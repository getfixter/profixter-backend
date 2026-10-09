const mongoose = require("mongoose");

/**
 * How much the growth system is trusted with one type of action.
 *
 * A row exists only once something has changed from the code default in
 * utils/growth/actionRegistry. The owner sets `mode`; the engine also moves it
 * on its own in exactly two ways:
 *
 *   promotion  supervised -> autonomous after the type's required run of
 *              verified successes, if the registry allows that type to run
 *              unattended at all;
 *   demotion   autonomous -> supervised on any failed run or failed
 *              verification. A broken automation must never keep running
 *              unattended because nobody happened to look.
 *
 * `setBy` records who or what made the last change, so the Command Center can
 * say "promoted automatically after 5 clean runs" rather than leaving the
 * owner to wonder.
 */
const growthPolicySchema = new mongoose.Schema(
  {
    type: { type: String, required: true, unique: true },
    mode: { type: String, enum: ["off", "shadow", "supervised", "autonomous"], required: true },
    setBy: {
      kind: {
        type: String,
        enum: ["owner", "auto_promotion", "auto_demotion"],
        default: "owner",
      },
      userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      note: { type: String, default: "" },
      at: { type: Date, default: null },
    },
    verifiedSuccesses: { type: Number, default: 0 },
    consecutiveVerifiedSuccesses: { type: Number, default: 0 },
    failures: { type: Number, default: 0 },
    lastFailureAt: { type: Date, default: null },
    promotedAt: { type: Date, default: null },
    demotedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.models.GrowthPolicy || mongoose.model("GrowthPolicy", growthPolicySchema);
