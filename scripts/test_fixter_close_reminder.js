/**
 * The close-the-job nudge, against a real database.
 *
 * The thing being proved is mostly negative. This reminder exists to email one
 * colleague once, and almost every test here is about what it must NOT do:
 * not the customer, not twice, not to a finished job, not to a cancelled one,
 * not through the CRM, and never by editing the booking's status to make the
 * problem go away.
 *
 *   node scripts/test_fixter_close_reminder.js
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
  async sendTx(templateKey, to, vars, opts = {}) {
    if (failNext > 0) {
      failNext -= 1;
      throw new Error("SES throttled");
    }
    sent.push({ templateKey, to, vars, opts });
    /* Mirror nodemailer: a caller-supplied Message-ID is the one that is used. */
    return { messageId: opts.messageId || `msg-${sent.length}` };
  },
});

/*
 * The CRM is stubbed so that any tag this sweep tried to apply would be
 * recorded and fail the test, rather than quietly reaching a real account.
 */
const tags = [];
stub("../utils/ghlContact", {
  createOrUpdateContact: async () => "contact-1",
  updateContactFields: async () => true,
  addTag: async (_contactId, tag) => {
    tags.push(tag);
    return true;
  },
  formatBookingDateTime: () => "pretty",
});

const Booking = require("../models/Booking");
const User = require("../models/User");
const SmsMessage = require("../models/SmsMessage");
const {
  processFixterCloseReminder,
  runBookingReminderCycle,
} = require("../jobs/bookingReminders");
const {
  REMINDER_MAX_ATTEMPTS,
  clearedReminderState,
} = require("../utils/bookingReminderPolicy");

const HOUR = 3600000;
const CLOSE_TEMPLATE = "fixter_close_booking_reminder";

let passed = 0;
const failures = [];
let fixter;

