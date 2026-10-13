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
        /* where the texture came from: owner upload, the manufacturer, or an approximation for testing */
        source: { type: String, enum: ["owner", "manufacturer", "approximation", null], default: null },
      },
    },
    /* "illustrative": the preview is an approximation (drawn pattern, estimated colour). */
    visualStatus: { type: String, enum: ["illustrative", "verified"], default: "illustrative" },
    status: { type: String, enum: ["draft", "published", "archived"], default: "draft", index: true },
    isPublic: { type: Boolean, default: true },
    featured: { type: Boolean, default: false },
    sortOrder: { type: Number, default: 0 },
    /*
     * Set for products added from a manufacturer's catalog (StudioSupplierItem).
     * Imports refresh the manufacturer's facts here (list price, availability)
     * and add `pendingReview` notes; they never touch `pricing`, `status` or
     * anything else the owner sets.
     */
    source: {
      manufacturer: { type: String, default: null, index: true },
      partNumber: { type: String, default: null },
      modelNumber: { type: String, default: "" },
      seriesName: { type: String, default: "" },
      colorCode: { type: String, default: null },
      /* the manufacturer's LIST price - not Profixter's cost */
      listPriceCents: { type: Number, default: null },
      listPriceEffective: { type: String, default: "" },
      availability: { type: String, default: "" },
      /* the one-piece unit whose integral walls this wall finish is (only selectable with it, included in its price) */
      unitSku: { type: String, default: null },
      approximations: { type: [String], default: [] },
      /* approximations serious enough that the preview must be checked before publishing */
      visualIssues: { type: [String], default: [] },
      lastImportId: { type: mongoose.Schema.Types.ObjectId, default: null },
      pendingReview: {
        type: [{ _id: false, kind: String, message: String, from: String, to: String, at: Date }],
        default: [],
      },
    },
    /*
     * The owner's sign-off on a manufacturer product (null = not yet; owner-made
     * products need no sign-off). `info`: name, description and specifications
     * checked. `visual`: the illustrative preview checked against the real
     * product. Both are required to publish a manufacturer product.
     */
    review: {
      info: { type: Boolean, default: null },
      visual: { type: Boolean, default: null },
      by: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      at: { type: Date, default: null },
    },
    /* Manufacturer links (photos, drawings, guides, CAD). Previewed in Admin only; never sent to the public Studio. */
    externalMedia: {
      type: [{ _id: false, kind: { type: String }, url: { type: String, maxlength: 1000 } }],
      default: [],
    },
    /*
     * Has the owner checked what this product fits and pairs with? Manufacturer
     * products start "unverified"; they cannot be published until reviewed.
     */
    compatibility: {
      status: { type: String, enum: ["unverified", "reviewed"], default: "reviewed" },
      note: { type: String, trim: true, maxlength: 1000, default: "" },
      reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      reviewedAt: { type: Date, default: null },
    },
    pricing: {
      /* null = not priced: the product may still be designed with, but no estimate is shown */
      priceCents: { type: Number, min: 0, default: null },
      /* what the product costs Profixter (internal; never shown to customers, never used in a quote) */
      costCents: { type: Number, min: 0, default: null },
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
