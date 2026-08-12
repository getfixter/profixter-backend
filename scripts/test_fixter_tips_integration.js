/**
 * Fixter tips - the webhook path, against a real database.
 *
 * The unit suite proves the rules. This proves the wiring, and above all the
 * one guarantee that only a database can give:
 *
 *   one payment produces one Tip, however many times Stripe delivers the event
 *   and however many deliveries arrive at once.
 *
 * Stripe and email are replaced with fakes; MongoDB is real and in memory.
 *
 *   node scripts/test_fixter_tips_integration.js
 *
 * Not part of `npm test`: it downloads and boots a MongoDB binary, which is too
 * heavy and too network-dependent for the deploy gate. Run it locally and in
 * any pre-release check.
 */

process.env.S3_BUCKET = process.env.S3_BUCKET || "test-bucket";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-tip-tokens";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_fake_for_unit_tests";
process.env.CLIENT_URL = "https://www.profixter.com";

const assert = require("assert");
const mongoose = require("mongoose");

/* ------------------------------------------------------------------ */
/* Fakes, installed before anything under test loads them              */
/* ------------------------------------------------------------------ */

const sentEmails = [];

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

stub("../utils/subscriptionManagement", {
  stripe: {},
  hasStripeSecretKey: () => true,
  getPlanPrice: () => 0,
  retrieveStripeSubscription: async () => null,
  upsertSubscriptionFromStripe: async () => null,
  syncCustomerFromStripe: async () => null,
  handlePaymentFailure: async () => null,
});

stub("../utils/emailService", {
  ADMIN: "owner@example.com",
  FROM: "Profixter <no-reply@example.com>",
  REPLY_TO: "support@example.com",
  formatNYCTime: (value) => new Date(value).toISOString(),
  async sendTx(templateKey, to, vars) {
    sentEmails.push({ templateKey, to, vars });
    return { messageId: `fake-${sentEmails.length}` };
  },
  async sendRaw({ to, subject }) {
    sentEmails.push({ templateKey: "raw", to, vars: { subject } });
    return { messageId: `fake-${sentEmails.length}` };
  },
  TEMPLATES: {},
});

const { MongoMemoryServer } = require("mongodb-memory-server");

const User = require("../models/User");
const Booking = require("../models/Booking");
const Tip = require("../models/Tip");
const webhook = require("../routes/webhook");
const tipRoutes = require("../routes/tips");
const { summarizeTips, netCents } = require("../utils/fixterTips");
const { createFixterChoiceToken, createTipToken } = require("../utils/tipToken");

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

const $ = (dollars) => Math.round(dollars * 100);
let sequence = 0;

async function makeFixter(over = {}) {
  sequence += 1;
  return User.create({
    userId: `emp${sequence}${Date.now() % 100000}`,
    name: "Roman Petrov",
    email: `roman${sequence}@profixter.test`,
    role: "employee",
    employeePosition: "Fixter",
    isActive: true,
    ...over,
  });
}

async function makeCustomer() {
  sequence += 1;
  return User.create({
    userId: `cus${sequence}${Date.now() % 100000}`,
    name: "Dana Whitfield",
    email: `dana${sequence}@example.test`,
    role: "customer",
  });
}

async function makeBooking(customer) {
  sequence += 1;
  return Booking.create({
    bookingNumber: `102${sequence}`,
    date: new Date("2026-08-11T14:00:00Z"),
    service: "Membership visit",
    user: customer._id,
    userId: customer.userId,
    name: customer.name,
    address: "1 Test Street",
    phone: "+15550001111",
    email: customer.email,
    subscription: "basic",
    status: "Completed",
  });
}

function tipSession({ fixterId, bookingId, userId, paymentIntent, amount = $(20) }) {
  return {
    id: `cs_${paymentIntent}`,
    mode: "payment",
    payment_status: "paid",
    amount_total: amount,
    currency: "usd",
    payment_intent: paymentIntent,
    customer_details: { name: "Card Holder", email: "cardholder@example.test" },
    metadata: {
      productKind: "fixter_tip",
      fixterId: String(fixterId || ""),
      bookingId: String(bookingId || ""),
      userId: String(userId || ""),
      source: "completion_email",
    },
  };
}

