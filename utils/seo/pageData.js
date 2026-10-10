/**
 * What a page looks like to Google right now, and how it performs in search.
 *
 * livePage(): fetches our own public page and reads its title, meta
 * description and H1 - the ground truth an SEO change is verified against.
 * pagePerformance(): sums Search Console's daily per-page rows for a window.
 */
const SITE = (process.env.MARKETING_SITE_BASE_URL || "https://www.profixter.com").replace(/\/+$/, "");

/** Only our own site, only page paths we publish. */
const ALLOWED_PATH = /^\/(|services\/[a-z0-9-]+|locations\/[a-z0-9-]+|guides\/[a-z0-9-]+|renovations\/[a-z0-9-]+|handyman-membership|membership|membership\/plans|services|locations|guides|book\/free|about)$/;

function decodeEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .trim();
}

async function livePage(path, { fetchImpl = globalThis.fetch } = {}) {
  if (!ALLOWED_PATH.test(path)) throw new Error(`Not a page we optimize: ${path}`);
  const res = await fetchImpl(`${SITE}${path}?seo-check=${Date.now()}`, { headers: { "User-Agent": "ProfixterGrowthEngine/1.0 (+https://www.profixter.com)" } });
  if (!res.ok) throw new Error(`${path} answered HTTP ${res.status}`);
  const html = await res.text();
  const pick = (re) => decodeEntities((html.match(re) || [])[1] || "");
  return {
    path,
    title: pick(/<title[^>]*>([\s\S]*?)<\/title>/i),
    // Respect the attribute's own quote: an apostrophe inside a double-quoted value ("Profixter's") is text.
    metaDescription:
      pick(/<meta[^>]+name=["']description["'][^>]+content="([^"]*)"/i) || pick(/<meta[^>]+name=["']description["'][^>]+content='([^']*)'/i),
    h1: pick(/<h1[^>]*>([\s\S]*?)<\/h1>/i).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(),
    noindex: /<meta[^>]+name=["']robots["'][^>]+content=["'][^"']*noindex/i.test(html),
  };
}

/** Clicks, impressions, CTR and impression-weighted position for one page over [from, to]. */
async function pagePerformance(path, { from, to, store } = {}) {
  const { getDefaultStore } = require("../visibility/store");
  const st = store || getDefaultStore();
  const docs = await st.findSnapshots({ source: "search_console", key: "pages", from, to });
  const url = `${SITE}${path}`;
  let clicks = 0;
  let impressions = 0;
  let posWeighted = 0;
  let days = 0;
  for (const d of docs) {
    days += 1;
    for (const r of d.metrics?.rows || []) {
      if (String(r.page).replace(/\/$/, "") !== url.replace(/\/$/, "")) continue;
      clicks += Number(r.clicks || 0);
      impressions += Number(r.impressions || 0);
      posWeighted += Number(r.position || 0) * Number(r.impressions || 0);
    }
  }
  return {
    path,
    daysWithData: days,
    clicks,
    impressions,
    ctr: impressions ? Math.round((clicks / impressions) * 10000) / 100 : null,
    position: impressions ? Math.round((posWeighted / impressions) * 10) / 10 : null,
  };
}

module.exports = { ALLOWED_PATH, SITE, livePage, pagePerformance };
