/**
 * Renovation project workflow (admin audit 2026-11-12, P-08..P-13, W-10, W-11, H-3).
 *
 *   - lead -> project conversion copies every answer, links both ways, and is idempotent
 *   - lead list/detail return the full answers, lean (no password)
 *   - lead status: EstimateLead never gets a status its schema forbids (F24)
 *   - next steps derived from records, for each fixture state
 *   - overview shape, derived stage beside (never over) the manual status
 *   - deposit / milestone invoices from the signed agreement, billed once
 *   - visits, schedule, substantial completion + warranty, punch list
 *   - project search and the needs-action collectors
 *
 * Real routers over HTTP against an in-memory MongoDB; S3, email, auth and
 * the activity log are injected.
 *
 *   node scripts/test_project_workflow.js
 */

process.env.S3_BUCKET = process.env.S3_BUCKET || "test-bucket";
process.env.ESIGN_ALLOW_UNSIGNED_COMPANY = "true";

const assert = require("assert");

const s3Store = new Map();
const fakeS3 = {
  async putPrivateObject({ Key, Body }) {
    s3Store.set(Key, Buffer.from(Body));
    return { Key };
  },
  async getObjectBuffer({ Key }) {
    return s3Store.get(Key) || Buffer.from("%PDF-1.4 test");
  },
  async putPublicObject() {
    throw new Error("never public");
  },
};
const emails = [];
const fakeEmail = {
  ADMIN: "owner@profixter.test",
  FROM: "Profixter <no-reply@profixter.test>",
  REPLY_TO: "hello@profixter.test",
  async sendRaw(payload) {
    emails.push(payload);
    return { messageId: `m-${emails.length}` };
  },
  async sendTx() {
    return { messageId: "tx" };
  },
};
const activity = [];
const ADMIN = { id: null };
const fakeAuth = (req, _res, next) => {
  req.user = { id: ADMIN.id };
  req.authUser = { email: "admin@profixter.com", role: "admin", name: "Owner" };
  req.accessUser = { email: "admin@profixter.com", name: "Owner" };
  next();
};
const fakeAuthorize = {
  PERMISSIONS: {
    ADMIN: "admin",
    PROJECTS_MANAGE: "projects.manage",
    LEADS_MANAGE: "leads.manage",
  },
  requirePermission: () => [
    (req, _res, next) => {
      req.accessRole = "admin";
      req.permissions = [];
      next();
    },
  ],
  requireAnyPermission: () => [(_req, _res, next) => next()],
  hasPermission: () => true,
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
  async createAdminActivityLog(_req, payload) {
    activity.push(payload);
    return { _id: `log-${activity.length}` };
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
const Invoice = require("../models/Invoice");
const ESignature = require("../models/ESignature");
const Booking = require("../models/Booking");
const User = require("../models/User");
const Request = require("../models/Request");
const EstimateLead = require("../models/EstimateLead");
const { buildNextSteps, buildDerivedStage } = require("../utils/projects/projectWorkflow");
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

const OID = () => new mongoose.Types.ObjectId();
const DAY = 24 * 60 * 60 * 1000;
let base = "";
let seq = 0;

async function api(method, path, body) {
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
}

async function makeEstimateLead(overrides = {}) {
  return EstimateLead.create({
    service: "bathroom",
    name: "Maria Lopez",
    phone: "(631) 555-0142",
    email: "maria@example.com",
    address: "88 Bay Ave, Babylon NY 11702",
    contactPref: "text",
    bestTime: "evenings",
    notes: "Two kids, need it done before summer",
    estimateLow: 18000,
    estimateHigh: 26000,
    bathroomScope: "full",
    bathroomSize: "medium",
    bathroomItems: ["shower", "vanity", "tile"],
    bathroomFinish: "premium",
    bathroomPlumbing: "maybe",
    timeline: "1-3months",
    budgetRange: "$20k-$30k",
    financing: "maybe",
    ...overrides,
  });
}

async function makeProject(overrides = {}) {
  seq += 1;
  return Project.create({
    projectNumber: `TEST-PW-${String(seq).padStart(4, "0")}`,
    customerName: "Jane Homeowner",
    email: "jane@example.com",
    phone: "6315550100",
    address: "12 Ocean Ave, Lindenhurst NY",
    projectType: "Bathroom",
    ...overrides,
  });
}

async function makeContract(project, overrides = {}) {
  seq += 1;
  return Contract.create({
    contractNumber: `PW${String(seq).padStart(5, "0")}`,
    version: 1,
    current: true,
    projectId: project._id,
    status: "Signed",
    customerSnapshot: { fullName: project.customerName, email: project.email },
    propertySnapshot: { address: project.address },
    workType: "Bathroom",
    projectDescription: "Remodel",
    scopeText: "Scope",
    originalContractPriceCents: 2000000,
    totalPriceCents: 2000000,
    adjustedContractPriceCents: 2000000,
    depositAmountCents: 500000,
    remainingBalanceCents: 1500000,
    paymentSchedule: [
      { label: "Deposit", amountCents: 500000, dueCondition: "Upon signing", order: 0 },
      { label: "Rough-in complete", amountCents: 800000, dueCondition: "When plumbing rough-in passes", order: 1 },
      { label: "Final", amountCents: 700000, dueCondition: "At substantial completion", order: 2 },
    ],
    dates: { contractDate: new Date("2026-10-01") },
    generatedPdf: { key: "agreement.pdf", fileName: "agreement.pdf" },
    signedPdf: overrides.status && overrides.status !== "Signed" ? undefined : { key: "signed.pdf", fileName: "signed.pdf" },
    createdBy: ADMIN.id,
    ...overrides,
  });
}

async function makeInvoice(project, overrides = {}) {
  seq += 1;
  return Invoice.create({
    invoiceNumber: `PW${String(seq).padStart(6, "0")}`,
    projectId: project._id,
    status: "Sent",
    sentAt: new Date(),
    customerSnapshot: { fullName: project.customerName, email: project.email },
    projectSnapshot: { projectNumber: project.projectNumber, workType: "Bathroom" },
    propertySnapshot: { address: project.address },
    lineItems: [{ description: "Work", quantity: 1, unitPriceCents: 300000, totalCents: 300000, category: "Contract work" }],
    subtotalCents: 300000,
    invoiceTotalCents: 300000,
    remainingBalanceCents: 300000,
    dates: { invoiceDate: new Date(), dueDate: new Date(Date.now() + 14 * DAY) },
    createdBy: ADMIN.id,
    ...overrides,
  });
}

async function insertBooking(overrides = {}) {
  const doc = {
    _id: OID(),
    bookingNumber: `B-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    date: new Date(Date.now() + 3 * DAY),
    service: "Site visit",
    status: "Confirmed",
    name: "Jane Homeowner",
    phone: "6315550100",
    email: "jane@example.com",
    subscription: "none",
    projectId: null,
    ...overrides,
  };
  await Booking.collection.insertOne(doc);
  return doc;
}

const keys = (steps) => steps.map((s) => s.key);

async function main() {
  const server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
  await Project.syncIndexes();
  ADMIN.id = OID();

  const app = express();
  app.use(express.json());
  app.use("/api/admin/projects", require("../routes/adminProjectWorkflow"));
  app.use("/api/admin/projects", require("../routes/projects"));
  app.use("/api/admin/leads", require("../routes/adminLeads"));
  app.use("/api/admin/invoices", require("../routes/adminInvoices"));
  app.use("/api/admin", require("../routes/admin"));
  const httpServer = app.listen(0);
  await new Promise((resolve) => httpServer.once("listening", resolve));
  base = `http://127.0.0.1:${httpServer.address().port}`;

  try {
    /* ============ Leads ============ */
    console.log("\nLeads");

    await test("an estimate lead becomes a project with every answer, linked both ways", async () => {
      const lead = await makeEstimateLead();
      const res = await api("POST", `/api/admin/leads/estimate/${lead._id}/convert-to-project`, {});
      assert.strictEqual(res.status, 201, JSON.stringify(res.json));
      assert.strictEqual(res.json.created, true);
      const q = res.json.project.qualification;
      assert.strictEqual(q.budgetRange, "$20k-$30k");
      assert.strictEqual(q.timeline, "1-3months");
      assert.strictEqual(q.financing, "maybe");
      assert.strictEqual(q.estimateLow, 18000);
      assert.strictEqual(q.estimateHigh, 26000);
      assert.deepStrictEqual(q.answers.bathroom.bathroomItems, ["shower", "vanity", "tile"]);
      assert.strictEqual(q.answers.bathroom.bathroomFinish, "premium");
      assert.strictEqual(q.contactPref, "text");
      const project = await Project.findById(res.json.project.id).lean();
      assert.strictEqual(project.projectType, "Bathroom");
      assert.strictEqual(project.address, "88 Bay Ave, Babylon NY 11702");
      assert.strictEqual(project.leadRef.model, "EstimateLead");
      assert.strictEqual(String(project.leadRef.id), String(lead._id));
      assert.strictEqual(project.statusHistory[0].source, "lead_conversion");
      assert.strictEqual(String((await EstimateLead.findById(lead._id)).projectId), String(project._id));
      assert.ok(activity.some((a) => a.action === "Lead Converted To Project"));
    });

    await test("conversion is idempotent: a second call and concurrent calls return the same project", async () => {
      const lead = await makeEstimateLead({ email: "twice@example.com" });
      const [a, b] = await Promise.all([
        api("POST", `/api/admin/leads/estimate/${lead._id}/convert-to-project`, {}),
        api("POST", `/api/admin/leads/estimate/${lead._id}/convert-to-project`, {}),
      ]);
      assert.ok([a.status, b.status].includes(201));
      assert.strictEqual(a.json.project.id, b.json.project.id);
      const again = await api("POST", `/api/admin/leads/estimate/${lead._id}/convert-to-project`, {});
      assert.strictEqual(again.status, 200);
      assert.strictEqual(again.json.created, false);
      assert.strictEqual(again.json.project.id, a.json.project.id);
      assert.strictEqual(await Project.countDocuments({ "leadRef.id": lead._id }), 1);
    });

    await test("a request without an address needs one; a free-visit request is not a project lead", async () => {
      const req = await Request.create({ name: "Tom", email: "tom@example.com", phone: "6315550123", serviceType: "home_improvement", message: "Deck repair" });
      const noAddress = await api("POST", `/api/admin/leads/request/${req._id}/convert-to-project`, {});
      assert.strictEqual(noAddress.status, 400);
      assert.strictEqual(noAddress.json.code, "ADDRESS_REQUIRED");
      const withAddress = await api("POST", `/api/admin/leads/request/${req._id}/convert-to-project`, {
        address: "5 Elm St, Islip NY",
        projectType: "Other",
      });
      assert.strictEqual(withAddress.status, 201, JSON.stringify(withAddress.json));
      assert.strictEqual(withAddress.json.project.qualification.notes, "Deck repair");

      const free = await Request.create({ name: "Ann", email: "ann@example.com", phone: "6315550199", serviceType: "free_visit_request", address: "1 Main St" });
      const refused = await api("POST", `/api/admin/leads/request/${free._id}/convert-to-project`, {});
      assert.strictEqual(refused.status, 409);
      assert.strictEqual(refused.json.code, "NOT_A_PROJECT_LEAD");
    });

    await test("lead list is lean and searchable from the body; detail returns the full answers", async () => {
      await Request.create({ name: "Secret Sam", email: "sam@example.com", phone: "6315550777", serviceType: "general_contractor", password: "should-never-leak" });
      const list = await api("GET", "/api/admin/leads?limit=50");
      assert.strictEqual(list.status, 200);
      assert.ok(list.json.total >= 4);
      assert.ok(!JSON.stringify(list.json).includes("should-never-leak"), "no password in the list");
      const search = await api("POST", "/api/admin/leads/search", { search: "555-0142" });
      assert.strictEqual(search.status, 200);
      assert.ok(search.json.leads.some((lead) => lead.name === "Maria Lopez"), "phone digits match across formatting");
      const maria = search.json.leads.find((lead) => lead.name === "Maria Lopez");
      assert.strictEqual(maria.href, `/admin/leads/${maria.key}`);
      const detail = await api("GET", `/api/admin/leads/estimate/${maria.id}`);
      assert.strictEqual(detail.status, 200);
      assert.strictEqual(detail.json.lead.qualification.answers.bathroom.bathroomScope, "full");
      assert.strictEqual(detail.json.lead.allowedActions.convertToProject, false, "already converted");
      assert.strictEqual(detail.json.lead.allowedActions.openProject, true);
    });

    await test("lead status: an estimate lead is never given pending_confirmation, and changes are logged", async () => {
      const lead = await makeEstimateLead({ email: "status@example.com" });
      const bad = await api("PUT", `/api/admin/requests/estimate:${lead._id}/status`, { status: "pending_confirmation" });
      assert.strictEqual(bad.status, 400);
      assert.strictEqual((await EstimateLead.findById(lead._id)).status, "new");
      activity.length = 0;
      const ok = await api("PUT", `/api/admin/requests/estimate:${lead._id}/status`, { status: "contacted" });
      assert.strictEqual(ok.status, 200, JSON.stringify(ok.json));
      const entry = activity.find((a) => a.action === "Lead Status Changed");
      assert.ok(entry);
      assert.strictEqual(entry.details.before.status, "new");
      assert.strictEqual(entry.details.after.status, "contacted");
    });

    /* ============ Next steps (fixture states) ============ */
    console.log("\nNext steps");
    const now = new Date();
    const fin = (over = {}) => ({ valuation: { paidCents: 0, executedValueCents: 0, uninvoicedExecutedCents: 0, ...over }, totals: {} });
    const P0 = { _id: OID(), punchList: [], billingClaims: [] };

    await test("no agreement: prepare the agreement", () => {
      assert.deepStrictEqual(keys(buildNextSteps({ project: P0, contracts: [], financials: fin(), now })), ["create_agreement"]);
    });

    await test("generated with no request: send it; awaiting 5 days: resend (attention)", () => {
      const c = { _id: OID(), contractNumber: "1", version: 1, current: true, status: "Generated" };
      assert.deepStrictEqual(keys(buildNextSteps({ project: P0, contracts: [c], signatures: [], financials: fin(), now })), ["send_agreement"]);
      const sig = { _id: OID(), documentType: "CONTRACT", documentId: c._id, status: "Sent", signingMode: "REMOTE", sentAt: new Date(now - 5 * DAY), createdAt: new Date(now - 5 * DAY), signingToken: { state: "active" } };
      const steps = buildNextSteps({ project: P0, contracts: [{ ...c, status: "Emailed" }], signatures: [sig], financials: fin(), now });
      assert.strictEqual(steps[0].key, "agreement_awaiting_signature");
      assert.strictEqual(steps[0].severity, "attention");
      assert.strictEqual(steps[0].action.endpoint, `/api/admin/signatures/native/${sig._id}/resend`);
    });

    await test("declined and expired signatures are problems", () => {
      const c = { _id: OID(), contractNumber: "1", version: 1, current: true, status: "Emailed" };
      const declined = { _id: OID(), documentType: "CONTRACT", documentId: c._id, status: "Declined", declineReason: "Price", createdAt: now, signingToken: { state: "declined" } };
      const s1 = buildNextSteps({ project: P0, contracts: [c], signatures: [declined], financials: fin(), now });
      assert.strictEqual(s1[0].key, "signature_declined");
      assert.strictEqual(s1[0].severity, "problem");
      const expired = { ...declined, status: "Expired", signingToken: { state: "expired" } };
      assert.strictEqual(buildNextSteps({ project: P0, contracts: [c], signatures: [expired], financials: fin(), now })[0].key, "signature_expired");
    });

    await test("signed with a deposit and no invoice: create the deposit invoice (amount from the agreement)", () => {
      const c = { _id: OID(), contractNumber: "1", version: 1, current: true, status: "Signed", depositAmountCents: 500000, paymentSchedule: [] };
      const steps = buildNextSteps({ project: P0, contracts: [c], invoices: [], financials: fin(), now });
      const deposit = steps.find((s) => s.key === "deposit_not_invoiced");
      assert.ok(deposit);
      assert.ok(deposit.label.includes("$5,000.00"));
      assert.deepStrictEqual(deposit.action.body, { kind: "deposit" });
      assert.ok(keys(steps).includes("schedule_work"));
    });

    await test("change order awaiting signature, overdue invoice, final invoice and open punch list", () => {
      const c = { _id: OID(), contractNumber: "1", version: 1, current: true, status: "Signed", depositAmountCents: 0, paymentSchedule: [] };
      const co = { _id: OID(), changeOrderNumber: "1-01", status: "Sent", sentAt: new Date(now - 4 * DAY) };
      const overdue = { _id: OID(), invoiceNumber: "9", status: "Sent", sentAt: new Date(now - 30 * DAY), invoiceTotalCents: 100000, payments: [], dates: { dueDate: new Date(now - 2 * DAY) } };
      const project = { ...P0, scheduledStart: new Date(now - 10 * DAY), substantialCompletionAt: new Date(now - DAY), punchList: [{ _id: OID(), text: "Caulk tub", done: false }] };
      const steps = buildNextSteps({ project, contracts: [c], changeOrders: [co], invoices: [overdue], signatures: [], financials: fin({ uninvoicedExecutedCents: 900000 }), now });
      const k = keys(steps);
      for (const key of ["change_order_awaiting_signature", "invoice_overdue", "final_invoice", "punch_list_open"]) {
        assert.ok(k.includes(key), `${key} missing from ${k.join(",")}`);
      }
      assert.strictEqual(steps[0].severity, "problem", "problems sort first");
    });

    await test("derived stage follows documents, not the manual status", () => {
      const project = { ...P0, status: "Lead" };
      const signed = { _id: OID(), status: "Signed", version: 1, current: true, depositAmountCents: 500000 };
      assert.strictEqual(buildDerivedStage({ project, contracts: [], financials: fin(), now }).key, "lead");
      assert.strictEqual(buildDerivedStage({ project, contracts: [{ ...signed, status: "Emailed" }], financials: fin(), now }).key, "proposal_issued");
      assert.strictEqual(buildDerivedStage({ project, contracts: [signed], financials: fin(), now }).key, "signed");
      assert.strictEqual(buildDerivedStage({ project, contracts: [signed], financials: fin({ paidCents: 500000 }), now }).key, "deposit_paid");
      const done = { ...project, substantialCompletionAt: new Date(now - DAY), warrantyEndsAt: new Date(now.getTime() + 300 * DAY) };
      assert.strictEqual(buildDerivedStage({ project: done, contracts: [signed], financials: fin({ paidCents: 2000000, executedValueCents: 2000000 }), now }).key, "warranty");
    });

    /* ============ Overview and billing ============ */
    console.log("\nOverview and billing");

    const project = await makeProject({ status: "Lead" });
    const contract = await makeContract(project);

    await test("overview: manual status kept, derived stage beside it, next step is the deposit", async () => {
      const res = await api("GET", `/api/admin/projects/${project._id}/overview`);
      assert.strictEqual(res.status, 200, JSON.stringify(res.json));
      assert.strictEqual(res.json.manualStatus, "Lead");
      assert.strictEqual(res.json.derivedStage.key, "signed");
      assert.strictEqual(res.json.financials.executedValueCents, 2000000);
      assert.strictEqual(res.json.financials.proposedValueCents, 0);
      assert.strictEqual(res.json.nextSteps[0].key, "deposit_not_invoiced");
      assert.strictEqual(res.json.documents.agreements[0].status, "Signed");
      assert.strictEqual(res.json.allowedActions.createDepositInvoice, true);
      assert.strictEqual((await Project.findById(project._id)).status, "Lead", "the derived stage never overwrites");
    });

    await test("overview carries the recipient and amounts the confirm dialogs need (gap B4)", async () => {
      const res = await api("GET", `/api/admin/projects/${project._id}/overview`);
      const deposit = res.json.nextSteps.find((s) => s.key === "deposit_not_invoiced");
      assert.strictEqual(deposit.action.amountCents, 500000);
      assert.strictEqual(deposit.action.recipientEmail, "jane@example.com");
      assert.strictEqual(res.json.documents.agreements[0].recipientEmail, "jane@example.com");

      const p3 = await makeProject({ email: "send@example.com" });
      const generated = await makeContract(p3, { status: "Generated", signedPdf: undefined, customerSnapshot: { fullName: "S", email: "Send@Example.com" } });
      const issued = await makeInvoice(p3, { customerSnapshot: { fullName: "S", email: "bill@example.com" } });
      const overview = await api("GET", `/api/admin/projects/${p3._id}/overview`);
      const send = overview.json.nextSteps.find((s) => s.key === "send_agreement");
      assert.ok(send, keys(overview.json.nextSteps).join(","));
      assert.strictEqual(send.action.recipientEmail, "send@example.com");
      assert.strictEqual(send.action.body.documentId, String(generated._id));
      const invoiceDoc = overview.json.documents.invoices.find((row) => row.id === String(issued._id));
      assert.strictEqual(invoiceDoc.recipientEmail, "bill@example.com");
    });

    let depositInvoiceId = null;
    await test("deposit invoice from the agreement: amount is the agreement's, replay returns the same invoice", async () => {
      const first = await api("POST", `/api/admin/projects/${project._id}/invoices/from-schedule`, { kind: "deposit", idempotencyKey: "k-1" });
      assert.strictEqual(first.status, 201, JSON.stringify(first.json));
      depositInvoiceId = first.json.invoice.id;
      const stored = await Invoice.findById(depositInvoiceId);
      assert.strictEqual(stored.invoiceTotalCents, 500000);
      const replay = await api("POST", `/api/admin/projects/${project._id}/invoices/from-schedule`, { kind: "deposit", idempotencyKey: "k-1" });
      assert.strictEqual(replay.status, 200);
      assert.strictEqual(replay.json.replayed, true);
      assert.strictEqual(replay.json.invoiceId, depositInvoiceId);
      const other = await api("POST", `/api/admin/projects/${project._id}/invoices/from-schedule`, { kind: "deposit", idempotencyKey: "k-2" });
      assert.strictEqual(other.status, 409);
      assert.strictEqual(other.json.code, "ALREADY_BILLED");
      assert.strictEqual(await Invoice.countDocuments({ projectId: project._id }), 1);
      const claim = (await Project.findById(project._id)).billingClaims[0];
      assert.strictEqual(String(claim.invoiceId), depositInvoiceId);
    });

    await test("after the deposit, the next milestone is offered (skipping the deposit row) and billed once", async () => {
      const res = await api("GET", `/api/admin/projects/${project._id}/overview`);
      const next = res.json.nextSteps.find((s) => s.key === "bill_next_milestone");
      assert.ok(next, res.json.nextSteps.map((s) => s.key).join(","));
      assert.strictEqual(next.action.body.scheduleIndex, 1);
      assert.strictEqual(next.action.scheduleIndex, 1);
      assert.strictEqual(next.action.amountCents, 800000);
      assert.strictEqual(next.action.recipientEmail, "jane@example.com");
      assert.ok(!res.json.nextSteps.some((s) => s.key === "deposit_not_invoiced"));
      const billed = await api("POST", `/api/admin/projects/${project._id}/invoices/from-schedule`, { kind: "milestone", scheduleIndex: 1, idempotencyKey: "m-1" });
      assert.strictEqual(billed.status, 201, JSON.stringify(billed.json));
      assert.strictEqual((await Invoice.findById(billed.json.invoice.id)).invoiceTotalCents, 800000);
      const depositRow = await api("POST", `/api/admin/projects/${project._id}/invoices/from-schedule`, { kind: "milestone", scheduleIndex: 0, idempotencyKey: "m-0" });
      assert.strictEqual(depositRow.json.code, "USE_DEPOSIT");
    });

    await test("billing needs a signed agreement and an idempotency key", async () => {
      const p2 = await makeProject();
      await makeContract(p2, { status: "Generated", signedPdf: undefined });
      const unsigned = await api("POST", `/api/admin/projects/${p2._id}/invoices/from-schedule`, { kind: "deposit", idempotencyKey: "x" });
      assert.strictEqual(unsigned.status, 409);
      assert.strictEqual(unsigned.json.code, "AGREEMENT_NOT_SIGNED");
      const noKey = await api("POST", `/api/admin/projects/${project._id}/invoices/from-schedule`, { kind: "deposit" });
      assert.strictEqual(noKey.status, 400);
      assert.strictEqual(noKey.json.code, "IDEMPOTENCY_KEY_REQUIRED");
    });

    await test("a voided deposit invoice can be billed again", async () => {
      await Invoice.updateOne({ _id: depositInvoiceId }, { $set: { status: "Voided" } });
      const again = await api("POST", `/api/admin/projects/${project._id}/invoices/from-schedule`, { kind: "deposit", idempotencyKey: "k-3" });
      assert.strictEqual(again.status, 201, JSON.stringify(again.json));
      assert.notStrictEqual(again.json.invoice.id, depositInvoiceId);
    });

    /* ============ Visits, schedule, closeout ============ */
    console.log("\nVisits, schedule, closeout");

    await test("a visit links to one project only, and unlinks cleanly", async () => {
      const booking = await insertBooking();
      const linked = await api("POST", `/api/admin/projects/${project._id}/bookings`, { bookingId: String(booking._id), siteVisit: true });
      assert.strictEqual(linked.status, 200, JSON.stringify(linked.json));
      assert.strictEqual(linked.json.siteVisitBookingId, String(booking._id));
      assert.strictEqual(String((await Booking.findById(booking._id).lean()).projectId), String(project._id));
      const other = await makeProject();
      const conflict = await api("POST", `/api/admin/projects/${other._id}/bookings`, { bookingId: String(booking._id) });
      assert.strictEqual(conflict.status, 409);
      assert.strictEqual(conflict.json.code, "BOOKING_LINKED_ELSEWHERE");
      const overview = await api("GET", `/api/admin/projects/${project._id}/overview`);
      assert.strictEqual(overview.json.linkedBookings[0].isSiteVisit, true);
      const unlinked = await api("DELETE", `/api/admin/projects/${project._id}/bookings/${booking._id}`);
      assert.strictEqual(unlinked.status, 200);
      assert.strictEqual(unlinked.json.siteVisitBookingId, null);
      assert.strictEqual((await Booking.findById(booking._id).lean()).projectId, null);
    });

    await test("schedule and crew: staff only, end after start, stale precondition refused", async () => {
      const fixter = await User.collection.insertOne({ name: "Fixter Fred", email: "fred@profixter.test", role: "employee", userId: "u-fred" });
      const customer = await User.collection.insertOne({ name: "Cust", email: "cust@example.com", role: "customer", userId: "u-cust" });
      const current = await Project.findById(project._id);
      const stale = await api("PUT", `/api/admin/projects/${project._id}/schedule`, {
        scheduledStart: "2026-12-01T13:00:00Z",
        expectedUpdatedAt: new Date(current.updatedAt.getTime() - 1000).toISOString(),
      });
      assert.strictEqual(stale.status, 409);
      assert.strictEqual(stale.json.code, "STALE");
      const notStaff = await api("PUT", `/api/admin/projects/${project._id}/schedule`, { assignedFixterIds: [String(customer.insertedId)] });
      assert.strictEqual(notStaff.json.code, "INVALID_ASSIGNEE");
      const backwards = await api("PUT", `/api/admin/projects/${project._id}/schedule`, { scheduledStart: "2026-12-05", scheduledEnd: "2026-12-01" });
      assert.strictEqual(backwards.json.code, "INVALID_DATE");
      const ok = await api("PUT", `/api/admin/projects/${project._id}/schedule`, {
        scheduledStart: "2026-12-01T13:00:00Z",
        scheduledEnd: "2026-12-12T22:00:00Z",
        assignedFixterIds: [String(fixter.insertedId)],
        expectedUpdatedAt: current.updatedAt.toISOString(),
      });
      assert.strictEqual(ok.status, 200, JSON.stringify(ok.json));
      assert.deepStrictEqual(ok.json.assignedFixterIds, [String(fixter.insertedId)]);
    });

    await test("substantial completion is explicit, once, and sets the warranty from the agreement terms", async () => {
      const unconfirmed = await api("POST", `/api/admin/projects/${project._id}/substantial-completion`, {});
      assert.strictEqual(unconfirmed.json.code, "CONFIRMATION_REQUIRED");
      const unsignedProject = await makeProject();
      const refused = await api("POST", `/api/admin/projects/${unsignedProject._id}/substantial-completion`, { confirm: true });
      assert.strictEqual(refused.json.code, "INVALID_TRANSITION");
      const done = await api("POST", `/api/admin/projects/${project._id}/substantial-completion`, { confirm: true, completedAt: "2026-11-01T15:00:00Z" });
      assert.strictEqual(done.status, 200, JSON.stringify(done.json));
      assert.strictEqual(new Date(done.json.warrantyEndsAt).toISOString(), "2027-11-01T15:00:00.000Z");
      assert.strictEqual(done.json.warranty.months, 12);
      const twice = await api("POST", `/api/admin/projects/${project._id}/substantial-completion`, { confirm: true });
      assert.strictEqual(twice.status, 409);
    });

    await test("punch list: add, tick off, edit, remove", async () => {
      const added = await api("POST", `/api/admin/projects/${project._id}/punch-list`, { text: "Touch up paint by door" });
      assert.strictEqual(added.status, 201);
      const id = added.json.punchList[0].id;
      const ticked = await api("PATCH", `/api/admin/projects/${project._id}/punch-list/${id}`, { done: true });
      assert.strictEqual(ticked.json.punchList[0].done, true);
      assert.ok(ticked.json.punchList[0].doneAt);
      const edited = await api("PATCH", `/api/admin/projects/${project._id}/punch-list/${id}`, { text: "Touch up paint by front door" });
      assert.strictEqual(edited.json.punchList[0].text, "Touch up paint by front door");
      const empty = await api("POST", `/api/admin/projects/${project._id}/punch-list`, { text: "  " });
      assert.strictEqual(empty.json.code, "TEXT_REQUIRED");
      const removed = await api("DELETE", `/api/admin/projects/${project._id}/punch-list/${id}`);
      assert.strictEqual(removed.json.punchList.length, 0);
    });

    await test("manual status changes keep a history with the actor; a stale expectedStatus is refused", async () => {
      const stale = await api("PUT", `/api/admin/projects/${project._id}/status`, { status: "Won", expectedStatus: "Follow Up" });
      assert.strictEqual(stale.status, 409);
      assert.strictEqual(stale.json.code, "STALE");
      const ok = await api("PUT", `/api/admin/projects/${project._id}/status`, { status: "Won", expectedStatus: "Lead", reason: "Signed" });
      assert.strictEqual(ok.status, 200, JSON.stringify(ok.json));
      const legacy = await api("PUT", `/api/admin/projects/${project._id}`, { status: "In Progress" });
      assert.strictEqual(legacy.status, 200, JSON.stringify(legacy.json));
      const stored = await Project.findById(project._id).lean();
      const history = stored.statusHistory.map((h) => `${h.from}->${h.to}`);
      assert.deepStrictEqual(history, ["Lead->Won", "Won->In Progress"]);
      assert.strictEqual(stored.statusHistory[0].actorName, "Owner");
    });

    /* ============ List and collectors ============ */
    console.log("\nList and needs action");

    await test("project search covers address and phone (body), with financial columns and a stage filter", async () => {
      const byAddress = await api("POST", "/api/admin/projects/search", { search: "ocean ave" });
      assert.strictEqual(byAddress.status, 200);
      const row = byAddress.json.projects.find((p) => p.id === String(project._id));
      assert.ok(row, "found by address");
      assert.strictEqual(row.executedValueCents, 2000000);
      // The deposit and milestone invoices are still drafts, so nothing is invoiced yet.
      assert.strictEqual(row.invoicedCents, 0);
      assert.strictEqual(row.outstandingCents, 0);
      const byPhone = await api("POST", "/api/admin/projects/search", { search: "(631) 555-0100" });
      assert.ok(byPhone.json.projects.some((p) => p.id === String(project._id)));
      const staged = await api("POST", "/api/admin/projects/search", { stage: "lead" });
      assert.ok(staged.json.projects.every((p) => p.derivedStage.key === "lead"));
      assert.ok(!staged.json.projects.some((p) => p.id === String(project._id)));
    });

    await test("search rows carry the overview's top next step, for every row (gap B1)", async () => {
      const declinedProject = await makeProject({ customerName: "Declined Dan" });
      const declined = await makeContract(declinedProject, { status: "Generated", signedPdf: undefined });
      await ESignature.collection.insertOne({
        projectId: declinedProject._id,
        documentType: "CONTRACT",
        documentId: declined._id,
        status: "Declined",
        signingMode: "REMOTE",
        declineReason: "Too expensive",
        createdAt: new Date(),
        signingToken: { state: "revoked" },
      });
      const list = await api("POST", "/api/admin/projects/search", { limit: 50 });
      assert.strictEqual(list.status, 200, JSON.stringify(list.json));
      assert.ok(list.json.projects.length >= 3);
      for (const row of list.json.projects) {
        const overview = await api("GET", `/api/admin/projects/${row.id}/overview`);
        const top = overview.json.nextSteps[0] || null;
        assert.deepStrictEqual(
          row.nextStep,
          top ? { key: top.key, label: top.label, severity: top.severity } : null,
          `row ${row.projectNumber}`
        );
      }
      const dan = list.json.projects.find((row) => row.id === String(declinedProject._id));
      assert.strictEqual(dan.nextStep.key, "signature_declined");
      assert.strictEqual(dan.nextStep.severity, "problem");
      const staged = await api("POST", "/api/admin/projects/search", { stage: "proposal_issued" });
      assert.ok(staged.json.projects.every((row) => "nextStep" in row));
    });

    await test("project customer picker: POST takes the query in the body, GET still works (gap B3)", async () => {
      await User.create({ userId: "70000001", name: "Picker Penelope", email: "penelope@example.com", role: "customer", phone: "6315550777" });
      const post = await api("POST", "/api/admin/projects/customer-search", { q: "penelope", limit: 5 });
      assert.strictEqual(post.status, 200, JSON.stringify(post.json));
      assert.ok(post.json.customers.some((c) => /penelope/i.test(c.email || c.name || "")), JSON.stringify(post.json));
      const get = await api("GET", "/api/admin/projects/customer-search?q=penelope&limit=5");
      assert.strictEqual(get.status, 200);
      assert.deepStrictEqual(post.json.customers.map((c) => c.id || c._id), get.json.customers.map((c) => c.id || c._id));
      const short = await api("POST", "/api/admin/projects/customer-search", { q: "p" });
      assert.strictEqual(short.status, 200);
      assert.deepStrictEqual(short.json.customers, []);
      assert.ok(short.json.message);
    });

    await test("needs action: projects collector finds deposit, declined signature and overdue invoice", async () => {
      const collector = require("../utils/needsAction/collectors/projects");
      const depositProject = await makeProject({ customerName: "Deposit Dana" });
      await makeContract(depositProject);
      const declinedProject = await makeProject({ customerName: "Declined Dan" });
      const open = await makeContract(declinedProject, { status: "Emailed", signedPdf: undefined });
      await ESignature.create({
        projectId: declinedProject._id,
        documentType: "CONTRACT",
        documentId: open._id,
        documentNumber: open.contractNumber,
        provider: "native",
        status: "Declined",
        declinedAt: new Date(),
        declineReason: "Too high",
        signers: [{ role: "CUSTOMER", email: "dan@example.com" }],
      });
      const overdueProject = await makeProject({ customerName: "Overdue Olga" });
      await makeInvoice(overdueProject, { dates: { invoiceDate: new Date(Date.now() - 40 * DAY), dueDate: new Date(Date.now() - 5 * DAY) } });

      const result = await collector.collect({ now: new Date(), limit: 50 });
      const kinds = result.items.map((item) => `${item.kind}:${item.title}`);
      assert.ok(kinds.some((k) => k.startsWith("project_deposit_not_invoiced") && k.includes("Deposit Dana")), kinds.join("\n"));
      assert.ok(kinds.some((k) => k.startsWith("project_signature_declined") && k.includes("Declined Dan")));
      assert.ok(kinds.some((k) => k.startsWith("project_invoice_overdue") && k.includes("Overdue Olga")));
      assert.ok(!kinds.some((k) => k.includes("Jane Homeowner") && k.startsWith("project_deposit")), "billed deposit is not flagged");
      assert.ok(result.items.every((item) => item.href.startsWith("/admin/projects/")));
      assert.strictEqual(collector.permission, "projects.manage");
    });

    await test("needs action: new renovation leads collector, not free visits", async () => {
      const collector = require("../utils/needsAction/collectors/projectLeads");
      await makeEstimateLead({ name: "Fresh Fiona", email: "fiona@example.com" });
      const result = await collector.collect({ now: new Date(), limit: 50 });
      const titles = result.items.map((item) => item.title);
      assert.ok(titles.some((t) => t.includes("Fresh Fiona")));
      assert.ok(!titles.some((t) => t.includes("Ann")), "free-visit requests belong to the bookings collector");
      assert.ok(!titles.some((t) => t.includes("Maria Lopez")), "converted leads are done");
      assert.strictEqual(collector.permission, "leads.manage");
    });

    await test("financial summary for the workflow project stays coherent", async () => {
      const summary = await getProjectFinancialSummary(project._id);
      assert.strictEqual(summary.valuation.executedValueCents, 2000000);
      assert.strictEqual(summary.agreement.id, String(contract._id));
    });
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
    await mongoose.disconnect();
    await server.stop();
  }

  console.log(`\n${passed} passed, ${failures.length} failed.`);
  if (failures.length) {
    for (const failure of failures) console.error(`\n${failure.name}\n${failure.err.stack}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error("project workflow suite crashed:", error);
  process.exit(1);
});
