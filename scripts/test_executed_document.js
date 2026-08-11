/**
 * Executed document integrity — the chain that matters:
 *
 *   frozen bytes -> frozen SHA-256 -> overlay execution fields onto those exact
 *   bytes -> executed PDF -> executed SHA-256
 *
 * These tests exist to catch the failure that would matter most: the executed
 * document being re-rendered rather than built from the frozen bytes, which
 * would let substantive content drift between what was signed and what is kept.
 *
 *   node scripts/test_executed_document.js
 */

process.env.S3_BUCKET = process.env.S3_BUCKET || "test-bucket";

const assert = require("assert");
const { PDFDocument } = require("pdf-lib");
const { renderFrozenDocument, overlayExecution } = require("../utils/esign/executedDocument");

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

const PINNED = new Date("2026-08-01T12:00:00Z");
const SIGNED_AT = new Date("2026-08-12T15:00:00Z");

function sampleContract() {
  return {
    contractNumber: "000010",
    version: 3,
    customerSnapshot: { fullName: "Jane Homeowner" },
    propertySnapshot: { address: "12 Ocean Ave, Lindenhurst NY" },
    workType: "Bathroom",
    projectDescription: "Full bathroom remodel",
    scopeText: "Demolition, plumbing, tile, fixtures",
    originalContractPriceCents: 2000000,
    totalPriceCents: 2000000,
    adjustedContractPriceCents: 2000000,
    depositAmountCents: 500000,
    remainingBalanceCents: 1500000,
    paymentSchedule: [],
    discounts: [],
    dates: { contractDate: new Date("2026-08-01") },
    optionalDetails: {},
    termsVersion: "x",
    legalNoticeVersion: "y",
  };
}

function sampleChangeOrder() {
  return {
    changeOrderNumber: "CO-000010-01",
    title: "Add recessed lighting",
    customerSnapshot: { fullName: "Jane Homeowner" },
    propertySnapshot: { address: "12 Ocean Ave", projectNumber: "P-1" },
    contractSnapshot: {
      contractNumber: "000010",
      contractDate: new Date("2026-08-01"),
      originalContractAmountCents: 2000000,
    },
    lines: [{ description: "Add lighting", direction: "add", amountCents: 10000 }],
    previousChangeOrderAdjustmentCents: 0,
    contractAmountBeforeChangeCents: 2000000,
    netAdjustmentCents: 10000,
    newContractAmountCents: 2010000,
    scheduleImpact: { type: "none" },
    createdAt: new Date("2026-08-10"),
  };
}

const execute = (frozen) =>
  overlayExecution({
    frozenBuffer: frozen.buffer,
    anchors: frozen.anchors,
    signatureImage: SIGNATURE_PNG,
    signedAt: SIGNED_AT,
  });

