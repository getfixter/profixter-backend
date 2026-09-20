/*
 * The signup address, after it stopped being five fields.
 *
 * The address step now asks one question and the browser sends structured parts
 * it got from an address lookup. Everything here is about the half of that the
 * server is responsible for: deriving what it must not be told, checking what it
 * is told, and refusing what is not an address.
 *
 * What is deliberately NOT asserted: that an out-of-area address is refused.
 * It is not, and that is the documented behaviour — utils/serviceArea.js gates
 * the First Visit Free offer, not account creation. There is a test below that
 * pins that open door shut against a future accidental "fix".
 */
const assert = require("assert");

const { buildSignupAddress, coordsAgreeWithZip } = require("../utils/addressVerification");
const { isZipInServiceArea, countyForZip } = require("../utils/serviceArea");

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

const BABYLON = { address: "125 Main St", city: "Babylon", state: "NY", zip: "11702" };

console.log("\nA real Long Island address");

test("accepted, with the street line intact", () => {
  const r = buildSignupAddress(BABYLON);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.address.line1, "125 Main St");
  assert.strictEqual(r.address.city, "Babylon");
  assert.strictEqual(r.address.zip, "11702");
});

test("county is derived, not asked for", () => {
  const r = buildSignupAddress(BABYLON);
  assert.strictEqual(r.address.county, "Suffolk");
});

test("a second Long Island address lands in the other county", () => {
  const r = buildSignupAddress({ address: "125 Main St", city: "Farmingdale", state: "NY", zip: "11735" });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.address.county, "Nassau");
  assert.strictEqual(r.inServiceArea, true);
});

console.log("\nThe county the client sends is ignored");

test("a wrong county from the browser does not survive", () => {
  // 11702 is Babylon, which is Suffolk. The client insists it is Nassau.
  const r = buildSignupAddress({ ...BABYLON, county: "Nassau" });
  assert.strictEqual(r.address.county, "Suffolk");
});

test("an invented county from the browser does not survive", () => {
  const r = buildSignupAddress({ ...BABYLON, county: "Westchester" });
  assert.strictEqual(r.address.county, "Suffolk");
});

test("the old ZIP-prefix rule the form used is not reproduced here", () => {
  /*
   * The removed browser helper read prefix 115 as Nassau and 117/118/119 as
   * Suffolk. 11590 (Westbury) is Nassau and would pass either way; 11201
   * (Brooklyn Heights) is neither, and the prefix rule had no opinion at all.
   * What matters is that an unlisted ZIP gets no county rather than a guess.
   */
  assert.strictEqual(countyForZip("11590"), "Nassau");
  assert.strictEqual(buildSignupAddress({ address: "1 X St", city: "Brooklyn", state: "NY", zip: "11201" }).address.county, "");
});

console.log("\nNot an address");

test("no street line is refused", () => {
  assert.deepStrictEqual(buildSignupAddress({ ...BABYLON, address: "" }), { ok: false, field: "address" });
});

test("no city is refused", () => {
  assert.strictEqual(buildSignupAddress({ ...BABYLON, city: "" }).field, "city");
});

test("a non-numeric ZIP is refused", () => {
  assert.strictEqual(buildSignupAddress({ ...BABYLON, zip: "abcde" }).field, "zip");
});

test("a four-digit ZIP is refused", () => {
  assert.strictEqual(buildSignupAddress({ ...BABYLON, zip: "1170" }).field, "zip");
});

test("a ZIP+4 is accepted and reduced to five digits", () => {
  const r = buildSignupAddress({ ...BABYLON, zip: "11702-1234" });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.address.zip, "11702");
});

console.log("\nCoordinates are checked against the ZIP they claim");

test("a point inside its own ZIP is kept", () => {
  const r = buildSignupAddress({ ...BABYLON, lat: 40.6959, lng: -73.3262 });
  assert.strictEqual(r.address.lat, 40.6959);
  assert.strictEqual(r.address.lng, -73.3262);
  assert.strictEqual(r.coordsRejected, false);
});

