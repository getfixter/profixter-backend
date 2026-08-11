/**
 * The one read path for a project's financial story.
 *
 * projectFinancials.js holds the arithmetic and knows nothing about the
 * database. This module is the other half: it decides WHICH documents make up
 * a project's financial position, loads them, and hands them to the engine.
 *
 * Everything that needs to know what a project is worth - the Admin summary,
 * invoice creation, the invoice PDF - comes through here, so there is exactly
 * one answer to "what has been agreed, billed and paid" and no route is free
 * to invent its own.
 */

const Contract = require("../models/Contract");
const ChangeOrder = require("../models/ChangeOrder");
const Invoice = require("../models/Invoice");
const {
  buildInvoiceFinancialContext,
  computeProjectFinancials,
  countsTowardInvoiced,
  invoiceIsIssued,
  paidOnInvoice,
} = require("./projectFinancials");
const { isExecuted, isPending } = require("./changeOrderTotals");

/**
 * Contract statuses that represent an agreement the customer is actually on
 * the hook for. A Draft is a proposal we have not issued.
 */
const BINDING_AGREEMENT_STATUSES = Object.freeze(["Generated", "Emailed", "Signed"]);

function isBindingAgreement(contract) {
  return BINDING_AGREEMENT_STATUSES.includes(String(contract?.status || ""));
}

/**
 * The agreement of record for a project.
 *
 * An Agreement is revised by versioning: every version shares one contract
 * number and exactly one is flagged `current`. So the current version is the
 * document of record, preferring an issued one over a draft that was started
 * on top of it. Only when nothing has been issued do we fall back to the
 * draft, so a project mid-setup shows the figures being prepared rather than a
 * bare zero - flagged non-binding so a draft is never presented as agreed
 * money.
 */
function pickAgreementOfRecord(contracts = []) {
  const list = Array.isArray(contracts) ? contracts : [];
  const byVersionDesc = [...list].sort((a, b) => Number(b.version || 0) - Number(a.version || 0));
  return (
    byVersionDesc.find((contract) => contract.current && isBindingAgreement(contract)) ||
    byVersionDesc.find(isBindingAgreement) ||
    byVersionDesc.find((contract) => contract.current) ||
    byVersionDesc[0] ||
    null
  );
}

/**
 * Every version of one Agreement.
 *
 * A change order is raised against a specific version document. If the
 * Agreement is later revised, that order still amends the Agreement - so
 * change orders are gathered across every version sharing the contract
 * number, not just the current one. Each order belongs to exactly one version,
 * so nothing can be counted twice, and nothing raised against v1 silently
 * disappears the day v2 is created.
 */
function agreementVersionIds(contracts, agreement) {
  if (!agreement) return [];
  return contracts
    .filter((contract) => contract.contractNumber === agreement.contractNumber)
    .map((contract) => contract._id);
}

/** Load every document that contributes to a project's financial position. */
async function loadProjectDocuments(projectId) {
  const contracts = await Contract.find({ projectId })
    .select(
      "contractNumber version current status adjustedContractPriceCents originalContractPriceCents totalPriceCents dates estimateId estimateSnapshot"
    )
    .sort({ version: -1 })
    .lean();

  const agreement = pickAgreementOfRecord(contracts);
  const versionIds = agreementVersionIds(contracts, agreement);

  const [changeOrders, invoices] = await Promise.all([
    versionIds.length
      ? ChangeOrder.find({ contractId: { $in: versionIds } })
          .select("changeOrderNumber title status netAdjustmentCents executedAt sentAt createdAt sequence")
          .sort({ sequence: 1 })
          .lean()
      : Promise.resolve([]),
    Invoice.find({ projectId, isArchived: { $ne: true } })
      .select(
        "invoiceNumber status invoiceTotalCents payments sentAt dates contractId projectFinancialSnapshot createdAt isArchived"
      )
      .sort({ createdAt: 1 })
      .lean(),
  ]);

  return { contracts, agreement, changeOrders, invoices };
}

function serializeChangeOrderReference(changeOrder) {
  return {
    id: String(changeOrder._id),
    changeOrderNumber: changeOrder.changeOrderNumber || "",
    title: changeOrder.title || "",
    status: changeOrder.status || "",
    netAdjustmentCents: Number(changeOrder.netAdjustmentCents || 0),
    executedAt: changeOrder.executedAt || null,
  };
}

function serializeInvoiceReference(invoice) {
  return {
    id: String(invoice._id),
    invoiceNumber: invoice.invoiceNumber || "",
    status: invoice.status || "",
    invoiceTotalCents: Number(invoice.invoiceTotalCents || 0),
    paidCents: paidOnInvoice(invoice),
    countsTowardInvoiced: countsTowardInvoiced(invoice),
    issuedAt: invoice.sentAt || null,
    invoiceDate: invoice.dates?.invoiceDate || null,
    hasFinancialSnapshot: !!invoice.projectFinancialSnapshot?.capturedAt,
  };
}

