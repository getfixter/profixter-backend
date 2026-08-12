/**
 * Native signing — HTTP route, email, resend and expiry verification.
 *
 * Closes the four gaps the service-level integration suite left open. This one
 * drives the REAL Express routers over HTTP against an in-memory MongoDB, with
 * S3, email and admin auth injected.
 *
 *   node scripts/test_native_signing_routes.js
 *
 * Excluded from `npm test` for the same reason as the other integration suite:
 * it boots a MongoDB binary.
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
const s3Fail = { putMatching: null };
const fakeS3 = {
  async putPrivateObject({ Key, Body }) {
    if (s3Fail.putMatching && Key.includes(s3Fail.putMatching)) throw new Error("Injected S3 failure");
    s3Store.set(Key, Buffer.from(Body));
    return { Key };
  },
  async getObjectBuffer({ Key }) {
    if (!s3Store.has(Key)) throw new Error(`Missing object: ${Key}`);
    return s3Store.get(Key);
  },
  async putPublicObject() {
    throw new Error("Native signing must never write a public object");
  },
};

const emails = [];
const emailFail = { enabled: false };
const fakeEmail = {
  async sendRaw(payload) {
    if (emailFail.enabled) throw new Error("Injected email failure");
    emails.push(payload);
    return { messageId: `test-${emails.length}` };
  },
  async sendTx() {
    return { messageId: "tx" };
  },
};

/** Admin identity for the authenticated router, injected rather than minted. */
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
// Activity logging touches its own model; not the subject of these tests.
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

const ESignature = require("../models/ESignature");
const Contract = require("../models/Contract");
const ChangeOrder = require("../models/ChangeOrder");
const service = require("../utils/esign/nativeSignatureService");
const native = require("../utils/esign/nativeSigning");
const rateLimiter = require("../utils/rateLimit");
const { summarizeContractValue } = require("../utils/changeOrderTotals");

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

const OID = () => new mongoose.Types.ObjectId();
let base = "";

async function makeContract() {
  return Contract.create({
    contractNumber: String(Date.now()).slice(-6) + Math.floor(Math.random() * 9),
    version: 4,
    projectId: OID(),
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
    generatedPdf: { key: "x", fileName: "x.pdf" },
    createdBy: OID(),
  });
}

const api = async (method, path, body, raw = false) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return { status: res.status, headers: res.headers, buffer: Buffer.from(await res.arrayBuffer()) };
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
};

/** Create a request through the real admin route so the email path runs. */
async function sendRemote(documentId, documentType = "CONTRACT") {
  const res = await api("POST", "/api/admin/signatures/native/send", {
    documentType,
    documentId: String(documentId),
    mode: "REMOTE",
  });
  assert.strictEqual(res.status, 201, JSON.stringify(res.json));
  return res.json;
}

