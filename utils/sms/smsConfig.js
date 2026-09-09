/**
 * SMS configuration.
 *
 * Every switch the system obeys is read here and nowhere else, so the question
 * "could this possibly text a customer right now?" has one place to look.
 *
 * THE MASTER SWITCH IS OFF BY DEFAULT AND FAILS CLOSED.
 *
 * SMS_ENABLED must spell "true" to enable sending. Unset, empty, "1", "yes",
 * "on" and any typo all mean disabled: only the word itself counts, so no
 * plausible misconfiguration can be the thing that starts texting customers.
 *
 * Surrounding whitespace and capitalisation are forgiven, which is the same
 * reading ENABLE_MARKETING_EMAILS and ENABLE_RESERVATION_ENGINE already use.
 * That consistency is worth more here than an extra notch of strictness: a
 * codebase where one flag treats "True" differently from its neighbours is a
 * codebase where somebody eventually sets the wrong one correctly.
 */

const TIMEZONE = "America/New_York";

function readFlag(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  return String(raw).trim().toLowerCase() === "true";
}

function readNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Whether real messages may leave the system.
 *
 * Deliberately a function rather than a constant captured at require time: a
 * test needs to flip it between cases, and a constant read once at module load
 * would make "prove SMS_ENABLED=false blocks sending" untestable in-process.
 */
function smsEnabled() {
  return readFlag("SMS_ENABLED", false);
}

/**
 * Whether marketing SMS may be sent at all, independent of SMS_ENABLED.
 *
 * A second dial, so transactional messaging can go live on its own. Turning on
 * the provider and starting to advertise are not the same decision and must not
 * share a switch.
 */
function smsMarketingEnabled() {
  return readFlag("SMS_MARKETING_ENABLED", false);
}

/**
 * Twilio credentials.
 *
 * API Key SID + Secret, which is what Twilio recommends for a server-side
 * application: a key is scoped, is revocable on its own, and can be rotated
 * without touching the account credential that everything else depends on.
 * The Account SID identifies the account; it is not a secret.
 *
 * AUTH TOKEN IS SEPARATE AND IS NOT USED FOR SENDING.
 * Twilio signs webhooks with the account auth token, and an API key cannot
 * verify that signature. So the token is read here for one purpose only —
 * validating inbound requests — and is never sent anywhere.
 */
function twilioCredentials() {
  return {
    accountSid: String(process.env.TWILIO_ACCOUNT_SID || "").trim(),
    apiKey: String(process.env.TWILIO_API_KEY || "").trim(),
    apiSecret: String(process.env.TWILIO_API_SECRET || "").trim(),
    messagingServiceSid: String(process.env.TWILIO_MESSAGING_SERVICE_SID || "").trim(),
    phoneNumber: String(process.env.TWILIO_PHONE_NUMBER || "").trim(),
    authToken: String(process.env.TWILIO_AUTH_TOKEN || "").trim(),
  };
}

/**
 * Whether we hold enough credentials to send anything at all.
 *
 * A messaging service or a from-number is required, not both: a Messaging
 * Service is the better answer once the account is approved, and a bare number
 * is what a brand-new account has first.
 */
function twilioConfigured() {
  const c = twilioCredentials();
  return Boolean(
    c.accountSid && c.apiKey && c.apiSecret && (c.messagingServiceSid || c.phoneNumber)
  );
}

/** Public base URL Twilio should call back on. Empty disables callbacks. */
function statusCallbackUrl() {
  const base = String(
    process.env.SMS_STATUS_CALLBACK_URL ||
      process.env.PUBLIC_API_URL ||
      process.env.PUBLIC_API_BASE_URL ||
      ""
  ).replace(/\/+$/, "");
  if (!base) return "";
  if (/\/api\/sms\/(status|webhook)/.test(base)) return base;
  return `${base}/api/sms/webhook/status`;
}

/**
 * Quiet hours, in New York local time.
 *
 * MARKETING IS WINDOWED. TRANSACTIONAL IS NOT.
 *
 * That is not an oversight. A 60-minute reminder is only useful sixty minutes
 * before the visit; deferring it out of a quiet window does not make it
 * politer, it makes it pointless, and the customer chose the appointment time
 * that put it there. Service messages about a transaction the person initiated
 * are the recognised exception to quiet-hour convention for exactly this
 * reason.
 *
 * Marketing has no such excuse and is held to a narrow daytime window.
 */
