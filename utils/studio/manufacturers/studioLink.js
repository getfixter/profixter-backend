/**
 * Adding manufacturer variants to the Studio: the owner picks variants in the
 * manufacturer catalog, and each becomes a Studio product - always a DRAFT,
 * with NO selling price and compatibility "unverified". The SKU is the
 * manufacturer's part number, so a product is never added twice and future
 * imports find it.
 *
 * What the designer draws is pre-filled from the manufacturer's dimensions;
 * anything not in the file is an approximation and is listed on the product.
 */
const StudioProduct = require("../../../models/studio/StudioProduct");
const StudioSupplierItem = require("../../../models/studio/StudioSupplierItem");
const StudioManufacturer = require("../../../models/studio/StudioManufacturer");
const { validateEngine } = require("../catalogFields");
const { adapterFor } = require("./index");

const MAX_PER_CALL = 300;
/** Approximations that mean the preview must be checked by the owner before publishing. */
const VISUAL_ISSUE = /not in the file|not published|no measured swatch|placeholder|estimated|approximation of its shape/i;
const WALLS_SUFFIX = "-WALLS";

function specsFor(item, adapter) {
  const d = item.dims || {};
  const src = adapter.sourceUrl;
  const out = [];
  const add = (key, label, value, unit = "") => { if (value !== undefined && value !== null && value !== "") out.push({ key, label, value: String(value), unit, status: "VERIFIED", source: src }); };
  add("part", "Manufacturer part number", item.partNumber);
  add("model", "Model", item.modelNumber);
  add("series", "Series", item.seriesName);
  add("length", "Length", d.lengthIn, "in");
  add("width", "Width", d.widthIn, "in");
  add("height", "Height", d.heightIn, "in");
  add("threshold", "Threshold width", d.thresholdWidthIn, "in");
  add("doorHeight", "Height available for a door", d.doorHeightIn, "in");
  add("doorWidth", "Width available for a door", d.doorWidthIn, "in");
  add("sump", "Deep sump height", d.deepSumpHeightIn, "in");
  add("gallons", "Capacity", d.maxGallons, "US gal");
  add("color", "Colour", item.color?.name);
  add("material", "Material", item.material);
  add("surface", "Surface", item.surface);
  add("install", "Installation", item.installationType);
  add("drain", "Drain", item.configuration);
  add("pieces", "Pieces", item.pieces);
  add("accessibility", "Accessibility", item.accessibility);
  add("code", "Code compliance", item.codeCompliancy);
  add("warranty", "Warranty", item.warranty);
  add("weight", "Weight", d.weightLbs, "lb");
  return out.slice(0, 60);
}

function hostRank(adapter, url) {
  try { const i = adapter.mediaHosts.indexOf(new URL(url).hostname); return i < 0 ? 99 : i; } catch { return 99; }
}

/** Owner overrides for a colour (their own swatch colour / genuine texture). */
function colorOverride(mfr, code) {
  return (mfr?.colors || []).find((c) => c.code === code) || null;
}

/**
 * @returns {Promise<{ added: object[], skipped: {partNumber, reason}[] }>}
 */
