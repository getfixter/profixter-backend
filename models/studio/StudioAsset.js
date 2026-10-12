const mongoose = require("mongoose");

/**
 * A catalog image: a product photo or a visualization texture. These are
 * marketing images (not customer data), served publicly by an unguessable
 * id, and stored privately - never in the public uploads/ prefix.
 */
const StudioAssetSchema = new mongoose.Schema(
  {
    publicId: { type: String, required: true, unique: true, index: true, immutable: true },
    kind: { type: String, enum: ["photo", "texture"], required: true },
    storageKey: { type: String, required: true, immutable: true },
    contentType: { type: String, required: true },
    bytes: { type: Number, required: true },
    width: { type: Number, required: true },
    height: { type: Number, required: true },
    sha256: { type: String, required: true },
    originalName: { type: String, trim: true, maxlength: 200, default: "" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.models.StudioAsset || mongoose.model("StudioAsset", StudioAssetSchema);
