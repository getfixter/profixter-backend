/**
 * Shower Studio in Admin - mounted at /api/admin/studio.
 *
 *   Catalog manager and prices  -> studio.catalog (owner, or employees the owner grants)
 *   Designs, Studio requests    -> studio.sell
 *   Price overrides / discounts -> studio.priceAdjust (employees capped at the owner's max discount)
 *   Creating a proposal         -> studio.sell AND projects.manage (it creates a Project + Estimate)
 *
 * Prices and internal notes only ever leave the server through these routes.
 */
const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const mongoose = require("mongoose");
const auth = require("../middleware/auth");
const { PERMISSIONS, requirePermission, hasPermission } = require("../middleware/authorize");
const StudioProduct = require("../models/studio/StudioProduct");
const StudioAsset = require("../models/studio/StudioAsset");
const StudioPricing = require("../models/studio/StudioPricing");
const StudioDesign = require("../models/studio/StudioDesign");
const StudioPhoto = require("../models/studio/StudioPhoto");
const { sanitizeImageBuffer } = require("../utils/imageSanitizer");
const storage = require("../utils/studio/storage");
const { photoUrl, randomId } = require("../utils/studio/signedLinks");
const { TYPES, fieldsFor, validateEngine, validateProduct, completeness, publishBlockers, readiness, familyOf, variantOf } = require("../utils/studio/catalogFields");
const StudioManufacturer = require("../models/studio/StudioManufacturer");
const { staffCatalog, invalidate } = require("../utils/studio/catalogService");
const { validateState } = require("../utils/studio/designState");
const { checkDesign, quoteDesign, blockingErrors, skusOf } = require("../utils/studio/designService");
const { discountAllowed } = require("../utils/studio/pricing");
const { EXAMPLE_SCENES, MEASURE_SOURCES, MEASURE_LABEL } = require("../utils/studio/examples");

const router = express.Router();
const json = express.json({ limit: "1mb" });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 8 } });
const catalogPerm = requirePermission(PERMISSIONS.STUDIO_CATALOG);
const sellPerm = requirePermission(PERMISSIONS.STUDIO_SELL);
const actorId = (req) => (req.accessUser?._id || req.user?.id || null);
const isOwner = (req) => req.accessRole === "admin";
const fail = (status, message, extra) => Object.assign(new Error(message), { status, extra });

router.use(auth);

// Manufacturer catalogs (Swan, ...): imports, browsing, adding variants as drafts.
router.use("/manufacturers", require("./adminStudioManufacturers"));

function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ message: e.message, ...(e.extra || {}) });
      if (e.name === "ValidationError") return res.status(400).json({ message: e.message });
      if (e.code === 11000) return res.status(409).json({ message: "That SKU is already used by another product." });
      console.error(`admin studio ${req.method} ${req.path} failed:`, e);
      return res.status(500).json({ message: "Something went wrong. Please try again." });
    }
  };
}

const validId = (id) => mongoose.Types.ObjectId.isValid(String(id));

// ===================================================================== catalog
router.get("/catalog/fields", ...catalogPerm, handle(async (_req, res) => {
  const out = {};
  for (const [category, types] of Object.entries(TYPES)) out[category] = types.map((t) => ({ ...t, fields: fieldsFor(category, t.id) }));
  res.json({ categories: out });
}));

/** Image and drawing status of a product (what customers could see, and from where). */
function imagingOf(p, rights = {}) {
  const r = readinessCache.get(p) || readiness(p);
  return {
    manufacturerImages: (p.externalMedia || []).filter((m) => m.kind === "photo").length,
    imageRights: p.source?.manufacturer ? rights[p.source.manufacturer] || "unconfirmed" : null,
    publicPhotos: p.assets?.photos?.length || 0,
    texture: p.assets?.texture?.assetId ? p.assets.texture.source || "owner" : null,
    visualization: r.blockers.some((b) => /^Visualization details/.test(b)) ? "incomplete" : (p.source?.visualIssues || []).length && p.review?.visual !== true ? "needs-review" : p.visualStatus === "verified" ? "verified" : "illustrative",
  };
}
const readinessCache = new WeakMap();
async function rightsMap() {
  const list = await StudioManufacturer.find({}).select("key imageRights.status").lean();
  return Object.fromEntries(list.map((m) => [m.key, m.imageRights?.status || "unconfirmed"]));
}

function serializeProduct(p, assetMap = new Map(), rights = {}) {
  const url = (id) => (assetMap.get(String(id)) ? `/api/studio/assets/${assetMap.get(String(id))}` : null);
  const r = readiness(p);
  readinessCache.set(p, r);
  return {
    ...p,
    _id: String(p._id),
    readiness: r,
    family: familyOf(p),
    variant: variantOf(p),
    imaging: imagingOf(p, rights),
    assets: {
      photos: (p.assets?.photos || []).map((x) => ({ assetId: String(x.assetId), alt: x.alt, url: url(x.assetId) })),
      texture: p.assets?.texture?.assetId ? { assetId: String(p.assets.texture.assetId), widthIn: p.assets.texture.widthIn, heightIn: p.assets.texture.heightIn, source: p.assets.texture.source || "owner", url: url(p.assets.texture.assetId) } : null,
    },
    issues: completeness(p),
  };
}
async function assetMapFor(products) {
  const ids = products.flatMap((p) => [...(p.assets?.photos || []).map((x) => x.assetId), p.assets?.texture?.assetId].filter(Boolean));
  const list = ids.length ? await StudioAsset.find({ _id: { $in: ids } }).select("publicId").lean() : [];
  return new Map(list.map((a) => [String(a._id), a.publicId]));
}

/**
 * The catalog manager: products grouped into families, filtered and paged.
 *   q            exact SKU / part number first, else name, model, colour, SKU
 *   manufacturer "own" (added by hand) or a manufacturer key
 *   category     wall | base | fixture | enclosure | accessory
 *   stage        draft | incomplete | review | ready | published | archived |
 *                missingPrice | missingPhoto | compatibility | visual | changes
 */
