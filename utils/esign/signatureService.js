/**
 * E-signature orchestration.
 *
 * Provider-agnostic: routes and webhooks talk to this module, and only
 * adobeSignClient knows about Adobe. Swapping providers means adding one
 * adapter and a branch in `providerFor`, not touching document logic.
 *
 * Core guarantee: when a provider reports an agreement complete, ProFixter
 * retrieves the executed PDF and audit trail and stores them privately, so the
 * project record never depends on the provider or on anyone's inbox.
 */

const ESignature = require("../../models/ESignature");
const Contract = require("../../models/Contract");
const ChangeOrder = require("../../models/ChangeOrder");
const adobe = require("./adobeSignClient");
const { putPrivateObject, getObjectBuffer } = require("../s3");

const ESIGN_S3_PREFIX = (process.env.ESIGN_S3_PREFIX || "private/admin/esign").replace(/\/+$/, "");

/** Max automatic attempts before a retrieval is left for manual retry. */
const MAX_RETRIEVAL_ATTEMPTS = 5;

function providerFor(name = "adobe_sign") {
  if (name === "adobe_sign") return adobe;
  throw new Error(`Unsupported e-signature provider: ${name}`);
}

/**
 * Reduce an untrusted value to a single safe path segment.
 * Separators are removed outright and dot runs collapsed, so no input can
 * produce a traversal segment or escape the private prefix.
 */
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
/* Sending                                                             */
/* ------------------------------------------------------------------ */

/**
 * Send a document for signature.
 *
 * The unsigned PDF is copied into e-sign storage first, so the exact bytes
 * that went out for signature are preserved even if the source document is
 * later regenerated.
 */
