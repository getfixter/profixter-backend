const mongoose = require("mongoose");

/**
 * One successful Stripe charge, classified for the Admin Overview.
 *
 * A read-only mirror kept by utils/analytics/stripeRevenue.js: a one-time
 * backfill, then only new charges and new refunds. The Overview reads this
 * instead of paging through a year of Stripe charges on every request
 * (~30s, which left the dashboard on skeletons).
 *
 * Stripe stays the source of truth. Nothing here is written back to Stripe
 * and nothing else in the app reads it.
 */
const revenueChargeSchema = new mongoose.Schema(
  {
    chargeId: { type: String, required: true, unique: true },
    created: { type: Date, required: true, index: true },
    kind: { type: String, required: true },
    plan: { type: String, default: null },
    billingCycle: { type: String, default: null },
    /* What the card was charged, after coupons, including sales tax. */
    cents: { type: Number, required: true },
    refundedCents: { type: Number, default: 0 },
    /* Sales tax inside `cents`. Not revenue: it is owed to the state. */
    taxCents: { type: Number, default: 0 },
    stripeCustomerId: { type: String, default: null },
    userRef: { type: String, default: null },
    subscriptionId: { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.models.RevenueCharge || mongoose.model("RevenueCharge", revenueChargeSchema);