const STAGE_TEST = {
  all: (p) => p.status !== "archived",
  draft: (p) => p.status === "draft",
  incomplete: (p, r) => r.stage === "incomplete",
  review: (p, r) => r.stage === "review",
  ready: (p, r) => r.stage === "ready",
  published: (p) => p.status === "published",
  archived: (p) => p.status === "archived",
  missingPrice: (p) => p.status !== "archived" && p.pricing?.priceCents == null && !p.source?.unitSku,
  missingPhoto: (p) => p.status !== "archived" && !p.assets?.photos?.length && !p.source?.unitSku,
  compatibility: (p) => p.status !== "archived" && p.compatibility?.status !== "reviewed",
  visual: (p, r) => p.status !== "archived" && (r.blockers.some((b) => /^Visualization details|preview/.test(b))),
  changes: (p) => (p.source?.pendingReview || []).length > 0,
};
const CAT_ORDER = ["wall", "base", "fixture", "enclosure", "accessory"];

router.get("/products", ...catalogPerm, handle(async (req, res) => {
  if (req.query.view !== "families") return legacyProducts(req, res);
  const f = {};
  if (req.query.category && CAT_ORDER.includes(String(req.query.category))) f.category = String(req.query.category);
  const mfr = String(req.query.manufacturer || "");
  if (mfr === "own") f["source.manufacturer"] = null;
  else if (mfr) f["source.manufacturer"] = mfr.slice(0, 40);
  const term = String(req.query.q || "").trim().slice(0, 80);
  const stage = STAGE_TEST[String(req.query.stage || "all")] ? String(req.query.stage || "all") : "all";
  let list = await StudioProduct.find(f).select("-specs -sources -description").lean();
  const counts = {};
  const scored = [];
  for (const p of list) {
    const r = readiness(p);
    for (const [k, test] of Object.entries(STAGE_TEST)) if (test(p, r)) counts[k] = (counts[k] || 0) + 1;
    if (!STAGE_TEST[stage](p, r)) continue;
    scored.push(p);
  }
  list = scored;
  let exact = null;
  if (term) {
    const t = term.toLowerCase();
    exact = list.find((p) => p.sku.toLowerCase() === t || p.source?.partNumber?.toLowerCase() === t) || null;
    list = exact ? [exact] : list.filter((p) => [p.sku, p.name, p.model, p.colorName, p.source?.modelNumber, p.source?.seriesName].some((x) => String(x || "").toLowerCase().includes(t)));
  }
  const fams = new Map();
  for (const p of list) {
    const fam = familyOf(p);
    if (!fams.has(fam.key)) fams.set(fam.key, { key: fam.key, name: fam.name, category: p.category, manufacturer: p.manufacturer || "", fromManufacturer: Boolean(p.source?.manufacturer), products: [] });
    fams.get(fam.key).products.push(p);
  }
  const all = [...fams.values()].sort((a, b) => (CAT_ORDER.indexOf(a.category) - CAT_ORDER.indexOf(b.category)) || (a.fromManufacturer - b.fromManufacturer) || a.name.localeCompare(b.name));
  const per = Math.max(5, Math.min(60, Number(req.query.per) || 20));
  const page = Math.max(1, Number(req.query.page) || 1);
  const slice = all.slice((page - 1) * per, page * per);
  const assets = await assetMapFor(slice.flatMap((x) => x.products));
  const rights = await rightsMap();
  const row = (p) => {
    const sp = serializeProduct(p, assets, rights);
    const thumb = sp.assets.photos[0]?.url || null;
    const ext = (p.externalMedia || []).find((m) => m.kind === "photo")?.url || null;
    return {
      _id: sp._id, sku: p.sku, name: p.name, category: p.category, type: p.type, status: p.status, colorName: p.colorName, model: p.model,
      variant: sp.variant, readiness: sp.readiness, imaging: sp.imaging, pricing: { priceCents: p.pricing?.priceCents ?? null, costCents: p.pricing?.costCents ?? null },
      listPriceCents: p.source?.listPriceCents ?? null, availability: p.source?.availability || null, unitSku: p.source?.unitSku || null,
      compatibility: p.compatibility?.status || "reviewed", pendingReview: (p.source?.pendingReview || []).length, isPublic: p.isPublic !== false, featured: Boolean(p.featured),
      photoUrl: thumb, manufacturerPhotoUrl: thumb ? null : ext,
    };
  };
  res.json({
    total: { products: list.length, families: all.length }, page, per, counts, exact: exact ? exact.sku : null,
    manufacturers: [...new Set((await StudioProduct.distinct("source.manufacturer")).filter(Boolean))],
    families: slice.map((x) => {
      const rows = x.products.map(row).sort((a, b) => a.variant.size.localeCompare(b.variant.size, undefined, { numeric: true }) || a.variant.color.localeCompare(b.variant.color));
      const by = (k) => rows.filter((r) => r.readiness.stage === k).length;
      return { key: x.key, name: x.name, category: x.category, manufacturer: x.manufacturer, fromManufacturer: x.fromManufacturer, sizes: [...new Set(rows.map((r) => r.variant.size).filter(Boolean))], colors: [...new Set(rows.map((r) => r.variant.color).filter(Boolean))], stages: { published: by("published"), ready: by("ready"), review: by("review"), incomplete: by("incomplete") }, products: rows };
    }),
  });
}));

