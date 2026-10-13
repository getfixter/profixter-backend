/**
 * What a product fits and pairs with in the current Studio catalog, worked
 * out with the designer's own compatibility rules (engine/compat.mjs), plus a
 * checklist of what the owner should confirm. Used by the compatibility review
 * in Admin; it never approves anything by itself.
 */
const { toEngineCatalog } = require("./catalogFields");
const { staffCatalog } = require("./catalogService");

let enginePromise = null;
const compat = () => (enginePromise ||= import("./engine/compat.mjs"));

/** An alcove exactly the size of a base, walls on both sides, for "would this pair work?". */
const alcoveFor = (base) => ({ facingWidth: base.dims.length, sideLength: base.dims.width, rimHeight: base.dims.height, leftWall: true, rightWall: true });
const brief = (x) => ({ sku: x.id, name: x.name, status: x.status, size: x.variant?.size || "", color: x.variant?.color || "" });

async function compatReport(product) {
  const { kitFor, kitUsable } = await compat();
  const { products } = await staffCatalog([product.sku]);
  const cat = toEngineCatalog(products, { withSpecs: false });
  const spec = (label) => (product.specs || []).find((s) => s.label === label)?.value || "";
  const checks = [];
  const out = { checks, pairs: [], pairLabel: "", unpaired: 0 };
  const e = product.engine || {};

  if (product.category === "wall") {
    const finish = cat.finishes.find((f) => f.id === product.sku);
    const kinds = finish?.kits?.map((k) => k.for) || [];
    checks.push({ status: "ok", text: `Wall kit for ${kinds.map((k) => (k === "tub" ? "tubs" : "shower bases")).join(" and ")}${product.source?.manufacturer ? " (from the product name in the price file)" : ""}.` });
    checks.push({ status: product.source?.manufacturer ? "warn" : "ok", text: `Fits alcoves ${e.kit?.fitsLengthMin}–${e.kit?.fitsLengthMax}″ long and ${e.kit?.fitsWidthMin}–${e.kit?.fitsWidthMax}″ deep${product.source?.manufacturer ? ": the upper limits are the kit size; the lower limits assume the panels are trimmed - confirm with the installation guide" : ""}.` });
    if (e.kit?.requiresBase?.length) checks.push({ status: "ok", text: `Only with: ${e.kit.requiresBase.join(", ")}.` });
    for (const base of cat.bases) {
      const kit = kitFor(finish, base);
      if (kit && kitUsable(kit, base, alcoveFor(base))) out.pairs.push(brief(base));
    }
    out.pairLabel = "Bases and tubs in your Studio catalog it fits over";
    out.unpaired = cat.bases.length - out.pairs.length;
  } else if (product.category === "base") {
    const base = cat.bases.find((b) => b.id === product.sku);
    checks.push({ status: "ok", text: `${product.type === "tub" ? "Tub" : "Shower base"} ${e.length}″ × ${e.width}″, ${e.height}″ high.` });
    const install = spec("Installation");
    checks.push({ status: install && !/alcove/i.test(install) ? "warn" : "ok", text: install ? `Installation: ${install}. The designer assumes an alcove.` : "Installation type not given: the designer assumes an alcove." });
    const drain = (e.drains || []).map((d) => d.name).join(", ");
    checks.push({ status: product.source?.manufacturer ? "warn" : "ok", text: `Drain: ${drain || "not set"}${product.source?.manufacturer ? " - position drawn approximately; check it against the drawing" : ""}.` });
    checks.push({ status: e.thresholdVerified ? "ok" : "warn", text: e.thresholdVerified ? `Threshold ${e.geometry?.thresholdW}″ (from the specification): doors needing more are refused.` : `Threshold ${e.geometry?.thresholdW}″ is an ESTIMATE: door minimums only warn until you confirm it.` });
    if (base) {
      for (const f of cat.finishes) {
        const kit = kitFor(f, base);
        if (kit && kitUsable(kit, base, alcoveFor(base))) out.pairs.push(brief(f));
      }
      const doors = cat.enclosures.filter((x) => (!x.forKinds || x.forKinds.includes(base.kind)) && base.dims.length >= x.opening[0] && base.dims.length <= x.opening[1]);
      const tooNarrow = doors.filter((x) => x.kind === "door" && x.minThreshold && e.geometry?.thresholdW != null && e.geometry.thresholdW < x.minThreshold);
      checks.push({ status: tooNarrow.length ? "warn" : "ok", text: `${doors.length} door(s)/rod(s) in your catalog fit this opening${tooNarrow.length ? `; ${tooNarrow.length} need a wider threshold (${tooNarrow.map((d) => d.name).slice(0, 3).join(", ")})` : ""}.` });
    }
    out.pairLabel = "Wall kits in your Studio catalog that fit over it";
    out.unpaired = cat.finishes.length - out.pairs.length;
  } else if (product.category === "accessory") {
    checks.push({ status: "warn", text: product.type === "seat" ? "Seats need solid backing and are for showers only (the designer refuses them over a tub)." : product.type === "grabBar" ? "Grab bars need blocking or approved anchors; the designer warns outside 33–36″ (ADA)." : "Shelves go in a corner on the new panels." });
  }
  out.pairs.sort((a, b) => a.name.localeCompare(b.name));
  out.total = out.pairs.length;
  out.pairs = out.pairs.slice(0, 40);
  return out;
}

module.exports = { compatReport };
