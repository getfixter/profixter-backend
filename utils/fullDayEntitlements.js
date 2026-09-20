const Subscription = require("../models/Subscription");
const VisitEntitlement = require("../models/VisitEntitlement");
const { subscriptionGrantsAccess } = require("./subscriptionManagement");

/**
 * The Full Day that comes with Elite: one per membership month, per address.
 *
 * "Membership month" is meant literally, and is anchored to the subscription
 * rather than the calendar: a member billed on the 12th does not experience
 * calendar months, and would otherwise get two Full Days in some months and
 * none in others depending on where their renewal fell. So months are counted
 * forward from the start of the billing period - see entitlementPeriod.
 *
 * For a monthly member the membership month and the billing period are the same
 * thing, which is why this used to read the billing period directly. Annual
 * billing broke that equivalence: an annual member buys twelve months of Elite
 * and pays for them once, so their one Stripe period covers twelve Full Days,
 * one of which becomes available at each monthly anniversary.
 *
 * The benefit is stored as an ordinary VisitEntitlement so it lands in the same
 * place as a bought one and everything downstream reads one shape. What marks
 * it out is source: "membership_benefit" plus the period, and those five fields
 * carry a unique index, which is what actually stops a member holding two.
 */

const INCLUDED_ELITE_FULL_DAYS_PER_PERIOD = 1;
const LIVE_STATUSES = ["pending_payment", "paid", "consumed"];

function serviceError(code, message, statusCode = 409) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function toDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The subscription giving this address Elite benefits, if there is a live one.
 *
 * "Giving Elite benefits" rather than "being Elite", because a Premium member
 * part-way through a Loyalty tier upgrade is entitled to everything Elite
 * includes, and the included Full Day is the largest part of that. Asking the
 * effective-plan seam rather than reading subscriptionType is what makes the
 * reward mean what it says.
 *
 * The per-period unique index still holds: a temporarily-Elite member gets one
 * included Full Day for the period, exactly like a paying Elite member, and it
 * lapses with the upgrade because this function stops answering.
 */