async function sendForSignature({
  projectId,
  documentType,
  documentId,
  documentNumber,
  documentName,
  pdfBuffer,
  pdfFileName,
  signers,
  message = "",
  provider = "adobe_sign",
  createdBy = null,
}) {
  if (!Array.isArray(signers) || !signers.length) {
    throw new Error("At least one signer is required");
  }

  const client = providerFor(provider);

  const signature = await ESignature.create({
    projectId,
    documentType,
    documentId,
    documentNumber,
    provider,
    status: "Draft",
    signers: signers.map((s, i) => ({
      role: s.role,
      name: s.name || "",
      email: String(s.email || "").toLowerCase(),
      order: Number(s.order || i + 1),
      status: "Pending",
    })),
    message,
    createdBy,
  });

  // Preserve the exact unsigned bytes that were sent.
  const originalKey = storageKey(signature, "original", pdfFileName);
  await putPrivateObject({
    Key: originalKey,
    Body: pdfBuffer,
    ContentType: "application/pdf",
    CacheControl: "private, max-age=0, no-cache",
  });
  signature.originalPdf = {
    key: originalKey,
    fileName: pdfFileName,
    size: pdfBuffer.length,
    storedAt: new Date(),
  };
  await signature.save();

  try {
    const transientDocumentId = await client.uploadTransientDocument({
      buffer: pdfBuffer,
      fileName: pdfFileName,
    });
    const agreementId = await client.createAgreement({
      name: documentName,
      transientDocumentId,
      signers: signature.signers,
      message,
    });

    signature.providerAgreementId = agreementId;
    signature.status = "Sent";
    signature.providerStatus = "OUT_FOR_SIGNATURE";
    signature.sentAt = new Date();
    await signature.save();
    return signature;
  } catch (error) {
    signature.status = "Failed";
    signature.providerMeta = {
      ...(signature.providerMeta || {}),
      lastError: error?.message || "Unknown error",
      lastErrorCode: error?.code || "",
    };
    await signature.save();
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Executed document retrieval                                         */
/* ------------------------------------------------------------------ */

/**
 * Fetch and store the executed PDF and audit trail.
 *
 * Safe to call repeatedly: it skips work already done, and records failures on
 * the signature so a later retry can pick up where it left off. A failure here
 * never rolls back the fact that the agreement completed.
 */
async function retrieveExecutedDocuments(signature) {
  const client = providerFor(signature.provider);
  const agreementId = signature.providerAgreementId;
  if (!agreementId) return signature;

  if (signature.executedPdf?.key && signature.documentRetrieval?.state === "succeeded") {
    return signature;
  }

  signature.documentRetrieval = {
    ...(signature.documentRetrieval?.toObject?.() || signature.documentRetrieval || {}),
    state: "pending",
    attempts: Number(signature.documentRetrieval?.attempts || 0) + 1,
    lastAttemptAt: new Date(),
  };
  await signature.save();

  try {
    if (!signature.executedPdf?.key) {
      const executed = await client.getCombinedDocument(agreementId);
      const fileName = `${sanitizePart(signature.documentNumber || "document")}-executed.pdf`;
      const key = storageKey(signature, "executed", fileName);
      await putPrivateObject({
        Key: key,
        Body: executed,
        ContentType: "application/pdf",
        CacheControl: "private, max-age=0, no-cache",
      });
      signature.executedPdf = {
        key,
        fileName,
        size: executed.length,
        storedAt: new Date(),
      };
    }

    // The audit trail is best effort: its absence must not fail the executed PDF.
    if (!signature.auditTrailPdf?.key) {
      try {
        const audit = await client.getAuditTrail(agreementId);
        const fileName = `${sanitizePart(signature.documentNumber || "document")}-audit-trail.pdf`;
        const key = storageKey(signature, "audit", fileName);
        await putPrivateObject({
          Key: key,
          Body: audit,
          ContentType: "application/pdf",
          CacheControl: "private, max-age=0, no-cache",
        });
        signature.auditTrailPdf = {
          key,
          fileName,
          size: audit.length,
          storedAt: new Date(),
        };
      } catch (auditError) {
        signature.providerMeta = {
          ...(signature.providerMeta || {}),
          auditTrailError: auditError?.message || "Unavailable",
        };
      }
    }

    signature.documentRetrieval.state = "succeeded";
    signature.documentRetrieval.lastError = "";
    await signature.save();

    // Mirror the executed copy onto the document itself so the project page can
    // serve it without knowing anything about signatures or providers.
    await attachExecutedDocument(signature);
    return signature;
  } catch (error) {
    signature.documentRetrieval.state = "failed";
    signature.documentRetrieval.lastError = String(error?.message || "Unknown error").slice(0, 1000);
    await signature.save();
    throw error;
  }
}

/**
 * Point the owning document at the executed PDF stored under the signature.
 *
 * Never overwrites an executed copy that is already recorded: if an admin has
 * already filed a countersigned PDF, that record stands and the provider copy
 * remains reachable through the signature.
 */
async function attachExecutedDocument(signature) {
  if (!signature.executedPdf?.key) return;

  if (signature.documentType === "CHANGE_ORDER") {
    const changeOrder = await ChangeOrder.findById(signature.documentId);
    if (!changeOrder || changeOrder.executedPdf?.key) return;
    changeOrder.executedPdf = {
      key: signature.executedPdf.key,
      url: "",
      fileName: signature.executedPdf.fileName,
      size: signature.executedPdf.size,
      uploadedAt: signature.executedPdf.storedAt || new Date(),
      uploadedBy: signature.createdBy || null,
      source: signature.provider,
    };
    changeOrder.auditHistory.push({
      event: "Executed PDF stored",
      at: new Date(),
      details: { source: signature.provider },
    });
    await changeOrder.save();
    return;
  }

  if (signature.documentType === "CONTRACT") {
    const contract = await Contract.findById(signature.documentId);
    if (!contract || contract.signedPdf?.key) return;
    contract.signedPdf = {
      key: signature.executedPdf.key,
      url: "",
      fileName: signature.executedPdf.fileName,
      size: signature.executedPdf.size,
      uploadedAt: signature.executedPdf.storedAt || new Date(),
      uploadedBy: signature.createdBy || null,
    };
    contract.auditHistory.push({
      event: "Executed PDF stored",
      at: new Date(),
      details: { source: signature.provider },
    });
    await contract.save();
  }
}

/** Signature status -> Change Order status. */
const CHANGE_ORDER_STATUS_FROM_SIGNATURE = Object.freeze({
  Sent: "Sent",
  Viewed: "Viewed",
  "Awaiting Signature": "Awaiting Signature",
  "Partially Signed": "Partially Signed",
  Completed: "Executed",
  Declined: "Declined",
  Cancelled: "Voided",
  Expired: "Voided",
});

/**
 * Reflect a signature outcome onto the owning Contract or Change Order.
 *
 * Contracts only ever move to "Signed" on completion: the contract lifecycle is
 * production-critical and intermediate signature states must not disturb it.
 */
async function syncDocumentStatus(signature) {
  if (signature.documentType === "CHANGE_ORDER") {
    const changeOrder = await ChangeOrder.findById(signature.documentId);
    if (!changeOrder) return null;

    const next = CHANGE_ORDER_STATUS_FROM_SIGNATURE[signature.status];
    if (!next || changeOrder.status === next) return changeOrder;
    // Executed is final: a late event must never reopen it.
    if (changeOrder.status === "Executed") return changeOrder;

    changeOrder.status = next;
    if (next === "Executed") changeOrder.executedAt = signature.completedAt || new Date();
    if (next === "Declined") changeOrder.declinedAt = signature.declinedAt || new Date();
    if (next === "Voided") {
      changeOrder.voidedAt = signature.voidedAt || signature.expiredAt || new Date();
    }
    changeOrder.auditHistory.push({
      event: `Signature ${signature.status}`,
      at: new Date(),
      details: { providerAgreementId: signature.providerAgreementId },
    });
    await changeOrder.save();
    return changeOrder;
  }

  if (signature.documentType === "CONTRACT" && signature.status === "Completed") {
    const contract = await Contract.findById(signature.documentId);
    if (!contract || contract.status === "Signed") return contract || null;
    contract.status = "Signed";
    contract.auditHistory.push({
      event: "Signature completed",
      at: new Date(),
      details: { providerAgreementId: signature.providerAgreementId },
    });
    await contract.save();
    return contract;
  }

  return null;
}

/** Signatures whose completion was recorded but whose PDF never landed. */
async function findRetrievalBacklog(limit = 25) {
  return ESignature.find({
    status: "Completed",
    "documentRetrieval.state": { $in: ["pending", "failed"] },
    "documentRetrieval.attempts": { $lt: MAX_RETRIEVAL_ATTEMPTS },
  })
    .sort({ completedAt: 1 })
    .limit(limit);
}

/* ------------------------------------------------------------------ */
/* Event application                                                   */
/* ------------------------------------------------------------------ */

/**
 * Apply one normalized provider event.
 *
 * Idempotent on `providerEventId`: a duplicate delivery is recognised and
 * ignored. Terminal states are never reopened by a late or out-of-order event.
 *
 * Returns { applied, signature, duplicated }.
 */
async function applyEvent({
  signature,
  providerEventId,
  eventType,
  normalizedEvent,
  providerStatus,
  participants = [],
  declineReason = "",
  occurredAt = new Date(),
}) {
  if (signature.hasProcessedEvent(providerEventId)) {
    return { applied: false, duplicated: true, signature };
  }

  // Record the event first so a crash mid-apply cannot cause a double-apply.
  signature.processedEvents.push({
    providerEventId: String(providerEventId),
    eventType: String(eventType || ""),
    receivedAt: new Date(),
  });

  if (providerStatus) signature.providerStatus = String(providerStatus).slice(0, 80);

  // Merge per-signer progress when the provider supplied it.
  if (Array.isArray(participants) && participants.length) {
    for (const participant of participants) {
      const email = String(participant.email || "").toLowerCase();
      const signer = signature.signers.find((s) => s.email === email);
      if (!signer) continue;
      if (participant.status) signer.status = String(participant.status).slice(0, 60);
      if (participant.viewedAt && !signer.viewedAt) signer.viewedAt = participant.viewedAt;
      if (participant.signedAt && !signer.signedAt) signer.signedAt = participant.signedAt;
    }
  }

  const wasTerminal = signature.isTerminal();

  switch (normalizedEvent) {
    case "viewed":
      if (!wasTerminal && signature.status === "Sent") signature.status = "Viewed";
      break;
    case "sent":
      if (!wasTerminal) signature.status = "Awaiting Signature";
      break;
    case "signer_completed":
      if (!wasTerminal) signature.status = "Partially Signed";
      break;
    case "completed":
      if (!wasTerminal) {
        signature.status = "Completed";
        signature.completedAt = occurredAt;
        // Mark retrieval as owed. The actual download happens after the
        // webhook has been acknowledged, and is retried independently.
        signature.documentRetrieval = {
          ...(signature.documentRetrieval?.toObject?.() || signature.documentRetrieval || {}),
          state: "pending",
        };
      }
      break;
    case "declined":
      if (!wasTerminal) {
        signature.status = "Declined";
        signature.declinedAt = occurredAt;
        signature.declineReason = String(declineReason || "").slice(0, 2000);
      }
      break;
    case "cancelled":
      if (!wasTerminal) {
        signature.status = "Cancelled";
        signature.voidedAt = occurredAt;
      }
      break;
    case "expired":
      if (!wasTerminal) {
        signature.status = "Expired";
        signature.expiredAt = occurredAt;
      }
      break;
    default:
      // Unknown or informational event: recorded, but changes no state.
      break;
  }

  await signature.save();
  return { applied: true, duplicated: false, signature };
}

/** Stream a stored PDF back out. Used by authenticated admin download routes. */
async function readStoredPdf(key) {
  if (!key) throw new Error("Missing storage key");
  return getObjectBuffer({ Key: key });
}

/**
 * Pull current state from the provider and apply it.
 *
 * This is the recovery path for a webhook that never arrived. It is idempotent
 * by construction: the synthetic event id encodes the provider status, so
 * refreshing twice at the same status changes nothing.
 */
async function refreshFromProvider(signature) {
  const client = providerFor(signature.provider);
  if (!signature.providerAgreementId) return { applied: false, signature };

  const agreement = await client.getAgreement(signature.providerAgreementId);
  const providerStatus = String(agreement?.status || "");
  const mapped = client.mapAgreementStatus(providerStatus);

  let participants = [];
  try {
    const members = await client.getAgreementMembers(signature.providerAgreementId);
    participants = (members?.participantSets || []).flatMap((set) =>
      (set?.memberInfos || []).map((member) => ({
        email: member?.email,
        status: set?.status || "",
        signedAt: member?.completedDate ? new Date(member.completedDate) : null,
        viewedAt: member?.lastViewedDate ? new Date(member.lastViewedDate) : null,
      }))
    );
  } catch {
    // Per-signer detail is a nice-to-have; agreement status is what matters.
  }

  const normalizedEvent = {
    Draft: "created",
    Sent: "sent",
    Viewed: "viewed",
    "Awaiting Signature": "sent",
    "Partially Signed": "signer_completed",
    Completed: "completed",
    Declined: "declined",
    Cancelled: "cancelled",
    Expired: "expired",
  }[mapped];

  return applyEvent({
    signature,
    providerEventId: `manual-refresh:${signature.providerAgreementId}:${providerStatus}`,
    eventType: `MANUAL_REFRESH_${providerStatus}`,
    normalizedEvent,
    providerStatus,
    participants,
    declineReason: agreement?.agreementRejectionInfo?.rejectionReason || "",
    occurredAt: new Date(),
  });
}

/** Recall an agreement that is still out for signature. */
async function cancelSignature(signature, reason) {
  const client = providerFor(signature.provider);
  if (signature.providerAgreementId && !signature.isTerminal()) {
    await client.cancelAgreement(signature.providerAgreementId, reason);
  }
  signature.status = "Cancelled";
  signature.voidedAt = new Date();
  await signature.save();
  return signature;
}

module.exports = {
  ESIGN_S3_PREFIX,
  MAX_RETRIEVAL_ATTEMPTS,
  CHANGE_ORDER_STATUS_FROM_SIGNATURE,
  providerFor,
  sendForSignature,
  retrieveExecutedDocuments,
  attachExecutedDocument,
  syncDocumentStatus,
  refreshFromProvider,
  cancelSignature,
  findRetrievalBacklog,
  applyEvent,
  readStoredPdf,
  storageKey,
};