async function legacyProducts(req, res) {
  const q = {};
  if (req.query.category) q.category = String(req.query.category);
  if (req.query.status) q.status = String(req.query.status);
  if (req.query.q) {
    const rx = new RegExp(String(req.query.q).trim().slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    q.$or = [{ sku: rx }, { name: rx }, { model: rx }];
  }
  const limit = Math.max(1, Math.min(5000, Number(req.query.limit) || 5000));
  const list = await StudioProduct.find(q).sort({ category: 1, sortOrder: 1, name: 1 }).limit(limit).lean();
  const assets = await assetMapFor(list);
  const rights = await rightsMap();
  res.json({ products: list.map((p) => serializeProduct(p, assets, rights)) });
}

router.get("/products/:id", ...catalogPerm, handle(async (req, res) => {
  if (!validId(req.params.id)) throw fail(404, "Product not found.");
  const p = await StudioProduct.findById(req.params.id).lean();
  if (!p) throw fail(404, "Product not found.");
  res.json({ product: serializeProduct(p, await assetMapFor([p]), await rightsMap()), siblings: await siblingsOf(p) });
}));

/** The other variants of a product's family (size / colour switcher in the editor). */
async function siblingsOf(p) {
  const fam = familyOf(p);
  if (fam.key.startsWith("sku:") || fam.key.startsWith("unit:")) return [];
  const list = await StudioProduct.find({ "source.manufacturer": p.source.manufacturer, "source.seriesName": p.source.seriesName, category: p.category, "source.unitSku": null }).select("sku name status colorName engine category source.modelNumber pricing.priceCents").lean();
  return list.map((x) => ({ _id: String(x._id), sku: x.sku, status: x.status, variant: variantOf(x), priceCents: x.pricing?.priceCents ?? null })).sort((a, b) => a.variant.size.localeCompare(b.variant.size, undefined, { numeric: true }) || a.variant.color.localeCompare(b.variant.color));
}

/** What the product fits and pairs with, and what to confirm (compatibility review). */
router.get("/products/:id/compatibility", ...catalogPerm, handle(async (req, res) => {
  if (!validId(req.params.id)) throw fail(404, "Product not found.");
  const p = await StudioProduct.findById(req.params.id).lean();
  if (!p) throw fail(404, "Product not found.");
  const { compatReport } = require("../utils/studio/compatReport");
  res.json({ report: await compatReport(p) });
}));

/**
 * Bulk changes from the catalog manager. Every product goes through the same
 * rules as one at a time: publishing still requires a product to be ready;
 * archiving applies to drafts only (unpublish first).
 */
const BULK = ["archive", "draft", "publish", "compatibilityReviewed", "show", "hide", "feature", "unfeature"];
router.post("/products/bulk", ...catalogPerm, json, handle(async (req, res) => {
  const action = String(req.body?.action || "");
  if (!BULK.includes(action)) throw fail(400, "Unknown action.");
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).filter(validId).slice(0, 500);
  if (!ids.length) throw fail(400, "Select products first.");
  const note = String(req.body?.note || "").trim().slice(0, 1000);
  if (action === "compatibilityReviewed" && note.length < 5) throw fail(400, "Say what you checked (it is saved on each product).");
  const list = await StudioProduct.find({ _id: { $in: ids } });
  const done = [];
  const skipped = [];
  for (const p of list) {
    const skip = (reason) => skipped.push({ sku: p.sku, reason });
    if (p.source?.unitSku && ["archive", "draft", "publish"].includes(action)) { skip("Part of a one-piece unit: changes with the unit."); continue; }
    if (action === "archive") {
      if (p.status === "published") { skip("Published: unpublish it first."); continue; }
      if (p.status === "archived") { skip("Already archived."); continue; }
      await changeStatus(p, "archived", req);
    } else if (action === "draft") {
      if (p.status === "draft") { skip("Already a draft."); continue; }
      await changeStatus(p, "draft", req);
    } else if (action === "publish") {
      if (p.status === "published") { skip("Already published."); continue; }
      const blocked = readiness(p.toObject()).blockers;
      if (blocked.length) { skip(blocked[0]); continue; }
      await changeStatus(p, "published", req);
    } else if (action === "compatibilityReviewed") {
      p.compatibility = { status: "reviewed", note, reviewedBy: actorId(req), reviewedAt: new Date() };
      await p.save();
    } else {
      if (action === "show" || action === "hide") p.isPublic = action === "show";
      else p.featured = action === "feature";
      p.updatedBy = actorId(req);
      await p.save();
    }
    done.push(p.sku);
  }
  invalidate();
  res.json({ done: done.length, skipped });
}));

router.post("/products", ...catalogPerm, json, handle(async (req, res) => {
  const { value, errors } = validateProduct(req.body || {}, { creating: true });
  const eng = validateEngine(value.category, value.type, req.body?.engine || {});
  const all = [...errors, ...eng.errors];
  if (all.length) throw fail(400, all[0].message, { errors: all });
  const p = await StudioProduct.create({ ...value, engine: eng.engine, status: "draft", updatedBy: actorId(req) });
  invalidate();
  res.status(201).json({ product: serializeProduct(p.toObject()) });
}));

router.put("/products/:id", ...catalogPerm, json, handle(async (req, res) => {
  if (!validId(req.params.id)) throw fail(404, "Product not found.");
  const p = await StudioProduct.findById(req.params.id);
  if (!p) throw fail(404, "Product not found.");
  const { value, errors } = validateProduct(req.body || {}, { creating: false });
  const type = value.type || p.type;
  const eng = req.body?.engine !== undefined ? validateEngine(p.category, type, req.body.engine) : { engine: p.engine, errors: [] };
  const all = [...errors, ...eng.errors];
  if (all.length) throw fail(400, all[0].message, { errors: all });
  delete value.sku; delete value.category;
  if (value.review) {
    value.review = { info: value.review.info ?? p.review?.info ?? null, visual: value.review.visual ?? p.review?.visual ?? null, by: actorId(req), at: new Date() };
  }
  if (value.compatibility) {
    const was = p.compatibility?.status;
    value.compatibility = { ...value.compatibility, reviewedBy: value.compatibility.status === "reviewed" ? (was === "reviewed" ? p.compatibility.reviewedBy : actorId(req)) : null, reviewedAt: value.compatibility.status === "reviewed" ? (was === "reviewed" ? p.compatibility.reviewedAt : new Date()) : null };
  }
  Object.assign(p, value, { engine: eng.engine, type, updatedBy: actorId(req) });
  p.version = (p.version || 1) + 1;
  p.markModified("engine");
  await p.save();
  invalidate();
  res.json({ product: serializeProduct(p.toObject(), await assetMapFor([p])) });
}));

/** Publish / unpublish (back to draft) / archive. Publishing needs complete visualization details. */
router.post("/products/:id/status", ...catalogPerm, json, handle(async (req, res) => {
  if (!validId(req.params.id)) throw fail(404, "Product not found.");
  const p = await StudioProduct.findById(req.params.id);
  if (!p) throw fail(404, "Product not found.");
  const status = String(req.body?.status || "");
  if (!["draft", "published", "archived"].includes(status)) throw fail(400, "Unknown status.");
  if (p.source?.unitSku) throw fail(400, "These walls are part of a one-piece unit: they are published, hidden or archived with the unit.");
  if (status === "published") {
    const { errors } = validateEngine(p.category, p.type, p.engine);
    if (errors.length) throw fail(400, `Finish the visualization details first: ${errors[0].message}`, { errors });
    const blockers = publishBlockers(p);
    if (blockers.length) throw fail(400, blockers[0], { errors: blockers.map((message) => ({ field: "status", message })) });
  }
  await changeStatus(p, status, req);
  invalidate();
  res.json({ product: serializeProduct(p.toObject(), await assetMapFor([p])) });
}));

