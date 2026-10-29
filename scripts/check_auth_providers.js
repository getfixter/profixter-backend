/**
 * Is sign-in ready to switch on? A read-only check of Google, Apple and Twilio.
 *
 * Reads configuration from the environment and asks each provider, read-only,
 * whether it is set up. Never prints a secret (only the last 4 characters of
 * an id) and never changes anything at a provider.
 *
 *   node scripts/check_auth_providers.js
 *   node scripts/check_auth_providers.js --send-test-code +16315551234
 *
 * The second form sends ONE real sign-in text to the number given - your own -
 * through exactly the path customers will use. It is the final proof that SMS
 * works end to end, and it is never run unless you pass the flag.
 */

const results = [];
const tail = (value) => (value ? `…${String(value).slice(-4)}` : "(not set)");
const ok = (area, message) => results.push({ area, status: "OK", message });
const warn = (area, message) => results.push({ area, status: "WARN", message });
const fail = (area, message) => results.push({ area, status: "FAIL", message });

async function getJson(url, headers = {}) {
  const response = await fetch(url, { headers });
  let body = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  return { ok: response.ok, status: response.status, body };
}

async function checkGoogle(env) {
  const ids = String(env.GOOGLE_CLIENT_ID || "").split(",").map((v) => v.trim()).filter(Boolean);
  if (!ids.length) return fail("Google", "GOOGLE_CLIENT_ID is not set on the backend.");
  for (const id of ids) {
    if (/\.apps\.googleusercontent\.com$/.test(id)) ok("Google", `Client id ${tail(id.replace(/\.apps\.googleusercontent\.com$/, ""))} has the right shape.`);
    else fail("Google", `Client id ${tail(id)} is not an OAuth Web client id (…apps.googleusercontent.com).`);
  }
  const certs = await getJson("https://www.googleapis.com/oauth2/v3/certs");
  if (certs.ok && certs.body.keys?.length) ok("Google", "Google's signing keys are reachable from this server.");
  else fail("Google", `Google's signing keys could not be fetched (HTTP ${certs.status}).`);
  warn("Google", "Also set NEXT_PUBLIC_GOOGLE_CLIENT_ID on Vercel to the SAME client id (cannot be checked from here).");
}

async function checkApple(env) {
  const ids = String(env.APPLE_CLIENT_IDS || env.APPLE_CLIENT_ID || "").split(",").map((v) => v.trim()).filter(Boolean);
  if (!ids.length) return fail("Apple", "APPLE_CLIENT_IDS is not set on the backend (your Services ID).");
  ok("Apple", `Accepting tokens for: ${ids.map((id) => id.replace(/^(.{4}).*(.{4})$/, "$1…$2")).join(", ")}`);
  const keys = await getJson("https://appleid.apple.com/auth/keys");
  if (keys.ok && keys.body.keys?.length) ok("Apple", "Apple's signing keys are reachable from this server.");
  else fail("Apple", `Apple's signing keys could not be fetched (HTTP ${keys.status}).`);
  warn("Apple", "Also set NEXT_PUBLIC_APPLE_CLIENT_ID and NEXT_PUBLIC_APPLE_REDIRECT_URI on Vercel, and register your email domain for Hide My Email (cannot be checked from here).");
}

