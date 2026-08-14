const crypto = require("crypto");

/**
 * Keys that can open an unsubscribe token, newest first.
 *
 * New tokens are always signed with the dedicated secret when one is set. Old
 * tokens signed with JWT_SECRET keep working, because an unsubscribe link lives
 * in somebody's inbox for a year and rotating a login secret must never turn a
 * working opt-out into a 400 page. Once every token predating the dedicated
 * secret has expired, the fallback can be dropped.
 */
function keyFrom(value) {
  return crypto.createHash("sha256").update(String(value)).digest();
}

function signingSecret() {
  const value = process.env.EMAIL_UNSUBSCRIBE_SECRET || process.env.JWT_SECRET;
  if (!value) throw new Error("EMAIL_UNSUBSCRIBE_SECRET or JWT_SECRET is required");
  return keyFrom(value);
}

function readingSecrets() {
  const keys = [];
  if (process.env.EMAIL_UNSUBSCRIBE_SECRET) keys.push(keyFrom(process.env.EMAIL_UNSUBSCRIBE_SECRET));
  if (process.env.JWT_SECRET) keys.push(keyFrom(process.env.JWT_SECRET));
  if (!keys.length) throw new Error("EMAIL_UNSUBSCRIBE_SECRET or JWT_SECRET is required");
  return keys;
}

function createUnsubscribeToken(email) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", signingSecret(), iv);
  const payload = JSON.stringify({
    email: String(email || "").trim().toLowerCase(),
    expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
  });
  const encrypted = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64url");
}

function readUnsubscribeToken(token) {
  const data = Buffer.from(String(token || ""), "base64url");
  if (data.length < 29) throw new Error("Invalid unsubscribe token");
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const encrypted = data.subarray(28);

  let payload = null;
  for (const key of readingSecrets()) {
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      payload = JSON.parse(
        Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8")
      );
      break;
    } catch (_error) {
      // Wrong key, or a tampered token. Try the next key before giving up.
    }
  }
  if (!payload) throw new Error("Invalid unsubscribe token");

  if (!payload.email || Number(payload.expiresAt) < Date.now()) {
    throw new Error("Expired unsubscribe token");
  }
  return payload;
}

module.exports = { createUnsubscribeToken, readUnsubscribeToken };
