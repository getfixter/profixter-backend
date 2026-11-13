/**
 * Native signing orchestration.
 *
 * The authoritative lifecycle:
 *
 *   create -> freeze -> send/open -> consent -> sign -> execute -> certificate
 *   -> store -> complete
 *
 * FAILURE ORDERING IS THE POINT OF THIS FILE.
 *
 * An Agreement must never be shown as executed unless the artifacts that prove
 * it exist. So completion runs in a deliberate order:
 *
 *   1. claim atomically           only one submission may proceed
 *   2. build executed PDF         in memory, from the frozen bytes
 *   3. store executed PDF         private S3
 *   4. build certificate          needs the executed hash from step 2
 *   5. store certificate          private S3
 *   6. persist completion         status, hashes, keys, audit - LAST
 *   7. execute financially        Change Order status, after 6 is durable
 *
 * Steps 2-5 produce artifacts. Only when all of them have landed does step 6
 * write "Completed". If anything before step 6 throws, the claim is released
 * and the record stays un-completed, so the customer can retry and the admin
 * sees a real failure rather than a false success.
 *
 * S3 writes are keyed deterministically, so a retry overwrites rather than
 * duplicating. That is what makes releasing the claim safe.
 */

const Contract = require("../../models/Contract");
const ChangeOrder = require("../../models/ChangeOrder");
const ESignature = require("../../models/ESignature");
const { putPrivateObject, getObjectBuffer } = require("../s3");
const { LEGAL_ENTITY: COMPANY_INFO } = require("../../config/legalEntity");
const {
  DISCLOSURE_VERSION,
} = require("../../config/electronicSignatureDisclosure");
const companySignature = require("../companySignature");
const { renderFrozenDocument, overlayExecution } = require("./executedDocument");
const { resolveCompanySignedAt } = require("../documentDates");
const { generateSignatureCertificateBuffer } = require("./signatureCertificate");
const native = require("./nativeSigning");

const ESIGN_S3_PREFIX = (process.env.ESIGN_S3_PREFIX || "private/admin/esign").replace(/\/+$/, "");

/** Reduce an untrusted value to one safe path segment. */
function sanitizePart(value) {
  return (
    String(value || "")
      .replace(/[^\w.-]+/g, "_")
      .replace(/\.{2,}/g, ".")
      .replace(/^[._]+/, "")
      .replace(/_+/g, "_")
      .slice(0, 120) || "document"
  );
}

/** Deterministic key: a retry overwrites the same object instead of duplicating. */
function storageKey(signature, kind, fileName) {
  return [
    ESIGN_S3_PREFIX,
    "projects",
    String(signature.projectId),
    signature.documentType.toLowerCase(),
    sanitizePart(signature.documentNumber || String(signature.documentId)),
    String(signature._id),
    kind,
    sanitizePart(fileName),
  ].join("/");
}

/* ------------------------------------------------------------------ */
/* Document state: may this document still be signed?                  */
/* ------------------------------------------------------------------ */

/**
 * Change Order statuses in which a customer signature may still execute it.
 * Draft is excluded because nothing unissued can be signed; the locked states
 * (Executed, Declined, Voided) are excluded because the owner closed them.
 */
const SIGNABLE_CHANGE_ORDER_STATUSES = Object.freeze([
  "Ready to Send",
  "Sent",
  "Viewed",
  "Awaiting Signature",
  "Partially Signed",
]);

/** Agreement statuses in which a customer signature may still execute it. */
const SIGNABLE_CONTRACT_STATUSES = Object.freeze(["Generated", "Emailed"]);

/** Raised when the authoritative document no longer accepts this signature. */
class DocumentNotSignableError extends Error {
  constructor(message, reason = "document_not_signable") {
    super(message);
    this.name = "DocumentNotSignableError";
    this.code = "DOCUMENT_NOT_SIGNABLE";
    this.reason = reason;
  }
}

/** The signature id recorded by the most recent execution entry, if any. */
function executingSignatureId(doc) {
  const entry = (doc?.auditHistory || [])
    .slice()
    .reverse()
    .find((item) => item?.details?.signatureId);
  return entry ? String(entry.details.signatureId) : "";
}