/** Set a product's status (checks done by the caller). A one-piece unit's integral walls follow the unit. */
async function changeStatus(p, status, req) {
  p.status = status;
  p.updatedBy = actorId(req);
  await p.save();
  if (p.source?.manufacturer) await StudioProduct.updateMany({ "source.unitSku": p.sku }, { $set: { status, updatedBy: actorId(req) } });
}

router.post("/products/reorder", ...catalogPerm, json, handle(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(validId).slice(0, 500) : [];
  await Promise.all(ids.map((id, i) => StudioProduct.updateOne({ _id: id }, { $set: { sortOrder: (i + 1) * 10 } })));
  invalidate();
  res.json({ ok: true });
}));

/**
 * Copy a manufacturer image (from the product's manufacturer links) into the
 * product's own photos. Only allowed once the owner has confirmed the
 * manufacturer's image rights; otherwise those images stay Admin previews.
 */
router.post("/products/:id/media/copy", ...catalogPerm, json, handle(async (req, res) => {
  if (!validId(req.params.id)) throw fail(404, "Product not found.");
  const p = await StudioProduct.findById(req.params.id);
  if (!p) throw fail(404, "Product not found.");
  const url = String(req.body?.url || "");
  if (!p.source?.manufacturer || !(p.externalMedia || []).some((m) => m.url === url && m.kind === "photo")) throw fail(400, "Choose one of this product's manufacturer photos.");
  const { copyManufacturerImage } = require("../utils/studio/manufacturers/media");
  const { asset, reused } = await copyManufacturerImage({ key: p.source.manufacturer, url, actorId: actorId(req) });
  if (!p.assets.photos.some((x) => String(x.assetId) === String(asset._id))) {
    if (p.assets.photos.length >= 8) throw fail(400, "Up to 8 photos per product.");
    p.assets.photos.push({ assetId: asset._id, alt: p.name.slice(0, 200) });
    p.version += 1;
    await p.save();
    invalidate();
  }
  res.status(reused ? 200 : 201).json({ product: serializeProduct(p.toObject(), await assetMapFor([p])) });
}));

/** The owner has looked at the manufacturer's changes (list price, availability): clear the notes. */
router.post("/products/:id/source/reviewed", ...catalogPerm, handle(async (req, res) => {
  if (!validId(req.params.id)) throw fail(404, "Product not found.");
  const p = await StudioProduct.findById(req.params.id);
  if (!p) throw fail(404, "Product not found.");
  if (p.source) p.source.pendingReview = [];
  p.updatedBy = actorId(req);
  await p.save();
  res.json({ product: serializeProduct(p.toObject(), await assetMapFor([p])) });
}));

/** Upload a product photo or texture (re-encoded; stored privately; served by an unguessable id). */
router.post("/products/:id/assets", ...catalogPerm, (req, res) => {
  upload.single("file")(req, res, (uploadError) => handle(async () => {
    if (uploadError) throw fail(400, uploadError.code === "LIMIT_FILE_SIZE" ? "Images must be 20 MB or smaller." : "Upload one image.");
    if (!validId(req.params.id)) throw fail(404, "Product not found.");
    const p = await StudioProduct.findById(req.params.id);
    if (!p) throw fail(404, "Product not found.");
    if (!req.file) throw fail(400, "Choose an image.");
    const kind = req.body?.kind === "texture" ? "texture" : "photo";
    if (kind === "texture" && p.category !== "wall") throw fail(400, "Textures are for wall finishes.");
    let clean;
    try { clean = await sanitizeImageBuffer(req.file.buffer); } catch (e) { throw fail(400, e.message); }
    const meta = await require("sharp")(clean.buffer).metadata();
    const key = storage.newKey("catalog");
    await storage.put(key, clean.buffer, "image/jpeg");
    const asset = await StudioAsset.create({
      publicId: randomId(18), kind, storageKey: key, contentType: "image/jpeg", bytes: clean.buffer.length,
      width: meta.width, height: meta.height, sha256: crypto.createHash("sha256").update(clean.buffer).digest("hex"),
      originalName: String(req.file.originalname || "").slice(0, 200), createdBy: actorId(req),
    });
    if (kind === "texture") {
      const w = Number(req.body.widthIn), h = Number(req.body.heightIn);
      if (!(w >= 1 && w <= 240 && h >= 1 && h <= 240)) throw fail(400, "Give the real-world size of the texture image in inches (1–240).");
      p.assets.texture = { assetId: asset._id, widthIn: w, heightIn: h, source: ["manufacturer", "approximation"].includes(req.body?.textureSource) ? req.body.textureSource : "owner" };
    } else {
      if (p.assets.photos.length >= 8) throw fail(400, "Up to 8 photos per product.");
      p.assets.photos.push({ assetId: asset._id, alt: String(req.body?.alt || p.name).slice(0, 200) });
    }
    p.version += 1;
    await p.save();
    invalidate();
    res.status(201).json({ product: serializeProduct(p.toObject(), await assetMapFor([p])) });
  })(req, res));
});

router.delete("/products/:id/assets/:assetId", ...catalogPerm, handle(async (req, res) => {
  if (!validId(req.params.id) || !validId(req.params.assetId)) throw fail(404, "Not found.");
  const p = await StudioProduct.findById(req.params.id);
  if (!p) throw fail(404, "Product not found.");
  const aid = String(req.params.assetId);
  p.assets.photos = p.assets.photos.filter((x) => String(x.assetId) !== aid);
  if (String(p.assets.texture?.assetId || "") === aid) p.assets.texture = { assetId: null, widthIn: null, heightIn: null };
  p.version += 1;
  await p.save();
  invalidate();
  res.json({ product: serializeProduct(p.toObject(), await assetMapFor([p])) });
}));

