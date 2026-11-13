/**
 * What each home's membership is doing, for Admin lists and the profile.
 *
 *   active         paid up and renewing
 *   trialing       in a trial (e.g. deferred over a gift); billing starts later
 *   payment_issue  Stripe is trying to collect: past_due, unpaid, incomplete,
 *                  paused, or an "active" record whose period ended with no
 *                  renewal on record (statusDetail says which)
 *   ending         a cancellation is scheduled (cancelAt is set)
 *   ended          canceled / expired, or the scheduled cancel date has passed
 *   none           never had one
 *
 * "payment_issue" and "ending" are still members: they are the people who need
 * a call. The old list showed only memberships that granted access right now,
 * so a failed renewal silently dropped out of Members.
 *
 * All of it is read from our Subscription records in ONE query per page of
 * customers (loadAddressPlans), never one query per customer.
 */
const Subscription = require("../../models/Subscription");
const { selectCurrentSubscription, subscriptionGrantsAccess, toDate } = require("../subscriptionManagement");

const ENDED = new Set(["canceled", "expired", "incomplete_expired"]);
const PAYMENT_ISSUE = new Set(["past_due", "unpaid", "incomplete", "paused"]);
const NON_ENDED_STATUSES = ["active", "trialing", "past_due", "unpaid", "incomplete", "paused"];
const PLAN_STATUSES = ["active", "trialing", "payment_issue", "ending", "ended", "none"];

function isEndedSubscription(subscription) {
  return !subscription || ENDED.has(String(subscription.status || "").toLowerCase());
}

/** When the membership stops, if it has been told to. */
function cancelAtFor(subscription) {
  if (!subscription) return null;
  const status = String(subscription.status || "").toLowerCase();
  if (ENDED.has(status)) return null;
  if (subscription.cancelAtPeriodEnd) return toDate(subscription.currentPeriodEnd || subscription.cancellationDate);
  return toDate(subscription.cancellationDate);
}

/** { planStatus, statusDetail } for one stored subscription. */
function planStatusFor(subscription, now = new Date()) {
  if (!subscription) return { planStatus: "none", statusDetail: "" };
  const status = String(subscription.status || "").toLowerCase();
  if (ENDED.has(status)) return { planStatus: "ended", statusDetail: status };

  const cancelAt = cancelAtFor(subscription);
  if (cancelAt && cancelAt.getTime() <= now.getTime()) return { planStatus: "ended", statusDetail: "cancel_date_passed" };
  if (PAYMENT_ISSUE.has(status)) return { planStatus: "payment_issue", statusDetail: status };
  if (cancelAt) return { planStatus: "ending", statusDetail: status };

  if (!subscriptionGrantsAccess(subscription, { now })) {
    return { planStatus: "payment_issue", statusDetail: "renewal_not_recorded" };
  }
  if (status === "trialing") return { planStatus: "trialing", statusDetail: "" };
  return { planStatus: "active", statusDetail: "" };
}

/**
 * The record that speaks for one home: the one granting access, else the
 * live one Stripe is still billing, else the most recent.
 */
function currentForAddress(subscriptions, address, user, hasAnyAddressSubs) {
  const own = subscriptions.filter((s) => String(s.addressId || "") === String(address._id));
  let selected = selectCurrentSubscription(own);
  // A membership from before subscriptions carried an address belongs to the default home.
  if (!selected && !hasAnyAddressSubs && String(user.defaultAddressId || "") === String(address._id)) {
    selected = selectCurrentSubscription(subscriptions.filter((s) => !s.addressId));
  }
  return selected;
}

function planSummary(subscription, now) {
  const { planStatus, statusDetail } = planStatusFor(subscription, now);
  const cancelAt = cancelAtFor(subscription);
  const periodEnd = subscription ? toDate(subscription.currentPeriodEnd || subscription.nextPaymentDate) : null;
  const grants = subscription ? subscriptionGrantsAccess(subscription, { now }) : false;
  return {
    subscriptionId: subscription ? String(subscription._id) : null,
    plan: subscription && planStatus !== "none" && planStatus !== "ended" ? subscription.subscriptionType : null,
    lastPlan: subscription ? subscription.subscriptionType : null,
    billingCycle: subscription ? subscription.billingCycle || "monthly" : null,
    planStatus,
    statusDetail,
    stripeStatus: subscription ? String(subscription.status || "") : null,
    grantsAccess: grants,
    stripeManaged: Boolean(subscription?.stripeSubscriptionId),
    complimentary: Boolean(subscription && subscription.paymentMethod === "complimentary"),
    currentPeriodEnd: periodEnd,
    cancelAt,
    renewsAt: planStatus === "active" || planStatus === "trialing" ? periodEnd : null,
    endsAt: planStatus === "ending" ? cancelAt : planStatus === "ended" ? cancelAt || toDate(subscription?.cancellationDate) : null,
    pendingPlan: subscription?.pendingPlan || null,
    pendingChangeEffectiveDate: subscription?.pendingChangeEffectiveDate || null,
    latestInvoiceStatus: subscription?.latestInvoiceStatus || null,
    cancellationDate: toDate(subscription?.cancellationDate),
  };
}

/**
 * Per-home plan summaries for many customers in one Subscription query.
 * @returns Map<userIdString, Map<addressIdString, summary>>
 */
async function loadAddressPlans(users = [], { now = new Date() } = {}) {
  const out = new Map();
  if (!users.length) return out;
  const subscriptions = await Subscription.find({ user: { $in: users.map((u) => u._id) } })
    .select(
      "user addressId subscriptionType billingCycle status accessStatus stripeSubscriptionId currentPeriodEnd nextPaymentDate cancelAtPeriodEnd cancellationDate pendingPlan pendingChangeEffectiveDate latestInvoiceStatus paymentMethod createdAt updatedAt startDate"
    )
    .lean();
  const byUser = new Map();
  for (const s of subscriptions) {
    const key = String(s.user);
    if (!byUser.has(key)) byUser.set(key, []);
    byUser.get(key).push(s);
  }
  for (const user of users) {
    const subs = byUser.get(String(user._id)) || [];
    const hasAnyAddressSubs = subs.some((s) => s.addressId);
    const perAddress = new Map();
    for (const address of user.addresses || []) {
      perAddress.set(String(address._id), planSummary(currentForAddress(subs, address, user, hasAnyAddressSubs), now));
    }
    out.set(String(user._id), perAddress);
  }
  return out;
}

/** The non-ended subscriptions on one home (duplicate prevention). */
async function nonEndedSubscriptionsForAddress({ userId, addressId }) {
  return Subscription.find({ user: userId, addressId, status: { $in: NON_ENDED_STATUSES } }).lean();
}

module.exports = {
  NON_ENDED_STATUSES,
  PLAN_STATUSES,
  cancelAtFor,
  currentForAddress,
  isEndedSubscription,
  loadAddressPlans,
  nonEndedSubscriptionsForAddress,
  planStatusFor,
  planSummary,
};
