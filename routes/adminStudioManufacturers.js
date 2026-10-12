/**
 * Manufacturer catalogs in Admin - mounted at /api/admin/studio/manufacturers
 * (inside adminStudio, after its auth). Everything needs studio.catalog;
 * recording image rights is owner only.
 *
 *   GET    /                         manufacturers, counts, rights, last import
 *   GET    /:key                     detail: colours, patterns, groups
 *   PUT    /:key                     image rights (owner) and settings
 *   GET    /:key/imports             import history
 *   POST   /:key/imports             upload a price file -> preview (nothing changes)
 *   GET    /:key/imports/:id         one import (preview or result)
 *   POST   /:key/imports/:id/apply   apply a preview (optionally some groups)
 *   GET    /:key/series              product series (families) with counts
 *   GET    /:key/items               variants (search, filters, paging)
 *   GET    /:key/items/:part         one variant, with what the designer can draw
 *   POST   /:key/add-to-studio       variants -> draft Studio products (no prices)
 *   POST   /:key/link-check          check image/document links (background)
 *   PUT    /:key/colors/:code        the owner's colour for drawing
 *   POST   /:key/colors/:code/assets swatch or texture image
 *   DELETE /:key/colors/:code/assets/:kind
 */
const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const mongoose = require("mongoose");
const { PERMISSIONS, requirePermission } = require("../middleware/authorize");
const StudioSupplierItem = require("../models/studio/StudioSupplierItem");
const StudioCatalogImport = require("../models/studio/StudioCatalogImport");
const StudioManufacturer = require("../models/studio/StudioManufacturer");
const StudioProduct = require("../models/studio/StudioProduct");
const StudioAsset = require("../models/studio/StudioAsset");
const { ADAPTERS, adapterFor } = require("../utils/studio/manufacturers");
const { GROUPS } = require("../utils/studio/manufacturers/abgEpf");
const { previewImport, applyImport } = require("../utils/studio/manufacturers/importService");
const { addToStudio } = require("../utils/studio/manufacturers/studioLink");
const { runLinkCheck, statusFor } = require("../utils/studio/manufacturers/media");
const { sanitizeImageBuffer } = require("../utils/imageSanitizer");
const storage = require("../utils/studio/storage");
const { randomId } = require("../utils/studio/signedLinks");
const { invalidate } = require("../utils/studio/catalogService");

const router = express.Router();
const json = express.json({ limit: "256kb" });
const catalogPerm = requirePermission(PERMISSIONS.STUDIO_CATALOG);
const xlsxUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 4 } });
const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 8 } });
const actorId = (req) => req.accessUser?._id || req.user?.id || null;
const isOwner = (req) => req.accessRole === "admin";
const fail = (status, message, extra) => Object.assign(new Error(message), { status, extra });
const HEX = /^#[0-9a-f]{6}$/i;
const escapeRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ message: e.message, ...(e.extra || {}) });
      if (e.name === "ValidationError") return res.status(400).json({ message: e.message });
      console.error(`admin studio manufacturers ${req.method} ${req.path} failed:`, e);
      return res.status(500).json({ message: "Something went wrong. Please try again." });
    }
  };
}

router.use(...catalogPerm);

/**
 * The best preview photo among candidates: one whose link check passed, then
 * the manufacturer's primary image host (adapter.mediaHosts order).
 */
function pickPhoto(a, urls, checks) {
  const host = (u) => { try { const i = a.mediaHosts.indexOf(new URL(u).hostname); return i < 0 ? 99 : i; } catch { return 99; } };
  const score = (u) => { const c = checks.get(u); return (c ? (c.status === "ok" ? 0 : 200) : 100) + host(u); };
  return [...new Set(urls.filter(Boolean))].sort((x, y) => score(x) - score(y))[0] || null;
}

function adapterOr404(req) {
  const a = adapterFor(String(req.params.key || ""));
  if (!a) throw fail(404, "Unknown manufacturer.");
  return a;
}

function rightsView(m) {
  const r = m.imageRights || {};
  return { status: r.status || "unconfirmed", note: r.note || "", evidenceUrl: r.evidenceUrl || "", decidedAt: r.decidedAt || null };
}