/**
 * Why this signature can no longer execute this document, or "" when it can.
 *
 * The document record is the authority. A signing link is only an invitation;
 * once the owner voids, declines, cancels, supersedes or revises the document,
 * the invitation is dead whatever state the token is in.
 */
function documentSignabilityReason(documentType, doc, signature = null) {
  if (!doc) return "This document no longer exists.";
  const signatureId = signature ? String(signature._id) : "";

  if (documentType === "CHANGE_ORDER") {
    if (doc.status === "Executed") {
      // A replay of the very signature that executed it is not another signer.
      if (signatureId && executingSignatureId(doc) === signatureId) return "";
      return "This change order has already been executed.";
    }
    if (doc.status === "Voided") return "This change order was withdrawn and can no longer be signed.";
    if (doc.status === "Declined") return "This change order was declined and can no longer be signed.";
    if (!SIGNABLE_CHANGE_ORDER_STATUSES.includes(doc.status)) {
      return "This change order is not ready to be signed.";
    }
    return "";
  }

  if (doc.status === "Signed") {
    if (signatureId && executingSignatureId(doc) === signatureId) return "";
    return "This agreement has already been signed.";
  }
  if (doc.status === "Canceled") return "This agreement was canceled and can no longer be signed.";
  if (doc.status === "Superseded" || doc.current === false) {
    return "This agreement was replaced by a newer version and can no longer be signed.";
  }
  if (doc.status === "Draft") return "This agreement is being revised and can no longer be signed.";
  if (!SIGNABLE_CONTRACT_STATUSES.includes(doc.status)) return "This agreement cannot be signed.";
  if (
    signature?.frozenDocument?.key &&
    signature?.frozenDocument?.documentVersion &&
    Number(signature.frozenDocument.documentVersion) !== Number(doc.version || 1)
  ) {
    return "This agreement was replaced by a newer version and can no longer be signed.";
  }
  return "";
}

/** Signed copies may be recorded only for an issued, still-open document. */
function manualUploadRefusal(documentType, doc) {
  if (!doc) return "Document not found";
  if (documentType === "CHANGE_ORDER") {
    if (!doc.generatedPdf?.key) return "Generate the change order before recording a signed copy.";
    if (!SIGNABLE_CHANGE_ORDER_STATUSES.includes(doc.status)) {
      return `A ${String(doc.status || "").toLowerCase()} change order cannot take a signed copy.`;
    }
    return "";
  }
  if (doc.signedPdf?.key) return "This agreement already has a signed copy. It cannot be replaced.";
  if (!SIGNABLE_CONTRACT_STATUSES.includes(doc.status)) {
    return `A signed copy can be recorded only for a generated or emailed agreement (this one is ${doc.status}).`;
  }
  if (doc.current === false) return "A signed copy can be recorded only for the current agreement version.";
  return "";
}

/* ------------------------------------------------------------------ */
/* Document access                                                     */
/* ------------------------------------------------------------------ */

/** Load the document a signature request refers to, server-side only. */
async function loadDocument(documentType, documentId) {
  if (documentType === "CHANGE_ORDER") {
    const changeOrder = await ChangeOrder.findById(documentId);
    if (!changeOrder) return null;
    return {
      type: "CHANGE_ORDER",
      doc: changeOrder,
      projectId: changeOrder.projectId,
      number: changeOrder.changeOrderNumber,
      version: 1,
      label: `Change Order ${changeOrder.changeOrderNumber}`,
      customerName: changeOrder.customerSnapshot?.fullName || "",
      customerEmail: String(changeOrder.customerSnapshot?.email || "").toLowerCase(),
      propertyAddress: changeOrder.propertySnapshot?.address || "",
      blockedReason: changeOrder.isLocked()
        ? `A ${changeOrder.status.toLowerCase()} change order cannot be sent for signature.`
        : !changeOrder.generatedPdf?.key
          ? "Generate the change order before sending it for signature."
          : "",
    };
  }

  const contract = await Contract.findById(documentId);
  if (!contract) return null;
  return {
    type: "CONTRACT",
    doc: contract,
    projectId: contract.projectId,
    number: contract.contractNumber,
    version: Number(contract.version || 1),
    label: `Home Improvement Agreement #${contract.contractNumber}`,
    customerName: contract.customerSnapshot?.fullName || "",
    customerEmail: String(contract.customerSnapshot?.email || "").toLowerCase(),
    propertyAddress: contract.propertySnapshot?.address || "",
    blockedReason:
      contract.status === "Canceled"
        ? "A canceled agreement cannot be sent for signature."
        : contract.status === "Draft"
          ? "Generate the agreement before sending it for signature."
          : contract.status === "Signed"
            ? "This agreement is already signed. Changes go through a change order."
            : contract.status === "Superseded" || contract.current === false
              ? "A superseded agreement cannot be sent for signature. Send the current version."
              : "",
  };
}

