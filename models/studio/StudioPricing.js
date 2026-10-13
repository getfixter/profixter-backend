const mongoose = require("mongoose");

/**
 * The Shower Studio's own price list (independent of any other Profixter
 * pricing). One document, edited by the owner. All money in cents.
 *
 * A null price means "not set": estimates that would need it are reported as
 * incomplete instead of showing a misleading number.
 */
const PROJECT_TYPES = ["tub-to-shower", "shower-replacement", "tub-replacement"];

const ProjectTypePriceSchema = new mongoose.Schema(
  {
    key: { type: String, enum: PROJECT_TYPES, required: true },
    label: { type: String, trim: true, maxlength: 120, required: true },
    /* the customer-facing explanation of what the base price includes */
    includes: { type: String, trim: true, maxlength: 2000, default: "" },
    basePriceCents: { type: Number, min: 0, default: null },
    enabled: { type: Boolean, default: true },
  },
  { _id: false }
);

/*
 * Installation adders. `trigger` decides when one applies automatically:
 *   manual       - only when staff add it to a design
 *   paintAbove   - the design removes old tile above the new panels and paints
 *   door         - a glass door is selected
 *   perGrabBar / perSeat / perShelf - once per accessory of that kind
 */
const ADDER_TRIGGERS = ["manual", "paintAbove", "door", "perGrabBar", "perSeat", "perShelf"];
const AdderSchema = new mongoose.Schema(
  {
    key: { type: String, trim: true, maxlength: 60, required: true },
    label: { type: String, trim: true, maxlength: 160, required: true },
    trigger: { type: String, enum: ADDER_TRIGGERS, default: "manual" },
    priceCents: { type: Number, min: 0, default: null },
    enabled: { type: Boolean, default: true },
  },
  { _id: false }
);

const PackageSchema = new mongoose.Schema(
  {
    key: { type: String, trim: true, maxlength: 60, required: true },
    name: { type: String, trim: true, maxlength: 160, required: true },
    description: { type: String, trim: true, maxlength: 1000, default: "" },
    /* SKUs in the package; a design that includes all of them gets the package price instead */
    skus: { type: [String], default: [] },
    priceCents: { type: Number, min: 0, default: null },
    isPublic: { type: Boolean, default: true },
    enabled: { type: Boolean, default: true },
  },
  { _id: false }
);

const StudioPricingSchema = new mongoose.Schema(
  {
    key: { type: String, default: "default", unique: true, immutable: true },
    currency: { type: String, default: "USD" },
    projectTypes: { type: [ProjectTypePriceSchema], default: [] },
    adders: { type: [AdderSchema], default: [] },
    packages: { type: [PackageSchema], default: [] },
    /* largest discount an employee with price-adjust may give, percent of the total */
    maxDiscountPercent: { type: Number, min: 0, max: 100, default: 15 },
    disclaimer: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: "Estimated total. Your final price is confirmed after an in-home measurement and inspection.",
    },
    /* shown to customers where they add a photo and where they send a request */
    privacyNote: {
      type: String,
      trim: true,
      maxlength: 1500,
      default: "Your photo and design are private: only you and the Profixter team can see them, and camera location data is removed. Unsent designs are deleted after 30 days.",
    },
    version: { type: Number, default: 1 },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true, minimize: false }
);

StudioPricingSchema.statics.current = async function current() {
  const found = await this.findOne({ key: "default" });
  if (found) return found;
  return this.create({
    key: "default",
    projectTypes: [
      { key: "tub-to-shower", label: "Tub-to-shower conversion", includes: "Remove the old tub, install the shower base, new wall panels and valve trim." },
      { key: "shower-replacement", label: "Shower replacement", includes: "Remove the old shower, install the new base, new wall panels and valve trim." },
      { key: "tub-replacement", label: "Bathtub replacement", includes: "Remove the old tub, install the new tub, tub walls and trim." },
    ],
    adders: [
      { key: "paint-above", label: "Remove old tile above the new walls, patch and paint", trigger: "paintAbove" },
      { key: "door-install", label: "Glass door installation", trigger: "door" },
      { key: "grab-bar-blocking", label: "Grab bar blocking and installation", trigger: "perGrabBar" },
      { key: "seat-backing", label: "Seat backing and installation", trigger: "perSeat" },
      { key: "valve-relocation", label: "Valve relocation", trigger: "manual" },
    ],
  });
};

module.exports = mongoose.models.StudioPricing || mongoose.model("StudioPricing", StudioPricingSchema);
module.exports.PROJECT_TYPES = PROJECT_TYPES;
module.exports.ADDER_TRIGGERS = ADDER_TRIGGERS;
