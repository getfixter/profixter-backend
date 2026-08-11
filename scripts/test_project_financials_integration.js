/**
 * Project financial chain — real-model, real-route integration tests.
 *
 * test_project_financials.js proves the arithmetic in isolation. This suite
 * proves the WIRING: real Mongoose models, the real Express routers, real
 * validation and the real PDF renderer, against an in-memory MongoDB with only
 * S3, email and admin auth injected.
 *
 * What it is really guarding:
 *
 *   1. a new Invoice is created against the agreement PLUS its executed change
 *      orders, not the agreement price alone - the original defect;
 *   2. an issued Invoice never changes its financial story afterwards, no
 *      matter what executes later;
 *   3. approved, invoiced and paid stay three separate numbers.
 *
 *   node scripts/test_project_financials_integration.js
 *
 * Not part of `npm test`: it boots a MongoDB binary, which is too heavy and too
 * network-dependent for the deploy gate.
 */

process.env.S3_BUCKET = process.env.S3_BUCKET || "test-bucket";

const assert = require("assert");

/* ------------------------------------------------------------------ */
/* Injected dependencies                                               */
/* ------------------------------------------------------------------ */

const s3Store = new Map();
const fakeS3 = {
  async putPrivateObject({ Key, Body }) {
    s3Store.set(Key, Buffer.from(Body));
    return { Key };
  },
  async getObjectBuffer({ Key }) {
    if (!s3Store.has(Key)) throw new Error(`Missing object: ${Key}`);
    return s3Store.get(Key);
  },
  async putPublicObject() {
    throw new Error("Invoices must never be written to a public object");
  },
};

const emails = [];
const fakeEmail = {
  async sendRaw(payload) {
    emails.push(payload);
    return { messageId: `test-${emails.length}` };
  },
  async sendTx() {
    return { messageId: "tx" };
  },
};

const ADMIN = { id: null, email: "admin@profixter.com" };
const fakeAuth = (req, _res, next) => {
  req.user = { id: ADMIN.id };
  req.authUser = { email: ADMIN.email, role: "admin" };
  req.accessUser = { email: ADMIN.email };
  next();
};
const fakeAuthorize = {
  PERMISSIONS: { ADMIN: "admin" },
  requirePermission: () => [(_req, _res, next) => next()],
};

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
stub("../utils/s3", fakeS3);
stub("../utils/emailService", fakeEmail);
stub("../middleware/auth", fakeAuth);
stub("../middleware/authorize", fakeAuthorize);
stub("../utils/adminActivityLog", {
  async createAdminActivityLog() {
    return null;
  },
  async markAdminActivityLog() {
    return null;
  },
});

const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const Project = require("../models/Project");
const Contract = require("../models/Contract");
const ChangeOrder = require("../models/ChangeOrder");
const Estimate = require("../models/Estimate");
const Invoice = require("../models/Invoice");
const { getProjectFinancialSummary } = require("../utils/projectFinancialsService");

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

/** Dollars to cents, so the tests read in money and assert in cents. */
const $ = (dollars) => Math.round(dollars * 100);

/**
 * The words actually printed on a PDF page.
 *
 * Asserting on raw bytes proves nothing: pdfkit deflates its content streams
 * and writes text as hex runs broken up by kerning offsets, so a naive
 * `includes()` on the buffer silently passes for text that is not there. This
 * inflates each stream and reassembles the show-text arrays, so a claim that
 * an invoice does NOT mention later work is a claim about the rendered page.
 */
function pdfText(buffer) {
  const zlib = require("zlib");
  const latin = buffer.toString("latin1");
  const parts = [];
  const streamStart = /stream\r?\n/g;
  let match;
  while ((match = streamStart.exec(latin))) {
    const start = match.index + match[0].length;
    const end = latin.indexOf("endstream", start);
    if (end < 0) continue;
    try {
      parts.push(zlib.inflateSync(Buffer.from(latin.slice(start, end), "latin1")).toString("latin1"));
    } catch {
      // Not a deflated content stream (an embedded font, for example).
    }
  }
  return parts
    .join("\n")
    .replace(/\[((?:\s*<[0-9A-Fa-f]*>|\s*-?[\d.]+)*)\s*\]\s*TJ/g, (_full, body) =>
      [...body.matchAll(/<([0-9A-Fa-f]*)>/g)]
        .map(([, hex]) => Buffer.from(hex, "hex").toString("latin1"))
        .join("")
    );
}
const OID = () => new mongoose.Types.ObjectId();

let base = "";
let sequence = 0;

const api = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
};

async function makeProject() {
  sequence += 1;
  return Project.create({
    projectNumber: `TEST-${String(sequence).padStart(4, "0")}`,
    status: "In Progress",
    customerName: "Konstantinos Papadopoulos-Wetherington III",
    email: "konstantinos@example.com",
    phone: "6315991363",
    address: "1487 Sunrise Highway, Bay Shore, NY 11706",
    projectType: "Kitchen",
    createdBy: ADMIN.id,
  });
}

