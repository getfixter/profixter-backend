const EmailSuppression = require("../../models/EmailSuppression");
const { isMarketableAccount } = require("../marketing/marketingEligibility");
const { toE164 } = require("../sms/smsPhone");

/**
 * What one customer may be sent, per channel, and WHY - from evidence already
 * stored, never inferred.
 *
 * DESCRIPTIVE. The send paths keep their own checks (smsEligibility for every
 * text, isUnsubscribed + isMarketableAccount for every marketing email); this
 * uses the same facts so the audit, the account screen and Marcus's counts
 * say exactly what those checks would do.
 *
 * Email marketing:
 *   opted_in           switched it on themselves (emailPreferences.marketingConsentAt)
 *   existing_customer  registered, never unsubscribed: emailable under the opt-out rule
 *   unsubscribed       unsubscribed (link or account setting)
 *   blocked            bounce, spam complaint or manual block - never lifted by us
 *   not_marketable     staff, excluded or test account, or no deliverable address
 * SMS (marketing and service, separately):
 *   opted_in           ticked the box (with the date and screen it was ticked on)
 *   opted_out          switched it off, or it was reset when the number changed to an unasked one
 *   stopped            the handset texted STOP and has not texted START
 *   unknown            never asked - NOT consent
 *   no_phone / excluded
 */
function emailStatus(user, suppression) {
  if (!isMarketableAccount(user)) return "not_marketable";
  if (EmailSuppression.isActive(suppression)) return suppression.reason === "unsubscribe" ? "unsubscribed" : "blocked";
  if (user.emailPreferences?.marketingConsentAt) return "opted_in";
  return "existing_customer";
}

function handsetStopped(optOut) {
  if (!optOut) return false;
  const inAt = optOut.optedInAt ? new Date(optOut.optedInAt).getTime() : 0;
  return !(inAt && inAt >= new Date(optOut.optedOutAt).getTime());
}

function smsStatus(user, purpose, optOut) {
  if (!toE164(user.phone)) return "no_phone";
  if (handsetStopped(optOut)) return "stopped";
  const prefs = user.smsPreferences || {};
  const flag = purpose === "marketing" ? prefs.marketingEnabled : prefs.transactionalEnabled;
  if (purpose === "marketing" && user.excludeFromMarketing === true) return "excluded";
  if (flag === true) return "opted_in";
  if (flag === false) return "opted_out";
  return "unknown";
}

function consentStatus(user, { suppression = null, optOut = null } = {}) {
  return {
    email: emailStatus(user, suppression),
    smsMarketing: smsStatus(user, "marketing", optOut),
    smsService: smsStatus(user, "service", optOut),
  };
}

/** For one account: looks its rows up. */
async function consentStatusFor(user) {
  const SmsOptOut = require("../../models/SmsOptOut");
  const e164 = toE164(user.phone);
  const [suppression, optOut] = await Promise.all([
    user.email ? EmailSuppression.findOne({ email: String(user.email).trim().toLowerCase() }).lean() : null,
    e164 ? SmsOptOut.findOne({ phone: e164 }).lean() : null,
  ]);
  return consentStatus(user, { suppression, optOut });
}

module.exports = { consentStatus, consentStatusFor, emailStatus, handsetStopped, smsStatus };
