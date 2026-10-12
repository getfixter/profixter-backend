/**
 * Shower Studio manufacturer catalog (Swan): reading the price file, preview
 * and apply, safe re-imports, owner prices kept, discontinued/unlisted
 * marking, adding variants to the Studio as drafts, publish rules, image
 * rights, link checks, colours/textures, permissions, and that nothing
 * private reaches the public Studio.
 *
 * In-memory MongoDB and storage; manufacturer links are never contacted (the
 * fetch used for link checks and image copies is stubbed).
 *   node scripts/test_studio_manufacturer_import.js
 * With the real Swan file present at catalog-imports/swan-epf-*.xlsx, the
 * whole workbook is also previewed and applied.
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "studio-test-secret";
process.env.MAIL_ADMIN = "owner@test.local";
process.env.STUDIO_STORAGE = "memory";
process.env.STUDIO_PUBLIC_ENABLED = "true";
process.env.S3_BUCKET = "";

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const sharp = require("sharp");
const ExcelJS = require("exceljs");
const { MongoMemoryServer } = require("mongodb-memory-server");

const FIXTURE = path.join(__dirname, "fixtures", "swan-epf-sample.xlsx");

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failures.push(name); console.log(`  FAIL  ${name}\n        ${e.stack.split("\n").slice(0, 4).join("\n        ")}`); }
}

/** A copy of the fixture with edits: { price: {part: dollars}, drop: [parts], discontinue: [parts] } */
async function variantWorkbook({ price = {}, drop = [], discontinue = [] } = {}) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(FIXTURE);
  for (const ws of wb.worksheets) {
    const head = ws.getRow(1).values;
    const ip = head.indexOf("Sellable Part Number"), ipr = head.indexOf("List Price");
    const remove = [];
    ws.eachRow((row, n) => {
      if (n === 1) return;
      const part = String(row.getCell(ip).value);
      if (price[part] !== undefined && ipr > 0) row.getCell(ipr).value = String(price[part]);
      if (drop.includes(part) && !/discontinu/i.test(ws.name)) remove.push(n);
    });
    for (const n of remove.reverse()) ws.spliceRows(n, 1);
    if (/discontinu/i.test(ws.name)) for (const part of discontinue) { const r = []; r[ip] = part; r[head.indexOf("Brand")] = "Swan"; r[head.indexOf("Discontinuation Date")] = "2026-09-30"; ws.addRow(r.slice(1)); }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const User = require("../models/User");
  const StudioProduct = require("../models/studio/StudioProduct");
  const StudioSupplierItem = require("../models/studio/StudioSupplierItem");
  const StudioCatalogImport = require("../models/studio/StudioCatalogImport");
  const StudioMediaCheck = require("../models/studio/StudioMediaCheck");
  const StudioAsset = require("../models/studio/StudioAsset");
  const StudioPricing = require("../models/studio/StudioPricing");
  const media = require("../utils/studio/manufacturers/media");
  const { parseCatalogFile } = require("../utils/studio/manufacturers");
  const { toEngineCatalog, validateEngine } = require("../utils/studio/catalogFields");
  const { invalidate } = require("../utils/studio/catalogService");

  const app = express();
  app.use("/api/studio", require("../routes/studioPublic"));
  app.use("/api/admin/studio", require("../routes/adminStudio"));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  const mk = (name, email, role, extra = {}) => User.create({ userId: `u-${email}`, name, email, role, ...extra });
  const owner = await mk("Owner", "owner@test.local", "admin");
  const cataloger = await mk("Cat Alog", "cat@test.local", "employee", { adminSections: ["studio-catalog"] });
  const seller = await mk("Sam Seller", "sam@test.local", "employee", { adminSections: ["studio", "projects"] });
  const outsider = await mk("Otto", "otto@test.local", "employee", { adminSections: ["leads"] });
  const customer = await mk("Carla", "carla@test.local", "customer");
  const tok = (u) => jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET);

  async function call(method, url, { user, body, form } = {}) {
    const h = {};
    if (user) h.Authorization = `Bearer ${tok(user)}`;
    let payload;
    if (form) payload = form;
    else if (body !== undefined) { h["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
    const r = await fetch(base + url, { method, headers: h, body: payload });
    const ct = r.headers.get("content-type") || "";
    return { status: r.status, body: ct.includes("json") ? await r.json() : await r.text() };
  }
  const xlsxForm = (buf, name = "swan-epf.xlsx") => { const f = new FormData(); f.append("file", new Blob([buf]), name); return f; };
  const M = "/api/admin/studio/manufacturers/swan";
  const upload = async (buf, user = owner) => call("POST", `${M}/imports`, { user, form: xlsxForm(buf) });
  async function applyAndWait(id, body = {}, user = owner) {
    const r = await call("POST", `${M}/imports/${id}/apply`, { user, body });
    if (r.status >= 400) return r;
    for (let i = 0; i < 100; i++) {
      const d = await call("GET", `${M}/imports/${id}`, { user });
      if (d.body.import.status !== "applying") return d;
      await new Promise((res) => setTimeout(res, 50));
    }
    throw new Error("apply did not finish");
  }
  const fixture = fs.readFileSync(FIXTURE);

  console.log("reading the price file");
  await test("the workbook is read: sheets, groups, series, model numbers, sizes, colours, list prices, media kinds", async () => {
    const out = await parseCatalogFile("swan", fixture);
    assert.strictEqual(out.issues.filter((i) => i.level === "error").length, 0);
    const kit = out.items.get("MTMK723450.221");
    assert.strictEqual(kit.group, "walls");
    assert.strictEqual(kit.modelNumber, "MTMK72-3450");
    assert.strictEqual(kit.seriesName, "Swanstone® Metro Subway Tile Glue up Bathtub and Shower Wall Kit");
    assert.deepStrictEqual([kit.dims.lengthIn, kit.dims.widthIn, kit.dims.heightIn], [50, 34, 72]);
    assert.deepStrictEqual(kit.color, { code: "221", name: "Carrara" });
    assert.strictEqual(kit.listPriceCents, 318500);
    assert.ok(kit.media.some((m) => m.kind === "photo") && kit.media.some((m) => m.kind === "drawing") && kit.media.some((m) => m.kind === "installGuide"));
    // all four colours of the same model share the series and model
    const colours = [...out.items.values()].filter((i) => i.baseModel === "MTMK723450");
    assert.strictEqual(colours.length, 4);
    assert.strictEqual(new Set(colours.map((c) => c.seriesKey)).size, 1);
    assert.strictEqual(out.items.get("VP6030CTSML.010").group, "tubShowers");
    assert.strictEqual(out.items.get("VP6034CS.010").group, "showers");
    assert.strictEqual(out.items.get("TK00105.224").availability, "special-order");
    assert.ok(out.items.get("EXNST4836.900").programs.includes("express"));
  });

  await test("duplicates are not created: a repeated part keeps its first row; active+discontinued conflicts stay for sale and are flagged", async () => {
    const out = await parseCatalogFile("swan", fixture);
    assert.ok(out.issues.some((i) => /BT03060RD\.010 is listed more than once/.test(i.message)));
    assert.ok(out.items.has("MSMK963662.226"));
    assert.ok(out.issues.some((i) => /MSMK963662\.226 is listed both for sale/.test(i.message)));
  });

  await test("a cell holding several links joined by | becomes several links; http links on Swan's hosts are upgraded to https", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Swan-Active-Products");
    ws.addRow(["Sellable Part Number", "Product Name", "Product Category", "List Price", "Technical Drawing 1", "Product Image 1"]);
    ws.addRow(["AB01234.010", "AB-1234 Test Pan in White", "Shower Base", "100", "https://res.cloudinary.com/american-bath-group/image/upload/a.pdf|https://res.cloudinary.com/american-bath-group/image/upload/b.pdf", "http://images.salsify.com/image/upload/x.jpg"]);
    const out = await parseCatalogFile("swan", Buffer.from(await wb.xlsx.writeBuffer()));
    const media = out.items.get("AB01234.010").media;
    assert.deepStrictEqual(media.filter((m) => m.kind === "drawing").map((m) => m.url.split("/").pop()), ["a.pdf", "b.pdf"]);
    assert.strictEqual(media.find((m) => m.kind === "photo").url, "https://images.salsify.com/image/upload/x.jpg");
  });

  await test("files that are not a Swan price file are refused with a clear message, and recorded in the history", async () => {
    let r = await upload(Buffer.from("not a spreadsheet"));
    assert.strictEqual(r.status, 400);
    assert.match(r.body.message, /not an \.xlsx workbook/);
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Prices").addRow(["Part", "Price"]);
    r = await upload(Buffer.from(await wb.xlsx.writeBuffer()));
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.import.status, "failed");
    assert.ok(r.body.import.issues.some((i) => i.level === "error" && /No active product sheet/.test(i.message)));
    const wb2 = new ExcelJS.Workbook();
    wb2.addWorksheet("Swan-Active-Products").addRow(["Sellable Part Number", "Product Name"]);
    r = await upload(Buffer.from(await wb2.xlsx.writeBuffer()));
    assert.ok(r.body.import.issues.some((i) => /missing the column\(s\): Product Category, List Price/.test(i.message)));
    assert.strictEqual(await StudioSupplierItem.countDocuments(), 0);
  });

  console.log("permissions");
  await test("only catalog access opens manufacturer catalogs; image rights are the owner's decision", async () => {
    assert.strictEqual((await call("GET", "/api/admin/studio/manufacturers")).status, 401);
    for (const u of [seller, outsider, customer]) assert.strictEqual((await call("GET", "/api/admin/studio/manufacturers", { user: u })).status, 403, u.name);
    assert.strictEqual((await call("POST", `${M}/imports`, { user: seller, form: xlsxForm(fixture) })).status, 403);
    assert.strictEqual((await call("GET", "/api/admin/studio/manufacturers", { user: cataloger })).status, 200);
    const r = await call("PUT", M, { user: cataloger, body: { imageRights: { status: "approved", note: "I think it is fine" } } });
    assert.strictEqual(r.status, 403);
  });

  console.log("preview and apply");
  let firstId;
  await test("preview shows what would change and changes nothing", async () => {
    const r = await upload(fixture);
    assert.strictEqual(r.status, 201);
    const s = r.body.import.summary;
    assert.strictEqual(r.body.import.status, "previewed");
    assert.strictEqual(s.variants, 36);
    assert.strictEqual(s.new, 36);
    assert.strictEqual(s.changed, 0);
    assert.strictEqual(s.issues.warn, 4);
    assert.ok(s.byGroup[0].key === "walls" && s.byGroup.some((g) => g.key === "tubShowers"));
    assert.strictEqual(r.body.import.samples.new.length, 25);
    assert.strictEqual(await StudioSupplierItem.countDocuments(), 0);
    firstId = r.body.import.id;
  });

  await test("apply can start with a few product groups (walls, bases); the rest stays out", async () => {
    const r = await applyAndWait(firstId, { groups: ["walls", "bases"] });
    assert.strictEqual(r.body.import.status, "applied");
    assert.deepStrictEqual(r.body.import.scope, { groups: ["walls", "bases"] });
    assert.strictEqual(await StudioSupplierItem.countDocuments(), 18);
    assert.strictEqual(await StudioSupplierItem.countDocuments({ group: { $nin: ["walls", "bases"] } }), 0);
    const again = await call("POST", `${M}/imports/${firstId}/apply`, { user: owner, body: {} });
    assert.strictEqual(again.status, 409, "a preview is applied once");
  });

  await test("the full file then adds only what is missing; importing the same file again changes nothing", async () => {
    let r = await upload(fixture);
    assert.strictEqual(r.body.import.summary.new, 18);
    assert.strictEqual(r.body.import.summary.unchanged, 18);
    r = await applyAndWait(r.body.import.id);
    assert.strictEqual(r.body.import.result.added, 18);
    assert.strictEqual(await StudioSupplierItem.countDocuments(), 36);
    r = await upload(fixture);
    assert.strictEqual(r.body.import.summary.new, 0);
    assert.strictEqual(r.body.import.summary.changed, 0);
    assert.strictEqual(r.body.import.summary.sameAsLastApplied, true);
    r = await applyAndWait(r.body.import.id);
    assert.strictEqual(r.body.import.result.added, 0);
    assert.strictEqual(await StudioSupplierItem.countDocuments(), 36);
    const hist = await call("GET", `${M}/imports`, { user: owner });
    assert.ok(hist.body.imports.filter((i) => i.status === "applied").length >= 3);
  });

  console.log("browsing");
  await test("families group variants: series with counts, search by model number, filters", async () => {
    let r = await call("GET", `${M}/series?group=walls`, { user: cataloger });
    const s = r.body.series.find((x) => /Metro Subway Tile Glue up Bathtub and Shower Wall Kit/.test(x.name));
    assert.ok(s && s.variants === 4 && s.models === 1 && s.colors.includes("Carrara"));
    r = await call("GET", `${M}/items?q=MTMK72-3450`, { user: cataloger });
    assert.strictEqual(r.body.total, 4);
    r = await call("GET", `${M}/items?q=mtmk723450.221`, { user: cataloger });
    assert.strictEqual(r.body.items[0].partNumber, "MTMK723450.221");
    assert.strictEqual(r.body.items[0].designer.supported, true);
    r = await call("GET", `${M}/items?group=bases`, { user: cataloger });
    assert.ok(r.body.items.some((i) => !i.designer.supported && /rectangular alcove/.test(i.designer.reason)), "the neo-angle base is not drawable");
    r = await call("GET", `${M}/items/MTMK723450.221`, { user: cataloger });
    assert.strictEqual(r.body.variants.length, 4);
    assert.ok(r.body.designer.approximations.some((a) => /not a colour match/.test(a)));
  });

  console.log("adding to the Studio");
  await test("variants become DRAFT Studio products with no selling price and unverified compatibility; drawing data is valid", async () => {
    const r = await call("POST", `${M}/add-to-studio`, { user: cataloger, body: { partNumbers: ["MTMK723450.221", "MTMK723450.010", "SR03260LM.010", "VP6030CTL.010", "MSMK8436.010", "VP6030CTSML.010", "BF05024.000", "NOPE.1"] } });
    assert.strictEqual(r.status, 201);
    const skipped = Object.fromEntries(r.body.skipped.map((s) => [s.partNumber, s.reason]));
    assert.match(skipped["MSMK8436.010"], /complete wall kits only/);
    assert.match(skipped["NOPE.1"], /Not in the imported catalog/);
    const kit = await StudioProduct.findOne({ sku: "MTMK723450.221" }).lean();
    assert.strictEqual(kit.status, "draft");
    assert.strictEqual(kit.pricing.priceCents, null);
    assert.strictEqual(kit.pricing.costCents, null);
    assert.strictEqual(kit.compatibility.status, "unverified");
    assert.strictEqual(kit.source.listPriceCents, 318500);
    assert.deepStrictEqual(kit.engine.kit.forKinds, ["pan", "tub"]);
    assert.deepStrictEqual(kit.engine.pattern.tileW, 8);
    assert.strictEqual(validateEngine("wall", kit.type, kit.engine).errors.length, 0);
    assert.ok(kit.specs.some((s) => s.label === "Length" && s.value === "50" && s.status === "VERIFIED"));
    assert.ok(!kit.specs.some((s) => /price/i.test(s.label)), "no price in specifications");
    const pan = await StudioProduct.findOne({ sku: "SR03260LM.010" }).lean();
    assert.deepStrictEqual([pan.category, pan.type, pan.engine.length, pan.engine.width], ["base", "pan", 60, 32]);
    assert.strictEqual(pan.engine.drains[0].id, "left");
    const tub = await StudioProduct.findOne({ sku: "VP6030CTL.010" }).lean();
    assert.strictEqual(tub.type, "tub");
    assert.strictEqual(await StudioSupplierItem.countDocuments({ studioSku: { $ne: null } }), 6);
  });

  await test("a one-piece tub/shower unit is a base plus its own walls, which only go with that unit and are included in its price", async () => {
    const walls = await StudioProduct.findOne({ sku: "VP6030CTSML.010-WALLS" }).lean();
    assert.ok(walls);
    assert.deepStrictEqual(walls.engine.kit.requiresBase, ["VP6030CTSML.010"]);
    assert.strictEqual(walls.pricing.priceCents, 0);
    assert.strictEqual(walls.source.unitSku, "VP6030CTSML.010");
    const unit = await StudioProduct.findOne({ sku: "VP6030CTSML.010" }).lean();
    assert.strictEqual(unit.engine.height, 18, "rim height = unit height 79 - 61 available above the rim");
    const r = await call("POST", `/api/admin/studio/products/${walls._id}/status`, { user: owner, body: { status: "published" } });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.message, /part of a one-piece unit/);
  });

  await test("adding the same variant again does nothing", async () => {
    const r = await call("POST", `${M}/add-to-studio`, { user: owner, body: { partNumbers: ["MTMK723450.221"] } });
    assert.strictEqual(r.body.added.length, 0);
    assert.match(r.body.skipped[0].reason, /Already in the Studio/);
    assert.strictEqual(await StudioProduct.countDocuments({ sku: "MTMK723450.221" }), 1);
  });

  console.log("prices and publishing");
  await test("three separate prices: list (manufacturer), material cost and selling price (owner); publishing needs a selling price and a compatibility review", async () => {
    const kit = await StudioProduct.findOne({ sku: "MTMK723450.221" });
    let r = await call("POST", `/api/admin/studio/products/${kit._id}/status`, { user: owner, body: { status: "published" } });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.message, /selling price/);
    r = await call("PUT", `/api/admin/studio/products/${kit._id}`, { user: owner, body: { pricing: { priceCents: 410000, costCents: 205000 } } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.product.pricing.costCents, 205000);
    assert.strictEqual(r.body.product.source.listPriceCents, 318500, "the list price is not the cost");
    r = await call("POST", `/api/admin/studio/products/${kit._id}/status`, { user: owner, body: { status: "published" } });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.message, /Compatibility is unverified/);
    r = await call("PUT", `/api/admin/studio/products/${kit._id}`, { user: owner, body: { compatibility: { status: "reviewed", note: "Fits our 60x32 alcoves" } } });
    assert.strictEqual(r.body.product.compatibility.status, "reviewed");
    assert.ok(r.body.product.compatibility.reviewedAt);
    r = await call("POST", `/api/admin/studio/products/${kit._id}/status`, { user: owner, body: { status: "published" } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.product.status, "published");
  });

  await test("owner-made products keep the old rules (an unpriced owner product can still be published)", async () => {
    const r = await call("POST", "/api/admin/studio/products", { user: owner, body: { sku: "OWN-BAR-1", category: "accessory", type: "grabBar", name: "Owner bar", engine: { length: 24, diameter: 1.25, clearance: 1.5, flange: 3.25, finishColor: "#c9ccce", roughness: 0.35 } } });
    assert.strictEqual(r.status, 201);
    const p = await call("POST", `/api/admin/studio/products/${r.body.product._id}/status`, { user: owner, body: { status: "published" } });
    assert.strictEqual(p.status, 200);
  });

  await test("publishing a unit publishes its walls with it", async () => {
    const unit = await StudioProduct.findOne({ sku: "VP6030CTSML.010" });
    await call("PUT", `/api/admin/studio/products/${unit._id}`, { user: owner, body: { pricing: { priceCents: 350000 }, compatibility: { status: "reviewed" } } });
    const r = await call("POST", `/api/admin/studio/products/${unit._id}/status`, { user: owner, body: { status: "published" } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await StudioProduct.findOne({ sku: "VP6030CTSML.010-WALLS" }).lean()).status, "published");
    await call("POST", `/api/admin/studio/products/${unit._id}/status`, { user: owner, body: { status: "draft" } });
    assert.strictEqual((await StudioProduct.findOne({ sku: "VP6030CTSML.010-WALLS" }).lean()).status, "draft");
  });

  console.log("re-importing an updated price file");
  await test("a new list price is recorded and flagged for review; the owner's selling price and cost are NOT changed", async () => {
    const buf = await variantWorkbook({ price: { "MTMK723450.221": "3299" }, drop: ["MTMK723450.010", "SR03260LM.010"], discontinue: ["SR03260LM.010"] });
    let r = await upload(buf);
    const s = r.body.import.summary;
    assert.strictEqual(s.priceChanged, 1);
    assert.strictEqual(s.priceUp, 1);
    assert.strictEqual(s.toUnlist, 1);
    assert.strictEqual(s.toDiscontinue, 1);
    assert.ok(s.studioProductsAffected >= 3);
    assert.deepStrictEqual(r.body.import.samples.priceChanged[0], { partNumber: "MTMK723450.221", name: r.body.import.samples.priceChanged[0].name, from: 318500, to: 329900, inStudio: true });
    assert.ok(r.body.import.samples.changed[0].fields.includes("listPriceCents"));
    r = await applyAndWait(r.body.import.id);
    assert.strictEqual(r.body.import.status, "applied");
    const item = await StudioSupplierItem.findOne({ partNumber: "MTMK723450.221" }).lean();
    assert.deepStrictEqual(item.priceHistory.map((h) => h.cents), [318500, 329900]);
    const kit = await StudioProduct.findOne({ sku: "MTMK723450.221" }).lean();
    assert.strictEqual(kit.pricing.priceCents, 410000);
    assert.strictEqual(kit.pricing.costCents, 205000);
    assert.strictEqual(kit.source.listPriceCents, 329900);
    assert.strictEqual(kit.status, "published", "not unpublished automatically");
    assert.match(kit.source.pendingReview[0].message, /List price changed from \$3,185\.00 to \$3,299\.00/);
  });

  await test("discontinued and no-longer-listed variants are marked for review, never deleted", async () => {
    const gone = await StudioSupplierItem.findOne({ partNumber: "MTMK723450.010" }).lean();
    assert.strictEqual(gone.availability, "unlisted");
    const disc = await StudioSupplierItem.findOne({ partNumber: "SR03260LM.010" }).lean();
    assert.strictEqual(disc.availability, "discontinued");
    const pan = await StudioProduct.findOne({ sku: "SR03260LM.010" }).lean();
    assert.strictEqual(pan.source.availability, "discontinued");
    assert.match(pan.source.pendingReview.at(-1).message, /discontinued/);
    assert.strictEqual(await StudioSupplierItem.countDocuments(), 36);
    const r = await call("POST", `/api/admin/studio/products/${pan._id}/status`, { user: owner, body: { status: "published" } });
    assert.strictEqual(r.status, 400);
    const ack = await call("POST", `/api/admin/studio/products/${pan._id}/source/reviewed`, { user: owner });
    assert.strictEqual(ack.body.product.source.pendingReview.length, 0);
  });

  console.log("the public Studio");
  await test("the public catalog has published products only - no drafts, costs, list prices, part data or manufacturer links", async () => {
    invalidate();
    const r = await call("GET", "/api/studio/catalog");
    const text = JSON.stringify(r.body);
    assert.ok(text.includes("MTMK723450.221"), "the published kit");
    assert.ok(!text.includes("MTMK723450.010") && !text.includes("VP6030CTL.010"), "no drafts");
    for (const leak of ["costCents", "listPrice", "205000", "318500", "329900", "410000", "cloudinary", "salsify", "pendingReview", "externalMedia"]) assert.ok(!text.includes(leak), `public catalog leaks ${leak}`);
    const kit = r.body.catalog.finishes.find((f) => f.id === "MTMK723450.221");
    assert.strictEqual(kit.photo, null, "manufacturer photos are not public");
    assert.deepStrictEqual(kit.kits.map((k) => k.for), ["pan", "tub"]);
  });

  await test("a public quote cannot use a draft manufacturer product", async () => {
    const r = await call("POST", "/api/studio/quote", { body: { projectType: "tub-replacement", design: { baseId: "VP6030CTL.010", finishId: "MTMK723450.221", fixtureId: "x", enclosureId: "none", accessories: [], measure: {} } } });
    assert.ok(r.status === 400 || r.status === 404, `got ${r.status}`);
    assert.ok(!JSON.stringify(r.body).match(/\d{4,}/), "no price");
  });

  await test("Admin's own designer may show a manufacturer photo as a labelled preview; the public engine catalog never does", async () => {
    const p = await StudioProduct.findOne({ sku: "MTMK723450.221" }).lean();
    assert.ok(toEngineCatalog([p], { manufacturerPhotos: true }).finishes[0].photoSource === "manufacturer-preview");
    assert.strictEqual(toEngineCatalog([p]).finishes[0].photo, null);
  });

  console.log("image rights and links");
  const jpeg = await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 220, g: 220, b: 215 } } }).jpeg().toBuffer();
  media.setFetch(async (url, init) => {
    if (url.includes("broken")) return new Response(null, { status: 404 });
    if (url.includes("salsify")) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    if (url.includes("redirect-away")) return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } });
    return new Response(init.method === "HEAD" ? null : jpeg, { status: 200, headers: { "content-type": "image/jpeg", "content-length": String(jpeg.length) } });
  });

  await test("manufacturer images cannot be copied into the Studio until the owner records image rights", async () => {
    const kit = await StudioProduct.findOne({ sku: "MTMK723450.221" }).lean();
    const url = kit.externalMedia.find((m) => m.kind === "photo").url;
    let r = await call("POST", `/api/admin/studio/products/${kit._id}/media/copy`, { user: owner, body: { url } });
    assert.strictEqual(r.status, 403);
    assert.match(r.body.message, /image rights are not confirmed/);
    r = await call("PUT", M, { user: owner, body: { imageRights: { status: "approved", note: "ok" } } });
    assert.strictEqual(r.status, 400, "a reason is required");
    r = await call("PUT", M, { user: owner, body: { imageRights: { status: "approved", note: "Swan dealer agreement 2026-10, section 4: product images may be used to sell Swan products." } } });
    assert.strictEqual(r.body.imageRights.status, "approved");
  });

  await test("with rights confirmed, a manufacturer photo is copied once (optimized, private storage) and attached", async () => {
    const kit = await StudioProduct.findOne({ sku: "VP6030CTL.010" }).lean();
    const url = kit.externalMedia.find((m) => m.kind === "photo" && !m.url.includes("salsify")).url;
    let r = await call("POST", `/api/admin/studio/products/${kit._id}/media/copy`, { user: owner, body: { url } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.product.assets.photos.length, 1);
    const asset = await StudioAsset.findOne({ "source.url": url }).lean();
    assert.ok(asset && asset.contentType === "image/jpeg" && asset.storageKey.startsWith("private/studio/"));
    r = await call("POST", `/api/admin/studio/products/${kit._id}/media/copy`, { user: owner, body: { url } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(await StudioAsset.countDocuments({ "source.url": url }), 1);
    r = await call("POST", `/api/admin/studio/products/${kit._id}/media/copy`, { user: owner, body: { url: "https://evil.example.com/a.jpg" } });
    assert.strictEqual(r.status, 400);
  });

  await test("the server only contacts the manufacturer's own hosts and does not follow redirects elsewhere", async () => {
    const swan = require("../utils/studio/manufacturers/swan");
    assert.strictEqual(media.allowedUrl(swan, "https://res.cloudinary.com/other-company/image/upload/x.jpg"), null);
    assert.strictEqual(media.allowedUrl(swan, "http://res.cloudinary.com/american-bath-group/x.jpg"), null);
    assert.strictEqual(media.allowedUrl(swan, "https://127.0.0.1/x.jpg"), null);
    assert.ok(media.allowedUrl(swan, "https://res.cloudinary.com/american-bath-group/image/upload/x.jpg"));
    const r = await media.checkOne(swan, "https://res.cloudinary.com/american-bath-group/redirect-away.jpg");
    assert.strictEqual(r.status, "broken");
    assert.match(r.error, /Redirects away/);
  });

  await test("link check: working, broken (404) and unreachable links are told apart and shown per image", async () => {
    await StudioSupplierItem.updateOne({ partNumber: "TK00105.010" }, { $push: { media: { kind: "photo", url: "https://res.cloudinary.com/american-bath-group/image/upload/broken.jpg" } } });
    let r = await call("POST", `${M}/link-check`, { user: owner });
    assert.strictEqual(r.status, 202);
    for (let i = 0; i < 100; i++) {
      r = await call("GET", M, { user: owner });
      if (r.body.manufacturer.linkCheck.status === "done") break;
      await new Promise((res) => setTimeout(res, 50));
    }
    const lc = r.body.manufacturer.linkCheck;
    assert.strictEqual(lc.status, "done");
    assert.ok(lc.ok > 0 && lc.broken === 1 && lc.unreachable > 0, JSON.stringify(lc));
    assert.strictEqual(lc.ok + lc.broken + lc.unreachable, lc.total);
    assert.strictEqual(await StudioMediaCheck.countDocuments({ url: /youtube|youtu\.be/ }), 0, "videos are not checked");
    r = await call("GET", `${M}/items/TK00105.010`, { user: owner });
    assert.strictEqual(r.body.item.media.find((m) => m.url.includes("broken")).check.status, "broken");
  });

  console.log("colours and textures");
  await test("colours: Swan's finishes with measured approximations; the owner's own colour, swatch and labelled texture", async () => {
    let r = await call("GET", M, { user: owner });
    const carrara = r.body.colors.find((c) => c.code === "221");
    assert.strictEqual(carrara.name, "Carrara");
    assert.strictEqual(carrara.measuredFrom, "swatch");
    assert.ok(carrara.manufacturerSwatchUrl.startsWith("https://res.cloudinary.com/american-bath-group/"));
    assert.ok(r.body.patterns.some((p) => p.code === "MT" && p.pattern.tileW === 8 && p.pattern.tileH === 4));
    r = await call("PUT", `${M}/colors/221`, { user: owner, body: { hex: "#eeeeec" } });
    assert.strictEqual(r.body.colors.find((c) => c.code === "221").ownHex, "#eeeeec");
    const form = new FormData();
    form.append("file", new Blob([jpeg], { type: "image/jpeg" }), "carrara.jpg");
    form.append("kind", "texture"); form.append("widthIn", "24"); form.append("heightIn", "24");
    r = await call("POST", `${M}/colors/221/assets`, { user: owner, form });
    assert.strictEqual(r.status, 400, "a texture must say where it came from");
    form.append("textureSource", "approximation");
    r = await call("POST", `${M}/colors/221/assets`, { user: owner, form });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.colors.find((c) => c.code === "221").texture.source, "approximation");
    assert.strictEqual(r.body.appliedToProducts, 1, "the Carrara wall kit gets it");
    const kit = await StudioProduct.findOne({ sku: "MTMK723450.221" }).lean();
    assert.ok(kit.assets.texture.assetId);
  });

  await test("existing Studio pricing and catalog still work (owner products, price list untouched)", async () => {
    const pricing = await StudioPricing.current();
    assert.ok(pricing.projectTypes.length === 3);
    const r = await call("GET", "/api/admin/studio/catalog/completeness", { user: owner });
    assert.strictEqual(r.status, 200);
    const row = r.body.products.find((p) => p.sku === "VP6030CTL.010");
    assert.ok(row.issues.some((i) => /selling price/.test(i.message)));
  });

  const real = (() => {
    const dir = path.join(__dirname, "..", "catalog-imports");
    try { return fs.readdirSync(dir).filter((f) => /^swan-epf-.*\.xlsx$/i.test(f)).map((f) => path.join(dir, f))[0] || null; } catch { return null; }
  })();
  if (real) {
    console.log(`the complete Swan workbook (${path.basename(real)})`);
    await test("the whole workbook previews and imports without timeouts or corruption; a second import changes nothing", async () => {
      await StudioSupplierItem.deleteMany({});
      await StudioCatalogImport.deleteMany({});
      const buf = fs.readFileSync(real);
      let t = Date.now();
      let r = await upload(buf);
      const previewMs = Date.now() - t;
      assert.strictEqual(r.body.import.status, "previewed");
      const s = r.body.import.summary;
      assert.strictEqual(s.issues.error, 0);
      t = Date.now();
      r = await applyAndWait(r.body.import.id);
      const applyMs = Date.now() - t;
      assert.strictEqual(r.body.import.status, "applied");
      assert.strictEqual(await StudioSupplierItem.countDocuments(), s.variants);
      const parts = await StudioSupplierItem.distinct("partNumber");
      assert.strictEqual(parts.length, s.variants, "one record per part number");
      r = await upload(buf);
      assert.strictEqual(r.body.import.summary.new, 0);
      assert.strictEqual(r.body.import.summary.changed, 0);
      assert.ok(previewMs < 60000 && applyMs < 120000, `preview ${previewMs} ms, apply ${applyMs} ms`);
      console.log(`        ${s.variants} variants, ${s.models} models, ${s.series} series; preview ${previewMs} ms, apply ${applyMs} ms`);
    });
  }

  server.close();
  await mongoose.disconnect();
  await mongo.stop();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
