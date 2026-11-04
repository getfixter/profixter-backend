const mongoose = require("mongoose");

/**
 * Times the Google review link (profixter.com/review) was opened, per New York
 * day and per place the link was in.
 *
 * via: email (the post-visit review email), account (visit history), home
 * (the homepage reviews section), other (an old link or a typed address).
 *
 * Aggregate only: no person, no IP, no booking. A browser counts once per day
 * and place (FunnelStepSeen, which expires on its own), so a reload or a
 * double tap does not inflate it. An open is somebody reaching Google's review
 * form, never proof that a review was posted.
 */
const VIAS = ["email", "account", "home", "other"];

const reviewLinkClickSchema = new mongoose.Schema(
  {
    date: { type: String, required: true }, // YYYY-MM-DD, America/New_York
    via: { type: String, enum: VIAS, required: true },
    count: { type: Number, default: 0 },
  },
  { timestamps: false }
);
reviewLinkClickSchema.index({ date: 1, via: 1 }, { unique: true });

module.exports = mongoose.models.ReviewLinkClick || mongoose.model("ReviewLinkClick", reviewLinkClickSchema);
module.exports.VIAS = VIAS;
