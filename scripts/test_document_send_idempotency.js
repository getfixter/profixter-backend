/**
 * Customer-facing document sends are never repeated by a retry or a
 * double-click (admin redesign gap fix B2 / BE-DOCS F20).
 *
 *   - agreement, change order and invoice emails, and the native signature
 *     request and its reminder, accept `idempotencyKey` in the JSON body: the
 *     same key again returns the first answer and sends nothing;
 *   - without a key (the frontend released before this), the same document to
 *     the same address within 60 seconds sends once and the repeat answers
 *     `duplicate: true`; a different address sends;
 *   - a failed send releases the key, so a retry sends;
 *   - the raw signing link is never written to the idempotency store.
 *
 * Real Express routers over HTTP against an in-memory MongoDB. S3, email,
 * auth and the activity log are injected; nothing leaves the process.
 *
 *   node scripts/test_document_send_idempotency.js
 */

process.env.S3_BUCKET = process.env.S3_BUCKET || "test-bucket";
process.env.ESIGN_ALLOW_UNSIGNED_COMPANY = "true";
process.env.PUBLIC_SITE_BASE_URL = "https://profixter.test";
delete process.env.STRIPE_SECRET_KEY;

const assert = require("assert");
const http = require("http");

const fakeS3 = {
  async putPrivateObject({ Key }) {
    return { Key };
  },
  async getObjectBuffer() {
    return Buffer.from("%PDF-1.4 stored test document");
  },
  async putPublicObject() {
    throw new Error("documents must never be public");
  },
};

