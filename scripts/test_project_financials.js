/**
 * Project financial roll-up — unit tests. No database, no network.
 *
 * These assert the distinctions that matter operationally: approved is not
 * projected, invoiced is not paid, and a payment never moves the agreement.
 *
 *   node scripts/test_project_financials.js
 */

const assert = require("assert");
const {
  computeProjectFinancials,
  buildInvoiceFinancialContext,
  countsTowardInvoiced,
  paidOnInvoice,
  freezeInvoiceSnapshot,
  buildEstimateSnapshot,
} = require("../utils/projectFinancials");

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

const $ = (dollars) => Math.round(dollars * 100);

const co = (status, amount, direction = "add") => ({
  status,
  changeOrderNumber: `CO-${status}-${amount}`,
  title: `${direction} ${amount}`,
  netAdjustmentCents: direction === "deduct" ? -$(amount) : $(amount),
});

const invoice = (status, total, payments = []) => ({
  status,
  invoiceTotalCents: $(total),
  payments: payments.map((amount) => ({ amountCents: $(amount) })),
});

/* ---------------- the worked example ---------------- */

console.log("\nThe brief's worked example");

const EXAMPLE = {
  baselineCents: $(20000),
  changeOrders: [co("Executed", 2000), co("Executed", 500, "deduct"), co("Sent", 4000)],
  invoices: [],
};

test("approved value is agreement plus executed change orders only", () =>
  assert.strictEqual(computeProjectFinancials(EXAMPLE).approvedAgreementCents, $(21500)));

test("projected value adds the pending change order", () =>
  assert.strictEqual(computeProjectFinancials(EXAMPLE).projectedAgreementCents, $(25500)));

test("pending value is reported separately, never folded into approved", () => {
  const result = computeProjectFinancials(EXAMPLE);
  assert.strictEqual(result.pendingChangeOrderCents, $(4000));
  assert.notStrictEqual(result.approvedAgreementCents, result.projectedAgreementCents);
});

/* ---------------- change order statuses ---------------- */

console.log("\nChange order status handling");

test("an agreement with no change orders is just the agreement", () => {
  const r = computeProjectFinancials({ baselineCents: $(20000) });
  assert.strictEqual(r.approvedAgreementCents, $(20000));
  assert.strictEqual(r.projectedAgreementCents, $(20000));
  assert.strictEqual(r.executedChangeOrderCents, 0);
});

test("an executed add raises approved value", () =>
  assert.strictEqual(
    computeProjectFinancials({ baselineCents: $(20000), changeOrders: [co("Executed", 2000)] })
      .approvedAgreementCents,
    $(22000)
  ));

test("an executed deduct lowers approved value", () =>
  assert.strictEqual(
    computeProjectFinancials({
      baselineCents: $(20000),
      changeOrders: [co("Executed", 500, "deduct")],
    }).approvedAgreementCents,
    $(19500)
  ));

test("a no-cost change order moves nothing", () => {
  const r = computeProjectFinancials({
    baselineCents: $(20000),
    changeOrders: [{ status: "Executed", netAdjustmentCents: 0 }],
  });
  assert.strictEqual(r.approvedAgreementCents, $(20000));
  assert.strictEqual(r.executedChangeOrderCount, 1);
});

test("multiple executed change orders accumulate", () =>
  assert.strictEqual(
    computeProjectFinancials({
      baselineCents: $(20000),
      changeOrders: [co("Executed", 1000), co("Executed", 2000), co("Executed", 500, "deduct")],
    }).approvedAgreementCents,
    $(22500)
  ));

test("declined, voided and draft change orders are excluded entirely", () => {
  const r = computeProjectFinancials({
    baselineCents: $(20000),
    changeOrders: [co("Declined", 5000), co("Voided", 5000), co("Draft", 5000)],
  });
  assert.strictEqual(r.approvedAgreementCents, $(20000));
  assert.strictEqual(r.projectedAgreementCents, $(20000));
});

/* ---------------- invoicing ---------------- */

console.log("\nInvoicing");

