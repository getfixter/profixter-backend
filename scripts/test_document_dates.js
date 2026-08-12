/**
 * Document date semantics.
 *
 * The rule these tests defend: a date printed on a document somebody holds is
 * a stored fact, not the render clock. Regenerating a PDF must reproduce the
 * dates it was issued with - if it does not, the paperwork quietly disagrees
 * with itself and with the database.
 *
 *   node scripts/test_document_dates.js
 */

const assert = require("assert");
const {
  autoIssueDate,
  contractIsIssued,
  invoiceIsIssued,
  readCompanySignedAt,
  resolveCompanySignedAt,
  sameCalendarDay,
  writeCompanySignedAt,
} = require("../utils/documentDates");

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

const MONDAY = new Date("2026-08-03T15:00:00.000Z");
const FRIDAY = new Date("2026-08-07T15:00:00.000Z");

/* ---------------- company execution date ---------------- */

console.log("\nCompany execution date");

test("is stamped the first time the signature is actually applied", () => {
  const contract = { dates: {} };
  const stamped = resolveCompanySignedAt(contract, true, MONDAY);
  assert.strictEqual(stamped, MONDAY);
  assert.strictEqual(contract.dates.companySignedAt, MONDAY);
});

test("is reused verbatim on every later render", () => {
  const contract = { dates: { companySignedAt: MONDAY } };
  // Regenerating the PDF four days later must not re-date the Agreement.
  assert.strictEqual(resolveCompanySignedAt(contract, true, FRIDAY), MONDAY);
  assert.strictEqual(contract.dates.companySignedAt, MONDAY);
});

test("is not invented when no signature was applied", () => {
  const contract = { dates: {} };
  assert.strictEqual(resolveCompanySignedAt(contract, false, MONDAY), null);
  assert.strictEqual(contract.dates.companySignedAt, undefined);
});

test("lives at the top level on a change order and under dates on an agreement", () => {
  const changeOrder = { changeOrderNumber: "CO-000010-01" };
  resolveCompanySignedAt(changeOrder, true, MONDAY);
  assert.strictEqual(changeOrder.companySignedAt, MONDAY);
  assert.strictEqual(readCompanySignedAt(changeOrder), MONDAY);

  const contract = { dates: {} };
  resolveCompanySignedAt(contract, true, MONDAY);
  assert.strictEqual(readCompanySignedAt(contract), MONDAY);
});

test("marks a mongoose nested path modified so the stamp is actually saved", () => {
  const modified = [];
  const contract = { dates: {}, markModified: (path) => modified.push(path) };
  writeCompanySignedAt(contract, MONDAY);
  assert.deepStrictEqual(modified, ["dates"]);
});

/* ---------------- issue dates ---------------- */

console.log("\nIssue dates");

test("an unissued draft written on Monday is dated the day it is issued", () => {
  const rolled = autoIssueDate({
    isIssued: false,
    isManual: false,
    currentDate: MONDAY,
    now: FRIDAY,
  });
  assert.strictEqual(rolled, FRIDAY);
});

test("a draft issued the same day is left alone", () => {
  assert.strictEqual(
    autoIssueDate({ isIssued: false, isManual: false, currentDate: MONDAY, now: MONDAY }),
    null
  );
});

test("an already-issued document is never re-dated", () => {
  assert.strictEqual(
    autoIssueDate({ isIssued: true, isManual: false, currentDate: MONDAY, now: FRIDAY }),
    null,
    "regenerating a historical document must not move its date"
  );
});

test("a deliberate backdate outranks the convenience default", () => {
  assert.strictEqual(
    autoIssueDate({ isIssued: false, isManual: true, currentDate: MONDAY, now: FRIDAY }),
    null
  );
});

test("a missing date is filled in rather than left empty", () => {
  assert.strictEqual(
    autoIssueDate({ isIssued: false, isManual: false, currentDate: null, now: FRIDAY }),
    FRIDAY
  );
});

/* ---------------- issued predicates ---------------- */

console.log("\nWhat counts as issued");

test("an agreement is issued once a PDF exists or it leaves Draft", () => {
  assert.strictEqual(contractIsIssued({ status: "Draft" }), false);
  assert.strictEqual(contractIsIssued({ status: "Draft", generatedPdf: { key: "k" } }), true);
  assert.strictEqual(contractIsIssued({ status: "Generated" }), true);
  assert.strictEqual(contractIsIssued({ status: "Signed" }), true);
  assert.strictEqual(contractIsIssued(null), false);
});

test("an invoice is issued once it is sent or leaves Draft", () => {
  assert.strictEqual(invoiceIsIssued({ status: "Draft" }), false);
  assert.strictEqual(invoiceIsIssued({ status: "Draft", sentAt: FRIDAY }), true);
  assert.strictEqual(invoiceIsIssued({ status: "Sent" }), true);
  assert.strictEqual(invoiceIsIssued({ status: "Voided" }), true);
});

/* ---------------- timezone ---------------- */

console.log("\nCalendar day");

test("late evening in New York is still the same business day", () => {
  // 2026-08-03T23:30 in New York is 2026-08-04T03:30 UTC. Comparing in UTC
  // would call these different days and re-date a document at night.
  const evening = new Date("2026-08-04T03:30:00.000Z");
  const afternoon = new Date("2026-08-03T18:00:00.000Z");
  assert.strictEqual(sameCalendarDay(evening, afternoon), true);
});

test("genuinely different days are different", () => {
  assert.strictEqual(sameCalendarDay(MONDAY, FRIDAY), false);
});

console.log(`\n${passed} passed, ${failures.length} failed.`);
if (failures.length) process.exit(1);
