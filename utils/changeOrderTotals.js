/**
 * Change Order financial engine.
 *
 * Pure functions - no database, no I/O - so the money rules are testable in
 * isolation and cannot drift with route changes.
 *
 * BASELINE
 * The figure a Change Order adjusts is the contract's "Final Contract Price"
 * (Contract.adjustedContractPriceCents = original price less discounts). That
 * is the number printed on the contract PDF and the number the customer signs,
 * so it is the only defensible baseline for an amendment.
 *
 * EXECUTED vs PENDING
 * Only EXECUTED change orders move the contract value. Draft, sent and awaiting
 * signature orders are proposals: they are reported separately as a projected
 * amount and never contaminate the executed total.
 *
 * All amounts are integer cents. Never floats.
 */

/** Statuses whose amounts count toward the binding contract value. */
const EXECUTED_STATUSES = Object.freeze(["Executed"]);

/** Statuses that represent a live proposal not yet binding. */
const PENDING_STATUSES = Object.freeze([
  "Ready to Send",
  "Sent",
  "Viewed",
  "Awaiting Signature",
  "Partially Signed",
]);

/** Statuses that are dead and must never affect any total. */
const INERT_STATUSES = Object.freeze(["Draft", "Declined", "Voided"]);

function toCents(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

/**
 * Signed cents for one change line.
 * `direction` is the admin's intent - "add" or "deduct" - so nobody has to
 * type a negative number, and a deduction can never be stored as a positive.
 */
function lineAmountCents(line) {
  const magnitude = Math.abs(toCents(line?.amountCents));
  if (magnitude === 0) return 0;
  return String(line?.direction).toLowerCase() === "deduct" ? -magnitude : magnitude;
}

/** Net signed adjustment for a set of change lines. */
function netAdjustmentCents(lines) {
  if (!Array.isArray(lines)) return 0;
  return lines.reduce((sum, line) => sum + lineAmountCents(line), 0);
}

function isExecuted(changeOrder) {
  return EXECUTED_STATUSES.includes(String(changeOrder?.status || ""));
}

function isPending(changeOrder) {
  return PENDING_STATUSES.includes(String(changeOrder?.status || ""));
}

/**
 * Roll up a contract baseline and its change orders.
 *
 * @param {number} baselineCents Contract "Final Contract Price" in cents.
 * @param {Array} changeOrders   Any order; each needs {status, netAdjustmentCents|lines}.
 * @returns {{
 *   originalContractCents: number,
 *   executedAdjustmentCents: number,
 *   executedContractCents: number,
 *   pendingAdjustmentCents: number,
 *   projectedContractCents: number,
 *   executedCount: number,
 *   pendingCount: number,
 * }}
 */
function summarizeContractValue(baselineCents, changeOrders = []) {
  const original = Math.max(toCents(baselineCents), 0);
  const list = Array.isArray(changeOrders) ? changeOrders : [];

  let executedAdjustment = 0;
  let pendingAdjustment = 0;
  let executedCount = 0;
  let pendingCount = 0;

  for (const co of list) {
    const net =
      co?.netAdjustmentCents !== undefined && co?.netAdjustmentCents !== null
        ? toCents(co.netAdjustmentCents)
        : netAdjustmentCents(co?.lines);

    if (isExecuted(co)) {
      executedAdjustment += net;
      executedCount += 1;
    } else if (isPending(co)) {
      pendingAdjustment += net;
      pendingCount += 1;
    }
    // Inert statuses contribute nothing, by design.
  }

  // A contract cannot be worth less than nothing.
  const executedContract = Math.max(original + executedAdjustment, 0);
  const projectedContract = Math.max(executedContract + pendingAdjustment, 0);

  return {
    originalContractCents: original,
    executedAdjustmentCents: executedAdjustment,
    executedContractCents: executedContract,
    pendingAdjustmentCents: pendingAdjustment,
    projectedContractCents: projectedContract,
    executedCount,
    pendingCount,
  };
}

/**
 * Figures for a single change order at the moment it is drafted or issued.
 *
 * `priorExecuted` should be the change orders already EXECUTED against this
 * contract, excluding the one being computed. The returned
 * contractAmountBeforeChangeCents is frozen onto the document when it is
 * issued, so the paperwork keeps saying what it said on the day it was signed
 * even if later orders change the running total.
 */
function computeChangeOrderFigures({ baselineCents, priorExecuted = [], lines = [] }) {
  const before = summarizeContractValue(baselineCents, priorExecuted).executedContractCents;
  const net = netAdjustmentCents(lines);
  const after = Math.max(before + net, 0);

  return {
    originalContractCents: Math.max(toCents(baselineCents), 0),
    previousChangeOrderAdjustmentCents: before - Math.max(toCents(baselineCents), 0),
    contractAmountBeforeChangeCents: before,
    netAdjustmentCents: net,
    newContractAmountCents: after,
  };
}

/** "+$1,250.00" / "-$450.00" / "$0.00" */
function formatSignedCents(cents) {
  const n = toCents(cents);
  const abs = Math.abs(n);
  const body = (abs / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  });
  if (n > 0) return `+${body}`;
  if (n < 0) return `-${body}`;
  return body;
}

module.exports = {
  EXECUTED_STATUSES,
  PENDING_STATUSES,
  INERT_STATUSES,
  lineAmountCents,
  netAdjustmentCents,
  isExecuted,
  isPending,
  summarizeContractValue,
  computeChangeOrderFigures,
  formatSignedCents,
};
