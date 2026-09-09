/**
 * The SMS system's pure logic.
 *
 * Everything here is deterministic and needs no database, no network and no
 * Twilio account, which is why it can run in CI on every deploy. The parts that
 * genuinely need a database — idempotency under concurrency, retries, opt-out
 * storage, webhook handling — live in test_sms_integration.js.
 *
 *   node scripts/test_sms_core.js
 */

process.env.S3_BUCKET = process.env.S3_BUCKET || "test-bucket";

/*
 * Establish the production-safe defaults before anything reads them. The whole
 * suite runs as production will on the day it ships: sending off, marketing
 * off, review link off.
 */
delete process.env.SMS_ENABLED;
delete process.env.SMS_MARKETING_ENABLED;
delete process.env.SMS_REVIEW_LINK_ENABLED;

const assert = require("node:assert/strict");
const crypto = require("crypto");

const config = require("../utils/sms/smsConfig");
const dedupe = require("../utils/sms/smsDedupe");
const eligibility = require("../utils/sms/smsEligibility");
const phone = require("../utils/sms/smsPhone");
const templates = require("../utils/sms/smsTemplates");
const types = require("../utils/sms/smsTypes");
const provider = require("../utils/sms/twilioProvider");

let passed = 0;
const failures = [];

const pending = [];

/**
 * Runs a case whether it is synchronous or returns a promise.
 *
 * Both kinds are needed here. Most assertions are pure, but the guards on the
 * typed send helpers and the disabled-provider check are only observable as
 * rejections, and a runner that ignored a returned promise would report those
 * as passing without ever having checked them.
 */
