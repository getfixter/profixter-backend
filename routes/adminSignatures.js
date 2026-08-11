/**
 * Admin e-signature routes.
 *
 * These sit alongside the document routes rather than inside them: Contracts
 * and Change Orders both send documents for signature, and neither document
 * router needs to know which provider is in use.
 *
 * Provider credentials never leave the server. Every PDF is streamed through
 * this authenticated router from private storage - no public or predictable
 * URLs are ever issued.
 */

const express = require("express");
const mongoose = require("mongoose");

const auth = require("../middleware/auth");
const { PERMISSIONS, requirePermission } = require("../middleware/authorize");
const Contract = require("../models/Contract");
const ChangeOrder = require("../models/ChangeOrder");
const ESignature = require("../models/ESignature");
const ESignWebhook = require("../models/ESignWebhook");
const { cleanString, sanitizeFilenamePart } = require("../utils/contractValidation");
const { COMPANY_INFO } = require("../config/premiumIslandHomesContract");
const { getObjectBuffer } = require("../utils/s3");
const adobe = require("../utils/esign/adobeSignClient");
const signatureService = require("../utils/esign/signatureService");
const provisioner = require("../utils/esign/webhookProvisioner");
const nativeService = require("../utils/esign/nativeSignatureService");
const native = require("../utils/esign/nativeSigning");
const signingEmails = require("../utils/esign/signingEmails");
const { createAdminActivityLog, markAdminActivityLog } = require("../utils/adminActivityLog");

const multer = require("multer");

const router = express.Router();

/** Manual signed-document upload. PDFs only, bounded size. */
const signedUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const isPdf = /\.pdf$/i.test(file.originalname || "") || file.mimetype === "application/pdf";
    return isPdf ? cb(null, true) : cb(new Error("The signed document must be a PDF"));
  },
});

/** Optional countersigner. When unset, only the customer signs. */
const COMPANY_SIGNER_EMAIL = String(process.env.ESIGN_COMPANY_SIGNER_EMAIL || "")
  .trim()
  .toLowerCase();

/** Signature states that mean an agreement is still live for this document. */
const ACTIVE_STATUSES = Object.freeze([
  "Draft",
  "Sent",
  "Viewed",
  "Awaiting Signature",
  "Partially Signed",
]);

router.use(auth, ...requirePermission(PERMISSIONS.ADMIN));

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** The signed-in admin's email, for audit attribution. */
function actorEmail(req) {
  const actor = req.accessUser || req.authUser || {};
  return String(actor.email || "").toLowerCase();
}

function serializeSignature(signature, options = {}) {
  const item = typeof signature.toObject === "function" ? signature.toObject() : signature;
  return {
    id: String(item._id),
    projectId: String(item.projectId),
    documentType: item.documentType,
    documentId: String(item.documentId),
    documentNumber: item.documentNumber || "",
    provider: item.provider,
    providerAgreementId: item.providerAgreementId || "",
    status: item.status,
    providerStatus: item.providerStatus || "",
    signers: (item.signers || []).map((signer) => ({
      role: signer.role,
      name: signer.name || "",
      email: signer.email,
      order: signer.order,
      status: signer.status,
      viewedAt: signer.viewedAt || null,
      signedAt: signer.signedAt || null,
    })),
    message: item.message || "",
    sentAt: item.sentAt || null,
    completedAt: item.completedAt || null,
    declinedAt: item.declinedAt || null,
    voidedAt: item.voidedAt || null,
    expiredAt: item.expiredAt || null,
    declineReason: item.declineReason || "",
    originalPdfAvailable: Boolean(item.originalPdf?.key),
    executedPdfAvailable: Boolean(item.executedPdf?.key),
    auditTrailAvailable: Boolean(item.auditTrailPdf?.key),
    documentRetrieval: {
      state: item.documentRetrieval?.state || "not_needed",
      attempts: Number(item.documentRetrieval?.attempts || 0),
      lastAttemptAt: item.documentRetrieval?.lastAttemptAt || null,
      lastError: item.documentRetrieval?.lastError || "",
    },
    // Event types and timings only - never raw provider payloads.
    events: options.includeEvents
      ? (item.processedEvents || []).map((event) => ({
          eventType: event.eventType,
          receivedAt: event.receivedAt,
        }))
      : undefined,
    eventCount: (item.processedEvents || []).length,
    createdAt: item.createdAt || null,
    updatedAt: item.updatedAt || null,
  };
}

