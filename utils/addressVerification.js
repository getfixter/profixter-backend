/**
 * Turning a looked-up address into one we are willing to store.
 *
 * The signup form now asks one question instead of five: the customer searches,
 * picks a real address, and the structured parts arrive already separated. That
 * moves a job onto the server. The browser is now the only thing that saw the
 * address provider, so everything it sends has to be treated as a claim rather
 * than a fact — a POST straight at /register never touched Google at all.
 *
 * Two claims matter and are handled differently.
 *
 * THE COUNTY IS NOT ACCEPTED AT ALL. serviceArea.js already says the customer's
 * county string is advisory and never trusted, and the old form made that worse
 * by mapping ZIP prefixes 115/117/118/119 to a county in the browser — exactly
 * the range-matching that module refuses to do, because Long Island ZIPs
 * interleave with Queens. It is derived here from the allowlist instead, so
 * there is one definition of which county a ZIP is in.
 *
 * THE COORDINATES ARE CHECKED AGAINST THE ZIP. We already ship polygon rings
 * for every serviceable ZIP (utils/membershipMap/zipGeography.json, built from
 * census geography and committed), so a point can be tested against the ZIP it
 * claims to be in without an API key, a network call or a cent of cost. A pair
 * that disagrees is dropped rather than rejected: bad coordinates are worth
 * nothing, but they are not worth failing a registration over, and nothing
 * about the account depends on them.
 *
 * WHAT THIS DOES NOT DO: it does not decide who may register. Out-of-area
 * accounts stay valid and stay welcome. The First Visit Free offer is the thing
 * the ZIP allowlist gates, and it is gated where it is spent — in bookings.js,
 * against the stored address, exactly as it was before this file existed.
 */
const { normalizeZip, countyForZip, isZipInServiceArea } = require("./serviceArea");
const { ZIP_GEOGRAPHY, pointInRings } = require("./membershipMap/publicPoint");

/** A finite number inside plausible earth bounds, or null. */
function finiteCoord(value, limit) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (Math.abs(n) > limit) return null;
  return n;
}

/**
 * Do these coordinates actually fall inside the ZIP they claim?
 *
 * Returns true for a ZIP we hold no geometry for, which is every ZIP outside
 * the service area. That is not a loophole: it is the honest answer to a
 * question we have no data to answer, and since eligibility is decided by the
 * ZIP allowlist rather than by coordinates, a point we cannot check cannot buy
 * anyone anything.
 */
function coordsAgreeWithZip(lat, lng, zip) {
  const key = normalizeZip(zip);
  if (!key) return false;
  const geography = ZIP_GEOGRAPHY[key];
  if (!geography || !Array.isArray(geography.rings) || !geography.rings.length) return true;
  return pointInRings(lat, lng, geography.rings);
}

/**
 * Build the address subdocument for a signup, from whatever the client sent.
 *
 * Returns { ok: false, field } when something required is missing or malformed,
 * so the caller can answer with one short message naming the offending part.
 */
function buildSignupAddress(input = {}) {
  const line1 = String(input.line1 || input.address || "").trim();
  const unit = String(input.unit || "").trim();
  const city = String(input.city || "").trim();
  const state = String(input.state || "NY").trim().toUpperCase();
  const zip = normalizeZip(input.zip);

  if (!line1) return { ok: false, field: "address" };
  if (!city) return { ok: false, field: "city" };
  if (!state) return { ok: false, field: "state" };
  if (!zip) return { ok: false, field: "zip" };

  /*
   * The unit rides inside line1 rather than getting a column of its own.
   *
   * That is not laziness about the model: findDuplicateAddress builds its key
   * from line1, and its comment says so — "Apt 1" and "Apt 2" are deliberately
   * distinct properties, each with its own introductory-visit eligibility. A
   * separate line2 that the key ignored would quietly merge them and hand one
   * building's worth of free first visits to whoever asked first.
   */
  const composedLine1 = unit ? `${line1} ${unit}`.trim() : line1;

  const lat = finiteCoord(input.lat, 90);
  const lng = finiteCoord(input.lng, 180);
  const hasCoords = lat !== null && lng !== null;
  const coordsUsable = hasCoords && coordsAgreeWithZip(lat, lng, zip);

  return {
    ok: true,
    address: {
      label: "Primary",
      line1: composedLine1,
      city,
      state,
      zip,
      // Derived, never accepted. "" for anywhere we do not serve.
      county: countyForZip(zip) || "",
      placeId: String(input.placeId || "").trim().slice(0, 300),
      lat: coordsUsable ? lat : null,
      lng: coordsUsable ? lng : null,
    },
    inServiceArea: isZipInServiceArea(zip),
    coordsRejected: hasCoords && !coordsUsable,
  };
}

module.exports = {
  buildSignupAddress,
  coordsAgreeWithZip,
};
