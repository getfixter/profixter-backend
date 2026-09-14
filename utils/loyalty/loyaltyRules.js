const {
  MILESTONES,
  MILESTONE_WINDOWS,
  UPGRADE_MAP,
  UPGRADE_CYCLES,
  PLAN_RANK,
  GIFT_SEED_CAP_MONTHS,
} = require("./loyaltyConfig");
// The same month arithmetic that sets a gift's own term, so the two agree.
const { addMonths } = require("../gifts/giftPricing");

/**
 * Every rule Loyalty Benefits runs on, as pure functions.
 *
 * No database, no Stripe, no clock beyond the one passed in, no side effects.
 * That is deliberate and it is the reason the program can be trusted: the rules
 * that decide who gets what are exhaustively testable in milliseconds without a
 * fixture, and anyone auditing a decision can read the rule rather than trace a
 * webhook. Everything that touches the world lives in the modules beside this
 * one and calls in here for the answers.
 */

const MONTHLY = "monthly";

function normalizePlan(value) {
  const plan = String(value || "").trim().toLowerCase();
  return PLAN_RANK[plan] ? plan : null;
}

function planRank(plan) {
  return PLAN_RANK[normalizePlan(plan)] || 0;
}

/* -------------------------------------------------------------------------- */
/* What counts                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Whether a Stripe invoice is a membership renewal.
 *
 * ONE billing_reason, and the rest of the list is not an oversight.
 *
 *  - subscription_create is signing up. Staying is what the program rewards, and
 *    counting the first invoice would put every new member at one month on the
 *    day they joined.
 *  - subscription_update is a plan change. Upgrades run with
 *    proration_behavior "always_invoice" and charge immediately, and the Stripe
 *    billing portal lets a customer do that themselves — so counting it would
 *    hand anyone a way to manufacture months on demand.
 *  - manual, subscription_threshold and everything else is not a monthly
 *    renewal of this membership.
 *
 * The invoice must also be paid and belong to a subscription. A $0 invoice is
 * still paid: Stripe advances a zero-amount invoice straight to paid and emits
 * the same event, which is exactly what happens during the twelve-month free
 * month, and that month is still a month the member stayed.
 */
function isCountableInvoice(invoice) {
  if (!invoice) return false;
  if (!invoice.subscription) return false;
  if (String(invoice.billing_reason || "") !== "subscription_cycle") return false;
  return ["paid"].includes(String(invoice.status || "")) || invoice.paid === true;
}

/**
 * Whether this membership is one the ladder applies to.
 *
 * Annual memberships are excluded, and not only because Pay 10 Get 12 is
 * already their loyalty reward: an annual member has no monthly renewal
 * boundary, so there is no recurring event for the ladder to be earned against.
 * There would be nothing to count even if we wanted to.
 */
function isEligibleBillingCycle(billingCycle) {
  return String(billingCycle || MONTHLY).trim().toLowerCase() === MONTHLY;
}

/**
 * Whether this invoice falls inside the program's life.
 *
 * Anything dated before the effective timestamp is history, and history never
 * counts. This is checked at the single point where a row could be written, so
 * there is exactly one place retroactive credit could enter and it is closed.
 */
function isWithinProgram(invoiceDate, effectiveAt) {
  if (!effectiveAt) return false;
  const at = invoiceDate instanceof Date ? invoiceDate : new Date(invoiceDate);
  if (Number.isNaN(at.getTime())) return false;
  return at.getTime() >= effectiveAt.getTime();
}

/* -------------------------------------------------------------------------- */
/* Continuity                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Whether a gap between two membership periods breaks the run.
 *
 * Measured from the end of the last counted month to the start of the new one,
 * which is the only pair of dates that describes an actual absence. A failed
 * payment recovered a fortnight later produces no gap at all — Stripe keeps the
 * period, the invoice is paid late, and the member never stopped being covered.
 * Somebody who cancelled in June and returned in October produces a real one.
 */
function isContinuityBreak({ previousPeriodEnd, nextPeriodStart, breakDays }) {
  if (!previousPeriodEnd) return false;
  const previous = new Date(previousPeriodEnd).getTime();
  const next = new Date(nextPeriodStart).getTime();
  if (!Number.isFinite(previous) || !Number.isFinite(next)) return false;
  if (next <= previous) return false;
  return next - previous > breakDays * 24 * 60 * 60 * 1000;
}

