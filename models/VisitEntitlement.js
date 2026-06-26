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
      enum: ["one_time_handyman_visit"],
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
    sparse: true,
    name: "visit_entitlement_unique_checkout_session",
  }
);

VisitEntitlementSchema.index(
  { stripePaymentIntentId: 1 },
  {
    unique: true,
    sparse: true,
    name: "visit_entitlement_unique_payment_intent",
  }
);

module.exports = mongoose.model("VisitEntitlement", VisitEntitlementSchema);