/** Load the Contract or Change Order a signature request refers to. */
async function loadDocument(documentType, documentId) {
  if (!mongoose.isValidObjectId(documentId)) return null;

  if (documentType === "CONTRACT") {
    const contract = await Contract.findById(documentId);
    if (!contract) return null;
    return {
      type: "CONTRACT",
      doc: contract,
      projectId: contract.projectId,
      number: contract.contractNumber,
      name: `Home Improvement Agreement #${contract.contractNumber} - ${COMPANY_INFO.legalName}`,
      pdf: contract.generatedPdf,
      customerName: contract.customerSnapshot?.fullName || "",
      customerEmail: contract.customerSnapshot?.email || "",
      blockedReason:
        contract.status === "Canceled"
          ? "A canceled contract cannot be sent for signature."
          : contract.status === "Draft"
            ? "Generate the contract PDF before sending it for signature."
            : "",
    };
  }

  if (documentType === "CHANGE_ORDER") {
    const changeOrder = await ChangeOrder.findById(documentId);
    if (!changeOrder) return null;
    return {
      type: "CHANGE_ORDER",
      doc: changeOrder,
      projectId: changeOrder.projectId,
      number: changeOrder.changeOrderNumber,
      name: `Change Order ${changeOrder.changeOrderNumber} - ${COMPANY_INFO.legalName}`,
      pdf: changeOrder.generatedPdf,
      customerName: changeOrder.customerSnapshot?.fullName || "",
      customerEmail: changeOrder.customerSnapshot?.email || "",
      blockedReason: changeOrder.isLocked()
        ? `A ${changeOrder.status.toLowerCase()} change order cannot be sent for signature.`
        : "",
    };
  }

  return null;
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ""));
}

/**
 * Build the signer list. The customer signs first; the company countersigns
 * only when a company signer address is configured.
 */
function buildSigners(target, requested) {
  if (Array.isArray(requested) && requested.length) {
    return requested.slice(0, 5).map((signer, index) => ({
      role: signer?.role === "COMPANY" ? "COMPANY" : "CUSTOMER",
      name: cleanString(signer?.name, 160),
      email: cleanString(signer?.email, 254).toLowerCase(),
      order: Number(signer?.order || index + 1),
    }));
  }

  const signers = [
    {
      role: "CUSTOMER",
      name: target.customerName,
      email: String(target.customerEmail || "").toLowerCase(),
      order: 1,
    },
  ];
  if (COMPANY_SIGNER_EMAIL) {
    signers.push({
      role: "COMPANY",
      name: COMPANY_INFO.projectManager,
      email: COMPANY_SIGNER_EMAIL,
      order: 2,
    });
  }
  return signers;
}

async function getSignatureOr404(id, res) {
  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({ message: "Invalid signature ID" });
    return null;
  }
  const signature = await ESignature.findById(id);
  if (!signature) {
    res.status(404).json({ message: "Signature not found" });
    return null;
  }
  return signature;
}

function providerErrorResponse(res, error, fallback) {
  if (error?.code === "NOT_CONFIGURED") {
    return res.status(503).json({
      message:
        "Adobe Acrobat Sign is not configured on this server. Add the Adobe credentials before sending documents for signature.",
      code: "NOT_CONFIGURED",
    });
  }
  const status = Number(error?.status);
  if (status === 401 || status === 403) {
    return res.status(502).json({
      message: "Adobe Acrobat Sign rejected the credentials. Check the refresh token and scopes.",
      code: "PROVIDER_AUTH_FAILED",
    });
  }
  return res.status(502).json({ message: fallback, code: error?.code || "PROVIDER_ERROR" });
}

/* ------------------------------------------------------------------ */
/* Meta                                                                */
/* ------------------------------------------------------------------ */

/**
 * Provider readiness for the admin UI.
 *
 * Reads only stored state - no provider calls - so it is cheap enough to load
 * with every project page.
 */
