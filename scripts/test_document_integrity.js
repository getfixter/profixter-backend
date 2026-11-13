/**
 * Project document integrity (admin audit 2026-11-12, U-5 / P-01..P-07).
 *
 * The document record is the authority, never a signing link:
 *   - a voided change order or a canceled / superseded agreement can never be
 *     executed by an outstanding link, including when the void lands while the
 *     signature is being processed;
 *   - emailing a copy never downgrades a Signed agreement;
 *   - signed copies are recorded only for issued, open documents, once;
 *   - a signed agreement cannot be canceled;
 *   - an invoice with payments cannot be voided, Stripe payments are read-only,
 *     a paid-in-full invoice is locked and an issued edit is traceable;
 *   - stale signing requests are swept to Expired;
 *   - the owner is emailed when a customer signs or declines.
 *
 * Real Express routers over HTTP against an in-memory MongoDB. S3, email,
 * auth and the activity log are injected; nothing leaves the process.
 *
 *   node scripts/test_document_integrity.js
 */

process.env.S3_BUCKET = process.env.S3_BUCKET || "test-bucket";
process.env.ESIGN_ALLOW_UNSIGNED_COMPANY = "true";
process.env.PUBLIC_SITE_BASE_URL = "https://profixter.test";

const assert = require("assert");
const http = require("http");

/* ------------------------------------------------------------------ */
/* Injected dependencies                                               */
/* ------------------------------------------------------------------ */

const s3Store = new Map();
const s3Hooks = { onPut: null };
const fakeS3 = {
  async putPrivateObject({ Key, Body }) {
    s3Store.set(Key, Buffer.from(Body));
    if (s3Hooks.onPut) await s3Hooks.onPut(Key);
    return { Key };
  },
  async getObjectBuffer({ Key }) {
    if (!s3Store.has(Key)) return Buffer.from("%PDF-1.4 stored test document");
    return s3Store.get(Key);
  },
  async putPublicObject() {
    throw new Error("documents must never be public");
  },
};

const emails = [];
const fakeEmail = {
  ADMIN: "owner@profixter.test",
  FROM: "Profixter <no-reply@profixter.test>",
  REPLY_TO: "hello@profixter.test",
  async sendRaw(payload) {
    emails.push(payload);
    return { messageId: `test-${emails.length}` };
  },
  async sendTx() {
    return { messageId: "tx" };
  },
};

const activity = [];
const ADMIN = { id: null, email: "admin@profixter.com" };
const fakeAuth = (req, _res, next) => {
  req.user = { id: ADMIN.id };
  req.authUser = { email: ADMIN.email, role: "admin" };
  req.accessUser = { email: ADMIN.email };
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
const ESignature = require("../models/ESignature");
const Invoice = require("../models/Invoice");
const service = require("../utils/esign/nativeSignatureService");
const { runSignatureExpiryCycle } = require("../jobs/signatureExpiry");
const { summarizeContractValue } = require("../utils/changeOrderTotals");
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

const SIGNATURE_PNG = Buffer.concat([
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAGQAAAAyCAYAAACqNX6+AAAAJUlEQVR42u3BAQ0AAAgDoJvc6PhWwQUJ0CFJkiRJkiRJkiRJ+jUBcXcAAeMHkbUAAAAASUVORK5CYII=",
    "base64"
  ),
  Buffer.alloc(900, 0x20),
]);
const SIGNATURE_DATA_URL = `data:image/png;base64,${SIGNATURE_PNG.toString("base64")}`;
const PDF = Buffer.from("%PDF-1.4\n% signed paper copy\n%%EOF");

const OID = () => new mongoose.Types.ObjectId();
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

async function upload(path, fields) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  form.append("file", new Blob([PDF], { type: "application/pdf" }), "signed.pdf");
  const res = await fetch(`${base}${path}`, { method: "POST", body: form });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function makeProject() {
  seq += 1;
  return Project.create({
    projectNumber: `TEST-DI-${String(seq).padStart(4, "0")}`,
    customerName: "Jane Homeowner",
    email: "jane@example.com",
    phone: "6315550100",
    address: "12 Ocean Ave, Lindenhurst NY",
    projectType: "Bathroom",
  });
}

