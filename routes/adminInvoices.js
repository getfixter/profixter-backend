const express = require("express");
const mongoose = require("mongoose");
const auth = require("../middleware/auth");
const { PERMISSIONS, requirePermission } = require("../middleware/authorize");
const Project = require("../models/Project");
const Contract = require("../models/Contract");
const Invoice = require("../models/Invoice");
const { sendRaw } = require("../utils/emailService");
const { getObjectBuffer, putPrivateObject } = require("../utils/s3");
const {
  buildInvoiceFilename,
  calculateInvoiceFinancials,
  cleanString,
  dueDateForTerm,
  formatMoney,
  invoiceDisplayLabel,
  normalizePaymentInput,
  projectSnapshots,
  sanitizeFilenamePart,
  todayDateOnly,
  validateInvoiceDraftInput,
} = require("../utils/invoiceValidation");
const { generateInvoicePdfBuffer } = require("../utils/invoicePdf");
const { freezeInvoiceSnapshot } = require("../utils/projectFinancials");
const {
  buildBillingWarnings,
  getInvoiceFinancialContext,
  invoiceIsIssued,
} = require("../utils/projectFinancialsService");
const { formatSignedCents } = require("../utils/changeOrderTotals");
const {
  autoIssueDate,
  invoiceIsIssued: invoiceHasBeenIssued,
} = require("../utils/documentDates");
const {
  createAdminActivityLog,
  markAdminActivityLog,
} = require("../utils/adminActivityLog");

const router = express.Router();
const INVOICE_S3_PREFIX = (
  process.env.INVOICE_S3_PREFIX || "private/admin/invoices"
).replace(/^\/+|\/+$/g, "");

router.use(auth, ...requirePermission(PERMISSIONS.ADMIN));

function actorEmail(req) {
  const actor = req.accessUser || req.authUser || {};
  return String(actor.email || "").toLowerCase();
}

function isDeletedProject(project) {
  return project?.isDeleted === true;
}

function sendDeletedProjectResponse(res, project) {
  return res.status(410).json({
    message: "Parent project has been deleted. Invoices, PDFs, and history are preserved for recordkeeping.",
    isDeleted: true,
    deletedAt: project.deletedAt || null,
  });
}

function deletedProjectNotice(project) {
  if (!isDeletedProject(project)) return null;
  return `Parent project deleted on ${project.deletedAt ? new Date(project.deletedAt).toISOString() : "unknown date"}`;
}

function objectIdOrNull(value) {
  return mongoose.isValidObjectId(value) ? value : null;
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
    sendDeletedProjectResponse(res, project);
    return null;
  }
  return project;
}

function projectIdFromRequest(req) {
  return cleanString(req.body?.projectId || req.query?.projectId, 80);
}

