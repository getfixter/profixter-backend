// Very simple in-memory limiter per email+IP.
// For production at scale use Redis.
const windowMs = 60 * 1000; // 1 minute
const max = 3;               // 3 requests per window
const buckets = new Map();

module.exports = function otpRateLimit(req, res, next) {
  const email = (req.body.email || "").toLowerCase();
  const key = `${req.ip}:${email}`;
  const now = Date.now();

  const entry = buckets.get(key) || { count: 0, reset: now + windowMs };
  if (now > entry.reset) {
    entry.count = 0;
    entry.reset = now + windowMs;
  }
  entry.count += 1;
  buckets.set(key, entry);

  if (entry.count > max) {
    return res.status(429).json({ message: "Too many requests. Try again shortly." });
  }
  next();
};
