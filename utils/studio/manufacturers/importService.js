/**
 * Importing a manufacturer's price file - always in two steps:
 *
 *   1. preview: read the file, compare it with the catalog, store the file
 *      privately and record what WOULD change. Nothing in the catalog changes.
 *   2. apply (owner confirms): re-read the stored file, check it is the same
 *      file, and apply - optionally only some product groups.
 *
 * Rules:
 *   - Variants are matched by manufacturer + Sellable Part Number, so
 *     re-importing the same file changes nothing and never duplicates.
 *   - Only the manufacturer's facts are written. Profixter's prices, costs,
 *     statuses and every other owner choice on Studio products are never
 *     changed; a Studio product whose manufacturer facts changed gets a note
 *     to review instead.
 *   - Nothing is deleted. A variant the file lists as discontinued is marked
 *     "discontinued"; one missing from a full import is marked "unlisted".
 */
const crypto = require("crypto");
const StudioSupplierItem = require("../../../models/studio/StudioSupplierItem");
const StudioCatalogImport = require("../../../models/studio/StudioCatalogImport");
const StudioProduct = require("../../../models/studio/StudioProduct");
const storage = require("../storage");
const { adapterFor, parseCatalogFile } = require("./index");
const { GROUPS } = require("./abgEpf");

const SAMPLE = 25;
const CHUNK = 500;
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const money = (c) => (c == null ? "-" : `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`);

/** The fields an import writes (everything the manufacturer publishes). */
const FEED_FIELDS = [
  "variantId", "upc", "baseModel", "modelNumber", "familyKey", "seriesKey", "seriesName", "group", "category",
  "availability", "programs", "name", "shortName", "color", "surface", "material", "installationType", "configuration",
  "shape", "pieces", "warranty", "accessibility", "codeCompliancy", "afr", "dims", "features", "media", "attributes",
  "listPriceCents", "listPriceEffective", "feedHash",
];
const COMPARE_FIELDS = FEED_FIELDS.filter((f) => !["feedHash", "attributes", "seriesKey", "modelNumber", "familyKey"].includes(f));
const feedOf = (item) => Object.fromEntries(FEED_FIELDS.map((f) => [f, item[f]]));
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function changedFields(oldDoc, item) {
  return COMPARE_FIELDS.filter((f) => !same(oldDoc[f], item[f]));
}

function fail(status, message, extra) {
  return Object.assign(new Error(message), { status, extra });
}

/** Compare a parsed file with the catalog. `scopeGroups` limits it to some product groups. */
async function plan(key, parsed, scopeGroups = null) {
  const inScope = (g) => !scopeGroups || scopeGroups.includes(g);
  const existing = await StudioSupplierItem.find({ manufacturer: key }).select("partNumber feedHash listPriceCents availability studioSku group name").lean();
  const byPart = new Map(existing.map((e) => [e.partNumber, e]));
  const out = { new: [], changed: [], unchanged: 0, priceChanged: [], toDiscontinue: [], toUnlist: [], byGroup: {} };
  const bump = (g, k) => { (out.byGroup[g] ||= { items: 0, new: 0, changed: 0 })[k]++; };
  for (const item of parsed.items.values()) {
    if (!inScope(item.group)) continue;
    bump(item.group, "items");
    const old = byPart.get(item.partNumber);
    if (!old) { out.new.push(item); bump(item.group, "new"); continue; }
    if (old.feedHash === item.feedHash) { out.unchanged++; continue; }
    out.changed.push({ item, old });
    bump(item.group, "changed");
    if (old.listPriceCents !== item.listPriceCents) out.priceChanged.push({ item, old });
  }
  for (const [part, d] of parsed.discontinued) {
    if (parsed.items.has(part)) continue;
    const old = byPart.get(part);
    if (old && old.availability !== "discontinued" && inScope(old.group)) out.toDiscontinue.push({ old, d });
  }
  if (!scopeGroups) {
    for (const old of existing) {
      if ((old.availability === "active" || old.availability === "special-order") && !parsed.items.has(old.partNumber) && !parsed.discontinued.has(old.partNumber)) out.toUnlist.push({ old });
    }
  }
  return out;
}

