/**
 * Admin Change Order routes.
 *
 * Deliberately parallel to routes/adminContracts.js - same auth posture, same
 * private-S3 pattern, same audit conventions - so there is one way to reason
 * about ProFixter documents. Nothing here touches the Contract routes.
 */

const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");

const auth = require("../middleware/auth");
const { PERMISSIONS, requirePermission } = require("../middleware/authorize");
const Project = require("../models/Project");
const Contract = require("../models/Contract");
const ChangeOrder = require("../models/ChangeOrder");
const ESignature = require("../models/ESignature");
const { sendRaw } = require("../utils/emailService");
const { getObjectBuffer, putPrivateObject } = require("../utils/s3");
const { cleanString, fileExtension, sanitizeFilenamePart } = require("../utils/contractValidation");
const {
  CHANGE_ORDER_STATUSES,
  CHANGE_ORDER_TERMS_VERSION,
  COMPANY_INFO,
  SCHEDULE_IMPACT_TYPES,
} = require("../config/changeOrderTerms");
const {
  computeChangeOrderFigures,
  summarizeContractValue,
} = require("../utils/changeOrderTotals");
const {
  buildChangeOrderFilename,
  generateChangeOrderPdfBuffer,
} = require("../utils/changeOrderPdf");
const { createAdminActivityLog, markAdminActivityLog } = require("../utils/adminActivityLog");
const { getCompanySignatureAsset } = require("../utils/companySignature");
const { formatSigningDate } = require("../utils/esign/executedDocument");
const { resolveCompanySignedAt } = require("../utils/documentDates");

const router = express.Router();

const MAX_SIGNED_PDF_BYTES = 25 * 1024 * 1024;
const CHANGE_ORDER_S3_PREFIX = (
  process.env.CHANGE_ORDER_S3_PREFIX || "private/admin/change-orders"
).replace(/^\/+|\/+$/g, "");

/** Contract states an amendment may legitimately be written against. */
const AMENDABLE_CONTRACT_STATUSES = Object.freeze([
  "Generated",
  "Emailed",
  "Signed",
]);

const signedUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIGNED_PDF_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = fileExtension(file.originalname);
    const isPdf = ext === ".pdf" || file.mimetype === "application/pdf";
    if (!isPdf) return cb(new Error("Signed change order upload must be a PDF"));
    return cb(null, true);
  },
});

router.use(auth, ...requirePermission(PERMISSIONS.ADMIN));

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function isDeletedProject(project) {
  return project?.isDeleted === true;
}

function sanitizeAuditDetails(details) {
  if (!details || typeof details !== "object") return {};
  const sanitized = { ...details };
  delete sanitized.key;
  delete sanitized.url;
  delete sanitized.storageKey;
  delete sanitized.s3Key;
  return sanitized;
}

function safeProviderResponse(info) {
  return String(info?.response || info?.messageId || "").slice(0, 500);
}

function htmlEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function serializeSignature(signature) {
  if (!signature) return null;
  const item = typeof signature.toObject === "function" ? signature.toObject() : signature;
  return {
    id: String(item._id),
    provider: item.provider,
    status: item.status,
    providerStatus: item.providerStatus || "",
    // The provider agreement id is operational, not secret, and support needs it.
    providerAgreementId: item.providerAgreementId || "",
    signers: (item.signers || []).map((signer) => ({
      role: signer.role,
      name: signer.name || "",
      email: signer.email,
      order: signer.order,
      status: signer.status,
      viewedAt: signer.viewedAt || null,
      signedAt: signer.signedAt || null,
    })),
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
    eventCount: (item.processedEvents || []).length,
    updatedAt: item.updatedAt || null,
  };
}

function serializeChangeOrder(changeOrder, options = {}) {
  const item = typeof changeOrder.toObject === "function" ? changeOrder.toObject() : changeOrder;
  return {
    ...item,
    id: String(item._id || item.id || ""),
    _id: String(item._id || item.id || ""),
    generatedPdf: {
      available: Boolean(item.generatedPdf?.key),
      fileName: item.generatedPdf?.fileName || "",
      size: Number(item.generatedPdf?.size || 0),
      generatedAt: item.generatedPdf?.generatedAt || null,
    },
    executedPdf: {
      available: Boolean(item.executedPdf?.key),
      fileName: item.executedPdf?.fileName || "",
      size: Number(item.executedPdf?.size || 0),
      uploadedAt: item.executedPdf?.uploadedAt || null,
      source: item.executedPdf?.source || "",
    },
    signature: options.signature !== undefined ? options.signature : undefined,
    auditHistory: Array.isArray(item.auditHistory)
      ? item.auditHistory.map((event) => ({
          ...event,
          details: sanitizeAuditDetails(event.details),
        }))
      : [],
  };
}

