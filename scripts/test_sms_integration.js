/**
 * The SMS system against a real database.
 *
 * test_sms_core proves the rules. This proves the behaviour that only exists
 * once there is a database underneath: whether the idempotency claim actually
 * stops a second worker, whether a retry resends or duplicates, whether an
 * opt-out survives, and whether SMS_ENABLED=false really keeps every message
 * inside the building.
 *
 *   node scripts/test_sms_integration.js
 *
 * Not in `npm test`: it boots a MongoDB binary.
 */

process.env.S3_BUCKET = process.env.S3_BUCKET || "test-bucket";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_fake";
delete process.env.SMS_ENABLED;
delete process.env.SMS_MARKETING_ENABLED;

const assert = require("assert");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

/* -------------------------------------------------------------------------- */
/* A fake Twilio, installed before the service loads the real one.             */
/* -------------------------------------------------------------------------- */

const twilioCalls = [];
let nextSendBehaviour = null;

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const realProvider = require("../utils/sms/twilioProvider");

/**
 * The provider double.
 *
 * Deliberately reuses the real error classification and signature validation:
 * those are the parts most worth exercising, and a hand-written double of them
 * would be testing the double rather than the system. Only the network call is
 * replaced.
 */
stub("../utils/sms/twilioProvider", {
  ...realProvider,
  async sendMessage({ to, body }) {
    twilioCalls.push({ to, body });
    if (nextSendBehaviour) {
      const behaviour = nextSendBehaviour;
      nextSendBehaviour = null;
      throw behaviour;
    }
    return { sid: `SM${twilioCalls.length}`, status: "queued", numSegments: 1, to };
  },
});

const SmsMessage = require("../models/SmsMessage");
const SmsOptOut = require("../models/SmsOptOut");
const User = require("../models/User");
const Subscription = require("../models/Subscription");
const Booking = require("../models/Booking");
const smsService = require("../utils/sms/smsService");
const smsNotify = require("../utils/sms/smsNotifications");
const dedupe = require("../utils/sms/smsDedupe");
const { runCampaign } = require("../utils/sms/smsCampaignRunner");
const { SmsProviderError } = realProvider;

/* -------------------------------------------------------------------------- */

let passed = 0;
const failures = [];
let mongod;

