const mongoose = require("mongoose");

/**
 * One manufacturer variant (a Sellable Part Number) from a manufacturer's
 * price file - the reference catalog the owner browses in Admin. It is NOT
 * what customers see: a variant reaches the Studio only when the owner adds
 * it, which creates a draft StudioProduct with the same SKU.
 *
 * Every field here is the manufacturer's and is rewritten by each import.
 * Profixter's own numbers (material cost, selling price) live on the
 * StudioProduct and are never touched by an import.
 */
const MediaSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ["photo", "video", "installGuide", "drawing", "cad", "model3d"], required: true },
    url: { type: String, required: true, maxlength: 1000 },
  },
  { _id: false }
);

const StudioSupplierItemSchema = new mongoose.Schema(
  {
    manufacturer: { type: String, required: true, index: true },
    partNumber: { type: String, required: true, maxlength: 64 },
    variantId: { type: String, default: "" },
    upc: { type: String, default: "" },
    baseModel: { type: String, default: "", index: true },
    modelNumber: { type: String, default: "" },
    familyKey: { type: String, default: "" },
    seriesKey: { type: String, default: "", index: true },
    seriesName: { type: String, default: "" },
    group: { type: String, default: "other", index: true },
    category: { type: String, default: "" },
    /* active | special-order | discontinued (listed as discontinued) | unlisted (missing from the latest full import) */
    availability: { type: String, enum: ["active", "special-order", "discontinued", "unlisted"], default: "active", index: true },
    programs: { type: [String], default: [] },
    discontinuedAt: { type: String, default: "" },
    name: { type: String, default: "" },
    shortName: { type: String, default: "" },
    color: { code: { type: String, default: null }, name: { type: String, default: "" } },
    surface: { type: String, default: "" },
    material: { type: String, default: "" },
    installationType: { type: String, default: "" },
    configuration: { type: String, default: "" },
    shape: { type: String, default: "" },
    pieces: { type: Number, default: null },
    warranty: { type: String, default: "" },
    accessibility: { type: String, default: "" },
    codeCompliancy: { type: String, default: "" },
    afr: { type: Boolean, default: false },
    dims: { type: mongoose.Schema.Types.Mixed, default: {} },
    features: { type: [String], default: [] },
    media: { type: [MediaSchema], default: [] },
    attributes: { type: mongoose.Schema.Types.Mixed, default: {} },
    /* manufacturer's list price - NOT Profixter's cost */
    listPriceCents: { type: Number, default: null },
    listPriceEffective: { type: String, default: "" },
    priceHistory: {
      type: [{ _id: false, cents: Number, effective: String, importId: mongoose.Schema.Types.ObjectId, at: Date }],
      default: [],
    },
    feedHash: { type: String, default: "" },
    firstImportId: { type: mongoose.Schema.Types.ObjectId, default: null },
    lastImportId: { type: mongoose.Schema.Types.ObjectId, default: null },
    lastChangedImportId: { type: mongoose.Schema.Types.ObjectId, default: null },
    /* the Studio product made from this variant, if the owner added it */
    studioSku: { type: String, default: null, index: true },
  },
  { timestamps: true, minimize: false }
);

StudioSupplierItemSchema.index({ manufacturer: 1, partNumber: 1 }, { unique: true });
StudioSupplierItemSchema.index({ manufacturer: 1, group: 1, seriesKey: 1, baseModel: 1 });

module.exports = mongoose.models.StudioSupplierItem || mongoose.model("StudioSupplierItem", StudioSupplierItemSchema);