router.get("/meta", async (_req, res) => {
  let webhook = null;
  try {
    const record = await ESignWebhook.findOne({
      provider: "adobe_sign",
      url: provisioner.webhookUrl(),
    }).lean();
    if (record) {
      webhook = {
        registered: record.provisionState === "active",
        providerWebhookId: record.providerWebhookId || "",
        state: record.providerState || "",
        eventCount: (record.events || []).length,
        url: record.url,
        lastCheckedAt: record.lastCheckedAt || null,
        lastError: record.lastError || "",
      };
    }
  } catch (error) {
    console.error("GET /admin/signatures/meta webhook lookup failed:", error?.message);
  }

  return res.json({
    provider: "adobe_sign",
    configured: adobe.isConfigured(),
    // Which credential style is in use — never the credentials themselves.
    authMode: adobe.authMode(),
    companySignerConfigured: Boolean(COMPANY_SIGNER_EMAIL),
    webhookConfigured: Boolean(
      process.env.ADOBE_SIGN_WEBHOOK_CLIENT_ID || process.env.ADOBE_SIGN_CLIENT_ID
    ),
    webhookPath: provisioner.WEBHOOK_PATH,
    webhook,
  });
});

/* ------------------------------------------------------------------ */
/* Native signing                                                      */
/* ------------------------------------------------------------------ */

/** Public signing links are built from the configured public site origin. */
function signingLinkFor(rawToken) {
  const base = String(process.env.PUBLIC_SITE_BASE_URL || "https://profixter.com").replace(/\/+$/, "");
  return `${base}/sign/${rawToken}`;
}

/**
 * Start a native signature request.
 *
 * `mode` is REMOTE (emailed link) or IN_PERSON (short-lived session used on the
 * admin's own device). Both freeze the document identically and complete
 * through the same pipeline; only delivery and expiry differ.
 *
 * The raw token exists only in this response. For REMOTE it goes into the
 * email; for IN_PERSON it is handed straight back so the device can open the
 * signing ceremony without any email at all.
 */
router.post("/native/send", async (req, res) => {
  let audit = null;
  try {
    const documentType = cleanString(req.body?.documentType, 40).toUpperCase();
    const documentId = cleanString(req.body?.documentId, 80);
    const mode = cleanString(req.body?.mode, 20).toUpperCase() === "IN_PERSON" ? "IN_PERSON" : "REMOTE";

    if (!["CONTRACT", "CHANGE_ORDER"].includes(documentType)) {
      return res.status(400).json({ message: "documentType must be CONTRACT or CHANGE_ORDER" });
    }
    if (!mongoose.isValidObjectId(documentId)) {
      return res.status(400).json({ message: "Invalid document ID" });
    }

    audit = await createAdminActivityLog(req, {
      action: mode === "IN_PERSON" ? "In-Person Signing Started" : "Signature Request Sent",
      entityType: documentType === "CONTRACT" ? "Contract" : "ChangeOrder",
      entityId: documentId,
      details: { mode },
    });

    const { signature, rawToken, target } = await nativeService.createSignatureRequest({
      documentType,
      documentId,
      signingMode: mode,
      createdBy: req.user.id,
      message: cleanString(req.body?.message, 2000),
      context: { ...native.requestEvidence(req), actorEmail: actorEmail(req) },
    });

    const signingUrl = signingLinkFor(rawToken);

    // In-person signing happens on this device; emailing a link would be noise
    // and would turn a short-lived session into a mailbox credential.
    let emailed = false;
    if (mode === "REMOTE") {
      try {
        await signingEmails.sendSignatureRequest({ signature, target, signingUrl });
        signature.signingToken.sendCount += 1;
        signature.signingToken.lastSentAt = new Date();
        signature.status = "Sent";
        signature.sentAt = new Date();
        signature.addAuditEvent(native.AUDIT.EMAIL_SENT, { recipient: target.customerEmail });
        await signature.save();
        emailed = true;
      } catch (emailError) {
        // The request exists and is valid; only delivery failed. Surfaced to
        // the admin rather than silently swallowed.
        console.error("native signing: request email failed:", emailError?.message);
      }
    }

    await markAdminActivityLog(audit, {
      action: mode === "IN_PERSON" ? "In-Person Signing Session Created" : "Signature Request Created",
      details: { documentNumber: target.number, signatureId: String(signature._id), emailed },
    });

    return res.status(201).json({
      signature: serializeSignature(signature),
      // The link is returned once. It is not stored in this form anywhere.
      signingUrl,
      mode,
      emailed,
    });
  } catch (error) {
    console.error("POST /admin/signatures/native/send failed:", error?.message);
    await markAdminActivityLog(audit, {
      action: "Signature Request Failed",
      details: { message: error?.message || "Unknown error" },
    });
    if (error?.code === "SIGNING_NOT_CONFIGURED") {
      return res.status(409).json({ message: error.message, code: error.code });
    }
    return res.status(400).json({ message: error?.message || "Failed to start the signature request" });
  }
});

