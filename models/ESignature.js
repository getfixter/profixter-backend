const mongoose = require("mongoose");

/**
 * One e-signature transaction for one ProFixter document.
 *
 * Provider-agnostic by design: Adobe-specific data lives in `providerMeta`,
 * everything the admin UI and our business logic rely on is normalized. The
 * provider runs the signature ceremony; this record is how ProFixter stays the
 * permanent system of record.
 */

const SIGNATURE_STATUSES = Object.freeze([
  "Draft",
  "Sent",
  "Viewed",
  "Awaiting Signature",
  "Partially Signed",
  "Completed",
  "Declined",
  "Cancelled",
  "Expired",
  "Failed",
]);

const DOCUMENT_TYPES = Object.freeze(["CONTRACT", "CHANGE_ORDER"]);

const PROVIDERS = Object.freeze(["adobe_sign"]);

/** Terminal states: no further provider events should change them. */
const TERMINAL_STATUSES = Object.freeze(["Completed", "Declined", "Cancelled", "Expired"]);

const StoredFileSchema = new mongoose.Schema(
  {
    key: { type: String, trim: true, default: "" },
    fileName: { type: String, trim: true, maxlength: 240, default: "" },
    size: { type: Number, min: 0, default: 0 },
    storedAt: { type: Date, default: null },
  },
  { _id: false }
);

const SignerSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ["CUSTOMER", "COMPANY"], required: true },
    name: { type: String, trim: true, maxlength: 160, default: "" },
    email: { type: String, trim: true, lowercase: true, maxlength: 254, required: true },
    /** Signing order; 1-based. Equal values mean parallel signing. */
    order: { type: Number, min: 1, default: 1 },
    status: { type: String, trim: true, maxlength: 60, default: "Pending" },
    viewedAt: { type: Date, default: null },
    signedAt: { type: Date, default: null },
  },
  { _id: true }
);

/**
 * Every provider event we accept, recorded once. The unique index on
 * providerEventId is what makes webhook processing idempotent: a duplicate
 * delivery fails to insert and is treated as already-handled.
 */
const ProcessedEventSchema = new mongoose.Schema(
  {
    providerEventId: { type: String, trim: true, required: true },
    eventType: { type: String, trim: true, maxlength: 120, default: "" },
    receivedAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const ESignatureSchema = new mongoose.Schema(
  {
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
      required: true,
      index: true,
      immutable: true,
    },
    documentType: { type: String, enum: DOCUMENT_TYPES, required: true, immutable: true },
    /** Contract._id or ChangeOrder._id. Refs vary by documentType. */
    documentId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
      immutable: true,
    },
    /** Human-facing identifier, e.g. C-000123 or CO-000123-01. */
    documentNumber: { type: String, trim: true, maxlength: 80, default: "" },

    provider: { type: String, enum: PROVIDERS, default: "adobe_sign", required: true },
    /** Adobe agreement id. Unique when present so one document maps to one agreement. */
    providerAgreementId: { type: String, trim: true, default: null, index: true },

    status: {
      type: String,
      enum: SIGNATURE_STATUSES,
      default: "Draft",
      required: true,
      index: true,
    },
    /** Raw provider status, kept verbatim for support and debugging. */
    providerStatus: { type: String, trim: true, maxlength: 80, default: "" },

    signers: { type: [SignerSchema], default: [] },
    message: { type: String, trim: true, maxlength: 2000, default: "" },

    /* --- Documents. The unsigned original is never overwritten. --- */
    originalPdf: { type: StoredFileSchema, default: () => ({}) },
    executedPdf: { type: StoredFileSchema, default: () => ({}) },
    auditTrailPdf: { type: StoredFileSchema, default: () => ({}) },

    sentAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    declinedAt: { type: Date, default: null },
    voidedAt: { type: Date, default: null },
    expiredAt: { type: Date, default: null },

    declineReason: { type: String, trim: true, maxlength: 2000, default: "" },

    /**
     * Retrieval of the executed PDF is retried independently of the webhook
     * that reported completion, so a storage blip can never lose the fact that
     * the document was signed.
     */
    documentRetrieval: {
      state: {
        type: String,
        enum: ["not_needed", "pending", "succeeded", "failed"],
        default: "not_needed",
      },
      attempts: { type: Number, min: 0, default: 0 },
      lastAttemptAt: { type: Date, default: null },
      lastError: { type: String, trim: true, maxlength: 1000, default: "" },
    },

    processedEvents: { type: [ProcessedEventSchema], default: [] },

    /** Provider-specific extras. Never contains secrets. */
    providerMeta: { type: mongoose.Schema.Types.Mixed, default: {} },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

ESignatureSchema.index(
  { providerAgreementId: 1 },
  {
    unique: true,
    name: "unique_provider_agreement",
    partialFilterExpression: { providerAgreementId: { $type: "string" } },
  }
);
ESignatureSchema.index({ documentType: 1, documentId: 1, createdAt: -1 });
ESignatureSchema.index({ "processedEvents.providerEventId": 1 });
ESignatureSchema.index({ "documentRetrieval.state": 1 });

ESignatureSchema.methods.isTerminal = function isTerminal() {
  return TERMINAL_STATUSES.includes(this.status);
};

/** True if this exact provider event has already been applied. */
ESignatureSchema.methods.hasProcessedEvent = function hasProcessedEvent(providerEventId) {
  if (!providerEventId) return false;
  return (this.processedEvents || []).some(
    (event) => event.providerEventId === String(providerEventId)
  );
};

module.exports = mongoose.model("ESignature", ESignatureSchema);
module.exports.SIGNATURE_STATUSES = SIGNATURE_STATUSES;
module.exports.DOCUMENT_TYPES = DOCUMENT_TYPES;
module.exports.TERMINAL_STATUSES = TERMINAL_STATUSES;