function summarize(parsed, p) {
  const lv = { error: 0, warn: 0, info: 0 };
  for (const i of parsed.issues) lv[i.level] = (lv[i.level] || 0) + 1;
  const items = [...parsed.items.values()];
  const count = (f) => items.reduce((m, x) => ((m[f(x)] = (m[f(x)] || 0) + 1), m), {});
  const linked = (list) => list.filter((x) => (x.old || {}).studioSku).length;
  return {
    sheets: parsed.stats.sheets,
    rows: parsed.stats.rows,
    variants: items.length,
    models: new Set(items.map((x) => x.baseModel)).size,
    series: new Set(items.map((x) => x.seriesKey)).size,
    byGroup: GROUPS.map((g) => ({ key: g.key, label: g.label, variants: items.filter((x) => x.group === g.key).length, ...(p.byGroup[g.key] || { new: 0, changed: 0 }) })).filter((g) => g.variants),
    byAvailability: count((x) => x.availability),
    express: items.filter((x) => x.programs.includes("express")).length,
    discontinuedListed: parsed.discontinued.size,
    new: p.new.length,
    changed: p.changed.length,
    unchanged: p.unchanged,
    priceChanged: p.priceChanged.length,
    priceUp: p.priceChanged.filter(({ item, old }) => (item.listPriceCents ?? 0) > (old.listPriceCents ?? 0)).length,
    priceDown: p.priceChanged.filter(({ item, old }) => (item.listPriceCents ?? 0) < (old.listPriceCents ?? 0)).length,
    toDiscontinue: p.toDiscontinue.length,
    toUnlist: p.toUnlist.length,
    studioProductsAffected: linked(p.changed) + linked(p.toDiscontinue) + linked(p.toUnlist),
    issues: lv,
    canApply: lv.error === 0 && items.length > 0,
  };
}

async function samples(p) {
  const changed = [];
  if (p.changed.length) {
    const first = p.changed.slice(0, SAMPLE);
    const docs = await StudioSupplierItem.find({ _id: { $in: first.map((c) => c.old._id) } }).lean();
    const byId = new Map(docs.map((d) => [String(d._id), d]));
    for (const { item, old } of first) {
      const doc = byId.get(String(old._id)) || {};
      changed.push({ partNumber: item.partNumber, name: item.name, fields: changedFields(doc, item), priceFrom: doc.listPriceCents ?? null, priceTo: item.listPriceCents ?? null, inStudio: Boolean(old.studioSku) });
    }
  }
  return {
    new: p.new.slice(0, SAMPLE).map((x) => ({ partNumber: x.partNumber, name: x.name, group: x.group, listPriceCents: x.listPriceCents, availability: x.availability })),
    changed,
    priceChanged: p.priceChanged.slice(0, SAMPLE).map(({ item, old }) => ({ partNumber: item.partNumber, name: item.name, from: old.listPriceCents, to: item.listPriceCents, inStudio: Boolean(old.studioSku) })),
    toDiscontinue: p.toDiscontinue.slice(0, SAMPLE).map(({ old, d }) => ({ partNumber: old.partNumber, name: old.name, discontinuedAt: d.discontinuedAt, inStudio: Boolean(old.studioSku) })),
    toUnlist: p.toUnlist.slice(0, SAMPLE).map(({ old }) => ({ partNumber: old.partNumber, name: old.name, inStudio: Boolean(old.studioSku) })),
  };
}

