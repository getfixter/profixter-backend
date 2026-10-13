/**
 * Swan (swanstone.com, an American Bath Group brand) - adapter for Swan's
 * Electronic Product File (EPF), published at swanstone.com -> Pro's Corner ->
 * Resources.
 *
 * Sources for the reference data below (checked 2026-10-12):
 *   colours and swatches: https://swanstone.com/collections-and-finishes/finishes
 *   wall patterns:        https://swanstone.com/wall-patterns (tile sizes as published)
 *
 * `approxHex` is the average colour of the official swatch photo, measured -
 * an APPROXIMATION for drawing, never presented as the manufacturer's colour.
 * Swatch photos are close-ups, not seamless repeat textures; they are linked
 * for the owner to look at in Admin and are not used as wall textures.
 */

const SWATCH = "https://res.cloudinary.com/american-bath-group/image/upload/";
const FIN = "websites-product-info-and-content/swan/content/collections-and-finishes/materials-and-finishes/finishes/";
const sw = (v, file) => `${SWATCH}${v}/${FIN}${file}`;

/** Colour codes (the 3 digits after the dot in a part number). */
const COLORS = Object.freeze([
  { code: "013", name: "Coastal Sands", series: "Nature Color Series", materials: ["Swanstone"], approxHex: "#e9e8dc", swatchUrl: sw("v1751324347", "swan-coastal-sands-013.jpg") },
  { code: "141", name: "Mountain Mist", series: "Nature Color Series", materials: ["Swanstone"], approxHex: "#cecdb8", swatchUrl: sw("v1751324343", "swan-mountain-mist-141.jpg") },
  { code: "203", name: "Ash Gray", series: "Concrete Series", materials: ["Swanstone"], approxHex: "#b5b6b3", swatchUrl: sw("v1634122148", "Ash_Gray_203.jpg") },
  { code: "226", name: "Birch", series: "Concrete Series", materials: ["Swanstone"], approxHex: "#cdc8c3", swatchUrl: sw("v1634124792", "Birch_226.jpg") },
  { code: "218", name: "Limestone", series: "Concrete Series", materials: ["Swanstone"], approxHex: "#a49a8c", swatchUrl: sw("v1634126224", "Limestone_218.jpg") },
  { code: "221", name: "Carrara", series: "Aggregate Series", materials: ["Swanstone"], approxHex: "#e9e9e9", swatchUrl: sw("v1634125434", "Carrara_221.jpg"), look: "marble" },
  { code: "130", name: "Ice", series: "Aggregate Series", materials: ["Swanstone"], approxHex: "#c9c9cc", swatchUrl: sw("v1634126131", "Ice_130.png") },
  { code: "011", name: "Tahiti White", series: "Aggregate Series", materials: ["Swanstone"], approxHex: "#cecdcd", swatchUrl: sw("v1634126381", "Tahiti_White_11.png") },
  { code: "018", name: "Bisque", series: "Solid Colors", materials: ["Swanstone"], approxHex: "#dbd8c9", swatchUrl: sw("v1634124914", "Bisque_018.png") },
  { code: "010", name: "White", series: "Solid Colors", materials: ["Swanstone", "Veritek"], approxHex: "#fcfcfc", swatchUrl: sw("v1634126452", "White_010-2.png") },
  { code: "170", name: "Espresso", series: "Granite Series", materials: ["Granite"], approxHex: "#3d2f33", swatchUrl: sw("v1634127186", "Espresso_170.png") },
  { code: "076", name: "Granito", series: "Granite Series", materials: ["Granite"], approxHex: "#dacdc2", swatchUrl: sw("v1634127286", "Granito_076.png") },
  { code: "173", name: "Metallico", series: "Granite Series", materials: ["Granite"], approxHex: "#959494", swatchUrl: sw("v1634127598", "Metallico_173.png") },
  { code: "077", name: "Nero", series: "Granite Series", materials: ["Granite"], approxHex: "#494043", swatchUrl: sw("v1634127996", "Nero_077.png") },
  { code: "210", name: "Opal White", series: "Granite Series", materials: ["Granite"], approxHex: "#e1e1e0", swatchUrl: sw("v1634128118", "Opal_White_210.png") },
  // Drain cover finishes (official swatches; colour values are generic approximations)
  { code: "089", name: "Antique Bronze", series: "Drain cover finishes", materials: ["Metal"], approxHex: "#5b4636", approxSource: "generic", swatchUrl: sw("v1634193664", "Antique-Bronze-_089.png") },
  { code: "187", name: "Brushed Nickel", series: "Drain cover finishes", materials: ["Metal"], approxHex: "#b8b5ad", approxSource: "generic", swatchUrl: sw("v1634193911", "Brushed-Nickel-_187.png") },
  { code: "088", name: "Polished Brass", series: "Drain cover finishes", materials: ["Metal"], approxHex: "#d4b25c", approxSource: "generic", swatchUrl: sw("v1634193997", "Polished-Brass-_088.png") },
  { code: "086", name: "Stainless Steel", series: "Drain cover finishes", materials: ["Metal"], approxHex: "#c0c2c4", approxSource: "generic", swatchUrl: sw("v1634194056", "Stainless-Steel-_086.png") },
  // In the EPF but not on the finishes page (special order / metal accessories): no official swatch found.
  { code: "224", name: "Aster", series: "Special order", materials: ["Swanstone"], approxHex: null, swatchUrl: null },
  { code: "225", name: "Sea Breeze", series: "Special order", materials: ["Swanstone"], approxHex: null, swatchUrl: null },
  { code: "223", name: "Storm Gray", series: "Special order", materials: ["Swanstone"], approxHex: null, swatchUrl: null },
  { code: "037", name: "Bone", series: "Special order", materials: ["Swanstone"], approxHex: null, swatchUrl: null },
  { code: "343", name: "Brushed Gold", series: "Metal finishes", materials: ["Metal"], approxHex: "#c8a96a", approxSource: "generic", swatchUrl: null },
  { code: "201", name: "Brushed Chrome", series: "Metal finishes", materials: ["Metal"], approxHex: "#c9ccce", approxSource: "generic", swatchUrl: null },
  { code: "340", name: "Matte Black", series: "Metal finishes", materials: ["Metal"], approxHex: "#2b2b2b", approxSource: "generic", swatchUrl: null },
]);
const COLOR_BY_CODE = new Map(COLORS.map((c) => [c.code, c]));
const COLOR_BY_NAME = new Map(COLORS.map((c) => [c.name.toLowerCase(), c]));

