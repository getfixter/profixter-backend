/**
 * Loading the catalog for the Studio: the public engine catalog (published,
 * public products; never any price), the staff catalog (everything except
 * archived, plus archived products a design still uses), and the product map
 * pricing needs. A short cache keeps the public page fast; any catalog or
 * price edit clears it.
 */
const StudioProduct = require("../../models/studio/StudioProduct");
const StudioAsset = require("../../models/studio/StudioAsset");
const StudioPricing = require("../../models/studio/StudioPricing");
const { toEngineCatalog } = require("./catalogFields");

const CACHE_MS = 30 * 1000;
let cache = null;
let staffCache = null;

function invalidate() {
  cache = null;
  staffCache = null;
}

function apiBase() {
  return String(process.env.PUBLIC_API_BASE_URL || process.env.PUBLIC_API_URL || "").replace(/\/+$/, "");
}

async function assetUrlResolver(products) {
  const ids = new Set();
  for (const p of products) {
    for (const ph of p.assets?.photos || []) ids.add(String(ph.assetId));
    if (p.assets?.texture?.assetId) ids.add(String(p.assets.texture.assetId));
  }
  const assets = ids.size ? await StudioAsset.find({ _id: { $in: [...ids] } }).select("publicId").lean() : [];
  const map = new Map(assets.map((a) => [String(a._id), a.publicId]));
  const base = apiBase();
  return (id) => (map.has(String(id)) ? `${base}/api/studio/assets/${map.get(String(id))}` : null);
}

/** What the public Studio page receives. */
async function publicCatalog() {
  if (cache && cache.at > Date.now() - CACHE_MS) return cache.value;
  const products = await StudioProduct.find({ status: "published", isPublic: true }).lean();
  const pricing = await StudioPricing.current();
  const assetUrl = await assetUrlResolver(products);
  const value = {
    catalog: toEngineCatalog(products, { assetUrl }),
    projectTypes: pricing.projectTypes.filter((t) => t.enabled !== false).map((t) => ({ key: t.key, label: t.label, includes: t.includes })),
    disclaimer: pricing.disclaimer,
    privacyNote: pricing.privacyNote,
    packages: pricing.packages.filter((p) => p.enabled !== false && p.isPublic && p.priceCents != null).map((p) => ({ key: p.key, name: p.name, description: p.description, skus: p.skus })),
    version: `${pricing.version}-${products.reduce((m, p) => Math.max(m, new Date(p.updatedAt).getTime()), 0)}`,
  };
  cache = { at: Date.now(), value };
  return value;
}

/** Staff catalog: all non-archived products, plus any archived SKUs listed in `keepSkus`. */
async function staffCatalog(keepSkus = []) {
  // Large manufacturer catalogs make this the heaviest Studio query; staff
  // designs ask for it on every change, so the live part is cached briefly
  // (cleared by any catalog edit) and only archived SKUs are looked up.
  if (!staffCache || staffCache.at < Date.now() - CACHE_MS) {
    const live = await StudioProduct.find({ status: { $ne: "archived" } }).select("-specs -sources").lean();
    staffCache = { at: Date.now(), live };
  }
  const have = new Set(staffCache.live.map((p) => p.sku));
  const missing = [...new Set(keepSkus)].filter((s) => s && !have.has(s));
  const archived = missing.length ? await StudioProduct.find({ sku: { $in: missing } }).select("-specs -sources").lean() : [];
  const products = [...staffCache.live, ...archived];
  const assetUrl = await assetUrlResolver(products);
  return { catalog: toEngineCatalog(products, { assetUrl, manufacturerPhotos: true, withSpecs: false }), products };
}

/** sku -> product (with pricing), for pricing. Includes archived products so old designs still price. */
async function productMap(skus) {
  const list = await StudioProduct.find({ sku: { $in: [...new Set(skus.filter(Boolean))] } }).lean();
  return new Map(list.map((p) => [p.sku, p]));
}

module.exports = { publicCatalog, staffCatalog, productMap, invalidate, apiBase };
