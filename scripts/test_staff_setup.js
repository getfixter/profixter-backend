/*
 * Telemarketer invitation-link setup (utils/auth/staffSetup.js), end to end:
 * no usable password at creation, single-use expiring links, resend
 * invalidating the previous link, tampering, reuse, access before setup, the
 * one-time conversion of accounts still on the old shared password (without
 * touching passwords employees chose), and offboarding.
 *
 * Real routes (/api/admin/fixters, /api/staff-setup, /api/auth/login,
 * /api/sales), a real in-memory MongoDB replica set. Email is captured at
 * emailService.sendRaw: nothing is sent.
 *
 *   node scripts/test_staff_setup.js
 */
Object.assign(process.env, {
  NODE_ENV: "test",
  JWT_SECRET: "test-secret-staff-setup",
  STRIPE_SECRET_KEY: "sk_test_fake_for_unit_tests",
  CLIENT_URL: "https://www.profixter.com",
  SMS_ENABLED: "false",
  S3_BUCKET: "test-bucket",
  AWS_REGION: "us-east-1",
  MAIL_ADMIN: "owner@example.test",
});

const assert = require("assert");
const crypto = require("crypto");
const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const sent = [];
const mail = require("../utils/emailService");
mail.sendRaw = async (message) => {
  sent.push(message);
  return { messageId: "fake" };
};

const User = require("../models/User");
const AuthRateCounter = require("../models/AuthRateCounter");
const AdminActivityLog = require("../models/AdminActivityLog");
const staffSetup = require("../utils/auth/staffSetup");

const app = express();
app.use(express.json());
app.use("/api/auth", require("../routes/auth"));
app.use("/api/staff-setup", require("../routes/staffSetup"));
app.use("/api/admin/fixters", require("../routes/fixters"));
app.use("/api/sales", require("../routes/sales"));
app.get("/api/protected", require("../middleware/auth"), (req, res) => res.json({ ok: true }));

let base;
const tokenFor = (u) => jwt.sign({ id: String(u._id), tv: Number(u.tokenVersion || 0) }, process.env.JWT_SECRET, { expiresIn: "10m" });
async function call(method, path, user, body, { token } = {}) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(user || token ? { authorization: `Bearer ${token || tokenFor(user)}` } : {}) },
    body: body && method !== "GET" ? JSON.stringify(body) : undefined,
  });
  let json = {};
  try {
    json = JSON.parse(await r.text());
  } catch {
    json = {};
  }
  return { status: r.status, body: json };
}
const tokenOf = (link) => String(link).split("#")[1];
const verify = (token) => call("POST", "/api/staff-setup/verify", null, { token });
const complete = (token, password) => call("POST", "/api/staff-setup/complete", null, { token, password });
const login = (email, password) => call("POST", "/api/auth/login", null, { email, password });
const fresh = (u) => User.findById(u._id || u.id).lean();