/* ------------------------------------------------------------------ */
/* Creation and freezing                                               */
/* ------------------------------------------------------------------ */

class SigningConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "SigningConfigurationError";
    this.code = "SIGNING_NOT_CONFIGURED";
  }
}

/**
 * Production guard.
 *
 * A document that reaches a customer must already carry the company signature -
 * NY GBL 771 requires a home improvement contract and its amendments to be
 * signed by all parties, so an agreement with an empty company rule is not
 * something to send out and then quietly call executed.
 *
 * Tests and local development set ESIGN_ALLOW_UNSIGNED_COMPANY=true to work
 * without the real asset. Production leaves it unset and gets a clear admin
 * error instead of a defective document.
 */
function assertCompanySignatureAvailable(applied) {
  if (applied) return;
  if (String(process.env.ESIGN_ALLOW_UNSIGNED_COMPANY || "").toLowerCase() === "true") return;
  throw new SigningConfigurationError(
    "The Premium Island Homes signature is not configured, so this document cannot be sent for " +
      "signature. Upload the signature image and set COMPANY_SIGNATURE_S3_KEY."
  );
}

/**
 * Create a signature request and freeze the document behind it.
 *
 * Freezing is what makes the rest defensible: the exact PDF the customer will
 * review is rendered once, hashed, and stored. Nothing downstream re-reads the
 * Contract, so an admin editing a draft afterwards cannot change what is being
 * signed.
 */
