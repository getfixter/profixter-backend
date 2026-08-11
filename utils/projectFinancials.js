/**
 * Project financial roll-up.
 *
 * The single read path for "where does this project stand financially". Pure
 * functions, integer cents, no I/O - so the money rules are testable in
 * isolation and cannot drift with route changes.
 *
 * IT COMPOSES, IT DOES NOT RECALCULATE.
 * Approved value comes from changeOrderTotals.summarizeContractValue(), which
 * already decides correctly which change order statuses count. That logic is
 * not repeated here and must never be: one money engine, one place to be wrong.
 *
 * FIVE DISTINCT NUMBERS, DELIBERATELY NOT INTERCHANGEABLE
 *
 *   approved   what the customer has agreed to pay - Agreement plus EXECUTED
 *              change orders only
 *   projected  approved plus change orders still awaiting signature. Never
 *              billable. Shown separately so nobody mistakes proposed work for
 *              agreed work.
 *   invoiced   what we have actually billed
 *   paid       what has actually been collected
 *   uninvoiced approved work not yet billed
 *
 * A payment never changes approved value. A change order is never a payment.
 * Conflating any two of these is the failure this module exists to prevent.
 */

const { summarizeContractValue } = require("./changeOrderTotals");

/**
 * Invoice statuses that represent a real claim on the customer.
 *
 * Draft is excluded: it has not been issued, so billing it would overstate what
 * we have asked for. Voided and Superseded are excluded because they have been
 * withdrawn or replaced - counting them would double-bill the replacement.
 */
const COUNTED_INVOICE_STATUSES = Object.freeze([
  "Sent",
  "Partially Paid",
  "Paid in Full",
  "Overdue",
]);

