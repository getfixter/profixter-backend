/**
 * The reminder sweep against a real database.
 *
 * The policy suite proves the rules. This proves the lifecycle around them: the
 * claim, the order of the send and the record, what a failure leaves behind,
 * and whether running the sweep again does nothing or does it twice.
 *
 *   node scripts/test_booking_reminders_integration.js
 *
 * Not in `npm test`: it boots a MongoDB binary.
 */

process.env.S3_BUCKET = process.env.S3_BUCKET || "test-bucket";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_fake";

const assert = require("assert");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

/* ---- fakes, installed before the job loads them ---- */
const sent = [];
let failNext = 0;

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

stub("../utils/emailService", {
  FROM: "test@profixter.com",
  REPLY_TO: "test@profixter.com",
  async sendTx(templateKey, to, vars) {
    if (failNext > 0) {
      failNext -= 1;
      const error = new Error("SES throttled");
      error.code = "Throttling";
      throw error;
    }
    sent.push({ templateKey, to, vars });
    return { messageId: `msg-${sent.length}` };
  },
});
// The CRM is not under test and must never decide whether an email counts.
const tags = [];
let failTags = 0;
stub("../utils/ghlContact", {
  createOrUpdateContact: async () => "contact-1",
  updateContactFields: async () => true,
  addTag: async (contactId, tag) => {
    if (failTags > 0) { failTags -= 1; return false; }
    tags.push(tag);
    return true;
  },
  formatBookingDateTime: () => "pretty",
});

const Booking = require("../models/Booking");
const { runBookingReminderCycle, logReminderHeartbeat } = require("../jobs/bookingReminders");
const { REMINDER_MAX_ATTEMPTS } = require("../utils/bookingReminderPolicy");

const HOUR = 3600000;
let passed = 0;
const failures = [];