test("only issued invoices count toward invoiced", () => {
  assert.strictEqual(countsTowardInvoiced(invoice("Sent", 100)), true);
  assert.strictEqual(countsTowardInvoiced(invoice("Draft", 100)), false);
  assert.strictEqual(countsTowardInvoiced(invoice("Voided", 100)), false);
  assert.strictEqual(countsTowardInvoiced(invoice("Superseded", 100)), false);
  assert.strictEqual(countsTowardInvoiced({ ...invoice("Sent", 100), isArchived: true }), false);
});

test("multiple invoices sum, drafts and voids ignored", () => {
  const r = computeProjectFinancials({
    baselineCents: $(21500),
    invoices: [invoice("Sent", 10000), invoice("Paid in Full", 5000), invoice("Draft", 9999), invoice("Voided", 8888)],
  });
  assert.strictEqual(r.invoicedCents, $(15000));
  assert.strictEqual(r.countedInvoiceCount, 2);
});

test("remaining approved but uninvoiced is approved minus invoiced", () => {
  const r = computeProjectFinancials({
    baselineCents: $(20000),
    changeOrders: [co("Executed", 2000), co("Executed", 500, "deduct")],
    invoices: [invoice("Sent", 10000), invoice("Sent", 5000)],
  });
  assert.strictEqual(r.approvedAgreementCents, $(21500));
  assert.strictEqual(r.invoicedCents, $(15000));
  assert.strictEqual(r.uninvoicedApprovedCents, $(6500));
});

test("a pending change order does not create billable headroom", () => {
  const r = computeProjectFinancials({
    baselineCents: $(20000),
    changeOrders: [co("Sent", 4000)],
    invoices: [invoice("Sent", 20000)],
  });
  assert.strictEqual(r.uninvoicedApprovedCents, 0, "pending work must not look billable");
});

test("over-invoicing surfaces explicitly rather than going negative", () => {
  const r = computeProjectFinancials({
    baselineCents: $(20000),
    invoices: [invoice("Sent", 25000)],
  });
  assert.strictEqual(r.uninvoicedApprovedCents, 0);
  assert.strictEqual(r.overInvoicedCents, $(5000));
});

/* ---------------- payments ---------------- */

console.log("\nPayments");

test("payments are summed from the payment records", () =>
  assert.strictEqual(paidOnInvoice(invoice("Sent", 5000, [1000, 2000])), $(3000)));

test("a partial payment leaves an outstanding balance", () => {
  const r = computeProjectFinancials({
    baselineCents: $(21500),
    invoices: [invoice("Partially Paid", 15000, [12000])],
  });
  assert.strictEqual(r.paidCents, $(12000));
  assert.strictEqual(r.outstandingInvoicedCents, $(3000));
});

test("a fully paid invoice leaves nothing outstanding", () => {
  const r = computeProjectFinancials({
    baselineCents: $(20000),
    invoices: [invoice("Paid in Full", 10000, [10000])],
  });
  assert.strictEqual(r.outstandingInvoicedCents, 0);
});

test("a payment never changes approved agreement value", () => {
  const withoutPayment = computeProjectFinancials({
    baselineCents: $(20000),
    changeOrders: [co("Executed", 2000)],
    invoices: [invoice("Sent", 10000)],
  });
  const withPayment = computeProjectFinancials({
    baselineCents: $(20000),
    changeOrders: [co("Executed", 2000)],
    invoices: [invoice("Partially Paid", 10000, [7500])],
  });
  assert.strictEqual(withPayment.approvedAgreementCents, withoutPayment.approvedAgreementCents);
  assert.strictEqual(withPayment.uninvoicedApprovedCents, withoutPayment.uninvoicedApprovedCents);
});

test("payments on voided invoices do not count as collected", () => {
  const r = computeProjectFinancials({
    baselineCents: $(20000),
    invoices: [invoice("Voided", 5000, [5000])],
  });
  assert.strictEqual(r.paidCents, 0);
  assert.strictEqual(r.invoicedCents, 0);
});

