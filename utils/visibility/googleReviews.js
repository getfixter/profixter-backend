/**
 * Google Business Profile rating and review count, one snapshot a day.
 *
 * WHY. Reviews are one of the two money levers in the growth audit, and the
 * only number Google exposes for them is the running total. Recording it
 * daily turns that total into a velocity (reviews gained per 30 days), which
 * is what tells us whether review requests are working.
 *
 * WHAT THIS IS NOT. The count does not say WHO reviewed. The /review page is
 * an untracked redirect and a click there is explicitly not proof of a review
 * (owner ruling, 2026-09-09); nothing here may be joined to customers or used
 * to gate review requests. It is an aggregate trend, nothing more.
 *
 * SOURCE. The same Places Details request the site's rating badge makes
 * (utils/googlePlaces, env GOOGLE_PLACES_API_KEY + GOOGLE_PLACE_ID), asking
 * only for rating and user_ratings_total. Leaving out name/url/reviews keeps
 * the call no more expensive than the badge's.
 *
 * ON BY DEFAULT, unlike every other collector. It reuses a key the site
 * already holds, costs one request a day (about $0.02, i.e. ~$0.60/month at
 * list price, against a badge that already calls Google on page views), sends
 * nothing anywhere and writes one small row. The bar for "off until the owner
 * decides" is new credentials or a meaningful bill; this clears neither. Set
 * VISIBILITY_REVIEWS_ENABLED=false to stop it.
 */
const { fetchPlaceDetails } = require("../googlePlaces");
const { nyDate, shiftYmd, daysBetween, round, defaultFetch } = require("./common");
const { getDefaultStore } = require("./store");

const SOURCE = "google_reviews";
const FIELDS = "rating,user_ratings_total";

function reviewsEnabled(env = process.env) {
  return String(env.VISIBILITY_REVIEWS_ENABLED || "").toLowerCase() !== "false";
}

function reviewsConfig(env = process.env) {
  const key = env.GOOGLE_PLACES_API_KEY || "";
  const placeId = env.GOOGLE_PLACE_ID || "";
  if (!key || !placeId) {
    return { configured: false, reason: !key ? "missing GOOGLE_PLACES_API_KEY" : "missing GOOGLE_PLACE_ID" };
  }
  return { configured: true, key, placeId, secrets: [key] };
}

/** Fetch today's rating and total and upsert the day's snapshot. */
async function snapshotGoogleReviews({ env = process.env, now = new Date(), store = getDefaultStore(), fetchImpl } = {}) {
  const config = reviewsConfig(env);
  if (!config.configured) throw new Error(config.reason);

  const json = await fetchPlaceDetails({
    key: config.key,
    placeId: config.placeId,
    fields: FIELDS,
    fetchImpl: fetchImpl || defaultFetch(),
  });
  if (!json || json.status !== "OK") {
    throw new Error(`Places Details: ${json?.error_message || json?.status || "no response"}`);
  }

  const rating = Number(json.result?.rating);
  const total = Number(json.result?.user_ratings_total);
  // A profile with no reviews omits both fields. Store that as zero reviews,
  // but never store a NaN or a negative that would poison the trend.
  const metrics = {
    rating: Number.isFinite(rating) ? rating : null,
    total: Number.isFinite(total) && total >= 0 ? Math.round(total) : 0,
  };
  const row = { source: SOURCE, date: nyDate(now), key: config.placeId, metrics, fetchedAt: now };
  await store.upsertSnapshots([row]);
  return { date: row.date, ...metrics };
}

/**
 * Pure: the review trend from a list of daily snapshots.
 *
 * "Then" is the latest snapshot on or before (latest date - days). When the
 * history is shorter than the window, the earliest snapshot is used instead
 * and `partialWindow` says so; velocity is always scaled by the ACTUAL span
 * between the two snapshots, never by the requested window, so a 10-day
 * history is not mistaken for a 30-day one.
 *
 * Google occasionally removes reviews, so `gained` can be negative; it is
 * reported as is.
 */
function computeReviewTrend(snapshots, { days = 30 } = {}) {
  const rows = (snapshots || [])
    .filter((r) => r && r.metrics && Number.isFinite(Number(r.metrics.total)))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!rows.length) return { available: false, reason: "no_data" };

  const latest = rows[rows.length - 1];
  const target = shiftYmd(latest.date, -days);
  const onOrBefore = rows.filter((r) => r.date <= target);
  const then = onOrBefore.length ? onOrBefore[onOrBefore.length - 1] : rows[0];
  const spanDays = daysBetween(then.date, latest.date);
  const gained = Number(latest.metrics.total) - Number(then.metrics.total);

  return {
    available: true,
    rating: latest.metrics.rating ?? null,
    totalNow: Number(latest.metrics.total),
    nowDate: latest.date,
    totalThen: Number(then.metrics.total),
    thenDate: then.date,
    windowDays: days,
    spanDays,
    gained,
    velocityPer30Days: spanDays > 0 ? round((gained / spanDays) * 30, 1) : null,
    partialWindow: !onOrBefore.length,
    staleDays: null,
  };
}

/** Review count now vs `days` ago, and reviews per 30 days. Never throws on missing data. */
async function reviewTrend({ days = 30, store = getDefaultStore(), now = new Date() } = {}) {
  const today = nyDate(now);
  // A little more history than the window so "on or before" has something to land on.
  const rows = await store.findSnapshots({ source: SOURCE, from: shiftYmd(today, -(days + 14)), to: today });
  const trend = computeReviewTrend(rows, { days });
  if (trend.available) trend.staleDays = daysBetween(trend.nowDate, today);
  return trend;
}

module.exports = {
  SOURCE,
  reviewsEnabled,
  reviewsConfig,
  snapshotGoogleReviews,
  computeReviewTrend,
  reviewTrend,
};
