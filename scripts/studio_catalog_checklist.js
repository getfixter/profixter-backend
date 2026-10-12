/**
 * The owner's catalog checklist, generated from the starter catalog:
 * what each product still needs (photo, texture, verified specs) and blank
 * lines for the real selling prices. Writes docs/STUDIO_CATALOG_CHECKLIST.md
 * and a CSV for entering prices.
 *   node scripts/studio_catalog_checklist.js
 */
const fs = require("fs");
const path = require("path");
const starter = require("../data/studio/starter-catalog.json");
const { completeness } = require("../utils/studio/catalogFields");

const CAT = { wall: "Wall kits", base: "Shower bases & bathtubs", fixture: "Valve trims (faucet & showerhead)", enclosure: "Doors & curtain rods", accessory: "Accessories" };
const TYPE = { pan: "shower", tub: "tub", shower: "shower-only", tubShower: "tub/shower", door: "door", rod: "rod", grabBar: "grab bar", shelf: "shelf", seat: "seat" };
const lines = [];
const csv = [["category", "sku", "name", "manufacturer", "model", "selling_price_usd", "install_adder_usd", "publish_yes_no", "notes"]];

lines.push("# Shower Studio - catalog & price checklist", "");
lines.push(`Generated from the starter catalog (research of ${starter.researchedOn}). Every starter product is imported as an **unpublished draft with no price**. Nothing is shown to customers until you publish it, and no price is shown until you enter one.`, "");
lines.push("How to use: Admin -> **Studio Catalog** -> Import starter products (once). Then for each product you sell: open it, add a photo (and for walls a texture), enter the price, check the specs, **Publish**. Or fill in `STUDIO_PRICE_SHEET.csv` and enter the numbers from it.", "");
lines.push("## 1. Project base prices (Studio Catalog -> Prices & packages)", "");
lines.push("| Project | What the base price should cover | Your price |", "|---|---|---|");
lines.push("| Tub-to-shower conversion | Remove tub, install shower base, acrylic walls, valve trim | $ ______ |");
lines.push("| Shower replacement | Remove old shower, install base, acrylic walls, valve trim | $ ______ |");
lines.push("| Bathtub replacement | Remove tub, install acrylic tub, tub walls, trim | $ ______ |", "");
lines.push("## 2. Installation adders", "", "| Adder | When it applies | Your price |", "|---|---|---|");
for (const [l, w] of [["Remove old tile above the new walls, patch and paint", "automatically when the design keeps the wall above painted"], ["Glass door installation", "automatically with any glass door"], ["Grab bar blocking and installation", "per grab bar"], ["Seat backing and installation", "per seat"], ["Valve relocation", "added by staff when needed"]]) lines.push(`| ${l} | ${w} | $ ______ |`);
lines.push("", "Also decide: the largest discount employees may give (default 15%), and the price note customers see.", "");
lines.push("## 3. Products", "");
lines.push("Legend: **Photo** = product photo still needed; **Texture** = wall texture (optional, otherwise the pattern is drawn); **Specs** = verified / estimated values from the research.", "");
for (const [cat, label] of Object.entries(CAT)) {
  const items = starter.products.filter((p) => p.category === cat);
  if (!items.length) continue;
  lines.push(`### ${label}`, "", "| Product | Model | Type | Photo | Texture | Specs (verified / estimate) | Needs checking | Price | Publish? |", "|---|---|---|---|---|---|---|---|---|");
  for (const p of items) {
    const v = p.specs.filter((s) => s.status === "VERIFIED").length, e = p.specs.length - v;
    const issues = completeness({ ...p, pricing: { priceCents: null } }).filter((i) => i.level !== "warn" && !/texture/i.test(i.message)).map((i) => i.message);
    const needs = [];
    if (!p.specs.length) needs.push("no specs listed");
    else if (!v) needs.push("no verified spec");
    if (/ESTIMATE|ILLUSTRATIVE|APPROXIMATE/i.test(p.description)) needs.push("pattern/colour approximate - confirm with the manufacturer");
    if (p.category === "base" && !p.engine.thresholdVerified) needs.push("threshold width estimated (matters for some doors)");
    for (const i of issues) if (!/specification/i.test(i)) needs.push(i);
    lines.push(`| ${p.name} | ${p.model || "-"} | ${TYPE[p.type] || p.type} | needed | ${cat === "wall" ? "optional" : "-"} | ${v} / ${e} | ${needs.join("; ") || "-"} | $ ____ | ☐ |`);
    csv.push([label, p.sku, p.name, p.manufacturer, p.model, "", "", "", needs.join("; ")]);
  }
  lines.push("");
}
lines.push("## 4. Before publishing anything", "",
  "- Use only photos and textures you are licensed to use (your own photos, or manufacturer images with permission).",
  "- Prices you enter are shown to customers as an **estimated total** - so publish only products you actually sell at that price.",
  "- A published product without a price makes designs that use it show **\"Price confirmed after review.\"** instead of a number.",
  "- Packages: optional. A package price replaces the individual prices of its products when a design contains all of them.", "");
const docs = path.join(__dirname, "..", "docs");
fs.writeFileSync(path.join(docs, "STUDIO_CATALOG_CHECKLIST.md"), lines.join("\n"));
fs.writeFileSync(path.join(docs, "STUDIO_PRICE_SHEET.csv"), csv.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\r\n"));
console.log(`wrote docs/STUDIO_CATALOG_CHECKLIST.md and docs/STUDIO_PRICE_SHEET.csv (${starter.products.length} products)`);
