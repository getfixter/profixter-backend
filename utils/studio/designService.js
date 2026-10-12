/**
 * Shared design logic for the public and staff Studio routes: compatibility
 * (the same rules the browser uses, from the visualization engine) and the
 * server-side price.
 */
const { priceDesign } = require("./pricing");
const { productMap, staffCatalog } = require("./catalogService");
const StudioPricing = require("../../models/studio/StudioPricing");

let enginePromise = null;
/** The engine's compatibility module (ES module, shared with the browser). */
function engineCompat() {
  enginePromise ||= import("./engine/compat.mjs");
  return enginePromise;
}

/** The base kind a project type needs. */
const KIND_FOR = { "tub-to-shower": "pan", "shower-replacement": "pan", "tub-replacement": "tub" };

function skusOf(design) {
  return [design?.baseId, design?.finishId, design?.fixtureId, design?.enclosureId, ...(design?.accessories || []).map((a) => a.productId)].filter((s) => s && s !== "none");
}

/**
 * Compatibility of a design with the current catalog (archived products the
 * design already uses still resolve). Returns the engine's check result plus
 * project-type rules.
 */
async function checkDesign(design, projectType, extra = {}) {
  const { check } = await engineCompat();
  const { catalog } = await staffCatalog(skusOf(design));
  const r = check({ ...design, valveWall: extra.valveWall || null }, catalog);
  const base = catalog.bases.find((b) => b.id === design.baseId);
  if (base && KIND_FOR[projectType] && base.kind !== KIND_FOR[projectType]) {
    r.errors.push({ field: "projectType", code: "project_type", message: projectType === "tub-replacement" ? "A bathtub replacement needs a tub, not a shower base." : "A shower needs a shower base, not a tub." });
    r.ok = false;
  }
  return r;
}

const blockingErrors = (r) => r.errors.filter((e) => !String(e.field).startsWith("accessory:"));

async function quoteDesign(design, projectType, adjustments = []) {
  const [products, pricing] = await Promise.all([productMap(skusOf(design)), StudioPricing.current()]);
  return { result: priceDesign({ design, projectType, products, pricing: pricing.toObject ? pricing.toObject() : pricing, adjustments }), pricing };
}

module.exports = { checkDesign, quoteDesign, blockingErrors, skusOf, KIND_FOR };
