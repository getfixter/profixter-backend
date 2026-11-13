const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const Session = require("../../models/Session");
const RevokedToken = require("../../models/RevokedToken");

/**
 * Revocable server-side sessions behind the existing bearer tokens.
 *
 * - A token minted after this release carries "sid", the id of a Session row.
 *   Signing out sets revokedAt on that row and the token stops working at once.
 * - A token minted before this release has no sid. It keeps working exactly as
 *   before (nobody is signed out by the release); signing it out stores its
 *   sha256 in RevokedToken until the token's own expiry.
 * - "Sign out everywhere" bumps user.tokenVersion, which every token carries as
 *   "tv" and middleware/auth.js already compares, and revokes every row.
 *
 * Expiry is unchanged: the session row expires when the token does.
 */

const TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const lastTouch = new Map();

function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function summarizeUserAgent(ua) {
  const value = String(ua || "");
  if (!value) return "";
  const browser =
    (/Edg\//.test(value) && "Edge") ||
    (/OPR\//.test(value) && "Opera") ||
    (/Chrome\//.test(value) && "Chrome") ||
    (/Firefox\//.test(value) && "Firefox") ||
    (/Safari\//.test(value) && "Safari") ||
    "";
  const os =
    (/iPhone|iPad|iPod/.test(value) && "iOS") ||
    (/Android/.test(value) && "Android") ||
    (/Windows/.test(value) && "Windows") ||
    (/Mac OS X|Macintosh/.test(value) && "macOS") ||
    (/Linux/.test(value) && "Linux") ||
    "";
  const summary = [browser, os].filter(Boolean).join(" on ");
  return (summary || value).slice(0, 160);
}

function ipHashFor(req) {
  try {
    const { clientIp } = require("./clientIp");
    const ip = clientIp(req);
    return ip ? crypto.createHash("sha256").update(`session:${ip}`).digest("hex").slice(0, 32) : "";
  } catch {
    return "";
  }
}

/**
 * Sign a session token for this user and create its Session row.
 * `payload` and `expiresIn` are exactly what the caller signed before sessions.
 */
async function signSessionToken(user, { payload, expiresIn, req } = {}) {
  const sid = new mongoose.Types.ObjectId();
  const token = jwt.sign({ ...payload, sid: String(sid) }, process.env.JWT_SECRET, { expiresIn });
  const decoded = jwt.decode(token);
  const expiresAt = decoded?.exp ? new Date(decoded.exp * 1000) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await Session.create({
    _id: sid,
    user: user._id,
    lastSeenAt: new Date(),
    userAgent: summarizeUserAgent(req?.headers?.["user-agent"]),
    ipHash: req ? ipHashFor(req) : "",
    expiresAt,
  });
  return token;
}

/**
 * Whether a verified token may still be used. Returns null when it may, or
 * { status, message, code } to send back.
 */
async function checkToken(decoded, token) {
  if (decoded?.sid) {
    if (!mongoose.Types.ObjectId.isValid(decoded.sid)) return revokedResponse();
    const session = await Session.findById(decoded.sid).select("user revokedAt").lean();
    if (!session || session.revokedAt || String(session.user) !== String(decoded.id)) return revokedResponse();
    return null;
  }
  const hit = await RevokedToken.exists({ tokenHash: tokenHash(token) });
  return hit ? revokedResponse() : null;
}

function revokedResponse() {
  return { status: 401, message: "Session ended. Please sign in again.", code: "SESSION_REVOKED" };
}

/** At most one lastSeenAt write per session per five minutes; never awaited by requests. */
function touch(sid, now = Date.now()) {
  if (!sid) return;
  const key = String(sid);
  const previous = lastTouch.get(key) || 0;
  if (now - previous < TOUCH_INTERVAL_MS) return;
  lastTouch.set(key, now);
  if (lastTouch.size > 10000) {
    for (const [k, at] of lastTouch) if (now - at >= TOUCH_INTERVAL_MS) lastTouch.delete(k);
  }
  Session.updateOne(
    { _id: key, revokedAt: null, lastSeenAt: { $lt: new Date(now - TOUCH_INTERVAL_MS) } },
    { $set: { lastSeenAt: new Date(now) } }
  ).catch(() => {});
}

/** End the session this token belongs to. */
async function revokeToken(decoded, token, reason = "logout") {
  if (decoded?.sid && mongoose.Types.ObjectId.isValid(decoded.sid)) {
    await Session.updateOne(
      { _id: decoded.sid, user: decoded.id, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedReason: reason } }
    );
    return { kind: "session" };
  }
  const expiresAt = decoded?.exp ? new Date(decoded.exp * 1000) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await RevokedToken.updateOne(
    { tokenHash: tokenHash(token) },
    { $setOnInsert: { tokenHash: tokenHash(token), user: decoded?.id || null, revokedAt: new Date(), expiresAt } },
    { upsert: true }
  );
  return { kind: "legacy" };
}

/** End every session of a user: bump tokenVersion (legacy tokens) and revoke every row. */
async function revokeAllForUser(userId, reason = "logout_all") {
  const User = require("../../models/User");
  await User.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } });
  const result = await Session.updateMany(
    { user: userId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } }
  );
  return { revoked: result.modifiedCount || 0 };
}

async function listActiveSessions(userId, currentSid) {
  const rows = await Session.find({ user: userId, revokedAt: null, expiresAt: { $gt: new Date() } })
    .select("createdAt lastSeenAt userAgent expiresAt")
    .sort({ lastSeenAt: -1 })
    .limit(50)
    .lean();
  return rows.map((row) => ({
    id: String(row._id),
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    device: row.userAgent || "",
    expiresAt: row.expiresAt,
    current: Boolean(currentSid) && String(row._id) === String(currentSid),
  }));
}

/** The raw bearer token from a request, as middleware/auth.js reads it. */
function tokenFromRequest(req) {
  const bearer = req.header ? req.header("Authorization") : req.headers?.authorization;
  return (bearer && String(bearer).replace(/^Bearer\s+/i, "")) || (req.header ? req.header("x-auth-token") : req.headers?.["x-auth-token"]) || "";
}

function _resetTouchCache() {
  lastTouch.clear();
}

/**
 * A purpose token (reauth proof, phone link/choice, password reset...) is
 * signed with the same secret as a sign-in token but is not one. It carries
 * `purpose` or `typ`; a sign-in token carries neither. Review fix 8
 * (2026-11-13): such a token is never accepted as a session, so a reauth
 * proof cannot outlive the sign-out of the session that minted it.
 */
function isPurposeToken(decoded) {
  return Boolean(decoded && (decoded.purpose !== undefined || decoded.typ !== undefined));
}

module.exports = {
  TOUCH_INTERVAL_MS,
  isPurposeToken,
  tokenHash,
  summarizeUserAgent,
  signSessionToken,
  checkToken,
  touch,
  revokeToken,
  revokeAllForUser,
  listActiveSessions,
  tokenFromRequest,
  _resetTouchCache,
};
