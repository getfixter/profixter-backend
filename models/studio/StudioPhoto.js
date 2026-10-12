const mongoose = require("mongoose");

/**
 * A customer's bathroom photo (or a rendered preview of their design).
 * PRIVATE: stored outside any public prefix, never listed, and readable only
 * through a time-limited signed link or by authorized staff.
 */
const StudioPhotoSchema = new mongoose.Schema(
  {
    publicId: { type: String, required: true, unique: true, index: true, immutable: true },
    designId: { type: mongoose.Schema.Types.ObjectId, ref: "StudioDesign", required: true, index: true },
    kind: { type: String, enum: ["original", "preview"], default: "original" },
    storageKey: { type: String, required: true, immutable: true },
    contentType: { type: String, required: true },
    bytes: { type: Number, required: true },
    width: { type: Number, required: true },
    height: { type: Number, required: true },
    sha256: { type: String, required: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.models.StudioPhoto || mongoose.model("StudioPhoto", StudioPhotoSchema);
