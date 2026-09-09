const { PLAN_CATALOG } = require("../subscriptionManagement");

/**
 * The four stable Stripe Products a gift is sold against.
 *
 * WHY STABLE PRODUCTS AT ALL
 *
 * A gift line item is an inline one-time amount, so Stripe will happily mint a
 * throwaway Product for each checkout if we let it. That works, but it costs
 * two things we want back:
 *
 *   1. Coupon control. A coupon restricted with applies_to.products can never
 *      match a product id that is invented at checkout time, and neither can
 *      one that is meant to EXCLUDE gifts. Without a stable product every
 *      unrestricted membership coupon silently discounts gifts, and there is
 *      no way to say otherwise.
 *   2. Tax and reporting. A tax code belongs on a Product, and Stripe's
 *      product reporting cannot aggregate revenue across ids that never repeat.
 *
 * WHAT STAYS EXACTLY AS IT WAS
 *
 * The AMOUNT still comes from PLAN_CATALOG, computed as the monthly price
 * times the number of months. There is no Stripe Price object for a gift and
 * there must never be one: a Price is the thing that can carry a `recurring`
 * block, and a recurring gift price is the single failure this architecture
 * exists to make impossible. Products are catalogue identity and nothing else.
 *
 * THE ID IS NOT A BILLING LINK
 *
 * A Product id says what was sold. It carries no customer, no payment method
 * and no subscription, so it cannot become a path between the purchaser's
 * billing identity and the recipient's. That separation is enforced elsewhere
 * (see utils/gifts/giftService and models/GiftMembership); this file only
 * needs to not undo it.
 */

/** Env var per plan, following the STRIPE_<KIND>_<THING> shape already in use. */
const PRODUCT_ENV = {
  basic: "STRIPE_PRODUCT_GIFT_BASIC",
  plus: "STRIPE_PRODUCT_GIFT_PLUS",
  premium: "STRIPE_PRODUCT_GIFT_PREMIUM",
  elite: "STRIPE_PRODUCT_GIFT_ELITE",
};

const PLANS = Object.keys(PRODUCT_ENV);

/**
 * Optional Stripe tax code for the transient-product shape.
 *
 * Only consulted when no stable Product is configured, which in a running
 * application means never — the route refuses to reach Stripe without one.
 * With a stable Product the tax code lives on the Product in Stripe, which is
 * the whole point of having one.
 */
function giftTaxCode() {
  return String(process.env.STRIPE_TAX_CODE_GIFT_MEMBERSHIP || "").trim();
}

function giftProductId(plan) {
  const key = String(plan || "").trim().toLowerCase();
  const envName = PRODUCT_ENV[key];
  if (!envName) return "";
  return String(process.env[envName] || "").trim();
}

/** Stripe product ids are `prod_` followed by an opaque identifier. */
function looksLikeProductId(value) {
  return /^prod_[A-Za-z0-9]{6,}$/.test(String(value || ""));
}

/** The recurring membership products. A gift must never be sold against one. */
function membershipProductIds() {
  return new Set(
    Object.values(PLAN_CATALOG)
      .map((entry) => String(entry?.stripeProductId || ""))
      .filter(Boolean)
  );
}

/**
 * Whether the four gift Products are configured well enough to sell against.
 *
 * Three separate ways to be wrong, reported separately because they need
 * different fixes:
 *
 *   missing      nobody set the variable
 *   invalid      it is set to something that is not a Stripe product id
 *   reused       it points at a MEMBERSHIP product
 *
 * The last one matters more than it looks. Pointing a gift at the recurring
 * membership product would fold gift revenue into membership reporting and,
 * worse, make every coupon restricted to membership products apply to gifts —
 * which is the exact exposure stable products were introduced to close.
 */
function giftProductStatus() {
  const membership = membershipProductIds();
  const missing = [];
  const invalid = [];
  const reused = [];
  const seen = new Map();
  const duplicated = [];

  for (const plan of PLANS) {
    const id = giftProductId(plan);
    if (!id) {
      missing.push(plan);
      continue;
    }
    if (!looksLikeProductId(id)) {
      invalid.push(plan);
      continue;
    }
    if (membership.has(id)) {
      reused.push(plan);
      continue;
    }
    if (seen.has(id)) duplicated.push(plan);
    seen.set(id, plan);
  }

  return {
    ok: !missing.length && !invalid.length && !reused.length && !duplicated.length,
    missing,
    invalid,
    reused,
    duplicated,
    configuredCount: seen.size,
  };
}

/** A one-line reason for logs and the admin/health surface. Never customer copy. */
function giftProductStatusReason(status = giftProductStatus()) {
  if (status.ok) return "";
  const parts = [];
  if (status.missing.length) parts.push(`missing: ${status.missing.join(", ")}`);
  if (status.invalid.length) parts.push(`invalid: ${status.invalid.join(", ")}`);
  if (status.reused.length) parts.push(`reuses membership product: ${status.reused.join(", ")}`);
  if (status.duplicated.length) parts.push(`duplicated across plans: ${status.duplicated.join(", ")}`);
  return parts.join("; ");
}

module.exports = {
  PLANS,
  PRODUCT_ENV,
  giftProductId,
  giftProductStatus,
  giftProductStatusReason,
  giftTaxCode,
  looksLikeProductId,
  membershipProductIds,
};
