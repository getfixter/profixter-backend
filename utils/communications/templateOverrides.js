const CommunicationTemplate = require("../../models/CommunicationTemplate");
const { DEFINITIONS, buildTokenValues, renderTokenTemplate } = require("./smsTokens");

/**
 * The live override lookup, in memory, because rendering is synchronous.
 *
 * renderSms is called from inside template code, from the retry sweep and from
 * a dozen triggers, and it returns a string rather than a promise. Making it
 * async to read one small collection would mean touching every one of those
 * call sites and turning a pure function into an I/O operation - so instead the
 * overrides are held here and refreshed.
 *
 * FAILING TO THE DEFAULT IS THE WHOLE DESIGN.
 *
 * If the cache has never loaded, if the database is unreachable, if a row names
 * a type that no longer exists, or if an override throws while rendering, the
 * caller gets the tested code template. There is no state of this module in
 * which a message fails to render; the worst case is that an admin's edit is
 * not applied yet, which is visibly better than a customer receiving nothing.
 */

const CACHE_TTL_MS = 60 * 1000;

const cache = {
  /** channel -> templateKey -> body */
  sms: new Map(),
  loadedAt: 0,
  loading: null,
};

function isFresh() {
  return cache.loadedAt > 0 && Date.now() - cache.loadedAt < CACHE_TTL_MS;
}

/**
 * Pull active overrides into memory.
 *
 * Only SMS is read. Email rows may exist - the model allows them so the schema
 * does not need migrating later - but nothing consults them, which is what
 * "reserved" means here rather than "half-wired".
 */
async function refresh({ force = false, Model = CommunicationTemplate } = {}) {
  if (!force && isFresh()) return cache;
  if (cache.loading) return cache.loading;

  cache.loading = (async () => {
    try {
      const rows = await Model.find({ channel: "sms", active: true })
        .select("templateKey body")
        .lean();
      const next = new Map();
      for (const row of rows) {
        // A row for a type the code no longer has is dropped, not trusted.
        if (row.templateKey && DEFINITIONS[row.templateKey] && String(row.body || "").trim()) {
          next.set(row.templateKey, row.body);
        }
      }
      cache.sms = next;
      cache.loadedAt = Date.now();
    } catch (error) {
      /*
       * Keep whatever is already cached. A database blip must not silently
       * revert every customised message mid-shift; the previous snapshot is a
       * better answer than an empty one.
       */
      console.warn(
        JSON.stringify({
          event: "communication_override_refresh_failed",
          error: String(error?.message || "").slice(0, 200),
        })
      );
    } finally {
      cache.loading = null;
    }
    return cache;
  })();

  return cache.loading;
}

/** Drop the cache so the next render re-reads. Called after a save or reset. */
function invalidate() {
  cache.loadedAt = 0;
}

/** Set the cache directly. Tests use this; nothing in production does. */
function primeForTest(entries = {}) {
  cache.sms = new Map(Object.entries(entries));
  cache.loadedAt = Date.now();
}

function getSmsOverride(notificationType) {
  return cache.sms.get(notificationType) || "";
}

function hasSmsOverride(notificationType) {
  return cache.sms.has(notificationType);
}

/**
 * Render an SMS body through the override when one is in force.
 *
 * Returns null when there is nothing to apply, which is the signal for the
 * caller to use its own code template. Returning null rather than the default
 * keeps this module ignorant of what the default is, so the two cannot drift.
 */
function renderSmsOverride(notificationType, vars = {}) {
  if (!hasSmsOverride(notificationType)) return null;
  try {
    const values = buildTokenValues(notificationType, vars);
    const body = renderTokenTemplate(getSmsOverride(notificationType), values);
    return String(body || "").trim() ? body : null;
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "communication_override_render_failed",
        notificationType,
        error: String(error?.message || "").slice(0, 200),
      })
    );
    return null;
  }
}

/**
 * Start keeping the cache warm.
 *
 * An interval rather than a change stream: the data is a few dozen short rows,
 * a minute of staleness after an edit made on another instance is acceptable
 * for message wording, and the instance that made the edit invalidates its own
 * cache immediately.
 */
function startOverrideRefresh({ intervalMs = CACHE_TTL_MS } = {}) {
  refresh({ force: true }).catch(() => {});
  const timer = setInterval(() => {
    refresh({ force: true }).catch(() => {});
  }, intervalMs);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = {
  CACHE_TTL_MS,
  getSmsOverride,
  hasSmsOverride,
  invalidate,
  primeForTest,
  refresh,
  renderSmsOverride,
  startOverrideRefresh,
};