/* -------------------------------------------------------------------------- */
/* Milestones and windows                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The milestone this month completes, or null.
 *
 * Deliberately exact rather than "at least". Reaching four months does not
 * re-award the three-month benefit, and the ladder stops at twelve: there is no
 * year-two rule yet, so a thirteenth month earns nothing until somebody decides
 * what it should earn.
 */
function milestoneReachedAt(countedMonths) {
  return MILESTONES.includes(countedMonths) ? countedMonths : null;
}

/**
 * Every milestone this member has now earned.
 *
 * NOT the same as milestoneReachedAt, and the difference is a real member.
 *
 * A gift recipient who converts arrives with seeded months already on the
 * ledger, so their first paid renewal can take them from zero straight to four.
 * Asking only "is four a milestone" answers no, and they would silently skip the
 * three-month reward they had plainly earned. The same happens to anybody whose
 * count moves by more than one at a time — a reversal corrected later, for
 * instance.
 *
 * Returning everything they have reached is safe because the grant table's
 * unique index refuses any milestone already awarded, so this can only ever
 * issue what is genuinely outstanding. Ascending, so rewards are granted in the
 * order they were earned.
 */
function milestonesEarnedBy(countedMonths) {
  return MILESTONES.filter((milestone) => countedMonths >= milestone);
}

function nextMilestoneAfter(countedMonths) {
  return MILESTONES.find((milestone) => milestone > countedMonths) || null;
}

/**
 * The months a milestone's reward is judged on.
 *
 * Windows do not overlap, and that is what makes the rule both fair and
 * ungameable. The three-month reward is judged on months one to three; the
 * six-month reward on months four to six only. A member who starts on Basic and
 * legitimately moves to Elite gets a Basic reward for the months they were
 * Basic, and an Elite reward for the window in which they were actually Elite —
 * without any of it being retroactive, and without a late upgrade being able to
 * reach back and improve a window it was not part of.
 */
function windowForMilestone(milestone, cycles) {
  const bounds = MILESTONE_WINDOWS[milestone];
  if (!bounds) return [];
  return cycles.slice(bounds.start - 1, bounds.end);
}

/**
 * The lowest real plan held across a window.
 *
 * Both attacks die here, and neither needs a rule of its own. Buy Elite and
 * drop to Basic: the minimum is Basic. Sit on Basic and upgrade the day before
 * a milestone: the minimum is still Basic. Flip back and forth as often as you
 * like: a minimum does not care about order.
 *
 * The cycles handed in carry the plan that was actually PAID for that month. A
 * temporary loyalty upgrade never reaches this function, because it is never
 * written to a cycle — which is what stops a Plus-by-reward member being
 * treated as having paid for Plus.
 */
function windowMinimumPlan(windowCycles) {
  const plans = windowCycles.map((cycle) => normalizePlan(cycle.plan)).filter(Boolean);
  if (!plans.length) return null;
  return plans.reduce((lowest, plan) => (planRank(plan) < planRank(lowest) ? plan : lowest));
}

/* -------------------------------------------------------------------------- */
/* Rewards                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What a milestone pays out, given the plan the window resolved to.
 *
 * Twelve months is a free month for everybody and needs no plan: the reward is
 * one month of whatever they are legitimately paying for, so it is automatically
 * proportionate without a table.
 *
 * Below that, Elite is the only plan with nowhere to be upgraded to, so it
 * receives an extra Full Day instead — genuinely extra, on top of the one its
 * plan already includes every billing period.
 */
function rewardForMilestone(milestone, windowPlan) {
  if (milestone === 12) {
    return { kind: "free_month" };
  }

  const plan = normalizePlan(windowPlan);
  if (!plan) return null;

  const cycles = UPGRADE_CYCLES[milestone];
  if (!cycles) return null;

  if (plan === "elite") {
    return { kind: "loyalty_full_day", count: 1 };
  }

  const rewardPlan = UPGRADE_MAP[plan];
  if (!rewardPlan) return null;

  return { kind: "tier_upgrade", rewardPlan, cycles };
}

