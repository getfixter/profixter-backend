/**
 * The curated DEMO catalog for the owner's homeowner walk-through - the ONE
 * source for both the local demo stack (scripts/studio_demo_env.js --demo, an
 * in-memory database that disappears when the demo stops) and the owner-only
 * live preview (scripts/build_studio_preview_catalog.js writes it to
 * data/studio/preview-catalog.json).
 *
 * Customers choose among a few product FAMILIES (`familyName`); each family
 * holds its sizes and colours as variants:
 *
 *   walls        Swan series (Traditional / Modern / Metro subway, Smooth in
 *                solid, marble-look and stone-look colours, Novaline vertical
 *                tile, Veritek smooth) - shower and tub kits, real Swan sizes
 *                and colours from the Swan price file
 *                and DEMO-generic beadboard panels (Swan has no beadboard)
 *   bases/tubs   Swan Swanstone / Veritek / Veritek Pro pans, Swan tubs - left
 *                and right drain only - plus one DEMO-generic low-profile base
 *                (the only 60" x 36" pan: Swan's 60 x 36 pans are center-drain)
 *   fixtures     Delta / Moen trims (researched starter data) and DEMO-generic
 *                packages in chrome, matte black, brushed nickel, brushed gold
 *   enclosures   DreamLine doors (starter data), DEMO-generic framed and
 *                frameless bypass doors, rods with curtains
 *   extras       Swan corner shelves and soap dish, grab bars, fold-down seats
 *
 * Every price here is a DEMO price, not a selling price. DEMO-generic products
 * (SKUs starting "DEMO-") are not a specific manufacturer model and carry no
 * model number. Colours are illustrative approximations; no manufacturer
 * images are used anywhere. Needs the Swan price file in catalog-imports/
 * (not committed); without it the walls, bases and tubs come from the
 * researched starter catalog instead.
 */
const fs = require("fs");
const path = require("path");

// ------------------------------------------------------------------ Swan (real parts from the Swan EPF)
const W = "010", BQ = "018", CA = "221", AG = "203", BI = "226", LI = "218", MM = "141";
const TILE_COLORS = [W, BQ, CA, AG, BI];
/** Speckle colours for the stone look (a darker shade of the illustrative swatch colour). */
const SPECKLE = { [AG]: "#86877f", [BI]: "#a19a92", [LI]: "#776c5f", [MM]: "#9c9b84" };

/**
 * Swan families: models (part number before the dot) x colour codes, with the
 * DEMO price per model. `look` swaps the drawn surface of smooth panels for a
 * marble or stone look (only where the Swan colour is that look).
 */
const SWAN_FAMILIES = [
  // walls
  { family: "Swanstone Traditional Subway Tile", colors: TILE_COLORS, models: { TSMK843062: 240000, TSMK843262: 245000, TSMK843662: 250000, TSMK723062: 220000, TSMK723262: 225000 } },
  { family: "Swanstone Modern Subway Tile", colors: TILE_COLORS, models: { MSMK843062: 245000, MSMK843262: 250000, MSMK843662: 255000, MSMK723062: 225000, MSMK723262: 230000 } },
  { family: "Swanstone Metro Subway Tile", colors: TILE_COLORS, models: { MTMK843062: 260000, MTMK843262: 265000, MTMK843662: 270000 } },
  { family: "Swanstone Smooth", colors: [W, BQ], models: { SK366296: 215000, SMMK723062: 195000, SMMK723262: 200000 } },
  { family: "Swanstone Smooth, marble look", colors: [CA], look: "marble", premium: 15000, models: { SK366296: 215000, SMMK723062: 195000, SMMK723262: 200000 } },
  { family: "Swanstone Smooth, stone look", colors: [AG, BI, LI, MM], look: "stone", premium: 10000, models: { SK366296: 215000, SMMK723062: 195000, SMMK723262: 200000 } },
  { family: "Novaline Vertical Tile", colors: ["900"], models: { NVT6036: 165000 } },
  { family: "Veritek Smooth", colors: [W], models: { BA03060: 135000 } },
  // shower bases
  { family: "Swanstone Shower Pan", colors: TILE_COLORS, models: { SB03060LM: 130000, SB03060RM: 130000, SR03260LM: 135000, SR03260RM: 135000 } },
  { family: "Veritek Pro Shower Pan", colors: [W], models: { VP6030CPANNSL: 90000, VP6030CPANNSR: 90000 } },
  { family: "Veritek Shower Pan", colors: [W], models: { FB03060LM: 75000, FB03060RM: 75000, FR03260LM: 80000, FR03260RM: 80000 } },
  // bathtubs
  { family: "Veritek Pro Bathtub", colors: [W], models: { VP6030CTL: 110000, VP6030CTR: 110000, VP6032CTMINL: 120000, VP6032CTMINR: 120000 } },
  { family: "Optima Veritek Pro Bathtub", colors: [W], models: { OP6030TL: 135000, OP6030TR: 135000, OP6032TL: 145000, OP6032TR: 145000 } },
  { family: "Veritek Bathtub", colors: [W], models: { BT03060LD: 85000, BT03060RD: 85000 } },
  // extras
  { family: "Swanstone Corner Soap Dish", colors: TILE_COLORS, models: { SS07211: 9500 } },
  { family: "Aerie Corner Shelf", colors: [W, BQ, CA, AG], models: { ES80000: 14000 } },
  { family: "Odile Suite Corner Shelf", colors: ["003", "002", "004", "001"], models: { CNRSHELF: 18000 }, colorPremium: { "002": 1500, "004": 1500 } },
];