async function activeEliteSubscription({ user, addressId, now = new Date() }) {
  if (!user?._id || !addressId) return null;
  const subscriptions = await Subscription.find({
    user: user._id,
    addressId,
    status: { $in: ["active", "trialing"] },
  }).sort({ currentPeriodStart: -1, updatedAt: -1 });

  const live = subscriptions.filter((subscription) =>
    subscriptionGrantsAccess(subscription, { now })
  );

  const paidElite = live.find(
    (subscription) => String(subscription.subscriptionType || "").toLowerCase() === "elite"
  );
  if (paidElite) return paidElite;

  const { effectivePlanForSubscription } = require("./loyalty/effectivePlan");
  for (const subscription of live) {
    const effective = await effectivePlanForSubscription(subscription, { now });
    if (effective.plan === "elite") return subscription;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Loyalty Full Days                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Extra Full Days earned by staying a member.
 *
 * The mirror image of the included one. An included Full Day exists as an
 * absence — no record for this period means one is available — whereas these are
 * granted up front and exist as records, so "how many do I have" is a count of
 * rows rather than the lack of one. Keeping them in the same collection means
 * booking, cancelling and reporting all read one shape; keeping them on a
 * different source means neither can ever be mistaken for the other.
 *
 * Ordered oldest first so the one closest to expiring is spent first, which is
 * what a customer would want and what avoids a day quietly lapsing beside a
 * fresher one.
 */
async function availableLoyaltyFullDays({ user, addressId, now = new Date() }) {
  if (!user?._id || !addressId) return [];
  return VisitEntitlement.find({
    user: user._id,
    addressId,
    kind: "full_day_visit",
    source: "loyalty_benefit",
    status: "paid",
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
  })
    .sort({ expiresAt: 1, createdAt: 1 })
    .lean();
}

/**
 * Whether an Elite Loyalty Full Day can be used here, right now.
 *
 * Requires live membership at the address as well as an unexpired entitlement.
 * A Loyalty Full Day is a benefit of BEING a member, so it stops being usable
 * when the membership genuinely ends — but the record is never deleted, because
 * somebody asking what happened to their reward deserves an answer.
 */
async function loyaltyFullDayState({ user, addressId, now = new Date() }) {
  const covered = await Subscription.findOne({
    user: user._id,
    addressId,
    status: { $in: ["active", "trialing"] },
  }).sort({ currentPeriodStart: -1, updatedAt: -1 });

  const membershipLive = !!covered && subscriptionGrantsAccess(covered, { now });
  const entitlements = membershipLive
    ? await availableLoyaltyFullDays({ user, addressId, now })
    : [];

  return {
    available: entitlements.length,
    next: entitlements[0] || null,
    entitlements,
    membershipLive,
  };
}

/**
 * Spend one Loyalty Full Day, at the moment the booking is confirmed.
 *
 * Conditional on the row still being `paid`, so two simultaneous requests
 * produce one consumption and one clean refusal rather than two bookings against
 * one entitlement — the same guarantee the unique index gives the included day,
 * achieved here with an atomic update because the row already exists.
 */
async function consumeLoyaltyFullDay({ entitlementId, user = null, now = new Date() }) {
  /*
   * The owner is part of the query when the caller can supply one.
   *
   * Belt and braces: every current call site resolves the entitlement from the
   * signed-in customer's own state, so an id belonging to somebody else cannot
   * reach here today. This makes that a property of the query rather than of
   * the caller, so a future caller that passes an id straight from a request
   * cannot spend another customer's Full Day.
   */
  const filter = { _id: entitlementId, source: "loyalty_benefit", status: "paid" };
  if (user?._id) filter.user = user._id;

  const consumed = await VisitEntitlement.findOneAndUpdate(
    filter,
    { $set: { status: "consumed", consumedAt: now } },
    { new: true }
  );
  if (!consumed) {
    throw serviceError(
      "LOYALTY_FULL_DAY_UNAVAILABLE",
      "That Loyalty Full Day has already been used."
    );
  }
  return consumed;
}

/**
 * Hand a Loyalty Full Day back when its booking is cancelled in time.
 *
 * Returns it to `paid` rather than `canceled`, because for a loyalty day the
 * record IS the entitlement — cancelling the row would destroy the benefit
 * rather than release it. The original expiry is untouched: a cancellation does
 * not buy more time.
 */
async function restoreLoyaltyFullDay({ booking, now = new Date() }) {
  if (!booking?.entitlementId) return { restored: false, reason: "no_entitlement_on_booking" };

  const entitlement = await VisitEntitlement.findById(booking.entitlementId);
  if (!entitlement || entitlement.source !== "loyalty_benefit") {
    return { restored: false, reason: "not_loyalty_entitlement" };
  }

  const scheduled = toDate(booking?.scheduledStart || booking?.date);
  if (!scheduled) return { restored: false, reason: "no_scheduled_date" };
  if (scheduled.getTime() <= now.getTime()) {
    return { restored: false, reason: "day_already_started" };
  }
  if (entitlement.expiresAt && new Date(entitlement.expiresAt).getTime() <= now.getTime()) {
    return { restored: false, reason: "loyalty_full_day_expired" };
  }

  const restored = await VisitEntitlement.findOneAndUpdate(
    { _id: entitlement._id, status: "consumed" },
    { $set: { status: "paid", consumedAt: null } },
    { new: true }
  );
  return restored
    ? { restored: true, reason: "", entitlement: restored }
    : { restored: false, reason: "not_consumed" };
}

/**
 * The authoritative period, or null.
 *
 * Null is a real answer, not a failure to look. A subscription Stripe has not
 * yet stamped with a period has no period to attribute a benefit to, and
 * inventing one would put the entitlement in a window that does not exist.
 */
function subscriptionPeriod(subscription) {
  const periodStart = toDate(subscription?.currentPeriodStart);
  const periodEnd = toDate(subscription?.currentPeriodEnd);
  if (!periodStart || !periodEnd || periodEnd <= periodStart) return null;
  return { periodStart, periodEnd };
}

/**
 * The same calendar day, `count` months on, in UTC.
 *
 * Clamped the way a person would clamp it: one month after the 31st of January
 * is the 28th of February, not the 3rd of March. Done by moving to the 1st
 * before changing the month, because setUTCMonth on a 31st silently overflows
 * into the following month and would hand somebody their Full Day a few days
 * early every single time February came round. Time of day is preserved, so an
 * anniversary keeps the hour Stripe stamped on it.
 */
function addMonths(date, count) {
  const result = new Date(date.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + count);
  const daysInTargetMonth = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)
  ).getUTCDate();
  result.setUTCDate(Math.min(day, daysInTargetMonth));
  return result;
}

