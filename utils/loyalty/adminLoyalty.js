const LoyaltyGrant = require("../../models/LoyaltyGrant");
const Subscription = require("../../models/Subscription");
const VisitEntitlement = require("../../models/VisitEntitlement");
const { addMonths } = require("../gifts/giftPricing");
const { selectCurrentSubscription } = require("../subscriptionManagement");
const {
  LOYALTY_FULL_DAY_VALID_DAYS,
  MILESTONES,
  breakDays,
  effectiveAt,
  loyaltyActive,
} = require("./loyaltyConfig");
const { normalizePlan, planRank, rewardForMilestone } = require("./loyaltyRules");
const { trackState } = require("./loyaltyLedger");
const {
  describeReward,
  loyaltyStatusForSubscription,
  planLabel,
  previewReward,
} = require("./loyaltyProgress");

/**
 * Loyalty Benefits as the owner needs to read them.
 *
 * BUILT ON THE CUSTOMER'S OWN ANSWER, NOT BESIDE IT. Every figure the member can
 * see - months counted, next milestone, the reward - comes from
 * loyaltyStatusForSubscription, the function their account screen calls. Admin
 * cannot drift from what the customer is told because it never recomputes it.
 *
 * What this adds is what only the owner needs: which state the membership is
 * really in, whether the expected date can be trusted, and what happens to the
 * progress if the member has stopped paying.
 *
 * NO DATE THAT WE CANNOT STAND BEHIND. A milestone is earned at a renewal, so a
 * date is only shown when the membership is active, its billing period is
 * current, and nothing on record stops that renewal happening. In every other
 * case the screen says what is still required instead.
 *
 * Read only. Nothing here writes, and nothing here calls Stripe.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const ENDED_STATUSES = new Set(["canceled", "expired", "incomplete_expired"]);
const PAYMENT_ISSUE_STATUSES = new Set(["past_due", "unpaid", "incomplete"]);

function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function iso(value) {
  const date = toDate(value);
  return date ? date.toISOString() : null;
}

/** "November 15, 2026", in New York, the way every other Admin date reads. */
function nyDay(date) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/**
 * What the membership is doing right now, in one word.
 *
 * Read from the stored record only, the same record the customer's screen reads.
 * A billing period that has already ended on an "active" record means the
 * renewal has not been written yet; it is reported as such rather than guessed.
 */
function membershipState(subscription, now = new Date()) {
  if (!subscription) return "none";
  const status = String(subscription.status || "").trim().toLowerCase();
  if (ENDED_STATUSES.has(status)) return "ended";
  if (status === "paused") return "paused";
  if (PAYMENT_ISSUE_STATUSES.has(status)) return "payment_issue";

  const periodEnd = toDate(subscription.currentPeriodEnd || subscription.nextPaymentDate);
  const cancelsOn = cancellationInstant(subscription);
  if (cancelsOn && cancelsOn.getTime() <= now.getTime()) return "ended";
  if (cancelsOn) return "ending";
  if (periodEnd && periodEnd.getTime() <= now.getTime()) return "renewal_pending";
  return "active";
}

/**
 * When the membership stops, if it has been told to.
 *
 * Cancel-at-period-end stops at the period end. An owner's "cancel on day" is
 * stored as cancellationDate on a record that is otherwise still active.
 */
function cancellationInstant(subscription) {
  if (!subscription) return null;
  if (subscription.cancelAtPeriodEnd) {
    return toDate(subscription.currentPeriodEnd || subscription.cancellationDate);
  }
  const status = String(subscription.status || "").trim().toLowerCase();
  if (["active", "trialing"].includes(status)) return toDate(subscription.cancellationDate);
  return null;
}

/**
 * The expected date, or the reason there is none.
 *
 * The milestone lands on a renewal, so the date only stands if that renewal will
 * happen. A cancellation is respected exactly: a member cancelling on 31
 * December still reaches a milestone due on 15 December, and does not reach one
 * due on the day the membership stops, because no renewal is billed that day.
 */