async function getProjectOr404(projectId, res, options = {}) {
  if (!mongoose.isValidObjectId(projectId)) {
    res.status(400).json({ message: "Invalid project ID" });
    return null;
  }
  const project = await Project.findById(projectId).lean();
  if (!project) {
    res.status(404).json({ message: "Project not found" });
    return null;
  }
  if (isDeletedProject(project) && !options.allowDeleted) {
    res.status(410).json({
      message:
        "Parent project has been deleted. Change orders and history are preserved for recordkeeping.",
      isDeleted: true,
      deletedAt: project.deletedAt || null,
    });
    return null;
  }
  return project;
}

async function getChangeOrderOr404(id, res) {
  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({ message: "Invalid change order ID" });
    return null;
  }
  const changeOrder = await ChangeOrder.findById(id);
  if (!changeOrder) {
    res.status(404).json({ message: "Change order not found" });
    return null;
  }
  return changeOrder;
}

/** Executed change orders for a contract, optionally excluding one document. */
async function priorExecutedFor(contractId, excludeId = null) {
  const query = { contractId, status: "Executed" };
  if (excludeId) query._id = { $ne: excludeId };
  return ChangeOrder.find(query).select("status netAdjustmentCents").lean();
}

/**
 * Validate and normalize change lines.
 * Amounts arrive as magnitudes; direction carries the sign. A "no cost" line is
 * forced to zero rather than trusted to be zero.
 */
function normalizeLines(rawLines, errors) {
  if (!Array.isArray(rawLines) || !rawLines.length) {
    errors.push("At least one change line is required");
    return [];
  }
  if (rawLines.length > 50) {
    errors.push("A change order cannot contain more than 50 lines");
    return [];
  }

  return rawLines.map((raw, index) => {
    const description = cleanString(raw?.description, 4000);
    if (!description) errors.push(`Line ${index + 1}: description is required`);

    const direction = String(raw?.direction || "add").toLowerCase();
    if (!["add", "deduct", "none"].includes(direction)) {
      errors.push(`Line ${index + 1}: direction must be add, deduct, or none`);
    }

    let amountCents = 0;
    if (direction !== "none") {
      const value = Number(raw?.amountCents);
      if (!Number.isFinite(value) || value < 0) {
        errors.push(`Line ${index + 1}: amount must be zero or greater`);
      } else if (!Number.isInteger(value)) {
        errors.push(`Line ${index + 1}: amount must be whole cents`);
      } else if (value > 100_000_000_00) {
        errors.push(`Line ${index + 1}: amount is unreasonably large`);
      } else {
        amountCents = value;
      }
    }

    return {
      description,
      direction: ["add", "deduct", "none"].includes(direction) ? direction : "add",
      amountCents,
      order: Number.isFinite(Number(raw?.order)) ? Number(raw.order) : index,
    };
  });
}

function normalizeScheduleImpact(raw, errors) {
  const type = String(raw?.type || "none");
  if (!SCHEDULE_IMPACT_TYPES.includes(type)) {
    errors.push("Schedule impact type is not recognized");
    return { type: "none", days: 0, note: "" };
  }

  const days = Number(raw?.days || 0);
  if ((type === "add_days" || type === "reduce_days") && (!Number.isInteger(days) || days < 1)) {
    errors.push("Schedule impact in days must be a whole number of at least 1");
  }
  const note = cleanString(raw?.note, 2000);
  if (type === "custom" && !note) {
    errors.push("A custom schedule impact requires a description");
  }

  return {
    type,
    days: type === "add_days" || type === "reduce_days" ? Math.max(days, 0) : 0,
    note,
  };
}

