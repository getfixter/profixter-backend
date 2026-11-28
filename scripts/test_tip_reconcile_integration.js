/**
 * Missing tips (2026-11-25): the old static Stripe tip link, reconciliation and
 * repair, against a real database.
 *
 * Gwen paid a $50 tip through "Leave a tip" in My Visits, which still pointed
 * at the old static Stripe Payment Link. Stripe delivered the event; the
 * webhook ignored it because only our own tip checkout was recognised. No Tip
 * was written, so the Tips view never showed it.
 *
 * This suite reproduces that case through the real webhook entry point and
 * proves: the tip is now recorded with its payment time and verified
 * attribution; retries, races, the hourly job and repeated repairs never make
 * a second Tip; the dry run writes nothing; a repair writes exactly what the
 * dry run showed and emails nobody; nothing is ever written to Stripe; and My
 * Visits now hands out the attributed Profixter link.
 *
 *   node scripts/test_tip_reconcile_integration.js
 *
 * Boots an in-memory MongoDB binary, so like the other *_integration suites it
 * is not in the CI gate (scripts/run_ci_tests.js); run it before a release.
 */

process.env.S3_BUCKET = process.env.S3_BUCKET || "test-bucket";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-tip-tokens";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_fake_for_unit_tests";
process.env.CLIENT_URL = "https://www.profixter.com";
process.env.TIP_PAGE_URL = "https://www.profixter.com/tip";
delete process.env.STRIPE_LEGACY_TIP_PAYMENT_LINKS;

const assert = require("assert");
const mongoose = require("mongoose");

/* ------------------------------------------------------------------ */
/* Fakes                                                               */
/* ------------------------------------------------------------------ */

const sentEmails = [];
const stripeWrites = [];
const stripeState = { sessions: [], intents: new Map() };

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

/** Reads behave like stripe-node (auto-paginating lists); every write throws and is recorded. */
function refuse(name) {
  return async () => {
    stripeWrites.push(name);
    throw new Error(`Stripe write attempted in a read-only path: ${name}`);
  };
}

const fakeStripe = {
  checkout: {
    sessions: {
      list(params = {}) {
        const gte = params.created?.gte ?? -Infinity;
        const lte = params.created?.lte ?? Infinity;
        const rows = stripeState.sessions.filter(
          (s) => s.created >= gte && s.created <= lte && (!params.status || s.status === params.status)
        );
        return {
          async *[Symbol.asyncIterator]() {
            for (const row of rows) yield JSON.parse(JSON.stringify(row));
          },
        };
      },
      create: refuse("checkout.sessions.create"),
      expire: refuse("checkout.sessions.expire"),
    },
  },
  paymentIntents: {
    async retrieve(id) {
      const pi = stripeState.intents.get(id);
      if (!pi) throw new Error(`No such payment_intent: ${id}`);
      return JSON.parse(JSON.stringify(pi));
    },
    update: refuse("paymentIntents.update"),
    cancel: refuse("paymentIntents.cancel"),
    create: refuse("paymentIntents.create"),
  },
  refunds: { create: refuse("refunds.create") },
  charges: { create: refuse("charges.create") },
  transfers: { create: refuse("transfers.create") },
  payouts: { create: refuse("payouts.create") },
};

stub("../utils/subscriptionManagement", {
  stripe: fakeStripe,
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
  async sendRaw({ to, subject, logContext }) {
    sentEmails.push({ templateKey: logContext?.templateKey || "raw", to, vars: { subject } });
    return { messageId: `fake-${sentEmails.length}` };
  },
  TEMPLATES: {},
});

const { MongoMemoryServer } = require("mongodb-memory-server");

const User = require("../models/User");
const Booking = require("../models/Booking");
const Tip = require("../models/Tip");
const webhook = require("../routes/webhook");
const { reconcileTips, summarize } = require("../utils/tipReconcile");
const { DEFAULT_LEGACY_TIP_PAYMENT_LINK_IDS } = require("../utils/fixterTips");
const { readTipToken } = require("../utils/tipToken");

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