function expectedDateFor({ state, estimatedUnlockDate, cancelsOn }) {
  const estimate = toDate(estimatedUnlockDate);
  if (!estimate) return { date: null, note: "" };

  if (state === "active") return { date: estimate, note: "" };
  if (state === "ending") {
    if (cancelsOn && estimate.getTime() < cancelsOn.getTime()) return { date: estimate, note: "" };
    return { date: null, note: "Set to cancel before this benefit is reached." };
  }
  if (state === "renewal_pending") {
    return { date: null, note: "The last billing period has ended and the renewal is not on record yet." };
  }
  if (state === "paused") return { date: null, note: "No date while the membership is paused." };
  if (state === "payment_issue") return { date: null, note: "No date until the outstanding payment is made." };
  if (state === "ended") return { date: null, note: "No date: the membership has ended." };
  return { date: null, note: "" };
}

/** Who they are in the program, as a label and a tone for the badge. */
/** A live membership with no Stripe subscription behind it: set up by hand in Admin. */
function manualMembership(subscription, state) {
  return !!subscription && !subscription.stripeSubscriptionId && !["none", "ended"].includes(state);
}

function standingFor({ reason, state, status, cancelsOn, manual = false }) {
  if (reason === "program_inactive") return { key: "inactive", label: "Program not active", tone: "neutral" };
  if (reason === "annual_membership") return { key: "annual", label: "Annual plan", tone: "neutral" };
  if (state === "none") return { key: "none", label: "No membership", tone: "neutral" };
  if (state === "ended") return { key: "ended", label: "Membership ended", tone: "danger" };
  if (state === "paused") return { key: "paused", label: "Paused, not earning", tone: "warning" };
  if (state === "payment_issue") return { key: "payment_issue", label: "On hold, payment issue", tone: "warning" };
  if (manual) return { key: "manual", label: "Manual plan, not earning", tone: "warning" };
  if (state === "renewal_pending") return { key: "renewal_pending", label: "Renewal not on record", tone: "warning" };
  if (state === "ending") return { key: "ending", label: "Cancels soon", tone: "warning", cancelsOn: iso(cancelsOn) };
  if (status.activeBenefits?.some((benefit) => benefit.active)) {
    return { key: "benefit_active", label: "Benefit running", tone: "success" };
  }
  if (status.ladderComplete) return { key: "complete", label: "All benefits earned", tone: "success" };
  if (!status.countedMonths) return { key: "not_started", label: "Not started yet", tone: "info" };
  return { key: "earning", label: "Earning", tone: "info" };
}

/**
 * What happens to the progress if the member has stopped paying.
 *
 * A gap longer than the break window starts a new run at zero. The run is kept
 * until that much time has passed since the last counted month ended, so the
 * owner can tell a lapsed member exactly how long their progress lasts.
 */
function continuityFor({ state, countedMonths, latestPeriodEnd, now, env }) {
  if (!["ended", "paused", "payment_issue"].includes(state)) return null;
  if (!countedMonths) return null;
  const lastEnd = toDate(latestPeriodEnd);
  if (!lastEnd) return null;

  const keptUntil = new Date(lastEnd.getTime() + breakDays(env) * DAY_MS);
  if (keptUntil.getTime() > now.getTime()) {
    return {
      keptUntil: keptUntil.toISOString(),
      lost: false,
      note: `Progress is kept if the membership is paid again by this date.`,
    };
  }
  return {
    keptUntil: keptUntil.toISOString(),
    lost: true,
    note: `More than ${breakDays(env)} days without a paid month. A return starts again at 0.`,
  };
}

/**
 * The plan a future milestone's window will be judged on, as far as is known.
 *
 * The customer's preview judges a window on the plans seen in it so far and the
 * plan held now. A downgrade already booked to land before the milestone will
 * lower that window's minimum when it arrives, so the owner is shown the reward
 * that will actually be issued. An upgrade cannot raise a minimum, so it
 * changes nothing.
 */