test("a change order is never counted as a payment", () => {
  const r = computeProjectFinancials({
    baselineCents: $(20000),
    changeOrders: [co("Executed", 2000)],
    invoices: [],
  });
  assert.strictEqual(r.paidCents, 0);
});

/* ---------------- invoice context ---------------- */

console.log("\nInvoice creation context");

const CONTRACT = { _id: "abc", contractNumber: "000010", version: 3, adjustedContractPriceCents: $(20000) };

test("a new invoice sees approved value including executed change orders", () => {
  const ctx = buildInvoiceFinancialContext({
    contract: CONTRACT,
    changeOrders: [co("Executed", 2000), co("Executed", 500, "deduct"), co("Sent", 4000)],
    invoices: [invoice("Sent", 10000)],
  });
  assert.strictEqual(ctx.approvedAgreementCents, $(21500), "this is the defect being fixed");
  assert.strictEqual(ctx.originalAgreementCents, $(20000));
  assert.strictEqual(ctx.previouslyInvoicedCents, $(10000));
  assert.strictEqual(ctx.uninvoicedApprovedCents, $(11500));
});

test("only executed change orders are itemised on an invoice", () => {
  const ctx = buildInvoiceFinancialContext({
    contract: CONTRACT,
    changeOrders: [co("Executed", 2000), co("Sent", 4000), co("Declined", 9000)],
  });
  assert.strictEqual(ctx.executedChangeOrders.length, 1);
  assert.strictEqual(ctx.executedChangeOrders[0].netAdjustmentCents, $(2000));
});

test("the agreement version is captured for traceability", () =>
  assert.strictEqual(buildInvoiceFinancialContext({ contract: CONTRACT }).agreementVersion, 3));

test("a contract without an adjusted price falls back to its total", () =>
  assert.strictEqual(
    buildInvoiceFinancialContext({ contract: { totalPriceCents: $(15000) } }).originalAgreementCents,
    $(15000)
  ));

/* ---------------- edges ---------------- */

console.log("\nEdges");

test("zero values are handled without NaN", () => {
  const r = computeProjectFinancials({ baselineCents: 0, changeOrders: [], invoices: [] });
  for (const [k, v] of Object.entries(r)) assert.ok(Number.isFinite(v), `${k} is not finite`);
});

test("large values stay exact in integer cents", () => {
  const r = computeProjectFinancials({
    baselineCents: $(2500000),
    changeOrders: [co("Executed", 125000)],
    invoices: [invoice("Sent", 1000000, [750000])],
  });
  assert.strictEqual(r.approvedAgreementCents, $(2625000));
  assert.strictEqual(r.outstandingInvoicedCents, $(250000));
});

test("a legacy invoice with no payments array does not throw", () => {
  const r = computeProjectFinancials({
    baselineCents: $(20000),
    invoices: [{ status: "Sent", invoiceTotalCents: $(5000) }],
  });
  assert.strictEqual(r.paidCents, 0);
  assert.strictEqual(r.invoicedCents, $(5000));
});

test("missing or malformed input degrades to zeros rather than throwing", () => {
  const r = computeProjectFinancials();
  assert.strictEqual(r.approvedAgreementCents, 0);
  assert.strictEqual(r.invoicedCents, 0);
});

/* ---------------- snapshots and immutability ---------------- */

console.log("\nEstimate snapshot");

test("an estimate converts dollars to cents once, at the boundary", () => {
  const snap = buildEstimateSnapshot({
    estimateNumber: "EST-0007",
    title: "Bathroom proposal",
    total: 20000.5,
    lineItems: [1, 2, 3],
  });
  assert.strictEqual(snap.totalCents, 2000050);
  assert.strictEqual(snap.estimateNumber, "EST-0007");
  assert.strictEqual(snap.lineItemCount, 3);
  assert.ok(snap.importedAt instanceof Date);
});

test("no estimate yields no snapshot rather than a fabricated one", () =>
  assert.strictEqual(buildEstimateSnapshot(null), null));