/**
 * The window one included Full Day belongs to: a MEMBERSHIP MONTH.
 *
 * Elite includes a Full Day every month. That is a property of the membership,
 * not of the invoice, and an annual member is buying twelve months of Elite -
 * they have simply paid for them in one go. Attributing the benefit to the
 * Stripe billing period made the two identical for a monthly member and
 * catastrophically different for an annual one, who got a single Full Day for
 * the entire year.
 *
 * So the period is sliced into anniversary months counted forward from the
 * start of the billing period. A monthly subscription has exactly one such
 * month and comes back completely unchanged - see the guard below. An annual
 * subscription comes back as whichever of its twelve months contains `now`.
 *
 * Nothing accumulates. The entitlement is an ABSENCE, not a grant: a member who
 * does not use February's Full Day has no February row, and in March the lookup
 * asks about March. There is nothing to carry forward and nothing to stockpile,
 * which is the existing rule and stays the rule.
 */
function entitlementPeriod(subscription, { now = new Date() } = {}) {
  const period = subscriptionPeriod(subscription);
  if (!period) return null;

  const { periodStart, periodEnd } = period;

  /*
   * Only genuinely long periods are sliced.
   *
   * A monthly billing period can never reach two months, so this guard means
   * monthly members take the original path and get byte-identical behaviour -
   * including the irregular periods that proration, plan changes and trials
   * produce, none of which should ever be chopped into pieces. Annual periods
   * are twelve months and always clear it.
   */
  if (periodEnd <= addMonths(periodStart, 2)) return period;

  // Which membership month contains `now`. Seeded from the calendar-month gap,
  // then corrected, because day-of-month clamping makes the seed approximate.
  let index =
    (now.getUTCFullYear() - periodStart.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - periodStart.getUTCMonth());
  if (!Number.isFinite(index) || index < 0) index = 0;
  while (index > 0 && addMonths(periodStart, index) > now) index -= 1;
  while (addMonths(periodStart, index + 1) <= now) index += 1;
  // A subscription Stripe has not re-stamped yet can leave `now` past the end.
  // Staying inside the final month is right; falling back to the whole year
  // would re-open a window the member may already have spent.
  while (index > 0 && addMonths(periodStart, index) >= periodEnd) index -= 1;

  const monthStart = addMonths(periodStart, index);
  const nextAnniversary = addMonths(periodStart, index + 1);
  return {
    periodStart: monthStart,
    periodEnd: nextAnniversary > periodEnd ? periodEnd : nextAnniversary,
  };
}

async function findIncludedEntitlement({ user, addressId, periodStart }) {
  return VisitEntitlement.findOne({
    user: user._id,
    addressId,
    kind: "full_day_visit",
    source: "membership_benefit",
    periodStart,
    status: { $in: LIVE_STATUSES },
  });
}

/**
 * What this customer's included Full Day looks like right now: whether they
 * have one, whether they have already used it, and which period it belongs to.
 */
async function includedFullDayState({ user, addressId, now = new Date() }) {
  const subscription = await activeEliteSubscription({ user, addressId, now });
  if (!subscription) {
    return {
      entitled: false,
      used: false,
      remaining: 0,
      subscription: null,
      periodStart: null,
      periodEnd: null,
      entitlement: null,
      reason: "not_elite",
    };
  }
  const period = entitlementPeriod(subscription, { now });
  if (!period) {
    return {
      entitled: false,
      used: false,
      remaining: 0,
      subscription,
      periodStart: null,
      periodEnd: null,
      entitlement: null,
      reason: "no_billing_period",
    };
  }
  const entitlement = await findIncludedEntitlement({
    user,
    addressId,
    periodStart: period.periodStart,
  });
  return {
    entitled: true,
    used: !!entitlement,
    remaining: entitlement ? 0 : INCLUDED_ELITE_FULL_DAYS_PER_PERIOD,
    subscription,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    entitlement,
    reason: entitlement ? "already_used_this_period" : "",
  };
}