/**
 * Resend the request email.
 *
 * Reuses the SAME frozen document and the SAME request. A reminder must never
 * produce a new agreement revision or a new document to sign - only the
 * original request is re-delivered, and the raw token no longer exists to be
 * re-sent, so a fresh link is issued against the identical frozen record.
 */
router.post("/native/:id/resend", async (req, res) => {
  try {
    const signature = await getSignatureOr404(req.params.id, res);
    if (!signature) return null;
    if (signature.signingMode !== "REMOTE") {
      return res.status(409).json({ message: "Only a remote request can be resent." });
    }
    const rejection = native.tokenRejectionReason(signature);
    if (rejection) {
      return res.status(409).json({ message: `This request is ${rejection} and cannot be resent.` });
    }

    // The stored hash cannot be reversed, so re-delivery issues a new token
    // against the unchanged frozen document.
    const rawToken = native.generateToken();
    signature.signingToken.hash = native.hashToken(rawToken);
    signature.signingToken.sendCount += 1;
    signature.signingToken.lastSentAt = new Date();

    const target = await nativeService.loadDocument(signature.documentType, signature.documentId);
    const signingUrl = signingLinkFor(rawToken);
    await signingEmails.sendSignatureRequest({ signature, target, signingUrl, reminder: true });

    signature.addAuditEvent(
      native.AUDIT.EMAIL_SENT,
      { reminder: true, sendCount: signature.signingToken.sendCount },
      { ...native.requestEvidence(req), actorEmail: actorEmail(req) }
    );
    await signature.save();

    return res.json({ signature: serializeSignature(signature), signingUrl });
  } catch (error) {
    console.error("POST /admin/signatures/native/:id/resend failed:", error?.message);
    return res.status(400).json({ message: error?.message || "Failed to resend the request" });
  }
});

/**
 * Record a document signed outside the native ceremony.
 *
 * Kept clearly distinct: no token, no consent record, no signing IP and no
 * certificate are created, because none of those things happened.
 */
router.post("/native/manual-upload", signedUpload.single("file"), async (req, res) => {
  let audit = null;
  try {
    const documentType = cleanString(req.body?.documentType, 40).toUpperCase();
    const documentId = cleanString(req.body?.documentId, 80);
    if (!["CONTRACT", "CHANGE_ORDER"].includes(documentType)) {
      return res.status(400).json({ message: "documentType must be CONTRACT or CHANGE_ORDER" });
    }
    if (!mongoose.isValidObjectId(documentId)) {
      return res.status(400).json({ message: "Invalid document ID" });
    }
    if (!req.file) return res.status(400).json({ message: "A signed PDF is required" });

    audit = await createAdminActivityLog(req, {
      action: "Signed Document Manually Uploaded",
      entityType: documentType === "CONTRACT" ? "Contract" : "ChangeOrder",
      entityId: documentId,
      details: { fileName: req.file.originalname, size: req.file.size },
    });

    const signature = await nativeService.recordManualUpload({
      documentType,
      documentId,
      buffer: req.file.buffer,
      fileName: req.file.originalname,
      uploadedBy: req.user.id,
      context: { ...native.requestEvidence(req), actorEmail: actorEmail(req) },
    });

    await markAdminActivityLog(audit, {
      action: "Signed Document Recorded",
      details: { signatureId: String(signature._id), mode: "MANUAL_UPLOAD" },
    });

    return res.status(201).json({ signature: serializeSignature(signature) });
  } catch (error) {
    console.error("POST /admin/signatures/native/manual-upload failed:", error?.message);
    await markAdminActivityLog(audit, {
      action: "Signed Document Upload Failed",
      details: { message: error?.message || "Unknown error" },
    });
    return res.status(400).json({ message: error?.message || "Failed to record the signed document" });
  }
});