async function createSignatureRequest({
  documentType,
  documentId,
  signingMode = "REMOTE",
  createdBy = null,
  message = "",
  expiresAt = null,
  context = {},
}) {
  const target = await loadDocument(documentType, documentId);
  if (!target) throw new Error("Document not found");
  if (target.blockedReason) throw new Error(target.blockedReason);
  if (!target.customerEmail) throw new Error("This document has no customer email on file.");

  // One live request per document: two open requests is how the wrong version
  // gets signed.
  const existing = await ESignature.findOne({
    documentType,
    documentId: target.doc._id,
    provider: "native",
    "signingToken.state": "active",
  });
  if (existing) {
    throw new Error("This document already has a signature request in progress. Revoke it first.");
  }

  const signature = await ESignature.create({
    projectId: target.projectId,
    documentType,
    documentId: target.doc._id,
    documentNumber: target.number,
    provider: "native",
    signingMode,
    status: "Draft",
    signers: [
      { role: "CUSTOMER", name: target.customerName, email: target.customerEmail, order: 1 },
    ],
    message,
    createdBy,
  });

  // Freeze: render once, hash, store. The pinned date keeps the render
  // deterministic so the same inputs reproduce the same bytes.
  const pinnedDate = new Date();

  // The company executed this document when it was issued. If a generated PDF
  // already carried that date, reuse it verbatim - the frozen document the
  // customer signs must not show a different company date than the Agreement
  // the admin already produced.
  const companySignedAt = resolveCompanySignedAt(target.doc, true, pinnedDate);

  const frozen = await renderFrozenDocument({
    documentType,
    document: target.doc,
    pinnedDate,
    companySignedAt,
  });

  try {
    assertCompanySignatureAvailable(frozen.companySignatureApplied);
  } catch (error) {
    // Nothing has been sent; remove the stub so the admin can retry cleanly.
    await ESignature.deleteOne({ _id: signature._id });
    throw error;
  }

  // resolveCompanySignedAt stamped the document in memory; it is persisted only
  // now that the signature really was applied, so a refused send never leaves an
  // execution date behind on a document that was never issued.
  await target.doc.save();

  const fileName = `${sanitizePart(target.number)}-frozen.pdf`;
  const key = storageKey(signature, "frozen", fileName);
  await putPrivateObject({
    Key: key,
    Body: frozen.buffer,
    ContentType: "application/pdf",
    CacheControl: "private, max-age=0, no-cache",
  });

  const rawToken = native.generateToken();
  signature.frozenDocument = {
    key,
    fileName,
    size: frozen.buffer.length,
    sha256: frozen.sha256,
    documentVersion: target.version,
    frozenAt: pinnedDate,
  };
  // Anchors travel with the record so execution never recomputes them.
  signature.providerMeta = { ...(signature.providerMeta || {}), anchors: frozen.anchors };
  signature.signingToken = {
    hash: native.hashToken(rawToken),
    state: "active",
    issuedAt: new Date(),
    expiresAt:
      expiresAt || (signingMode === "IN_PERSON" ? native.inPersonExpiry() : native.expiryFromNow()),
    sendCount: 0,
  };
  if (signingMode === "IN_PERSON") {
    // Bind the ceremony to the admin who initiated it. An in-person signature
    // is witnessed, and the record should say by whom.
    signature.inPersonSession = {
      initiatedBy: createdBy,
      initiatedByEmail: String(context.actorEmail || "").toLowerCase(),
      initiatedAt: new Date(),
    };
  }

  signature.status = "Ready";
  signature.addAuditEvent(
    native.AUDIT.CREATED,
    {
      documentVersion: target.version,
      frozenSha256: frozen.sha256,
      signingMode,
      ...(signingMode === "IN_PERSON" ? { initiatedByEmail: context.actorEmail || "" } : {}),
    },
    context
  );
  await signature.save();

  // The raw token is returned exactly once and never persisted.
  return { signature, rawToken, target };
}

/* ------------------------------------------------------------------ */
/* Opening and consent                                                 */
/* ------------------------------------------------------------------ */

/** Record that the signer opened the document. First open only. */
async function recordOpened(signature, context = {}) {
  if (!signature.signingToken.openedAt) {
    signature.signingToken.openedAt = new Date();
    if (signature.status === "Sent" || signature.status === "Ready") signature.status = "Viewed";
    signature.addAuditEvent(native.AUDIT.LINK_OPENED, {}, context);
    await signature.save();
  }
  return signature;
}

/** The frozen bytes the signer must be shown. Never a regenerated document. */
async function readFrozenDocument(signature) {
  if (!signature.frozenDocument?.key) throw new Error("This request has no frozen document");
  return getObjectBuffer({ Key: signature.frozenDocument.key });
}

/* ------------------------------------------------------------------ */
/* Completion                                                          */
/* ------------------------------------------------------------------ */

/**
 * Complete a signature request.
 *
 * Idempotent: a duplicate submission that loses the atomic claim returns the
 * already-completed record rather than an error, because from the customer's
 * point of view their signature did land.
 *
 * `consentAccepted` must be a genuine affirmative from the UI. It is checked
 * here as well as at the route, because this is the layer that must not be
 * bypassable.
 */
