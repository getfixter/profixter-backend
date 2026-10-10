/**
 * Meta ad spend, mirrored from the Marketing API Insights endpoint into
 * AdSpendDaily so the Admin Overview can show spend, cost per customer and
 * ROAS without ever calling Meta on a request.
 *
 * WHAT IS READ. Daily insights for the configured ad account:
 * - level=ad, time_increment=1: spend, impressions, clicks, reach and a few
 *   actions per ad per day, with the campaign and ad set ids and names. The
 *   Overview matches these to customers by the Meta ids the ads put in their
 *   URLs (utm_campaign / utm_term / utm_content, or campaign_id / adset_id /
 *   ad_id), see utils/analytics/attribution.js.
 * - level=account, breakdowns=publisher_platform: the same days split into
 *   Facebook / Instagram / Audience Network / Messenger, which is what the
 *   ads write into utm_source ({{site_source_name}}), so the Overview's
 *   Facebook and Instagram rows can carry their own spend.
 *
 * WHEN. The first successful run backfills the last 90 days; every later run
 * re-reads the last three days (Meta restates recent days as late
 * conversions and invalid-click credits arrive), reaching further back only
 * to catch up after a failure. Every six hours, plus once shortly after boot,
 * and on demand from the Admin. One instance at a time (the AnalyticsState
 * lease shared with the revenue ledger sync).
 *
 * WHICH TOKEN. META_ADS_ACCESS_TOKEN, else the Conversions API token
 * (META_CAPI_TOKEN, then FB_ACCESS_TOKEN - the same precedence as
 * utils/metaCapi.js). Whatever it is needs ads_read on the ad account; a
 * token that only has the pixel is classified as "token_missing_ads_read".
 * The token is never logged, never stored and never returned: errors are
 * sanitised before they reach the status record.
 *
 * NEVER THROWS ON A SCHEDULE. A failed run records why in the status and the
 * next run tries again; the Overview keeps showing what was mirrored.
 */
const { GRAPH_VERSION, getToken: getCapiToken } = require("../metaCapi");
const lease = require("./analyticsLease");

const GRAPH_HOST = "graph.facebook.com";
const STATE_KEY = "meta-ad-spend";
const LEASE_KEY = "meta-ad-spend-lease";
const LEASE_MS = 20 * 60 * 1000;
const INTERVAL_MS = 6 * 60 * 60 * 1000;
const BOOT_DELAY_MS = 2 * 60 * 1000;
const BACKFILL_DAYS = 90;
const RESTATE_DAYS = 3;
const CHUNK_DAYS = 30; // keeps each insights request well inside Meta's "too much data" limit
const PAGE_LIMIT = 500;
const MAX_PAGES = 400;
const MAX_ATTEMPTS = 4;
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TZ = "America/New_York";

const AD_FIELDS = [
  "campaign_id",
  "campaign_name",
  "adset_id",
  "adset_name",
  "ad_id",
  "ad_name",
  "spend",
  "impressions",
  "clicks",
  "reach",
  "actions",
  "account_currency",
];
const PLATFORM_FIELDS = ["spend", "impressions", "clicks", "reach", "actions", "account_currency"];

/*
 * The platform-reported actions worth keeping. Keys are stored without dots
 * (Mongo field names), so the pixel events get short names.
 */
const ACTION_KEYS = {
  link_click: "link_click",
  landing_page_view: "landing_page_view",
  lead: "lead",
  complete_registration: "complete_registration",
  "offsite_conversion.fb_pixel_lead": "pixel_lead",
  "offsite_conversion.fb_pixel_complete_registration": "pixel_complete_registration",
  "offsite_conversion.fb_pixel_purchase": "pixel_purchase",
};

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

/** The ad account id without its "act_" prefix, or null when unset or malformed. */
function configuredAccountId(env = process.env) {
  const raw = String(env.META_ADS_ACCOUNT_ID || "").trim().replace(/^act_/i, "");
  return /^\d{5,25}$/.test(raw) ? raw : null;
}

