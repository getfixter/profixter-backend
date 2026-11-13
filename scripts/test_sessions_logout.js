/**
 * Server-side sign-out: revocable sessions behind the existing bearer tokens.
 *
 * Drives the real routes/auth.js and middleware/auth.js over HTTP against an
 * in-memory MongoDB. Nothing leaves the process (password sign-in only).
 *
 *   node scripts/test_sessions_logout.js
 */

Object.assign(process.env, {
  NODE_ENV: "test",
  S3_BUCKET: "test-bucket",
  JWT_SECRET: "test-secret-for-sessions",
  STRIPE_SECRET_KEY: "sk_test_fake",
  CLIENT_URL: "https://www.profixter.com",
});

const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const User = require("../models/User");
const Session = require("../models/Session");
const RevokedToken = require("../models/RevokedToken");
const AuthRateCounter = require("../models/AuthRateCounter");
const sessions = require("../utils/auth/sessions");

const app = express();
app.use(express.json());
app.use("/api/auth", require("../routes/auth"));
const authV2 = require("../routes/authV2");
const delivered = [];
// Codes are captured, never sent.
authV2.deps.deliver = async (entry) => {
  delivered.push(entry);
};
app.use("/api/auth", authV2);
app.get("/api/protected", require("../middleware/auth"), (req, res) => res.json({ ok: true, id: req.user.id }));

let base;
async function call(method, path, body, token, headers = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = {};
  try {
    json = await response.json();
  } catch {
    json = {};
  }
  return { status: response.status, body: json };
}