// ------------------------------------------------------------------ researched starter products (data/studio/starter-catalog.json)
const STARTER = {
  "delta-bt13210": { price: 35000, familyName: "Delta Monitor 13", colorName: "Chrome" },
  "delta-bt13410": { price: 39000, familyName: "Delta Monitor 13", colorName: "Chrome" },
  "moen-t25902ep-chrome": { price: 42000, familyName: "Moen Gibson", colorName: "Chrome" },
  "moen-t25902ep-black": { price: 46000, familyName: "Moen Gibson", colorName: "Matte black" },
  "moen-t25903ep-chrome": { price: 46000, familyName: "Moen Gibson", colorName: "Chrome" },
  "infinityz-6072-chrome": { price: 95000, familyName: "DreamLine Infinity-Z sliding door", colorName: "Chrome" },
  "infinityz-6072-black": { price: 105000, familyName: "DreamLine Infinity-Z sliding door", colorName: "Matte black" },
  "infinityz-tub-6058": { price: 85000, familyName: "DreamLine Infinity-Z sliding door", colorName: "Chrome" },
  "enigmax-6076": { price: 145000, familyName: "DreamLine Enigma-X frameless sliding door", colorName: "Brushed stainless" },
  "moen-csr2160-chrome": { price: 12000, familyName: "Moen curved shower rod", colorName: "Chrome" },
  "moen-csr2160-black": { price: 13500, familyName: "Moen curved shower rod", colorName: "Matte black" },
  "moen-8724": { price: 9000, familyName: "Moen grab bar", colorName: "Stainless" },
  "moen-8736": { price: 11000, familyName: "Moen grab bar", colorName: "Stainless" },
  "as-passage-shelf": { price: 7500, familyName: "American Standard Passage corner shelf", colorName: "Satin nickel" },
  "moen-dn7110": { price: 26000, familyName: "Moen fold-down teak seat", colorName: "Teak" },
};

// ------------------------------------------------------------------ DEMO-generic products (no manufacturer, no model number)
const FINISH = {
  chrome: { name: "Chrome", hex: "#e6e8ea", rough: 0.12, add: 0 },
  black: { name: "Matte black", hex: "#2a2b2d", rough: 0.55, add: 4000 },
  nickel: { name: "Brushed nickel", hex: "#b8b5ad", rough: 0.35, add: 3000 },
  gold: { name: "Brushed gold", hex: "#c8a96a", rough: 0.35, add: 6000 },
};
const GENERIC = "Generic (DEMO)";
const DEMO_NOTE = "DEMO product for the Studio walk-through: a generic option, not a specific manufacturer model. Drawn as an illustration; colours are approximate.";