async function addToStudio({ key, partNumbers, actorId = null }) {
  const adapter = adapterFor(key);
  if (!adapter) throw Object.assign(new Error("Unknown manufacturer."), { status: 404 });
  const parts = [...new Set((Array.isArray(partNumbers) ? partNumbers : []).map(String))].slice(0, MAX_PER_CALL);
  if (!parts.length) throw Object.assign(new Error("Choose at least one product."), { status: 400 });
  const mfr = await StudioManufacturer.forKey(key);
  const trimAllowanceIn = mfr.settings?.trimAllowanceIn ?? adapter.DEFAULT_TRIM_ALLOWANCE_IN;
  const items = await StudioSupplierItem.find({ manufacturer: key, partNumber: { $in: parts } }).lean();
  const found = new Map(items.map((i) => [i.partNumber, i]));
  const existing = new Set((await StudioProduct.find({ sku: { $in: [...parts, ...parts.map((p) => p + WALLS_SUFFIX)] } }).select("sku").lean()).map((p) => p.sku));
  const added = [];
  const skipped = [];
  const docs = [];
  for (const part of parts) {
    const item = found.get(part);
    if (!item) { skipped.push({ partNumber: part, reason: "Not in the imported catalog." }); continue; }
    if (existing.has(part)) {
      skipped.push({ partNumber: part, reason: "Already in the Studio catalog." });
      if (!item.studioSku) await StudioSupplierItem.updateOne({ _id: item._id }, { $set: { studioSku: part } });
      continue;
    }
    if (item.availability === "discontinued" || item.availability === "unlisted") { skipped.push({ partNumber: part, reason: `The manufacturer lists it as ${item.availability}.` }); continue; }
    const m = adapter.studioMapping(item, { trimAllowanceIn });
    if (!m.supported) { skipped.push({ partNumber: part, reason: m.reason }); continue; }
    const ov = colorOverride(mfr, item.color?.code);
    const approximations = [...m.approximations];
    if (ov?.approxHex) {
      for (const eng of [m.engine, m.companion?.engine].filter(Boolean)) if (eng.color) eng.color = ov.approxHex;
      approximations[0] = "Colour drawn in the colour you set for this finish.";
    }
    const v = validateEngine(m.category, m.type, m.engine);
    if (v.errors.length) { skipped.push({ partNumber: part, reason: `Could not prepare the drawing: ${v.errors[0].message}` }); continue; }
    // Public "sources" name the manufacturer's resource page only; drawings and guides stay Admin links (externalMedia).
    const sources = [adapter.sourceUrl];
    const source = {
      manufacturer: key, partNumber: part, modelNumber: item.modelNumber, seriesName: item.seriesName, colorCode: item.color?.code || null,
      listPriceCents: item.listPriceCents, listPriceEffective: item.listPriceEffective, availability: item.availability,
      unitSku: null, approximations, visualIssues: approximations.filter((a) => VISUAL_ISSUE.test(a)), lastImportId: item.lastImportId, pendingReview: [],
    };
    const texture = m.category === "wall" && ov?.textureAssetId ? { assetId: ov.textureAssetId, widthIn: ov.textureWidthIn, heightIn: ov.textureHeightIn } : undefined;
    const doc = {
      sku: part, category: m.category, type: m.type,
      name: item.name.slice(0, 160), manufacturer: adapter.name, model: item.modelNumber, colorName: item.color?.name || "",
      description: item.features.join(". ").slice(0, 4000),
      specs: specsFor(item, adapter), sources,
      engine: v.engine,
      ...(texture ? { assets: { photos: [], texture } } : {}),
      visualStatus: "illustrative", status: "draft", isPublic: true,
      pricing: { priceCents: null, costCents: null, installCents: 0, internalNote: "" },
      // photos from the manufacturer's primary image host first (the designer previews the first one)
      source, externalMedia: [...item.media].sort((x, y) => hostRank(adapter, x.url) - hostRank(adapter, y.url)).map((x) => ({ kind: x.kind, url: x.url })),
      compatibility: { status: "unverified", note: "" },
      updatedBy: actorId,
    };
    docs.push(doc);
    if (m.companion) {
      const sku = part + WALLS_SUFFIX;
      const engine = { ...m.companion.engine, kit: { ...m.companion.engine.kit, requiresBase: [part] } };
      const cv = validateEngine(m.companion.category, m.companion.type, engine);
      if (cv.errors.length) { docs.pop(); skipped.push({ partNumber: part, reason: `Could not prepare the unit's walls: ${cv.errors[0].message}` }); continue; }
      docs.push({
        sku, category: m.companion.category, type: m.companion.type,
        name: `${item.modelNumber} integral walls (part of the unit)`.slice(0, 160), manufacturer: adapter.name, model: item.modelNumber, colorName: item.color?.name || "",
        description: `The walls of the ${item.modelNumber} one-piece unit. Only selectable with that unit; included in its price.`,
        specs: [], sources, engine: cv.engine, visualStatus: "illustrative", status: "draft", isPublic: true,
        // The walls are part of the unit: $0 here, the unit's selling price covers them.
        pricing: { priceCents: 0, costCents: null, installCents: 0, internalNote: `Included in the price of ${part}.` },
        source: { ...source, unitSku: part, listPriceCents: null, approximations: ["Integral walls of a one-piece unit, drawn as smooth panels."], visualIssues: [] },
        externalMedia: [], compatibility: { status: "reviewed", note: `Only with ${part} (part of the same unit).` },
        updatedBy: actorId,
      });
    }
    added.push({ partNumber: part, sku: part, category: m.category, type: m.type, name: doc.name, companion: m.companion ? part + WALLS_SUFFIX : null });
  }
  if (docs.length) {
    try {
      await StudioProduct.insertMany(docs, { ordered: false });
    } catch (e) {
      // Another add (a second tab or server) created some of these first: those are "already in the Studio".
      const errs = e.writeErrors || [];
      if (!errs.length || errs.some((w) => (w.code ?? w.err?.code) !== 11000)) throw e;
      const dup = new Set(errs.map((w) => docs[w.index ?? w.err?.index]?.sku).filter(Boolean));
      for (let i = added.length - 1; i >= 0; i--) if (dup.has(added[i].sku)) { skipped.push({ partNumber: added[i].partNumber, reason: "Already in the Studio catalog." }); added.splice(i, 1); }
    }
    await StudioSupplierItem.updateMany({ manufacturer: key, partNumber: { $in: added.map((a) => a.partNumber) } }, [{ $set: { studioSku: "$partNumber" } }]);
    require("../catalogService").invalidate();
  }
  return { added, skipped };
}

module.exports = { addToStudio, specsFor, WALLS_SUFFIX, MAX_PER_CALL };
