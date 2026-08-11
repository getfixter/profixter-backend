/**
 * Change Order document + route input validation — unit tests.
 * No database, no network, no AWS calls.
 *   node scripts/test_change_order_document.js
 */

// s3.js refuses to load without a bucket name; the tests never call it.
process.env.S3_BUCKET = process.env.S3_BUCKET || "test-bucket";

const assert = require("assert");
const {
  buildChangeOrderFilename,
  generateChangeOrderPdfBuffer,
  scheduleImpactText,
} = require("../utils/changeOrderPdf");
const {
  normalizeLines,
  normalizeScheduleImpact,
  AMENDABLE_CONTRACT_STATUSES,
} = require("../routes/adminChangeOrders");
const ChangeOrder = require("../models/ChangeOrder");
const {
  CHANGE_ORDER_STATUSES,
  CHANGE_ORDER_TERMS_VERSION,
} = require("../config/changeOrderTerms");

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      return result.then(
        () => {
          passed += 1;
          console.log(`  PASS  ${name}`);
        },
        (err) => {
          failures.push({ name, err });
          console.log(`  FAIL  ${name}\n        ${err.message}`);
        }
      );
    }
    passed += 1;
    console.log(`  PASS  ${name}`);
    return Promise.resolve();
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
    return Promise.resolve();
  }
}

const $ = (dollars) => Math.round(dollars * 100);

function sampleChangeOrder(overrides = {}) {
  return {
    changeOrderNumber: "CO-000123-01",
    title: "Add recessed lighting and revise trim package",
    customerSnapshot: { fullName: "Jane Homeowner", email: "jane@example.com" },
    propertySnapshot: {
      address: "12 Ocean Avenue, Apartment 4B, Lindenhurst, New York 11757",
      projectNumber: "P-1042",
    },
    contractSnapshot: {
      contractNumber: "000123",
      contractDate: new Date("2026-05-04T12:00:00Z"),
      originalContractAmountCents: $(20000),
    },
    lines: [
      { description: "Add six recessed LED fixtures", direction: "add", amountCents: $(3000) },
      { description: "Remove decorative trim package", direction: "deduct", amountCents: $(500) },
      { description: "Substitute equivalent faucet", direction: "none", amountCents: 0 },
    ],
    previousChangeOrderAdjustmentCents: 0,
    contractAmountBeforeChangeCents: $(20000),
    netAdjustmentCents: $(2500),
    newContractAmountCents: $(22500),
    scheduleImpact: { type: "add_days", days: 4, note: "" },
    notes: "Fixtures selected by customer prior to rough-in.",
    createdAt: new Date("2026-08-09T12:00:00Z"),
    ...overrides,
  };
}

