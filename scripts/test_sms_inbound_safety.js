/**
 * The unmonitored number: what it does when somebody texts or rings it, and
 * the one time it introduces itself.
 *
 * 631-888-6340 sends appointment reminders and nothing else. People will text
 * it back and people will ring it, because it is the number on the message in
 * their hand, and both of those have to end somewhere sensible rather than in
 * silence or in a loop.
 *
 * THE CASE THIS FILE REALLY EXISTS FOR is the loop. An auto-responder that
 * answers every inbound message will, sooner or later, meet another
 * auto-responder and the two will talk until somebody reads the bill. The
 * protection has to be durable - surviving a redeploy, a second instance and a
 * retried webhook delivery - so it is the unique index on dedupeKey, and the
 * tests below prove it holds across repeated deliveries rather than within one
 * process.
 *
 * The second theme is the launch blast. When SMS_ENABLED eventually becomes
 * true, nothing historical may wake up: not the fifty rows already in the
 * database, not an introduction for every customer who opted in early, not a
 * queue that has been quietly filling. Those cases are at the end.
 */
const assert = require("assert");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
/* Explicitly off for the whole file. Several cases assert on that directly. */
delete process.env.SMS_ENABLED;
delete process.env.SMS_MARKETING_ENABLED;
delete process.env.GIFT_SMS_ENABLED;
delete process.env.SMS_REVIEW_LINK_ENABLED;

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error?.message || error}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

