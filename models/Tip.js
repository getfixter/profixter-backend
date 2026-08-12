const mongoose = require("mongoose");

/**
 * A tip a customer left for a Fixter.
 *
 * KEYED ON THE PAYMENT INTENT
 * The unique index on stripePaymentIntentId is the whole idempotency story.
 * Stripe delivers checkout.session.completed more than once, retries failed
 * deliveries, and a customer refreshing the tip page can produce a second
 * Checkout Session. None of that may produce a second Tip, and a database
 * constraint is the only place that guarantee holds under concurrency.
 *
 * TOTALS ARE DERIVED, NEVER COUNTED
 * There is deliberately no running balance anywhere. Every figure an admin or a
 * Fixter sees is summed from these records in integer cents at read time, so a
 * lost event, a replayed event or a manual correction can never leave a stored
 * total disagreeing with the transactions behind it.
 *
 * ATTRIBUTION IS RECORDED, NEVER GUESSED
 * `fixter` is set only when the server resolved a real employee from a token it
 * issued itself. A tip that arrives without resolvable context is stored with
 * assignmentStatus "unassigned" and surfaced to the admin for manual
 * assignment. Money is never quietly credited to whoever seems likely.
 *
 * REFUNDS REDUCE, THEY DO NOT DELETE
 * A refund lowers refundedCents on the existing record. The tip still happened
 * and still belongs in the history; what changed is how much was retained.
 */
const TipSchema = new mongoose.Schema(
  {
    /** The employee this tip belongs to. Null until attribution is established. */
    fixter: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    /**
     * Who the Fixter was at the time. Employees can be deleted, and a tip that
     * has already been paid must stay readable in the ledger afterwards.
     */
    fixterNameSnapshot: { type: String, trim: true, maxlength: 160, default: "" },
    fixterPositionSnapshot: {
      type: String,
      enum: ["Fixter", "General Fixter", ""],
      default: "",
    },

    amountCents: { type: Number, required: true, min: 0 },
    currency: { type: String, trim: true, lowercase: true, maxlength: 10, default: "usd" },
    receivedAt: { type: Date, required: true, index: true },

    status: {
      type: String,
      enum: ["pending", "succeeded", "refunded", "partially_refunded"],
      default: "succeeded",
      required: true,
      index: true,
    },

    /** Stripe identity. The PaymentIntent is the idempotency key. */
    stripePaymentIntentId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      maxlength: 120,
    },
    stripeCheckoutSessionId: { type: String, trim: true, maxlength: 120, default: "" },
    /** Kept for audit rather than for matching. */
    stripeEventId: { type: String, trim: true, maxlength: 120, default: "" },

    /** Who left it. ProFixter data where we have it, Stripe's only as a fallback. */
    tipperName: { type: String, trim: true, maxlength: 160, default: "" },
    tipperEmail: { type: String, trim: true, lowercase: true, maxlength: 254, default: "" },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    tipperKind: {
      type: String,
      enum: ["customer", "visitor", "unknown"],
      default: "unknown",
      index: true,
    },

    booking: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      default: null,
      index: true,
    },
    bookingNumberSnapshot: { type: String, trim: true, maxlength: 60, default: "" },

    /** Cumulative cents refunded to the customer, never more than amountCents. */
    refundedCents: { type: Number, min: 0, default: 0 },
    refundStatus: { type: String, enum: ["", "partial", "full"], default: "" },
    refundedAt: { type: Date, default: null },

    assignmentStatus: {
      type: String,
      enum: ["attributed", "unassigned", "manually_assigned"],
      default: "unassigned",
      required: true,
      index: true,
    },
    assignedAt: { type: Date, default: null },
    assignedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    /** Why this tip could not be attributed automatically, for the admin. */
    unassignedReason: { type: String, trim: true, maxlength: 240, default: "" },

    /** How the customer reached the tip page. */
    source: {
      type: String,
      enum: ["completion_email", "direct"],
      default: "direct",
    },
    notificationSentAt: { type: Date, default: null },
  },
  { timestamps: true }
);

TipSchema.index({ fixter: 1, receivedAt: -1 });
TipSchema.index({ assignmentStatus: 1, receivedAt: -1 });

module.exports = mongoose.model("Tip", TipSchema);
