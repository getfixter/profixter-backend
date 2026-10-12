const mongoose = require("mongoose");

/**
 * A Shower Studio catalog product. The owner manages these in Admin; nothing
 * here is hard-coded in the app.
 *
 * - `sku` is the product's permanent identity: saved designs and quotes refer
 *   to products by SKU, so a product can be edited, unpublished or archived
 *   without breaking what was already designed or quoted. Products are never
 *   deleted once used - they are archived.
 * - `engine` holds the visualization parameters for the product's category
 *   (pattern, dimensions, kit heights, door opening range...). Its shape is
 *   validated by utils/studio/catalogFields.js, which is also what the Admin
 *   form is generated from.
 * - `pricing` is internal. Public endpoints never return it; customers only
 *   ever see a computed total (utils/studio/pricing.js).
 */
const CATEGORIES = ["wall", "base", "fixture", "enclosure", "accessory"];
const SPEC_STATUSES = ["VERIFIED", "ESTIMATE", "APPROXIMATE"];

const SpecSchema = new mongoose.Schema(
  {
    key: { type: String, trim: true, maxlength: 80, required: true },
    label: { type: String, trim: true, maxlength: 120, default: "" },
    value: { type: String, trim: true, maxlength: 200, default: "" },
    unit: { type: String, trim: true, maxlength: 60, default: "" },
    status: { type: String, enum: SPEC_STATUSES, default: "ESTIMATE" },
    source: { type: String, trim: true, maxlength: 600, default: "" },
  },
  { _id: false }
);

const AssetRefSchema = new mongoose.Schema(
  {
    assetId: { type: mongoose.Schema.Types.ObjectId, ref: "StudioAsset", required: true },
    alt: { type: String, trim: true, maxlength: 200, default: "" },
  },
  { _id: false }
);

const StudioProductSchema = new mongoose.Schema(
  {
    sku: { type: String, required: true, trim: true, maxlength: 64, unique: true, index: true, immutable: true },
    category: { type: String, enum: CATEGORIES, required: true, index: true },
    /* base: pan|tub · fixture: shower|tubShower · enclosure: door|rod · accessory: grabBar|shelf|seat · wall: kit */
    type: { type: String, trim: true, maxlength: 32, required: true },
    name: { type: String, required: true, trim: true, maxlength: 160 },
    manufacturer: { type: String, trim: true, maxlength: 120, default: "" },
    model: { type: String, trim: true, maxlength: 120, default: "" },
    description: { type: String, trim: true, maxlength: 4000, default: "" },
    colorName: { type: String, trim: true, maxlength: 80, default: "" },
    specs: { type: [SpecSchema], default: [] },
    sources: { type: [String], default: [] },
    /* Visualization and compatibility parameters (validated per category). */
    engine: { type: mongoose.Schema.Types.Mixed, default: {} },
    assets: {
      photos: { type: [AssetRefSchema], default: [] },
      texture: {
        assetId: { type: mongoose.Schema.Types.ObjectId, ref: "StudioAsset", default: null },
        /* real-world size of one repeat of the texture image, inches */
        widthIn: { type: Number, min: 1, max: 240, default: null },
        heightIn: { type: Number, min: 1, max: 240, default: null },
      },
    },
    /* "illustrative": the preview is an approximation (drawn pattern, estimated colour). */
    visualStatus: { type: String, enum: ["illustrative", "verified"], default: "illustrative" },
    status: { type: String, enum: ["draft", "published", "archived"], default: "draft", index: true },
    isPublic: { type: Boolean, default: true },
    featured: { type: Boolean, default: false },
    sortOrder: { type: Number, default: 0 },
    pricing: {
      /* null = not priced: the product may still be designed with, but no estimate is shown */
      priceCents: { type: Number, min: 0, default: null },
      /* installation adder specific to this product (e.g. glass door install) */
      installCents: { type: Number, min: 0, default: 0 },
      internalNote: { type: String, trim: true, maxlength: 1000, default: "" },
    },
    version: { type: Number, default: 1 },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true, minimize: false }
);

StudioProductSchema.index({ category: 1, status: 1, sortOrder: 1 });

module.exports = mongoose.models.StudioProduct || mongoose.model("StudioProduct", StudioProductSchema);
module.exports.CATEGORIES = CATEGORIES;
module.exports.SPEC_STATUSES = SPEC_STATUSES;
