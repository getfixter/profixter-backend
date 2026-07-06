const NOT_AVAILABLE = "Not Available";

function clean(value, fallback = NOT_AVAILABLE) {
  const result = String(value ?? "").trim();
  return result || fallback;
}

function formatMoneyPerMonth(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return NOT_AVAILABLE;
  const dollars = numeric.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: Number.isInteger(numeric) ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `${dollars}/month`;
}

function formatAddressParts(parts = {}) {
  return [
    parts.line1 || parts.address,
    parts.city,
    parts.state,
    parts.zip,
    parts.county,
  ]
    .filter(Boolean)
    .join(", ");
}

function formatDate(value, formatDateTime) {
  if (!value) return NOT_AVAILABLE;
  if (typeof formatDateTime === "function") {
    return formatDateTime(value) || NOT_AVAILABLE;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return NOT_AVAILABLE;
  return date.toISOString();
}

function yesNoWithOptionalDate(isYes, value, formatDateTime) {
  if (!isYes) return "No";
  return value ? `Yes - ${formatDate(value, formatDateTime)}` : "Yes";
}

function getRetentionOffer(subscription = {}) {
  return subscription.retentionOffer || {};
}

function retentionOfferWasAccepted(subscription = {}) {
  return !!getRetentionOffer(subscription).acceptedAt;
}

function shouldSendSubscriptionCanceledAdminEmail({
  previousSubscription = {},
  updatedSubscription = {},
  stripeSubscriptionBefore = {},
} = {}) {
  const alreadyScheduled =
    previousSubscription.cancelAtPeriodEnd === true ||
    stripeSubscriptionBefore.cancel_at_period_end === true ||
    String(previousSubscription.status || "").toLowerCase() === "canceled" ||
    String(stripeSubscriptionBefore.status || "").toLowerCase() === "canceled";

  return (
    updatedSubscription.cancelAtPeriodEnd === true &&
    !alreadyScheduled &&
    !retentionOfferWasAccepted(updatedSubscription) &&
    !retentionOfferWasAccepted(previousSubscription)
  );
}

function buildSubscriptionCanceledAdminFields({
  user = {},
  address = {},
  subscription = {},
  stripeSubscription = {},
  requestedAt = new Date(),
  accessEndDate = null,
  retentionOfferDeclined = false,
  formatDateTime,
} = {}) {
  const addressSnapshot = subscription.addressSnapshot || address || {};
  const retentionOffer = getRetentionOffer(subscription);
  const offerShown =
    !!retentionOffer.offeredAt ||
    !!retentionOffer.acceptedAt ||
    !!retentionOffer.declinedAt ||
    retentionOfferDeclined === true;
  const offerDeclined = !!retentionOffer.declinedAt || retentionOfferDeclined === true;
  const offerAccepted = !!retentionOffer.acceptedAt;

  return [
    ["Customer full name", user.name],
    ["Email", user.email],
    ["Phone", user.phone],
    ["Service address", formatAddressParts(addressSnapshot)],
    ["City", addressSnapshot.city],
    ["State", addressSnapshot.state],
    ["ZIP", addressSnapshot.zip],
    ["County", addressSnapshot.county],
    ["Plan name", subscription.subscriptionType],
    ["Monthly price", formatMoneyPerMonth(subscription.planPrice)],
    ["Stripe customer ID", stripeSubscription.customer || subscription.stripeCustomerId],
    ["Stripe subscription ID", stripeSubscription.id || subscription.stripeSubscriptionId],
    ["Local subscription ID", subscription._id],
    ["Address ID", address._id || subscription.addressId],
    ["Cancellation requested date/time", formatDate(requestedAt, formatDateTime)],
    ["Access termination date / period end date", formatDate(accessEndDate, formatDateTime)],
    [
      "Cancellation timing",
      subscription.cancelAtPeriodEnd ? "Scheduled at period end" : "Immediate",
    ],
    ["Current subscription status", subscription.status],
    [
      "Retention offer status",
      offerAccepted
        ? "Accepted - cancellation notification suppressed"
        : offerDeclined
          ? "Declined and continued cancellation"
          : offerShown
            ? "Shown but not accepted"
            : "Not shown / not recorded",
    ],
    ["Was retention offer shown?", offerShown ? "Yes" : "No"],
    [
      "Was retention offer declined?",
      yesNoWithOptionalDate(offerDeclined, retentionOffer.declinedAt, formatDateTime),
    ],
    [
      "Was retention offer accepted?",
      yesNoWithOptionalDate(offerAccepted, retentionOffer.acceptedAt, formatDateTime),
    ],
    ["Retention offer shown at", formatDate(retentionOffer.offeredAt, formatDateTime)],
    ["User Mongo ID", user._id],
    ["Customer user ID", user.userId],
  ].map(([label, value]) => [label, clean(value)]);
}

module.exports = {
  buildSubscriptionCanceledAdminFields,
  formatMoneyPerMonth,
  shouldSendSubscriptionCanceledAdminEmail,
};
