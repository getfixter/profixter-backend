/**
 * The one Google Places Details request Profixter makes.
 *
 * Two callers share it: GET /api/google/reviews (the site's rating badge and
 * review strip) and the daily review snapshot (utils/visibility/googleReviews).
 * Keeping the URL in one place means the badge and the trend can never read
 * the profile differently, e.g. a different place id or language.
 *
 * This returns Google's parsed JSON untouched and lets network and parse
 * errors propagate, exactly as the route always did inline; each caller keeps
 * its own handling of `status !== "OK"`. Extracting it changed nothing about
 * the route's responses.
 *
 * COST. Billed per request by the fields asked for: rating,
 * user_ratings_total and reviews are "Atmosphere" fields, so every call costs
 * a Place Details request plus the Atmosphere surcharge (about $0.02 at list
 * price; https://developers.google.com/maps/billing-and-pricing/pricing).
 */
const fetch = require("node-fetch");

const DETAILS_ENDPOINT = "https://maps.googleapis.com/maps/api/place/details/json";

/** The fields the rating badge needs. Order matters only for URL identity. */
const BADGE_FIELDS = "name,rating,user_ratings_total,url,reviews";

function placeDetailsUrl({ key, placeId, fields = BADGE_FIELDS }) {
  return (
    DETAILS_ENDPOINT +
    `?place_id=${encodeURIComponent(placeId)}` +
    `&fields=${encodeURIComponent(fields)}` +
    `&language=en` +
    `&key=${encodeURIComponent(key)}`
  );
}

/** Raw Places Details JSON ({ status, result, error_message }). */
async function fetchPlaceDetails({ key, placeId, fields = BADGE_FIELDS, fetchImpl = fetch }) {
  const resp = await fetchImpl(placeDetailsUrl({ key, placeId, fields }));
  return resp.json();
}

module.exports = { BADGE_FIELDS, placeDetailsUrl, fetchPlaceDetails };