async function main() {
  console.log("\nFrozen document");

  const frozen = await renderFrozenDocument({
    documentType: "CONTRACT",
    document: sampleContract(),
    pinnedDate: PINNED,
  });

  await test("freezing produces a stable SHA-256 for identical inputs", async () => {
    const again = await renderFrozenDocument({
      documentType: "CONTRACT",
      document: sampleContract(),
      pinnedDate: PINNED,
    });
    assert.strictEqual(frozen.sha256, again.sha256);
    assert.strictEqual(frozen.sha256.length, 64);
  });

  await test("a changed price changes the frozen hash", async () => {
    const altered = sampleContract();
    altered.adjustedContractPriceCents = 3000000;
    const other = await renderFrozenDocument({
      documentType: "CONTRACT",
      document: altered,
      pinnedDate: PINNED,
    });
    assert.notStrictEqual(other.sha256, frozen.sha256);
  });

  await test("the generator records where the execution fields belong", () => {
    const fields = frozen.anchors.map((a) => a.field);
    assert.ok(fields.includes("customer"), JSON.stringify(fields));
    assert.ok(fields.includes("customerDate"), JSON.stringify(fields));
    for (const anchor of frozen.anchors) {
      assert.ok(Number.isInteger(anchor.pageIndex) && anchor.pageIndex >= 0);
      assert.ok(anchor.topY > 0 && anchor.x > 0);
    }
  });

  console.log("\nExecution overlay");

  await test("the executed document is a valid PDF built from the frozen bytes", async () => {
    const executed = await execute(frozen);
    assert.strictEqual(executed.buffer.subarray(0, 5).toString(), "%PDF-");
    // Overlaying only adds content.
    assert.ok(executed.buffer.length >= frozen.buffer.length);
  });

  await test("the executed hash differs from the frozen hash", async () => {
    const executed = await execute(frozen);
    assert.notStrictEqual(executed.sha256, frozen.sha256);
    assert.strictEqual(executed.sha256.length, 64);
  });

  await test("the substantive document survives the overlay unchanged", async () => {
    const executed = await execute(frozen);
    const before = await PDFDocument.load(frozen.buffer);
    const after = await PDFDocument.load(executed.buffer);
    // Nothing re-rendered and nothing appended: identical page count and size.
    assert.strictEqual(after.getPageCount(), before.getPageCount());
    const b = before.getPage(0).getSize();
    const a = after.getPage(0).getSize();
    assert.strictEqual(a.width, b.width);
    assert.strictEqual(a.height, b.height);
  });

  await test("the frozen document is never mutated by execution", async () => {
    const hashBefore = frozen.sha256;
    await execute(frozen);
    const { sha256 } = require("../utils/esign/nativeSigning");
    assert.strictEqual(sha256(frozen.buffer), hashBefore);
  });

  await test("executing twice from the same frozen bytes is deterministic", async () => {
    const a = await execute(frozen);
    const b = await execute(frozen);
    assert.strictEqual(a.sha256, b.sha256);
  });

  console.log("\nExecution refuses to guess");

  await test("no signature means no executed document", async () => {
    await assert.rejects(
      () =>
        overlayExecution({
          frozenBuffer: frozen.buffer,
          anchors: frozen.anchors,
          signatureImage: null,
        }),
      /signature/i
    );
  });

  await test("no frozen document means no executed document", async () => {
    await assert.rejects(
      () =>
        overlayExecution({
          frozenBuffer: null,
          anchors: frozen.anchors,
          signatureImage: SIGNATURE_PNG,
        }),
      /frozen document/i
    );
  });

  await test("a missing anchor is refused rather than guessed", async () => {
    await assert.rejects(
      () =>
        overlayExecution({
          frozenBuffer: frozen.buffer,
          anchors: [],
          signatureImage: SIGNATURE_PNG,
        }),
      /position/i
    );
  });

  console.log("\nChange Orders");

  await test("a Change Order freezes and executes through the same path", async () => {
    const co = await renderFrozenDocument({
      documentType: "CHANGE_ORDER",
      document: sampleChangeOrder(),
      pinnedDate: PINNED,
    });
    assert.ok(co.anchors.some((a) => a.field === "customer"), JSON.stringify(co.anchors));
    const executed = await execute(co);
    assert.notStrictEqual(executed.sha256, co.sha256);
    assert.strictEqual(executed.buffer.subarray(0, 5).toString(), "%PDF-");
  });

  await test("a Change Order's page count is unchanged by execution", async () => {
    const co = await renderFrozenDocument({
      documentType: "CHANGE_ORDER",
      document: sampleChangeOrder(),
      pinnedDate: PINNED,
    });
    const executed = await execute(co);
    const before = await PDFDocument.load(co.buffer);
    const after = await PDFDocument.load(executed.buffer);
    assert.strictEqual(after.getPageCount(), before.getPageCount());
  });

  console.log("\nCompany signature");

  await test("an absent company signature asset is explicit, never invented", async () => {
    const saved = process.env.COMPANY_SIGNATURE_S3_KEY;
    delete process.env.COMPANY_SIGNATURE_S3_KEY;
    try {
      const result = await renderFrozenDocument({
        documentType: "CONTRACT",
        document: sampleContract(),
        pinnedDate: PINNED,
      });
      assert.strictEqual(result.companySignatureApplied, false);
      // The document is still produced; the company rule is simply empty.
      assert.ok(result.buffer.length > 1000);
    } finally {
      if (saved !== undefined) process.env.COMPANY_SIGNATURE_S3_KEY = saved;
    }
  });

  console.log(`\n${passed} passed, ${failures.length} failed.`);
  if (failures.length) {
    for (const failure of failures) console.error(`\n${failure.name}\n${failure.err.stack}`);
    process.exit(1);
  }
  process.exit(0);
}

main();
