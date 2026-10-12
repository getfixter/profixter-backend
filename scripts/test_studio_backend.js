/**
 * Shower Studio backend: catalog manager, pricing, public designs, private
 * photos, lead submission, staff designs and price adjustments, permissions.
 *
 * In-memory MongoDB, in-memory private storage, the lead email stubbed. No
 * network, no AWS, no real email.
 *   node scripts/test_studio_backend.js
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "studio-test-secret";
process.env.MAIL_ADMIN = "owner@test.local";
process.env.STUDIO_STORAGE = "memory";
process.env.STUDIO_PUBLIC_ENABLED = "true";
process.env.S3_BUCKET = "";

const path = require("path");
const assert = require("assert");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const sharp = require("sharp");
const { MongoMemoryServer } = require("mongodb-memory-server");

// stub the staff email before anything requires it
const sent = [];
const notifierPath = require.resolve(path.join(__dirname, "..", "utils", "adminLeadNotification"));
require.cache[notifierPath] = { id: notifierPath, filename: notifierPath, loaded: true, exports: { sendAdminLeadNotification: async (input) => { sent.push(input); return { ok: true }; } } };

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
  const StudioDesign = require("../models/studio/StudioDesign");
  const StudioPhoto = require("../models/studio/StudioPhoto");
  const EstimateLead = require("../models/EstimateLead");
  const storage = require("../utils/studio/storage");

  const app = express();
  app.use("/api/studio", require("../routes/studioPublic"));
  app.use("/api/admin/studio", require("../routes/adminStudio"));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  const mk = (name, email, role, extra = {}) => User.create({ userId: `u-${email}`, name, email, role, ...extra });
  const owner = await mk("Owner", "owner@test.local", "admin");
  const seller = await mk("Sam Seller", "sam@test.local", "employee", { adminSections: ["studio", "projects"] });
  const pricer = await mk("Pat Pricer", "pat@test.local", "employee", { adminSections: ["studio", "studio-pricing"] });
  const cataloger = await mk("Cat Alog", "cat@test.local", "employee", { adminSections: ["studio-catalog"] });
  const outsider = await mk("Otto", "otto@test.local", "employee", { adminSections: ["leads"] });
  const customer = await mk("Carla Customer", "carla@test.local", "customer");
  const tok = (u) => jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET);

  async function call(method, url, { user, body, headers = {}, form } = {}) {
    const h = { ...headers };
    if (user) h.Authorization = `Bearer ${tok(user)}`;
    let payload;
    if (form) payload = form;
    else if (body !== undefined) { h["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
    const r = await fetch(base + url, { method, headers: h, body: payload });
    const ct = r.headers.get("content-type") || "";
    return { status: r.status, body: ct.includes("json") ? await r.json() : Buffer.from(await r.arrayBuffer()), headers: r.headers };
  }
  const jpeg = async (w = 640, h = 480, withExif = false) => {
    let img = sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 180, b: 120 } } }).jpeg();
    if (withExif) img = img.withMetadata({ exif: { IFD0: { Make: "TestCam", Model: "GPS-Phone" }, IFD3: { GPSLatitudeRef: "N" } } });
    return img.toBuffer();
  };
  const fileForm = (field, buf, name = "photo.jpg", extra = {}) => {
    const f = new FormData();
    f.append(field, new Blob([buf], { type: "image/jpeg" }), name);
    for (const [k, v] of Object.entries(extra)) f.append(k, String(v));
    return f;
  };

  console.log("catalog manager");
  await test("only the owner or a catalog employee can manage the catalog", async () => {
    assert.strictEqual((await call("GET", "/api/admin/studio/products")).status, 401);
    for (const u of [customer, outsider, seller]) assert.strictEqual((await call("GET", "/api/admin/studio/products", { user: u })).status, 403, u.name);
    assert.strictEqual((await call("GET", "/api/admin/studio/products", { user: cataloger })).status, 200);
    assert.strictEqual((await call("GET", "/api/admin/studio/products", { user: owner })).status, 200);
  });

  await test("starter import adds the researched products as unpriced drafts; public sees nothing yet", async () => {
    const r = await call("POST", "/api/admin/studio/catalog/import-starter", { user: owner });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.added >= 25, JSON.stringify(r.body));
    const again = await call("POST", "/api/admin/studio/catalog/import-starter", { user: owner });
    assert.strictEqual(again.body.added, 0, "import is idempotent");
    const pub = await call("GET", "/api/studio/catalog");
    assert.strictEqual(pub.body.catalog.finishes.length, 0, "drafts are not public");
  });

  let productId;
  await test("creating a product is validated field by field", async () => {
    const bad = await call("POST", "/api/admin/studio/products", { user: cataloger, body: { sku: "bad sku!", category: "accessory", type: "grabBar", name: "", engine: { length: 900 } } });
    assert.strictEqual(bad.status, 400);
    const fields = bad.body.errors.map((e) => e.field);
    assert.ok(fields.includes("sku") && fields.includes("name") && fields.includes("length"), fields.join());
    const ok = await call("POST", "/api/admin/studio/products", { user: cataloger, body: { sku: "test-bar-18", category: "accessory", type: "grabBar", name: "Test 18in grab bar", manufacturer: "Acme", model: "GB18", engine: { length: 18, diameter: 1.25, clearance: 1.5, flange: 3, finishColor: "#c9ccce", roughness: 0.3 }, pricing: { priceCents: 8900, installCents: 6000 } } });
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
    assert.strictEqual(ok.body.product.status, "draft");
    productId = ok.body.product._id;
    const dup = await call("POST", "/api/admin/studio/products", { user: cataloger, body: { sku: "test-bar-18", category: "accessory", type: "grabBar", name: "Dup", engine: { length: 18, diameter: 1.25, clearance: 1.5, flange: 3, finishColor: "#c9ccce", roughness: 0.3 } } });
    assert.strictEqual(dup.status, 409);
  });

  await test("product photos and textures: real images only, re-encoded, served by an unguessable id", async () => {
    const notImage = await call("POST", `/api/admin/studio/products/${productId}/assets`, { user: owner, form: fileForm("file", Buffer.from("<html>not a photo</html>"), "x.jpg") });
    assert.strictEqual(notImage.status, 400);
    const texOnBar = await call("POST", `/api/admin/studio/products/${productId}/assets`, { user: owner, form: fileForm("file", await jpeg(), "t.jpg", { kind: "texture", widthIn: 12, heightIn: 12 }) });
    assert.strictEqual(texOnBar.status, 400, "textures are for walls");
    const up = await call("POST", `/api/admin/studio/products/${productId}/assets`, { user: owner, form: fileForm("file", await jpeg(800, 600, true)) });
    assert.strictEqual(up.status, 201, JSON.stringify(up.body));
    const url = up.body.product.assets.photos[0].url;
    assert.match(url, /^\/api\/studio\/assets\/[A-Za-z0-9_-]{20,}$/);
    const img = await call("GET", url);
    assert.strictEqual(img.status, 200);
    assert.strictEqual(img.headers.get("content-type"), "image/jpeg");
    const meta = await sharp(img.body).metadata();
    assert.strictEqual(meta.exif, undefined, "camera metadata stripped");
    const keys = [...storage._memory.keys()];
    assert.ok(keys.every((k) => k.startsWith("private/studio/")), keys.join());
  });

  await test("publishing needs complete visualization details; the public catalog never contains prices", async () => {
    const all = (await call("GET", "/api/admin/studio/products", { user: owner })).body.products;
    for (const p of all) {
      const r = await call("POST", `/api/admin/studio/products/${p._id}/status`, { user: owner, body: { status: "published" } });
      assert.strictEqual(r.status, 200, `${p.sku}: ${JSON.stringify(r.body)}`);
    }
    const broken = await StudioProduct.create({ sku: "broken-kit", category: "wall", type: "pan", name: "Broken", engine: { color: "#ffffff" } });
    const r = await call("POST", `/api/admin/studio/products/${broken._id}/status`, { user: owner, body: { status: "published" } });
    assert.strictEqual(r.status, 400);
    const pub = await call("GET", "/api/studio/catalog");
    assert.ok(pub.body.catalog.finishes.length >= 5 && pub.body.catalog.accessories.some((a) => a.id === "test-bar-18"));
    const text = JSON.stringify(pub.body);
    assert.ok(!/priceCents|installCents|internalNote|pricing/.test(text), "no prices or internal notes in the public catalog");
  });

  console.log("pricing");
  const baseDesign = {
    measure: { facingWidth: 30, sideLength: 60, rimHeight: 15, leftWall: true, rightWall: false, aboveMode: "keep" },
    baseId: "slimline-6030", drainId: "end", finishId: "qwall-vs-white", fixtureId: "delta-bt13210", enclosureId: "none", curtain: false, accessories: [],
  };
  await test("unpriced designs are incomplete: no total, and the public is told the price will be confirmed", async () => {
    const r = await call("POST", "/api/studio/quote", { body: { design: baseDesign, projectType: "tub-to-shower" } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.complete, false);
    assert.strictEqual(r.body.totalCents, null);
    assert.match(r.body.message, /confirm/);
    assert.ok(!JSON.stringify(r.body).includes("Base price"), "missing-price details are internal");
  });

  await test("only catalog staff may change prices", async () => {
    assert.strictEqual((await call("PUT", "/api/admin/studio/pricing", { user: seller, body: { maxDiscountPercent: 90 } })).status, 403);
    assert.strictEqual((await call("PUT", "/api/admin/studio/products/" + productId, { user: pricer, body: { pricing: { priceCents: 1 } } })).status, 403);
  });

  await test("with prices set the total is exact: base + products + install + automatic adders", async () => {
    const pricing = (await call("GET", "/api/admin/studio/pricing", { user: owner })).body.pricing;
    pricing.projectTypes.find((t) => t.key === "tub-to-shower").basePriceCents = 450000;
    pricing.projectTypes.find((t) => t.key === "tub-replacement").basePriceCents = 520000;
    for (const a of pricing.adders) a.priceCents = { "paint-above": 60000, "door-install": 25000, "grab-bar-blocking": 15000, "seat-backing": 20000, "valve-relocation": 50000 }[a.key];
    pricing.packages = [{ key: "safety", name: "Safety package", skus: ["moen-8724", "moen-dn7110"], priceCents: 30000, isPublic: true }];
    const put = await call("PUT", "/api/admin/studio/pricing", { user: owner, body: pricing });
    assert.strictEqual(put.status, 200, JSON.stringify(put.body));
    const prices = { "slimline-6030": 89000, "qwall-vs-white": 120000, "delta-bt13210": 32000, "duet-6072": 95000, "moen-8724": 9000, "moen-dn7110": 45000, "qwall-tub-white": 110000, "dreamline-prism-6030": 98000, "delta-bt13410": 36000 };
    for (const p of await StudioProduct.find({ sku: { $in: Object.keys(prices) } })) {
      const r = await call("PUT", `/api/admin/studio/products/${p._id}`, { user: cataloger, body: { pricing: { priceCents: prices[p.sku], installCents: 0 } } });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    }
    const q = await call("POST", "/api/studio/quote", { body: { design: baseDesign, projectType: "tub-to-shower" } });
    assert.strictEqual(q.body.complete, true, JSON.stringify(q.body));
    assert.strictEqual(q.body.totalCents, 450000 + 89000 + 120000 + 32000);
    const withDoor = await call("POST", "/api/studio/quote", { body: { design: { ...baseDesign, enclosureId: "duet-6072", measure: { ...baseDesign.measure, aboveMode: "paint" } }, projectType: "tub-to-shower" } });
    assert.strictEqual(withDoor.body.totalCents, 450000 + 89000 + 120000 + 32000 + 95000 + 25000 + 60000);
    const pkg = await call("POST", "/api/studio/quote", { body: { design: { ...baseDesign, accessories: [{ key: "g", productId: "moen-8724", wall: "left", u: 30, y: 35.5 }, { key: "s", productId: "moen-dn7110", wall: "left", u: 45, y: 19 }] }, projectType: "tub-to-shower" } });
    assert.strictEqual(pkg.body.totalCents, 450000 + 89000 + 120000 + 32000 + 30000 + 15000 + 20000, "package replaces the two item prices; per-item adders still apply");
  });

  await test("a price sent by the browser is ignored: the server prices from the catalog", async () => {
    const q = await call("POST", "/api/studio/quote", { body: { design: { ...baseDesign, priceCents: 1, totalCents: 1 }, projectType: "tub-to-shower", totalCents: 1 } });
    assert.strictEqual(q.body.totalCents, 691000);
  });

  console.log("public designs and private photos");
  let pub;
  await test("a visitor starts a design without an account; nobody else can open it", async () => {
    const r = await call("POST", "/api/studio/designs", { body: { projectType: "tub-to-shower" } });
    assert.strictEqual(r.status, 201);
    pub = r.body;
    assert.ok(pub.token.length >= 30);
    assert.strictEqual((await call("GET", `/api/studio/designs/${pub.id}`)).status, 404);
    assert.strictEqual((await call("GET", `/api/studio/designs/${pub.id}`, { headers: { "x-studio-token": "x".repeat(32) } })).status, 404);
    assert.strictEqual((await call("GET", `/api/studio/designs/${pub.id}`, { headers: { "x-studio-token": pub.token } })).status, 200);
    const stored = await StudioDesign.findOne({ publicId: pub.id }).lean();
    assert.notStrictEqual(stored.editTokenHash, pub.token, "only the token's hash is stored");
  });

  let photoUrl;
  await test("photo upload: validated, metadata stripped, stored privately, readable only by a signed expiring link", async () => {
    const bad = await call("POST", `/api/studio/designs/${pub.id}/photo`, { headers: { "x-studio-token": pub.token }, form: fileForm("photo", Buffer.from("%PDF-1.4 fake"), "a.pdf") });
    assert.strictEqual(bad.status, 400);
    const r = await call("POST", `/api/studio/designs/${pub.id}/photo`, { headers: { "x-studio-token": pub.token }, form: fileForm("photo", await jpeg(3000, 4000, true)) });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.photo.height, 1600, "downscaled to 1600 px");
    photoUrl = r.body.photo.url;
    const img = await call("GET", photoUrl);
    assert.strictEqual(img.status, 200);
    assert.strictEqual((await sharp(img.body).metadata()).exif, undefined, "no EXIF / GPS");
    assert.match(img.headers.get("cache-control"), /private/);
    const tampered = photoUrl.replace(/sig=[^&]+/, "sig=AAAA");
    assert.strictEqual((await call("GET", tampered)).status, 403);
    const extended = photoUrl.replace(/exp=(\d+)/, (_, e) => `exp=${Number(e) + 3600}`);
    assert.strictEqual((await call("GET", extended)).status, 403, "expiry cannot be extended");
    const expired = photoUrl.replace(/exp=(\d+)/, "exp=1000");
    assert.strictEqual((await call("GET", expired)).status, 403);
    const other = await StudioPhoto.findOne({}).lean();
    assert.ok(other.storageKey.startsWith("private/studio/photos/"), other.storageKey);
  });

  const stateFor = (photo, design = baseDesign) => ({
    marks: { wallTL: [220, 160], wallTR: [444, 140], wallBL: [221, 703], wallBR: [412, 748] },
    points: { valve: [318, 628], head: [323, 163] },
    design,
    masks: { remove: { length: photo.width * photo.height, first: 0, runs: [photo.width * photo.height] }, keep: null },
    autoRemove: true,
  });
  await test("saving a design validates it (bad masks, missing dots, oversized)", async () => {
    const photo = { width: 1200, height: 1600 };
    const h = { "x-studio-token": pub.token };
    assert.strictEqual((await call("PUT", `/api/studio/designs/${pub.id}`, { headers: h, body: { state: { ...stateFor(photo), marks: {} } } })).status, 400);
    assert.strictEqual((await call("PUT", `/api/studio/designs/${pub.id}`, { headers: h, body: { state: { ...stateFor(photo), masks: { remove: { length: 5, first: 0, runs: [5] } } } } })).status, 400);
    const huge = await fetch(`${base}/api/studio/designs/${pub.id}`, { method: "PUT", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify({ state: stateFor(photo), pad: "x".repeat(700 * 1024) }) });
    assert.strictEqual(huge.status, 413, "body limit");
    const ok = await call("PUT", `/api/studio/designs/${pub.id}`, { headers: h, body: { state: stateFor(photo), projectType: "tub-to-shower" } });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  });

  await test("submitting: validation, too-fast bots, honeypot", async () => {
    const h = { "x-studio-token": pub.token };
    const v = await call("POST", `/api/studio/designs/${pub.id}/submit`, { headers: h, body: { name: "A", email: "nope", phone: "12", zip: "1", consent: false } });
    assert.strictEqual(v.status, 400);
    const fields = v.body.errors.map((e) => e.field);
    for (const f of ["name", "email", "phone", "zip", "consent"]) assert.ok(fields.includes(f), f);
    const fast = await call("POST", `/api/studio/designs/${pub.id}/submit`, { headers: h, body: { name: "Hannah Home", email: "hannah@example.com", phone: "631-555-0100", zip: "11787", consent: true } });
    assert.strictEqual(fast.status, 400, "submitted seconds after starting");
    await StudioDesign.collection.updateOne({ publicId: pub.id }, { $set: { createdAt: new Date(Date.now() - 120000) } });
    const bot = await call("POST", `/api/studio/designs/${pub.id}/submit`, { headers: h, body: { name: "Bot", email: "bot@example.com", phone: "6315550100", zip: "11787", consent: true, website: "http://spam" } });
    assert.strictEqual(bot.status, 200);
    assert.strictEqual(await EstimateLead.countDocuments({}), 0, "honeypot: no lead");
  });

  await test("a valid request creates ONE lead, notifies staff once, freezes the price; repeats are idempotent", async () => {
    const h = { "x-studio-token": pub.token };
    const body = { name: "Hannah Home", email: "Hannah@Example.com", phone: "631-555-0100", zip: "11787", address: "12 Elm St, Smithtown NY", consent: true, notes: "Prefer mornings" };
    const r = await call("POST", `/api/studio/designs/${pub.id}/submit`, { headers: h, body });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const again = await call("POST", `/api/studio/designs/${pub.id}/submit`, { headers: h, body });
    assert.strictEqual(again.body.alreadySubmitted, true);
    const leads = await EstimateLead.find({}).lean();
    assert.strictEqual(leads.length, 1);
    assert.strictEqual(leads[0].service, "bathroom");
    assert.strictEqual(leads[0].source, "shower_studio");
    assert.strictEqual(leads[0].email, "hannah@example.com");
    assert.strictEqual(leads[0].estimateLow, 6910);
    assert.ok(leads[0].studioDesignId);
    assert.strictEqual(sent.length, 1, "one staff notification");
    const d = await StudioDesign.findOne({ publicId: pub.id }).lean();
    assert.strictEqual(d.status, "submitted");
    assert.strictEqual(d.priceSnapshot.totalCents, 691000);
    assert.ok(d.selections.some((s) => s.sku === "qwall-vs-white" && s.name));
    const edit = await call("PUT", `/api/studio/designs/${pub.id}`, { headers: h, body: { state: stateFor({ width: 1200, height: 1600 }) } });
    assert.strictEqual(edit.status, 409, "no edits after sending");
  });

  await test("later catalog price changes never alter a submitted request's price", async () => {
    const p = await StudioProduct.findOne({ sku: "qwall-vs-white" });
    await call("PUT", `/api/admin/studio/products/${p._id}`, { user: owner, body: { pricing: { priceCents: 999999 } } });
    const d = await StudioDesign.findOne({ publicId: pub.id }).lean();
    assert.strictEqual(d.priceSnapshot.totalCents, 691000);
    await call("PUT", `/api/admin/studio/products/${p._id}`, { user: owner, body: { pricing: { priceCents: 120000 } } });
  });

  await test("an incompatible combination cannot be submitted", async () => {
    const r = await call("POST", "/api/studio/designs", { body: {} });
    const h = { "x-studio-token": r.body.token };
    await call("POST", `/api/studio/designs/${r.body.id}/photo`, { headers: h, form: fileForm("photo", await jpeg()) });
    // a tub-only wall kit over a shower pan
    await call("PUT", `/api/studio/designs/${r.body.id}`, { headers: h, body: { state: stateFor({ width: 640, height: 480 }, { ...baseDesign, finishId: "qwall-tub-white" }) } });
    await StudioDesign.collection.updateOne({ publicId: r.body.id }, { $set: { createdAt: new Date(Date.now() - 120000) } });
    const s = await call("POST", `/api/studio/designs/${r.body.id}/submit`, { headers: h, body: { name: "Ivy", email: "ivy@example.com", phone: "6315550101", zip: "11787", consent: true } });
    assert.strictEqual(s.status, 400);
    assert.match(s.body.message, /can't be installed/);
  });

  await test("a visitor can delete their unsent design: the photo is erased", async () => {
    const r = await call("POST", "/api/studio/designs", { body: {} });
    const h = { "x-studio-token": r.body.token };
    await call("POST", `/api/studio/designs/${r.body.id}/photo`, { headers: h, form: fileForm("photo", await jpeg()) });
    const d = await StudioDesign.findOne({ publicId: r.body.id }).lean();
    const ph = await StudioPhoto.findById(d.photo).lean();
    assert.ok(storage._memory.has(ph.storageKey));
    assert.strictEqual((await call("DELETE", `/api/studio/designs/${r.body.id}`, { headers: h })).status, 200);
    assert.ok(!storage._memory.has(ph.storageKey), "file deleted");
    assert.strictEqual(await StudioDesign.countDocuments({ publicId: r.body.id }), 0);
  });

  console.log("staff studio");
  await test("staff see submitted requests but never a visitor's unsent draft; outsiders see nothing", async () => {
    const draft = await call("POST", "/api/studio/designs", { body: {} });
    const list = await call("GET", "/api/admin/studio/designs", { user: seller });
    assert.strictEqual(list.status, 200);
    const ids = list.body.designs.map((d) => d.id);
    assert.ok(ids.includes(pub.id));
    assert.ok(!ids.includes(draft.body.id));
    assert.strictEqual((await call("GET", `/api/admin/studio/designs/${draft.body.id}`, { user: owner })).status, 404);
    assert.strictEqual((await call("GET", "/api/admin/studio/designs", { user: outsider })).status, 403);
    assert.strictEqual((await call("GET", "/api/admin/studio/designs", { user: cataloger })).status, 403);
    const lead = await EstimateLead.findOne({}).lean();
    const byLead = await call("GET", `/api/admin/studio/designs/by-lead/${lead._id}`, { user: seller });
    assert.strictEqual(byLead.body.id, pub.id);
  });

  await test("staff open the request: full price lines, a fresh signed photo link, compatibility", async () => {
    const r = await call("GET", `/api/admin/studio/designs/${pub.id}`, { user: seller });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.live.lines.length >= 4);
    assert.match(r.body.design.photo.url, /sig=/);
    assert.strictEqual(r.body.compat.ok, true);
    assert.strictEqual(r.body.can.adjust, false);
    assert.strictEqual(r.body.can.propose, true);
  });

  await test("staff edits (verified measurements) are saved as revisions and re-priced", async () => {
    const r = await call("GET", `/api/admin/studio/designs/${pub.id}`, { user: seller });
    const state = r.body.design.state;
    state.design.measure.facingWidth = 30.25;
    state.design.enclosureId = "duet-6072";
    const put = await call("PUT", `/api/admin/studio/designs/${pub.id}`, { user: seller, body: { state, note: "Measured on site" } });
    assert.strictEqual(put.status, 200, JSON.stringify(put.body));
    assert.strictEqual(put.body.design.status, "in_review");
    assert.strictEqual(put.body.design.revisions.length, 1);
    assert.strictEqual(put.body.design.priceSnapshot.totalCents, 691000 + 95000 + 25000);
  });

  await test("price adjustments: only with permission, with a reason, discounts capped for employees", async () => {
    const id = pub.id;
    assert.strictEqual((await call("POST", `/api/admin/studio/designs/${id}/adjustments`, { user: seller, body: { kind: "discount", percent: 5, reason: "Loyal customer" } })).status, 403);
    assert.strictEqual((await call("POST", `/api/admin/studio/designs/${id}/adjustments`, { user: pricer, body: { kind: "discount", percent: 5, reason: "" } })).status, 400);
    assert.strictEqual((await call("POST", `/api/admin/studio/designs/${id}/adjustments`, { user: pricer, body: { kind: "discount", percent: 40, reason: "Too much" } })).status, 403);
    const ok = await call("POST", `/api/admin/studio/designs/${id}/adjustments`, { user: pricer, body: { kind: "discount", percent: 10, reason: "Spring promotion" } });
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
    assert.strictEqual(ok.body.design.priceSnapshot.totalCents, Math.round(811000 * 0.9));
    const adder = await call("POST", `/api/admin/studio/designs/${id}/adjustments`, { user: seller, body: { kind: "adder", key: "valve-relocation", reason: "Valve too low" } });
    assert.strictEqual(adder.status, 201, "manual adders only need studio.sell");
    const ownerBig = await call("POST", `/api/admin/studio/designs/${id}/adjustments`, { user: owner, body: { kind: "override", amountCents: 700000, reason: "Owner's price" } });
    assert.strictEqual(ownerBig.status, 201);
    assert.strictEqual(ownerBig.body.design.priceSnapshot.totalCents, Math.round(700000 * 0.9));
  });

  await test("staff can start a design for an existing customer", async () => {
    const r = await call("POST", "/api/admin/studio/designs", { user: seller, body: { customerId: String(customer._id), customer: { name: "Carla Customer", email: "carla@test.local", phone: "6315550199" }, projectType: "tub-replacement" } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.design.origin, "staff");
    assert.strictEqual(r.body.design.projectType, "tub-replacement");
    const up = await call("POST", `/api/admin/studio/designs/${r.body.design.id}/photo`, { user: seller, form: fileForm("photo", await jpeg()) });
    assert.strictEqual(up.status, 201);
  });

  console.log("no photo, no measurements (example bathroom)");
  await test("price labels: always an ESTIMATE, its basis stated, never called verified", async () => {
    const std = await call("POST", "/api/studio/quote", { body: { design: baseDesign, projectType: "tub-to-shower", measureSource: "standard" } });
    assert.strictEqual(std.body.complete, true);
    assert.strictEqual(std.body.label, "Estimated total");
    assert.match(std.body.basis, /standard 60″ × 30″ example size, not your measurements/);
    const cust = await call("POST", "/api/studio/quote", { body: { design: baseDesign, projectType: "tub-to-shower", measureSource: "customer" } });
    assert.match(cust.body.basis, /measurements you entered/);
    const tampered = await call("POST", "/api/studio/quote", { body: { design: baseDesign, projectType: "tub-to-shower", measureSource: "verified" } });
    assert.match(tampered.body.basis, /standard/, "the public cannot claim verified measurements");
    for (const r of [std, cust, tampered]) assert.ok(!/verif/i.test(JSON.stringify(r.body)), JSON.stringify(r.body));
  });

  await test("incomplete prices: no number at all, exactly 'Price confirmed after review.'", async () => {
    await StudioProduct.create({ sku: "unpriced-bar", category: "accessory", type: "grabBar", name: "Unpriced bar", status: "published", engine: { length: 24, diameter: 1.25, clearance: 1.5, flange: 3, finishColor: "#cccccc", roughness: 0.3 } });
    const r = await call("POST", "/api/studio/quote", { body: { design: { ...baseDesign, accessories: [{ key: "u", productId: "unpriced-bar", wall: "left", u: 30, y: 35.5 }] }, projectType: "tub-to-shower" } });
    assert.strictEqual(r.body.complete, false);
    assert.strictEqual(r.body.message, "Price confirmed after review.");
    assert.strictEqual(r.body.totalCents, null);
    assert.strictEqual(r.body.display, null);
    assert.strictEqual(r.body.label, null);
    assert.ok(!/\$\d/.test(JSON.stringify(r.body)), "no dollar amount anywhere");
  });

  const exampleState = (design) => stateFor({ width: 681, height: 1023 }, design);
  await test("an unknown example bathroom is refused", async () => {
    const r = await call("POST", "/api/studio/designs", { body: {} });
    const s = await call("PUT", `/api/studio/designs/${r.body.id}`, { headers: { "x-studio-token": r.body.token }, body: { exampleScene: "../../etc/passwd", state: exampleState(baseDesign) } });
    assert.strictEqual(s.status, 400);
  });

  await test("without a photo or an example bathroom a request cannot be sent", async () => {
    const r = await call("POST", "/api/studio/designs", { body: {} });
    const h = { "x-studio-token": r.body.token };
    await call("PUT", `/api/studio/designs/${r.body.id}`, { headers: h, body: { state: exampleState(baseDesign) } });
    await StudioDesign.collection.updateOne({ publicId: r.body.id }, { $set: { createdAt: new Date(Date.now() - 120000) } });
    const s = await call("POST", `/api/studio/designs/${r.body.id}/submit`, { headers: h, body: { name: "Nora", email: "nora@example.com", phone: "6315550111", zip: "11787", consent: true } });
    assert.strictEqual(s.status, 400);
    assert.match(s.body.message, /Finish your design/);
  });

  let exampleId;
  await test("a complete request with NO photo and NO measurements (example bathroom, standard size)", async () => {
    const leadsBefore = await EstimateLead.countDocuments({});
    const r = await call("POST", "/api/studio/designs", { body: { exampleScene: "example-bathroom-1", measureSource: "standard", projectType: "tub-to-shower" } });
    assert.strictEqual(r.status, 201);
    exampleId = r.body.id;
    const h = { "x-studio-token": r.body.token };
    const put = await call("PUT", `/api/studio/designs/${r.body.id}`, { headers: h, body: { state: exampleState({ ...baseDesign, enclosureId: "duet-6072" }), measureSource: "standard" } });
    assert.strictEqual(put.status, 200, JSON.stringify(put.body));
    await StudioDesign.collection.updateOne({ publicId: r.body.id }, { $set: { createdAt: new Date(Date.now() - 120000) } });
    const s = await call("POST", `/api/studio/designs/${r.body.id}/submit`, { headers: h, body: { name: "Erin Example", email: "erin@example.com", phone: "6315550123", zip: "11787", consent: true } });
    assert.strictEqual(s.status, 200, JSON.stringify(s.body));
    assert.strictEqual(await EstimateLead.countDocuments({}), leadsBefore + 1);
    const lead = await EstimateLead.findOne({ email: "erin@example.com" }).lean();
    assert.match(lead.notes, /No photo: designed on the example bathroom/);
    assert.match(lead.notes, /Standard example size \(not measured\)/);
    const d = await StudioDesign.findOne({ publicId: r.body.id }).lean();
    assert.strictEqual(d.photo, null);
    assert.strictEqual(d.exampleScene, "example-bathroom-1");
    assert.strictEqual(d.measureSource, "standard");
    assert.ok(d.priceSnapshot.complete);
  });

  await test("staff see 'standard example size' and can mark the measurements verified on site", async () => {
    const v = await call("GET", `/api/admin/studio/designs/${exampleId}`, { user: seller });
    assert.strictEqual(v.status, 200);
    assert.strictEqual(v.body.design.exampleScene, "example-bathroom-1");
    assert.strictEqual(v.body.design.measureLabel, "Standard example size (not measured)");
    const state = v.body.design.state;
    state.design.measure.facingWidth = 31;
    const put = await call("PUT", `/api/admin/studio/designs/${exampleId}`, { user: seller, body: { state, measureSource: "verified", note: "Measured on site" } });
    assert.strictEqual(put.status, 200, JSON.stringify(put.body));
    assert.strictEqual(put.body.design.measureLabel, "Verified on site by Profixter");
  });

  console.log("dark launch and access");
  await test("public Studio switched OFF: empty disabled catalog, and nothing can be created, quoted or sent", async () => {
    process.env.STUDIO_PUBLIC_ENABLED = "false";
    try {
      const c = await call("GET", "/api/studio/catalog");
      assert.strictEqual(c.status, 200);
      assert.strictEqual(c.body.enabled, false);
      assert.strictEqual(c.body.catalog.finishes.length, 0);
      for (const [m, u, body] of [["POST", "/api/studio/designs", {}], ["POST", "/api/studio/quote", { design: baseDesign }], ["POST", `/api/studio/designs/${pub.id}/submit`, {}], ["PUT", `/api/studio/designs/${pub.id}`, {}]]) {
        const r = await call(m, u, { body });
        assert.strictEqual(r.status, 404, `${m} ${u} -> ${r.status}`);
      }
      // Admin keeps working while the public side is off
      assert.strictEqual((await call("GET", "/api/admin/studio/designs", { user: seller })).status, 200);
      assert.strictEqual((await call("GET", "/api/admin/studio/products", { user: owner })).status, 200);
    } finally {
      process.env.STUDIO_PUBLIC_ENABLED = "true";
    }
  });

  await test("an unpublished product can never be priced or used from outside", async () => {
    const draft = await StudioProduct.create({ sku: "secret-draft-bar", category: "accessory", type: "grabBar", name: "Secret draft bar", status: "draft", engine: { length: 24, diameter: 1.25, clearance: 1.5, flange: 3, finishColor: "#cccccc", roughness: 0.3 }, pricing: { priceCents: 123456 } });
    const design = { ...baseDesign, accessories: [{ key: "s", productId: draft.sku, wall: "left", u: 30, y: 35.5 }] };
    const q = await call("POST", "/api/studio/quote", { body: { design, projectType: "tub-to-shower" } });
    assert.strictEqual(q.status, 400);
    assert.ok(!JSON.stringify(q.body).includes("1234"), "no price leaked");
    const hidden = await StudioProduct.create({ sku: "staff-only-bar", category: "accessory", type: "grabBar", name: "Staff only", status: "published", isPublic: false, engine: draft.engine, pricing: { priceCents: 5000 } });
    const q2 = await call("POST", "/api/studio/quote", { body: { design: { ...baseDesign, accessories: [{ key: "s", productId: hidden.sku, wall: "left", u: 30, y: 35.5 }] }, projectType: "tub-to-shower" } });
    assert.strictEqual(q2.status, 400, "published but hidden from the website is not public either");
    const r = await call("POST", "/api/studio/designs", { body: {} });
    const s = await call("PUT", `/api/studio/designs/${r.body.id}`, { headers: { "x-studio-token": r.body.token }, body: { state: stateFor({ width: 1, height: 1 }, design) } });
    assert.ok(s.status === 400, `save with a draft product -> ${s.status}`);
  });

  await test("only the owner sees the new sections at first: an employee with EVERY existing section is refused", async () => {
    const legacy = ["overview", "customer-map", "members", "customers", "leads", "projects", "jobs", "schedule", "recent-work", "communications", "promotion", "blacklist", "activity"];
    const veteran = await mk("Vera Veteran", "vera@test.local", "employee", { adminSections: legacy });
    for (const u of ["/api/admin/studio/designs", "/api/admin/studio/products", "/api/admin/studio/pricing", "/api/admin/studio/catalog/completeness"]) {
      assert.strictEqual((await call("GET", u, { user: veteran })).status, 403, u);
    }
    const { permissionsForSections } = require("../utils/adminAccess");
    const perms = [...permissionsForSections(legacy)];
    assert.ok(!perms.some((p) => p.startsWith("studio.")), perms.join());
  });

  await test("the photo-link key: dedicated secret preferred, too-short refused, never logged", async () => {
    const sl = require("../utils/studio/signedLinks");
    const keep = process.env.STUDIO_LINK_SECRET;
    try {
      delete process.env.STUDIO_LINK_SECRET;
      assert.strictEqual(sl.secretSource(), "derived-from-jwt-secret");
      process.env.STUDIO_LINK_SECRET = "short";
      assert.strictEqual(sl.secretSource(), "dedicated-too-short");
      assert.throws(() => sl.photoUrl("abc"), /at least 32/);
      process.env.STUDIO_LINK_SECRET = "x".repeat(40);
      assert.strictEqual(sl.secretSource(), "dedicated");
      const url = sl.photoUrl("abc");
      assert.ok(!url.includes("xxxx"));
    } finally {
      if (keep === undefined) delete process.env.STUDIO_LINK_SECRET; else process.env.STUDIO_LINK_SECRET = keep;
    }
  });

  console.log("retention");
  await test("abandoned drafts are deleted with their photos; old requests keep the record but lose the photos", async () => {
    const { sweepStudioRetention } = require("../utils/studio/retention");
    const r = await call("POST", "/api/studio/designs", { body: {} });
    await call("POST", `/api/studio/designs/${r.body.id}/photo`, { headers: { "x-studio-token": r.body.token }, form: fileForm("photo", await jpeg()) });
    const draft = await StudioDesign.findOne({ publicId: r.body.id }).lean();
    const draftPhoto = await StudioPhoto.findById(draft.photo).lean();
    await StudioDesign.collection.updateOne({ _id: draft._id }, { $set: { deleteAfter: new Date(Date.now() - 1000) } });
    const old = await StudioDesign.findOne({ publicId: pub.id }).lean();
    const oldPhoto = await StudioPhoto.findById(old.photo).lean();
    await StudioDesign.collection.updateOne({ _id: old._id }, { $set: { deleteAfter: new Date(Date.now() - 1000) } });
    const out = await sweepStudioRetention();
    assert.ok(out.draftsDeleted >= 1);
    assert.strictEqual(await StudioDesign.countDocuments({ _id: draft._id }), 0);
    assert.ok(!storage._memory.has(draftPhoto.storageKey));
    const kept = await StudioDesign.findById(old._id).lean();
    assert.ok(kept && kept.customer.email === "hannah@example.com" && kept.priceSnapshot, "the request record stays");
    assert.strictEqual(kept.photo, null);
    assert.ok(!storage._memory.has(oldPhoto.storageKey));
    assert.ok(await EstimateLead.exists({ studioDesignId: old._id }), "the lead stays");
  });

  server.close();
  await mongoose.disconnect();
  await mongo.stop();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