async function test(name, fn) {
  sent.length = 0;
  tags.length = 0;
  failNext = 0;
  await Booking.deleteMany({});
  await SmsMessage.deleteMany({});
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
async function makeBooking(hoursAgo, overrides = {}) {
  seq += 1;
  return Booking.create({
    bookingNumber: String(30000000 + seq),
    date: new Date(Date.now() - hoursAgo * HOUR),
    service: "Labor Only",
    subscription: "Plus",
    user: new mongoose.Types.ObjectId(),
    userId: String(40000000 + seq),
    name: "Test Customer",
    phone: "+15550001111",
    email: `customer${seq}@example.com`,
    address: "1 Test Street",
    city: "Babylon",
    state: "NY",
    zip: "11702",
    status: "Confirmed",
    assignedFixterId: fixter._id,
    assignedFixterName: fixter.name,
    assignedFixterEmail: fixter.email,
    assignedFixterPosition: "Fixter",
    ...overrides,
  });
}

const reload = (b) => Booking.findById(b._id).lean();
const sweep = (now = new Date()) =>
  processFixterCloseReminder(now, {
    scanned: 0, claimed: 0, notDue: 0, locked: 0, sent: 0, failed: 0, abandoned: 0,
  });

/** Every assertion this feature's blast radius depends on. */
function assertNothingElseHappened(before) {
  assert.equal(tags.length, 0, "must never touch the CRM");
  for (const row of sent) {
    assert.equal(row.templateKey, CLOSE_TEMPLATE, `unexpected email: ${row.templateKey}`);
    assert.equal(row.to, fixter.email, `email went to ${row.to}, not the Fixter`);
  }
  if (before) {
    assert.equal(before.status, "Confirmed", "status must not be rewritten");
  }
}

async function run() {
  const server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri(), { dbName: "fixterclose" });
  await Booking.init();

  fixter = await User.create({
    userId: "90000001",
    name: "Roman Hecha",
    email: "roman@profixter.com",
    password: "x",
    phone: "+15550002222",
    role: "employee",
    employeePosition: "Fixter",
    isActive: true,
    address: "2 Depot Rd",
    city: "Babylon",
    state: "NY",
    zip: "11702",
  });

  try {
    console.log("\n--- the send ---");

    await test("1. Confirmed, +2h, assigned Fixter -> sends once", async () => {
      const b = await makeBooking(3);
      await sweep();
      assert.equal(sent.length, 1, "expected exactly one email");
      assert.equal(sent[0].templateKey, CLOSE_TEMPLATE);
      assert.equal(sent[0].to, fixter.email);
      assert.equal(sent[0].vars.customerName, "Test Customer");
      assert.equal(sent[0].vars.fixterName, "Roman Hecha");

      const after = await reload(b);
      assert.ok(after.fixterCloseReminderSentAt, "sentAt must be recorded");
      assert.equal(
        after.fixterCloseReminderMessageId,
        sent[0].opts.messageId,
        "the recorded id must be the one the provider was given"
      );
      assert.equal(after.fixterCloseReminderQueuedAt, undefined, "lock must be released");
      assert.equal(after.status, "Confirmed", "status must not change");
      assertNothingElseHappened(after);
    });

    await test("2. rerunning the scheduler does NOT send again", async () => {
      const b = await makeBooking(3);
      await sweep();
      await sweep();
      await sweep();
      await runBookingReminderCycle();
      assert.equal(sent.length, 1, `expected 1 email, got ${sent.length}`);
      assertNothingElseHappened(await reload(b));
    });

    console.log("\n--- the refusals ---");

    await test("3. Completed before +2h -> no send", async () => {
      await makeBooking(3, { status: "Completed", completedAt: new Date() });
      await sweep();
      assert.equal(sent.length, 0);
    });

    await test("3b. Completed spelled 'Done' -> no send", async () => {
      await makeBooking(3, { status: "Done" });
      await sweep();
      assert.equal(sent.length, 0);
    });

    await test("4. Canceled -> no send", async () => {
      await makeBooking(3, { status: "Canceled" });
      await sweep();
      assert.equal(sent.length, 0);
    });

    await test("4b. Pending (never confirmed) -> no send", async () => {
      await makeBooking(3, { status: "Pending" });
      await sweep();
      assert.equal(sent.length, 0);
    });

    await test("5. Confirmed but no assigned Fixter -> no send", async () => {
      const b = await makeBooking(3, {
        assignedFixterId: null,
        assignedFixterName: "",
        assignedFixterEmail: "",
      });
      await sweep();
      assert.equal(sent.length, 0);
      const after = await reload(b);
      assert.ok(!after.fixterCloseReminderSkippedAt, "stays pending: it can still be assigned");
    });

    await test("6. assigned Fixter has no usable email -> no send", async () => {
      /*
       * The employee model requires an email, so the realistic shape of this is
       * not a blank field on a live record - it is a booking still pointing at
       * an employee record that is no longer there, with nothing denormalised
       * on the booking to fall back to.
       */
      await makeBooking(3, {
        assignedFixterId: new mongoose.Types.ObjectId(),
        assignedFixterName: "Departed Fixter",
        assignedFixterEmail: "",
      });
      await sweep();
      assert.equal(sent.length, 0);
    });

    await test("6a. an employee row with an unusable email -> no send", async () => {
      /* Inserted under the model to reproduce legacy data the schema now forbids. */
      const legacyId = new mongoose.Types.ObjectId();
      await User.collection.insertOne({
        _id: legacyId, userId: "90000003", name: "Legacy Fixter", email: "   ",
        role: "employee", employeePosition: "Fixter", isActive: true,
      });
      await makeBooking(3, {
        assignedFixterId: legacyId,
        assignedFixterName: "Legacy Fixter",
        assignedFixterEmail: "",
      });
      await sweep();
      assert.equal(sent.length, 0);
    });

    await test("6b. malformed stored email -> no send", async () => {
      await makeBooking(3, { assignedFixterEmail: "not-an-address" });
      /*
       * The fallback finds the real employee record, so this one legitimately
       * sends - to the address on the employee, never to the broken string.
       */
      await sweep();
      assert.equal(sent.length, 1);
      assert.equal(sent[0].to, fixter.email);
    });

    await test("7. booking not yet +2h -> no send", async () => {
      const b = await makeBooking(1.5);
      await sweep();
      assert.equal(sent.length, 0, "1h30m after start is not due yet");
      const after = await reload(b);
      assert.ok(!after.fixterCloseReminderSkippedAt, "not-due must not be terminal");
      assert.equal(Number(after.fixterCloseReminderAttempts || 0), 0, "must not burn an attempt");
    });

    await test("7b. a future booking is never selected", async () => {
      await makeBooking(-5);
      await sweep();
      assert.equal(sent.length, 0);
    });

    console.log("\n--- concurrency and recovery ---");

    await test("8. overlapping workers still send exactly one", async () => {
      const b = await makeBooking(3);
      await Promise.all([sweep(), sweep(), sweep(), sweep()]);
      assert.equal(sent.length, 1, `expected 1 email, got ${sent.length}`);
      assertNothingElseHappened(await reload(b));
    });

    await test("8b. overlapping workers over many bookings never duplicate", async () => {
      for (let i = 0; i < 6; i += 1) await makeBooking(3 + i * 0.1);
      await Promise.all([sweep(), sweep(), sweep()]);
      assert.equal(sent.length, 6, `expected 6 emails, got ${sent.length}`);
      const addresses = sent.map((s) => s.to);
      assert.equal(new Set(sent.map((s) => s.vars.bookingNumber)).size, 6, "one per booking");
      assert.ok(addresses.every((a) => a === fixter.email));
    });

    await test("a send that fails is retried, not consumed", async () => {
      const b = await makeBooking(3);
      failNext = 1;
      await sweep();
      assert.equal(sent.length, 0);
      let after = await reload(b);
      assert.ok(!after.fixterCloseReminderSentAt, "must not record a send that failed");
      assert.equal(after.fixterCloseReminderQueuedAt, undefined, "lock released for the retry");
      assert.match(after.fixterCloseReminderLastError, /throttled/);

      await sweep();
      assert.equal(sent.length, 1, "the next cycle sends it");
      after = await reload(b);
      assert.ok(after.fixterCloseReminderSentAt);
    });

    await test("a permanently failing address stops after the attempt ceiling", async () => {
      const b = await makeBooking(3, {
        fixterCloseReminderAttempts: REMINDER_MAX_ATTEMPTS,
      });
      await sweep();
      assert.equal(sent.length, 0);
      const after = await reload(b);
      assert.ok(after.fixterCloseReminderSkippedAt, "must be settled, not retried forever");
      assert.equal(after.fixterCloseReminderSkipReason, "max_attempts_exceeded");
    });

    await test("a crashed worker's claim is recovered after it goes stale", async () => {
      const b = await makeBooking(3);
      await Booking.updateOne(
        { _id: b._id },
        { $set: { fixterCloseReminderQueuedAt: new Date(Date.now() - 30 * 60 * 1000) } }
      );
      await sweep();
      assert.equal(sent.length, 1, "a stale lock must be reclaimable");
    });

    await test("a fresh claim by another worker is respected", async () => {
      const b = await makeBooking(3);
      await Booking.updateOne(
        { _id: b._id },
        { $set: { fixterCloseReminderQueuedAt: new Date() } }
      );
      await sweep();
      assert.equal(sent.length, 0, "must not send while another worker holds the claim");
    });

    await test("a booking nobody ever closed is eventually settled with a reason", async () => {
      const b = await makeBooking(30);
      await sweep();
      assert.equal(sent.length, 0, "too late to be useful");
      const after = await reload(b);
      assert.equal(after.fixterCloseReminderSkipReason, "too_late_to_nudge");
    });

    await test("rescheduling clears the nudge so the new date gets its own", async () => {
      const b = await makeBooking(3);
      await sweep();
      assert.equal(sent.length, 1);

      await Booking.updateOne(
        { _id: b._id },
        { $set: { date: new Date(Date.now() - 3 * HOUR + 60000), ...clearedReminderState() } }
      );
      await sweep();
      assert.equal(sent.length, 2, "the moved appointment gets its own nudge");
    });

    console.log("\n--- the crash-after-send window ---");

    await test("the Message-ID is deterministic for the same visit", async () => {
      const b = await makeBooking(3);
      await sweep();
      assert.equal(sent.length, 1);
      const key = sent[0].opts.messageId;
      assert.match(key, /^<fixter-close-reminder\./, `unexpected key: ${key}`);
      assert.ok(key.includes(String(b._id)), "key must name the booking");
      assert.ok(
        key.includes(String(new Date(b.date).getTime())),
        "key must name the appointment instant"
      );
      assert.equal(
        sent[0].opts.headers["X-Entity-Ref-ID"],
        key,
        "the reference header must carry the same key"
      );
    });

    await test("a rescheduled visit gets a different Message-ID", async () => {
      const b = await makeBooking(3);
      await sweep();
      const first = sent[0].opts.messageId;

      await Booking.updateOne(
        { _id: b._id },
        { $set: { date: new Date(Date.now() - 4 * HOUR), ...clearedReminderState() } }
      );
      await sweep();
      assert.equal(sent.length, 2);
      assert.notEqual(sent[1].opts.messageId, first, "a moved visit is a different message");
    });

    await test("CRASH AFTER SEND: the second copy is identical, not a new message", async () => {
      /*
       * Exactly the state a crash between the provider accepting and the booking
       * update would leave behind: the lock still held, sentAt never written.
       * Ten minutes later that lock is stale and reclaimable.
       *
       * This test asserts what actually happens rather than what we would like
       * to happen. A second copy IS sent - there is no idempotent send on SES
       * SMTP to prevent it - and the assertion worth making is that it carries
       * the same Message-ID, which is what lets a receiving server collapse it
       * and what makes it provably the same nudge afterwards.
       */
      const b = await makeBooking(3);
      await sweep();
      assert.equal(sent.length, 1, "first send");
      const firstKey = sent[0].opts.messageId;

      await Booking.updateOne(
        { _id: b._id },
        {
          $set: { fixterCloseReminderQueuedAt: new Date(Date.now() - 30 * 60 * 1000) },
          $unset: { fixterCloseReminderSentAt: 1, fixterCloseReminderMessageId: 1 },
        }
      );

      await sweep();
      assert.equal(sent.length, 2, "the window is real: a second copy goes out");
      assert.equal(
        sent[1].opts.messageId,
        firstKey,
        "but it is the same message, not a new one"
      );

      const after = await reload(b);
      assert.ok(after.fixterCloseReminderSentAt, "and it settles afterwards");
      assert.equal(after.fixterCloseReminderMessageId, firstKey);
    });

    await test("no crash: the claim alone stops a rerun before it reaches the provider", async () => {
      const b = await makeBooking(3);
      await sweep();
      await sweep();
      await sweep();
      assert.equal(sent.length, 1, "the recorded send is what stops the rerun");
      assert.ok((await reload(b)).fixterCloseReminderSentAt);
    });

    console.log("\n--- blast radius ---");

    await test("no customer email, no SMS, no CRM tag, no status write", async () => {
      const b = await makeBooking(3);
      const before = await reload(b);
      await runBookingReminderCycle();

      assert.equal(sent.length, 1, "exactly one email");
      assert.equal(sent[0].to, fixter.email, "and it went to the Fixter");
      assert.notEqual(sent[0].to, before.email, "never to the customer");
      assert.equal(tags.length, 0, "no CRM tag, therefore no SMS trigger");
      assert.equal(await SmsMessage.countDocuments({}), 0, "no SMS row written");

      const after = await reload(b);
      assert.equal(after.status, "Confirmed", "status must not be changed by a reminder");
      assert.equal(
        (after.statusHistory || []).length,
        (before.statusHistory || []).length,
        "status history must not grow"
      );
      assert.deepEqual(
        { c: after.completedAt, r: after.reviewRequestSentAt },
        { c: before.completedAt, r: before.reviewRequestSentAt },
        "completion and review state must be untouched"
      );
      assert.equal(
        after.reminder24hSentAt,
        before.reminder24hSentAt,
        "the 24h reminder must be untouched"
      );
      assert.equal(
        after.reminder60mSentAt,
        before.reminder60mSentAt,
        "the 60m reminder must be untouched"
      );
    });

    await test("the customer reminders still work alongside it", async () => {
      /* Tomorrow's booking: the 24h reminder is due, the close nudge is not. */
      await makeBooking(-23);
      await runBookingReminderCycle();
      const kinds = sent.map((s) => s.templateKey);
      assert.ok(kinds.includes("booking_reminder_24h"), `expected a 24h reminder, got ${kinds}`);
      assert.ok(!kinds.includes(CLOSE_TEMPLATE), "the close nudge is not due for a future booking");
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
