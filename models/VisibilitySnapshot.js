const mongoose = require("mongoose");

/**
 * One measurement of how visible Profixter is, from one outside source, on one
 * day. Written by the visibility collectors (utils/visibility/*) and read by
 * the Growth Command Center; nothing on a customer request path reads it.
 *
 * - source: which collector wrote it.
 *     google_reviews  key = Google place id      metrics { rating, total }
 *     search_console  key = "totals" | "queries" | "pages"   (one row per day
 *                     per kind, the day's rows bundled; see searchConsole.js)
 *     local_rank      key = "<keyword>|<lat>,<lng>"           metrics { rank, ... }
 *     ai_visibility   key = "<prompt id>|<engine>"            metrics { scores, ... }
 * - date: YYYY-MM-DD in America/New_York, the business's day boundary (the
 *   same one the Admin Overview uses). For Search Console it is the day the
 *   data describes, not the day it was fetched.
 * - metrics: deliberately schemaless. Each source owns its shape, and a new
 *   measurement must not need a migration.
 *
 * (source, date, key) is unique, so re-running a collector for the same day,
 * or re-reading a day that the source has since restated, replaces the row in
 * place instead of adding a second one.
 */
const visibilitySnapshotSchema = new mongoose.Schema(
  {
    source: {
      type: String,
      required: true,
      enum: ["google_reviews", "search_console", "local_rank", "ai_visibility"],
    },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    key: { type: String, required: true },
    metrics: { type: mongoose.Schema.Types.Mixed, default: {} },
    fetchedAt: { type: Date, required: true },
  },
  { timestamps: true, minimize: false }
);

visibilitySnapshotSchema.index({ source: 1, date: 1, key: 1 }, { unique: true, name: "visibility_natural_key" });

module.exports =
  mongoose.models.VisibilitySnapshot || mongoose.model("VisibilitySnapshot", visibilitySnapshotSchema);