const LEGACY_LINK = DEFAULT_LEGACY_TIP_PAYMENT_LINK_IDS[0];
const sec = (iso) => Math.floor(new Date(iso).getTime() / 1000);
let seq = 0;

async function makeUser(over) {
  seq += 1;
  return User.create({ userId: `u${seq}${Date.now() % 100000}`, phone: `+1555000${String(seq).padStart(4, "0")}`, ...over });
}

async function makeVisit(customer, fixter, completedAt, over = {}) {
  seq += 1;
  return Booking.create({
    bookingNumber: `9${String(seq).padStart(7, "0")}`,
    date: new Date(completedAt),
    service: "Membership visit",
    user: customer._id,
    userId: customer.userId,
    name: customer.name,
    address: "1 Test Street",
    phone: "+15550001111",
    email: customer.email,
    subscription: "basic",
    status: "Completed",
    completedAt: new Date(completedAt),
    assignedFixterId: fixter ? fixter._id : null,
    assignedFixterName: fixter ? fixter.name : "",
    ...over,
  });
}

/** A paid session exactly as the old static tip link produces it: no metadata, a payment_link, a comment field. */
function legacyStripeTip({ pi, email, name, paidAtIso, amount, refunded = 0, disputed = false, link = LEGACY_LINK }) {
  const session = {
    id: `cs_live_${pi}`,
    object: "checkout.session",
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    created: sec(paidAtIso) - 90,
    amount_total: amount,
    currency: "usd",
    payment_intent: pi,
    payment_link: link,
    metadata: {},
    customer_details: { name, email },
    custom_fields: [{ key: "leavecommend", text: { value: "Thank you" } }],
  };
  stripeState.sessions.push(session);
  stripeState.intents.set(pi, {
    id: pi,
    created: sec(paidAtIso) - 2,
    latest_charge: { id: `ch_${pi}`, created: sec(paidAtIso), amount, amount_refunded: refunded, disputed },
  });
  return session;
}