router.get("/catalog/completeness", ...catalogPerm, handle(async (_req, res) => {
  const list = await StudioProduct.find({ status: { $ne: "archived" } }).lean();
  const pricing = await StudioPricing.current();
  const rows = list.map((p) => ({ id: String(p._id), sku: p.sku, name: p.name, category: p.category, status: p.status, issues: completeness(p) }));
  const pricingIssues = [
    ...pricing.projectTypes.filter((t) => t.enabled !== false && t.basePriceCents == null).map((t) => `No base price for ${t.label}`),
    ...pricing.adders.filter((a) => a.enabled !== false && a.priceCents == null).map((a) => `No price for "${a.label}"`),
  ];
  res.json({
    products: rows,
    pricingIssues,
    summary: {
      total: rows.length,
      published: rows.filter((r) => r.status === "published").length,
      unpriced: list.filter((p) => p.pricing?.priceCents == null).length,
      noPhoto: list.filter((p) => !p.assets?.photos?.length).length,
      incomplete: rows.filter((r) => r.issues.some((i) => i.level === "error")).length,
    },
  });
}));

/** One-time convenience: add the researched starter products (as drafts, unpriced) that are not in the catalog yet. */
router.post("/catalog/import-starter", ...catalogPerm, handle(async (req, res) => {
  const starter = require("../data/studio/starter-catalog.json");
  const have = new Set((await StudioProduct.find({}).select("sku").lean()).map((p) => p.sku));
  const toAdd = starter.products.filter((p) => !have.has(p.sku)).map((p) => ({ ...p, status: "draft", updatedBy: actorId(req) }));
  if (toAdd.length) await StudioProduct.insertMany(toAdd);
  invalidate();
  res.json({ added: toAdd.length, skipped: starter.products.length - toAdd.length });
}));

// ===================================================================== pricing
router.get("/pricing", ...catalogPerm, handle(async (_req, res) => {
  res.json({ pricing: (await StudioPricing.current()).toObject() });
}));

router.put("/pricing", ...catalogPerm, json, handle(async (req, res) => {
  const b = req.body || {};
  const pricing = await StudioPricing.current();
  const errors = [];
  const cents = (v, label) => {
    if (v === null || v === "" || v === undefined) return null;
    const c = Math.round(Number(v));
    if (!Number.isFinite(c) || c < 0 || c > 1_000_000_00) { errors.push({ message: `${label}: enter an amount between $0 and $1,000,000.` }); return null; }
    return c;
  };
  if (Array.isArray(b.projectTypes)) {
    for (const t of b.projectTypes) {
      const cur = pricing.projectTypes.find((x) => x.key === t.key);
      if (!cur) continue;
      if (t.label !== undefined) cur.label = String(t.label).trim().slice(0, 120) || cur.label;
      if (t.includes !== undefined) cur.includes = String(t.includes).trim().slice(0, 2000);
      if (t.basePriceCents !== undefined) cur.basePriceCents = cents(t.basePriceCents, `${cur.label} base price`);
      if (t.enabled !== undefined) cur.enabled = Boolean(t.enabled);
    }
  }
  if (Array.isArray(b.adders)) {
    if (b.adders.length > 40) errors.push({ message: "Up to 40 adders." });
    pricing.adders = b.adders.slice(0, 40).map((a, i) => ({
      key: String(a.key || `adder-${i + 1}`).replace(/[^\w-]/g, "").slice(0, 60) || `adder-${i + 1}`,
      label: String(a.label || "").trim().slice(0, 160) || "Additional work",
      trigger: ["manual", "paintAbove", "door", "perGrabBar", "perSeat", "perShelf"].includes(a.trigger) ? a.trigger : "manual",
      priceCents: cents(a.priceCents, a.label || "Adder"),
      enabled: a.enabled !== false,
    }));
  }
  if (Array.isArray(b.packages)) {
    if (b.packages.length > 30) errors.push({ message: "Up to 30 packages." });
    pricing.packages = b.packages.slice(0, 30).map((p, i) => ({
      key: String(p.key || `package-${i + 1}`).replace(/[^\w-]/g, "").slice(0, 60) || `package-${i + 1}`,
      name: String(p.name || "").trim().slice(0, 160) || "Package",
      description: String(p.description || "").trim().slice(0, 1000),
      skus: (Array.isArray(p.skus) ? p.skus : []).map(String).filter((s) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(s)).slice(0, 20),
      priceCents: cents(p.priceCents, p.name || "Package"),
      isPublic: p.isPublic !== false,
      enabled: p.enabled !== false,
    }));
  }
  if (b.maxDiscountPercent !== undefined) {
    const m = Number(b.maxDiscountPercent);
    if (!(m >= 0 && m <= 100)) errors.push({ message: "Maximum discount must be 0–100%." });
    else pricing.maxDiscountPercent = m;
  }
  if (b.disclaimer !== undefined) pricing.disclaimer = String(b.disclaimer).trim().slice(0, 1000) || pricing.disclaimer;
  if (b.privacyNote !== undefined) pricing.privacyNote = String(b.privacyNote).trim().slice(0, 1500) || pricing.privacyNote;
  if (errors.length) throw fail(400, errors[0].message, { errors });
  pricing.version += 1;
  pricing.updatedBy = actorId(req);
  await pricing.save();
  invalidate();
  res.json({ pricing: pricing.toObject() });
}));

// ===================================================================== designs
async function designOr404(id) {
  const d = /^[A-Za-z0-9_-]{16,40}$/.test(String(id)) ? await StudioDesign.findOne({ publicId: String(id) }) : null;
  if (!d) throw fail(404, "Design not found.");
  return d;
}

async function photoView(photoId) {
  if (!photoId) return null;
  const p = await StudioPhoto.findById(photoId).lean();
  if (!p || p.deletedAt) return null;
  return { url: photoUrl(p.publicId), width: p.width, height: p.height };
}

async function snapshotFor(d) {
  if (!d.state?.design) return null;
  const { result } = await quoteDesign(d.state.design, d.projectType, d.adjustments || []);
  return { at: new Date(), pricingVersion: result.pricingVersion, complete: result.complete, missing: result.missing, lines: result.lines, totalCents: result.totalCents };
}

/**
 * A design view carries the whole staff catalog (thousands of products once a
 * manufacturer range is added), and nothing upstream compresses responses:
 * gzip it here when the browser accepts it.
 */
function sendView(req, res, body, status = 200) {
  const text = JSON.stringify(body);
  res.status(status);
  if (text.length > 32 * 1024 && /gzip/.test(String(req.headers["accept-encoding"] || ""))) {
    res.set({ "Content-Type": "application/json; charset=utf-8", "Content-Encoding": "gzip", Vary: "Accept-Encoding" });
    return res.end(require("zlib").gzipSync(text));
  }
  return res.type("application/json").send(text);
}