async function completeSignature({ signature, signatureImageBuffer, consentAccepted, context = {} }) {
  if (!consentAccepted) {
    throw new Error("Electronic records consent is required before signing.");
  }
  if (!signatureImageBuffer || !signatureImageBuffer.length) {
    throw new Error("A drawn signature is required.");
  }

  const rejection = native.tokenRejectionReason(signature);
  if (rejection && rejection !== null) {
    if (rejection === "completed" && signature.status === "Completed") {
      signature.$locals.replay = true;
      return signature;
    }
    throw new Error(`This signing link is no longer valid (${rejection}).`);
  }

  // 0. The document is the authority. A withdrawn document refuses the
  //    signature outright, and the dead link is revoked so it stops showing.
  const before = await loadDocument(signature.documentType, signature.documentId);
  const refusal = documentSignabilityReason(signature.documentType, before?.doc, signature);
  if (refusal) {
    await revokeActiveSignatureRecord(signature._id, "document_not_signable", context);
    throw new DocumentNotSignableError(refusal);
  }

  // 1. Claim. Losing here means another submission is already executing.
  const claimed = await native.claimForCompletion(signature._id);
  if (!claimed) {
    const current = await ESignature.findById(signature._id);
    if (current?.status === "Completed") {
      current.$locals.replay = true;
      return current;
    }
    throw new Error("This document is already being signed.");
  }

  const signedAt = new Date();

  try {
    // 2. Executed PDF, from the frozen bytes only.
    const frozenBuffer = await readFrozenDocument(claimed);
    const anchors = claimed.providerMeta?.anchors || [];
    const executed = await overlayExecution({
      frozenBuffer,
      anchors,
      signatureImage: signatureImageBuffer,
      signedAt,
    });

    // 3. Store the signature image and executed PDF.
    const signatureKey = storageKey(claimed, "signature", "customer-signature.png");
    await putPrivateObject({
      Key: signatureKey,
      Body: signatureImageBuffer,
      ContentType: "image/png",
      CacheControl: "private, max-age=0, no-cache",
    });

    const executedName = `${sanitizePart(claimed.documentNumber || "document")}-executed.pdf`;
    const executedKey = storageKey(claimed, "executed", executedName);
    await putPrivateObject({
      Key: executedKey,
      Body: executed.buffer,
      ContentType: "application/pdf",
      CacheControl: "private, max-age=0, no-cache",
    });

    // 4/5. Certificate, which needs the executed hash, then store it.
    claimed.executedSha256 = executed.sha256;
    claimed.consent = {
      disclosureVersion: DISCLOSURE_VERSION,
      acceptedAt: claimed.consent?.acceptedAt || signedAt,
      ip: context.ip || claimed.consent?.ip || "",
      userAgent: context.userAgent || claimed.consent?.userAgent || "",
    };
    claimed.addAuditEvent(native.AUDIT.SUBMITTED, {}, context);

    const target = await loadDocument(claimed.documentType, claimed.documentId);
    const certificate = await generateSignatureCertificateBuffer({
      signature: claimed,
      documentLabel: target?.label || claimed.documentNumber,
      customerName: target?.customerName || "",
      propertyAddress: target?.propertyAddress || "",
    });
    const certificateName = `${sanitizePart(claimed.documentNumber || "document")}-certificate.pdf`;
    const certificateKey = storageKey(claimed, "certificate", certificateName);
    await putPrivateObject({
      Key: certificateKey,
      Body: certificate,
      ContentType: "application/pdf",
      CacheControl: "private, max-age=0, no-cache",
    });

    // 5b. Re-check the document. The owner may have voided or canceled it
    //     while the artifacts were being produced.
    const retainedFiles = { signatureKey, executedKey, certificateKey };
    const latest = await loadDocument(claimed.documentType, claimed.documentId);
    const lateRefusal = documentSignabilityReason(claimed.documentType, latest?.doc, claimed);
    if (lateRefusal) {
      await failSignatureAfterDocumentChange(claimed, lateRefusal, retainedFiles, context);
      throw new DocumentNotSignableError(lateRefusal, "document_changed_during_signing");
    }

    // 6. Only now is the record allowed to say Completed.
    claimed.signatureImage = {
      key: signatureKey,
      format: "png",
      capturedAt: signedAt,
    };
    claimed.executedPdf = {
      key: executedKey,
      fileName: executedName,
      size: executed.buffer.length,
      storedAt: signedAt,
    };
    claimed.certificatePdf = {
      key: certificateKey,
      fileName: certificateName,
      size: certificate.length,
      storedAt: signedAt,
    };
    claimed.status = "Completed";
    claimed.completedAt = signedAt;
    claimed.signers.forEach((signer) => {
      if (signer.role === "CUSTOMER") {
        signer.status = "Signed";
        signer.signedAt = signedAt;
      }
    });
    claimed.addAuditEvent(
      native.AUDIT.EXECUTED,
      { executedSha256: executed.sha256, frozenSha256: claimed.frozenDocument?.sha256 },
      context
    );
    await claimed.save();

    // 7. Financial/document execution, only after completion is durable. The
    //    document update is conditional on its signable state, so a void that
    //    lands in this last window still wins and nothing is executed.
    const executedDoc = await executeDocument(claimed);
    if (!executedDoc) {
      const current = await loadDocument(claimed.documentType, claimed.documentId);
      const reason =
        documentSignabilityReason(claimed.documentType, current?.doc, claimed) ||
        "The document changed while it was being signed.";
      await failSignatureAfterDocumentChange(claimed, reason, retainedFiles, context);
      throw new DocumentNotSignableError(reason, "document_changed_during_signing");
    }

    return claimed;
  } catch (error) {
    // The signature was closed deliberately; releasing the claim would reopen it.
    if (error instanceof DocumentNotSignableError) throw error;
    // Nothing may look executed. Release the claim so a retry can proceed;
    // deterministic S3 keys make a retry overwrite rather than duplicate.
    await native.releaseClaim(claimed._id);
    const reopened = await ESignature.findById(claimed._id);
    if (reopened) {
      reopened.addAuditEvent(
        "SIGNATURE_COMPLETION_FAILED",
        { message: String(error?.message || "").slice(0, 300) },
        context
      );
      await reopened.save();
    }
    throw error;
  }
}

