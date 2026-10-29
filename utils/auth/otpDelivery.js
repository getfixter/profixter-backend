const { twilioCredentials, twilioConfigured } = require("../sms/smsConfig");
const { optOutFor } = require("../sms/smsEligibility");

/**
 * Getting a sign-in code to a person.
 *
 * DELIBERATELY NOT THE SMS PIPELINE. smsService is built for notifications:
 * it requires the account's service-text consent (a sign-up has no account
 * yet), retries failures minutes later (after the code has expired) and keeps
 * the message body for Admin (which would put live codes on a screen). A code
 * the person just asked for needs none of that. What it does keep is STOP:
 * a number that has opted out is never texted, by us or, as a backstop, by
 * Twilio itself.
 *
 * FAILS CLOSED. SMS_OTP_ENABLED must be exactly "true" for a real text to go
 * out, so deploying this changes nothing until the owner switches it on.
 */

const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";
const VERIFY_API_BASE = "https://verify.twilio.com/v2";
const REQUEST_TIMEOUT_MS = 10000;

class OtpDeliveryError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

function smsOtpEnabled(env = process.env) {
  return String(env.SMS_OTP_ENABLED || "").trim().toLowerCase() === "true";
}

function verifyServiceSid(env = process.env) {
  return String(env.TWILIO_VERIFY_SERVICE_SID || "").trim();
}

/*
 * Verify calls use their own restricted API key when one is set. The sending
 * key used for notifications is deliberately restricted to messaging and
 * cannot reach Verify; granting it more, or falling back to the account's
 * master token, would widen what a leaked key can do. Least privilege: one
 * key per job.
 */
function verifyCredentials(env = process.env) {
  const base = twilioCredentials();
  const apiKey = String(env.TWILIO_VERIFY_API_KEY || "").trim();
  const apiSecret = String(env.TWILIO_VERIFY_API_SECRET || "").trim();
  return apiKey && apiSecret ? { ...base, apiKey, apiSecret } : base;
}

/**
 * The host the code is bound to, for the browser's automatic code fill.
 *
 * It must be EXACTLY the host the customer has open, or WebOTP silently does
 * nothing. That is www.profixter.com: the bare domain redirects there. Not
 * derived from CLIENT_URL on purpose - production sets that to the bare
 * domain, which would bind every code to a host nobody is ever on.
 */
function otpDomain(env = process.env) {
  return String(env.OTP_WEBOTP_DOMAIN || "www.profixter.com").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

/**
 * The text itself.
 *
 * The last line is the domain-bound format the WebOTP API and iOS/Android
 * autofill read ("@host #code"); it must be the final line, on its own.
 */
function smsBody(code, env = process.env) {
  return `Your Profixter code is ${code}. It expires in 10 minutes. Don't share it with anyone.\n\n@${otpDomain(env)} #${code}`;
}

function authHeader(creds) {
  return `Basic ${Buffer.from(`${creds.apiKey}:${creds.apiSecret}`).toString("base64")}`;
}

async function twilioPost(url, params, creds) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: authHeader(creds),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: params.toString(),
      signal: controller.signal,
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    return { ok: response.ok, status: response.status, payload };
  } catch (error) {
    throw new OtpDeliveryError("SMS_UNAVAILABLE", `Twilio request failed: ${error?.message || "network"}`);
  } finally {
    clearTimeout(timer);
  }
}

function assertSmsReady(env) {
  if (!smsOtpEnabled(env) || !twilioConfigured()) {
    throw new OtpDeliveryError("SMS_UNAVAILABLE", "Sign-in texts are not switched on");
  }
}

async function assertNotOptedOut(e164) {
  if (await optOutFor(e164)) {
    throw new OtpDeliveryError("SMS_OPTED_OUT", "This number has opted out of texts");
  }
}

/** Text our own code (provider "local"). */
async function sendSmsCode(e164, code, { env = process.env } = {}) {
  assertSmsReady(env);
  await assertNotOptedOut(e164);
  const creds = twilioCredentials();
  const params = new URLSearchParams({ To: e164, Body: smsBody(code, env) });
  if (creds.messagingServiceSid) params.set("MessagingServiceSid", creds.messagingServiceSid);
  else params.set("From", creds.phoneNumber);
  const url = `${TWILIO_API_BASE}/Accounts/${encodeURIComponent(creds.accountSid)}/Messages.json`;
  const result = await twilioPost(url, params, creds);
  if (!result.ok) {
    if (Number(result.payload?.code) === 21610) throw new OtpDeliveryError("SMS_OPTED_OUT");
    if ([21211, 21614, 21408].includes(Number(result.payload?.code))) throw new OtpDeliveryError("INVALID_PHONE");
    throw new OtpDeliveryError("SMS_UNAVAILABLE", `Twilio ${result.status} ${result.payload?.code || ""}`);
  }
  return { provider: "local", sid: result.payload?.sid || "" };
}

/** Ask Twilio Verify to send its own code (provider "twilio_verify"). */
async function startVerify(e164, { env = process.env } = {}) {
  assertSmsReady(env);
  await assertNotOptedOut(e164);
  const creds = verifyCredentials(env);
  const url = `${VERIFY_API_BASE}/Services/${encodeURIComponent(verifyServiceSid(env))}/Verifications`;
  const result = await twilioPost(url, new URLSearchParams({ To: e164, Channel: "sms" }), creds);
  if (!result.ok) {
    if (Number(result.payload?.code) === 60200) throw new OtpDeliveryError("INVALID_PHONE");
    throw new OtpDeliveryError("SMS_UNAVAILABLE", `Verify ${result.status} ${result.payload?.code || ""}`);
  }
  return { provider: "twilio_verify" };
}

/** Ask Twilio Verify whether this code is right. */
async function checkVerify(e164, code, { env = process.env } = {}) {
  const creds = verifyCredentials(env);
  const url = `${VERIFY_API_BASE}/Services/${encodeURIComponent(verifyServiceSid(env))}/VerificationCheck`;
  const result = await twilioPost(url, new URLSearchParams({ To: e164, Code: code }), creds);
  return result.ok && result.payload?.status === "approved";
}

/** Email the code. The email log keeps a redacted copy, never the code. */
async function sendEmailCode(email, code) {
  const mail = require("../emailService");
  await mail.sendTx("login_code", email, { code }, {
    bccAdmin: false,
    logContext: { recipientEmail: email, emailType: "transactional", source: "authEmailCode", redactBody: true },
  });
  return { provider: "local" };
}

module.exports = {
  OtpDeliveryError,
  checkVerify,
  otpDomain,
  sendEmailCode,
  sendSmsCode,
  smsBody,
  smsOtpEnabled,
  startVerify,
  verifyServiceSid,
};