function toCents(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/** An invoice counts toward billed totals only if issued and still live. */
function countsTowardInvoiced(invoice) {
  if (!invoice || invoice.isArchived) return false;
  return COUNTED_INVOICE_STATUSES.includes(String(invoice.status || ""));
}

/**
 * Has this invoice left the building?
 *
 * The moment that matters for immutability. Up to here an invoice is a working
 * draft and its financial context should track reality; past here it is a
 * document the customer holds, and its context must never move again.
 *
 * Voided and Superseded count as issued: they were real claims once, and
 * rewriting their history retroactively would be worse than leaving it.
 */
function invoiceIsIssued(invoice) {
  if (!invoice) return false;
  if (invoice.sentAt) return true;
  const status = String(invoice.status || "");
  return COUNTED_INVOICE_STATUSES.includes(status) ||
    status === "Voided" ||
    status === "Superseded";
}

/** Drop one invoice from a list - used so an invoice never counts itself. */
function withoutInvoice(invoices, excludeInvoiceId) {
  const list = Array.isArray(invoices) ? invoices : [];
  if (!excludeInvoiceId) return list;
  const excluded = String(excludeInvoiceId);
  return list.filter((invoice) => String(invoice?._id || invoice?.id || "") !== excluded);
}

/**
 * Money actually collected against one invoice.
 *
 * Payments are embedded on the invoice, so they are summed from the payment
 * records rather than trusting the denormalised totalPaidCents - a stored
 * total that drifted would silently misreport collections.
 */
function paidOnInvoice(invoice) {
  const payments = Array.isArray(invoice?.payments) ? invoice.payments : [];
  return payments.reduce((sum, payment) => sum + Math.max(toCents(payment?.amountCents), 0), 0);
}

/**
 * The whole financial picture for one project.
 *
 * @param {object} input
 * @param {number} input.baselineCents  Agreement "Final Agreement Price".
 * @param {Array}  input.changeOrders   All change orders for that agreement.
 * @param {Array}  input.invoices       All invoices for the project.
 * @returns {object} every figure the Admin summary and invoice creation need.
 */
function computeProjectFinancials({ baselineCents = 0, changeOrders = [], invoices = [] } = {}) {
  // Approved and projected value: delegated, never re-derived.
  const agreement = summarizeContractValue(baselineCents, changeOrders);

  const counted = (Array.isArray(invoices) ? invoices : []).filter(countsTowardInvoiced);

  const invoicedCents = counted.reduce(
    (sum, invoice) => sum + Math.max(toCents(invoice.invoiceTotalCents), 0),
    0
  );

  // Payments are only meaningful against invoices that still stand. A payment
  // recorded on a voided invoice is a bookkeeping problem, not collected
  // revenue against this project's approved value.
  const paidCents = counted.reduce((sum, invoice) => sum + paidOnInvoice(invoice), 0);

  // What the customer still owes on what we have already billed.
  const outstandingInvoicedCents = Math.max(invoicedCents - paidCents, 0);

  // Approved work we have not billed yet. Floored at zero: over-invoicing
  // beyond approved value is possible operationally, and it should surface as
  // an overage rather than as a negative amount of remaining work.
  const uninvoicedApprovedCents = Math.max(
    agreement.executedContractCents - invoicedCents,
    0
  );

  // Explicit, so the UI can warn rather than silently hiding it.
  const overInvoicedCents = Math.max(invoicedCents - agreement.executedContractCents, 0);

  return {
    // Agreement side
    originalAgreementCents: agreement.originalContractCents,
    executedChangeOrderCents: agreement.executedAdjustmentCents,
    approvedAgreementCents: agreement.executedContractCents,
    pendingChangeOrderCents: agreement.pendingAdjustmentCents,
    projectedAgreementCents: agreement.projectedContractCents,
    executedChangeOrderCount: agreement.executedCount,
    pendingChangeOrderCount: agreement.pendingCount,

    // Billing side
    invoicedCents,
    paidCents,
    outstandingInvoicedCents,
    uninvoicedApprovedCents,
    overInvoicedCents,
    countedInvoiceCount: counted.length,
  };
}

/**
 * The context a NEW invoice should be created against.
 *
 * This is what fixes the original defect: invoice creation reads approved value
 * from here, so it sees the agreement PLUS executed change orders rather than
 * the original agreement price alone.
 *
 * The returned object is also the shape worth freezing onto the invoice at
 * issue, so the invoice keeps saying what was true on the day it was sent even
 * after later change orders execute.
 */
function buildInvoiceFinancialContext({
  contract,
  changeOrders = [],
  invoices = [],
  excludeInvoiceId = null,
}) {
  const baselineCents = toCents(
    contract?.adjustedContractPriceCents ?? contract?.totalPriceCents ?? 0
  );
  // "Previously" means every other invoice. An invoice that counted itself
  // would report its own amount as already billed and understate the headroom.
  const others = withoutInvoice(invoices, excludeInvoiceId);
  const totals = computeProjectFinancials({ baselineCents, changeOrders, invoices: others });

  // Only executed change orders belong in an invoice's financial story: a
  // pending one is not approved value and must not appear as billable.
  const executed = (Array.isArray(changeOrders) ? changeOrders : [])
    .filter((co) => String(co?.status || "") === "Executed")
    .map((co) => ({
      changeOrderNumber: co.changeOrderNumber,
      title: co.title || "",
      netAdjustmentCents: toCents(co.netAdjustmentCents),
    }));

  return {
    agreementId: contract?._id ? String(contract._id) : "",
    agreementNumber: contract?.contractNumber || "",
    agreementVersion: Number(contract?.version || 1),
    originalAgreementCents: totals.originalAgreementCents,
    executedChangeOrders: executed,
    executedChangeOrderCents: totals.executedChangeOrderCents,
    approvedAgreementCents: totals.approvedAgreementCents,
    previouslyInvoicedCents: totals.invoicedCents,
    previouslyPaidCents: totals.paidCents,
    uninvoicedApprovedCents: totals.uninvoicedApprovedCents,
    capturedAt: null, // stamped by the caller at issue time
  };
}

/**
 * Freeze an invoice's financial context at issue time.
 *
 * Takes the live context and stamps it, so the invoice reports what was true
 * on the day it was sent rather than recomputing against today's project.
 * Change order ids are captured too, so the snapshot can be traced back to the
 * exact documents it was built from.
 */
function freezeInvoiceSnapshot(context, changeOrders = [], now = new Date()) {
  const byNumber = new Map(
    (Array.isArray(changeOrders) ? changeOrders : []).map((co) => [co?.changeOrderNumber, co])
  );

  return {
    agreementId: context.agreementId || "",
    agreementNumber: context.agreementNumber || "",
    agreementVersion: Number(context.agreementVersion || 1),
    originalAgreementCents: toCents(context.originalAgreementCents),
    executedChangeOrders: (context.executedChangeOrders || []).map((entry) => {
      const source = byNumber.get(entry.changeOrderNumber);
      return {
        changeOrderId: source?._id ? String(source._id) : "",
        changeOrderNumber: entry.changeOrderNumber || "",
        title: entry.title || "",
        netAdjustmentCents: toCents(entry.netAdjustmentCents),
      };
    }),
    executedChangeOrderCents: toCents(context.executedChangeOrderCents),
    approvedAgreementCents: toCents(context.approvedAgreementCents),
    previouslyInvoicedCents: toCents(context.previouslyInvoicedCents),
    previouslyPaidCents: toCents(context.previouslyPaidCents),
    uninvoicedApprovedCents: toCents(context.uninvoicedApprovedCents),
    capturedAt: now,
  };
}

/**
 * Convert an Estimate into the frozen context an Agreement keeps.
 *
 * Estimates hold dollars; everything downstream is integer cents. The
 * conversion happens here, once, rather than being repeated at each read.
 */
function buildEstimateSnapshot(estimate, now = new Date()) {
  if (!estimate) return null;
  return {
    estimateNumber: estimate.estimateNumber || "",
    title: estimate.title || "",
    totalCents: Math.max(Math.round(Number(estimate.total || 0) * 100), 0),
    lineItemCount: Array.isArray(estimate.lineItems) ? estimate.lineItems.length : 0,
    importedAt: now,
  };
}

module.exports = {
  freezeInvoiceSnapshot,
  buildEstimateSnapshot,
  COUNTED_INVOICE_STATUSES,
  countsTowardInvoiced,
  invoiceIsIssued,
  withoutInvoice,
  paidOnInvoice,
  computeProjectFinancials,
  buildInvoiceFinancialContext,
};