/**
 * Apply the completed signature to the underlying document.
 *
 * Idempotent and guarded: a Change Order already Executed is left alone, so a
 * replayed call cannot apply its amount twice. The financial effect is the
 * status transition itself - changeOrderTotals.js remains the only place that
 * decides what a status is worth.
 */
async function executeDocument(
  signature,
  { event = "Executed by electronic signature", source = "native_esign" } = {}
) {
  const at = signature.completedAt || new Date();
  const auditEntry = {
    event,
    at: new Date(),
    details: { signatureId: String(signature._id), executedSha256: signature.executedSha256 },
  };
  const executedFile = {
    key: signature.executedPdf.key,
    url: "",
    fileName: signature.executedPdf.fileName,
    size: signature.executedPdf.size,
    uploadedAt: at,
    uploadedBy: signature.createdBy || null,
  };

  if (signature.documentType === "CHANGE_ORDER") {
    const existing = await ChangeOrder.findById(signature.documentId);
    if (!existing) return null;
    // A replay of the signature that already executed it is an idempotent success;
    // execution by anyone else is a refusal (null).
    if (existing.status === "Executed") {
      return executingSignatureId(existing) === String(signature._id) ? existing : null;
    }
    // Atomic: only a change order still in a signable state flips. A void that
    // won the race leaves this update matching nothing.
    return ChangeOrder.findOneAndUpdate(
      { _id: signature.documentId, status: { $in: SIGNABLE_CHANGE_ORDER_STATUSES } },
      {
        $set: { status: "Executed", executedAt: at, executedPdf: { ...executedFile, source } },
        $push: { auditHistory: auditEntry },
      },
      { new: true }
    );
  }

  const existing = await Contract.findById(signature.documentId);
  if (!existing) return null;
  if (existing.status === "Signed") {
    return executingSignatureId(existing) === String(signature._id) ? existing : null;
  }
  const filter = {
    _id: signature.documentId,
    status: { $in: SIGNABLE_CONTRACT_STATUSES },
    current: { $ne: false },
    // The signed-copy slot is write-once.
    $or: [{ "signedPdf.key": { $exists: false } }, { "signedPdf.key": "" }, { "signedPdf.key": null }],
  };
  // A ceremony signature is bound to the exact version it froze.
  if (signature.frozenDocument?.key && signature.frozenDocument?.documentVersion) {
    filter.version = Number(signature.frozenDocument.documentVersion);
  }
  return Contract.findOneAndUpdate(
    filter,
    { $set: { status: "Signed", signedPdf: executedFile }, $push: { auditHistory: auditEntry } },
    { new: true }
  );
}

/**
 * The document changed after this signature was claimed. The stored files are
 * kept (they are evidence of what happened), but the signature is closed as
 * Failed with its token revoked, and the document is never flipped.
 */
