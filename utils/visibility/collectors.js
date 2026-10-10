/**
 * The visibility collectors, and the one wrapper every scheduled run goes
 * through.
 *
 * WHY ONE WRAPPER. Each collector needs the same four guarantees, and they
 * are easy to get subtly wrong four times:
 *   1. OFF unless switched on. A collector runs only when its flag is on AND
 *      its credentials are present; otherwise it records why it did not run
 *      (the Command Center shows "not configured: missing GSC_SITE_URL",
 *      not silence).
 *   2. One instance at a time. The backend runs on one to four instances, all
 *      with the same crons, so a run first takes a Mongo lease (the shared
 *      utils/analytics/analyticsLease, one key per collector). Losing the
 *      lease means another instance is doing it: skip quietly.
 *   3. Status per collector in AnalyticsState ("visibility:status:<name>"):
 *      lastRunAt, lastSuccessAt, lastError, enabled, configured, reason,
 *      and a small lastResult. lastSuccessAt means DATA LANDED, so a
 *      local-rank run that only queued its tasks does not count until its
 *      results are collected.
 *   4. Never throws, never leaks. Errors are caught, sanitised (each
 *      collector names its secrets; common.sanitizeError also strips known
 *      token shapes) and stored; the cron keeps ticking.
 */
const reviews = require("./googleReviews");
const searchConsole = require("./searchConsole");
const localRank = require("./localRank");
const ai = require("./aiVisibility");
const { sanitizeError } = require("./common");
const { getDefaultStore } = require("./store");

const STATUS_PREFIX = "visibility:status:";
const LEASE_PREFIX = "visibility:lease:";

/*
 * name        status record the run reports to
 * enabled     the feature flag
 * config      { configured, reason, secrets }
 * run         the work; returns a small result object. `completed: false`
 *             means it ran fine but the data has not landed yet.
 * leaseMs     comfortably longer than a slow run; a crashed run's lease expires
 */
const COLLECTORS = {
  google_reviews: {
    status: "google_reviews",
    enabled: reviews.reviewsEnabled,
    config: reviews.reviewsConfig,
    run: (ctx) => reviews.snapshotGoogleReviews(ctx),
    leaseMs: 5 * 60 * 1000,
  },
  search_console: {
    status: "search_console",
    enabled: searchConsole.searchConsoleEnabled,
    config: searchConsole.searchConsoleConfig,
    run: (ctx) => searchConsole.syncSearchConsole(ctx),
    leaseMs: 15 * 60 * 1000,
  },
  local_rank: {
    status: "local_rank",
    enabled: localRank.localRankEnabled,
    config: localRank.localRankConfig,
    run: (ctx) => localRank.postLocalRankRun(ctx),
    leaseMs: 15 * 60 * 1000,
  },
  // Same status record as local_rank: this is the second half of that run.
  local_rank_collect: {
    status: "local_rank",
    enabled: localRank.localRankEnabled,
    config: localRank.localRankConfig,
    run: (ctx) => localRank.collectLocalRankResults(ctx),
    leaseMs: 10 * 60 * 1000,
    quietWhenIdle: true,
  },
  ai_visibility: {
    status: "ai_visibility",
    enabled: ai.aiVisibilityEnabled,
    config: ai.aiVisibilityConfig,
    run: (ctx) => ai.runAiVisibility(ctx),
    leaseMs: 60 * 60 * 1000,
  },
};

/** The four collectors the Command Center lists. */
const PUBLIC_COLLECTORS = ["google_reviews", "search_console", "local_rank", "ai_visibility"];

/** Deep-copy a small result with every string sanitised and size bounded. */
function sanitizeResult(value, secrets, depth = 0) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") return sanitizeError(value, secrets);
  if (typeof value !== "object") return value;
  if (depth > 3) return null;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitizeResult(v, secrets, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value).slice(0, 30)) out[k] = sanitizeResult(v, secrets, depth + 1);
  return out;
}

async function readStatus(store, name) {
  return (await store.readState(`${STATUS_PREFIX}${name}`)) || {};
}

async function writeStatus(store, name, patch) {
  const current = await readStatus(store, name);
  const next = { ...current, ...patch };
  await store.writeState(`${STATUS_PREFIX}${name}`, next);
  return next;
}

/**
 * Run one collector under its flag, credentials and lease. Never rejects.
 * Returns { ran, skipped?, reason?, result?, error? }.
 */
async function runCollector(name, { env = process.env, now = new Date(), store = getDefaultStore(), fetchImpl, log = console, ...extra } = {}) {
  const def = COLLECTORS[name];
  if (!def) return { ran: false, reason: `unknown collector ${name}` };
  let secrets = [];
  try {
    const enabled = Boolean(def.enabled(env));
    const config = def.config(env);
    secrets = config.secrets || [];
    if (!enabled || !config.configured) {
      const reason = !enabled ? "disabled" : config.reason;
      // The collect tick runs every 10 minutes; do not rewrite status that often.
      if (!def.quietWhenIdle) {
        await writeStatus(store, def.status, { enabled, configured: config.configured, reason, checkedAt: now.toISOString() });
      }
      return { ran: false, reason };
    }

    const leaseKey = `${LEASE_PREFIX}${name}`;
    if (!(await store.takeLease(leaseKey, def.leaseMs))) return { ran: false, skipped: true, reason: "lease_held" };
    try {
      const result = await def.run({ env, now, store, fetchImpl, log, ...extra });
      if (def.quietWhenIdle && result?.idle) return { ran: true, result };
      const patch = {
        enabled: true,
        configured: true,
        reason: null,
        lastRunAt: now.toISOString(),
        lastError: null,
        lastResult: sanitizeResult(result, secrets),
      };
      if (result?.completed !== false) patch.lastSuccessAt = now.toISOString();
      await writeStatus(store, def.status, patch);
      log.info?.(JSON.stringify({ event: "visibility_collector_succeeded", collector: name, result: patch.lastResult }));
      return { ran: true, result };
    } finally {
      await store.releaseLease(leaseKey).catch(() => {});
    }
  } catch (error) {
    const message = sanitizeError(error?.message || String(error), secrets);
    log.error?.(JSON.stringify({ event: "visibility_collector_failed", collector: name, error: message }));
    await writeStatus(store, def.status, {
      enabled: true,
      configured: true,
      lastRunAt: now.toISOString(),
      lastError: message,
      lastErrorAt: now.toISOString(),
    }).catch(() => {});
    return { ran: true, error: message };
  }
}

/**
 * Every public collector's status for the Command Center. Flag and
 * credential state are read live from the environment (so a just-set
 * variable shows at once); run history comes from the stored status.
 */
async function collectorStatuses({ env = process.env, store = getDefaultStore() } = {}) {
  const out = [];
  for (const name of PUBLIC_COLLECTORS) {
    const def = COLLECTORS[name];
    const enabled = Boolean(def.enabled(env));
    const config = def.config(env);
    let stored = {};
    try {
      stored = await readStatus(store, name);
    } catch {
      stored = {};
    }
    out.push({
      name,
      enabled,
      configured: config.configured,
      reason: !enabled ? "disabled" : config.configured ? null : config.reason,
      lastRunAt: stored.lastRunAt || null,
      lastSuccessAt: stored.lastSuccessAt || null,
      lastError: stored.lastError || null,
      lastErrorAt: stored.lastErrorAt || null,
    });
  }
  return out;
}

module.exports = { COLLECTORS, PUBLIC_COLLECTORS, STATUS_PREFIX, runCollector, collectorStatuses, sanitizeResult };
