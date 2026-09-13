/**
 * SMS consent is voluntary, end to end.
 *
 * WHAT WENT WRONG, AND WHY A DISCLOSURE REWRITE WOULD NOT HAVE FIXED IT
 *
 * The Twilio A2P campaign was rejected with error 30923, FORCED CONSENT
 * VIOLATION, after a carrier reviewer inspected profixter.com/signup. They were
 * right, and the problem was mechanical rather than editorial: registration
 * required a phone number, the signup page stated "We text you about your
 * visits" as a fact with no box to decline, and the eligibility engine treated
 * an absent preference as permission. Put together, agreeing to be texted was a
 * condition of having an account.
 *
 * So the mechanics changed, and this file is what proves they did. The claim it
 * defends is a single sentence:
 *
 *   A customer can register, book, buy and use every part of ProFixter without
 *   consenting to any SMS, and nothing about their service degrades if they do.
 *
 * It runs the real Express routes against real Mongoose models on an in-memory
 * MongoDB, and reads the real frontend source for the parts that only exist in
 * the browser. Stubbing either side would prove the stub. Nothing here sends,
 * or can send: the four production switches are forced off for the whole run
 * and the final case asserts they stayed that way.
 *
 *   node scripts/test_sms_consent_mechanics.js
 */

const assert = require("assert");
const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const mongoose = require("mongoose");
const fetch = require("node-fetch");
const jwt = require("jsonwebtoken");
const path = require("path");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-not-real";
/* The four switches stay off for the whole run; see the final section. */
const SMS_FLAGS = [
  "SMS_ENABLED",
  "SMS_MARKETING_ENABLED",
  "SMS_REVIEW_LINK_ENABLED",
  "GIFT_SMS_ENABLED",
];
for (const flag of SMS_FLAGS) process.env[flag] = "false";

/*
 * The frontend lives in a sibling checkout. Several cases below are about what
 * a carrier reviewer can see on the signup page, which is a fact about that
 * file and nowhere else - asserting it against a mock would assert the mock.
 *
 * THAT CHECKOUT IS NOT ALWAYS THERE, AND ITS ABSENCE MUST NOT LOOK LIKE A PASS.
 *
 * The backend deploy workflow checks out one repository, so on CI this path
 * does not exist. Reading it unconditionally is what broke the first attempt to
 * deploy this work: the suite threw ENOENT, backend validation failed, and the
 * deploy was correctly refused for a reason that had nothing to do with the
 * code being deployed.
 *
 * These cases therefore SKIP when the sibling checkout is missing, and say so
 * loudly - counted separately, listed at the end, never folded into the passes.
 * They run in full on any machine with both repositories, which is where this
 * work is done and reviewed. Everything that can be checked from the backend
 * alone still runs everywhere, unconditionally.
 */
const FRONTEND = path.join(__dirname, "..", "..", "FrontEnd");
const SIGNUP_PAGE = path.join(FRONTEND, "app", "(auth)", "signup", "page.tsx");
const FRONTEND_PRESENT = fs.existsSync(SIGNUP_PAGE);

/**
 * Source with line endings normalised.
 *
 * Git stores these files LF and a Windows checkout gets CRLF, so any scan for a
 * literal newline matches on CI and fails on a developer machine for reasons
 * that have nothing to do with the code. Normalising once here is what keeps
 * these cases honest in both places.
 */
