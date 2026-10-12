/**
 * The American Bath Group "Electronic Product File" (EPF) format - the
 * spreadsheet Swan publishes for dealers (and, as ABG brands, likely MAAX and
 * DreamLine too). Turns a workbook into normalized supplier items.
 *
 * One item per Sellable Part Number. The part number is the manufacturer's
 * stable identity for a variant (model + colour, e.g. TK00105.130), so it is
 * what re-imports match on. Nothing here decides prices or compatibility; it
 * only reads what the manufacturer published.
 *
 * Brand-specific knowledge (sheet names, series naming, colours, patterns) is
 * in the brand's adapter, e.g. ./swan.js.
 */
const crypto = require("crypto");

const H = Object.freeze({
  part: "Sellable Part Number",
  variant: "Variant ID (Internal Use)",
  upc: "UPC",
  short: "Short Product Name",
  name: "Product Name",
  category: "Product Category",
  price: "List Price",
  priceDate: "List Price Effective Date",
  discDate: "Discontinuation Date",
  install: "Installation Type",
  material: "Material",
  color: "Color",
  surface: "Surface Type",
  config: "Configuration",
  shape: "Shape",
  pieces: "Number Of Pieces",
  warranty: "Warranty",
  access: "Accessibility Type",
  code: "Code Compliancy",
  afr: "AFR",
});

const DIMS = Object.freeze({
  widthIn: "Product Width (in.)",
  lengthIn: "Product Length (in.)",
  heightIn: "Product Height (in.)",
  depthIn: "Product Depth (in.)",
  thresholdWidthIn: "Threshold Width (in.)",
  bathingWellLengthIn: "Bottom Bathing Well Length (in.)",
  bathingWellWidthIn: "Bottom Bathing Well Width (in.)",
  deepSumpHeightIn: "Deep Sump Height (in.)",
  deckWidthIn: "Deck Width (in.)",
  doorHeightIn: "Height Available for Door Installation (in.)",
  doorWidthIn: "Width Available for Door Installation (in.)",
  weightLbs: "Weight Lbs",
  maxGallons: "Maximum US Gallons",
});

const MEDIA = Object.freeze([
  ...[1, 2, 3, 4, 5].map((i) => [`Product Image ${i}`, "photo"]),
  ...[1, 2, 3].map((i) => [`Video link ${i}`, "video"]),
  ...[1, 2].map((i) => [`Installation Guide ${i}`, "installGuide"]),
  ...[1, 2].map((i) => [`Technical Drawing ${i}`, "drawing"]),
  ["CAD File", "cad"],
]);

/** Columns the importer reads into named fields; everything else is kept as attributes. */
const KNOWN = new Set([...Object.values(H), ...Object.values(DIMS), ...MEDIA.map((m) => m[0]), "Brand", "Feature 1", "Feature 2", "Feature 3"]);

const REQUIRED = Object.freeze({
  catalog: [H.part, H.name, H.category, H.price],
  discontinued: [H.part],
});

/** Manufacturer category -> the Studio's catalog groups (in the owner's priority order). */
const GROUPS = Object.freeze([
  { key: "walls", label: "Shower & tub walls", categories: ["Wall"] },
  { key: "bases", label: "Shower bases & pans", categories: ["Shower Base"] },
  { key: "bathtubs", label: "Bathtubs", categories: ["Bathtub"] },
  { key: "tubShowers", label: "Tub/shower units", categories: ["Tub Shower"] },
  { key: "showers", label: "Shower units", categories: ["Shower"] },
  { key: "accessories", label: "Accessories", categories: ["Accessory"] },
  { key: "vanityTops", label: "Vanity tops", categories: ["Vanity Top"] },
  { key: "sinks", label: "Sinks", categories: ["Sink"] },
  { key: "other", label: "Other", categories: [] },
]);
const GROUP_OF = new Map(GROUPS.flatMap((g) => g.categories.map((c) => [c.toLowerCase(), g.key])));
const groupOf = (category) => GROUP_OF.get(String(category || "").toLowerCase()) || "other";

