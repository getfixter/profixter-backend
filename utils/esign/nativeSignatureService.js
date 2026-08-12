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
const { COMPANY_INFO } = require("../../config/premiumIslandHomesContract");
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
    if (rejection === "completed" && signature.status === "Completed") return signature;
    throw new Error(`This signing link is no longer valid (${rejection}).`);
  }

  // 1. Claim. Losing here means another submission is already executing.
  const claimed = await native.claimForCompletion(signature._id);
  if (!claimed) {
    const current = await ESignature.findById(signature._id);
    if (current?.status === "Completed") return current;
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

    // 7. Financial/document execution, only after completion is durable.
    await executeDocument(claimed);

    return claimed;
  } catch (error) {
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
async function executeDocument(signature) {
  if (signature.documentType === "CHANGE_ORDER") {
    const changeOrder = await ChangeOrder.findById(signature.documentId);
    if (!changeOrder || changeOrder.status === "Executed") return changeOrder || null;

    changeOrder.status = "Executed";
    changeOrder.executedAt = signature.completedAt || new Date();
    changeOrder.executedPdf = {
      key: signature.executedPdf.key,
      url: "",
      fileName: signature.executedPdf.fileName,
      size: signature.executedPdf.size,
      uploadedAt: signature.completedAt || new Date(),
      uploadedBy: signature.createdBy || null,
      source: "native_esign",
    };
    changeOrder.auditHistory.push({
      event: "Executed by electronic signature",
      at: new Date(),
      details: { signatureId: String(signature._id), executedSha256: signature.executedSha256 },
    });
    await changeOrder.save();
    return changeOrder;
  }

  const contract = await Contract.findById(signature.documentId);
  if (!contract || contract.status === "Signed") return contract || null;
  contract.status = "Signed";
  contract.signedPdf = {
    key: signature.executedPdf.key,
    url: "",
    fileName: signature.executedPdf.fileName,
    size: signature.executedPdf.size,
    uploadedAt: signature.completedAt || new Date(),
    uploadedBy: signature.createdBy || null,
  };
  contract.auditHistory.push({
    event: "Executed by electronic signature",
    at: new Date(),
    details: { signatureId: String(signature._id), executedSha256: signature.executedSha256 },
  });
  await contract.save();
  return contract;
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

/** Admin revocation. The frozen document and its history are retained. */
async function revokeSignature({ signature, reason = "", context = {} }) {
  if (signature.status === "Completed") {
    throw new Error("A completed signature cannot be revoked.");
  }
  signature.signingToken.state = "revoked";
  signature.status = "Cancelled";
  signature.voidedAt = new Date();
  signature.addAuditEvent(native.AUDIT.REVOKED, { reason: String(reason || "").slice(0, 500) }, context);
  await signature.save();
  return signature;
}

/** Mark genuinely elapsed requests expired. Safe to run repeatedly. */
async function expireStaleRequests(now = new Date()) {
  const stale = await ESignature.find({
    provider: "native",
    "signingToken.state": "active",
    "signingToken.expiresAt": { $lt: now },
  }).limit(200);

  for (const signature of stale) {
    signature.signingToken.state = "expired";
    signature.status = "Expired";
    signature.expiredAt = now;
    signature.addAuditEvent(native.AUDIT.EXPIRED, {});
    await signature.save();
  }
  return stale.length;
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

  await executeDocument(signature);
  return signature;
}

/** The stored executed document, for attaching to the completion email. */
async function readStoredExecuted(signature) {
  if (!signature.executedPdf?.key) return null;
  return getObjectBuffer({ Key: signature.executedPdf.key });
}

module.exports = {
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
