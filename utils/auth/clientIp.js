/**
 * The caller's IP, for abuse limits.
 *
 * Production sits behind AWS's load balancer, which APPENDS the real client
 * address to X-Forwarded-For. Everything before that last entry was supplied
 * by the client and can be anything, so trusting the first entry would let
 * anyone mint a fresh "IP" per request and walk through every per-IP limit.
 */
function clientIp(req) {
  const hops = String(req?.headers?.["x-forwarded-for"] || "")
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean);
  return hops[hops.length - 1] || req?.ip || "";
}

module.exports = { clientIp };
