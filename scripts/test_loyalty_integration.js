/**
 * Loyalty Benefits against a real database.
 *
 * test_loyalty_rules proves the rules. This proves the behaviour that only
 * exists once records interact and the database is asked to enforce something:
 * webhook idempotency, concurrent grants, generation resets, gift seeding, and
 * the guarantee that a Loyalty Full Day never touches Elite's included one.
 *
 *   node scripts/test_loyalty_integration.js
 *
 * Not in `npm test`: it boots a MongoDB binary.
 */

process.env.S3_BUCKET = process.env.S3_BUCKET || "test-bucket";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_fake";
process.env.LOYALTY_ENABLED = "true";
process.env.LOYALTY_EFFECTIVE_AT = "2026-01-01T00:00:00Z";

const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const GiftMembership = require("../models/GiftMembership");
const LoyaltyCycle = require("../models/LoyaltyCycle");
const LoyaltyGrant = require("../models/LoyaltyGrant");
const Subscription = require("../models/Subscription");
const User = require("../models/User");
const VisitEntitlement = require("../models/VisitEntitlement");

const ledger = require("../utils/loyalty/loyaltyLedger");
const rewards = require("../utils/loyalty/loyaltyRewards");
const effective = require("../utils/loyalty/effectivePlan");
const progress = require("../utils/loyalty/loyaltyProgress");
const fullDays = require("../utils/fullDayEntitlements");
const loyaltyService = require("../utils/loyalty/loyaltyService");

const DAY = 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * DAY;

let passed = 0;
const failures = [];
let mongod;
let seq = 0;

