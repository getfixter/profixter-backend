/**
 * First-touch acquisition attribution: what we store, and how we name it.
 *
 * TRUE FIRST TOUCH. The browser records, once, how it first arrived at the
 * site from outside: the tags on that first landing URL (utm_*, fbclid, gclid,
 * Meta ids/names, our own ?source=event|qr|referral, a referral-program ?ref=)
 * and the external referrer. Nothing later replaces it - not a later ad click,
 * not a direct visit, not our own links (FrontEnd lib/meta.ts). Registration
 * sends that record and it is written to User.attribution exactly once.
 *
 * NEVER INVENTED. A customer with no evidence is "Direct / Unknown". An id is
 * shown as an id, never as a name. Facebook vs Instagram comes only from the
 * placement Meta itself writes into utm_source ({{site_source_name}}); fbclid
 * proves Meta, not which Meta app.
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
  /* Google's app/iOS click ids: Google Ads evidence, like gclid. */
  "gbraid",
  "wbraid",
  /* Meta ids and names from an ad's URL parameters ({{campaign.id}}, {{campaign.name}}...). */
  "campaignId",
  "campaignName",
  "adsetId",
  "adsetName",
  "adId",
  "adName",
  /* ?source= on our own acquisition links: event, qr, referral. */
  "refSource",
  /* ?ref= on a referral-program link: the referring customer's id. */
  "refCode",
  "landingPath",
  "referrer",
  /* The very first page this browser saw and where it came from. */
  "firstLandingPath",
  "firstReferrer",
  /* Anonymous browser id, linking the account to its SiteVisitor row. */
  "visitorId",
];

/*
 * The only ?source= values that are acquisition. Our own buttons also use
 * ?source= (home, about, start-screen) to say where on the site a click came
 * from; those describe navigation, not how someone found us, and are ignored.
 */
const ACQUISITION_REF_SOURCES = new Set(["event", "qr", "referral"]);

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
  // An internal ?source= (from an older browser's storage) is navigation, not acquisition.
  if (out.refSource && !ACQUISITION_REF_SOURCES.has(out.refSource.toLowerCase())) out.refSource = null;
  out.firstSeenAt = toDate(raw.firstSeenAt);
  out.fbclidAt = toDate(raw.fbclidAt);
  if (!any && !out.firstSeenAt) return null;
  out.capturedAt = now;
  return out;
}

/* ------------------------------------------------------------------ */
/* Source classification                                               */
/* ------------------------------------------------------------------ */

/*
 * The Overview's sources, in display order. The three Meta rows share the
 * group "meta" so the Overview can show their total as "Meta Ads".
 */
const SOURCES = [
  { key: "meta_facebook", label: "Facebook", group: "meta" },
  { key: "meta_instagram", label: "Instagram", group: "meta" },
  { key: "meta_other", label: "Other Meta", group: "meta" },
  { key: "google_ads", label: "Google Ads" },
  { key: "google_organic", label: "Google Organic" },
  { key: "search_other", label: "Bing & other search" },
  /* Our own outreach: replies to homeowners (GHL) and postcards - tagged links only. */
  { key: "outreach", label: "Outreach (replies, mail)" },
  { key: "events_qr", label: "Events / QR" },
  { key: "referral", label: "Referral" },
  { key: "other", label: "Other" },
  { key: "direct", label: "Direct / Unknown" },
];
const BY_KEY = Object.fromEntries(SOURCES.map((s) => [s.key, s]));
const GROUPS = [{ key: "meta", label: "Meta Ads" }];

const META_SOURCES = new Set(["facebook", "fb", "instagram", "ig", "meta", "facebook_ads", "meta_ads", "an", "msg", "messenger", "audience_network", "threads"]);
const FACEBOOK = new Set(["fb", "facebook", "facebook_ads", "facebook.com"]);
const INSTAGRAM = new Set(["ig", "instagram", "instagram.com"]);
const OUTREACH_SOURCES = new Set(["ghl_sms", "ghl_email", "direct_mail", "postcard", "eddm"]);
const PAID_MEDIUMS = new Set(["cpc", "ppc", "paid", "paid_social", "paidsocial", "paid-social", "social_paid", "ads", "ad", "cpm"]);

