const crypto = require("crypto");

const ZIP_GEOGRAPHY = require("./zipGeography.json");

/**
 * The public map position for an active membership.
 *
 * THE HOUSE IS NEVER LOCATED. THAT IS THE WHOLE PRIVACY DESIGN.
 *
 * ProFixter has never geocoded a customer address and this deliberately does
 * not start. Geocoding the property and pushing the pin a little way off would
 * CREATE precise customer coordinates that do not exist anywhere in the system,
 * then rely on an offset to throw that precision away again - a new column to
 * leak, log, back up and regret.
 *
 * So the input is the ZIP, which is an area rather than a place. The most
 * precise fact anywhere in this pipeline is "somewhere in 11757". The property
 * was never an input, so the displacement is not a radius anybody can subtract.
 *
 * WHY V2 MOVED THE PINS BACK TOWARDS THE MIDDLE
 *
 * V1 scattered each membership anywhere inside its ZIP, on the theory that a
 * wider spread was privately safer. It was not - the ZIP is what provides the
 * privacy, and the scatter was the only thing choosing WHERE in the ZIP. All it
 * bought was dishonesty: the median pin sat 836m from its own town centre and
 * the worst sat 2358m away, which on Long Island is the next town. Eight of
 * forty-three members appeared somewhere they do not live.
 *
 * Worse, the scatter was pointless for most of them. Spread exists only to stop
 * two members in one ZIP landing on the same pixel, and TWENTY-FIVE OF THIRTY-
 * TWO ZIPS HAVE EXACTLY ONE MEMBER. Those pins were being flung up to two
 * kilometres off-centre to avoid a collision with nobody.
 *
 * V2 places by ZIP rather than by member. One member sits essentially on the
 * ZIP's own representative point. Several members are dealt deterministic slots
 * on a compact ring around it, sized by how many there are. The spread is now
 * exactly as large as the crowding requires and no larger, so a Lindenhurst
 * member looks like they live in Lindenhurst.
 *
 * STABILITY
 * Positions are derived, never random and never stored. The same membership
 * resolves to the same point across requests, restarts and deploys - and
 * vanishes the moment its access does. Slots are dealt in hash order rather
 * than database order, so a neighbour joining or leaving does not reshuffle
 * everybody else's pin.
 */

/**
 * Salt for the position hash.
 *
 * Defence in depth rather than the mechanism. Somebody who knew both the salt
 * and a subscription id could recompute that pin, but the pin only tells them
 * the ZIP, which the hash is not needed to guess. Privacy rests on the ZIP-level
 * derivation; this costs nothing and makes the mapping non-reproducible off-box.
 */
const SALT = process.env.MEMBERSHIP_MAP_SALT || "profixter-membership-map-v1";

/**
 * How far a lone member sits from the ZIP's representative point.
 *
 * Not zero, because a map where every single-member ZIP sits on a mathematically
 * exact centroid looks generated rather than observed - and a pin visibly
 * snapped to a centroid also advertises that it is the only one there. Small
 * enough - under a quarter of a kilometre - that it is unambiguously the right
 * neighbourhood of the right town.
 *
 * This is slot 0 of the spiral below rather than a separate rule, so a lone
 * member and the first of five are placed by exactly the same arithmetic.
 */
const SOLO_OFFSET_M = 191;

/**
 * One step of the spiral a crowded ZIP is packed along.
 *
 * Slot i sits SPIRAL_STEP_M * sqrt(i + 0.5) from the anchor, so the first pin is
 * about 190m out - the lone-member case - the second about 330m, the fourth
 * about 520m. Growth slows as the count rises, which is what keeps a busy town
 * compact instead of letting the tenth member define how far the first sits.
 *
 * Everything is bounded by the ZIP's own ceiling below, so this is the shape of
 * the packing rather than a promise about distance.
 */
const SPIRAL_STEP_M = 270;