async function main() {
  const server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
  ADMIN.id = OID();

  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use("/api/sign", require("../routes/publicSigning"));
  app.use("/api/admin/signatures", require("../routes/adminSignatures"));
  const listener = http.createServer(app);
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${listener.address().port}`;

  try {
    /* =========== 1. EMAIL ASSERTIONS =========== */
    console.log("\nEmail lifecycle");

    const contract = await makeContract();
    emails.length = 0;
    const created = await sendRemote(contract._id);
    const requestEmail = emails[0];

    await test("exactly one request email is sent", () => {
      assert.strictEqual(emails.length, 1);
      assert.strictEqual(created.emailed, true);
    });

    await test("it goes to the customer with the right subject and number", () => {
      assert.strictEqual(requestEmail.to, "jane@example.com");
      assert.ok(/Signature requested/i.test(requestEmail.subject), requestEmail.subject);
      assert.ok(requestEmail.subject.includes(contract.contractNumber), requestEmail.subject);
    });

    await test("it carries the CTA and the current signing URL", () => {
      assert.ok(/Review &amp; Sign Agreement|Review & Sign Agreement/.test(requestEmail.html));
      assert.ok(requestEmail.html.includes(created.signingUrl), "signing URL missing from email");
      assert.ok(requestEmail.text.includes(created.signingUrl));
    });

    await test("the signing URL contains the current raw token", async () => {
      const rawToken = created.signingUrl.split("/sign/")[1];
      const stored = await ESignature.findById(created.signature.id);
      assert.strictEqual(stored.signingToken.hash, native.hashToken(rawToken));
    });

    await test("no S3 URL, no Adobe branding, no internal identifiers leak", () => {
      const blob = `${requestEmail.html}\n${requestEmail.text}\n${requestEmail.subject}`;
      assert.ok(!/s3\.amazonaws|s3\./i.test(blob), "storage URL leaked");
      assert.ok(!/adobe|acrobat|echosign/i.test(blob), "Adobe branding leaked");
      assert.ok(!blob.includes(String(created.signature.id)), "internal id leaked");
      assert.ok(!/sha256|frozenDocument|providerMeta/i.test(blob), "internal metadata leaked");
    });

    /* completion email */
    const rawToken1 = created.signingUrl.split("/sign/")[1];
    emails.length = 0;
    await test("completion email is sent only after durable completion", async () => {
      const res = await api("POST", `/api/sign/${rawToken1}/sign`, {
        consentAccepted: true,
        signatureImage: SIGNATURE_DATA_URL,
      });
      assert.strictEqual(res.status, 200, JSON.stringify(res.json));
      const stored = await ESignature.findById(created.signature.id);
      assert.strictEqual(stored.status, "Completed");
      assert.strictEqual(emails.length, 1);
      assert.ok(/signed/i.test(emails[0].subject), emails[0].subject);
      assert.ok(emails[0].attachments?.length, "executed PDF should be attached");
    });

    await test("an email failure does not roll back completion", async () => {
      const c2 = await makeContract();
      emails.length = 0;
      emailFail.enabled = true;
      const made = await api("POST", "/api/admin/signatures/native/send", {
        documentType: "CONTRACT",
        documentId: String(c2._id),
        mode: "REMOTE",
      });
      assert.strictEqual(made.status, 201);
      assert.strictEqual(made.json.emailed, false, "email should have failed");

      // The request is still valid and signable despite the mail failure.
      const stored = await ESignature.findById(made.json.signature.id);
      const raw = made.json.signingUrl.split("/sign/")[1];
      assert.strictEqual(stored.signingToken.hash, native.hashToken(raw));

      const res = await api("POST", `/api/sign/${raw}/sign`, {
        consentAccepted: true,
        signatureImage: SIGNATURE_DATA_URL,
      });
      emailFail.enabled = false;
      assert.strictEqual(res.status, 200, JSON.stringify(res.json));

      const done = await ESignature.findById(made.json.signature.id);
      assert.strictEqual(done.status, "Completed");
      assert.ok(done.executedPdf.key && s3Store.has(done.executedPdf.key));
      assert.ok(done.certificatePdf.key && s3Store.has(done.certificatePdf.key));
      assert.strictEqual(done.executedSha256.length, 64);
      const doc = await Contract.findById(c2._id);
      assert.strictEqual(doc.status, "Signed");
      const executed = done.auditEvents.filter((e) => e.event === native.AUDIT.EXECUTED);
      assert.strictEqual(executed.length, 1, "email failure must not cause double execution");
    });

    /* =========== 2. RESEND =========== */
    console.log("\nResend rotates exactly one active link");

    const rc = await makeContract();
    emails.length = 0;
    const first = await sendRemote(rc._id);
    const firstToken = first.signingUrl.split("/sign/")[1];
    const beforeRecord = await ESignature.findById(first.signature.id);
    const frozenBefore = {
      key: beforeRecord.frozenDocument.key,
      sha256: beforeRecord.frozenDocument.sha256,
      version: beforeRecord.frozenDocument.documentVersion,
      bytes: s3Store.get(beforeRecord.frozenDocument.key),
    };
    const contractVersionBefore = (await Contract.findById(rc._id)).version;

    emails.length = 0;
    const resent = await api("POST", `/api/admin/signatures/native/${first.signature.id}/resend`);
    const secondToken = resent.json?.signingUrl?.split("/sign/")[1];

    await test("resend reuses the same request and frozen document", async () => {
      assert.strictEqual(resent.status, 200, JSON.stringify(resent.json));
      const after = await ESignature.findById(first.signature.id);
      assert.strictEqual(String(after._id), String(beforeRecord._id));
      assert.strictEqual(String(after.documentId), String(rc._id));
      assert.strictEqual(after.frozenDocument.key, frozenBefore.key);
      assert.strictEqual(after.frozenDocument.sha256, frozenBefore.sha256);
      assert.strictEqual(after.frozenDocument.documentVersion, frozenBefore.version);
      assert.deepStrictEqual(s3Store.get(after.frozenDocument.key), frozenBefore.bytes);
    });

    await test("resend does not create a new Agreement revision", async () => {
      const after = await Contract.findById(rc._id);
      assert.strictEqual(after.version, contractVersionBefore);
      assert.strictEqual(await Contract.countDocuments({ contractNumber: rc.contractNumber }), 1);
    });

    await test("a new token replaces the old hash", async () => {
      assert.ok(secondToken && secondToken !== firstToken);
      const after = await ESignature.findById(first.signature.id);
      assert.strictEqual(after.signingToken.hash, native.hashToken(secondToken));
      assert.notStrictEqual(after.signingToken.hash, native.hashToken(firstToken));
    });

    await test("the old link stops working immediately", async () => {
      const res = await api("GET", `/api/sign/${firstToken}`);
      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.json.state, "invalid");
    });

    await test("the new link works", async () => {
      const res = await api("GET", `/api/sign/${secondToken}`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.state, "ready");
    });

    await test("the reminder email carries the new URL and send count is updated", async () => {
      assert.strictEqual(emails.length, 1);
      assert.ok(/Reminder/i.test(emails[0].subject), emails[0].subject);
      assert.ok(emails[0].html.includes(resent.json.signingUrl));
      assert.ok(!emails[0].html.includes(firstToken), "old token must not appear");
      const after = await ESignature.findById(first.signature.id);
      assert.strictEqual(after.signingToken.sendCount, 2);
      const sent = after.auditEvents.filter((e) => e.event === native.AUDIT.EMAIL_SENT);
      assert.strictEqual(sent.length, 2);
    });

    /* =========== 3. HTTP ROUTES =========== */
    console.log("\nPublic HTTP surface");

    const hc = await makeContract();
    const httpReq = await sendRemote(hc._id);
    const httpToken = httpReq.signingUrl.split("/sign/")[1];

    await test("GET /:token returns the signing payload without internal ids", async () => {
      const res = await api("GET", `/api/sign/${httpToken}`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.state, "ready");
      assert.ok(res.json.disclosure?.sections?.length);
      const blob = JSON.stringify(res.json);
      assert.ok(!blob.includes(String(hc._id)), "document id leaked");
      assert.ok(!/sha256|frozenDocument|s3|signingToken/i.test(blob), "internal state leaked");
    });

    await test("GET /:token/document returns the exact frozen bytes as a PDF", async () => {
      const res = await api("GET", `/api/sign/${httpToken}/document`, null, true);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers.get("content-type"), "application/pdf");
      const stored = await ESignature.findById(httpReq.signature.id);
      assert.strictEqual(native.sha256(res.buffer), stored.frozenDocument.sha256);
      assert.ok(!res.headers.get("location"), "no redirect to storage");
    });

    await test("unknown and malformed tokens answer identically", async () => {
      const unknown = await api("GET", `/api/sign/${native.generateToken()}`);
      const malformed = await api("GET", "/api/sign/not-a-real-token");
      assert.strictEqual(unknown.status, 404);
      assert.strictEqual(malformed.status, 404);
      assert.deepStrictEqual(unknown.json, malformed.json);
    });

    await test("signing without consent is refused", async () => {
      const res = await api("POST", `/api/sign/${httpToken}/sign`, {
        consentAccepted: false,
        signatureImage: SIGNATURE_DATA_URL,
      });
      assert.strictEqual(res.status, 400);
      assert.ok(/consent/i.test(res.json.message));
    });

    await test("a missing or malformed signature is refused", async () => {
      const empty = await api("POST", `/api/sign/${httpToken}/sign`, { consentAccepted: true });
      assert.strictEqual(empty.status, 400);
      const svg = await api("POST", `/api/sign/${httpToken}/sign`, {
        consentAccepted: true,
        signatureImage: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      });
      assert.strictEqual(svg.status, 400);
    });

    await test("client-supplied price, version, hash and timestamps are ignored", async () => {
      const res = await api("POST", `/api/sign/${httpToken}/sign`, {
        consentAccepted: true,
        signatureImage: SIGNATURE_DATA_URL,
        // All of this is hostile input and must have no effect whatsoever.
        adjustedContractPriceCents: 1,
        documentVersion: 999,
        frozenSha256: "0".repeat(64),
        executedSha256: "0".repeat(64),
        completedAt: "1999-01-01T00:00:00Z",
        status: "Completed",
        documentId: String(OID()),
      });
      assert.strictEqual(res.status, 200);

      const stored = await ESignature.findById(httpReq.signature.id);
      assert.strictEqual(stored.frozenDocument.documentVersion, 4, "version was overridden");
      assert.notStrictEqual(stored.frozenDocument.sha256, "0".repeat(64));
      assert.notStrictEqual(stored.executedSha256, "0".repeat(64));
      assert.ok(new Date(stored.completedAt).getFullYear() > 2020, "timestamp was overridden");
      assert.strictEqual(String(stored.documentId), String(hc._id), "document was swapped");
      const doc = await Contract.findById(hc._id);
      assert.strictEqual(doc.adjustedContractPriceCents, 2000000, "price was altered");
    });

    await test("a completed link cannot sign again and says so safely", async () => {
      const res = await api("GET", `/api/sign/${httpToken}`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.state, "completed");
      const retry = await api("POST", `/api/sign/${httpToken}/sign`, {
        consentAccepted: true,
        signatureImage: SIGNATURE_DATA_URL,
      });
      assert.strictEqual(retry.json.state, "completed");
    });

    /* ---------------- executed document access ---------------- */
    console.log("\nExecuted document access after signing");

    await test("a completed token can retrieve its own executed PDF", async () => {
      const res = await api("GET", `/api/sign/${httpToken}/executed`, null, true);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers.get("content-type"), "application/pdf");
      assert.ok(res.buffer.subarray(0, 5).toString() === "%PDF-", "a real PDF is returned");
    });

    await test("the bytes are exactly the stored executed document", async () => {
      const stored = await ESignature.findById(httpReq.signature.id);
      const fromStorage = s3Store.get(stored.executedPdf.key);
      const res = await api("GET", `/api/sign/${httpToken}/executed`, null, true);
      assert.ok(fromStorage && fromStorage.length, "the executed PDF was stored");
      assert.ok(res.buffer.equals(fromStorage), "served bytes differ from stored bytes");
      // The same bytes the certificate hash was taken over.
      assert.strictEqual(
        require("crypto").createHash("sha256").update(res.buffer).digest("hex"),
        stored.executedSha256
      );
    });

    await test("no storage URL, key or identifier is exposed", async () => {
      const res = await api("GET", `/api/sign/${httpToken}/executed`, null, true);
      assert.ok(!res.headers.get("location"), "must not redirect to storage");
      const disposition = res.headers.get("content-disposition") || "";
      assert.ok(disposition.includes("inline"), "opens in the browser by default");
      assert.ok(!/amazonaws|s3\.|private\/admin/i.test(disposition), "no storage path leaked");
      const stored = await ESignature.findById(httpReq.signature.id);
      assert.ok(!disposition.includes(String(stored._id)), "no database id in the filename");
      assert.ok(!disposition.includes(stored.executedPdf.key), "no storage key in the filename");
    });

    await test("download=1 asks the browser to save it instead", async () => {
      const res = await api("GET", `/api/sign/${httpToken}/executed?download=1`, null, true);
      assert.strictEqual(res.status, 200);
      assert.ok((res.headers.get("content-disposition") || "").includes("attachment"));
    });

    await test("retrieving the document does not reopen signing", async () => {
      // A fresh request, so this proves the rule rather than the rate limiter.
      const fresh = await sendRemote((await makeContract())._id);
      const freshToken = fresh.signingUrl.split("/sign/")[1];
      await api("POST", `/api/sign/${freshToken}/sign`, {
        consentAccepted: true,
        signatureImage: SIGNATURE_DATA_URL,
      });
      const before = await ESignature.findById(fresh.signature.id);
      const executedSha = before.executedSha256;

      const doc = await api("GET", `/api/sign/${freshToken}/executed`, null, true);
      assert.strictEqual(doc.status, 200);

      const retry = await api("POST", `/api/sign/${freshToken}/sign`, {
        consentAccepted: true,
        signatureImage: SIGNATURE_DATA_URL,
      });
      assert.strictEqual(retry.json.state, "completed", "the sign route stays terminal");

      const after = await ESignature.findById(fresh.signature.id);
      assert.strictEqual(after.signingToken.state, "completed");
      assert.strictEqual(after.signers.filter((x) => x.status === "Signed").length, 1);
      assert.strictEqual(after.executedSha256, executedSha, "the executed document was replaced");
    });

    await test("the completed page payload advertises the signed document", async () => {
      const res = await api("GET", `/api/sign/${httpToken}`);
      assert.strictEqual(res.json.state, "completed");
      assert.strictEqual(res.json.executedDocumentAvailable, true);
      assert.strictEqual(res.json.documentType, "CONTRACT");
    });

    await test("an active token has no executed document to retrieve", async () => {
      const pending = await sendRemote((await makeContract())._id);
      const pendingToken = pending.signingUrl.split("/sign/")[1];
      const res = await api("GET", `/api/sign/${pendingToken}/executed`);
      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.json.state, "invalid");
    });

    await test("an unrelated, unknown or malformed token is refused identically", async () => {
      const unknown = await api("GET", `/api/sign/${native.generateToken()}/executed`);
      const malformed = await api("GET", "/api/sign/not-a-real-token/executed");
      assert.strictEqual(unknown.status, 404);
      assert.strictEqual(malformed.status, 404);
      assert.deepStrictEqual(unknown.json, malformed.json, "responses must be indistinguishable");
    });

    await test("a revoked token cannot reach anyone's executed document", async () => {
      const rv = await sendRemote((await makeContract())._id);
      const rvToken = rv.signingUrl.split("/sign/")[1];
      await api("POST", `/api/admin/signatures/native/${rv.signature.id}/revoke`, { reason: "test" });
      const res = await api("GET", `/api/sign/${rvToken}/executed`);
      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.json.state, "invalid");
    });

    await test("a declined token cannot reach an executed document", async () => {
      const dc = await sendRemote((await makeContract())._id);
      const dcToken = dc.signingUrl.split("/sign/")[1];
      await api("POST", `/api/sign/${dcToken}/decline`, { reason: "No thanks" });
      const res = await api("GET", `/api/sign/${dcToken}/executed`);
      assert.strictEqual(res.status, 404);
    });

    await test("a Change Order's executed document is retrievable the same way", async () => {
      const parent = await makeContract();
      const sequence = await ChangeOrder.nextSequence(parent.contractNumber);
      const co = await ChangeOrder.create({
        changeOrderNumber: ChangeOrder.formatNumber(parent.contractNumber, sequence),
        sequence,
        projectId: parent.projectId,
        contractId: parent._id,
        status: "Ready to Send",
        title: "Additional electrical work",
        customerSnapshot: { fullName: "Jane Homeowner", email: "jane@example.com" },
        propertySnapshot: { address: "12 Ocean Ave" },
        contractSnapshot: {
          contractNumber: parent.contractNumber,
          originalContractAmountCents: 2000000,
        },
        lines: [{ description: "Add", direction: "add", amountCents: 150000 }],
        contractAmountBeforeChangeCents: 2000000,
        generatedPdf: { key: "co-exec", fileName: "co.pdf" },
        createdBy: OID(),
      });
      const req = await sendRemote(co._id, "CHANGE_ORDER");
      const coToken = req.signingUrl.split("/sign/")[1];
      const signed = await api("POST", `/api/sign/${coToken}/sign`, {
        consentAccepted: true,
        signatureImage: SIGNATURE_DATA_URL,
      });
      assert.strictEqual(signed.json.state, "completed");
      assert.strictEqual(signed.json.executedDocumentAvailable, true);

      const res = await api("GET", `/api/sign/${coToken}/executed`, null, true);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers.get("content-type"), "application/pdf");
      assert.ok((res.headers.get("content-disposition") || "").includes("Change-Order"));
    });

    await test("revoked and declined links are rejected over HTTP", async () => {
      const rv = await sendRemote((await makeContract())._id);
      const rvToken = rv.signingUrl.split("/sign/")[1];
      await api("POST", `/api/admin/signatures/native/${rv.signature.id}/revoke`, { reason: "test" });
      const res = await api("GET", `/api/sign/${rvToken}`);
      assert.strictEqual(res.json.state, "revoked");

      const dc = await sendRemote((await makeContract())._id);
      const dcToken = dc.signingUrl.split("/sign/")[1];
      const declined = await api("POST", `/api/sign/${dcToken}/decline`, { reason: "Too expensive" });
      assert.strictEqual(declined.status, 200);
      assert.strictEqual(declined.json.state, "declined");
      const after = await api("GET", `/api/sign/${dcToken}`);
      assert.strictEqual(after.json.state, "declined");
    });

    /* rate limiting */
    console.log("\nRate limiting");

    await test("a token-scoped read threshold returns 429 with Retry-After", async () => {
      rateLimiter._reset();
      const rl = await sendRemote((await makeContract())._id);
      const token = rl.signingUrl.split("/sign/")[1];
      let limited = null;
      for (let i = 0; i < 62; i += 1) {
        const res = await fetch(`${base}/api/sign/${token}`);
        if (res.status === 429) {
          limited = res;
          break;
        }
      }
      assert.ok(limited, "read limit never triggered");
      assert.ok(Number(limited.headers.get("retry-after")) > 0);
      const body = await limited.json();
      assert.ok(!/token|sha|s3|stack/i.test(JSON.stringify(body)), "limiter leaked detail");
    });

    await test("one abused token does not lock out another legitimate token", async () => {
      rateLimiter._reset();
      const a = await sendRemote((await makeContract())._id);
      const b = await sendRemote((await makeContract())._id);
      const tokenA = a.signingUrl.split("/sign/")[1];
      const tokenB = b.signingUrl.split("/sign/")[1];

      for (let i = 0; i < 62; i += 1) await fetch(`${base}/api/sign/${tokenA}`);
      const abused = await fetch(`${base}/api/sign/${tokenA}`);
      assert.strictEqual(abused.status, 429, "token A should be limited");

      const innocent = await fetch(`${base}/api/sign/${tokenB}`);
      assert.strictEqual(innocent.status, 200, "token B must not be collateral damage");
    });

    await test("the limit is a window, not a permanent lockout", async () => {
      rateLimiter._reset();
      const res = await fetch(`${base}/api/sign/${native.generateToken()}`);
      // After a reset the same caller is served again: no sticky ban list.
      assert.notStrictEqual(res.status, 429);
    });

    /* =========== 4. EXPIRY SWEEP =========== */
    console.log("\nExpiry sweep");

    await test("an elapsed active request becomes Expired with an audit event", async () => {
      const c = await sendRemote((await makeContract())._id);
      const rec = await ESignature.findById(c.signature.id);
      rec.signingToken.expiresAt = new Date(Date.now() - 60_000);
      await rec.save();

      const swept = await service.expireStaleRequests();
      assert.ok(swept >= 1);
      const after = await ESignature.findById(c.signature.id);
      assert.strictEqual(after.status, "Expired");
      assert.strictEqual(after.signingToken.state, "expired");
      assert.ok(after.auditEvents.some((e) => e.event === native.AUDIT.EXPIRED));

      const res = await api("GET", `/api/sign/${c.signingUrl.split("/sign/")[1]}`);
      assert.strictEqual(res.json.state, "expired");
    });

    await test("the sweep is idempotent and leaves fresh requests alone", async () => {
      const fresh = await sendRemote((await makeContract())._id);
      const before = await ESignature.findById(fresh.signature.id);
      await service.expireStaleRequests();
      await service.expireStaleRequests();
      const after = await ESignature.findById(fresh.signature.id);
      assert.strictEqual(after.status, before.status);
      assert.strictEqual(after.signingToken.state, "active");
    });

    await test("terminal states are never rewritten by the sweep", async () => {
      const states = await ESignature.find({
        status: { $in: ["Completed", "Declined", "Cancelled"] },
      }).lean();
      assert.ok(states.length >= 3, "expected completed, declined and revoked records to exist");
      await service.expireStaleRequests();
      for (const record of states) {
        const after = await ESignature.findById(record._id).lean();
        assert.strictEqual(after.status, record.status, `${record.status} was rewritten`);
      }
    });

    await test("an expired Change Order has no financial effect", async () => {
      const fc = await makeContract();
      const sequence = await ChangeOrder.nextSequence(fc.contractNumber);
      const co = await ChangeOrder.create({
        changeOrderNumber: ChangeOrder.formatNumber(fc.contractNumber, sequence),
        sequence,
        projectId: fc.projectId,
        contractId: fc._id,
        status: "Ready to Send",
        title: "Expiring change",
        customerSnapshot: { fullName: "Jane", email: "jane@example.com" },
        propertySnapshot: { address: "12 Ocean Ave" },
        contractSnapshot: { contractNumber: fc.contractNumber, originalContractAmountCents: 2000000 },
        lines: [{ description: "Add", direction: "add", amountCents: 500000 }],
        contractAmountBeforeChangeCents: 2000000,
        generatedPdf: { key: "co", fileName: "co.pdf" },
        createdBy: OID(),
      });

      const req = await sendRemote(co._id, "CHANGE_ORDER");
      const rec = await ESignature.findById(req.signature.id);
      rec.signingToken.expiresAt = new Date(Date.now() - 60_000);
      await rec.save();
      await service.expireStaleRequests();

      const storedCo = await ChangeOrder.findById(co._id);
      assert.notStrictEqual(storedCo.status, "Executed");
      const orders = await ChangeOrder.find({ contractId: fc._id }).lean();
      assert.strictEqual(summarizeContractValue(2000000, orders).executedContractCents, 2000000);
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
  console.error("route suite crashed:", error);
  process.exit(1);
});