function serializeAgreementReference(agreement) {
  if (!agreement) return null;
  const estimateSnapshot = agreement.estimateSnapshot || {};
  return {
    id: String(agreement._id),
    contractNumber: agreement.contractNumber || "",
    version: Number(agreement.version || 1),
    status: agreement.status || "",
    isBinding: isBindingAgreement(agreement),
    contractDate: agreement.dates?.contractDate || null,
    estimate: agreement.estimateId
      ? {
          id: String(agreement.estimateId),
          estimateNumber: estimateSnapshot.estimateNumber || "",
          title: estimateSnapshot.title || "",
          totalCents: Number(estimateSnapshot.totalCents || 0),
          importedAt: estimateSnapshot.importedAt || null,
        }
      : null,
  };
}

/**
 * The whole financial story for one project, ready to serve.
 *
 * Returns the totals plus the documents they were derived from, so the Admin
 * UI can explain every number by pointing at a document instead of recomputing
 * anything of its own.
 */
async function getProjectFinancialSummary(projectId) {
  const { contracts, agreement, changeOrders, invoices } = await loadProjectDocuments(projectId);

  const totals = computeProjectFinancials({
    baselineCents: agreement?.adjustedContractPriceCents || 0,
    changeOrders,
    invoices,
  });

  // A project is normally one Agreement revised through versions. If it somehow
  // carries several distinct Agreements, say so rather than quietly summarising
  // one of them as though it were the whole project.
  const otherAgreementNumbers = [
    ...new Set(
      contracts
        .filter((contract) => agreement && contract.contractNumber !== agreement.contractNumber)
        .map((contract) => contract.contractNumber)
    ),
  ];

  return {
    projectId: String(projectId),
    agreement: serializeAgreementReference(agreement),
    otherAgreementNumbers,
    changeOrders: {
      executed: changeOrders.filter(isExecuted).map(serializeChangeOrderReference),
      pending: changeOrders.filter(isPending).map(serializeChangeOrderReference),
    },
    invoices: invoices.map(serializeInvoiceReference),
    totals,
  };
}

/**
 * The financial context a specific invoice should be created or issued against.
 *
 * `excludeInvoiceId` keeps an invoice from counting itself as already billed,
 * which would otherwise understate the approved headroom by exactly its own
 * amount every time an existing draft was re-saved.
 */
async function getInvoiceFinancialContext(projectId, { contract = null, excludeInvoiceId = null } = {}) {
  const documents = await loadProjectDocuments(projectId);

  // An invoice imported from a specific agreement is billed against THAT
  // agreement, even when a different one has since become the one of record.
  const agreement = contract || documents.agreement;
  const sameAgreement =
    agreement &&
    documents.agreement &&
    agreement.contractNumber === documents.agreement.contractNumber;
  const changeOrders = sameAgreement
    ? documents.changeOrders
    : agreement
      ? await ChangeOrder.find({
          contractId: {
            $in: agreementVersionIds(documents.contracts, agreement).length
              ? agreementVersionIds(documents.contracts, agreement)
              : [agreement._id],
          },
        })
          .select("changeOrderNumber title status netAdjustmentCents executedAt sequence")
          .sort({ sequence: 1 })
          .lean()
      : [];

  return {
    agreement,
    changeOrders,
    invoices: documents.invoices,
    context: buildInvoiceFinancialContext({
      contract: agreement,
      changeOrders,
      invoices: documents.invoices,
      excludeInvoiceId,
    }),
  };
}

/**
 * Warnings the Admin should see before billing - never a block.
 *
 * Over-invoicing is a legitimate operational act (an agreed extra billed
 * before its change order is executed, a correction). The system's job is to
 * make it visible, not to decide it is wrong.
 */
function buildBillingWarnings({ context, invoiceTotalCents, agreement }) {
  const warnings = [];
  const thisInvoice = Number(invoiceTotalCents || 0);
  const totalAfter = Number(context.previouslyInvoicedCents || 0) + thisInvoice;
  const approved = Number(context.approvedAgreementCents || 0);

  if (agreement && !isBindingAgreement(agreement)) {
    warnings.push({
      code: "agreement_not_issued",
      message: `Agreement #${agreement.contractNumber} has not been issued yet. Its price is not approved value.`,
    });
  }
  if (approved > 0 && totalAfter > approved) {
    warnings.push({
      code: "over_invoiced",
      message:
        "This invoice bills more than the approved Agreement value. Execute a Change Order first if this work was agreed.",
      overageCents: totalAfter - approved,
    });
  }
  return warnings;
}

module.exports = {
  BINDING_AGREEMENT_STATUSES,
  isBindingAgreement,
  pickAgreementOfRecord,
  agreementVersionIds,
  loadProjectDocuments,
  getProjectFinancialSummary,
  getInvoiceFinancialContext,
  buildBillingWarnings,
  invoiceIsIssued,
};
