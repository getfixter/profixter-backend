/**
 * The marketing-SMS preference, end to end.
 *
 * Runs the real Express routes against a real Mongoose model on an in-memory
 * MongoDB, because the thing worth proving here is not that a handler returns
 * 200 - it is that the account screen, the register route and the send-time
 * eligibility check all agree about who may be advertised to. Stubbing any one
 * of those would prove the stub.
 *
 * WHAT THIS FILE IS REALLY GUARDING
 *
 * Two mistakes would be expensive and neither looks like a bug from the
 * outside. The first is a preference screen that quietly overrides a STOP: the
 * database would claim a consent the carrier refuses to act on, and we would
 * keep paying to attempt sends that can never arrive. The second is a marketing
 * toggle that switches off service messages too, which silences the visit
 * reminders a customer is relying on without anybody noticing until they miss
 * an appointment. Both are asserted below.
 */

const assert = require("assert");
const express = require("express");
const mongoose = require("mongoose");
const fetch = require("node-fetch");
const jwt = require("jsonwebtoken");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-not-real";
/* The four switches stay off for the whole run; see the final case. */
for (const flag of [
  "SMS_ENABLED",
  "SMS_MARKETING_ENABLED",
  "SMS_REVIEW_LINK_ENABLED",
  "GIFT_SMS_ENABLED",
]) {
  process.env[flag] = "false";
}

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
  const SmsOptOut = require("../models/SmsOptOut");
  const { checkEligibility, accountAllows } = require("../utils/sms/smsEligibility");

  const app = express();
  app.use(express.json());
  app.use("/api/users", require("../routes/users"));
  app.use("/api/auth", require("../routes/auth"));

  const server = app.listen(0);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  let seq = 0;
  async function makeUser(overrides = {}) {
    seq += 1;
    const user = await User.create({
      userId: `U${seq}${Date.now()}`,
      name: "Test Person",
      email: `pref${seq}.${Date.now()}@example.com`,
      password: "hashed",
      phone: overrides.phone || `+1631555${String(1000 + seq).slice(-4)}`,
      role: "customer",
      address: "1 Main St",
      city: "Huntington",
      state: "NY",
      zip: "11743",
      county: "Suffolk",
      ...overrides,
    });
    const token = jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET);
    return { user, token };
  }

  const api = (token) => ({
    get: () =>
      fetch(`${base}/api/users/me/sms-preferences`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    put: (body) =>
      fetch(`${base}/api/users/me/sms-preferences`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
  });

  const reload = (id) => User.findById(id).lean();

  /* ------------------------------------------------------------------ */
  section("An existing customer who was never asked");

  await test("starts OFF, because absence is not consent", async () => {
    const { token } = await makeUser();
    const body = await (await api(token).get()).json();
    assert.strictEqual(body.marketingEnabled, false);
    assert.strictEqual(body.marketingConsentAt, null);
    assert.strictEqual(body.phoneOptedOut, false);
  });

  await test("is refused marketing by the eligibility layer while off", async () => {
    const { user } = await makeUser();
    const verdict = await checkEligibility({
      notificationType: "MEMBERSHIP_MARKETING",
      user: await reload(user._id),
      phone: user.phone,
    });
    assert.strictEqual(verdict.eligible, false);
    assert.strictEqual(verdict.reason, "marketing_not_opted_in");
  });

  /* ------------------------------------------------------------------ */
  section("Opting in from account settings");

  await test("records the flag, the timestamp and the source", async () => {
    const { user, token } = await makeUser();
    const before = Date.now();
    const res = await api(token).put({ marketingEnabled: true });
    assert.strictEqual(res.status, 200);

    const row = await reload(user._id);
    assert.strictEqual(row.smsPreferences.marketingEnabled, true);
    assert.strictEqual(row.smsPreferences.marketingConsentSource, "account_settings");
    const at = new Date(row.smsPreferences.marketingConsentAt).getTime();
    assert.ok(at >= before && at <= Date.now(), "consent timestamp is the moment it was given");
  });

  await test("satisfies the account-level consent rule at send time", async () => {
    const { user, token } = await makeUser();
    await api(token).put({ marketingEnabled: true });
    const verdict = accountAllows(await reload(user._id), "MEMBERSHIP_MARKETING");
    assert.strictEqual(verdict.eligible, true, `expected eligible, got ${verdict.reason}`);
  });

  /*
   * The consent gate and the channel switch are different locks.
   *
   * checkEligibility refuses marketing on SMS_MARKETING_ENABLED before it ever
   * looks at the person, so a full-stack "eligible: true" is unreachable while
   * that switch is off - which is the state this whole project is meant to stay
   * in. What is worth asserting is that the refusal has MOVED: an opted-in
   * customer is held only by the channel, not by their own consent.
   */
  await test("is held only by the channel switch, no longer by consent", async () => {
    const { user, token } = await makeUser();
    const before = await checkEligibility({
      notificationType: "MEMBERSHIP_MARKETING",
      user: await reload(user._id),
      phone: user.phone,
    });
    assert.strictEqual(before.reason, "marketing_not_opted_in");

    await api(token).put({ marketingEnabled: true });
    const after = await checkEligibility({
      notificationType: "MEMBERSHIP_MARKETING",
      user: await reload(user._id),
      phone: user.phone,
    });
    assert.strictEqual(after.eligible, false, "the channel is off, so nothing is eligible");
    assert.strictEqual(after.reason, "marketing_channel_disabled");
  });

  await test("refuses a truthy string, so 'false' cannot opt somebody in", async () => {
    const { user, token } = await makeUser();
    const res = await api(token).put({ marketingEnabled: "false" });
    assert.strictEqual(res.status, 400);
    const row = await reload(user._id);
    assert.notStrictEqual(row.smsPreferences?.marketingEnabled, true);
  });

  /* ------------------------------------------------------------------ */
  section("Opting out of marketing only");

  await test("clears the marketing flag", async () => {
    const { user, token } = await makeUser();
    await api(token).put({ marketingEnabled: true });
    await api(token).put({ marketingEnabled: false });
    const row = await reload(user._id);
    assert.strictEqual(row.smsPreferences.marketingEnabled, false);
  });

  await test("LEAVES TRANSACTIONAL SMS ELIGIBLE - the reminder still sends", async () => {
    const { user, token } = await makeUser();
    await api(token).put({ marketingEnabled: true });
    await api(token).put({ marketingEnabled: false });

    const row = await reload(user._id);
    assert.notStrictEqual(
      row.smsPreferences.transactionalEnabled,
      false,
      "a marketing toggle must never switch off service messages"
    );
    const verdict = await checkEligibility({
      notificationType: "BOOKING_REMINDER_24H",
      user: row,
      phone: user.phone,
    });
    assert.strictEqual(verdict.eligible, true, `expected eligible, got ${verdict.reason}`);
  });

  await test("is NOT recorded as a global STOP", async () => {
    const { user, token } = await makeUser();
    await api(token).put({ marketingEnabled: true });
    await api(token).put({ marketingEnabled: false });

    const row = await reload(user._id);
    assert.ok(!row.smsPreferences.optedOutAt, "optedOutAt mirrors a handset STOP, not this");
    assert.strictEqual(row.smsPreferences.optOutSource || "", "");
    const optOut = await SmsOptOut.findOne({ phone: user.phone }).lean();
    assert.strictEqual(optOut, null, "no SmsOptOut row may be created by a preference change");
  });

  await test("keeps the consent timestamp as history", async () => {
    const { user, token } = await makeUser();
    await api(token).put({ marketingEnabled: true });
    await api(token).put({ marketingEnabled: false });
    const row = await reload(user._id);
    assert.ok(row.smsPreferences.marketingConsentAt, "when consent was given stays true afterwards");
  });

  /* ------------------------------------------------------------------ */
  section("A global STOP outranks the account screen");

  await test("opting in is REFUSED while the phone is opted out", async () => {
    const { user, token } = await makeUser();
    await SmsOptOut.create({
      phone: user.phone,
      scope: "all",
      source: "carrier_keyword",
      optedOutAt: new Date(),
    });

    const res = await api(token).put({ marketingEnabled: true });
    assert.strictEqual(res.status, 409);

    const row = await reload(user._id);
    assert.notStrictEqual(
      row.smsPreferences?.marketingEnabled,
      true,
      "a STOP must not be overridable from account settings"
    );
  });

  await test("the STOP row is never silently cleared", async () => {
    const { user, token } = await makeUser();
    await SmsOptOut.create({
      phone: user.phone,
      scope: "all",
      source: "carrier_keyword",
      optedOutAt: new Date(),
    });
    await api(token).put({ marketingEnabled: true });

    const optOut = await SmsOptOut.findOne({ phone: user.phone }).lean();
    assert.ok(optOut, "the withdrawal record must survive");
    assert.ok(!optOut.optedInAt, "and must not be resolved by an account toggle");
  });

  await test("the UI is told why, rather than shown a dead checkbox", async () => {
    const { user, token } = await makeUser();
    await SmsOptOut.create({
      phone: user.phone,
      scope: "all",
      source: "carrier_keyword",
      optedOutAt: new Date(),
    });
    const body = await (await api(token).get()).json();
    assert.strictEqual(body.phoneOptedOut, true);
    assert.strictEqual(body.phoneOptOutScope, "all");
  });

  await test("turning marketing OFF is still allowed under a STOP", async () => {
    const { user, token } = await makeUser();
    await User.updateOne(
      { _id: user._id },
      { $set: { "smsPreferences.marketingEnabled": true } }
    );
    await SmsOptOut.create({
      phone: user.phone,
      scope: "all",
      source: "carrier_keyword",
      optedOutAt: new Date(),
    });

    const res = await api(token).put({ marketingEnabled: false });
    assert.strictEqual(res.status, 200, "agreeing with the STOP is not a bypass");
    const row = await reload(user._id);
    assert.strictEqual(row.smsPreferences.marketingEnabled, false);
  });

  /* ------------------------------------------------------------------ */
  section("Shared handsets");

  await test("a STOP blocks BOTH accounts on the same number", async () => {
    const shared = "+16315557777";
    const a = await makeUser({ phone: shared });
    const b = await makeUser({ phone: shared });

    // Both opted in before the STOP arrived.
    await api(a.token).put({ marketingEnabled: true });
    await api(b.token).put({ marketingEnabled: true });

    await SmsOptOut.create({
      phone: shared,
      scope: "all",
      source: "carrier_keyword",
      optedOutAt: new Date(),
    });

    for (const who of [a, b]) {
      const body = await (await api(who.token).get()).json();
      assert.strictEqual(body.phoneOptedOut, true, "every account on the handset sees the STOP");

      /*
       * Asserted with a TRANSACTIONAL type on purpose.
       *
       * A marketing type is refused on the channel switch before the opt-out
       * check is ever reached, so it could not tell a working STOP from a
       * broken one. A service reminder reaches the opt-out check, which makes
       * this a real test of the handset-level block - and it is the stronger
       * claim anyway: a STOP silences even the messages a customer would
       * otherwise still receive.
       */
      const verdict = await checkEligibility({
        notificationType: "BOOKING_REMINDER_24H",
        user: await reload(who.user._id),
        phone: shared,
      });
      assert.strictEqual(verdict.eligible, false);
      assert.strictEqual(verdict.reason, "opted_out_all");
    }
  });

  await test("one account opting in does not opt in the other", async () => {
    const shared = "+16315558888";
    const a = await makeUser({ phone: shared });
    const b = await makeUser({ phone: shared });

    await api(a.token).put({ marketingEnabled: true });

    const rowA = await reload(a.user._id);
    const rowB = await reload(b.user._id);
    assert.strictEqual(rowA.smsPreferences.marketingEnabled, true);
    assert.notStrictEqual(
      rowB.smsPreferences?.marketingEnabled,
      true,
      "consent is per account, even when the handset is shared"
    );
  });

  /* ------------------------------------------------------------------ */
  section("Signup consent still behaves as it did");

  async function registerWith(extra) {
    const email = `signup${++seq}.${Date.now()}@example.com`;
    const res = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Test Person",
        email,
        password: "testpassword123",
        phone: `+1631555${String(2000 + seq).slice(-4)}`,
        address: "1 Main St",
        city: "Huntington",
        state: "NY",
        zip: "11743",
        county: "Suffolk",
        ...extra,
      }),
    });
    return { res, row: await User.findOne({ email }).lean() };
  }

  await test("a new signup without the box stores no consent", async () => {
    const { res, row } = await registerWith({});
    assert.ok(res.status < 400, "registration must succeed without marketing consent");
    assert.ok(row, "the account is created");
    assert.notStrictEqual(row.smsPreferences?.marketingEnabled, true);
  });

  await test("a new signup with the box stores signup_web_form", async () => {
    const { res, row } = await registerWith({ smsMarketingConsent: true });
    assert.ok(res.status < 400);
    assert.strictEqual(row.smsPreferences.marketingEnabled, true);
    assert.strictEqual(row.smsPreferences.marketingConsentSource, "signup_web_form");
  });

  await test("the two sources stay distinguishable in the record", async () => {
    const { row } = await registerWith({ smsMarketingConsent: true });
    const token = jwt.sign({ id: String(row._id) }, process.env.JWT_SECRET);
    await api(token).put({ marketingEnabled: false });
    await api(token).put({ marketingEnabled: true });

    const after = await reload(row._id);
    assert.strictEqual(
      after.smsPreferences.marketingConsentSource,
      "account_settings",
      "the latest consent names where it was actually given"
    );
  });

  /* ------------------------------------------------------------------ */
  section("The switches are still off");

  await test("no notification type can send during any of this", async () => {
    delete require.cache[require.resolve("../utils/sms/smsConfig")];
    const { sendingAllowedFor } = require("../utils/sms/smsConfig");
    const { SMS_TYPES } = require("../utils/sms/smsTypes");
    const open = Object.keys(SMS_TYPES).filter((t) => sendingAllowedFor(t));
    assert.deepStrictEqual(open, [], `these types could send: ${open.join(", ")}`);
  });

  server.close();
  await mongoose.disconnect();
  await mongod.stop();

  console.log(`\n${passed} passed, ${failures.length} failed.`);
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  console.error("\nSuite crashed:", error);
  process.exit(1);
});