async function fullView(d, req) {
  const skus = skusOf(d.state?.design);
  const { catalog, products } = await staffCatalog(skus);
  const priceOf = Object.fromEntries(products.map((p) => [p.sku, { priceCents: p.pricing?.priceCents ?? null, installCents: p.pricing?.installCents || 0, status: p.status }]));
  const live = d.state?.design ? await quoteDesign(d.state.design, d.projectType, d.adjustments || []) : null;
  const compat = d.state?.design ? await checkDesign(d.state.design, d.projectType) : null;
  const pricing = await StudioPricing.current();
  return {
    design: {
      id: d.publicId, origin: d.origin, status: d.status, projectType: d.projectType, state: d.state,
      exampleScene: d.exampleScene, measureSource: d.measureSource, measureLabel: MEASURE_LABEL[d.measureSource] || MEASURE_LABEL.standard,
      customer: d.customer, consentAt: d.consentAt, submittedAt: d.submittedAt,
      selections: d.selections, priceSnapshot: d.priceSnapshot, adjustments: d.adjustments,
      leadId: d.leadId, customerId: d.customerId, projectId: d.projectId, estimateId: d.estimateId,
      revisions: (d.revisions || []).map((r) => ({ id: String(r._id), at: r.at, note: r.note, totalCents: r.priceSnapshot?.totalCents ?? null })),
      createdAt: d.createdAt, updatedAt: d.updatedAt,
      photo: await photoView(d.photo),
      preview: await photoView(d.preview),
    },
    live: live?.result || null,
    compat,
    catalog,
    prices: priceOf,
    pricing: { adders: pricing.adders.filter((a) => a.enabled !== false), maxDiscountPercent: pricing.maxDiscountPercent, disclaimer: pricing.disclaimer, projectTypes: pricing.projectTypes },
    can: { adjust: hasPermission(req, PERMISSIONS.STUDIO_PRICE_ADJUST), propose: hasPermission(req, PERMISSIONS.PROJECTS_MANAGE), catalog: hasPermission(req, PERMISSIONS.STUDIO_CATALOG), owner: isOwner(req) },
  };
}

router.get("/designs", ...sellPerm, handle(async (req, res) => {
  const q = {};
  if (req.query.status && req.query.status !== "all") q.status = String(req.query.status);
  else q.status = { $ne: "archived" };
  if (req.query.origin) q.origin = String(req.query.origin);
  if (!req.query.status) q.$or = [{ origin: "staff" }, { status: { $ne: "draft" } }]; // anonymous unsent drafts stay private
  const text = String(req.query.q || "").trim().slice(0, 80);
  if (text) {
    const rx = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    q.$and = [{ $or: [{ "customer.name": rx }, { "customer.email": rx }, { "customer.phone": rx }, { "customer.zip": rx }] }];
  }
  const list = await StudioDesign.find(q).sort({ updatedAt: -1 }).limit(200).select("publicId origin status projectType exampleScene measureSource customer.name customer.email customer.phone customer.zip priceSnapshot.totalCents priceSnapshot.complete submittedAt updatedAt createdAt photo preview leadId projectId").lean();
  const photos = await StudioPhoto.find({ _id: { $in: list.flatMap((d) => [d.preview, d.photo]).filter(Boolean) }, deletedAt: null }).select("publicId").lean();
  const pmap = new Map(photos.map((p) => [String(p._id), p.publicId]));
  res.json({
    designs: list.map((d) => ({
      id: d.publicId, origin: d.origin, status: d.status, projectType: d.projectType,
      exampleScene: d.exampleScene, measureSource: d.measureSource,
      customer: d.customer, totalCents: d.priceSnapshot?.totalCents ?? null, priceComplete: d.priceSnapshot?.complete ?? null,
      submittedAt: d.submittedAt, updatedAt: d.updatedAt, createdAt: d.createdAt,
      // the rendered design first (requests without a photo have one), else the customer photo
      thumb: [d.preview, d.photo].map((x) => x && pmap.get(String(x))).find(Boolean) ? photoUrl([d.preview, d.photo].map((x) => x && pmap.get(String(x))).find(Boolean)) : null,
      leadId: d.leadId, projectId: d.projectId,
    })),
  });
}));

/** Find the design behind a lead (Leads tab -> "Open in Shower Studio"). */
router.get("/designs/by-lead/:leadId", ...sellPerm, handle(async (req, res) => {
  if (!validId(req.params.leadId)) throw fail(404, "Not found.");
  const d = await StudioDesign.findOne({ leadId: req.params.leadId }).select("publicId").lean();
  if (!d) throw fail(404, "No Studio design for this lead.");
  res.json({ id: d.publicId });
}));

router.post("/designs", ...sellPerm, json, handle(async (req, res) => {
  const b = req.body || {};
  const c = b.customer || {};
  const d = await StudioDesign.create({
    publicId: randomId(16), origin: "staff", status: "draft",
    projectType: ["tub-to-shower", "shower-replacement", "tub-replacement"].includes(b.projectType) ? b.projectType : "tub-to-shower",
    customer: {
      name: String(c.name || "").trim().slice(0, 160), email: String(c.email || "").trim().toLowerCase().slice(0, 254),
      phone: String(c.phone || "").trim().slice(0, 40), address: String(c.address || "").trim().slice(0, 500), zip: String(c.zip || "").trim().slice(0, 10),
    },
    customerId: validId(b.customerId) ? b.customerId : null,
    createdBy: actorId(req), updatedBy: actorId(req),
  });
  sendView(req, res, await fullView(d, req), 201);
}));

router.get("/designs/:id", ...sellPerm, handle(async (req, res) => {
  const d = await designOr404(req.params.id);
  if (d.origin === "public" && d.status === "draft") throw fail(404, "Design not found."); // a visitor's unsent draft is theirs
  sendView(req, res, await fullView(d, req));
}));

