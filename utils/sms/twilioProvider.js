const crypto = require("crypto");
const fetch = require("node-fetch");

const {
  smsEnabled,
  statusCallbackUrl,
  twilioConfigured,
  twilioCredentials,
} = require("./smsConfig");
const { maskPhone } = require("./smsPhone");

/**
 * The only place in ProFixter that talks to Twilio.
 *
 * Everything above this file deals in notifications, eligibility and audit
 * records; everything Twilio-shaped stops here. That boundary is the point of
 * the whole design: ProFixter is the brain and Twilio is a wire, so replacing
 * the wire should be one file and no business logic.
 *
 * WHY THE REST API DIRECTLY AND NOT THE TWILIO SDK
 * The send path is one form POST and the signature check is one HMAC, both
 * fully specified and stable. Against that, the SDK is a large new dependency
 * tree on the critical path of a production API that currently has twenty-four
 * of them. node-fetch and crypto are already here. If the SDK is wanted later,
 * it replaces this file and nothing else.
 *
 * CREDENTIALS
 * Sending authenticates with an API Key SID and Secret over HTTP Basic, which
 * is what Twilio recommends for a server application: the key is scoped, is
 * revocable by itself, and rotating it does not disturb the account credential.
 * The account auth token is used for exactly one thing, verifying inbound
 * webhook signatures, because Twilio signs with the account token and an API
 * key cannot verify that. No credential is ever logged, returned or included in
 * an error message.
 */

const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";
const REQUEST_TIMEOUT_MS = 15000;

/**
 * Twilio errors that are worth trying again, and every other error is not.
 *
 * The default has to be "do not retry". Retrying a permanent failure burns
 * money and, for a filtered or opted-out recipient, repeatedly attempts a
 * message the carrier has already told us not to send — which is how an account
 * loses its sending reputation. So this is an allowlist of the transient cases,
 * not a blocklist of the fatal ones.
 */
const RETRYABLE_TWILIO_CODES = new Set([
  20429, // Too Many Requests: our own rate against the API.
  20500, // Internal server error at Twilio.
  20503, // Service unavailable.
  30001, // Queue overflow: the message was not accepted, but could be later.
  30022, // Carrier rate limit exceeded.
]);

/**
 * Permanent failures, named so the audit record says why rather than "failed".
 *
 * 21610 is special and is not merely permanent: it means Twilio already holds
 * an opt-out for this number that we did not know about. The caller uses it to
 * write that opt-out into our own database, which is how our state stays
 * synchronised with Twilio when a STOP never reached our webhook.
 */
const PERMANENT_TWILIO_CODES = {
  21211: "invalid_phone_number",
  21214: "invalid_phone_number",
  21217: "invalid_phone_number",
  21408: "region_not_enabled",
  21610: "recipient_opted_out",
  21612: "unreachable_route",
  21614: "not_a_mobile_number",
  30003: "handset_unreachable",
  30004: "message_blocked",
  30005: "unknown_destination",
  30006: "landline_or_unreachable",
  30007: "carrier_filtered",
  30008: "unknown_delivery_error",
};

/** A failure with enough structure for the caller to decide what to do next. */
class SmsProviderError extends Error {
  constructor(message, { code = "", status = 0, retryable = false, reason = "" } = {}) {
    super(message);
    this.name = "SmsProviderError";
    this.providerErrorCode = String(code || "");
    this.httpStatus = status;
    this.retryable = Boolean(retryable);
    this.reason = reason;
  }
}

/**
 * Whether a Twilio error should be attempted again.
 *
 * HTTP 5xx and a network failure are transient by nature: the request may never
 * have reached Twilio, so nothing was necessarily charged or sent. A 4xx with a
 * code we do not recognise is treated as permanent, which is the conservative
 * reading — an unknown client error retried three times is still an unknown
 * client error, just three times more expensive.
 */
function classifyTwilioError({ code, status }) {
  const numericCode = Number(code);
  if (RETRYABLE_TWILIO_CODES.has(numericCode)) {
    return { retryable: true, reason: "provider_transient" };
  }
  if (PERMANENT_TWILIO_CODES[numericCode]) {
    return { retryable: false, reason: PERMANENT_TWILIO_CODES[numericCode] };
  }
  if (status >= 500) return { retryable: true, reason: "provider_server_error" };
  if (status === 429) return { retryable: true, reason: "provider_rate_limited" };
  if (status >= 400) return { retryable: false, reason: "provider_rejected" };
  return { retryable: true, reason: "provider_unknown" };
}

/** True when Twilio told us the recipient is on its own opt-out list. */
function isOptOutError(error) {
  return Number(error?.providerErrorCode) === 21610;
}

