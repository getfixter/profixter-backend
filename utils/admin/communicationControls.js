const User = require("../../models/User");
const EmailSuppression = require("../../models/EmailSuppression");
const { recordConsent } = require("../consent/ledger");
const { CURRENT } = require("../consent/consentText");
const { emailStatus, handsetStopped } = require("../consent/status");
const { optOutFor } = require("../sms/smsEligibility");
const { toE164 } = require("../sms/smsPhone");

/**
 * Admin's view of, and control over, what one customer is sent.
 *
 * THE ONLY PLACE ADMIN WRITES A CUSTOMER'S COMMUNICATION CHOICES. The owner
 * decided (2026-10-30) that staff taking a call may switch channels on or off
 * for the caller, and that the call is the consent. Everything about that is
 * kept honest here, and scripts/test_sms_consent_mechanics.js holds every
 * other admin route to not doing it:
 *
 *  - every change appends a ConsentEvent naming source "admin_phone" (on) or
 *    "admin_change" (off) and the staff member, with the wording the customer
 *    agreed to (consentText "*.admin_phone.v1");
 *  - every change writes an AdminActivityLog row (the caller does that);
 *  - nothing is ever sent to the customer about it;
 *  - what the customer did on their own handset or inbox outranks Admin: a
 *    STOP texted from the phone, a bounce or a spam complaint cannot be
 *    switched back on from here (409). Only the customer can lift those.
 *
 * Four switches, matching what the send paths actually read:
 *   service SMS     smsPreferences.transactionalEnabled  (smsEligibility)
 *   marketing SMS   smsPreferences.marketingEnabled      (smsEligibility)
 *   marketing email EmailSuppression row                 (marketing sends)
 *   service email   emailPreferences.serviceEnabled      (emailService SERVICE_EMAIL_KEYS)
 */

const SWITCHES = {
  "service.sms": { purpose: "service", channel: "sms" },
  "marketing.sms": { purpose: "marketing", channel: "sms" },
  "service.email": { purpose: "service", channel: "email" },
  "marketing.email": { purpose: "marketing", channel: "email" },
};

const SELECT = "name email phone role isActive employeePosition excludeFromMarketing smsPreferences emailPreferences";

class CommunicationControlError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function adminDetail(admin, note = "") {
  const who = String(admin?.name || admin?.email || "admin").slice(0, 80);
  return `${note ? `${note}; ` : ""}recorded by ${who}${admin?._id ? ` (${admin._id})` : ""}`.slice(0, 300);
}

async function readRows(user) {
  const email = String(user.email || "").trim().toLowerCase();
  const [suppression, optOut] = await Promise.all([
    email ? EmailSuppression.findOne({ email }).lean() : null,
    optOutFor(user.phone),
  ]);
  return { suppression, optOut };
}

/** What Admin sees: four on/off switches, plus why a switch is locked. */
async function communicationState(userOrId) {
  const user = userOrId?.smsPreferences !== undefined || userOrId?.email !== undefined
    ? userOrId
    : await User.findById(userOrId).select(SELECT).lean();
  if (!user) return null;
  const { suppression, optOut } = await readRows(user);
  const prefs = user.smsPreferences || {};
  const hasPhone = Boolean(toE164(user.phone));
  const stopped = hasPhone && handsetStopped(optOut);
  const mailStatus = emailStatus(user, suppression);
  const hasEmail = Boolean(String(user.email || "").trim());

  return {
    service: {
      email: {
        enabled: hasEmail && user.emailPreferences?.serviceEnabled !== false,
        locked: hasEmail ? null : "no_email",
        changedAt: user.emailPreferences?.serviceChangedAt || null,
        source: user.emailPreferences?.serviceChangeSource || "",
      },
      sms: {
        enabled: hasPhone && !stopped && prefs.transactionalEnabled === true,
        locked: !hasPhone ? "no_phone" : stopped ? "stopped" : null,
        changedAt: prefs.transactionalConsentAt || null,
        source: prefs.transactionalConsentSource || "",
      },
    },
    marketing: {
      email: {
        enabled: mailStatus === "opted_in" || mailStatus === "existing_customer",
        locked: mailStatus === "blocked" ? "blocked" : mailStatus === "not_marketable" ? "not_marketable" : null,
        changedAt: user.emailPreferences?.marketingConsentAt || suppression?.suppressedAt || null,
        source: user.emailPreferences?.marketingConsentSource || suppression?.source || "",
      },
      sms: {
        enabled: hasPhone && !stopped && user.excludeFromMarketing !== true && prefs.marketingEnabled === true,
        locked: !hasPhone ? "no_phone" : stopped ? "stopped" : user.excludeFromMarketing === true ? "excluded" : null,
        changedAt: prefs.marketingConsentAt || null,
        source: prefs.marketingConsentSource || "",
      },
    },
  };
}