async function makeAgreement(project, priceCents, options = {}) {
  return Contract.create({
    projectId: project._id,
    version: 1,
    current: true,
    status: options.status || "Generated",
    customerSnapshot: { fullName: project.customerName, email: project.email },
    propertySnapshot: { address: project.address },
    workType: "Kitchen",
    projectDescription: "Full kitchen remodel",
    scopeText: "Demolition, cabinetry, counters, appliances.",
    originalContractPriceCents: priceCents,
    totalPriceCents: priceCents,
    adjustedContractPriceCents: priceCents,
    depositAmountCents: 0,
    remainingBalanceCents: priceCents,
    dates: { contractDate: new Date("2026-06-01") },
    generatedPdf: { key: "agreement.pdf", fileName: "agreement.pdf" },
    createdBy: ADMIN.id,
    ...(options.estimateId ? { estimateId: options.estimateId } : {}),
    ...(options.estimateSnapshot ? { estimateSnapshot: options.estimateSnapshot } : {}),
  });
}

/**
 * A change order in a given state. `amount` is a magnitude; `direction`
 * carries the intent, exactly as the admin enters it.
 */
async function makeChangeOrder(contract, { amount, direction = "add", status = "Executed", title = "Change" }) {
  const seq = await ChangeOrder.nextSequence(contract.contractNumber);
  const order = new ChangeOrder({
    changeOrderNumber: ChangeOrder.formatNumber(contract.contractNumber, seq),
    sequence: seq,
    projectId: contract.projectId,
    contractId: contract._id,
    status: "Draft",
    title,
    contractSnapshot: {
      contractNumber: contract.contractNumber,
      originalContractAmountCents: contract.adjustedContractPriceCents,
    },
    lines: [{ description: title, direction, amountCents: Math.abs(amount) }],
    contractAmountBeforeChangeCents: contract.adjustedContractPriceCents,
    createdBy: ADMIN.id,
  });
  await order.save();
  if (status !== "Draft") {
    order.status = status;
    if (status === "Executed") order.executedAt = new Date();
    await order.save();
  }
  return order;
}

async function createInvoiceFromAgreement(project, body = {}) {
  return api("POST", `/api/admin/projects/${project._id}/invoices/draft`, {
    createFromContract: true,
    ...body,
  });
}

/** Move an invoice from draft to issued the way the product does: email it. */
async function issueInvoice(project, invoiceId) {
  const generated = await api("POST", `/api/admin/invoices/${invoiceId}/generate`, {
    projectId: String(project._id),
  });
  assert.strictEqual(generated.status, 200, JSON.stringify(generated.json));
  const emailed = await api("POST", `/api/admin/invoices/${invoiceId}/email`, {
    projectId: String(project._id),
    recipient: "konstantinos@example.com",
  });
  assert.strictEqual(emailed.status, 200, JSON.stringify(emailed.json));
  return emailed.json.invoice;
}

async function summaryFor(project) {
  const res = await api("GET", `/api/admin/projects/${project._id}/financials`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.json));
  return res.json;
}