/** Step 1: read, compare, keep the file. The catalog is not changed. */
async function previewImport({ key, buffer, fileName = "", actorId = null }) {
  const adapter = adapterFor(key);
  if (!adapter) throw fail(404, "Unknown manufacturer.");
  const fileSha256 = sha256(buffer);
  let parsed;
  try {
    parsed = await parseCatalogFile(key, buffer);
  } catch (e) {
    const doc = await StudioCatalogImport.create({ manufacturer: key, fileName, fileSha256, fileBytes: buffer.length, status: "failed", error: e.userMessage || "The file could not be read.", createdBy: actorId });
    throw fail(400, doc.error, { importId: String(doc._id) });
  }
  const p = await plan(key, parsed);
  const summary = summarize(parsed, p);
  let storageKey = "";
  if (summary.canApply) {
    storageKey = storage.newKey("imports", ".xlsx");
    await storage.put(storageKey, buffer, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  }
  const previous = await StudioCatalogImport.find({ manufacturer: key, status: "previewed" }).select("_id").lean();
  if (previous.length) await StudioCatalogImport.updateMany({ _id: { $in: previous.map((x) => x._id) } }, { $set: { status: "superseded" } });
  const lastApplied = await StudioCatalogImport.findOne({ manufacturer: key, status: "applied" }).sort({ appliedAt: -1 }).select("fileSha256 appliedAt").lean();
  summary.sameAsLastApplied = Boolean(lastApplied && lastApplied.fileSha256 === fileSha256);
  return StudioCatalogImport.create({
    manufacturer: key, fileName: String(fileName).slice(0, 200), fileSha256, fileBytes: buffer.length, storageKey,
    status: summary.canApply ? "previewed" : "failed", error: summary.canApply ? "" : "The file has errors; nothing can be imported.",
    summary, samples: await samples(p), issues: parsed.issues.slice(0, 200), createdBy: actorId,
  });
}

function itemInsert(item, importId, now) {
  return {
    manufacturer: item.manufacturer, partNumber: item.partNumber, ...feedOf(item),
    priceHistory: item.listPriceCents == null ? [] : [{ cents: item.listPriceCents, effective: item.listPriceEffective, importId, at: now }],
    firstImportId: importId, lastImportId: importId, lastChangedImportId: importId, studioSku: null,
  };
}

async function bulk(ops) {
  for (let i = 0; i < ops.length; i += CHUNK) await StudioSupplierItem.bulkWrite(ops.slice(i, i + CHUNK), { ordered: false });
}

/** Step 2: apply a previewed import (the owner confirmed). `groups` limits it to some product groups. */
async function applyImport({ key, importId, groups = null, actorId = null }) {
  const scopeGroups = Array.isArray(groups) && groups.length ? [...new Set(groups.map(String))].filter((g) => GROUPS.some((x) => x.key === g)) : null;
  if (await StudioCatalogImport.exists({ manufacturer: key, status: "applying" })) throw fail(409, "Another import is being applied. Try again in a minute.");
  const imp = await StudioCatalogImport.findOneAndUpdate(
    { _id: importId, manufacturer: key, status: "previewed" },
    { $set: { status: "applying", appliedBy: actorId, scope: scopeGroups ? { groups: scopeGroups } : { all: true } } },
    { new: true }
  );
  if (!imp) throw fail(409, "This preview can no longer be applied (it was applied, replaced by a newer upload, or failed). Upload the file again.");
  const started = Date.now();
  try {
    const buffer = await storage.get(imp.storageKey);
    if (sha256(buffer) !== imp.fileSha256) throw new Error("The stored file does not match the preview.");
    const parsed = await parseCatalogFile(key, buffer);
    const p = await plan(key, parsed, scopeGroups);
    const now = new Date();
    const ops = [];
    for (const item of p.new) ops.push({ insertOne: { document: itemInsert(item, imp._id, now) } });
    for (const { item, old } of p.changed) {
      const update = { $set: { ...feedOf(item), lastImportId: imp._id, lastChangedImportId: imp._id } };
      if (old.listPriceCents !== item.listPriceCents && item.listPriceCents != null) update.$push = { priceHistory: { $each: [{ cents: item.listPriceCents, effective: item.listPriceEffective, importId: imp._id, at: now }], $slice: -20 } };
      ops.push({ updateOne: { filter: { _id: old._id }, update } });
    }
    const added = new Set(p.new);
    const unchangedParts = [];
    for (const item of parsed.items.values()) if ((!scopeGroups || scopeGroups.includes(item.group)) && !added.has(item)) unchangedParts.push(item.partNumber);
    for (const { old, d } of p.toDiscontinue) ops.push({ updateOne: { filter: { _id: old._id }, update: { $set: { availability: "discontinued", discontinuedAt: d.discontinuedAt, lastImportId: imp._id, lastChangedImportId: imp._id } } } });
    for (const { old } of p.toUnlist) ops.push({ updateOne: { filter: { _id: old._id }, update: { $set: { availability: "unlisted", lastChangedImportId: imp._id } } } });
    await bulk(ops);
    // mark everything seen in this file (one query, not one per variant)
    await StudioSupplierItem.updateMany({ manufacturer: key, partNumber: { $in: unchangedParts } }, { $set: { lastImportId: imp._id } });

    // Studio products made from changed variants: refresh the manufacturer's facts, ask the owner to review.
    let studioUpdated = 0;
    const notes = [];
    for (const { item, old } of p.changed) {
      if (!old.studioSku) continue;
      const review = [];
      if (old.listPriceCents !== item.listPriceCents) review.push({ kind: "price", message: `List price changed from ${money(old.listPriceCents)} to ${money(item.listPriceCents)}${item.listPriceEffective ? ` (effective ${item.listPriceEffective})` : ""}. Your selling price was not changed.`, from: String(old.listPriceCents ?? ""), to: String(item.listPriceCents ?? ""), at: now });
      if (old.availability !== item.availability) review.push({ kind: "availability", message: `Manufacturer availability changed from ${old.availability} to ${item.availability}.`, from: old.availability, to: item.availability, at: now });
      if (!review.length) review.push({ kind: "spec", message: "The manufacturer updated this product's details. Check the specifications and drawing.", at: now });
      notes.push({ sku: old.studioSku, set: { "source.listPriceCents": item.listPriceCents, "source.listPriceEffective": item.listPriceEffective, "source.availability": item.availability, "source.lastImportId": imp._id }, review });
    }
    for (const { old, d } of p.toDiscontinue) if (old.studioSku) notes.push({ sku: old.studioSku, set: { "source.availability": "discontinued", "source.lastImportId": imp._id }, review: [{ kind: "availability", message: `The manufacturer lists this product as discontinued${d.discontinuedAt ? ` (${d.discontinuedAt})` : ""}. It was not removed or unpublished.`, to: "discontinued", at: now }] });
    for (const { old } of p.toUnlist) if (old.studioSku) notes.push({ sku: old.studioSku, set: { "source.availability": "unlisted", "source.lastImportId": imp._id }, review: [{ kind: "availability", message: "This product is no longer in the manufacturer's price file. It was not removed or unpublished.", to: "unlisted", at: now }] });
    for (const n of notes) {
      const r = await StudioProduct.updateOne({ sku: n.sku, "source.manufacturer": key }, { $set: n.set, $push: { "source.pendingReview": { $each: n.review, $slice: -20 } } });
      studioUpdated += r.modifiedCount || 0;
    }
    if (studioUpdated) require("../catalogService").invalidate();

    const result = { added: p.new.length, updated: p.changed.length, unchanged: p.unchanged, priceChanged: p.priceChanged.length, discontinued: p.toDiscontinue.length, unlisted: p.toUnlist.length, studioProductsFlagged: studioUpdated };
    imp.status = "applied";
    imp.result = result;
    imp.appliedAt = new Date();
    imp.durationMs = Date.now() - started;
    await imp.save();
    return imp;
  } catch (e) {
    imp.status = "failed";
    imp.error = e.userMessage || e.message || "The import failed.";
    imp.durationMs = Date.now() - started;
    await imp.save();
    console.error(JSON.stringify({ event: "studio_catalog_import_failed", manufacturer: key, importId: String(imp._id), error: String(e.message || e).slice(0, 300) }));
    throw fail(500, `The import stopped: ${imp.error} Upload the file again to retry - importing the same file twice is safe.`);
  }
}

module.exports = { previewImport, applyImport, plan, changedFields, FEED_FIELDS };