/** The token and where it came from. Never logged. */
function resolveToken(env = process.env) {
  if (env.META_ADS_ACCESS_TOKEN) return { token: env.META_ADS_ACCESS_TOKEN, source: "META_ADS_ACCESS_TOKEN" };
  const token = env === process.env ? getCapiToken() : env.META_CAPI_TOKEN || env.FB_ACCESS_TOKEN || "";
  if (!token) return { token: "", source: null };
  return { token, source: env.META_CAPI_TOKEN ? "META_CAPI_TOKEN" : "FB_ACCESS_TOKEN" };
}

/*
 * On when explicitly enabled, or automatically when a dedicated read-only
 * reporting token (META_ADS_ACCESS_TOKEN, ads_read) has been provided - the
 * token IS the owner's decision to connect reporting. META_ADS_SYNC_ENABLED
 * "false" always wins.
 */
const syncEnabled = (env = process.env) =>
  env.META_ADS_SYNC_ENABLED === "true" || (env.META_ADS_SYNC_ENABLED !== "false" && Boolean(env.META_ADS_ACCESS_TOKEN));

/** The ad account to read: configured, else the one discovered (and remembered) from the token. */
async function resolveAccountId({ env, prev, token, fetchImpl }) {
  const configured = configuredAccountId(env);
  if (configured) return configured;
  if (prev?.discoveredAccountId) return prev.discoveredAccountId;
  if (!token || !fetchImpl) return null;
  const u = new URL(`https://${GRAPH_HOST}/${GRAPH_VERSION}/me/adaccounts`);
  u.searchParams.set("fields", "account_id,name,account_status");
  u.searchParams.set("limit", "25");
  const body = await graphGet(u.toString(), { token, fetchImpl });
  const accounts = Array.isArray(body.data) ? body.data : [];
  // Prefer an active account (account_status 1); refuse to guess between several.
  const active = accounts.filter((a) => Number(a.account_status) === 1);
  const pick = active.length === 1 ? active[0] : accounts.length === 1 ? accounts[0] : null;
  return pick ? String(pick.account_id || pick.id).replace(/^act_/, "") : null;
}

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

