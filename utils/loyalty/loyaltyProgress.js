const LoyaltyGrant = require("../../models/LoyaltyGrant");
const { addMonths } = require("../gifts/giftPricing");
const { loyaltyActive, effectiveAt, MILESTONE_WINDOWS } = require("./loyaltyConfig");
const {
  isEligibleBillingCycle,
  nextMilestoneAfter,
  normalizePlan,
  planRank,
  rewardForMilestone,
} = require("./loyaltyRules");
const { trackState } = require("./loyaltyLedger");
const { availableLoyaltyFullDays } = require("../fullDayEntitlements");

/**
 * One property's Loyalty Benefits, shaped for a screen.
 *
 * The words live here rather than in the front end, and that is deliberate in
 * three ways. The account page, the cancellation screen and the emails all
 * describe the same reward, so they must not be able to disagree. The ladder can
 * change without a front-end deploy. And the customer never has to work anything
 * out: no counting, no arithmetic, no translating "milestone 6" into what they
 * actually get.
 */

const PLAN_LABEL = { basic: "Basic", plus: "Plus", premium: "Premium", elite: "Elite" };

function planLabel(plan) {
  return PLAN_LABEL[normalizePlan(plan)] || "";
}

function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysBetween(from, to) {
  const start = toDate(from);
  const end = toDate(to);
  if (!start || !end) return null;
  return Math.max(0, Math.ceil((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)));
}

/**
 * How a reward reads to a homeowner.
 *
 * "Complimentary Premium benefits" rather than "free upgrade", because nothing
 * about their own membership changes and calling it an upgrade invites the
 * question of what happens to the plan they are paying for. No dollar figures:
 * the plan difference is not what the benefit is worth to them, and a number we
 * could not defend would cheapen it.
 */
function describeReward(reward) {
  if (!reward) return null;
  if (reward.kind === "free_month") {
    return { headline: "Your next month is on us", detail: "One full month, no charge." };
  }
  if (reward.kind === "loyalty_full_day") {
    return {
      headline: "An extra Full Day",
      detail: "A whole extra day of work at your home, on top of the one Elite includes.",
    };
  }
  const label = planLabel(reward.rewardPlan);
  const months = reward.cycles === 2 ? "2 months" : "1 month";
  return {
    headline: `${months} of complimentary ${label} benefits`,
    detail: `You keep paying your own plan. We treat your home as ${label} for ${
      reward.cycles === 2 ? "two billing months" : "a billing month"
    }.`,
  };
}

/**
 * What the next milestone is likely to pay out.
 *
 * Judged on the lowest plan seen in the window SO FAR alongside the plan they
 * are on now, because that is the best honest answer available before the
 * window closes — and it is the answer that will hold unless they change plan
 * again. A preview that assumed the current plan would overpromise the moment
 * somebody downgraded mid-window.
 */
function previewReward({ milestone, cycles, currentPlan }) {
  if (!milestone) return null;
  if (milestone === 12) return rewardForMilestone(12, null);

  const bounds = MILESTONE_WINDOWS[milestone];
  const seen = cycles
    .slice(bounds.start - 1, bounds.end)
    .map((cycle) => normalizePlan(cycle.plan))
    .filter(Boolean);

  const candidates = [...seen, normalizePlan(currentPlan)].filter(Boolean);
  if (!candidates.length) return null;

  const lowest = candidates.reduce((low, plan) => (planRank(plan) < planRank(low) ? plan : low));
  return rewardForMilestone(milestone, lowest);
}

/** A grant, as the account screen needs to read it. */
function serializeGrant(grant, now = new Date()) {
  const reward = {
    kind: grant.rewardKind,
    rewardPlan: grant.rewardPlan,
    cycles: grant.cycles,
  };
  const described = describeReward(reward);

  return {
    id: String(grant._id),
    milestone: grant.milestone,
    kind: grant.rewardKind,
    headline: described?.headline || "",
    detail: described?.detail || "",
    rewardPlan: grant.rewardPlan || null,
    status: grant.status,
    grantedAt: grant.grantedAt || null,
    effectiveFrom: grant.effectiveFrom || null,
    effectiveUntil: grant.effectiveUntil || null,
    active:
      grant.rewardKind === "tier_upgrade" &&
      grant.status === "granted" &&
      !!grant.effectiveUntil &&
      new Date(grant.effectiveUntil).getTime() > now.getTime(),
    pendingFreeMonth: grant.rewardKind === "free_month" && grant.status === "applied",
  };
}