async function makeContract(project, overrides = {}) {
  seq += 1;
  return Contract.create({
    contractNumber: `DI${String(seq).padStart(5, "0")}`,
    version: 1,
    current: true,
    projectId: project._id,
    status: "Generated",
    customerSnapshot: { fullName: "Jane Homeowner", email: "jane@example.com" },
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
    ...overrides,
  });
}

async function makeChangeOrder(contract, overrides = {}) {
  const sequence = await ChangeOrder.nextSequence(contract.contractNumber);
  return ChangeOrder.create({
    changeOrderNumber: ChangeOrder.formatNumber(contract.contractNumber, sequence),
    sequence,
    projectId: contract.projectId,
    contractId: contract._id,
    status: "Ready to Send",
    title: "Additional electrical work",
    customerSnapshot: { fullName: "Jane Homeowner", email: "jane@example.com" },
    propertySnapshot: { address: "12 Ocean Ave" },
    contractSnapshot: { contractNumber: contract.contractNumber, originalContractAmountCents: 2000000 },
    lines: [{ description: "Add", direction: "add", amountCents: 150000 }],
    contractAmountBeforeChangeCents: 2000000,
    generatedPdf: { key: "co.pdf", fileName: "co.pdf" },
    createdBy: OID(),
    ...overrides,
  });
}

async function sendRemote(documentId, documentType) {
  const res = await api("POST", "/api/admin/signatures/native/send", {
    documentType,
    documentId: String(documentId),
    mode: "REMOTE",
  });
  assert.strictEqual(res.status, 201, JSON.stringify(res.json));
  return { ...res.json, token: res.json.signingUrl.split("/sign/")[1] };
}

const sign = (token) =>
  api("POST", `/api/sign/${token}/sign`, { consentAccepted: true, signatureImage: SIGNATURE_DATA_URL });

async function contractValue(contractId) {
  const orders = await ChangeOrder.find({ contractId }).lean();
  return summarizeContractValue(2000000, orders).executedContractCents;
}

