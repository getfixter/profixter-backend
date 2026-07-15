const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const auth = require("../middleware/auth");
const { PERMISSIONS, requirePermission } = require("../middleware/authorize");
const Project = require("../models/Project");
const Contract = require("../models/Contract");
const { sendRaw } = require("../utils/emailService");
const { getObjectBuffer, putPublicObject } = require("../utils/s3");
const {
  ATTORNEY_REVIEW_NOTE,
  COMPANY_INFO,
  CONTRACT_STATUSES,
  CONTRACT_TERMS_SECTIONS,
  CONTRACT_TERMS_VERSION,
  NY_SOURCE_URLS,
  WORK_TYPES,
} = require("../config/premiumIslandHomesContract");
const {
  buildContractFilename,
  cleanString,
  fileExtension,
  sanitizeFilenamePart,
  validateContractInput,
} = require("../utils/contractValidation");
const { generateContractPdfBuffer } = require("../utils/contractPdf");
const {
  createAdminActivityLog,
  markAdminActivityLog,
} = require("../utils/adminActivityLog");

const router = express.Router();
const MAX_SIGNED_PDF_BYTES = 25 * 1024 * 1024;
const S3_PREFIX = (process.env.S3_PREFIX || "uploads").replace(/^\/+|\/+$/g, "");

const signedUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIGNED_PDF_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = fileExtension(file.originalname);
    const isPdf = ext === ".pdf" || file.mimetype === "application/pdf";
    if (!isPdf) return cb(new Error("Signed contract upload must be a PDF"));
    return cb(null, true);
  },
});

router.use(auth, ...requirePermission(PERMISSIONS.ADMIN));

function actorEmail(req) {
  const actor = req.accessUser || req.authUser || {};
  return String(actor.email || "").toLowerCase();
}

