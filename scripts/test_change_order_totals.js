/**
 * Change Order financial engine — unit tests. No database, no network.
 *   node scripts/test_change_order_totals.js
 */

const assert = require("assert");
const {
  lineAmountCents,
  netAdjustmentCents,
  summarizeContractValue,
  computeChangeOrderFigures,
  formatSignedCents,
} = require("../utils/changeOrderTotals");

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

/* ---------------- line direction ---------------- */

console.log("\nLine direction (admin never types a negative)");

test("add line is positive", () =>
  assert.strictEqual(lineAmountCents({ direction: "add", amountCents: $(2500) }), $(2500)));

test("deduct line is negative", () =>
  assert.strictEqual(lineAmountCents({ direction: "deduct", amountCents: $(450) }), -$(450)));

test("deduct of a positive input still deducts", () =>
  assert.strictEqual(lineAmountCents({ direction: "deduct", amountCents: $(450) }), -$(450)));

test("deduct of an accidentally negative input cannot flip to a credit", () =>
  assert.strictEqual(lineAmountCents({ direction: "deduct", amountCents: -$(450) }), -$(450)));

test("add of an accidentally negative input cannot become a deduction", () =>
  assert.strictEqual(lineAmountCents({ direction: "add", amountCents: -$(450) }), $(450)));

test("zero-cost change is zero regardless of direction", () => {
  assert.strictEqual(lineAmountCents({ direction: "add", amountCents: 0 }), 0);
  assert.strictEqual(lineAmountCents({ direction: "deduct", amountCents: 0 }), 0);
});

test("missing/garbage amount is zero, not NaN", () => {
  assert.strictEqual(lineAmountCents({ direction: "add" }), 0);
  assert.strictEqual(lineAmountCents({ direction: "add", amountCents: "abc" }), 0);
  assert.strictEqual(lineAmountCents(null), 0);
});

test("multiple lines net correctly", () =>
  assert.strictEqual(
    netAdjustmentCents([
      { direction: "add", amountCents: $(2500) },
      { direction: "deduct", amountCents: $(450) },
      { direction: "add", amountCents: 0 },
    ]),
    $(2050)
  ));

/* ---------------- the brief's worked example ---------------- */

console.log("\nSequential change orders (worked example from the brief)");

test("20,000 → +3,000 → -500 → +1,200 = 23,700", () => {
  const baseline = $(20000);
  const cos = [
    { status: "Executed", netAdjustmentCents: $(3000) },
    { status: "Executed", netAdjustmentCents: -$(500) },
    { status: "Executed", netAdjustmentCents: $(1200) },
  ];
  const s = summarizeContractValue(baseline, cos);
  assert.strictEqual(s.executedContractCents, $(23700));
});

test("current value after CO1 and CO2 only is 22,500", () => {
  const s = summarizeContractValue($(20000), [
    { status: "Executed", netAdjustmentCents: $(3000) },
    { status: "Executed", netAdjustmentCents: -$(500) },
  ]);
  assert.strictEqual(s.executedContractCents, $(22500));
});

/* ---------------- executed vs pending integrity ---------------- */

console.log("\nDraft/pending orders must never inflate the executed value");

test("CRITICAL: signed +2,000 with draft +4,000 stays at 22,000", () => {
  const s = summarizeContractValue($(20000), [
    { status: "Executed", netAdjustmentCents: $(2000) },
    { status: "Draft", netAdjustmentCents: $(4000) },
  ]);
  assert.strictEqual(s.executedContractCents, $(22000), "draft must not count");
  assert.strictEqual(s.projectedContractCents, $(22000), "draft is not even a live proposal");
});

test("awaiting-signature order shows as projected but not executed", () => {
  const s = summarizeContractValue($(20000), [
    { status: "Executed", netAdjustmentCents: $(2000) },
    { status: "Awaiting Signature", netAdjustmentCents: $(4000) },
  ]);
  assert.strictEqual(s.executedContractCents, $(22000));
  assert.strictEqual(s.projectedContractCents, $(26000));
  assert.strictEqual(s.pendingAdjustmentCents, $(4000));
});

test("declined and voided orders contribute nothing", () => {
  const s = summarizeContractValue($(20000), [
    { status: "Executed", netAdjustmentCents: $(1000) },
    { status: "Declined", netAdjustmentCents: $(9000) },
    { status: "Voided", netAdjustmentCents: -$(9000) },
  ]);
  assert.strictEqual(s.executedContractCents, $(21000));
  assert.strictEqual(s.projectedContractCents, $(21000));
});

test("counts distinguish executed from pending", () => {
  const s = summarizeContractValue($(10000), [
    { status: "Executed", netAdjustmentCents: $(100) },
    { status: "Executed", netAdjustmentCents: $(100) },
    { status: "Sent", netAdjustmentCents: $(100) },
    { status: "Draft", netAdjustmentCents: $(100) },
  ]);
  assert.strictEqual(s.executedCount, 2);
  assert.strictEqual(s.pendingCount, 1);
});

