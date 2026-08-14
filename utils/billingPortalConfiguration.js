/**
 * What the Stripe Customer Portal is allowed to offer an existing member.
 *
 * Existing members could only ever see the four monthly prices, because the
 * portal session is created without a `configuration` and therefore falls back
 * to the account's default configuration — whose product list is edited in the
 * Stripe Dashboard and was last touched before the annual prices existed. There
 * was nothing wrong with the code; the list simply had one price per product.
 *
 * A Dashboard-managed list is also invisible: `products` is omitted from the API
 * response unless explicitly expanded, so the omission could not be noticed by
 * reading either the code or a plain API read. Defining it here instead means
 * the portal's offer is reviewable, diffable and testable like anything else,
 * and `resolveBillingPortalConfigurationId` keeps Stripe authoritative about
 * which configuration is actually in force.
 *
 * Everything else in this file deliberately mirrors the live default
 * configuration, so applying it changes exactly one thing: annual becomes
 * reachable.
 */

const { PLAN_CATALOG } = require("./subscriptionManagement");

/*
 * Downgrades wait for the end of the paid period; upgrades happen now.
 *
 * `decreasing_item_amount` defers any move to a cheaper price, and
 * `shortening_interval` defers any move from a longer billing interval to a
 * shorter one. Together they are what makes Annual -> Monthly land at the end of
 * the year the member already paid for, rather than becoming a refund question.
 * Both are already set on the live configuration and are carried over unchanged.
 */
const SCHEDULE_AT_PERIOD_END_CONDITIONS = [
  { type: "decreasing_item_amount" },
  { type: "shortening_interval" },
];

function membershipProducts() {
  return Object.values(PLAN_CATALOG)
    .sort((a, b) => a.rank - b.rank)
    .map((plan) => ({
      product: plan.stripeProductId,
      prices: [plan.monthly.stripePriceId, plan.annual.stripePriceId],
      /*
       * A membership covers one address, so a quantity of two is not a thing a
       * member can meaningfully buy. The live configuration leaves this enabled,
       * which lets the portal show a quantity stepper beside the plan.
       */
      adjustable_quantity: { enabled: false },
    }));
}

function buildPortalConfigurationParams() {
  return {
    business_profile: {
      headline: "Manage your ProFixter membership",
    },
    features: {
      customer_update: {
        enabled: true,
        allowed_updates: ["name", "email", "address", "phone"],
      },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: {
        enabled: true,
        mode: "at_period_end",
        proration_behavior: "none",
        cancellation_reason: {
          enabled: true,
          options: ["too_expensive", "switched_service", "unused", "other"],
        },
      },
      subscription_update: {
        enabled: true,
        default_allowed_updates: ["price"],
        proration_behavior: "always_invoice",
        schedule_at_period_end: { conditions: SCHEDULE_AT_PERIOD_END_CONDITIONS },
        products: membershipProducts(),
      },
    },
    metadata: {
      managed_by: "profixter_backend",
      purpose: "membership_monthly_and_annual",
    },
  };
}

/**
 * Which configuration a portal session should use.
 *
 * Unset means Stripe's account default, which is exactly today's behaviour, so
 * the change is reverted by clearing one environment variable rather than by
 * another deploy.
 */
function resolveBillingPortalConfigurationId() {
  const id = String(process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID || "").trim();
  return id || null;
}

/** Every price the portal is allowed to move a member on to. */
function allowedPortalPriceIds() {
  return membershipProducts().flatMap((product) => product.prices);
}

module.exports = {
  SCHEDULE_AT_PERIOD_END_CONDITIONS,
  buildPortalConfigurationParams,
  membershipProducts,
  allowedPortalPriceIds,
  resolveBillingPortalConfigurationId,
};
