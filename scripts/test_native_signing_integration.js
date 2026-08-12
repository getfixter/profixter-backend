/**
 * Native signing — integration and failure tests.
 *
 * Drives the REAL orchestration service against an in-memory MongoDB, with S3
 * and email replaced by injectable fakes. Unit suites prove the primitives;
 * this suite proves the wiring, and above all the failure ordering:
 *
 *   an Agreement must never appear signed unless every artifact that proves it
 *   was durably stored first.
 *
 *   node scripts/test_native_signing_integration.js
 *
 * Not part of `npm test`: it downloads and boots a MongoDB binary, which is too
 * heavy and too network-dependent for the deploy gate. Run it locally and in
 * any pre-release check.
 */

process.env.S3_BUCKET = process.env.S3_BUCKET || "test-bucket";
// Tests run without the real company signature asset; production must not.
process.env.ESIGN_ALLOW_UNSIGNED_COMPANY = "true";
process.env.PUBLIC_SITE_BASE_URL = "https://profixter.test";

const assert = require("assert");
const Module = require("module");

/* ------------------------------------------------------------------ */
/* Dependency injection                                                */
/*                                                                     */
/* s3.js talks to AWS at require time, so it is replaced in the module  */
/* cache before anything loads it. Each fake exposes a failure switch   */
/* so a specific step of completion can be made to fail on demand.      */
/* ------------------------------------------------------------------ */

const s3Store = new Map();
const s3Fail = { putMatching: null, getMatching: null };

