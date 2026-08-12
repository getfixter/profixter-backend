/**
 * The credential that carries tip context from a completion email to Stripe.
 *
 * WHY NOT A DATABASE ID IN THE URL
 * A tip link is public: it lands in an inbox, gets forwarded, and is opened by
 * anyone holding it. If the URL carried a Fixter id, anyone could edit it and
 * decide which employee gets paid, and every historical link would keep working
 * against whatever that id points at later. So the browser is given an opaque
 * blob it cannot read, cannot edit and cannot forge, and the server does every
 * lookup itself.
 *
 * The construction is AES-256-GCM, matching utils/unsubscribeToken: encryption
 * hides the identifiers, and the GCM tag authenticates them, so a tampered
 * token fails to decrypt rather than resolving to something else. No database
 * row is needed to issue one, which matters because completion emails are sent
 * on a hot path.
 */

const crypto = require("crypto");

/** A year. Tips arrive days after a visit, never months, but an expired link
 *  that quietly loses attribution is worse than a long-lived one that keeps it. */
const TIP_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000;

const TOKEN_VERSION = 1;

function secret() {
  const value = process.env.TIP_TOKEN_SECRET || process.env.JWT_SECRET;
  if (!value) throw new Error("TIP_TOKEN_SECRET or JWT_SECRET is required");
  return crypto.createHash("sha256").update(String(value)).digest();
}

function idString(value) {
  const text = String(value ?? "").trim();
  return text && text !== "null" && text !== "undefined" ? text : "";
}

/**
 * Issue a token for one completed booking.
 *
 * Stores identifiers only. Names, emails and amounts are resolved server-side
 * when the token is redeemed, so a token can never assert a fact about a
 * customer, and stale context in an old email cannot be replayed as truth.
 */
function createTipToken({ bookingId, fixterId, userId, now = Date.now() }) {
  const payload = JSON.stringify({
    v: TOKEN_VERSION,
    b: idString(bookingId),
    f: idString(fixterId),
    u: idString(userId),
    exp: now + TIP_TOKEN_TTL_MS,
  });

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", secret(), iv);
  const encrypted = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64url");
}

/**
 * Read a token, or throw.
 *
 * Throwing is deliberate: every caller treats an unreadable token as "no
 * context" and falls back to an unattributed tip, so there is one obvious way
 * to fail and it never ends in a guess.
 */
function readTipToken(token) {
  const data = Buffer.from(String(token || ""), "base64url");
  if (data.length < 29) throw new Error("Invalid tip token");

  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const encrypted = data.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", secret(), iv);
  decipher.setAuthTag(tag);

  const payload = JSON.parse(
    Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8")
  );

  if (Number(payload.v) !== TOKEN_VERSION) throw new Error("Unsupported tip token");
  if (!Number.isFinite(Number(payload.exp)) || Number(payload.exp) < Date.now()) {
    throw new Error("Expired tip token");
  }

  return {
    bookingId: idString(payload.b),
    fixterId: idString(payload.f),
    userId: idString(payload.u),
    expiresAt: new Date(Number(payload.exp)),
  };
}

/** Whether a token can be issued at all, so callers can degrade rather than throw. */
function tipTokensAvailable() {
  return !!(process.env.TIP_TOKEN_SECRET || process.env.JWT_SECRET);
}

module.exports = {
  TIP_TOKEN_TTL_MS,
  createTipToken,
  readTipToken,
  tipTokensAvailable,
};
