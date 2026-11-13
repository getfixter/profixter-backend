/**
 * Needs action - renovation projects: a signed agreement with no deposit
 * invoice, a declined or expired signature on a document that is still open,
 * and overdue invoices. Each item comes from the authoritative record and
 * links to the project.
 *
 * Loaded by utils/needsAction/index.js (directory scan); skipped for callers
 * without the Projects section.
 */
const { PERMISSIONS } = require("../../adminAccess");
const Project = require("../../../models/Project");
const Contract = require("../../../models/Contract");
const ChangeOrder = require("../../../models/ChangeOrder");
const Invoice = require("../../../models/Invoice");
const ESignature = require("../../../models/ESignature");
const { depositBilled, isOverdue } = require("../../projects/projectWorkflow");
const { paidOnInvoice } = require("../../projectFinancials");
const {
  SIGNABLE_CHANGE_ORDER_STATUSES,
  SIGNABLE_CONTRACT_STATUSES,
} = require("../../esign/documentStates");

const SCAN_LIMIT = 300;
const SIGNATURE_LOOKBACK_DAYS = 45;

function money(cents) {
  return `$${(Number(cents || 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function liveProjects(ids) {
  const projects = await Project.find({ _id: { $in: ids }, isDeleted: { $ne: true } })
    .select("projectNumber customerName address billingClaims")
    .lean();
  return new Map(projects.map((project) => [String(project._id), project]));
}

async function depositItems(now) {
  const signed = await Contract.find({ status: "Signed", depositAmountCents: { $gt: 0 } })
    .select("projectId contractNumber version depositAmountCents updatedAt")
    .sort({ updatedAt: -1 })
    .limit(SCAN_LIMIT)
    .lean();
  if (!signed.length) return [];
  const projects = await liveProjects(signed.map((c) => c.projectId));
  const invoices = await Invoice.find({ projectId: { $in: [...projects.keys()] }, isArchived: { $ne: true } })
    .select("projectId contractId status invoiceTotalCents isArchived")
    .lean();
  const invoicesByProject = new Map();
  for (const invoice of invoices) {
    const key = String(invoice.projectId);
    if (!invoicesByProject.has(key)) invoicesByProject.set(key, []);
    invoicesByProject.get(key).push(invoice);
  }
  const seen = new Set();
  const items = [];
  for (const contract of signed) {
    const key = String(contract.projectId);
    if (seen.has(key)) continue; // newest signed version per project only
    seen.add(key);
    const project = projects.get(key);
    if (!project) continue;
    const projectInvoices = invoicesByProject.get(key) || [];
    const byId = new Map(projectInvoices.map((invoice) => [String(invoice._id), invoice]));
    if (depositBilled(project, contract, projectInvoices, byId)) continue;
    items.push({
      id: key,
      kind: "project_deposit_not_invoiced",
      title: `Deposit not invoiced: ${project.customerName}`,
      subtitle: `${project.projectNumber} · Agreement #${contract.contractNumber}`,
      reason: `The agreement is signed. Create the ${money(contract.depositAmountCents)} deposit invoice.`,
      severity: "attention",
      href: `/admin/projects/${key}`,
      at: contract.updatedAt || now,
    });
  }
  return items;
}

async function signatureItems(now) {
  const since = new Date(now.getTime() - SIGNATURE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const ended = await ESignature.find({
    provider: "native",
    status: { $in: ["Declined", "Expired"] },
    updatedAt: { $gte: since },
  })
    .select("projectId documentType documentId documentNumber status declinedAt expiredAt declineReason createdAt updatedAt")
    .sort({ updatedAt: -1 })
    .limit(SCAN_LIMIT)
    .lean();
  if (!ended.length) return [];

  const projects = await liveProjects(ended.map((s) => s.projectId));
  const items = [];
  const seenDocs = new Set();
  for (const signature of ended) {
    const docKey = `${signature.documentType}:${signature.documentId}`;
    if (seenDocs.has(docKey)) continue;
    seenDocs.add(docKey);
    const project = projects.get(String(signature.projectId));
    if (!project) continue;

    // Resolved already if a newer request was sent or completed for the same document.
    const newer = await ESignature.exists({
      documentType: signature.documentType,
      documentId: signature.documentId,
      createdAt: { $gt: signature.createdAt },
    });
    if (newer) continue;

    // Still relevant only while the document itself is open.
    const doc =
      signature.documentType === "CHANGE_ORDER"
        ? await ChangeOrder.findById(signature.documentId).select("status").lean()
        : await Contract.findById(signature.documentId).select("status current").lean();
    if (!doc) continue;
    const open =
      signature.documentType === "CHANGE_ORDER"
        ? SIGNABLE_CHANGE_ORDER_STATUSES.includes(doc.status)
        : SIGNABLE_CONTRACT_STATUSES.includes(doc.status) && doc.current !== false;
    if (!open) continue;

    const declined = signature.status === "Declined";
    const label = signature.documentType === "CHANGE_ORDER" ? `Change order ${signature.documentNumber}` : `Agreement #${signature.documentNumber}`;
    items.push({
      id: String(signature._id),
      kind: declined ? "project_signature_declined" : "project_signature_expired",
      title: `${declined ? "Signature declined" : "Signing link expired"}: ${project.customerName}`,
      subtitle: `${project.projectNumber} · ${label}`,
      reason: declined
        ? signature.declineReason
          ? `Customer's reason: ${signature.declineReason}`
          : "The customer declined without a reason. Call them."
        : "The customer did not sign before the link ran out. Send a new request.",
      severity: "problem",
      href: `/admin/projects/${signature.projectId}`,
      at: signature.declinedAt || signature.expiredAt || signature.updatedAt,
    });
  }
  return items;
}

async function overdueItems(now) {
  const candidates = await Invoice.find({
    isArchived: { $ne: true },
    status: { $in: ["Sent", "Partially Paid", "Overdue"] },
    $or: [{ status: "Overdue" }, { "dates.dueDate": { $lt: now } }],
  })
    .select("projectId invoiceNumber status invoiceTotalCents payments dates sentAt isArchived")
    .sort({ "dates.dueDate": 1 })
    .limit(SCAN_LIMIT)
    .lean();
  if (!candidates.length) return [];
  const projects = await liveProjects(candidates.map((invoice) => invoice.projectId));
  const items = [];
  for (const invoice of candidates) {
    if (!isOverdue(invoice, now)) continue;
    const project = projects.get(String(invoice.projectId));
    if (!project) continue;
    const balance = Number(invoice.invoiceTotalCents || 0) - paidOnInvoice(invoice);
    items.push({
      id: String(invoice._id),
      kind: "project_invoice_overdue",
      title: `Invoice overdue: ${project.customerName}`,
      subtitle: `${project.projectNumber} · Invoice #${invoice.invoiceNumber}`,
      reason: `${money(balance)} outstanding${invoice.dates?.dueDate ? `, due ${new Date(invoice.dates.dueDate).toISOString().slice(0, 10)}` : ""}.`,
      severity: "problem",
      href: `/admin/projects/${invoice.projectId}?tab=invoices&invoice=${invoice._id}`,
      at: invoice.dates?.dueDate || invoice.sentAt || now,
    });
  }
  return items;
}

module.exports = {
  key: "projects",
  order: 30,
  permission: PERMISSIONS.PROJECTS_MANAGE,
  async collect({ now = new Date(), limit = 25 } = {}) {
    const [signatures, overdue, deposits] = await Promise.all([signatureItems(now), overdueItems(now), depositItems(now)]);
    const items = [...signatures, ...overdue, ...deposits];
    return { count: items.length, items: items.slice(0, limit) };
  },
};