function demoProducts() {
  const out = [];
  const add = (p) => out.push({ manufacturer: GENERIC, model: "", description: DEMO_NOTE, specs: [], sources: [], visualStatus: "illustrative", ...p });

  // shower and tub/shower packages
  const packages = [
    { key: "ROUND", family: "Classic round shower package", finishes: ["chrome", "black", "nickel", "gold"], shower: 38000, tub: 42000, g: { plateR: 3.5, leverLen: 4, armLen: 7, headDiameter: 5 }, spout: { spoutReach: 6.5, spoutAboveRim: 4.5 } },
    { key: "RAIN", family: "Modern rain shower package", finishes: ["chrome", "black", "nickel", "gold"], shower: 52000, tub: 56000, g: { plateR: 3.25, leverLen: 4.5, armLen: 10, headDiameter: 8 }, spout: { spoutReach: 7, spoutAboveRim: 4.5 } },
    { key: "HAND", family: "Shower package with hand shower", finishes: ["chrome", "black"], shower: 48000, tub: 52000, g: { plateR: 3.5, leverLen: 4, armLen: 7, headDiameter: 5, handheld: { barLength: 24 } }, spout: { spoutReach: 6.5, spoutAboveRim: 4.5 } },
  ];
  for (const pk of packages) for (const f of pk.finishes) for (const type of ["shower", "tubShower"]) {
    const fin = FINISH[f];
    add({
      sku: `DEMO-FX-${pk.key}-${type === "shower" ? "SH" : "TS"}-${f.toUpperCase()}`, category: "fixture", type,
      name: `${pk.family}, ${type === "shower" ? "shower only" : "tub and shower"}, ${fin.name.toLowerCase()}`, familyName: pk.family, colorName: fin.name,
      engine: { finishColor: fin.hex, roughness: fin.rough, geometry: { ...pk.g, ...(type === "tubShower" ? pk.spout : {}) }, ...(type === "tubShower" ? { spoutBelowValveMin: 8, spoutBelowValveMax: 18 } : {}) },
      price: (type === "shower" ? pk.shower : pk.tub) + fin.add,
    });
  }

  // bypass sliding doors: shower (60" opening, 72" glass) and tub (60" opening, 58"/60" glass)
  const doors = [
    { key: "FRAMED", family: "Framed bypass shower door", frame: "framed", glassThickness: 0.25, minThreshold: 1, shower: 75000, tub: 70000, tubGlass: 58 },
    { key: "FRAMELESS", family: "Frameless bypass shower door", frame: "frameless", glassThickness: 0.375, minThreshold: 2.25, shower: 165000, tub: 150000, tubGlass: 60 },
  ];
  for (const d of doors) for (const f of ["chrome", "black", "nickel"]) for (const kind of ["pan", "tub"]) {
    const fin = FINISH[f];
    add({
      sku: `DEMO-DOOR-${d.key}-${kind === "pan" ? "SH" : "TUB"}-${f.toUpperCase()}`, category: "enclosure", type: "door",
      name: `${d.family}, ${kind === "pan" ? "shower" : "tub"}, ${fin.name.toLowerCase()}`, familyName: d.family, colorName: fin.name,
      engine: { forKinds: [kind], openingMin: 56, openingMax: 60, glassHeight: kind === "pan" ? 72 : d.tubGlass, glassThickness: d.glassThickness, frame: d.frame, frameColor: fin.hex, minThreshold: d.minThreshold, overlap: 2 },
      price: (kind === "pan" ? d.shower : d.tub) + fin.add * 1.5,
    });
  }

  // rods with a curtain
  const CURTAIN = { white: { name: "white curtain", hex: "#f4f4f1" }, gray: { name: "gray curtain", hex: "#9ea3a8" }, linen: { name: "linen curtain", hex: "#d8cdb8" } };
  const rods = [
    { key: "STRAIGHT", family: "Straight shower rod with curtain", bow: 0, price: 6000, variants: [["chrome", "white"], ["black", "white"], ["nickel", "white"], ["chrome", "gray"]] },
    { key: "CURVED", family: "Curved shower rod with curtain", bow: 6, price: 14000, variants: [["chrome", "white"], ["black", "white"], ["nickel", "white"], ["gold", "white"], ["chrome", "gray"], ["chrome", "linen"]] },
  ];
  for (const r of rods) for (const [f, c] of r.variants) {
    const fin = FINISH[f], cur = CURTAIN[c];
    add({
      sku: `DEMO-ROD-${r.key}-${f.toUpperCase()}-${c.toUpperCase()}`, category: "enclosure", type: "rod",
      name: `${r.family}, ${fin.name.toLowerCase()}, ${cur.name}`, familyName: r.family, colorName: `${fin.name}, ${cur.name}`,
      engine: { forKinds: ["pan", "tub"], openingMin: 54, openingMax: 72, mountHeight: 75, diameter: 1, bow: r.bow, finishColor: fin.hex, curtainColor: cur.hex },
      price: r.price + fin.add / 4,
    });
  }

  // grab bars 18 / 24 / 32 / 36
  for (const len of [18, 24, 32, 36]) for (const f of ["chrome", "black", "nickel"]) {
    const fin = FINISH[f];
    add({
      sku: `DEMO-GRAB-${len}-${f.toUpperCase()}`, category: "accessory", type: "grabBar",
      name: `Grab bar ${len}″, ${fin.name.toLowerCase()}`, familyName: "Grab bar", colorName: fin.name,
      engine: { length: len, diameter: 1.25, clearance: 1.5, flange: 3.25, finishColor: fin.hex, roughness: fin.rough, ratedLoad: 500 },
      price: { 18: 7000, 24: 8000, 32: 9500, 36: 10500 }[len] + (f === "chrome" ? 0 : 1500),
    });
  }

  // fold-down seats
  for (const [k, colorName, color, price] of [["TEAK", "Teak", "#a8784c", 24000], ["WHITE", "White", "#f2f2ef", 22000]]) {
    add({
      sku: `DEMO-SEAT-${k}`, category: "accessory", type: "seat",
      name: `Fold-down shower seat, ${colorName.toLowerCase()}`, familyName: "Fold-down shower seat", colorName,
      engine: { width: 18, depth: 14, color, frameColor: FINISH.nickel.hex, ratedLoad: 300 },
      price,
    });
  }

  // beadboard wall kits (Swan has no beadboard; a generic look for the demo)
  for (const [k, colorName, color] of [["WHITE", "White", "#f4f4f0"], ["GRAY", "Light gray", "#c9cbc8"]]) {
    for (const [size, type, L, Wd, H, price] of [["SH6232", "pan", 62, 32, 84, 175000], ["SH6236", "pan", 62, 36, 84, 180000], ["TUB6232", "tub", 62, 32, 60, 160000]]) {
      add({
        sku: `DEMO-WALL-BEAD-${size}-${k}`, category: "wall", type,
        name: `Beadboard ${type === "pan" ? "shower" : "tub"} wall kit ${L}″ × ${Wd}″ × ${H}″, ${colorName.toLowerCase()}`, familyName: "Beadboard wall panels", colorName,
        engine: { color, material: "generic wall panel (DEMO)", pattern: { type: "beadboard", boardW: 3.5, grooveW: 0.25 }, gloss: 0.45, kit: { height: H, fitsLengthMin: L - 6, fitsLengthMax: L, fitsWidthMin: Wd - 6, fitsWidthMax: Wd } },
        price,
      });
    }
  }

  // low-profile shower base, left or right drain
  const LEFT = { id: "left", name: "Left-hand drain", along: 0.12, across: 0.5 };
  const RIGHT = { id: "right", name: "Right-hand drain", along: 0.88, across: 0.5 };
  for (const width of [30, 32, 36]) for (const [colorKey, colorName, color, add$] of [["WHITE", "White", "#f3f3ef", 0], ["GRAY", "Light gray", "#c4c6c4", 5000]]) for (const drain of [LEFT, RIGHT]) {
    add({
      sku: `DEMO-BASE-LP-60${width}-${drain.id === "left" ? "L" : "R"}-${colorKey}`, category: "base", type: "pan",
      name: `Low-profile shower base 60″ × ${width}″, ${drain.name.toLowerCase()}, ${colorName.toLowerCase()}`, familyName: "Low-profile shower base", colorName,
      engine: { length: 60, width, height: 3, color, material: "acrylic", geometry: { thresholdW: 2.5, ledgeW: 1.25, floorDrop: 1.4, slope: 1.6 }, thresholdVerified: false, drains: [drain] },
      price: { 30: 95000, 32: 100000, 36: 105000 }[width] + add$,
    });
  }
  return out;
}