/** Revoke a pending request. The frozen document and history are retained. */
router.post("/native/:id/revoke", async (req, res) => {
  try {
    const signature = await getSignatureOr404(req.params.id, res);
    if (!signature) return null;
    await nativeService.revokeSignature({
      signature,
      reason: cleanString(req.body?.reason, 500),
      context: { ...native.requestEvidence(req), actorEmail: actorEmail(req) },
    });
    return res.json({ signature: serializeSignature(signature) });
  } catch (error) {
    console.error("POST /admin/signatures/native/:id/revoke failed:", error?.message);
    return res.status(400).json({ message: error?.message || "Failed to revoke the request" });
  }
});

/** Stream a stored artifact: frozen original, executed document or certificate. */
router.get("/native/:id/document", async (req, res) => {
  try {
    const signature = await getSignatureOr404(req.params.id, res);
    if (!signature) return null;

    const kind = cleanString(req.query.kind || "executed", 20);
    const slot =
      kind === "frozen"
        ? signature.frozenDocument
        : kind === "certificate"
          ? signature.certificatePdf
          : signature.executedPdf;

    if (!slot?.key) return res.status(404).json({ message: `No ${kind} document is available` });

    const buffer = await signatureService.readStoredPdf(slot.key);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `${req.query.disposition === "inline" ? "inline" : "attachment"}; filename="${sanitizeFilenamePart(
        slot.fileName || `${signature.documentNumber || "document"}-${kind}.pdf`
      )}"`
    );
    return res.send(buffer);
  } catch (error) {
    console.error("GET /admin/signatures/native/:id/document failed:", error?.message);
    return res.status(500).json({ message: "Failed to load the document" });
  }
});

/* ------------------------------------------------------------------ */
/* Send                                                                */
/* ------------------------------------------------------------------ */

router.post("/send", async (req, res) => {
  let audit = null;
  try {
    const documentType = cleanString(req.body?.documentType, 40).toUpperCase();
    const documentId = cleanString(req.body?.documentId, 80);
    if (!["CONTRACT", "CHANGE_ORDER"].includes(documentType)) {
      return res.status(400).json({ message: "documentType must be CONTRACT or CHANGE_ORDER" });
    }

    const target = await loadDocument(documentType, documentId);
    if (!target) return res.status(404).json({ message: "Document not found" });
    if (target.blockedReason) return res.status(409).json({ message: target.blockedReason });
    if (!target.pdf?.key) {
      return res
        .status(409)
        .json({ message: "Generate the document PDF before sending it for signature" });
    }

    if (!adobe.isConfigured()) {
      return res.status(503).json({
        message:
          "Adobe Acrobat Sign is not configured on this server. Add the Adobe credentials before sending documents for signature.",
        code: "NOT_CONFIGURED",
      });
    }

    // One live agreement per document: two open agreements for the same
    // paperwork is how a wrong version gets signed.
    const existing = await ESignature.findOne({
      documentType,
      documentId: target.doc._id,
      status: { $in: ACTIVE_STATUSES },
    });
    if (existing) {
      return res.status(409).json({
        message: "This document already has a signature request in progress. Cancel it first.",
        signature: serializeSignature(existing),
      });
    }

    const signers = buildSigners(target, req.body?.signers);
    const invalid = signers.filter((signer) => !isValidEmail(signer.email));
    if (invalid.length) {
      return res.status(400).json({
        message: signers.length
          ? "Every signer needs a valid email address"
          : "At least one signer is required",
      });
    }

    audit = await createAdminActivityLog(req, {
      action: "E-Signature Send Started",
      entityType: documentType === "CONTRACT" ? "Contract" : "ChangeOrder",
      entityId: target.doc._id,
      entityName: target.number,
      details: { projectId: target.projectId, signerCount: signers.length },
    });

    const pdfBuffer = await getObjectBuffer({ Key: target.pdf.key });

    const signature = await signatureService.sendForSignature({
      projectId: target.projectId,
      documentType,
      documentId: target.doc._id,
      documentNumber: target.number,
      documentName: target.name,
      pdfBuffer,
      pdfFileName: target.pdf.fileName || `${sanitizeFilenamePart(target.number)}.pdf`,
      signers,
      message: cleanString(req.body?.message, 2000),
      createdBy: req.user.id,
      inPerson: req.body?.inPerson === true,
    });

    // Link the document to its signature and record the send.
    if (documentType === "CHANGE_ORDER") {
      target.doc.signatureId = signature._id;
      target.doc.status = "Sent";
      target.doc.sentAt = target.doc.sentAt || new Date();
      target.doc.updatedBy = req.user.id;
      target.doc.addAuditEvent("Sent for e-signature", req, {
        provider: signature.provider,
        signerCount: signers.length,
      });
      await target.doc.save();
    } else {
      target.doc.addAuditEvent("Sent for e-signature", req, {
        provider: signature.provider,
        signerCount: signers.length,
      });
      await target.doc.save();
    }

    await markAdminActivityLog(audit, {
      action: "E-Signature Sent",
      details: { documentNumber: target.number, provider: signature.provider },
    });

    return res.status(201).json({ signature: serializeSignature(signature) });
  } catch (error) {
    console.error("POST /admin/signatures/send failed:", error?.message);
    await markAdminActivityLog(audit, {
      action: "E-Signature Send Failed",
      details: { message: error?.message || "Unknown error" },
    });
    if (error?.name === "AdobeSignError") {
      return providerErrorResponse(res, error, "Failed to send the document for signature");
    }
    return res.status(500).json({ message: "Failed to send the document for signature" });
  }
});