async function failSignatureAfterDocumentChange(claimed, reason, files = {}, context = {}) {
  const now = new Date();
  await ESignature.updateOne(
    { _id: claimed._id },
    {
      $set: {
        status: "Failed",
        "signingToken.state": "revoked",
        voidedAt: now,
        completedAt: null,
      },
      $push: {
        auditEvents: {
          event: "SIGNATURE_REFUSED_DOCUMENT_CHANGED",
          at: now,
          ip: String(context.ip || "").slice(0, 64),
          userAgent: String(context.userAgent || "").slice(0, 400),
          actorEmail: "",
          details: { reason: String(reason || "").slice(0, 300), retainedFiles: files },
        },
      },
    }
  );
}

/* ------------------------------------------------------------------ */
/* Decline, revoke, expire                                             */
/* ------------------------------------------------------------------ */

async function declineSignature({ signature, reason = "", context = {} }) {
  const claimed = await native.claimForDecline(signature._id);
  if (!claimed) {
    const current = await ESignature.findById(signature._id);
    if (current?.status === "Declined") return current;
    throw new Error("This request can no longer be declined.");
  }
  claimed.status = "Declined";
  claimed.declinedAt = new Date();
  claimed.declineReason = String(reason || "").slice(0, 2000);
  claimed.addAuditEvent(native.AUDIT.DECLINED, { reason: claimed.declineReason }, context);
  await claimed.save();
  // A declined Change Order stays un-executed and contributes nothing.
  return claimed;
}

/**
 * Atomically revoke one signature whose token is still active. Returns the
 * updated record, or null when it was no longer active (completed, declined,
 * expired, revoked - or claimed by a submission in flight, which then fails
 * its own document re-check).
 */
async function revokeActiveSignatureRecord(signatureId, reason = "", context = {}) {
  const now = new Date();
  return ESignature.findOneAndUpdate(
    {
      _id: signatureId,
      "signingToken.state": "active",
      status: { $nin: ["Completed", "Declined", "Cancelled", "Expired"] },
    },
    {
      $set: { "signingToken.state": "revoked", status: "Cancelled", voidedAt: now },
      $push: {
        auditEvents: {
          event: native.AUDIT.REVOKED,
          at: now,
          ip: String(context.ip || "").slice(0, 64),
          userAgent: String(context.userAgent || "").slice(0, 400),
          actorEmail: String(context.actorEmail || "").toLowerCase(),
          details: { reason: String(reason || "").slice(0, 500) },
        },
      },
    },
    { new: true }
  );
}

/** Admin revocation. The frozen document and its history are retained. */
async function revokeSignature({ signature, reason = "", context = {} }) {
  if (signature.status === "Completed") {
    throw new Error("A completed signature cannot be revoked.");
  }
  const updated = await revokeActiveSignatureRecord(signature._id, reason, context);
  const current = updated || (await ESignature.findById(signature._id));
  if (!updated && current?.status === "Completed") {
    throw new Error("A completed signature cannot be revoked.");
  }
  if (current) {
    // Keep the caller's object in step with what is stored.
    signature.status = current.status;
    signature.voidedAt = current.voidedAt;
    signature.signingToken = current.signingToken;
    signature.auditEvents = current.auditEvents;
  }
  return signature;
}

/**
 * Revoke every live native signing request for a document. Called by void,
 * cancel, regenerate, revise, supersede and signed-copy upload, so an
 * outstanding link can never execute a document the owner withdrew.
 * Returns how many were revoked.
 */
async function revokeSignaturesForDocument(documentType, documentId, reason = "", context = {}) {
  const active = await ESignature.find({
    documentType,
    documentId,
    "signingToken.state": "active",
  }).select("_id");
  let revoked = 0;
  for (const row of active) {
    if (await revokeActiveSignatureRecord(row._id, reason, context)) revoked += 1;
  }
  return revoked;
}