let passed = 0;
const failures = [];
async function test(name, fn) {
  await Promise.all([User.deleteMany({}), Session.deleteMany({}), RevokedToken.deleteMany({}), AuthRateCounter.deleteMany({})]);
  sessions._resetTouchCache();
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error.stack}`);
  }
}

let seq = 0;
async function makeUser(overrides = {}) {
  seq += 1;
  return User.create({
    userId: String(50000000 + seq),
    name: "Sam Session",
    email: `session${seq}@example.com`,
    password: await bcrypt.hash("correct horse", 4),
    role: "customer",
    signupMethod: "password",
    ...overrides,
  });
}

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit Safari/604.1";
const WINDOWS_UA = "Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36";

async function login(user, ua = IPHONE_UA) {
  const res = await call("POST", "/api/auth/login", { email: user.email, password: "correct horse" }, null, { "User-Agent": ua });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.token;
}

/** A token as every release before sessions minted it: no "sid". */
const legacyToken = (user, extra = {}) =>
  jwt.sign({ id: user._id, tv: Number(user.tokenVersion || 0), ...extra }, process.env.JWT_SECRET, { expiresIn: "30d" });

async function run() {
  await test("a new sign-in carries a sid backed by a Session row, same 30-day life", async () => {
    const user = await makeUser();
    const token = await login(user);
    const decoded = jwt.decode(token);
    assert.ok(decoded.sid);
    assert.equal(String(decoded.id), String(user._id));
    assert.equal(decoded.tv, 0);
    assert.ok(Math.abs(decoded.exp - decoded.iat - 30 * 24 * 3600) < 5);
    const row = await Session.findById(decoded.sid).lean();
    assert.ok(row);
    assert.equal(row.userAgent, "Safari on iOS");
    assert.equal(row.revokedAt, null);
    assert.equal(row.expiresAt.getTime(), decoded.exp * 1000);
    assert.equal((await call("GET", "/api/protected", null, token)).status, 200);
  });

  await test("logout invalidates the token immediately", async () => {
    const user = await makeUser();
    const token = await login(user);
    const out = await call("POST", "/api/auth/logout", null, token);
    assert.equal(out.status, 200);
    assert.deepEqual(out.body, { ok: true, revoked: "session" });
    const after = await call("GET", "/api/protected", null, token);
    assert.equal(after.status, 401);
    assert.equal(after.body.code, "SESSION_REVOKED");
    assert.equal((await call("GET", "/api/auth/me", null, token)).status, 401);
  });

  await test("other sessions are unaffected by a single logout", async () => {
    const user = await makeUser();
    const phone = await login(user);
    const laptop = await login(user, WINDOWS_UA);
    await call("POST", "/api/auth/logout", null, phone);
    assert.equal((await call("GET", "/api/protected", null, phone)).status, 401);
    assert.equal((await call("GET", "/api/protected", null, laptop)).status, 200);
    const list = await call("GET", "/api/auth/sessions", null, laptop);
    assert.equal(list.status, 200);
    assert.equal(list.body.sessions.length, 1);
    assert.equal(list.body.sessions[0].current, true);
    assert.equal(list.body.sessions[0].device, "Chrome on Windows");
    assert.equal(list.body.currentIsLegacy, false);
  });

  await test("a legacy token (no sid) keeps working at release", async () => {
    const user = await makeUser();
    const token = legacyToken(user);
    assert.equal((await call("GET", "/api/protected", null, token)).status, 200);
    const list = await call("GET", "/api/auth/sessions", null, token);
    assert.equal(list.status, 200);
    assert.equal(list.body.currentIsLegacy, true);
  });

  await test("legacy token logout denylists its hash until its own expiry", async () => {
    const user = await makeUser();
    const token = legacyToken(user);
    const other = legacyToken(user, { iat: Math.floor(Date.now() / 1000) - 60 });
    const out = await call("POST", "/api/auth/logout", null, token);
    assert.equal(out.status, 200);
    assert.equal(out.body.revoked, "legacy");
    const after = await call("GET", "/api/protected", null, token);
    assert.equal(after.status, 401);
    assert.equal(after.body.code, "SESSION_REVOKED");
    const row = await RevokedToken.findOne({}).lean();
    assert.equal(row.tokenHash, sessions.tokenHash(token));
    assert.notEqual(row.tokenHash, token, "the token itself is never stored");
    assert.equal(row.expiresAt.getTime(), jwt.decode(token).exp * 1000);
    // A different legacy token for the same account is untouched.
    assert.equal((await call("GET", "/api/protected", null, other)).status, 200);
  });

  await test("logout-all ends every session and every legacy token", async () => {
    const user = await makeUser();
    const a = await login(user);
    const b = await login(user);
    const legacy = legacyToken(user);
    const out = await call("POST", "/api/auth/logout-all", null, a);
    assert.equal(out.status, 200);
    assert.equal(out.body.ok, true);
    assert.equal(out.body.revokedSessions, 2);
    for (const token of [a, b, legacy]) assert.equal((await call("GET", "/api/protected", null, token)).status, 401);
    assert.equal((await User.findById(user._id).lean()).tokenVersion, 1);
    const fresh = await login(user);
    assert.equal((await call("GET", "/api/protected", null, fresh)).status, 200);
  });

  await test("a token naming another user's session, or a missing one, is refused", async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const token = await login(owner);
    const forged = jwt.sign({ id: other._id, tv: 0, sid: jwt.decode(token).sid }, process.env.JWT_SECRET, { expiresIn: "1h" });
    assert.equal((await call("GET", "/api/protected", null, forged)).status, 401);
    const missing = jwt.sign({ id: owner._id, tv: 0, sid: String(new mongoose.Types.ObjectId()) }, process.env.JWT_SECRET, { expiresIn: "1h" });
    assert.equal((await call("GET", "/api/protected", null, missing)).status, 401);
  });

  await test("a temporary-password session is limited but can still sign out", async () => {
    const user = await makeUser({
      mustChangePassword: true,
      temporaryPassword: { issuedAt: new Date(), expiresAt: new Date(Date.now() + 3600e3) },
    });
    const token = legacyToken(user);
    const blocked = await call("GET", "/api/protected", null, token);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, "PASSWORD_CHANGE_REQUIRED");
    assert.equal((await call("POST", "/api/auth/logout", null, token)).status, 200);
    assert.equal((await call("GET", "/api/auth/me", null, token)).status, 401);
  });

  await test("phone/email-code sessions (auth 2.0 routes) honour sign-out too", async () => {
    const user = await makeUser({ phone: "+16315550142", phoneVerifiedAt: new Date() });
    const token = await login(user);
    const before = await call("POST", "/api/auth/reauth/start", { channel: "sms" }, token);
    assert.equal(before.status, 200, JSON.stringify(before.body));
    await AuthRateCounter.deleteMany({});
    await call("POST", "/api/auth/logout", null, token);
    const after = await call("POST", "/api/auth/reauth/start", { channel: "sms" }, token);
    assert.notEqual(after.status, 200, "a signed-out session cannot use the 2.0 account routes");
    assert.equal(delivered.length, 1);
  });

  await test("review 8: a reauth proof (or any purpose token) is never accepted as a sign-in token", async () => {
    const user = await makeUser({ phone: "+16315550143", phoneVerifiedAt: new Date() });
    const token = await login(user);
    delivered.length = 0;
    assert.equal((await call("POST", "/api/auth/reauth/start", { channel: "sms" }, token)).status, 200);
    const code = delivered[delivered.length - 1]?.code;
    assert.ok(code, JSON.stringify(delivered));
    const verified = await call("POST", "/api/auth/reauth/verify", { channel: "sms", code }, token);
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    const reauthToken = verified.body.reauthToken;
    assert.equal(jwt.decode(reauthToken).purpose, "reauth");
    // Its intended use (a body proof next to the real session) is untouched; as a bearer token it is refused.
    assert.equal((await call("GET", "/api/protected", null, reauthToken)).status, 401, "middleware/auth refuses it");
    assert.notEqual((await call("POST", "/api/auth/reauth/start", { channel: "sms" }, reauthToken)).status, 200, "the 2.0 routes refuse it");
    await call("POST", "/api/auth/logout", null, token);
    assert.equal((await call("GET", "/api/protected", null, reauthToken)).status, 401, "nothing outlives the sign-out");
    // Hand-made purpose tokens with a valid id and tokenVersion are refused the same way.
    for (const extra of [{ purpose: "reauth" }, { typ: "phone_link" }, { typ: "reset" }]) {
      assert.equal((await call("GET", "/api/protected", null, legacyToken(user, extra))).status, 401, JSON.stringify(extra));
    }
    // A plain legacy sign-in token (no sid, no purpose) still works: no forced logout.
    assert.equal((await call("GET", "/api/protected", null, legacyToken(user))).status, 200);
  });

  await test("lastSeenAt updates are throttled to one write per five minutes", async () => {
    const user = await makeUser();
    const token = await login(user);
    const sid = jwt.decode(token).sid;
    sessions._resetTouchCache();
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await Session.updateOne({ _id: sid }, { $set: { lastSeenAt: old } });
    await call("GET", "/api/protected", null, token);
    await new Promise((r) => setTimeout(r, 150));
    const first = (await Session.findById(sid).lean()).lastSeenAt;
    assert.ok(first > old);
    await Session.updateOne({ _id: sid }, { $set: { lastSeenAt: old } });
    await call("GET", "/api/protected", null, token);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal((await Session.findById(sid).lean()).lastSeenAt.getTime(), old.getTime(), "second request within 5 min does not write");
  });
}

(async () => {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([User.syncIndexes(), Session.syncIndexes(), RevokedToken.syncIndexes(), AuthRateCounter.syncIndexes()]);
  const server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run();
  } finally {
    server.close();
    await mongoose.disconnect();
    await mongod.stop();
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