/**
 * Take the included Full Day, at the moment the booking is confirmed.
 *
 * Written straight to "consumed" rather than "paid then consumed later"
 * because confirming the booking is what spends it: the member has the day,
 * whether or not the visit has happened yet. The unique index is the guard, so
 * two simultaneous requests produce one entitlement and one clear refusal
 * rather than two entitlements.
 */
async function consumeIncludedFullDay({
  user,
  addressId,
  addressSnapshot = {},
  periodStart,
  periodEnd,
  durationMinutes,
  now = new Date(),
}) {
  try {
    return await VisitEntitlement.create({
      user: user._id,
      userId: user.userId,
      addressId,
      addressSnapshot,
      kind: "full_day_visit",
      source: "membership_benefit",
      status: "consumed",
      priceCents: 0,
      currency: "usd",
      durationMinutes,
      periodStart,
      periodEnd,
      purchasedAt: now,
      consumedAt: now,
      holdExpiresAt: null,
    });
  } catch (error) {
    if (error?.code === 11000) {
      throw serviceError(
        "FULL_DAY_BENEFIT_ALREADY_USED",
        "Your included Full Day for this month has already been used."
      );
    }
    throw error;
  }
}

/**
 * Whether a cancellation gives the included Full Day back.
 *
 * Three conditions, all required, and each one is a different way the benefit
 * could otherwise be abused or misread:
 *
 *  - the day has not started, because a day that has begun has been delivered
 *    whether or not anyone showed up to it;
 *  - the cancellation falls in the same billing period the benefit was granted
 *    for, because returning it into a later period would hand the member two
 *    Full Days in that period;
 *  - the booking actually used the benefit, because a paid Full Day has nothing
 *    to give back here and its money is a separate question entirely.
 */
function canRestoreIncludedFullDay({ booking, entitlement, now = new Date() }) {
  if (!entitlement) {
    return { restore: false, reason: "no_membership_entitlement" };
  }
  if (entitlement.source !== "membership_benefit") {
    return { restore: false, reason: "paid_full_day" };
  }
  const scheduled = toDate(booking?.scheduledStart || booking?.date);
  if (!scheduled) return { restore: false, reason: "no_scheduled_date" };
  if (scheduled.getTime() <= now.getTime()) {
    return { restore: false, reason: "day_already_started" };
  }
  const periodStart = toDate(entitlement.periodStart);
  const periodEnd = toDate(entitlement.periodEnd);
  if (!periodStart || !periodEnd) {
    return { restore: false, reason: "no_billing_period" };
  }
  if (now < periodStart || now >= periodEnd) {
    return { restore: false, reason: "outside_granted_period" };
  }
  return { restore: true, reason: "" };
}

/**
 * Hand the included Full Day back by ending this entitlement's life.
 *
 * "canceled" is outside the unique index's partial filter, so the member can be
 * granted the next one immediately. Nothing is deleted: the record of the
 * benefit having been taken and returned survives, which is what anyone
 * investigating a billing question will want to see.
 */
async function restoreIncludedFullDay({ booking, now = new Date() }) {
  if (!booking?.entitlementId) {
    return { restored: false, reason: "no_entitlement_on_booking" };
  }
  const entitlement = await VisitEntitlement.findById(booking.entitlementId);
  const verdict = canRestoreIncludedFullDay({ booking, entitlement, now });
  if (!verdict.restore) return { restored: false, reason: verdict.reason };

  entitlement.status = "canceled";
  entitlement.consumedAt = null;
  await entitlement.save();
  return { restored: true, reason: "", entitlement };
}

module.exports = {
  INCLUDED_ELITE_FULL_DAYS_PER_PERIOD,
  LIVE_STATUSES,
  activeEliteSubscription,
  availableLoyaltyFullDays,
  canRestoreIncludedFullDay,
  consumeIncludedFullDay,
  consumeLoyaltyFullDay,
  entitlementPeriod,
  findIncludedEntitlement,
  includedFullDayState,
  loyaltyFullDayState,
  restoreIncludedFullDay,
  restoreLoyaltyFullDay,
  subscriptionPeriod,
};