async function test(name, fn) {
  await Promise.all([
    LoyaltyCycle.deleteMany({}),
    LoyaltyGrant.deleteMany({}),
    VisitEntitlement.deleteMany({}),
    GiftMembership.deleteMany({}),
    Subscription.deleteMany({}),
    User.deleteMany({}),
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

async function makeUser() {
  seq += 1;
  return User.create({
    userId: `u${String(seq).padStart(7, "0")}`,
    name: "Jane Doe",
    email: `person${seq}@example.com`,
    phone: "6315991363",
    role: "customer",
    addresses: [{ line1: "1 Main St", city: "Lindenhurst", state: "NY", zip: "11757" }],
  });
}

/*
 * A live membership, with its billing period straddling today.
 *
 * The period has to be current, not a fixed date, because
 * subscriptionGrantsAccess refuses a subscription whose currentPeriodEnd has
 * passed — which is correct behaviour and exactly what would happen to a real
 * lapsed member. A fixture with hardcoded 2026 dates tests the lapse, not the
 * benefit.
 */
async function makeSubscription(user, overrides = {}) {
  const address = user.addresses[0];
  const periodStart = overrides.currentPeriodStart || new Date(Date.now() - 5 * DAY);
  const periodEnd = overrides.currentPeriodEnd || new Date(Date.now() + 25 * DAY);

  return Subscription.create({
    user: user._id,
    userId: user.userId,
    subscriptionType: overrides.plan || "basic",
    billingCycle: overrides.billingCycle || "monthly",
    addressId: overrides.addressId || address._id,
    addressSnapshot: { line1: address.line1, city: address.city, state: address.state, zip: address.zip },
    stripeCustomerId: `cus_${seq}`,
    stripeSubscriptionId: overrides.stripeSubscriptionId || `sub_${seq}_${Math.random().toString(16).slice(2, 8)}`,
    status: "active",
    accessStatus: "active",
    startDate: new Date(Date.now() - 365 * DAY),
    latestPaymentDate: periodStart,
    nextPaymentDate: periodEnd,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
  });
}

/** Add one counted month to a track, the way the webhook would. */
async function addCycle(user, subscription, { plan, index, invoiceId }) {
  return ledger.recordCycle({
    user: user._id,
    userId: user.userId,
    addressId: subscription.addressId,
    plan: plan || subscription.subscriptionType,
    periodStart: new Date(Date.now() - (12 - index) * MONTH_MS),
    periodEnd: new Date(Date.now() - (11 - index) * MONTH_MS),
    stripeInvoiceId: invoiceId || `in_${subscription.stripeSubscriptionId}_${index}`,
    stripeSubscriptionId: subscription.stripeSubscriptionId,
  });
}

/* ========================================================================== */

async function run() {
  console.log("\n--- the ledger counts once, whatever Stripe does");

  await test("the same invoice cannot be counted twice", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user);

    const first = await addCycle(user, sub, { index: 1, invoiceId: "in_replay" });
    const second = await addCycle(user, sub, { index: 1, invoiceId: "in_replay" });

    assert.equal(first.created, true);
    assert.equal(second.created, false, "a replayed webhook must not count a second month");
    assert.equal(await LoyaltyCycle.countDocuments({ user: user._id }), 1);
  });

  await test("concurrent deliveries of one invoice produce one month", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => addCycle(user, sub, { index: 1, invoiceId: "in_race" }))
    );

    assert.equal(results.filter((r) => r.created).length, 1, "exactly one insert wins");
    assert.equal(await LoyaltyCycle.countDocuments({ user: user._id }), 1);
  });

  await test("a reversed month stops counting without being deleted", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user);
    await addCycle(user, sub, { index: 1, invoiceId: "in_a" });
    await addCycle(user, sub, { index: 2, invoiceId: "in_b" });

    await ledger.reverseCycleByInvoice("in_b", "charge_refunded");

    const state = await ledger.trackState(user._id, sub.addressId);
    assert.equal(state.countedMonths, 1, "the refunded month no longer counts");
    assert.equal(await LoyaltyCycle.countDocuments({ user: user._id }), 2, "but the record survives");
  });

  console.log("\n--- rewards are issued exactly once");

  await test("two concurrent milestone evaluations grant one reward", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user, { plan: "basic" });
    for (let index = 1; index <= 3; index += 1) {
      await addCycle(user, sub, { index });
    }
    const { cycles, generation } = await ledger.trackState(user._id, sub.addressId);

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        rewards.evaluateMilestones({
          user,
          subscription: sub,
          cycles,
          generation,
          triggeringInvoiceId: "in_3",
          stripeSubscription: { id: sub.stripeSubscriptionId },
        })
      )
    );

    assert.equal(results.flat().filter(Boolean).length, 1, "only one caller may grant");
    assert.equal(await LoyaltyGrant.countDocuments({ user: user._id, milestone: 3 }), 1);
  });

  await test("Basic at three months earns one month of Plus, not a plan change", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user, { plan: "basic" });
    for (let index = 1; index <= 3; index += 1) await addCycle(user, sub, { index });
    const { cycles, generation } = await ledger.trackState(user._id, sub.addressId);

    const [grant] = await rewards.evaluateMilestones({
      user,
      subscription: sub,
      cycles,
      generation,
      triggeringInvoiceId: "in_3",
      stripeSubscription: { id: sub.stripeSubscriptionId },
    });

    assert.equal(grant.rewardKind, "tier_upgrade");
    assert.equal(grant.rewardPlan, "plus");
    assert.equal(grant.cycles, 1);
    assert.ok(grant.effectiveUntil, "the benefit has an end date so nothing has to expire it");

    const reread = await Subscription.findById(sub._id);
    assert.equal(reread.subscriptionType, "basic", "the paid plan must never be rewritten");
  });

  await test("the reward records why it resolved the way it did", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user, { plan: "basic" });
    await addCycle(user, sub, { index: 1, plan: "elite" });
    await addCycle(user, sub, { index: 2, plan: "basic" });
    await addCycle(user, sub, { index: 3, plan: "basic" });
    const { cycles, generation } = await ledger.trackState(user._id, sub.addressId);

    const [grant] = await rewards.evaluateMilestones({
      user,
      subscription: sub,
      cycles,
      generation,
      triggeringInvoiceId: "in_why",
      stripeSubscription: { id: sub.stripeSubscriptionId },
    });

    assert.equal(grant.windowMinimumPlan, "basic", "Elite then Basic resolves to Basic");
    assert.deepEqual(grant.windowPlans, ["elite", "basic", "basic"]);
    assert.equal(grant.triggeringInvoiceId, "in_why");
    assert.equal(grant.rewardPlan, "plus");
  });

  await test("a legitimate upgrade is rewarded in the following window", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user, { plan: "elite" });
    await addCycle(user, sub, { index: 1, plan: "basic" });
    for (let index = 2; index <= 6; index += 1) await addCycle(user, sub, { index, plan: "elite" });
    const { cycles, generation } = await ledger.trackState(user._id, sub.addressId);

    // Six months earns both rungs at once here, so pick the one under test.
    const granted = await rewards.evaluateMilestones({
      user,
      subscription: sub,
      cycles,
      generation,
      triggeringInvoiceId: "in_6",
      stripeSubscription: { id: sub.stripeSubscriptionId },
      fullDayMinutes: 480,
    });
    const grant = granted.find((entry) => entry.milestone === 6);

    assert.equal(grant.milestone, 6);
    assert.equal(grant.windowMinimumPlan, "elite", "months 4-6 were all Elite");
    assert.equal(grant.rewardKind, "loyalty_full_day");
  });

  console.log("\n--- an Elite Loyalty Full Day is genuinely extra");

  await test("a Loyalty Full Day does not touch Elite's included one", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user, { plan: "elite" });
    for (let index = 1; index <= 3; index += 1) await addCycle(user, sub, { index, plan: "elite" });
    const { cycles, generation } = await ledger.trackState(user._id, sub.addressId);

    const [grant] = await rewards.evaluateMilestones({
      user,
      subscription: sub,
      cycles,
      generation,
      triggeringInvoiceId: "in_elite3",
      stripeSubscription: { id: sub.stripeSubscriptionId },
      fullDayMinutes: 480,
    });

    assert.equal(grant.rewardKind, "loyalty_full_day");
    assert.ok(grant.visitEntitlementId);

    // The included day is untouched: still available for this period.
    const included = await fullDays.includedFullDayState({ user, addressId: sub.addressId });
    assert.equal(included.entitled, true);
    assert.equal(included.used, false, "the loyalty day must not read as the included one");
    assert.equal(included.remaining, 1);

    // And the loyalty day is available alongside it.
    const loyalty = await fullDays.loyaltyFullDayState({ user, addressId: sub.addressId });
    assert.equal(loyalty.available, 1);
  });

  await test("one grant can only ever produce one Full Day", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user, { plan: "elite" });
    const grant = await LoyaltyGrant.create({
      user: user._id,
      userId: user.userId,
      addressId: sub.addressId,
      generation: 1,
      milestone: 3,
      rewardKind: "loyalty_full_day",
      status: "granted",
      grantedAt: new Date(),
    });

    const issued = await Promise.all(
      Array.from({ length: 4 }, () =>
        rewards.issueLoyaltyFullDay({ grant, subscription: sub, user, durationMinutes: 480 })
      )
    );

    assert.equal(issued.filter(Boolean).length, 4, "every caller gets an entitlement back");
    assert.equal(
      await VisitEntitlement.countDocuments({ loyaltyGrantId: grant._id }),
      1,
      "but only one exists"
    );
  });

  await test("an expired Loyalty Full Day is no longer available", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user, { plan: "elite" });
    await VisitEntitlement.create({
      user: user._id,
      userId: user.userId,
      addressId: sub.addressId,
      kind: "full_day_visit",
      source: "loyalty_benefit",
      status: "paid",
      priceCents: 0,
      loyaltyGrantId: new mongoose.Types.ObjectId(),
      expiresAt: new Date(Date.now() - DAY),
    });

    const state = await fullDays.loyaltyFullDayState({ user, addressId: sub.addressId });
    assert.equal(state.available, 0, "ninety days is ninety days");
  });

  await test("a Loyalty Full Day is unusable once the membership ends", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user, { plan: "elite" });
    await VisitEntitlement.create({
      user: user._id,
      userId: user.userId,
      addressId: sub.addressId,
      kind: "full_day_visit",
      source: "loyalty_benefit",
      status: "paid",
      priceCents: 0,
      loyaltyGrantId: new mongoose.Types.ObjectId(),
      expiresAt: new Date(Date.now() + 30 * DAY),
    });

    await Subscription.updateOne({ _id: sub._id }, { $set: { status: "canceled", accessStatus: "inactive" } });

    const state = await fullDays.loyaltyFullDayState({ user, addressId: sub.addressId });
    assert.equal(state.available, 0, "it is a benefit of being a member");
    assert.equal(
      await VisitEntitlement.countDocuments({ source: "loyalty_benefit" }),
      1,
      "the record still exists so the history is answerable"
    );
  });

  /*
   * The two kinds are given back in opposite directions, and getting this wrong
   * destroys a benefit rather than returning it. An included day is released by
   * ending its record; a Loyalty day IS its record, so it must return to `paid`.
   */
  await test("cancelling a Loyalty Full Day booking returns it, does not destroy it", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user, { plan: "elite" });
    const entitlement = await VisitEntitlement.create({
      user: user._id,
      userId: user.userId,
      addressId: sub.addressId,
      kind: "full_day_visit",
      source: "loyalty_benefit",
      status: "paid",
      priceCents: 0,
      loyaltyGrantId: new mongoose.Types.ObjectId(),
      expiresAt: new Date(Date.now() + 60 * DAY),
    });

    await fullDays.consumeLoyaltyFullDay({ entitlementId: entitlement._id });
    assert.equal(
      (await fullDays.loyaltyFullDayState({ user, addressId: sub.addressId })).available,
      0,
      "spent"
    );

    const result = await fullDays.restoreLoyaltyFullDay({
      booking: { entitlementId: entitlement._id, date: new Date(Date.now() + 10 * DAY) },
    });

    assert.equal(result.restored, true);
    const after = await VisitEntitlement.findById(entitlement._id);
    assert.equal(after.status, "paid", "back to available, NOT canceled");
    assert.equal(
      (await fullDays.loyaltyFullDayState({ user, addressId: sub.addressId })).available,
      1,
      "the member has their Full Day back"
    );
  });

  await test("a Loyalty Full Day booking already under way is not given back", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user, { plan: "elite" });
    const entitlement = await VisitEntitlement.create({
      user: user._id,
      userId: user.userId,
      addressId: sub.addressId,
      kind: "full_day_visit",
      source: "loyalty_benefit",
      status: "consumed",
      priceCents: 0,
      loyaltyGrantId: new mongoose.Types.ObjectId(),
      expiresAt: new Date(Date.now() + 60 * DAY),
    });

    const result = await fullDays.restoreLoyaltyFullDay({
      booking: { entitlementId: entitlement._id, date: new Date(Date.now() - DAY) },
    });
    assert.equal(result.restored, false);
    assert.equal(result.reason, "day_already_started");
  });

  /* The included-day helper must refuse a Loyalty row, and the reverse. */
  await test("the two restore helpers never touch each other's entitlements", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user, { plan: "elite" });
    const loyaltyRow = await VisitEntitlement.create({
      user: user._id,
      userId: user.userId,
      addressId: sub.addressId,
      kind: "full_day_visit",
      source: "loyalty_benefit",
      status: "consumed",
      priceCents: 0,
      loyaltyGrantId: new mongoose.Types.ObjectId(),
      expiresAt: new Date(Date.now() + 60 * DAY),
    });

    const booking = { entitlementId: loyaltyRow._id, date: new Date(Date.now() + 10 * DAY) };
    const wrongHelper = await fullDays.restoreIncludedFullDay({ booking });
    assert.equal(wrongHelper.restored, false, "the included helper refuses a Loyalty row");
    assert.equal(
      (await VisitEntitlement.findById(loyaltyRow._id)).status,
      "consumed",
      "and leaves it exactly as it was"
    );
  });

  await test("a Loyalty Full Day cannot be spent twice", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user, { plan: "elite" });
    const entitlement = await VisitEntitlement.create({
      user: user._id,
      userId: user.userId,
      addressId: sub.addressId,
      kind: "full_day_visit",
      source: "loyalty_benefit",
      status: "paid",
      priceCents: 0,
      loyaltyGrantId: new mongoose.Types.ObjectId(),
      expiresAt: new Date(Date.now() + 30 * DAY),
    });

    const outcomes = await Promise.allSettled(
      Array.from({ length: 3 }, () => fullDays.consumeLoyaltyFullDay({ entitlementId: entitlement._id }))
    );

    assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((o) => o.status === "rejected").length, 2);
  });

  console.log("\n--- the temporary upgrade is real, and it ends by itself");

  await test("a live grant raises the effective plan without touching Stripe", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user, { plan: "basic" });
    await LoyaltyGrant.create({
      user: user._id,
      userId: user.userId,
      addressId: sub.addressId,
      generation: 1,
      milestone: 3,
      rewardKind: "tier_upgrade",
      rewardPlan: "plus",
      cycles: 1,
      status: "granted",
      effectiveFrom: new Date(Date.now() - DAY),
      effectiveUntil: new Date(Date.now() + 20 * DAY),
      grantedAt: new Date(),
    });

    const resolved = await effective.effectivePlanForSubscription(sub);
    assert.equal(resolved.plan, "plus");
    assert.equal(resolved.paidPlan, "basic");
    assert.equal(resolved.source, "loyalty");
  });

  await test("an expired grant stops applying with no job involved", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user, { plan: "basic" });
    await LoyaltyGrant.create({
      user: user._id,
      userId: user.userId,
      addressId: sub.addressId,
      generation: 1,
      milestone: 3,
      rewardKind: "tier_upgrade",
      rewardPlan: "plus",
      status: "granted",
      effectiveFrom: new Date(Date.now() - 60 * DAY),
      effectiveUntil: new Date(Date.now() - DAY),
      grantedAt: new Date(),
    });

    const resolved = await effective.effectivePlanForSubscription(sub);
    assert.equal(resolved.plan, "basic");
    assert.equal(resolved.source, "paid");
  });

  await test("a temporarily-Elite member gets the included Full Day too", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user, { plan: "premium" });
    await LoyaltyGrant.create({
      user: user._id,
      userId: user.userId,
      addressId: sub.addressId,
      generation: 1,
      milestone: 3,
      rewardKind: "tier_upgrade",
      rewardPlan: "elite",
      cycles: 1,
      status: "granted",
      effectiveFrom: new Date(Date.now() - DAY),
      effectiveUntil: new Date(Date.now() + 20 * DAY),
      grantedAt: new Date(),
    });

    const state = await fullDays.includedFullDayState({ user, addressId: sub.addressId });
    assert.equal(state.entitled, true, "complimentary Elite means the Elite Full Day");
    assert.equal(state.remaining, 1);
  });

  console.log("\n--- the free month cannot be farmed");

  /** A Stripe stand-in that records what it was asked to do. */
  function fakeStripe({ invoices = [], listThrows = false } = {}) {
    const calls = { couponsCreated: 0, subscriptionsUpdated: 0 };
    return {
      calls,
      invoices: {
        list: async () => {
          if (listThrows) throw new Error("stripe unavailable");
          return { data: invoices };
        },
      },
      coupons: {
        create: async () => {
          calls.couponsCreated += 1;
          return { id: `co_fake_${calls.couponsCreated}` };
        },
      },
      subscriptions: {
        update: async () => {
          calls.subscriptionsUpdated += 1;
          return {};
        },
      },
    };
  }

  async function pendingFreeMonth(user, sub) {
    return LoyaltyGrant.create({
      user: user._id,
      userId: user.userId,
      addressId: sub.addressId,
      generation: 1,
      milestone: 12,
      rewardKind: "free_month",
      stripeSubscriptionId: sub.stripeSubscriptionId,
      stripeCouponId: "co_original",
      status: "applied",
      grantedAt: new Date(Date.now() - 20 * DAY),
    });
  }

  await test("a $0 renewal settles the free month", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user, { plan: "basic" });
    const grant = await pendingFreeMonth(user, sub);

    await rewards.verifyFreeMonth({
      invoice: { id: "in_free", amount_paid: 0, billing_reason: "subscription_cycle" },
      stripeSubscription: { id: sub.stripeSubscriptionId },
      stripeClient: fakeStripe({ invoices: [] }),
    });

    const after = await LoyaltyGrant.findById(grant._id);
    assert.equal(after.status, "consumed");
    assert.equal(after.appliedInvoiceId, "in_free");
    assert.equal(after.verifiedAmountPaidCents, 0);
  });

  /*
   * The exploit this guard exists for: take the free month, upgrade in the
   * Stripe portal so the 100%-off coupon zeroes a large proration, downgrade,
   * and let the protective retry hand over a second coupon. One earned benefit
   * must not become two on demand.
   */
  await test("a customer-raised proration blocks the automatic re-issue", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user, { plan: "basic" });
    const grant = await pendingFreeMonth(user, sub);

    const stripeClient = fakeStripe({
      invoices: [
        { id: "in_proration", billing_reason: "subscription_update", amount_paid: 35000 },
      ],
    });

    await rewards.verifyFreeMonth({
      invoice: { id: "in_renewal", amount_paid: 14900, billing_reason: "subscription_cycle" },
      stripeSubscription: { id: sub.stripeSubscriptionId },
      stripeClient,
    });

    const after = await LoyaltyGrant.findById(grant._id);
    assert.equal(stripeClient.calls.couponsCreated, 0, "NO second coupon is minted");
    assert.equal(after.status, "failed");
    assert.equal(after.needsReview, true, "a person is asked instead");
    assert.match(after.failureReason, /subscription_update/);
    assert.equal(after.appliedInvoiceId, "in_proration", "and the burn is recorded");
  });

  await test("a renewal-only history still gets one automatic retry", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user, { plan: "basic" });
    const grant = await pendingFreeMonth(user, sub);

    const stripeClient = fakeStripe({
      invoices: [{ id: "in_prev", billing_reason: "subscription_cycle", amount_paid: 14900 }],
    });

    await rewards.verifyFreeMonth({
      invoice: { id: "in_renewal", amount_paid: 14900, billing_reason: "subscription_cycle" },
      stripeSubscription: { id: sub.stripeSubscriptionId },
      stripeClient,
    });

    const after = await LoyaltyGrant.findById(grant._id);
    assert.equal(stripeClient.calls.couponsCreated, 1, "the genuine failure is retried");
    assert.equal(after.status, "applied");
    assert.equal(after.reapplyCount, 1);
  });

  /* Money decisions fail closed when Stripe cannot be asked. */
  await test("an unreadable invoice history refuses to re-issue", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user, { plan: "basic" });
    const grant = await pendingFreeMonth(user, sub);

    const stripeClient = fakeStripe({ listThrows: true });

    await rewards.verifyFreeMonth({
      invoice: { id: "in_renewal", amount_paid: 14900, billing_reason: "subscription_cycle" },
      stripeSubscription: { id: sub.stripeSubscriptionId },
      stripeClient,
    });

    const after = await LoyaltyGrant.findById(grant._id);
    assert.equal(stripeClient.calls.couponsCreated, 0);
    assert.equal(after.needsReview, true);
    assert.match(after.failureReason, /unverified/);
  });

  await test("retries stop after two, rather than looping against money", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user, { plan: "basic" });
    const grant = await pendingFreeMonth(user, sub);
    await LoyaltyGrant.updateOne({ _id: grant._id }, { $set: { reapplyCount: 2 } });

    const stripeClient = fakeStripe({ invoices: [] });
    await rewards.verifyFreeMonth({
      invoice: { id: "in_renewal", amount_paid: 14900, billing_reason: "subscription_cycle" },
      stripeSubscription: { id: sub.stripeSubscriptionId },
      stripeClient,
    });

    const after = await LoyaltyGrant.findById(grant._id);
    assert.equal(stripeClient.calls.couponsCreated, 0);
    assert.equal(after.status, "failed");
    assert.equal(after.needsReview, true);
  });

  await test("a member's existing promotion code is preserved, not replaced", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user, { plan: "basic" });
    const grant = await pendingFreeMonth(user, sub);

    let sentDiscounts = null;
    const stripeClient = {
      coupons: { create: async () => ({ id: "co_loyalty" }) },
      subscriptions: {
        update: async (_id, params) => {
          sentDiscounts = params.discounts;
          return {};
        },
      },
    };

    const result = await rewards.applyFreeMonthCoupon({
      grant,
      stripeSubscription: {
        id: sub.stripeSubscriptionId,
        discounts: [{ promotion_code: "promo_member", coupon: { id: "co_member" } }],
      },
      stripeClient,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(
      sentDiscounts,
      [{ promotion_code: "promo_member" }, { coupon: "co_loyalty" }],
      "theirs first, ours appended — never a blind overwrite"
    );
  });

  console.log("\n--- multi-property members stay separate");

  await test("two properties earn independently", async () => {
    const user = await makeUser();
    user.addresses.push({ line1: "2 Oak Ave", city: "Babylon", state: "NY", zip: "11702" });
    await user.save();

    const houseA = user.addresses[0]._id;
    const houseB = user.addresses[1]._id;
    const subA = await makeSubscription(user, { plan: "basic", addressId: houseA });
    const subB = await makeSubscription(user, { plan: "premium", addressId: houseB });

    for (let index = 1; index <= 3; index += 1) await addCycle(user, subA, { index });
    await addCycle(user, subB, { index: 1 });

    const stateA = await ledger.trackState(user._id, houseA);
    const stateB = await ledger.trackState(user._id, houseB);
    assert.equal(stateA.countedMonths, 3);
    assert.equal(stateB.countedMonths, 1, "one house's progress is not the other's");
  });

  await test("a grant at one property does not raise the plan at another", async () => {
    const user = await makeUser();
    user.addresses.push({ line1: "2 Oak Ave", city: "Babylon", state: "NY", zip: "11702" });
    await user.save();
    const houseA = user.addresses[0]._id;
    const houseB = user.addresses[1]._id;
    const subA = await makeSubscription(user, { plan: "basic", addressId: houseA });
    const subB = await makeSubscription(user, { plan: "basic", addressId: houseB });

    await LoyaltyGrant.create({
      user: user._id,
      userId: user.userId,
      addressId: houseA,
      generation: 1,
      milestone: 3,
      rewardKind: "tier_upgrade",
      rewardPlan: "plus",
      status: "granted",
      effectiveFrom: new Date(Date.now() - DAY),
      effectiveUntil: new Date(Date.now() + 20 * DAY),
      grantedAt: new Date(),
    });

    assert.equal((await effective.effectivePlanForSubscription(subA)).plan, "plus");
    assert.equal((await effective.effectivePlanForSubscription(subB)).plan, "basic");
  });

  console.log("\n--- continuity");

  await test("a long absence starts a new generation and progress restarts", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user);

    await ledger.recordCycle({
      user: user._id,
      userId: user.userId,
      addressId: sub.addressId,
      plan: "basic",
      periodStart: new Date("2026-01-01"),
      periodEnd: new Date("2026-02-01"),
      stripeInvoiceId: "in_old",
      stripeSubscriptionId: sub.stripeSubscriptionId,
    });

    await ledger.recordCycle({
      user: user._id,
      userId: user.userId,
      addressId: sub.addressId,
      plan: "basic",
      periodStart: new Date("2026-09-01"),
      periodEnd: new Date("2026-10-01"),
      stripeInvoiceId: "in_returned",
      stripeSubscriptionId: sub.stripeSubscriptionId,
    });

    const state = await ledger.trackState(user._id, sub.addressId);
    assert.equal(state.generation, 2, "seven months away is a break");
    assert.equal(state.countedMonths, 1, "the new run starts at one");
    assert.equal(await LoyaltyCycle.countDocuments({ user: user._id }), 2, "history is kept");
  });

  await test("a three-week dunning gap keeps the same generation", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user);

    await ledger.recordCycle({
      user: user._id,
      userId: user.userId,
      addressId: sub.addressId,
      plan: "basic",
      periodStart: new Date("2026-01-01"),
      periodEnd: new Date("2026-02-01"),
      stripeInvoiceId: "in_1",
      stripeSubscriptionId: sub.stripeSubscriptionId,
    });
    await ledger.recordCycle({
      user: user._id,
      userId: user.userId,
      addressId: sub.addressId,
      plan: "basic",
      periodStart: new Date("2026-02-21"),
      periodEnd: new Date("2026-03-21"),
      stripeInvoiceId: "in_2",
      stripeSubscriptionId: sub.stripeSubscriptionId,
    });

    const state = await ledger.trackState(user._id, sub.addressId);
    assert.equal(state.generation, 1, "recovering from a failed payment is not leaving");
    assert.equal(state.countedMonths, 2);
  });

  await test("a returning member may earn the same milestone again, once", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user);
    const base = {
      user: user._id,
      userId: user.userId,
      addressId: sub.addressId,
      milestone: 3,
      rewardKind: "tier_upgrade",
      rewardPlan: "plus",
      status: "granted",
      grantedAt: new Date(),
    };

    await LoyaltyGrant.create({ ...base, generation: 1 });
    await LoyaltyGrant.create({ ...base, generation: 2 });

    await assert.rejects(
      LoyaltyGrant.create({ ...base, generation: 2 }),
      (error) => error.code === 11000,
      "but not twice in the same run"
    );
  });

  console.log("\n--- gift conversion");

  await test("delivered gift months seed a converting recipient", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user, { plan: "basic" });
    await GiftMembership.create({
      giftNumber: `G${seq}A`,
      purchaser: new mongoose.Types.ObjectId(),
      recipientEmail: user.email,
      recipient: user._id,
      addressId: sub.addressId,
      plan: "premium",
      durationMonths: 2,
      status: "claimed",
      startAt: new Date(Date.now() - 70 * DAY),
      endAt: new Date(Date.now() - 8 * DAY),
    });

    await loyaltyService.seedFromGiftsIfFirstCycle({
      user,
      subscription: sub,
      periodStart: new Date(),
      env: process.env,
    });

    const state = await ledger.trackState(user._id, sub.addressId);
    assert.equal(state.countedMonths, 2, "two gifted months carry forward");
    assert.equal(state.cycles[0].plan, "premium", "seeded at the gift's own plan");
    assert.equal(state.cycles[0].source, "gift_seed");
  });

  await test("seeding runs once, however many times it is called", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user, { plan: "basic" });
    await GiftMembership.create({
      giftNumber: `G${seq}B`,
      purchaser: new mongoose.Types.ObjectId(),
      recipientEmail: user.email,
      recipient: user._id,
      addressId: sub.addressId,
      plan: "basic",
      durationMonths: 2,
      status: "claimed",
      startAt: new Date(Date.now() - 70 * DAY),
      endAt: new Date(Date.now() - 8 * DAY),
    });

    const args = { user, subscription: sub, periodStart: new Date(), env: process.env };
    await loyaltyService.seedFromGiftsIfFirstCycle(args);
    await loyaltyService.seedFromGiftsIfFirstCycle(args);

    const state = await ledger.trackState(user._id, sub.addressId);
    assert.equal(state.countedMonths, 2, "not four");
  });

  /*
   * The case that made evaluateMilestones return a list.
   *
   * A recipient with three seeded gift months whose first paid renewal takes
   * them to four would, under an exact "is four a milestone" test, silently
   * skip the three-month reward they had plainly earned.
   */
  await test("a gift recipient whose count jumps past a milestone still gets it", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user, { plan: "basic" });
    await GiftMembership.create({
      giftNumber: `G${seq}E`,
      purchaser: new mongoose.Types.ObjectId(),
      recipientEmail: user.email,
      recipient: user._id,
      addressId: sub.addressId,
      plan: "basic",
      durationMonths: 3,
      status: "claimed",
      startAt: new Date(Date.now() - 100 * DAY),
      endAt: new Date(Date.now() - 8 * DAY),
    });

    await loyaltyService.recordRenewal({
      invoice: {
        id: "in_converted",
        subscription: sub.stripeSubscriptionId,
        billing_reason: "subscription_cycle",
        status: "paid",
        amount_paid: 14900,
        created: Math.floor(Date.now() / 1000),
        period_start: Math.floor(Date.now() / 1000),
        period_end: Math.floor((Date.now() + MONTH_MS) / 1000),
      },
      stripeSubscription: { id: sub.stripeSubscriptionId },
      env: process.env,
    });

    const state = await ledger.trackState(user._id, sub.addressId);
    assert.equal(state.countedMonths, 4, "three gifted months plus one paid");

    const grants = await LoyaltyGrant.find({ user: user._id }).lean();
    assert.equal(grants.length, 1, "the three-month reward is not skipped");
    assert.equal(grants[0].milestone, 3);
    assert.equal(grants[0].rewardPlan, "plus");
  });

  await test("an unclaimed gift seeds nothing", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user, { plan: "basic" });
    await GiftMembership.create({
      giftNumber: `G${seq}C`,
      purchaser: new mongoose.Types.ObjectId(),
      recipientEmail: user.email,
      recipient: user._id,
      addressId: sub.addressId,
      plan: "basic",
      durationMonths: 2,
      status: "invited",
    });

    await loyaltyService.seedFromGiftsIfFirstCycle({
      user,
      subscription: sub,
      periodStart: new Date(),
      env: process.env,
    });

    assert.equal(await LoyaltyCycle.countDocuments({ user: user._id }), 0);
  });

  await test("a gift bought for somebody else earns the purchaser nothing", async () => {
    const purchaser = await makeUser();
    const recipient = await makeUser();
    const purchaserSub = await makeSubscription(purchaser, { plan: "premium" });

    await GiftMembership.create({
      giftNumber: `G${seq}D`,
      purchaser: purchaser._id,
      recipientEmail: recipient.email,
      recipient: recipient._id,
      addressId: recipient.addresses[0]._id,
      plan: "elite",
      durationMonths: 2,
      status: "claimed",
      startAt: new Date(Date.now() - 70 * DAY),
      endAt: new Date(Date.now() - 8 * DAY),
    });

    await loyaltyService.seedFromGiftsIfFirstCycle({
      user: purchaser,
      subscription: purchaserSub,
      periodStart: new Date(),
      env: process.env,
    });

    assert.equal(
      await LoyaltyCycle.countDocuments({ user: purchaser._id }),
      0,
      "buying a gift creates no loyalty relationship"
    );
  });

  console.log("\n--- what the customer is shown");

  await test("an annual member is told their reward is already built in", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user, { plan: "premium", billingCycle: "annual" });

    const status = await progress.loyaltyStatusForSubscription({ user, subscription: sub });
    assert.equal(status.eligible, false);
    assert.equal(status.reason, "annual_membership");
    assert.match(status.annual.detail, /pay for 10 months and get 12/i);
  });

  await test("a brand new member sees a meter at zero and a real next reward", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user, { plan: "plus" });

    const status = await progress.loyaltyStatusForSubscription({ user, subscription: sub });
    assert.equal(status.eligible, true);
    assert.equal(status.countedMonths, 0);
    assert.equal(status.nextMilestone, 3);
    assert.equal(status.monthsRemaining, 3);
    assert.match(status.nextReward.headline, /complimentary Premium/);
    assert.ok(status.estimatedUnlockDate, "a date, not a vague promise");
  });

  await test("progress and active benefits appear together", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user, { plan: "basic" });
    for (let index = 1; index <= 3; index += 1) await addCycle(user, sub, { index });
    await LoyaltyGrant.create({
      user: user._id,
      userId: user.userId,
      addressId: sub.addressId,
      generation: 1,
      milestone: 3,
      rewardKind: "tier_upgrade",
      rewardPlan: "plus",
      cycles: 1,
      status: "granted",
      effectiveFrom: new Date(Date.now() - DAY),
      effectiveUntil: new Date(Date.now() + 20 * DAY),
      grantedAt: new Date(),
    });

    const status = await progress.loyaltyStatusForSubscription({ user, subscription: sub });
    assert.equal(status.countedMonths, 3);
    assert.equal(status.nextMilestone, 6);
    assert.equal(status.activeBenefits.length, 1);
    assert.match(status.activeBenefits[0].headline, /complimentary Plus/);
  });

  await test("a member who finishes the ladder is told so, not shown an empty meter", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user, { plan: "basic" });
    for (let index = 1; index <= 12; index += 1) await addCycle(user, sub, { index });

    const status = await progress.loyaltyStatusForSubscription({ user, subscription: sub });
    assert.equal(status.countedMonths, 12);
    assert.equal(status.nextMilestone, null);
    assert.equal(status.ladderComplete, true);
    assert.equal(status.nextReward, null, "year two has not been decided, so nothing is promised");
  });

  await test("with the program off, nothing is counted or shown", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user, { plan: "basic" });

    const status = await progress.loyaltyStatusForSubscription({
      user,
      subscription: sub,
      env: { LOYALTY_ENABLED: "false" },
    });
    assert.equal(status.enabled, false);
    assert.equal(status.reason, "program_inactive");
  });

  console.log("\n--- no retroactive credit");

  await test("a renewal from before launch is refused by the service", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user, { plan: "basic" });

    const result = await loyaltyService.recordRenewal({
      invoice: {
        id: "in_ancient",
        subscription: sub.stripeSubscriptionId,
        billing_reason: "subscription_cycle",
        status: "paid",
        created: Math.floor(new Date("2025-06-01").getTime() / 1000),
      },
      stripeSubscription: { id: sub.stripeSubscriptionId },
      env: { LOYALTY_ENABLED: "true", LOYALTY_EFFECTIVE_AT: "2026-01-01T00:00:00Z" },
    });

    assert.equal(result, null);
    assert.equal(await LoyaltyCycle.countDocuments({ user: user._id }), 0);
  });

  await test("an upgrade proration is refused by the service", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user, { plan: "basic" });

    await loyaltyService.recordRenewal({
      invoice: {
        id: "in_proration",
        subscription: sub.stripeSubscriptionId,
        billing_reason: "subscription_update",
        status: "paid",
        created: Math.floor(Date.now() / 1000),
      },
      stripeSubscription: { id: sub.stripeSubscriptionId },
      env: process.env,
    });

    assert.equal(await LoyaltyCycle.countDocuments({ user: user._id }), 0);
  });

  await test("an annual renewal is refused by the service", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user, { plan: "premium", billingCycle: "annual" });

    await loyaltyService.recordRenewal({
      invoice: {
        id: "in_annual",
        subscription: sub.stripeSubscriptionId,
        billing_reason: "subscription_cycle",
        status: "paid",
        created: Math.floor(Date.now() / 1000),
      },
      stripeSubscription: { id: sub.stripeSubscriptionId },
      env: process.env,
    });

    assert.equal(await LoyaltyCycle.countDocuments({ user: user._id }), 0);
  });

  await test("a genuine renewal is counted end to end", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user, { plan: "basic" });

    await loyaltyService.recordRenewal({
      invoice: {
        id: "in_real",
        subscription: sub.stripeSubscriptionId,
        billing_reason: "subscription_cycle",
        status: "paid",
        amount_paid: 14900,
        created: Math.floor(Date.now() / 1000),
        period_start: Math.floor(Date.now() / 1000),
        period_end: Math.floor((Date.now() + MONTH_MS) / 1000),
      },
      stripeSubscription: { id: sub.stripeSubscriptionId },
      env: process.env,
    });

    const state = await ledger.trackState(user._id, sub.addressId);
    assert.equal(state.countedMonths, 1);
    assert.equal(state.cycles[0].plan, "basic");
    assert.equal(state.cycles[0].amountPaidCents, 14900);
  });

  await test("a loyalty failure never propagates out of the webhook path", async () => {
    // No subscription exists for this id, which is the shape of a real fault.
    const result = await loyaltyService.recordRenewal({
      invoice: {
        id: "in_orphan",
        subscription: "sub_does_not_exist",
        billing_reason: "subscription_cycle",
        status: "paid",
        created: Math.floor(Date.now() / 1000),
      },
      stripeSubscription: { id: "sub_does_not_exist" },
      env: process.env,
    });
    assert.equal(result, null, "it returns, it does not throw");
  });
}

/* ========================================================================== */

(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: "loyalty_test" });
  await Promise.all([
    LoyaltyCycle.init(),
    LoyaltyGrant.init(),
    VisitEntitlement.init(),
    GiftMembership.init(),
    Subscription.init(),
    User.init(),
  ]);

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