const num = (v) => {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};
function dateText(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^\d{5}(\.\d+)?$/.test(s)) return new Date(Date.UTC(1899, 11, 30) + Number(s) * 86400000).toISOString().slice(0, 10); // Excel serial date
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s.slice(0, 20) : d.toISOString().slice(0, 10);
}
/** A web link, upgraded to https on the manufacturer's own hosts (some cells still say http). */
function safeUrl(v, hosts = []) {
  try {
    const u = new URL(String(v).trim());
    if (u.protocol === "http:" && hosts.includes(u.hostname.toLowerCase())) u.protocol = "https:";
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}
/** Some cells hold several links joined by "|" (or spaces). */
const splitLinks = (v) => String(v).split(/\s*\|\s*|\s+(?=https?:\/\/)/).map((x) => x.trim()).filter(Boolean);
function mediaKind(kind, url) {
  if (kind !== "cad") return kind;
  const ext = url.split("?")[0].split(".").pop().toLowerCase();
  return ext === "glb" || ext === "gltf" ? "model3d" : "cad";
}
const slug = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);

/** The fields a re-import compares. A change in any of them is "changed". */
function feedHash(item) {
  const { sheet, row, ...feed } = item;
  return crypto.createHash("sha1").update(JSON.stringify(feed)).digest("hex");
}

function sheetRole(name, adapter) {
  for (const r of adapter.sheetRoles) if (r.match.test(name)) return r.role;
  return null;
}

/**
 * @param workbook  readWorkbook() output
 * @param adapter   brand adapter (key, name, sheetRoles, seriesName(), modelNumber())
 * @returns { items: Map<partNumber, item>, discontinued: Map<partNumber, {...}>, issues, stats }
 */