/** Save the design (staff edit). Every save keeps a revision. */
router.put("/designs/:id", ...sellPerm, json, handle(async (req, res) => {
  const d = await designOr404(req.params.id);
  if (d.origin === "public" && d.status === "draft") throw fail(404, "Design not found.");
  if (d.status === "signed") throw fail(409, "This design is signed. Start a new revision from Projects (change order) instead.");
  const b = req.body || {};
  const photo = d.photo ? await StudioPhoto.findById(d.photo).lean() : d.exampleScene ? EXAMPLE_SCENES[d.exampleScene] : null;
  if (b.state) d.state = validateState(b.state, photo);
  if (MEASURE_SOURCES.includes(b.measureSource)) d.measureSource = b.measureSource;
  if (["tub-to-shower", "shower-replacement", "tub-replacement"].includes(b.projectType)) d.projectType = b.projectType;
  if (b.customer) {
    const c = b.customer;
    for (const [k, max] of [["name", 160], ["phone", 40], ["address", 500], ["zip", 10], ["notes", 2000]]) if (c[k] !== undefined) d.customer[k] = String(c[k]).trim().slice(0, max);
    if (c.email !== undefined) d.customer.email = String(c.email).trim().toLowerCase().slice(0, 254);
  }
  if (b.status && ["in_review", "closed", "archived", "submitted"].includes(b.status)) d.status = b.status;
  else if (d.status === "submitted") d.status = "in_review";
  d.priceSnapshot = await snapshotFor(d);
  if (d.state) {
    d.selections = (await quoteDesign(d.state.design, d.projectType, d.adjustments)).result.selections;
    d.revisions.push({ by: actorId(req), note: String(b.note || "").slice(0, 500), state: d.state, priceSnapshot: d.priceSnapshot });
    if (d.revisions.length > 40) d.revisions.splice(0, d.revisions.length - 40);
  }
  d.updatedBy = actorId(req);
  d.markModified("state");
  await d.save();
  sendView(req, res, await fullView(d, req));
}));

/** Price preview for unsaved changes (full lines; staff only). */
router.post("/designs/:id/quote", ...sellPerm, json, handle(async (req, res) => {
  const d = await designOr404(req.params.id);
  const photo = d.photo ? await StudioPhoto.findById(d.photo).lean() : d.exampleScene ? EXAMPLE_SCENES[d.exampleScene] : null;
  const state = req.body?.state ? validateState(req.body.state, photo) : d.state;
  if (!state) throw fail(400, "No design yet.");
  const projectType = req.body?.projectType || d.projectType;
  const { result } = await quoteDesign(state.design, projectType, d.adjustments || []);
  const compat = await checkDesign(state.design, projectType);
  res.json({ live: result, compat });
}));

router.post("/designs/:id/photo", ...sellPerm, (req, res) => {
  upload.single("photo")(req, res, (uploadError) => handle(async () => {
    if (uploadError) throw fail(400, uploadError.code === "LIMIT_FILE_SIZE" ? "Images must be 20 MB or smaller." : "Upload one image.");
    const d = await designOr404(req.params.id);
    if (!req.file) throw fail(400, "Choose a photo.");
    let clean;
    try { clean = await sanitizeImageBuffer(req.file.buffer); } catch (e) { throw fail(400, e.message); }
    const meta = await require("sharp")(clean.buffer).metadata();
    const key = storage.newKey("photos");
    await storage.put(key, clean.buffer, "image/jpeg");
    const p = await StudioPhoto.create({
      publicId: randomId(18), designId: d._id, storageKey: key, contentType: "image/jpeg", bytes: clean.buffer.length,
      width: meta.width, height: meta.height, sha256: crypto.createHash("sha256").update(clean.buffer).digest("hex"),
    });
    d.photo = p._id;
    d.exampleScene = null;
    d.state = null; // the dots belong to the old photo (the old photo stays with past revisions)
    d.updatedBy = actorId(req);
    await d.save();
    sendView(req, res, await fullView(d, req), 201);
  })(req, res));
});

/** Price adjustments: manual adders (studio.sell), overrides and discounts (studio.priceAdjust). */
router.post("/designs/:id/adjustments", ...sellPerm, json, handle(async (req, res) => {
  const d = await designOr404(req.params.id);
  if (d.status === "signed") throw fail(409, "This design is signed.");
  const b = req.body || {};
  const kind = String(b.kind || "");
  if (!["adder", "override", "discount"].includes(kind)) throw fail(400, "Unknown adjustment.");
  if (kind !== "adder" && !hasPermission(req, PERMISSIONS.STUDIO_PRICE_ADJUST)) throw fail(403, "You are not allowed to change prices. Ask the owner for price adjustments.");
  const reason = String(b.reason || "").trim().slice(0, 500);
  if (kind !== "adder" && reason.length < 3) throw fail(400, "Give a reason for the price change.");
  const adj = { kind, key: String(b.key || "").slice(0, 60), label: String(b.label || "").trim().slice(0, 240), reason, by: actorId(req), at: new Date() };
  if (kind === "adder") {
    // a manual adder from the price list; an explicit amount (if any) replaces its listed price
    const pricing = await StudioPricing.current();
    const listed = pricing.adders.find((x) => x.key === adj.key && x.enabled !== false);
    if (!listed && !(Number(b.amountCents) > 0 && adj.label)) throw fail(400, "Choose an adder from the price list, or give a label and an amount.");
    if (!adj.label && listed) adj.label = listed.label;
    adj.amountCents = Number(b.amountCents) > 0 ? Math.round(Number(b.amountCents)) : 0;
    if (Number(b.amountCents) > 0 && listed && !hasPermission(req, PERMISSIONS.STUDIO_PRICE_ADJUST)) throw fail(403, "Changing an adder's price needs price-adjust access.");
  } else if (kind === "discount" && Number(b.percent) > 0) adj.percent = Math.min(100, Number(b.percent));
  else adj.amountCents = Math.round(Number(b.amountCents));
  if (kind !== "adder" && (kind !== "discount" || !adj.percent)) {
    if (!Number.isFinite(adj.amountCents) || adj.amountCents < 0 || adj.amountCents > 1_000_000_00) throw fail(400, "Enter an amount between $0 and $1,000,000.");
  }
  if (kind === "discount") {
    const pricing = await StudioPricing.current();
    const { result } = await quoteDesign(d.state?.design || {}, d.projectType, d.adjustments || []);
    if (!discountAllowed({ subtotalCents: result.subtotalCents, percent: adj.percent, amountCents: adj.amountCents, pricing, isOwner: isOwner(req) })) {
      throw fail(403, `Discounts above ${pricing.maxDiscountPercent}% need the owner.`);
    }
  }
  d.adjustments.push(adj);
  d.priceSnapshot = await snapshotFor(d);
  d.updatedBy = actorId(req);
  await d.save();
  sendView(req, res, await fullView(d, req), 201);
}));

