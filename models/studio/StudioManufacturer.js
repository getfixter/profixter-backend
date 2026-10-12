const mongoose = require("mongoose");

/**
 * The owner's settings for one manufacturer: whether Profixter may show the
 * manufacturer's images to customers, the owner's own swatches and textures
 * per colour, and the last image-link check. Created on first use.
 *
 * Image rights default to "unconfirmed": manufacturer images can be previewed
 * in Admin (loaded from the manufacturer's own site, never copied) and are
 * never sent to the public Studio. Copying them into Profixter's storage is
 * possible only after the owner records that rights are confirmed.
 */
const ColorSchema = new mongoose.Schema(
  {
    code: { type: String, required: true },
    /* the owner's colour for drawing, replacing the measured approximation */
    approxHex: { type: String, default: null },
    swatchAssetId: { type: mongoose.Schema.Types.ObjectId, ref: "StudioAsset", default: null },
    /* a genuine, seamless, repeatable texture image and its real-world size */
    textureAssetId: { type: mongoose.Schema.Types.ObjectId, ref: "StudioAsset", default: null },
    textureWidthIn: { type: Number, default: null },
    textureHeightIn: { type: Number, default: null },
    /* "manufacturer" = supplied by the manufacturer as a texture; "approximation" = for internal testing only */
    textureSource: { type: String, enum: ["manufacturer", "approximation", null], default: null },
  },
  { _id: false }
);

const StudioManufacturerSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, immutable: true },
    imageRights: {
      status: { type: String, enum: ["unconfirmed", "approved", "denied"], default: "unconfirmed" },
      note: { type: String, trim: true, maxlength: 2000, default: "" },
      evidenceUrl: { type: String, trim: true, maxlength: 600, default: "" },
      decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      decidedAt: { type: Date, default: null },
    },
    settings: {
      trimAllowanceIn: { type: Number, min: 0, max: 24, default: null },
    },
    colors: { type: [ColorSchema], default: [] },
    linkCheck: {
      status: { type: String, enum: ["idle", "running", "done", "failed"], default: "idle" },
      startedAt: { type: Date, default: null },
      finishedAt: { type: Date, default: null },
      total: { type: Number, default: 0 },
      checked: { type: Number, default: 0 },
      ok: { type: Number, default: 0 },
      broken: { type: Number, default: 0 },
      unreachable: { type: Number, default: 0 },
    },
  },
  { timestamps: true, minimize: false }
);

StudioManufacturerSchema.statics.forKey = async function forKey(key) {
  return (await this.findOne({ key })) || this.findOneAndUpdate({ key }, { $setOnInsert: { key } }, { upsert: true, new: true });
};

module.exports = mongoose.models.StudioManufacturer || mongoose.model("StudioManufacturer", StudioManufacturerSchema);