const STARTER_FALLBACK_CATEGORIES = ["wall", "base"]; // walls/bases/tubs if the Swan file is missing

function swanFile() {
  const dir = path.join(__dirname, "..", "catalog-imports");
  try { return fs.readdirSync(dir).filter((f) => /^swan-epf-.*\.xlsx$/i.test(f)).map((f) => path.join(dir, f))[0] || null; } catch { return null; }
}

/** Every Swan part number in the demo, with its family, DEMO price, sort order and drawn look. */
function swanParts() {
  const parts = new Map();
  SWAN_FAMILIES.forEach((f, i) => {
    for (const [model, cents] of Object.entries(f.models)) for (const c of f.colors) {
      parts.set(`${model}.${c}`, { familyName: f.family, price: cents + (f.premium || 0) + (f.colorPremium?.[c] || 0), sortOrder: (i + 1) * 10, look: f.look || null, color: c });
    }
  });
  return parts;
}

async function seedDemoCatalog({ ownerId }) {
  process.env.STUDIO_STORAGE = "memory"; // the seeding process keeps the uploaded file in memory only
  const StudioProduct = require("../models/studio/StudioProduct");
  const StudioPricing = require("../models/studio/StudioPricing");
  const { validateEngine } = require("../utils/studio/catalogFields");
  const starter = require("../data/studio/starter-catalog.json");
  const demo = (cents) => ({ priceCents: Math.round(cents), costCents: null, installCents: 0, internalNote: "DEMO price - not a selling price" });
  const approved = { status: "published", isPublic: true, compatibility: { status: "reviewed", note: "Demo", reviewedBy: ownerId, reviewedAt: new Date() }, review: { info: true, visual: true, by: ownerId, at: new Date() } };
  const checked = (p) => {
    const v = validateEngine(p.category, p.type, p.engine);
    if (v.errors.length) throw new Error(`Demo product ${p.sku}: ${v.errors[0].field} - ${v.errors[0].message}`);
    return v.engine;
  };

  const file = swanFile();
  // researched starter products (with their family and finish), plus the starter walls/bases when there is no Swan file
  const starterDocs = [];
  starter.products.forEach((p, i) => {
    const s = STARTER[p.sku];
    if (s) starterDocs.push({ ...p, familyName: s.familyName, colorName: s.colorName, sortOrder: 500 + i, status: "published", isPublic: true, pricing: demo(s.price), engine: checked(p) });
    else if (!file && STARTER_FALLBACK_CATEGORIES.includes(p.category)) starterDocs.push({ ...p, status: "published", isPublic: true, pricing: demo(p.category === "wall" ? 230000 : 110000) });
  });
  const generic = demoProducts().map(({ price, ...p }, i) => ({ ...p, engine: checked(p), sortOrder: 700 + i, status: "published", isPublic: true, pricing: demo(price) }));
  await StudioProduct.insertMany([...starterDocs, ...generic]);

  let swan = 0, swanSkipped = 0;
  if (file) {
    const { previewImport, applyImport } = require("../utils/studio/manufacturers/importService");
    const { addToStudio } = require("../utils/studio/manufacturers/studioLink");
    const imp = await previewImport({ key: "swan", buffer: fs.readFileSync(file), fileName: path.basename(file), actorId: ownerId });
    await applyImport({ key: "swan", importId: imp._id, actorId: ownerId });
    const parts = swanParts();
    const r = await addToStudio({ key: "swan", partNumbers: [...parts.keys()], actorId: ownerId });
    for (const a of r.added) {
      const s = parts.get(a.sku);
      const set = { ...approved, familyName: s.familyName, sortOrder: s.sortOrder, pricing: demo(s.price) };
      if (s.look) {
        const p = await StudioProduct.findOne({ sku: a.sku }).lean();
        const pattern = s.look === "marble" ? { type: "marble", veinColor: "#a9adb2", veinScale: 30 } : { type: "stone", speckleColor: SPECKLE[s.color] || "#8f8f8a" };
        set.engine = checked({ ...p, engine: { ...p.engine, pattern } });
      }
      await StudioProduct.updateOne({ sku: a.sku }, { $set: set });
    }
    swan = r.added.length;
    swanSkipped = r.skipped.length;
    if (r.skipped.length) console.log(`  demo catalog: ${r.skipped.length} Swan parts skipped (${r.skipped[0].partNumber}: ${r.skipped[0].reason})`);
  }

  const pricing = await StudioPricing.current();
  for (const t of pricing.projectTypes) t.basePriceCents = { "tub-to-shower": 450000, "shower-replacement": 400000, "tub-replacement": 380000 }[t.key];
  for (const a of pricing.adders) a.priceCents = { "paint-above": 60000, "door-install": 25000, "grab-bar-blocking": 15000, "seat-backing": 20000, "valve-relocation": 50000 }[a.key];
  pricing.disclaimer = "DEMO PRICE - sample numbers for testing the Studio. Not a real quote.";
  await pricing.save();
  return { swanFile: file ? path.basename(file) : null, swanProducts: swan, swanSkipped, starterProducts: starterDocs.length, demoProducts: generic.length };
}

module.exports = { seedDemoCatalog, SWAN_FAMILIES, STARTER };
