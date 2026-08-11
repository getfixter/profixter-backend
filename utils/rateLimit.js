/**
 * Small in-process rate limiter.
 *
 * Deliberately dependency-free: the only endpoints that need limiting here are
 * the public signing routes, and adding a package for a fixed-window counter
 * would be more trusted surface than the counter itself.
 *
 * DESIGN NOTE - why the key is usually not the IP alone.
 * Customers sign from phones on carrier NAT and from shared home connections,
 * so an IP is frequently shared by people who have nothing to do with each
 * other. Limiting purely by IP would lock out a legitimate signer because a
 * stranger on the same carrier hit the endpoint. Where a signing token is
 * present it is the better key: it scopes the limit to one signing request,
 * which is the thing actually worth protecting. IP limits stay deliberately
 * loose and exist only to blunt broad scanning.
 *
 * Fixed windows, in memory. This is a single-instance environment; if that
 * changes, move the counters to a shared store rather than tightening these
 * numbers.
 */

/** windowMs -> Map(key -> { count, resetAt }) */
const buckets = new Map();

/** Stop the maps growing without bound on a long-lived process. */
function sweep(store, now) {
  for (const [key, entry] of store) {
    if (entry.resetAt <= now) store.delete(key);
  }
}

/**
 * Consume one unit against a key.
 * Returns { allowed, remaining, retryAfterSeconds }.
 */
function consume({ key, limit, windowMs, now = Date.now() }) {
  if (!buckets.has(windowMs)) buckets.set(windowMs, new Map());
  const store = buckets.get(windowMs);

  // Cheap amortised cleanup rather than a timer.
  if (store.size > 5000) sweep(store, now);

  const entry = store.get(key);
  if (!entry || entry.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
  }

  entry.count += 1;
  if (entry.count > limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    };
  }
  return { allowed: true, remaining: limit - entry.count, retryAfterSeconds: 0 };
}

/**
 * Express middleware.
 *
 * `keyResolver` decides what is being limited. Prefer a token-scoped key so a
 * shared IP cannot starve an unrelated signer.
 */
function rateLimit({ limit, windowMs, keyResolver, message = "Too many requests. Please try again shortly." }) {
  return function rateLimitMiddleware(req, res, next) {
    let key;
    try {
      key = keyResolver(req);
    } catch {
      key = null;
    }
    // No usable key means nothing to attribute the request to; let it through
    // rather than inventing a bucket that lumps unrelated callers together.
    if (!key) return next();

    const result = consume({ key, limit, windowMs });
    if (result.allowed) return next();

    res.set("Retry-After", String(result.retryAfterSeconds));
    return res.status(429).json({ message });
  };
}

/** Exposed for tests. */
function _reset() {
  buckets.clear();
}

module.exports = { rateLimit, consume, _reset };