function serializeContract(contract) {
  const item = typeof contract.toObject === "function" ? contract.toObject() : contract;
  return {
    ...item,
    id: String(item._id || item.id || ""),
    _id: String(item._id || item.id || ""),
  };
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

function defaultEmailBody(contract) {
  const name = contract.customerSnapshot?.fullName || "there";
  return [
    `Hi ${name},`,
    "",
    "Attached is your Premium Island Homes contract for review.",
    "Please review the scope, payment schedule, and cancellation notice. If everything looks good, sign and return the contract so we can move forward.",
    "",
    "Thank you,",
    "Premium Island Homes Inc.",
  ].join("\n");
}

async function getProjectOr404(projectId, res) {
  if (!mongoose.isValidObjectId(projectId)) {
    res.status(400).json({ message: "Invalid project ID" });
    return null;
  }
  const project = await Project.findById(projectId).lean();
  if (!project) {
    res.status(404).json({ message: "Project not found" });
    return null;
  }
  return project;
}

async function getContractOr404(contractId, res) {
  if (!mongoose.isValidObjectId(contractId)) {
    res.status(400).json({ message: "Invalid contract ID" });
    return null;
  }
  const contract = await Contract.findById(contractId);
  if (!contract) {
    res.status(404).json({ message: "Contract not found" });
    return null;
  }
  return contract;
}

function copyContractForNewDraft(source, update, req) {
  const data = source.toObject();
  delete data._id;
  delete data.id;
  delete data.createdAt;
  delete data.updatedAt;
  delete data.generatedPdf;
  delete data.signedPdf;
  delete data.emailHistory;
  data.version = Number(source.version || 1) + 1;
  data.current = true;
  data.status = "Draft";
  data.updatedBy = req.user.id;
  data.createdBy = req.user.id;
  data.auditHistory = [];
  return new Contract({ ...data, ...update });
}

async function saveDraft({ project, body, req }) {
  const { errors, update } = validateContractInput(body, project);
  if (errors.length) {
    const error = new Error(errors[0]);
    error.status = 400;
    error.errors = errors;
    throw error;
  }
  update.status = "Draft";

  const requestedId = cleanString(body.contractId || body._id || body.id, 80);
  let contract = null;

  if (requestedId) {
    if (!mongoose.isValidObjectId(requestedId)) {
      const error = new Error("Invalid contract ID");
      error.status = 400;
      throw error;
    }
    contract = await Contract.findOne({ _id: requestedId, projectId: project._id });
    if (!contract) {
      const error = new Error("Contract not found for this project");
      error.status = 404;
      throw error;
    }
  } else {
    contract = await Contract.findOne({
      projectId: project._id,
      status: "Draft",
      current: true,
    }).sort({ updatedAt: -1 });
  }

  if (contract && contract.status !== "Draft") {
    await Contract.updateMany(
      { projectId: project._id, current: true },
      { $set: { current: false } }
    );
    const nextDraft = copyContractForNewDraft(contract, update, req);
    nextDraft.addAuditEvent("Draft created", req, {
      fromContractId: contract._id,
      fromVersion: contract.version,
    });
    return nextDraft.save();
  }

  if (contract) {
    Object.assign(contract, update);
    contract.updatedBy = req.user.id;
    contract.addAuditEvent("Draft updated", req);
    return contract.save();
  }

  const newContract = new Contract({
    projectId: project._id,
    ...update,
    createdBy: req.user.id,
    updatedBy: req.user.id,
  });
  newContract.addAuditEvent("Draft created", req);
  return newContract.save();
}

router.get("/meta", (_req, res) => {
  return res.json({
    company: COMPANY_INFO,
    workTypes: WORK_TYPES,
    statuses: CONTRACT_STATUSES,
    termsVersion: CONTRACT_TERMS_VERSION,
    termsSections: CONTRACT_TERMS_SECTIONS,
    sourceUrls: NY_SOURCE_URLS,
    attorneyReviewNote: ATTORNEY_REVIEW_NOTE,
    maxSignedPdfBytes: MAX_SIGNED_PDF_BYTES,
  });
});

router.get("/project/:projectId", async (req, res) => {
  try {
    const project = await getProjectOr404(req.params.projectId, res);
    if (!project) return null;
    const contracts = await Contract.find({ projectId: project._id })
      .sort({ current: -1, version: -1, createdAt: -1 })
      .lean();
    return res.json({ contracts: contracts.map(serializeContract) });
  } catch (error) {
    console.error("GET /admin/contracts/project/:projectId failed:", error);
    return res.status(500).json({ message: "Failed to load project contracts" });
  }
});

router.post("/project/:projectId/draft", async (req, res) => {
  try {
    const project = await getProjectOr404(req.params.projectId, res);
    if (!project) return null;
    const contract = await saveDraft({ project, body: req.body, req });
    return res.status(201).json({ contract: serializeContract(contract) });
  } catch (error) {
    console.error("POST /admin/contracts/project/:projectId/draft failed:", error);
    return res.status(error.status || 500).json({
      message: error.status ? error.message : "Failed to save contract draft",
      errors: error.errors,
    });
  }
});

router.post("/:id/generate", async (req, res) => {
  let audit = null;
  try {
    const contract = await getContractOr404(req.params.id, res);
    if (!contract) return null;
    if (contract.status !== "Draft") {
      return res.status(409).json({
        message: "Only draft contracts can generate a new PDF. Save changes as a new draft first.",
      });
    }

    audit = await createAdminActivityLog(req, {
      action: "Contract PDF Generation Started",
      entityType: "Contract",
      entityId: contract._id,
      entityName: contract.contractNumber,
      details: {
        projectId: contract.projectId,
        version: contract.version,
      },
    });

    const pdfBuffer = await generateContractPdfBuffer(contract);
    const fileName = buildContractFilename(contract);
    const key = `${S3_PREFIX}/projects/${contract.projectId}/contracts/${sanitizeFilenamePart(
      contract.contractNumber
    )}/v${contract.version}/${fileName}`;
    const url = await putPublicObject({
      Key: key,
      Body: pdfBuffer,
      ContentType: "application/pdf",
      CacheControl: "private, max-age=0, no-cache",
    });

    await Contract.updateMany(
      {
        _id: { $ne: contract._id },
        projectId: contract.projectId,
        contractNumber: contract.contractNumber,
        status: { $in: ["Generated", "Emailed"] },
      },
      {
        $set: { status: "Superseded", current: false },
        $push: {
          auditHistory: {
            event: "Superseded",
            at: new Date(),
            adminId: req.user.id,
            adminEmail: actorEmail(req),
            details: { supersededBy: contract._id, version: contract.version },
          },
        },
      }
    );

    contract.status = "Generated";
    contract.current = true;
    contract.generatedPdf = {
      key,
      url,
      fileName,
      size: pdfBuffer.length,
      generatedAt: new Date(),
      generatedBy: req.user.id,
    };
    contract.updatedBy = req.user.id;
    contract.addAuditEvent("PDF generated", req, { key, fileName, size: pdfBuffer.length });
    await contract.save();

    await markAdminActivityLog(audit, {
      action: "Contract PDF Generated",
      details: {
        contractNumber: contract.contractNumber,
        version: contract.version,
        fileName,
        size: pdfBuffer.length,
      },
    });

    return res.json({ contract: serializeContract(contract) });
  } catch (error) {
    console.error("POST /admin/contracts/:id/generate failed:", error);
    await markAdminActivityLog(audit, {
      action: "Contract PDF Generation Failed",
      details: { message: error?.message || "Unknown error" },
    });
    return res.status(500).json({ message: "Failed to generate contract PDF" });
  }
});

router.get("/:id/download", async (req, res) => {
  try {
    const contract = await getContractOr404(req.params.id, res);
    if (!contract) return null;
    const type = cleanString(req.query.type || "generated", 20);
    const pdf = type === "signed" ? contract.signedPdf : contract.generatedPdf;
    if (!pdf?.key) {
      return res.status(404).json({ message: `${type === "signed" ? "Signed" : "Generated"} PDF not found` });
    }

    const buffer = await getObjectBuffer({ Key: pdf.key });
    contract.addAuditEvent(type === "signed" ? "Signed PDF downloaded" : "PDF downloaded", req, {
      fileName: pdf.fileName,
    });
    await contract.save();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${sanitizeFilenamePart(pdf.fileName || buildContractFilename(contract))}"`
    );
    return res.send(buffer);
  } catch (error) {
    console.error("GET /admin/contracts/:id/download failed:", error);
    return res.status(500).json({ message: "Failed to download contract PDF" });
  }
});