function defaultEmailBody(changeOrder) {
  const name = changeOrder.customerSnapshot?.fullName || "there";
  return [
    `Hi ${name},`,
    "",
    `Attached is Change Order ${changeOrder.changeOrderNumber} for your project.`,
    "Please review the described changes, the price adjustment, and any schedule impact. If everything looks correct, sign and return the change order so we can proceed.",
    "",
    "Thank you,",
    "Premium Island Homes Inc.",
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* Meta                                                                */
/* ------------------------------------------------------------------ */

router.get("/meta", (_req, res) => {
  return res.json({
    company: COMPANY_INFO,
    statuses: CHANGE_ORDER_STATUSES,
    scheduleImpactTypes: SCHEDULE_IMPACT_TYPES,
    termsVersion: CHANGE_ORDER_TERMS_VERSION,
    amendableContractStatuses: AMENDABLE_CONTRACT_STATUSES,
    maxSignedPdfBytes: MAX_SIGNED_PDF_BYTES,
  });
});

/* ------------------------------------------------------------------ */
/* Read                                                                */
/* ------------------------------------------------------------------ */

/** Every change order on a project, plus the contract value roll-up. */
router.get("/project/:projectId", async (req, res) => {
  try {
    const project = await getProjectOr404(req.params.projectId, res, { allowDeleted: true });
    if (!project) return null;

    const changeOrders = await ChangeOrder.find({ projectId: project._id })
      .sort({ createdAt: -1 })
      .lean();

    const signatureIds = changeOrders.map((co) => co.signatureId).filter(Boolean);
    const signatures = signatureIds.length
      ? await ESignature.find({ _id: { $in: signatureIds } }).lean()
      : [];
    const signatureById = new Map(signatures.map((s) => [String(s._id), s]));

    // One roll-up per contract that has change orders, so the UI can show the
    // executed value and the projected value side by side.
    const contractIds = [...new Set(changeOrders.map((co) => String(co.contractId)))];
    const contracts = contractIds.length
      ? await Contract.find({ _id: { $in: contractIds } })
          .select("contractNumber version status adjustedContractPriceCents")
          .lean()
      : [];

    const summaries = contracts.map((contract) => {
      const forContract = changeOrders.filter(
        (co) => String(co.contractId) === String(contract._id)
      );
      return {
        contractId: String(contract._id),
        contractNumber: contract.contractNumber,
        contractStatus: contract.status,
        ...summarizeContractValue(contract.adjustedContractPriceCents, forContract),
      };
    });

    return res.json({
      changeOrders: changeOrders.map((co) =>
        serializeChangeOrder(co, {
          signature: serializeSignature(signatureById.get(String(co.signatureId)) || null),
        })
      ),
      contractSummaries: summaries,
      parentProjectDeletedAt: isDeletedProject(project) ? project.deletedAt || null : null,
    });
  } catch (error) {
    console.error("GET /admin/change-orders/project/:projectId failed:", error);
    return res.status(500).json({ message: "Failed to load change orders" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const changeOrder = await getChangeOrderOr404(req.params.id, res);
    if (!changeOrder) return null;
    const signature = changeOrder.signatureId
      ? await ESignature.findById(changeOrder.signatureId)
      : null;
    return res.json({
      changeOrder: serializeChangeOrder(changeOrder, {
        signature: serializeSignature(signature),
      }),
    });
  } catch (error) {
    console.error("GET /admin/change-orders/:id failed:", error);
    return res.status(500).json({ message: "Failed to load change order" });
  }
});

/* ------------------------------------------------------------------ */
/* Create / update / delete                                            */
/* ------------------------------------------------------------------ */

router.post("/contract/:contractId", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.contractId)) {
      return res.status(400).json({ message: "Invalid contract ID" });
    }
    const contract = await Contract.findById(req.params.contractId);
    if (!contract) return res.status(404).json({ message: "Contract not found" });

    const project = await getProjectOr404(contract.projectId, res);
    if (!project) return null;

    if (!AMENDABLE_CONTRACT_STATUSES.includes(contract.status)) {
      return res.status(409).json({
        message: `A change order cannot be written against a ${contract.status.toLowerCase()} contract. Generate and issue the contract first.`,
      });
    }

    const errors = [];
    const title = cleanString(req.body?.title, 240);
    if (!title) errors.push("A change order title is required");
    const lines = normalizeLines(req.body?.lines, errors);
    const scheduleImpact = normalizeScheduleImpact(req.body?.scheduleImpact, errors);
    const notes = cleanString(req.body?.notes, 8000);
    if (errors.length) return res.status(400).json({ message: errors[0], errors });

    const priorExecuted = await priorExecutedFor(contract._id);
    const figures = computeChangeOrderFigures({
      baselineCents: contract.adjustedContractPriceCents,
      priorExecuted,
      lines,
    });

    const sequence = await ChangeOrder.nextSequence(contract.contractNumber);
    const changeOrderNumber = ChangeOrder.formatNumber(contract.contractNumber, sequence);

    const changeOrder = new ChangeOrder({
      changeOrderNumber,
      sequence,
      projectId: contract.projectId,
      contractId: contract._id,
      status: "Draft",
      title,
      customerSnapshot: {
        fullName: contract.customerSnapshot?.fullName || "",
        email: contract.customerSnapshot?.email || "",
        phone: contract.customerSnapshot?.phone || "",
      },
      propertySnapshot: {
        address: contract.propertySnapshot?.address || "",
        projectNumber: contract.propertySnapshot?.projectNumber || "",
      },
      contractSnapshot: {
        contractNumber: contract.contractNumber,
        contractDate: contract.dates?.contractDate || null,
        originalContractAmountCents: figures.originalContractCents,
      },
      lines,
      previousChangeOrderAdjustmentCents: figures.previousChangeOrderAdjustmentCents,
      contractAmountBeforeChangeCents: figures.contractAmountBeforeChangeCents,
      scheduleImpact,
      notes,
      createdBy: req.user.id,
      updatedBy: req.user.id,
    });
    changeOrder.addAuditEvent("Draft created", req, {
      contractNumber: contract.contractNumber,
      priorExecutedCount: priorExecuted.length,
    });
    await changeOrder.save();

    return res.status(201).json({ changeOrder: serializeChangeOrder(changeOrder) });
  } catch (error) {
    console.error("POST /admin/change-orders/contract/:contractId failed:", error);
    return res.status(500).json({ message: "Failed to create change order" });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const changeOrder = await getChangeOrderOr404(req.params.id, res);
    if (!changeOrder) return null;
    if (!changeOrder.isEditable()) {
      return res.status(409).json({
        message: `A change order in status "${changeOrder.status}" can no longer be edited.`,
      });
    }

    const errors = [];
    const title = cleanString(req.body?.title, 240);
    if (!title) errors.push("A change order title is required");
    const lines = normalizeLines(req.body?.lines, errors);
    const scheduleImpact = normalizeScheduleImpact(req.body?.scheduleImpact, errors);
    const notes = cleanString(req.body?.notes, 8000);
    if (errors.length) return res.status(400).json({ message: errors[0], errors });

    // Re-derive the baseline: other change orders may have executed since this
    // draft was created.
    const contract = await Contract.findById(changeOrder.contractId).select(
      "adjustedContractPriceCents"
    );
    const priorExecuted = await priorExecutedFor(changeOrder.contractId, changeOrder._id);
    const figures = computeChangeOrderFigures({
      baselineCents: contract?.adjustedContractPriceCents || 0,
      priorExecuted,
      lines,
    });

    changeOrder.title = title;
    changeOrder.lines = lines;
    changeOrder.scheduleImpact = scheduleImpact;
    changeOrder.notes = notes;
    changeOrder.previousChangeOrderAdjustmentCents = figures.previousChangeOrderAdjustmentCents;
    changeOrder.contractAmountBeforeChangeCents = figures.contractAmountBeforeChangeCents;
    changeOrder.updatedBy = req.user.id;
    changeOrder.addAuditEvent("Draft updated", req);
    await changeOrder.save();

    return res.json({ changeOrder: serializeChangeOrder(changeOrder) });
  } catch (error) {
    console.error("PUT /admin/change-orders/:id failed:", error);
    return res.status(500).json({ message: "Failed to update change order" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const changeOrder = await getChangeOrderOr404(req.params.id, res);
    if (!changeOrder) return null;
    if (changeOrder.status !== "Draft") {
      return res.status(409).json({
        message: "Only a draft change order can be deleted. Void it instead to keep the record.",
      });
    }
    // The sequence number is deliberately not reclaimed: a gap in numbering is
    // preferable to two documents that ever shared a number.
    await changeOrder.deleteOne();
    return res.json({ deleted: true, id: String(changeOrder._id) });
  } catch (error) {
    console.error("DELETE /admin/change-orders/:id failed:", error);
    return res.status(500).json({ message: "Failed to delete change order" });
  }
});

/* ------------------------------------------------------------------ */
/* Generate                                                            */
/* ------------------------------------------------------------------ */

router.post("/:id/generate", async (req, res) => {
  let audit = null;
  try {
    const changeOrder = await getChangeOrderOr404(req.params.id, res);
    if (!changeOrder) return null;
    if (changeOrder.status !== "Draft" && changeOrder.status !== "Ready to Send") {
      return res.status(409).json({
        message: `A change order in status "${changeOrder.status}" cannot be regenerated.`,
      });
    }

    const contract = await Contract.findById(changeOrder.contractId).select(
      "adjustedContractPriceCents contractNumber"
    );
    if (!contract) return res.status(404).json({ message: "Parent contract not found" });

    // Freeze the figures at issue time against the current executed set.
    const priorExecuted = await priorExecutedFor(changeOrder.contractId, changeOrder._id);
    const figures = computeChangeOrderFigures({
      baselineCents: contract.adjustedContractPriceCents,
      priorExecuted,
      lines: changeOrder.lines,
    });
    changeOrder.contractSnapshot.originalContractAmountCents = figures.originalContractCents;
    changeOrder.previousChangeOrderAdjustmentCents = figures.previousChangeOrderAdjustmentCents;
    changeOrder.contractAmountBeforeChangeCents = figures.contractAmountBeforeChangeCents;

    audit = await createAdminActivityLog(req, {
      action: "Change Order PDF Generation Started",
      entityType: "ChangeOrder",
      entityId: changeOrder._id,
      entityName: changeOrder.changeOrderNumber,
      details: { projectId: changeOrder.projectId, contractId: changeOrder.contractId },
    });

    // Countersigned before the customer sees it, exactly as an Agreement is -
    // the generated PDF and the frozen copy sent for signature must be the same
    // document. The execution date is stamped once and reused, never re-read
    // from the clock at render time.
    const companySignature = await getCompanySignatureAsset();
    const companySignatureImage = companySignature?.buffer || null;
    const companySignedAt = resolveCompanySignedAt(changeOrder, Boolean(companySignatureImage));

    const pdfBuffer = await generateChangeOrderPdfBuffer(changeOrder, {
      companySignatureImage,
      companySignatureInkBox: companySignature?.inkBox || null,
      companySignedDate: companySignedAt ? formatSigningDate(companySignedAt) : "",
    });
    const fileName = buildChangeOrderFilename(changeOrder);
    const key = `${CHANGE_ORDER_S3_PREFIX}/projects/${changeOrder.projectId}/contracts/${sanitizeFilenamePart(
      changeOrder.contractSnapshot.contractNumber || "contract"
    )}/${sanitizeFilenamePart(changeOrder.changeOrderNumber)}/${fileName}`;

    await putPrivateObject({
      Key: key,
      Body: pdfBuffer,
      ContentType: "application/pdf",
      CacheControl: "private, max-age=0, no-cache",
      ContentDisposition: `attachment; filename="${fileName.replace(/"/g, "")}"`,
    });

    changeOrder.generatedPdf = {
      key,
      url: "",
      fileName,
      size: pdfBuffer.length,
      generatedAt: new Date(),
      generatedBy: req.user.id,
    };
    changeOrder.status = "Ready to Send";
    changeOrder.updatedBy = req.user.id;
    changeOrder.addAuditEvent("PDF generated", req, { fileName, size: pdfBuffer.length });
    await changeOrder.save();

    await markAdminActivityLog(audit, {
      action: "Change Order PDF Generated",
      details: {
        changeOrderNumber: changeOrder.changeOrderNumber,
        fileName,
        size: pdfBuffer.length,
      },
    });

    return res.json({ changeOrder: serializeChangeOrder(changeOrder) });
  } catch (error) {
    console.error("POST /admin/change-orders/:id/generate failed:", error);
    await markAdminActivityLog(audit, {
      action: "Change Order PDF Generation Failed",
      details: { message: error?.message || "Unknown error" },
    });
    return res.status(500).json({ message: "Failed to generate change order PDF" });
  }
});

/* ------------------------------------------------------------------ */
/* Download                                                            */
/* ------------------------------------------------------------------ */

/**
 * Stream a stored PDF through this authenticated route.
 * `type` is generated | executed. Nothing is ever exposed by public URL.
 */
router.get("/:id/download", async (req, res) => {
  try {
    const changeOrder = await getChangeOrderOr404(req.params.id, res);
    if (!changeOrder) return null;

    const type = cleanString(req.query.type || "generated", 20);
    const pdf = type === "executed" ? changeOrder.executedPdf : changeOrder.generatedPdf;
    if (!pdf?.key) {
      return res
        .status(404)
        .json({ message: `${type === "executed" ? "Executed" : "Generated"} PDF not found` });
    }

    const buffer = await getObjectBuffer({ Key: pdf.key });
    changeOrder.addAuditEvent(
      type === "executed" ? "Executed PDF downloaded" : "PDF downloaded",
      req,
      { fileName: pdf.fileName }
    );
    await changeOrder.save();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `${req.query.disposition === "inline" ? "inline" : "attachment"}; filename="${sanitizeFilenamePart(
        pdf.fileName || buildChangeOrderFilename(changeOrder)
      )}"`
    );
    return res.send(buffer);
  } catch (error) {
    console.error("GET /admin/change-orders/:id/download failed:", error);
    return res.status(500).json({ message: "Failed to download change order PDF" });
  }
});

/* ------------------------------------------------------------------ */
/* Email                                                               */
/* ------------------------------------------------------------------ */

router.post("/:id/email", async (req, res) => {
  try {
    const changeOrder = await getChangeOrderOr404(req.params.id, res);
    if (!changeOrder) return null;
    if (!changeOrder.generatedPdf?.key) {
      return res.status(409).json({ message: "Generate the change order PDF before emailing it" });
    }
    if (changeOrder.isLocked()) {
      return res
        .status(409)
        .json({ message: `A ${changeOrder.status.toLowerCase()} change order cannot be re-issued.` });
    }

    const recipient = cleanString(
      req.body?.recipient || changeOrder.customerSnapshot?.email,
      254
    ).toLowerCase();
    const subject = cleanString(
      req.body?.subject || `Change Order ${changeOrder.changeOrderNumber} - Premium Island Homes`,
      240
    );
    const message = cleanString(req.body?.message || defaultEmailBody(changeOrder), 10000);

    if (!recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
      return res.status(400).json({ message: "A valid recipient email is required" });
    }
    if (!subject) return res.status(400).json({ message: "Email subject is required" });
    if (!message) return res.status(400).json({ message: "Email message is required" });

    const pdfBuffer = await getObjectBuffer({ Key: changeOrder.generatedPdf.key });
    const info = await sendRaw({
      to: recipient,
      subject,
      html: `<p>${htmlEscape(message).replace(/\n/g, "<br>")}</p>`,
      text: message,
      attachments: [
        {
          filename: changeOrder.generatedPdf.fileName || buildChangeOrderFilename(changeOrder),
          content: pdfBuffer,
          contentType: "application/pdf",
        },
      ],
      logContext: {
        templateKey: "premium_island_change_order",
        source: "adminChangeOrders",
        emailType: "transactional",
      },
    });

    // Only advance the status if a signature flow has not already moved it on.
    if (changeOrder.status === "Ready to Send") changeOrder.status = "Sent";
    changeOrder.sentAt = changeOrder.sentAt || new Date();
    changeOrder.emailHistory.push({
      recipient,
      subject,
      message,
      sentAt: new Date(),
      sentBy: req.user.id,
      providerResponse: safeProviderResponse(info),
    });
    changeOrder.addAuditEvent("PDF emailed", req, { recipient, subject });
    changeOrder.updatedBy = req.user.id;
    await changeOrder.save();

    return res.json({ changeOrder: serializeChangeOrder(changeOrder) });
  } catch (error) {
    console.error("POST /admin/change-orders/:id/email failed:", error);
    return res.status(500).json({
      message: error?.message
        ? `Failed to email change order: ${error.message}`
        : "Failed to email change order",
    });
  }
});

/* ------------------------------------------------------------------ */
/* Executed copy (wet signature path)                                  */
/* ------------------------------------------------------------------ */

/**
 * Upload a countersigned PDF for change orders signed on paper.
 * This is a record of a real signature that happened off-platform; it is not a
 * substitute for the e-signature flow and is labelled as such.
 */
router.post("/:id/executed", signedUpload.single("file"), async (req, res) => {
  try {
    const changeOrder = await getChangeOrderOr404(req.params.id, res);
    if (!changeOrder) return null;
    if (!req.file) return res.status(400).json({ message: "Signed change order PDF is required" });
    if (changeOrder.status === "Executed") {
      return res.status(409).json({ message: "This change order is already executed" });
    }
    if (changeOrder.status === "Voided" || changeOrder.status === "Declined") {
      return res
        .status(409)
        .json({ message: `A ${changeOrder.status.toLowerCase()} change order cannot be executed.` });
    }
    if (!changeOrder.generatedPdf?.key) {
      return res.status(409).json({ message: "Generate the change order PDF first" });
    }

    const fileName = `${sanitizeFilenamePart(changeOrder.changeOrderNumber)}-executed.pdf`;
    const key = `${CHANGE_ORDER_S3_PREFIX}/projects/${changeOrder.projectId}/contracts/${sanitizeFilenamePart(
      changeOrder.contractSnapshot.contractNumber || "contract"
    )}/${sanitizeFilenamePart(changeOrder.changeOrderNumber)}/executed/${Date.now()}-${fileName}`;

    await putPrivateObject({
      Key: key,
      Body: req.file.buffer,
      ContentType: "application/pdf",
      CacheControl: "private, max-age=0, no-cache",
      ContentDisposition: `attachment; filename="${fileName.replace(/"/g, "")}"`,
    });

    changeOrder.executedPdf = {
      key,
      url: "",
      fileName,
      size: req.file.size,
      uploadedAt: new Date(),
      uploadedBy: req.user.id,
      source: "manual_upload",
    };
    changeOrder.status = "Executed";
    changeOrder.executedAt = new Date();
    changeOrder.updatedBy = req.user.id;
    changeOrder.addAuditEvent("Executed copy uploaded", req, {
      fileName,
      size: req.file.size,
      source: "manual_upload",
    });
    await changeOrder.save();

    return res.json({ changeOrder: serializeChangeOrder(changeOrder) });
  } catch (error) {
    console.error("POST /admin/change-orders/:id/executed failed:", error);
    return res.status(500).json({ message: "Failed to upload executed change order" });
  }
});

/* ------------------------------------------------------------------ */
/* Void                                                                */
/* ------------------------------------------------------------------ */

router.post("/:id/void", async (req, res) => {
  try {
    const changeOrder = await getChangeOrderOr404(req.params.id, res);
    if (!changeOrder) return null;
    if (changeOrder.status === "Executed") {
      return res.status(409).json({
        message:
          "An executed change order cannot be voided. Issue a new change order that reverses it.",
      });
    }
    if (changeOrder.status === "Voided") {
      return res.json({ changeOrder: serializeChangeOrder(changeOrder) });
    }

    changeOrder.status = "Voided";
    changeOrder.voidedAt = new Date();
    changeOrder.updatedBy = req.user.id;
    changeOrder.addAuditEvent("Voided", req, { reason: cleanString(req.body?.reason, 1000) });
    await changeOrder.save();

    return res.json({ changeOrder: serializeChangeOrder(changeOrder) });
  } catch (error) {
    console.error("POST /admin/change-orders/:id/void failed:", error);
    return res.status(500).json({ message: "Failed to void change order" });
  }
});

router.use((error, _req, res, next) => {
  if (!error) return next();
  if (error instanceof multer.MulterError) {
    return res.status(400).json({ message: error.message });
  }
  if (error.message === "Signed change order upload must be a PDF") {
    return res.status(400).json({ message: error.message });
  }
  return next(error);
});

module.exports = router;
module.exports.normalizeLines = normalizeLines;
module.exports.normalizeScheduleImpact = normalizeScheduleImpact;
module.exports.AMENDABLE_CONTRACT_STATUSES = AMENDABLE_CONTRACT_STATUSES;
