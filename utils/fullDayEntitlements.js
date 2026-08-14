const Subscription = require("../models/Subscription");
const VisitEntitlement = require("../models/VisitEntitlement");
const { subscriptionGrantsAccess } = require("./subscriptionManagement");

/**
 * The Full Day that comes with Elite: one per billing period, per address.
 *
 * "Per billing period" is meant literally. The period is copied off the
 * subscription, not computed from a calendar month, because a member billed on
 * the 12th does not experience months and would otherwise get two Full Days in
 * some months and none in others depending on where their renewal fell.
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

/** The Elite subscription covering this address, if there is a live one. */
async function activeEliteSubscription({ user, addressId, now = new Date() }) {
  if (!user?._id || !addressId) return null;
  const subscriptions = await Subscription.find({
    user: user._id,
    addressId,
    subscriptionType: "elite",
    status: { $in: ["active", "trialing"] },
  }).sort({ currentPeriodStart: -1, updatedAt: -1 });
  return (
    subscriptions.find((subscription) =>
      subscriptionGrantsAccess(subscription, { now })
    ) || null
  );
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
  const period = subscriptionPeriod(subscription);
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
        "Your included Full Day for this billing period has already been used."
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
  canRestoreIncludedFullDay,
  consumeIncludedFullDay,
  findIncludedEntitlement,
  includedFullDayState,
  restoreIncludedFullDay,
  subscriptionPeriod,
};