async function counts(key) {
  const [byGroup, byAvailability, inStudio, studioProducts] = await Promise.all([
    StudioSupplierItem.aggregate([{ $match: { manufacturer: key } }, { $group: { _id: "$group", variants: { $sum: 1 }, models: { $addToSet: "$baseModel" }, series: { $addToSet: "$seriesKey" } } }]),
    StudioSupplierItem.aggregate([{ $match: { manufacturer: key } }, { $group: { _id: "$availability", n: { $sum: 1 } } }]),
    StudioSupplierItem.countDocuments({ manufacturer: key, studioSku: { $ne: null } }),
    StudioProduct.aggregate([{ $match: { "source.manufacturer": key } }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
  ]);
  const g = new Map(byGroup.map((x) => [x._id, x]));
  return {
    variants: byGroup.reduce((s, x) => s + x.variants, 0),
    groups: GROUPS.filter((x) => g.has(x.key)).map((x) => ({ key: x.key, label: x.label, variants: g.get(x.key).variants, models: g.get(x.key).models.length, series: g.get(x.key).series.length })),
    availability: Object.fromEntries(byAvailability.map((x) => [x._id, x.n])),
    inStudio,
    studioProducts: Object.fromEntries(studioProducts.map((x) => [x._id, x.n])),
  };
}

const importView = (i, full = false) => ({
  id: String(i._id), manufacturer: i.manufacturer, fileName: i.fileName, fileBytes: i.fileBytes, status: i.status, error: i.error,
  summary: i.summary, scope: i.scope, result: i.result, createdAt: i.createdAt, appliedAt: i.appliedAt, durationMs: i.durationMs,
  ...(full ? { samples: i.samples, issues: i.issues } : { issueCounts: i.summary?.issues || null }),
});

router.get("/", handle(async (_req, res) => {
  const out = [];
  for (const a of Object.values(ADAPTERS)) {
    const m = await StudioManufacturer.forKey(a.key);
    const [c, lastApplied, pending] = await Promise.all([
      counts(a.key),
      StudioCatalogImport.findOne({ manufacturer: a.key, status: "applied" }).sort({ appliedAt: -1 }).lean(),
      StudioCatalogImport.findOne({ manufacturer: a.key, status: { $in: ["previewed", "applying"] } }).sort({ createdAt: -1 }).lean(),
    ]);
    out.push({ key: a.key, name: a.name, company: a.company, website: a.website, fileHelp: a.fileHelp, imageRights: rightsView(m), settings: { trimAllowanceIn: m.settings?.trimAllowanceIn ?? a.DEFAULT_TRIM_ALLOWANCE_IN }, linkCheck: m.linkCheck, counts: c, lastImport: lastApplied ? importView(lastApplied) : null, pendingImport: pending ? importView(pending) : null });
  }
  res.json({ manufacturers: out, groups: GROUPS.map(({ key, label }) => ({ key, label })) });
}));

async function colorsView(a, m) {
  const used = await StudioSupplierItem.aggregate([{ $match: { manufacturer: a.key } }, { $group: { _id: "$color.code", name: { $first: "$color.name" }, n: { $sum: 1 } } }]);
  const usedBy = new Map(used.map((u) => [u._id, u]));
  const assetIds = (m.colors || []).flatMap((c) => [c.swatchAssetId, c.textureAssetId]).filter(Boolean);
  const assets = assetIds.length ? await StudioAsset.find({ _id: { $in: assetIds } }).select("publicId").lean() : [];
  const url = (id) => { const x = assets.find((y) => String(y._id) === String(id)); return x ? `/api/studio/assets/${x.publicId}` : null; };
  return a.COLORS.map((c) => {
    const ov = (m.colors || []).find((x) => x.code === c.code) || {};
    return {
      code: c.code, name: c.name, series: c.series, materials: c.materials, look: c.look || null,
      manufacturerSwatchUrl: c.swatchUrl, measuredHex: c.approxHex, measuredFrom: c.approxSource === "generic" ? "generic" : c.approxHex ? "swatch" : null,
      ownHex: ov.approxHex || null,
      swatch: ov.swatchAssetId ? { assetId: String(ov.swatchAssetId), url: url(ov.swatchAssetId) } : null,
      texture: ov.textureAssetId ? { assetId: String(ov.textureAssetId), url: url(ov.textureAssetId), widthIn: ov.textureWidthIn, heightIn: ov.textureHeightIn, source: ov.textureSource } : null,
      variants: usedBy.get(c.code)?.n || 0,
    };
  });
}

router.get("/:key", handle(async (req, res) => {
  const a = adapterOr404(req);
  const m = await StudioManufacturer.forKey(a.key);
  res.json({
    manufacturer: { key: a.key, name: a.name, company: a.company, website: a.website, fileHelp: a.fileHelp, sourceUrl: a.sourceUrl, imageRights: rightsView(m), settings: { trimAllowanceIn: m.settings?.trimAllowanceIn ?? a.DEFAULT_TRIM_ALLOWANCE_IN }, linkCheck: m.linkCheck },
    counts: await counts(a.key),
    colors: await colorsView(a, m),
    patterns: a.PATTERNS.map((p) => ({ code: p.code, name: p.name, pattern: p.pattern, manufacturerImageUrl: p.imageUrl })),
    groups: GROUPS.map(({ key, label }) => ({ key, label })),
  });
}));

router.put("/:key", json, handle(async (req, res) => {
  const a = adapterOr404(req);
  const b = req.body || {};
  const m = await StudioManufacturer.forKey(a.key);
  if (b.imageRights !== undefined) {
    if (!isOwner(req)) throw fail(403, "Only the owner can record image rights.");
    const status = ["unconfirmed", "approved", "denied"].includes(b.imageRights?.status) ? b.imageRights.status : null;
    if (!status) throw fail(400, "Choose unconfirmed, approved or denied.");
    const note = String(b.imageRights.note || "").trim().slice(0, 2000);
    if (status === "approved" && note.length < 10) throw fail(400, "Describe the permission you have (who granted it, when, and what it covers).");
    const evidenceUrl = String(b.imageRights.evidenceUrl || "").trim();
    if (evidenceUrl && !/^https?:\/\//.test(evidenceUrl)) throw fail(400, "The evidence link must be a web address.");
    m.imageRights = { status, note, evidenceUrl: evidenceUrl.slice(0, 600), decidedBy: actorId(req), decidedAt: new Date() };
  }
  if (b.settings?.trimAllowanceIn !== undefined) {
    const v = b.settings.trimAllowanceIn === null || b.settings.trimAllowanceIn === "" ? null : Number(b.settings.trimAllowanceIn);
    if (v !== null && !(v >= 0 && v <= 24)) throw fail(400, "Trim allowance must be 0–24 inches.");
    m.settings = { ...(m.settings?.toObject?.() || m.settings || {}), trimAllowanceIn: v };
  }
  await m.save();
  res.json({ imageRights: rightsView(m), settings: { trimAllowanceIn: m.settings?.trimAllowanceIn ?? a.DEFAULT_TRIM_ALLOWANCE_IN } });
}));

// ------------------------------------------------------------------ imports
router.get("/:key/imports", handle(async (req, res) => {
  const a = adapterOr404(req);
  const list = await StudioCatalogImport.find({ manufacturer: a.key }).sort({ createdAt: -1 }).limit(40).select("-samples -issues").lean();
  res.json({ imports: list.map((i) => importView(i)) });
}));

router.get("/:key/imports/:id", handle(async (req, res) => {
  const a = adapterOr404(req);
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) throw fail(404, "Import not found.");
  const i = await StudioCatalogImport.findOne({ _id: req.params.id, manufacturer: a.key }).lean();
  if (!i) throw fail(404, "Import not found.");
  res.json({ import: importView(i, true) });
}));

router.post("/:key/imports", (req, res) => {
  xlsxUpload.single("file")(req, res, (err) => handle(async () => {
    const a = adapterOr404(req);
    if (err) throw fail(400, err.code === "LIMIT_FILE_SIZE" ? "The file is larger than 20 MB." : "Upload one .xlsx file.");
    if (!req.file) throw fail(400, "Choose the manufacturer's .xlsx price file.");
    if (!/\.xlsx$/i.test(req.file.originalname || "")) throw fail(400, "The file must be an Excel workbook (.xlsx).");
    const imp = await previewImport({ key: a.key, buffer: req.file.buffer, fileName: req.file.originalname, actorId: actorId(req) });
    res.status(201).json({ import: importView(imp.toObject(), true) });
  })(req, res));
});

router.post("/:key/imports/:id/apply", json, handle(async (req, res) => {
  const a = adapterOr404(req);
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) throw fail(404, "Import not found.");
  const groups = Array.isArray(req.body?.groups) ? req.body.groups : null;
  // Runs in the background; the page follows its status.
  const job = applyImport({ key: a.key, importId: req.params.id, groups, actorId: actorId(req) });
  const settled = await Promise.race([job.then(() => "done", (e) => e), new Promise((r) => setTimeout(() => r("running"), 1500))]);
  if (settled instanceof Error) throw settled;
  if (settled === "running") job.catch(() => {});
  const i = await StudioCatalogImport.findById(req.params.id).lean();
  res.status(settled === "running" ? 202 : 200).json({ import: importView(i, true) });
}));

// ------------------------------------------------------------------ browsing
function itemFilter(key, q) {
  const f = { manufacturer: key };
  if (q.group && GROUPS.some((g) => g.key === q.group)) f.group = String(q.group);
  if (q.series) f.seriesKey = String(q.series).slice(0, 200);
  const av = String(q.availability || "current");
  if (av === "current") f.availability = { $in: ["active", "special-order"] };
  else if (["active", "special-order", "discontinued", "unlisted"].includes(av)) f.availability = av;
  if (q.inStudio === "yes") f.studioSku = { $ne: null };
  if (q.inStudio === "no") f.studioSku = null;
  if (q.color) f["color.code"] = String(q.color).slice(0, 10);
  const term = String(q.q || "").trim().slice(0, 60);
  if (term) {
    const rx = new RegExp(escapeRx(term), "i");
    const starts = new RegExp(`^${escapeRx(term.replace(/[\s-]/g, ""))}`, "i");
    f.$or = [{ partNumber: starts }, { baseModel: starts }, { modelNumber: rx }, { name: rx }, { upc: term }];
  }
  return f;
}

router.get("/:key/series", handle(async (req, res) => {
  const a = adapterOr404(req);
  const rows = await StudioSupplierItem.aggregate([
    { $match: itemFilter(a.key, { ...req.query, series: undefined }) },
    { $group: {
      _id: "$seriesKey", seriesName: { $first: "$seriesName" }, group: { $first: "$group" }, variants: { $sum: 1 },
      models: { $addToSet: "$baseModel" }, colors: { $addToSet: "$color.name" }, priceMin: { $min: "$listPriceCents" }, priceMax: { $max: "$listPriceCents" },
      inStudio: { $sum: { $cond: [{ $ne: ["$studioSku", null] }, 1, 0] } }, photos: { $addToSet: { $arrayElemAt: [{ $filter: { input: "$media", as: "m", cond: { $eq: ["$m.kind", "photo"] } } }, 0] } },
    } },
    { $sort: { variants: -1 } },
    { $limit: 300 },
  ]);
  const order = new Map(GROUPS.map((g, i) => [g.key, i]));
  rows.sort((x, y) => (order.get(x.group) - order.get(y.group)) || (y.variants - x.variants));
  for (const r of rows) r.photoUrls = (r.photos || []).map((p) => p?.url).filter(Boolean).slice(0, 40);
  const checks = await statusFor(rows.flatMap((r) => r.photoUrls));
  res.json({ series: rows.map((r) => ({ key: r._id, name: r.seriesName, group: r.group, variants: r.variants, models: r.models.length, colors: r.colors.filter(Boolean).sort(), priceMinCents: r.priceMin, priceMaxCents: r.priceMax, inStudio: r.inStudio, photoUrl: pickPhoto(a, r.photoUrls, checks) })) });
}));

function itemRow(a, it, checks = new Map()) {
  const m = a.studioMapping(it);
  return {
    partNumber: it.partNumber, modelNumber: it.modelNumber, baseModel: it.baseModel, name: it.name, seriesName: it.seriesName, seriesKey: it.seriesKey, group: it.group,
    color: it.color, surface: it.surface, material: it.material, configuration: it.configuration, dims: it.dims,
    listPriceCents: it.listPriceCents, listPriceEffective: it.listPriceEffective, availability: it.availability, programs: it.programs, discontinuedAt: it.discontinuedAt,
    studioSku: it.studioSku, photoUrl: pickPhoto(a, (it.media || []).filter((x) => x.kind === "photo").map((x) => x.url), checks),
    designer: m.supported ? { supported: true, category: m.category, type: m.type } : { supported: false, reason: m.reason },
  };
}

router.get("/:key/items", handle(async (req, res) => {
  const a = adapterOr404(req);
  const page = Math.max(1, Math.min(500, Number(req.query.page) || 1));
  const per = Math.max(10, Math.min(200, Number(req.query.per) || 60));
  const f = itemFilter(a.key, req.query);
  const [total, list] = await Promise.all([
    StudioSupplierItem.countDocuments(f),
    StudioSupplierItem.find(f).sort({ group: 1, seriesKey: 1, baseModel: 1, "color.name": 1 }).skip((page - 1) * per).limit(per).select("-attributes -priceHistory").lean(),
  ]);
  const checks = await statusFor(list.flatMap((it) => (it.media || []).filter((x) => x.kind === "photo").map((x) => x.url)));
  res.json({ total, page, per, items: list.map((it) => itemRow(a, it, checks)) });
}));

router.get("/:key/items/:part", handle(async (req, res) => {
  const a = adapterOr404(req);
  const it = await StudioSupplierItem.findOne({ manufacturer: a.key, partNumber: String(req.params.part) }).lean();
  if (!it) throw fail(404, "Not in the imported catalog.");
  const m = await StudioManufacturer.forKey(a.key);
  const mapping = a.studioMapping(it, { trimAllowanceIn: m.settings?.trimAllowanceIn ?? a.DEFAULT_TRIM_ALLOWANCE_IN });
  const checks = await statusFor(it.media.map((x) => x.url));
  const product = it.studioSku ? await StudioProduct.findOne({ sku: it.studioSku }).select("_id status pricing.priceCents pricing.costCents compatibility.status").lean() : null;
  const siblings = await StudioSupplierItem.find({ manufacturer: a.key, baseModel: it.baseModel }).select("partNumber color listPriceCents availability studioSku").sort({ "color.name": 1 }).lean();
  res.json({
    item: {
      ...itemRow(a, it, checks), upc: it.upc, variantId: it.variantId, features: it.features, warranty: it.warranty, installationType: it.installationType, shape: it.shape, pieces: it.pieces,
      accessibility: it.accessibility, codeCompliancy: it.codeCompliancy, attributes: it.attributes, priceHistory: it.priceHistory,
      media: it.media.map((x) => ({ ...x, check: checks.get(x.url) ? { status: checks.get(x.url).status, httpStatus: checks.get(x.url).httpStatus, error: checks.get(x.url).error, checkedAt: checks.get(x.url).checkedAt } : null })),
    },
    designer: mapping.supported ? { supported: true, category: mapping.category, type: mapping.type, approximations: mapping.approximations, unit: Boolean(mapping.companion) } : { supported: false, reason: mapping.reason },
    product: product ? { id: String(product._id), status: product.status, priceCents: product.pricing?.priceCents ?? null, costCents: product.pricing?.costCents ?? null, compatibility: product.compatibility?.status } : null,
    variants: siblings.map((s) => ({ partNumber: s.partNumber, color: s.color, listPriceCents: s.listPriceCents, availability: s.availability, inStudio: Boolean(s.studioSku) })),
    imageRights: rightsView(m),
  });
}));

router.post("/:key/add-to-studio", json, handle(async (req, res) => {
  const a = adapterOr404(req);
  const out = await addToStudio({ key: a.key, partNumbers: req.body?.partNumbers, actorId: actorId(req) });
  res.status(out.added.length ? 201 : 200).json(out);
}));

router.post("/:key/link-check", handle(async (req, res) => {
  const a = adapterOr404(req);
  const m = await StudioManufacturer.forKey(a.key);
  if (m.linkCheck?.status === "running" && m.linkCheck.startedAt > new Date(Date.now() - 2 * 3600 * 1000)) throw fail(409, "A link check is already running.");
  runLinkCheck({ key: a.key }).catch((e) => console.error(JSON.stringify({ event: "studio_link_check_failed", manufacturer: a.key, error: String(e.message).slice(0, 200) })));
  res.status(202).json({ started: true });
}));

// ------------------------------------------------------------------ colours, swatches, textures
function colorOr404(a, code) {
  const c = a.COLORS.find((x) => x.code === String(code));
  if (!c) throw fail(404, "Unknown colour.");
  return c;
}
function colorEntry(m, code) {
  let e = m.colors.find((x) => x.code === code);
  if (!e) { m.colors.push({ code }); e = m.colors.find((x) => x.code === code); }
  return e;
}

router.put("/:key/colors/:code", json, handle(async (req, res) => {
  const a = adapterOr404(req);
  const c = colorOr404(a, req.params.code);
  const hex = req.body?.hex === null || req.body?.hex === "" ? null : String(req.body?.hex || "");
  if (hex !== null && !HEX.test(hex)) throw fail(400, "Use a colour like #e9e8dc.");
  const m = await StudioManufacturer.forKey(a.key);
  colorEntry(m, c.code).approxHex = hex;
  await m.save();
  res.json({ colors: await colorsView(a, m) });
}));

router.post("/:key/colors/:code/assets", (req, res) => {
  imageUpload.single("file")(req, res, (err) => handle(async () => {
    const a = adapterOr404(req);
    const c = colorOr404(a, req.params.code);
    if (err) throw fail(400, err.code === "LIMIT_FILE_SIZE" ? "Images must be 20 MB or smaller." : "Upload one image.");
    if (!req.file) throw fail(400, "Choose an image.");
    const kind = req.body?.kind === "texture" ? "texture" : "swatch";
    let w = null, h = null, textureSource = null;
    if (kind === "texture") {
      w = Number(req.body.widthIn); h = Number(req.body.heightIn);
      if (!(w >= 1 && w <= 240 && h >= 1 && h <= 240)) throw fail(400, "Give the real-world size of one repeat of the texture in inches (1–240).");
      textureSource = req.body.textureSource === "manufacturer" ? "manufacturer" : req.body.textureSource === "approximation" ? "approximation" : null;
      if (!textureSource) throw fail(400, "Say whether this texture came from the manufacturer or is an approximation for testing.");
    }
    let clean;
    try { clean = await sanitizeImageBuffer(req.file.buffer); } catch (e) { throw fail(400, e.message); }
    const meta = await require("sharp")(clean.buffer).metadata();
    const key = storage.newKey("catalog");
    await storage.put(key, clean.buffer, "image/jpeg");
    const asset = await StudioAsset.create({
      publicId: randomId(18), kind, storageKey: key, contentType: "image/jpeg", bytes: clean.buffer.length, width: meta.width, height: meta.height,
      sha256: crypto.createHash("sha256").update(clean.buffer).digest("hex"), originalName: String(req.file.originalname || "").slice(0, 200), createdBy: actorId(req),
    });
    const m = await StudioManufacturer.forKey(a.key);
    const e = colorEntry(m, c.code);
    let applied = 0;
    if (kind === "swatch") e.swatchAssetId = asset._id;
    else {
      Object.assign(e, { textureAssetId: asset._id, textureWidthIn: w, textureHeightIn: h, textureSource });
      // Use it on this colour's Studio wall products that have no texture of their own.
      const r = await StudioProduct.updateMany(
        { "source.manufacturer": a.key, "source.colorCode": c.code, category: "wall", "source.unitSku": null, $or: [{ "assets.texture.assetId": null }, { "assets.texture.assetId": { $exists: false } }] },
        { $set: { "assets.texture": { assetId: asset._id, widthIn: w, heightIn: h } }, $inc: { version: 1 } }
      );
      applied = r.modifiedCount || 0;
      if (applied) invalidate();
    }
    await m.save();
    res.status(201).json({ colors: await colorsView(a, m), appliedToProducts: applied });
  })(req, res));
});

router.delete("/:key/colors/:code/assets/:kind", handle(async (req, res) => {
  const a = adapterOr404(req);
  const c = colorOr404(a, req.params.code);
  const m = await StudioManufacturer.forKey(a.key);
  const e = colorEntry(m, c.code);
  if (req.params.kind === "texture") Object.assign(e, { textureAssetId: null, textureWidthIn: null, textureHeightIn: null, textureSource: null });
  else e.swatchAssetId = null;
  await m.save();
  res.json({ colors: await colorsView(a, m) });
}));

module.exports = router;