/** Mark genuinely elapsed requests expired. Safe to run repeatedly; atomic per row. */
async function expireStaleRequests(now = new Date()) {
  const stale = await ESignature.find({
    provider: "native",
    "signingToken.state": "active",
    "signingToken.expiresAt": { $lt: now },
  })
    .select("_id")
    .limit(200);

  let expired = 0;
  for (const row of stale) {
    const updated = await ESignature.findOneAndUpdate(
      { _id: row._id, "signingToken.state": "active", "signingToken.expiresAt": { $lt: now } },
      {
        $set: { "signingToken.state": "expired", status: "Expired", expiredAt: now },
        $push: { auditEvents: { event: native.AUDIT.EXPIRED, at: now, details: {} } },
      }
    );
    if (updated) expired += 1;
  }
  return expired;
}

/* ------------------------------------------------------------------ */
/* Manual fallback                                                     */
/* ------------------------------------------------------------------ */

/**
 * Record a document signed outside the native ceremony.
 *
 * Deliberately does NOT fabricate a token, consent record, signing IP or
 * certificate. The record says exactly what happened: an admin supplied a
 * signed document. Anything else would put invented evidence into the audit
 * trail.
 */
async function recordManualUpload({
  documentType,
  documentId,
  buffer,
  fileName,
  uploadedBy,
  context = {},
}) {
  const target = await loadDocument(documentType, documentId);
  if (!target) throw new Error("Document not found");
  const uploadRefusal = manualUploadRefusal(documentType, target.doc);
  if (uploadRefusal) throw new DocumentNotSignableError(uploadRefusal, "manual_upload_not_allowed");

  // A paper signature supersedes any outstanding link for the same document.
  await revokeSignaturesForDocument(documentType, target.doc._id, "signed_copy_uploaded", context);

  const signature = await ESignature.create({
    projectId: target.projectId,
    documentType,
    documentId: target.doc._id,
    documentNumber: target.number,
    provider: "native",
    signingMode: "MANUAL_UPLOAD",
    status: "Completed",
    completedAt: new Date(),
    signers: [
      { role: "CUSTOMER", name: target.customerName, email: target.customerEmail, order: 1 },
    ],
    createdBy: uploadedBy,
  });

  const safeName = `${sanitizePart(target.number)}-signed-upload.pdf`;
  const key = storageKey(signature, "manual", safeName);
  await putPrivateObject({
    Key: key,
    Body: buffer,
    ContentType: "application/pdf",
    CacheControl: "private, max-age=0, no-cache",
  });

  signature.executedPdf = {
    key,
    fileName: fileName || safeName,
    size: buffer.length,
    storedAt: new Date(),
  };
  signature.executedSha256 = native.sha256(buffer);
  signature.addAuditEvent(
    native.AUDIT.MANUAL_UPLOAD,
    { fileName: fileName || safeName, sha256: signature.executedSha256 },
    context
  );
  await signature.save();

  const executedDoc = await executeDocument(signature, {
    event: "Signed copy uploaded",
    source: "manual_upload",
  });
  if (!executedDoc) {
    // Kept for audit, never counted: the document changed under the upload.
    await failSignatureAfterDocumentChange(
      signature,
      "The document changed before the upload was recorded.",
      { manualKey: key },
      context
    );
    throw new DocumentNotSignableError(
      "The document changed before the upload was recorded. Nothing was marked signed."
    );
  }
  return signature;
}

/** The stored executed document, for attaching to the completion email. */
async function readStoredExecuted(signature) {
  if (!signature.executedPdf?.key) return null;
  return getObjectBuffer({ Key: signature.executedPdf.key });
}

module.exports = {
  SIGNABLE_CHANGE_ORDER_STATUSES,
  SIGNABLE_CONTRACT_STATUSES,
  DocumentNotSignableError,
  documentSignabilityReason,
  manualUploadRefusal,
  revokeActiveSignatureRecord,
  revokeSignaturesForDocument,
  readStoredExecuted,
  SigningConfigurationError,
  ESIGN_S3_PREFIX,
  COMPANY_INFO,
  sanitizePart,
  storageKey,
  loadDocument,
  assertCompanySignatureAvailable,
  createSignatureRequest,
  recordOpened,
  readFrozenDocument,
  completeSignature,
  executeDocument,
  declineSignature,
  revokeSignature,
  expireStaleRequests,
  recordManualUpload,
  companySignature,
};
