const mongoose = require("mongoose");
const Counter = require("./Counter");
const {
  CHANGE_ORDER_STATUSES,
  CHANGE_ORDER_TERMS_VERSION,
  SCHEDULE_IMPACT_TYPES,
} = require("../config/changeOrderTerms");
const { netAdjustmentCents } = require("../utils/changeOrderTotals");

/**
 * A Change Order amends an existing Contract. It never replaces it.
 *
 * Mirrors the Contract model's conventions deliberately: Counter-based
 * sequential numbering, immutable snapshots taken at creation, integer cents,
 * an append-only audit history, and separate generated/executed PDF slots.
 */

/** One discrete change. Normalized rather than crammed into a description blob. */
const ChangeLineSchema = new mongoose.Schema(
  {
    description: { type: String, trim: true, maxlength: 4000, required: true },
    /**
     * The admin's intent. Storing direction separately from magnitude means
     * nobody types a negative number and a deduction can never silently
     * become a credit.
     */
    direction: {
      type: String,
      enum: ["add", "deduct", "none"],
      default: "add",
      required: true,
    },
    /** Always a magnitude (>= 0). Sign is derived from `direction`. */
    amountCents: { type: Number, min: 0, default: 0, required: true },
    order: { type: Number, min: 0, default: 0 },
  },
  { _id: true }
);

const AuditEventSchema = new mongoose.Schema(
  {
    event: { type: String, required: true, trim: true, maxlength: 120 },
    at: { type: Date, default: Date.now, required: true },
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    adminEmail: { type: String, trim: true, lowercase: true, maxlength: 254, default: "" },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: true }
);

const PdfSchema = new mongoose.Schema(
  {
    key: { type: String, trim: true, default: "" },
    url: { type: String, trim: true, default: "" },
    fileName: { type: String, trim: true, maxlength: 240, default: "" },
    size: { type: Number, min: 0, default: 0 },
    generatedAt: { type: Date, default: null },
    generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { _id: false }
);

const ExecutedPdfSchema = new mongoose.Schema(
  {
    key: { type: String, trim: true, default: "" },
    url: { type: String, trim: true, default: "" },
    fileName: { type: String, trim: true, maxlength: 240, default: "" },
    size: { type: Number, min: 0, default: 0 },
    uploadedAt: { type: Date, default: null },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    /** "adobe_sign" | "manual_upload" - how the executed copy was obtained. */
    source: { type: String, trim: true, maxlength: 40, default: "" },
  },
  { _id: false }
);

const ChangeOrderSchema = new mongoose.Schema(
  {
    /** e.g. CO-000123-01 */
    changeOrderNumber: { type: String, required: true, index: true, immutable: true },
    /** Sequence within the parent contract, 1-based. */
    sequence: { type: Number, required: true, min: 1, immutable: true },

    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
      required: true,
      index: true,
      immutable: true,
    },
    contractId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Contract",
      required: true,
      index: true,
      immutable: true,
    },

    status: {
      type: String,
      enum: CHANGE_ORDER_STATUSES,
      default: "Draft",
      required: true,
      index: true,
    },
    termsVersion: {
      type: String,
      default: CHANGE_ORDER_TERMS_VERSION,
      required: true,
      immutable: true,
    },

    title: { type: String, trim: true, maxlength: 240, required: true },

    /* --- Snapshots. Frozen at creation so the paperwork keeps saying what it
       said on the day it was issued, even if the project changes later. --- */
    customerSnapshot: {
      fullName: { type: String, trim: true, maxlength: 160, default: "" },
      email: { type: String, trim: true, lowercase: true, maxlength: 254, default: "" },
      phone: { type: String, trim: true, maxlength: 40, default: "" },
    },
    propertySnapshot: {
      address: { type: String, trim: true, maxlength: 500, default: "" },
      projectNumber: { type: String, trim: true, maxlength: 80, default: "" },
    },
    contractSnapshot: {
      contractNumber: { type: String, trim: true, maxlength: 80, default: "" },
      contractDate: { type: Date, default: null },
      /** The contract's "Final Contract Price" - the figure the customer signed. */
      originalContractAmountCents: { type: Number, min: 0, default: 0 },
    },

    lines: { type: [ChangeLineSchema], default: [] },

    /* --- Money. Recomputed on save while editable, frozen once issued. --- */
    netAdjustmentCents: { type: Number, default: 0 },
    contractAmountBeforeChangeCents: { type: Number, min: 0, default: 0 },
    newContractAmountCents: { type: Number, min: 0, default: 0 },
    previousChangeOrderAdjustmentCents: { type: Number, default: 0 },

    scheduleImpact: {
      type: {
        type: String,
        enum: SCHEDULE_IMPACT_TYPES,
        default: "none",
        required: true,
      },
      days: { type: Number, min: 0, default: 0 },
      note: { type: String, trim: true, maxlength: 2000, default: "" },
    },

    notes: { type: String, trim: true, maxlength: 8000, default: "" },

    /** Unsigned PDF as generated by ProFixter. Never overwritten by a signed copy. */
    generatedPdf: { type: PdfSchema, default: () => ({}) },

    /**
     * The fully executed copy, stored separately so the unsigned original is
     * always still retrievable. `source` records how it arrived: an e-signature
     * provider, or a countersigned PDF uploaded for a paper signature.
     */
    executedPdf: { type: ExecutedPdfSchema, default: () => ({}) },

    /** Link to the e-signature transaction, when one has been started. */
    signatureId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ESignature",
      default: null,
      index: true,
    },

    emailHistory: {
      type: [
        {
          recipient: { type: String, trim: true, lowercase: true, maxlength: 254, required: true },
          subject: { type: String, trim: true, maxlength: 240, required: true },
          message: { type: String, trim: true, maxlength: 10000, default: "" },
          sentAt: { type: Date, default: Date.now },
          sentBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
          providerResponse: { type: String, trim: true, maxlength: 500, default: "" },
        },
      ],
      default: [],
    },

    auditHistory: { type: [AuditEventSchema], default: [] },

    sentAt: { type: Date, default: null },
    executedAt: { type: Date, default: null },
    declinedAt: { type: Date, default: null },
    voidedAt: { type: Date, default: null },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
      index: true,
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

