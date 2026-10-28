/**
 * Admin's completed-visit counts and Loyalty Benefits view, against a real
 * database.
 *
 * Proves the owner sees the same months and rewards the customer is shown, that
 * a date is offered only when the renewal it depends on will happen, and that
 * only finished, started visits are counted.
 *
 *   node scripts/test_admin_loyalty_integration.js
 *
 * Not in `npm test`: it boots a MongoDB binary.
 */

process.env.S3_BUCKET = process.env.S3_BUCKET || "test-bucket";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_fake";
process.env.LOYALTY_ENABLED = "true";
process.env.LOYALTY_EFFECTIVE_AT = "2026-01-01T00:00:00Z";
process.env.LOYALTY_BREAK_DAYS = "45";

const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const Booking = require("../models/Booking");
const LoyaltyCycle = require("../models/LoyaltyCycle");
const LoyaltyGrant = require("../models/LoyaltyGrant");
const Subscription = require("../models/Subscription");
const User = require("../models/User");
const VisitEntitlement = require("../models/VisitEntitlement");

const ledger = require("../utils/loyalty/loyaltyLedger");
const progress = require("../utils/loyalty/loyaltyProgress");
const { addMonths } = require("../utils/gifts/giftPricing");
const { adminLoyaltyForUsers } = require("../utils/loyalty/adminLoyalty");
const { completedBookingCountsForUsers } = require("../utils/customerBookingCounts");

const DAY = 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * DAY;

let passed = 0;
const failures = [];
let mongod;
let seq = 0;

