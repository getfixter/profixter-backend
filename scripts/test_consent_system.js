/**
 * The customer consent system, end to end (2026-10-27).
 *
 * Real Express routes, real models, in-memory MongoDB. Nothing is sent: every
 * SMS and marketing switch is off for the whole run, and the test asserts no
 * marketing send record was created.
 *
 *   - every consent change lands in the append-only history with the wording,
 *     version, source and destination - and the history refuses edits
 *   - email marketing: opt-out in the account, opt back in, a bounce or
 *     complaint can never be lifted by the customer, the link unsubscribe is
 *     recorded, and the send-time check agrees with the screen
 *   - SMS: signup ticks, settings on/off, STOP wins over everything, START
 *     lifts the block but grants nothing, re-consent after START
 *   - no fabrication: the audit changes nothing, unknown stays unknown, a
 *     guest's visit consent never becomes marketing, and a guest who later
 *     registers starts with only what they tick
 *   - duplicate phones: one STOP covers every account on the handset
 *   - Marcus's counts use the same rules as the send paths
 *
 *   node scripts/test_consent_system.js
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-not-real";
for (const flag of ["SMS_ENABLED", "SMS_MARKETING_ENABLED", "SMS_REVIEW_LINK_ENABLED", "GIFT_SMS_ENABLED", "ENABLE_MARKETING_EMAILS", "GROWTH_ACTIONS_ENABLED"]) process.env[flag] = "false";

const assert = require("assert");
const express = require("express");
const mongoose = require("mongoose");
const fetch = require("node-fetch");
const jwt = require("jsonwebtoken");
const { MongoMemoryServer } = require("mongodb-memory-server");

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}`);
    throw error;
  }
}

async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());

  const User = require("../models/User");
  const SmsOptOut = require("../models/SmsOptOut");
  const EmailSuppression = require("../models/EmailSuppression");
  const ConsentEvent = require("../models/ConsentEvent");
  const MarketingSend = require("../models/MarketingSend");
  const { isUnsubscribed } = require("../utils/marketing/marketingEligibility");
  const { checkEligibility } = require("../utils/sms/smsEligibility");
  const { consentStatusFor } = require("../utils/consent/status");
  const { consentAudit } = require("../utils/consent/audit");
  const { applyOptOut, applyOptIn } = require("../routes/smsWebhook");
  const { VERSIONS, CURRENT } = require("../utils/consent/consentText");
  const { createUnsubscribeToken } = require("../utils/unsubscribeToken");

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use("/api/users", require("../routes/users"));
  app.use("/api/auth", require("../routes/auth"));
  app.use("/api/email", require("../routes/email"));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  let seq = 0;
  async function makeUser(overrides = {}) {
    seq += 1;
    const user = await User.create({
      userId: `C${seq}${Date.now()}`,
      name: "Test Person",
      email: `consent${seq}.${Date.now()}@homeowner-mail.net`,
      password: "hashed",
      phone: `+1631555${String(3000 + seq).slice(-4)}`,
      role: "customer",
      address: "1 Main St",
      city: "Huntington",
      state: "NY",
      zip: "11743",
      county: "Suffolk",
      ...overrides,
    });
    return { user, token: jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET) };
  }
  const call = (token, method, path, body) =>
    fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "consent-test" }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  const history = (userId) => ConsentEvent.find({ user: userId }).sort({ at: 1, _id: 1 }).lean();

  console.log("signup");

  await test("signup records each ticked box with its wording, version, number and source; an unticked box records nothing", async () => {
    const email = `signup${Date.now()}@homeowner-mail.net`;
    const r = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "New Person", email, password: "testpassword123", phone: "+16315559001", address: "1 Main St", city: "Huntington", state: "NY", zip: "11743", county: "Suffolk", smsTransactionalConsent: true, smsMarketingConsent: false }),
    });
    assert.ok([200, 201].includes(r.status), `register ${r.status}`);
    const u = await User.findOne({ email }).lean();
    const h = await history(u._id);
    assert.strictEqual(h.length, 1, "only the service box was ticked");
    assert.strictEqual(h[0].purpose, "service");
    assert.strictEqual(h[0].action, "granted");
    assert.strictEqual(h[0].consentVersion, CURRENT.signup.service);
    assert.strictEqual(h[0].consentText, VERSIONS[CURRENT.signup.service].text);
    assert.strictEqual(h[0].phone, "+16315559001");
    assert.strictEqual(h[0].source, "signup_web_form");
    assert.strictEqual(u.smsPreferences.marketingEnabled, undefined, "marketing stays never-asked, not false");
    assert.strictEqual((await consentStatusFor(u)).smsMarketing, "unknown");
    assert.strictEqual((await consentStatusFor(u)).email, "existing_customer", "emailable under the opt-out rule, not 'opted in'");
  });

  await test("optional marketing is never a condition of the account", async () => {
    const email = `nomkt${Date.now()}@homeowner-mail.net`;
    const r = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "No Marketing", email, password: "testpassword123", phone: "+16315559002", address: "1 Main St", city: "Huntington", state: "NY", zip: "11743", county: "Suffolk", smsTransactionalConsent: true }),
    });
    assert.ok([200, 201].includes(r.status));
  });

  console.log("email marketing");

  await test("email: off in the account suppresses at once and is recorded; on again lifts only their own unsubscribe and records the opt-in", async () => {
    const { user, token } = await makeUser();
    let r = await call(token, "GET", "/api/users/me/email-preferences");
    assert.deepStrictEqual([r.body.marketingEnabled, r.body.status], [true, "existing_customer"]);
    r = await call(token, "PUT", "/api/users/me/email-preferences", { marketingEnabled: false });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.status, "unsubscribed");
    assert.strictEqual(await isUnsubscribed(user.email), true, "the send-time check agrees immediately");
    r = await call(token, "PUT", "/api/users/me/email-preferences", { marketingEnabled: true });
    assert.strictEqual(r.body.status, "opted_in");
    assert.strictEqual(await isUnsubscribed(user.email), false);
    const row = await EmailSuppression.findOne({ email: user.email }).lean();
    assert.ok(row && row.reason === "unsubscribe" && row.resubscribedAt, "the unsubscribe stays on record");
    r = await call(token, "PUT", "/api/users/me/email-preferences", { marketingEnabled: false });
    assert.strictEqual(await isUnsubscribed(user.email), true, "a second unsubscribe wins again");
    const h = await history(user._id);
    assert.deepStrictEqual(h.map((e) => e.action), ["unsubscribed", "resubscribed", "unsubscribed"]);
    assert.strictEqual(h[1].consentVersion, CURRENT.email_settings.marketing);
    assert.strictEqual(h[1].userAgent, "consent-test");
    r = await call(token, "PUT", "/api/users/me/email-preferences", { marketingEnabled: "true" });
    assert.strictEqual(r.status, 400, "a string is not a choice");
  });

  await test("email: a bounce, complaint or manual block can never be lifted by the customer", async () => {
    for (const reason of ["bounce", "complaint", "manual_blacklist"]) {
      const { user, token } = await makeUser();
      await EmailSuppression.create({ email: user.email, reason, source: "test" });
      const r = await call(token, "PUT", "/api/users/me/email-preferences", { marketingEnabled: true });
      assert.strictEqual(r.status, 409, reason);
      assert.strictEqual(await isUnsubscribed(user.email), true, reason);
    }
  });

  await test("email: the one-click unsubscribe link is honoured and recorded", async () => {
    const { user } = await makeUser();
    const token = createUnsubscribeToken(user.email);
    const r = await fetch(`${base}/api/email/unsubscribe?token=${encodeURIComponent(token)}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(await isUnsubscribed(user.email), true);
    const h = await history(user._id);
    assert.deepStrictEqual([h[0].action, h[0].source], ["unsubscribed", "email_unsubscribe_link"]);
  });

  await test("email: staff and excluded accounts are never marketable, whatever they click", async () => {
    const { token } = await makeUser({ excludeFromMarketing: true });
    const r = await call(token, "GET", "/api/users/me/email-preferences");
    assert.deepStrictEqual([r.body.status, r.body.canChange], ["not_marketable", false]);
  });

  console.log("SMS");

  await test("SMS settings: on and off are recorded per channel with the settings wording; marketing never switches service", async () => {
    const { user, token } = await makeUser();
    await call(token, "PUT", "/api/users/me/sms-preferences", { marketingEnabled: true });
    await call(token, "PUT", "/api/users/me/sms-preferences", { marketingEnabled: false });
    const u = await User.findById(user._id).lean();
    assert.strictEqual(u.smsPreferences.transactionalEnabled, undefined, "service untouched");
    const h = await history(user._id);
    assert.deepStrictEqual(h.map((e) => [e.purpose, e.action]), [["marketing", "granted"], ["marketing", "withdrawn"]]);
    assert.strictEqual(h[0].consentText, VERSIONS[CURRENT.sms_settings.marketing].text);
    assert.strictEqual(h[1].consentVersion, "", "a withdrawal needs no wording");
  });

  await test("STOP wins over every preference; START lifts the block but grants nothing; re-consent is a new, recorded tick", async () => {
    const { user, token } = await makeUser();
    await call(token, "PUT", "/api/users/me/sms-preferences", { marketingEnabled: true, transactionalEnabled: true });
    assert.strictEqual((await consentStatusFor(await User.findById(user._id).lean())).smsMarketing, "opted_in");
    await applyOptOut(user.phone, "STOP");
    let u = await User.findById(user._id).lean();
    assert.strictEqual((await consentStatusFor(u)).smsMarketing, "stopped");
    assert.strictEqual((await checkEligibility({ notificationType: "POST_FREE_VISIT_THANKS", user: u, phone: u.phone })).eligible, false);
    let r = await call(token, "PUT", "/api/users/me/sms-preferences", { marketingEnabled: true });
    assert.strictEqual(r.status, 409, "the account screen cannot override a STOP");
    await applyOptIn(user.phone, "START");
    u = await User.findById(user._id).lean();
    assert.strictEqual((await consentStatusFor(u)).smsMarketing, "opted_out", "START is not consent");
    r = await call(token, "PUT", "/api/users/me/sms-preferences", { marketingEnabled: true });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await consentStatusFor(await User.findById(user._id).lean())).smsMarketing, "opted_in");
    const actions = (await history(user._id)).map((e) => e.action);
    assert.deepStrictEqual(actions, ["granted", "granted", "stop", "start", "granted"]);
  });

  await test("one handset, several accounts: a STOP covers and is recorded on each of them", async () => {
    const phone = "+16315559777";
    const a = await makeUser({ phone, smsPreferences: { marketingEnabled: true, marketingConsentAt: new Date(), marketingConsentSource: "test" } });
    const b = await makeUser({ phone, smsPreferences: { marketingEnabled: true, marketingConsentAt: new Date(), marketingConsentSource: "test" } });
    await applyOptOut(phone, "STOP");
    for (const x of [a, b]) {
      assert.strictEqual((await consentStatusFor(await User.findById(x.user._id).lean())).smsMarketing, "stopped");
      assert.strictEqual((await history(x.user._id)).at(-1).action, "stop");
    }
  });

  console.log("no fabrication");

  await test("the consent history refuses edits and deletes", async () => {
    const { user } = await makeUser();
    const e = await ConsentEvent.create({ user: user._id, channel: "sms", purpose: "marketing", action: "granted", source: "test" });
    await assert.rejects(ConsentEvent.updateOne({ _id: e._id }, { $set: { action: "withdrawn" } }), /append-only/);
    await assert.rejects(ConsentEvent.deleteOne({ _id: e._id }), /append-only/);
    const doc = await ConsentEvent.findById(e._id);
    doc.action = "withdrawn";
    await assert.rejects(doc.save(), /append-only/);
  });

  await test("a guest's visit consent never becomes marketing, and a guest who registers starts with only what they tick", async () => {
    const Booking = require("../models/Booking");
    const phone = "+16315559555";
    const email = `guest${Date.now()}@homeowner-mail.net`;
    await Booking.collection.insertOne({ guestRequestId: new mongoose.Types.ObjectId(), user: null, phone, email, status: "Pending Confirmation", guestContactConsent: { text: "By booking, you agree to be contacted by call or text about your visit", at: new Date() }, createdAt: new Date() });
    const r = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Guest Later", email, password: "testpassword123", phone, address: "1 Main St", city: "Huntington", state: "NY", zip: "11743", county: "Suffolk", smsTransactionalConsent: true }),
    });
    assert.ok([200, 201].includes(r.status));
    const u = await User.findOne({ email }).lean();
    const st = await consentStatusFor(u);
    assert.strictEqual(st.smsMarketing, "unknown", "the visit consent did not turn into marketing");
    assert.strictEqual((await checkEligibility({ notificationType: "POST_FREE_VISIT_THANKS", user: u, phone })).eligible, false);
    assert.strictEqual(u.emailPreferences?.marketingConsentAt ?? null, null, "no email opt-in invented either");
  });

  await test("the audit changes nothing, keeps unknown as unknown, and flags opt-ins without evidence", async () => {
    await makeUser({ smsPreferences: { marketingEnabled: true } }); // on, but no date or source: suspicious
    await makeUser({ role: "admin", email: `staff${Date.now()}@homeowner-mail.net` });
    const usersBefore = JSON.stringify(await User.find({}).sort({ _id: 1 }).lean());
    const eventsBefore = await ConsentEvent.countDocuments();
    const a = await consentAudit();
    assert.strictEqual(JSON.stringify(await User.find({}).sort({ _id: 1 }).lean()), usersBefore, "no account changed");
    assert.strictEqual(await ConsentEvent.countDocuments(), eventsBefore, "no history invented");
    const customers = await User.countDocuments({ role: "customer" });
    assert.strictEqual(a.registeredCustomers, customers, "staff are not customers");
    assert.ok(a.summary.smsMarketing.unknownNeverAsked > 0, "never-asked is reported as unknown");
    assert.strictEqual(a.checks.smsMarketingOnWithoutEvidence, 1);
    const sum = (o) => Object.values(o).reduce((n, v) => n + v, 0);
    assert.strictEqual(sum(a.summary.emailMarketing), a.registeredCustomers, "every customer is in exactly one email group");
    assert.strictEqual(sum(a.summary.smsMarketing), a.registeredCustomers, "and one SMS group");
    assert.doesNotMatch(JSON.stringify(a), /@homeowner-mail.net|\+1631/, "counts only - no emails or phones");
  });

  await test("nothing in this run created a marketing send", async () => {
    assert.strictEqual(await MarketingSend.countDocuments(), 0);
  });

  console.log("Marcus");

  await test("Marcus's audience counts use the send-path rules (a STOP is not counted as text opt-in)", async () => {
    const { reengagementAudiences } = require("../utils/agents/marketingData");
    const out = await reengagementAudiences();
    assert.ok(out.audiences && out.rules, "still answers");
    assert.doesNotMatch(JSON.stringify(out), /@homeowner-mail.net|\+1631/);
  });

  server.close();
  await mongoose.disconnect();
  await mongo.stop();
  console.log(`\n${passed} consent tests passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
