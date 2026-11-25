const CommMessage = require("../../models/CommMessage");
const SmsPhoneStatus = require("../../models/SmsPhoneStatus");
const { optOutFor, accountAllows, withinSendWindow } = require("../sms/smsEligibility");
const { smsMarketingEnabled, QUIET_HOURS } = require("../sms/smsConfig");
const { marketingSmsLaunched } = require("../marketing/smsMarketingLaunch");
const { toE164 } = require("../sms/smsPhone");

/**
 * Whether a person may be texted from Communications, for a stated purpose.
 *
 * The same consent rules as every automated text (utils/sms/smsEligibility),
 * reused rather than restated, plus the one rule a conversation adds:
 *
 * SERVICE (a reply or a message about their service)
 *   - their own service-text opt-in (smsPreferences.transactionalEnabled), OR
 *   - they texted this business within the last 30 days (a conversation THEY
 *     started; one-to-one only, never a basis for a bulk send).
 * MARKETING (anything promotional)
 *   - the marketing consent that qualifies under marketingSmsBasis, the
 *     marketing channel switch, the launch date, and the 11am-6pm window.
 *   Never inferred from an account, a booking, a membership or a service text.
 * ALWAYS
 *   - a STOP (SmsOptOut) blocks everything, and a number a carrier has
 *     permanently refused is not texted.
 *
 * Returns { eligible, reason, text, basis, warnings[] }; `text` is what Admin
 * shows, so every refusal names the real reason.
 */
const INBOUND_BASIS_DAYS = 30;

const TEXT = {
  no_valid_phone: "This number can't receive texts (it isn't a valid US mobile number).",
  opted_out_all: "This number replied STOP. Nothing can be texted until the customer texts START.",
  opted_out_marketing: "This number opted out of promotional texts.",
  phone_undeliverable: "Carriers have refused texts to this number. Fix the number before texting.",
  no_service_consent: "No service-text consent: the customer hasn't turned on service texts and hasn't texted us in the last 30 days.",
  bulk_requires_opt_in: "Bulk service texts need the customer's own service-text opt-in.",
  transactional_disabled_by_user: "The customer turned service texts off.",
  marketing_requires_account: "Promotional texts need a linked customer with promotional-text consent.",
  marketing_not_opted_in: "The customer hasn't opted in to promotional texts.",
  account_excluded_from_marketing: "This account is excluded from marketing.",
  marketing_channel_disabled: "Promotional texting is switched off on the server.",
  before_marketing_launch: "Promotional texting hasn't launched yet.",
  outside_marketing_window: "Promotional texts can go out only between 11am and 6pm New York time.",
  blocked: "This customer is blocked.",
};
const textFor = (reason, detail) =>
  TEXT[reason] || (String(reason).startsWith("marketing_consent_") ? `Their promotional-text consent doesn't qualify (${detail || reason.replace("marketing_consent_", "")}).` : reason);

const no = (reason, detail = "") => ({ eligible: false, reason, detail, text: textFor(reason, detail), warnings: [] });

async function customerTextedRecently(phone, now) {
  const since = new Date(now.getTime() - INBOUND_BASIS_DAYS * 864e5);
  return CommMessage.exists({ channel: "sms", direction: "inbound", kind: "customer", fromAddress: phone, occurredAt: { $gte: since } });
}

/**
 * @param {object} o
 * @param {"service"|"marketing"} o.purpose
 * @param {"manual"|"bulk"} o.mode
 */
async function checkCommsSend({ purpose, phone, user = null, mode = "manual", now = new Date(), blocked = false }) {
  const e164 = toE164(phone);
  if (!e164) return no("no_valid_phone");
  if (purpose !== "service" && purpose !== "marketing") return no("unknown_purpose");

  const optOut = await optOutFor(e164);
  if (optOut && optOut.scope === "all") return no("opted_out_all", optOut.source || "");
  if (optOut && optOut.scope === "marketing" && purpose === "marketing") return no("opted_out_marketing");

  const ps = await SmsPhoneStatus.findOne({ phone: e164 }).select("status undeliverableReason").lean();
  if (ps?.status === "undeliverable") return no("phone_undeliverable", ps.undeliverableReason || "");

  if (blocked && mode === "bulk") return no("blocked");
  const warnings = blocked ? [{ code: "blocked", text: "This customer is blocked from booking. Text only if you need to." }] : [];

  let basis = "";
  if (purpose === "marketing") {
    if (!user) return no("marketing_requires_account");
    const account = accountAllows(user, "MEMBERSHIP_MARKETING");
    if (!account.eligible) return no(account.reason, account.detail);
    if (!smsMarketingEnabled()) return no("marketing_channel_disabled");
    if (!marketingSmsLaunched(now)) return no("before_marketing_launch");
    if (mode === "manual" && !withinSendWindow("MEMBERSHIP_MARKETING", now)) return no("outside_marketing_window");
    basis = "marketing_consent";
  } else {
    const account = user ? accountAllows(user, "BOOKING_CONFIRMED") : { eligible: false, reason: "transactional_not_opted_in" };
    if (account.eligible) basis = "service_opt_in";
    else if (account.reason === "transactional_disabled_by_user") return no("transactional_disabled_by_user");
    else if (mode === "bulk") return no("bulk_requires_opt_in");
    else if (await customerTextedRecently(e164, now)) basis = "customer_texted_recently";
    else return no("no_service_consent");
    if (mode === "manual" && !withinSendWindow("ACCOUNT_CREATED", now)) {
      warnings.push({
        code: "quiet_hours",
        text: `It's outside ${QUIET_HOURS.transactional.startHour}am-${QUIET_HOURS.transactional.endHour - 12}pm in New York. Confirm you want this to arrive now.`,
        requiresAck: true,
      });
    }
  }
  return { eligible: true, reason: "eligible", basis, phone: e164, text: "", warnings };
}

/** The window a bulk send may deliver in (worker holds sends outside it). */
function bulkWindowOpen(purpose, now = new Date()) {
  return withinSendWindow(purpose === "marketing" ? "MEMBERSHIP_MARKETING" : "ACCOUNT_CREATED", now);
}

module.exports = { INBOUND_BASIS_DAYS, TEXT, bulkWindowOpen, checkCommsSend, textFor };
