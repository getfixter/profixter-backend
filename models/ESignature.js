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
  // Frozen and ready to be delivered or handed over, but not yet sent. Native
  // signing needs this state; Adobe never had it.
  "Ready",
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

/**
 * "adobe_sign" is retained so historical records stay valid and readable.
 * "native" is ProFixter's own signing engine and the production default.
 */
const PROVIDERS = Object.freeze(["adobe_sign", "native"]);

/** How a signature was obtained. */
const SIGNING_MODES = Object.freeze(["REMOTE", "IN_PERSON", "MANUAL_UPLOAD"]);

/** Lifecycle of a remote signing token. */
const TOKEN_STATES = Object.freeze(["active", "completed", "declined", "revoked", "expired"]);

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

/**
 * One signing event. Append-only: nothing here is ever updated or removed, so
 * the sequence itself is evidence.
 */
const AuditEventSchema = new mongoose.Schema(
  {
    event: { type: String, required: true, trim: true, maxlength: 80 },
    at: { type: Date, default: Date.now, required: true },
    /** Supporting evidence only - an IP address does not identify a person. */
    ip: { type: String, trim: true, maxlength: 64, default: "" },
    userAgent: { type: String, trim: true, maxlength: 400, default: "" },
    actorEmail: { type: String, trim: true, lowercase: true, maxlength: 254, default: "" },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
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

    provider: { type: String, enum: PROVIDERS, default: "native", required: true },
    signingMode: { type: String, enum: SIGNING_MODES, default: "REMOTE" },
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

    /**
     * The exact document that was sent to be signed.
     *
     * Frozen at request time and never regenerated: the hash is what lets us
     * say "this signer signed these exact bytes, at this version". A later
     * draft edit changes the Contract, not this.
     */
    frozenDocument: {
      key: { type: String, trim: true, default: "" },
      fileName: { type: String, trim: true, maxlength: 240, default: "" },
      size: { type: Number, min: 0, default: 0 },
      sha256: { type: String, trim: true, maxlength: 64, default: "" },
      documentVersion: { type: Number, min: 1, default: 1 },
      frozenAt: { type: Date, default: null },
    },

    /**
     * Remote signing token.
     *
     * Only the hash is stored. A database disclosure therefore yields nothing
     * that can be used to open a signing link.
     */
    signingToken: {
      hash: { type: String, trim: true, default: null },
      state: { type: String, enum: TOKEN_STATES, default: "active" },
      issuedAt: { type: Date, default: null },
      expiresAt: { type: Date, default: null },
      openedAt: { type: Date, default: null },
      sendCount: { type: Number, min: 0, default: 0 },
      lastSentAt: { type: Date, default: null },
    },

    /**
     * In-person session binding.
     *
     * Present only when signingMode is IN_PERSON. The credential itself still
     * lives in signingToken - the primitive is shared deliberately - but an
     * in-person ceremony is a different thing from an emailed link, so the
     * admin who initiated it and stood next to the customer is recorded here
     * and the session is issued with a much shorter life.
     */
    inPersonSession: {
      initiatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      initiatedByEmail: { type: String, trim: true, lowercase: true, maxlength: 254, default: "" },
      initiatedAt: { type: Date, default: null },
    },

    /** Affirmative E-SIGN consent, recorded separately from the signature. */
    consent: {
      disclosureVersion: { type: String, trim: true, maxlength: 80, default: "" },
      acceptedAt: { type: Date, default: null },
      ip: { type: String, trim: true, maxlength: 64, default: "" },
      userAgent: { type: String, trim: true, maxlength: 400, default: "" },
    },

    /**
     * The captured signature. Stored privately in S3 like every other
     * document artifact; never served by a public route.
     */
    signatureImage: {
      key: { type: String, trim: true, default: "" },
      format: { type: String, trim: true, maxlength: 20, default: "" },
      width: { type: Number, min: 0, default: 0 },
      height: { type: Number, min: 0, default: 0 },
      capturedAt: { type: Date, default: null },
    },

    /** The signing certificate produced at completion. */
    certificatePdf: { type: StoredFileSchema, default: () => ({}) },

    /** Integrity of the executed document. */
    executedSha256: { type: String, trim: true, maxlength: 64, default: "" },

    /**
     * Append-only signing history. Distinct from processedEvents, which is
     * the provider-event idempotency ledger.
     */
    auditEvents: { type: [AuditEventSchema], default: [] },

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
ESignatureSchema.index(
  { "signingToken.hash": 1 },
  {
    unique: true,
    name: "unique_signing_token",
    partialFilterExpression: { "signingToken.hash": { $type: "string" } },
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


/** Append a signing event. Never mutates or removes an existing one. */
ESignatureSchema.methods.addAuditEvent = function addAuditEvent(event, details = {}, context = {}) {
  this.auditEvents.push({
    event,
    at: new Date(),
    ip: String(context.ip || "").slice(0, 64),
    userAgent: String(context.userAgent || "").slice(0, 400),
    actorEmail: String(context.actorEmail || "").toLowerCase(),
    details,
  });
};

module.exports = mongoose.model("ESignature", ESignatureSchema);
module.exports.SIGNATURE_STATUSES = SIGNATURE_STATUSES;
module.exports.DOCUMENT_TYPES = DOCUMENT_TYPES;
module.exports.TERMINAL_STATUSES = TERMINAL_STATUSES;
module.exports.PROVIDERS = PROVIDERS;
module.exports.SIGNING_MODES = SIGNING_MODES;
module.exports.TOKEN_STATES = TOKEN_STATES;

