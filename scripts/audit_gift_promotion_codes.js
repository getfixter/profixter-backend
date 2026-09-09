/**
 * Which existing promotion codes would work on a gift purchase.
 *
 *   node scripts/audit_gift_promotion_codes.js
 *
 * READ ONLY. Lists and retrieves; it never creates, updates or deletes a
 * coupon, promotion code, product or price. Safe to run against live keys, and
 * deliberately written so that is obvious from the code rather than promised
 * in a comment.
 *
 * WHY THIS IS NEEDED
 *
 * A gift is billed with an INLINE one-time price, not the membership's
 * recurring price, and it therefore has no Stripe Product behind it. That is
 * the right way to charge for a gift — a recurring price would create a
 * subscription — but it has a consequence for coupons:
 *
 *   - A coupon restricted to specific products (applies_to.products) can never
 *     match a gift, because the gift line has no product id to match against.
 *   - A coupon whose duration is "repeating" or "forever" is meaningful only
 *     on a subscription. On a one-time payment Stripe applies it once, so it
 *     behaves like "once" — worth knowing before somebody expects otherwise.
 *   - Everything else — percent or amount off, "once" duration, redemption
 *     limits, expiry, first-time-customer restrictions — works normally.
 *
 * Run this before enabling GIFTS_ENABLED so the answer is known rather than
 * discovered by a customer whose code was refused.
 */

require("dotenv").config();

const KEY = process.env.STRIPE_SECRET_KEY;
if (!KEY) {
  console.error("STRIPE_SECRET_KEY is not set. Nothing to audit.");
  process.exit(1);
}

const stripe = require("stripe")(KEY);

const LIVE = KEY.startsWith("sk_live_");

function verdictFor(coupon) {
  const reasons = [];
  let worksOnGifts = true;

  const products = coupon?.applies_to?.products || [];
  if (products.length) {
    worksOnGifts = false;
    reasons.push(
      `restricted to ${products.length} product(s); a gift line has no product id, so it cannot match`
    );
  }

  if (coupon?.duration === "repeating") {
    reasons.push(
      `duration "repeating" (${coupon.duration_in_months} months) behaves as "once" on a one-time payment`
    );
  } else if (coupon?.duration === "forever") {
    reasons.push('duration "forever" behaves as "once" on a one-time payment');
  }

  if (coupon?.valid === false) {
    worksOnGifts = false;
    reasons.push("coupon is no longer valid");
  }

  if (coupon?.currency && coupon.currency.toLowerCase() !== "usd") {
    worksOnGifts = false;
    reasons.push(`amount-off is in ${coupon.currency.toUpperCase()}, gifts are charged in USD`);
  }

  return { worksOnGifts, reasons };
}

async function main() {
  console.log(`\nStripe key: ${LIVE ? "LIVE" : "TEST"} mode`);
  console.log("Mode: READ ONLY — nothing will be created or changed.\n");

  const promos = await stripe.promotionCodes.list({ limit: 100, expand: ["data.coupon"] });

  if (!promos.data.length) {
    console.log("No promotion codes exist on this account.");
    return;
  }

  const works = [];
  const blocked = [];

  for (const promo of promos.data) {
    const coupon = promo.coupon || {};
    const { worksOnGifts, reasons } = verdictFor(coupon);

    const discount = coupon.percent_off
      ? `${coupon.percent_off}% off`
      : coupon.amount_off
        ? `${(coupon.amount_off / 100).toFixed(2)} ${String(coupon.currency || "usd").toUpperCase()} off`
        : "unknown discount";

    const row = {
      code: promo.code,
      active: promo.active,
      discount,
      duration: coupon.duration,
      restrictedToProducts: (coupon.applies_to?.products || []).length,
      maxRedemptions: promo.max_redemptions ?? null,
      timesRedeemed: promo.times_redeemed,
      expiresAt: promo.expires_at ? new Date(promo.expires_at * 1000).toISOString().slice(0, 10) : null,
      firstTimeOnly: promo.restrictions?.first_time_transaction || false,
      minimumAmount: promo.restrictions?.minimum_amount ?? null,
      reasons,
    };

    (worksOnGifts ? works : blocked).push(row);
  }

  const line = (row) =>
    `  ${row.code.padEnd(20)} ${row.discount.padEnd(18)} ` +
    `${row.active ? "active " : "INACTIVE"} ${row.duration.padEnd(10)}` +
    (row.reasons.length ? `\n      note: ${row.reasons.join("; ")}` : "");

  console.log(`WORKS ON GIFTS (${works.length})`);
  console.log(works.length ? works.map(line).join("\n") : "  none");

  console.log(`\nWILL NOT WORK ON GIFTS (${blocked.length})`);
  console.log(blocked.length ? blocked.map(line).join("\n") : "  none");

  console.log("\nWHAT WOULD BE NEEDED TO FIX A BLOCKED CODE");
  console.log("  A product-restricted coupon cannot be made to match a gift without either:");
  console.log("    a) creating a Stripe Product for gift memberships and adding it to the");
  console.log("       coupon's applies_to list, then billing gifts against a price on that");
  console.log("       product instead of an inline price; or");
  console.log("    b) creating a separate, gift-specific promotion code with no product");
  console.log("       restriction.");
  console.log("  (b) is the smaller change and does not touch any existing code.");
  console.log("  NEITHER has been done. This script changes nothing.\n");
}

main().catch((error) => {
  console.error("Audit failed:", error?.message || error);
  process.exit(1);
});