function windowPlanFor({ subscription, milestoneDate }) {
  const current = normalizePlan(subscription?.subscriptionType);
  const pending = normalizePlan(subscription?.pendingPlan);
  if (!pending || !current || planRank(pending) >= planRank(current)) return { plan: current, basis: "" };

  const effective = toDate(subscription.pendingChangeEffectiveDate);
  const target = toDate(milestoneDate);
  if (effective && target && effective.getTime() > target.getTime()) return { plan: current, basis: "" };

  return {
    plan: pending,
    basis: `Reflects the scheduled change to ${planLabel(pending)}${effective ? ` on ${nyDay(effective)}` : ""}.`,
  };
}

/**
 * How long a reward lasts, in the program's own terms.
 *
 * A plan upgrade runs for its number of billing months from the renewal that
 * earned it. A Loyalty Full Day has to be booked within its validity window.
 * The free month is one monthly bill at $0. Dates are added only when the
 * milestone date itself is known.
 */
function durationFor(reward, startsAt = null) {
  if (!reward) return null;
  const start = toDate(startsAt);
  if (reward.kind === "tier_upgrade") {
    const months = reward.cycles || 1;
    return {
      summary: `${plural(months, "billing month")} of ${planLabel(reward.rewardPlan)} benefits`,
      from: iso(start),
      until: start ? iso(addMonths(start, months)) : null,
    };
  }
  if (reward.kind === "loyalty_full_day") {
    return {
      summary: `Book within ${LOYALTY_FULL_DAY_VALID_DAYS} days of earning it`,
      from: iso(start),
      until: start ? iso(new Date(start.getTime() + LOYALTY_FULL_DAY_VALID_DAYS * DAY_MS)) : null,
    };
  }
  if (reward.kind === "free_month") {
    return {
      summary: "One monthly bill at $0, the bill after this renewal",
      from: start ? iso(addMonths(start, 1)) : null,
      until: null,
    };
  }
  return null;
}

/**
 * Where an earned benefit stands today, read from the records that deliver it.
 *
 * Expiry is a date, so a plan upgrade whose window has passed is reported as
 * ended even though nothing rewrites its status. A Full Day is judged by the
 * entitlement it created, because that is what the customer books against.
 */
function benefitState(grant, entitlement, now) {
  const at = now.getTime();
  const from = toDate(grant.effectiveFrom);
  const until = toDate(grant.effectiveUntil);

  if (grant.status === "failed") return { state: "needs_review", label: "Needs review: not delivered" };
  if (grant.status === "superseded") return { state: "expired", label: "Replaced by a better benefit" };

  if (grant.rewardKind === "tier_upgrade") {
    if (from && from.getTime() > at) return { state: "upcoming", label: `Starts ${nyDay(from)}` };
    if (until && until.getTime() > at && grant.status === "granted") {
      return { state: "active", label: `Active until ${nyDay(until)}` };
    }
    return { state: "expired", label: until ? `Ended ${nyDay(until)}` : "Ended" };
  }

  if (grant.rewardKind === "loyalty_full_day") {
    const expires = toDate(entitlement?.expiresAt);
    if (grant.status === "consumed" || entitlement?.status === "consumed") return { state: "used", label: "Used" };
    if (entitlement?.status === "paid" && (!expires || expires.getTime() > at)) {
      return { state: "active", label: expires ? `Available to book until ${nyDay(expires)}` : "Available to book" };
    }
    return { state: "expired", label: expires ? `Expired ${nyDay(expires)}` : "Expired" };
  }

  if (grant.rewardKind === "free_month") {
    if (grant.status === "consumed") return { state: "used", label: "Applied: that bill was $0" };
    if (grant.status === "expired") return { state: "expired", label: "Expired" };
    return { state: "upcoming", label: "Applies to the next monthly bill" };
  }

  return { state: "expired", label: grant.status || "" };
}

function benefitRow(grant, entitlement, now, currentGeneration) {
  const reward = { kind: grant.rewardKind, rewardPlan: grant.rewardPlan, cycles: grant.cycles };
  const described = describeReward(reward);
  const { state, label } = benefitState(grant, entitlement, now);
  const start = grant.rewardKind === "tier_upgrade" ? grant.effectiveFrom : grant.grantedAt;
  return {
    id: String(grant._id),
    milestone: grant.milestone,
    kind: grant.rewardKind,
    rewardPlan: normalizePlan(grant.rewardPlan),
    headline: described?.headline || "",
    state,
    stateLabel: label,
    duration: durationFor(reward, start)?.summary || "",
    grantedAt: iso(grant.grantedAt),
    effectiveFrom: iso(grant.effectiveFrom),
    effectiveUntil: iso(grant.effectiveUntil),
    currentRun: grant.generation === currentGeneration,
    // Kept for the list view and older screens.
    status: grant.status,
    active: state === "active",
    pendingFreeMonth: grant.rewardKind === "free_month" && state === "upcoming",
  };
}