let passed = 0;
let failed = 0;
async function check(name, fn) {
  await AuthRateCounter.deleteMany({});
  try {
    await fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name}\n      ${String(error.stack || error.message).split("\n").slice(0, 6).join("\n      ")}`);
  }
}

let seq = 0;
async function createTele(owner, first = "Tina") {
  seq += 1;
  const r = await call("POST", "/api/admin/fixters", owner, { firstName: first, lastName: `Tele${seq}`, email: `${first.toLowerCase()}${seq}@staff.test`, employeePosition: "Telemarketer" });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  return { id: r.body.fixter.id, email: r.body.fixter.email, link: r.body.setupLink?.link, res: r };
}

(async () => {
  const mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongod.getUri());
  await User.init();
  const server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  const owner = await User.create({ userId: "70000001", name: "Owner Person", email: "owner@example.test", role: "admin" });

  await check("creating a Telemarketer gives no usable password, a single-use expiring link, and sends nothing", async () => {
    const before = sent.length;
    const t = await createTele(owner);
    assert.match(t.link, /^https:\/\/www\.profixter\.com\/team-setup#[A-Za-z0-9_-]{43}$/);
    const u = await fresh(t);
    assert.ok(!u.password, "no password hash at all");
    assert.strictEqual(u.mustChangePassword, false);
    assert.strictEqual(u.staffSetup.pending, true);
    assert.strictEqual(u.staffSetup.tokenHash, staffSetup.hashToken(tokenOf(t.link)));
    assert.ok(!JSON.stringify(u).includes(tokenOf(t.link)), "the raw token is never stored");
    const hours = (new Date(u.staffSetup.expiresAt) - Date.now()) / 3600e3;
    assert.ok(hours > 71.9 && hours <= 72, `expires in 72h (got ${hours})`);
    assert.strictEqual(sent.length, before, "no email until the owner presses Send");
    assert.strictEqual(t.res.body.fixter.setup.state, "link_active");
    assert.ok(!JSON.stringify(t.res.body.fixter).includes(tokenOf(t.link)), "the Team list never carries the link");
    assert.ok(await AdminActivityLog.exists({ action: "Employee Created", entityId: u._id }));
  });

  await check("11111111 (or anything) never signs a new Telemarketer in; a session token for them is refused everywhere", async () => {
    const t = await createTele(owner);
    for (const pw of ["11111111", "", "password"]) assert.notStrictEqual((await login(t.email, pw)).status, 200, `login with "${pw}"`);
    const u = await User.findById(t.id);
    for (const p of ["/api/protected", "/api/sales/me", "/api/auth/me"]) {
      const r = await call("GET", p, u);
      assert.strictEqual(r.status, 403, p);
      assert.strictEqual(r.body.code, "STAFF_SETUP_REQUIRED", p);
    }
  });

  await check("the setup screen can read whose link it is; tampered, truncated, empty and query-string tokens are refused", async () => {
    const t = await createTele(owner, "Vera");
    const ok = await verify(tokenOf(t.link));
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.deepStrictEqual([ok.body.firstName, ok.body.email], ["Vera", t.email]);
    const raw = tokenOf(t.link);
    const flipped = raw.slice(0, 10) + (raw[10] === "A" ? "B" : "A") + raw.slice(11);
    for (const bad of [flipped, raw.slice(0, 42), raw + "x", "", "../../etc", staffSetup.hashToken(raw)]) {
      const r = await verify(bad);
      assert.strictEqual(r.status, 400, `"${bad.slice(0, 12)}" -> ${r.status}`);
      assert.strictEqual(r.body.code, "SETUP_LINK_INVALID");
      assert.strictEqual((await complete(bad, "a-strong-pass-9")).status, 400);
    }
    const q = await fetch(`${base}/api/staff-setup/verify?token=${raw}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.strictEqual(q.status, 400, "a token in the query string is ignored");
    assert.strictEqual((await verify(raw)).status, 200, "the real link still works after the tampering attempts");
  });

  await check("weak passwords (including 11111111) are refused and leave the link usable", async () => {
    const t = await createTele(owner);
    for (const pw of ["11111111", "short", "aaaaaaaaaa", "12345678", "password", t.email]) {
      const r = await complete(tokenOf(t.link), pw);
      assert.strictEqual(r.status, 400, `${pw} -> ${r.status}`);
      assert.strictEqual(r.body.code, "WEAK_PASSWORD");
    }
    assert.strictEqual((await verify(tokenOf(t.link))).status, 200);
    assert.ok(!(await fresh(t)).password);
  });

  await check("setup sets their own password, signs them straight in, and only then opens the workspace", async () => {
    const t = await createTele(owner);
    const u0 = await User.findById(t.id);
    const preToken = tokenFor(u0);
    const r = await complete(tokenOf(t.link), "My-own-secret-7");
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.token);
    assert.strictEqual((await call("GET", "/api/sales/me", null, null, { token: r.body.token })).status, 200, "the new session opens the workspace");
    assert.strictEqual((await call("GET", "/api/protected", null, null, { token: preToken })).status, 401, "a token from before setup is dead");
    const u = await fresh(t);
    assert.ok(await bcrypt.compare("My-own-secret-7", u.password));
    assert.deepStrictEqual([u.staffSetup.pending, u.staffSetup.tokenHash, u.mustChangePassword], [false, null, false]);
    assert.ok(u.staffSetup.completedAt);
    assert.strictEqual((await login(t.email, "My-own-secret-7")).status, 200, "and they sign in normally afterwards");
    assert.notStrictEqual((await login(t.email, "11111111")).status, 200);
  });

  await check("a link works once: reuse after setup is refused, and two simultaneous submissions set exactly one password", async () => {
    const t = await createTele(owner);
    const raw = tokenOf(t.link);
    const [a, b] = await Promise.all([complete(raw, "First-choice-11"), complete(raw, "Second-choice-22")]);
    assert.deepStrictEqual([a.status, b.status].sort(), [200, 400], `${a.status}/${b.status}`);
    const winner = a.status === 200 ? "First-choice-11" : "Second-choice-22";
    assert.ok(await bcrypt.compare(winner, (await fresh(t)).password));
    assert.strictEqual((await complete(raw, "Third-choice-33")).status, 400);
    assert.strictEqual((await verify(raw)).status, 400);
    assert.ok(await bcrypt.compare(winner, (await fresh(t)).password), "the reused link changed nothing");
  });

  await check("an expired link is refused (410) for reading and for setup; a new link works", async () => {
    const t = await createTele(owner);
    await User.updateOne({ _id: t.id }, { $set: { "staffSetup.expiresAt": new Date(Date.now() - 1000) } });
    const v = await verify(tokenOf(t.link));
    assert.deepStrictEqual([v.status, v.body.code], [410, "SETUP_LINK_EXPIRED"]);
    assert.strictEqual((await complete(tokenOf(t.link), "Late-but-strong-1")).status, 410);
    assert.ok(!(await fresh(t)).password);
    const list = (await call("GET", "/api/admin/fixters", owner)).body.fixters.find((f) => f.id === t.id);
    assert.strictEqual(list.setup.state, "expired");
    const again = await call("POST", `/api/admin/fixters/${t.id}/setup-link`, owner, {});
    assert.strictEqual(again.status, 200, JSON.stringify(again.body));
    assert.strictEqual((await verify(tokenOf(again.body.setupLink.link))).status, 200);
  });

  await check("expiry boundary: valid just before, refused at the expiry instant (server clock)", async () => {
    const t = await createTele(owner);
    const u = await User.findById(t.id);
    const at = new Date(u.staffSetup.expiresAt);
    assert.ok(await staffSetup.inspect(tokenOf(t.link), { now: new Date(at - 1) }));
    await assert.rejects(staffSetup.inspect(tokenOf(t.link), { now: at }), (e) => e.code === "SETUP_LINK_EXPIRED");
    await assert.rejects(staffSetup.complete(tokenOf(t.link), "Exactly-at-expiry-1", { now: at }), (e) => e.code === "SETUP_LINK_EXPIRED");
  });

  await check("send and resend: each invitation emails a NEW link and kills every earlier one (copied or sent)", async () => {
    const t = await createTele(owner, "Rosa");
    const n = sent.length;
    const s1 = await call("POST", `/api/admin/fixters/${t.id}/setup-invite`, owner, {});
    assert.strictEqual(s1.status, 200, JSON.stringify(s1.body));
    assert.strictEqual(sent.length, n + 1);
    const m1 = sent[sent.length - 1];
    assert.strictEqual(m1.to, t.email);
    assert.ok(m1.text.includes(s1.body.setupLink.link) && m1.html.includes(s1.body.setupLink.link), "the email carries the new link");
    assert.strictEqual(m1.logContext.redactBody, true, "the email log never keeps the link");
    assert.strictEqual((await verify(tokenOf(t.link))).status, 400, "the link from creation is dead");
    const s2 = await call("POST", `/api/admin/fixters/${t.id}/setup-invite`, owner, {});
    assert.strictEqual((await verify(tokenOf(s1.body.setupLink.link))).status, 400, "the first invitation's link is dead");
    const c = await call("POST", `/api/admin/fixters/${t.id}/setup-link`, owner, {});
    assert.strictEqual((await verify(tokenOf(s2.body.setupLink.link))).status, 400, "copying a new link kills the sent one");
    assert.strictEqual((await verify(tokenOf(c.body.setupLink.link))).status, 200);
    const u = await fresh(t);
    assert.deepStrictEqual([u.staffSetup.sendCount, u.staffSetup.lastSentTo], [2, t.email]);
    assert.ok(await AdminActivityLog.exists({ action: "Employee Invitation Sent", entityId: u._id }));
    assert.ok(await AdminActivityLog.exists({ action: "Employee Invitation Resent", entityId: u._id }));
    assert.strictEqual(c.body.fixter.setup.state, "link_active");
  });

  await check("a failed email still leaves one working (new) link for the owner to copy; earlier links are dead", async () => {
    const t = await createTele(owner);
    const real = mail.sendRaw;
    mail.sendRaw = async () => {
      throw new Error("SES down");
    };
    try {
      const r = await call("POST", `/api/admin/fixters/${t.id}/setup-invite`, owner, {});
      assert.deepStrictEqual([r.status, r.body.sent], [502, false]);
      assert.strictEqual((await verify(tokenOf(r.body.setupLink.link))).status, 200);
      assert.strictEqual((await verify(tokenOf(t.link))).status, 400);
      assert.strictEqual((await fresh(t)).staffSetup.sendCount, 0);
    } finally {
      mail.sendRaw = real;
    }
  });

  await check("once set up, the owner cannot issue a link or invitation (a chosen password is never reset this way)", async () => {
    const t = await createTele(owner);
    assert.strictEqual((await complete(tokenOf(t.link), "Chosen-by-me-42")).status, 200);
    for (const p of ["setup-link", "setup-invite"]) {
      const r = await call("POST", `/api/admin/fixters/${t.id}/${p}`, owner, {});
      assert.deepStrictEqual([r.status, r.body.code], [409, "SETUP_COMPLETE"], p);
    }
    assert.ok(await bcrypt.compare("Chosen-by-me-42", (await fresh(t)).password));
  });

  await check("only the owner can issue links; a telemarketer or field employee cannot", async () => {
    const t = await createTele(owner);
    const done = await createTele(owner);
    await complete(tokenOf(done.link), "Ready-to-go-55");
    const field = await User.create({ userId: "70000077", name: "Fred Field", email: "ff@example.test", role: "employee", employeePosition: "Fixter", password: await bcrypt.hash("x-strong-1", 10) });
    for (const who of [await User.findById(done.id), field]) {
      assert.strictEqual((await call("POST", `/api/admin/fixters/${t.id}/setup-link`, who, {})).status, 403);
      assert.strictEqual((await call("POST", `/api/admin/fixters/${t.id}/setup-invite`, who, {})).status, 403);
    }
    assert.strictEqual((await call("POST", `/api/admin/fixters/${t.id}/setup-link`, null, {})).status, 401);
    assert.strictEqual((await call("POST", `/api/admin/fixters/${field._id}/setup-link`, owner, {})).body.code, "SETUP_NOT_APPLICABLE");
  });

  await check("turning off a pending account kills its link; turning it back on needs a new one", async () => {
    const t = await createTele(owner);
    assert.strictEqual((await call("PATCH", `/api/admin/fixters/${t.id}/status`, owner, { isActive: false })).status, 200);
    assert.strictEqual((await verify(tokenOf(t.link))).status, 400);
    assert.strictEqual((await call("POST", `/api/admin/fixters/${t.id}/setup-invite`, owner, {})).body.code, "EMPLOYEE_INACTIVE");
    assert.strictEqual((await call("PATCH", `/api/admin/fixters/${t.id}/status`, owner, { isActive: true })).status, 200);
    assert.strictEqual((await verify(tokenOf(t.link))).status, 400, "re-enabling does not revive the old link");
    const r = await call("POST", `/api/admin/fixters/${t.id}/setup-link`, owner, {});
    assert.strictEqual((await verify(tokenOf(r.body.setupLink.link))).status, 200);
  });

  await check("existing Telemarketers on the shared password are converted; passwords employees chose are untouched; Fixters unchanged", async () => {
    const shared = await bcrypt.hash("11111111", 10);
    const waiting = await User.create({ userId: "70000101", name: "Wendy Waiting", firstName: "Wendy", email: "wendy@staff.test", role: "employee", employeePosition: "Telemarketer", isActive: true, password: shared, mustChangePassword: true });
    const chosenHash = await bcrypt.hash("Wendys-friend-pw-1", 10);
    const chose = await User.create({ userId: "70000102", name: "Carl Chose", firstName: "Carl", email: "carl@staff.test", role: "employee", employeePosition: "Telemarketer", isActive: true, password: chosenHash, mustChangePassword: false });
    const fixter = await User.create({ userId: "70000103", name: "Finn Fixter", firstName: "Finn", email: "finn@staff.test", role: "employee", employeePosition: "Fixter", isActive: true, password: shared, mustChangePassword: true });
    const preToken = tokenFor(waiting);
    // Even BEFORE the conversion runs, the shared password and an old session open nothing.
    assert.notStrictEqual((await login("wendy@staff.test", "11111111")).status, 200);
    assert.strictEqual((await call("GET", "/api/sales/me", null, null, { token: preToken })).body.code, "STAFF_SETUP_REQUIRED");
    const team = (await call("GET", "/api/admin/fixters", owner)).body.fixters;
    assert.strictEqual(team.find((f) => f.email === "wendy@staff.test").setup.state, "needs_link");

    assert.strictEqual(await staffSetup.convertLegacyTelemarketers(), 1);
    assert.strictEqual(await staffSetup.convertLegacyTelemarketers(), 0, "idempotent");
    const w = await fresh(waiting);
    assert.ok(!w.password && w.staffSetup.pending && !w.staffSetup.tokenHash && w.mustChangePassword === false);
    assert.ok(w.tokenVersion > 0, "their sessions are ended");
    assert.strictEqual((await fresh(chose)).password, chosenHash, "a chosen password is never reset");
    assert.strictEqual((await login("carl@staff.test", "Wendys-friend-pw-1")).status, 200);
    const f = await fresh(fixter);
    assert.deepStrictEqual([f.password, f.mustChangePassword, f.staffSetup?.pending || false], [shared, true, false], "Fixters keep their current onboarding");

    const inv = await call("POST", `/api/admin/fixters/${waiting._id}/setup-invite`, owner, {});
    assert.strictEqual(inv.status, 200);
    assert.strictEqual((await complete(tokenOf(inv.body.setupLink.link), "Wendy-chooses-77")).status, 200);
    assert.strictEqual((await login("wendy@staff.test", "Wendy-chooses-77")).status, 200);
  });

  await check("moving an employee still on the shared password into Telemarketer switches them to link setup", async () => {
    const office = await User.create({ userId: "70000110", name: "Olga Office", firstName: "Olga", lastName: "Office", email: "olga@staff.test", role: "employee", employeePosition: null, isActive: true, password: await bcrypt.hash("11111111", 10), mustChangePassword: true });
    const r = await call("PUT", `/api/admin/fixters/${office._id}`, owner, { firstName: "Olga", lastName: "Office", phone: "", employeePosition: "Telemarketer" });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const o = await fresh(office);
    assert.ok(!o.password && o.staffSetup.pending);
    assert.notStrictEqual((await login("olga@staff.test", "11111111")).status, 200);
    assert.strictEqual(r.body.fixter.setup.state, "needs_link");
  });

  await check("guessing is rate limited per IP", async () => {
    let last;
    for (let i = 0; i < 16; i++) last = await complete(crypto.randomBytes(32).toString("base64url"), "Whatever-pw-123");
    assert.strictEqual(last.status, 429);
  });

  await check("invitation emails to one employee are capped per hour", async () => {
    const t = await createTele(owner);
    let last;
    for (let i = 0; i < 7; i++) last = await call("POST", `/api/admin/fixters/${t.id}/setup-invite`, owner, {});
    assert.strictEqual(last.status, 429);
  });

  server.close();
  await mongoose.disconnect();
  await mongod.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