function test(name, fn) {
  let result;
  try {
    result = fn();
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error.message}`);
    return;
  }
  if (result && typeof result.then === "function") {
    pending.push(
      result.then(
        () => {
          passed += 1;
          console.log(`  PASS  ${name}`);
        },
        (error) => {
          failures.push({ name, error });
          console.log(`  FAIL  ${name}\n        ${error.message}`);
        }
      )
    );
    return;
  }
  passed += 1;
  console.log(`  PASS  ${name}`);
}

function section(title) {
  console.log(`\n${title}`);
}

/** A booking of each kind, with one fixed appointment instant: 2pm New York. */
const APPOINTMENT = new Date("2026-03-03T19:00:00.000Z");
const BOOKINGS = {
  membership: {
    _id: "b_membership",
    bookingNumber: "10000001",
    bookingType: "membership_visit",
    accessType: "membership",
    service: "Handyman visit",
    date: APPOINTMENT,
  },
  freeFirst: {
    _id: "b_free",
    bookingNumber: "10000002",
    bookingType: "membership_visit",
    accessType: "free_first_visit",
    isFreeFirstVisit: true,
    service: "Handyman visit",
    date: APPOINTMENT,
  },
  oneTime: {
    _id: "b_onetime",
    bookingNumber: "10000003",
    bookingType: "one_time_handyman_visit",
    accessType: "one_time",
    service: "One-Time Visit",
    date: APPOINTMENT,
  },
  fullDay: {
    _id: "b_fullday",
    bookingNumber: "10000004",
    bookingType: "full_day_visit",
    // A paid Full Day genuinely carries accessType one_time. This is the trap.
    accessType: "one_time",
    service: "Full Day Fixter",
    date: APPOINTMENT,
  },
};

/* ========================================================================== */
section("Production safety");
/* ========================================================================== */

test("SMS_ENABLED is false by default", () => {
  assert.equal(config.smsEnabled(), false);
});

test("marketing is off by default, independently of SMS_ENABLED", () => {
  assert.equal(config.smsMarketingEnabled(), false);
});

test("nothing but the word 'true' enables sending", () => {
  /*
   * The values checked here are the plausible misconfigurations: a truthy
   * looking number, a synonym, a partial word. None of them may enable a
   * channel that contacts customers.
   *
   * The try/finally matters. Without it a failure inside the loop would leave
   * SMS_ENABLED set, and every later case would run against a system that
   * believes sending is on, which turns one failure into a cascade that hides
   * its own cause.
   */
  try {
    for (const value of ["", "false", "1", "yes", "on", "True!", "0", " ", "truthy"]) {
      process.env.SMS_ENABLED = value;
      assert.equal(config.smsEnabled(), false, `"${value}" must not enable sending`);
    }
    // Whitespace and case are forgiven, matching the repo's other flags.
    for (const value of ["true", "TRUE", " true ", "True"]) {
      process.env.SMS_ENABLED = value;
      assert.equal(config.smsEnabled(), true, `"${value}" should enable sending`);
    }
  } finally {
    delete process.env.SMS_ENABLED;
  }
});

test("the provider refuses to send while SMS_ENABLED is false", async () => {
  // Synchronous assertion of an async rejection: collect it, then check.
  let rejected = null;
  provider.sendMessage({ to: "+16315991363", body: "x" }).catch((e) => {
    rejected = e;
  });
  // The guard is hit before any await, so the rejection is already scheduled.
  return Promise.resolve().then(() => {
    assert.ok(rejected, "send should have been refused");
    assert.equal(rejected.reason, "sms_disabled");
  });
});

test("configSnapshot never leaks a credential value", () => {
  process.env.TWILIO_ACCOUNT_SID = "AC_super_secret_sid";
  process.env.TWILIO_API_SECRET = "secret_value_here";
  const snapshot = JSON.stringify(config.configSnapshot());
  assert.ok(!snapshot.includes("AC_super_secret_sid"));
  assert.ok(!snapshot.includes("secret_value_here"));
  assert.ok(snapshot.includes("hasAccountSid"));
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_API_SECRET;
});

/* ========================================================================== */
section("Phone normalization");
/* ========================================================================== */

test("accepts the formats a customer actually types", () => {
  for (const input of [
    "6315991363",
    "(631) 599-1363",
    "631-599-1363",
    "631.599.1363",
    "+1 631 599 1363",
    "16315991363",
    "+16315991363",
    " 631 599 1363 ",
    "001 631 599 1363",
  ]) {
    assert.equal(phone.toE164(input), "+16315991363", `failed on: ${input}`);
  }
});

test("rejects what is not a dialable US number", () => {
  for (const input of ["", null, undefined, "123", "555", "0315991363", "1315991363", "abc", "631599136", "63159913631234567"]) {
    assert.equal(phone.toE164(input), null, `should reject: ${JSON.stringify(input)}`);
  }
});

test("rejects area codes and exchanges starting 0 or 1", () => {
  assert.equal(phone.toE164("0315991363"), null);
  assert.equal(phone.toE164("1315991363"), null);
  assert.equal(phone.toE164("6310991363"), null);
});

test("masking keeps a number out of the logs", () => {
  const masked = phone.maskPhone("6315991363");
  assert.equal(masked, "+1******63");
  assert.ok(!masked.includes("599"));
  assert.ok(!masked.includes("13"));
});

test("segment estimate flags a message that would cost double", () => {
  assert.equal(phone.estimateSegments("a".repeat(160)), 1);
  assert.equal(phone.estimateSegments("a".repeat(161)), 2);
  // One emoji forces UCS-2 and cuts the single-segment limit to 70.
  assert.equal(phone.estimateSegments("a".repeat(71)), 1);
  assert.equal(phone.estimateSegments("\u{1F600}" + "a".repeat(70)), 2);
});

test("booking phone is preferred over the account phone", () => {
  const resolved = phone.resolveBookingPhone({ phone: "6315991363" }, { phone: "2125551212" });
  assert.equal(resolved.phone, "+16315991363");
  assert.equal(resolved.source, "booking");
});

test("account phone is the fallback when the booking has none", () => {
  const resolved = phone.resolveBookingPhone({ phone: "" }, { phone: "2125551212" });
  assert.equal(resolved.phone, "+12125551212");
  assert.equal(resolved.source, "user");
});

/* ========================================================================== */
section("Notification type registry");
/* ========================================================================== */

test("every type declares a channel class", () => {
  for (const type of types.allTypes()) {
    const spec = types.getTypeSpec(type);
    assert.ok(
      ["transactional", "marketing"].includes(spec.channelClass),
      `${type} has no valid channelClass`
    );
    assert.equal(typeof spec.timeCritical, "boolean", `${type} has no timeCritical`);
    assert.ok(spec.description, `${type} has no description`);
  }
});

test("an unknown type is refused rather than guessed at", () => {
  assert.throws(() => types.getTypeSpec("MADE_UP_TYPE"), /Unknown SMS notification type/);
  assert.equal(types.isKnownType("MADE_UP_TYPE"), false);
});

test("marketing and transactional are disjoint and complete", () => {
  const marketing = new Set(types.typesOfClass("marketing"));
  const transactional = new Set(types.typesOfClass("transactional"));
  assert.equal(marketing.size + transactional.size, types.allTypes().length);
  for (const type of marketing) assert.ok(!transactional.has(type));
});

test("the three promotional types are the only marketing types", () => {
  assert.deepEqual(types.typesOfClass("marketing").sort(), [
    "KITCHEN_BATH_MARKETING",
    "MEMBERSHIP_MARKETING",
    "SEASONAL_MARKETING",
  ]);
});

test("NO routine renewal or recurring-charge notification exists", () => {
  /*
   * The explicit business rule: ProFixter does not volunteer reminders of
   * routine recurring charges. Asserted against the registry rather than
   * against the templates, because the registry is what makes such a message
   * possible to send at all.
   */
  const banned = /RENEWAL|RENEW|UPCOMING_PAYMENT|UPCOMING_CHARGE|CARD_CHARG|RECURRING|PAYMENT_SUCCE|PAYMENT_RECEIVED|INVOICE_UPCOMING|SUBSCRIPTION_RENEW/i;
  const offenders = types.allTypes().filter((type) => banned.test(type));
  assert.deepEqual(offenders, [], `these must not exist: ${offenders.join(", ")}`);
});

test("PAYMENT_FAILED exists, because a failure is actionable", () => {
  assert.ok(types.isKnownType("PAYMENT_FAILED"));
  assert.equal(types.channelClassOf("PAYMENT_FAILED"), "transactional");
});

test("ON_THE_WAY is reserved but has no trigger", () => {
  assert.ok(types.isKnownType("FIXTER_ON_THE_WAY"));
  const notifications = require("../utils/sms/smsNotifications");
  const triggers = Object.keys(notifications).join(" ");
  assert.ok(!/OnTheWay|OnWay/i.test(triggers), "no trigger should exist yet");
});

/* ========================================================================== */
section("Visit terminology");
/* ========================================================================== */

test("each booking kind is classified correctly", () => {
  assert.equal(templates.visitVocabulary(BOOKINGS.membership).kind, "membership");
  assert.equal(templates.visitVocabulary(BOOKINGS.freeFirst).kind, "free_first");
  assert.equal(templates.visitVocabulary(BOOKINGS.oneTime).kind, "one_time");
  assert.equal(templates.visitVocabulary(BOOKINGS.fullDay).kind, "full_day");
});

test("a paid Full Day is never described as a One-Time Visit", () => {
  // The trap: it carries accessType "one_time". Full Day must win.
  const vocab = templates.visitVocabulary(BOOKINGS.fullDay);
  assert.equal(vocab.kind, "full_day");
  const body = templates.renderSms("FULL_DAY_CONFIRMED", { booking: BOOKINGS.fullDay });
  assert.ok(!/90 minutes/i.test(body), "must not mention 90 minutes");
  assert.ok(!/One-Time/i.test(body), "must not say One-Time");
  assert.match(body, /Full Day/);
  assert.match(body, /full workday/i);
});

test("a free first visit is never called a membership visit", () => {
  const body = templates.renderSms("FREE_VISIT_CONFIRMED", { booking: BOOKINGS.freeFirst });
  assert.ok(!/membership/i.test(body), "must not mention membership");
  assert.match(body, /free first visit/i);
  assert.match(body, /no charge/i);
});

test("a One-Time Visit is never said to be included in a membership", () => {
  const body = templates.renderSms("ONE_TIME_VISIT_CONFIRMED", { booking: BOOKINGS.oneTime });
  assert.ok(!/membership/i.test(body));
  assert.ok(!/included/i.test(body));
  assert.match(body, /One-Time Visit/);
});

test("a membership visit is described as one", () => {
  const body = templates.renderSms("BOOKING_CONFIRMED", { booking: BOOKINGS.membership });
  assert.match(body, /membership visit/i);
});

test("reminders carry the right words for every kind", () => {
  const expectations = [
    [BOOKINGS.membership, /membership visit/i],
    [BOOKINGS.freeFirst, /free first visit/i],
    [BOOKINGS.oneTime, /One-Time Visit/],
    [BOOKINGS.fullDay, /Full Day/],
  ];
  for (const [booking, pattern] of expectations) {
    for (const type of ["BOOKING_REMINDER_24H", "BOOKING_REMINDER_60M"]) {
      assert.match(templates.renderSms(type, { booking }), pattern, `${type} / ${booking._id}`);
    }
  }
});

test("a Full Day reminder never quotes a single start time", () => {
  const body = templates.renderSms("BOOKING_REMINDER_24H", { booking: BOOKINGS.fullDay });
  assert.ok(!/\d:\d\d\s?(AM|PM)/i.test(body), `should not name a start time: ${body}`);
});

test("the 24-hour reminder never claims the visit is 'tomorrow'", () => {
  /*
   * The sweep can legitimately deliver a catch-up reminder as little as two
   * hours before the visit after an outage. "Tomorrow" would then be a lie, so
   * the template names the date instead.
   */
  for (const booking of Object.values(BOOKINGS)) {
    const body = templates.renderSms("BOOKING_REMINDER_24H", { booking });
    assert.ok(!/tomorrow/i.test(body), `must not say tomorrow: ${body}`);
  }
});

/* ========================================================================== */
section("Completion, tip and review links");
/* ========================================================================== */

test("every completion message carries the tip link", () => {
  for (const type of [
    "BOOKING_COMPLETED",
    "FREE_VISIT_COMPLETED",
    "ONE_TIME_VISIT_COMPLETED",
    "FULL_DAY_COMPLETED",
  ]) {
    const body = templates.renderSms(type, { booking: BOOKINGS.membership });
    assert.ok(
      body.includes("https://www.profixter.com/tip"),
      `${type} must carry the exact tip URL`
    );
  }
});

test("the review link is NOT sent, because review state is unknowable", () => {
  /*
   * profixter.com/review is a bare redirect to Google Maps. Nothing records
   * that a customer arrived, and nothing records that they left a review, so
   * "customers who have not reviewed" is not a set this system can compute.
   * Including the link would mean asking people who have already done it.
   */
  assert.equal(config.reviewLinkEnabled(), false);
  for (const type of [
    "BOOKING_COMPLETED",
    "FREE_VISIT_COMPLETED",
    "ONE_TIME_VISIT_COMPLETED",
    "FULL_DAY_COMPLETED",
  ]) {
    const body = templates.renderSms(type, { booking: BOOKINGS.membership });
    assert.ok(!/\/review/i.test(body), `${type} must not carry a review link`);
  }
});

test("the review link plumbing works when the flag is turned on", () => {
  // Proves the capability is built and waiting, not merely absent.
  process.env.SMS_REVIEW_LINK_ENABLED = "true";
  const body = templates.renderSms("BOOKING_COMPLETED", { booking: BOOKINGS.membership });
  assert.ok(body.includes("https://www.profixter.com/review"));
  assert.ok(body.includes("https://www.profixter.com/tip"));
  delete process.env.SMS_REVIEW_LINK_ENABLED;
});

test("only the canonical URLs are ever used", () => {
  const allBodies = types
    .allTypes()
    .map((type) =>
      templates.renderSms(type, {
        booking: BOOKINGS.membership,
        name: "Sam",
        fixterName: "Alex",
        planLabel: "Premium",
        billingCycle: "monthly",
        accessUntil: APPOINTMENT,
      })
    )
    .join(" ");
  const urls = allBodies.match(/https?:\/\/\S+/g) || [];
  for (const url of urls) {
    assert.ok(
      url.startsWith("https://www.profixter.com/"),
      `unexpected link in an SMS: ${url}`
    );
  }
});

/* ========================================================================== */
section("Membership wording");
/* ========================================================================== */

test("a scheduled cancellation does not claim the membership has ended", () => {
  const body = templates.renderSms("MEMBERSHIP_CANCELLATION_SCHEDULED", {
    accessUntil: new Date("2026-03-31T12:00:00Z"),
  });
  assert.match(body, /keep full access until/i);
  assert.ok(!/has now ended/i.test(body));
  assert.match(body, /Mar 31/);
});

test("an actual cancellation says the membership ended", () => {
  const body = templates.renderSms("MEMBERSHIP_CANCELLED", {});
  assert.match(body, /has now ended/i);
  assert.ok(!/keep full access/i.test(body));
});

test("the two cancellation messages are genuinely different", () => {
  assert.notEqual(
    templates.renderSms("MEMBERSHIP_CANCELLATION_SCHEDULED", { accessUntil: APPOINTMENT }),
    templates.renderSms("MEMBERSHIP_CANCELLED", {})
  );
});

/* ========================================================================== */
section("Marketing rules");
/* ========================================================================== */

test("every marketing message carries an opt-out instruction", () => {
  for (const type of types.typesOfClass("marketing")) {
    const body = templates.renderSms(type, { body: "Seasonal copy" });
    assert.match(body, /Reply STOP/i, `${type} must carry the opt-out line`);
  }
});

test("the opt-out line is added even if a template forgets it", () => {
  const body = templates.renderSms("SEASONAL_MARKETING", { body: "No opt out written here" });
  assert.match(body, /Reply STOP to opt out\./);
});

test("no transactional message is padded with marketing", () => {
  /*
   * ACCOUNT_CREATED is the deliberate exception. For most customers the welcome
   * text is the first message ProFixter ever sends them, and carrying the
   * opt-out instruction on an initial message is what the carriers expect. That
   * is a compliance disclosure, not marketing, so it is exempted by name rather
   * than by loosening the rule for every transactional message.
   */
  const DISCLOSURE_EXEMPT = new Set(["ACCOUNT_CREATED"]);
  for (const type of types.typesOfClass("transactional")) {
    if (DISCLOSURE_EXEMPT.has(type)) continue;
    const body = templates.renderSms(type, {
      booking: BOOKINGS.membership,
      name: "Sam",
      fixterName: "Alex",
      planLabel: "Premium",
      accessUntil: APPOINTMENT,
    });
    assert.ok(!/Reply STOP/i.test(body), `${type} should not carry the marketing opt-out`);
  }
  // And the exemption is real, not a way of skipping a broken template.
  assert.match(templates.renderSms("ACCOUNT_CREATED", { name: "Sam" }), /Reply STOP/i);
});

/* ========================================================================== */
section("Template safety");
/* ========================================================================== */

test("every type has a template, and every template renders", () => {
  for (const type of types.allTypes()) {
    assert.ok(templates.hasTemplate(type), `${type} has no template`);
    const body = templates.renderSms(type, {
      booking: BOOKINGS.membership,
      name: "Sam Carter",
      fixterName: "Alex Rivera",
      planLabel: "Premium",
      billingCycle: "monthly",
      accessUntil: APPOINTMENT,
      body: "Seasonal",
    });
    assert.ok(body.length > 0, `${type} rendered empty`);
  }
});

test("no message exceeds the length cap", () => {
  for (const type of types.allTypes()) {
    const body = templates.renderSms(type, {
      booking: BOOKINGS.membership,
      name: "X".repeat(300),
      fixterName: "Y".repeat(300),
      planLabel: "Z".repeat(300),
      body: "W".repeat(900),
    });
    assert.ok(body.length <= config.MAX_BODY_LENGTH, `${type} is ${body.length} chars`);
  }
});

test("every message fits inside two segments", () => {
  for (const type of types.allTypes()) {
    const body = templates.renderSms(type, {
      booking: BOOKINGS.membership,
      name: "Sam",
      fixterName: "Alex",
      planLabel: "Premium",
      billingCycle: "monthly",
      accessUntil: APPOINTMENT,
      body: "Seasonal offer",
    });
    assert.ok(phone.estimateSegments(body) <= 2, `${type} is ${phone.estimateSegments(body)} segments`);
  }
});

test("no template smuggles in a non-GSM7 character", () => {
  // One curly quote or emoji halves the segment size for the whole message.
  for (const type of types.allTypes()) {
    const body = templates.renderSms(type, {
      booking: BOOKINGS.membership,
      name: "Sam",
      fixterName: "Alex",
      planLabel: "Premium",
      accessUntil: APPOINTMENT,
      body: "Seasonal",
    });
    assert.equal(phone.isUnicodeBody(body), false, `${type} forces UCS-2: ${body}`);
  }
});

test("a customer-supplied value cannot inject a link", () => {
  const body = templates.renderSms("FIXTER_ASSIGNED", {
    booking: BOOKINGS.membership,
    fixterName: "Eve http://evil.example/pay",
  });
  assert.ok(!/evil/i.test(body), `link leaked: ${body}`);
  assert.ok(!/http:\/\//.test(body));
});

test("a customer-supplied value cannot inject newlines", () => {
  const body = templates.renderSms("MEMBERSHIP_STARTED", {
    name: "Sam\n\nURGENT: call 555-0000",
    planLabel: "Premium",
  });
  assert.ok(!body.includes("\n"));
});

test("hyphenated words survive sanitisation", () => {
  // A regression guard: an over-broad control-character class once turned
  // "One-Time" into "One Time".
  assert.equal(templates.clean("One-Time Visit"), "One-Time Visit");
  assert.equal(templates.clean("Anne-Marie O Brien"), "Anne-Marie O Brien");
});

/* ========================================================================== */
section("Timezone and DST");
/* ========================================================================== */

test("times render in New York regardless of server timezone", () => {
  // 19:00 UTC is 2pm EST.
  assert.match(templates.formatDateTime(new Date("2026-03-03T19:00:00Z")), /2:00 PM/);
});

test("a 2pm appointment reads as 2pm on both sides of the spring change", () => {
  // DST begins 2026-03-08. Before: UTC-5. After: UTC-4.
  assert.match(templates.formatDateTime(new Date("2026-03-07T19:00:00Z")), /Sat, Mar 7 at 2:00 PM/);
  assert.match(templates.formatDateTime(new Date("2026-03-09T18:00:00Z")), /Mon, Mar 9 at 2:00 PM/);
});

test("a 2pm appointment reads as 2pm on both sides of the autumn change", () => {
  // DST ends 2026-11-01.
  assert.match(templates.formatDateTime(new Date("2026-10-30T18:00:00Z")), /Fri, Oct 30 at 2:00 PM/);
  assert.match(templates.formatDateTime(new Date("2026-11-02T19:00:00Z")), /Mon, Nov 2 at 2:00 PM/);
});

test("an appointment during the repeated autumn hour still renders", () => {
  // 01:30 New York happens twice on 2026-11-01. Both instants must format.
  assert.match(templates.formatDateTime(new Date("2026-11-01T05:30:00Z")), /1:30 AM/);
  assert.match(templates.formatDateTime(new Date("2026-11-01T06:30:00Z")), /1:30 AM/);
});

test("an invalid date renders as empty rather than 1970", () => {
  assert.equal(templates.formatDateTime(null), "");
  assert.equal(templates.formatDateTime("not a date"), "");
  assert.equal(templates.formatDateOnly(undefined), "");
});

test("New York hour is read correctly across DST", () => {
  // 16:00 UTC is 11am EST in March, and noon EDT in July.
  assert.equal(eligibility.newYorkParts(new Date("2026-01-15T16:00:00Z")).hour, 11);
  assert.equal(eligibility.newYorkParts(new Date("2026-07-15T16:00:00Z")).hour, 12);
});

test("midnight New York is hour 0, not hour 24", () => {
  assert.equal(eligibility.newYorkParts(new Date("2026-01-15T05:00:00Z")).hour, 0);
});

/* ========================================================================== */
section("Quiet hours");
/* ========================================================================== */

const at = (iso) => new Date(iso);

test("marketing is refused outside the daytime window", () => {
  // 03:00 New York.
  assert.equal(eligibility.withinSendWindow("KITCHEN_BATH_MARKETING", at("2026-01-15T08:00:00Z")), false);
  // 21:00 New York.
  assert.equal(eligibility.withinSendWindow("KITCHEN_BATH_MARKETING", at("2026-01-16T02:00:00Z")), false);
});

test("marketing is allowed in the middle of the day", () => {
  // 12:00 New York.
  assert.equal(eligibility.withinSendWindow("KITCHEN_BATH_MARKETING", at("2026-01-15T17:00:00Z")), true);
});

test("a reminder is never held back by quiet hours", () => {
  /*
   * An hour-before reminder deferred out of a quiet window is not politer, it
   * is useless: the customer chose the appointment time that put it there.
   */
  for (const iso of ["2026-01-15T08:00:00Z", "2026-01-16T02:00:00Z", "2026-01-15T17:00:00Z"]) {
    assert.equal(eligibility.withinSendWindow("BOOKING_REMINDER_60M", at(iso)), true, iso);
    assert.equal(eligibility.withinSendWindow("BOOKING_REMINDER_24H", at(iso)), true, iso);
    assert.equal(eligibility.withinSendWindow("BOOKING_CONFIRMED", at(iso)), true, iso);
  }
});

test("a non-urgent transactional message waits for morning", () => {
  // 03:00 New York: an account notice can wait.
  assert.equal(eligibility.withinSendWindow("ACCOUNT_CREATED", at("2026-01-15T08:00:00Z")), false);
  // 12:00 New York.
  assert.equal(eligibility.withinSendWindow("ACCOUNT_CREATED", at("2026-01-15T17:00:00Z")), true);
});

/* ========================================================================== */
section("Consent");
/* ========================================================================== */

test("marketing requires an explicit opt-in; absence is not consent", () => {
  assert.equal(eligibility.accountAllows({}, "KITCHEN_BATH_MARKETING").eligible, false);
  assert.equal(
    eligibility.accountAllows({ smsPreferences: {} }, "KITCHEN_BATH_MARKETING").eligible,
    false
  );
  assert.equal(
    eligibility.accountAllows(
      { smsPreferences: { marketingEnabled: true } },
      "KITCHEN_BATH_MARKETING"
    ).eligible,
    true
  );
});

test("transactional is allowed when no preference has been recorded", () => {
  // Nobody has an SMS preference yet; service messages must still work.
  assert.equal(eligibility.accountAllows({}, "BOOKING_REMINDER_24H").eligible, true);
  assert.equal(
    eligibility.accountAllows({ smsPreferences: {} }, "BOOKING_CONFIRMED").eligible,
    true
  );
});

test("transactional is refused when the customer switched it off", () => {
  const verdict = eligibility.accountAllows(
    { smsPreferences: { transactionalEnabled: false } },
    "BOOKING_CONFIRMED"
  );
  assert.equal(verdict.eligible, false);
  assert.equal(verdict.reason, "transactional_disabled_by_user");
});

test("excludeFromMarketing blocks marketing but not service messages", () => {
  const user = { excludeFromMarketing: true, smsPreferences: { marketingEnabled: true } };
  assert.equal(eligibility.accountAllows(user, "KITCHEN_BATH_MARKETING").eligible, false);
  assert.equal(eligibility.accountAllows(user, "BOOKING_REMINDER_24H").eligible, true);
});

/* ========================================================================== */
section("Deduplication keys");
/* ========================================================================== */

test("a reminder key changes when the booking is rescheduled", () => {
  const original = { _id: "b1", date: new Date("2026-03-03T19:00:00Z") };
  const moved = { _id: "b1", date: new Date("2026-03-05T15:00:00Z") };
  assert.notEqual(
    dedupe.bookingKey("BOOKING_REMINDER_24H", original),
    dedupe.bookingKey("BOOKING_REMINDER_24H", moved)
  );
});

test("a reminder key is stable when nothing moved", () => {
  const a = { _id: "b1", date: new Date("2026-03-03T19:00:00Z") };
  const b = { _id: "b1", date: new Date("2026-03-03T19:00:00.000Z") };
  assert.equal(
    dedupe.bookingKey("BOOKING_REMINDER_24H", a),
    dedupe.bookingKey("BOOKING_REMINDER_24H", b)
  );
});

test("confirmation, cancellation and completion happen once per booking", () => {
  const before = { _id: "b1", date: new Date("2026-03-03T19:00:00Z") };
  const after = { _id: "b1", date: new Date("2026-03-05T15:00:00Z") };
  for (const type of ["BOOKING_CONFIRMED", "BOOKING_CANCELLED", "BOOKING_COMPLETED"]) {
    assert.equal(
      dedupe.bookingKey(type, before),
      dedupe.bookingKey(type, after),
      `${type} must not recur when a booking moves`
    );
  }
});

test("two different bookings never share a key", () => {
  const a = { _id: "b1", date: APPOINTMENT };
  const b = { _id: "b2", date: APPOINTMENT };
  assert.notEqual(dedupe.bookingKey("BOOKING_CONFIRMED", a), dedupe.bookingKey("BOOKING_CONFIRMED", b));
});

test("the 24-hour and 60-minute reminders have different keys", () => {
  const booking = { _id: "b1", date: APPOINTMENT };
  assert.notEqual(
    dedupe.bookingKey("BOOKING_REMINDER_24H", booking),
    dedupe.bookingKey("BOOKING_REMINDER_60M", booking)
  );
});

test("reassignment to a different Fixter is a new occurrence", () => {
  const booking = { _id: "b1", date: APPOINTMENT };
  assert.notEqual(
    dedupe.assignmentKey("FIXTER_CHANGED", booking, "fixter_a"),
    dedupe.assignmentKey("FIXTER_CHANGED", booking, "fixter_b")
  );
});

test("a payment failure is keyed to the invoice, not the retry", () => {
  assert.equal(
    dedupe.invoiceKey("PAYMENT_FAILED", "in_123"),
    dedupe.invoiceKey("PAYMENT_FAILED", "in_123")
  );
  assert.notEqual(
    dedupe.invoiceKey("PAYMENT_FAILED", "in_123"),
    dedupe.invoiceKey("PAYMENT_FAILED", "in_456")
  );
});

test("a campaign key separates cycles", () => {
  const user = { _id: "u1" };
  assert.notEqual(dedupe.campaignKey("c1", user, 0), dedupe.campaignKey("c1", user, 1));
  assert.equal(dedupe.campaignKey("c1", user, 0), dedupe.campaignKey("c1", user, 0));
});

test("a key never contains characters that would break an index lookup", () => {
  const key = dedupe.bookingKey("BOOKING_CONFIRMED", { _id: "a b/c\nd", date: APPOINTMENT });
  assert.ok(!/[\s/\n]/.test(key), `unsafe key: ${JSON.stringify(key)}`);
});

test("a booking with no date still produces a usable key", () => {
  const key = dedupe.bookingKey("BOOKING_REMINDER_24H", { _id: "b1", date: null });
  assert.match(key, /no_date$/);
});

/* ========================================================================== */
section("Twilio webhook authenticity");
/* ========================================================================== */

const TOKEN = "test_auth_token";
const HOOK_URL = "https://api.profixter.com/api/sms/webhook/status";

function twilioSignature(url, params, token = TOKEN) {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return crypto.createHmac("sha1", token).update(Buffer.from(data, "utf-8")).digest("base64");
}

test("a genuine Twilio signature is accepted", () => {
  const params = { MessageSid: "SM1", MessageStatus: "delivered" };
  const result = provider.validateTwilioSignature({
    url: HOOK_URL,
    params,
    signature: twilioSignature(HOOK_URL, params),
    authToken: TOKEN,
  });
  assert.equal(result.valid, true);
});

test("a tampered parameter is rejected", () => {
  const params = { MessageSid: "SM1", MessageStatus: "delivered" };
  const signature = twilioSignature(HOOK_URL, params);
  const result = provider.validateTwilioSignature({
    url: HOOK_URL,
    params: { ...params, MessageStatus: "failed" },
    signature,
    authToken: TOKEN,
  });
  assert.equal(result.valid, false);
});

test("an added parameter is rejected", () => {
  const params = { MessageSid: "SM1", MessageStatus: "delivered" };
  const result = provider.validateTwilioSignature({
    url: HOOK_URL,
    params: { ...params, Extra: "injected" },
    signature: twilioSignature(HOOK_URL, params),
    authToken: TOKEN,
  });
  assert.equal(result.valid, false);
});

test("a signature captured from one endpoint cannot be replayed on another", () => {
  const params = { MessageSid: "SM1", MessageStatus: "delivered" };
  const result = provider.validateTwilioSignature({
    url: "https://api.profixter.com/api/sms/webhook/inbound",
    params,
    signature: twilioSignature(HOOK_URL, params),
    authToken: TOKEN,
  });
  assert.equal(result.valid, false);
});

test("a signature made with the wrong token is rejected", () => {
  const params = { MessageSid: "SM1" };
  const result = provider.validateTwilioSignature({
    url: HOOK_URL,
    params,
    signature: twilioSignature(HOOK_URL, params, "attacker_token"),
    authToken: TOKEN,
  });
  assert.equal(result.valid, false);
});

test("an unsigned request is rejected", () => {
  const result = provider.validateTwilioSignature({
    url: HOOK_URL,
    params: { MessageSid: "SM1" },
    signature: "",
    authToken: TOKEN,
  });
  assert.equal(result.valid, false);
  assert.equal(result.reason, "missing_signature");
});

test("verification fails closed when no auth token is configured", () => {
  const params = { MessageSid: "SM1" };
  const result = provider.validateTwilioSignature({
    url: HOOK_URL,
    params,
    signature: twilioSignature(HOOK_URL, params),
    authToken: "",
  });
  assert.equal(result.valid, false);
  assert.equal(result.reason, "auth_token_not_configured");
});

test("a signature of the wrong length is rejected without throwing", () => {
  // timingSafeEqual throws on a length mismatch; the guard must come first.
  const result = provider.validateTwilioSignature({
    url: HOOK_URL,
    params: { MessageSid: "SM1" },
    signature: "short",
    authToken: TOKEN,
  });
  assert.equal(result.valid, false);
});

/* ========================================================================== */
section("Retry classification");
/* ========================================================================== */

test("transient provider problems are retried", () => {
  for (const [code, status] of [[20429, 429], [20500, 500], [20503, 503], [30001, 400], [30022, 400]]) {
    assert.equal(provider.classifyTwilioError({ code, status }).retryable, true, `code ${code}`);
  }
  assert.equal(provider.classifyTwilioError({ code: "", status: 500 }).retryable, true);
  assert.equal(provider.classifyTwilioError({ code: "", status: 503 }).retryable, true);
});

test("permanent failures are never retried", () => {
  for (const code of [21211, 21214, 21408, 21610, 21614, 30003, 30005, 30006, 30007]) {
    const verdict = provider.classifyTwilioError({ code, status: 400 });
    assert.equal(verdict.retryable, false, `code ${code} must not retry`);
    assert.ok(verdict.reason, `code ${code} must have a named reason`);
  }
});

test("an opted-out recipient is a permanent failure with a nameable reason", () => {
  const verdict = provider.classifyTwilioError({ code: 21610, status: 400 });
  assert.equal(verdict.retryable, false);
  assert.equal(verdict.reason, "recipient_opted_out");
});

test("an unrecognised client error defaults to not retrying", () => {
  assert.equal(provider.classifyTwilioError({ code: 99999, status: 400 }).retryable, false);
});

test("an opt-out error is detectable so our own state can be synchronised", () => {
  assert.equal(provider.isOptOutError({ providerErrorCode: "21610" }), true);
  assert.equal(provider.isOptOutError({ providerErrorCode: "21211" }), false);
});

test("backoff widens and then stops", () => {
  const { nextAttemptDelayMs } = require("../utils/sms/smsService");
  assert.ok(nextAttemptDelayMs(1) < nextAttemptDelayMs(2));
  assert.ok(nextAttemptDelayMs(2) < nextAttemptDelayMs(3));
  // Beyond the table it clamps rather than throwing or returning undefined.
  assert.equal(nextAttemptDelayMs(99), nextAttemptDelayMs(3));
});

/* ========================================================================== */
section("Typed send guards");
/* ========================================================================== */

test("a marketing type cannot be sent as transactional", async () => {
  const { sendTransactionalSms } = require("../utils/sms/smsService");
  await assert.rejects(
    () => sendTransactionalSms({ notificationType: "KITCHEN_BATH_MARKETING", dedupeKey: "k" }),
    /use sendMarketingSms/
  );
});

test("a transactional type cannot be sent as marketing", async () => {
  const { sendMarketingSms } = require("../utils/sms/smsService");
  await assert.rejects(
    () => sendMarketingSms({ notificationType: "BOOKING_CONFIRMED", dedupeKey: "k" }),
    /use sendTransactionalSms/
  );
});

/* ========================================================================== */
section("STOP keyword parsing");
/* ========================================================================== */

test("carrier keywords are recognised in any case or punctuation", () => {
  const { normalizeKeyword } = require("../routes/smsWebhook");
  assert.equal(normalizeKeyword("STOP"), "stop");
  assert.equal(normalizeKeyword(" stop "), "stop");
  assert.equal(normalizeKeyword("Stop!"), "stop");
  assert.equal(normalizeKeyword("UNSUBSCRIBE"), "unsubscribe");
  assert.equal(normalizeKeyword("Start"), "start");
  assert.equal(normalizeKeyword("HELP"), "help");
});

test("an ordinary reply is not mistaken for a keyword", () => {
  const { normalizeKeyword } = require("../routes/smsWebhook");
  assert.equal(normalizeKeyword("please stop by at 3"), "please stop by at");
  assert.equal(normalizeKeyword("thanks!"), "thanks");
});

/* ========================================================================== */

Promise.all(pending).then(() => {
  console.log(`\n${passed} passed, ${failures.length} failed.`);
  if (failures.length) {
    for (const { name, error } of failures) {
      console.error(`\n--- ${name} ---\n${error.stack || error.message}`);
    }
    process.exit(1);
  }
  process.exit(0);
});