async function test(name, fn) {
  sent.length = 0;
  tags.length = 0;
  failNext = 0;
  failTags = 0;
  await Booking.deleteMany({});
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error.message}`);
  }
}

let seq = 0;
async function makeBooking(hoursAway, overrides = {}) {
  seq += 1;
  return Booking.create({
    bookingNumber: String(10000000 + seq),
    date: new Date(Date.now() + hoursAway * HOUR),
    service: "Labor Only",
    subscription: "Plus",
    user: new mongoose.Types.ObjectId(),
    userId: String(20000000 + seq),
    name: "Test Customer",
    phone: "+15550001111",
    email: `customer${seq}@example.com`,
    address: "1 Test Street",
    city: "Babylon",
    state: "NY",
    zip: "11702",
    status: "Confirmed",
    ...overrides,
  });
}

const reload = (b) => Booking.findById(b._id).lean();

async function run() {
  const server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri(), { dbName: "reminders" });
  await Booking.init();

  try {
    console.log("\nSending");

    await test("a booking due its 24h reminder gets exactly one", async () => {
      const b = await makeBooking(20);
      await runBookingReminderCycle();
      assert.equal(sent.length, 1);
      assert.equal(sent[0].templateKey, "booking_reminder_24h");
      const after = await reload(b);
      assert.ok(after.reminder24hSentAt, "sent time recorded");
      assert.equal(after.reminder24hMessageId, "msg-1", "provider receipt kept for tracing");
      assert.equal(after.reminder24hQueuedAt, undefined, "lock released");
    });

    await test("running the sweep five more times sends nothing further", async () => {
      await makeBooking(20);
      await runBookingReminderCycle();
      assert.equal(sent.length, 1);
      for (let i = 0; i < 5; i += 1) await runBookingReminderCycle();
      assert.equal(sent.length, 1, "idempotent across repeated runs");
    });

    await test("a booking 30 hours out is not reminded yet", async () => {
      await makeBooking(30);
      await runBookingReminderCycle();
      assert.equal(sent.length, 0);
    });

    console.log("\nRecovering from a scheduler outage");

    await test("a reminder due six hours ago still goes out", async () => {
      // Due at T-24h; nothing ran until T-18h. The old narrow window lost this.
      const b = await makeBooking(18);
      await runBookingReminderCycle();
      assert.equal(sent.length, 1);
      assert.ok((await reload(b)).reminder24hSentAt);
    });

    await test("a 60m reminder missed at the hour still goes out at 20 minutes", async () => {
      const b = await makeBooking(20 / 60);
      await runBookingReminderCycle();
      const keys = sent.map((s) => s.templateKey);
      assert.ok(keys.includes("booking_reminder_60m"), `got ${keys.join(",")}`);
      assert.ok((await reload(b)).reminder60mSentAt);
    });

    console.log("\nFailure and retry");

    await test("a failed send is retried, not consumed", async () => {
      const b = await makeBooking(20);
      failNext = 1;
      await runBookingReminderCycle();
      let after = await reload(b);
      assert.equal(sent.length, 0, "nothing was delivered");
      assert.equal(after.reminder24hSentAt, undefined, "and nothing was recorded as sent");
      assert.equal(after.reminder24hAttempts, 1, "the attempt was counted");
      assert.match(after.reminder24hLastError, /throttled/i);
      assert.equal(after.reminder24hQueuedAt, undefined, "lock released for the retry");

      await runBookingReminderCycle();
      after = await reload(b);
      assert.equal(sent.length, 1, "the next cycle delivered it");
      assert.ok(after.reminder24hSentAt);
      assert.equal(after.reminder24hAttempts, 2);
    });

    await test("retrying stops at the ceiling and is recorded, not looped forever", async () => {
      const b = await makeBooking(20);
      failNext = REMINDER_MAX_ATTEMPTS;
      for (let i = 0; i < REMINDER_MAX_ATTEMPTS; i += 1) await runBookingReminderCycle();
      let after = await reload(b);
      assert.equal(after.reminder24hAttempts, REMINDER_MAX_ATTEMPTS);
      assert.equal(after.reminder24hSentAt, undefined);

      // The next sweep must give up visibly rather than keep hammering.
      await runBookingReminderCycle();
      after = await reload(b);
      assert.ok(after.reminder24hSkippedAt, "the give-up is recorded");
      assert.equal(after.reminder24hSkipReason, "max_attempts_exceeded");
      assert.equal(sent.length, 0);
    });

    console.log("\nAbandoning, deliberately and visibly");

    await test("confirmed 90 minutes before the visit: 24h abandoned with a reason", async () => {
      const b = await makeBooking(1.5);
      await runBookingReminderCycle();
      let after = await reload(b);
      assert.equal(after.reminder24hSentAt, undefined);
      assert.ok(after.reminder24hSkippedAt, "abandonment recorded rather than silent");
      assert.equal(after.reminder24hSkipReason, "less_than_2h_notice");

      // The 60-minute reminder is not due at 90 minutes out, and must be left
      // owed rather than abandoned alongside the 24-hour one.
      assert.equal(after.reminder60mSkippedAt, undefined, "60m must still be owed");
      assert.equal(after.reminder60mSentAt, undefined);

      // It goes out on its own schedule, once it is actually due.
      await Booking.updateOne({ _id: b._id }, { $set: { date: new Date(Date.now() + 0.5 * HOUR) } });
      await runBookingReminderCycle();
      after = await reload(b);
      assert.ok(after.reminder60mSentAt, "the useful reminder still went");
      assert.equal(sent.length, 1);
      assert.equal(sent[0].templateKey, "booking_reminder_60m");
    });

    await test("a past appointment is abandoned, not reminded", async () => {
      const b = await makeBooking(-3);
      await runBookingReminderCycle();
      assert.equal(sent.length, 0);
      const after = await reload(b);
      assert.equal(after.reminder24hSkipReason, "appointment_started");
      assert.equal(after.reminder60mSkipReason, "appointment_started");
    });

    console.log("\nBooking state");

    await test("cancelled and completed bookings are never reminded", async () => {
      await makeBooking(20, { status: "Canceled" });
      await makeBooking(20, { status: "Completed" });
      await makeBooking(0.5, { status: "Cancelled" });
      await runBookingReminderCycle();
      assert.equal(sent.length, 0);
    });

    await test("a booking cancelled between claim and send is not reminded twice", async () => {
      const b = await makeBooking(20);
      await runBookingReminderCycle();
      assert.equal(sent.length, 1);
      await Booking.updateOne({ _id: b._id }, { $set: { status: "Canceled" } });
      await runBookingReminderCycle();
      assert.equal(sent.length, 1);
    });

    console.log("\nRescheduling");

    await test("a moved appointment earns a new reminder", async () => {
      const b = await makeBooking(20);
      await runBookingReminderCycle();
      assert.equal(sent.length, 1);

      // Moved three days out with reminder state cleared, which is what the
      // reschedule paths do.
      const { clearedReminderState } = require("../utils/bookingReminderPolicy");
      await Booking.updateOne(
        { _id: b._id },
        { $set: { date: new Date(Date.now() + 92 * HOUR), ...clearedReminderState() } }
      );
      await runBookingReminderCycle();
      assert.equal(sent.length, 1, "not due yet at 92 hours out");

      await Booking.updateOne({ _id: b._id }, { $set: { date: new Date(Date.now() + 20 * HOUR) } });
      await runBookingReminderCycle();
      assert.equal(sent.length, 2, "the new appointment gets its own reminder");
    });

    await test("a booking saved without moving keeps its reminder state", async () => {
      const b = await makeBooking(20);
      await runBookingReminderCycle();
      await Booking.updateOne({ _id: b._id }, { $set: { note: "touched" } });
      await runBookingReminderCycle();
      assert.equal(sent.length, 1, "an unrelated save must not resend");
    });

    console.log("\nThe two reminders are independent");

    await test("a 24h sweep failure does not suppress the 60m sweep", async () => {
      await makeBooking(20);          // wants 24h
      const soon = await makeBooking(0.5); // wants 60m
      failNext = 1;                   // the first send, the 24h one, fails
      await runBookingReminderCycle();
      const keys = sent.map((s) => s.templateKey);
      assert.ok(
        keys.includes("booking_reminder_60m"),
        `the 60m reminder must still go out; sent ${JSON.stringify(keys)}`
      );
      assert.ok((await reload(soon)).reminder60mSentAt);
    });

    await test("one booking can receive both reminders in turn", async () => {
      const b = await makeBooking(20);
      await runBookingReminderCycle();
      await Booking.updateOne({ _id: b._id }, { $set: { date: new Date(Date.now() + 0.5 * HOUR) } });
      await runBookingReminderCycle();
      const after = await reload(b);
      assert.ok(after.reminder24hSentAt && after.reminder60mSentAt);
      assert.deepEqual(sent.map((s) => s.templateKey), [
        "booking_reminder_24h",
        "booking_reminder_60m",
      ]);
    });

    console.log("\nMany bookings, and the heartbeat");

    await test("a batch is processed per booking, not all-or-nothing", async () => {
      await Promise.all([
        makeBooking(20), makeBooking(19), makeBooking(18),
        makeBooking(30), makeBooking(1.5), makeBooking(0.5),
      ]);
      await runBookingReminderCycle();
      const k = sent.map((s) => s.templateKey);
      assert.equal(k.filter((x) => x === "booking_reminder_24h").length, 3);
      assert.equal(k.filter((x) => x === "booking_reminder_60m").length, 1);
    });

    await test("the heartbeat reports the pending backlog", async () => {
      await makeBooking(20);
      await makeBooking(0.5);
      const beat = await logReminderHeartbeat();
      assert.equal(beat.pending24h, 1);
      assert.equal(beat.pending60m, 1);
      await runBookingReminderCycle();
      const after = await logReminderHeartbeat();
      assert.equal(after.pending24h, 0, "a cleared backlog is how we know it ran");
      assert.equal(after.pending60m, 0);
    });

    console.log("\nThe SMS tag is its own channel");

    await test("a sent reminder also applies the CRM tag that triggers the SMS", async () => {
      const b = await makeBooking(20);
      await runBookingReminderCycle();
      assert.equal(sent.length, 1);
      assert.deepEqual(tags, ["reminder_24h"]);
      const after = await reload(b);
      assert.ok(after.reminder24hTagAt, "the tag is recorded in its own field");
    });

    await test("a failed tag does NOT resend the email, and retries on its own", async () => {
      const b = await makeBooking(20);
      // Enough failures to outlast the in-cycle retry, so the cycle ends with
      // the email delivered and the tag still owed.
      failTags = 99;
      await runBookingReminderCycle();
      let after = await reload(b);
      assert.equal(sent.length, 1, "the email went out");
      assert.ok(after.reminder24hSentAt, "and is recorded as sent");
      assert.equal(after.reminder24hTagAt, null, "but the tag is not");
      assert.ok(after.reminder24hTagAttempts >= 1);
      assert.match(after.reminder24hTagError, /Failed adding GHL tag/);
      failTags = 0;

      // The next cycle retries the tag alone. This is the guarantee that
      // matters: no second email lands in the customer inbox to chase a text.
      await runBookingReminderCycle();
      after = await reload(b);
      assert.equal(sent.length, 1, "STILL one email");
      assert.ok(after.reminder24hTagAt, "the tag was applied on retry");
      assert.deepEqual(tags, ["reminder_24h"]);
    });

    await test("a failed email means no tag, so no SMS without an email", async () => {
      await makeBooking(20);
      failNext = 1;
      await runBookingReminderCycle();
      assert.equal(sent.length, 0);
      assert.deepEqual(tags, [], "the SMS must not fire when the email did not");
    });

    await test("the two tags are independent", async () => {
      const b = await makeBooking(20);
      await runBookingReminderCycle();
      await Booking.updateOne({ _id: b._id }, { $set: { date: new Date(Date.now() + 0.5 * HOUR) } });
      await runBookingReminderCycle();
      const after = await reload(b);
      assert.ok(after.reminder24hTagAt && after.reminder60mTagAt);
      assert.deepEqual(tags, ["reminder_24h", "reminder_60m"]);
    });

    console.log("\nTwo workers racing the same booking");

    await test("concurrent sweeps send exactly one email and apply one tag", async () => {
      await makeBooking(20);
      // Four sweeps started together, as four EB instances would. The claim is
      // a conditional atomic update, so only one can win.
      await Promise.all([
        runBookingReminderCycle(),
        runBookingReminderCycle(),
        runBookingReminderCycle(),
        runBookingReminderCycle(),
      ]);
      assert.equal(sent.length, 1, `expected one email, got ${sent.length}`);
      assert.equal(tags.filter((t) => t === "reminder_24h").length, 1, `expected one tag, got ${tags.length}`);
    });

    await test("concurrent sweeps on many bookings never duplicate", async () => {
      await Promise.all([makeBooking(20), makeBooking(19), makeBooking(18), makeBooking(0.5)]);
      await Promise.all([runBookingReminderCycle(), runBookingReminderCycle(), runBookingReminderCycle()]);
      assert.equal(sent.length, 4, `expected 4 emails, got ${sent.length}`);
      assert.equal(tags.length, 4, `expected 4 tags, got ${tags.length}`);
    });

    await test("a crashed worker's claim is recovered, not stuck forever", async () => {
      const b = await makeBooking(20);
      // A worker claimed it and died: the lock is set and stale.
      await Booking.updateOne(
        { _id: b._id },
        { $set: { reminder24hQueuedAt: new Date(Date.now() - 20 * 60 * 1000) } }
      );
      await runBookingReminderCycle();
      assert.equal(sent.length, 1, "a stale claim is reclaimed");
      assert.ok((await reload(b)).reminder24hSentAt);
    });

    await test("a fresh claim by another worker is respected", async () => {
      const b = await makeBooking(20);
      // Another worker is mid-send right now.
      await Booking.updateOne({ _id: b._id }, { $set: { reminder24hQueuedAt: new Date() } });
      await runBookingReminderCycle();
      assert.equal(sent.length, 0, "must not send while another worker holds the claim");
    });
  } finally {
    await mongoose.disconnect();
    await server.stop();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.error(`\n${f.name}\n`, f.error);
    process.exit(1);
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