const QUIET_HOURS = {
  marketing: {
    startHour: readNumber("SMS_MARKETING_START_HOUR", 11),
    endHour: readNumber("SMS_MARKETING_END_HOUR", 18),
  },
  /*
   * A floor for transactional messages that are NOT time-critical: an account
   * change at 4am can wait until morning. Reminders and confirmations opt out
   * of this by being marked timeCritical in the type registry.
   */
  transactional: {
    startHour: readNumber("SMS_TRANSACTIONAL_START_HOUR", 8),
    endHour: readNumber("SMS_TRANSACTIONAL_END_HOUR", 21),
  },
};

/**
 * Retry policy.
 *
 * Three attempts with widening gaps. Not more, because an SMS that has failed
 * three times over half an hour is not going to succeed on the fourth, and a
 * message that arrives long after the moment it described is worse than one
 * that never arrives.
 */
const RETRY = {
  maxAttempts: readNumber("SMS_MAX_ATTEMPTS", 3),
  backoffMs: [60 * 1000, 5 * 60 * 1000, 30 * 60 * 1000],
  /** A worker that claimed a send and vanished releases it after this. */
  lockStaleMs: readNumber("SMS_LOCK_STALE_MS", 5 * 60 * 1000),
};

/** How many messages one sweep may push. Small, so a mistake stays small. */
const BATCH = {
  maxPerRun: readNumber("SMS_MAX_PER_RUN", 50),
  delayBetweenSendsMs: readNumber("SMS_SEND_DELAY_MS", 120),
};

/**
 * A single segment is 160 GSM-7 characters. Templates are written to fit two,
 * and anything past this is truncated rather than silently billed as four.
 */
const MAX_BODY_LENGTH = readNumber("SMS_MAX_BODY_LENGTH", 320);

/** Canonical links. Fixed values, never assembled from user input. */
const LINKS = {
  tip: "https://www.profixter.com/tip",
  review: "https://www.profixter.com/review",
};

/**
 * Whether a completion text may carry the review link.
 *
 * OFF, AND IT HAS TO STAY OFF UNTIL THE PRODUCT CAN ANSWER THE QUESTION.
 *
 * profixter.com/review is a bare redirect to Google Maps. Nothing records that
 * a customer arrived, and nothing records that they left a review, so
 * "customers who have not reviewed yet" is not a set this system can compute.
 * The nearest available signal, Booking.reviewRequestSentAt, means we asked,
 * which is a different fact and a bad proxy for it.
 *
 * CLICK TRACKING IS NOT THE ANSWER EITHER, and this correction matters enough
 * to write down. An earlier version of this note proposed an interstitial that
 * recorded a click on /review before handing off to Google. That was wrong: a
 * click means somebody opened a page. It does not mean they wrote anything,
 * and treating it as "reviewed" would silence future asks for the many people
 * who tapped the link and then closed the tab. A click-derived
 * reviewCompleted flag would be a confident-looking lie, which is worse than
 * the honest gap we have now.
 *
 * What would actually earn this flag is a trustworthy record that a review was
 * LEFT — a verified signal from the review platform, or, perfectly
 * acceptably, an Admin marking "this customer reviewed us" by hand. Until one
 * of those exists, the completion message carries the tip link alone.
 *
 * The plumbing is built and tested so that turning this on is one flag, once
 * that record is real.
 */
function reviewLinkEnabled() {
  return readFlag("SMS_REVIEW_LINK_ENABLED", false);
}

/** A compact snapshot for logs, health checks and the admin screen. */
function configSnapshot() {
  const c = twilioCredentials();
  return {
    smsEnabled: smsEnabled(),
    smsMarketingEnabled: smsMarketingEnabled(),
    twilioConfigured: twilioConfigured(),
    reviewLinkEnabled: reviewLinkEnabled(),
    timezone: TIMEZONE,
    // Presence only. No credential, or any part of one, is ever logged.
    hasAccountSid: Boolean(c.accountSid),
    hasApiKey: Boolean(c.apiKey),
    hasApiSecret: Boolean(c.apiSecret),
    hasMessagingServiceSid: Boolean(c.messagingServiceSid),
    hasPhoneNumber: Boolean(c.phoneNumber),
    hasAuthToken: Boolean(c.authToken),
    statusCallbackConfigured: Boolean(statusCallbackUrl()),
  };
}

module.exports = {
  BATCH,
  LINKS,
  MAX_BODY_LENGTH,
  QUIET_HOURS,
  RETRY,
  TIMEZONE,
  configSnapshot,
  readFlag,
  reviewLinkEnabled,
  smsEnabled,
  smsMarketingEnabled,
  statusCallbackUrl,
  twilioConfigured,
  twilioCredentials,
};