/* ISO 4217 currencies with no minor unit: "cents" are whole units there. */
const ZERO_DECIMAL = new Set(["BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);

/**
 * Meta's spend is a decimal string ("12.34", "0.5", "1234"). Integer minor
 * units, without ever going through a float: "0.29" * 100 is 28.999999999999996.
 * Half-up on the third decimal. Anything unreadable or negative is null.
 */
function toMinorUnits(value, currency = "USD") {
  if (value === null || value === undefined || value === "") return null;
  const text = typeof value === "number" ? (Number.isFinite(value) ? value.toFixed(6) : "") : String(value).trim();
  const m = /^(\d+)(?:\.(\d*))?$/.exec(text);
  if (!m) return null;
  const digits = ZERO_DECIMAL.has(String(currency || "").toUpperCase()) ? 0 : 2;
  const whole = Number(m[1]);
  const frac = (m[2] || "").padEnd(digits + 1, "0");
  let minor = whole * 10 ** digits + (digits ? Number(frac.slice(0, digits)) : 0);
  if (Number(frac[digits]) >= 5) minor += 1;
  return Number.isSafeInteger(minor) ? minor : null;
}

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}

function pickActions(list) {
  const out = {};
  for (const a of Array.isArray(list) ? list : []) {
    const key = ACTION_KEYS[a?.action_type];
    if (!key) continue;
    out[key] = (out[key] || 0) + toInt(a.value);
  }
  return out;
}

const ymdFormatters = new Map();
function ymdIn(timeZone, date) {
  const tz = timeZone || DEFAULT_TZ;
  if (!ymdFormatters.has(tz)) {
    let fmt;
    try {
      fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    } catch {
      fmt = new Intl.DateTimeFormat("en-CA", { timeZone: DEFAULT_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
    }
    ymdFormatters.set(tz, fmt);
  }
  return ymdFormatters.get(tz).format(date);
}

function shiftYmd(ymd, days) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

const minYmd = (a, b) => (a <= b ? a : b);
const maxYmd = (a, b) => (a >= b ? a : b);

/**
 * The days to read on this run: the 90-day backfill the first time, then the
 * last three days, or further back to the last day already synced if runs
 * have been failing (never beyond the backfill horizon).
 */
function syncWindow(state, today) {
  const horizon = shiftYmd(today, -(BACKFILL_DAYS - 1));
  if (!state?.lastSuccessAt || !state?.syncedThroughYmd) return { since: horizon, until: today, backfill: true };
  const from = shiftYmd(minYmd(state.syncedThroughYmd, today), -(RESTATE_DAYS - 1));
  return { since: maxYmd(horizon, from), until: today, backfill: false };
}

/** [since, until] in chunks of at most CHUNK_DAYS days, oldest first. */
function chunkWindow(since, until, size = CHUNK_DAYS) {
  const chunks = [];
  let start = since;
  while (start <= until) {
    const end = minYmd(shiftYmd(start, size - 1), until);
    chunks.push({ since: start, until: end });
    start = shiftYmd(end, 1);
  }
  return chunks;
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/* Failures that mean the token cannot read the account: the Overview stops showing spend as current. */
const AUTH_REASONS = new Set(["token_invalid", "token_missing_ads_read", "token_missing", "not_configured"]);

const RATE_LIMIT_CODES =new Set([4, 17, 32, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006, 80008, 80009, 80014]);

/** Remove anything token-like from a message before it is stored or logged. */
function sanitize(message, token) {
  let text = String(message || "").slice(0, 2000);
  if (token) text = text.split(token).join("[redacted]");
  text = text
    .replace(/access_token=[^&\s"']+/gi, "access_token=[redacted]")
    .replace(/(Bearer|OAuth)\s+[A-Za-z0-9._-]+/g, "$1 [redacted]")
    .replace(/\bEA[A-Za-z0-9]{20,}\b/g, "[redacted]");
  return text.slice(0, 300);
}

/**
 * What a Graph API failure means for the sync.
 * - transient (retry with backoff): network failures, 5xx, Meta's "temporary"
 *   errors, and the rate limits.
 * - permanent: the token is invalid or expired (190), lacks ads_read on the
 *   account (10, 200-299, or 100 / subcode 33 "missing permissions"), the API
 *   version is retired, or the request itself is wrong.
 */
function classifyGraphError({ httpStatus = 0, error = null, network = false } = {}) {
  if (network) return { reason: "network_error", transient: true };
  const code = Number(error?.code);
  const subcode = Number(error?.error_subcode);
  const msg = String(error?.message || "");
  if (RATE_LIMIT_CODES.has(code) || httpStatus === 429) return { reason: "rate_limited", transient: true };
  if (code === 190 || code === 102 || code === 463 || code === 467) return { reason: "token_invalid", transient: false };
  if (code === 10 || code === 294 || (code >= 200 && code <= 299)) return { reason: "token_missing_ads_read", transient: false };
  if (code === 100 && (subcode === 33 || /ads_read|ads_management|permission/i.test(msg))) return { reason: "token_missing_ads_read", transient: false };
  if (code === 2635 || code === 12) return { reason: "api_version_deprecated", transient: false };
  if (code === 1 || code === 2 || error?.is_transient === true || httpStatus >= 500) return { reason: "meta_unavailable", transient: true };
  if (code === 100) return { reason: "bad_request", transient: false };
  return { reason: "error", transient: false };
}

class MetaApiError extends Error {
  constructor({ reason, transient, httpStatus, code, subcode, message }) {
    super(message);
    this.name = "MetaApiError";
    this.reason = reason;
    this.transient = transient;
    this.httpStatus = httpStatus || null;
    this.code = Number.isFinite(code) ? code : null;
    this.subcode = Number.isFinite(subcode) ? subcode : null;
  }
}

/* ------------------------------------------------------------------ */
/* Graph client                                                        */
/* ------------------------------------------------------------------ */

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function backoffMs(attempt, reason) {
  const base = reason === "rate_limited" ? 15000 : 2000;
  return Math.min(base * 2 ** (attempt - 1), 120000);
}

/**
 * GET one Graph URL, retrying transient failures (bounded). The token goes in
 * the query string, as Graph documents; it is stripped from every error.
 * Only graph.facebook.com is ever called, so a pagination URL can never send
 * the token anywhere else.
 */
async function graphGet(url, { token, fetchImpl, sleep = defaultSleep, maxAttempts = MAX_ATTEMPTS }) {
  const target = new URL(url);
  if (target.protocol !== "https:" || target.hostname !== GRAPH_HOST) {
    throw new MetaApiError({ reason: "error", transient: false, message: "Refusing to call a non-Graph URL" });
  }
  target.searchParams.set("access_token", token);
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(target.toString(), { method: "GET", headers: { Accept: "application/json" } });
    } catch (error) {
      const c = classifyGraphError({ network: true });
      lastError = new MetaApiError({ ...c, message: sanitize(`Network error: ${error?.message || error}`, token) });
    }
    if (response) {
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (response.ok && body && !body.error) return body;
      const err = body?.error || null;
      const c = classifyGraphError({ httpStatus: response.status, error: err });
      lastError = new MetaApiError({
        ...c,
        httpStatus: response.status,
        code: Number(err?.code),
        subcode: Number(err?.error_subcode),
        message: sanitize(err ? `Meta API ${err.code || response.status}${err.error_subcode ? `/${err.error_subcode}` : ""}: ${err.message || "error"}` : `Meta API HTTP ${response.status}`, token),
      });
    }
    if (!lastError.transient || attempt === maxAttempts) throw lastError;
    await sleep(backoffMs(attempt, lastError.reason));
  }
  throw lastError;
}

/** Every row of an insights query, following paging.next. */
async function fetchAllPages(firstUrl, ctx) {
  const rows = [];
  let url = firstUrl;
  for (let page = 0; url && page < MAX_PAGES; page += 1) {
    const body = await graphGet(url, ctx);
    for (const r of Array.isArray(body.data) ? body.data : []) rows.push(r);
    url = body.paging?.next || null;
  }
  if (url) throw new MetaApiError({ reason: "error", transient: false, message: `Insights paging exceeded ${MAX_PAGES} pages` });
  return rows;
}

function insightsUrl(accountId, params) {
  const u = new URL(`https://${GRAPH_HOST}/${GRAPH_VERSION}/act_${accountId}/insights`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, typeof v === "string" ? v : JSON.stringify(v));
  return u.toString();
}

async function fetchAccount(accountId, ctx) {
  const u = new URL(`https://${GRAPH_HOST}/${GRAPH_VERSION}/act_${accountId}`);
  u.searchParams.set("fields", "name,currency,timezone_name,account_status");
  return graphGet(u.toString(), ctx);
}

function fetchAdInsights(accountId, { since, until }, ctx) {
  return fetchAllPages(
    insightsUrl(accountId, {
      level: "ad",
      time_increment: "1",
      time_range: { since, until },
      fields: AD_FIELDS.join(","),
      limit: String(PAGE_LIMIT),
    }),
    ctx
  );
}

function fetchPlatformInsights(accountId, { since, until }, ctx) {
  return fetchAllPages(
    insightsUrl(accountId, {
      level: "account",
      time_increment: "1",
      time_range: { since, until },
      breakdowns: "publisher_platform",
      fields: PLATFORM_FIELDS.join(","),
      limit: String(PAGE_LIMIT),
    }),
    ctx
  );
}

/* ------------------------------------------------------------------ */
/* Rows                                                                */
/* ------------------------------------------------------------------ */

const clip = (v, max = 300) => (v === undefined || v === null || v === "" ? null : String(v).slice(0, max));

function adRow(r, { accountId, currency, fetchedAt }) {
  const cur = r.account_currency || currency || null;
  return {
    platform: "meta",
    accountId,
    date: String(r.date_start),
    level: "ad",
    entityId: String(r.ad_id),
    campaignId: clip(r.campaign_id, 40),
    campaignName: clip(r.campaign_name),
    adsetId: clip(r.adset_id, 40),
    adsetName: clip(r.adset_name),
    adId: clip(r.ad_id, 40),
    adName: clip(r.ad_name),
    publisherPlatform: null,
    spendCents: toMinorUnits(r.spend, cur) ?? 0,
    impressions: toInt(r.impressions),
    clicks: toInt(r.clicks),
    reach: toInt(r.reach),
    actions: pickActions(r.actions),
    currency: cur,
    fetchedAt,
  };
}

function platformRow(r, { accountId, currency, fetchedAt }) {
  const cur = r.account_currency || currency || null;
  const platform = String(r.publisher_platform || "unknown").toLowerCase().slice(0, 40);
  return {
    platform: "meta",
    accountId,
    date: String(r.date_start),
    level: "platform",
    entityId: platform,
    campaignId: null,
    campaignName: null,
    adsetId: null,
    adsetName: null,
    adId: null,
    adName: null,
    publisherPlatform: platform,
    spendCents: toMinorUnits(r.spend, cur) ?? 0,
    impressions: toInt(r.impressions),
    clicks: toInt(r.clicks),
    reach: toInt(r.reach),
    actions: pickActions(r.actions),
    currency: cur,
    fetchedAt,
  };
}

const validDay = (r) => /^\d{4}-\d{2}-\d{2}$/.test(String(r.date_start || ""));

/*
 * Upserts keyed by the natural key, so a re-read updates in place. If two
 * writers race on a new row, the loser's insert hits the unique index and the
 * retry finds the row and updates it (the same pattern as the revenue ledger).
 */
async function upsertRows(AdSpendDaily, rows) {
  if (!rows.length) return 0;
  const ops = rows.map((row) => ({
    updateOne: {
      filter: { platform: row.platform, accountId: row.accountId, date: row.date, level: row.level, entityId: row.entityId },
      update: { $set: row },
      upsert: true,
    },
  }));
  let written = 0;
  for (let i = 0; i < ops.length; i += 500) {
    const slice = ops.slice(i, i + 500);
    try {
      await AdSpendDaily.bulkWrite(slice, { ordered: false });
    } catch (error) {
      const writeErrors = error?.writeErrors || error?.result?.result?.writeErrors || [];
      const dupOnly = error?.code === 11000 || (writeErrors.length && writeErrors.every((e) => (e.code ?? e.err?.code) === 11000));
      if (!dupOnly) throw error;
      await AdSpendDaily.bulkWrite(slice, { ordered: false });
    }
    written += slice.length;
  }
  return written;
}

/*
 * A day Meta re-reports without a row it had before (spend credited back to
 * zero, an ad deleted) must lose that row too. After a window was read in
 * full, rows of that level in that window not touched by this run are removed.
 */
async function removeUnseen(AdSpendDaily, { accountId, level, since, until, fetchedAt }) {
  const res = await AdSpendDaily.deleteMany({ platform: "meta", accountId, level, date: { $gte: since, $lte: until }, fetchedAt: { $lt: fetchedAt } });
  return res?.deletedCount || 0;
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

async function readState() {
  const AnalyticsState = require("../../models/AnalyticsState");
  const doc = await AnalyticsState.findOne({ key: STATE_KEY }).lean();
  return doc?.value || {};
}

async function writeState(value) {
  const AnalyticsState = require("../../models/AnalyticsState");
  await AnalyticsState.updateOne({ key: STATE_KEY }, { $set: { value } }, { upsert: true });
}

/* ------------------------------------------------------------------ */
/* Sync                                                                */
/* ------------------------------------------------------------------ */

let inFlight = null;
let defaultFetch = typeof fetch === "function" ? fetch : null;

/** Tests swap in a fake fetch. */
function setFetch(next) {
  defaultFetch = next || (typeof fetch === "function" ? fetch : null);
}

/**
 * One sync run. Resolves to { skipped } when another instance holds the
 * lease, otherwise to the status it wrote. Never rejects.
 */
function syncMetaAdSpend({ now = new Date(), env = process.env, fetchImpl, sleep } = {}) {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const { token } = resolveToken(env);
    const prev = await readState();
    const runAt = new Date(now);
    let accountId = null;
    try {
      accountId = await resolveAccountId({ env, prev, token, fetchImpl: fetchImpl || defaultFetch });
    } catch (error) {
      const c = error instanceof MetaApiError ? error.reason : "error";
      const value = { ...prev, lastRunAt: runAt, lastFailureAt: runAt, lastError: sanitize(error.message, token), reason: c, connected: AUTH_REASONS.has(c) ? false : !!prev.connected };
      await writeState(value);
      return value;
    }

    if (!accountId || !token) {
      const value = {
        ...prev,
        lastRunAt: runAt,
        lastError: null,
        connected: false,
        reason: !token ? "token_missing" : "not_configured",
        ...(token && !accountId ? { lastError: "No single active ad account visible to the token; set META_ADS_ACCOUNT_ID" } : {}),
      };
      await writeState(value);
      return value;
    }

    const doFetch = fetchImpl || defaultFetch;
    if (!doFetch) {
      const value = { ...prev, lastRunAt: runAt, lastError: "fetch is unavailable in this runtime", reason: "error" };
      await writeState(value);
      return value;
    }

    if (!(await lease.takeLease(LEASE_KEY, LEASE_MS))) return { skipped: true };
    let rowsUpserted = 0;
    let rowsRemoved = 0;
    try {
      const AdSpendDaily = require("../../models/AdSpendDaily");
      await AdSpendDaily.init(); // the unique index exists before the first write
      const ctx = { token, fetchImpl: doFetch, sleep: sleep || defaultSleep };
      const account = await fetchAccount(accountId, ctx);
      if (!configuredAccountId(env)) prev.discoveredAccountId = accountId;
      const currency = account?.currency || prev.accountCurrency || null;
      const timezone = account?.timezone_name || prev.accountTimezone || DEFAULT_TZ;
      const today = ymdIn(timezone, runAt);
      const window = syncWindow(prev, today);
      // Every row written by this run carries the run's time, so unseen rows can be told apart.
      const fetchedAt = new Date(Math.max(Date.now(), runAt.getTime()));
      const rowCtx = { accountId, currency, fetchedAt };

      for (const chunk of chunkWindow(window.since, window.until)) {
        const ads = (await fetchAdInsights(accountId, chunk, ctx)).filter((r) => validDay(r) && r.ad_id);
        rowsUpserted += await upsertRows(AdSpendDaily, ads.map((r) => adRow(r, rowCtx)));
        rowsRemoved += await removeUnseen(AdSpendDaily, { accountId, level: "ad", ...chunk, fetchedAt });

        const platforms = (await fetchPlatformInsights(accountId, chunk, ctx)).filter(validDay);
        rowsUpserted += await upsertRows(AdSpendDaily, platforms.map((r) => platformRow(r, rowCtx)));
        rowsRemoved += await removeUnseen(AdSpendDaily, { accountId, level: "platform", ...chunk, fetchedAt });
      }

      const value = {
        connected: true,
        reason: "ok",
        accountId,
        discoveredAccountId: configuredAccountId(env) ? null : accountId,
        accountName: clip(account?.name, 120),
        accountCurrency: currency,
        accountTimezone: timezone,
        timezoneMatchesOverview: timezone === DEFAULT_TZ,
        lastRunAt: runAt,
        lastSuccessAt: new Date(),
        lastError: null,
        lastErrorCode: null,
        rowsUpserted,
        rowsRemoved,
        backfilledAt: prev.backfilledAt || new Date(),
        coverageFromYmd: prev.coverageFromYmd && prev.accountId === accountId ? minYmd(prev.coverageFromYmd, window.since) : window.since,
        syncedThroughYmd: window.until,
        lastWindow: { since: window.since, until: window.until },
        graphVersion: GRAPH_VERSION,
      };
      await writeState(value);
      return value;
    } catch (error) {
      const known = error instanceof MetaApiError;
      const reason = known ? error.reason : "error";
      const value = {
        ...prev,
        // A token that can no longer read the account cannot be trusted for recent days either.
        connected: AUTH_REASONS.has(reason) ? false : !!prev.connected,
        reason,
        lastRunAt: runAt,
        lastFailureAt: new Date(),
        lastError: sanitize(error?.message || String(error), token),
        lastErrorCode: known ? error.code : null,
        rowsUpserted,
        rowsRemoved,
      };
      await writeState(value).catch(() => {});
      return value;
    } finally {
      await lease.releaseLease(LEASE_KEY).catch(() => {});
    }
  })()
    .catch((error) => {
      // State reads/writes failed (Mongo down): report, never reject.
      console.warn("Meta ad spend sync failed:", sanitize(error?.message, resolveToken(env).token));
      return { reason: "error", lastError: "Ad spend sync could not reach the database." };
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

function kickSync() {
  if (!syncEnabled()) return;
  syncMetaAdSpend().then((result) => {
    if (result && !result.skipped && result.reason && result.reason !== "ok") {
      console.warn(`Meta ad spend sync: ${result.reason}${result.lastError ? ` - ${result.lastError}` : ""}`);
    }
  });
}

/**
 * Boot: once ~2 minutes after start, then every six hours. A no-op (returns
 * false) unless META_ADS_SYNC_ENABLED is "true" and META_ADS_ACCOUNT_ID is set.
 */
function startMetaAdSpendSync() {
  // Timers always register; each tick checks syncEnabled(), so a reporting
  // token added later (Parameter Store refreshes every 30 minutes) starts the
  // sync without a restart.
  if (process.env.NODE_ENV === "test") return false;
  setTimeout(kickSync, BOOT_DELAY_MS).unref?.();
  setInterval(kickSync, INTERVAL_MS).unref?.();
  return true;
}

/* ------------------------------------------------------------------ */
/* Reading, for the Overview and the Admin                             */
/* ------------------------------------------------------------------ */

function statusReason(state, env = process.env) {
  if (!configuredAccountId(env) && !state.discoveredAccountId && !resolveToken(env).token) return "not_configured";
  if (state.reason) return state.reason;
  if (!resolveToken(env).token) return "token_missing";
  return syncEnabled(env) ? "never_run" : "disabled";
}

/** The status record for the Admin endpoint: configuration and the last runs, never the token. */
async function adSpendStatus({ env = process.env } = {}) {
  const state = await readState();
  const tok = resolveToken(env);
  return {
    enabled: syncEnabled(env),
    accountId: configuredAccountId(env) || state.discoveredAccountId || null,
    tokenPresent: !!tok.token,
    tokenSource: tok.source,
    graphVersion: GRAPH_VERSION,
    connected: !!state.connected && !!state.lastSuccessAt,
    reason: statusReason(state, env),
    lastRunAt: state.lastRunAt || null,
    lastSuccessAt: state.lastSuccessAt || null,
    lastFailureAt: state.lastFailureAt || null,
    lastError: state.lastError || null,
    lastErrorCode: state.lastErrorCode ?? null,
    rowsUpserted: state.rowsUpserted ?? null,
    rowsRemoved: state.rowsRemoved ?? null,
    accountName: state.accountName || null,
    accountCurrency: state.accountCurrency || null,
    accountTimezone: state.accountTimezone || null,
    timezoneMatchesOverview: state.timezoneMatchesOverview ?? null,
    coverageFromYmd: state.coverageFromYmd || null,
    syncedThroughYmd: state.syncedThroughYmd || null,
    stale: state.lastSuccessAt ? Date.now() - new Date(state.lastSuccessAt).getTime() > STALE_AFTER_MS : null,
  };
}

/**
 * Spend for the inclusive days [fromYmd, toYmd], aggregated for the Overview.
 * Never throws: an error reads as "not connected" with the reason.
 *
 * Returns { connected, status, lastSuccessAt, totalCents, currency, stale,
 * partial, coverageFromYmd, platformSplit, byPlatform, campaigns } where
 * campaigns is Map(campaignId -> { id, name, spendCents, adsets: Map(adsetId ->
 * { id, name, spendCents, ads: Map(adId -> { id, name, spendCents }) }) }).
 */
async function adSpendForPeriod({ fromYmd, toYmd, env = process.env } = {}) {
  const off = (status, extra = {}) => ({
    connected: false,
    status,
    lastSuccessAt: null,
    totalCents: null,
    currency: null,
    stale: false,
    partial: false,
    coverageFromYmd: null,
    platformSplit: false,
    byPlatform: {},
    campaigns: new Map(),
    ...extra,
  });
  try {
    const state = await readState();
    const reason = statusReason(state, env);
    if (!state.connected || !state.lastSuccessAt) return off(reason, { lastSuccessAt: state.lastSuccessAt || null, currency: state.accountCurrency || null });
    const AdSpendDaily = require("../../models/AdSpendDaily");
    const accountId = configuredAccountId(env) || state.accountId || null;
    const docs = await AdSpendDaily.find({ platform: "meta", ...(accountId ? { accountId } : {}), date: { $gte: fromYmd, $lte: toYmd } })
      .select("level entityId campaignId campaignName adsetId adsetName adId adName publisherPlatform spendCents currency date")
      .lean();
    let totalCents = 0;
    const byPlatform = {};
    let platformRows = 0;
    const campaigns = new Map();
    const node = (map, id, name) => {
      if (!map.has(id)) map.set(id, { id, name: name || null, spendCents: 0 });
      const n = map.get(id);
      n.name ||= name || null;
      return n;
    };
    for (const d of docs) {
      const cents = Number(d.spendCents || 0);
      if (d.level === "platform") {
        platformRows += 1;
        byPlatform[d.entityId] = (byPlatform[d.entityId] || 0) + cents;
        continue;
      }
      totalCents += cents;
      const campId = d.campaignId || "unknown";
      const camp = node(campaigns, campId, d.campaignName);
      camp.adsets ||= new Map();
      camp.spendCents += cents;
      const adset = node(camp.adsets, d.adsetId || "unknown", d.adsetName);
      adset.ads ||= new Map();
      adset.spendCents += cents;
      node(adset.ads, d.adId || d.entityId, d.adName).spendCents += cents;
    }
    const lastSuccessAt = state.lastSuccessAt;
    return {
      connected: true,
      status: reason,
      lastSuccessAt,
      totalCents,
      currency: state.accountCurrency || docs.find((d) => d.currency)?.currency || null,
      stale: Date.now() - new Date(lastSuccessAt).getTime() > STALE_AFTER_MS,
      // The window starts before the first day ever synced: spend is missing for its early days.
      partial: !!state.coverageFromYmd && fromYmd < state.coverageFromYmd,
      coverageFromYmd: state.coverageFromYmd || null,
      platformSplit: platformRows > 0,
      byPlatform,
      campaigns,
    };
  } catch (error) {
    console.warn("Overview ad spend read failed:", error.message);
    return off("error");
  }
}

module.exports = {
  GRAPH_VERSION,
  STATE_KEY,
  LEASE_KEY,
  BACKFILL_DAYS,
  RESTATE_DAYS,
  configuredAccountId,
  resolveToken,
  syncEnabled,
  toMinorUnits,
  pickActions,
  syncWindow,
  chunkWindow,
  classifyGraphError,
  sanitize,
  graphGet,
  MetaApiError,
  syncMetaAdSpend,
  startMetaAdSpendSync,
  adSpendStatus,
  adSpendForPeriod,
  setFetch,
};