async function main() {
  /* ---------------- numbering ---------------- */

  console.log("\nNumbering");

  await test("change order number is contract-scoped and zero padded", () => {
    assert.strictEqual(ChangeOrder.formatNumber("000123", 1), "CO-000123-01");
    assert.strictEqual(ChangeOrder.formatNumber("000123", 12), "CO-000123-12");
  });

  await test("three-digit sequences are not truncated", () =>
    assert.strictEqual(ChangeOrder.formatNumber("000123", 105), "CO-000123-105"));

  await test("filename is derived from the change order number", () =>
    assert.strictEqual(
      buildChangeOrderFilename({ changeOrderNumber: "CO-000123-01" }),
      "CO-000123-01.pdf"
    ));

  await test("filename strips characters that are unsafe in a path", () =>
    assert.strictEqual(
      buildChangeOrderFilename({ changeOrderNumber: "CO/000123 01" }),
      "CO-000123-01.pdf"
    ));

  /* ---------------- config ---------------- */

  console.log("\nDocument configuration");

  await test("every status the signature layer can produce exists in the enum", () => {
    for (const status of [
      "Draft",
      "Ready to Send",
      "Sent",
      "Viewed",
      "Awaiting Signature",
      "Partially Signed",
      "Executed",
      "Declined",
      "Voided",
    ]) {
      assert.ok(CHANGE_ORDER_STATUSES.includes(status), `missing status: ${status}`);
    }
  });

  await test("terms version is pinned", () =>
    assert.strictEqual(CHANGE_ORDER_TERMS_VERSION, "PIH-CO-2026-001"));

  await test("a change order can only amend an issued contract", () => {
    assert.ok(!AMENDABLE_CONTRACT_STATUSES.includes("Draft"));
    assert.ok(!AMENDABLE_CONTRACT_STATUSES.includes("Canceled"));
    assert.ok(AMENDABLE_CONTRACT_STATUSES.includes("Signed"));
  });

  /* ---------------- line validation ---------------- */

  console.log("\nLine validation");

  await test("a valid line set produces no errors", () => {
    const errors = [];
    const lines = normalizeLines(
      [{ description: "Add lighting", direction: "add", amountCents: $(3000) }],
      errors
    );
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0].amountCents, $(3000));
  });

  await test("an empty line set is rejected", () => {
    const errors = [];
    normalizeLines([], errors);
    assert.ok(errors.length > 0);
  });

  await test("a missing description is rejected", () => {
    const errors = [];
    normalizeLines([{ description: "   ", direction: "add", amountCents: 100 }], errors);
    assert.ok(errors.some((message) => /description is required/i.test(message)));
  });

  await test("a negative amount is rejected rather than silently flipped", () => {
    const errors = [];
    normalizeLines([{ description: "Add work", direction: "add", amountCents: -500 }], errors);
    assert.ok(errors.some((message) => /zero or greater/i.test(message)));
  });

  await test("a fractional cent amount is rejected", () => {
    const errors = [];
    normalizeLines([{ description: "Add work", direction: "add", amountCents: 100.5 }], errors);
    assert.ok(errors.some((message) => /whole cents/i.test(message)));
  });

  await test("an unrecognized direction is rejected", () => {
    const errors = [];
    normalizeLines([{ description: "Add work", direction: "credit", amountCents: 100 }], errors);
    assert.ok(errors.some((message) => /add, deduct, or none/i.test(message)));
  });

  await test("a no-cost line is forced to zero even if an amount was supplied", () => {
    const errors = [];
    const lines = normalizeLines(
      [{ description: "Substitute fixture", direction: "none", amountCents: $(900) }],
      errors
    );
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(lines[0].amountCents, 0);
  });

  await test("an absurd amount is rejected", () => {
    const errors = [];
    normalizeLines(
      [{ description: "Add work", direction: "add", amountCents: 999_999_999_999 }],
      errors
    );
    assert.ok(errors.some((message) => /unreasonably large/i.test(message)));
  });

  await test("more than fifty lines is rejected", () => {
    const errors = [];
    normalizeLines(
      Array.from({ length: 51 }, () => ({ description: "x", direction: "add", amountCents: 1 })),
      errors
    );
    assert.ok(errors.some((message) => /more than 50 lines/i.test(message)));
  });

  /* ---------------- schedule validation ---------------- */

  console.log("\nSchedule impact validation");

  await test("no schedule impact is the default", () => {
    const errors = [];
    const impact = normalizeScheduleImpact(undefined, errors);
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(impact.type, "none");
    assert.strictEqual(impact.days, 0);
  });

  await test("added days must be a whole number of at least one", () => {
    const errors = [];
    normalizeScheduleImpact({ type: "add_days", days: 0 }, errors);
    assert.ok(errors.length > 0);
  });

  await test("days are cleared when the type does not use them", () => {
    const errors = [];
    const impact = normalizeScheduleImpact({ type: "none", days: 12 }, errors);
    assert.strictEqual(impact.days, 0);
  });

  await test("a custom impact requires a description", () => {
    const errors = [];
    normalizeScheduleImpact({ type: "custom", note: "" }, errors);
    assert.ok(errors.some((message) => /custom schedule impact/i.test(message)));
  });

  await test("an unknown impact type is rejected", () => {
    const errors = [];
    normalizeScheduleImpact({ type: "delay_forever" }, errors);
    assert.ok(errors.length > 0);
  });

  /* ---------------- schedule wording ---------------- */

  console.log("\nSchedule impact wording");

  await test("no impact says so plainly", () =>
    assert.match(scheduleImpactText({ scheduleImpact: { type: "none" } }), /No change/i));

  await test("added days are singular when there is one", () =>
    assert.match(
      scheduleImpactText({ scheduleImpact: { type: "add_days", days: 1 } }),
      /1 calendar day\./
    ));

  await test("added days are plural when there is more than one", () =>
    assert.match(
      scheduleImpactText({ scheduleImpact: { type: "add_days", days: 4 } }),
      /4 calendar days\./
    ));

  await test("reduced days read as a reduction, not an extension", () => {
    const text = scheduleImpactText({ scheduleImpact: { type: "reduce_days", days: 3 } });
    assert.match(text, /reduced/i);
    assert.ok(!/extended/i.test(text));
  });

  await test("a custom impact prints the admin's own words", () =>
    assert.strictEqual(
      scheduleImpactText({ scheduleImpact: { type: "custom", note: "Re-baseline after inspection." } }),
      "Re-baseline after inspection."
    ));

  /* ---------------- PDF ---------------- */

  console.log("\nPDF generation");

  await test("a change order renders to a real PDF", async () => {
    const buffer = await generateChangeOrderPdfBuffer(sampleChangeOrder());
    assert.ok(Buffer.isBuffer(buffer));
    assert.ok(buffer.length > 2000, `PDF suspiciously small: ${buffer.length} bytes`);
    assert.strictEqual(buffer.subarray(0, 5).toString(), "%PDF-");
  });

  await test("a change order with no lines still renders", async () => {
    const buffer = await generateChangeOrderPdfBuffer(
      sampleChangeOrder({ lines: [], netAdjustmentCents: 0, newContractAmountCents: $(20000) })
    );
    assert.ok(buffer.length > 1500);
  });

  await test("a long change order paginates instead of overflowing one page", async () => {
    const paragraph =
      "Add six recessed LED fixtures in the living room ceiling, including new switching, " +
      "dimmer, and patching and painting of all disturbed drywall to match existing finish. ";
    const buffer = await generateChangeOrderPdfBuffer(
      sampleChangeOrder({
        lines: Array.from({ length: 10 }, (_line, index) => ({
          description: paragraph.repeat(2),
          direction: index % 2 ? "add" : "deduct",
          amountCents: $(100 * (index + 1)),
        })),
        notes: paragraph.repeat(6),
      })
    );
    const pageCounts = [...buffer.toString("latin1").matchAll(/\/Count (\d+)/g)].map((match) =>
      Number(match[1])
    );
    assert.ok(pageCounts.length > 0, "no page tree found in the PDF");
    assert.ok(Math.max(...pageCounts) > 1, "long document did not paginate");
  });

  await test("negative-value change orders render without throwing", async () => {
    const buffer = await generateChangeOrderPdfBuffer(
      sampleChangeOrder({
        lines: [{ description: "Remove scope", direction: "deduct", amountCents: $(5000) }],
        netAdjustmentCents: -$(5000),
        newContractAmountCents: $(15000),
        previousChangeOrderAdjustmentCents: -$(1200),
      })
    );
    assert.strictEqual(buffer.subarray(0, 5).toString(), "%PDF-");
  });

  /* ---------------- immutability ---------------- */

  console.log("\nImmutability");

  await test("editable statuses are only Draft", () =>
    assert.deepStrictEqual([...ChangeOrder.EDITABLE_STATUSES], ["Draft"]));

  await test("executed, declined and voided are locked", () => {
    for (const status of ["Executed", "Declined", "Voided"]) {
      assert.ok(ChangeOrder.LOCKED_STATUSES.includes(status), `${status} should be locked`);
    }
  });

  await test("a locked change order never recomputes its stored totals", async () => {
    const doc = new ChangeOrder({
      changeOrderNumber: "CO-000999-01",
      sequence: 1,
      projectId: "0".repeat(24),
      contractId: "1".repeat(24),
      status: "Executed",
      title: "Signed change order",
      lines: [{ description: "Add work", direction: "add", amountCents: $(2000) }],
      contractAmountBeforeChangeCents: $(20000),
      netAdjustmentCents: $(2000),
      newContractAmountCents: $(22000),
      createdBy: "2".repeat(24),
    });

    // Someone tampers with the lines after execution.
    doc.lines.push({ description: "Sneaky extra", direction: "add", amountCents: $(4000) });
    await doc.validate();

    assert.strictEqual(doc.netAdjustmentCents, $(2000));
    assert.strictEqual(doc.newContractAmountCents, $(22000));
  });

  await test("a draft change order does recompute its totals from its lines", async () => {
    const doc = new ChangeOrder({
      changeOrderNumber: "CO-000999-02",
      sequence: 2,
      projectId: "0".repeat(24),
      contractId: "1".repeat(24),
      status: "Draft",
      title: "Draft change order",
      lines: [{ description: "Add work", direction: "add", amountCents: $(2000) }],
      contractAmountBeforeChangeCents: $(20000),
      createdBy: "2".repeat(24),
    });
    doc.lines.push({ description: "Deduct work", direction: "deduct", amountCents: $(500) });
    await doc.validate();

    assert.strictEqual(doc.netAdjustmentCents, $(1500));
    assert.strictEqual(doc.newContractAmountCents, $(21500));
  });

  await test("a change order can never drive the contract below zero", async () => {
    const doc = new ChangeOrder({
      changeOrderNumber: "CO-000999-03",
      sequence: 3,
      projectId: "0".repeat(24),
      contractId: "1".repeat(24),
      status: "Draft",
      title: "Oversized deduction",
      lines: [{ description: "Remove everything", direction: "deduct", amountCents: $(50000) }],
      contractAmountBeforeChangeCents: $(20000),
      createdBy: "2".repeat(24),
    });
    await doc.validate();
    assert.strictEqual(doc.netAdjustmentCents, -$(50000));
    assert.strictEqual(doc.newContractAmountCents, 0);
  });

  /* ---------------- summary ---------------- */

  console.log(`\n${passed} passed, ${failures.length} failed.`);
  if (failures.length) {
    for (const failure of failures) console.error(`\n${failure.name}\n${failure.err.stack}`);
    process.exit(1);
  }
  process.exit(0);
}

main();
