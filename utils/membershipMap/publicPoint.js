const crypto = require("crypto");

const ZIP_GEOGRAPHY = require("./zipGeography.json");

/**
 * The public map position for an active membership.
 *
 * THE HOUSE IS NEVER LOCATED. THAT IS THE WHOLE PRIVACY DESIGN.
 *
 * ProFixter has never geocoded a customer address and this feature deliberately
 * does not start. The obvious implementation - geocode the property, then push
 * the pin a little way off - would CREATE precise customer coordinates that do
 * not currently exist anywhere in the system, and then rely on an offset to
 * throw that precision away again. Every one of those coordinates would be a
 * new thing to leak, log, back up and regret.
 *
 * So the input here is the ZIP code, which is an area rather than a place. The
 * most precise fact that exists anywhere in this pipeline is "this membership
 * is somewhere in 11757", and the published point is a position inside that
 * area chosen by a hash. Its relationship to the actual property is arbitrary
 * by construction: the property was never an input, so the displacement is not
 * a radius anybody can subtract, it is the whole ZIP.
 *
 * WHAT THE JITTER IS ACTUALLY FOR
 * Not privacy - the ZIP-level derivation already provides that. Without it,
 * every member in one ZIP would stack on one pixel, which looks broken and
 * understates the footprint. The jitter spreads them, and nothing more.
 *
 * STABILITY
 * The position is derived, not stored and not random. The same membership
 * resolves to the same point on every request, across restarts and deploys,
 * for as long as it stays active - and vanishes when it does not.
 */

/**
 * Salt for the position hash.
 *
 * Defence in depth rather than the mechanism. Somebody who knew both the salt
 * and a subscription id could recompute that membership's pin, but the pin only
 * tells them the ZIP, which the hash is not needed to guess. Privacy rests on
 * the ZIP-level derivation above; this makes the mapping non-reproducible by
 * anybody outside the server, which costs nothing to add.
 */
const SALT = process.env.MEMBERSHIP_MAP_SALT || "profixter-membership-map-v1";

/**
 * How far a pin may sit from the area's internal point.
 *
 * Scaled to the ZIP'S OWN LAND AREA rather than a fixed radius, because a
 * fixed one is wrong in both directions on Long Island: dense village ZIPs are
 * a couple of kilometres across and would throw pins into the next town, while
 * eastern Suffolk ZIPs are enormous and would leave a tight knot of pins in the
 * middle of a large area.
 *
 * Land area only - AREAWATER is excluded upstream, so a ZIP fronting Great
 * South Bay does not get a radius inflated by the water it looks at.
 *
 * The 0.55 factor keeps the disc comfortably inside a roughly circular area;
 * anything the shape rejects is caught by the containment test below.
 */
const RADIUS_FACTOR = 0.55;
const MIN_RADIUS_M = 700;
const MAX_RADIUS_M = 2500;

/** Deterministic attempts to land inside the polygon before giving up. */
const PLACEMENT_ATTEMPTS = 12;

const EARTH_RADIUS_M = 6378137;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/** Two independent unit floats from one seed and counter. */
function unitPair(seed, counter) {
  const digest = crypto.createHash("sha256").update(`${SALT}:${seed}:${counter}`).digest();
  return [digest.readUInt32BE(0) / 0x1_0000_0000, digest.readUInt32BE(4) / 0x1_0000_0000];
}

function radiusForZip(geography) {
  const land = Number(geography?.landM2) || 0;
  if (land <= 0) return MIN_RADIUS_M;
  const equivalent = Math.sqrt(land / Math.PI);
  return clamp(equivalent * RADIUS_FACTOR, MIN_RADIUS_M, MAX_RADIUS_M);
}

/**
 * Move a point by a distance and bearing.
 *
 * Flat-earth offsets over a couple of kilometres at latitude 41, which is
 * accurate to well under the simplification already baked into the polygon.
 * The longitude step is divided by cos(lat) so the displacement is the same
 * number of metres east-west as north-south rather than being squashed.
 */
function offsetPoint(lat, lng, metres, bearingRad) {
  const dNorth = metres * Math.cos(bearingRad);
  const dEast = metres * Math.sin(bearingRad);
  const dLat = (dNorth / EARTH_RADIUS_M) * (180 / Math.PI);
  const dLng = (dEast / (EARTH_RADIUS_M * Math.cos((lat * Math.PI) / 180))) * (180 / Math.PI);
  return { lat: lat + dLat, lng: lng + dLng };
}

/**
 * Is the point inside the area?
 *
 * Ray casting, toggled across EVERY ring of the ZCTA rather than one of them.
 * That single loop buys two things at once. A genuinely multi-part area is
 * covered in full instead of having half of it treated as water - 11772 is
 * exactly this, a village plus a separate southern stretch, and the Census
 * internal point sits in the smaller half. And an inner ring subtracts itself:
 * a point inside an outer ring and also inside a hole crosses an even number of
 * edges and comes back outside, which is correct without inspecting winding
 * order.
 *
 * This is what stops a pin appearing in Great South Bay, in the Sound, or three
 * towns away. The safe area is the actual area, not a circle drawn near it.
 */
function pointInRings(lat, lng, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      const straddles = yi > lat !== yj > lat;
      if (!straddles) continue;
      const crossing = ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
      if (lng < crossing) inside = !inside;
    }
  }
  return inside;
}

/**
 * The published position for one membership, or null if it cannot be placed.
 *
 * Returns null rather than guessing. A ZIP outside the service-area table has
 * no shape to constrain a pin to, and a pin that is merely somewhere on Long
 * Island is not something to publish as if it meant something.
 */
function publicPointFor({ zip, seed }) {
  const key = String(zip || "").trim();
  const geography = ZIP_GEOGRAPHY[key];
  if (!geography || !Array.isArray(geography.rings) || !geography.rings.length) return null;
  if (!seed) return null;

  const radius = radiusForZip(geography);

  for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS; attempt += 1) {
    const [u, v] = unitPair(seed, attempt);
    /*
     * sqrt(u) rather than u, so points are spread evenly across the disc
     * instead of bunching toward the middle.
     */
    const distance = radius * Math.sqrt(u);
    const bearing = v * 2 * Math.PI;
    const candidate = offsetPoint(geography.lat, geography.lng, distance, bearing);
    if (pointInRings(candidate.lat, candidate.lng, geography.rings)) {
      return { lat: candidate.lat, lng: candidate.lng };
    }
  }

  /*
   * Every attempt fell outside - a long thin ZIP, or a coastal one shaped like
   * a crescent. The Census internal point is guaranteed by definition to lie
   * within the area, so it is the one position that is always safe. Several
   * memberships in such a ZIP will share it; a small stack of pins is a far
   * better outcome than one pin in the water.
   */
  return { lat: geography.lat, lng: geography.lng };
}

/** Whether the table knows a ZIP at all. Used to skip records early. */
function hasGeographyFor(zip) {
  return Boolean(ZIP_GEOGRAPHY[String(zip || "").trim()]);
}

module.exports = {
  MAX_RADIUS_M,
  MIN_RADIUS_M,
  ZIP_GEOGRAPHY,
  hasGeographyFor,
  pointInRings,
  publicPointFor,
  radiusForZip,
};
