/**
 * Everything the visibility collectors know, as one object for the Growth
 * Command Center:
 *
 *   { reviews, search, localRank, aiVisibility, collectors: [...] }
 *
 * DEGRADES, NEVER THROWS. Each part is computed independently with a time
 * limit; a part that cannot be produced becomes { available: false, reason }
 * ("disabled", "not configured: missing GSC_SITE_URL", "no_data",
 * "db_unavailable", "timeout", "error: ..."). The Command Center must render
 * with all four collectors switched off, which is the default.
 *
 * Data already collected is still shown after a collector is switched off
 * (it is history, and true); `collectors[].enabled` says it is no longer
 * being refreshed.
 */
const { reviewTrend } = require("./googleReviews");
const { searchSummary } = require("./searchConsole");
const { rankSummary } = require("./localRank");
const { aiVisibilitySummary } = require("./aiVisibility");
const { collectorStatuses } = require("./collectors");
const { sanitizeError } = require("./common");
const { getDefaultStore } = require("./store");

const PART_TIMEOUT_MS = 8000;

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Explain a "no data" result in terms of the collector's flag/credentials. */
function unavailableReason(result, status) {
  if (result?.available) return result;
  if (status && !status.enabled) return { available: false, reason: "disabled" };
  if (status && !status.configured) return { available: false, reason: `not configured: ${status.reason}` };
  if (status?.lastError) return { available: false, reason: result?.reason || "no_data", lastError: status.lastError };
  return { available: false, reason: result?.reason || "no_data" };
}

async function part(fn, status, timeoutMs) {
  try {
    const result = await withTimeout(Promise.resolve().then(fn), timeoutMs);
    return unavailableReason(result, status);
  } catch (error) {
    const msg = error?.message === "timeout" ? "timeout" : `error: ${sanitizeError(error?.message || String(error))}`;
    return { available: false, reason: msg };
  }
}

async function buildVisibilitySummary({
  store = getDefaultStore(),
  env = process.env,
  now = new Date(),
  reviewDays = 30,
  searchDays = 28,
  timeoutMs = PART_TIMEOUT_MS,
} = {}) {
  let dbUp = true;
  try {
    dbUp = store.available ? Boolean(store.available()) : true;
  } catch {
    dbUp = false;
  }

  let collectors;
  try {
    collectors = dbUp
      ? await withTimeout(collectorStatuses({ env, store }), timeoutMs)
      : await collectorStatuses({ env, store: { readState: async () => null } });
  } catch {
    collectors = await collectorStatuses({ env, store: { readState: async () => null } });
  }
  const byName = Object.fromEntries(collectors.map((c) => [c.name, c]));

  if (!dbUp) {
    const down = { available: false, reason: "db_unavailable" };
    return { generatedAt: now.toISOString(), reviews: down, search: down, localRank: down, aiVisibility: down, collectors };
  }

  const [reviews, search, localRank, aiVisibility] = await Promise.all([
    part(() => reviewTrend({ days: reviewDays, store, now }), byName.google_reviews, timeoutMs),
    part(() => searchSummary({ days: searchDays, store, now }), byName.search_console, timeoutMs),
    part(() => rankSummary({ store }), byName.local_rank, timeoutMs),
    part(() => aiVisibilitySummary({ store }), byName.ai_visibility, timeoutMs),
  ]);

  return { generatedAt: now.toISOString(), reviews, search, localRank, aiVisibility, collectors };
}

module.exports = { buildVisibilitySummary };