test("a malformed estimate total does not become NaN cents", () =>
  assert.strictEqual(buildEstimateSnapshot({ total: undefined }).totalCents, 0));

console.log("\nInvoice snapshot immutability");

const AGREEMENT = {
  _id: "agr1",
  contractNumber: "000010",
  version: 1,
  adjustedContractPriceCents: $(20000),
};

test("an old invoice does not move when a change order executes later", () => {
  // Invoice #1 issued while approved value is $20,000.
  const snapshotAtIssue = freezeInvoiceSnapshot(
    buildInvoiceFinancialContext({ contract: AGREEMENT, changeOrders: [], invoices: [] }),
    []
  );
  assert.strictEqual(snapshotAtIssue.approvedAgreementCents, $(20000));

  // Later a +$5,000 change order executes. The frozen snapshot is untouched.
  const later = [{ ...co("Executed", 5000), _id: "co1" }];
  assert.strictEqual(snapshotAtIssue.approvedAgreementCents, $(20000));
  assert.strictEqual(snapshotAtIssue.executedChangeOrders.length, 0);

  // A new invoice created now sees $25,000.
  const contextLater = buildInvoiceFinancialContext({
    contract: AGREEMENT,
    changeOrders: later,
    invoices: [invoice("Sent", 20000)],
  });
  assert.strictEqual(contextLater.approvedAgreementCents, $(25000));
  assert.strictEqual(contextLater.previouslyInvoicedCents, $(20000));
});

test("a frozen snapshot captures change order ids for traceability", () => {
  const changeOrders = [{ ...co("Executed", 2000), _id: "co-abc" }];
  const snap = freezeInvoiceSnapshot(
    buildInvoiceFinancialContext({ contract: AGREEMENT, changeOrders }),
    changeOrders
  );
  assert.strictEqual(snap.executedChangeOrders.length, 1);
  assert.strictEqual(snap.executedChangeOrders[0].changeOrderId, "co-abc");
  assert.strictEqual(snap.executedChangeOrders[0].netAdjustmentCents, $(2000));
});

test("a deduction is frozen as a negative amount, not an absolute one", () => {
  const changeOrders = [{ ...co("Executed", 500, "deduct"), _id: "co-d" }];
  const snap = freezeInvoiceSnapshot(
    buildInvoiceFinancialContext({ contract: AGREEMENT, changeOrders }),
    changeOrders
  );
  assert.strictEqual(snap.executedChangeOrders[0].netAdjustmentCents, -$(500));
  assert.strictEqual(snap.approvedAgreementCents, $(19500));
});

test("a pending change order is never frozen into an issued invoice", () => {
  const changeOrders = [{ ...co("Sent", 4000), _id: "co-p" }];
  const snap = freezeInvoiceSnapshot(
    buildInvoiceFinancialContext({ contract: AGREEMENT, changeOrders }),
    changeOrders
  );
  assert.strictEqual(snap.executedChangeOrders.length, 0);
  assert.strictEqual(snap.approvedAgreementCents, $(20000));
});

test("the snapshot is stamped with a capture time", () => {
  const snap = freezeInvoiceSnapshot(buildInvoiceFinancialContext({ contract: AGREEMENT }), []);
  assert.ok(snap.capturedAt instanceof Date);
});

test("a historical invoice with no snapshot still aggregates correctly", () => {
  // Invoices issued before the snapshot field existed have no such field.
  const legacy = {
    status: "Sent",
    invoiceTotalCents: $(8000),
    payments: [{ amountCents: $(3000) }],
  };
  const r = computeProjectFinancials({ baselineCents: $(20000), invoices: [legacy] });
  assert.strictEqual(r.invoicedCents, $(8000));
  assert.strictEqual(r.paidCents, $(3000));
  assert.strictEqual(r.outstandingInvoicedCents, $(5000));
});

console.log(`\n${passed} passed, ${failures.length} failed.`);
if (failures.length) {
  for (const f of failures) console.error(`\n${f.name}\n${f.err.stack}`);
  process.exit(1);
}
process.exit(0);
