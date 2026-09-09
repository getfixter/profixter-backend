const SmsOptOut = require("../../models/SmsOptOut");
const SmsPhoneStatus = require("../../models/SmsPhoneStatus");
const { QUIET_HOURS, TIMEZONE, smsMarketingEnabled } = require("./smsConfig");
const { isMarketing, isTimeCritical, isKnownType } = require("./smsTypes");
const { toE164 } = require("./smsPhone");

/**
 * Whether a particular message may go to a particular person right now.
 *
 * EVERY REASON TO NOT SEND LIVES HERE, AND NOWHERE ELSE.
 *
 * A trigger asks for a notification; it never decides whether the person wants
 * it. That separation is what makes the consent rules auditable: there is one
 * function to read, and a new trigger added next year inherits every rule
 * without its author having to know they exist.
 *
 * THE RULES ARE NOT SYMMETRIC BETWEEN THE TWO CHANNELS, ON PURPOSE
 * Marketing needs express permission that ProFixter has never asked for, so it
 * requires an explicit opt-in and a narrow daytime window. Transactional
 * messaging is about a transaction the customer initiated with us and is
 * allowed unless they have said no. Treating the two the same in either
 * direction would be wrong: identical strictness silences appointment
 * reminders people are relying on, and identical looseness sends
 * advertisements to people who never agreed to receive them.
 */

/** A refusal, with a reason that gets stored on the record. */
function no(reason, detail = "") {
  return { eligible: false, reason, detail };
}

const yes = { eligible: true, reason: "eligible" };

/**
 * The current hour and weekday in New York.
 *
 * Read out of Intl rather than computed from a UTC offset, so it stays correct
 * across both DST transitions without anybody remembering to think about them.
 */
function newYorkParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    hour: "numeric",
    hour12: false,
    weekday: "short",
  }).formatToParts(new Date(now));

  const hourPart = parts.find((p) => p.type === "hour");
  const weekdayPart = parts.find((p) => p.type === "weekday");
  const dayIndex = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  return {
    // Intl renders midnight as "24" in some ICU versions; normalise it to 0.
    hour: Number(hourPart?.value || 0) % 24,
    dayOfWeek: dayIndex[weekdayPart?.value] ?? 0,
  };
}

/**
 * Whether the clock permits this message.
 *
 * Time-critical transactional messages ignore the window entirely. That is not
 * a loophole: an hour-before reminder deferred out of quiet hours is not a
 * politer reminder, it is a useless one, and the customer chose the appointment
 * time that put it there. Everything else, including all marketing, is held to
 * a window.
 */
function withinSendWindow(notificationType, now = new Date(), overrideWindow = null) {
  const { hour } = newYorkParts(now);

  if (overrideWindow) {
    const { startHour, endHour } = overrideWindow;
    return hour >= startHour && hour < endHour;
  }
  if (isMarketing(notificationType)) {
    const w = QUIET_HOURS.marketing;
    return hour >= w.startHour && hour < w.endHour;
  }
  if (isTimeCritical(notificationType)) return true;

  const w = QUIET_HOURS.transactional;
  return hour >= w.startHour && hour < w.endHour;
}

/**
 * The opt-out state of a number.
 *
 * Keyed by phone, because a STOP is a property of the handset and not of an
 * account. Returns the row so the caller can record which scope blocked it.
 */
async function optOutFor(phone, OptOutModel = SmsOptOut) {
  const e164 = toE164(phone);
  if (!e164) return null;
  const row = await OptOutModel.findOne({ phone: e164 }).lean();
  if (!row) return null;
  // A START that came after the STOP resolves it. Compare rather than delete,
  // so the history of a number that left and came back is still readable.
  const optedIn = row.optedInAt ? new Date(row.optedInAt).getTime() : 0;
  const optedOut = row.optedOutAt ? new Date(row.optedOutAt).getTime() : 0;
  if (optedIn && optedIn >= optedOut) return null;
  return row;
}

