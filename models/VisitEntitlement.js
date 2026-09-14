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
     *
     * "loyalty_benefit" is an EXTRA Full Day earned by staying a member, and it
     * works the opposite way round from the included one. The included benefit
     * is recognised by its ABSENCE — no record for this period means one is
     * available, and writing the record is what spends it. A loyalty day is
     * recognised by its PRESENCE: the record is granted up front and carries the
     * day until it is used or expires.
     *
     * The two cannot be confused, because findIncludedEntitlement filters on
     * source "membership_benefit" and never sees a loyalty row. That is what
     * makes the loyalty day genuinely additive: an Elite member holding one
     * still has their ordinary included Full Day, untouched.
     */
    source: {
      type: String,
      enum: ["purchase", "membership_benefit", "loyalty_benefit"],
      default: "purchase",
      required: true,
      index: true,
    },

    /*
     * The Loyalty Benefit that produced this entitlement.
     *
     * Also the duplicate defence. The per-period index below cannot protect a
     * loyalty day — its partial filter requires source "membership_benefit" —
     * so a loyalty row carries its own unique key instead. One grant, one Full
     * Day, however many times the webhook is delivered.
     */
    loyaltyGrantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LoyaltyGrant",
      default: null,
      index: true,
    },

    /*
     * When an unused loyalty day stops being usable.
     *
     * Ninety days from grant. Deliberately a date rather than a status a job
     * has to set, on the same reasoning as gift access: a sweep that does not
     * run must never be able to hand somebody a benefit that should have
     * lapsed, nor take one away that should not have. Null for everything else,
     * which has no expiry.
     */
    expiresAt: { type: Date, default: null, index: true },

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

/*
 * One Full Day per Loyalty grant.
 *
 * The index above cannot do this job: its partial filter is pinned to
 * source "membership_benefit" and a loyalty row falls outside it entirely, so
 * without this two concurrent grants would both succeed and an Elite member
 * would hold two Full Days from one milestone.
 *
 * Partial on the grant id, so the many nulls on every purchased and included
 * entitlement do not collide with each other. Unlike the per-period index this
 * one deliberately ignores status: a consumed or expired loyalty day must still
 * block its grant from producing a second, because the grant was already spent.
 */
VisitEntitlementSchema.index(
  { loyaltyGrantId: 1 },
  {
    unique: true,
    name: "one_entitlement_per_loyalty_grant",
    partialFilterExpression: { loyaltyGrantId: { $type: "objectId" } },
  }
);

module.exports = mongoose.model("VisitEntitlement", VisitEntitlementSchema);