/**
 * Every milestone on the ladder, for the support view.
 *
 * Reached milestones point at the benefit they produced. Milestones still ahead
 * show the reward the existing rules would issue and, only when the renewals
 * leading to it are already scheduled, an estimated date. Every one of those
 * dates assumes each renewal is paid; none is a promise.
 */
function buildLadder({ state, cancelsOn, subscription, track, counted, generation, benefits, manual, previousRunOnly }) {
  const periodEnd = toDate(subscription.currentPeriodEnd || subscription.nextPaymentDate);
  let nextSeen = false;

  return MILESTONES.map((milestone) => {
    if (counted >= milestone) {
      const benefit = benefits.find((row) => row.milestone === milestone && row.currentRun);
      return {
        milestone,
        position: "reached",
        reward: benefit ? { headline: benefit.headline, detail: "" } : null,
        duration: benefit?.duration || "",
        estimatedDate: null,
        monthsRemaining: 0,
        benefitId: benefit?.id || null,
        benefitStateLabel: benefit ? benefit.stateLabel : "Reached; no benefit record found",
        basis: "",
      };
    }

    const monthsRemaining = milestone - counted;
    const estimate =
      !manual && !previousRunOnly && periodEnd ? addMonths(periodEnd, monthsRemaining - 1) : null;
    const { date } = expectedDateFor({ state, estimatedUnlockDate: estimate, cancelsOn });

    const { plan, basis } = windowPlanFor({ subscription, milestoneDate: date });
    const reward =
      milestone === 12
        ? rewardForMilestone(12, null)
        : previewReward({ milestone, cycles: previousRunOnly ? [] : track.cycles, currentPlan: plan });
    const described = describeReward(reward);
    const duration = durationFor(reward, date);

    const position = nextSeen ? "later" : "next";
    nextSeen = true;
    return {
      milestone,
      position,
      reward: described,
      duration: duration?.summary || "",
      benefitFrom: duration?.from || null,
      benefitUntil: duration?.until || null,
      estimatedDate: iso(date),
      monthsRemaining,
      benefitId: null,
      benefitStateLabel: "",
      basis: milestone === 12 ? "" : basis,
      generation,
    };
  });
}

/**
 * The membership half of the answer.
 *
 * "Complimentary" is reported beside the paid plan, never in place of it, so
 * the owner can always see what the member is actually paying for.
 */
function membershipFacts(subscription, state, cancelsOn, benefits) {
  if (!subscription) return { state: "none" };
  const running = benefits.find((benefit) => benefit.kind === "tier_upgrade" && benefit.state === "active");
  return {
    state,
    plan: normalizePlan(subscription.subscriptionType),
    planLabel: planLabel(subscription.subscriptionType),
    billingCycle: subscription.billingCycle || "monthly",
    status: subscription.status || "",
    startedAt: iso(subscription.startDate || subscription.createdAt),
    currentPeriodEnd: iso(subscription.currentPeriodEnd || subscription.nextPaymentDate),
    cancelsOn: iso(cancelsOn),
    pendingPlan: normalizePlan(subscription.pendingPlan),
    pendingChangeEffectiveDate: iso(subscription.pendingChangeEffectiveDate),
    billedByStripe: !!subscription.stripeSubscriptionId,
    complimentaryPlan: running ? running.rewardPlan : null,
    complimentaryPlanLabel: running ? planLabel(running.rewardPlan) : "",
    complimentaryUntil: running ? running.effectiveUntil : null,
  };
}

