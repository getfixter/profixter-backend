/**
 * Service area ZIP allowlist — unit tests and audit. No database, no network.
 *   node scripts/test_service_area.js
 */

const assert = require("assert");
const {
  NASSAU_ZIPS,
  SUFFOLK_ZIPS,
  SERVICE_AREA_ZIPS,
  KNOWN_EXCLUSIONS,
  normalizeZip,
  isZipInServiceArea,
  isAddressInServiceArea,
  countyForZip,
  outOfServiceAreaMessage,
} = require("../utils/serviceArea");

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

/* ---------------- integrity of the list itself ---------------- */

console.log("\nAllowlist integrity");

test("no duplicate ZIPs within Nassau", () => {
  assert.strictEqual(new Set(NASSAU_ZIPS).size, NASSAU_ZIPS.length);
});
test("no duplicate ZIPs within Suffolk", () => {
  assert.strictEqual(new Set(SUFFOLK_ZIPS).size, SUFFOLK_ZIPS.length);
});
test("no ZIP appears in both counties", () => {
  const overlap = NASSAU_ZIPS.filter((z) => SUFFOLK_ZIPS.includes(z));
  assert.deepStrictEqual(overlap, [], `overlap: ${overlap.join(",")}`);
});
test("every entry is a valid 5-digit ZIP", () => {
  const bad = [...NASSAU_ZIPS, ...SUFFOLK_ZIPS].filter((z) => !/^\d{5}$/.test(z));
  assert.deepStrictEqual(bad, [], `malformed: ${bad.join(",")}`);
});
test("no allowlisted ZIP is also in the exclusion set", () => {
  const clash = [...SERVICE_AREA_ZIPS].filter((z) => KNOWN_EXCLUSIONS.has(z));
  assert.deepStrictEqual(clash, [], `clash: ${clash.join(",")}`);
});

/* ---------------- Queens must never leak in ---------------- */

console.log("\nQueens ZIPs must all be rejected");

// Full Queens ZIP set, including the ones adjacent to the Nassau border and
// the Rockaways, which a numeric range would have wrongly captured.
const QUEENS_ZIPS = [
  "11004", "11005", // Glen Oaks / Floral Park (Queens side)
  "11101", "11102", "11103", "11104", "11105", "11106",
  "11109", "11120",
  "11351", "11354", "11355", "11356", "11357", "11358", "11359", "11360",
  "11361", "11362", "11363", "11364", "11365", "11366", "11367", "11368",
  "11369", "11370", "11372", "11373", "11374", "11375", "11377", "11378",
  "11379", "11385",
  "11411", "11412", "11413", "11414", "11415", "11416", "11417", "11418",
  "11419", "11420", "11421", "11422", "11423", "11426", "11427", "11428",
  "11429", "11430", "11432", "11433", "11434", "11435", "11436",
  "11691", "11692", "11693", "11694", "11695", "11697", // Rockaways
];

test(`all ${QUEENS_ZIPS.length} Queens ZIPs rejected`, () => {
  const leaked = QUEENS_ZIPS.filter((z) => isZipInServiceArea(z));
  assert.deepStrictEqual(leaked, [], `QUEENS LEAKED IN: ${leaked.join(",")}`);
});

console.log("\nOther NYC / neighbouring areas rejected");
const OUTSIDE = [
  ["11201", "Brooklyn"], ["11215", "Brooklyn"], ["11249", "Brooklyn"],
  ["10001", "Manhattan"],
  ["10451", "Bronx"], ["10301", "Staten Island"],
  ["10701", "Yonkers"], ["10801", "New Rochelle"],
  ["06905", "Stamford CT"], ["06390", "Fishers Island (excluded)"],
  ["07030", "Hoboken NJ"], ["90210", "Beverly Hills CA"],
  ["12180", "Troy NY"], ["11599", "non-existent"],
  ["11888", "non-existent"], ["11700", "non-existent"],
];
OUTSIDE.forEach(([zip, where]) => {
  test(`${zip} (${where}) rejected`, () => assert.strictEqual(isZipInServiceArea(zip), false));
});

/* ---------------- representative in-area coverage ---------------- */