router.post("/:id/email", async (req, res) => {
  try {
    const contract = await getContractOr404(req.params.id, res);
    if (!contract) return null;
    if (!contract.generatedPdf?.key) {
      return res.status(409).json({ message: "Generate the contract PDF before emailing it" });
    }
    const recipient = cleanString(req.body.recipient || contract.customerSnapshot?.email, 254).toLowerCase();
    const subject = cleanString(
      req.body.subject || `Your Premium Island Homes Contract - ${contract.workType}`,
      240
    );
    const message = cleanString(req.body.message || defaultEmailBody(contract), 10000);
    if (!recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
      return res.status(400).json({ message: "A valid recipient email is required" });
    }
    if (!subject) return res.status(400).json({ message: "Email subject is required" });
    if (!message) return res.status(400).json({ message: "Email message is required" });

    const pdfBuffer = await getObjectBuffer({ Key: contract.generatedPdf.key });
    const info = await sendRaw({
      to: recipient,
      subject,
      html: `<p>${htmlEscape(message).replace(/\n/g, "<br>")}</p>`,
      text: message,
      attachments: [
        {
          filename: contract.generatedPdf.fileName || buildContractFilename(contract),
          content: pdfBuffer,
          contentType: "application/pdf",
        },
      ],
      logContext: {
        templateKey: "premium_island_contract",
        source: "adminContracts",
        emailType: "transactional",
      },
    });

    contract.status = "Emailed";
    contract.emailHistory.push({
      recipient,
      subject,
      message,
      sentAt: new Date(),
      sentBy: req.user.id,
      providerResponse: safeProviderResponse(info),
    });
    contract.addAuditEvent("PDF emailed", req, { recipient, subject });
    contract.updatedBy = req.user.id;
    await contract.save();

    return res.json({ contract: serializeContract(contract) });
  } catch (error) {
    console.error("POST /admin/contracts/:id/email failed:", error);
    return res.status(500).json({
      message: error?.message ? `Failed to email contract: ${error.message}` : "Failed to email contract",
    });
  }
});

router.post("/:id/signed", signedUpload.single("file"), async (req, res) => {
  try {
    const contract = await getContractOr404(req.params.id, res);
    if (!contract) return null;
    if (!req.file) return res.status(400).json({ message: "Signed contract PDF is required" });

    const fileName = `${sanitizeFilenamePart(
      contract.contractNumber
    )}-v${contract.version}-signed.pdf`;
    const key = `${S3_PREFIX}/projects/${contract.projectId}/contracts/${sanitizeFilenamePart(
      contract.contractNumber
    )}/v${contract.version}/signed/${Date.now()}-${fileName}`;
    const url = await putPublicObject({
      Key: key,
      Body: req.file.buffer,
      ContentType: "application/pdf",
      CacheControl: "private, max-age=0, no-cache",
    });

    contract.status = "Signed";
    contract.signedPdf = {
      key,
      url,
      fileName,
      size: req.file.size,
      uploadedAt: new Date(),
      uploadedBy: req.user.id,
    };
    contract.updatedBy = req.user.id;
    contract.addAuditEvent("Signed copy uploaded", req, { fileName, size: req.file.size });
    await contract.save();

    return res.json({ contract: serializeContract(contract) });
  } catch (error) {
    console.error("POST /admin/contracts/:id/signed failed:", error);
    return res.status(500).json({ message: "Failed to upload signed contract" });
  }
});

router.post("/:id/cancel", async (req, res) => {
  try {
    const contract = await getContractOr404(req.params.id, res);
    if (!contract) return null;
    contract.status = "Canceled";
    contract.updatedBy = req.user.id;
    contract.addAuditEvent("Canceled", req, {
      reason: cleanString(req.body?.reason, 1000),
    });
    await contract.save();
    return res.json({ contract: serializeContract(contract) });
  } catch (error) {
    console.error("POST /admin/contracts/:id/cancel failed:", error);
    return res.status(500).json({ message: "Failed to cancel contract" });
  }
});

router.use((error, _req, res, next) => {
  if (!error) return next();
  if (error instanceof multer.MulterError) {
    return res.status(400).json({ message: error.message });
  }
  if (error.message === "Signed contract upload must be a PDF") {
    return res.status(400).json({ message: error.message });
  }
  return next(error);
});

module.exports = router;