test("a point in Texas carrying a Babylon ZIP is dropped, not stored", () => {
  const r = buildSignupAddress({ ...BABYLON, lat: 30.2672, lng: -97.7431 });
  assert.strictEqual(r.ok, true, "the registration still succeeds");
  assert.strictEqual(r.address.lat, null);
  assert.strictEqual(r.address.lng, null);
  assert.strictEqual(r.coordsRejected, true);
});

test("nonsense coordinates are dropped", () => {
  const r = buildSignupAddress({ ...BABYLON, lat: 999, lng: "banana" });
  assert.strictEqual(r.address.lat, null);
  assert.strictEqual(r.address.lng, null);
});

test("no coordinates at all is normal, not an error", () => {
  const r = buildSignupAddress(BABYLON);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.address.lat, null);
  assert.strictEqual(r.coordsRejected, false);
});

test("a ZIP we hold no geometry for cannot fail the coordinate check", () => {
  // Out-of-area ZIPs have no polygon. The honest answer is "cannot check".
  assert.strictEqual(coordsAgreeWithZip(30.2672, -97.7431, "78701"), true);
});

console.log("\nThe unit rides inside the street line");

test("a unit is appended to line1", () => {
  const r = buildSignupAddress({ ...BABYLON, unit: "Apt 4B" });
  assert.strictEqual(r.address.line1, "125 Main St Apt 4B");
});

test("two units at one building stay two different properties", () => {
  /*
   * findDuplicateAddress keys a property off line1. If the unit lived anywhere
   * else, Apt 1 and Apt 2 would collapse into one address and one of them would
   * lose its own first-visit eligibility.
   */
  const a = buildSignupAddress({ ...BABYLON, unit: "Apt 1" }).address.line1;
  const b = buildSignupAddress({ ...BABYLON, unit: "Apt 2" }).address.line1;
  assert.notStrictEqual(a, b);
});

test("no unit leaves the street line untouched", () => {
  assert.strictEqual(buildSignupAddress({ ...BABYLON, unit: "   " }).address.line1, "125 Main St");
});

console.log("\nOut of area: reported, never refused");

test("a Queens address still produces a valid account address", () => {
  const r = buildSignupAddress({ address: "90-10 Roosevelt Ave", city: "Jackson Heights", state: "NY", zip: "11372" });
  assert.strictEqual(r.ok, true, "registration must not be blocked by the service area");
  assert.strictEqual(r.inServiceArea, false);
  assert.strictEqual(r.address.county, "");
});

test("an out-of-state address still produces a valid account address", () => {
  const r = buildSignupAddress({ address: "1 Congress Ave", city: "Austin", state: "tx", zip: "78701" });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.inServiceArea, false);
  assert.strictEqual(r.address.state, "TX", "state is normalised to upper case");
});

test("the offer itself is still gated by the allowlist", () => {
  // The line that actually protects the free labour, unchanged by any of this.
  assert.strictEqual(isZipInServiceArea("11702"), true);
  assert.strictEqual(isZipInServiceArea("11372"), false);
  assert.strictEqual(isZipInServiceArea("78701"), false);
});

console.log("\nThe hand-typed fallback is not a side door");

test("a typed address carries no lookup identifiers", () => {
  const r = buildSignupAddress({ ...BABYLON, placeId: "", lat: null, lng: null });
  assert.strictEqual(r.address.placeId, "");
  assert.strictEqual(r.address.lat, null);
});

test("a typed out-of-area address is still out of area", () => {
  const r = buildSignupAddress({ address: "1 Congress Ave", city: "Austin", state: "TX", zip: "78701" });
  assert.strictEqual(r.inServiceArea, false);
});

test("a forged placeId buys nothing, because eligibility never reads it", () => {
  const r = buildSignupAddress({ address: "1 Congress Ave", city: "Austin", state: "TX", zip: "78701", placeId: "ChIJ_totally_made_up" });
  assert.strictEqual(r.inServiceArea, false);
});

if (failures) {
  console.log(`\n${failures} failing`);
  process.exit(1);
}
console.log("\nAll signup address checks passed");