async function main() {
  const server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
  ADMIN.id = OID();

  const app = express();
  app.use(express.json({ limit: "4mb" }));
  app.use("/api/sign", require("../routes/publicSigning"));
  app.use("/api/admin/signatures", require("../routes/adminSignatures"));
  app.use("/api/admin/contracts", require("../routes/adminContracts"));
  app.use("/api/admin/change-orders", require("../routes/adminChangeOrders"));
  app.use("/api/admin/invoices", require("../routes/adminInvoices"));
  app.use(
    "/api/admin/projects/:projectId/invoices",
    (req, _res, next) => {
      req.url = `/project/${req.params.projectId}${req.url}`;
      next();
    },
    require("../routes/adminInvoices")
  );
  const listener = http.createServer(app);
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${listener.address().port}`;

  try {
    /* ============ Change orders ============ */
    console.log("\nChange orders");

    await test("voiding a change order revokes its link; signing then is refused and nothing moves", async () => {
      const project = await makeProject();
      const contract = await makeContract(project);
      const co = await makeChangeOrder(contract);
      const req = await sendRemote(co._id, "CHANGE_ORDER");

      const voided = await api("POST", `/api/admin/change-orders/${co._id}/void`, { reason: "Owner withdrew" });
      assert.strictEqual(voided.status, 200, JSON.stringify(voided.json));
      const sig = await ESignature.findById(req.signature.id);
      assert.strictEqual(sig.signingToken.state, "revoked");
      assert.strictEqual(sig.status, "Cancelled");

      emails.length = 0;
      const signed = await sign(req.token);
      assert.notStrictEqual(signed.status, 500);
      assert.notStrictEqual(signed.json.state, "completed");
      const stored = await ChangeOrder.findById(co._id);
      assert.strictEqual(stored.status, "Voided");
      assert.strictEqual(await contractValue(contract._id), 2000000, "the agreement value is unchanged");
      assert.strictEqual(emails.length, 0, "no completion or owner email for a refused signature");
      assert.ok(activity.some((entry) => entry.action === "Change Order Voided"), "void is in the activity log");
    });

    await test("review 5: regenerating a sent change order revokes its link; the old PDF can no longer be signed", async () => {
      const project = await makeProject();
      const contract = await makeContract(project);
      const co = await makeChangeOrder(contract);
      const req = await sendRemote(co._id, "CHANGE_ORDER");
      const regenerated = await api("POST", `/api/admin/change-orders/${co._id}/generate`);
      assert.strictEqual(regenerated.status, 200, JSON.stringify(regenerated.json));
      const sig = await ESignature.findById(req.signature.id);
      assert.strictEqual(sig.signingToken.state, "revoked", "the old link is closed");
      emails.length = 0;
      const signed = await sign(req.token);
      assert.notStrictEqual(signed.status, 500);
      assert.notStrictEqual(signed.json.state, "completed");
      const stored = await ChangeOrder.findById(co._id);
      assert.strictEqual(stored.status, "Ready to Send", "not executed by the stale link");
      assert.strictEqual(await contractValue(contract._id), 2000000);
      assert.strictEqual(emails.length, 0);
      // The regenerated document can be sent again.
      const again = await sendRemote(co._id, "CHANGE_ORDER");
      assert.ok(again.token && again.token !== req.token);
    });

    await test("a live link on a change order voided outside the void route is still refused by the document check", async () => {
      const project = await makeProject();
      const contract = await makeContract(project);
      const co = await makeChangeOrder(contract);
      const req = await sendRemote(co._id, "CHANGE_ORDER");
      await ChangeOrder.updateOne({ _id: co._id }, { $set: { status: "Voided" } });

      const signed = await sign(req.token);
      assert.strictEqual(signed.status, 409, JSON.stringify(signed.json));
      assert.strictEqual(signed.json.code, "DOCUMENT_NOT_SIGNABLE");
      assert.ok(/withdrawn/i.test(signed.json.message), signed.json.message);
      assert.strictEqual((await ChangeOrder.findById(co._id)).status, "Voided");
      const sig = await ESignature.findById(req.signature.id);
      assert.strictEqual(sig.signingToken.state, "revoked", "the dead link is closed");
      assert.strictEqual(await contractValue(contract._id), 2000000);
    });

    await test("opening the link of a withdrawn change order shows it as no longer active", async () => {
      const project = await makeProject();
      const contract = await makeContract(project);
      const co = await makeChangeOrder(contract);
      const req = await sendRemote(co._id, "CHANGE_ORDER");
      await ChangeOrder.updateOne({ _id: co._id }, { $set: { status: "Declined" } });
      const view = await api("GET", `/api/sign/${req.token}`);
      assert.strictEqual(view.status, 200);
      assert.strictEqual(view.json.state, "revoked");
      assert.ok(/declined/i.test(view.json.message));
    });

    await test("race: a void that lands while the signature is being stored wins; files kept, nothing executed", async () => {
      const project = await makeProject();
      const contract = await makeContract(project);
      const co = await makeChangeOrder(contract);
      const req = await sendRemote(co._id, "CHANGE_ORDER");

      // The owner voids the change order between the claim and the execution:
      // the token is already claimed, so the revoke matches nothing and only
      // the document re-check can stop it.
      s3Hooks.onPut = async (key) => {
        if (key.includes("/certificate/")) {
          s3Hooks.onPut = null;
          const voided = await api("POST", `/api/admin/change-orders/${co._id}/void`, { reason: "race" });
          assert.strictEqual(voided.status, 200, JSON.stringify(voided.json));
        }
      };
      emails.length = 0;
      const signed = await sign(req.token);
      s3Hooks.onPut = null;

      assert.strictEqual(signed.status, 409, JSON.stringify(signed.json));
      assert.strictEqual((await ChangeOrder.findById(co._id)).status, "Voided");
      const sig = await ESignature.findById(req.signature.id);
      assert.strictEqual(sig.status, "Failed");
      assert.strictEqual(sig.signingToken.state, "revoked");
      const refusal = sig.auditEvents.find((e) => e.event === "SIGNATURE_REFUSED_DOCUMENT_CHANGED");
      assert.ok(refusal, "the refusal is audited");
      assert.ok(s3Store.has(refusal.details.retainedFiles.executedKey), "the executed file is kept for audit");
      assert.strictEqual(await contractValue(contract._id), 2000000);
      assert.strictEqual(emails.length, 0);
    });

    await test("race in the last window: the atomic execute refuses a change order voided after the re-check", async () => {
      const project = await makeProject();
      const contract = await makeContract(project);
      const co = await makeChangeOrder(contract);
      const signature = await ESignature.create({
        projectId: project._id,
        documentType: "CHANGE_ORDER",
        documentId: co._id,
        documentNumber: co.changeOrderNumber,
        provider: "native",
        status: "Completed",
        completedAt: new Date(),
        signers: [{ role: "CUSTOMER", name: "Jane", email: "jane@example.com" }],
        executedPdf: { key: "exec.pdf", fileName: "exec.pdf", size: 10 },
      });
      await ChangeOrder.updateOne({ _id: co._id }, { $set: { status: "Voided" } });
      const result = await service.executeDocument(signature);
      assert.strictEqual(result, null);
      assert.strictEqual((await ChangeOrder.findById(co._id)).status, "Voided");
    });

    await test("a declined change order cannot take an executed paper copy", async () => {
      const project = await makeProject();
      const contract = await makeContract(project);
      const co = await makeChangeOrder(contract, { status: "Declined" });
      const res = await upload(`/api/admin/change-orders/${co._id}/executed`, {});
      assert.strictEqual(res.status, 409);
      assert.strictEqual((await ChangeOrder.findById(co._id)).status, "Declined");
    });

    /* ============ Agreements ============ */
    console.log("\nAgreements");

    await test("canceling an agreement revokes its link; signing then is refused", async () => {
      const project = await makeProject();
      const contract = await makeContract(project);
      const req = await sendRemote(contract._id, "CONTRACT");
      const canceled = await api("POST", `/api/admin/contracts/${contract._id}/cancel`, {
        projectId: String(project._id),
        reason: "Customer chose another scope",
      });
      assert.strictEqual(canceled.status, 200, JSON.stringify(canceled.json));
      assert.strictEqual((await ESignature.findById(req.signature.id)).signingToken.state, "revoked");
      const signed = await sign(req.token);
      assert.notStrictEqual(signed.json.state, "completed");
      const stored = await Contract.findById(contract._id);
      assert.strictEqual(stored.status, "Canceled");
      assert.ok(!stored.signedPdf?.key, "no signed copy was attached");
    });

    await test("a superseded (regenerated) agreement cannot be signed through its old link", async () => {
      const project = await makeProject();
      const v1 = await makeContract(project);
      const req = await sendRemote(v1._id, "CONTRACT");
      // What generate does to older issued versions, without its PDF pipeline.
      await Contract.updateOne({ _id: v1._id }, { $set: { status: "Superseded", current: false } });
      const signed = await sign(req.token);
      assert.strictEqual(signed.status, 409, JSON.stringify(signed.json));
      assert.ok(/newer version/i.test(signed.json.message), signed.json.message);
      assert.strictEqual((await Contract.findById(v1._id)).status, "Superseded");
    });

    await test("a version that is no longer current cannot be signed, even if still Generated", async () => {
      const project = await makeProject();
      const v1 = await makeContract(project);
      const req = await sendRemote(v1._id, "CONTRACT");
      await Contract.updateOne({ _id: v1._id }, { $set: { current: false } });
      const signed = await sign(req.token);
      assert.strictEqual(signed.status, 409);
      assert.strictEqual((await Contract.findById(v1._id)).status, "Generated");
    });

    await test("revoking every link for a document is atomic and counts only live ones", async () => {
      const project = await makeProject();
      const contract = await makeContract(project);
      const req = await sendRemote(contract._id, "CONTRACT");
      assert.strictEqual(await service.revokeSignaturesForDocument("CONTRACT", contract._id, "agreement_revised"), 1);
      assert.strictEqual(await service.revokeSignaturesForDocument("CONTRACT", contract._id, "again"), 0);
      const sig = await ESignature.findById(req.signature.id);
      assert.strictEqual(sig.status, "Cancelled");
    });

    await test("emailing a Signed agreement keeps it Signed; emailing a Generated one moves it to Emailed", async () => {
      const project = await makeProject();
      const signedContract = await makeContract(project, { status: "Signed", signedPdf: { key: "signed.pdf" } });
      const res = await api("POST", `/api/admin/contracts/${signedContract._id}/email`, {
        projectId: String(project._id),
      });
      assert.strictEqual(res.status, 200, JSON.stringify(res.json));
      const stored = await Contract.findById(signedContract._id);
      assert.strictEqual(stored.status, "Signed");
      assert.strictEqual(stored.emailHistory.length, 1, "the copy is still recorded");

      const fresh = await makeContract(await makeProject());
      const res2 = await api("POST", `/api/admin/contracts/${fresh._id}/email`, {
        projectId: String(fresh.projectId),
      });
      assert.strictEqual(res2.status, 200);
      assert.strictEqual((await Contract.findById(fresh._id)).status, "Emailed");
    });

    await test("a Signed or Superseded agreement cannot be sent for signature", async () => {
      const project = await makeProject();
      for (const status of ["Signed", "Superseded"]) {
        const contract = await makeContract(project, { status, current: status === "Signed" });
        const res = await api("POST", "/api/admin/signatures/native/send", {
          documentType: "CONTRACT",
          documentId: String(contract._id),
          mode: "REMOTE",
        });
        assert.strictEqual(res.status, 400, `${status}: ${JSON.stringify(res.json)}`);
        assert.strictEqual(await ESignature.countDocuments({ documentId: contract._id }), 0);
      }
    });

    await test("uploading a signed copy of a Draft agreement is refused (both upload routes)", async () => {
      const project = await makeProject();
      const draft = await makeContract(project, { status: "Draft" });
      const legacy = await upload(`/api/admin/contracts/${draft._id}/signed`, { projectId: String(project._id) });
      assert.strictEqual(legacy.status, 409, JSON.stringify(legacy.json));
      const native = await upload("/api/admin/signatures/native/manual-upload", {
        documentType: "CONTRACT",
        documentId: String(draft._id),
      });
      assert.strictEqual(native.status, 409, JSON.stringify(native.json));
      const stored = await Contract.findById(draft._id);
      assert.strictEqual(stored.status, "Draft");
      assert.ok(!stored.signedPdf?.key);
    });

    await test("the signed-copy slot is write-once and a paper upload closes the live link", async () => {
      const project = await makeProject();
      const contract = await makeContract(project);
      const req = await sendRemote(contract._id, "CONTRACT");
      const first = await upload(`/api/admin/contracts/${contract._id}/signed`, { projectId: String(project._id) });
      assert.strictEqual(first.status, 200, JSON.stringify(first.json));
      const key = (await Contract.findById(contract._id)).signedPdf.key;
      assert.strictEqual((await ESignature.findById(req.signature.id)).signingToken.state, "revoked");

      const second = await upload(`/api/admin/contracts/${contract._id}/signed`, { projectId: String(project._id) });
      assert.strictEqual(second.status, 409);
      assert.strictEqual(second.json.code, "SIGNED_COPY_EXISTS");
      const again = await upload("/api/admin/signatures/native/manual-upload", {
        documentType: "CONTRACT",
        documentId: String(contract._id),
      });
      assert.strictEqual(again.status, 409);
      assert.strictEqual((await Contract.findById(contract._id)).signedPdf.key, key, "the first copy stands");
    });

    await test("a Signed agreement cannot be canceled", async () => {
      const project = await makeProject();
      const contract = await makeContract(project, { status: "Signed", signedPdf: { key: "s.pdf" } });
      const res = await api("POST", `/api/admin/contracts/${contract._id}/cancel`, {
        projectId: String(project._id),
        reason: "oops",
      });
      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.json.code, "INVALID_TRANSITION");
      assert.strictEqual((await Contract.findById(contract._id)).status, "Signed");
    });

    /* ============ Owner notifications ============ */
    console.log("\nOwner notifications");

    await test("the owner is emailed once when a customer signs", async () => {
      const project = await makeProject();
      const contract = await makeContract(project);
      const req = await sendRemote(contract._id, "CONTRACT");
      emails.length = 0;
      const signed = await sign(req.token);
      assert.strictEqual(signed.status, 200, JSON.stringify(signed.json));
      const owner = emails.filter((mail) => mail.to === fakeEmail.ADMIN);
      assert.strictEqual(owner.length, 1);
      assert.ok(/Agreement Signed - Jane Homeowner/.test(owner[0].subject), owner[0].subject);
      assert.ok(owner[0].html.includes(`/admin/projects/${project._id}`));
      assert.strictEqual((await Contract.findById(contract._id)).status, "Signed");
    });

    await test("the owner is emailed when a customer declines, with the reason", async () => {
      const project = await makeProject();
      const contract = await makeContract(project);
      const co = await makeChangeOrder(contract);
      const req = await sendRemote(co._id, "CHANGE_ORDER");
      emails.length = 0;
      const declined = await api("POST", `/api/sign/${req.token}/decline`, { reason: "Too expensive" });
      assert.strictEqual(declined.status, 200);
      const owner = emails.filter((mail) => mail.to === fakeEmail.ADMIN);
      assert.strictEqual(owner.length, 1);
      assert.ok(/CHANGE ORDER DECLINED/.test(owner[0].subject), owner[0].subject);
      assert.ok(owner[0].text.includes("Too expensive"));
    });

    /* ============ Expiry sweep ============ */
    console.log("\nExpiry sweep");

    await test("the scheduled sweep closes elapsed requests so they stop blocking a resend", async () => {
      const project = await makeProject();
      const contract = await makeContract(project);
      const req = await sendRemote(contract._id, "CONTRACT");
      await ESignature.updateOne(
        { _id: req.signature.id },
        { $set: { "signingToken.expiresAt": new Date(Date.now() - 60_000) } }
      );
      const count = await runSignatureExpiryCycle(new Date());
      assert.ok(count >= 1);
      const sig = await ESignature.findById(req.signature.id);
      assert.strictEqual(sig.status, "Expired");
      // A fresh request is now possible.
      await sendRemote(contract._id, "CONTRACT");
    });

    /* ============ Financials: executed vs proposed ============ */
    console.log("\nFinancials");

    await test("an unsigned agreement is proposed value, never executed value", async () => {
      const project = await makeProject();
      await makeContract(project);
      const summary = await getProjectFinancialSummary(project._id);
      assert.strictEqual(summary.valuation.executedValueCents, 0);
      assert.strictEqual(summary.valuation.proposedValueCents, 2000000);
      assert.strictEqual(summary.valuation.agreementSigned, false);
      assert.strictEqual(summary.totals.executedValueCents, 0, "also on totals, for one read path");
      assert.strictEqual(summary.agreement.isSigned, false);
      assert.strictEqual(summary.agreement.awaitingSignature, true);
    });

    await test("an unsigned revision never outranks the signed version", async () => {
      const project = await makeProject();
      const v1 = await makeContract(project, { status: "Signed", signedPdf: { key: "s.pdf" }, current: false });
      await makeContract(project, {
        contractNumber: v1.contractNumber,
        version: 2,
        current: true,
        status: "Generated",
        originalContractPriceCents: 2600000,
        totalPriceCents: 2600000,
        adjustedContractPriceCents: 2600000,
      });
      // Created open (so its totals compute), then executed.
      const co = await makeChangeOrder(v1);
      await ChangeOrder.updateOne({ _id: co._id }, { $set: { status: "Executed", executedAt: new Date() } });
      const summary = await getProjectFinancialSummary(project._id);
      assert.strictEqual(summary.agreement.version, 1, "the signed version is the agreement of record");
      assert.strictEqual(summary.valuation.executedValueCents, 2150000, "signed price plus executed change order");
      assert.strictEqual(summary.valuation.proposedValueCents, 2600000, "the revision is reported as proposed");
      assert.strictEqual(summary.proposedAgreement.version, 2);
      assert.strictEqual(summary.totals.approvedAgreementCents, 2150000);
    });

    /* ============ Invoices ============ */
    console.log("\nInvoices");

    async function makeInvoice(project, overrides = {}) {
      seq += 1;
      return Invoice.create({
        invoiceNumber: `DI${String(seq).padStart(6, "0")}`,
        projectId: project._id,
        status: "Sent",
        sentAt: new Date(),
        customerSnapshot: { fullName: "Jane Homeowner", email: "jane@example.com" },
        projectSnapshot: { projectNumber: project.projectNumber, workType: "Bathroom" },
        propertySnapshot: { address: project.address },
        lineItems: [{ description: "Deposit", quantity: 1, unitPriceCents: 500000, totalCents: 500000, category: "Contract work" }],
        subtotalCents: 500000,
        invoiceTotalCents: 500000,
        remainingBalanceCents: 500000,
        dates: { invoiceDate: new Date(), dueDate: new Date(Date.now() + 14 * 86400000) },
        createdBy: ADMIN.id,
        ...overrides,
      });
    }

    await test("an invoice with recorded payments cannot be voided (409 HAS_PAYMENTS)", async () => {
      const project = await makeProject();
      const invoice = await makeInvoice(project, {
        payments: [{ amountCents: 200000, paymentDate: new Date(), method: "Check" }],
      });
      const res = await api("POST", `/api/admin/invoices/${invoice._id}/void`, {
        projectId: String(project._id),
        confirmation: "VOID",
      });
      assert.strictEqual(res.status, 409, JSON.stringify(res.json));
      assert.strictEqual(res.json.code, "HAS_PAYMENTS");
      assert.strictEqual(res.json.paidCents, 200000);
      assert.notStrictEqual((await Invoice.findById(invoice._id)).status, "Voided");
      const summary = await getProjectFinancialSummary(project._id);
      assert.strictEqual(summary.totals.paidCents, 200000, "paid money stays counted");
    });

    await test("an invoice without payments can still be voided and the void is logged", async () => {
      const project = await makeProject();
      const invoice = await makeInvoice(project);
      const res = await api("POST", `/api/admin/invoices/${invoice._id}/void`, {
        projectId: String(project._id),
        confirmation: "VOID",
        reason: "Duplicate",
      });
      assert.strictEqual(res.status, 200, JSON.stringify(res.json));
      assert.strictEqual((await Invoice.findById(invoice._id)).status, "Voided");
      assert.ok(activity.some((entry) => entry.action === "Invoice Voided"));
    });

    await test("Stripe payments cannot be edited or removed", async () => {
      const project = await makeProject();
      const invoice = await makeInvoice(project, {
        payments: [
          {
            amountCents: 500000,
            paymentDate: new Date(),
            method: "Credit Card",
            provider: "stripe",
            stripePaymentIntentId: "pi_test_123",
          },
        ],
      });
      const paymentId = String(invoice.payments[0]._id);
      const edit = await api("PATCH", `/api/admin/invoices/${invoice._id}/payments/${paymentId}`, {
        projectId: String(project._id),
        amountCents: 100,
        method: "Cash",
        paymentDate: new Date().toISOString(),
      });
      assert.strictEqual(edit.status, 409);
      assert.strictEqual(edit.json.code, "STRIPE_PAYMENT_READ_ONLY");
      const del = await api("DELETE", `/api/admin/invoices/${invoice._id}/payments/${paymentId}?projectId=${project._id}`);
      assert.strictEqual(del.status, 409);
      const stored = await Invoice.findById(invoice._id);
      assert.strictEqual(stored.payments.length, 1);
      assert.strictEqual(stored.payments[0].amountCents, 500000);
    });

    await test("a manual payment edit is recorded with before and after", async () => {
      const project = await makeProject();
      const invoice = await makeInvoice(project, {
        payments: [{ amountCents: 100000, paymentDate: new Date(), method: "Check" }],
      });
      const paymentId = String(invoice.payments[0]._id);
      activity.length = 0;
      const edit = await api("PATCH", `/api/admin/invoices/${invoice._id}/payments/${paymentId}`, {
        projectId: String(project._id),
        amountCents: 150000,
        method: "Check",
        paymentDate: new Date().toISOString(),
      });
      assert.strictEqual(edit.status, 200, JSON.stringify(edit.json));
      const entry = activity.find((row) => row.action === "Invoice Payment Edited");
      assert.ok(entry, "payment edit logged");
      assert.strictEqual(entry.details.before.payment.amountCents, 100000);
      assert.strictEqual(entry.details.after.payment.amountCents, 150000);
    });

    await test("a paid-in-full invoice is locked against edits", async () => {
      const project = await makeProject();
      const invoice = await makeInvoice(project, {
        status: "Paid in Full",
        payments: [{ amountCents: 500000, paymentDate: new Date(), method: "Check" }],
      });
      const res = await api("POST", `/api/admin/projects/${project._id}/invoices/draft`, {
        invoiceId: String(invoice._id),
        lineItems: [{ description: "Changed", quantity: 1, unitPriceCents: 900000, category: "Contract work" }],
      });
      assert.strictEqual(res.status, 409, JSON.stringify(res.json));
      assert.strictEqual(res.json.code, "INVOICE_LOCKED");
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
  console.error("document integrity suite crashed:", error);
  process.exit(1);
});