async function main() {
  const server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
  ADMIN.id = OID();

  const app = express();
  app.use(express.json());
  app.use("/api/admin/projects", require("../routes/projects"));
  app.use("/api/admin/contracts", require("../routes/adminContracts"));
  app.use("/api/admin/invoices", require("../routes/adminInvoices"));
  // The invoice routes read the project id from the body or query; this alias
  // lets the tests express "create an invoice on THIS project" directly.
  app.use("/api/admin/projects/:projectId/invoices", (req, _res, next) => {
    req.url = `/project/${req.params.projectId}${req.url}`;
    next();
  }, require("../routes/adminInvoices"));

  const httpServer = app.listen(0);
  await new Promise((resolve) => httpServer.once("listening", resolve));
  base = `http://127.0.0.1:${httpServer.address().port}`;

  /* ---------------- Estimate to Agreement ---------------- */

  console.log("\nEstimate to Agreement");

  await test("an Agreement created from an Estimate records the link and freezes the proposal", async () => {
    const project = await makeProject();
    const estimate = await Estimate.create({
      projectId: project._id,
      title: "Kitchen proposal",
      lineItems: [
        { description: "Cabinetry", quantity: 1, unitPrice: 12000 },
        { description: "Counters", quantity: 1, unitPrice: 8000 },
      ],
      createdBy: ADMIN.id,
    });

    const res = await api("POST", `/api/admin/contracts/project/${project._id}/draft`, {
      estimateId: String(estimate._id),
      customerSnapshot: { fullName: project.customerName, email: project.email },
      propertySnapshot: { address: project.address },
      workType: "Kitchen",
      projectDescription: "Full kitchen remodel",
      scopeText: "Demolition, cabinetry, counters, appliances.",
      totalPriceCents: $(20000),
      depositAmountCents: 0,
      dates: { contractDate: "2026-06-01" },
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.json));

    const saved = await Contract.findById(res.json.contract.id).lean();
    assert.strictEqual(String(saved.estimateId), String(estimate._id));
    assert.strictEqual(saved.estimateSnapshot.estimateNumber, estimate.estimateNumber);
    assert.strictEqual(saved.estimateSnapshot.totalCents, $(20000));
    assert.strictEqual(saved.estimateSnapshot.lineItemCount, 2);
    assert.ok(saved.estimateSnapshot.importedAt);
  });

  await test("editing the Estimate afterwards does not move the Agreement's frozen copy", async () => {
    const project = await makeProject();
    const estimate = await Estimate.create({
      projectId: project._id,
      title: "Original proposal",
      lineItems: [{ description: "Work", quantity: 1, unitPrice: 15000 }],
      createdBy: ADMIN.id,
    });
    const created = await api("POST", `/api/admin/contracts/project/${project._id}/draft`, {
      estimateId: String(estimate._id),
      customerSnapshot: { fullName: project.customerName },
      propertySnapshot: { address: project.address },
      workType: "Kitchen",
      projectDescription: "Remodel",
      scopeText: "Scope",
      totalPriceCents: $(15000),
      depositAmountCents: 0,
      dates: { contractDate: "2026-06-01" },
    });
    assert.strictEqual(created.status, 201, JSON.stringify(created.json));

    estimate.title = "Revised proposal";
    estimate.lineItems = [{ description: "Work", quantity: 1, unitPrice: 99000 }];
    await estimate.save();

    // Re-saving the Agreement draft must not re-import the changed Estimate.
    await api("POST", `/api/admin/contracts/project/${project._id}/draft`, {
      contractId: created.json.contract.id,
      estimateId: String(estimate._id),
      customerSnapshot: { fullName: project.customerName },
      propertySnapshot: { address: project.address },
      workType: "Kitchen",
      projectDescription: "Remodel",
      scopeText: "Scope",
      totalPriceCents: $(15000),
      depositAmountCents: 0,
      dates: { contractDate: "2026-06-01" },
    });

    const saved = await Contract.findById(created.json.contract.id).lean();
    assert.strictEqual(saved.estimateSnapshot.title, "Original proposal");
    assert.strictEqual(saved.estimateSnapshot.totalCents, $(15000));
  });

  await test("an Agreement without an Estimate is entirely unaffected", async () => {
    const project = await makeProject();
    const agreement = await makeAgreement(project, $(20000));
    assert.strictEqual(agreement.estimateId, null);
    const summary = await summaryFor(project);
    assert.strictEqual(summary.agreement.estimate, null);
    assert.strictEqual(summary.totals.approvedAgreementCents, $(20000));
  });

  await test("an Estimate belonging to another project is refused", async () => {
    const project = await makeProject();
    const other = await makeProject();
    const estimate = await Estimate.create({
      projectId: other._id,
      title: "Someone else's proposal",
      lineItems: [{ description: "Work", quantity: 1, unitPrice: 100 }],
      createdBy: ADMIN.id,
    });
    const res = await api("POST", `/api/admin/contracts/project/${project._id}/draft`, {
      estimateId: String(estimate._id),
      customerSnapshot: { fullName: project.customerName },
      propertySnapshot: { address: project.address },
      workType: "Kitchen",
      projectDescription: "Remodel",
      scopeText: "Scope",
      totalPriceCents: $(100),
      depositAmountCents: 0,
      dates: { contractDate: "2026-06-01" },
    });
    assert.strictEqual(res.status, 404);
  });

  /* ---------------- Agreement + Change Orders ---------------- */

  console.log("\nAgreement and Change Orders");

  await test("an Agreement with no change orders is approved at its own value", async () => {
    const project = await makeProject();
    await makeAgreement(project, $(20000));
    const { totals } = await summaryFor(project);
    assert.strictEqual(totals.originalAgreementCents, $(20000));
    assert.strictEqual(totals.executedChangeOrderCents, 0);
    assert.strictEqual(totals.approvedAgreementCents, $(20000));
    assert.strictEqual(totals.projectedAgreementCents, $(20000));
  });

  await test("an executed addition raises the approved value", async () => {
    const project = await makeProject();
    const agreement = await makeAgreement(project, $(20000));
    await makeChangeOrder(agreement, { amount: $(1500), direction: "add" });
    const { totals } = await summaryFor(project);
    assert.strictEqual(totals.executedChangeOrderCents, $(1500));
    assert.strictEqual(totals.approvedAgreementCents, $(21500));
  });

  await test("an executed deduction lowers the approved value", async () => {
    const project = await makeProject();
    const agreement = await makeAgreement(project, $(20000));
    await makeChangeOrder(agreement, { amount: $(500), direction: "deduct" });
    const { totals } = await summaryFor(project);
    assert.strictEqual(totals.executedChangeOrderCents, -$(500));
    assert.strictEqual(totals.approvedAgreementCents, $(19500));
  });

  await test("a no-cost change order moves no money but is still recorded", async () => {
    const project = await makeProject();
    const agreement = await makeAgreement(project, $(20000));
    await makeChangeOrder(agreement, { amount: 0, direction: "none", title: "Schedule shift" });
    const { totals, changeOrders } = await summaryFor(project);
    assert.strictEqual(totals.approvedAgreementCents, $(20000));
    assert.strictEqual(totals.executedChangeOrderCount, 1);
    assert.strictEqual(changeOrders.executed.length, 1);
  });

  await test("multiple executed change orders net correctly", async () => {
    const project = await makeProject();
    const agreement = await makeAgreement(project, $(20000));
    await makeChangeOrder(agreement, { amount: $(2000), direction: "add" });
    await makeChangeOrder(agreement, { amount: $(500), direction: "deduct" });
    await makeChangeOrder(agreement, { amount: $(750), direction: "add" });
    const { totals } = await summaryFor(project);
    assert.strictEqual(totals.executedChangeOrderCents, $(2250));
    assert.strictEqual(totals.approvedAgreementCents, $(22250));
  });

  await test("a pending change order is projected, never approved", async () => {
    const project = await makeProject();
    const agreement = await makeAgreement(project, $(20000));
    await makeChangeOrder(agreement, { amount: $(4000), direction: "add", status: "Sent" });
    const { totals } = await summaryFor(project);
    assert.strictEqual(totals.approvedAgreementCents, $(20000));
    assert.strictEqual(totals.pendingChangeOrderCents, $(4000));
    assert.strictEqual(totals.projectedAgreementCents, $(24000));
  });

  await test("draft, declined and voided change orders affect nothing", async () => {
    const project = await makeProject();
    const agreement = await makeAgreement(project, $(20000));
    await makeChangeOrder(agreement, { amount: $(9000), direction: "add", status: "Draft" });
    await makeChangeOrder(agreement, { amount: $(9000), direction: "add", status: "Declined" });
    await makeChangeOrder(agreement, { amount: $(9000), direction: "add", status: "Voided" });
    const { totals } = await summaryFor(project);
    assert.strictEqual(totals.approvedAgreementCents, $(20000));
    assert.strictEqual(totals.projectedAgreementCents, $(20000));
  });

  await test("a change order raised against v1 still counts after the Agreement is revised", async () => {
    const project = await makeProject();
    const v1 = await makeAgreement(project, $(20000));
    await makeChangeOrder(v1, { amount: $(1500), direction: "add", title: "Recessed lighting" });

    // The Agreement is revised. v2 becomes the document of record.
    await Contract.updateOne({ _id: v1._id }, { $set: { current: false } });
    await Contract.create({
      contractNumber: v1.contractNumber,
      version: 2,
      current: true,
      status: "Generated",
      projectId: project._id,
      customerSnapshot: { fullName: project.customerName },
      propertySnapshot: { address: project.address },
      workType: "Kitchen",
      projectDescription: "Full kitchen remodel",
      scopeText: "Revised scope.",
      originalContractPriceCents: $(21000),
      totalPriceCents: $(21000),
      depositAmountCents: 0,
      dates: { contractDate: new Date("2026-07-01") },
      createdBy: ADMIN.id,
    });

    const { totals, agreement } = await summaryFor(project);
    assert.strictEqual(agreement.version, 2);
    // The executed amendment did not evaporate when the Agreement was revised.
    assert.strictEqual(totals.executedChangeOrderCents, $(1500));
    assert.strictEqual(totals.approvedAgreementCents, $(22500));
  });

  await test("the current issued Agreement wins over a draft started on top of it", async () => {
    const project = await makeProject();
    const issued = await makeAgreement(project, $(20000));
    await Contract.updateOne({ _id: issued._id }, { $set: { current: false } });
    await Contract.create({
      contractNumber: issued.contractNumber,
      version: 2,
      current: true,
      status: "Draft",
      projectId: project._id,
      customerSnapshot: { fullName: project.customerName },
      propertySnapshot: { address: project.address },
      workType: "Kitchen",
      projectDescription: "Remodel",
      scopeText: "Scope",
      originalContractPriceCents: $(99000),
      totalPriceCents: $(99000),
      depositAmountCents: 0,
      dates: { contractDate: new Date("2026-07-01") },
      createdBy: ADMIN.id,
    });

    const { totals, agreement } = await summaryFor(project);
    assert.strictEqual(agreement.isBinding, true);
    assert.strictEqual(agreement.version, 1);
    assert.strictEqual(totals.approvedAgreementCents, $(20000), "an unissued draft is not approved money");
  });

  /* ---------------- Invoice creation ---------------- */

  console.log("\nInvoice creation");

  await test("a new invoice is created against the CO-aware approved value", async () => {
    const project = await makeProject();
    const agreement = await makeAgreement(project, $(20000));
    await makeChangeOrder(agreement, { amount: $(1500), direction: "add", title: "Recessed lighting" });

    const res = await createInvoiceFromAgreement(project);
    assert.strictEqual(res.status, 201, JSON.stringify(res.json));
    // The original defect: this used to be $20,000, silently omitting the CO.
    assert.strictEqual(res.json.invoice.invoiceTotalCents, $(21500));
    assert.strictEqual(res.json.invoice.projectFinancialSnapshot.approvedAgreementCents, $(21500));
  });

  await test("a deduction change order bills as a credit, not a negative line", async () => {
    const project = await makeProject();
    const agreement = await makeAgreement(project, $(20000));
    await makeChangeOrder(agreement, { amount: $(500), direction: "deduct", title: "Tile allowance removed" });

    const res = await createInvoiceFromAgreement(project);
    assert.strictEqual(res.status, 201, JSON.stringify(res.json));
    assert.strictEqual(res.json.invoice.invoiceTotalCents, $(19500));
    assert.strictEqual(res.json.invoice.discounts.length, 1);
    assert.strictEqual(res.json.invoice.discounts[0].type, "credit");
  });

  await test("a pending change order is never billed", async () => {
    const project = await makeProject();
    const agreement = await makeAgreement(project, $(20000));
    await makeChangeOrder(agreement, { amount: $(4000), direction: "add", status: "Awaiting Signature" });
    const res = await createInvoiceFromAgreement(project);
    assert.strictEqual(res.json.invoice.invoiceTotalCents, $(20000));
    assert.strictEqual(res.json.invoice.projectFinancialSnapshot.executedChangeOrders.length, 0);
  });

  await test("a partial amount invoice bills what the admin asked for, not the approved value", async () => {
    const project = await makeProject();
    await makeAgreement(project, $(20000));
    const res = await createInvoiceFromAgreement(project, {
      billing: { mode: "amount", amountCents: $(5000), label: "Deposit" },
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.json));
    assert.strictEqual(res.json.invoice.invoiceTotalCents, $(5000));
    assert.strictEqual(res.json.invoice.projectFinancialSnapshot.approvedAgreementCents, $(20000));
  });

  await test("a partial amount invoice refuses a zero amount rather than billing nothing", async () => {
    const project = await makeProject();
    await makeAgreement(project, $(20000));
    const res = await createInvoiceFromAgreement(project, { billing: { mode: "amount", amountCents: 0 } });
    assert.strictEqual(res.status, 400);
  });

  await test("several invoices can be raised against one agreement", async () => {
    const project = await makeProject();
    await makeAgreement(project, $(20000));
    const first = await createInvoiceFromAgreement(project, {
      billing: { mode: "amount", amountCents: $(6000), label: "Deposit" },
    });
    await issueInvoice(project, first.json.invoice.id);
    const second = await createInvoiceFromAgreement(project, {
      billing: { mode: "amount", amountCents: $(4000), label: "Progress payment" },
    });
    assert.strictEqual(second.status, 201, JSON.stringify(second.json));
    assert.strictEqual(second.json.invoice.projectFinancialSnapshot.previouslyInvoicedCents, $(6000));
  });

  await test("the remaining balance mode bills exactly the approved value not yet invoiced", async () => {
    const project = await makeProject();
    const agreement = await makeAgreement(project, $(20000));
    await makeChangeOrder(agreement, { amount: $(1500), direction: "add" });
    const first = await createInvoiceFromAgreement(project, {
      billing: { mode: "amount", amountCents: $(15000), label: "Progress payment" },
    });
    await issueInvoice(project, first.json.invoice.id);

    const final = await createInvoiceFromAgreement(project, { billing: { mode: "remaining" } });
    assert.strictEqual(final.status, 201, JSON.stringify(final.json));
    assert.strictEqual(final.json.invoice.invoiceTotalCents, $(6500));
  });

  await test("change-order-only billing invoices the change orders alone", async () => {
    const project = await makeProject();
    const agreement = await makeAgreement(project, $(20000));
    const co = await makeChangeOrder(agreement, { amount: $(1500), direction: "add", title: "Recessed lighting" });
    const res = await createInvoiceFromAgreement(project, {
      billing: { mode: "changeOrders", changeOrderIds: [String(co._id)] },
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.json));
    assert.strictEqual(res.json.invoice.invoiceTotalCents, $(1500));
    assert.strictEqual(res.json.invoice.lineItems[0].category, "Change order");
  });

  await test("importing the same agreement twice at full value is refused", async () => {
    const project = await makeProject();
    await makeAgreement(project, $(20000));
    const first = await createInvoiceFromAgreement(project);
    assert.strictEqual(first.status, 201);
    const second = await createInvoiceFromAgreement(project);
    assert.strictEqual(second.status, 409);
  });

  await test("an agreement percentage discount is frozen, not re-applied to change order work", async () => {
    const project = await makeProject();
    const agreement = await Contract.create({
      projectId: project._id,
      version: 1,
      current: true,
      status: "Generated",
      customerSnapshot: { fullName: project.customerName },
      propertySnapshot: { address: project.address },
      workType: "Kitchen",
      projectDescription: "Remodel",
      scopeText: "Scope",
      originalContractPriceCents: $(20000),
      totalPriceCents: $(20000),
      discounts: [{ name: "Repeat customer", type: "percentage", value: 1000, calculatedAmountCents: $(2000) }],
      depositAmountCents: 0,
      dates: { contractDate: new Date("2026-06-01") },
      createdBy: ADMIN.id,
    });
    assert.strictEqual(agreement.adjustedContractPriceCents, $(18000));
    await makeChangeOrder(agreement, { amount: $(5000), direction: "add" });

    const res = await createInvoiceFromAgreement(project);
    assert.strictEqual(res.status, 201, JSON.stringify(res.json));
    // 20,000 - 2,000 discount + 5,000 change order. A re-applied 10% would
    // have taken 2,500 off instead and understated the invoice by 500.
    assert.strictEqual(res.json.invoice.invoiceTotalCents, $(23000));
    assert.strictEqual(res.json.invoice.discounts[0].calculatedAmountCents, $(2000));
  });

  /* ---------------- Immutability ---------------- */

  console.log("\nHistorical immutability");

  await test("an issued invoice does not move when a change order executes later", async () => {
    const project = await makeProject();
    const agreement = await makeAgreement(project, $(20000));

    const first = await createInvoiceFromAgreement(project);
    assert.strictEqual(first.json.invoice.invoiceTotalCents, $(20000));
    await issueInvoice(project, first.json.invoice.id);

    await makeChangeOrder(agreement, { amount: $(5000), direction: "add", title: "Extra work" });

    const stored = await Invoice.findById(first.json.invoice.id).lean();
    assert.strictEqual(stored.projectFinancialSnapshot.approvedAgreementCents, $(20000));
    assert.strictEqual(stored.projectFinancialSnapshot.executedChangeOrders.length, 0);
    assert.strictEqual(stored.invoiceTotalCents, $(20000));

    const { totals } = await summaryFor(project);
    assert.strictEqual(totals.approvedAgreementCents, $(25000));
  });

  await test("regenerating an issued invoice's PDF does not rewrite its snapshot", async () => {
    const project = await makeProject();
    const agreement = await makeAgreement(project, $(20000));
    const first = await createInvoiceFromAgreement(project);
    await issueInvoice(project, first.json.invoice.id);
    await makeChangeOrder(agreement, { amount: $(5000), direction: "add" });

    const regenerated = await api("POST", `/api/admin/invoices/${first.json.invoice.id}/generate`, {
      projectId: String(project._id),
    });
    assert.strictEqual(regenerated.status, 200, JSON.stringify(regenerated.json));
    assert.strictEqual(regenerated.json.invoice.projectFinancialSnapshot.approvedAgreementCents, $(20000));
    assert.strictEqual(regenerated.json.invoice.projectFinancialSnapshot.executedChangeOrders.length, 0);
  });

  await test("the next invoice does see the later change order", async () => {
    const project = await makeProject();
    const agreement = await makeAgreement(project, $(20000));
    const first = await createInvoiceFromAgreement(project, {
      billing: { mode: "amount", amountCents: $(20000), label: "Agreement in full" },
    });
    await issueInvoice(project, first.json.invoice.id);

    await makeChangeOrder(agreement, { amount: $(5000), direction: "add", title: "Extra work" });

    const second = await createInvoiceFromAgreement(project, { billing: { mode: "remaining" } });
    assert.strictEqual(second.status, 201, JSON.stringify(second.json));
    assert.strictEqual(second.json.invoice.projectFinancialSnapshot.approvedAgreementCents, $(25000));
    assert.strictEqual(second.json.invoice.projectFinancialSnapshot.previouslyInvoicedCents, $(20000));
    assert.strictEqual(second.json.invoice.invoiceTotalCents, $(5000));
  });

  await test("a draft invoice still tracks reality until it is issued", async () => {
    const project = await makeProject();
    const agreement = await makeAgreement(project, $(20000));
    const draft = await createInvoiceFromAgreement(project, {
      billing: { mode: "amount", amountCents: $(1000), label: "Deposit" },
    });
    assert.strictEqual(draft.json.invoice.projectFinancialSnapshot.approvedAgreementCents, $(20000));

    await makeChangeOrder(agreement, { amount: $(3000), direction: "add" });
    const resaved = await api("POST", `/api/admin/projects/${project._id}/invoices/draft`, {
      invoiceId: draft.json.invoice.id,
      lineItems: draft.json.invoice.lineItems,
    });
    assert.strictEqual(resaved.status, 201, JSON.stringify(resaved.json));
    assert.strictEqual(resaved.json.invoice.projectFinancialSnapshot.approvedAgreementCents, $(23000));
  });

  await test("an invoice never counts itself as already invoiced", async () => {
    const project = await makeProject();
    await makeAgreement(project, $(20000));
    const draft = await createInvoiceFromAgreement(project, {
      billing: { mode: "amount", amountCents: $(5000), label: "Deposit" },
    });
    const resaved = await api("POST", `/api/admin/projects/${project._id}/invoices/draft`, {
      invoiceId: draft.json.invoice.id,
      lineItems: draft.json.invoice.lineItems,
    });
    assert.strictEqual(resaved.json.invoice.projectFinancialSnapshot.previouslyInvoicedCents, 0);
  });

  /* ---------------- Payments and aggregation ---------------- */

  console.log("\nPayments and aggregation");

  await test("a partial payment leaves an outstanding balance", async () => {
    const project = await makeProject();
    await makeAgreement(project, $(20000));
    const invoice = await createInvoiceFromAgreement(project);
    await issueInvoice(project, invoice.json.invoice.id);
    const paid = await api("POST", `/api/admin/invoices/${invoice.json.invoice.id}/payments`, {
      projectId: String(project._id),
      amountCents: $(12000),
      method: "Check",
    });
    assert.strictEqual(paid.status, 201, JSON.stringify(paid.json));

    const { totals } = await summaryFor(project);
    assert.strictEqual(totals.invoicedCents, $(20000));
    assert.strictEqual(totals.paidCents, $(12000));
    assert.strictEqual(totals.outstandingInvoicedCents, $(8000));
  });

  await test("payment in full clears the outstanding balance and nothing else", async () => {
    const project = await makeProject();
    await makeAgreement(project, $(20000));
    const invoice = await createInvoiceFromAgreement(project);
    await issueInvoice(project, invoice.json.invoice.id);
    await api("POST", `/api/admin/invoices/${invoice.json.invoice.id}/payments`, {
      projectId: String(project._id),
      amountCents: $(20000),
      method: "ACH / Bank Transfer",
    });

    const { totals } = await summaryFor(project);
    assert.strictEqual(totals.paidCents, $(20000));
    assert.strictEqual(totals.outstandingInvoicedCents, 0);
    // A payment must never move approved value.
    assert.strictEqual(totals.approvedAgreementCents, $(20000));
  });

  await test("a change order is not a payment", async () => {
    const project = await makeProject();
    const agreement = await makeAgreement(project, $(20000));
    await makeChangeOrder(agreement, { amount: $(3000), direction: "add" });
    const { totals } = await summaryFor(project);
    assert.strictEqual(totals.paidCents, 0);
    assert.strictEqual(totals.invoicedCents, 0);
    assert.strictEqual(totals.approvedAgreementCents, $(23000));
  });

  await test("a draft invoice is not billed and a voided one stops being billed", async () => {
    const project = await makeProject();
    await makeAgreement(project, $(20000));
    const draft = await createInvoiceFromAgreement(project, {
      billing: { mode: "amount", amountCents: $(4000), label: "Deposit" },
    });
    let { totals } = await summaryFor(project);
    assert.strictEqual(totals.invoicedCents, 0, "a draft is not a claim on the customer");

    await issueInvoice(project, draft.json.invoice.id);
    ({ totals } = await summaryFor(project));
    assert.strictEqual(totals.invoicedCents, $(4000));

    const voided = await api("POST", `/api/admin/invoices/${draft.json.invoice.id}/void`, {
      projectId: String(project._id),
      confirmation: "VOID",
      reason: "Issued in error",
    });
    assert.strictEqual(voided.status, 200, JSON.stringify(voided.json));
    ({ totals } = await summaryFor(project));
    assert.strictEqual(totals.invoicedCents, 0);
  });

  await test("payments recorded on a voided invoice do not inflate project paid totals", async () => {
    const project = await makeProject();
    await makeAgreement(project, $(20000));
    const invoice = await createInvoiceFromAgreement(project);
    await issueInvoice(project, invoice.json.invoice.id);
    await api("POST", `/api/admin/invoices/${invoice.json.invoice.id}/payments`, {
      projectId: String(project._id),
      amountCents: $(5000),
      method: "Cash",
    });
    await api("POST", `/api/admin/invoices/${invoice.json.invoice.id}/void`, {
      projectId: String(project._id),
      confirmation: "VOID",
      reason: "Wrong customer",
    });

    const { totals } = await summaryFor(project);
    assert.strictEqual(totals.invoicedCents, 0);
    assert.strictEqual(totals.paidCents, 0);
  });

  await test("two invoices are counted once each, not compounded", async () => {
    const project = await makeProject();
    await makeAgreement(project, $(20000));
    const first = await createInvoiceFromAgreement(project, {
      billing: { mode: "amount", amountCents: $(8000), label: "Deposit" },
    });
    await issueInvoice(project, first.json.invoice.id);
    const second = await createInvoiceFromAgreement(project, {
      billing: { mode: "amount", amountCents: $(7000), label: "Progress payment" },
    });
    await issueInvoice(project, second.json.invoice.id);

    const { totals } = await summaryFor(project);
    assert.strictEqual(totals.invoicedCents, $(15000));
    assert.strictEqual(totals.uninvoicedApprovedCents, $(5000));
    assert.strictEqual(totals.overInvoicedCents, 0);
  });

  await test("over-invoicing is reported, not hidden", async () => {
    const project = await makeProject();
    await makeAgreement(project, $(20000));
    const first = await createInvoiceFromAgreement(project);
    await issueInvoice(project, first.json.invoice.id);
    const extra = await createInvoiceFromAgreement(project, {
      billing: { mode: "amount", amountCents: $(3000), label: "Extra work billed early" },
    });
    assert.strictEqual(extra.status, 201, JSON.stringify(extra.json));
    assert.ok(
      extra.json.financialWarnings.some((warning) => warning.code === "over_invoiced"),
      "the admin must be warned"
    );
    await issueInvoice(project, extra.json.invoice.id);

    const { totals } = await summaryFor(project);
    assert.strictEqual(totals.invoicedCents, $(23000));
    assert.strictEqual(totals.overInvoicedCents, $(3000));
    assert.strictEqual(totals.uninvoicedApprovedCents, 0, "never a negative amount of remaining work");
  });

  /* ---------------- Legacy documents ---------------- */

  console.log("\nLegacy documents");

  await test("an invoice issued before snapshots existed still aggregates correctly", async () => {
    const project = await makeProject();
    await makeAgreement(project, $(20000));
    const legacy = await createInvoiceFromAgreement(project, {
      billing: { mode: "amount", amountCents: $(9000), label: "Legacy invoice" },
    });
    await issueInvoice(project, legacy.json.invoice.id);
    // Strip the snapshot to reproduce a document created before this feature.
    await Invoice.updateOne(
      { _id: legacy.json.invoice.id },
      { $unset: { projectFinancialSnapshot: "" } }
    );
    await api("POST", `/api/admin/invoices/${legacy.json.invoice.id}/payments`, {
      projectId: String(project._id),
      amountCents: $(4000),
      method: "Check",
    });

    const summary = await summaryFor(project);
    assert.strictEqual(summary.totals.invoicedCents, $(9000));
    assert.strictEqual(summary.totals.paidCents, $(4000));
    assert.strictEqual(summary.invoices[0].hasFinancialSnapshot, false);
  });

  await test("a legacy invoice PDF regenerates without inventing an agreement summary", async () => {
    const project = await makeProject();
    await makeAgreement(project, $(20000));
    const legacy = await createInvoiceFromAgreement(project, {
      billing: { mode: "amount", amountCents: $(9000), label: "Legacy invoice" },
    });
    await issueInvoice(project, legacy.json.invoice.id);
    await Invoice.updateOne(
      { _id: legacy.json.invoice.id },
      { $unset: { projectFinancialSnapshot: "" } }
    );

    const regenerated = await api("POST", `/api/admin/invoices/${legacy.json.invoice.id}/generate`, {
      projectId: String(project._id),
    });
    assert.strictEqual(regenerated.status, 200, JSON.stringify(regenerated.json));
    const stored = await Invoice.findById(legacy.json.invoice.id).lean();
    assert.ok(!stored.projectFinancialSnapshot?.capturedAt, "an issued invoice is never back-filled");
  });

  /* ---------------- PDF ---------------- */

  console.log("\nInvoice PDF");

  await test("the PDF prints the agreement position it was issued against", async () => {
    const project = await makeProject();
    const agreement = await makeAgreement(project, $(20000));
    await makeChangeOrder(agreement, { amount: $(1500), direction: "add", title: "Recessed lighting" });
    const invoice = await createInvoiceFromAgreement(project, {
      billing: { mode: "amount", amountCents: $(5000), label: "Progress payment" },
    });
    await issueInvoice(project, invoice.json.invoice.id);

    const key = [...s3Store.keys()].filter((k) => k.includes(String(invoice.json.invoice.id))).pop();
    const text = pdfText(s3Store.get(key));
    assert.ok(text.includes("AGREEMENT SUMMARY"), "the summary section is printed");
    assert.ok(text.includes("Original Agreement"));
    assert.ok(text.includes("CO-000010-01") || text.includes("Recessed lighting"));
    assert.ok(text.includes("Approved Agreement Value"));
    assert.ok(text.includes("$21,500.00"), "approved value at issue");
    assert.ok(text.includes("$5,000.00"), "the amount actually being billed");
  });

  await test("regenerating after a later change order does not leak it into the PDF", async () => {
    const project = await makeProject();
    const agreement = await makeAgreement(project, $(20000));
    const invoice = await createInvoiceFromAgreement(project);
    await issueInvoice(project, invoice.json.invoice.id);

    const issuedKey = [...s3Store.keys()].filter((k) => k.includes(String(invoice.json.invoice.id))).pop();
    const issuedText = pdfText(s3Store.get(issuedKey));
    assert.ok(issuedText.includes("$20,000.00"));
    assert.ok(!issuedText.includes("Later work"));

    await makeChangeOrder(agreement, { amount: $(5000), direction: "add", title: "Later work" });
    const regenerated = await api("POST", `/api/admin/invoices/${invoice.json.invoice.id}/generate`, {
      projectId: String(project._id),
    });
    assert.strictEqual(regenerated.status, 200, JSON.stringify(regenerated.json));

    const latestKey = [...s3Store.keys()].filter((k) => k.includes(String(invoice.json.invoice.id))).pop();
    const latestText = pdfText(s3Store.get(latestKey));
    assert.ok(!latestText.includes("Later work"), "an issued invoice must not tell today's story");
    assert.ok(!latestText.includes("$25,000.00"), "the later approved value must not appear");
    assert.ok(latestText.includes("$20,000.00"));
  });

  await test("a legacy invoice PDF prints no agreement summary at all", async () => {
    const project = await makeProject();
    await makeAgreement(project, $(20000));
    const legacy = await createInvoiceFromAgreement(project, {
      billing: { mode: "amount", amountCents: $(9000), label: "Legacy invoice" },
    });
    await issueInvoice(project, legacy.json.invoice.id);
    await Invoice.updateOne(
      { _id: legacy.json.invoice.id },
      { $unset: { projectFinancialSnapshot: "" } }
    );
    await api("POST", `/api/admin/invoices/${legacy.json.invoice.id}/generate`, {
      projectId: String(project._id),
    });

    const key = [...s3Store.keys()].filter((k) => k.includes(String(legacy.json.invoice.id))).pop();
    const text = pdfText(s3Store.get(key));
    assert.ok(!text.includes("AGREEMENT SUMMARY"), "nothing is invented for a document that never had it");
    assert.ok(text.includes("$9,000.00"), "the invoice itself renders exactly as before");
  });

  await test("the summary explains its numbers with the documents behind them", async () => {
    const project = await makeProject();
    const agreement = await makeAgreement(project, $(20000));
    await makeChangeOrder(agreement, { amount: $(1500), direction: "add", title: "Recessed lighting" });
    await makeChangeOrder(agreement, { amount: $(4000), direction: "add", status: "Sent", title: "Proposed deck" });
    const invoice = await createInvoiceFromAgreement(project, {
      billing: { mode: "amount", amountCents: $(10000), label: "Progress payment" },
    });
    await issueInvoice(project, invoice.json.invoice.id);

    const summary = await summaryFor(project);
    assert.strictEqual(summary.agreement.contractNumber, agreement.contractNumber);
    assert.strictEqual(summary.agreement.isBinding, true);
    assert.strictEqual(summary.changeOrders.executed.length, 1);
    assert.strictEqual(summary.changeOrders.executed[0].title, "Recessed lighting");
    assert.strictEqual(summary.changeOrders.pending.length, 1);
    assert.strictEqual(summary.invoices.length, 1);
    assert.strictEqual(summary.invoices[0].countsTowardInvoiced, true);
    assert.strictEqual(summary.totals.uninvoicedApprovedCents, $(11500));
  });

  await test("a project with nothing at all reports zeros rather than failing", async () => {
    const project = await makeProject();
    const summary = await summaryFor(project);
    assert.strictEqual(summary.agreement, null);
    assert.strictEqual(summary.totals.approvedAgreementCents, 0);
    assert.strictEqual(summary.totals.invoicedCents, 0);
  });

  await test("a draft agreement is reported but flagged as not yet binding", async () => {
    const project = await makeProject();
    await makeAgreement(project, $(20000), { status: "Draft" });
    const summary = await summaryFor(project);
    assert.strictEqual(summary.agreement.isBinding, false);
    assert.strictEqual(summary.totals.originalAgreementCents, $(20000));
  });

  /* ---------------- Direct service checks ---------------- */

  await test("the summary service agrees with the route it serves", async () => {
    const project = await makeProject();
    const agreement = await makeAgreement(project, $(20000));
    await makeChangeOrder(agreement, { amount: $(1500), direction: "add" });
    const direct = await getProjectFinancialSummary(project._id);
    const viaRoute = await summaryFor(project);
    assert.deepStrictEqual(direct.totals, viaRoute.totals);
  });

  console.log(`\n${passed} passed, ${failures.length} failed.`);

  await mongoose.disconnect();
  await server.stop();
  httpServer.close();

  if (failures.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
