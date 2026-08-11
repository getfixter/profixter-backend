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
const { cleanString, sanitizeFilenamePart } = require("../utils/contractValidation");
const { COMPANY_INFO } = require("../config/premiumIslandHomesContract");
const { getObjectBuffer } = require("../utils/s3");
const adobe = require("../utils/esign/adobeSignClient");
const signatureService = require("../utils/esign/signatureService");
const { createAdminActivityLog, markAdminActivityLog } = require("../utils/adminActivityLog");

const router = express.Router();

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
      name: `Contract ${contract.contractNumber} - ${COMPANY_INFO.legalName}`,
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

/** Whether the server can actually talk to the provider, for the admin UI. */
router.get("/meta", (_req, res) => {
  return res.json({
    provider: "adobe_sign",
    configured: adobe.isConfigured(),
    // Which credential style is in use — never the credentials themselves.
    authMode: adobe.authMode(),
    companySignerConfigured: Boolean(COMPANY_SIGNER_EMAIL),
    webhookConfigured: Boolean(
      process.env.ADOBE_SIGN_WEBHOOK_CLIENT_ID || process.env.ADOBE_SIGN_CLIENT_ID
    ),
    webhookPath: "/api/esign/webhook/adobe-sign",
  });
});

/**
 * Live, read-only proof that THIS running environment can talk to Adobe using
 * its own configuration.
 *
 * The only calls it makes are a token refresh and GET /baseUris. It creates
 * nothing, sends nothing, and registers nothing. It exists so a deployed
 * environment can be verified without shipping credentials anywhere or reading
 * them back out - no secret or token value appears in the response.
 */
router.get("/connectivity", async (req, res) => {
  const configuredHost = String(process.env.ADOBE_SIGN_TOKEN_HOST || "").trim().replace(/\/+$/, "");
  const expectedShard = String(process.env.ADOBE_SIGN_SHARD || "").trim().toLowerCase();

  const result = {
    configured: adobe.isConfigured(),
    authMode: adobe.authMode(),
    tokenHostConfigured: configuredHost || null,
    shardExpected: expectedShard || null,
    webhookClientIdConfigured: Boolean(
      process.env.ADOBE_SIGN_WEBHOOK_CLIENT_ID || process.env.ADOBE_SIGN_CLIENT_ID
    ),
    webhookPath: "/api/esign/webhook/adobe-sign",
    authentication: { ok: false },
    baseUris: null,
    shardReported: null,
    shardMatch: false,
    tokenHostCorrect: false,
  };

  if (!result.configured) {
    return res.status(503).json({
      ...result,
      message:
        "Adobe Acrobat Sign is not configured in this environment. A client id and secret " +
        "alone cannot authenticate; a refresh token or integration key is required.",
    });
  }

  try {
    const token = await adobe.getAccessToken();
    result.authentication = {
      ok: true,
      // Length only - never the token itself.
      accessTokenLength: String(token?.accessToken || "").length,
      apiAccessPointFromToken: token?.apiAccessPoint || null,
    };
  } catch (error) {
    return res.status(502).json({
      ...result,
      authentication: {
        ok: false,
        // AdobeSignError messages are written to carry no token material.
        error: String(error?.message || "Authentication failed").slice(0, 300),
        status: Number(error?.status || 0) || null,
        code: String(error?.code || "") || null,
      },
      message: "Adobe authentication failed. Nothing else was attempted.",
    });
  }

  try {
    const baseUris = await adobe.getBaseUris();
    const apiAccessPoint = String(baseUris?.apiAccessPoint || "").replace(/\/+$/, "");
    const match = apiAccessPoint.match(/(?:^|\/\/|\.)([a-z]{2,4}\d{1,2})\.adobesign\.com/i);

    result.baseUris = {
      apiAccessPoint: apiAccessPoint || null,
      webAccessPoint: String(baseUris?.webAccessPoint || "").replace(/\/+$/, "") || null,
    };
    result.shardReported = match ? match[1].toLowerCase() : null;
    result.shardMatch = Boolean(
      result.shardReported && (!expectedShard || result.shardReported === expectedShard)
    );
    result.tokenHostCorrect = Boolean(apiAccessPoint) && configuredHost === apiAccessPoint;
  } catch (error) {
    return res.status(502).json({
      ...result,
      message: String(error?.message || "Base URI lookup failed").slice(0, 300),
    });
  }

  const ready = result.shardMatch && result.tokenHostCorrect;
  return res.status(ready ? 200 : 409).json({
    ...result,
    ready,
    message: ready
      ? "Adobe authentication succeeded. No agreement, document or webhook was touched."
      : "Authenticated, but the configured API host does not match the shard Adobe reports.",
  });
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