ChangeOrderSchema.index(
  { changeOrderNumber: 1 },
  { unique: true, name: "unique_change_order_number" }
);
ChangeOrderSchema.index(
  { contractId: 1, sequence: 1 },
  { unique: true, name: "unique_sequence_per_contract" }
);
ChangeOrderSchema.index({ projectId: 1, createdAt: -1 });
ChangeOrderSchema.index({ contractId: 1, status: 1 });

/** Statuses whose content may still be edited. */
const EDITABLE_STATUSES = Object.freeze(["Draft"]);

/** Statuses that are final: content must never change again. */
const LOCKED_STATUSES = Object.freeze(["Executed", "Declined", "Voided"]);

ChangeOrderSchema.methods.isEditable = function isEditable() {
  return EDITABLE_STATUSES.includes(this.status);
};

ChangeOrderSchema.methods.isLocked = function isLocked() {
  return LOCKED_STATUSES.includes(this.status);
};

/**
 * Next sequence number for a contract, allocated atomically.
 * Keyed per contract so CO numbering restarts at 01 for each contract.
 */
ChangeOrderSchema.statics.nextSequence = async function nextSequence(contractNumber) {
  const counter = await Counter.findOneAndUpdate(
    { key: `pih-change-order:${contractNumber}` },
    { $inc: { value: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return counter.value;
};

/** CO-000123-01 */
ChangeOrderSchema.statics.formatNumber = function formatNumber(contractNumber, sequence) {
  return `CO-${contractNumber}-${String(sequence).padStart(2, "0")}`;
};

/**
 * Keep the stored net adjustment in step with the lines while the document is
 * still editable. Once issued the figures are frozen: routes are responsible
 * for refusing edits, and this hook must not quietly recompute a signed total.
 */
ChangeOrderSchema.pre("validate", function syncTotals() {
  if (this.isLocked()) return;
  this.netAdjustmentCents = netAdjustmentCents(this.lines);
  this.newContractAmountCents = Math.max(
    Number(this.contractAmountBeforeChangeCents || 0) + Number(this.netAdjustmentCents || 0),
    0
  );
});

ChangeOrderSchema.methods.addAuditEvent = function addAuditEvent(event, req, details = {}) {
  const actor = req?.accessUser || req?.authUser || {};
  this.auditHistory.push({
    event,
    at: new Date(),
    adminId: req?.user?.id || actor?._id || null,
    adminEmail: String(actor?.email || "").toLowerCase(),
    details,
  });
};

module.exports = mongoose.model("ChangeOrder", ChangeOrderSchema);
module.exports.CHANGE_ORDER_STATUSES = CHANGE_ORDER_STATUSES;
module.exports.EDITABLE_STATUSES = EDITABLE_STATUSES;
module.exports.LOCKED_STATUSES = LOCKED_STATUSES;
