const AuthRateCounter = require("../../models/AuthRateCounter");

/**
 * Count one event against a fixed window, and say whether it is allowed.
 *
 * Shared by every server through the database, so scaling out does not raise
 * the limit. The window is part of the key, so a counter needs no reset job:
 * the next window simply starts a new row, and the TTL index clears old ones.
 */
async function hit(key, { limit, windowMs, now = Date.now(), Model = AuthRateCounter } = {}) {
  const windowIndex = Math.floor(now / windowMs);
  const windowEnd = (windowIndex + 1) * windowMs;
  const rowKey = `${key}:${windowMs}:${windowIndex}`;

  let row;
  try {
    row = await Model.findOneAndUpdate(
      { key: rowKey },
      { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(windowEnd) } },
      { upsert: true, new: true }
    ).lean();
  } catch (error) {
    // Two first hits raced the upsert; the row exists now, so count again.
    if (error?.code !== 11000) throw error;
    row = await Model.findOneAndUpdate({ key: rowKey }, { $inc: { count: 1 } }, { new: true }).lean();
  }

  const allowed = row.count <= limit;
  return { allowed, count: row.count, retryAfterSeconds: allowed ? 0 : Math.ceil((windowEnd - now) / 1000) };
}

/** Check several limits; the first refusal wins, and every limit is counted. */
async function hitAll(rules, options = {}) {
  let refused = null;
  for (const rule of rules) {
    const result = await hit(rule.key, { ...options, limit: rule.limit, windowMs: rule.windowMs });
    if (!result.allowed && !refused) refused = { ...result, rule: rule.name || rule.key };
  }
  return refused || { allowed: true, retryAfterSeconds: 0 };
}

module.exports = { hit, hitAll };