/**
 * How many gifted months carry into a paid membership.
 *
 * Only months the recipient actually received. A gift that was bought but never
 * claimed delivered nothing, and a gift still running has not finished
 * delivering, so neither is counted in full. The cap exists because the schema
 * allows a gift of up to twenty-four months and an uncapped seed would let one
 * generous present land somebody straight on the free month.
 */
function giftSeedMonths({ deliveredMonths, cap = GIFT_SEED_CAP_MONTHS }) {
  const delivered = Math.floor(Number(deliveredMonths) || 0);
  if (delivered <= 0) return 0;
  return Math.min(delivered, cap);
}

/**
 * How much of a gift has actually been delivered by now.
 *
 * Whole months only, measured from the window the gift was given. An unclaimed
 * gift has no window and has delivered nothing; a gift half way through its
 * second month has delivered one.
 */
function giftMonthsDelivered(gift, now = new Date()) {
  if (!gift || gift.status !== "claimed") return 0;
  if (!gift.startAt || !gift.endAt) return 0;

  const start = new Date(gift.startAt);
  const at = new Date(now).getTime();
  const term = Number(gift.durationMonths) || 0;
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(at) || term <= 0) return 0;

  /*
   * Counted in CALENDAR months, using the same arithmetic that set the gift's
   * own window. An average month would be wrong in both directions and wrong
   * most of the year: January to March is fifty-nine days, which is two months
   * of gift but only 1.9 average ones, so a fully delivered two-month gift
   * would have carried one month forward.
   */
  let delivered = 0;
  for (let month = 1; month <= term; month += 1) {
    const boundary = addMonths(start, month);
    if (!boundary || boundary.getTime() > at) break;
    delivered = month;
  }
  return delivered;
}

/* -------------------------------------------------------------------------- */
/* Effective plan                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Whether a grant is delivering a temporary upgrade at this instant.
 *
 * Expiry is a date comparison and nothing else. No job turns these off, so no
 * missed run can leave a benefit running longer than it should or cut one
 * short — the window simply stops containing now.
 */
function isGrantActive(grant, now = new Date()) {
  if (!grant) return false;
  if (grant.rewardKind !== "tier_upgrade") return false;
  if (!["granted"].includes(String(grant.status || ""))) return false;
  const from = grant.effectiveFrom ? new Date(grant.effectiveFrom).getTime() : null;
  const until = grant.effectiveUntil ? new Date(grant.effectiveUntil).getTime() : null;
  if (!Number.isFinite(until)) return false;
  const at = new Date(now).getTime();
  if (Number.isFinite(from) && at < from) return false;
  return at < until;
}

/**
 * The plan a member should be treated as having.
 *
 * Only ever upward. A grant that has been overtaken by a real upgrade — the
 * member bought Premium while holding complimentary Premium — changes nothing,
 * and is left to expire on its own rather than being cancelled, so the record of
 * what they were given survives.
 *
 * Returns the paid plan and the source, because the account screen has to be
 * able to say "complimentary Premium benefits through 14 October" rather than
 * simply claiming they are on Premium.
 */
function resolveEffectivePlan({ paidPlan, grants = [], now = new Date() }) {
  const paid = normalizePlan(paidPlan);
  const active = grants.filter((grant) => isGrantActive(grant, now));

  let best = null;
  for (const grant of active) {
    const rewardPlan = normalizePlan(grant.rewardPlan);
    if (!rewardPlan) continue;
    if (planRank(rewardPlan) <= planRank(paid)) continue;
    if (!best || planRank(rewardPlan) > planRank(best.rewardPlan)) best = grant;
  }

  if (!best) {
    return { plan: paid, paidPlan: paid, source: "paid", grant: null, until: null };
  }

  return {
    plan: normalizePlan(best.rewardPlan),
    paidPlan: paid,
    source: "loyalty",
    grant: best,
    until: best.effectiveUntil || null,
  };
}

module.exports = {
  normalizePlan,
  planRank,
  isCountableInvoice,
  isEligibleBillingCycle,
  isWithinProgram,
  isContinuityBreak,
  milestoneReachedAt,
  milestonesEarnedBy,
  nextMilestoneAfter,
  windowForMilestone,
  windowMinimumPlan,
  rewardForMilestone,
  giftSeedMonths,
  giftMonthsDelivered,
  isGrantActive,
  resolveEffectivePlan,
};
