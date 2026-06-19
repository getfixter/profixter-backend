const crypto = require("crypto");

function secret() {
  const value = process.env.EMAIL_UNSUBSCRIBE_SECRET || process.env.JWT_SECRET;
  if (!value) throw new Error("EMAIL_UNSUBSCRIBE_SECRET or JWT_SECRET is required");
  return crypto.createHash("sha256").update(String(value)).digest();
}

function createUnsubscribeToken(email) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", secret(), iv);
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
  const decipher = crypto.createDecipheriv("aes-256-gcm", secret(), iv);
  decipher.setAuthTag(tag);
  const payload = JSON.parse(
    Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8")
  );
  if (!payload.email || Number(payload.expiresAt) < Date.now()) {
    throw new Error("Expired unsubscribe token");
  }
  return payload;
}

module.exports = { createUnsubscribeToken, readUnsubscribeToken };
