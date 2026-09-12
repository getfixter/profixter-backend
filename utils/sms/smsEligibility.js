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
 * BOTH CHANNELS REQUIRE AN AFFIRMATIVE OPT-IN. THEY DIFFER ONLY IN DEGREE.
 * Neither service nor marketing SMS may be sent to somebody who has not ticked
 * the box for it. The rules that remain asymmetric are the ones about timing
 * and reach: marketing is additionally held to a narrow daytime window and a
 * separate channel switch, because an advertisement that arrives at the wrong
 * hour is a nuisance while an hour-before reminder that does not arrive is a
 * missed appointment. What they no longer differ on is consent.
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
 * ABSENCE IS NOT CONSENT ON EITHER CHANNEL. THAT IS THE WHOLE RULE.
 *
 * This function used to read absence asymmetrically: marketing needed an
 * explicit opt-in, transactional was allowed unless the customer had said no.
 * The argument was that a number handed over to book a visit was handed over in
 * order to be texted about that visit.
 *
 * A carrier reviewer disagreed, and they were looking at something the code
 * could not see: registration REQUIRED a phone number, so "give us a number we
 * will text you on" was a condition of having an account at all. That is forced
 * consent (A2P error 30923) regardless of how reasonable the messages are.
 *
 * So service SMS now requires the same affirmative act marketing does. Only
 * transactionalEnabled === true is eligible; false and absent are both refused,
 * with different reasons so the audit can tell "said no" from "never asked".
 *
 * NOTHING ELSE IS TREATED AS CONSENT. Not a phone number on the account, not an
 * accepted Terms of Service, not an existing booking, not a paid membership,
 * and not consent to the other channel. Each of those was at some point offered
 * as a reason SMS should be allowed, and each of them is the exact inference
 * that made the campaign non-compliant.
 */
function accountAllows(user, notificationType) {
  const prefs = user?.smsPreferences || {};

  if (isMarketing(notificationType)) {
    if (prefs.marketingEnabled !== true) return no("marketing_not_opted_in");
    if (user?.excludeFromMarketing === true) return no("account_excluded_from_marketing");
    return yes;
  }

  /*
   * Explicitly switched off reads differently from never asked. Both refuse
   * the message; only one of them describes a customer who made a choice, and
   * an operator answering "why did they not get the text" needs to know which.
   */
  if (prefs.transactionalEnabled === false) return no("transactional_disabled_by_user");
  if (prefs.transactionalEnabled !== true) return no("transactional_not_opted_in");
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
   * NO ACCOUNT MEANS NO CONSENT RECORD, WHICH MEANS NO MESSAGE.
   *
   * This used to let a transactional message through to a bare phone number on
   * the grounds that a booking taken over the telephone is still a booking the
   * customer asked for. That reasoning does not survive the forced-consent
   * question: consent has to be something the person did, and a number typed
   * into our admin screen by somebody else is not it. There is nowhere to read
   * a tick from and nowhere to store the evidence, so the honest answer is no.
   *
   * The customer is not left uninformed - email and the phone call the booking
   * was made on both still work. If they want texts, they create an account and
   * tick the box, and then there is a record saying so.
   *
   * ONE TYPE IS SHAPED LIKE AN EXCEPTION AND IS DELIBERATELY NOT GIVEN ONE:
   * GIFT_INVITATION is addressed to a recipient who by definition has no
   * account yet. It is refused here like everything else. It is also disabled
   * at the switch (GIFT_SMS_ENABLED=false) and stays that way, so this changes
   * no behaviour today; when somebody wants to turn it on they will have to
   * design a real consent step for the recipient first, and this refusal is
   * what will make them.
   */
  if (user) {
    const account = accountAllows(user, notificationType);
    if (!account.eligible) return account;
  } else {
    return no(isMarketing(notificationType) ? "marketing_requires_account" : "transactional_requires_account");
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
