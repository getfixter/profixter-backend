const NOT_AVAILABLE = "Not Available";
const RETENTION_COUPON_ENV = "STRIPE_RETENTION_COUPON_ID";

function clean(value, fallback = NOT_AVAILABLE) {
  const result = String(value ?? "").trim();
  return result || fallback;
}

function retentionOffer(subscription = {}) {
  return subscription.retentionOffer || {};
}

function isSubscriptionCanceledOrScheduled(subscription = {}) {
  const status = String(subscription.status || "").toLowerCase();
  return (
    subscription.cancelAtPeriodEnd === true ||
    status === "canceled" ||
    status === "expired" ||
    status === "incomplete_expired"
  );
}

function hasRetentionCoupon(env = process.env) {
  return !!String(env[RETENTION_COUPON_ENV] || "").trim();
}

function getRetentionCouponId(env = process.env) {
  return String(env[RETENTION_COUPON_ENV] || "").trim();
}

function evaluateRetentionOfferDisplay(subscription = {}, env = process.env) {
  const offer = retentionOffer(subscription);

  if (!hasRetentionCoupon(env)) {
    return { eligible: false, reason: "coupon_env_missing" };
  }

  if (isSubscriptionCanceledOrScheduled(subscription)) {
    return { eligible: false, reason: "subscription_cancellation_unavailable" };
  }

  if (offer.acceptedAt) {
    return { eligible: false, reason: "retention_offer_already_accepted" };
  }

  if (offer.declinedAt) {
    return { eligible: false, reason: "retention_offer_already_declined" };
  }

  return { eligible: true, reason: "eligible" };
}

function evaluateRetentionOfferAcceptance(subscription = {}, env = process.env) {
  const offer = retentionOffer(subscription);

  if (!hasRetentionCoupon(env)) {
    return { eligible: false, reason: "coupon_env_missing" };
  }

  if (isSubscriptionCanceledOrScheduled(subscription)) {
    return { eligible: false, reason: "subscription_cancellation_unavailable" };
  }

  if (offer.acceptedAt) {
    return { eligible: false, reason: "retention_offer_already_accepted" };
  }

  if (offer.declinedAt) {
    return { eligible: false, reason: "retention_offer_already_declined" };
  }

  return { eligible: true, reason: "eligible" };
}

function planPriceToCents(planPrice) {
  const numeric = Number(planPrice);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.round(numeric * 100);
}

function formatMoney(cents, currency = "usd") {
  const numeric = Number(cents);
  if (!Number.isFinite(numeric)) return NOT_AVAILABLE;

  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: String(currency || "usd").toUpperCase(),
    }).format(numeric / 100);
  } catch (_err) {
    return `$${(numeric / 100).toFixed(2)}`;
  }
}

function formatDateTime(value) {
  if (!value) return NOT_AVAILABLE;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return NOT_AVAILABLE;

  return date.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
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

function getStripeDiscountId(stripeSubscription = {}) {
  if (stripeSubscription.discount?.id) return stripeSubscription.discount.id;

  const firstDiscount = Array.isArray(stripeSubscription.discounts)
    ? stripeSubscription.discounts[0]
    : null;
  return firstDiscount?.discount?.id || firstDiscount?.id || null;
}

function calculateRetentionDiscountCents(coupon = {}, planPriceCents) {
  const price = Number(planPriceCents);
  if (!Number.isFinite(price) || price <= 0) return null;

  const amountOff = Number(coupon.amount_off);
  if (Number.isFinite(amountOff) && amountOff > 0) {
    return Math.min(amountOff, price);
  }

  const percentOff = Number(coupon.percent_off);
  if (Number.isFinite(percentOff) && percentOff > 0) {
    return Math.round(price * (percentOff / 100));
  }

  return null;
}

function describeCouponDiscount(coupon = {}, discountCents, currency = "usd") {
  const amountOff = Number(coupon.amount_off);
  if (Number.isFinite(amountOff) && amountOff > 0) {
    return formatMoney(amountOff, coupon.currency || currency);
  }

  const percentOff = Number(coupon.percent_off);
  if (Number.isFinite(percentOff) && percentOff > 0) {
    const estimate =
      Number.isFinite(Number(discountCents)) && Number(discountCents) > 0
        ? ` (${formatMoney(discountCents, currency)} estimated)`
        : "";
    return `${percentOff}% off${estimate}`;
  }

  return NOT_AVAILABLE;
}

async function applyRetentionCouponToStripe({
  stripeClient,
  stripeSubscriptionId,
  couponId,
}) {
  if (!stripeClient?.subscriptions?.update) {
    throw new Error("Stripe client is not available");
  }

  return stripeClient.subscriptions.update(stripeSubscriptionId, {
    discounts: [{ coupon: couponId }],
    proration_behavior: "none",
    expand: ["items.data.price"],
  });
}

function buildRetentionAcceptedAdminSections({
  user = {},
  address = {},
  subscription = {},
  stripeSubscription = {},
  coupon = {},
  couponId,
  acceptedAt = new Date(),
} = {}) {
  const addressSnapshot = subscription.addressSnapshot || address || {};
  const planPriceCents = planPriceToCents(subscription.planPrice);
  const currency = coupon.currency || "usd";
  const discountCents = calculateRetentionDiscountCents(coupon, planPriceCents);

  return [
    {
      title: "CUSTOMER",
      fields: [
        ["Customer name", user.name],
        ["Email", user.email],
        ["Phone", user.phone],
        ["Property address", formatAddressParts(addressSnapshot)],
      ],
    },
    {
      title: "MEMBERSHIP",
      fields: [
        ["Membership plan", subscription.subscriptionType],
        [
          "Current monthly price",
          planPriceCents ? `${formatMoney(planPriceCents, currency)}/month` : NOT_AVAILABLE,
        ],
        ["Next renewal date", formatDateTime(subscription.currentPeriodEnd || subscription.nextPaymentDate)],
        ["Current status", subscription.status],
      ],
    },
    {
      title: "RETENTION OFFER",
      fields: [
        ["Coupon ID applied", couponId],
        ["Discount amount", describeCouponDiscount(coupon, discountCents, currency)],
        ["Date/time accepted", formatDateTime(acceptedAt)],
      ],
    },
    {
      title: "STRIPE",
      fields: [
        ["Stripe Subscription ID", stripeSubscription.id || subscription.stripeSubscriptionId],
        ["Stripe Customer ID", stripeSubscription.customer || subscription.stripeCustomerId],
        ["Stripe Discount ID", getStripeDiscountId(stripeSubscription)],
      ],
    },
    {
      title: "SYSTEM",
      fields: [
        ["Customer ID", user.userId || user._id],
        ["User Mongo ID", user._id],
        ["Subscription Mongo ID", subscription._id],
        ["Address ID", address._id || subscription.addressId],
      ],
    },
  ];
}

module.exports = {
  NOT_AVAILABLE,
  RETENTION_COUPON_ENV,
  applyRetentionCouponToStripe,
  buildRetentionAcceptedAdminSections,
  calculateRetentionDiscountCents,
  clean,
  describeCouponDiscount,
  evaluateRetentionOfferAcceptance,
  evaluateRetentionOfferDisplay,
  formatDateTime,
  formatMoney,
  getRetentionCouponId,
  getStripeDiscountId,
  hasRetentionCoupon,
  planPriceToCents,
};