async function main() {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  const User = require("../models/User");
  const SmsMessage = require("../models/SmsMessage");
  const SmsOptOut = require("../models/SmsOptOut");
  const smsTypes = require("../utils/sms/smsTypes");
  const templates = require("../utils/sms/smsTemplates");
  const { checkEligibility } = require("../utils/sms/smsEligibility");
  const { runSmsRetrySweep } = require("../utils/sms/smsService");
  const voiceRoute = require("../routes/voiceWebhook");
  const smsNotify = require("../utils/sms/smsNotifications");

  await SmsMessage.init();
  await SmsOptOut.init();

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use("/api/users", require("../routes/users"));
  app.use("/api/sms/webhook", require("../routes/smsWebhook"));
  app.use("/api/voice/webhook", voiceRoute);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  let seq = 0;
  async function makeUser(overrides = {}) {
    seq += 1;
    const user = await User.create({
      userId: `I${seq}${Date.now()}`,
      name: "Dana Whitfield",
      email: `inbound${seq}.${Date.now()}@example.com`,
      password: "hashed",
      phone: overrides.phone || `+1631555${String(6000 + seq).slice(-4)}`,
      role: "customer",
      address: "14 Bayview Ave",
      city: "Babylon",
      state: "NY",
      zip: "11702",
      county: "Suffolk",
      ...overrides,
    });
    return { user, token: jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET) };
  }

  const prefsPut = (token, body) =>
    fetch(`${base}/api/users/me/sms-preferences`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  /*
   * The webhooks verify a Twilio signature and there is no auth token in a
   * test environment, so every HTTP call to them is refused before the handler
   * runs. That is itself worth asserting, but it means the behavioural cases
   * drive the exported helpers directly rather than pretending to be Twilio.
   * Forging a signature to get past our own guard would be testing a system we
   * do not ship.
   */
  const webhook = require("../routes/smsWebhook");

  /* ==================================================================== */
  section("The webhooks refuse anything unsigned");

  await test("an unsigned inbound POST is refused, and nothing is written", async () => {
    const before = await SmsMessage.countDocuments();
    const res = await fetch(`${base}/api/sms/webhook/inbound`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "From=%2B16315550147&Body=hello",
    });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(await SmsMessage.countDocuments(), before, "a refused webhook wrote a row");
  });

  await test("an unsigned voice POST is refused", async () => {
    const res = await fetch(`${base}/api/voice/webhook/inbound`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "CallSid=CA123&From=%2B16315550147",
    });
    assert.strictEqual(res.status, 403);
    const body = await res.text();
    assert.ok(!/<Response>/.test(body), "a refused call must not receive TwiML");
  });

  /* ==================================================================== */
  section("Ordinary inbound text");

  await test("an ordinary reply produces exactly one informational response", async () => {
    const phone = "+16315557001";
    await webhook.replyThatNobodyIsReading(phone, { MessageSid: "SM1" });
    const rows = await SmsMessage.find({ toPhone: phone, notificationType: "INBOUND_INFO_REPLY" });
    assert.strictEqual(rows.length, 1, "expected exactly one reply row");
    assert.match(rows[0].body, /only for automated notifications/i);
    assert.match(rows[0].body, /631-599-1363/);
    assert.match(rows[0].body, /Reply STOP to opt out/i);
  });

  await test("a duplicate webhook delivery does not produce a second response", async () => {
    const phone = "+16315557002";
    await webhook.replyThatNobodyIsReading(phone, { MessageSid: "SM2" });
    /* Same number, same day, different SID - a Twilio retry, or a second instance. */
    await webhook.replyThatNobodyIsReading(phone, { MessageSid: "SM2" });
    await webhook.replyThatNobodyIsReading(phone, { MessageSid: "SM2-retry" });
    const n = await SmsMessage.countDocuments({
      toPhone: phone,
      notificationType: "INBOUND_INFO_REPLY",
    });
    assert.strictEqual(n, 1, "the dedupe key must collapse repeat deliveries onto one reply");
  });

  await test("ten rapid inbound messages still produce one response", async () => {
    /* The loop, simulated: another automaton answering us over and over. */
    const phone = "+16315557003";
    for (let i = 0; i < 10; i += 1) {
      await webhook.replyThatNobodyIsReading(phone, { MessageSid: `SM-loop-${i}` });
    }
    const n = await SmsMessage.countDocuments({
      toPhone: phone,
      notificationType: "INBOUND_INFO_REPLY",
    });
    assert.strictEqual(n, 1, "a loop must not produce a message per exchange");
  });

  await test("the protection is durable, not in-memory", async () => {
    /*
     * The guard has to survive the process. Dropping the module cache is the
     * closest thing to a redeploy available here: if the protection lived in a
     * variable it would be reset by this and the second call would send.
     */
    const phone = "+16315557004";
    await webhook.replyThatNobodyIsReading(phone, { MessageSid: "SM4" });
    for (const key of Object.keys(require.cache)) {
      if (/smsWebhook|smsService/.test(key)) delete require.cache[key];
    }
    const reloaded = require("../routes/smsWebhook");
    await reloaded.replyThatNobodyIsReading(phone, { MessageSid: "SM4-after-restart" });
    const n = await SmsMessage.countDocuments({
      toPhone: phone,
      notificationType: "INBOUND_INFO_REPLY",
    });
    assert.strictEqual(n, 1, "the guard did not survive a module reload");
  });

  await test("a number under STOP gets silence, not an explanation", async () => {
    const phone = "+16315557005";
    await SmsOptOut.create({ phone, scope: "all", source: "carrier_keyword", optedOutAt: new Date() });
    await webhook.replyThatNobodyIsReading(phone, { MessageSid: "SM5" });
    const n = await SmsMessage.countDocuments({
      toPhone: phone,
      notificationType: "INBOUND_INFO_REPLY",
    });
    assert.strictEqual(n, 0, "replying to an opted-out number is the one unforgivable version");
  });

  await test("our own number never gets answered", async () => {
    process.env.TWILIO_PHONE_NUMBER = "+16318886340";
    try {
      await webhook.replyThatNobodyIsReading("+16318886340", { MessageSid: "SM-self" });
      const n = await SmsMessage.countDocuments({
        toPhone: "+16318886340",
        notificationType: "INBOUND_INFO_REPLY",
      });
      assert.strictEqual(n, 0, "a self-addressed loop must die before any database work");
    } finally {
      delete process.env.TWILIO_PHONE_NUMBER;
    }
  });

  await test("the reply is one GSM-7 segment", () => {
    const body = templates.renderSms("INBOUND_INFO_REPLY", {});
    const phone = require("../utils/sms/smsPhone");
    assert.strictEqual(phone.isUnicodeBody(body), false);
    assert.strictEqual(phone.estimateSegments(body), 1, `${body.length} chars`);
  });

  await test("with SMS_ENABLED off the reply is recorded, never sent", async () => {
    const rows = await SmsMessage.find({ notificationType: "INBOUND_INFO_REPLY" }).lean();
    assert.ok(rows.length > 0, "expected reply rows from the cases above");
    for (const row of rows) {
      assert.strictEqual(row.status, "simulated", `status was ${row.status}`);
      assert.ok(!row.providerMessageSid, "nothing may reach a provider");
    }
  });

  /* ==================================================================== */
  section("Compliance keywords are untouched");

  await test("the keyword sets still recognise every Twilio variant", () => {
    const src = require("fs").readFileSync(require("path").join(__dirname, "..", "routes", "smsWebhook.js"), "utf8");
    for (const word of ["stop", "stopall", "unsubscribe", "cancel", "end", "quit"]) {
      assert.ok(src.includes(`"${word}"`), `STOP variant ${word} missing`);
    }
    for (const word of ["start", "unstop", "yes"]) {
      assert.ok(src.includes(`"${word}"`), `START variant ${word} missing`);
    }
    for (const word of ["help", "info"]) {
      assert.ok(src.includes(`"${word}"`), `HELP variant ${word} missing`);
    }
  });

  await test("a compliance keyword never triggers the informational reply", () => {
    /*
     * Structural: the auto-reply is reached only from the final else, after
     * STOP, START and HELP have each been handled and the branch closed.
     */
    const src = require("fs").readFileSync(require("path").join(__dirname, "..", "routes", "smsWebhook.js"), "utf8");
    const stopAt = src.indexOf("STOP_WORDS.has(keyword)");
    const startAt = src.indexOf("START_WORDS.has(keyword)");
    const helpAt = src.indexOf("HELP_WORDS.has(keyword)");
    const replyAt = src.indexOf("replyThatNobodyIsReading(from");
    for (const [name, at] of [["STOP", stopAt], ["START", startAt], ["HELP", helpAt]]) {
      assert.ok(at > -1 && at < replyAt, `${name} must be handled before the auto-reply`);
    }
  });

  await test("STOP still clears both consents and records the opt-out", async () => {
    const { user } = await makeUser({
      phone: "+16315557010",
      smsPreferences: { transactionalEnabled: true, marketingEnabled: true },
    });
    await webhook.applyOptOut("+16315557010", "stop");
    const fresh = await User.findById(user._id).lean();
    assert.strictEqual(fresh.smsPreferences.transactionalEnabled, false);
    assert.strictEqual(fresh.smsPreferences.marketingEnabled, false);
    const row = await SmsOptOut.findOne({ phone: "+16315557010" }).lean();
    assert.ok(row, "the opt-out record is the audit trail and must exist");
    assert.strictEqual(row.scope, "all");
  });

  await test("START lifts the block and restores neither consent", async () => {
    const { user } = await makeUser({ phone: "+16315557011" });
    await webhook.applyOptOut("+16315557011", "stop");
    await webhook.applyOptIn("+16315557011", "start");
    const fresh = await User.findById(user._id).lean();
    assert.notStrictEqual(fresh.smsPreferences?.transactionalEnabled, true, "START granted service consent");
    assert.notStrictEqual(fresh.smsPreferences?.marketingEnabled, true, "START granted marketing consent");
  });

  /* ==================================================================== */
  section("Inbound calls");

  await test("the announcement names the office line and nothing else", () => {
    assert.match(voiceRoute.ANNOUNCEMENT, /automated ProFixter notifications/i);
    assert.match(voiceRoute.ANNOUNCEMENT, /does not accept calls/i);
    assert.match(voiceRoute.ANNOUNCEMENT, /631 599 1363/);
  });

  await test("the TwiML announces and then hangs up", () => {
    const twiml = voiceRoute.announcementTwiml();
    assert.match(twiml, /<Say/);
    assert.match(twiml, /<Hangup\/>/);
    assert.ok(twiml.indexOf("<Say") < twiml.indexOf("<Hangup/>"), "it must speak before hanging up");
  });

  await test("the call never forwards, rings, queues, records or takes a message", () => {
    const twiml = voiceRoute.announcementTwiml();
    for (const verb of ["<Dial", "<Record", "<Enqueue", "<Conference", "<Sip", "<Client", "<Number", "<Voicemail"]) {
      assert.ok(!twiml.includes(verb), `${verb} must never appear in the call response`);
    }
    const src = require("fs").readFileSync(require("path").join(__dirname, "..", "routes", "voiceWebhook.js"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const verb of ["<Dial", "<Record", "<Enqueue", "<Conference"]) {
      assert.ok(!code.includes(verb), `${verb} must not exist anywhere in the route`);
    }
  });

  /* ==================================================================== */
  section("The one-time number introduction");

  await test("an explicit service opt-in sends it exactly once", async () => {
    const { user, token } = await makeUser({ phone: "+16315557020" });
    const res = await prefsPut(token, { transactionalEnabled: true });
    assert.strictEqual(res.status, 200);
    const n = await SmsMessage.countDocuments({
      user: user._id,
      notificationType: "SMS_NUMBER_INTRODUCTION",
    });
    assert.strictEqual(n, 1);
  });

  await test("toggling off and on again does not send it twice", async () => {
    const { user, token } = await makeUser({ phone: "+16315557021" });
    await prefsPut(token, { transactionalEnabled: true });
    await prefsPut(token, { transactionalEnabled: false });
    await prefsPut(token, { transactionalEnabled: true });
    const n = await SmsMessage.countDocuments({
      user: user._id,
      notificationType: "SMS_NUMBER_INTRODUCTION",
    });
    assert.strictEqual(n, 1, "once per account, forever");
  });

  await test("marketing consent alone cannot trigger it", async () => {
    const { user, token } = await makeUser({ phone: "+16315557022" });
    await prefsPut(token, { marketingEnabled: true });
    const n = await SmsMessage.countDocuments({
      user: user._id,
      notificationType: "SMS_NUMBER_INTRODUCTION",
    });
    assert.strictEqual(n, 0);
  });

  await test("being a member cannot trigger it", async () => {
    const { user } = await makeUser({ phone: "+16315557023", subscriptionType: "premium" });
    const n = await SmsMessage.countDocuments({
      user: user._id,
      notificationType: "SMS_NUMBER_INTRODUCTION",
    });
    assert.strictEqual(n, 0, "membership is not consent and never has been");
  });

  await test("having a phone number cannot trigger it", async () => {
    const { user } = await makeUser({ phone: "+16315557024" });
    const n = await SmsMessage.countDocuments({
      user: user._id,
      notificationType: "SMS_NUMBER_INTRODUCTION",
    });
    assert.strictEqual(n, 0);
  });

  await test("it requires transactionalEnabled === true at send time", async () => {
    const { user } = await makeUser({
      phone: "+16315557025",
      smsPreferences: { transactionalEnabled: false },
    });
    const verdict = await checkEligibility({
      notificationType: "SMS_NUMBER_INTRODUCTION",
      user,
      phone: user.phone,
    });
    assert.strictEqual(verdict.eligible, false);
    assert.strictEqual(verdict.reason, "transactional_disabled_by_user");
  });

  await test("registration does not also send it - ACCOUNT_CREATED stands alone", () => {
    /*
     * The trigger lives in the account-settings route only. If it were moved
     * into registration a new customer would receive a welcome and an
     * explanation of the number that just welcomed them, seconds apart.
     */
    const fs = require("fs");
    const path = require("path");
    const auth = fs.readFileSync(path.join(__dirname, "..", "routes", "auth.js"), "utf8");
    assert.ok(
      !auth.includes("notifySmsNumberIntroduction"),
      "registration must not send the introduction"
    );
    const users = fs.readFileSync(path.join(__dirname, "..", "routes", "users.js"), "utf8");
    assert.ok(users.includes("notifySmsNumberIntroduction"), "the account-settings path must send it");
  });

  /* ==================================================================== */
  section("Enabling SMS_ENABLED cannot blast anybody");

  await test("the introduction recorded while disabled is simulated and owns its key", async () => {
    const rows = await SmsMessage.find({ notificationType: "SMS_NUMBER_INTRODUCTION" }).lean();
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.strictEqual(row.status, "simulated");
      assert.ok(row.dedupeKey, "the key is what prevents a later replay");
    }
  });

  await test("the retry sweep ignores simulated and suppressed rows entirely", async () => {
    const before = await SmsMessage.countDocuments({ status: { $in: ["sent", "delivered"] } });
    process.env.SMS_ENABLED = "true";
    try {
      const stats = await runSmsRetrySweep({ now: new Date() });
      assert.strictEqual(stats.retried || 0, 0, "nothing historical may be retried");
    } finally {
      delete process.env.SMS_ENABLED;
    }
    const after = await SmsMessage.countDocuments({ status: { $in: ["sent", "delivered"] } });
    assert.strictEqual(after, before, "turning the switch on sent something historical");
  });

  await test("the sweep's query is status-scoped to retry_scheduled", () => {
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "..", "utils", "sms", "smsService.js"),
      "utf8"
    );
    const at = src.indexOf("runSmsRetrySweep");
    const window = src.slice(at, at + 1200);
    assert.match(window, /status:\s*"retry_scheduled"/, "the sweep must select only retry_scheduled");
    assert.ok(
      !/status:\s*\{\s*\$in:\s*\[[^\]]*simulated/.test(window),
      "simulated rows must never be selectable"
    );
    assert.ok(
      !/status:\s*\{\s*\$in:\s*\[[^\]]*suppressed/.test(window),
      "suppressed rows must never be selectable"
    );
  });

  await test("re-running the introduction for an existing opt-in does not resend", async () => {
    /* Exactly what a well-meaning "catch everyone up" script would attempt. */
    const user = await User.findOne({ phone: "+16315557020" });
    process.env.SMS_ENABLED = "true";
    try {
      await smsNotify.notifySmsNumberIntroduction(user, "manual_backfill_attempt");
    } finally {
      delete process.env.SMS_ENABLED;
    }
    const n = await SmsMessage.countDocuments({
      user: user._id,
      notificationType: "SMS_NUMBER_INTRODUCTION",
    });
    assert.strictEqual(n, 1, "a backfill must collide with the existing key, not create a send");
  });

  await test("no scheduler scans for un-sent introductions", () => {
    const fs = require("fs");
    const path = require("path");
    for (const file of ["jobs/smsJobs.js", "jobs/bookingReminders.js", "utils/sms/smsCampaignRunner.js"]) {
      const src = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
      assert.ok(
        !src.includes("SMS_NUMBER_INTRODUCTION"),
        `${file} must not look for introductions to catch up`
      );
      assert.ok(
        !src.includes("INBOUND_INFO_REPLY"),
        `${file} must not look for inbound replies to catch up`
      );
    }
  });

  await test("both new types are transactional and neither is marketing", () => {
    for (const type of ["INBOUND_INFO_REPLY", "SMS_NUMBER_INTRODUCTION"]) {
      assert.strictEqual(smsTypes.channelClassOf(type), "transactional");
      assert.strictEqual(smsTypes.isMarketing(type), false);
    }
  });

  await test("every flag in this run stayed off", () => {
    const cfg = require("../utils/sms/smsConfig");
    assert.strictEqual(cfg.smsEnabled(), false);
    assert.strictEqual(cfg.smsMarketingEnabled(), false);
    assert.strictEqual(cfg.giftSmsEnabled(), false);
    assert.strictEqual(cfg.reviewLinkEnabled(), false);
  });

  /* ==================================================================== */
  server.close();
  await mongoose.disconnect();
  await mongod.stop();

  console.log("");
  if (failures.length) {
    console.log(`${passed} passed, ${failures.length} failed`);
    process.exit(1);
  }
  console.log(`${passed} passed, 0 failed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
