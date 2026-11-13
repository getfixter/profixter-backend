const mongoose = require("mongoose");

/**
 * One Admin customer action, remembered by the client's idempotency key.
 *
 * Money-moving and customer-visible actions (plan change, cancellation date)
 * take an idempotencyKey. The first request claims the key here ("pending");
 * when it finishes, the HTTP status and body it answered with are stored
 * ("done"). A repeat of the same key - a double tap, a retry after a dropped
 * connection - gets that stored answer back and nothing is done twice.
 *
 * Kept for 24 hours, which matches how long Stripe itself remembers a key.
 */
const CustomerActionReceiptSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    scope: { type: String, required: true },
    actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    targetUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    /* "<userId>:<addressId>": a key replays only for the customer and home it was first used for. */
    target: { type: String, default: "" },
    status: { type: String, enum: ["pending", "done"], default: "pending" },
    httpStatus: { type: Number, default: null },
    body: { type: mongoose.Schema.Types.Mixed, default: null },
    createdAt: { type: Date, default: Date.now, expires: 24 * 60 * 60 },
  },
  { versionKey: false }
);

module.exports = mongoose.models.CustomerActionReceipt || mongoose.model("CustomerActionReceipt", CustomerActionReceiptSchema);