async function getInvoiceForProjectOr404(invoiceId, req, res, options = {}) {
  const projectId = projectIdFromRequest(req);
  if (!mongoose.isValidObjectId(invoiceId)) {
    res.status(400).json({ message: "Invalid invoice ID" });
    return null;
  }
  const project = await getProjectOr404(projectId, res, {
    allowDeleted: options.allowDeleted === true,
  });
  if (!project) return null;
  const invoice = await Invoice.findOne({ _id: invoiceId, projectId });
  if (!invoice) {
    res.status(404).json({ message: "Invoice not found for this project" });
    return null;
  }
  invoice.$locals.parentProject = project;
  return invoice;
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

function serializePdfRecord(pdf) {
  return {
    available: !!pdf?.key,
    version: Number(pdf?.version || 0),
    fileName: pdf?.fileName || "",
    size: Number(pdf?.size || 0),
    generatedAt: pdf?.generatedAt || null,
    generatedBy: pdf?.generatedBy || null,
    status: pdf?.status || "",
  };
}

function currentPdfRecord(invoice) {
  const pdfs = [...(invoice.generatedPdfs || [])];
  const current = pdfs
    .filter((pdf) => pdf.status === "Current")
    .sort((a, b) => Number(b.version || 0) - Number(a.version || 0))[0];
  if (current) return current;
  return pdfs
    .filter((pdf) => pdf.status === "Voided")
    .sort((a, b) => Number(b.version || 0) - Number(a.version || 0))[0] || null;
}

function serializeInvoice(invoice, options = {}) {
  const item = typeof invoice.toObject === "function" ? invoice.toObject() : invoice;
  const parentProject = options.parentProject || null;
  const currentPdf = currentPdfRecord(item);
  return {
    ...item,
    id: String(item._id || item.id || ""),
    _id: String(item._id || item.id || ""),
    parentProjectDeletedAt: isDeletedProject(parentProject) ? parentProject.deletedAt || null : null,
    parentProjectDeletedMessage: deletedProjectNotice(parentProject),
    currentPdf: currentPdf ? serializePdfRecord(currentPdf) : { available: false },
    generatedPdfs: Array.isArray(item.generatedPdfs)
      ? item.generatedPdfs.map(serializePdfRecord)
      : [],
    eventHistory: Array.isArray(item.eventHistory)
      ? item.eventHistory.map((event) => ({
          ...event,
          details: sanitizeAuditDetails(event.details),
        }))
      : [],
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

function defaultPaymentInstructions() {
  return cleanString(
    process.env.INVOICE_PAYMENT_INSTRUCTIONS ||
      "Checks payable to Premium Island Homes Inc.\nContact 631-599-1363 for payment arrangements.",
    2000
  );
}

function customerFirstName(invoice) {
  return cleanString(invoice.customerSnapshot?.fullName, 160).split(/\s+/).filter(Boolean)[0] || "there";
}

function defaultEmailSubject(invoice) {
  return `Premium Island Homes ${invoiceDisplayLabel(invoice)}`;
}

function defaultEmailBody(invoice) {
  const paid = invoice.status === "Paid in Full" ||
    (Number(invoice.invoiceTotalCents || 0) > 0 && Number(invoice.remainingBalanceCents || 0) === 0);
  const amountLine = paid
    ? "This invoice is paid in full. Thank you for your payment."
    : `Amount due: ${formatMoney(invoice.remainingBalanceCents)}`;
  return [
    `Hi ${customerFirstName(invoice)},`,
    "",
    `Attached is ${invoiceDisplayLabel(invoice)} for the project at ${invoice.propertySnapshot?.formattedAddress || invoice.propertySnapshot?.address || "your property"}.`,
    "",
    amountLine,
    "",
    "Please contact us if you have any questions.",
    "",
    "Thank you,",
    "Taras Bandura",
    "Premium Island Homes Inc.",
    "631-599-1363",
  ].join("\n");
}

function contentSignature(invoiceLike) {
  return JSON.stringify({
    customerSnapshot: invoiceLike.customerSnapshot,
    propertySnapshot: invoiceLike.propertySnapshot,
    projectSnapshot: invoiceLike.projectSnapshot,
    contractSnapshot: invoiceLike.contractSnapshot,
    lineItems: invoiceLike.lineItems,
    discounts: invoiceLike.discounts,
    taxTreatment: invoiceLike.taxTreatment,
    taxRateBasisPoints: invoiceLike.taxRateBasisPoints,
    dates: invoiceLike.dates,
    publicNote: invoiceLike.publicNote,
    paymentInstructions: invoiceLike.paymentInstructions,
    payments: invoiceLike.payments,
    // A change order executing behind a drafted invoice changes what its PDF
    // should say, so it has to count as a content change.
    projectFinancials: snapshotSignature(invoiceLike.projectFinancialSnapshot),
  });
}

function contractWorkType(contract) {
  return contract?.workType === "Other"
    ? contract.otherWorkType || "Other"
    : contract?.workType || "Project";
}

/** How much of the project this import is meant to bill. */
const BILLING_MODES = Object.freeze(["full", "amount", "remaining", "changeOrders"]);

function normalizeBilling(body) {
  const raw = body?.billing && typeof body.billing === "object" ? body.billing : {};
  const mode = BILLING_MODES.includes(cleanString(raw.mode, 40)) ? cleanString(raw.mode, 40) : "full";
  return {
    mode,
    amountCents: Math.max(Math.round(Number(raw.amountCents || 0)), 0),
    label: cleanString(raw.label, 240),
    changeOrderIds: (Array.isArray(raw.changeOrderIds) ? raw.changeOrderIds : [])
      .map((id) => cleanString(id, 80))
      .filter(Boolean)
      .slice(0, 100),
  };
}

function changeOrderDescription(changeOrder) {
  const title = cleanString(changeOrder.title, 240);
  return title ? `${changeOrder.changeOrderNumber} - ${title}` : String(changeOrder.changeOrderNumber || "Change order");
}

/**
 * Turn executed change orders into invoice rows.
 *
 * An addition is billable work, so it becomes a line item. A deduction is
 * money coming off the agreement, and invoice line items cannot be negative -
 * so it becomes a credit, which is what a deduction actually is. A no-cost
 * change order moves no money and is deliberately not billed at all.
 */
function changeOrderBillingRows(changeOrders) {
  const lineItems = [];
  const discounts = [];
  changeOrders.forEach((changeOrder) => {
    const net = Number(changeOrder.netAdjustmentCents || 0);
    if (net > 0) {
      lineItems.push({
        description: changeOrderDescription(changeOrder),
        quantity: 1,
        unitPriceCents: net,
        category: "Change order",
      });
    } else if (net < 0) {
      discounts.push({
        name: changeOrderDescription(changeOrder),
        type: "credit",
        valueCents: Math.abs(net),
        note: "Executed change order deduction",
      });
    }
  });
  return { lineItems, discounts };
}

/**
 * Contract discounts, converted to fixed amounts.
 *
 * The contract already worked out what each discount is worth against the
 * contract price. Carrying a percentage across would re-apply it to the
 * invoice subtotal instead - which changes the moment a change order line or
 * an admin edit moves that subtotal, silently altering an agreed discount.
 * The percentage stays visible in the label; only the maths is frozen.
 */
function contractDiscountRows(contract) {
  return (contract.discounts || []).map((discount) => {
    const percent = discount.type === "percentage" ? Number(discount.value || 0) / 100 : 0;
    const label = percent
      ? `${discount.name} (${percent.toFixed(3).replace(/0+$/g, "").replace(/\.$/, "")}%)`
      : discount.name;
    return {
      name: label,
      type: "fixed",
      valueCents: Number(discount.calculatedAmountCents || 0),
      note: discount.note,
    };
  });
}

function draftBodyFromContract(project, contract, { billing, context, executedChangeOrders }) {
  const defaults = projectSnapshots(project);
  const originalCents = Number(contract.originalContractPriceCents ?? contract.totalPriceCents ?? 0);
  const finalCents = Number(contract.adjustedContractPriceCents ?? originalCents);
  const contractNumber = cleanString(contract.contractNumber, 80);
  const { lineItems, discounts, note } = billingRowsForMode({
    billing,
    context,
    contract,
    contractNumber,
    originalCents,
    executedChangeOrders,
  });
  return {
    source: "contract",
    contractId: contract._id,
    contractSnapshot: {
      contractId: cleanString(contract._id, 80),
      contractNumber,
      finalContractPriceCents: finalCents,
      importedAt: new Date(),
    },
    customerSnapshot: {
      ...defaults.customerSnapshot,
      fullName: contract.customerSnapshot?.fullName || defaults.customerSnapshot.fullName,
      email: contract.customerSnapshot?.email || defaults.customerSnapshot.email,
      phone: contract.customerSnapshot?.phone || defaults.customerSnapshot.phone,
      customerId: contract.customerSnapshot?.customerId || defaults.customerSnapshot.customerId,
    },
    propertySnapshot: {
      ...defaults.propertySnapshot,
      address: contract.propertySnapshot?.address || defaults.propertySnapshot.address,
      formattedAddress: contract.propertySnapshot?.address || defaults.propertySnapshot.formattedAddress,
    },
    projectSnapshot: {
      ...defaults.projectSnapshot,
      workType: contractWorkType(contract),
      projectDescription: contract.projectDescription || defaults.projectSnapshot.projectDescription,
    },
    lineItems,
    discounts,
    taxTreatment: "Not Determined",
    dueTerm: "due_on_receipt",
    dates: {
      invoiceDate: todayDateOnly(),
      dueDate: todayDateOnly(),
      serviceDate: contract.dates?.estimatedCompletionDate || null,
    },
    publicNote: "Thank you for your business.",
    internalNote: [
      `Created from ${invoiceContractLabel(contractNumber)}. ${note}`,
      `Approved Agreement value at import: ${formatMoney(context.approvedAgreementCents)}` +
        (context.executedChangeOrders.length
          ? ` (Agreement ${formatMoney(context.originalAgreementCents)} ${formatSignedCents(context.executedChangeOrderCents)} from ${context.executedChangeOrders.length} executed change order${context.executedChangeOrders.length === 1 ? "" : "s"}).`
          : "."),
      `Previously invoiced on this project: ${formatMoney(context.previouslyInvoicedCents)}. Previously paid: ${formatMoney(context.previouslyPaidCents)}.`,
      "Agreement was not modified. Agreement deposit or payment-schedule requirements were not imported as received payments.",
    ].join("\n"),
    paymentInstructions: defaultPaymentInstructions(),
    payments: [],
  };
}

/**
 * The rows for one billing intent.
 *
 * Every mode produces an amount the Admin can still edit. None of them decides
 * what is due: they only save retyping the figures the project already knows.
 */
function billingRowsForMode({ billing, context, contract, contractNumber, originalCents, executedChangeOrders }) {
  const agreementLabel = contractNumber ? ` (${invoiceContractLabel(contractNumber)})` : "";

  if (billing.mode === "amount" || billing.mode === "remaining") {
    const isRemaining = billing.mode === "remaining";
    const amountCents = isRemaining
      ? Number(context.uninvoicedApprovedCents || 0)
      : billing.amountCents;
    const description =
      billing.label ||
      (isRemaining ? `Final balance${agreementLabel}` : `Progress payment${agreementLabel}`);
    return {
      lineItems: [
        {
          description,
          quantity: 1,
          unitPriceCents: Math.max(amountCents, 0),
          category: "Contract work",
        },
      ],
      discounts: [],
      note: isRemaining
        ? "Imported as the approved value not yet invoiced."
        : "Imported as a partial billing amount.",
    };
  }

  if (billing.mode === "changeOrders") {
    const selected = billing.changeOrderIds.length
      ? executedChangeOrders.filter((co) => billing.changeOrderIds.includes(String(co._id)))
      : executedChangeOrders;
    const rows = changeOrderBillingRows(selected);
    return {
      lineItems: rows.lineItems,
      discounts: rows.discounts,
      note: `Imported as change order billing only (${selected.length} executed change order${selected.length === 1 ? "" : "s"}).`,
    };
  }

  // "full": the agreement price plus everything executed against it.
  const rows = changeOrderBillingRows(executedChangeOrders);
  return {
    lineItems: [
      {
        description: `${contractWorkType(contract)} contract work${agreementLabel}`,
        quantity: 1,
        unitPriceCents: originalCents,
        category: "Contract work",
      },
      ...rows.lineItems,
    ],
    discounts: [...contractDiscountRows(contract), ...rows.discounts],
    note: "Imported at the full approved Agreement value including executed change orders.",
  };
}

function invoiceContractLabel(contractNumber) {
  return `Contract #${cleanString(contractNumber, 80)}`;
}

async function loadContractForInvoice(projectId, body, res) {
  const requestedContractId = cleanString(body.contractId || body.contractSnapshot?.contractId, 80);
  const query = { projectId };
  if (requestedContractId) {
    if (!mongoose.isValidObjectId(requestedContractId)) {
      res.status(400).json({ message: "Invalid contract ID" });
      return null;
    }
    query._id = requestedContractId;
  } else {
    query.current = true;
    query.status = { $in: ["Generated", "Emailed", "Signed"] };
  }
  const contract = await Contract.findOne(query).sort({ current: -1, version: -1, updatedAt: -1 });
  if (!contract) {
    res.status(404).json({ message: "Generated project contract not found" });
    return null;
  }
  return contract;
}

/**
 * Guard against importing the same agreement twice at full value.
 *
 * Only "full" imports are blocked. Progress, milestone and change-order
 * billing all legitimately produce several invoices against one agreement, and
 * refusing them would make partial billing impossible.
 */
async function assertNoActiveContractImport(projectId, contractId, res) {
  const existing = await Invoice.findOne({
    projectId,
    contractId,
    isArchived: { $ne: true },
    status: { $ne: "Voided" },
  }).lean();
  if (!existing) return false;
  res.status(409).json({
    message: "An active invoice already exists for this agreement. Bill a partial amount or the remaining balance instead of importing the full agreement again.",
    invoice: serializeInvoice(existing),
  });
  return true;
}

/**
 * Stamp the project's financial position onto an invoice.
 *
 * Refreshed freely while the invoice is a draft, because a draft should tell
 * the truth about today. Frozen the moment it is issued: from then on the
 * invoice keeps reporting the figures it was actually sent against, no matter
 * what change orders execute afterwards. This is the whole of the historical
 * immutability guarantee, in one place.
 *
 * @returns {object|null} the live context, or null if the invoice is frozen.
 */
async function refreshFinancialSnapshot(invoice, { contract = null } = {}) {
  if (invoiceIsIssued(invoice)) return null;
  const { agreement, changeOrders, context } = await getInvoiceFinancialContext(invoice.projectId, {
    contract,
    excludeInvoiceId: invoice._id,
  });
  if (!agreement) return null;
  invoice.projectFinancialSnapshot = freezeInvoiceSnapshot(context, changeOrders);
  return { agreement, changeOrders, context };
}

/**
 * The parts of a snapshot that change what the PDF says.
 *
 * `capturedAt` is deliberately excluded: it moves on every refresh, and
 * including it would mark a draft as needing regeneration merely for having
 * been re-saved.
 */
function snapshotSignature(snapshot) {
  if (!snapshot) return "";
  return JSON.stringify({
    approvedAgreementCents: snapshot.approvedAgreementCents,
    originalAgreementCents: snapshot.originalAgreementCents,
    executedChangeOrderCents: snapshot.executedChangeOrderCents,
    previouslyInvoicedCents: snapshot.previouslyInvoicedCents,
    executedChangeOrders: (snapshot.executedChangeOrders || []).map((entry) => [
      entry.changeOrderNumber,
      entry.netAdjustmentCents,
    ]),
  });
}

function handleWriteError(error, res, fallbackMessage) {
  console.error(fallbackMessage, error);
  if (error?.name === "ValidationError") {
    const message = Object.values(error.errors || {})[0]?.message || error.message;
    return res.status(400).json({ message });
  }
  if (error?.code === 11000) {
    return res.status(409).json({ message: "Invoice number already exists" });
  }
  return res.status(500).json({ message: fallbackMessage });
}

router.get("/project/:projectId", async (req, res) => {
  try {
    const project = await getProjectOr404(req.params.projectId, res, { allowDeleted: true });
    if (!project) return null;
    const invoices = await Invoice.find({ projectId: project._id, isArchived: { $ne: true } })
      .sort({ createdAt: -1 })
      .lean();
    return res.json({
      invoices: invoices.map((invoice) => serializeInvoice(invoice, { parentProject: project })),
      parentProjectDeletedAt: isDeletedProject(project) ? project.deletedAt || null : null,
      parentProjectDeletedMessage: deletedProjectNotice(project),
    });
  } catch (error) {
    console.error("GET /admin/invoices/project/:projectId failed:", error);
    return res.status(500).json({ message: "Failed to load project invoices" });
  }
});

router.post("/project/:projectId/draft", async (req, res) => {
  try {
    const project = await getProjectOr404(req.params.projectId, res);
    if (!project) return null;

    let body = req.body && typeof req.body === "object" ? req.body : {};
    const requestedId = cleanString(body.invoiceId || body._id || body.id, 80);
    const createFromContract = body.createFromContract === true || body.source === "contract";
    let importContract = null;
    if (createFromContract && !requestedId) {
      const contract = await loadContractForInvoice(project._id, body, res);
      if (!contract) return null;
      const billing = normalizeBilling(body);
      if (billing.mode === "full" && (await assertNoActiveContractImport(project._id, contract._id, res))) {
        return null;
      }

      // The whole point of the import: the draft is built against the agreement
      // PLUS its executed change orders, not the agreement price alone.
      const { context, changeOrders } = await getInvoiceFinancialContext(project._id, { contract });
      const executed = changeOrders.filter((co) => String(co.status) === "Executed");
      if (billing.mode === "amount" && billing.amountCents <= 0) {
        return res.status(400).json({ message: "Enter the amount to invoice" });
      }
      if (billing.mode === "remaining" && Number(context.uninvoicedApprovedCents || 0) <= 0) {
        return res.status(409).json({
          message: "The approved Agreement value has already been fully invoiced. Nothing remains to bill.",
        });
      }
      if (billing.mode === "changeOrders" && !executed.length) {
        return res.status(409).json({
          message: "This agreement has no executed change orders to bill.",
        });
      }

      importContract = contract;
      body = draftBodyFromContract(project, contract, {
        billing,
        context,
        executedChangeOrders: executed,
      });
      if (!body.lineItems.length) {
        return res.status(409).json({
          message: "The selected change orders are all deductions or no-cost, so there is nothing to bill on their own.",
        });
      }
    }

    let invoice = null;
    if (requestedId) {
      if (!mongoose.isValidObjectId(requestedId)) {
        return res.status(400).json({ message: "Invalid invoice ID" });
      }
      invoice = await Invoice.findOne({ _id: requestedId, projectId: project._id });
      if (!invoice) return res.status(404).json({ message: "Invoice not found for this project" });
      if (invoice.status === "Voided") {
        return res.status(409).json({ message: "Voided invoices cannot be edited" });
      }
    }

    const previousSignature = invoice ? contentSignature(invoice.toObject()) : "";
    const { errors, update } = validateInvoiceDraftInput(body, project, invoice);
    if (errors.length) return res.status(400).json({ message: errors[0], errors });
    update.customerId = objectIdOrNull(update.customerId);
    update.contractId = objectIdOrNull(update.contractId);

    let live = null;
    if (!invoice) {
      invoice = new Invoice({
        projectId: project._id,
        ...update,
        createdBy: req.user.id,
        updatedBy: req.user.id,
      });
      live = await refreshFinancialSnapshot(invoice, { contract: importContract });
      invoice.addEvent("Invoice created", req, {
        source: update.source,
        approvedAgreementCents: invoice.projectFinancialSnapshot?.approvedAgreementCents,
      });
    } else {
      Object.assign(invoice, update);
      invoice.updatedBy = req.user.id;
      live = await refreshFinancialSnapshot(invoice);
      const nextSignature = contentSignature(invoice.toObject());
      if ((invoice.generatedPdfs || []).length && previousSignature !== nextSignature) {
        invoice.requiresRegeneration = true;
        invoice.addEvent("Draft updated after PDF generation", req, {
          reason: "Current editable invoice data differs from the last generated PDF.",
        });
      } else {
        invoice.addEvent("Draft updated", req);
      }
    }

    await invoice.save();
    return res.status(201).json({
      invoice: serializeInvoice(invoice, { parentProject: project }),
      financialWarnings: live
        ? buildBillingWarnings({
            context: live.context,
            invoiceTotalCents: invoice.invoiceTotalCents,
            agreement: live.agreement,
          })
        : [],
    });
  } catch (error) {
    return handleWriteError(error, res, "Failed to save invoice draft");
  }
});

router.post("/:id/generate", async (req, res) => {
  let audit = null;
  try {
    const invoice = await getInvoiceForProjectOr404(req.params.id, req, res);
    if (!invoice) return null;
    if (!invoice.lineItems?.length) {
      return res.status(400).json({ message: "At least one line item is required before generating an invoice PDF" });
    }

    audit = await createAdminActivityLog(req, {
      action: "Invoice PDF Generation Started",
      entityType: "Invoice",
      entityId: invoice._id,
      entityName: invoice.invoiceNumber,
      details: {
        projectId: invoice.projectId,
        version: Number(invoice.version || 1),
      },
    });

    // Last refresh before the document exists. After the invoice is issued this
    // is a no-op, so regenerating a sent invoice never rewrites its history.
    await refreshFinancialSnapshot(invoice);

    /*
     * An invoice drafted on Monday and issued on Friday is a Friday invoice.
     * Rolling the date here - the moment the customer-facing document is
     * produced - keeps the PDF and the record saying the same thing, and stops
     * net terms being counted from a date that has already passed. Skipped
     * entirely once the invoice has been issued, and whenever the admin set the
     * date deliberately.
     */
    const rolledInvoiceDate = autoIssueDate({
      isIssued: invoiceHasBeenIssued(invoice),
      isManual: invoice.dates?.invoiceDateIsManual,
      currentDate: invoice.dates?.invoiceDate,
    });
    if (rolledInvoiceDate) {
      invoice.dates.invoiceDate = rolledInvoiceDate;
      invoice.dates.dueDate = dueDateForTerm(rolledInvoiceDate, invoice.dueTerm, invoice.dates.dueDate, []);
      invoice.markModified("dates");
    }

    const nextVersion = Math.max(
      Number(invoice.version || 1),
      ...invoice.generatedPdfs.map((pdf) => Number(pdf.version || 0))
    ) + (invoice.generatedPdfs.length ? 1 : 0);
    invoice.version = nextVersion;
    invoice.generatedPdfs.forEach((pdf) => {
      if (pdf.status === "Current" || pdf.status === "Voided") {
        pdf.status = "Superseded";
      }
    });

    const pdfBuffer = await generateInvoicePdfBuffer(invoice);
    const fileName = buildInvoiceFilename(invoice);
    const key = `${INVOICE_S3_PREFIX}/${invoice.projectId}/${invoice._id}/v${invoice.version}/${sanitizeFilenamePart(fileName)}`;
    await putPrivateObject({
      Key: key,
      Body: pdfBuffer,
      ContentType: "application/pdf",
      CacheControl: "private, max-age=0, no-cache",
      ContentDisposition: `attachment; filename="${fileName.replace(/"/g, "")}"`,
    });

    invoice.generatedPdfs.push({
      version: invoice.version,
      key,
      url: "",
      fileName,
      size: pdfBuffer.length,
      generatedAt: new Date(),
      generatedBy: req.user.id,
      status: invoice.status === "Voided" ? "Voided" : "Current",
    });
    invoice.requiresRegeneration = false;
    invoice.updatedBy = req.user.id;
    invoice.addEvent(invoice.status === "Voided" ? "Voided PDF generated" : "Generated", req, {
      fileName,
      size: pdfBuffer.length,
      version: invoice.version,
    });
    await invoice.save();

    await markAdminActivityLog(audit, {
      action: "Invoice PDF Generated",
      details: {
        invoiceNumber: invoice.invoiceNumber,
        version: invoice.version,
        fileName,
        size: pdfBuffer.length,
      },
    });

    return res.json({ invoice: serializeInvoice(invoice, { parentProject: invoice.$locals.parentProject }) });
  } catch (error) {
    console.error("POST /admin/invoices/:id/generate failed:", error);
    await markAdminActivityLog(audit, {
      action: "Invoice PDF Generation Failed",
      details: { message: error?.message || "Unknown error" },
    });
    return res.status(500).json({ message: "Failed to generate invoice PDF" });
  }
});

router.get("/:id/download", async (req, res) => {
  try {
    const invoice = await getInvoiceForProjectOr404(req.params.id, req, res, { allowDeleted: true });
    if (!invoice) return null;
    const requestedVersion = Number(req.query.version || 0);
    const pdf = requestedVersion
      ? invoice.generatedPdfs.find((item) => Number(item.version || 0) === requestedVersion)
      : currentPdfRecord(invoice);
    if (!pdf?.key) return res.status(404).json({ message: "Generated invoice PDF not found" });

    const buffer = await getObjectBuffer({ Key: pdf.key });
    invoice.addEvent("Downloaded", req, {
      fileName: pdf.fileName,
      version: pdf.version,
    });
    await invoice.save();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${sanitizeFilenamePart(pdf.fileName || buildInvoiceFilename(invoice))}"`
    );
    return res.send(buffer);
  } catch (error) {
    console.error("GET /admin/invoices/:id/download failed:", error);
    return res.status(500).json({ message: "Failed to download invoice PDF" });
  }
});

router.post("/:id/email", async (req, res) => {
  try {
    const invoice = await getInvoiceForProjectOr404(req.params.id, req, res);
    if (!invoice) return null;
    const pdf = currentPdfRecord(invoice);
    if (!pdf?.key) {
      return res.status(409).json({ message: "Generate the invoice PDF before emailing it" });
    }
    if (invoice.requiresRegeneration) {
      return res.status(409).json({ message: "Generate a current invoice PDF before emailing this invoice" });
    }
    const recipient = cleanString(req.body.recipient || invoice.customerSnapshot?.email, 254).toLowerCase();
    const subject = cleanString(req.body.subject || defaultEmailSubject(invoice), 240);
    const message = cleanString(req.body.message || defaultEmailBody(invoice), 10000);
    if (!recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
      return res.status(400).json({ message: "A valid recipient email is required" });
    }
    if (!subject) return res.status(400).json({ message: "Email subject is required" });
    if (!message) return res.status(400).json({ message: "Email message is required" });

    const pdfBuffer = await getObjectBuffer({ Key: pdf.key });
    const info = await sendRaw({
      to: recipient,
      subject,
      html: `<p>${htmlEscape(message).replace(/\n/g, "<br>")}</p>`,
      text: message,
      attachments: [
        {
          filename: pdf.fileName || buildInvoiceFilename(invoice),
          content: pdfBuffer,
          contentType: "application/pdf",
        },
      ],
      logContext: {
        templateKey: invoice.status === "Paid in Full" ? "premium_island_paid_invoice" : "premium_island_invoice",
        source: "adminInvoices",
        emailType: "transactional",
      },
    });

    const now = new Date();
    invoice.sentAt = invoice.sentAt || now;
    invoice.lastEmailedAt = now;
    invoice.emailHistory.push({
      recipient,
      subject,
      message,
      pdfVersion: Number(pdf.version || invoice.version || 1),
      sentAt: now,
      sentBy: req.user.id,
      providerResponse: safeProviderResponse(info),
    });
    invoice.updatedBy = req.user.id;
    invoice.addEvent("Emailed", req, {
      recipient,
      subject,
      pdfVersion: Number(pdf.version || invoice.version || 1),
    });
    await invoice.save();

    return res.json({ invoice: serializeInvoice(invoice, { parentProject: invoice.$locals.parentProject }) });
  } catch (error) {
    console.error("POST /admin/invoices/:id/email failed:", error);
    return res.status(500).json({
      message: error?.message ? `Failed to email invoice: ${error.message}` : "Failed to email invoice",
    });
  }
});

router.post("/:id/payments", async (req, res) => {
  try {
    const invoice = await getInvoiceForProjectOr404(req.params.id, req, res);
    if (!invoice) return null;
    if (invoice.status === "Voided") return res.status(409).json({ message: "Voided invoices cannot accept payments" });

    const errors = [];
    const payment = normalizePaymentInput(req.body, errors);
    if (errors.length) return res.status(400).json({ message: errors[0], errors });
    const wasPaid = invoice.status === "Paid in Full";
    invoice.payments.push({
      ...payment,
      recordedBy: req.user.id,
      recordedByEmail: actorEmail(req),
    });
    const financials = calculateInvoiceFinancials(invoice);
    if (financials.errors.length) return res.status(400).json({ message: financials.errors[0], errors: financials.errors });
    if ((invoice.generatedPdfs || []).length) invoice.requiresRegeneration = true;
    invoice.updatedBy = req.user.id;
    invoice.addEvent("Payment added", req, {
      amountCents: payment.amountCents,
      method: payment.method,
    });
    await invoice.save();
    if (!wasPaid && invoice.status === "Paid in Full") {
      invoice.addEvent("Paid in full", req, { paidInFullAt: invoice.dates?.paidInFullAt });
      await invoice.save();
    }
    return res.status(201).json({ invoice: serializeInvoice(invoice, { parentProject: invoice.$locals.parentProject }) });
  } catch (error) {
    return handleWriteError(error, res, "Failed to add invoice payment");
  }
});

router.patch("/:id/payments/:paymentId", async (req, res) => {
  try {
    const invoice = await getInvoiceForProjectOr404(req.params.id, req, res);
    if (!invoice) return null;
    if (invoice.status === "Voided") return res.status(409).json({ message: "Voided invoice payments cannot be edited" });
    const payment = invoice.payments.id(req.params.paymentId);
    if (!payment) return res.status(404).json({ message: "Payment not found" });

    const errors = [];
    const nextPayment = normalizePaymentInput(req.body, errors, payment);
    if (errors.length) return res.status(400).json({ message: errors[0], errors });
    const wasPaid = invoice.status === "Paid in Full";
    Object.assign(payment, nextPayment);
    const financials = calculateInvoiceFinancials(invoice);
    if (financials.errors.length) return res.status(400).json({ message: financials.errors[0], errors: financials.errors });
    if ((invoice.generatedPdfs || []).length) invoice.requiresRegeneration = true;
    invoice.updatedBy = req.user.id;
    invoice.addEvent("Payment edited", req, {
      paymentId: req.params.paymentId,
      amountCents: nextPayment.amountCents,
      method: nextPayment.method,
    });
    await invoice.save();
    if (wasPaid && invoice.status !== "Paid in Full") {
      invoice.addEvent("Reopened due to payment correction", req, { paymentId: req.params.paymentId });
      await invoice.save();
    } else if (!wasPaid && invoice.status === "Paid in Full") {
      invoice.addEvent("Paid in full", req, { paidInFullAt: invoice.dates?.paidInFullAt });
      await invoice.save();
    }
    return res.json({ invoice: serializeInvoice(invoice, { parentProject: invoice.$locals.parentProject }) });
  } catch (error) {
    return handleWriteError(error, res, "Failed to edit invoice payment");
  }
});

router.delete("/:id/payments/:paymentId", async (req, res) => {
  try {
    const invoice = await getInvoiceForProjectOr404(req.params.id, req, res);
    if (!invoice) return null;
    if (invoice.status === "Voided") return res.status(409).json({ message: "Voided invoice payments cannot be removed" });
    const payment = invoice.payments.id(req.params.paymentId);
    if (!payment) return res.status(404).json({ message: "Payment not found" });
    const wasPaid = invoice.status === "Paid in Full";
    const details = {
      paymentId: req.params.paymentId,
      amountCents: payment.amountCents,
      method: payment.method,
    };
    payment.deleteOne();
    if ((invoice.generatedPdfs || []).length) invoice.requiresRegeneration = true;
    invoice.updatedBy = req.user.id;
    invoice.addEvent("Payment removed", req, details);
    await invoice.save();
    if (wasPaid && invoice.status !== "Paid in Full") {
      invoice.addEvent("Reopened due to payment correction", req, { paymentId: req.params.paymentId });
      await invoice.save();
    }
    return res.json({ invoice: serializeInvoice(invoice, { parentProject: invoice.$locals.parentProject }) });
  } catch (error) {
    return handleWriteError(error, res, "Failed to remove invoice payment");
  }
});

router.post("/:id/void", async (req, res) => {
  try {
    const invoice = await getInvoiceForProjectOr404(req.params.id, req, res);
    if (!invoice) return null;
    if (invoice.status === "Voided") {
      return res.json({ invoice: serializeInvoice(invoice, { parentProject: invoice.$locals.parentProject }) });
    }
    const confirmation = cleanString(req.body.confirmation, 40);
    if (confirmation !== "VOID") {
      return res.status(400).json({ message: "Type VOID to confirm invoice voiding" });
    }
    invoice.status = "Voided";
    invoice.voidedAt = new Date();
    invoice.voidedBy = req.user.id;
    invoice.voidReason = cleanString(req.body.reason, 1000);
    if ((invoice.generatedPdfs || []).length) invoice.requiresRegeneration = true;
    invoice.updatedBy = req.user.id;
    invoice.addEvent("Voided", req, { reason: invoice.voidReason });
    await invoice.save();
    return res.json({ invoice: serializeInvoice(invoice, { parentProject: invoice.$locals.parentProject }) });
  } catch (error) {
    return handleWriteError(error, res, "Failed to void invoice");
  }
});

module.exports = router;
