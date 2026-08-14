const mongoose = require("mongoose");

const VisitEntitlementSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    userId: { type: String, required: true, index: true },
    addressId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    addressSnapshot: {
      line1: String,
      city: String,
      state: String,
      zip: String,
      county: String,
    },
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      default: null,
      index: true,
    },
    kind: {
      type: String,
      enum: ["one_time_handyman_visit", "full_day_visit"],
      default: "one_time_handyman_visit",
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: [
        "pending_payment",
        "paid",
        "consumed",
        "expired",
        "payment_failed",
        "canceled",
        "refunded",
      ],
      default: "pending_payment",
      required: true,
      index: true,
    },
    priceCents: { type: Number, default: 9900, min: 0 },
    currency: { type: String, default: "usd", lowercase: true },
    durationMinutes: { type: Number, default: 90, min: 1 },
    holdExpiresAt: { type: Date, default: null, index: true },
    stripeCustomerId: { type: String, default: null, index: true },
    stripeCheckoutSessionId: {
      type: String,
      default: null,
    },
    stripePaymentIntentId: {
      type: String,
      default: null,
    },
    purchasedAt: { type: Date, default: null },
    consumedAt: { type: Date, default: null },

    /*
     * How this entitlement came to exist.
     *
     * Everything written before Full Day existed was bought, so "purchase" is
     * the default and every historical document reads correctly without being
     * touched. "membership_benefit" is the Elite Full Day included with the
     * plan: no payment, granted once per billing period.
     */
    source: {
      type: String,
      enum: ["purchase", "membership_benefit"],
      default: "purchase",
      required: true,
      index: true,
    },

    /*
     * The billing period this benefit belongs to, copied from the subscription
     * at grant time rather than computed from a calendar month. A member whose
     * period runs the 12th to the 12th gets one Full Day per period, not one
     * per calendar month, and the two disagree for most of the year.
     *
     * Null for purchases, which are not tied to a period.
     */
    periodStart: { type: Date, default: null },
    periodEnd: { type: Date, default: null },
  },
  { timestamps: true }
);

VisitEntitlementSchema.index({
  user: 1,
  addressId: 1,
  kind: 1,
  status: 1,
});

VisitEntitlementSchema.index(
  { stripeCheckoutSessionId: 1 },
  {
    unique: true,
    name: "visit_entitlement_unique_checkout_session",
    partialFilterExpression: {
      stripeCheckoutSessionId: { $type: "string" },
    },
  }
);

VisitEntitlementSchema.index(
  { stripePaymentIntentId: 1 },
  {
    unique: true,
    name: "visit_entitlement_unique_payment_intent",
    partialFilterExpression: {
      stripePaymentIntentId: { $type: "string" },
    },
  }
);

/*
 * One live membership-benefit entitlement per customer, per address, per kind,
 * per billing period.
 *
 * This is the whole defence for the Elite Full Day. Double taps, retries,
 * duplicated requests and genuine races all end up trying to insert a second
 * document with the same five values, and the database refuses. Checking first
 * and then writing would leave a window; this leaves none.
 *
 * Partial on purpose, in three ways. It only applies to membership benefits, so
 * purchases are untouched. It only applies once periodStart exists, so every
 * document written before this field existed is outside the index and no
 * historical data has to be migrated or backfilled. And it excludes the states
 * that end an entitlement's life, so a cancelled or expired benefit does not
 * block the customer from being granted the next one.
 */
VisitEntitlementSchema.index(
  { user: 1, addressId: 1, kind: 1, source: 1, periodStart: 1 },
  {
    unique: true,
    name: "one_membership_benefit_per_period",
    partialFilterExpression: {
      source: "membership_benefit",
      periodStart: { $type: "date" },
      status: { $in: ["pending_payment", "paid", "consumed"] },
    },
  }
);

module.exports = mongoose.model("VisitEntitlement", VisitEntitlementSchema);
