const mongoose = require("mongoose");

/**
 * "Add eligible products to Studio" runs: which categories, how far it got,
 * what was added or skipped. A run that stops (server restart) is marked
 * interrupted; starting again continues where it stopped, because adding a
 * product that is already in the Studio does nothing.
 */
const StudioBulkJobSchema = new mongoose.Schema(
  {
    manufacturer: { type: String, required: true, index: true },
    groups: { type: [String], default: [] },
    status: { type: String, enum: ["running", "done", "failed", "interrupted"], default: "running", index: true },
    total: { type: Number, default: 0 },
    processed: { type: Number, default: 0 },
    added: { type: Number, default: 0 },
    companions: { type: Number, default: 0 },
    skipped: { type: Number, default: 0 },
    skippedReasons: { type: mongoose.Schema.Types.Mixed, default: {} },
    error: { type: String, default: "" },
    heartbeatAt: { type: Date, default: Date.now },
    finishedAt: { type: Date, default: null },
    durationMs: { type: Number, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true, minimize: false }
);

module.exports = mongoose.models.StudioBulkJob || mongoose.model("StudioBulkJob", StudioBulkJobSchema);