console.log("\nNassau coverage");
[
  ["11758", "Massapequa"], ["11550", "Hempstead"], ["11530", "Garden City"],
  ["11590", "Westbury"], ["11001", "Floral Park"], ["11801", "Hicksville"],
  ["11040", "New Hyde Park"], ["11561", "Long Beach"], ["11020", "Great Neck"],
  ["11096", "Inwood"], ["11735", "Farmingdale"], ["11804", "Old Bethpage"],
].forEach(([zip, town]) => {
  test(`${zip} ${town} serviceable + county Nassau`, () => {
    assert.strictEqual(isZipInServiceArea(zip), true);
    assert.strictEqual(countyForZip(zip), "Nassau");
  });
});

console.log("\nSuffolk coverage");
[
  ["11702", "Babylon"], ["11706", "Bay Shore"], ["11757", "Lindenhurst"],
  ["11701", "Amityville"], ["11772", "Patchogue"], ["11743", "Huntington"],
  ["11787", "Smithtown"], ["11901", "Riverhead"], ["11968", "Southampton"],
  ["11954", "Montauk"], ["11937", "East Hampton"], ["11980", "Yaphank"],
  ["11798", "Wyandanch"], ["11790", "Stony Brook"],
].forEach(([zip, town]) => {
  test(`${zip} ${town} serviceable + county Suffolk`, () => {
    assert.strictEqual(isZipInServiceArea(zip), true);
    assert.strictEqual(countyForZip(zip), "Suffolk");
  });
});

/* ---------------- documented exclusions ---------------- */

console.log("\nDocumented exclusions stay excluded");
[
  ["11964", "Shelter Island - ferry only"],
  ["11965", "Shelter Island Heights - ferry only"],
  ["11770", "Ocean Beach, Fire Island - no vehicle access"],
  ["11794", "Stony Brook University - institutional"],
  ["11973", "Upton / BNL - institutional"],
  ["11902", "Riverhead PO boxes"],
  ["11025", "Great Neck PO boxes"],
].forEach(([zip, why]) => {
  test(`${zip} excluded (${why})`, () => assert.strictEqual(isZipInServiceArea(zip), false));
});

/* ---------------- normalization + fail-closed ---------------- */

console.log("\nNormalization and fail-closed behavior");
test("ZIP+4 truncates to base", () => assert.strictEqual(normalizeZip("11702-1234"), "11702"));
test("ZIP+4 still matches allowlist", () => assert.strictEqual(isZipInServiceArea("11702-1234"), true));
test("whitespace trimmed", () => assert.strictEqual(isZipInServiceArea("  11702 "), true));
test("short ZIP rejected", () => assert.strictEqual(isZipInServiceArea("117"), false));
test("non-numeric rejected", () => assert.strictEqual(isZipInServiceArea("ABCDE"), false));
test("empty rejected", () => assert.strictEqual(isZipInServiceArea(""), false));
test("null rejected", () => assert.strictEqual(isZipInServiceArea(null), false));
test("undefined rejected", () => assert.strictEqual(isZipInServiceArea(undefined), false));

console.log("\nAddress-level checks");
test("Babylon address serviceable", () =>
  assert.strictEqual(isAddressInServiceArea({ line1: "123 Main St", zip: "11702" }), true));
test("Brooklyn address rejected", () =>
  assert.strictEqual(isAddressInServiceArea({ line1: "1 Front St", zip: "11201" }), false));
test("county string is ignored — only ZIP is trusted", () =>
  assert.strictEqual(
    isAddressInServiceArea({ line1: "1 Front St", zip: "11201", county: "Suffolk" }),
    false,
    "a Brooklyn ZIP claiming Suffolk must still be rejected"
  ));
test("missing ZIP rejected even with county set", () =>
  assert.strictEqual(isAddressInServiceArea({ line1: "1 Main St", county: "Nassau" }), false));
test("null address rejected", () => assert.strictEqual(isAddressInServiceArea(null), false));

console.log("\nCustomer message");
test("names both counties, reads friendly", () => {
  const msg = outOfServiceAreaMessage();
  assert.ok(/Nassau/.test(msg) && /Suffolk/.test(msg), msg);
  assert.ok(!/error|invalid|denied|forbidden/i.test(msg));
});

console.log(
  `\nAllowlist size: ${SERVICE_AREA_ZIPS.size} ZIPs ` +
  `(${NASSAU_ZIPS.length} Nassau, ${SUFFOLK_ZIPS.length} Suffolk), ` +
  `${KNOWN_EXCLUSIONS.size} documented exclusions`
);
console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error(`FAILED: ${f.name}\n${f.err.stack}\n`);
  process.exit(1);
}
process.exit(0);