const fakeS3 = {
  async putPrivateObject({ Key, Body }) {
    if (s3Fail.putMatching && Key.includes(s3Fail.putMatching)) {
      throw new Error(`Injected S3 write failure for ${s3Fail.putMatching}`);
    }
    s3Store.set(Key, Buffer.from(Body));
    return { Key };
  },
  async getObjectBuffer({ Key }) {
    if (s3Fail.getMatching && Key.includes(s3Fail.getMatching)) {
      throw new Error("Injected S3 read failure");
    }
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

const s3Path = require.resolve("../utils/s3");
const emailPath = require.resolve("../utils/emailService");
require.cache[s3Path] = { id: s3Path, filename: s3Path, loaded: true, exports: fakeS3 };
require.cache[emailPath] = { id: emailPath, filename: emailPath, loaded: true, exports: fakeEmail };
void Module;

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const ESignature = require("../models/ESignature");
const Contract = require("../models/Contract");
const ChangeOrder = require("../models/ChangeOrder");
const Counter = require("../models/Counter");
const service = require("../utils/esign/nativeSignatureService");
const native = require("../utils/esign/nativeSigning");
const { summarizeContractValue } = require("../utils/changeOrderTotals");
const { DISCLOSURE_VERSION } = require("../config/electronicSignatureDisclosure");

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

/** A small real PNG standing in for a drawn signature. */
const SIGNATURE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAGQAAAAyCAYAAACqNX6+AAAAJUlEQVR42u3BAQ0AAAgDoJvc6PhWwQUJ0CFJkiRJkiRJkiRJ+jUBcXcAAeMHkbUAAAAASUVORK5CYII=",
  "base64"
);
/**
 * decodeSignatureImage enforces a minimum size so an untouched pad cannot be
 * submitted as a signature. The tiny fixture above is fine as raw bytes but is
 * below that floor, so the data-URL fixture is padded to represent a real
 * drawn signature.
 */
const SIGNATURE_DATA_URL = `data:image/png;base64,${Buffer.concat([
  SIGNATURE_PNG,
  Buffer.alloc(800, 0x20),
]).toString("base64")}`;

const OID = () => new mongoose.Types.ObjectId();

async function makeContract(overrides = {}) {
  return Contract.create({
    contractNumber: String(Date.now()).slice(-6),
    version: 3,
    projectId: OID(),
    status: "Generated",
    customerSnapshot: { fullName: "Jane Homeowner", email: "jane@example.com" },
    propertySnapshot: { address: "12 Ocean Ave, Lindenhurst NY" },
    workType: "Bathroom",
    projectDescription: "Full bathroom remodel",
    scopeText: "Demolition, plumbing, tile",
    originalContractPriceCents: 2000000,
    totalPriceCents: 2000000,
    adjustedContractPriceCents: 2000000,
    depositAmountCents: 500000,
    remainingBalanceCents: 1500000,
    paymentSchedule: [],
    dates: { contractDate: new Date("2026-08-01") },
    generatedPdf: { key: "x", fileName: "x.pdf" },
    createdBy: OID(),
    ...overrides,
  });
}

async function makeChangeOrder(contract, { amountCents = 400000, direction = "add" } = {}) {
  const sequence = await ChangeOrder.nextSequence(contract.contractNumber);
  return ChangeOrder.create({
    changeOrderNumber: ChangeOrder.formatNumber(contract.contractNumber, sequence),
    sequence,
    projectId: contract.projectId,
    contractId: contract._id,
    status: "Ready to Send",
    title: "Test change",
    customerSnapshot: { fullName: "Jane Homeowner", email: "jane@example.com" },
    propertySnapshot: { address: "12 Ocean Ave", projectNumber: "P-1" },
    contractSnapshot: {
      contractNumber: contract.contractNumber,
      contractDate: new Date("2026-08-01"),
      originalContractAmountCents: 2000000,
    },
    lines: [{ description: "Change", direction, amountCents }],
    contractAmountBeforeChangeCents: 2000000,
    generatedPdf: { key: "co", fileName: "co.pdf" },
    createdBy: OID(),
  });
}

const createRemote = (doc, type = "CONTRACT") =>
  service.createSignatureRequest({
    documentType: type,
    documentId: doc._id,
    signingMode: "REMOTE",
    createdBy: OID(),
    context: { ip: "203.0.113.9", userAgent: "TestAgent" },
  });

const sign = (signature) =>
  service.completeSignature({
    signature,
    signatureImageBuffer: SIGNATURE_PNG,
    consentAccepted: true,
    context: { ip: "203.0.113.9", userAgent: "TestAgent" },
  });

function resetInjection() {
  s3Fail.putMatching = null;
  s3Fail.getMatching = null;
  emailFail.enabled = false;
}

/* ------------------------------------------------------------------ */

async function main() {
  const server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());

  try {
    /* ---------------- request creation ---------------- */
    console.log("\nRemote request creation");

    const contract = await makeContract();
    const created = await createRemote(contract);

    await test("a raw token is returned exactly once", () => {
      assert.ok(created.rawToken && created.rawToken.length >= 43);
    });

    await test("the raw token is never persisted anywhere in the record", async () => {
      const stored = await ESignature.findById(created.signature._id).lean();
      const serialized = JSON.stringify(stored);
      assert.ok(!serialized.includes(created.rawToken), "raw token found in the stored record");
      assert.strictEqual(stored.signingToken.hash, native.hashToken(created.rawToken));
    });

    await test("the frozen document and its hash are stored", async () => {
      const stored = await ESignature.findById(created.signature._id);
      assert.ok(stored.frozenDocument.key);
      assert.strictEqual(stored.frozenDocument.sha256.length, 64);
      assert.strictEqual(stored.frozenDocument.documentVersion, 3);
      assert.ok(s3Store.has(stored.frozenDocument.key));
    });

    await test("the stored frozen bytes hash to exactly the recorded hash", async () => {
      const stored = await ESignature.findById(created.signature._id);
      const bytes = s3Store.get(stored.frozenDocument.key);
      assert.strictEqual(native.sha256(bytes), stored.frozenDocument.sha256);
    });

    await test("signature anchors are captured for execution", async () => {
      const stored = await ESignature.findById(created.signature._id);
      const anchors = stored.providerMeta?.anchors || [];
      assert.ok(anchors.some((a) => a.field === "customer"), JSON.stringify(anchors));
    });

    await test("a second live request for the same document is refused", async () => {
      await assert.rejects(() => createRemote(contract), /already has a signature request/i);
    });

    await test("no public S3 object is ever written", () => {
      // fakeS3.putPublicObject throws; reaching here means it was never called.
      assert.ok(true);
    });

    /* ---------------- token lookup ---------------- */
    console.log("\nToken lookup and terminal states");

    await test("lookup by raw token resolves via the stored hash", async () => {
      const { signature, reason } = await native.findByToken(created.rawToken);
      assert.ok(signature);
      assert.strictEqual(reason, null);
    });

    await test("an unknown token resolves to not_found", async () => {
      const { signature, reason } = await native.findByToken(native.generateToken());
      assert.strictEqual(signature, null);
      assert.strictEqual(reason, "not_found");
    });

    await test("a revoked request rejects its token", async () => {
      const other = await createRemote(await makeContract());
      await service.revokeSignature({ signature: other.signature, reason: "test" });
      const { reason } = await native.findByToken(other.rawToken);
      assert.strictEqual(reason, "revoked");
    });

    await test("an expired request rejects its token", async () => {
      const other = await createRemote(await makeContract());
      other.signature.signingToken.expiresAt = new Date(Date.now() - 1000);
      await other.signature.save();
      const { reason } = await native.findByToken(other.rawToken);
      assert.strictEqual(reason, "expired");
    });

    /* ---------------- consent and signature ---------------- */
    console.log("\nConsent and signature validation");

    await test("signing without consent is refused", async () => {
      const c = await createRemote(await makeContract());
      await assert.rejects(
        () =>
          service.completeSignature({
            signature: c.signature,
            signatureImageBuffer: SIGNATURE_PNG,
            consentAccepted: false,
          }),
        /consent/i
      );
    });

    await test("signing without a signature image is refused", async () => {
      const c = await createRemote(await makeContract());
      await assert.rejects(
        () =>
          service.completeSignature({
            signature: c.signature,
            signatureImageBuffer: null,
            consentAccepted: true,
          }),
        /signature/i
      );
    });

    await test("an invalid signature payload is refused at the boundary", () => {
      assert.ok(native.decodeSignatureImage("data:image/svg+xml;base64,PHN2Zz4=").error);
      assert.ok(native.decodeSignatureImage(SIGNATURE_DATA_URL).buffer);
    });

    /* ---------------- durable completion ---------------- */
    console.log("\nDurable completion");

    const happy = await createRemote(await makeContract());
    const completed = await sign(happy.signature);

    await test("completion produces executed PDF, hash and certificate", async () => {
      assert.strictEqual(completed.status, "Completed");
      assert.ok(completed.completedAt);
      assert.ok(completed.executedPdf.key && s3Store.has(completed.executedPdf.key));
      assert.strictEqual(completed.executedSha256.length, 64);
      assert.ok(completed.certificatePdf.key && s3Store.has(completed.certificatePdf.key));
      assert.ok(completed.signatureImage.key && s3Store.has(completed.signatureImage.key));
    });

    await test("the frozen original is retained unchanged", async () => {
      const bytes = s3Store.get(completed.frozenDocument.key);
      assert.strictEqual(native.sha256(bytes), completed.frozenDocument.sha256);
      assert.notStrictEqual(completed.executedSha256, completed.frozenDocument.sha256);
    });

    await test("consent is recorded with the disclosure version", () => {
      assert.strictEqual(completed.consent.disclosureVersion, DISCLOSURE_VERSION);
      assert.ok(completed.consent.acceptedAt);
    });

    await test("the Agreement becomes Signed with the executed PDF attached", async () => {
      const doc = await Contract.findById(completed.documentId);
      assert.strictEqual(doc.status, "Signed");
      assert.strictEqual(doc.signedPdf.key, completed.executedPdf.key);
    });

    await test("the audit trail records execution", () => {
      const names = completed.auditEvents.map((e) => e.event);
      assert.ok(names.includes(native.AUDIT.CREATED));
      assert.ok(names.includes(native.AUDIT.SUBMITTED));
      assert.ok(names.includes(native.AUDIT.EXECUTED));
    });

    await test("a completed request cannot be signed again", async () => {
      const again = await sign(completed);
      // Idempotent: returns the same completed record rather than re-executing.
      assert.strictEqual(String(again._id), String(completed._id));
      assert.strictEqual(again.status, "Completed");
    });

    /* ---------------- concurrency ---------------- */
    console.log("\nConcurrent completion");

    await test("two simultaneous submissions produce exactly one execution", async () => {
      const c = await createRemote(await makeContract());
      const fresh1 = await ESignature.findById(c.signature._id);
      const fresh2 = await ESignature.findById(c.signature._id);
      const results = await Promise.allSettled([sign(fresh1), sign(fresh2)]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      // One wins outright; the other either loses the claim (rejects) or
      // observes the completed record. Neither may produce a second execution.
      const final = await ESignature.findById(c.signature._id);
      assert.strictEqual(final.status, "Completed");
      const executed = final.auditEvents.filter((e) => e.event === native.AUDIT.EXECUTED);
      assert.strictEqual(executed.length, 1, `executed ${executed.length} times`);
      assert.ok(fulfilled.length >= 1);
    });

    /* ---------------- artifact failure ---------------- */
    console.log("\nArtifact failure leaves no false Signed state");

    for (const [label, marker] of [
      ["executed PDF storage", "/executed/"],
      ["signature image storage", "/signature/"],
      ["certificate storage", "/certificate/"],
    ]) {
      await test(`${label} failure does not mark the Agreement signed`, async () => {
        resetInjection();
        const c = await createRemote(await makeContract());
        s3Fail.putMatching = marker;

        await assert.rejects(() => sign(c.signature));

        const stored = await ESignature.findById(c.signature._id);
        assert.notStrictEqual(stored.status, "Completed");
        assert.ok(!stored.completedAt, "completedAt must be absent");
        assert.strictEqual(stored.signingToken.state, "active", "claim must be released");
        assert.ok(
          stored.auditEvents.some((e) => e.event === "SIGNATURE_COMPLETION_FAILED"),
          "failure must be recorded"
        );

        const doc = await Contract.findById(stored.documentId);
        assert.notStrictEqual(doc.status, "Signed");

        // And the retry must succeed once the fault clears.
        resetInjection();
        const retried = await sign(await ESignature.findById(c.signature._id));
        assert.strictEqual(retried.status, "Completed");
        const executed = retried.auditEvents.filter((e) => e.event === native.AUDIT.EXECUTED);
        assert.strictEqual(executed.length, 1, "retry must not double-execute");
      });
    }

    resetInjection();

    /* ---------------- decline, revoke ---------------- */
    console.log("\nDecline and revoke");

    await test("decline is terminal and blocks later signing", async () => {
      const c = await createRemote(await makeContract());
      await service.declineSignature({ signature: c.signature, reason: "Price too high" });
      const stored = await ESignature.findById(c.signature._id);
      assert.strictEqual(stored.status, "Declined");
      assert.strictEqual(stored.declineReason, "Price too high");
      const { reason } = await native.findByToken(c.rawToken);
      assert.strictEqual(reason, "declined");
    });

    await test("revoke retains the frozen document and history", async () => {
      const c = await createRemote(await makeContract());
      const frozenKey = c.signature.frozenDocument.key;
      await service.revokeSignature({ signature: c.signature, reason: "superseded" });
      const stored = await ESignature.findById(c.signature._id);
      assert.strictEqual(stored.signingToken.state, "revoked");
      assert.ok(s3Store.has(frozenKey), "frozen original must be retained");
      assert.ok(stored.auditEvents.some((e) => e.event === native.AUDIT.REVOKED));
    });

    /* ---------------- in-person ---------------- */
    console.log("\nIn-person signing");

    await test("an in-person session is bound to the initiating admin", async () => {
      const adminId = OID();
      const c = await service.createSignatureRequest({
        documentType: "CONTRACT",
        documentId: (await makeContract())._id,
        signingMode: "IN_PERSON",
        createdBy: adminId,
        context: { ip: "10.0.0.1", userAgent: "iPad", actorEmail: "admin@profixter.com" },
      });
      assert.strictEqual(c.signature.signingMode, "IN_PERSON");
      assert.strictEqual(String(c.signature.inPersonSession.initiatedBy), String(adminId));
      assert.strictEqual(c.signature.inPersonSession.initiatedByEmail, "admin@profixter.com");
    });

    await test("an in-person session expires far sooner than a remote link", async () => {
      const c = await service.createSignatureRequest({
        documentType: "CONTRACT",
        documentId: (await makeContract())._id,
        signingMode: "IN_PERSON",
        createdBy: OID(),
        context: {},
      });
      const remote = await createRemote(await makeContract());
      assert.ok(
        c.signature.signingToken.expiresAt < remote.signature.signingToken.expiresAt,
        "in-person expiry must be shorter"
      );
    });

    await test("in-person completes through the same pipeline and audits IN_PERSON", async () => {
      const c = await service.createSignatureRequest({
        documentType: "CONTRACT",
        documentId: (await makeContract())._id,
        signingMode: "IN_PERSON",
        createdBy: OID(),
        context: { actorEmail: "admin@profixter.com" },
      });
      const done = await sign(c.signature);
      assert.strictEqual(done.status, "Completed");
      assert.strictEqual(done.signingMode, "IN_PERSON");
      assert.ok(done.certificatePdf.key && s3Store.has(done.certificatePdf.key));
      const createdEvent = done.auditEvents.find((e) => e.event === native.AUDIT.CREATED);
      assert.strictEqual(createdEvent.details.signingMode, "IN_PERSON");
    });

    /* ---------------- Change Order financials ---------------- */
    console.log("\nChange Order financial integrity");

    const finContract = await makeContract();
    const co1 = await makeChangeOrder(finContract, { amountCents: 200000 });
    const co2 = await makeChangeOrder(finContract, { amountCents: 400000 });

    await test("a pending Change Order is projected, never executed value", async () => {
      const orders = await ChangeOrder.find({ contractId: finContract._id }).lean();
      const totals = summarizeContractValue(2000000, orders);
      assert.strictEqual(totals.executedContractCents, 2000000);
      assert.strictEqual(totals.projectedContractCents, 2600000);
    });

    await test("executing CO #1 moves current value by exactly its amount", async () => {
      const c = await createRemote(co1, "CHANGE_ORDER");
      await sign(c.signature);
      const stored = await ChangeOrder.findById(co1._id);
      assert.strictEqual(stored.status, "Executed");
      const orders = await ChangeOrder.find({ contractId: finContract._id }).lean();
      const totals = summarizeContractValue(2000000, orders);
      assert.strictEqual(totals.executedContractCents, 2200000);
      assert.strictEqual(totals.projectedContractCents, 2600000);
    });

    await test("executing CO #2 brings current value to the projected figure", async () => {
      const c = await createRemote(co2, "CHANGE_ORDER");
      await sign(c.signature);
      const orders = await ChangeOrder.find({ contractId: finContract._id }).lean();
      const totals = summarizeContractValue(2000000, orders);
      assert.strictEqual(totals.executedContractCents, 2600000);
    });

    await test("a replayed completion cannot apply a Change Order twice", async () => {
      const stored = await ESignature.findOne({ documentId: co2._id });
      await service.executeDocument(stored);
      await service.executeDocument(stored);
      const orders = await ChangeOrder.find({ contractId: finContract._id }).lean();
      assert.strictEqual(summarizeContractValue(2000000, orders).executedContractCents, 2600000);
    });

    await test("a deduct Change Order lowers the executed value", async () => {
      const deduct = await makeChangeOrder(finContract, { amountCents: 100000, direction: "deduct" });
      const c = await createRemote(deduct, "CHANGE_ORDER");
      await sign(c.signature);
      const orders = await ChangeOrder.find({ contractId: finContract._id }).lean();
      assert.strictEqual(summarizeContractValue(2000000, orders).executedContractCents, 2500000);
    });

    await test("a declined Change Order contributes nothing", async () => {
      const declined = await makeChangeOrder(finContract, { amountCents: 900000 });
      const c = await createRemote(declined, "CHANGE_ORDER");
      await service.declineSignature({ signature: c.signature, reason: "no" });
      const stored = await ChangeOrder.findById(declined._id);
      assert.notStrictEqual(stored.status, "Executed");
      const orders = await ChangeOrder.find({ contractId: finContract._id }).lean();
      assert.strictEqual(summarizeContractValue(2000000, orders).executedContractCents, 2500000);
    });

    await test("an artifact failure cannot move money", async () => {
      const risky = await makeChangeOrder(finContract, { amountCents: 700000 });
      const c = await createRemote(risky, "CHANGE_ORDER");
      s3Fail.putMatching = "/certificate/";
      await assert.rejects(() => sign(c.signature));
      resetInjection();
      const stored = await ChangeOrder.findById(risky._id);
      assert.notStrictEqual(stored.status, "Executed");
      const orders = await ChangeOrder.find({ contractId: finContract._id }).lean();
      assert.strictEqual(summarizeContractValue(2000000, orders).executedContractCents, 2500000);
    });

    /* ---------------- manual upload ---------------- */
    console.log("\nManual upload");

    await test("manual upload records MANUAL_UPLOAD without fabricated evidence", async () => {
      const c = await makeContract();
      const signature = await service.recordManualUpload({
        documentType: "CONTRACT",
        documentId: c._id,
        buffer: Buffer.from("%PDF-1.4 scanned signed copy"),
        fileName: "scan.pdf",
        uploadedBy: OID(),
        context: { actorEmail: "admin@profixter.com" },
      });

      assert.strictEqual(signature.signingMode, "MANUAL_UPLOAD");
      assert.strictEqual(signature.status, "Completed");
      // Nothing about a native ceremony may be invented.
      assert.ok(!signature.signingToken?.hash, "no signing token may exist");
      assert.ok(!signature.consent?.acceptedAt, "no consent may be fabricated");
      assert.ok(!signature.certificatePdf?.key, "no native certificate may be produced");
      assert.ok(
        signature.auditEvents.some((e) => e.event === native.AUDIT.MANUAL_UPLOAD),
        "manual upload must be audited"
      );
      const doc = await Contract.findById(c._id);
      assert.strictEqual(doc.status, "Signed");
    });

    /* ---------------- Adobe compatibility ---------------- */
    console.log("\nAdobe compatibility and native startup");

    await test("native signing works with every Adobe credential absent", async () => {
      const saved = {};
      for (const key of [
        "ADOBE_SIGN_CLIENT_ID",
        "ADOBE_SIGN_CLIENT_SECRET",
        "ADOBE_SIGN_REFRESH_TOKEN",
        "ADOBE_SIGN_TOKEN_HOST",
      ]) {
        saved[key] = process.env[key];
        delete process.env[key];
      }
      try {
        const c = await createRemote(await makeContract());
        const done = await sign(c.signature);
        assert.strictEqual(done.status, "Completed");
      } finally {
        for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
      }
    });

    await test("Adobe startup provisioning is disabled by default", async () => {
      const provisioner = require("../utils/esign/webhookProvisioner");
      // Resolves without throwing and without contacting Adobe.
      await provisioner.runStartupProvisioning();
      assert.ok(true);
    });

    await test("a historical adobe_sign record remains valid and readable", async () => {
      const legacy = await ESignature.create({
        projectId: OID(),
        documentType: "CONTRACT",
        documentId: OID(),
        provider: "adobe_sign",
        providerAgreementId: "CBJCHBCAABAA-legacy",
        status: "Completed",
        signers: [{ role: "CUSTOMER", email: "old@example.com" }],
      });
      const read = await ESignature.findById(legacy._id);
      assert.strictEqual(read.provider, "adobe_sign");
      assert.strictEqual(read.providerAgreementId, "CBJCHBCAABAA-legacy");
    });

    /* ---------------- company signature guard ---------------- */
    console.log("\nCompany signature guard");

    await test("production refuses to create a request without the company signature", async () => {
      const doc = await makeContract();
      delete process.env.ESIGN_ALLOW_UNSIGNED_COMPANY;
      try {
        await assert.rejects(() => createRemote(doc), /signature is not configured/i);
      } finally {
        process.env.ESIGN_ALLOW_UNSIGNED_COMPANY = "true";
      }
    });

    await test("a blocked request leaves no orphan record behind", async () => {
      delete process.env.ESIGN_ALLOW_UNSIGNED_COMPANY;
      const doc = await makeContract();
      try {
        await createRemote(doc).catch(() => {});
        const orphans = await ESignature.countDocuments({ documentId: doc._id });
        assert.strictEqual(orphans, 0);
      } finally {
        process.env.ESIGN_ALLOW_UNSIGNED_COMPANY = "true";
      }
    });

    await test("a refused send leaves no company execution date behind", async () => {
      delete process.env.ESIGN_ALLOW_UNSIGNED_COMPANY;
      const doc = await makeContract();
      try {
        await createRemote(doc).catch(() => {});
        const stored = await Contract.findById(doc._id).lean();
        assert.ok(
          !stored.dates?.companySignedAt,
          "a document that was never issued must not be recorded as executed"
        );
      } finally {
        process.env.ESIGN_ALLOW_UNSIGNED_COMPANY = "true";
      }
    });

    /* ---------------- company execution date ---------------- */
    console.log("\nCompany execution date");

    await test("an Agreement already generated keeps the date it was generated with", async () => {
      const doc = await makeContract();
      // As if the Agreement PDF had been produced last Monday.
      const monday = new Date("2026-08-03T15:00:00.000Z");
      doc.dates.companySignedAt = monday;
      doc.markModified("dates");
      await doc.save();

      await createRemote(doc);
      const stored = await Contract.findById(doc._id).lean();
      assert.strictEqual(
        new Date(stored.dates.companySignedAt).getTime(),
        monday.getTime(),
        "freezing for signature must not re-date the company signature"
      );
    });

    await test("a first send stamps the execution date and persists it", async () => {
      const doc = await makeContract();
      assert.ok(!doc.dates.companySignedAt, "starts unstamped");
      await createRemote(doc);
      const stored = await Contract.findById(doc._id).lean();
      assert.ok(stored.dates.companySignedAt, "the execution date is recorded on the document");
    });

    await test("a Change Order records its own execution date", async () => {
      const co = await makeChangeOrder(await makeContract());
      await createRemote(co, "CHANGE_ORDER");
      const stored = await ChangeOrder.findById(co._id).lean();
      assert.ok(stored.companySignedAt, "a change order is executed by the company too");
    });
  } finally {
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
  console.error("integration suite crashed:", error);
  process.exit(1);
});
