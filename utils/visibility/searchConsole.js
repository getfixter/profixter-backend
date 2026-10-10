/**
 * Google Search Console: what people searched when profixter.com showed up.
 *
 * WHAT IS READ. The Search Analytics API (searchanalytics.query), read-only,
 * per day:
 *   - totals: clicks, impressions, CTR and average position for the site;
 *   - the top 250 queries (dimension "query") with the same four numbers;
 *   - the top 250 pages (dimension "page").
 * Stored as three VisibilitySnapshot rows per day (key "totals", "queries",
 * "pages"), each day's rows bundled into one document. One document per
 * query would be ~90,000 rows a year for no gain, and a bundled day is
 * replaced whole when re-read, so a query that drops out of a restated day
 * cannot linger as a stale row.
 *
 * WHY THE LAST THREE DAYS, EVERY DAY. Search Console data arrives two to
 * three days late and Google restates recent days as it finalises them. Each
 * run re-reads (today-4 .. today-2) and overwrites, which absorbs both. A day
 * Google has not published yet returns no rows and is simply not written, so
 * an empty day is never stored as a day of zero traffic. The first run (and a
 * run after a long gap) backfills SEARCH_CONSOLE_BACKFILL_DAYS (default 28).
 *
 * THE TOP 250 DO NOT ADD UP TO THE TOTAL. Google withholds rare ("anonymized")
 * queries, so family sums are a floor, not a share of the total. The summary
 * reports them as numbers in their own right, never as a percentage of the
 * site total.
 *
 * COST: none. The Search Console API is free (quota: 1,200 queries/minute per
 * site); a normal run makes 9 requests.
 *
 * OWNER SETUP (one time, ~10 minutes):
 *   1. Google Cloud console (any project, e.g. the one that owns the Places
 *      key): APIs & Services > Library > enable "Google Search Console API".
 *   2. IAM & Admin > Service Accounts > Create service account (no roles
 *      needed) > Keys > Add key > JSON. Download the file.
 *   3. Search Console > Settings > Users and permissions > Add user: the
 *      service account's email (…@….iam.gserviceaccount.com), permission
 *      "Restricted" (read-only is all this needs).
 *   4. On Elastic Beanstalk set
 *        GSC_SERVICE_ACCOUNT_JSON = base64 of that JSON file
 *          (PowerShell: [Convert]::ToBase64String([IO.File]::ReadAllBytes("key.json")))
 *        GSC_SITE_URL = the property exactly as Search Console names it:
 *          "sc-domain:profixter.com" for a Domain property, or
 *          "https://www.profixter.com/" for a URL-prefix property
 *        SEARCH_CONSOLE_SYNC_ENABLED = true
 *   Then delete the downloaded key file.
 */
const { nyDate, shiftYmd, daysBetween, round, fetchJson, defaultFetch } = require("./common");
const { classifyQuery, FAMILIES } = require("./queryFamilies");
const { getDefaultStore } = require("./store");

const SOURCE = "search_console";
const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const API_BASE = "https://searchconsole.googleapis.com/webmasters/v3/sites";
const TOP_ROWS = 250;
const LAG_DAYS = 2; // newest day requested: today - 2 (New York)
const REREAD_DAYS = 3; // re-read this many most recent days every run
const STATE_KEY = "visibility:search_console:cursor";

function searchConsoleEnabled(env = process.env) {
  return String(env.SEARCH_CONSOLE_SYNC_ENABLED || "").toLowerCase() === "true";
}

/** Decode the base64 service-account key. Never returns or logs the key itself on failure. */
function parseServiceAccount(encoded) {
  if (!encoded) return { ok: false, reason: "missing GSC_SERVICE_ACCOUNT_JSON" };
  let json;
  try {
    const text = /^\s*\{/.test(encoded) ? encoded : Buffer.from(String(encoded).trim(), "base64").toString("utf8");
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: "GSC_SERVICE_ACCOUNT_JSON is not base64 of a JSON key file" };
  }
  if (!json.client_email || !json.private_key) {
    return { ok: false, reason: "GSC_SERVICE_ACCOUNT_JSON lacks client_email/private_key" };
  }
  return { ok: true, credentials: { client_email: json.client_email, private_key: json.private_key } };
}