const LOCK_MESSAGES = {
  no_phone: "This customer has no phone number.",
  no_email: "This customer has no email address.",
  stopped: "This phone texted STOP. Only the customer can restart texts, by texting START.",
  blocked: "This email bounced or reported spam, so it can't be switched back on here.",
  not_marketable: "This account can't receive marketing email.",
  excluded: "This account is excluded from marketing.",
};

/**
 * Turn one switch on or off for a customer, on Admin's say-so.
 * Returns { changed, before, after } - `changed` false when it already was.
 */
async function setCommunicationPreference({ userId, key, enabled, admin, req = null, note = "", recordIfUnchanged = false, at = new Date() }) {
  const target = SWITCHES[key];
  if (!target) throw new CommunicationControlError("UNKNOWN_SWITCH", "Unknown setting.", 400);
  if (enabled !== true && enabled !== false) throw new CommunicationControlError("BAD_VALUE", "enabled must be true or false.", 400);

  const user = await User.findById(userId).select(SELECT);
  if (!user) throw new CommunicationControlError("NOT_FOUND", "Customer not found.", 404);
  if (String(user.role || "customer") !== "customer" || user.employeePosition) {
    throw new CommunicationControlError("NOT_A_CUSTOMER", "Only customer accounts have these settings.", 400);
  }

  const before = await communicationState(user.toObject());
  const current = before[target.purpose][target.channel];
  /*
   * Already that way: nothing to do - except at account creation, where an
   * "on" that the opt-out rule already implies (marketing email, service
   * email) is still recorded, so the account carries the call's consent.
   */
  if (current.enabled === enabled && !(recordIfUnchanged && enabled)) return { changed: false, before, after: before };
  if (enabled && current.locked) {
    throw new CommunicationControlError(`LOCKED_${current.locked.toUpperCase()}`, LOCK_MESSAGES[current.locked] || "This setting is locked.");
  }

  const source = enabled ? "admin_phone" : "admin_change";
  const detail = adminDetail(admin, note);
  const phone = toE164(user.phone) || "";
  const email = String(user.email || "").trim().toLowerCase();

  if (target.channel === "sms") {
    const base = target.purpose === "marketing" ? "smsPreferences.marketing" : "smsPreferences.transactional";
    const set = { [`${base}Enabled`]: enabled };
    if (enabled) {
      set[`${base}ConsentAt`] = at;
      set[`${base}ConsentSource`] = source;
    }
    await User.updateOne({ _id: user._id }, { $set: set });
    await recordConsent({
      user,
      channel: "sms",
      purpose: target.purpose,
      action: enabled ? "granted" : "withdrawn",
      source,
      version: enabled ? CURRENT.admin_phone[target.purpose] : "",
      phone,
      req,
      detail,
      at,
    });
  } else if (target.purpose === "marketing") {
    if (enabled) {
      const row = await EmailSuppression.findOne({ email }).lean();
      if (row && EmailSuppression.isActive(row)) {
        await EmailSuppression.updateOne({ _id: row._id }, { $set: { resubscribedAt: at, resubscribeSource: source } });
      }
      await User.updateOne(
        { _id: user._id },
        { $set: { "emailPreferences.marketingConsentAt": at, "emailPreferences.marketingConsentSource": source, "emailPreferences.marketingConsentVersion": CURRENT.admin_phone.emailMarketing } }
      );
      await recordConsent({ user, channel: "email", purpose: "marketing", action: row ? "resubscribed" : "granted", source, version: CURRENT.admin_phone.emailMarketing, email, req, detail, at });
    } else {
      await EmailSuppression.findOneAndUpdate(
        { email },
        { $set: { suppressedAt: at }, $setOnInsert: { reason: "unsubscribe", source } },
        { upsert: true, setDefaultsOnInsert: true }
      );
      await recordConsent({ user, channel: "email", purpose: "marketing", action: "unsubscribed", source, email, req, detail, at });
    }
  } else {
    await User.updateOne(
      { _id: user._id },
      { $set: { "emailPreferences.serviceEnabled": enabled, "emailPreferences.serviceChangedAt": at, "emailPreferences.serviceChangeSource": source } }
    );
    await recordConsent({ user, channel: "email", purpose: "service", action: enabled ? "granted" : "withdrawn", source, email, req, detail, at });
  }

  const after = await communicationState(await User.findById(user._id).select(SELECT).lean());
  console.log(JSON.stringify({ event: "admin_communication_preference_changed", userId: String(user._id), key, enabled, source, adminId: String(admin?._id || "") }));
  return { changed: true, before, after };
}

module.exports = {
  CommunicationControlError,
  LOCK_MESSAGES,
  SWITCHES,
  communicationState,
  setCommunicationPreference,
};
