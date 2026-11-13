const mongoose = require("mongoose");

/**
 * A server-side record of one sign-in, so a token can be ended before it
 * expires.
 *
 * Every token minted by utils/auth/accounts.issueSession carries this record's
 * id as the "sid" claim, and middleware/auth.js refuses a token whose session
 * is revoked or missing. The bearer token itself is unchanged in every other
 * way (same claims, same 30-day life), so nothing on the client had to change.
 *
 * No secret is stored here: only who, when, and a short description of the
 * device for the "your sessions" list. The record is removed by TTL once the
 * token it backs could no longer be used anyway.
 */
const SessionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    lastSeenAt: { type: Date, default: Date.now },
    userAgent: { type: String, default: "", maxlength: 160 },
    // sha256 of the client IP: enough to tell two devices apart, not to locate anyone.
    ipHash: { type: String, default: "" },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: "" },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

SessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("Session", SessionSchema);