/** Every benefit ever issued at this property, newest first, with what delivers it. */
async function loadBenefits({ user, subscription, now, generation }) {
  if (!subscription?.addressId) return [];
  const grants = await LoyaltyGrant.find({ user: user._id, addressId: subscription.addressId })
    .sort({ grantedAt: -1 })
    .lean();
  const entitlementIds = grants.map((grant) => grant.visitEntitlementId).filter(Boolean);
  const entitlements = entitlementIds.length
    ? await VisitEntitlement.find({ _id: { $in: entitlementIds } }).select("status expiresAt").lean()
    : [];
  const byId = new Map(entitlements.map((row) => [String(row._id), row]));
  return grants.map((grant) =>
    benefitRow(grant, grant.visitEntitlementId ? byId.get(String(grant.visitEntitlementId)) : null, now, generation)
  );
}

/**
 * One property's membership and Loyalty Benefits, for Admin.
 *
 * `subscription` is the record that best describes the property today, of any
 * status, so a member who left is still shown with the progress they had.
 */
async function adminLoyaltyForSubscription({ user, subscription, now = new Date(), env = process.env }) {
  const state = membershipState(subscription, now);
  const cancelsOn = cancellationInstant(subscription);
  const manual = manualMembership(subscription, state);

  /*
   * The customer's own function answers for every status it is handed. An
   * ended record still carries its addressId, billing cycle and plan, which is
   * all it reads, so a lapsed member's months come back exactly as they were.
   */
  const status = await loyaltyStatusForSubscription({ user, subscription, now, env });
  const reason = status.reason || (state === "none" ? "no_membership" : "");
  const track = status.eligible ? await trackState(user._id, subscription.addressId) : null;
  const benefits = loyaltyActive(env)
    ? await loadBenefits({ user, subscription, now, generation: track?.generation || 1 })
    : [];
  const delivered = benefits.filter((row) => row.state !== "needs_review");

  const result = {
    addressId: subscription?.addressId ? String(subscription.addressId) : null,
    membership: membershipFacts(subscription, state, cancelsOn, benefits),
    loyalty: {
      reason,
      standing: standingFor({ reason, state, status, cancelsOn, manual }),
      programStartedAt: iso(effectiveAt(env)),
      countedMonths: status.countedMonths || 0,
      nextMilestone: status.nextMilestone || null,
      monthsRemaining: status.monthsRemaining ?? null,
      nextReward: status.nextReward || null,
      nextRewardBasis: "",
      nextRewardDuration: "",
      expectedDate: null,
      requirement: "",
      dateNote: "",
      ladderComplete: !!status.ladderComplete,
      benefitsEarned: delivered.length,
      benefits,
      ladder: [],
      loyaltyFullDaysAvailable: status.loyaltyFullDaysAvailable || 0,
      continuity: null,
      /* True when countedMonths describes a run that is over and a return starts at 0. */
      previousRunOnly: false,
      annualNote: status.annual?.detail || "",
    },
  };

  if (!status.eligible) return result;
  const loyalty = result.loyalty;

  loyalty.continuity = continuityFor({
    state,
    countedMonths: loyalty.countedMonths,
    latestPeriodEnd: track.latestPeriodEnd,
    now,
    env,
  });

  /*
   * Past the break window the counted months belong to a run that is over.
   * Coming back opens a new generation at zero, so the ladder is that of a fresh
   * start. The old months stay visible as history, not as progress.
   */
  loyalty.previousRunOnly = !!loyalty.continuity?.lost && ["ended", "paused"].includes(state);
  const counted = loyalty.previousRunOnly ? 0 : loyalty.countedMonths;

  loyalty.ladder = buildLadder({
    state,
    cancelsOn,
    subscription,
    track,
    counted,
    generation: loyalty.previousRunOnly ? track.generation + 1 : track.generation,
    benefits,
    manual,
    previousRunOnly: loyalty.previousRunOnly,
  });

  /*
   * The headline "next benefit" is the ladder's next rung, so the list view, the
   * detail and the ladder cannot disagree. Its reward is the customer's own
   * preview unless a scheduled downgrade lowers it.
   */
  const next = loyalty.ladder.find((rung) => rung.position === "next");
  if (!next) return result;

  loyalty.nextMilestone = next.milestone;
  loyalty.monthsRemaining = next.monthsRemaining;
  loyalty.nextReward = next.reward;
  loyalty.nextRewardBasis = next.basis;
  loyalty.nextRewardDuration = next.duration;
  loyalty.expectedDate = next.estimatedDate;

  const remaining = next.monthsRemaining;
  if (loyalty.previousRunOnly) {
    loyalty.requirement = `Membership must restart. Progress starts again at 0, then ${plural(
      remaining,
      "paid monthly renewal"
    )}.`;
  } else if (state === "ended") {
    loyalty.requirement = `Membership must restart, then ${plural(remaining, "more paid monthly renewal")}.`;
  } else {
    loyalty.requirement = `${plural(remaining, "more paid monthly renewal")}.`;
  }

  const periodEnd = toDate(subscription.currentPeriodEnd || subscription.nextPaymentDate);
  const estimate = periodEnd ? addMonths(periodEnd, remaining - 1) : null;
  loyalty.dateNote = expectedDateFor({ state, estimatedUnlockDate: estimate, cancelsOn }).note;
  if (loyalty.previousRunOnly) loyalty.dateNote = "";

  /*
   * A membership the owner set up by hand has no Stripe invoices, and a paid
   * Stripe renewal is the only thing that adds a month. Saying "3 more
   * renewals" would promise something that cannot happen on this record.
   */
  if (manual) {
    loyalty.requirement = "Not billed through Stripe, so it does not earn loyalty months.";
    loyalty.expectedDate = null;
    loyalty.dateNote = "Months are earned only from paid Stripe monthly renewals.";
  }

  return result;
}