/**
 * The largest offset any pin may take, whatever the arithmetic above produces.
 *
 * Also bounded per-ZIP by the area's own size: a compact village ZIP gets a
 * proportionally tighter cluster than a large eastern Suffolk one, so nothing is
 * ever pushed outside the town it belongs to.
 */
const ABSOLUTE_MAX_OFFSET_M = 1100;
const ZIP_RADIUS_FACTOR = 0.45;

/**
 * Deterministic wobble applied to every slot radius.
 *
 * Without it a cluster is a perfect spiral, which reads as a diagram rather
 * than a distribution. Small enough that it never changes which town a pin is
 * in, and derived from the seed so it never changes at all.
 */
const WOBBLE_MIN = 0.92;
const WOBBLE_MAX = 1.08;

/** The furthest a lone member can land, wobble included. */
const MAX_SOLO_OFFSET_M = Math.round(SOLO_OFFSET_M * WOBBLE_MAX);

/** Deterministic shrink attempts before a pin falls back to the anchor. */
const SHRINK_STEPS = [1, 0.72, 0.5, 0.3];

const EARTH_RADIUS_M = 6378137;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function digest(...parts) {
  return crypto.createHash("sha256").update(`${SALT}:${parts.join(":")}`).digest();
}

/** A stable unit float in [0,1) from any inputs. */
function unit(...parts) {
  return digest(...parts).readUInt32BE(0) / 0x1_0000_0000;
}

/**
 * How far this ZIP may spread its pins, from its own land area.
 *
 * Land only - water area is excluded upstream, so a ZIP fronting Great South
 * Bay is not granted a wider cluster because of the water it looks at.
 */
function zipSpreadCeilingM(geography) {
  const land = Number(geography?.landM2) || 0;
  if (land <= 0) return SOLO_OFFSET_M;
  const equivalent = Math.sqrt(land / Math.PI);
  return clamp(equivalent * ZIP_RADIUS_FACTOR, SOLO_OFFSET_M, ABSOLUTE_MAX_OFFSET_M);
}

/**
 * How far the furthest pin sits when `count` members share this ZIP.
 *
 * The outermost slot of the spiral, clamped by the area's own ceiling. Reported
 * rather than used to place: the spiral needs no knowledge of the count, which
 * is the entire point of it.
 */
function clusterRadiusM(geography, count) {
  const outermost = SOLO_OFFSET_M + SPIRAL_STEP_M * Math.sqrt(Math.max(count, 1) - 1);
  return Math.min(outermost, zipSpreadCeilingM(geography), ABSOLUTE_MAX_OFFSET_M);
}

/**
 * Move a point by a distance and bearing.
 *
 * Flat-earth offsets over at most a kilometre at latitude 41, accurate to well
 * under the simplification already baked into the polygon. Longitude is divided
 * by cos(lat) so the displacement is the same number of metres east-west as
 * north-south rather than being squashed.
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
 * Ray casting toggled across EVERY ring of the ZCTA. That one loop buys two
 * things: a genuinely multi-part area is covered in full instead of having half
 * of it treated as water - 11772 is a village plus a separate southern stretch,
 * with the Census internal point in the smaller half - and an inner ring
 * subtracts itself, because a point inside an outer ring and also inside a hole
 * crosses an even number of edges and comes back outside.
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
 * Place one pin at a bearing and distance, pulling it in until it fits.
 *
 * A crescent-shaped coastal ZIP can easily put a slot in the water. Rather than
 * rejecting the slot and re-rolling somewhere arbitrary, the same bearing is
 * retried closer in: the pin keeps the direction its slot gave it - which is
 * what keeps a cluster looking like a cluster - and simply sits nearer the
 * middle. The anchor is the last resort and is always inside by definition.
 */
function placeAt(geography, distanceM, bearingRad) {
  for (const factor of SHRINK_STEPS) {
    const candidate = offsetPoint(geography.lat, geography.lng, distanceM * factor, bearingRad);
    if (pointInRings(candidate.lat, candidate.lng, geography.rings)) return candidate;
  }
  return { lat: geography.lat, lng: geography.lng };
}