/**
 * Everything about one property's Loyalty Benefits.
 *
 * Answers for every shape of member, including the ones with nothing to show:
 * an annual member gets the annual framing rather than an empty meter, and a
 * member with no membership at all gets a clean "not applicable" instead of a
 * zero that looks like a punishment.
 */
async function loyaltyStatusForSubscription({
  user,
  subscription,
  now = new Date(),
  env = process.env,
}) {
  const startedAt = effectiveAt(env);
  const base = {
    enabled: loyaltyActive(env),
    programStartedAt: startedAt,
    eligible: false,
    reason: "",
    countedMonths: 0,
    nextMilestone: null,
    monthsRemaining: null,
    daysUntilNextMilestone: null,
    estimatedUnlockDate: null,
    nextReward: null,
    activeBenefits: [],
    loyaltyFullDaysAvailable: 0,
    history: [],
  };

  if (!base.enabled) return { ...base, reason: "program_inactive" };
  if (!subscription?.addressId) return { ...base, reason: "no_membership" };

  if (!isEligibleBillingCycle(subscription.billingCycle)) {
    return {
      ...base,
      reason: "annual_membership",
      annual: {
        headline: "Your loyalty savings are already built in",
        detail: "Annual members pay for 10 months and get 12 — the reward, taken up front.",
      },
    };
  }

  const { cycles, countedMonths } = await trackState(user._id, subscription.addressId);
  const currentPlan = normalizePlan(subscription.subscriptionType);
  const nextMilestone = nextMilestoneAfter(countedMonths);

  const grants = await LoyaltyGrant.find({
    user: user._id,
    addressId: subscription.addressId,
  })
    .sort({ grantedAt: -1 })
    .lean();

  const serialized = grants.map((grant) => serializeGrant(grant, now));
  const fullDays = await availableLoyaltyFullDays({
    user,
    addressId: subscription.addressId,
    now,
  });

  /*
   * When the next benefit arrives, in real dates.
   *
   * "Eighteen days" moves somebody in a way "two months" does not, and the
   * figure is knowable: the current period ends on a date Stripe already told
   * us, and every month after that is one more renewal.
   */
  const periodEnd = toDate(subscription.currentPeriodEnd || subscription.nextPaymentDate);
  const monthsRemaining = nextMilestone ? nextMilestone - countedMonths : null;
  const estimatedUnlockDate =
    nextMilestone && periodEnd && monthsRemaining > 0
      ? addMonths(periodEnd, monthsRemaining - 1)
      : null;

  return {
    ...base,
    eligible: true,
    reason: "",
    addressId: String(subscription.addressId),
    plan: currentPlan,
    countedMonths,
    nextMilestone,
    monthsRemaining,
    daysUntilNextMilestone: daysBetween(now, estimatedUnlockDate),
    estimatedUnlockDate,
    nextReward: nextMilestone
      ? describeReward(previewReward({ milestone: nextMilestone, cycles, currentPlan }))
      : null,
    /*
     * Nothing beyond twelve months has been decided, so nothing is promised.
     * A member who completes the ladder is told they have finished it, which is
     * true, rather than shown an empty meter that implies we forgot.
     */
    ladderComplete: !nextMilestone && countedMonths >= 12,
    activeBenefits: serialized.filter((grant) => grant.active || grant.pendingFreeMonth),
    loyaltyFullDaysAvailable: fullDays.length,
    nextLoyaltyFullDayExpiresAt: fullDays[0]?.expiresAt || null,
    history: serialized.filter((grant) => !["failed"].includes(grant.status)),
  };
}

module.exports = {
  daysBetween,
  describeReward,
  loyaltyStatusForSubscription,
  planLabel,
  previewReward,
  serializeGrant,
};
