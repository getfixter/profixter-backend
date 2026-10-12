const mongoose = require("mongoose");

/**
 * One shower/tub design: the photo, the dots and measurements, the product
 * choices, and the price at the moment it mattered.
 *
 * Public designs are anonymous: the visitor's browser holds an edit token
 * (only its hash is stored here). Staff designs belong to the staff member who
 * created them. A public design becomes a lead when it is submitted.
 *
 * `state` is the visualization engine's design record (marks, points,
 * measurements, SKUs, run-length-encoded masks), validated on the way in.
 * `priceSnapshot` and `selections` freeze what was quoted, so later catalog or
 * price edits never change a submitted request or a proposal.
 */
const STATUSES = ["draft", "submitted", "in_review", "proposal", "signed", "closed", "archived"];

const PriceLineSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ["base", "product", "install", "adder", "package", "adjustment", "discount"], required: true },
    label: { type: String, trim: true, maxlength: 240, required: true },
    sku: { type: String, default: "" },
    quantity: { type: Number, default: 1 },
    unitCents: { type: Number, default: 0 },
    totalCents: { type: Number, required: true },
    /* staff-only lines (internal adjustments) are never shown to the customer */
    customerVisible: { type: Boolean, default: true },
    reason: { type: String, trim: true, maxlength: 500, default: "" },
  },
  { _id: false }
);

const PriceSnapshotSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    pricingVersion: { type: Number, default: 0 },
    complete: { type: Boolean, default: false },
    missing: { type: [String], default: [] },
    lines: { type: [PriceLineSchema], default: [] },
    totalCents: { type: Number, default: null },
  },
  { _id: false }
);

const SelectionSchema = new mongoose.Schema(
  {
    sku: String,
    category: String,
    type: String,
    name: String,
    manufacturer: String,
    model: String,
    quantity: { type: Number, default: 1 },
  },
  { _id: false }
);

const StudioDesignSchema = new mongoose.Schema(
  {
    publicId: { type: String, required: true, unique: true, index: true, immutable: true },
    origin: { type: String, enum: ["public", "staff"], required: true, index: true },
    editTokenHash: { type: String, default: null },
    status: { type: String, enum: STATUSES, default: "draft", index: true },
    projectType: { type: String, enum: ["tub-to-shower", "shower-replacement", "tub-replacement"], default: "tub-to-shower" },
    state: { type: mongoose.Schema.Types.Mixed, default: null },
    photo: { type: mongoose.Schema.Types.ObjectId, ref: "StudioPhoto", default: null },
    preview: { type: mongoose.Schema.Types.ObjectId, ref: "StudioPhoto", default: null },
    selections: { type: [SelectionSchema], default: [] },
    priceSnapshot: { type: PriceSnapshotSchema, default: null },
    /* staff price edits: overrides and discounts, re-applied on every recalculation */
    adjustments: {
      type: [
        new mongoose.Schema(
          {
            kind: { type: String, enum: ["adder", "override", "discount"], required: true },
            key: { type: String, default: "" },
            label: { type: String, trim: true, maxlength: 240, default: "" },
            amountCents: { type: Number, default: 0 },
            percent: { type: Number, default: null },
            reason: { type: String, trim: true, maxlength: 500, default: "" },
            by: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
            at: { type: Date, default: Date.now },
          },
          { _id: true }
        ),
      ],
      default: [],
    },
    customer: {
      name: { type: String, trim: true, maxlength: 160, default: "" },
      email: { type: String, trim: true, lowercase: true, maxlength: 254, default: "" },
      phone: { type: String, trim: true, maxlength: 40, default: "" },
      address: { type: String, trim: true, maxlength: 500, default: "" },
      zip: { type: String, trim: true, maxlength: 10, default: "" },
      contactPref: { type: String, enum: ["phone", "text", "email"], default: "phone" },
      notes: { type: String, trim: true, maxlength: 2000, default: "" },
    },
    consentAt: { type: Date, default: null },
    submittedAt: { type: Date, default: null },
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: "EstimateLead", default: null, index: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: "Project", default: null },
    estimateId: { type: mongoose.Schema.Types.ObjectId, ref: "Estimate", default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    revisions: {
      type: [
        new mongoose.Schema(
          {
            at: { type: Date, default: Date.now },
            by: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
            note: { type: String, trim: true, maxlength: 500, default: "" },
            state: { type: mongoose.Schema.Types.Mixed, default: null },
            priceSnapshot: { type: PriceSnapshotSchema, default: null },
          },
          { _id: true }
        ),
      ],
      default: [],
    },
    /* private data is deleted after this date unless the design moves forward */
    deleteAfter: { type: Date, default: null, index: true },
    /* designed on an example bathroom (no customer photo) - utils/studio/examples.js */
    exampleScene: { type: String, default: null },
    /* where the alcove size came from: standard example size, the customer, or verified on site */
    measureSource: { type: String, enum: ["standard", "customer", "verified"], default: "standard" },
  },
  { timestamps: true, minimize: false }
);

StudioDesignSchema.index({ origin: 1, status: 1, updatedAt: -1 });

module.exports = mongoose.models.StudioDesign || mongoose.model("StudioDesign", StudioDesignSchema);
module.exports.STATUSES = STATUSES;