async function main() {
  const server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
  await Tip.init();

  try {
    const roman = await makeUser({ name: "Roman Hecha", email: "roman@profixter.test", role: "employee", employeePosition: "General Fixter", isActive: true });
    const other = await makeUser({ name: "Other Fixter", email: "other@profixter.test", role: "employee", employeePosition: "Fixter", isActive: true });
    const gwen = await makeUser({ name: "Gwen Example", email: "gwen@example.test", role: "customer", emailVerifiedAt: new Date("2026-01-01") });
    const lori = await makeUser({ name: "Mike", email: "lori.mike@example.test", role: "customer", emailVerifiedAt: new Date("2026-01-01") });
    const split = await makeUser({ name: "Split Household", email: "split@example.test", role: "customer", emailVerifiedAt: new Date("2026-01-01") });

    await makeVisit(gwen, roman, "2026-11-24T15:01:18Z");
    const gwenVisit = await makeVisit(gwen, roman, "2026-11-25T22:33:26Z");
    await makeVisit(lori, roman, "2026-11-06T22:35:52Z");
    await makeVisit(split, roman, "2026-11-20T15:00:00Z");
    await makeVisit(split, other, "2026-11-24T15:00:00Z");

    console.log("\nGwen's case through the live webhook (the 2026-11-25 missing tip)");

    const gwenSession = legacyStripeTip({ pi: "pi_gwen", email: "gwen@example.test", name: "Gwen Example", paidAtIso: "2026-11-25T22:40:29Z", amount: 5000 });

    await test("an old-link $50 tip delivered to the webhook is recorded (it used to be ignored)", async () => {
      sentEmails.length = 0;
      const result = await webhook.handleCheckoutCompleted(JSON.parse(JSON.stringify(gwenSession)), "evt_gwen", sec("2026-11-25T22:40:31Z"));
      assert.ok(result?.tipId, "the webhook ignored the old-link tip again");
      const tip = await Tip.findById(result.tipId).lean();
      assert.strictEqual(tip.amountCents, 5000);
      assert.strictEqual(tip.receivedAt.toISOString(), "2026-11-25T22:40:31.000Z", "the tip does not carry the time it was paid");
      assert.strictEqual(tip.source, "legacy_payment_link");
      assert.strictEqual(String(tip.user), String(gwen._id));
      assert.strictEqual(String(tip.fixter), String(roman._id));
      assert.strictEqual(tip.attributionBasis, "visit_history");
      assert.strictEqual(String(tip.booking), String(gwenVisit._id), "the visit completed 7 minutes before was not linked");
      assert.strictEqual(tip.needsReview, false);
      assert.strictEqual(tip.recordedBy, "webhook");
      const notice = sentEmails.filter((m) => m.templateKey === "fixter_tip_received");
      assert.strictEqual(notice.length, 1);
      assert.strictEqual(notice[0].to, roman.email);
    });

    await test("webhook retries and simultaneous deliveries leave exactly one Tip and one email", async () => {
      sentEmails.length = 0;
      const again = await webhook.handleCheckoutCompleted(JSON.parse(JSON.stringify(gwenSession)), "evt_gwen_retry", sec("2026-11-25T22:45:00Z"));
      assert.strictEqual(again.duplicate, true);
      await Promise.all([
        webhook.handleCheckoutCompleted(JSON.parse(JSON.stringify(gwenSession)), "evt_gwen_a", sec("2026-11-25T22:46:00Z")),
        webhook.handleCheckoutCompleted(JSON.parse(JSON.stringify(gwenSession)), "evt_gwen_b", sec("2026-11-25T22:46:00Z")),
      ]);
      assert.strictEqual(await Tip.countDocuments({ stripePaymentIntentId: "pi_gwen" }), 1);
      assert.strictEqual(sentEmails.length, 0, "a retry emailed the Fixter again");
    });

    await test("a $50 payment that is not from a tip flow is still not a tip", async () => {
      const before = await Tip.countDocuments();
      await webhook.handleCheckoutCompleted(
        { ...JSON.parse(JSON.stringify(gwenSession)), id: "cs_not_tip", payment_intent: "pi_not_tip", payment_link: "plink_1TwpJXBw0RtvSZjM3GNjTObq" },
        "evt_not_tip",
        sec("2026-11-25T23:00:00Z")
      );
      await webhook.handleCheckoutCompleted(
        { ...JSON.parse(JSON.stringify(gwenSession)), id: "cs_plain", payment_intent: "pi_plain", payment_link: null },
        "evt_plain",
        sec("2026-11-25T23:00:00Z")
      );
      assert.strictEqual(await Tip.countDocuments(), before);
    });

    console.log("\nReconciliation and repair");

    // Lori's tip was missed (no webhook in this test); a refunded one and an ambiguous one too.
    legacyStripeTip({ pi: "pi_lori", email: "lori.mike@example.test", name: "Lori LM", paidAtIso: "2026-11-11T18:36:57Z", amount: 2000 });
    legacyStripeTip({ pi: "pi_split", email: "split@example.test", name: "Split Household", paidAtIso: "2026-11-25T12:00:00Z", amount: 3000 });
    legacyStripeTip({ pi: "pi_refunded", email: "nobody@example.test", name: "Walk In", paidAtIso: "2026-11-20T12:00:00Z", amount: 4000, refunded: 4000 });
    // Before the ledger existed: never touched.
    legacyStripeTip({ pi: "pi_pre_ledger", email: "gwen@example.test", name: "Gwen Example", paidAtIso: "2026-07-01T12:00:00Z", amount: 1500 });
    // Not a tip: a $50 Full Day link payment in the same Stripe list.
    legacyStripeTip({ pi: "pi_full_day", email: "gwen@example.test", name: "Gwen Example", paidAtIso: "2026-11-25T13:00:00Z", amount: 5000, link: "plink_1TwpJXBw0RtvSZjM3GNjTObq" });

    const MISSING = ["pi_lori", "pi_refunded", "pi_split"];
    const now = new Date("2026-11-27T20:00:00Z");

    await test("the dry run finds exactly the missing tips, shows what would be written, and writes nothing", async () => {
      const before = await Tip.countDocuments();
      const result = await reconcileTips({ until: now, apply: false, plan: true, recordedBy: "repair", stripeClient: fakeStripe, now });
      const counts = summarize(result);
      assert.deepStrictEqual(result.missing.map((m) => m.paymentIntentId).sort(), MISSING);
      assert.strictEqual(counts.matched, 1, "Gwen's recorded tip should match");
      assert.strictEqual(counts.recorded, 0);
      assert.strictEqual(counts.unexplained, 0);
      assert.ok(new Date(result.window.since) >= new Date("2026-08-12T18:00:00Z"), "reached behind the ledger start");
      const loriPlan = result.missing.find((m) => m.paymentIntentId === "pi_lori").plan;
      assert.strictEqual(loriPlan.fixter, String(roman._id));
      assert.strictEqual(loriPlan.booking, "", "a visit five days earlier was linked as the job");
      assert.strictEqual(loriPlan.receivedAt, "2026-11-11T18:36:57.000Z");
      assert.strictEqual(loriPlan.attributionBasis, "visit_history");
      const splitPlan = result.missing.find((m) => m.paymentIntentId === "pi_split").plan;
      assert.strictEqual(splitPlan.fixter, "");
      assert.strictEqual(splitPlan.needsReview, true);
      const refundedPlan = result.missing.find((m) => m.paymentIntentId === "pi_refunded").plan;
      assert.strictEqual(refundedPlan.status, "refunded");
      assert.strictEqual(refundedPlan.refundedCents, 4000);
      assert.strictEqual(refundedPlan.needsReview, true, "no customer account: should wait for a person");
      assert.strictEqual(await Tip.countDocuments(), before, "the dry run wrote a Tip");
    });

    await test("a scoped repair writes exactly those tips, with payment dates, and emails nobody", async () => {
      sentEmails.length = 0;
      const result = await reconcileTips({ until: now, apply: true, only: new Set(["pi_lori"]), recordedBy: "repair", stripeClient: fakeStripe, now });
      assert.deepStrictEqual(result.recorded.map((r) => r.paymentIntentId), ["pi_lori"]);
      assert.strictEqual(await Tip.countDocuments({ stripePaymentIntentId: { $in: ["pi_split", "pi_refunded"] } }), 0, "the repair went outside its scope");
      const tip = await Tip.findOne({ stripePaymentIntentId: "pi_lori" }).lean();
      assert.strictEqual(tip.receivedAt.toISOString(), "2026-11-11T18:36:57.000Z");
      assert.strictEqual(tip.amountCents, 2000);
      assert.strictEqual(String(tip.fixter), String(roman._id));
      assert.strictEqual(tip.recordedBy, "repair");
      assert.strictEqual(tip.stripeEventId, "");
      assert.strictEqual(sentEmails.length, 0, "a repair sent an email");
    });

    await test("repeating the repair changes nothing", async () => {
      const again = await reconcileTips({ until: now, apply: true, only: new Set(["pi_lori"]), recordedBy: "repair", stripeClient: fakeStripe, now });
      assert.strictEqual(again.recorded.length, 0);
      assert.strictEqual(again.matched, 1);
      assert.strictEqual(await Tip.countDocuments({ stripePaymentIntentId: "pi_lori" }), 1);
    });

    await test("a late webhook for a repaired tip is a duplicate, not a second Tip", async () => {
      const late = stripeState.sessions.find((s) => s.payment_intent === "pi_lori");
      const result = await webhook.handleCheckoutCompleted(JSON.parse(JSON.stringify(late)), "evt_lori_late", sec("2026-11-27T21:00:00Z"));
      assert.strictEqual(result.duplicate, true);
      assert.strictEqual(await Tip.countDocuments({ stripePaymentIntentId: "pi_lori" }), 1);
    });

    await test("a refunded and an ambiguous tip are restored refunded and flagged, never credited", async () => {
      await reconcileTips({ until: now, apply: true, only: new Set(["pi_refunded", "pi_split"]), recordedBy: "repair", stripeClient: fakeStripe, now });
      const refunded = await Tip.findOne({ stripePaymentIntentId: "pi_refunded" }).lean();
      assert.strictEqual(refunded.status, "refunded");
      assert.strictEqual(refunded.refundedCents, 4000);
      assert.strictEqual(refunded.fixter, null);
      const splitTip = await Tip.findOne({ stripePaymentIntentId: "pi_split" }).lean();
      assert.strictEqual(splitTip.fixter, null, "a tip with two possible Fixters was credited");
      assert.strictEqual(splitTip.needsReview, true);
      assert.match(splitTip.unassignedReason, /more than one Fixter/);
    });

    await test("a refund Stripe made after the record is brought level once", async () => {
      stripeState.intents.get("pi_lori").latest_charge.amount_refunded = 500;
      const first = await reconcileTips({ until: now, apply: true, recordedBy: "repair", stripeClient: fakeStripe, now });
      assert.strictEqual(first.refundBehind.length, 1);
      const tip = await Tip.findOne({ stripePaymentIntentId: "pi_lori" }).lean();
      assert.strictEqual(tip.refundedCents, 500);
      assert.strictEqual(tip.amountCents, 2000, "the original amount was overwritten");
      const second = await reconcileTips({ until: now, apply: true, recordedBy: "repair", stripeClient: fakeStripe, now });
      assert.strictEqual(second.refundBehind.length, 0);
    });

    await test("after the repair the whole ledger window has no unexplained gap", async () => {
      const result = await reconcileTips({ until: now, apply: false, stripeClient: fakeStripe, now });
      const counts = summarize(result);
      assert.strictEqual(counts.missing, 0);
      assert.strictEqual(counts.unexplained, 0);
      assert.strictEqual(counts.amountMismatch, 0);
      assert.strictEqual(counts.matched, 4);
      assert.strictEqual(await Tip.countDocuments({ stripePaymentIntentId: { $in: ["pi_pre_ledger", "pi_full_day"] } }), 0);
    });

    await test("a ledger row with no Stripe tip behind it is reported, not deleted", async () => {
      await Tip.create({ amountCents: 700, receivedAt: new Date("2026-11-21T12:00:00Z"), stripePaymentIntentId: "pi_ghost", assignmentStatus: "unassigned" });
      const result = await reconcileTips({ until: now, apply: true, stripeClient: fakeStripe, now });
      assert.deepStrictEqual(result.unexplained.map((u) => u.paymentIntentId), ["pi_ghost"]);
      assert.strictEqual(await Tip.countDocuments({ stripePaymentIntentId: "pi_ghost" }), 1);
      await Tip.deleteOne({ stripePaymentIntentId: "pi_ghost" });
    });

    console.log("\nThe hourly job");

    const job = require("../jobs/tipReconcile");

    await test("a tip the webhook missed after this release is recorded by the job, silently, once", async () => {
      legacyStripeTip({ pi: "pi_after_release", email: "gwen@example.test", name: "Gwen Example", paidAtIso: "2026-11-28T15:00:00Z", amount: 2500 });
      sentEmails.length = 0;
      const at = new Date("2026-11-28T16:00:00Z");
      const counts = await job.reconcilePass({ now: at });
      assert.strictEqual(counts.recorded, 1);
      const tip = await Tip.findOne({ stripePaymentIntentId: "pi_after_release" }).lean();
      assert.strictEqual(tip.recordedBy, "reconcile");
      assert.strictEqual(sentEmails.filter((m) => m.templateKey === "fixter_tip_received").length, 0, "the job emailed a Fixter");
      assert.strictEqual(sentEmails.filter((m) => m.templateKey === "admin_tip_reconcile_alert").length, 1, "the owner was not told");
      const rerun = await job.reconcilePass({ now: new Date("2026-11-28T17:00:00Z") });
      assert.strictEqual(rerun.recorded, 0);
      assert.strictEqual(await Tip.countDocuments({ stripePaymentIntentId: "pi_after_release" }), 1);
    });

    await test("a tip still inside the webhook's grace period is left to the webhook", async () => {
      legacyStripeTip({ pi: "pi_fresh", email: "gwen@example.test", name: "Gwen Example", paidAtIso: "2026-11-28T17:50:00Z", amount: 1000 });
      const counts = await job.reconcilePass({ now: new Date("2026-11-28T18:00:00Z") });
      assert.strictEqual(counts.pending, 1);
      assert.strictEqual(await Tip.countDocuments({ stripePaymentIntentId: "pi_fresh" }), 0);
    });

    await test("an older gap is reported to the owner once, not auto-written, and not re-sent hourly", async () => {
      legacyStripeTip({ pi: "pi_old_gap", email: "gwen@example.test", name: "Gwen Example", paidAtIso: "2026-11-26T12:00:00Z", amount: 1200 });
      sentEmails.length = 0;
      const first = await job.reconcilePass({ now: new Date("2026-11-28T19:00:00Z") });
      assert.ok(first.missing >= 1);
      assert.strictEqual(await Tip.countDocuments({ stripePaymentIntentId: "pi_old_gap" }), 0, "the job repaired a pre-release gap without review");
      await job.reconcilePass({ now: new Date("2026-11-28T20:00:00Z") });
      assert.strictEqual(sentEmails.filter((m) => m.templateKey === "admin_tip_reconcile_alert").length, 1, "the same alert went out twice");
    });

    console.log("\nDisputes");

    await test("a disputed tip is flagged for review and its amounts are untouched", async () => {
      await webhook.handleTipDispute({ payment_intent: "pi_gwen", status: "needs_response" });
      const tip = await Tip.findOne({ stripePaymentIntentId: "pi_gwen" }).lean();
      assert.strictEqual(tip.disputeStatus, "needs_response");
      assert.strictEqual(tip.needsReview, true);
      assert.strictEqual(tip.amountCents, 5000);
      assert.strictEqual(tip.refundedCents, 0);
      assert.strictEqual(await webhook.handleTipDispute({ payment_intent: "pi_membership" }), null);
    });

    console.log("\nMy Visits");

    await test("a completed visit's Leave a tip is the attributed Profixter link, never the old Stripe link", async () => {
      const router = require("../routes/bookings");
      const layer = router.stack.find((l) => l.route?.path === "/" && l.route.methods.get);
      const handler = layer.route.stack[layer.route.stack.length - 1].handle;
      let body = null;
      const res = { status() { return this; }, json(payload) { body = payload; return this; } };
      await handler({ user: { id: String(gwen._id) }, query: {}, headers: {} }, res);
      const card = body.find((b) => String(b._id) === String(gwenVisit._id));
      assert.ok(card.tipUrl, "no tip link on a completed visit");
      assert.ok(card.tipUrl.startsWith("https://www.profixter.com/tip?t="), card.tipUrl);
      assert.ok(!/buy\.stripe\.com/.test(JSON.stringify(body)), "the old Stripe link is still handed out");
      assert.ok(!JSON.stringify(body).includes(String(roman._id)), "the Fixter id reached the browser");
      const claims = readTipToken(new URL(card.tipUrl).searchParams.get("t"));
      assert.strictEqual(claims.fixterId, String(roman._id));
      assert.strictEqual(claims.bookingId, String(gwenVisit._id));
    });

    await test("nothing in any of this wrote to Stripe", async () => {
      assert.deepStrictEqual(stripeWrites, []);
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