/**
 * KEYLESS (preferred): Workload Identity Federation. GSC_EXTERNAL_ACCOUNT_JSON
 * holds a credential CONFIG (not a secret) produced by
 * `gcloud iam workload-identity-pools create-cred-config ... --aws`: the
 * server proves its AWS identity (the EB instance role, via IMDSv2) to Google,
 * which lets it impersonate the read-only service account. No key exists.
 */
function parseExternalAccount(encoded) {
  if (!encoded) return null;
  try {
    const text = /^\s*\{/.test(encoded) ? encoded : Buffer.from(String(encoded).trim(), "base64").toString("utf8");
    const json = JSON.parse(text);
    if (json.type !== "external_account" || !json.service_account_impersonation_url) return { ok: false, reason: "GSC_EXTERNAL_ACCOUNT_JSON is not an external_account config with impersonation" };
    return { ok: true, config: json };
  } catch {
    return { ok: false, reason: "GSC_EXTERNAL_ACCOUNT_JSON is not a JSON credential config" };
  }
}

function searchConsoleConfig(env = process.env) {
  const siteUrl = String(env.GSC_SITE_URL || "").trim();
  const external = parseExternalAccount(env.GSC_EXTERNAL_ACCOUNT_JSON);
  if (external?.ok) return { configured: true, siteUrl: siteUrl || null, external: external.config, secrets: [] };
  if (external && !external.ok) return { configured: false, reason: external.reason };
  const account = parseServiceAccount(env.GSC_SERVICE_ACCOUNT_JSON);
  if (!account.ok) return { configured: false, reason: account.reason };
  // GSC_SITE_URL is optional: without it the property is discovered from the
  // service account's own site list (see resolveSiteUrl).
  return {
    configured: true,
    siteUrl: siteUrl || null,
    credentials: account.credentials,
    secrets: [account.credentials.private_key, env.GSC_SERVICE_ACCOUNT_JSON],
  };
}

/** Access tokens through Workload Identity Federation (no key). */
function externalAccountTokenSource(config) {
  const { ExternalAccountClient } = require("google-auth-library");
  const client = ExternalAccountClient.fromJSON({ ...config, scopes: [SCOPE] });
  if (!client) throw new Error("Search Console: unusable external account config");
  return async () => {
    const { token } = await client.getAccessToken();
    if (!token) throw new Error("Search Console: no access token from workload identity federation");
    return token;
  };
}

/** A function that returns a fresh OAuth access token for the service account. */
function serviceAccountTokenSource(credentials) {
  const { JWT } = require("google-auth-library");
  const client = new JWT({ email: credentials.client_email, key: credentials.private_key, scopes: [SCOPE] });
  return async () => {
    const { token } = await client.getAccessToken();
    if (!token) throw new Error("Search Console: no access token from service account");
    return token;
  };
}

function metricsOf(row) {
  return {
    clicks: Number(row.clicks || 0),
    impressions: Number(row.impressions || 0),
    ctr: round(row.ctr, 4),
    position: round(row.position, 2),
  };
}

async function queryAnalytics({ fetchImpl, token, siteUrl, body }) {
  const url = `${API_BASE}/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  const json = await fetchJson(fetchImpl, url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body,
  });
  return Array.isArray(json.rows) ? json.rows : [];
}

/** The days to (re)read this run: the last three complete days, or a backfill after a gap. */
function syncWindow(cursor, today, backfillDays) {
  const end = shiftYmd(today, -LAG_DAYS);
  const reread = shiftYmd(end, -(REREAD_DAYS - 1));
  const earliest = shiftYmd(end, -(backfillDays - 1));
  // After a gap, resume from a little before the last day we hold (so it is
  // re-read too), but never further back than the backfill limit.
  let start = earliest;
  if (cursor?.lastDataDate) {
    if (cursor.lastDataDate >= shiftYmd(reread, -1)) start = reread; // the normal daily case
    else {
      const resume = shiftYmd(cursor.lastDataDate, -(REREAD_DAYS - 1));
      start = resume < earliest ? earliest : resume;
    }
  }
  const days = [];
  for (let d = start; d <= end; d = shiftYmd(d, 1)) days.push(d);
  return days;
}

/** Read the window from Search Console and upsert its days. */
/**
 * The Search Console property to read. GSC_SITE_URL wins; otherwise the
 * service account's site list is read and the profixter.com property it has
 * real access to is used (a Domain property is preferred over a URL-prefix
 * one, because it covers http/https and www/apex together).
 */
async function resolveSiteUrl({ configured, fetchImpl, token }) {
  if (configured) return configured;
  const res = await fetchImpl(API_BASE, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Search Console site list failed: HTTP ${res.status}`);
  const usable = (body.siteEntry || []).filter(
    (e) => /profixter\.com/i.test(e.siteUrl || "") && e.permissionLevel && e.permissionLevel !== "siteUnverifiedUser"
  );
  const pick = usable.find((e) => e.siteUrl.startsWith("sc-domain:")) || usable[0];
  if (!pick) {
    throw new Error("Search Console: the service account has no access to a profixter.com property yet (add it under Settings > Users and permissions)");
  }
  return pick.siteUrl;
}

