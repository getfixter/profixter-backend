/**
 * Long Island, flattened onto the SVG the homepage draws.
 *
 * WHY THE SERVER PROJECTS AND THE CLIENT DOES NOT.
 *
 * The published payload carries drawing positions, not geography. Sending
 * latitude and longitude would be safe enough on its own - the points are
 * derived from a ZIP area and were never the customer's location - but there is
 * no reason for a public endpoint to hand out anything shaped like a coordinate
 * when the browser's only job is to place a circle in a box.
 *
 * This is honestly not a cryptographic improvement: the bounds below ship in
 * the client bundle, so the transform is reversible by anybody who cares, and
 * what it reverses to is still only a point inside a ZIP. The privacy is in
 * publicPoint.js. This just means nothing in the response looks like an address.
 *
 * Equirectangular, with longitude scaled by cos(latitude) at the middle of the
 * island. Over two degrees of longitude at latitude 41 that is visually
 * indistinguishable from a proper conformal projection, and it is four lines
 * instead of a dependency.
 */

/**
 * The visible window: the ProFixter service area, with a little air.
 *
 * Derived from the bounding box of the 169 service-area ZIP polygons, padded so
 * the coastline is not flush against the frame. Deliberately excludes the far
 * eastern county fragments that would otherwise stretch the frame and shrink
 * the part of the island anybody actually lives in.
 */
const MAP_BOUNDS = {
  west: -73.81,
  east: -71.82,
  south: 40.54,
  north: 41.24,
};

/** The latitude longitude is scaled at - the middle of the frame. */
const REFERENCE_LAT = (MAP_BOUNDS.north + MAP_BOUNDS.south) / 2;
const LNG_SCALE = Math.cos((REFERENCE_LAT * Math.PI) / 180);

const VIEWBOX_WIDTH = 1000;

/**
 * Height that keeps the island its real shape.
 *
 * Computed rather than chosen, so a change to the bounds cannot silently
 * stretch Long Island into something that is not Long Island.
 */
const VIEWBOX_HEIGHT = Math.round(
  (VIEWBOX_WIDTH * (MAP_BOUNDS.north - MAP_BOUNDS.south)) /
    ((MAP_BOUNDS.east - MAP_BOUNDS.west) * LNG_SCALE)
);

const VIEWBOX = { width: VIEWBOX_WIDTH, height: VIEWBOX_HEIGHT };

/**
 * Geography to drawing position, or null if it falls outside the frame.
 *
 * Rounded to one decimal: about 150 metres on this map, which is far finer than
 * a pin is wide and keeps the payload small.
 */
function project(lat, lng) {
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  const x =
    ((longitude - MAP_BOUNDS.west) / (MAP_BOUNDS.east - MAP_BOUNDS.west)) * VIEWBOX_WIDTH;
  const y =
    ((MAP_BOUNDS.north - latitude) / (MAP_BOUNDS.north - MAP_BOUNDS.south)) * VIEWBOX_HEIGHT;

  if (x < 0 || x > VIEWBOX_WIDTH || y < 0 || y > VIEWBOX_HEIGHT) return null;

  return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
}

module.exports = { MAP_BOUNDS, REFERENCE_LAT, VIEWBOX, project };