/* ------------------------------------------------------------------ */
/* Read                                                                */
/* ------------------------------------------------------------------ */

/**
 * The Adobe hosted signing URL for the customer on this agreement.
 *
 * Used for in-person signing: the admin opens it on their phone and hands the
 * device to the customer. The ceremony runs inside Adobe, so the signature,
 * the audit trail, the executed PDF and the completion webhook are identical
 * to a remote signature - nothing about the record is special-cased.
 *
 * The URL is short-lived and specific to the signer, and is returned only to
 * an authenticated admin.
 */
router.post("/:id/signing-url", async (req, res) => {
  try {
    const signature = await getSignatureOr404(req.params.id, res);
    if (!signature) return null;
    if (!signature.providerAgreementId) {
      return res.status(409).json({ message: "This document has not been sent for signature yet" });
    }
    if (signature.isTerminal()) {
      return res
        .status(409)
        .json({ message: `This document is already ${signature.status.toLowerCase()}.` });
    }

    const urls = await adobe.getSigningUrls(signature.providerAgreementId);
    if (!urls.length) {
      return res.status(409).json({
        message:
          "Adobe has no signing URL for this agreement yet. It may still be processing - try again shortly.",
      });
    }

    // Prefer the customer; fall back to whoever is next to act.
    const customer = signature.signers.find((signer) => signer.role === "CUSTOMER");
    const match =
      (customer && urls.find((entry) => entry.email === String(customer.email).toLowerCase())) ||
      urls[0];

    signature.providerMeta = {
      ...(signature.providerMeta || {}),
      lastInPersonAt: new Date().toISOString(),
    };
    await signature.save();

    return res.json({ signingUrl: match.url, email: match.email });
  } catch (error) {
    console.error("POST /admin/signatures/:id/signing-url failed:", error?.message);
    if (error?.name === "AdobeSignError") {
      return providerErrorResponse(res, error, "Failed to open the in-person signing session");
    }
    return res.status(500).json({ message: "Failed to open the in-person signing session" });
  }
});

