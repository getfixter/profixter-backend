/**
 * The owner's live preview of the customer Shower Studio (/api/studio-preview):
 * owner only (server-side), demo catalog and DEMO prices only, and stateless -
 * a preview request writes nothing to any collection and sends nothing.
 *
 * In-memory MongoDB; the staff email is stubbed. STUDIO_PUBLIC_ENABLED unset
 * (the public Studio stays off while the preview works).
 *   node scripts/test_studio_preview.js
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "studio-test-secret";
process.env.MAIL_ADMIN = "owner@test.local";
process.env.STUDIO_STORAGE = "memory";
delete process.env.STUDIO_PUBLIC_ENABLED;

const path = require("path");
const assert = require("assert");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const sent = [];
const notifierPath = require.resolve(path.join(__dirname, "..", "utils", "adminLeadNotification"));
require.cache[notifierPath] = { id: notifierPath, filename: notifierPath, loaded: true, exports: { sendAdminLeadNotification: async (x) => { sent.push(x); return { ok: true }; } } };

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failures.push(name); console.log(`  FAIL  ${name}\n        ${e.stack.split("\n").slice(0, 3).join("\n        ")}`); }
}

async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const User = require("../models/User");
  const StudioProduct = require("../models/studio/StudioProduct");
  const { SECTIONS } = require("../utils/adminAccess");
  const app = express();
  app.use("/api/studio", require("../routes/studioPublic"));
  app.use("/api/studio-preview", require("../routes/studioPreview"));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  const owner = await User.create({ userId: "u-owner", name: "Owner", email: "owner@test.local", role: "admin" });
  const allSections = await User.create({ userId: "u-emp", name: "Every Section", email: "emp@test.local", role: "employee", adminSections: SECTIONS.map((s) => s.id) });
  const customer = await User.create({ userId: "u-cust", name: "Carla", email: "carla@test.local", role: "customer" });
  // a real (non-demo) product exists in the catalog: the preview must never price it
  await StudioProduct.create({ sku: "REAL-BAR-1", category: "accessory", type: "grabBar", name: "Real bar", status: "published", pricing: { priceCents: 12345 }, engine: { length: 24, diameter: 1.25, clearance: 1.5, flange: 3.25, finishColor: "#c9ccce", roughness: 0.35 } });
  const tok = (u) => jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET);
  async function call(method, url, { user, body, token } = {}) {
    const h = {};
    if (user) h.Authorization = `Bearer ${tok(user)}`;
    if (token) h.Authorization = `Bearer ${token}`;
    if (body !== undefined) h["Content-Type"] = "application/json";
    const r = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }
  async function snapshot() {
    const out = {};
    for (const c of await mongoose.connection.db.listCollections().toArray()) out[c.name] = await mongoose.connection.db.collection(c.name).countDocuments();
    return out;
  }

  await test("only the owner gets in: anonymous, bad tokens, customers and an employee with every Admin section are refused", async () => {
    assert.strictEqual((await call("GET", "/api/studio-preview/catalog")).status, 401);
    assert.strictEqual((await call("GET", "/api/studio-preview/catalog", { token: "not-a-token" })).status, 401);
    assert.strictEqual((await call("GET", "/api/studio-preview/catalog", { token: jwt.sign({ id: String(owner._id) }, "wrong-secret") })).status, 401);
    assert.strictEqual((await call("GET", "/api/studio-preview/catalog", { user: customer })).status, 403);
    for (const url of ["/api/studio-preview/catalog"]) assert.strictEqual((await call("GET", url, { user: allSections })).status, 403);
    assert.strictEqual((await call("POST", "/api/studio-preview/quote", { user: allSections, body: {} })).status, 403);
    assert.strictEqual((await call("POST", "/api/studio-preview/submit", { user: allSections, body: {} })).status, 403);
    assert.strictEqual((await call("GET", "/api/studio-preview/catalog", { user: owner })).status, 200);
  });

  let cat;
  await test("the owner gets the DEMO catalog only: demo products, DEMO prices note, no images, no costs or real products", async () => {
    const r = await call("GET", "/api/studio-preview/catalog", { user: owner });
    cat = r.body.catalog;
    assert.strictEqual(r.body.preview, true);
    assert.match(r.body.disclaimer, /DEMO PRICE/);
    const t = JSON.stringify(r.body);
    assert.ok(!t.includes("REAL-BAR-1"), "no real catalog product");
    for (const leak of ["priceCents", "costCents", "listPrice", "cloudinary", "salsify", "internalNote"]) assert.ok(!t.includes(leak), leak);
    assert.ok(cat.finishes.length >= 8 && cat.bases.length >= 4 && cat.fixtures.length >= 2 && cat.accessories.length >= 3);
    assert.ok(cat.finishes.every((f) => !f.photo), "no photos at all (drawn swatches)");
  });

  const designFor = (kind, finishIdx = 0) => {
    const base = cat.bases.find((b) => b.kind === kind);
    const fins = cat.finishes.filter((f) => f.kits.some((k) => k.for === kind) && (!f.kits[0].requiresBase || f.kits[0].requiresBase.includes(base.id)));
    const fixture = cat.fixtures.find((f) => f.kind === (kind === "tub" ? "tubShower" : "shower"));
    return { measure: { facingWidth: 30, sideLength: 60, rimHeight: 15, leftWall: true, rightWall: false }, baseId: base.id, drainId: base.drains[0].id, finishId: fins[finishIdx].id, fixtureId: fixture.id, enclosureId: "none", accessories: [] };
  };

  await test("prices recalculate with the design (DEMO prices), and only demo products can be priced", async () => {
    const d1 = designFor("pan", 0);
    const d2 = { ...d1, finishId: designFor("pan", 4).finishId, accessories: [{ key: "a1", productId: cat.accessories.find((a) => a.type === "grabBar").id, wall: "facing", u: 15, y: 36 }] };
    const q1 = await call("POST", "/api/studio-preview/quote", { user: owner, body: { design: d1, projectType: "tub-to-shower" } });
    const q2 = await call("POST", "/api/studio-preview/quote", { user: owner, body: { design: d2, projectType: "tub-to-shower" } });
    assert.strictEqual(q1.status, 200, JSON.stringify(q1.body));
    assert.ok(q1.body.complete && q2.body.complete);
    assert.notStrictEqual(q1.body.totalCents, q2.body.totalCents);
    assert.match(q1.body.message, /DEMO PRICE/);
    const bad = await call("POST", "/api/studio-preview/quote", { user: owner, body: { design: { ...d1, accessories: [{ key: "x", productId: "REAL-BAR-1", wall: "facing", u: 15, y: 36 }] }, projectType: "tub-to-shower" } });
    assert.strictEqual(bad.status, 400);
    assert.ok(!JSON.stringify(bad.body).includes("12345"));
  });

  await test("a test request is checked like a real one, answered with a DEMO reference, and writes NOTHING and sends nothing", async () => {
    const before = await snapshot();
    const d = designFor("tub");
    let r = await call("POST", "/api/studio-preview/submit", { user: owner, body: { state: { design: d }, projectType: "tub-replacement", exampleScene: "example-bathroom-1" } });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.message, /Please enter your name/);
    const form = { name: "Owner Test", phone: "631-555-0142", email: "owner.test@example.com", zip: "11787", consent: true };
    r = await call("POST", "/api/studio-preview/submit", { user: owner, body: { ...form, state: { design: { ...d, fixtureId: cat.fixtures.find((f) => f.kind === "shower").id } }, projectType: "tub-replacement", exampleScene: "example-bathroom-1" } });
    assert.strictEqual(r.status, 400, "a shower trim on a tub is refused");
    assert.match(r.body.message, /can't be installed/);
    r = await call("POST", "/api/studio-preview/submit", { user: owner, body: { ...form, state: { design: d }, projectType: "tub-replacement", exampleScene: "example-bathroom-1" } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.reference, /^DEMO-[0-9A-F]{6}$/);
    assert.deepStrictEqual(await snapshot(), before, "no collection changed");
    assert.strictEqual(sent.length, 0, "no staff email");
  });

  await test("the public Studio stays off while the preview works", async () => {
    const r = await call("GET", "/api/studio/catalog");
    assert.strictEqual(r.body.enabled, false);
    assert.strictEqual((await call("POST", "/api/studio/designs", { body: {} })).status, 404);
    assert.strictEqual((await call("POST", "/api/studio/quote", { body: {} })).status, 404);
  });

  server.close();
  await mongoose.disconnect();
  await mongo.stop();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
