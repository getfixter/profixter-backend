const mongoose = require("mongoose");

/**
 * One "Charge extra" on a booking: agreed additional work, charged once.
 *
 * Written BEFORE Stripe is contacted, so every PaymentIntent and every
 * Checkout page made for it carries this record's id in its metadata and can
 * be traced back - a timeout, a double tap or a replayed webhook always finds
 * the same record and never creates a second payable charge.
 *
 * Ownership is bound here once: `booking`, `user` and `stripeCustomerId` are
 * resolved on the server from the booking's stored account (never from the
 * browser) and every later step re-checks them against this record.
 *
 * Money is integer cents. Nothing here changes the booking, visit
 * entitlements, loyalty or membership billing.
 */
const STATUSES = Object.freeze([
  "charging", // claimed; the PaymentIntent request is in flight (shown as Processing)
  "processing", // Stripe is processing, or the outcome is not known yet
  "awaiting_payment", // a payment link is out; the customer pays on Stripe's page
  "paid",
  "failed",
  "partially_refunded",
  "refunded",
  "canceled", // the owner closed an unpaid charge
]);

const AttemptSchema = new mongoose.Schema(
  {
    n: { type: Number, required: true },
    kind: { type: String, enum: ["card", "checkout"], required: true },
    stripeIdempotencyKey: { type: String, default: "" },
    paymentIntentId: { type: String, default: "" },
    checkoutSessionId: { type: String, default: "" },
    status: { type: String, default: "" },
    errorCode: { type: String, default: "" },
    declineCode: { type: String, default: "" },
    message: { type: String, default: "" },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const AdditionalChargeSchema = new mongoose.Schema(
  {
    booking: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", required: true, index: true },
    bookingNumber: { type: String, default: "" },
    seq: { type: Number, required: true },
    number: { type: String, required: true },
    /* The owner's sheet makes one key per intent: the same key twice is the same charge. */
    clientKey: { type: String, required: true },

    /* Ownership, resolved on the server from the booking (null for a guest visit). */
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    accountUserId: { type: String, default: "" },
    guest: { type: Boolean, default: false },
    stripeCustomerId: { type: String, default: "", index: true },
    customerName: { type: String, default: "" },
    /* Where Stripe sends its receipt: the account's email (the booking's for a guest). */
    receiptEmail: { type: String, default: "" },
    serviceAddress: {
      line1: { type: String, default: "" },
      unit: { type: String, default: "" },
      city: { type: String, default: "" },
      state: { type: String, default: "" },
      zip: { type: String, default: "" },
    },

    description: { type: String, required: true, maxlength: 500 },
    currency: { type: String, default: "usd" },
    subtotalCents: { type: Number, required: true, min: 50 },
    taxCents: { type: Number, required: true, min: 0 },
    totalCents: { type: Number, required: true, min: 50 },
    tax: {
      treatment: { type: String, required: true },
      source: { type: String, default: "" }, // stripe_tax | owner_treatment
      calculationId: { type: String, default: "" },
      calculationExpiresAt: { type: Date, default: null },
      taxCode: { type: String, default: "" },
      taxabilityReason: { type: String, default: "" },
      ratePercent: { type: String, default: "" },
      transactionId: { type: String, default: "" },
      transactionError: { type: String, default: "" },
      reversals: { type: [{ refundedCents: Number, transactionId: String, at: Date, _id: false }], default: [] },
    },

    /*
     * The owner's statement, exactly as confirmed. It records what the OWNER
     * said; it is not proof of the customer's consent on its own.
     */
    consent: {
      statement: { type: String, required: true },
      confirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
      confirmedByName: { type: String, default: "" },
      confirmedAt: { type: Date, required: true },
      description: { type: String, required: true },
      totalCents: { type: Number, required: true },
      writtenApprovalRef: { type: String, default: "", maxlength: 300 },
    },

    method: { type: String, enum: ["card", "link"], required: true },
    status: { type: String, enum: STATUSES, required: true, index: true },
    statusChangedAt: { type: Date, default: Date.now },
    attempts: { type: [AttemptSchema], default: [] },

    paymentMethodId: { type: String, default: "" },
    card: {
      brand: { type: String, default: "" },
      last4: { type: String, default: "" },
      expMonth: { type: Number, default: null },
      expYear: { type: Number, default: null },
    },
    paymentIntentId: { type: String, default: "", index: true },
    chargeId: { type: String, default: "" },
    receiptUrl: { type: String, default: "" },
    paidAt: { type: Date, default: null },
    failure: {
      code: { type: String, default: "" },
      declineCode: { type: String, default: "" },
      message: { type: String, default: "" },
    },
    refundedCents: { type: Number, default: 0 },
    /* A second payment that reached Stripe for an already-paid charge: refund it in Stripe. */
    extraPayments: { type: [{ paymentIntentId: String, amountCents: Number, at: Date, _id: false }], default: [] },

    paymentLink: { type: mongoose.Schema.Types.ObjectId, ref: "AdminPaymentLink", default: null },
    lastStripeSyncAt: { type: Date, default: null },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    createdByName: { type: String, default: "" },
  },
  { timestamps: true }
);

AdditionalChargeSchema.index({ booking: 1, seq: 1 }, { unique: true });
AdditionalChargeSchema.index({ booking: 1, clientKey: 1 }, { unique: true });

AdditionalChargeSchema.statics.STATUSES = STATUSES;

module.exports = mongoose.models.AdditionalCharge || mongoose.model("AdditionalCharge", AdditionalChargeSchema);