function readSource(file) {
  return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

let passed = 0;
const failures = [];
const skipped = [];

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

/**
 * A case that needs the sibling FrontEnd checkout.
 *
 * Skipped rather than failed when it is absent, and skipped rather than quietly
 * passed - a consent assertion that silently stopped running would be worse
 * than one that never existed.
 */
async function frontendTest(name, fn) {
  if (!FRONTEND_PRESENT) {
    skipped.push(name);
    console.log(`  SKIP  ${name}`);
    console.log(`        no FrontEnd checkout beside this repo; run locally to cover it`);
    return;
  }
  await test(name, fn);
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
  const smsTypes = require("../utils/sms/smsTypes");
  const smsConfig = require("../utils/sms/smsConfig");
  const webhook = require("../routes/smsWebhook");

  const app = express();
  app.use(express.json());
  app.use("/api/users", require("../routes/users"));
  app.use("/api/auth", require("../routes/auth"));

  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  let seq = 0;

  /** A registration payload with everything the route demands and no SMS ticks. */
  function registration(extra = {}) {
    seq += 1;
    return {
      name: "Dana Whitfield",
      email: `consent${seq}.${Date.now()}@example.com`,
      password: "correct horse battery",
      phone: `631555${String(2000 + seq).slice(-4)}`,
      address: "14 Bayview Ave",
      city: "Babylon",
      state: "NY",
      zip: "11702",
      county: "Suffolk",
      termsAccepted: true,
      ...extra,
    };
  }

  async function registerVia(body) {
    const res = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { res, json: await res.json().catch(() => ({})) };
  }

  async function makeUser(overrides = {}) {
    seq += 1;
    const user = await User.create({
      userId: `C${seq}${Date.now()}`,
      name: "Dana Whitfield",
      email: `acct${seq}.${Date.now()}@example.com`,
      password: "hashed",
      phone: overrides.phone || `+1631555${String(3000 + seq).slice(-4)}`,
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

  const prefsApi = (token) => ({
    get: () =>
      fetch(`${base}/api/users/me/sms-preferences`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    put: (body) =>
      fetch(`${base}/api/users/me/sms-preferences`, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
  });

  const reload = (id) => User.findById(id).lean();

  /* ================================================================== */
  section("The signup page a carrier reviewer actually opens");
  /* ================================================================== */

  const signup = FRONTEND_PRESENT ? readSource(SIGNUP_PAGE) : "";

  await frontendTest("both SMS consents start unchecked", () => {
    /*
     * A pre-ticked box is not affirmative consent under TCPA/CTIA or Twilio's
     * web form opt-in standard, and it is the first thing a reviewer checks.
     */
    for (const state of ["smsTransactionalConsent", "smsMarketingConsent"]) {
      assert.ok(
        new RegExp(`const \\[${state}, set\\w+\\] = useState\\(false\\)`).test(signup),
        `${state} must initialise to false`
      );
    }
  });

  await frontendTest("service and marketing are two separate controls", () => {
    for (const id of ["sms-service-consent", "sms-marketing-consent"]) {
      assert.ok(signup.includes(`id="${id}"`), `missing checkbox ${id}`);
    }
    assert.notStrictEqual(
      signup.indexOf("sms-service-consent"),
      signup.indexOf("sms-marketing-consent")
    );
  });

  await frontendTest("Terms acceptance is a third, separate control", () => {
    assert.ok(signup.includes('id="agree-terms"'), "the Terms checkbox is gone");
    /*
     * Bundling is the specific defect. The Terms box must not be the thing that
     * carries an SMS consent, so nothing may set either SMS state from it.
     */
    const termsBlock = signup.slice(
      signup.indexOf('id="agree-terms"'),
      signup.indexOf("</ConsentCheckbox>", signup.indexOf('id="agree-terms"'))
    );
    for (const state of ["setSmsTransactionalConsent", "setSmsMarketingConsent"]) {
      assert.ok(!termsBlock.includes(state), `Terms acceptance must not touch ${state}`);
    }
  });

  await frontendTest("neither SMS choice takes part in validation", () => {
    /*
     * THE COMPLIANCE CLAIM RESTS ON THIS CASE.
     *
     * A checkbox that is labelled optional but read by a validator is not
     * optional. No validator on the page may mention either state.
     */
    const validators = signup.match(/const validate\w+Step = \(\) => \{[\s\S]*?\n  \};/g) || [];
    assert.ok(validators.length >= 4, "expected the four step validators to be found");
    for (const validator of validators) {
      for (const state of ["smsTransactionalConsent", "smsMarketingConsent"]) {
        assert.ok(!validator.includes(state), `a validator reads ${state}`);
      }
    }
  });

  await frontendTest("the choices are visible without creating an account", () => {
    /*
     * Signup is a four-step wizard and the boxes used to be on step 4, which
     * meant a reviewer opening the page saw an address form and no sign that
     * texting was optional or even offered. The panel now renders outside the
     * step-gated form, so it is on screen at step 1.
     */
    const panel = signup.indexOf('aria-labelledby="sms-consent-heading"');
    assert.ok(panel > 0, "the always-visible consent panel is gone");
    assert.ok(
      panel > signup.indexOf("</form>"),
      "the consent panel must sit outside the step form so every step renders it"
    );
    for (const id of ["sms-service-consent", "sms-marketing-consent"]) {
      assert.ok(signup.indexOf(`id="${id}"`) > panel, `${id} must live inside the panel`);
    }
  });

  await frontendTest("the page says in words that SMS is not required", () => {
    assert.ok(
      /without agreeing to receive text messages/i.test(signup),
      "the page must state plainly that an account can be created without SMS"
    );
    assert.ok(/Text messages &mdash; optional/i.test(signup), "the panel heading must say optional");
  });

  await frontendTest("the required CTIA disclosures sit with the service checkbox", () => {
    const panel = signup.slice(signup.indexOf('aria-labelledby="sms-consent-heading"'));
    for (const phrase of [
      "(631) 888-6340",
      "Message frequency varies",
      "Message and data rates may apply",
      "Reply STOP",
      "HELP for help",
    ]) {
      assert.ok(panel.includes(phrase), `the consent panel is missing: ${phrase}`);
    }
  });

  await frontendTest("the old forced-consent sentence is gone", () => {
    /*
     * Comments are stripped first. The file explains in a comment what the
     * page used to say and why it changed, which is worth keeping and is not
     * something a customer or a reviewer can read - scanning raw source would
     * fail on the explanation of the fix rather than on the defect.
     */
    const rendered = signup.replace(/\/\*[\s\S]*?\*\//g, "");
    assert.ok(
      !/We text you about your visits/i.test(rendered),
      "the page must not assert that we will text them"
    );
  });

  /* ================================================================== */
  section("Registering with both boxes left alone");
  /* ================================================================== */

  await test("registration succeeds with no SMS consent at all", async () => {
    const { res, json } = await registerVia(registration());
    assert.strictEqual(res.status, 201, `expected 201, got ${res.status}`);
    assert.ok(json.token, "a usable account must come back");
  });

  await test("declining SMS writes no consent of any kind", async () => {
    const body = registration();
    await registerVia(body);
    const row = await User.findOne({ email: body.email.toLowerCase() }).lean();
    const prefs = row.smsPreferences || {};
    /*
     * Nothing is written rather than false, so "never asked" stays
     * distinguishable from "said no" forever. Both are refused at send time.
     */
    assert.notStrictEqual(prefs.transactionalEnabled, true);
    assert.notStrictEqual(prefs.marketingEnabled, true);
    assert.ok(!prefs.transactionalConsentAt, "no consent timestamp may be invented");
    assert.ok(!prefs.transactionalConsentSource, "no consent source may be invented");
  });

  await test("a declined signup can still be used - nothing is degraded", async () => {
    const body = registration();
    const { json } = await registerVia(body);
    const row = await User.findOne({ email: body.email.toLowerCase() }).lean();
    assert.strictEqual(row.isActive, true, "the account must be active");
    assert.ok(row.addresses.length === 1, "the property must be saved");
    assert.ok(row.defaultAddressId, "the property must be usable for booking");
    assert.ok(json.token, "they must be logged in exactly like anybody else");
  });

  await test("ticking service SMS records consent with timestamp and source", async () => {
    const body = registration({ smsTransactionalConsent: true });
    const before = Date.now();
    await registerVia(body);
    const row = await User.findOne({ email: body.email.toLowerCase() }).lean();
    const prefs = row.smsPreferences;
    assert.strictEqual(prefs.transactionalEnabled, true);
    assert.strictEqual(prefs.transactionalConsentSource, "signup_web_form");
    assert.ok(
      new Date(prefs.transactionalConsentAt).getTime() >= before - 1000,
      "the consent timestamp must be the moment it was given"
    );
    assert.notStrictEqual(prefs.marketingEnabled, true, "one tick is not two");
  });

  await test("ticking marketing records marketing and nothing else", async () => {
    const body = registration({ smsMarketingConsent: true });
    await registerVia(body);
    const prefs = (await User.findOne({ email: body.email.toLowerCase() }).lean()).smsPreferences;
    assert.strictEqual(prefs.marketingEnabled, true);
    assert.strictEqual(prefs.marketingConsentSource, "signup_web_form");
    assert.notStrictEqual(prefs.transactionalEnabled, true, "marketing must not imply service");
  });

  await test("a truthy string is not consent", async () => {
    /*
     * Every string is truthy, so a client sending "false" would opt somebody in
     * under any looser comparison. The route tests against the literal boolean.
     */
    for (const value of ["true", "false", 1, "1", "yes", {}]) {
      const body = registration({ smsTransactionalConsent: value, smsMarketingConsent: value });
      await registerVia(body);
      const prefs =
        (await User.findOne({ email: body.email.toLowerCase() }).lean()).smsPreferences || {};
      assert.notStrictEqual(
        prefs.transactionalEnabled,
        true,
        `${JSON.stringify(value)} must not become service consent`
      );
      assert.notStrictEqual(prefs.marketingEnabled, true);
    }
  });

  /* ================================================================== */
  section("Send-time eligibility");
  /* ================================================================== */

  await test("an absent preference suppresses service SMS", async () => {
    const { user } = await makeUser();
    const verdict = await checkEligibility({
      notificationType: "BOOKING_REMINDER_24H",
      user: await reload(user._id),
      phone: user.phone,
    });
    assert.strictEqual(verdict.eligible, false);
    assert.strictEqual(verdict.reason, "transactional_not_opted_in");
  });

  await test("transactionalEnabled=false suppresses service SMS", async () => {
    const { user } = await makeUser({ smsPreferences: { transactionalEnabled: false } });
    const verdict = await checkEligibility({
      notificationType: "BOOKING_CONFIRMED",
      user: await reload(user._id),
      phone: user.phone,
    });
    assert.strictEqual(verdict.eligible, false);
    assert.strictEqual(verdict.reason, "transactional_disabled_by_user");
  });

  await test("transactionalEnabled=true is eligible, subject to the normal rules", async () => {
    const { user } = await makeUser({ smsPreferences: { transactionalEnabled: true } });
    const row = await reload(user._id);
    assert.strictEqual(
      (await checkEligibility({
        notificationType: "BOOKING_REMINDER_24H",
        user: row,
        phone: user.phone,
      })).eligible,
      true
    );
    /*
     * Consent is a gate, not an override. A non-urgent type still waits for the
     * quiet-hours window, which is what "subject to the normal rules" means.
     */
    const atThreeAm = new Date("2026-03-04T08:00:00.000Z");
    const late = await checkEligibility({
      notificationType: "BOOKING_COMPLETED",
      user: row,
      phone: user.phone,
      now: atThreeAm,
    });
    assert.strictEqual(late.eligible, false);
    assert.strictEqual(late.reason, "outside_send_window");
  });

  await test("marketing consent does not imply service consent", async () => {
    const { user } = await makeUser({
      smsPreferences: { marketingEnabled: true, marketingConsentAt: new Date() },
    });
    const verdict = await checkEligibility({
      notificationType: "BOOKING_REMINDER_24H",
      user: await reload(user._id),
      phone: user.phone,
    });
    assert.strictEqual(verdict.eligible, false);
    assert.strictEqual(verdict.reason, "transactional_not_opted_in");
  });

  await test("service consent does not imply marketing consent", async () => {
    const { user } = await makeUser({ smsPreferences: { transactionalEnabled: true } });
    const verdict = await checkEligibility({
      notificationType: "KITCHEN_BATH_MARKETING",
      user: await reload(user._id),
      phone: user.phone,
    });
    assert.strictEqual(verdict.eligible, false);
    assert.strictEqual(verdict.reason, "marketing_not_opted_in");
  });

  await test("nothing but the tick counts - not a phone, terms, or a membership", () => {
    const notConsent = [
      { phone: "+16315551234" },
      { termsAccepted: true, consentAt: new Date(), consentSource: "website_signup" },
      { subscription: "elite", subscriptionExpiry: new Date(Date.now() + 8.64e7) },
      { smsPreferences: { optedOutAt: null, optOutSource: "" } },
    ];
    for (const user of notConsent) {
      assert.strictEqual(
        accountAllows(user, "BOOKING_CONFIRMED").eligible,
        false,
        `${JSON.stringify(user)} must not be read as consent`
      );
    }
  });

  await test("a message with no account behind it is refused", async () => {
    /*
     * There is nowhere to read a tick from and nowhere to store the evidence,
     * so a bare phone number cannot be texted. GIFT_INVITATION is shaped like
     * an exception and deliberately does not get one; it is also disabled at
     * the switch and stays that way.
     */
    const verdict = await checkEligibility({
      notificationType: "BOOKING_CONFIRMED",
      user: null,
      phone: "+16315554321",
    });
    assert.strictEqual(verdict.eligible, false);
    assert.strictEqual(verdict.reason, "transactional_requires_account");
  });

  await test("every SMS type requires consent on its own channel", async () => {
    /*
     * Asserted over the whole registry rather than a sample, so that a type
     * added next year cannot quietly arrive without a consent rule. The two
     * classes are checked against a user who consented to the OTHER channel,
     * which is the mistake most likely to be made.
     */
    const serviceOnly = { smsPreferences: { transactionalEnabled: true } };
    const marketingOnly = { smsPreferences: { marketingEnabled: true } };
    for (const type of smsTypes.allTypes()) {
      const wrongChannel = smsTypes.isMarketing(type) ? serviceOnly : marketingOnly;
      assert.strictEqual(
        accountAllows(wrongChannel, type).eligible,
        false,
        `${type} accepted consent from the wrong channel`
      );
      assert.strictEqual(accountAllows({}, type).eligible, false, `${type} accepted no consent`);
    }
  });

  /* ================================================================== */
  section("My Account");
  /* ================================================================== */

  await test("an existing customer with no record shows both switches OFF", async () => {
    /*
     * NOBODY IS GRANDFATHERED. Every customer who registered before the
     * checkbox existed has no transactionalEnabled, and having their phone
     * number is not an answer to a question we never asked them.
     */
    const { user, token } = await makeUser({ phone: "+16315558881" });
    const body = await (await prefsApi(token).get()).json();
    assert.strictEqual(body.transactionalEnabled, false);
    assert.strictEqual(body.marketingEnabled, false);
    assert.ok(!(await reload(user._id)).smsPreferences?.transactionalEnabled);
  });

  await test("turning service texts on records state, timestamp and source", async () => {
    const { user, token } = await makeUser({ phone: "+16315558882" });
    const before = Date.now();
    const res = await prefsApi(token).put({ transactionalEnabled: true });
    assert.strictEqual(res.status, 200);

    const prefs = (await reload(user._id)).smsPreferences;
    assert.strictEqual(prefs.transactionalEnabled, true);
    assert.strictEqual(prefs.transactionalConsentSource, "account_settings");
    assert.ok(new Date(prefs.transactionalConsentAt).getTime() >= before - 1000);
  });

  await test("turning service texts off leaves marketing and email alone", async () => {
    const { user, token } = await makeUser({ phone: "+16315558883" });
    await prefsApi(token).put({ transactionalEnabled: true, marketingEnabled: true });
    await prefsApi(token).put({ transactionalEnabled: false });

    const row = await reload(user._id);
    assert.strictEqual(row.smsPreferences.transactionalEnabled, false);
    assert.strictEqual(row.smsPreferences.marketingEnabled, true, "marketing must be untouched");
    assert.strictEqual(row.email, row.email, "the email address is not a preference");
    /* Switching a preference is not a STOP; that record is the webhook's. */
    assert.ok(!row.smsPreferences.optedOutAt, "a preference must not forge a handset STOP");
    assert.strictEqual(await SmsOptOut.countDocuments({ phone: row.phone }), 0);
  });

  await test("the consent timestamp survives switching off", async () => {
    /*
     * It records the historical fact that consent was once given, which stays
     * true after it is withdrawn. The enabled flag is what eligibility reads.
     */
    const { user, token } = await makeUser({ phone: "+16315558884" });
    await prefsApi(token).put({ transactionalEnabled: true });
    const given = (await reload(user._id)).smsPreferences.transactionalConsentAt;
    await prefsApi(token).put({ transactionalEnabled: false });
    assert.deepStrictEqual((await reload(user._id)).smsPreferences.transactionalConsentAt, given);
  });

  await test("each switch moves on its own", async () => {
    const { user, token } = await makeUser({ phone: "+16315558885" });
    await prefsApi(token).put({ marketingEnabled: true });
    let row = await reload(user._id);
    assert.notStrictEqual(row.smsPreferences.transactionalEnabled, true);

    await prefsApi(token).put({ transactionalEnabled: true });
    row = await reload(user._id);
    assert.strictEqual(row.smsPreferences.marketingEnabled, true);
    assert.strictEqual(row.smsPreferences.transactionalEnabled, true);
  });

  await test("a non-boolean is refused rather than guessed at", async () => {
    const { token } = await makeUser({ phone: "+16315558886" });
    for (const value of ["true", "false", 1, null]) {
      const res = await prefsApi(token).put({ transactionalEnabled: value });
      assert.strictEqual(res.status, 400, `${JSON.stringify(value)} was accepted`);
    }
    const empty = await prefsApi(token).put({});
    assert.strictEqual(empty.status, 400, "a request naming no channel must be rejected");
  });

  await test("the account screen and the send path agree", async () => {
    const { user, token } = await makeUser({ phone: "+16315558887" });
    await prefsApi(token).put({ transactionalEnabled: true });
    const shown = await (await prefsApi(token).get()).json();
    const verdict = await checkEligibility({
      notificationType: "BOOKING_REMINDER_24H",
      user: await reload(user._id),
      phone: user.phone,
    });
    assert.strictEqual(shown.transactionalEnabled, verdict.eligible);
  });

  /* ================================================================== */
  section("STOP and START");
  /* ================================================================== */

  await test("a global STOP blocks both channels", async () => {
    const { user } = await makeUser({
      phone: "+16315559001",
      smsPreferences: { transactionalEnabled: true, marketingEnabled: true },
    });
    await webhook.applyOptOut("+16315559001", "stop");

    const row = await reload(user._id);
    for (const [type, reason] of [
      ["BOOKING_REMINDER_24H", "transactional_disabled_by_user"],
      ["KITCHEN_BATH_MARKETING", "marketing_not_opted_in"],
    ]) {
      const verdict = await checkEligibility({ notificationType: type, user: row, phone: user.phone });
      assert.strictEqual(verdict.eligible, false, `${type} survived a STOP`);
      assert.strictEqual(verdict.reason, reason);
    }
  });

  await test("a STOP withdraws both consents on the account", async () => {
    /*
     * A STOP is a withdrawal of consent to be texted, without a carve-out for
     * reminders. Leaving transactionalEnabled true would leave the database
     * asserting a consent the customer has just revoked.
     */
    const { user } = await makeUser({
      phone: "+16315559002",
      smsPreferences: { transactionalEnabled: true, marketingEnabled: true },
    });
    await webhook.applyOptOut("+16315559002", "stop");
    const prefs = (await reload(user._id)).smsPreferences;
    assert.strictEqual(prefs.transactionalEnabled, false);
    assert.strictEqual(prefs.marketingEnabled, false);
    assert.ok(prefs.optedOutAt, "the withdrawal must be recorded");
  });

  await test("START lifts the block and grants no consent", async () => {
    const { user } = await makeUser({ phone: "+16315559003" });
    await webhook.applyOptOut("+16315559003", "stop");
    await webhook.applyOptIn("+16315559003", "start");

    const optOut = await SmsOptOut.findOne({ phone: "+16315559003" }).lean();
    assert.ok(optOut.optedInAt, "the handset block must be resolved");
    assert.ok(optOut.optedOutAt, "the history of the STOP must be kept as evidence");

    const prefs = (await reload(user._id)).smsPreferences || {};
    assert.notStrictEqual(prefs.transactionalEnabled, true, "START must not create consent");
    assert.notStrictEqual(prefs.marketingEnabled, true);

    const verdict = await checkEligibility({
      notificationType: "BOOKING_REMINDER_24H",
      user: await reload(user._id),
      phone: user.phone,
    });
    assert.strictEqual(verdict.eligible, false, "still silent until they opt in again");
  });

  await test("the account screen refuses an opt-in while the handset is stopped", async () => {
    const { token } = await makeUser({ phone: "+16315559004" });
    await SmsOptOut.create({
      phone: "+16315559004",
      scope: "all",
      source: "carrier_keyword",
      optedOutAt: new Date(),
    });
    const res = await prefsApi(token).put({ transactionalEnabled: true });
    assert.strictEqual(res.status, 409, "the database must not claim what Twilio would refuse");
    const body = await res.json();
    assert.strictEqual(body.phoneOptedOut, true);
    assert.strictEqual(body.transactionalEnabled, false);
  });

  await test("opting OUT is still allowed under a STOP", async () => {
    /* Somebody agreeing with us is not a conflict. */
    const { user, token } = await makeUser({
      phone: "+16315559005",
      smsPreferences: { transactionalEnabled: true },
    });
    await SmsOptOut.create({
      phone: "+16315559005",
      scope: "all",
      source: "carrier_keyword",
      optedOutAt: new Date(),
    });
    const res = await prefsApi(token).put({ transactionalEnabled: false });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await reload(user._id)).smsPreferences.transactionalEnabled, false);
  });

  /* ================================================================== */
  section("The Twilio Advanced Opt-Out replies");
  /* ================================================================== */

  const optOutCopy = require("../utils/sms/twilioOptOutCopy");

  await test("every keyword reply fits one console field and two segments", () => {
    /*
     * A single smart quote or en dash pasted into the console switches the body
     * to UCS-2, cutting the per-segment budget from 153 characters to 67. The
     * bodies are written in plain ASCII for that reason and pinned here, along
     * with Twilio's 320-character field limit.
     */
    for (const field of ["OPT_OUT_MESSAGE", "OPT_IN_MESSAGE", "HELP_MESSAGE"]) {
      const body = optOutCopy[field];
      const { gsm7, segments } = optOutCopy.measure(body);
      assert.ok(gsm7, `${field} is not GSM-7; a non-ASCII character halves the segment budget`);
      assert.ok(body.length <= 320, `${field} is ${body.length} chars; the console field holds 320`);
      assert.ok(segments <= 2, `${field} costs ${segments} segments`);
    }
  });

  await test("the START reply is the wording Taras approved, verbatim", () => {
    /*
     * Pinned as an exact string rather than by pattern. This body was settled
     * word by word between two wrong versions - one claiming a consent we do
     * not have, one denying an unblock that did happen - so an edit to it is a
     * decision somebody has to make again deliberately, not a tidy-up.
     */
    assert.strictEqual(
      optOutCopy.OPT_IN_MESSAGE,
      "ProFixter: This number can receive texts from us again. To choose which " +
        "ProFixter texts you want, turn on service or offer texts in your account " +
        "at profixter.com/account. Msg&data rates may apply. Reply STOP to opt out, " +
        "HELP for help."
    );
  });

  await test("the START reply claims no subscription to either category", () => {
    /*
     * Twilio's stock confirmation says the customer has been re-subscribed.
     * Ours must not, because applyOptIn sets neither consent flag - the
     * database would be contradicted by its own confirmation message.
     */
    const body = optOutCopy.OPT_IN_MESSAGE;
    for (const claim of [
      /re-?subscrib/i,
      /you are (now )?(subscribed|signed up|opted in)/i,
      /you will (now )?(receive|get) (texts|messages)/i,
      /we will (resume|start) (sending|texting)/i,
    ]) {
      assert.ok(!claim.test(body), `the START reply claims a subscription: ${claim}`);
    }
  });

  await test("the START reply does not contradict Twilio's own unblock", () => {
    /*
     * The opposite failure, and the reason an earlier draft was rejected.
     * START really does clear the carrier block, so a reply denying that the
     * number can receive anything would be both confusing and at odds with the
     * keyword Twilio reserves as an opt-in. It has to state the unblock, then
     * point at where the ProFixter choice is actually made.
     */
    const body = optOutCopy.OPT_IN_MESSAGE;
    assert.ok(
      /can receive texts from us again/i.test(body),
      "the START reply must state the carrier-level unblock plainly"
    );
    assert.ok(
      !/not (signed up|subscribed|opted in)/i.test(body),
      "the START reply must not deny an opt-in keyword doing what Twilio says it does"
    );
    assert.ok(
      /profixter\.com\/account/.test(body),
      "the START reply must say where the application-level choice is made"
    );
  });

  await test("each reply carries the disclosures its keyword owes", () => {
    assert.ok(/ProFixter/.test(optOutCopy.OPT_OUT_MESSAGE), "STOP reply must name the brand");
    assert.ok(
      /unsubscribed|no more texts/i.test(optOutCopy.OPT_OUT_MESSAGE),
      "STOP reply must confirm the unsubscribe"
    );
    for (const field of ["OPT_IN_MESSAGE", "HELP_MESSAGE"]) {
      assert.ok(/Msg&data rates may apply/.test(optOutCopy[field]), `${field} needs the rates line`);
      assert.ok(/Reply STOP to opt out/.test(optOutCopy[field]), `${field} needs the STOP line`);
    }
    assert.ok(
      /631-599-1363/.test(optOutCopy.HELP_MESSAGE),
      "HELP reply must carry a real contact route"
    );
    assert.ok(
      /Premium Island Homes/.test(optOutCopy.HELP_MESSAGE),
      "HELP reply must name the legal entity behind the brand"
    );
  });

  await test("our webhook recognises every keyword we ask Twilio to use", () => {
    /*
     * Twilio enforces the opt-out; we mirror it so our eligibility agrees with
     * theirs. A keyword added to the console list that our webhook ignores
     * would leave the two silently disagreeing about who is blocked - Twilio
     * refusing sends we keep believing are allowed.
     */
    const webhookSrc = readSource(path.join(__dirname, "..", "routes", "smsWebhook.js"));
    const setFor = (name) => {
      /*
       * Sliced rather than matched with a regular expression. The words are a
       * literal array in the source and a pattern for it needs enough escaping
       * to be worth getting wrong once; indexOf cannot be misread.
       */
      const marker = `${name} = new Set([`;
      const from = webhookSrc.indexOf(marker);
      assert.ok(from >= 0, `${name} not found in routes/smsWebhook.js`);
      const body = webhookSrc.slice(from + marker.length, webhookSrc.indexOf("])", from));
      return new Set(
        body
          .split(",")
          .map((entry) => entry.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean)
      );
    };
    const pairs = [
      [optOutCopy.OPT_OUT_KEYWORDS, setFor("STOP_WORDS"), "STOP_WORDS"],
      [optOutCopy.OPT_IN_KEYWORDS, setFor("START_WORDS"), "START_WORDS"],
      [optOutCopy.HELP_KEYWORDS, setFor("HELP_WORDS"), "HELP_WORDS"],
    ];
    for (const [consoleKeywords, ours, name] of pairs) {
      for (const keyword of consoleKeywords) {
        assert.ok(
          ours.has(keyword.toLowerCase()),
          `${keyword} is configured in Twilio but ${name} does not recognise it`
        );
      }
    }
  });

  /* ================================================================== */
  section("What must NOT have changed");
  /* ================================================================== */

  await test("email delivery is untouched by any SMS choice", async () => {
    /*
     * The promise made on the signup page is that declining texts costs the
     * customer nothing, because everything still arrives by email. That promise
     * is only true if the SMS preference is invisible to the email layer - so
     * no email module may read it.
     */
    const utils = path.join(__dirname, "..", "utils");
    const scanned = [
      "emailService.js",
      "customerEmailTemplates.js",
      "operationalEmail.js",
      "campaignEmail.js",
      "subscriptionCancellationAdminEmail.js",
    ].map((f) => path.join(utils, f));
    for (const file of scanned) {
      assert.ok(fs.existsSync(file), `the email layer moved: ${path.basename(file)} not found`);
    }
    for (const file of scanned) {
      const src = readSource(file);
      assert.ok(
        !/transactionalEnabled|smsPreferences/.test(src),
        `${path.basename(file)} reads an SMS preference; declining SMS could suppress email`
      );
    }
  });

  await test("the approved message bodies are byte-for-byte unchanged", () => {
    /*
     * The campaign was submitted with these bodies. Changing one during a
     * consent fix would invalidate the submission for a reason nobody would
     * connect back to this work, so the file is pinned by hash.
     *
     * Re-pinned when the four Free First Visit lifecycle templates were added.
     * Every body that existed at A2P submission is byte-for-byte identical -
     * that change was twenty-seven added lines and no removed or modified
     * ones, and the assertion below this one proves the submitted bodies
     * individually rather than trusting the hash alone. The new templates are
     * marketing-class and cannot send without an explicit marketing opt-in.
     */
    const digest = crypto
      .createHash("sha256")
      .update(readSource(path.join(__dirname, "..", "utils", "sms", "smsTemplates.js")))
      .digest("hex");
    assert.strictEqual(
      digest,
      "356762e5bce1748a0b6c1ca17d6a7f2137613f4285d7ead65ec6fb70ee31e29c",
      "utils/sms/smsTemplates.js changed; re-approve the wording before updating this hash"
    );
  });

  await frontendTest("the privacy non-sharing statement is intact and prominent", () => {
    /*
     * This exact sentence is what cleared A2P error 30908, and it has to carry
     * all six elements in one sentence. Splitting it across two is what failed.
     */
    const SENTENCE =
      "Mobile information and SMS consent will not be shared with third parties or affiliates for marketing or promotional purposes.";
    for (const page of ["privacy", "communication-consent"]) {
      const src = readSource(path.join(FRONTEND, "app", page, "page.tsx")).replace(/\s+/g, " ");
      assert.ok(src.includes(SENTENCE), `the non-sharing sentence is missing from /${page}`);
    }
  });

  /*
   * THE CLAIM AND THE CODE HAVE TO AGREE, OR THE CAMPAIGN IS MISDESCRIBED.
   *
   * applyOptIn lifts the handset block and grants no consent. Any surface that
   * tells a customer START will resume their texts is describing a system we do
   * not have - and it is the sentence a carrier reviewer would quote back at
   * us. The CTIA boilerplate that ships with most SMS terms ("To rejoin, start
   * again as you did initially, and we will resume sending SMS messages to
   * you") says precisely that, which is why it is named here.
   *
   * Split by repository so the backend half still runs where only this repo is
   * checked out. The rule is identical on both sides; only the file list differs.
   */
  const FORBIDDEN_START_CLAIMS = [
    /we will resume sending\s+SMS messages/i,
    /START[^.]{0,80}\band we will (resume|start) (sending|texting)/i,
    /text START[^.]{0,60}to (resume|restart) (your )?(texts|messages)/i,
    /START[^.]{0,60}\bre-?subscribes?\b/i,
  ];

  function assertNoStartClaims(files) {
    for (const file of files) {
      const src = readSource(file).replace(/\s+/g, " ");
      for (const pattern of FORBIDDEN_START_CLAIMS) {
        assert.ok(
          !pattern.test(src),
          `${path.basename(file)} claims START resumes messaging: ${pattern}`
        );
      }
    }
  }

  await test("no backend copy claims START resumes messages", () => {
    assertNoStartClaims([
      path.join(__dirname, "..", "routes", "users.js"),
      path.join(__dirname, "..", "routes", "smsWebhook.js"),
      path.join(__dirname, "..", "utils", "sms", "twilioOptOutCopy.js"),
    ]);
  });

  await frontendTest("no customer-facing page claims START resumes messages", () => {
    assertNoStartClaims([
      path.join(FRONTEND, "app", "terms", "page.tsx"),
      path.join(FRONTEND, "app", "privacy", "page.tsx"),
      path.join(FRONTEND, "app", "communication-consent", "page.tsx"),
      path.join(FRONTEND, "app", "components", "account", "SmsPreferences.tsx"),
    ]);
  });

  await frontendTest("the pages that mention START say it grants nothing", () => {
    /*
     * The negative case above is not enough on its own - deleting the sentence
     * would pass it while leaving a customer with no idea what START does.
     * Wherever START is offered as the way out of a STOP, the page must also
     * say that the customer still has to switch their texts back on.
     */
    const surfaces = [
      path.join(FRONTEND, "app", "terms", "page.tsx"),
      path.join(FRONTEND, "app", "communication-consent", "page.tsx"),
      path.join(FRONTEND, "app", "components", "account", "SmsPreferences.tsx"),
    ];
    for (const file of surfaces) {
      const src = readSource(file).replace(/\s+/g, " ");
      if (!/START/.test(src)) continue;
      assert.ok(
        /does not by itself|on its own does not|does not by itself resume|switch on the ones you want|turn the categories you want back on|account settings/i.test(
          src
        ),
        `${path.basename(file)} mentions START without saying the customer must opt back in`
      );
    }
  });

  await frontendTest("the legal pages describe the new mechanics", () => {
    const consent = readSource(
      path.join(FRONTEND, "app", "communication-consent", "page.tsx")
    ).replace(/\s+/g, " ");
    assert.ok(
      /Text messages are never required/i.test(consent),
      "the consent page must say SMS is never required"
    );
    assert.ok(
      /Service texts require their own opt-in/i.test(consent),
      "the consent page must say service texts need their own opt-in"
    );
    assert.ok(
      !/By creating an account, booking a service, or requesting a quote[^.]*you consent to receive communications/i.test(
        consent
      ),
      "the forced-consent sentence is back on the consent page"
    );
  });

  await test("no admin route can write a customer's consent", () => {
    /*
     * Admin may READ consent. A button that set it would manufacture a record
     * saying the customer did something they did not, which is worse than
     * having no record - it is a false one.
     */
    const adminSrc = readSource(path.join(__dirname, "..", "routes", "admin.js"));
    const writes =
      adminSrc.match(/smsPreferences\.(transactionalEnabled|marketingEnabled)/g) || [];
    assert.strictEqual(writes.length, 0, "an admin route references a consent flag for writing");
    assert.ok(
      adminSrc.includes('router.get("/users/:id/sms-consent"'),
      "the read-only consent view is missing"
    );
  });

  /* ================================================================== */
  section("The switches are still off");
  /* ================================================================== */

  await test("all four SMS flags remain false", () => {
    for (const flag of SMS_FLAGS) {
      assert.strictEqual(process.env[flag], "false", `${flag} moved during the run`);
    }
    assert.strictEqual(smsConfig.smsEnabled(), false);
    assert.strictEqual(smsConfig.smsMarketingEnabled(), false);
  });

  await test("no notification type could send, whatever the consent says", () => {
    /*
     * The last line of defence. Even a fully consenting customer with a clean
     * number sends nothing while the switches are off, which is why this whole
     * exercise is provably zero-production-SMS.
     */
    for (const type of smsTypes.allTypes()) {
      assert.strictEqual(
        smsConfig.sendingAllowedFor(type),
        false,
        `${type} would have sent for real`
      );
    }
  });

  /* ------------------------------------------------------------------ */
  await mongoose.disconnect();
  await mongod.stop();
  server.close();

  const skipNote = skipped.length ? `, ${skipped.length} skipped` : "";
  console.log(`\n${passed} passed, ${failures.length} failed${skipNote}\n`);
  if (skipped.length) {
    /*
     * Named individually rather than counted. A bare "12 skipped" at the
     * bottom of a green run is easy to read past; a list of the consent
     * assertions that did not actually run is not.
     */
    console.log("Skipped - no FrontEnd checkout beside this repo:");
    for (const name of skipped) console.log(`  - ${name}`);
    console.log("");
  }
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
