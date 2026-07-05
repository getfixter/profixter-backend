const mongoose = require("mongoose");

const SubscriptionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    userId: { type: String, required: true, index: true }, // public 8-digit ID

    subscriptionType: {
      type: String,
      required: true,
      enum: ["basic", "plus", "premium", "elite"],
      index: true,
    },

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

    stripeCustomerId: { type: String, default: null, index: true },
    stripeSubscriptionId: { type: String, default: null, index: true, sparse: true },
    stripeSubscriptionItemId: { type: String, default: null },
    stripePriceId: { type: String, default: null },
    stripeCheckoutSessionId: { type: String, default: null },

    billingCycle: {
      type: String,
      enum: ["monthly", "annual"],
      default: "monthly",
      index: true,
    },

    startDate: { type: Date, required: true },
    latestPaymentDate: { type: Date, required: true },
    nextPaymentDate: { type: Date, required: true },
    currentPeriodStart: { type: Date, default: null },
    currentPeriodEnd: { type: Date, default: null },
    trialStart: { type: Date, default: null },
    trialEnd: { type: Date, default: null },
    latestInvoiceId: { type: String, default: null },
    latestInvoiceStatus: { type: String, default: null },
    latestPaymentIntentStatus: { type: String, default: null },
    accessStatus: {
      type: String,
      enum: ["active", "inactive"],
      default: "inactive",
      index: true,
    },

    status: {
      type: String,
      enum: [
        "active",
        "trialing",
        "past_due",
        "unpaid",
        "incomplete",
        "incomplete_expired",
        "canceled",
        "expired",
        "paused",
      ],
      default: "active",
      index: true,
    },

    cancelAtPeriodEnd: { type: Boolean, default: false },
    cancellationDate: { type: Date, default: null },
    cancellationReason: { type: String, default: null },
    retentionOffer: {
      offeredAt: { type: Date, default: null },
      declinedAt: { type: Date, default: null },
      acceptedAt: { type: Date, default: null },
      stripeCouponId: { type: String, default: null },
      stripeDiscountId: { type: String, default: null },
      discountAmountCents: { type: Number, default: null },
      discountCurrency: { type: String, default: null },
      discountDescription: { type: String, default: null },
      lastErrorAt: { type: Date, default: null },
      lastErrorMessage: { type: String, default: null },
    },
    pendingPlan: {
      type: String,
      enum: ["basic", "plus", "premium", "elite", null],
      default: null,
    },
    pendingBillingCycle: {
      type: String,
      enum: ["monthly", "annual", null],
      default: null,
    },
    pendingStripePriceId: { type: String, default: null },
    pendingChangeEffectiveDate: { type: Date, default: null },

    renewalAttempts: { type: Number, default: 0 },
    planPrice: { type: Number, default: 0 },
    paymentMethod: { type: String, default: "card" },
  },
  { timestamps: true }
);

SubscriptionSchema.index(
  { user: 1, addressId: 1, status: 1 },
  { name: "subscription_user_address_status_idx" }
);

// Enforce exactly one active subscription per (user, address) at the DB level.
// Run scripts/repair_subscriptions.js to eliminate existing duplicates before deploying,
// otherwise Mongoose will log an index-build error on startup (non-fatal, but the guard
// won't be active until duplicates are removed).
SubscriptionSchema.index(
  { user: 1, addressId: 1 },
  {
    name: "subscription_one_active_per_address_idx",
    unique: true,
    partialFilterExpression: { status: { $in: ["active", "trialing"] } },
  }
);

module.exports = mongoose.model("Subscription", SubscriptionSchema);
