const mongoose = require("mongoose");

/**
 * One upload of a manufacturer's price file: the preview (what would change)
 * and, once the owner confirms, what was applied. The file itself is kept in
 * private storage so the confirmed import applies exactly what was previewed.
 */
const StudioCatalogImportSchema = new mongoose.Schema(
  {
    manufacturer: { type: String, required: true, index: true },
    fileName: { type: String, default: "" },
    fileSha256: { type: String, required: true },
    fileBytes: { type: Number, default: 0 },
    storageKey: { type: String, default: "" },
    status: { type: String, enum: ["previewed", "applying", "applied", "failed", "superseded"], default: "previewed", index: true },
    summary: { type: mongoose.Schema.Types.Mixed, default: {} },
    samples: { type: mongoose.Schema.Types.Mixed, default: {} },
    issues: { type: [{ _id: false, level: String, message: String, sheet: String, row: Number }], default: [] },
    scope: { type: mongoose.Schema.Types.Mixed, default: null },
    result: { type: mongoose.Schema.Types.Mixed, default: null },
    error: { type: String, default: "" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    appliedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    appliedAt: { type: Date, default: null },
    durationMs: { type: Number, default: null },
  },
  { timestamps: true, minimize: false }
);

module.exports = mongoose.models.StudioCatalogImport || mongoose.model("StudioCatalogImport", StudioCatalogImportSchema);
