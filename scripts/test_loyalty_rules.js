/**
 * Loyalty Benefits: every rule that decides who gets what.
 *
 * No database, no network, no Stripe. Each function under test is pure, which
 * is the reason the cases that actually matter — the gaming attempts, the
 * boundary months, the invoice types that must never count — can be checked at
 * all, and checked in milliseconds.
 *
 * The rest of the feature is plumbing. This is where it is right or wrong.
 *
 *   node scripts/test_loyalty_rules.js
 */

const assert = require("node:assert/strict");

const {
  MILESTONES,
  MILESTONE_WINDOWS,
  GIFT_SEED_CAP_MONTHS,
  LOYALTY_FULL_DAY_VALID_DAYS,
  breakDays,
  effectiveAt,
  loyaltyActive,
  retentionOfferEnabled,
} = require("../utils/loyalty/loyaltyConfig");
const {
  giftMonthsDelivered,
  giftSeedMonths,
  isContinuityBreak,
  isCountableInvoice,
  isEligibleBillingCycle,
  isGrantActive,
  isWithinProgram,
  milestoneReachedAt,
  milestonesEarnedBy,
  nextMilestoneAfter,
  planRank,
  resolveEffectivePlan,
  rewardForMilestone,
  windowForMilestone,
  windowMinimumPlan,
} = require("../utils/loyalty/loyaltyRules");
const { describeReward, previewReward } = require("../utils/loyalty/loyaltyProgress");
const { existingDiscountArgs } = require("../utils/loyalty/loyaltyRewards");
const { templateFor } = require("../utils/loyalty/loyaltyNotify");
const { TEMPLATES } = require("../utils/emailService");
const { TEMPLATES: SMS_TEMPLATES } = require("../utils/sms/smsTemplates");
const { SMS_TYPES } = require("../utils/sms/smsTypes");
const dedupe = require("../utils/sms/smsDedupe");

const DAY = 24 * 60 * 60 * 1000;
let passed = 0;

function section(name) {
  console.log(`\n--- ${name}`);
}

