const mongoose = require("mongoose");

/**
 * Tokens signed out before sessions existed.
 *
 * A token issued before the release that introduced models/Session has no
 * "sid" claim, so there is no session record to revoke. Signing such a token
 * out stores the sha256 of the token (never the token) until the moment the
 * token would have expired on its own; after that the TTL index drops the row
 * because jwt.verify refuses the token anyway.
 */
const RevokedTokenSchema = new mongoose.Schema({
  tokenHash: { type: String, required: true, unique: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  revokedAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
});

RevokedTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("RevokedToken", RevokedTokenSchema);
