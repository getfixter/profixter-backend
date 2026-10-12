/**
 * Time-limited links to private Shower Studio photos.
 *
 * A link is /api/studio/photos/<publicId>?exp=<unix>&sig=<hmac>. The HMAC binds
 * the photo id and the expiry, so a link cannot be extended, moved to another
 * photo, or guessed. Links expire after STUDIO_LINK_TTL_SECONDS (15 minutes).
 */
const crypto = require("crypto");

const TTL = Number(process.env.STUDIO_LINK_TTL_SECONDS || 15 * 60);

let announced = false;
/** Which key signs photo links - never the key itself. */
function secretSource() {
  if (process.env.STUDIO_LINK_SECRET) return process.env.STUDIO_LINK_SECRET.length >= 32 ? "dedicated" : "dedicated-too-short";
  return process.env.JWT_SECRET ? "derived-from-jwt-secret" : "missing";
}
function secret() {
  const source = secretSource();
  if (!announced) { announced = true; console.log(JSON.stringify({ event: "studio_link_secret", source })); }
  if (source === "missing") throw new Error("STUDIO_LINK_SECRET (or JWT_SECRET) is required for private photo links");
  if (source === "dedicated-too-short") throw new Error("STUDIO_LINK_SECRET must be at least 32 characters");
  const s = process.env.STUDIO_LINK_SECRET || `studio-links:${process.env.JWT_SECRET}`;
  return crypto.createHash("sha256").update(s).digest();
}

function sign(publicId, exp) {
  return crypto.createHmac("sha256", secret()).update(`${publicId}.${exp}`).digest("base64url");
}

function photoUrl(publicId, { ttl = TTL, base = "" } = {}) {
  const exp = Math.floor(Date.now() / 1000) + ttl;
  return `${base}/api/studio/photos/${encodeURIComponent(publicId)}?exp=${exp}&sig=${sign(publicId, exp)}`;
}

function verify(publicId, exp, sig) {
  const e = Number(exp);
  if (!Number.isInteger(e) || e < Math.floor(Date.now() / 1000) || e > Math.floor(Date.now() / 1000) + 24 * 3600) return false;
  const want = Buffer.from(sign(publicId, e));
  const got = Buffer.from(String(sig || ""));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

/** Random public ids and edit tokens. */
const randomId = (bytes = 16) => crypto.randomBytes(bytes).toString("base64url");
const hashToken = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");

module.exports = { photoUrl, verify, randomId, hashToken, secretSource, TTL };