function hostOf(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/* l.facebook.com, m.facebook.com, lm.facebook.com -> facebook.com; l.instagram.com -> instagram.com */
function normalizeHost(host) {
  const h = String(host || "").toLowerCase().replace(/^www\./, "");
  for (const base of ["facebook.com", "instagram.com", "google.com", "bing.com", "yahoo.com", "duckduckgo.com", "yelp.com", "nextdoor.com", "chatgpt.com"]) {
    if (h === base || h.endsWith(`.${base}`)) return base;
  }
  return h;
}

const isInternalHost = (host) => !host || /(^|\.)profixter\.com$/.test(host) || host === "localhost";

/**
 * Which channel acquired this browser/customer, from its stored first touch.
 *
 * Strongest evidence first: a click id or the ad's own ids, then explicit tags
 * (utm, our acquisition ?source=, a referral ?ref=), then the external
 * referrer. With none of those: Direct / Unknown - never a guess.
 */
function classifySource(attr) {
  const a = attr || {};
  const src = String(a.utmSource || "").toLowerCase().trim();
  const medium = String(a.utmMedium || "").toLowerCase().trim();
  const refRaw = String(a.refSource || "").toLowerCase().trim();
  const ref = ACQUISITION_REF_SOURCES.has(refRaw) ? refRaw : "";
  const landing = String(a.landingPath || a.firstLandingPath || "").toLowerCase();
  const host = normalizeHost(hostOf(a.referrer || a.firstReferrer));

  let key = "direct";
  if (a.fbclid || a.campaignId || a.adsetId || a.adId || META_SOURCES.has(src)) {
    // Placement only from Meta's own utm_source ({{site_source_name}}); fbclid alone is just "Meta".
    key = FACEBOOK.has(src) ? "meta_facebook" : INSTAGRAM.has(src) ? "meta_instagram" : "meta_other";
  } else if (a.gclid || a.gbraid || a.wbraid || (src === "google" && PAID_MEDIUMS.has(medium))) key = "google_ads";
  else if (ref === "event" || ref === "qr" || src === "event" || src === "qr" || medium === "qr" || landing.startsWith("/event")) key = "events_qr";
  else if (OUTREACH_SOURCES.has(src)) key = "outreach";
  else if (a.refCode || ref === "referral" || medium === "referral" || src === "referral") key = "referral";
  else if (src === "google") key = "google_organic";
  else if (src) key = "other";
  else if (host === "google.com" || /(^|\.)google\./.test(host)) key = "google_organic";
  else if (["bing.com", "duckduckgo.com", "yahoo.com"].includes(host) || /(^|\.)(bing|duckduckgo|ecosia|brave)\./.test(host)) key = "search_other";
  // An organic Facebook/Instagram post (no click id, no tag) is not an ad: Other, with its host kept.
  else if (!isInternalHost(host)) key = "other";
  const s = BY_KEY[key];
  return { key, label: s.label, group: s.group || null };
}

/** For an "Other" first touch: the referring site or the unknown utm_source, so Other can be explained. */
function originOf(attr) {
  const a = attr || {};
  if (a.utmSource) return String(a.utmSource).toLowerCase().slice(0, 60);
  const host = normalizeHost(hostOf(a.referrer || a.firstReferrer));
  return isInternalHost(host) ? null : host;
}

/*
 * Meta campaign, ad set and ad - ids and names kept apart.
 *
 * Explicit parameters win (campaign_id, campaign_name...). The ads running in
 * October 2026 put ids into utm_campaign / utm_term / utm_content, so a value
 * there that is a Meta id (all digits) is read as the id, never as a name;
 * anything else there is a name. With no name, the Overview shows the id.
 */
const isMetaId = (v) => /^\d{6,}$/.test(String(v || "").trim());

function split(explicitId, explicitName, utmValue) {
  const id = explicitId || (isMetaId(utmValue) ? String(utmValue).trim() : null);
  const name = explicitName || (utmValue && !isMetaId(utmValue) ? String(utmValue).trim() : null);
  return { id: id || null, name: name || null };
}

function campaignOf(attr) {
  const a = attr || {};
  const campaign = split(a.campaignId, a.campaignName, a.utmCampaign);
  const adset = split(a.adsetId, a.adsetName, a.utmTerm);
  const ad = split(a.adId, a.adName, a.utmContent);
  const keyOf = (x) => x.id || x.name || null;
  return {
    campaignId: campaign.id,
    campaignName: campaign.name,
    campaignKey: keyOf(campaign),
    adsetId: adset.id,
    adsetName: adset.name,
    adsetKey: keyOf(adset),
    adId: ad.id,
    adName: ad.name,
    adKey: keyOf(ad),
  };
}

/** What to show for an id/name pair: the name, or "ID <id>", or a stated absence. */
function displayName(name, id, missing) {
  if (name) return name;
  if (id) return `ID ${id}`;
  return missing;
}

module.exports = {
  STRING_FIELDS,
  ACQUISITION_REF_SOURCES,
  SOURCES,
  GROUPS,
  sanitizeAttribution,
  classifySource,
  originOf,
  normalizeHost,
  campaignOf,
  displayName,
  isMetaId,
};