/**
 * Positions for every active membership in ONE ZIP.
 *
 * Takes the whole group rather than one member at a time, because the right
 * spread is a property of the group: it is the answer to "how many pins have to
 * fit here", which a single membership cannot know on its own. This is the
 * change that fixes V1 - placement became a per-ZIP decision instead of a
 * per-member one.
 *
 * Returns a Map of seed to {lat, lng}. Seeds that cannot be placed are absent.
 */
function placeZipCluster({ zip, seeds }) {
  const key = String(zip || "").trim();
  const geography = ZIP_GEOGRAPHY[key];
  const out = new Map();
  if (!geography || !Array.isArray(geography.rings) || !geography.rings.length) return out;

  const usable = (seeds || []).filter(Boolean);
  if (!usable.length) return out;

  /*
   * Dealt in hash order, not database order.
   *
   * Slot n must belong to the same membership tomorrow as it does today, or a
   * cancellation somewhere else in the town would silently rearrange everybody
   * who stayed. Hashing gives a total order that depends only on the memberships
   * present, not on how Mongo happened to return them.
   */
  const ordered = [...usable].sort((a, b) => {
    const ha = digest("order", a).toString("hex");
    const hb = digest("order", b).toString("hex");
    return ha < hb ? -1 : ha > hb ? 1 : 0;
  });

  /*
   * A phyllotaxis spiral: slot i sits at i turns of the golden angle, a step
   * out proportional to sqrt(i).
   *
   * CHOSEN BECAUSE THE GEOMETRY DOES NOT DEPEND ON HOW MANY MEMBERS THERE ARE.
   *
   * The obvious layout - deal n evenly-spaced slots around one ring - has to
   * recompute every angle when n changes, so a single new membership in a town
   * rotates everybody already there. Measured, a third member joining moved an
   * existing pin 615m: nobody has moved house, but the map says they have.
   *
   * Here slot i is at the same angle and the same distance whatever else is in
   * the ZIP, so joining appends a pin and leaving removes one. Only members
   * whose hash sorts after a newcomer shift, and they shift by one slot rather
   * than by a whole rotation. It is also how sunflowers pack seeds, which is to
   * say it stays evenly spaced at every count without being told the count.
   *
   * The solo case falls out of the same formula rather than being special-cased:
   * slot 0 is sqrt(0.5) steps out, which is the lone-member offset.
   */
  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
  const ceiling = Math.min(zipSpreadCeilingM(geography), ABSOLUTE_MAX_OFFSET_M);
  /* Rotated per ZIP so neighbouring towns do not show the same rosette. */
  const rotation = unit("rotate", key) * 2 * Math.PI;

  ordered.forEach((seed, index) => {
    /*
     * A touch of deterministic wobble, so a cluster looks like a distribution
     * rather than a diagram. Tied to the seed, so it never changes.
     */
    const wobble = WOBBLE_MIN + unit("wobble", seed) * (WOBBLE_MAX - WOBBLE_MIN);
    const distance = Math.min((SOLO_OFFSET_M + SPIRAL_STEP_M * Math.sqrt(index)) * wobble, ceiling);
    const bearing = rotation + index * GOLDEN_ANGLE;
    out.set(seed, placeAt(geography, distance, bearing));
  });

  return out;
}

/** Whether the table knows a ZIP at all. Used to skip records early. */
function hasGeographyFor(zip) {
  return Boolean(ZIP_GEOGRAPHY[String(zip || "").trim()]);
}

module.exports = {
  ABSOLUTE_MAX_OFFSET_M,
  MAX_SOLO_OFFSET_M,
  SPIRAL_STEP_M,
  SOLO_OFFSET_M,
  ZIP_GEOGRAPHY,
  clusterRadiusM,
  hasGeographyFor,
  placeZipCluster,
  pointInRings,
  zipSpreadCeilingM,
};