router.delete("/designs/:id/adjustments/:adjId", ...sellPerm, handle(async (req, res) => {
  const d = await designOr404(req.params.id);
  const adj = d.adjustments.id(req.params.adjId);
  if (!adj) throw fail(404, "Adjustment not found.");
  if (adj.kind !== "adder" && !hasPermission(req, PERMISSIONS.STUDIO_PRICE_ADJUST)) throw fail(403, "You are not allowed to change prices.");
  adj.deleteOne();
  d.priceSnapshot = await snapshotFor(d);
  await d.save();
  sendView(req, res, await fullView(d, req));
}));

/** A rendered preview of the design (stored privately; shown to staff and in the lead). */
router.post("/designs/:id/preview", ...sellPerm, (req, res) => {
  upload.single("preview")(req, res, (uploadError) => handle(async () => {
    if (uploadError) throw fail(400, "Upload one image.");
    const d = await designOr404(req.params.id);
    if (!req.file) throw fail(400, "No preview image.");
    await storePreview(d, req.file.buffer);
    res.status(201).json({ ok: true });
  })(req, res));
});

async function storePreview(d, buffer) {
  let clean;
  try { clean = await sanitizeImageBuffer(buffer); } catch (e) { throw fail(400, e.message); }
  const meta = await require("sharp")(clean.buffer).metadata();
  const key = storage.newKey("previews");
  await storage.put(key, clean.buffer, "image/jpeg");
  const p = await StudioPhoto.create({
    publicId: randomId(18), designId: d._id, kind: "preview", storageKey: key, contentType: "image/jpeg", bytes: clean.buffer.length,
    width: meta.width, height: meta.height, sha256: crypto.createHash("sha256").update(clean.buffer).digest("hex"),
  });
  const old = d.preview;
  d.preview = p._id;
  await d.save();
  if (old) {
    const o = await StudioPhoto.findById(old);
    if (o && !o.deletedAt) { await storage.remove(o.storageKey).catch(() => {}); o.deletedAt = new Date(); await o.save(); }
  }
}

/**
 * Create the proposal: a Bathroom Project (or the design's existing one) and an
 * Estimate reproducing the design's price exactly. The contract and signature
 * then follow the existing Projects workflow.
 */
router.post("/designs/:id/proposal", ...sellPerm, json, handle(async (req, res) => {
  if (!hasPermission(req, PERMISSIONS.PROJECTS_MANAGE)) throw fail(403, "Creating a proposal needs access to Projects.");
  const Project = require("../models/Project");
  const Estimate = require("../models/Estimate");
  const { estimateFromSnapshot, scopeText, TYPE_LABEL } = require("../utils/studio/proposal");
  const d = await designOr404(req.params.id);
  if (d.origin === "public" && d.status === "draft") throw fail(404, "Design not found.");
  if (!d.state?.design) throw fail(400, "Finish the design first.");
  const compat = await checkDesign(d.state.design, d.projectType);
  const block = blockingErrors(compat);
  if (block.length) throw fail(400, `Fix the design first: ${block[0].message}`);
  const c = d.customer || {};
  if (!c.name || !(c.address || c.zip)) throw fail(400, "Add the customer's name and address first.");
  d.priceSnapshot = await snapshotFor(d); // freeze the current price
  const est = estimateFromSnapshot(d.priceSnapshot);

  let project = d.projectId ? await Project.findOne({ _id: d.projectId, isDeleted: { $ne: true } }) : null;
  if (!project) {
    project = await Project.create({
      customerName: c.name, phone: c.phone || "", email: c.email || "",
      address: c.address ? `${c.address}${c.zip && !c.address.includes(c.zip) ? ` ${c.zip}` : ""}` : `ZIP ${c.zip}`,
      customerId: d.customerId || null, projectType: "Bathroom", status: "Lead",
      customerSnapshot: { fullName: c.name, email: c.email || "", phone: c.phone || "" },
      notes: `Created from Shower Studio design ${d.publicId}.`,
    });
  }
  const estimate = await Estimate.create({
    projectId: project._id, status: "Draft",
    title: `${TYPE_LABEL[d.projectType]} - Shower Studio design`,
    description: scopeText(d),
    lineItems: est.lineItems, discount: est.discount, tax: 0,
    notes: `Price frozen from Shower Studio design ${d.publicId} on ${new Date().toISOString().slice(0, 10)}.`,
    createdBy: actorId(req),
  });
  project.estimateAmount = estimate.total;
  await project.save();
  d.projectId = project._id;
  d.estimateId = estimate._id;
  d.status = "proposal";
  d.revisions.push({ by: actorId(req), note: `Proposal created: ${project.projectNumber} / ${estimate.estimateNumber}`, state: d.state, priceSnapshot: d.priceSnapshot });
  d.updatedBy = actorId(req);
  await d.save();
  res.status(201).json({
    projectId: String(project._id), projectNumber: project.projectNumber,
    estimateId: String(estimate._id), estimateNumber: estimate.estimateNumber, total: estimate.total,
    next: "Open the project in Projects to attach the contract and send it for signature.",
  });
}));

/** Delete a design's private data (photos), keeping a minimal record of the request. */
router.delete("/designs/:id", ...sellPerm, handle(async (req, res) => {
  const d = await designOr404(req.params.id);
  if (d.status === "signed" || d.status === "proposal") throw fail(409, "This design has a proposal; manage it from Projects.");
  const photos = await StudioPhoto.find({ designId: d._id, deletedAt: null });
  for (const p of photos) { await storage.remove(p.storageKey).catch(() => {}); p.deletedAt = new Date(); await p.save(); }
  d.photo = null; d.preview = null; d.state = null; d.revisions = []; d.status = "archived";
  d.updatedBy = actorId(req);
  await d.save();
  res.json({ ok: true });
}));

module.exports = router;
module.exports._snapshotFor = snapshotFor;
module.exports._fullView = fullView;
module.exports._designOr404 = designOr404;
module.exports._blockingErrors = blockingErrors;