async function checkTwilio(env) {
  const sid = env.TWILIO_ACCOUNT_SID;
  const key = env.TWILIO_API_KEY;
  const secret = env.TWILIO_API_SECRET;
  if (!sid || !key || !secret) return fail("Twilio", "TWILIO_ACCOUNT_SID / TWILIO_API_KEY / TWILIO_API_SECRET are not all set.");
  /*
   * Read-only lookups use the account token when present: the sending key may
   * be a RESTRICTED key (allowed to send, not to read), which is good practice
   * and must not be reported as broken.
   */
  const keyAuth = { Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}` };
  const auth = env.TWILIO_AUTH_TOKEN
    ? { Authorization: `Basic ${Buffer.from(`${sid}:${env.TWILIO_AUTH_TOKEN}`).toString("base64")}` }
    : keyAuth;

  const account = await getJson(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}.json`, auth);
  if (account.ok) ok("Twilio", `Account ${tail(sid)} reachable; status "${account.body.status}".`);
  else return fail("Twilio", `Account could not be read (HTTP ${account.status}).`);
  const keyRead = await getJson(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}.json`, keyAuth);
  if (!keyRead.ok) ok("Twilio", `Sending key ${tail(key)} cannot read the account: a restricted key, as it should be. Production texts prove it can send.`);

  const verifySid = String(env.TWILIO_VERIFY_SERVICE_SID || "").trim();
  if (verifySid) {
    const service = await getJson(`https://verify.twilio.com/v2/Services/${encodeURIComponent(verifySid)}`, auth);
    if (service.ok) ok("Twilio", `Verify service ${tail(verifySid)} found: "${service.body.friendly_name}", code length ${service.body.code_length}.`);
    else fail("Twilio", `Verify service ${tail(verifySid)} not found (HTTP ${service.status}).`);
    // The key the backend will actually use for Verify must be able to reach it.
    const vKey = env.TWILIO_VERIFY_API_KEY || key;
    const vSecret = env.TWILIO_VERIFY_API_SECRET || secret;
    const viaKey = await getJson(`https://verify.twilio.com/v2/Services/${encodeURIComponent(verifySid)}`, {
      Authorization: `Basic ${Buffer.from(`${vKey}:${vSecret}`).toString("base64")}`,
    });
    if (viaKey.ok) ok("Twilio", `Verify key ${tail(vKey)} can use the Verify service.`);
    else fail("Twilio", `Key ${tail(vKey)} cannot use Verify (HTTP ${viaKey.status}): create a restricted key with Verify permissions and set TWILIO_VERIFY_API_KEY / TWILIO_VERIFY_API_SECRET.`);
  } else {
    warn("Twilio", "No TWILIO_VERIFY_SERVICE_SID: codes would be sent through your own Messaging Service (see the A2P use case below).");
  }

  const mg = String(env.TWILIO_MESSAGING_SERVICE_SID || "").trim();
  if (mg) {
    const service = await getJson(`https://messaging.twilio.com/v1/Services/${encodeURIComponent(mg)}`, auth);
    if (service.ok) ok("Twilio", `Messaging Service ${tail(mg)} found: "${service.body.friendly_name}".`);
    else warn("Twilio", `Messaging Service ${tail(mg)} could not be read (HTTP ${service.status}).`);
    const a2p = await getJson(`https://messaging.twilio.com/v1/Services/${encodeURIComponent(mg)}/Compliance/Usa2p`, auth);
    const campaigns = a2p.body.compliance || [];
    for (const campaign of campaigns) {
      const useCase = String(campaign.us_app_to_person_usecase || "");
      const status = String(campaign.campaign_status || "");
      const coversCodes = /2FA|MIXED|ACCOUNT_NOTIFICATION/i.test(useCase);
      const line = `A2P campaign ${tail(campaign.sid)}: use case "${useCase}", status "${status}".`;
      if (!verifySid && !coversCodes) warn("Twilio", `${line} Sign-in codes are not obviously covered by this use case: use Twilio Verify, or register a campaign that includes verification codes, before switching phone sign-in on.`);
      else ok("Twilio", line);
    }
    if (!campaigns.length) warn("Twilio", "No A2P campaign is attached to the Messaging Service.");
  } else if (!verifySid) {
    fail("Twilio", "Neither TWILIO_VERIFY_SERVICE_SID nor TWILIO_MESSAGING_SERVICE_SID is set.");
  }

  if (String(env.SMS_OTP_ENABLED || "").toLowerCase() === "true") ok("Twilio", "SMS_OTP_ENABLED=true: phone sign-in texts will send.");
  else warn("Twilio", "SMS_OTP_ENABLED is not \"true\": phone sign-in is switched off (by design until you enable it).");
}

async function sendTestCode(number) {
  const { normalizePhoneE164 } = require("../utils/identity");
  const e164 = normalizePhoneE164(number);
  if (!e164) return fail("Live SMS", `${number} is not a valid US number.`);
  const delivery = require("../utils/auth/otpDelivery");
  const { newCode } = require("../utils/auth/otpService");
  try {
    if (delivery.verifyServiceSid()) await delivery.startVerify(e164);
    else await delivery.sendSmsCode(e164, newCode());
    ok("Live SMS", `One sign-in text sent to …${e164.slice(-4)}. Check your phone: it should offer to fill the code.`);
  } catch (error) {
    fail("Live SMS", `Sending failed: ${error.code || error.message}`);
  }
}

(async () => {
  const env = process.env;
  await checkGoogle(env).catch((e) => fail("Google", e.message));
  await checkApple(env).catch((e) => fail("Apple", e.message));
  await checkTwilio(env).catch((e) => fail("Twilio", e.message));
  const flag = process.argv.indexOf("--send-test-code");
  if (flag > -1) await sendTestCode(process.argv[flag + 1]);
  for (const r of results) console.log(`${r.status.padEnd(4)}  ${r.area.padEnd(8)}  ${r.message}`);
  const failed = results.filter((r) => r.status === "FAIL").length;
  console.log(`\n${failed ? `${failed} problem(s) to fix` : "No blocking problems found"}`);
  process.exit(failed ? 1 : 0);
})();