router.get("/document/:documentType/:documentId", async (req, res) => {
  try {
    const documentType = String(req.params.documentType || "").toUpperCase();
    if (!["CONTRACT", "CHANGE_ORDER"].includes(documentType)) {
      return res.status(400).json({ message: "documentType must be CONTRACT or CHANGE_ORDER" });
    }
    if (!mongoose.isValidObjectId(req.params.documentId)) {
      return res.status(400).json({ message: "Invalid document ID" });
    }

    const signatures = await ESignature.find({
      documentType,
      documentId: req.params.documentId,
    }).sort({ createdAt: -1 });

    return res.json({ signatures: signatures.map((s) => serializeSignature(s)) });
  } catch (error) {
    console.error("GET /admin/signatures/document failed:", error);
    return res.status(500).json({ message: "Failed to load signature history" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const signature = await getSignatureOr404(req.params.id, res);
    if (!signature) return null;
    return res.json({ signature: serializeSignature(signature, { includeEvents: true }) });
  } catch (error) {
    console.error("GET /admin/signatures/:id failed:", error);
    return res.status(500).json({ message: "Failed to load signature" });
  }
});

/* ------------------------------------------------------------------ */
/* Download                                                            */
/* ------------------------------------------------------------------ */

/** type = executed | original | audit. */
router.get("/:id/download", async (req, res) => {
  try {
    const signature = await getSignatureOr404(req.params.id, res);
    if (!signature) return null;

    const type = cleanString(req.query.type || "executed", 20);
    const slot =
      type === "original"
        ? signature.originalPdf
        : type === "audit"
          ? signature.auditTrailPdf
          : signature.executedPdf;

    if (!slot?.key) {
      return res.status(404).json({
        message:
          type === "executed"
            ? "The executed PDF has not been retrieved yet"
            : `The ${type} PDF is not available`,
      });
    }

    const buffer = await signatureService.readStoredPdf(slot.key);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `${req.query.disposition === "inline" ? "inline" : "attachment"}; filename="${sanitizeFilenamePart(
        slot.fileName || `${signature.documentNumber || "document"}.pdf`
      )}"`
    );
    return res.send(buffer);
  } catch (error) {
    console.error("GET /admin/signatures/:id/download failed:", error);
    return res.status(500).json({ message: "Failed to download the signed document" });
  }
});

/* ------------------------------------------------------------------ */
/* Recovery                                                            */
/* ------------------------------------------------------------------ */

/** Pull current status from the provider. Used when a webhook never arrived. */
router.post("/:id/refresh", async (req, res) => {
  try {
    const signature = await getSignatureOr404(req.params.id, res);
    if (!signature) return null;
    if (!signature.providerAgreementId) {
      return res.status(409).json({ message: "This signature has no provider agreement to refresh" });
    }

    await signatureService.refreshFromProvider(signature);
    await signatureService.syncDocumentStatus(signature);

    if (signature.status === "Completed" && !signature.executedPdf?.key) {
      try {
        await signatureService.retrieveExecutedDocuments(signature);
      } catch (retrievalError) {
        console.error("signature refresh: retrieval failed", retrievalError?.message);
      }
    }

    return res.json({ signature: serializeSignature(signature, { includeEvents: true }) });
  } catch (error) {
    console.error("POST /admin/signatures/:id/refresh failed:", error?.message);
    if (error?.name === "AdobeSignError") {
      return providerErrorResponse(res, error, "Failed to refresh the signature status");
    }
    return res.status(500).json({ message: "Failed to refresh the signature status" });
  }
});

/** Retry a failed executed-document download. */
router.post("/:id/retry-retrieval", async (req, res) => {
  try {
    const signature = await getSignatureOr404(req.params.id, res);
    if (!signature) return null;
    if (signature.status !== "Completed") {
      return res
        .status(409)
        .json({ message: "Only a completed signature has an executed document to retrieve" });
    }

    await signatureService.retrieveExecutedDocuments(signature);
    return res.json({ signature: serializeSignature(signature, { includeEvents: true }) });
  } catch (error) {
    console.error("POST /admin/signatures/:id/retry-retrieval failed:", error?.message);
    if (error?.name === "AdobeSignError") {
      return providerErrorResponse(res, error, "Failed to retrieve the executed document");
    }
    return res.status(500).json({ message: "Failed to retrieve the executed document" });
  }
});

/** Recall an agreement that is still out for signature. */
router.post("/:id/cancel", async (req, res) => {
  try {
    const signature = await getSignatureOr404(req.params.id, res);
    if (!signature) return null;
    if (signature.isTerminal()) {
      return res
        .status(409)
        .json({ message: `A ${signature.status.toLowerCase()} signature cannot be cancelled.` });
    }

    const reason = cleanString(req.body?.reason, 500) || "Cancelled by Premium Island Homes Inc.";
    await signatureService.cancelSignature(signature, reason);
    await signatureService.syncDocumentStatus(signature);

    return res.json({ signature: serializeSignature(signature, { includeEvents: true }) });
  } catch (error) {
    console.error("POST /admin/signatures/:id/cancel failed:", error?.message);
    if (error?.name === "AdobeSignError") {
      return providerErrorResponse(res, error, "Failed to cancel the signature request");
    }
    return res.status(500).json({ message: "Failed to cancel the signature request" });
  }
});

module.exports = router;
module.exports.ACTIVE_STATUSES = ACTIVE_STATUSES;
module.exports.buildSigners = buildSigners;
