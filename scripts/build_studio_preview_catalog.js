/**
 * Builds data/studio/preview-catalog.json - the fixed DEMO catalog the owner's
 * live preview (/api/studio-preview) serves. Same curated set as the local
 * demo (scripts/studio_demo_catalog.js - the one source): real product sizes, DEMO prices, no
 * manufacturer images. Run again only to change the demo set.
 *
 *   node scripts/build_studio_preview_catalog.js
 */
process.env.NODE_ENV = "test";
process.env.STUDIO_STORAGE = "memory";
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

(async () => {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const User = require("../models/User");
  const StudioProduct = require("../models/studio/StudioProduct");
  const StudioPricing = require("../models/studio/StudioPricing");
  const owner = await User.create({ userId: "preview-builder", name: "Builder", email: "builder@preview.local", role: "admin" });
  const info = await require("./studio_demo_catalog").seedDemoCatalog({ ownerId: owner._id });
  if (!info.swanFile) throw new Error("Needs the Swan price file in catalog-imports/.");
  if (info.swanSkipped) throw new Error(`${info.swanSkipped} Swan part(s) of the demo set were not added - fix the demo set in scripts/studio_demo_catalog.js.`);
  const keep = ["sku", "category", "type", "name", "manufacturer", "model", "description", "colorName", "familyName", "engine", "visualStatus", "featured", "sortOrder"];
  const products = (await StudioProduct.find({ status: "published" }).sort({ category: 1, sku: 1 }).lean()).map((p) => ({
    ...Object.fromEntries(keep.map((k) => [k, p[k]])),
    status: "published", isPublic: true,
    pricing: { priceCents: p.pricing.priceCents, installCents: p.pricing.installCents || 0 },
    ...(p.source?.manufacturer ? { source: { manufacturer: p.source.manufacturer, seriesName: p.source.seriesName, modelNumber: p.source.modelNumber, unitSku: p.source.unitSku || null } } : {}),
    assets: { photos: [], texture: { assetId: null } },
  }));
  const pr = (await StudioPricing.current()).toObject();
  const pricing = {
    currency: pr.currency, version: 1, maxDiscountPercent: pr.maxDiscountPercent, disclaimer: pr.disclaimer,
    privacyNote: "Owner preview: nothing you enter here is saved or sent.",
    projectTypes: pr.projectTypes.map(({ key, label, includes, basePriceCents, enabled }) => ({ key, label, includes, basePriceCents, enabled })),
    adders: pr.adders.map(({ key, label, trigger, priceCents, enabled }) => ({ key, label, trigger, priceCents, enabled })),
    packages: [],
  };
  const out = { note: "DEMO catalog for the owner-only live preview. Demo prices; not a selling price list. Built by scripts/build_studio_preview_catalog.js.", products, pricing };
  const file = path.join(__dirname, "..", "data", "studio", "preview-catalog.json");
  fs.writeFileSync(file, JSON.stringify(out, null, 1));
  console.log(`wrote ${file}: ${products.length} products, ${fs.statSync(file).size} bytes`);
  await mongoose.disconnect();
  await mongo.stop();
})().catch((e) => { console.error(e); process.exit(1); });