async function test(name, fn) {
  await Promise.all([
    Booking.deleteMany({}),
    LoyaltyCycle.deleteMany({}),
    LoyaltyGrant.deleteMany({}),
    VisitEntitlement.deleteMany({}),
    Subscription.deleteMany({}),
    User.deleteMany({}),
  ]);
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error.stack}`);
  }
}

async function makeUser({ addresses = 1 } = {}) {
  seq += 1;
  return User.create({
    userId: `u${String(seq).padStart(7, "0")}`,
    name: "Jane Doe",
    email: `person${seq}@example.com`,
    phone: "6315991363",
    role: "customer",
    addresses: Array.from({ length: addresses }, (_, i) => ({
      line1: `${i + 1} Main St`,
      city: "Lindenhurst",
      state: "NY",
      zip: "11757",
    })),
  });
}

async function makeSubscription(user, overrides = {}) {
  const address = user.addresses[0];
  const periodStart = overrides.currentPeriodStart || new Date(Date.now() - 5 * DAY);
  const periodEnd = overrides.currentPeriodEnd || new Date(Date.now() + 25 * DAY);
  const { plan, ...rest } = overrides;
  return Subscription.create({
    user: user._id,
    userId: user.userId,
    subscriptionType: plan || "basic",
    billingCycle: "monthly",
    addressId: address._id,
    addressSnapshot: { line1: address.line1, city: address.city, state: address.state, zip: address.zip },
    stripeCustomerId: `cus_${seq}`,
    stripeSubscriptionId: `sub_${seq}_${Math.random().toString(16).slice(2, 8)}`,
    status: "active",
    accessStatus: "active",
    startDate: new Date(Date.now() - 365 * DAY),
    latestPaymentDate: periodStart,
    nextPaymentDate: periodEnd,
    ...rest,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
  });
}

/** Months counted the way the webhook writes them, the last one ending `lastEndsAgo` ago. */
async function addCycles(user, subscription, plans, { lastEndsAgo = 5 * DAY } = {}) {
  const lastEnd = Date.now() - lastEndsAgo;
  for (let i = 0; i < plans.length; i += 1) {
    const monthsBack = plans.length - 1 - i;
    await ledger.recordCycle({
      user: user._id,
      userId: user.userId,
      addressId: subscription.addressId,
      plan: plans[i],
      periodStart: new Date(lastEnd - (monthsBack + 1) * MONTH_MS),
      periodEnd: new Date(lastEnd - monthsBack * MONTH_MS),
      stripeInvoiceId: `in_${subscription.stripeSubscriptionId}_${i}`,
      stripeSubscriptionId: subscription.stripeSubscriptionId,
    });
  }
}

async function loyaltyRow(user) {
  const rows = await adminLoyaltyForUsers([await User.findById(user._id).lean()]);
  assert.equal(rows.length, 1, "one row per property with a membership");
  return rows[0];
}

let bookingSeq = 0;
async function makeBooking(user, overrides = {}) {
  bookingSeq += 1;
  return Booking.create({
    bookingNumber: `B${bookingSeq}`,
    date: new Date(Date.now() - 3 * DAY),
    service: "Handyman visit",
    user: user._id,
    userId: user.userId,
    name: user.name,
    address: "1 Main St",
    phone: "6315991363",
    email: user.email,
    subscription: "basic",
    status: "Completed",
    ...overrides,
  });
}

/* ========================================================================== */

async function run() {
  console.log("\n--- completed visits");

  await test("counts finished, started visits of every kind and nothing else", async () => {
    const user = await makeUser();
    const other = await makeUser();
    await makeBooking(user, { accessType: "membership" });
    await makeBooking(user, { accessType: "one_time", bookingType: "one_time_handyman_visit" });
    await makeBooking(user, { accessType: "free_first_visit" });
    await makeBooking(user, { bookingType: "full_day_visit", status: "done" });
    await makeBooking(user, { status: "completed" });
    await makeBooking(user, { status: "Canceled" });
    await makeBooking(user, { status: "Pending" });
    await makeBooking(user, { status: "Confirmed" });
    await makeBooking(user, { status: "Pending Confirmation" });
    await makeBooking(user, { status: "Completed", date: new Date(Date.now() + 2 * DAY) });
    await makeBooking(other, {});

    const counts = await completedBookingCountsForUsers([user, other, await makeUser()]);
    assert.equal(counts.get(String(user._id)), 5);
    assert.equal(counts.get(String(other._id)), 1);
    assert.equal([...counts.values()].filter((n) => n === 0).length, 1, "a customer with no visits reads 0");
  });

  await test("an older booking carrying only the public userId still counts, once", async () => {
    const user = await makeUser();
    await makeBooking(user, {});
    await Booking.collection.insertOne({
      bookingNumber: "LEGACY",
      date: new Date(Date.now() - 40 * DAY),
      service: "Handyman visit",
      user: null,
      userId: user.userId,
      name: user.name,
      status: "Completed",
    });
    const counts = await completedBookingCountsForUsers([user]);
    assert.equal(counts.get(String(user._id)), 2);
  });

  await test("a guest request with no account is nobody's visit", async () => {
    const user = await makeUser();
    await Booking.collection.insertOne({
      bookingNumber: "GUEST",
      date: new Date(Date.now() - 4 * DAY),
      service: "Free visit",
      user: null,
      userId: "",
      name: user.name,
      email: user.email,
      status: "Completed",
      guestRequestId: new mongoose.Types.ObjectId(),
    });
    const counts = await completedBookingCountsForUsers([user]);
    assert.equal(counts.get(String(user._id)), 0);
  });

  console.log("\n--- loyalty: the owner sees what the customer sees");

  await test("an active member matches the customer's own status exactly", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user, { plan: "premium" });
    await addCycles(user, sub, ["premium", "premium"]);

    const row = await loyaltyRow(user);
    const customer = await progress.loyaltyStatusForSubscription({ user, subscription: sub.toObject() });

    assert.equal(row.loyalty.countedMonths, customer.countedMonths);
    assert.equal(row.loyalty.countedMonths, 2);
    assert.equal(row.loyalty.nextMilestone, 3);
    assert.deepEqual(row.loyalty.nextReward, customer.nextReward);
    assert.equal(row.loyalty.nextReward.headline, "1 month of complimentary Elite benefits");
    assert.equal(row.loyalty.expectedDate, customer.estimatedUnlockDate.toISOString());
    assert.equal(row.loyalty.requirement, "1 more paid monthly renewal.");
    assert.equal(row.loyalty.standing.key, "earning");
    assert.equal(row.membership.planLabel, "Premium");
  });

  await test("a newly registered member: zero months, date is the third renewal", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user, { plan: "basic" });
    const row = await loyaltyRow(user);
    assert.equal(row.loyalty.countedMonths, 0);
    assert.equal(row.loyalty.standing.key, "not_started");
    assert.equal(row.loyalty.monthsRemaining, 3);
    assert.equal(row.loyalty.expectedDate, addMonths(sub.currentPeriodEnd, 2).toISOString());
    assert.equal(row.loyalty.nextReward.headline, "1 month of complimentary Plus benefits");
    assert.equal(row.loyalty.benefitsEarned, 0);
  });

  await test("set to cancel at period end: no date, the requirement instead", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user, { cancelAtPeriodEnd: true });
    await addCycles(user, sub, ["basic", "basic"]);
    const row = await loyaltyRow(user);
    assert.equal(row.membership.state, "ending");
    assert.equal(row.loyalty.expectedDate, null);
    assert.equal(row.loyalty.requirement, "1 more paid monthly renewal.");
    assert.match(row.loyalty.dateNote, /cancel/i);
  });

  await test("cancelling after the milestone still shows the milestone date", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user, { cancellationDate: new Date(Date.now() + 90 * DAY) });
    await addCycles(user, sub, ["basic", "basic"]);
    const row = await loyaltyRow(user);
    assert.equal(row.membership.state, "ending");
    assert.ok(row.loyalty.expectedDate, "milestone falls before the cancellation");
  });

  await test("past due: on hold, no date, progress kept while inside the break window", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user, { status: "past_due", accessStatus: "inactive" });
    await addCycles(user, sub, ["plus", "plus"], { lastEndsAgo: 10 * DAY });
    const row = await loyaltyRow(user);
    assert.equal(row.loyalty.standing.key, "payment_issue");
    assert.equal(row.loyalty.expectedDate, null);
    assert.equal(row.loyalty.countedMonths, 2);
    assert.equal(row.loyalty.continuity.lost, false);
    assert.equal(row.loyalty.previousRunOnly, false);
    assert.equal(row.loyalty.requirement, "1 more paid monthly renewal.");
  });

  await test("canceled long ago: progress shown as it was, flagged as reset on return", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user, {
      status: "canceled",
      accessStatus: "inactive",
      currentPeriodStart: new Date(Date.now() - 110 * DAY),
      currentPeriodEnd: new Date(Date.now() - 80 * DAY),
    });
    await addCycles(user, sub, ["basic", "basic"], { lastEndsAgo: 80 * DAY });
    const row = await loyaltyRow(user);
    assert.equal(row.membership.state, "ended");
    assert.equal(row.loyalty.standing.key, "ended");
    assert.equal(row.loyalty.expectedDate, null);
    assert.equal(row.loyalty.continuity.lost, true);
    // The old months are history, not progress: a return needs all three renewals.
    assert.equal(row.loyalty.previousRunOnly, true);
    assert.equal(row.loyalty.countedMonths, 2);
    assert.equal(row.loyalty.monthsRemaining, 3);
    assert.equal(row.loyalty.requirement, "Membership must restart. Progress starts again at 0, then 3 paid monthly renewals.");
  });

  await test("a manual plan with a lapsed period is not shown as 'not started'", async () => {
    const user = await makeUser();
    await makeSubscription(user, {
      stripeSubscriptionId: null,
      accessStatus: undefined,
      currentPeriodStart: new Date(Date.now() - 170 * DAY),
      currentPeriodEnd: new Date(Date.now() - 140 * DAY),
    });
    const row = await loyaltyRow(user);
    assert.equal(row.membership.state, "renewal_pending");
    assert.equal(row.membership.billedByStripe, false);
    assert.equal(row.loyalty.standing.key, "manual");
    assert.equal(row.loyalty.expectedDate, null);
    assert.match(row.loyalty.requirement, /Not billed through Stripe/);
  });

  await test("a Stripe plan whose renewal is not written yet says so", async () => {
    const user = await makeUser();
    await makeSubscription(user, {
      currentPeriodStart: new Date(Date.now() - 32 * DAY),
      currentPeriodEnd: new Date(Date.now() - 2 * DAY),
    });
    const row = await loyaltyRow(user);
    assert.equal(row.loyalty.standing.key, "renewal_pending");
    assert.equal(row.loyalty.expectedDate, null);
    assert.equal(row.loyalty.requirement, "3 more paid monthly renewals.");
  });

  await test("an annual member is not put on the monthly ladder", async () => {
    const user = await makeUser();
    await makeSubscription(user, { billingCycle: "annual", plan: "elite" });
    const row = await loyaltyRow(user);
    assert.equal(row.loyalty.reason, "annual_membership");
    assert.equal(row.loyalty.standing.key, "annual");
    assert.equal(row.loyalty.expectedDate, null);
    assert.equal(row.loyalty.nextMilestone, null);
  });

  await test("a scheduled downgrade lowers the previewed reward", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user, {
      plan: "premium",
      pendingPlan: "basic",
      pendingChangeEffectiveDate: new Date(Date.now() + 25 * DAY),
    });
    await addCycles(user, sub, ["premium", "premium", "premium"]);
    const row = await loyaltyRow(user);
    assert.equal(row.loyalty.nextMilestone, 6);
    assert.equal(row.loyalty.nextReward.headline, "2 months of complimentary Plus benefits");
    assert.match(row.loyalty.nextRewardBasis, /Basic/);
  });

  await test("earned benefits are listed, a running upgrade is reported beside the paid plan", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user, { plan: "basic" });
    await addCycles(user, sub, ["basic", "basic", "basic", "basic"]);
    await LoyaltyGrant.create({
      user: user._id,
      userId: user.userId,
      addressId: sub.addressId,
      generation: 1,
      milestone: 3,
      rewardKind: "tier_upgrade",
      rewardPlan: "plus",
      cycles: 1,
      effectiveFrom: new Date(Date.now() - 5 * DAY),
      effectiveUntil: new Date(Date.now() + 25 * DAY),
      status: "granted",
    });
    const row = await loyaltyRow(user);
    assert.equal(row.loyalty.benefitsEarned, 1);
    assert.equal(row.loyalty.benefits[0].headline, "1 month of complimentary Plus benefits");
    assert.equal(row.loyalty.standing.key, "benefit_active");
    assert.equal(row.membership.planLabel, "Basic");
    assert.equal(row.membership.complimentaryPlanLabel, "Plus");
    assert.equal(row.loyalty.countedMonths, 4);
    assert.equal(row.loyalty.nextMilestone, 6);
  });

  console.log("\n--- the support view: the whole ladder, durations, benefit states");

  await test("a new Basic member sees every milestone, its reward, length and estimated date", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user, { plan: "basic" });
    const { loyalty } = await loyaltyRow(user);
    const end = sub.currentPeriodEnd;
    const [three, six, twelve] = loyalty.ladder;

    assert.deepEqual(loyalty.ladder.map((rung) => rung.position), ["next", "later", "later"]);
    assert.equal(three.reward.headline, "1 month of complimentary Plus benefits");
    assert.equal(three.duration, "1 billing month of Plus benefits");
    assert.equal(three.estimatedDate, addMonths(end, 2).toISOString());
    assert.equal(three.benefitUntil, addMonths(addMonths(end, 2), 1).toISOString());

    assert.equal(six.reward.headline, "2 months of complimentary Plus benefits");
    assert.equal(six.duration, "2 billing months of Plus benefits");
    assert.equal(six.estimatedDate, addMonths(end, 5).toISOString());

    assert.equal(twelve.reward.headline, "Your next month is on us");
    assert.equal(twelve.estimatedDate, addMonths(end, 11).toISOString());
    assert.equal(twelve.benefitFrom, addMonths(end, 12).toISOString(), "the $0 bill is the one after");

    // The headline next benefit is the ladder's next rung.
    assert.equal(loyalty.expectedDate, three.estimatedDate);
    assert.equal(loyalty.nextRewardDuration, three.duration);
  });

  await test("Elite earns an extra Full Day at 3 and 6, booked within 90 days", async () => {
    const user = await makeUser();
    await makeSubscription(user, { plan: "elite" });
    const { loyalty } = await loyaltyRow(user);
    assert.equal(loyalty.ladder[0].reward.headline, "An extra Full Day");
    assert.equal(loyalty.ladder[0].duration, "Book within 90 days of earning it");
    assert.equal(loyalty.ladder[1].reward.headline, "An extra Full Day");
  });

  await test("set to cancel: rewards are listed but no milestone gets a date", async () => {
    const user = await makeUser();
    await makeSubscription(user, { cancelAtPeriodEnd: true });
    const { loyalty } = await loyaltyRow(user);
    assert.equal(loyalty.ladder.length, 3);
    assert.ok(loyalty.ladder.every((rung) => rung.estimatedDate === null));
    assert.ok(loyalty.ladder.every((rung) => rung.reward));
  });

  await test("earned benefits read as active, upcoming, used or expired from their own records", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user, { plan: "basic" });
    await addCycles(user, sub, Array(12).fill("basic"));
    const base = { user: user._id, userId: user.userId, addressId: sub.addressId };

    await LoyaltyGrant.create({ ...base, generation: 1, milestone: 3, rewardKind: "tier_upgrade", rewardPlan: "plus",
      cycles: 1, status: "granted", grantedAt: new Date(Date.now() - 270 * DAY),
      effectiveFrom: new Date(Date.now() - 270 * DAY), effectiveUntil: new Date(Date.now() - 240 * DAY) });
    await LoyaltyGrant.create({ ...base, generation: 1, milestone: 6, rewardKind: "tier_upgrade", rewardPlan: "plus",
      cycles: 2, status: "granted", grantedAt: new Date(Date.now() - 2 * DAY),
      effectiveFrom: new Date(Date.now() + 3 * DAY), effectiveUntil: new Date(Date.now() + 63 * DAY) });
    await LoyaltyGrant.create({ ...base, generation: 1, milestone: 12, rewardKind: "free_month", status: "applied" });

    const { loyalty, membership } = await loyaltyRow(user);
    const byMilestone = Object.fromEntries(loyalty.benefits.map((row) => [row.milestone, row]));
    assert.equal(byMilestone[3].state, "expired");
    assert.match(byMilestone[3].stateLabel, /^Ended /);
    assert.equal(byMilestone[6].state, "upcoming");
    assert.match(byMilestone[6].stateLabel, /^Starts /);
    assert.equal(byMilestone[6].duration, "2 billing months of Plus benefits");
    assert.equal(byMilestone[12].state, "upcoming");
    assert.equal(byMilestone[12].stateLabel, "Applies to the next monthly bill");
    assert.equal(loyalty.benefitsEarned, 3);
    assert.equal(membership.complimentaryPlanLabel, "", "nothing is running today");

    assert.ok(loyalty.ladder.every((rung) => rung.position === "reached"));
    assert.equal(loyalty.ladder[1].benefitStateLabel, byMilestone[6].stateLabel);
  });

  await test("a used Loyalty Full Day reads as used; a failed grant is flagged and not counted", async () => {
    const user = await makeUser();
    const sub = await makeSubscription(user, { plan: "elite" });
    await addCycles(user, sub, Array(6).fill("elite"));
    const base = { user: user._id, userId: user.userId, addressId: sub.addressId, generation: 1 };
    await LoyaltyGrant.create({ ...base, milestone: 3, rewardKind: "loyalty_full_day", status: "consumed" });
    await LoyaltyGrant.create({ ...base, milestone: 6, rewardKind: "loyalty_full_day", status: "failed", failureReason: "x" });

    const { loyalty } = await loyaltyRow(user);
    const byMilestone = Object.fromEntries(loyalty.benefits.map((row) => [row.milestone, row]));
    assert.equal(byMilestone[3].state, "used");
    assert.equal(byMilestone[6].state, "needs_review");
    assert.equal(loyalty.benefitsEarned, 1);
  });

  await test("detail view lists every property, including one never on a plan", async () => {
    const user = await makeUser({ addresses: 2 });
    await makeSubscription(user, { plan: "plus" });
    const rows = await adminLoyaltyForUsers([await User.findById(user._id).lean()], { allAddresses: true });
    assert.equal(rows.length, 2);
    const bare = rows.find((row) => row.membership.state === "none");
    assert.ok(bare, "the second address has no membership");
    assert.equal(bare.loyalty.standing.key, "none");
    assert.equal(bare.address.line1, "2 Main St");
  });

  await test("program switched off: inert, nothing promised", async () => {
    const user = await makeUser();
    await makeSubscription(user, {});
    const rows = await adminLoyaltyForUsers([await User.findById(user._id).lean()], {
      env: { LOYALTY_ENABLED: "false" },
    });
    assert.equal(rows[0].loyalty.standing.key, "inactive");
    assert.equal(rows[0].loyalty.expectedDate, null);
  });
}

(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  try {
    await run();
  } finally {
    await mongoose.disconnect();
    await mongod.stop();
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
