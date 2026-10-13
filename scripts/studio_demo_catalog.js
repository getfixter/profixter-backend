/**
 * The curated DEMO catalog for the owner's homeowner walk-through (local demo
 * stack only - an in-memory database that disappears when the demo stops).
 *
 *   walls    4 finish families per project (Traditional, Modern and Metro
 *            subway, Smooth), each in White, Carrara, Ash Gray, Birch - real
 *            Swan sizes, drawn as illustrations (no Swan images)
 *   tubs     2 (Swan Veritek Pro, Swan Optima), left or right drain
 *   bases    2 (Swan Veritek Pro pan, Swanstone pan in 4 colours)
 *   fixtures 2 packages (Delta, Moen: shower and tub/shower trims)
 *   doors    2 shower doors, 1 tub door, 1 curved rod
 *   extras   grab bars, a corner shelf, a corner soap dish, a fold-down seat
 *
 * Every price here is a DEMO price, not a selling price. Needs the Swan price
 * file in catalog-imports/ (not committed); without it the walls, bases and
 * tubs come from the researched starter catalog instead.
 */
const fs = require("fs");
const path = require("path");

const COLORS = ["010", "221", "203", "226"]; // White, Carrara, Ash Gray, Birch
const WALL_MODELS = {
  // walk-in shower (84" tall)            // bathtub (72" tall)              // both
  TSMK843062: 240000, MSMK843062: 245000, SK366296: 215000, TSMK723062: 220000, MSMK723062: 225000, SMMK723062: 195000, MTMK843062: 260000,
};
const SWAN_SINGLE = {
  "VP6030CTL.010": 110000, "VP6030CTR.010": 110000, // Veritek Pro bathtub
  "OP6030TL.010": 135000, "OP6030TR.010": 135000, // Optima bathtub
  "VP6030CPANNSL.010": 90000, "VP6030CPANNSR.010": 90000, // Veritek Pro shower pan
  "SS07211.010": 9500, // corner soap dish
};
const SWANSTONE_PAN = 130000; // SB03060LM/RM in the four colours
const STARTER = {
  "delta-bt13210": 35000, "delta-bt13410": 39000, "moen-t25902ep-chrome": 42000, "moen-t25903ep-chrome": 46000,
  "infinityz-6072-chrome": 95000, "enigmax-6076": 145000, "infinityz-tub-6058": 85000, "moen-csr2160-chrome": 12000,
  "moen-8724": 9000, "moen-8736": 11000, "as-passage-shelf": 7500, "moen-dn7110": 26000,
};
const STARTER_FALLBACK = ["dreamline", "delta", "american-standard", "as-"]; // walls/bases/tubs if the Swan file is missing

function swanFile() {
  const dir = path.join(__dirname, "..", "catalog-imports");
  try { return fs.readdirSync(dir).filter((f) => /^swan-epf-.*\.xlsx$/i.test(f)).map((f) => path.join(dir, f))[0] || null; } catch { return null; }
}

async function seedDemoCatalog({ ownerId }) {
  process.env.STUDIO_STORAGE = "memory"; // the seeding process keeps the uploaded file in memory only
  const StudioProduct = require("../models/studio/StudioProduct");
  const StudioPricing = require("../models/studio/StudioPricing");
  const starter = require("../data/studio/starter-catalog.json");
  const demo = (cents) => ({ priceCents: cents, costCents: null, installCents: 0, internalNote: "DEMO price - not a selling price" });
  const approved = { status: "published", compatibility: { status: "reviewed", note: "Demo", reviewedBy: ownerId, reviewedAt: new Date() }, review: { info: true, visual: true, by: ownerId, at: new Date() } };

  const file = swanFile();
  const keepStarter = Object.keys(STARTER);
  if (!file) for (const p of starter.products) if (["wall", "base"].includes(p.category)) keepStarter.push(p.sku);
  await StudioProduct.insertMany(starter.products.filter((p) => keepStarter.includes(p.sku)).map((p) => ({ ...p, status: "published", pricing: demo(STARTER[p.sku] ?? (p.category === "wall" ? 230000 : 110000)) })));

  let swan = 0;
  if (file) {
    const { previewImport, applyImport } = require("../utils/studio/manufacturers/importService");
    const { addToStudio } = require("../utils/studio/manufacturers/studioLink");
    const imp = await previewImport({ key: "swan", buffer: fs.readFileSync(file), fileName: path.basename(file), actorId: ownerId });
    await applyImport({ key: "swan", importId: imp._id, actorId: ownerId });
    const prices = { ...SWAN_SINGLE };
    for (const [model, cents] of Object.entries(WALL_MODELS)) for (const c of COLORS) prices[`${model}.${c}`] = cents;
    for (const side of ["LM", "RM"]) for (const c of COLORS) prices[`SB03060${side}.${c}`] = SWANSTONE_PAN;
    const r = await addToStudio({ key: "swan", partNumbers: Object.keys(prices), actorId: ownerId });
    for (const a of r.added) await StudioProduct.updateOne({ sku: a.sku }, { $set: { ...approved, pricing: demo(prices[a.sku]) } });
    swan = r.added.length;
    if (r.skipped.length) console.log(`  demo catalog: ${r.skipped.length} Swan parts skipped (${r.skipped[0].partNumber}: ${r.skipped[0].reason})`);
  }

  const pricing = await StudioPricing.current();
  for (const t of pricing.projectTypes) t.basePriceCents = { "tub-to-shower": 450000, "shower-replacement": 400000, "tub-replacement": 380000 }[t.key];
  for (const a of pricing.adders) a.priceCents = { "paint-above": 60000, "door-install": 25000, "grab-bar-blocking": 15000, "seat-backing": 20000, "valve-relocation": 50000 }[a.key];
  pricing.disclaimer = "DEMO PRICE - sample numbers for testing the Studio. Not a real quote.";
  await pricing.save();
  return { swanFile: file ? path.basename(file) : null, swanProducts: swan, starterProducts: keepStarter.length };
}

module.exports = { seedDemoCatalog };