function addressSummary(address, user) {
  if (!address) return null;
  return {
    _id: String(address._id),
    label: address.label || "",
    line1: address.line1 || "",
    city: address.city || "",
    state: address.state || "",
    zip: address.zip || "",
    isDefault: String(user.defaultAddressId || "") === String(address._id),
  };
}

/** Run a list through `fn` a few at a time, keeping order. */
async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Loyalty for many customers at once.
 *
 * One query loads every subscription for the batch, then each property is
 * answered by the same per-property function the detail view uses, so the
 * list and the detail cannot disagree. `allAddresses` includes properties that
 * have never had a membership, for the detail view; the list leaves them out.
 */
async function adminLoyaltyForUsers(users = [], { now = new Date(), env = process.env, allAddresses = false } = {}) {
  const list = (Array.isArray(users) ? users : []).filter((user) => user?._id);
  if (!list.length) return [];

  const subscriptions = await Subscription.find({
    user: { $in: list.map((user) => user._id) },
    addressId: { $ne: null },
  }).lean();

  const byTrack = new Map();
  for (const subscription of subscriptions) {
    const key = `${subscription.user}:${subscription.addressId}`;
    if (!byTrack.has(key)) byTrack.set(key, []);
    byTrack.get(key).push(subscription);
  }

  const jobs = [];
  for (const user of list) {
    const addresses = new Map((user.addresses || []).map((address) => [String(address._id), address]));
    const addressIds = new Set(allAddresses ? addresses.keys() : []);
    for (const key of byTrack.keys()) {
      const [userKey, addressId] = key.split(":");
      if (userKey === String(user._id)) addressIds.add(addressId);
    }
    for (const addressId of addressIds) {
      const subscription = selectCurrentSubscription(byTrack.get(`${user._id}:${addressId}`) || [], { now });
      jobs.push({ user, addressId, address: addresses.get(addressId) || null, subscription });
    }
  }

  return mapLimited(jobs, 6, async ({ user, addressId, address, subscription }) => {
    const row = await adminLoyaltyForSubscription({ user, subscription, now, env });
    return {
      ...row,
      userId: String(user._id),
      // The property asked about, even when it has never had a membership.
      addressId,
      address: addressSummary(address, user),
      addressSnapshot: address ? null : subscription?.addressSnapshot || null,
    };
  });
}

module.exports = {
  adminLoyaltyForSubscription,
  adminLoyaltyForUsers,
  cancellationInstant,
  continuityFor,
  expectedDateFor,
  membershipState,
  standingFor,
  programActive: loyaltyActive,
};