function normalizeEpf(workbook, adapter) {
  const issues = [];
  const issue = (level, message, at = {}) => { if (issues.length < 500) issues.push({ level, message, ...at }); };
  const stats = { sheets: [], rows: 0 };
  const items = new Map();
  const discontinued = new Map();
  const seenRoles = new Set();

  for (const sheet of workbook.sheets) {
    const role = sheetRole(sheet.name, adapter);
    stats.sheets.push({ name: sheet.name, role: role || "ignored", rows: sheet.rows.length });
    if (!role) { issue("info", `Sheet "${sheet.name}" is not a product sheet and was skipped.`, { sheet: sheet.name }); continue; }
    seenRoles.add(role);
    const need = role === "discontinued" ? REQUIRED.discontinued : REQUIRED.catalog;
    const missing = need.filter((h) => !sheet.headers.includes(h));
    if (missing.length) {
      issue("error", `Sheet "${sheet.name}" is missing the column(s): ${missing.join(", ")}.`, { sheet: sheet.name });
      continue;
    }
    stats.rows += sheet.rows.length;

    for (const r of sheet.rows) {
      const at = { sheet: sheet.name, row: r._row };
      const part = String(r[H.part] || "").trim();
      if (!part) { issue("warn", "Row without a Sellable Part Number was skipped.", at); continue; }
      if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,63}$/.test(part)) { issue("warn", `Part number "${part.slice(0, 40)}" has unexpected characters; skipped.`, at); continue; }

      if (role === "discontinued") {
        if (discontinued.has(part)) continue;
        discontinued.set(part, { partNumber: part, name: r[H.name] || r[H.short] || "", category: r[H.category] || "", discontinuedAt: dateText(r[H.discDate]), sheet: sheet.name, row: r._row });
        continue;
      }

      const priceNum = num(r[H.price]);
      if (priceNum == null) issue("warn", `${part}: list price "${String(r[H.price] || "").slice(0, 20)}" is not a number.`, at);
      const media = [];
      const seenUrl = new Set();
      for (const [col, kind] of MEDIA) {
        if (!r[col]) continue;
        for (const raw of splitLinks(r[col])) {
          const url = safeUrl(raw, adapter.mediaHosts || []);
          if (!url) { issue("warn", `${part}: "${col}" is not a web link.`, at); continue; }
          if (seenUrl.has(url)) continue;
          seenUrl.add(url);
          media.push({ kind: mediaKind(kind, url), url });
        }
      }
      const dims = {};
      for (const [k, col] of Object.entries(DIMS)) { const v = num(r[col]); if (v != null && v > 0) dims[k] = v; }
      const attributes = {};
      for (const [k, v] of Object.entries(r)) if (k !== "_row" && !KNOWN.has(k) && Object.keys(attributes).length < 80) attributes[k] = String(v).slice(0, 300);
      const category = String(r[H.category] || "").trim();
      const colorCode = /\.([0-9]{3})$/.exec(part)?.[1] || null;
      const base = {
        manufacturer: adapter.key,
        partNumber: part,
        variantId: String(r[H.variant] || "").trim(),
        upc: String(r[H.upc] || "").trim(),
        baseModel: part.split(".")[0],
        name: String(r[H.name] || r[H.short] || part).trim().slice(0, 300),
        shortName: String(r[H.short] || "").trim().slice(0, 160),
        category,
        group: groupOf(category),
        availability: role === "specialOrder" ? "special-order" : "active",
        programs: role === "express" ? ["express"] : [],
        listPriceCents: priceNum == null ? null : Math.round(priceNum * 100),
        listPriceEffective: dateText(r[H.priceDate]),
        color: { code: colorCode, name: String(r[H.color] || "").trim() },
        surface: String(r[H.surface] || "").trim(),
        material: String(r[H.material] || "").trim(),
        installationType: String(r[H.install] || "").trim(),
        configuration: String(r[H.config] || "").trim(),
        shape: String(r[H.shape] || "").trim(),
        pieces: num(r[H.pieces]),
        warranty: String(r[H.warranty] || "").trim(),
        accessibility: String(r[H.access] || "").trim(),
        codeCompliancy: String(r[H.code] || "").trim(),
        afr: String(r[H.afr] || "").toLowerCase() === "true",
        dims,
        features: ["Feature 1", "Feature 2", "Feature 3"].map((c) => String(r[c] || "").trim()).filter(Boolean),
        media,
        attributes,
      };
      base.familyKey = base.variantId ? base.variantId.split("-")[0] : base.baseModel;
      base.modelNumber = adapter.modelNumber(base);
      base.seriesName = adapter.seriesName(base);
      base.seriesKey = `${base.group}:${slug(base.seriesName)}`;
      const item = { ...base, sheet: sheet.name, row: r._row };

      const prev = items.get(part);
      if (prev) {
        if (role === "express" && prev.availability === "active") { prev.programs = [...new Set([...prev.programs, "express"])]; continue; }
        if (prev.programs.includes("express") && role === "active") { item.programs = [...new Set([...item.programs, "express"])]; items.set(part, item); continue; }
        issue("warn", `${part} is listed more than once (${prev.sheet} row ${prev.row} and ${sheet.name} row ${r._row}); the first row was kept.`, at);
        continue;
      }
      items.set(part, item);
    }
  }

  if (!seenRoles.has("active")) issue("error", `No active product sheet was found. Expected a sheet whose name matches ${adapter.sheetRoles.find((r) => r.role === "active")?.match}.`);
  // A part both listed for sale and listed as discontinued: keep it for sale, flag it.
  for (const [part, d] of discontinued) {
    if (items.has(part)) issue("warn", `${part} is listed both for sale (${items.get(part).sheet}) and as discontinued (${d.sheet}); it is kept as for sale - please check with the manufacturer.`, { sheet: d.sheet, row: d.row });
  }
  for (const it of items.values()) it.feedHash = feedHash(it);
  return { items, discontinued, issues, stats };
}

module.exports = { normalizeEpf, GROUPS, groupOf, feedHash, slug, H, DIMS };