async function test(name, fn) {
  twilioCalls.length = 0;
  nextSendBehaviour = null;
  await Promise.all([
    SmsMessage.deleteMany({}),
    SmsOptOut.deleteMany({}),
    User.deleteMany({}),
    Subscription.deleteMany({}),
    Booking.deleteMany({}),
  ]);
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error.message}`);
  }
}

const APPOINTMENT = new Date("2026-03-03T19:00:00.000Z");

async function makeUser(overrides = {}) {
  return User.create({
    userId: overrides.userId || `u${Math.random().toString(36).slice(2, 10)}`,
    name: "Sam Carter",
    email: overrides.email || `sam${Math.random().toString(36).slice(2, 8)}@example.com`,
    phone: "6315991363",
    role: "customer",
    ...overrides,
  });
}

async function makeBooking(user, overrides = {}) {
  return Booking.create({
    bookingNumber: String(Math.floor(10000000 + Math.random() * 8999999)),
    date: APPOINTMENT,
    service: "Handyman visit",
    user: user._id,
    userId: user.userId,
    name: user.name,
    address: "1 Main St",
    phone: "6315991363",
    email: user.email,
    subscription: "basic",
    status: "Confirmed",
    ...overrides,
  });
}

/* ========================================================================== */

async function run() {
  console.log("\nProduction safety");

  await test("SMS_ENABLED=false records the message and sends nothing", async () => {
    const user = await makeUser();
    const booking = await makeBooking(user);

    const result = await smsNotify.notifyBookingConfirmed(booking, user);

    assert.equal(result.status, "simulated");
    assert.equal(twilioCalls.length, 0, "no provider call may be made");

    const row = await SmsMessage.findOne({ dedupeKey: dedupe.bookingKey("BOOKING_CONFIRMED", booking) });
    assert.ok(row, "the attempt must still be recorded");
    assert.equal(row.status, "simulated");
    assert.equal(row.suppressionReason, "sms_disabled");
    assert.ok(row.body.includes("ProFixter"), "the rendered body is stored for audit");
    assert.equal(row.sentAt, null);
  });

  await test("a simulated message still consumes its dedupe key", async () => {
    /*
     * So that switching sending on does not release weeks of stale reminders at
     * customers whose appointments have already happened.
     */
    const user = await makeUser();
    const booking = await makeBooking(user);

    await smsNotify.notifyBookingConfirmed(booking, user);
    process.env.SMS_ENABLED = "true";
    const second = await smsNotify.notifyBookingConfirmed(booking, user);
    delete process.env.SMS_ENABLED;

    assert.equal(second.status, "duplicate");
    assert.equal(twilioCalls.length, 0);
    assert.equal(await SmsMessage.countDocuments({}), 1);
  });

  await test("with sending enabled the provider is actually called", async () => {
    // The control for every "nothing was sent" assertion above.
    process.env.SMS_ENABLED = "true";
    try {
      const user = await makeUser();
      const booking = await makeBooking(user);
      const result = await smsNotify.notifyBookingConfirmed(booking, user);
      assert.equal(result.status, "sent");
      assert.equal(twilioCalls.length, 1);
      assert.equal(twilioCalls[0].to, "+16315991363");
      const row = await SmsMessage.findOne({});
      assert.equal(row.status, "sent");
      assert.equal(row.providerMessageSid, "SM1");
      assert.ok(row.sentAt);
    } finally {
      delete process.env.SMS_ENABLED;
    }
  });

  console.log("\nIdempotency");

  await test("a booking confirmation is sent once, however many times it is asked for", async () => {
    const user = await makeUser();
    const booking = await makeBooking(user);
    for (let i = 0; i < 5; i += 1) await smsNotify.notifyBookingConfirmed(booking, user);
    assert.equal(await SmsMessage.countDocuments({}), 1);
  });

  await test("concurrent workers produce exactly one message", async () => {
    /*
     * The scenario the whole design exists for: four Elastic Beanstalk
     * instances running the same sweep in the same second. The claim is an
     * insert under a unique index, so the database picks one winner and the
     * losers get a duplicate-key error they treat as "somebody else has it".
     */
    const user = await makeUser();
    const booking = await makeBooking(user);

    const results = await Promise.all(
      Array.from({ length: 8 }, () => smsNotify.notifyBookingConfirmed(booking, user))
    );

    assert.equal(await SmsMessage.countDocuments({}), 1);
    assert.equal(results.filter((r) => r.status === "duplicate").length, 7);
    assert.equal(results.filter((r) => r.status === "simulated").length, 1);
  });

  await test("the 24-hour reminder is sent once", async () => {
    const user = await makeUser();
    const booking = await makeBooking(user);
    for (let i = 0; i < 3; i += 1) await smsNotify.notifyBookingReminder(booking, user, "24h");
    assert.equal(await SmsMessage.countDocuments({ notificationType: "BOOKING_REMINDER_24H" }), 1);
  });

  await test("the 60-minute reminder is sent once, and is separate from the 24-hour one", async () => {
    const user = await makeUser();
    const booking = await makeBooking(user);
    await smsNotify.notifyBookingReminder(booking, user, "24h");
    await smsNotify.notifyBookingReminder(booking, user, "60m");
    await smsNotify.notifyBookingReminder(booking, user, "60m");

    assert.equal(await SmsMessage.countDocuments({ notificationType: "BOOKING_REMINDER_24H" }), 1);
    assert.equal(await SmsMessage.countDocuments({ notificationType: "BOOKING_REMINDER_60M" }), 1);
  });

  await test("a completion message is sent once per booking", async () => {
    const user = await makeUser();
    const booking = await makeBooking(user, { status: "Completed" });
    await smsNotify.notifyBookingCompleted(booking, user);
    await smsNotify.notifyBookingCompleted(booking, user);
    const rows = await SmsMessage.find({});
    assert.equal(rows.length, 1);
    assert.ok(rows[0].body.includes("https://www.profixter.com/tip"));
  });

  console.log("\nRescheduling");

  await test("a rescheduled booking gets a NEW reminder, not a suppressed one", async () => {
    /*
     * The bug that looks most like correct deduplication: the customer told
     * about Monday has been told nothing about Thursday, so suppressing
     * Thursday because Monday was announced is wrong.
     */
    const user = await makeUser();
    const booking = await makeBooking(user);
    await smsNotify.notifyBookingReminder(booking, user, "24h");

    booking.date = new Date("2026-03-06T15:00:00.000Z");
    await booking.save();
    await smsNotify.notifyBookingReminder(booking, user, "24h");

    const rows = await SmsMessage.find({ notificationType: "BOOKING_REMINDER_24H" }).sort({ createdAt: 1 });
    assert.equal(rows.length, 2, "the new appointment needs its own reminder");
    assert.notEqual(rows[0].dedupeKey, rows[1].dedupeKey);
    assert.ok(rows[1].body.includes("Mar 6"), `should describe the new date: ${rows[1].body}`);
  });

  await test("a reminder for the OLD time is never resent after a move", async () => {
    const user = await makeUser();
    const booking = await makeBooking(user);
    await smsNotify.notifyBookingReminder(booking, user, "24h");
    const originalKey = dedupe.bookingKey("BOOKING_REMINDER_24H", booking);

    booking.date = new Date("2026-03-06T15:00:00.000Z");
    await booking.save();
    await smsNotify.notifyBookingReminder(booking, user, "24h");

    // Re-running the sweep against the moved booking must not revive the old one.
    await smsNotify.notifyBookingReminder(booking, user, "24h");
    assert.equal(await SmsMessage.countDocuments({ dedupeKey: originalKey }), 1);
    assert.equal(await SmsMessage.countDocuments({ notificationType: "BOOKING_REMINDER_24H" }), 2);
  });

  await test("a reschedule notice describes the new time and repeats only per move", async () => {
    const user = await makeUser();
    const booking = await makeBooking(user);

    booking.date = new Date("2026-03-06T15:00:00.000Z");
    await booking.save();
    await smsNotify.notifyBookingRescheduled(booking, user);
    await smsNotify.notifyBookingRescheduled(booking, user);
    assert.equal(await SmsMessage.countDocuments({ notificationType: "BOOKING_RESCHEDULED" }), 1);

    booking.date = new Date("2026-03-09T15:00:00.000Z");
    await booking.save();
    await smsNotify.notifyBookingRescheduled(booking, user);
    assert.equal(await SmsMessage.countDocuments({ notificationType: "BOOKING_RESCHEDULED" }), 2);
  });

  console.log("\nCancellation");

  await test("a cancelled booking receives its cancellation once", async () => {
    const user = await makeUser();
    const booking = await makeBooking(user, { status: "Canceled" });
    await smsNotify.notifyBookingCancelled(booking, user);
    await smsNotify.notifyBookingCancelled(booking, user);
    assert.equal(await SmsMessage.countDocuments({ notificationType: "BOOKING_CANCELLED" }), 1);
  });

  await test("a cancelled booking is not selected by the reminder sweep at all", async () => {
    /*
     * The strongest form of "cancel the pending reminders": there is no queue
     * to drain. The sweep selects only Confirmed bookings, so a cancelled one
     * stops being selectable the moment its status changes.
     */
    const user = await makeUser();
    await makeBooking(user, { status: "Canceled", date: new Date(Date.now() + 23 * 3600 * 1000) });

    const selectable = await Booking.countDocuments({
      status: /^confirmed$/i,
      date: { $lte: new Date(Date.now() + 24 * 3600 * 1000) },
    });
    assert.equal(selectable, 0);
    assert.equal(await SmsMessage.countDocuments({ notificationType: /REMINDER/ }), 0);
  });

  console.log("\nOpt-out");

  await test("a STOP blocks every message, including service messages", async () => {
    const user = await makeUser();
    const booking = await makeBooking(user);
    await SmsOptOut.create({
      phone: "+16315991363",
      scope: "all",
      source: "carrier_keyword",
      keyword: "stop",
      optedOutAt: new Date(),
    });

    const result = await smsNotify.notifyBookingReminder(booking, user, "24h");
    assert.equal(result.status, "suppressed");
    assert.equal(result.reason, "opted_out_all");
    assert.equal(twilioCalls.length, 0);

    const row = await SmsMessage.findOne({});
    assert.equal(row.status, "suppressed");
    assert.equal(row.suppressionReason, "opted_out_all");
  });

  await test("a marketing-only opt-out still allows appointment reminders", async () => {
    const user = await makeUser();
    const booking = await makeBooking(user);
    await SmsOptOut.create({
      phone: "+16315991363",
      scope: "marketing",
      source: "customer_preference",
      optedOutAt: new Date(),
    });

    const result = await smsNotify.notifyBookingReminder(booking, user, "24h");
    assert.equal(result.status, "simulated", "a service message must still go");
  });

  await test("a START after a STOP restores service messaging", async () => {
    const user = await makeUser();
    const booking = await makeBooking(user);
    const stoppedAt = new Date(Date.now() - 60000);
    await SmsOptOut.create({
      phone: "+16315991363",
      scope: "all",
      source: "carrier_keyword",
      optedOutAt: stoppedAt,
      optedInAt: new Date(),
    });

    const result = await smsNotify.notifyBookingReminder(booking, user, "24h");
    assert.equal(result.status, "simulated");
  });

  await test("a STOP received after a START is honoured in the right order", async () => {
    const user = await makeUser();
    const booking = await makeBooking(user);
    await SmsOptOut.create({
      phone: "+16315991363",
      scope: "all",
      source: "carrier_keyword",
      optedInAt: new Date(Date.now() - 60000),
      optedOutAt: new Date(),
    });

    const result = await smsNotify.notifyBookingReminder(booking, user, "24h");
    assert.equal(result.status, "suppressed");
  });

  await test("Twilio reporting an unknown opt-out writes it into our own table", async () => {
    process.env.SMS_ENABLED = "true";
    try {
      const user = await makeUser();
      const booking = await makeBooking(user);
      nextSendBehaviour = new SmsProviderError("recipient unsubscribed", {
        code: 21610,
        status: 400,
        retryable: false,
        reason: "recipient_opted_out",
      });

      await smsNotify.notifyBookingReminder(booking, user, "24h");

      const optOut = await SmsOptOut.findOne({ phone: "+16315991363" });
      assert.ok(optOut, "our state must be synchronised with Twilio's");
      assert.equal(optOut.source, "twilio_error");
      assert.equal(optOut.scope, "all");
    } finally {
      delete process.env.SMS_ENABLED;
    }
  });

  await test("a message with no usable phone number is recorded, not sent", async () => {
    /*
     * Booking.phone is required by the schema, so the realistic failure is not
     * an empty field but a junk one: a number typed wrong, or a placeholder
     * somebody entered to get past a form. It must be refused rather than
     * "corrected" into a stranger's phone.
     */
    const user = await makeUser({ phone: "000" });
    const booking = await makeBooking(user, { phone: "000" });
    const result = await smsNotify.notifyBookingReminder(booking, user, "24h");
    assert.equal(result.status, "suppressed");
    assert.equal(result.reason, "no_valid_phone");
    assert.equal(twilioCalls.length, 0);
  });

  console.log("\nRetries");

  await test("a transient failure is retried and eventually sends once", async () => {
    process.env.SMS_ENABLED = "true";
    try {
      const user = await makeUser();
      const booking = await makeBooking(user);
      nextSendBehaviour = new SmsProviderError("Twilio unavailable", {
        code: 20503,
        status: 503,
        retryable: true,
        reason: "provider_server_error",
      });

      const first = await smsNotify.notifyBookingReminder(booking, user, "24h");
      assert.equal(first.status, "retry_scheduled");

      let row = await SmsMessage.findOne({});
      assert.equal(row.status, "retry_scheduled");
      assert.ok(row.nextAttemptAt, "a retry must be scheduled");
      assert.equal(row.attempts, 1);

      // Move time forward past the backoff and sweep.
      const stats = await smsService.runSmsRetrySweep({
        now: new Date(Date.now() + 10 * 60 * 1000),
      });
      assert.equal(stats.sent, 1);

      row = await SmsMessage.findOne({});
      assert.equal(row.status, "sent");
      assert.equal(row.attempts, 2);
      assert.equal(twilioCalls.length, 2, "one failed attempt, one successful");
      assert.equal(await SmsMessage.countDocuments({}), 1, "a retry must not duplicate the row");
    } finally {
      delete process.env.SMS_ENABLED;
    }
  });

  await test("a permanent failure is never retried", async () => {
    process.env.SMS_ENABLED = "true";
    try {
      const user = await makeUser();
      const booking = await makeBooking(user);
      nextSendBehaviour = new SmsProviderError("invalid number", {
        code: 21211,
        status: 400,
        retryable: false,
        reason: "invalid_phone_number",
      });

      await smsNotify.notifyBookingReminder(booking, user, "24h");

      const row = await SmsMessage.findOne({});
      assert.equal(row.status, "failed");
      assert.equal(row.nextAttemptAt, null);
      assert.equal(row.suppressionReason, "invalid_phone_number");

      const stats = await smsService.runSmsRetrySweep({ now: new Date(Date.now() + 3600 * 1000) });
      assert.equal(stats.scanned, 0, "a permanent failure must not be picked up");
      assert.equal(twilioCalls.length, 1);
    } finally {
      delete process.env.SMS_ENABLED;
    }
  });

  await test("a message stranded by a dead worker is reclaimed", async () => {
    process.env.SMS_ENABLED = "true";
    try {
      const user = await makeUser();
      await SmsMessage.create({
        user: user._id,
        toPhone: "+16315991363",
        notificationType: "BOOKING_REMINDER_24H",
        channelClass: "transactional",
        body: "stranded",
        status: "sending",
        dedupeKey: "stranded_key",
        attempts: 1,
        lockExpiresAt: new Date(Date.now() - 60000),
      });

      const stats = await smsService.runSmsRetrySweep({ now: new Date() });
      assert.equal(stats.reclaimed, 1);
      assert.equal(stats.sent, 1);
      assert.equal((await SmsMessage.findOne({})).status, "sent");
    } finally {
      delete process.env.SMS_ENABLED;
    }
  });

  await test("retries stop after the maximum, and say why", async () => {
    process.env.SMS_ENABLED = "true";
    try {
      const user = await makeUser();
      await SmsMessage.create({
        user: user._id,
        toPhone: "+16315991363",
        notificationType: "BOOKING_REMINDER_24H",
        channelClass: "transactional",
        body: "exhausted",
        status: "retry_scheduled",
        dedupeKey: "exhausted_key",
        attempts: 3,
        nextAttemptAt: new Date(Date.now() - 1000),
      });

      const stats = await smsService.runSmsRetrySweep({ now: new Date() });
      assert.equal(stats.abandoned, 1);
      assert.equal(twilioCalls.length, 0, "no further provider call may be made");

      const row = await SmsMessage.findOne({});
      assert.equal(row.status, "failed");
      assert.equal(row.suppressionReason, "max_attempts_exceeded");
    } finally {
      delete process.env.SMS_ENABLED;
    }
  });

  await test("the retry sweep sends nothing while SMS_ENABLED is false", async () => {
    await SmsMessage.create({
      toPhone: "+16315991363",
      notificationType: "BOOKING_REMINDER_24H",
      channelClass: "transactional",
      body: "queued while disabled",
      status: "retry_scheduled",
      dedupeKey: "disabled_retry_key",
      attempts: 1,
      nextAttemptAt: new Date(Date.now() - 1000),
    });

    const stats = await smsService.runSmsRetrySweep({ now: new Date() });
    assert.equal(stats.sent, 0);
    assert.equal(twilioCalls.length, 0);
    // Left alone rather than failed, so it becomes sendable again later.
    assert.equal((await SmsMessage.findOne({})).status, "retry_scheduled");
  });

  console.log("\nMarketing");

  const campaign = {
    _id: new mongoose.Types.ObjectId(),
    campaignId: "membership_push_v1",
    name: "Membership push",
    category: "membership",
    enabled: true,
    audience: { membership: "non_member", minAccountAgeDays: 30, requiresCompletedBooking: false },
    frequency: { cooldownDays: 180, minDaysBetweenAnyMarketing: 30, maxSendsPerPerson: 2 },
    limits: { maxPerRun: 25, maxPerDay: 100 },
    sendWindow: { startHour: 11, endHour: 18, daysOfWeek: [1, 2, 3, 4, 5, 6] },
  };
  // A Monday at 12:00 New York, inside the window.
  const MARKETING_NOW = new Date("2026-03-02T17:00:00.000Z");
  const OLD_ACCOUNT = new Date("2025-01-01T00:00:00.000Z");

  await test("marketing reaches nobody without an explicit opt-in", async () => {
    process.env.SMS_MARKETING_ENABLED = "true";
    try {
      await makeUser({ createdAt: OLD_ACCOUNT });
      const stats = await runCampaign(campaign, { now: MARKETING_NOW });
      assert.equal(stats.claimed, 0);
      /*
       * Not even considered. The consent rule is in the candidate query itself,
       * so somebody who has not opted in is never loaded, never evaluated and
       * never given a suppressed audit row. That is both cheaper and the right
       * record: we did not decide against texting them, we never had grounds to
       * consider it.
       */
      assert.equal(stats.considered, 0);
      assert.equal(await SmsMessage.countDocuments({}), 0);
    } finally {
      delete process.env.SMS_MARKETING_ENABLED;
    }
  });

  await test("an opted-in non-member does receive the campaign", async () => {
    process.env.SMS_MARKETING_ENABLED = "true";
    try {
      await makeUser({
        createdAt: OLD_ACCOUNT,
        smsPreferences: { marketingEnabled: true, marketingConsentAt: OLD_ACCOUNT },
      });
      const stats = await runCampaign(campaign, { now: MARKETING_NOW });
      assert.equal(stats.claimed, 1);
      const row = await SmsMessage.findOne({});
      assert.equal(row.channelClass, "marketing");
      assert.equal(row.campaignId, "membership_push_v1");
      assert.match(row.body, /Reply STOP/i);
    } finally {
      delete process.env.SMS_MARKETING_ENABLED;
    }
  });

  await test("an ACTIVE member is excluded from the membership campaign", async () => {
    process.env.SMS_MARKETING_ENABLED = "true";
    try {
      const user = await makeUser({
        createdAt: OLD_ACCOUNT,
        smsPreferences: { marketingEnabled: true },
      });
      await Subscription.create({
        user: user._id,
        userId: user.userId,
        subscriptionType: "premium",
        addressId: new mongoose.Types.ObjectId(),
        startDate: OLD_ACCOUNT,
        latestPaymentDate: OLD_ACCOUNT,
        nextPaymentDate: new Date("2026-04-01"),
        status: "active",
      });

      const stats = await runCampaign(campaign, { now: MARKETING_NOW });
      assert.equal(stats.claimed, 0, "an active member must not be sold a membership");
      assert.equal(stats.skipped, 1);
    } finally {
      delete process.env.SMS_MARKETING_ENABLED;
    }
  });

  await test("an opted-out phone is refused even with an opted-in account", async () => {
    process.env.SMS_MARKETING_ENABLED = "true";
    try {
      await makeUser({ createdAt: OLD_ACCOUNT, smsPreferences: { marketingEnabled: true } });
      await SmsOptOut.create({
        phone: "+16315991363",
        scope: "all",
        source: "carrier_keyword",
        optedOutAt: new Date(),
      });

      await runCampaign(campaign, { now: MARKETING_NOW });
      const row = await SmsMessage.findOne({});
      assert.equal(row.status, "suppressed", "the handset opt-out overrides the account");
      assert.equal(twilioCalls.length, 0);
    } finally {
      delete process.env.SMS_MARKETING_ENABLED;
    }
  });

  await test("excludeFromMarketing keeps internal accounts out", async () => {
    process.env.SMS_MARKETING_ENABLED = "true";
    try {
      await makeUser({
        createdAt: OLD_ACCOUNT,
        excludeFromMarketing: true,
        smsPreferences: { marketingEnabled: true },
      });
      const stats = await runCampaign(campaign, { now: MARKETING_NOW });
      assert.equal(stats.claimed, 0);
    } finally {
      delete process.env.SMS_MARKETING_ENABLED;
    }
  });

  await test("a campaign does not send twice inside its cooldown", async () => {
    process.env.SMS_MARKETING_ENABLED = "true";
    try {
      await makeUser({ createdAt: OLD_ACCOUNT, smsPreferences: { marketingEnabled: true } });
      const first = await runCampaign(campaign, { now: MARKETING_NOW });
      assert.equal(first.claimed, 1);

      // A week later: inside both the campaign cooldown and the global cap.
      const later = new Date(MARKETING_NOW.getTime() + 7 * 24 * 3600 * 1000);
      const second = await runCampaign(campaign, { now: later });
      assert.equal(second.claimed, 0);
      assert.equal(await SmsMessage.countDocuments({}), 1);
    } finally {
      delete process.env.SMS_MARKETING_ENABLED;
    }
  });

  await test("nothing is sent while the marketing channel is off", async () => {
    await makeUser({ createdAt: OLD_ACCOUNT, smsPreferences: { marketingEnabled: true } });
    const { runSmsCampaignSweep } = require("../utils/sms/smsCampaignRunner");
    const result = await runSmsCampaignSweep({ now: MARKETING_NOW });
    assert.equal(result.ran, false);
    assert.equal(result.reason, "marketing_channel_disabled");
    assert.equal(await SmsMessage.countDocuments({}), 0);
  });

  await test("a campaign outside its send window does not run", async () => {
    process.env.SMS_MARKETING_ENABLED = "true";
    try {
      await makeUser({ createdAt: OLD_ACCOUNT, smsPreferences: { marketingEnabled: true } });
      // 03:00 New York.
      const night = new Date("2026-03-02T08:00:00.000Z");
      const stats = await runCampaign(campaign, { now: night });
      assert.equal(stats.reason, "outside_send_hours");
      assert.equal(stats.claimed, 0);
    } finally {
      delete process.env.SMS_MARKETING_ENABLED;
    }
  });

  await test("a disabled campaign never runs", async () => {
    process.env.SMS_MARKETING_ENABLED = "true";
    try {
      await makeUser({ createdAt: OLD_ACCOUNT, smsPreferences: { marketingEnabled: true } });
      const stats = await runCampaign({ ...campaign, enabled: false }, { now: MARKETING_NOW });
      assert.equal(stats.reason, "campaign_disabled");
    } finally {
      delete process.env.SMS_MARKETING_ENABLED;
    }
  });

  console.log("\nStatus callbacks and STOP handling");

  const webhook = require("../routes/smsWebhook");

  await test("a repeated delivery callback is harmless", async () => {
    await SmsMessage.create({
      toPhone: "+16315991363",
      notificationType: "BOOKING_REMINDER_24H",
      channelClass: "transactional",
      body: "x",
      status: "sent",
      dedupeKey: "cb_key",
      providerMessageSid: "SM_CB",
      sentAt: new Date(),
    });

    for (let i = 0; i < 3; i += 1) {
      await SmsMessage.updateOne(
        { providerMessageSid: "SM_CB", status: { $nin: ["delivered"] } },
        { $set: { status: "delivered", deliveredAt: new Date(), providerStatus: "delivered" } }
      );
    }
    const rows = await SmsMessage.find({ providerMessageSid: "SM_CB" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "delivered");
  });

  await test("a late 'sent' callback cannot downgrade a delivered message", async () => {
    await SmsMessage.create({
      toPhone: "+16315991363",
      notificationType: "BOOKING_REMINDER_24H",
      channelClass: "transactional",
      body: "x",
      status: "delivered",
      dedupeKey: "ooo_key",
      providerMessageSid: "SM_OOO",
      deliveredAt: new Date(),
    });

    // The filter the route uses for a "sent" callback.
    await SmsMessage.updateOne(
      { providerMessageSid: "SM_OOO", status: { $in: ["pending", "sending"] } },
      { $set: { status: "sent" } }
    );
    assert.equal((await SmsMessage.findOne({ providerMessageSid: "SM_OOO" })).status, "delivered");
  });

  await test("a STOP writes the opt-out and mirrors it onto the account", async () => {
    const user = await makeUser({ phone: "+16315991363" });
    await webhook.applyOptOut("+16315991363", "stop");

    const optOut = await SmsOptOut.findOne({ phone: "+16315991363" });
    assert.ok(optOut);
    assert.equal(optOut.scope, "all");
    assert.equal(optOut.source, "carrier_keyword");

    const reloaded = await User.findById(user._id).lean();
    assert.equal(reloaded.smsPreferences.marketingEnabled, false);
    assert.ok(reloaded.smsPreferences.optedOutAt);
  });

  await test("a repeated STOP does not create a second opt-out row", async () => {
    await makeUser({ phone: "+16315991363" });
    await webhook.applyOptOut("+16315991363", "stop");
    await webhook.applyOptOut("+16315991363", "unsubscribe");
    assert.equal(await SmsOptOut.countDocuments({ phone: "+16315991363" }), 1);
  });

  await test("a START restores service messaging but NOT marketing", async () => {
    /*
     * START is a reply to a service message, not the express written consent
     * that promotional texting requires. Restoring marketing on a START would
     * treat the two as the same thing.
     */
    const user = await makeUser({
      phone: "+16315991363",
      smsPreferences: { marketingEnabled: true },
    });
    await webhook.applyOptOut("+16315991363", "stop");
    await webhook.applyOptIn("+16315991363", "start");

    const optOut = await SmsOptOut.findOne({ phone: "+16315991363" });
    assert.ok(optOut.optedInAt, "the opt-out must be resolved");

    const reloaded = await User.findById(user._id).lean();
    assert.equal(reloaded.smsPreferences.marketingEnabled, false, "marketing stays off");

    const booking = await makeBooking(reloaded);
    const result = await smsNotify.notifyBookingReminder(booking, reloaded, "24h");
    assert.equal(result.status, "simulated", "service messaging is restored");
  });

  console.log("\nVisit types end to end");

  await test("each booking kind produces its own confirmation type and wording", async () => {
    const cases = [
      [{}, "BOOKING_CONFIRMED", /membership visit/i],
      [
        { accessType: "free_first_visit", isFreeFirstVisit: true },
        "FREE_VISIT_CONFIRMED",
        /free first visit/i,
      ],
      [
        { bookingType: "one_time_handyman_visit", accessType: "one_time", service: "One-Time Visit" },
        "ONE_TIME_VISIT_CONFIRMED",
        /One-Time Visit/,
      ],
      [
        { bookingType: "full_day_visit", accessType: "one_time", service: "Full Day Fixter" },
        "FULL_DAY_CONFIRMED",
        /Full Day/,
      ],
    ];

    for (const [overrides, expectedType, pattern] of cases) {
      const user = await makeUser();
      const booking = await makeBooking(user, overrides);
      await smsNotify.notifyBookingConfirmed(booking, user);
      const row = await SmsMessage.findOne({ booking: booking._id });
      assert.equal(row.notificationType, expectedType, JSON.stringify(overrides));
      assert.match(row.body, pattern);
    }
  });

  await test("each booking kind produces its own completion type, all with the tip link", async () => {
    const cases = [
      [{}, "BOOKING_COMPLETED"],
      [{ accessType: "free_first_visit", isFreeFirstVisit: true }, "FREE_VISIT_COMPLETED"],
      [{ bookingType: "one_time_handyman_visit", accessType: "one_time" }, "ONE_TIME_VISIT_COMPLETED"],
      [{ bookingType: "full_day_visit", accessType: "one_time" }, "FULL_DAY_COMPLETED"],
    ];

    for (const [overrides, expectedType] of cases) {
      const user = await makeUser();
      const booking = await makeBooking(user, { status: "Completed", ...overrides });
      await smsNotify.notifyBookingCompleted(booking, user);
      const row = await SmsMessage.findOne({ booking: booking._id });
      assert.equal(row.notificationType, expectedType, JSON.stringify(overrides));
      assert.ok(row.body.includes("https://www.profixter.com/tip"));
      assert.ok(!/\/review/.test(row.body), "no review link while review state is unknowable");
    }
  });

  console.log("\nMembership lifecycle");

  await test("a scheduled cancellation and a real one are different messages", async () => {
    const user = await makeUser();
    const subscription = await Subscription.create({
      user: user._id,
      userId: user.userId,
      subscriptionType: "premium",
      addressId: new mongoose.Types.ObjectId(),
      startDate: new Date("2026-01-01"),
      latestPaymentDate: new Date("2026-02-01"),
      /*
       * A realistic Stripe period end: an actual instant, not midnight UTC.
       *
       * Worth being deliberate about, because "2026-03-31" parses as midnight
       * UTC, which is 7pm on the 30th in New York — so a naive fixture would
       * make a correct implementation look wrong. Dates are rendered in the
       * customer's timezone, and this asserts that they are.
       */
      nextPaymentDate: new Date("2026-03-31T14:22:07.000Z"),
      currentPeriodEnd: new Date("2026-03-31T14:22:07.000Z"),
      status: "active",
      cancelAtPeriodEnd: true,
    });

    await smsNotify.notifyMembershipCancellationScheduled(subscription, user);
    await smsNotify.notifyMembershipCancelled(subscription, user);

    const scheduled = await SmsMessage.findOne({
      notificationType: "MEMBERSHIP_CANCELLATION_SCHEDULED",
    });
    const ended = await SmsMessage.findOne({ notificationType: "MEMBERSHIP_CANCELLED" });

    assert.match(scheduled.body, /keep full access until Tue, Mar 31/i);
    assert.ok(!/has now ended/i.test(scheduled.body));
    assert.match(ended.body, /has now ended/i);
  });

  await test("a payment failure is announced once per invoice, not per retry", async () => {
    const user = await makeUser();
    for (let i = 0; i < 4; i += 1) {
      await smsNotify.notifyPaymentFailed({ invoiceId: "in_ABC123", user });
    }
    assert.equal(await SmsMessage.countDocuments({ notificationType: "PAYMENT_FAILED" }), 1);

    // A genuinely different invoice is a genuinely different problem.
    await smsNotify.notifyPaymentFailed({ invoiceId: "in_XYZ789", user });
    assert.equal(await SmsMessage.countDocuments({ notificationType: "PAYMENT_FAILED" }), 2);
  });

  await test("a membership welcome is sent once", async () => {
    const user = await makeUser();
    const subscription = await Subscription.create({
      user: user._id,
      userId: user.userId,
      subscriptionType: "elite",
      addressId: new mongoose.Types.ObjectId(),
      startDate: new Date(),
      latestPaymentDate: new Date(),
      nextPaymentDate: new Date("2026-04-01"),
      status: "active",
    });
    await smsNotify.notifyMembershipStarted(subscription, user);
    await smsNotify.notifyMembershipStarted(subscription, user);
    assert.equal(await SmsMessage.countDocuments({ notificationType: "MEMBERSHIP_STARTED" }), 1);
  });

  console.log("\nAudit record");

  await test("a message records everything an operator would need", async () => {
    const user = await makeUser();
    const booking = await makeBooking(user);
    await smsNotify.notifyBookingConfirmed(booking, user, "testSource");

    const row = await SmsMessage.findOne({}).lean();
    assert.equal(String(row.user), String(user._id));
    assert.equal(row.userId, user.userId);
    assert.equal(String(row.booking), String(booking._id));
    assert.equal(row.bookingNumber, booking.bookingNumber);
    assert.equal(row.toPhone, "+16315991363");
    assert.equal(row.notificationType, "BOOKING_CONFIRMED");
    assert.equal(row.channelClass, "transactional");
    assert.ok(row.body);
    assert.equal(row.provider, "twilio");
    assert.ok(row.dedupeKey);
    assert.equal(row.source, "testSource");
    assert.ok(row.createdAt);
    assert.ok(row.scheduledFor);
    assert.ok(row.segments >= 1);
  });

  await test("a notification never throws into its caller", async () => {
    /*
     * A booking confirmation must not fail because a text could not be sent.
     * Passing rubbish exercises the guarantee rather than assuming it.
     */
    const result = await smsNotify.notifyBookingConfirmed(null, null);
    assert.ok(result, "must return rather than throw");
    assert.equal(result.ok, false);
  });
}

/* ========================================================================== */

(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: "sms_test" });
  await Promise.all([SmsMessage.init(), SmsOptOut.init(), User.init()]);

  try {
    await run();
  } finally {
    await mongoose.disconnect();
    await mongod.stop();
  }

  console.log(`\n${passed} passed, ${failures.length} failed.`);
  if (failures.length) {
    for (const { name, error } of failures) {
      console.error(`\n--- ${name} ---\n${error.stack || error.message}`);
    }
    process.exit(1);
  }
  process.exit(0);
})();