const emails = [];
const sendHooks = { failNext: 0 };
const fakeEmail = {
  ADMIN: "owner@profixter.test",
  FROM: "Profixter <no-reply@profixter.test>",
  REPLY_TO: "hello@profixter.test",
  async sendRaw(payload) {
    if (sendHooks.failNext > 0) {
      sendHooks.failNext -= 1;
      throw new Error("simulated provider outage");
    }
    // A little latency so concurrent requests really overlap.
    await new Promise((resolve) => setTimeout(resolve, 30));
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
  req.accessUser = { _id: ADMIN.id, email: ADMIN.email };
  next();
};
const fakeAuthorize = {
  PERMISSIONS: { ADMIN: "admin", PROJECTS_MANAGE: "projects.manage" },
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
    return { _id: "log" };
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
const ESignature = require("../models/ESignature");
const Invoice = require("../models/Invoice");
const AdminIdempotencyRecord = require("../models/AdminIdempotencyRecord");

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
let base = "";
let seq = 0;
const key = () => `test-key-${Date.now()}-${(seq += 1)}`;

async function api(method, path, body, headers = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json", ...headers } : headers,
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

const sentTo = (address) => emails.filter((e) => String(e.to).toLowerCase() === address).length;

async function makeProject() {
  seq += 1;
  return Project.create({
    projectNumber: `TEST-SI-${String(seq).padStart(4, "0")}`,
    customerName: "Jane Homeowner",
    email: "jane@example.com",
    phone: "6315550100",
    address: "12 Ocean Ave, Lindenhurst NY",
    projectType: "Bathroom",
  });
}

async function makeContract(project, email) {
  seq += 1;
  return Contract.create({
    contractNumber: `SI${String(seq).padStart(5, "0")}`,
    version: 1,
    current: true,
    projectId: project._id,
    status: "Generated",
    customerSnapshot: { fullName: "Jane Homeowner", email },
    propertySnapshot: { address: "12 Ocean Ave, Lindenhurst NY" },
    workType: "Bathroom",
    projectDescription: "Remodel",
    scopeText: "Scope",
    originalContractPriceCents: 2000000,
    totalPriceCents: 2000000,
    adjustedContractPriceCents: 2000000,
    depositAmountCents: 500000,
    remainingBalanceCents: 1500000,
    paymentSchedule: [],
    dates: { contractDate: new Date("2026-08-01") },
    generatedPdf: { key: "generated.pdf", fileName: "agreement.pdf" },
    createdBy: OID(),
  });
}

async function makeChangeOrder(contract, email) {
  const sequence = await ChangeOrder.nextSequence(contract.contractNumber);
  return ChangeOrder.create({
    changeOrderNumber: ChangeOrder.formatNumber(contract.contractNumber, sequence),
    sequence,
    projectId: contract.projectId,
    contractId: contract._id,
    status: "Ready to Send",
    title: "Additional electrical work",
    customerSnapshot: { fullName: "Jane Homeowner", email },
    propertySnapshot: { address: "12 Ocean Ave" },
    contractSnapshot: { contractNumber: contract.contractNumber, originalContractAmountCents: 2000000 },
    lines: [{ description: "Add", direction: "add", amountCents: 150000 }],
    contractAmountBeforeChangeCents: 2000000,
    generatedPdf: { key: "co.pdf", fileName: "co.pdf" },
    createdBy: OID(),
  });
}

async function makeInvoice(project, email) {
  seq += 1;
  return Invoice.create({
    invoiceNumber: `SI${String(seq).padStart(6, "0")}`,
    projectId: project._id,
    status: "Sent",
    sentAt: new Date(),
    customerSnapshot: { fullName: "Jane Homeowner", email },
    projectSnapshot: { projectNumber: project.projectNumber, workType: "Bathroom" },
    propertySnapshot: { address: project.address },
    lineItems: [{ description: "Deposit", quantity: 1, unitPriceCents: 500000, totalCents: 500000, category: "Contract work" }],
    subtotalCents: 500000,
    invoiceTotalCents: 500000,
    remainingBalanceCents: 500000,
    dates: { invoiceDate: new Date(), dueDate: new Date(Date.now() + 14 * 86400000) },
    generatedPdfs: [{ key: "invoice.pdf", fileName: "invoice.pdf", version: 1, status: "Current" }],
    createdBy: ADMIN.id,
  });
}

let addressSeq = 0;
const freshAddress = () => `customer${(addressSeq += 1)}@example.com`;

async function main() {
  const server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
  await AdminIdempotencyRecord.syncIndexes();
  ADMIN.id = OID();

  const app = express();
  app.use(express.json({ limit: "4mb" }));
  app.use("/api/admin/signatures", require("../routes/adminSignatures"));
  app.use("/api/admin/contracts", require("../routes/adminContracts"));
  app.use("/api/admin/change-orders", require("../routes/adminChangeOrders"));
  app.use("/api/admin/invoices", require("../routes/adminInvoices"));
  const listener = http.createServer(app);
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${listener.address().port}`;

  /** The same checks for each `/email` route. */
  async function emailRouteSuite(label, makeDoc, pathFor, bodyKey) {
    console.log(`\n${label}`);
    // The agreement and invoice routes are project-scoped by a body projectId.
    const send = (doc, body = {}) => api("POST", pathFor(doc), { projectId: String(doc.projectId), ...body });

    await test(`${label}: the same idempotencyKey twice sends once and replays the answer`, async () => {
      const address = freshAddress();
      const doc = await makeDoc(address);
      const k = key();
      const first = await send(doc, { idempotencyKey: k });
      assert.strictEqual(first.status, 200, JSON.stringify(first.json));
      assert.ok(first.json[bodyKey], "first answer carries the document");
      const replay = await send(doc, { idempotencyKey: k });
      assert.strictEqual(replay.status, 200, JSON.stringify(replay.json));
      assert.strictEqual(replay.json.replayed, true);
      assert.deepStrictEqual(replay.json[bodyKey], first.json[bodyKey]);
      assert.strictEqual(sentTo(address), 1, "one email");
    });

    await test(`${label}: no key, double-click (concurrent and sequential) within 60s sends once`, async () => {
      const address = freshAddress();
      const doc = await makeDoc(address);
      const [a, b] = await Promise.all([send(doc, {}), send(doc, {})]);
      assert.strictEqual(a.status, 200, JSON.stringify(a.json));
      assert.strictEqual(b.status, 200, JSON.stringify(b.json));
      assert.strictEqual([a, b].filter((r) => r.json.duplicate === true).length, 1, "exactly one is the duplicate");
      const third = await send(doc, {});
      assert.strictEqual(third.status, 200);
      assert.strictEqual(third.json.duplicate, true);
      assert.strictEqual(sentTo(address), 1, "one email");
    });

    await test(`${label}: no key, a different recipient within 60s sends`, async () => {
      const address = freshAddress();
      const other = freshAddress();
      const doc = await makeDoc(address);
      const first = await send(doc, {});
      const second = await send(doc, { recipient: other });
      assert.strictEqual(first.status, 200, JSON.stringify(first.json));
      assert.strictEqual(second.status, 200, JSON.stringify(second.json));
      assert.notStrictEqual(second.json.duplicate, true);
      assert.strictEqual(sentTo(address), 1);
      assert.strictEqual(sentTo(other), 1);
    });

    await test(`${label}: after the 60s window the same send goes out again`, async () => {
      const address = freshAddress();
      const doc = await makeDoc(address);
      await send(doc, {});
      await AdminIdempotencyRecord.updateMany(
        { scope: /^send-guard:/ },
        { $set: { expiresAt: new Date(Date.now() - 1000) } }
      );
      const again = await send(doc, {});
      assert.strictEqual(again.status, 200, JSON.stringify(again.json));
      assert.notStrictEqual(again.json.duplicate, true);
      assert.strictEqual(sentTo(address), 2);
    });

    await test(`${label}: a failed send releases the key, so the retry sends`, async () => {
      const address = freshAddress();
      const doc = await makeDoc(address);
      const k = key();
      sendHooks.failNext = 1;
      const failed = await send(doc, { idempotencyKey: k });
      assert.strictEqual(failed.status, 500, JSON.stringify(failed.json));
      const retry = await send(doc, { idempotencyKey: k });
      assert.strictEqual(retry.status, 200, JSON.stringify(retry.json));
      assert.notStrictEqual(retry.json.replayed, true);
      sendHooks.failNext = 1;
      const failedNoKey = await send(doc, { recipient: freshAddress() });
      assert.strictEqual(failedNoKey.status, 500);
      assert.strictEqual(sentTo(address), 1);
    });
  }

  try {
    sendHooks.failNext = 0;
    await emailRouteSuite(
      "Agreement email",
      async (address) => makeContract(await makeProject(), address),
      (doc) => `/api/admin/contracts/${doc._id}/email`,
      "contract"
    );
    await emailRouteSuite(
      "Change order email",
      async (address) => makeChangeOrder(await makeContract(await makeProject(), address), address),
      (doc) => `/api/admin/change-orders/${doc._id}/email`,
      "changeOrder"
    );
    await emailRouteSuite(
      "Invoice email",
      async (address) => makeInvoice(await makeProject(), address),
      (doc) => `/api/admin/invoices/${doc._id}/email`,
      "invoice"
    );

    console.log("\nNative signature request");

    await test("send: the same key twice creates one request, sends once, and never stores the link", async () => {
      const address = freshAddress();
      const contract = await makeContract(await makeProject(), address);
      const k = key();
      const body = { documentType: "CONTRACT", documentId: String(contract._id), mode: "REMOTE", idempotencyKey: k };
      const first = await api("POST", "/api/admin/signatures/native/send", body);
      assert.strictEqual(first.status, 201, JSON.stringify(first.json));
      assert.ok(/\/sign\//.test(first.json.signingUrl), "the first answer carries the link");
      const replay = await api("POST", "/api/admin/signatures/native/send", body);
      assert.strictEqual(replay.status, 201, JSON.stringify(replay.json));
      assert.strictEqual(replay.json.replayed, true);
      assert.strictEqual(replay.json.signingUrl, null);
      assert.strictEqual(replay.json.signingUrlWithheld, true);
      assert.strictEqual(replay.json.signature.id, first.json.signature.id);
      assert.strictEqual(await ESignature.countDocuments({ documentId: contract._id }), 1);
      assert.strictEqual(sentTo(address), 1);
      const token = first.json.signingUrl.split("/sign/")[1];
      const stored = JSON.stringify(await AdminIdempotencyRecord.find({}).lean());
      assert.ok(!stored.includes(token), "the raw token is not in the idempotency store");
    });

    await test("send: no key, double-click within 60s sends once and answers duplicate", async () => {
      const address = freshAddress();
      const contract = await makeContract(await makeProject(), address);
      const body = { documentType: "CONTRACT", documentId: String(contract._id), mode: "REMOTE" };
      const [a, b] = await Promise.all([
        api("POST", "/api/admin/signatures/native/send", body),
        api("POST", "/api/admin/signatures/native/send", body),
      ]);
      assert.deepStrictEqual([a.status, b.status], [201, 201], JSON.stringify([a.json, b.json]));
      const dup = [a, b].find((r) => r.json.duplicate === true);
      assert.ok(dup, "one answer is the duplicate");
      assert.strictEqual(dup.json.signingUrl, null);
      assert.strictEqual(await ESignature.countDocuments({ documentId: contract._id }), 1);
      assert.strictEqual(sentTo(address), 1);
    });

    await test("send: the Idempotency-Key header still works but is never required", async () => {
      const address = freshAddress();
      const contract = await makeContract(await makeProject(), address);
      const body = { documentType: "CONTRACT", documentId: String(contract._id), mode: "REMOTE" };
      const k = key();
      const first = await api("POST", "/api/admin/signatures/native/send", body, { "Idempotency-Key": k });
      assert.strictEqual(first.status, 201, JSON.stringify(first.json));
      const replay = await api("POST", "/api/admin/signatures/native/send", { ...body, idempotencyKey: k });
      assert.strictEqual(replay.json.replayed, true);
      assert.strictEqual(sentTo(address), 1);
      const bad = await api("POST", "/api/admin/signatures/native/send", { ...body, idempotencyKey: "short" });
      assert.strictEqual(bad.status, 400);
      assert.strictEqual(bad.json.code, "IDEMPOTENCY_KEY_INVALID");
    });

    await test("resend: same key once; no key double-click once; a new reminder after the window sends", async () => {
      const address = freshAddress();
      const contract = await makeContract(await makeProject(), address);
      const sent = await api("POST", "/api/admin/signatures/native/send", {
        documentType: "CONTRACT",
        documentId: String(contract._id),
        mode: "REMOTE",
      });
      assert.strictEqual(sent.status, 201, JSON.stringify(sent.json));
      const id = sent.json.signature.id;
      const path = `/api/admin/signatures/native/${id}/resend`;

      const k = key();
      const r1 = await api("POST", path, { idempotencyKey: k });
      assert.strictEqual(r1.status, 200, JSON.stringify(r1.json));
      assert.ok(r1.json.signingUrl);
      const r2 = await api("POST", path, { idempotencyKey: k });
      assert.strictEqual(r2.json.replayed, true);
      assert.strictEqual(r2.json.signingUrl, null);
      assert.strictEqual(sentTo(address), 2, "request + one reminder");

      const [a, b] = await Promise.all([api("POST", path, {}), api("POST", path, {})]);
      assert.deepStrictEqual([a.status, b.status], [200, 200], JSON.stringify([a.json, b.json]));
      assert.strictEqual([a, b].filter((r) => r.json.duplicate === true).length, 1);
      assert.strictEqual(sentTo(address), 3, "one more reminder");

      await AdminIdempotencyRecord.updateMany({ scope: /^send-guard:/ }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
      const later = await api("POST", path, {});
      assert.strictEqual(later.status, 200, JSON.stringify(later.json));
      assert.notStrictEqual(later.json.duplicate, true);
      assert.strictEqual(sentTo(address), 4);
      const signature = await ESignature.findById(id);
      assert.strictEqual(signature.signingToken.sendCount, 4);
    });

    await test("in-person signing is not guarded: nothing is emailed and each start returns its link", async () => {
      const address = freshAddress();
      const contract = await makeContract(await makeProject(), address);
      const res = await api("POST", "/api/admin/signatures/native/send", {
        documentType: "CONTRACT",
        documentId: String(contract._id),
        mode: "IN_PERSON",
      });
      assert.strictEqual(res.status, 201, JSON.stringify(res.json));
      assert.ok(res.json.signingUrl);
      assert.strictEqual(res.json.duplicate, undefined);
      assert.strictEqual(sentTo(address), 0);
    });
  } finally {
    await new Promise((resolve) => listener.close(resolve));
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
  console.error("document send idempotency suite crashed:", error);
  process.exit(1);
});
