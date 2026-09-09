const crypto = require("crypto");

const { CLAIM_TOKEN_TTL_DAYS } = require("./giftConfig");

/**
 * The credential that carries a gift invitation from an inbox to a claim page.
 *
 * Same construction as utils/tipToken and utils/unsubscribeToken, for the same
 * reasons: AES-256-GCM, so encryption hides the identifiers and the GCM tag
 * authenticates them. A tampered token fails to decrypt rather than resolving
 * to a different gift, and nobody holding one can read which record it points
 * at or edit it to point at another.
 *
 * TWO INDEPENDENT CHECKS, AND BOTH MUST PASS.
 *
 *   1. The token decrypts, its version matches, and it has not expired.
 *   2. Its SHA-256 hash equals the hash stored on the gift.
 *
 * The second is what makes Admin re-issue work. Issuing a new token replaces
 * the stored hash, so every token handed out before then stops verifying even
 * though it still decrypts perfectly well and may not have expired. Without
 * it, "send them a fresh link" would leave the old link working — which is the
 * opposite of what re-issuing after a suspected leak is for.
 *
 * The token is NEVER stored. Only its hash goes in the database, so reading the
 * collection does not yield a working claim link.
 */

const TOKEN_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

function keyFrom(value) {
  return crypto.createHash("sha256").update(String(value)).digest();
}

/**
 * The signing key.
 *
 * A dedicated secret, falling back to JWT_SECRET so a stack that has not set
 * one still works. Mirrors the fallback in unsubscribeToken; rotating the
 * login secret would invalidate outstanding invitations, which is survivable
 * because Admin can re-issue, but the dedicated variable avoids the question.
 */
function signingSecret() {
  const value = process.env.GIFT_CLAIM_SECRET || process.env.JWT_SECRET;
  if (!value) throw new Error("GIFT_CLAIM_SECRET or JWT_SECRET is required");
  return keyFrom(value);
}

/** The hash stored against the gift. Never the token itself. */
function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

/**
 * Mint a claim token for a gift.
 *
 * Returns the token AND the fields to persist. The caller stores the fields;
 * the token goes into exactly one email and is never seen again.
 */
function createClaimToken({ giftId, version, ttlDays = CLAIM_TOKEN_TTL_DAYS }) {
  if (!giftId) throw new Error("giftId is required to mint a claim token");

  const issuedAt = Date.now();
  const expiresAt = issuedAt + Number(ttlDays) * DAY_MS;

  const payload = JSON.stringify({
    v: TOKEN_VERSION,
    g: String(giftId),
    n: Number(version) || 0,
    e: expiresAt,
  });

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", signingSecret(), iv);
  const encrypted = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const token = Buffer.concat([iv, tag, encrypted]).toString("base64url");

  return {
    token,
    fields: {
      claimTokenHash: hashToken(token),
      claimTokenVersion: Number(version) || 0,
      claimTokenIssuedAt: new Date(issuedAt),
      claimTokenExpiresAt: new Date(expiresAt),
    },
  };
}

/**
 * Read a token, without consulting the database.
 *
 * Returns what the token claims. The caller must still check it against the
 * stored hash and version — this only proves the token is well formed, ours,
 * and unexpired.
 */
function readClaimToken(token) {
  let data;
  try {
    data = Buffer.from(String(token || ""), "base64url");
  } catch (_error) {
    return { ok: false, reason: "malformed" };
  }
  if (data.length < 29) return { ok: false, reason: "malformed" };

  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const encrypted = data.subarray(28);

  let payload;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", signingSecret(), iv);
    decipher.setAuthTag(tag);
    payload = JSON.parse(
      Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8")
    );
  } catch (_error) {
    // Wrong key, or somebody edited the token. Indistinguishable on purpose.
    return { ok: false, reason: "invalid" };
  }

  if (payload?.v !== TOKEN_VERSION) return { ok: false, reason: "invalid" };
  if (!payload?.g) return { ok: false, reason: "invalid" };

  /*
   * An expired token is reported distinctly from an invalid one, because the
   * two need completely different answers. Invalid is "this link is not ours".
   * Expired is "this link is old, and your gift is still here" — the gift
   * itself has not been touched, and Admin can send a fresh link.
   */
  if (Number(payload.e) < Date.now()) {
    return { ok: false, reason: "expired", giftId: String(payload.g) };
  }

  return {
    ok: true,
    giftId: String(payload.g),
    version: Number(payload.n) || 0,
  };
}

/**
 * The full check, against the gift record.
 *
 * Constant-time on the hash comparison. A byte-by-byte early return would leak
 * how much of a guessed token was right, and the hashes are the same length by
 * construction so the comparison is always safe to make.
 */
function verifyClaimToken(token, gift) {
  const read = readClaimToken(token);
  if (!read.ok) return read;

  if (!gift) return { ok: false, reason: "not_found" };
  if (String(gift._id) !== read.giftId) return { ok: false, reason: "invalid" };

  if (!gift.claimTokenHash) return { ok: false, reason: "revoked" };

  const provided = Buffer.from(hashToken(token), "utf8");
  const stored = Buffer.from(String(gift.claimTokenHash), "utf8");
  if (provided.length !== stored.length || !crypto.timingSafeEqual(provided, stored)) {
    // The hash on the gift moved: a newer invitation was issued, and this is
    // an older link that has been superseded.
    return { ok: false, reason: "superseded" };
  }

  if (Number(gift.claimTokenVersion || 0) !== read.version) {
    return { ok: false, reason: "superseded" };
  }

  return { ok: true, giftId: read.giftId, version: read.version };
}

module.exports = {
  CLAIM_TOKEN_TTL_DAYS,
  TOKEN_VERSION,
  createClaimToken,
  hashToken,
  readClaimToken,
  verifyClaimToken,
};
