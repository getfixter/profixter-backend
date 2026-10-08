const mongoose = require("mongoose");

/**
 * Small named bookmarks for background analytics jobs, e.g. how far the
 * Stripe revenue ledger has been synced. One document per key.
 */
const analyticsStateSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    value: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, minimize: false }
);

module.exports = mongoose.models.AnalyticsState || mongoose.model("AnalyticsState", analyticsStateSchema);