const PATTERN_IMG = "https://res.cloudinary.com/american-bath-group/image/upload/";
/** Official wall patterns. Tile sizes as published by Swan (inches). */
const PATTERNS = Object.freeze([
  { code: "TS", name: "Traditional Subway Tile", match: /tra?i?ditional subway/i, pattern: { type: "tile", orientation: "horizontal", bond: "running", tileW: 24, tileH: 12 }, imageUrl: `${PATTERN_IMG}v1695156029/websites-product-info-and-content/swan/content/common/wall-patterns/swan-wall-pattern-traditional-subway-tile.png` },
  { code: "MS", name: "Modern Subway Tile", match: /modern subway/i, pattern: { type: "tile", orientation: "horizontal", bond: "running", tileW: 24, tileH: 6 }, imageUrl: `${PATTERN_IMG}v1695156056/websites-product-info-and-content/swan/content/common/wall-patterns/swan-wall-pattern-modern-subway-tile.png` },
  { code: "MT", name: "Metro Subway Tile", match: /metro subway/i, pattern: { type: "tile", orientation: "horizontal", bond: "running", tileW: 8, tileH: 4 }, imageUrl: `${PATTERN_IMG}v1701898903/websites-product-info-and-content/swan/content/common/wall-patterns/swan-wall-pattern-metro-subway-tile.png` },
  { code: "VT", name: "Vertical Tile", match: /vertical tile/i, pattern: { type: "tile", orientation: "vertical", bond: "stack", tileW: 3, tileH: 12 }, imageUrl: `${PATTERN_IMG}v1702002096/websites-product-info-and-content/swan/content/common/wall-patterns/swan-wall-patterns-vertical-tile.png` },
  { code: "SM", name: "Smooth Wall", match: /smooth/i, pattern: { type: "smooth" }, imageUrl: `${PATTERN_IMG}v1695156078/websites-product-info-and-content/swan/content/common/wall-patterns/swan-wall-pattern-smooth.png` },
]);
// Note: Novaline "Subway Tile" kits are a different product line; their tile size is not published
// on the pattern page, so they are not matched to TS/MS/MT (the pattern stays unknown).
const patternFor = (item) => (/novaline/i.test(item.name) && !/vertical/i.test(item.name) ? null : PATTERNS.find((p) => p.match.test(item.name)) || null);

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const CODE_LIKE = /^[A-Z0-9][A-Z0-9\/.-]*\d[A-Z0-9\/.-]*$/i;

