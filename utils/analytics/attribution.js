/**
 * First-touch marketing attribution: what we store, and how we name it.
 *
 * STORED ONCE, AT REGISTRATION. The browser keeps the first identifiable
 * marketing touch (utm_*, fbclid, gclid, Meta campaign/ad ids) and, separately,
 * the very first page it ever landed on. Both are sent with registration and
 * written to User.attribution exactly once. Nothing here ever rewrites an
 * existing record, and nothing here ever invents a source: a customer with no
 * evidence is "Direct / Unknown", which keeps tracking gaps visible.
 *
 * Everything posted is untrusted: only the listed keys are kept, each is
 * clipped, and unknown keys are dropped.
 */

const STRING_FIELDS = [
  "utmSource",
  "utmMedium",
  "utmCampaign",
  "utmContent",
  "utmTerm",
  "fbclid",
  "gclid",
  /* Meta's own ids/names, from the ad's URL parameters ({{campaign.id}} etc). */
  "campaignId",
  "adsetId",
  "adsetName",
  "adId",
  "adName",
  /* ?source= on our own links - event kiosk QR, referral links. */
  "refSource",
  "landingPath",
  "referrer",
  /* The very first page this browser ever saw, marketing or not. */
  "firstLandingPath",
  "firstReferrer",
  /* Anonymous browser id, linking the account to its first SiteVisitor row. */
  "visitorId",
];

function clip(value, max = 300) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim().slice(0, max);
  return text || null;
}

function toDate(value) {
  if (value === undefined || value === null || value === "") return null;
  const date = new Date(typeof value === "number" ? value : String(value));
  if (Number.isNaN(date.getTime())) return null;
  // A browser clock can be wrong; never accept a first touch from the future.
  return date.getTime() > Date.now() + 60 * 1000 ? null : date;
}

/** The record to store on User.attribution, or null if nothing was sent. */
function sanitizeAttribution(raw, { now = new Date() } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  let any = false;
  for (const key of STRING_FIELDS) {
    out[key] = clip(raw[key]);
    if (out[key]) any = true;
  }
  out.firstSeenAt = toDate(raw.firstSeenAt);
  out.fbclidAt = toDate(raw.fbclidAt);
  if (!any && !out.firstSeenAt) return null;
  out.capturedAt = now;
  return out;
}

/* ------------------------------------------------------------------ */
/* Source classification                                               */
/* ------------------------------------------------------------------ */

const SOURCES = [
  { key: "meta_ads", label: "Meta Ads" },
  { key: "google_ads", label: "Google Ads" },
  { key: "google_organic", label: "Google Organic" },
  { key: "events_qr", label: "Events / QR" },
  { key: "referral", label: "Referral" },
  { key: "direct", label: "Direct / Unknown" },
  { key: "other", label: "Other" },
];
const LABELS = Object.fromEntries(SOURCES.map((s) => [s.key, s.label]));

const META_SOURCES = new Set(["facebook", "fb", "instagram", "ig", "meta", "facebook_ads", "meta_ads", "an", "messenger"]);
const PAID_MEDIUMS = new Set(["cpc", "ppc", "paid", "paid_social", "paidsocial", "paid-social", "social_paid", "ads", "ad", "cpm"]);

function hostOf(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Which channel acquired this customer, from the stored first touch.
 *
 * Order matters and is conservative: a click id is the strongest evidence,
 * then explicit utm/source tags, then the referrer. With none of those the
 * answer is Direct / Unknown - never a guess.
 */
function classifySource(attr) {
  const a = attr || {};
  const src = String(a.utmSource || "").toLowerCase();
  const medium = String(a.utmMedium || "").toLowerCase();
  const ref = String(a.refSource || "").toLowerCase();
  const landing = String(a.landingPath || a.firstLandingPath || "").toLowerCase();

  let key = "direct";
  if (a.fbclid || a.campaignId || a.adId || a.adsetId || META_SOURCES.has(src)) key = "meta_ads";
  else if (a.gclid || (src === "google" && PAID_MEDIUMS.has(medium))) key = "google_ads";
  else if (ref === "event" || ref === "qr" || src === "event" || src === "qr" || medium === "qr" || landing.startsWith("/event")) key = "events_qr";
  else if (medium === "referral" || ref === "referral" || src === "referral") key = "referral";
  else if (src === "google") key = "google_organic";
  else if (src) key = "other";
  else {
    const host = hostOf(a.referrer || a.firstReferrer);
    if (/(^|\.)google\./.test(host) || host === "google.com") key = "google_organic";
    // A facebook.com referrer with no click id or tag is usually an organic
    // post, not an ad - counting it as Meta Ads would flatter the ads.
    else if (host && !/profixter\.com$/.test(host)) key = "other";
  }
  return { key, label: LABELS[key] };
}

/** Campaign / ad set / ad as stored, best name first, id as the fallback. */
function campaignOf(attr) {
  const a = attr || {};
  return {
    campaign: a.utmCampaign || a.campaignId || null,
    campaignId: a.campaignId || null,
    adset: a.adsetName || a.utmTerm || a.adsetId || null,
    adsetId: a.adsetId || null,
    ad: a.adName || a.utmContent || a.adId || null,
    adId: a.adId || null,
  };
}

module.exports = { STRING_FIELDS, SOURCES, sanitizeAttribution, classifySource, campaignOf };