test("summary works from lines when netAdjustmentCents is absent", () => {
  const s = summarizeContractValue($(1000), [
    { status: "Executed", lines: [{ direction: "add", amountCents: $(250) }] },
  ]);
  assert.strictEqual(s.executedContractCents, $(1250));
});

/* ---------------- per-document figures ---------------- */

console.log("\nPer-change-order figures");

test("figures for the first change order", () => {
  const f = computeChangeOrderFigures({
    baselineCents: $(18500),
    priorExecuted: [],
    lines: [{ direction: "add", amountCents: $(2500) }],
  });
  assert.strictEqual(f.originalContractCents, $(18500));
  assert.strictEqual(f.previousChangeOrderAdjustmentCents, 0);
  assert.strictEqual(f.contractAmountBeforeChangeCents, $(18500));
  assert.strictEqual(f.netAdjustmentCents, $(2500));
  assert.strictEqual(f.newContractAmountCents, $(21000));
});

test("figures for a later change order include prior executed ones", () => {
  const f = computeChangeOrderFigures({
    baselineCents: $(18500),
    priorExecuted: [{ status: "Executed", netAdjustmentCents: $(2000) }],
    lines: [{ direction: "add", amountCents: $(1250) }],
  });
  assert.strictEqual(f.previousChangeOrderAdjustmentCents, $(2000));
  assert.strictEqual(f.contractAmountBeforeChangeCents, $(20500));
  assert.strictEqual(f.newContractAmountCents, $(21750));
});

test("a deduction lowers the new total", () => {
  const f = computeChangeOrderFigures({
    baselineCents: $(20000),
    priorExecuted: [{ status: "Executed", netAdjustmentCents: $(3000) }],
    lines: [{ direction: "deduct", amountCents: $(500) }],
  });
  assert.strictEqual(f.contractAmountBeforeChangeCents, $(23000));
  assert.strictEqual(f.newContractAmountCents, $(22500));
});

test("a no-cost change leaves the total untouched", () => {
  const f = computeChangeOrderFigures({
    baselineCents: $(20000),
    priorExecuted: [],
    lines: [{ direction: "add", amountCents: 0 }],
  });
  assert.strictEqual(f.netAdjustmentCents, 0);
  assert.strictEqual(f.newContractAmountCents, $(20000));
});

test("draft prior orders are excluded from the baseline", () => {
  const f = computeChangeOrderFigures({
    baselineCents: $(20000),
    priorExecuted: [
      { status: "Executed", netAdjustmentCents: $(1000) },
      { status: "Draft", netAdjustmentCents: $(5000) },
    ],
    lines: [{ direction: "add", amountCents: $(100) }],
  });
  assert.strictEqual(f.contractAmountBeforeChangeCents, $(21000));
  assert.strictEqual(f.newContractAmountCents, $(21100));
});

/* ---------------- guards ---------------- */

console.log("\nGuards");

test("deductions cannot drive the contract below zero", () => {
  const s = summarizeContractValue($(1000), [
    { status: "Executed", netAdjustmentCents: -$(5000) },
  ]);
  assert.strictEqual(s.executedContractCents, 0);
});

test("no change orders returns the baseline unchanged", () => {
  const s = summarizeContractValue($(18500), []);
  assert.strictEqual(s.executedContractCents, $(18500));
  assert.strictEqual(s.projectedContractCents, $(18500));
});

test("legacy contract with no change orders array is safe", () => {
  const s = summarizeContractValue($(18500), undefined);
  assert.strictEqual(s.executedContractCents, $(18500));
});

test("negative baseline is clamped to zero", () =>
  assert.strictEqual(summarizeContractValue(-500, []).executedContractCents, 0));

test("cents stay integers (no float drift)", () => {
  const s = summarizeContractValue($(1999.99), [
    { status: "Executed", netAdjustmentCents: $(0.01) },
  ]);
  assert.ok(Number.isInteger(s.executedContractCents), "must be an integer");
  assert.strictEqual(s.executedContractCents, 200000);
});

/* ---------------- display ---------------- */

console.log("\nFormatting");

test("positive shows a plus", () => assert.strictEqual(formatSignedCents($(1250)), "+$1,250.00"));
test("negative shows a minus once", () => assert.strictEqual(formatSignedCents(-$(450)), "-$450.00"));
test("zero shows no sign", () => assert.strictEqual(formatSignedCents(0), "$0.00"));
test("thousands separated", () => assert.strictEqual(formatSignedCents($(23700)), "+$23,700.00"));

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error(`FAILED: ${f.name}\n${f.err.stack}\n`);
  process.exit(1);
}
process.exit(0);