/**
 * Does this account permit this class of message?
 *
 * ABSENCE IS READ DIFFERENTLY PER CHANNEL, AND THAT IS THE WHOLE RULE.
 *
 * Nobody in the database has an SMS preference yet, because the fields are new.
 * For transactional that absence means yes: the number was given to us to book
 * a visit and messages about that visit are what it is for. For marketing it
 * means no, and it will keep meaning no until the person affirmatively opts in,
 * because promotional texting requires consent that has never been collected.
 *
 * The practical consequence is deliberate: on the day this ships, marketing SMS
 * has an audience of zero. That is the correct audience for a channel nobody
 * has agreed to.
 */
function accountAllows(user, notificationType) {
  const prefs = user?.smsPreferences || {};

  if (isMarketing(notificationType)) {
    if (prefs.marketingEnabled !== true) return no("marketing_not_opted_in");
    if (user?.excludeFromMarketing === true) return no("account_excluded_from_marketing");
    return yes;
  }

  if (prefs.transactionalEnabled === false) return no("transactional_disabled_by_user");
  return yes;
}

/**
 * The full check, in the order that produces the most useful refusal.
 *
 * Cheap and structural reasons first, so a message with no phone number is
 * refused as "no phone" rather than as "outside the send window" — the record
 * has to say the thing an operator would need to fix.
 */
async function checkEligibility({
  notificationType,
  user = null,
  phone = null,
  now = new Date(),
  sendWindow = null,
  OptOutModel = SmsOptOut,
  PhoneStatusModel = SmsPhoneStatus,
}) {
  if (!isKnownType(notificationType)) {
    return no("unknown_notification_type", notificationType);
  }

  const e164 = toE164(phone || user?.phone);
  if (!e164) return no("no_valid_phone");

  /*
   * A message may be addressed to a number with no account behind it, which is
   * legitimate for a booking taken over the phone. Only account-level rules are
   * skipped in that case; the opt-out and window rules still apply.
   */
  if (user) {
    const account = accountAllows(user, notificationType);
    if (!account.eligible) return account;
  } else if (isMarketing(notificationType)) {
    // Marketing needs a consenting account. There is no anonymous consent.
    return no("marketing_requires_account");
  }

  if (isMarketing(notificationType) && !smsMarketingEnabled()) {
    return no("marketing_channel_disabled");
  }

  const optOut = await optOutFor(e164, OptOutModel);
  if (optOut) {
    /*
     * A STOP blocks everything, including service messages. That is not our
     * choice to make: the carrier and Twilio enforce it regardless, so a
     * transactional message sent to a stopped number is a message that fails
     * and costs reputation rather than one that arrives.
     */
    if (optOut.scope === "all") {
      return no("opted_out_all", optOut.source || "");
    }
    if (optOut.scope === "marketing" && isMarketing(notificationType)) {
      return no("opted_out_marketing", optOut.source || "");
    }
  }

  /*
   * A number a carrier has permanently refused.
   *
   * Checked here rather than at each trigger so that transactional and
   * marketing inherit it identically and a future notification type cannot be
   * added without it. Deliberately AFTER the opt-out check: a person who
   * opted out and whose number later died should be recorded as opted out,
   * because that is the fact that matters and the one somebody will ask about.
   *
   * The message still gets a row in the audit, marked suppressed with this
   * reason, so "why did they not get the text" is answerable from the admin
   * screen rather than from the absence of anything.
   */
  const phoneStatus = await PhoneStatusModel.findOne({ phone: e164 })
    .select("status undeliverableCode undeliverableReason")
    .lean();
  if (phoneStatus && phoneStatus.status === "undeliverable") {
    return no(
      "phone_undeliverable",
      phoneStatus.undeliverableReason || phoneStatus.undeliverableCode || ""
    );
  }

  if (!withinSendWindow(notificationType, now, sendWindow)) {
    return no("outside_send_window");
  }

  return { ...yes, phone: e164 };
}

module.exports = {
  accountAllows,
  checkEligibility,
  newYorkParts,
  optOutFor,
  withinSendWindow,
};
