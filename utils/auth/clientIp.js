/**
 * The visitor's IP for abuse limits, in a way a visitor cannot fake.
 *
 * Production runs behind an AWS load balancer and nginx. X-Forwarded-For then
 * reads "<anything the client sent>, <real client>, <load balancer>": the
 * left-hand entries are whatever the client put in the header, and the LAST
 * entry is our own load balancer's private address. Taking the first entry lets
 * anyone send a new fake address with every request and never hit a limit;
 * taking the last puts every customer in one shared bucket, so one script could
 * lock everybody out. So we walk from the RIGHT, skip our own infrastructure
 * (private and loopback addresses), and take the first public address - the
 * one our load balancer appended.
 */
const net = require("net");

function isPrivate(ip) {
  if (!ip) return true;
  const v = ip.replace(/^::ffff:/, "");
  if (net.isIPv4(v)) {
    const [a, b] = v.split(".").map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0;
  }
  if (net.isIPv6(v)) return v === "::1" || /^f[cd]/i.test(v) || /^fe80/i.test(v);
  return true;
}

function clientIp(req) {
  const chain = String(req?.headers?.["x-forwarded-for"] || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => net.isIP(s.replace(/^::ffff:/, "")));
  const socket = req?.socket?.remoteAddress || req?.ip || "";
  const all = [...chain, socket];
  for (let i = all.length - 1; i >= 0; i--) if (!isPrivate(all[i])) return all[i].replace(/^::ffff:/, "");
  return socket.replace(/^::ffff:/, "") || "unknown";
}

module.exports = { clientIp, isPrivate };