function modelNumber(item) {
  const first = String(item.shortName || "").split(/\s+/)[0] || "";
  return CODE_LIKE.test(first) && /[A-Z]/i.test(first) ? first : item.baseModel;
}

/** "MTMK72-3450 34 x 50 x 72 Swanstone® Metro Subway Tile ... in Ice" -> "Swanstone® Metro Subway Tile ..." */
function seriesName(item) {
  let n = item.name;
  if (item.color?.name) n = n.replace(new RegExp(`\\s+(in\\s+)?${esc(item.color.name)}\\s*$`, "i"), "");
  n = n.replace(/^(Optima™\s+)?[A-Z0-9][A-Z0-9\/-]*\d[A-Z0-9\/-]*\s+/, "$1");
  n = n.replace(/^\(AFR\)\s*/, "");
  n = n.replace(/^[\d.\s\/x"-]+(?=[A-Za-z(])/, "");
  n = n.replace(/^(NexTile)( FHA)? \d{4} /, "$1$2 ");
  n = n.replace(/^(Novaline) \d+ x \d+ x \d+ /, "$1 ");
  n = n.replace(/\b(Left|Right) Hand\b/g, "L/R");
  n = n.replace(/Traiditional/g, "Traditional");
  n = n.replace(/\s+in\s+(Gray Granite|White)$/i, "");
  return n.trim() || item.shortName || item.baseModel;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v, step = 0.125) => Math.round(v / step) * step;

function colorOf(item) {
  return COLOR_BY_CODE.get(item.color?.code || "") || COLOR_BY_NAME.get(String(item.color?.name || "").toLowerCase()) || null;
}
function glossOf(item) {
  const s = String(item.surface || "").toLowerCase();
  return s === "gloss" ? 0.75 : s === "matte" ? 0.25 : s === "satin" ? 0.5 : 0.5;
}
function materialLabel(item) {
  return String(item.material || "").replace(/[®™]/g, "").trim() || "Swanstone";
}

/** How much smaller an alcove a glue-up panel kit can be trimmed to (owner-editable per manufacturer). */
const DEFAULT_TRIM_ALLOWANCE_IN = 6;

const DRAIN = {
  center: { id: "center", name: "Center drain", along: 0.5, across: 0.5 },
  "front center": { id: "front-center", name: "Front center drain", along: 0.5, across: 0.25 },
  left: { id: "left", name: "Left-hand drain", along: 0.12, across: 0.5 },
  right: { id: "right", name: "Right-hand drain", along: 0.88, across: 0.5 },
};

/**
 * What the Studio's designer can draw for this item, with every value marked
 * by where it came from. Returns { supported: false, reason } for items the
 * designer cannot show (they stay in the manufacturer catalog).
 *
 * Values from the EPF are the manufacturer's; everything else is an
 * APPROXIMATION for drawing and is listed in `approximations`.
 */
function studioMapping(item, { trimAllowanceIn = DEFAULT_TRIM_ALLOWANCE_IN } = {}) {
  const d = item.dims || {};
  const color = colorOf(item);
  const approximations = [];
  const hex = color?.approxHex || null;
  if (!hex) approximations.push(`Colour "${item.color?.name || "unknown"}" has no measured swatch: drawn in a neutral placeholder colour.`);
  else approximations.push(`Colour drawn from the average of Swan's ${color.name} swatch${color.approxSource === "generic" ? " (generic metal approximation)" : ""} - not a colour match.`);
  const panelColor = hex || "#e8e6e1";
  const L = Math.max(d.lengthIn || 0, d.widthIn || 0);
  const W = Math.min(d.lengthIn || 0, d.widthIn || 0);
  const name = item.name;
  const rectangular = /^(rectangular|square)$/i.test(item.shape || "");
  const alcove = /^alcove$/i.test(item.installationType || "");

  if (item.group === "walls") {
    if (!/wall kit/i.test(name) || (item.pieces || 0) < 3) return { supported: false, reason: "Single panels and trims are sold with kits; the designer draws complete wall kits only." };
    if (!(L >= 24 && W >= 20 && d.heightIn >= 30)) return { supported: false, reason: "The file does not give this kit's length, depth and height." };
    const pat = patternFor(item);
    if (!pat) approximations.push("Wall pattern size is not published for this kit: drawn smooth.");
    else if (pat.pattern.type === "tile") approximations.push(`${pat.name} drawn as ${pat.pattern.tileW}" × ${pat.pattern.tileH}" tiles (Swan's published size); grout line width is estimated.`);
    const kinds = /bathtub and shower/i.test(name) ? ["pan", "tub"] : /tub wall kit/i.test(name) ? ["tub"] : /shower wall kit/i.test(name) ? ["pan"] : ["pan", "tub"];
    approximations.push(`Fits alcoves up to ${L}" × ${W}" (the kit size); trimming down ${trimAllowanceIn}" is an assumption - verify.`);
    return {
      supported: true,
      category: "wall",
      type: kinds[0],
      engine: {
        color: panelColor,
        material: materialLabel(item),
        pattern: pat?.pattern.type === "tile" ? { ...pat.pattern, groutW: 0.125 } : { type: "smooth" },
        gloss: glossOf(item),
        kit: {
          height: clamp(d.heightIn, 30, 100),
          fitsLengthMax: clamp(L, 24, 96),
          fitsLengthMin: clamp(L - trimAllowanceIn, 24, 96),
          fitsWidthMax: clamp(W, 20, 72),
          fitsWidthMin: clamp(W - trimAllowanceIn, 20, 72),
          ...(kinds.length > 1 ? { forKinds: kinds } : {}),
        },
      },
      patternCode: pat?.code || null,
      approximations,
    };
  }

  if (item.group === "bases" || item.group === "bathtubs") {
    const tub = item.group === "bathtubs";
    if (!rectangular || !alcove) return { supported: false, reason: `The designer draws rectangular alcove ${tub ? "tubs" : "bases"}; this one is ${item.shape || "?"} / ${item.installationType || "?"}.` };
    if (!(L >= 24 && L <= 96 && W >= 20 && W <= 72 && d.heightIn > 0)) return { supported: false, reason: "The file does not give a usable length, depth and height." };
    const drain = DRAIN[String(item.configuration || "").toLowerCase()] || DRAIN.center;
    if (!item.configuration) approximations.push("Drain position not given: drawn centred.");
    approximations.push("Drain position drawn approximately; base ledges and slopes are generic shapes, not the manufacturer's geometry.");
    const threshold = d.thresholdWidthIn;
    if (!threshold) approximations.push("Threshold width not in the file: estimated.");
    const engine = {
      length: L, width: W, height: clamp(d.heightIn, 1, 30), color: panelColor, material: materialLabel(item),
      geometry: {
        thresholdW: threshold ? clamp(threshold, 0.5, 8) : tub ? 3.5 : 2.5,
        ledgeW: tub ? 3.5 : 1.25,
        floorDrop: tub ? clamp(d.deepSumpHeightIn || 13.5, 0.25, 24) : 1.6,
        slope: tub ? 3.5 : 1.6,
      },
      thresholdVerified: Boolean(threshold),
      drains: [drain],
    };
    if (tub && !d.deepSumpHeightIn) approximations.push("Tub interior depth not in the file: estimated.");
    return { supported: true, category: "base", type: tub ? "tub" : "pan", engine, approximations };
  }

  if (item.group === "tubShowers" || item.group === "showers") {
    const tub = item.group === "tubShowers";
    if (!alcove || !(L >= 24 && L <= 96 && W >= 20 && W <= 72 && d.heightIn >= 40)) return { supported: false, reason: "The file does not give this unit's size." };
    // The unit's own walls rise "Height Available for Door Installation" above its rim.
    const wallH = d.doorHeightIn && d.doorHeightIn < d.heightIn ? d.doorHeightIn : null;
    const baseH = wallH ? round(d.heightIn - wallH) : tub ? 18 : 6;
    if (!wallH) approximations.push("Rim height not in the file: estimated.");
    approximations.push("One-piece unit drawn as a base with smooth integral walls - an approximation of its shape.");
    const drain = DRAIN[String(item.configuration || "").toLowerCase()] || DRAIN.center;
    return {
      supported: true,
      category: "base",
      type: tub ? "tub" : "pan",
      engine: {
        length: L, width: W, height: clamp(baseH, 1, 30), color: panelColor, material: materialLabel(item),
        geometry: { thresholdW: d.thresholdWidthIn ? clamp(d.thresholdWidthIn, 0.5, 8) : tub ? 3.5 : 2.5, ledgeW: tub ? 3.5 : 1.25, floorDrop: tub ? clamp(d.deepSumpHeightIn || 13.5, 0.25, 24) : 1.6, slope: tub ? 3.5 : 1.6 },
        thresholdVerified: Boolean(d.thresholdWidthIn),
        drains: [drain],
      },
      // The unit's walls are part of the unit: a linked wall finish, only selectable with it, priced at $0 (included).
      companion: {
        category: "wall",
        type: tub ? "tub" : "pan",
        engine: {
          color: panelColor, material: materialLabel(item), pattern: { type: "smooth" }, gloss: glossOf(item),
          kit: { height: clamp(wallH || d.heightIn - baseH, 30, 100), fitsLengthMin: clamp(L - 0.75, 24, 96), fitsLengthMax: clamp(L + 0.75, 24, 96), fitsWidthMin: clamp(W - 0.75, 20, 72), fitsWidthMax: clamp(W + 0.75, 20, 72) },
        },
      },
      approximations,
    };
  }

  if (item.group === "accessories") {
    const metal = /metal|steel|aluminum|chrome|nickel|brass|bronze/i.test(`${item.material} ${item.color?.name}`);
    if (/straight.*grab bar/i.test(name)) {
      const len = Number(/(\d{2})"/.exec(name)?.[1]) || null;
      if (!len) return { supported: false, reason: "Grab bar length is not in the file." };
      approximations.push("Grab bar tube, flange and clearance are standard sizes, not the manufacturer's drawing.");
      return { supported: true, category: "accessory", type: "grabBar", engine: { length: clamp(len, 6, 60), diameter: 1.25, clearance: 1.5, flange: 3.25, finishColor: hex || "#c9ccce", roughness: 0.35 }, approximations };
    }
    if (/folding.*seat/i.test(name)) {
      approximations.push("Seat size is a standard size: the file does not give it.");
      return { supported: true, category: "accessory", type: "seat", engine: { width: d.widthIn ? clamp(Math.max(d.widthIn, d.lengthIn || 0), 10, 40) : 20, depth: 16, color: panelColor, frameColor: "#c9ccce" }, approximations };
    }
    if (/corner (soap dish|shelf)/i.test(name)) {
      const leg = clamp(Math.max(d.widthIn || 0, d.lengthIn || 0) || 9, 4, 18);
      approximations.push("Drawn as a flat corner shelf.");
      return { supported: true, category: "accessory", type: "shelf", engine: { leg, thickness: 0.4, metal, color: hex || "#b8bbbe" }, approximations };
    }
    return { supported: false, reason: "This accessory has no drawing in the designer yet; it can still be priced in an estimate." };
  }
  return { supported: false, reason: "Not a shower or tub product; kept in the catalog for later use." };
}

module.exports = {
  key: "swan",
  name: "Swan",
  company: "American Bath Group",
  website: "https://swanstone.com/",
  format: "abg-epf",
  fileHelp: "Swan Electronic Product File (EPF) .xlsx - swanstone.com → Pro's Corner → Resources.",
  sourceUrl: "https://swanstone.com/pros-corner/resources",
  sheetRoles: [
    { role: "discontinued", match: /discontinu/i },
    { role: "specialOrder", match: /special/i },
    { role: "express", match: /express/i },
    { role: "active", match: /active/i },
  ],
  /** Hosts the manufacturer's media links point to - the only hosts Profixter's server will contact for them. */
  mediaHosts: ["res.cloudinary.com", "images.salsify.com", "swanstone.com", "www.swanstone.com"],
  mediaPathPrefixes: { "res.cloudinary.com": ["/american-bath-group/"] },
  COLORS,
  PATTERNS,
  DEFAULT_TRIM_ALLOWANCE_IN,
  colorOf,
  colorNameFor: (code) => COLOR_BY_CODE.get(code || "")?.name || "",
  patternFor,
  modelNumber,
  seriesName,
  studioMapping,
};
