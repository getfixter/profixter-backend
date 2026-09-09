const GiftMembership = require("../../models/GiftMembership");

/**
 * Whether a gift is usable right now.
 *
 * NOTHING HERE READS A STATUS A BACKGROUND JOB IS SUPPOSED TO HAVE SET.
 *
 * That is the whole point of this file. Access is computed from the dates on
 * the record every time it is asked: a gift is live when its window contains
 * this instant and it has not been cancelled, full stop. The lifecycle sweep
 * sends reminders and tidies bookkeeping, and if it is delayed an hour, a day,
 * or never runs again, a customer holding a valid gift still books their visit.
 *
 * The alternative — an `active` flag a cron sets at midnight — means a missed
 * run locks paying customers out of something they hold, and the failure is
 * silent because everything looks fine until somebody tries to book.
 *
 * `status` on the record tracks the LIFECYCLE (bought, invited, claimed,
 * cancelled). The temporal question is always computed. The two are separate
 * on purpose and must stay that way.
 */

/** Lifecycle states a gift can hold and still be worth evaluating. */
const CLAIMABLE_STATUSES = ["purchased", "invited"];

/**
 * The temporal state of one gift, derived purely from its dates.
 *
 * Pure and synchronous: no database, no clock beyond the one passed in, no
 * side effects. That is what lets the whole state machine be tested exhaustively
 * without a database and reasoned about without tracing a worker.
 */
function giftAccessState(gift, now = new Date()) {
  if (!gift) return { state: "none", active: false };

  const at = new Date(now).getTime();

  if (gift.status === "cancelled") {
    return { state: "cancelled", active: false, reason: gift.cancelledReason || "" };
  }
  if (CLAIMABLE_STATUSES.includes(gift.status)) {
    return { state: "unclaimed", active: false };
  }
  if (gift.status !== "claimed") {
    return { state: "unknown", active: false };
  }

  const start = gift.startAt ? new Date(gift.startAt).getTime() : null;
  const end = gift.endAt ? new Date(gift.endAt).getTime() : null;

  /*
   * Claimed but with no window is a data fault, not a free membership. It is
   * reported rather than silently treated as either active or expired, because
   * both of those would hide it.
   */
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return { state: "invalid_window", active: false };
  }

  if (at < start) {
    return { state: "queued", active: false, startsAt: new Date(start), endsAt: new Date(end) };
  }
  if (at >= end) {
    return { state: "expired", active: false, startsAt: new Date(start), endsAt: new Date(end) };
  }
  return { state: "active", active: true, startsAt: new Date(start), endsAt: new Date(end) };
}

/**
 * The gift currently covering this person at this address, if any.
 *
 * Address-scoped, because a membership is scoped to a property: a gift claimed
 * against one house does not cover another. Ordered by start so that when two
 * queued gifts run back to back, the one covering today is the one returned.
 */
async function findActiveGift(
  userId,
  addressId,
  { now = new Date(), Model = GiftMembership } = {}
) {
  if (!userId || !addressId) return null;

  const candidates = await Model.find({
    recipient: userId,
    addressId,
    status: "claimed",
  })
    .sort({ startAt: 1 })
    .lean();

  for (const gift of candidates) {
    if (giftAccessState(gift, now).active) return gift;
  }
  return null;
}

/**
 * Everything this person holds at this address, in order.
 *
 * Drives the account screen: what is running now, what follows it, and what has
 * already been used. One query, so the screen does not have to guess.
 */
async function findGiftTimeline(
  userId,
  addressId,
  { now = new Date(), Model = GiftMembership } = {}
) {
  if (!userId) return { active: null, queued: [], expired: [] };

  const filter = { recipient: userId, status: "claimed" };
  if (addressId) filter.addressId = addressId;

  const gifts = await Model.find(filter).sort({ startAt: 1 }).lean();

  const timeline = { active: null, queued: [], expired: [] };
  for (const gift of gifts) {
    const state = giftAccessState(gift, now);
    if (state.active && !timeline.active) timeline.active = { ...gift, ...state };
    else if (state.state === "queued") timeline.queued.push({ ...gift, ...state });
    else if (state.state === "expired") timeline.expired.push({ ...gift, ...state });
  }
  return timeline;
}

/**
 * When coverage this person already holds runs out.
 *
 * Used to queue a newly claimed gift behind whatever is ahead of it, so no
 * paid-for day is spent twice. Returns null when nothing is ahead, meaning the
 * new gift starts immediately.
 *
 * Deliberately takes the paid subscription's end as an argument rather than
 * looking it up: the caller already has it, and this function must never be in
 * a position to write to a Subscription.
 */
function coverageEndsAt(
  { paidCoverageEndsAt = null, existingGifts = [] } = {},
  now = new Date()
) {
  const at = new Date(now).getTime();
  let latest = null;

  const consider = (value) => {
    if (!value) return;
    const ms = new Date(value).getTime();
    if (!Number.isFinite(ms) || ms <= at) return;
    if (latest === null || ms > latest) latest = ms;
  };

  consider(paidCoverageEndsAt);
  for (const gift of existingGifts) {
    if (gift?.status !== "claimed") continue;
    const state = giftAccessState(gift, now);
    // Only coverage that is running or still to come pushes a new gift back.
    // An expired gift is behind us and must not delay anything.
    if (state.state === "active" || state.state === "queued") consider(gift.endAt);
  }

  return latest === null ? null : new Date(latest);
}

/**
 * A gift, shaped so the existing membership readers can use it unchanged.
 *
 * The booking gate and the account screen only ever ask a membership for its
 * plan. Handing them this lets a gift grant exactly the benefits it bought
 * without a single one of those call sites learning what a gift is.
 *
 * THREE PROPERTIES MAKE IT SAFE, AND ALL THREE ARE DELIBERATE.
 *
 *   - It carries NO Stripe identifiers. Not stripeCustomerId, not
 *     stripeSubscriptionId, not a price. The billing portal resolves a
 *     customer by searching for exactly those on a user's subscriptions, so
 *     their absence is what keeps the purchaser's card unreachable.
 *   - It has no _id, so nothing can mistake it for a row and try to update it.
 *   - It is frozen, so nothing downstream can add a Stripe field to it later
 *     and quietly reintroduce the hazard.
 *
 * It is never persisted. There is no code path in this feature that writes a
 * Subscription document, and this object exists precisely so that none is
 * needed.
 */
function syntheticGiftSubscription(gift) {
  if (!gift) return null;
  return Object.freeze({
    isGift: true,
    giftId: gift._id,
    giftNumber: gift.giftNumber,
    subscriptionType: gift.plan,
    status: "active",
    accessStatus: "active",
    addressId: gift.addressId,
    user: gift.recipient,
    currentPeriodEnd: gift.endAt,
    startDate: gift.startAt,
    // Gifts do not renew and are not cancellable by the recipient. Stated
    // rather than omitted so a reader checking these fields gets the truth.
    cancelAtPeriodEnd: false,
    billingCycle: null,
    giftedBy: gift.purchaserSnapshot?.name || "",
  });
}

module.exports = {
  CLAIMABLE_STATUSES,
  coverageEndsAt,
  findActiveGift,
  findGiftTimeline,
  giftAccessState,
  syntheticGiftSubscription,
};