async function syncSearchConsole({
  env = process.env,
  now = new Date(),
  store = getDefaultStore(),
  fetchImpl,
  getAccessToken,
} = {}) {
  const config = searchConsoleConfig(env);
  if (!config.configured) throw new Error(config.reason);
  const doFetch = fetchImpl || defaultFetch();
  const tokenSource = getAccessToken || (config.external ? externalAccountTokenSource(config.external) : serviceAccountTokenSource(config.credentials));
  const backfillDays = Math.min(Math.max(Number(env.SEARCH_CONSOLE_BACKFILL_DAYS) || 28, REREAD_DAYS), 480);

  const cursor = await store.readState(STATE_KEY);
  const days = syncWindow(cursor, nyDate(now), backfillDays);
  const token = await tokenSource();
  const siteUrl = await resolveSiteUrl({ configured: config.siteUrl, fetchImpl: doFetch, token });
  const ctx = { fetchImpl: doFetch, token, siteUrl };

  // Totals for the whole window in one request; per-day top lists need one
  // request each (a multi-day request ranks rows across days, not within one).
  const totals = await queryAnalytics({
    ...ctx,
    body: { startDate: days[0], endDate: days[days.length - 1], dimensions: ["date"], type: "web", rowLimit: 1000 },
  });
  const totalsByDay = new Map(totals.map((r) => [r.keys?.[0], metricsOf(r)]));

  const rows = [];
  let requests = 1;
  for (const day of days) {
    if (!totalsByDay.has(day)) continue; // not published yet: write nothing rather than zeros
    const [queries, pages] = await Promise.all(
      ["query", "page"].map((dimension) =>
        queryAnalytics({
          ...ctx,
          body: { startDate: day, endDate: day, dimensions: [dimension], type: "web", rowLimit: TOP_ROWS },
        })
      )
    );
    requests += 2;
    const fetchedAt = now;
    rows.push({ source: SOURCE, date: day, key: "totals", metrics: totalsByDay.get(day), fetchedAt });
    rows.push({
      source: SOURCE,
      date: day,
      key: "queries",
      metrics: { rows: queries.map((r) => ({ query: String(r.keys?.[0] || ""), ...metricsOf(r) })) },
      fetchedAt,
    });
    rows.push({
      source: SOURCE,
      date: day,
      key: "pages",
      metrics: { rows: pages.map((r) => ({ page: String(r.keys?.[0] || ""), ...metricsOf(r) })) },
      fetchedAt,
    });
  }

  await store.upsertSnapshots(rows);
  const written = rows.filter((r) => r.key === "totals").map((r) => r.date);
  const newest = written.length ? written[written.length - 1] : null;
  if (newest && newest > (cursor?.lastDataDate || "")) {
    await store.writeState(STATE_KEY, { lastDataDate: newest });
  }
  return { requested: days, written, requests };
}

/* ------------------------------------------------------------------ */
/* Summary                                                             */
/* ------------------------------------------------------------------ */

function sumMetrics(list) {
  let clicks = 0;
  let impressions = 0;
  let positionWeight = 0;
  for (const m of list) {
    clicks += Number(m.clicks || 0);
    impressions += Number(m.impressions || 0);
    if (m.position !== null && m.position !== undefined) positionWeight += Number(m.position) * Number(m.impressions || 0);
  }
  return {
    clicks,
    impressions,
    ctr: impressions ? round(clicks / impressions, 4) : null,
    position: impressions ? round(positionWeight / impressions, 1) : null,
  };
}

