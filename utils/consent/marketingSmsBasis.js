/**
 * May this customer be sent a marketing text? Decided from the EVIDENCE of
 * their consent, not from who typed it in.
 *
 * Marketing texts need the customer's own prior express written consent
 * (TCPA, 47 CFR 64.1200(a)(2)) and an opt-in that matches the registered A2P
 * campaign. Who recorded the consent does not decide it; what the customer
 * actually did does:
 *
 *  - The customer opted in themselves, electronically, where the registered
 *    A2P campaign says consent is collected (sign-up form, account settings,
 *    the website, texting START): qualifies.
 *  - The customer pressed "Yes" on the one-click page Admin emails after a
 *    call, or Admin recorded WRITTEN permission the customer sent (their own
 *    email, their own text message, a signed form) and described it: real
 *    consent, but the registered campaign (as of 2026-10-31) says consent is
 *    given only on the sign-up form and in account settings, "no verbal opt-in,
 *    no paper opt-in". Sending on these before the carrier description says so
 *    would put the verified campaign - and every service text - at risk. They
 *    qualify once Twilio confirms the updated message flow
 *    (SMS_ADMIN_ASSISTED_OPTIN_REGISTERED=true; docs/a2p-campaign-update.md).
 *  - Admin recorded a phone call: the call is real and stays on record, but a
 *    spoken yes is not written consent. The customer completes it themselves
 *    (account settings now; the one-click link once registered).
 *
 * Used by smsEligibility (every marketing text), the campaign senders and the
 * Admin panel, so all three always agree.
 */

/* The customer's own electronic act. */
const SELF_GIVEN_SOURCES = new Set([
  "signup_web_form",
  "signup_phone_code",
  "account_settings",
  "website",
  "sms_keyword",
]);

/* How Admin can say the customer agreed. Only the written ones can qualify. */
const ADMIN_METHODS = {
  phone_call: { label: "Phone call", written: false },
  customer_email: { label: "Customer's own email", written: true },
  customer_text: { label: "Customer's own text message", written: true },
  signed_form: { label: "Signed form", written: true },
};

const MIN_EVIDENCE = 8;

/* Opt-in methods the registered campaign does not describe yet: they wait for the carrier. */
function adminAssistedOptInRegistered() {
  return String(process.env.SMS_ADMIN_ASSISTED_OPTIN_REGISTERED || "").trim().toLowerCase() === "true";
}

/**
 * @returns {{status: "off"|"qualifies"|"needs_confirmation"|"awaiting_registration", basis: string, method: string}}
 *  status "qualifies" is the only one a marketing text may go out on.
 */
function marketingSmsBasis(user) {
  const prefs = user?.smsPreferences || {};
  const source = String(prefs.marketingConsentSource || "");
  const method = String(prefs.marketingConsentMethod || (source === "admin_phone" ? "phone_call" : ""));
  if (prefs.marketingEnabled !== true) return { status: "off", basis: "", method };
  if (SELF_GIVEN_SOURCES.has(source)) return { status: "qualifies", basis: "customer_electronic", method: "customer_self_service" };
  const pending = (basis, how) => ({ status: adminAssistedOptInRegistered() ? "qualifies" : "awaiting_registration", basis, method: how });
  if (source === "sms_confirm_link") return pending("customer_confirmed_link", "customer_confirmed_link");
  if (source === "admin_written" && ADMIN_METHODS[method]?.written && String(prefs.marketingConsentEvidence || "").trim().length >= MIN_EVIDENCE) {
    return pending("admin_recorded_written", method);
  }
  return { status: "needs_confirmation", basis: source === "admin_phone" ? "admin_recorded_phone" : "unknown", method };
}

module.exports = { ADMIN_METHODS, MIN_EVIDENCE, SELF_GIVEN_SOURCES, adminAssistedOptInRegistered, marketingSmsBasis };