async function main() {
  const server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
  // The unique index is the guarantee under test. Build it before racing it.
  await Tip.init();

  try {
    console.log("\nRecording a tip");

    const fixter = await makeFixter();
    const customer = await makeCustomer();
    const booking = await makeBooking(customer);

    await test("a paid session becomes one Tip credited to the Fixter", async () => {
      sentEmails.length = 0;
      const result = await webhook.handleFixterTipCheckoutCompleted(
        tipSession({
          fixterId: fixter._id,
          bookingId: booking._id,
          userId: customer._id,
          paymentIntent: "pi_int_1",
        }),
        "evt_1"
      );
      assert.ok(result?.tipId);
      const tip = await Tip.findById(result.tipId).lean();
      assert.strictEqual(String(tip.fixter), String(fixter._id));
      assert.strictEqual(tip.amountCents, $(20));
      assert.strictEqual(tip.assignmentStatus, "attributed");
      assert.strictEqual(tip.status, "succeeded");
      assert.strictEqual(String(tip.booking), String(booking._id));
      assert.strictEqual(tip.tipperEmail, customer.email.toLowerCase());
    });

    await test("the Fixter is told, at their own account email", async () => {
      const notice = sentEmails.find((mail) => mail.templateKey === "fixter_tip_received");
      assert.ok(notice, "the Fixter was never told about the tip");
      assert.strictEqual(notice.to, fixter.email);
      assert.match(notice.vars.amount, /\$20\.00/);
    });

    await test("a redelivered event does not record a second tip", async () => {
      const again = await webhook.handleFixterTipCheckoutCompleted(
        tipSession({
          fixterId: fixter._id,
          bookingId: booking._id,
          userId: customer._id,
          paymentIntent: "pi_int_1",
        }),
        "evt_1_retry"
      );
      assert.strictEqual(again.duplicate, true);
      assert.strictEqual(await Tip.countDocuments({ stripePaymentIntentId: "pi_int_1" }), 1);
    });

    await test("two deliveries arriving at once still record one tip", async () => {
      const session = tipSession({
        fixterId: fixter._id,
        bookingId: booking._id,
        userId: customer._id,
        paymentIntent: "pi_int_race",
      });
      await Promise.all([
        webhook.handleFixterTipCheckoutCompleted(session, "evt_race_a"),
        webhook.handleFixterTipCheckoutCompleted(session, "evt_race_b"),
      ]);
      assert.strictEqual(
        await Tip.countDocuments({ stripePaymentIntentId: "pi_int_race" }),
        1,
        "a concurrent redelivery created a second tip"
      );
    });

    await test("a session with no PaymentIntent records nothing at all", async () => {
      const before = await Tip.countDocuments();
      const result = await webhook.handleFixterTipCheckoutCompleted(
        { ...tipSession({ fixterId: fixter._id, paymentIntent: "pi_x" }), payment_intent: null },
        "evt_no_pi"
      );
      assert.strictEqual(result, null);
      assert.strictEqual(await Tip.countDocuments(), before);
    });

    await test("an unpaid session records nothing", async () => {
      const before = await Tip.countDocuments();
      const result = await webhook.handleFixterTipCheckoutCompleted(
        {
          ...tipSession({ fixterId: fixter._id, paymentIntent: "pi_unpaid" }),
          payment_status: "unpaid",
        },
        "evt_unpaid"
      );
      assert.strictEqual(result, null);
      assert.strictEqual(await Tip.countDocuments(), before);
    });

    console.log("\nWhen attribution cannot be trusted");

    await test("a Fixter who stopped being one between checkout and payment is not credited", async () => {
      const leaver = await makeFixter({ name: "Ex Fixter" });
      const session = tipSession({ fixterId: leaver._id, paymentIntent: "pi_int_leaver" });

      // The employee is demoted after the session was created, exactly as a
      // real edit between checkout and webhook would look.
      await User.updateOne(
        { _id: leaver._id },
        { $set: { role: "customer", employeePosition: null } }
      );

      const result = await webhook.handleFixterTipCheckoutCompleted(session, "evt_leaver");
      const tip = await Tip.findById(result.tipId).lean();
      assert.strictEqual(tip.fixter, null, "a non-employee was credited");
      assert.strictEqual(tip.assignmentStatus, "unassigned");
      assert.ok(tip.unassignedReason);
    });

    await test("a tip with no context at all is recorded, unassigned", async () => {
      sentEmails.length = 0;
      const result = await webhook.handleFixterTipCheckoutCompleted(
        {
          id: "cs_bare",
          mode: "payment",
          payment_status: "paid",
          amount_total: $(15),
          currency: "usd",
          payment_intent: "pi_int_bare",
          customer_details: { name: "", email: "" },
          metadata: { productKind: "fixter_tip" },
        },
        "evt_bare"
      );
      const tip = await Tip.findById(result.tipId).lean();
      assert.strictEqual(tip.amountCents, $(15), "money was refused rather than recorded");
      assert.strictEqual(tip.assignmentStatus, "unassigned");
      assert.strictEqual(tip.tipperKind, "unknown");
      assert.strictEqual(
        sentEmails.filter((mail) => mail.templateKey === "fixter_tip_received").length,
        0,
        "someone was told about a tip that is not theirs"
      );
    });

    await test("an unattributed tip still remembers the visit, so it can be placed", async () => {
      const stranger = await makeFixter({ name: "Not An Employee", role: "customer", employeePosition: null });
      const result = await webhook.handleFixterTipCheckoutCompleted(
        tipSession({
          fixterId: stranger._id,
          bookingId: booking._id,
          userId: customer._id,
          paymentIntent: "pi_int_evidence",
        }),
        "evt_evidence"
      );
      const tip = await Tip.findById(result.tipId).lean();
      assert.strictEqual(tip.fixter, null);
      assert.strictEqual(String(tip.booking), String(booking._id));
      assert.strictEqual(tip.bookingNumberSnapshot, booking.bookingNumber);
    });

    console.log("\nRefunds");

    await test("a refund reduces the tip without deleting the record", async () => {
      const result = await webhook.handleTipChargeRefunded({
        payment_intent: "pi_int_1",
        amount_refunded: $(5),
      });
      assert.strictEqual(result.changed, true);
      const tip = await Tip.findOne({ stripePaymentIntentId: "pi_int_1" }).lean();
      assert.strictEqual(tip.refundedCents, $(5));
      assert.strictEqual(tip.status, "partially_refunded");
      assert.strictEqual(tip.amountCents, $(20), "the original amount was overwritten");
      assert.strictEqual(netCents(tip), $(15));
    });

    await test("a redelivered refund event changes nothing", async () => {
      const again = await webhook.handleTipChargeRefunded({
        payment_intent: "pi_int_1",
        amount_refunded: $(5),
      });
      assert.strictEqual(again.changed, false);
      const tip = await Tip.findOne({ stripePaymentIntentId: "pi_int_1" }).lean();
      assert.strictEqual(tip.refundedCents, $(5));
    });

    await test("a refund for anything that is not a tip is ignored entirely", async () => {
      // charge.refunded fires for memberships, one-time visits and project
      // invoices too. Nothing in this collection matches, so nothing happens.
      const before = await Tip.countDocuments();
      assert.strictEqual(
        await webhook.handleTipChargeRefunded({
          payment_intent: "pi_membership_refund",
          amount_refunded: $(99),
        }),
        null
      );
      assert.strictEqual(
        await webhook.handleTipChargeRefunded({ amount_refunded: $(99) }),
        null
      );
      assert.strictEqual(await Tip.countDocuments(), before);
    });

    console.log("\nThe public chooser, against real records");

    const chooserOnly = await makeFixter({ name: "Nina Alvarez", firstName: "Nina" });
    const generalFixter = await makeFixter({
      name: "Sam Okafor",
      firstName: "Sam",
      employeePosition: "General Fixter",
    });
    const deactivated = await makeFixter({
      name: "Gone Away",
      firstName: "Gone",
      isActive: false,
    });
    const officeStaff = await makeFixter({
      name: "Office Person",
      firstName: "Office",
      employeePosition: null,
    });

    await test("the chooser offers active tippable Fixters and nobody else", async () => {
      const list = await tipRoutes.loadSelectableFixters();
      const names = list.map((row) => row.firstName);
      assert.ok(names.includes("Nina"), "an active Fixter was missing from the chooser");
      assert.ok(names.includes("Sam"), "an active General Fixter was missing from the chooser");
      assert.ok(!names.includes("Gone"), "a deactivated employee was offered to customers");
      assert.ok(!names.includes("Office"), "an employee with no tippable position was offered");
    });

    await test("the chooser payload carries no private employee data", async () => {
      const list = await tipRoutes.loadSelectableFixters();
      const serialized = JSON.stringify(list);
      for (const row of list) {
        assert.deepStrictEqual(Object.keys(row).sort(), ["choice", "firstName"]);
      }
      for (const secret of [
        String(chooserOnly._id),
        chooserOnly.email,
        chooserOnly.userId,
        "Alvarez",
        "employee",
        "General Fixter",
        "isActive",
      ]) {
        assert.ok(!serialized.includes(secret), `private employee data leaked: ${secret}`);
      }
    });

    await test("a chosen Fixter is revalidated against the database, not trusted", async () => {
      const resolved = await tipRoutes.resolveChoice(createFixterChoiceToken(chooserOnly._id));
      assert.ok(resolved.fixter, "a legitimate choice was refused");
      assert.strictEqual(String(resolved.fixter._id), String(chooserOnly._id));
    });

    await test("a choice naming a deactivated Fixter is refused", async () => {
      const resolved = await tipRoutes.resolveChoice(createFixterChoiceToken(deactivated._id));
      assert.strictEqual(resolved.fixter, null, "a deactivated employee could still be tipped");
      assert.strictEqual(resolved.reason, "fixter_not_selectable");
    });

    await test("a choice naming a non-tippable employee is refused", async () => {
      const resolved = await tipRoutes.resolveChoice(createFixterChoiceToken(officeStaff._id));
      assert.strictEqual(resolved.fixter, null);
    });

    await test("a Fixter deactivated after the page rendered can no longer be chosen", async () => {
      // The window between rendering the chooser and pressing Continue is real.
      const leaving = await makeFixter({ name: "Just Left", firstName: "Just" });
      const choice = createFixterChoiceToken(leaving._id);
      assert.ok((await tipRoutes.resolveChoice(choice)).fixter, "setup failed");

      await User.updateOne({ _id: leaving._id }, { $set: { isActive: false } });
      const after = await tipRoutes.resolveChoice(choice);
      assert.strictEqual(after.fixter, null, "a stale choice outlived the employee record");
    });

    await test("a forged choice cannot attribute a tip", async () => {
      const forged = Buffer.concat([
        Buffer.alloc(12),
        Buffer.alloc(16),
        Buffer.from(JSON.stringify({ v: 1, k: "c", f: String(chooserOnly._id), exp: Date.now() + 10000 })),
      ]).toString("base64url");
      const resolved = await tipRoutes.resolveChoice(forged);
      assert.strictEqual(resolved.fixter, null, "a forged handle named a real Fixter");
      assert.strictEqual(resolved.reason, "unreadable_choice");
    });

    await test("a raw database id is not a usable choice", async () => {
      // The browser never sees an id, and sending one anyway must achieve nothing.
      const resolved = await tipRoutes.resolveChoice(String(chooserOnly._id));
      assert.strictEqual(resolved.fixter, null, "a raw Fixter id was accepted from the browser");
    });

    await test("a completion token cannot be spent as a choice", async () => {
      const booking = createTipToken({ fixterId: String(chooserOnly._id), bookingId: "", userId: "" });
      const resolved = await tipRoutes.resolveChoice(booking);
      assert.strictEqual(resolved.fixter, null);
    });

    await test("two different choices resolve to two different Fixters", async () => {
      const one = await tipRoutes.resolveChoice(createFixterChoiceToken(chooserOnly._id));
      const two = await tipRoutes.resolveChoice(createFixterChoiceToken(generalFixter._id));
      assert.strictEqual(String(one.fixter._id), String(chooserOnly._id));
      assert.strictEqual(String(two.fixter._id), String(generalFixter._id));
      assert.notStrictEqual(String(one.fixter._id), String(two.fixter._id));
    });

    console.log("\nThe tokenized completion link still skips the chooser");

    await test("a valid completion token still resolves its Fixter directly", async () => {
      const worker = await makeFixter({ name: "Token Worker", firstName: "Token" });
      const cust = await makeCustomer();
      const bk = await makeBooking(cust);
      await Booking.updateOne({ _id: bk._id }, { $set: { assignedFixterId: worker._id } });

      const token = createTipToken({
        bookingId: String(bk._id),
        fixterId: String(worker._id),
        userId: String(cust._id),
      });
      const context = await tipRoutes.resolveTipContext(token);
      assert.ok(context.fixter, "a valid completion link stopped attributing");
      assert.strictEqual(String(context.fixter._id), String(worker._id));
      assert.strictEqual(String(context.booking._id), String(bk._id));
    });

    await test("an invalid or tampered token yields no attribution, so the page can offer the chooser", async () => {
      for (const bad of ["", "not-a-token", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"]) {
        const context = await tipRoutes.resolveTipContext(bad);
        assert.strictEqual(context.fixter, null, `"${bad}" produced an attribution`);
      }
      const list = await tipRoutes.loadSelectableFixters();
      assert.ok(list.length > 0, "there would be nothing to fall back to");
    });

    console.log("\nTotals over real records");

    await test("the ledger totals what was retained, not what was collected", async () => {
      const all = await Tip.find({}).lean();
      const summary = summarizeTips(all, { now: new Date("2026-08-12T16:00:00Z") });
      const collected = all.reduce((sum, tip) => sum + tip.amountCents, 0);
      const retained = all.reduce((sum, tip) => sum + netCents(tip), 0);
      assert.ok(retained < collected, "the fixture has no refund to prove anything with");
      assert.strictEqual(summary.totals.allTimeCents, retained);
    });

    await test("unassigned money is never credited to a Fixter", async () => {
      const all = await Tip.find({}).lean();
      const summary = summarizeTips(all, { now: new Date("2026-08-12T16:00:00Z") });
      const credited = summary.fixters.reduce((sum, row) => sum + row.allTimeCents, 0);
      assert.ok(summary.unassigned.allTimeCents > 0, "the fixture has nothing unassigned");
      assert.strictEqual(
        credited + summary.unassigned.allTimeCents,
        summary.totals.allTimeCents
      );
    });
  } finally {
    await mongoose.disconnect();
    await server.stop();
  }

  console.log(`\n${passed} passed, ${failures.length} failed.`);
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
