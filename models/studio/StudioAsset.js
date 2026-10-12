const mongoose = require("mongoose");

/**
 * A catalog image: a product photo, a colour swatch, or a visualization
 * texture (a seamless, repeatable image of a material). These are marketing
 * images (not customer data), served by an unguessable id, and stored
 * privately - never in the public uploads/ prefix.
 *
 * `source` records where a copied manufacturer image came from; copying is
 * only allowed once the owner has confirmed the manufacturer's image rights.
 */
const StudioAssetSchema = new mongoose.Schema(
  {
    publicId: { type: String, required: true, unique: true, index: true, immutable: true },
    kind: { type: String, enum: ["photo", "texture", "swatch"], required: true },
    source: {
      manufacturer: { type: String, default: null },
      url: { type: String, default: null, index: true },
    },
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