function basicAuthHeader(user, pass) {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

/**
 * Send one message.
 *
 * REFUSES WHEN SENDING IS DISABLED, AS A SECOND LINE OF DEFENCE.
 *
 * The service layer already checks SMS_ENABLED and never calls this when it is
 * false. This checks again anyway, because the cost of the two disagreeing is a
 * text to a real customer during a period when the business has been told none
 * can happen. A guard that is only in the caller is a guard that a future
 * caller can forget.
 */
async function sendMessage({ to, body, statusCallback = statusCallbackUrl() }) {
  if (!smsEnabled()) {
    throw new SmsProviderError("SMS sending is disabled (SMS_ENABLED is not true)", {
      reason: "sms_disabled",
      retryable: false,
    });
  }
  if (!twilioConfigured()) {
    throw new SmsProviderError("Twilio is not configured", {
      reason: "provider_not_configured",
      retryable: false,
    });
  }
  if (!to) {
    throw new SmsProviderError("Missing destination number", {
      reason: "invalid_phone_number",
      retryable: false,
    });
  }

  const creds = twilioCredentials();
  const params = new URLSearchParams();
  params.set("To", to);
  params.set("Body", String(body || ""));
  /*
   * A Messaging Service is preferred when configured: it owns the sender pool,
   * the compliance registration and Twilio's own opt-out handling. A bare
   * from-number is the fallback a brand-new account has before that exists.
   */
  if (creds.messagingServiceSid) {
    params.set("MessagingServiceSid", creds.messagingServiceSid);
  } else {
    params.set("From", creds.phoneNumber);
  }
  if (statusCallback) params.set("StatusCallback", statusCallback);

  const url = `${TWILIO_API_BASE}/Accounts/${encodeURIComponent(creds.accountSid)}/Messages.json`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  let payload = {};
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: basicAuthHeader(creds.apiKey, creds.apiSecret),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: params.toString(),
      signal: controller.signal,
    });
    const text = await response.text();
    payload = text ? JSON.parse(text) : {};
  } catch (error) {
    /*
     * A timeout or a socket error. Genuinely ambiguous: Twilio may have
     * accepted the message before the connection died. Treated as retryable
     * because the alternative is dropping messages during a network blip, and
     * the duplicate risk is carried by the dedupe key rather than by hoping.
     */
    throw new SmsProviderError(`Twilio request failed: ${error?.message || "network error"}`, {
      reason: "provider_unreachable",
      retryable: true,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const code = payload?.code || "";
    const { retryable, reason } = classifyTwilioError({ code, status: response.status });
    throw new SmsProviderError(
      String(payload?.message || `Twilio returned ${response.status}`).slice(0, 300),
      { code, status: response.status, retryable, reason }
    );
  }

  return {
    sid: String(payload?.sid || ""),
    status: String(payload?.status || "queued"),
    numSegments: Number(payload?.num_segments || 0) || 0,
    to: maskPhone(payload?.to || to),
  };
}

/* -------------------------------------------------------------------------- */
/* Webhook authenticity                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Verify that a request really came from Twilio.
 *
 * Twilio's scheme: take the full URL it was configured to call, append every
 * POST parameter as key immediately followed by value, sorted by key, then
 * HMAC-SHA1 the result with the account auth token and base64 it. That value
 * arrives in X-Twilio-Signature.
 *
 * WHY THE URL MATTERS AS MUCH AS THE BODY
 * The URL is part of the signed material, so a signature captured from one
 * endpoint cannot be replayed against another. It has to be the URL Twilio
 * used, which behind a load balancer is not what Express reconstructs by
 * default — hence the explicit url argument rather than reading req.
 *
 * Compared in constant time. A byte-by-byte early return here leaks how much of
 * a guessed signature was right, which is exactly enough to forge one.
 */
function validateTwilioSignature({ url, params = {}, signature, authToken }) {
  const token = String(authToken || twilioCredentials().authToken || "");
  if (!token) return { valid: false, reason: "auth_token_not_configured" };
  if (!signature) return { valid: false, reason: "missing_signature" };
  if (!url) return { valid: false, reason: "missing_url" };

  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + String(params[key] ?? ""), String(url));

  const expected = crypto.createHmac("sha1", token).update(Buffer.from(data, "utf-8")).digest("base64");

  const provided = Buffer.from(String(signature), "utf8");
  const computed = Buffer.from(expected, "utf8");
  if (provided.length !== computed.length) {
    return { valid: false, reason: "signature_mismatch" };
  }
  const valid = crypto.timingSafeEqual(provided, computed);
  return { valid, reason: valid ? "ok" : "signature_mismatch" };
}

/**
 * The URL Twilio signed, rebuilt from the request.
 *
 * Behind a proxy the protocol and host Express sees are the internal ones, so
 * the forwarded headers are preferred when present. The configured callback URL
 * wins over both when it is set, because that is by definition the address
 * Twilio was told to call and therefore the one it signed.
 */
function webhookUrlFor(req, configuredUrl = "") {
  if (configuredUrl) return configuredUrl;
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "https")
    .split(",")[0]
    .trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  return `${proto}://${host}${req.originalUrl || req.url || ""}`;
}

module.exports = {
  PERMANENT_TWILIO_CODES,
  RETRYABLE_TWILIO_CODES,
  SmsProviderError,
  classifyTwilioError,
  isOptOutError,
  sendMessage,
  validateTwilioSignature,
  webhookUrlFor,
};