function pctChange(now, before) {
  if (!before) return null;
  return round(((now - before) / before) * 100, 1);
}

/**
 * Pure: the Search Console summary from stored day rows.
 *
 * Windows end at the newest day with data (not "today", which never has
 * data yet): current = the last `days` days with data up to that day,
 * previous = the `days` before it.
 */
function computeSearchSummary(rows, { days = 28 } = {}) {
  const totals = rows.filter((r) => r.key === "totals").sort((a, b) => a.date.localeCompare(b.date));
  if (!totals.length) return { available: false, reason: "no_data" };

  const lastDate = totals[totals.length - 1].date;
  const currentFrom = shiftYmd(lastDate, -(days - 1));
  const previousFrom = shiftYmd(currentFrom, -days);
  const inCurrent = (d) => d >= currentFrom && d <= lastDate;
  const inPrevious = (d) => d >= previousFrom && d < currentFrom;

  const current = sumMetrics(totals.filter((r) => inCurrent(r.date)).map((r) => r.metrics));
  const previous = sumMetrics(totals.filter((r) => inPrevious(r.date)).map((r) => r.metrics));
  const previousDays = new Set(totals.filter((r) => inPrevious(r.date)).map((r) => r.date)).size;

  // Per query, per window.
  const queryStats = new Map();
  for (const r of rows.filter((x) => x.key === "queries")) {
    const bucket = inCurrent(r.date) ? "current" : inPrevious(r.date) ? "previous" : null;
    if (!bucket) continue;
    for (const q of r.metrics?.rows || []) {
      if (!q.query) continue;
      if (!queryStats.has(q.query)) queryStats.set(q.query, { current: [], previous: [] });
      queryStats.get(q.query)[bucket].push(q);
    }
  }

  const byFamily = Object.fromEntries(
    FAMILIES.map((f) => [f, { current: { clicks: 0, impressions: 0 }, previous: { clicks: 0, impressions: 0 }, queries: 0 }])
  );
  const local = [];
  for (const [query, stat] of queryStats) {
    const family = classifyQuery(query);
    const cur = sumMetrics(stat.current);
    const prev = sumMetrics(stat.previous);
    const f = byFamily[family];
    f.current.clicks += cur.clicks;
    f.current.impressions += cur.impressions;
    f.previous.clicks += prev.clicks;
    f.previous.impressions += prev.impressions;
    if (stat.current.length) f.queries += 1;
    if (family === "local") {
      local.push({
        query,
        impressions: cur.impressions,
        previousImpressions: prev.impressions,
        clicks: cur.clicks,
        position: cur.position,
        previousPosition: prev.position,
        deltaImpressions: cur.impressions - prev.impressions,
      });
    }
  }

  const risingLocal = local
    .filter((q) => q.deltaImpressions > 0)
    .sort((a, b) => b.deltaImpressions - a.deltaImpressions || a.query.localeCompare(b.query))
    .slice(0, 10);

  return {
    available: true,
    windowDays: days,
    current: { from: currentFrom, to: lastDate, ...current },
    previous: { from: previousFrom, to: shiftYmd(currentFrom, -1), daysWithData: previousDays, ...previous },
    change: {
      clicksPct: previousDays ? pctChange(current.clicks, previous.clicks) : null,
      impressionsPct: previousDays ? pctChange(current.impressions, previous.impressions) : null,
    },
    byFamily,
    familyNote: "Family sums cover the top 250 queries per day only; Google withholds rare queries, so they do not add up to the site total.",
    risingLocalQueries: risingLocal,
    lastDataDate: lastDate,
  };
}

/** Clicks/impressions now vs the previous window, by family, with rising local queries. */
async function searchSummary({ days = 28, store = getDefaultStore(), now = new Date() } = {}) {
  const today = nyDate(now);
  const rows = await store.findSnapshots({ source: SOURCE, from: shiftYmd(today, -(2 * days + 10)), to: today });
  const summary = computeSearchSummary(rows, { days });
  if (summary.available) summary.staleDays = daysBetween(summary.lastDataDate, today);
  return summary;
}

module.exports = {
  resolveSiteUrl,
  SOURCE,
  STATE_KEY,
  searchConsoleEnabled,
  searchConsoleConfig,
  parseServiceAccount,
  syncWindow,
  syncSearchConsole,
  computeSearchSummary,
  searchSummary,
};
