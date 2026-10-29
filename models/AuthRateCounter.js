const mongoose = require("mongoose");

/**
 * A fixed-window counter for sign-in abuse limits, shared by every server.
 *
 * In the database rather than in memory because production can scale to more
 * than one instance, and a per-process limit multiplies by the number of
 * processes - exactly what somebody pumping SMS would rely on.
 */
const AuthRateCounterSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  count: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true },
});

AuthRateCounterSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("AuthRateCounter", AuthRateCounterSchema);
