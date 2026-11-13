const mongoose = require("mongoose");

/**
 * One client-supplied idempotency key for an externally visible Admin action
 * (a status transition that texts or emails the customer, a reschedule).
 *
 * The first request with a key claims it ("pending"), does the work and stores
 * the response ("completed"). A replay of the same key returns that stored
 * response and repeats nothing. A failed attempt deletes its claim so the
 * client can retry with the same key.
 *
 * Scoped by actor and action, so one person's key can never replay another
 * person's result. Expires after 24 hours (TTL index on expiresAt).
 */
const AdminIdempotencyRecordSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true, maxlength: 120 },
    scope: { type: String, required: true, trim: true, maxlength: 160 },
    actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    entityId: { type: String, default: "" },
    status: { type: String, enum: ["pending", "completed"], default: "pending" },
    httpStatus: { type: Number, default: 200 },
    response: { type: mongoose.Schema.Types.Mixed, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

AdminIdempotencyRecordSchema.index({ scope: 1, key: 1 }, { unique: true, name: "admin_idempotency_scope_key" });
AdminIdempotencyRecordSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "admin_idempotency_ttl" });

module.exports = mongoose.model("AdminIdempotencyRecord", AdminIdempotencyRecordSchema);