function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok    ${name}`);
}

/** A counted month, as the ledger stores it. */
function cycle(sequence, plan) {
  return { sequence, plan, periodStart: new Date(2026, 0, sequence), reversed: false };
}

function run(plans) {
  return plans.map((plan, index) => cycle(index + 1, plan));
}

/* ========================================================================== */
/* What counts as a loyalty month                                             */
/* ========================================================================== */

function testCountableInvoices() {
  section("only a genuine monthly renewal counts");

  check("a subscription_cycle renewal counts", () => {
    assert.equal(
      isCountableInvoice({ subscription: "sub_1", billing_reason: "subscription_cycle", status: "paid" }),
      true
    );
  });

  /*
   * Signing up is not staying. Counting the first invoice would put every new
   * member at one month on the day they joined, and a three-month reward would
   * be two renewals away instead of three.
   */
  check("signing up does NOT count", () => {
    assert.equal(
      isCountableInvoice({ subscription: "sub_1", billing_reason: "subscription_create", status: "paid" }),
      false
    );
  });

  /*
   * The most important line in the feature. Upgrades run with
   * proration_behavior "always_invoice" and charge on the spot, and the Stripe
   * billing portal lets a customer do that themselves — so counting a
   * subscription_update would hand anybody a way to manufacture loyalty months
   * on demand.
   */
  check("an upgrade proration does NOT count", () => {
    assert.equal(
      isCountableInvoice({ subscription: "sub_1", billing_reason: "subscription_update", status: "paid" }),
      false
    );
  });

  check("a manual invoice does NOT count", () => {
    assert.equal(
      isCountableInvoice({ subscription: "sub_1", billing_reason: "manual", status: "paid" }),
      false
    );
  });

  /*
   * A ProFixter project invoice is a real Stripe invoice on the same customer.
   * It has no subscription, which is what keeps kitchens out of the ledger.
   */
  check("a project invoice with no subscription does NOT count", () => {
    assert.equal(
      isCountableInvoice({ subscription: null, billing_reason: "manual", status: "paid" }),
      false
    );
  });

  check("an unpaid renewal does NOT count", () => {
    assert.equal(
      isCountableInvoice({ subscription: "sub_1", billing_reason: "subscription_cycle", status: "open" }),
      false
    );
  });

  /*
   * The twelve-month reward makes one renewal $0, and Stripe advances a
   * zero-amount invoice straight to paid. That month is still a month the
   * member stayed, so it still counts — otherwise the free month would
   * silently cost them a month of progress.
   */
  check("a $0 renewal during the free month DOES count", () => {
    assert.equal(
      isCountableInvoice({
        subscription: "sub_1",
        billing_reason: "subscription_cycle",
        status: "paid",
        amount_paid: 0,
      }),
      true
    );
  });

  check("annual memberships are not eligible", () => {
    assert.equal(isEligibleBillingCycle("annual"), false);
    assert.equal(isEligibleBillingCycle("monthly"), true);
    assert.equal(isEligibleBillingCycle(undefined), true, "missing reads as monthly");
  });
}

/* ========================================================================== */
/* No retroactive credit                                                      */
/* ========================================================================== */

function testProgramWindow() {
  section("nothing before the program started can ever count");
  const started = new Date("2026-10-01T00:00:00Z");

  check("an invoice from before launch is ignored", () => {
    assert.equal(isWithinProgram(new Date("2026-09-30T23:59:59Z"), started), false);
  });

  check("an invoice at the launch instant counts", () => {
    assert.equal(isWithinProgram(started, started), true);
  });

  check("an invoice after launch counts", () => {
    assert.equal(isWithinProgram(new Date("2026-11-01T00:00:00Z"), started), true);
  });

  /*
   * With no effective timestamp there is no such thing as "inside the program",
   * so nothing counts. Failing closed here is what makes a misconfigured deploy
   * inert rather than retroactive.
   */
  check("with no launch date set, nothing counts", () => {
    assert.equal(isWithinProgram(new Date(), null), false);
  });

  check("the program is inert unless both switches are set", () => {
    assert.equal(loyaltyActive({ LOYALTY_ENABLED: "true" }), false, "no date");
    assert.equal(
      loyaltyActive({ LOYALTY_EFFECTIVE_AT: "2026-10-01T00:00:00Z" }),
      false,
      "not enabled"
    );
    assert.equal(
      loyaltyActive({ LOYALTY_ENABLED: "true", LOYALTY_EFFECTIVE_AT: "nonsense" }),
      false,
      "unparseable date"
    );
    assert.equal(
      loyaltyActive({ LOYALTY_ENABLED: "true", LOYALTY_EFFECTIVE_AT: "2026-10-01T00:00:00Z" }),
      true
    );
  });

  check("the effective timestamp parses to the instant given", () => {
    assert.equal(
      effectiveAt({ LOYALTY_EFFECTIVE_AT: "2026-10-01T00:00:00Z" }).toISOString(),
      "2026-10-01T00:00:00.000Z"
    );
    assert.equal(effectiveAt({}), null);
  });
}

/* ========================================================================== */
/* Milestones and windows                                                     */
/* ========================================================================== */

function testMilestones() {
  section("milestones fire once, exactly, and stop at twelve");

  check("3, 6 and 12 are the ladder", () => {
    assert.deepEqual(MILESTONES, [3, 6, 12]);
  });

  check("only the exact month fires a milestone", () => {
    assert.equal(milestoneReachedAt(2), null);
    assert.equal(milestoneReachedAt(3), 3);
    assert.equal(milestoneReachedAt(4), null, "month four does not re-award month three");
    assert.equal(milestoneReachedAt(6), 6);
    assert.equal(milestoneReachedAt(12), 12);
  });

  /*
   * Year two has not been decided, so nothing is promised. A member who
   * completes the ladder earns nothing further until somebody says what a
   * thirteenth month should be worth.
   */
  check("nothing is awarded beyond twelve", () => {
    assert.equal(milestoneReachedAt(13), null);
    assert.equal(milestoneReachedAt(15), null);
    assert.equal(milestoneReachedAt(24), null);
    assert.equal(nextMilestoneAfter(12), null);
  });

  /*
   * A count can move by more than one at a time — a converting gift recipient
   * lands on four in a single event — so "what have they earned" has to be
   * asked as a list, or the three-month reward is skipped in silence.
   */
  check("every earned milestone is offered, not only the exact one", () => {
    assert.deepEqual(milestonesEarnedBy(0), []);
    assert.deepEqual(milestonesEarnedBy(2), []);
    assert.deepEqual(milestonesEarnedBy(3), [3]);
    assert.deepEqual(milestonesEarnedBy(4), [3], "four still owes the three-month reward");
    assert.deepEqual(milestonesEarnedBy(6), [3, 6]);
    assert.deepEqual(milestonesEarnedBy(12), [3, 6, 12]);
  });

  check("the list stops at twelve, like the ladder", () => {
    assert.deepEqual(milestonesEarnedBy(30), [3, 6, 12]);
  });

  check("the next milestone is the next rung up", () => {
    assert.equal(nextMilestoneAfter(0), 3);
    assert.equal(nextMilestoneAfter(3), 6);
    assert.equal(nextMilestoneAfter(7), 12);
  });

  check("windows do not overlap", () => {
    assert.deepEqual(MILESTONE_WINDOWS[3], { start: 1, end: 3 });
    assert.deepEqual(MILESTONE_WINDOWS[6], { start: 4, end: 6 });
    assert.deepEqual(MILESTONE_WINDOWS[12], { start: 7, end: 12 });
  });

  check("a window selects its own months and no others", () => {
    const cycles = run(["basic", "basic", "basic", "elite", "elite", "elite"]);
    assert.deepEqual(
      windowForMilestone(3, cycles).map((c) => c.sequence),
      [1, 2, 3]
    );
    assert.deepEqual(
      windowForMilestone(6, cycles).map((c) => c.sequence),
      [4, 5, 6]
    );
  });
}

/* ========================================================================== */
/* Anti-gaming                                                                */
/* ========================================================================== */

function testWindowMinimum() {
  section("the reward matches the plan they were actually on");

  /*
   * The headline attack: pay for one month of Elite, drop to Basic, then
   * collect Elite-level rewards for the rest of the year.
   */
  check("Elite then Basic yields a Basic reward", () => {
    const cycles = run(["elite", "basic", "basic"]);
    assert.equal(windowMinimumPlan(windowForMilestone(3, cycles)), "basic");
  });

  /*
   * The mirror attack: sit on Basic, upgrade to Elite the day before the
   * milestone, collect an Elite reward for a month of Elite.
   */
  check("Basic then a last-minute Elite upgrade yields a Basic reward", () => {
    const cycles = run(["basic", "basic", "elite"]);
    assert.equal(windowMinimumPlan(windowForMilestone(3, cycles)), "basic");
  });

  check("flipping plans repeatedly changes nothing", () => {
    const cycles = run(["elite", "basic", "elite"]);
    assert.equal(windowMinimumPlan(windowForMilestone(3, cycles)), "basic");
  });

  /*
   * The case the asymmetric rule got wrong, and the reason this rule replaced
   * it. A member who starts on Basic and genuinely becomes Elite must not be
   * locked to Basic rewards for a year of Elite payments.
   */
  check("a legitimate long-term upgrade is recognised in the NEXT window", () => {
    const cycles = run(["basic", "elite", "elite", "elite", "elite", "elite"]);
    assert.equal(
      windowMinimumPlan(windowForMilestone(3, cycles)),
      "basic",
      "months 1-3 included a Basic month, so the first reward is Basic"
    );
    assert.equal(
      windowMinimumPlan(windowForMilestone(6, cycles)),
      "elite",
      "months 4-6 were all Elite, so the second reward is Elite"
    );
  });

  check("staying on one plan resolves to that plan", () => {
    assert.equal(windowMinimumPlan(run(["premium", "premium", "premium"])), "premium");
  });

  check("an empty window resolves to nothing", () => {
    assert.equal(windowMinimumPlan([]), null);
  });

  check("plan ranking is the ladder order", () => {
    assert.ok(planRank("basic") < planRank("plus"));
    assert.ok(planRank("plus") < planRank("premium"));
    assert.ok(planRank("premium") < planRank("elite"));
    assert.equal(planRank("nonsense"), 0);
  });
}

/* ========================================================================== */
/* The ladder                                                                 */
/* ========================================================================== */

function testRewards() {
  section("each plan earns what the ladder promises");

  check("Basic climbs to Plus", () => {
    assert.deepEqual(rewardForMilestone(3, "basic"), {
      kind: "tier_upgrade",
      rewardPlan: "plus",
      cycles: 1,
    });
    assert.deepEqual(rewardForMilestone(6, "basic"), {
      kind: "tier_upgrade",
      rewardPlan: "plus",
      cycles: 2,
    });
  });

  check("Plus climbs to Premium", () => {
    assert.equal(rewardForMilestone(3, "plus").rewardPlan, "premium");
    assert.equal(rewardForMilestone(6, "plus").cycles, 2);
  });

  check("Premium climbs to Elite", () => {
    assert.equal(rewardForMilestone(3, "premium").rewardPlan, "elite");
    assert.equal(rewardForMilestone(6, "premium").rewardPlan, "elite");
  });

  /* Elite has nowhere to climb, so it receives a Full Day instead. */
  check("Elite receives a Full Day at 3 and another at 6", () => {
    assert.deepEqual(rewardForMilestone(3, "elite"), { kind: "loyalty_full_day", count: 1 });
    assert.deepEqual(rewardForMilestone(6, "elite"), { kind: "loyalty_full_day", count: 1 });
  });

  check("twelve months is a free month for everybody", () => {
    for (const plan of ["basic", "plus", "premium", "elite", null]) {
      assert.deepEqual(rewardForMilestone(12, plan), { kind: "free_month" });
    }
  });

  check("no plan means no tier reward", () => {
    assert.equal(rewardForMilestone(3, null), null);
  });
}

/* ========================================================================== */
/* Continuity                                                                 */
/* ========================================================================== */

function testContinuity() {
  section("payment trouble is not a break; leaving is");

  const base = new Date("2026-06-01T00:00:00Z");
  const after = (days) => new Date(base.getTime() + days * DAY);

  check("a normal back-to-back renewal is not a break", () => {
    assert.equal(
      isContinuityBreak({ previousPeriodEnd: base, nextPeriodStart: base, breakDays: 45 }),
      false
    );
  });

  /*
   * Dunning. Stripe retries a failed invoice over several weeks and the member
   * never stopped being covered, so recovering must not cost them progress.
   */
  check("a payment recovered three weeks later is not a break", () => {
    assert.equal(
      isContinuityBreak({ previousPeriodEnd: base, nextPeriodStart: after(21), breakDays: 45 }),
      false
    );
  });

  check("forty-five days exactly is not a break", () => {
    assert.equal(
      isContinuityBreak({ previousPeriodEnd: base, nextPeriodStart: after(45), breakDays: 45 }),
      false
    );
  });

  check("leaving for four months is a break", () => {
    assert.equal(
      isContinuityBreak({ previousPeriodEnd: base, nextPeriodStart: after(120), breakDays: 45 }),
      true
    );
  });

  check("a first-ever month is never a break", () => {
    assert.equal(
      isContinuityBreak({ previousPeriodEnd: null, nextPeriodStart: base, breakDays: 45 }),
      false
    );
  });

  check("the break window is configurable and defaults to 45 days", () => {
    assert.equal(breakDays({}), 45);
    assert.equal(breakDays({ LOYALTY_BREAK_DAYS: "60" }), 60);
    assert.equal(breakDays({ LOYALTY_BREAK_DAYS: "nonsense" }), 45);
  });
}

/* ========================================================================== */
/* Gift conversion                                                            */
/* ========================================================================== */

function testGiftSeeding() {
  section("delivered gift months carry into a paid membership");

  check("a two-month gift seeds two months", () => {
    assert.equal(giftSeedMonths({ deliveredMonths: 2 }), 2);
  });

  /*
   * The schema allows a gift of up to twenty-four months. Uncapped, one
   * generous present would land somebody straight on the free month.
   */
  check("a long gift is capped", () => {
    assert.equal(GIFT_SEED_CAP_MONTHS, 3);
    assert.equal(giftSeedMonths({ deliveredMonths: 12 }), 3);
    assert.equal(giftSeedMonths({ deliveredMonths: 24 }), 3);
  });

  check("nothing delivered seeds nothing", () => {
    assert.equal(giftSeedMonths({ deliveredMonths: 0 }), 0);
    assert.equal(giftSeedMonths({ deliveredMonths: -1 }), 0);
  });

  const claimed = {
    status: "claimed",
    startAt: new Date("2026-01-01T00:00:00Z"),
    endAt: new Date("2026-03-01T00:00:00Z"),
    durationMonths: 2,
  };

  check("a fully delivered two-month gift counts two", () => {
    assert.equal(giftMonthsDelivered(claimed, new Date("2026-03-02T00:00:00Z")), 2);
  });

  check("a gift halfway through its second month counts one", () => {
    assert.equal(giftMonthsDelivered(claimed, new Date("2026-02-14T00:00:00Z")), 1);
  });

  /* Bought but never claimed delivered nothing, so it carries nothing. */
  check("an unclaimed gift counts zero", () => {
    assert.equal(
      giftMonthsDelivered({ status: "invited", durationMonths: 2 }, new Date("2026-06-01Z")),
      0
    );
  });

  check("a queued gift that has not started counts zero", () => {
    assert.equal(giftMonthsDelivered(claimed, new Date("2025-12-01T00:00:00Z")), 0);
  });

  check("delivery never exceeds what was bought", () => {
    assert.equal(giftMonthsDelivered(claimed, new Date("2027-01-01T00:00:00Z")), 2);
  });
}

/* ========================================================================== */
/* The effective plan                                                         */
/* ========================================================================== */

function testEffectivePlan() {
  section("a temporary upgrade raises the plan, and only ever raises it");

  const now = new Date("2026-06-15T00:00:00Z");
  const live = {
    rewardKind: "tier_upgrade",
    status: "granted",
    rewardPlan: "premium",
    effectiveFrom: new Date("2026-06-01T00:00:00Z"),
    effectiveUntil: new Date("2026-07-01T00:00:00Z"),
  };

  check("a live grant raises the plan", () => {
    const result = resolveEffectivePlan({ paidPlan: "plus", grants: [live], now });
    assert.equal(result.plan, "premium");
    assert.equal(result.paidPlan, "plus", "what they pay for is unchanged");
    assert.equal(result.source, "loyalty");
  });

  /*
   * Expiry is a date comparison and nothing else. No job turns these off, so a
   * missed run can neither extend a benefit nor cut one short.
   */
  check("an expired grant applies to nothing", () => {
    const result = resolveEffectivePlan({
      paidPlan: "plus",
      grants: [live],
      now: new Date("2026-07-01T00:00:01Z"),
    });
    assert.equal(result.plan, "plus");
    assert.equal(result.source, "paid");
  });

  check("a grant that has not started yet applies to nothing", () => {
    const result = resolveEffectivePlan({
      paidPlan: "plus",
      grants: [live],
      now: new Date("2026-05-20T00:00:00Z"),
    });
    assert.equal(result.plan, "plus");
  });

  /*
   * Never downward. A member who buys Elite while holding complimentary Premium
   * must not be dragged back to Premium by their own reward.
   */
  check("a grant below the paid plan never lowers it", () => {
    const result = resolveEffectivePlan({ paidPlan: "elite", grants: [live], now });
    assert.equal(result.plan, "elite");
    assert.equal(result.source, "paid");
  });

  check("the highest live grant wins", () => {
    const lower = { ...live, rewardPlan: "plus" };
    const result = resolveEffectivePlan({ paidPlan: "basic", grants: [lower, live], now });
    assert.equal(result.plan, "premium");
  });

  check("a failed or consumed grant is not live", () => {
    assert.equal(isGrantActive({ ...live, status: "failed" }, now), false);
    assert.equal(isGrantActive({ ...live, status: "expired" }, now), false);
    assert.equal(isGrantActive({ ...live, rewardKind: "free_month" }, now), false);
  });

  check("no grants leaves the paid plan exactly as it was", () => {
    const result = resolveEffectivePlan({ paidPlan: "basic", grants: [], now });
    assert.equal(result.plan, "basic");
    assert.equal(result.source, "paid");
  });
}

/* ========================================================================== */
/* Protecting a member's existing discount                                    */
/* ========================================================================== */

function testDiscountPreservation() {
  section("a member's own promotion code survives the free month");

  check("an existing coupon is listed back, not dropped", () => {
    const result = existingDiscountArgs({
      discounts: [{ coupon: { id: "co_member", duration: "forever" } }],
    });
    assert.deepEqual(result.args, [{ coupon: "co_member" }]);
    assert.deepEqual(result.ids, ["co_member"]);
  });

  check("a promotion code is preserved as a promotion code", () => {
    const result = existingDiscountArgs({
      discounts: [{ promotion_code: "promo_x", coupon: { id: "co_x" } }],
    });
    assert.deepEqual(result.args, [{ promotion_code: "promo_x" }]);
  });

  /* Stripe exposes both shapes depending on age, and both have to be read. */
  check("the legacy single discount field is read too", () => {
    const result = existingDiscountArgs({ discount: { coupon: { id: "co_legacy" } } });
    assert.deepEqual(result.args, [{ coupon: "co_legacy" }]);
  });

  check("the same discount in both shapes is not duplicated", () => {
    const result = existingDiscountArgs({
      discounts: [{ coupon: { id: "co_same" } }],
      discount: { coupon: { id: "co_same" } },
    });
    assert.equal(result.args.length, 1);
  });

  check("no discounts produces an empty list, not a crash", () => {
    assert.deepEqual(existingDiscountArgs({}).args, []);
    assert.deepEqual(existingDiscountArgs(null).args, []);
  });

  /* Re-listing a repeating coupon may restart it, so it is flagged. */
  check("a repeating coupon is reported for review", () => {
    const result = existingDiscountArgs({
      discounts: [{ coupon: { id: "co_rep", duration: "repeating", duration_in_months: 3 } }],
    });
    assert.deepEqual(result.repeating, ["co_rep"]);
  });

  /* An already-free subscription must not be given a second free month. */
  check("an existing 100% discount blocks a second one", () => {
    const result = existingDiscountArgs({
      discounts: [{ coupon: { id: "co_free", percent_off: 100 } }],
    });
    assert.equal(result.fullyDiscounted, true);
  });

  /*
   * What live Stripe actually returns. `discounts` comes back as bare ids
   * unless expanded, and "di_1ABC" says nothing about whether it is a coupon or
   * a promotion code — so it cannot be listed back. Silently skipping it would
   * DELETE a member's discount, which is the exact failure this whole function
   * exists to prevent. It has to be reported so the caller expands and retries.
   */
  check("a bare discount id is reported, never silently skipped", () => {
    const result = existingDiscountArgs({ discounts: ["di_1ABC"] });
    assert.deepEqual(result.unresolved, ["di_1ABC"]);
    assert.deepEqual(result.args, [], "and it is NOT invented as a coupon id");
  });

  check("an expanded discount leaves nothing unresolved", () => {
    const result = existingDiscountArgs({
      discounts: [{ id: "di_1ABC", coupon: { id: "co_real", duration: "once" } }],
    });
    assert.deepEqual(result.unresolved, []);
    assert.deepEqual(result.args, [{ coupon: "co_real" }]);
  });

  check("an object with no coupon or promotion code is reported too", () => {
    const result = existingDiscountArgs({ discounts: [{ id: "di_odd" }] });
    assert.deepEqual(result.unresolved, ["di_odd"]);
  });

  check("a plain subscription still resolves cleanly", () => {
    const result = existingDiscountArgs({});
    assert.deepEqual(result.unresolved, []);
    assert.deepEqual(result.args, []);
  });
}

/* ========================================================================== */
/* Customer-facing words                                                      */
/* ========================================================================== */

function testCopy() {
  section("the customer is told what they got, not what the system did");

  check("a one-cycle upgrade reads as one month of that plan", () => {
    const copy = describeReward({ kind: "tier_upgrade", rewardPlan: "premium", cycles: 1 });
    assert.match(copy.headline, /1 month of complimentary Premium benefits/);
  });

  check("a two-cycle upgrade reads as two months", () => {
    const copy = describeReward({ kind: "tier_upgrade", rewardPlan: "plus", cycles: 2 });
    assert.match(copy.headline, /2 months of complimentary Plus benefits/);
  });

  /*
   * The copy has to say the paid plan is untouched, because the first thought
   * on reading "upgrade" is "what am I being charged now".
   */
  check("the upgrade copy says their own plan is unchanged", () => {
    const copy = describeReward({ kind: "tier_upgrade", rewardPlan: "plus", cycles: 1 });
    assert.match(copy.detail, /keep paying your own plan/i);
  });

  check("a Full Day reads as extra, not as a replacement", () => {
    const copy = describeReward({ kind: "loyalty_full_day" });
    assert.match(copy.headline, /extra Full Day/i);
    assert.match(copy.detail, /on top of/i);
  });

  check("the free month reads plainly", () => {
    assert.match(describeReward({ kind: "free_month" }).headline, /next month is on us/i);
  });

  /* No invented dollar values anywhere. */
  check("no reward copy quotes a price", () => {
    const all = [
      describeReward({ kind: "tier_upgrade", rewardPlan: "elite", cycles: 2 }),
      describeReward({ kind: "loyalty_full_day" }),
      describeReward({ kind: "free_month" }),
    ];
    for (const copy of all) {
      assert.doesNotMatch(`${copy.headline} ${copy.detail}`, /\$\d/);
    }
  });

  /*
   * The preview must not overpromise. A member who downgraded mid-window is
   * shown the reward the window will actually produce.
   */
  check("the preview uses the lowest plan seen so far, not today's plan", () => {
    const cycles = run(["basic", "basic"]);
    const reward = previewReward({ milestone: 3, cycles, currentPlan: "elite" });
    assert.equal(reward.rewardPlan, "plus", "two Basic months cap the window at Basic");
  });

  check("the preview of a fresh window follows the current plan", () => {
    const reward = previewReward({ milestone: 3, cycles: [], currentPlan: "premium" });
    assert.equal(reward.rewardPlan, "elite");
  });
}

/* ========================================================================== */
/* Configuration                                                              */
/* ========================================================================== */

/* ========================================================================== */
/* Congratulations                                                            */
/* ========================================================================== */

function testCongratulationRouting() {
  section("every reward has its own congratulation, and only its own");

  const cases = [
    ["tier_upgrade", 3, "loyalty_upgrade_month_3", "LOYALTY_UPGRADE_UNLOCKED_3"],
    ["tier_upgrade", 6, "loyalty_upgrade_month_6", "LOYALTY_UPGRADE_UNLOCKED_6"],
    ["loyalty_full_day", 3, "loyalty_full_day_month_3", "LOYALTY_FULL_DAY_UNLOCKED_3"],
    ["loyalty_full_day", 6, "loyalty_full_day_month_6", "LOYALTY_FULL_DAY_UNLOCKED_6"],
    ["free_month", 12, "loyalty_free_month", "LOYALTY_FREE_MONTH_UNLOCKED"],
  ];

  check("all five rewards route to their own email template", () => {
    for (const [rewardKind, milestone, template] of cases) {
      assert.equal(templateFor({ rewardKind, milestone }), template, `${rewardKind}:${milestone}`);
    }
  });

  check("all five rewards have their own SMS body", () => {
    for (const [, , , smsType] of cases) {
      assert.equal(typeof SMS_TEMPLATES[smsType], "function", smsType);
    }
  });

  check("all five SMS types are registered as transactional", () => {
    for (const [, , , smsType] of cases) {
      assert.ok(SMS_TYPES[smsType], `${smsType} is not a known type`);
      assert.equal(SMS_TYPES[smsType].channelClass, "transactional", smsType);
    }
  });

  /*
   * A reward shape nobody has defined a message for must produce silence, not
   * a half-written congratulation. Year two is exactly that case.
   */
  check("an unknown reward shape sends nothing", () => {
    assert.equal(templateFor({ rewardKind: "tier_upgrade", milestone: 12 }), null);
    assert.equal(templateFor({ rewardKind: "free_month", milestone: 3 }), null);
    assert.equal(templateFor({}), null);
  });

  check("the congratulation is keyed on the grant, so it cannot repeat", () => {
    const grant = { _id: "grant123" };
    const key = dedupe.loyaltyGrantKey("LOYALTY_FREE_MONTH_UNLOCKED", grant);
    assert.equal(key, "LOYALTY_FREE_MONTH_UNLOCKED:loyalty_grant_grant123");
    assert.equal(dedupe.loyaltyGrantKey("LOYALTY_FREE_MONTH_UNLOCKED", grant), key, "stable");
    assert.notEqual(key, dedupe.loyaltyGrantKey("LOYALTY_FREE_MONTH_UNLOCKED", { _id: "grant999" }));
  });
}

function testSmsCopy() {
  section("the texts say the approved thing, and stay in one segment");

  const render = (type, vars) => SMS_TEMPLATES[type](vars);

  check("the 3-month text names the plan and says no extra cost", () => {
    const body = render("LOYALTY_UPGRADE_UNLOCKED_3", { rewardPlan: "Plus" });
    assert.match(body, /complimentary Plus benefits/);
    assert.match(body, /no extra cost/);
    assert.match(body, /Already active/);
  });

  check("the 6-month text leads with TWO months", () => {
    const body = render("LOYALTY_UPGRADE_UNLOCKED_6", { rewardPlan: "Premium" });
    assert.match(body, /2 months of complimentary Premium benefits/);
  });

  check("both Full Day texts say the day is EXTRA and on top of Elite's", () => {
    for (const type of ["LOYALTY_FULL_DAY_UNLOCKED_3", "LOYALTY_FULL_DAY_UNLOCKED_6"]) {
      const body = render(type, { useByDate: "Dec 13" });
      assert.match(body, /extra Full Day/);
      assert.match(body, /on top of the one Elite includes/);
      assert.match(body, /Use it by Dec 13/);
    }
  });

  check("the 6-month Full Day text says SECOND, as approved", () => {
    assert.match(render("LOYALTY_FULL_DAY_UNLOCKED_6", {}), /your second extra Full Day/i);
    assert.doesNotMatch(render("LOYALTY_FULL_DAY_UNLOCKED_6", {}), /another Full Day/i);
  });

  check("a missing use-by date leaves no dangling sentence", () => {
    const body = render("LOYALTY_FULL_DAY_UNLOCKED_3", {});
    assert.doesNotMatch(body, /Use it by\s*\./);
    assert.doesNotMatch(body, /\s{2,}/, "no double spaces where the date would have been");
  });

  check("the free-month text never says coupon or code", () => {
    const body = render("LOYALTY_FREE_MONTH_UNLOCKED", { renewalDate: "Oct 14" });
    assert.match(body, /your next month is on us/i);
    assert.match(body, /Oct 14 renewal will be \$0/);
    assert.doesNotMatch(body, /coupon|promo|code|discount/i);
  });

  /*
   * ONE EMOJI COSTS A SEGMENT. Anything outside GSM-7 forces the whole body to
   * UCS-2, cutting 160 characters to 70 and roughly tripling what these cost to
   * send. The owner's draft used an emoji; this is why the final copy does not.
   */
  check("no Loyalty text leaves GSM-7", () => {
    const GSM7 =
      "@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
      "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà" +
      "\n\r\f^{}\\[~]|€";
    for (const [type] of Object.entries(SMS_TEMPLATES)) {
      if (!type.startsWith("LOYALTY_")) continue;
      const body = SMS_TEMPLATES[type]({
        rewardPlan: "Premium",
        useByDate: "Dec 13",
        renewalDate: "Oct 14",
      });
      const bad = [...body].filter((ch) => !GSM7.includes(ch));
      assert.deepEqual(bad, [], `${type} contains non-GSM-7: ${bad.join(" ")}`);
    }
  });

  check("every Loyalty text fits one segment", () => {
    for (const type of Object.keys(SMS_TEMPLATES)) {
      if (!type.startsWith("LOYALTY_")) continue;
      const body = SMS_TEMPLATES[type]({
        rewardPlan: "Premium",
        useByDate: "Dec 13",
        renewalDate: "Oct 14",
      });
      assert.ok(body.length <= 160, `${type} is ${body.length} chars: ${body}`);
    }
  });

  check("every Loyalty text carries the account link", () => {
    for (const type of Object.keys(SMS_TEMPLATES)) {
      if (!type.startsWith("LOYALTY_")) continue;
      assert.match(SMS_TEMPLATES[type]({}), /profixter\.com\/account/);
    }
  });
}

function testEmailCopy() {
  section("the emails say the approved thing");

  const render = (key, vars) => TEMPLATES[key]({ name: "Sam", ...vars });

  check("no Loyalty subject line carries an emoji, as approved", () => {
    for (const key of Object.keys(templateFor.EMAIL_TEMPLATE || {})) void key;
    for (const key of [
      "loyalty_upgrade_month_3",
      "loyalty_upgrade_month_6",
      "loyalty_full_day_month_3",
      "loyalty_full_day_month_6",
      "loyalty_free_month",
    ]) {
      const { subject } = render(key, { rewardPlan: "Plus", currentPlan: "Basic" });
      assert.doesNotMatch(subject, /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u, `${key}: ${subject}`);
    }
  });

  check("the upgrade emails state the paid plan is unchanged", () => {
    for (const key of ["loyalty_upgrade_month_3", "loyalty_upgrade_month_6"]) {
      const { html } = render(key, { rewardPlan: "Premium", currentPlan: "Plus" });
      assert.match(html, /unchanged/);
      assert.match(html, /Premium/);
    }
  });

  check("the 6-month email makes two months prominent", () => {
    const { subject, html } = render("loyalty_upgrade_month_6", { rewardPlan: "Elite" });
    assert.match(subject, /^Two months of complimentary Elite benefits are yours$/);
    assert.match(html, /<strong>two<\/strong>/);
  });

  check("the Full Day emails do not promise open scheduling, as approved", () => {
    for (const key of ["loyalty_full_day_month_3", "loyalty_full_day_month_6"]) {
      const { html, text } = render(key, { useByDate: "December 13, 2026" });
      assert.doesNotMatch(`${html} ${text}`, /whenever suits you/i);
      assert.match(html, /now available through your membership/);
      assert.match(html, /on top of the one/);
      assert.match(html, /December 13, 2026/);
    }
  });

  check("the 6-month Full Day email says SECOND, as approved", () => {
    const { subject, html } = render("loyalty_full_day_month_6", {});
    assert.match(subject, /second extra Full Day/);
    assert.match(html, /Your second extra Full Day/);
  });

  check("the free-month email uses the approved opening and never says coupon", () => {
    const { subject, html } = render("loyalty_free_month", {
      renewalDate: "October 14, 2026",
      currentPlan: "Basic",
    });
    assert.equal(subject, "Your next month is on us");
    assert.match(html, /You've been a Profixter member for a full year\. Thank you for staying with us\./);
    assert.doesNotMatch(html, /A full year looking after your home together/);
    assert.doesNotMatch(html, /coupon|promo code/i);
    assert.match(html, /October 14, 2026 renewal will come to \$0/);
    assert.match(html, /nothing to enter and nothing to do/);
  });

  check("every Loyalty email links to the account", () => {
    for (const key of [
      "loyalty_upgrade_month_3",
      "loyalty_upgrade_month_6",
      "loyalty_full_day_month_3",
      "loyalty_full_day_month_6",
      "loyalty_free_month",
    ]) {
      assert.match(render(key, { rewardPlan: "Plus" }).html, /profixter\.com\/account\?tab=plan/);
    }
  });
}

function testConfig() {
  section("the switches behave as documented");

  check("a Loyalty Full Day lasts 90 days", () => {
    assert.equal(LOYALTY_FULL_DAY_VALID_DAYS, 90);
  });

  check("the 30% offer stays on unless explicitly turned off", () => {
    assert.equal(retentionOfferEnabled({}), true, "absent means today's behaviour");
    assert.equal(retentionOfferEnabled({ RETENTION_OFFER_ENABLED: "false" }), false);
    assert.equal(retentionOfferEnabled({ RETENTION_OFFER_ENABLED: "true" }), true);
  });
}

/* ========================================================================== */

function main() {
  testCountableInvoices();
  testProgramWindow();
  testMilestones();
  testWindowMinimum();
  testRewards();
  testContinuity();
  testGiftSeeding();
  testEffectivePlan();
  testDiscountPreservation();
  testCopy();
  testCongratulationRouting();
  testSmsCopy();
  testEmailCopy();
  testConfig();
  console.log(`\nLoyalty rules: ${passed} passed, 0 failed.`);
}

main();
