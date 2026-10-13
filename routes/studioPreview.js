/**
 * The owner's LIVE PREVIEW of the customer Shower Studio - /api/studio-preview.
 *
 * Owner only, checked here on every request (signed-in account with the
 * owner's admin.all permission; employees can never hold it). It shows the
 * customer flow with a FIXED DEMO catalog and DEMO prices
 * (data/studio/preview-catalog.json) and is completely stateless:
 *
 *   - nothing is read from or written to the Studio catalog, designs, photos,
 *     leads or customers (no database model is used here at all);
 *   - "Request installation" validates the form like the real one and answers
 *     with a DEMO reference - no lead, no email, no booking, no contract;
 *   - photos stay in the owner's browser (never uploaded).
 *
 * The public Studio (/api/studio) is unaffected and stays switched off until
 * STUDIO_PUBLIC_ENABLED is set.
 */
const express = require("express");
const crypto = require("crypto");
const auth = require("../middleware/auth");
const { PERMISSIONS, requirePermission } = require("../middleware/authorize");
const { rateLimit } = require("../utils/rateLimit");
const { toEngineCatalog, familyOf } = require("../utils/studio/catalogFields");
const { validateState } = require("../utils/studio/designState");
const { priceDesign, publicQuote } = require("../utils/studio/pricing");
const { isExampleScene } = require("../utils/studio/examples");
const DEMO = require("../data/studio/preview-catalog.json");

const router = express.Router();
const json = express.json({ limit: "256kb" });
const owner = requirePermission(PERMISSIONS.ADMIN);
const byUser = (req) => `studio-preview:${req.user?.id || "anon"}`;
const limit = (name, n) => rateLimit({ limit: n, windowMs: 60_000, keyResolver: (req) => `${byUser(req)}:${name}`, message: "Too many requests. Please wait a moment." });

router.use(auth, ...owner);

const PRODUCTS = new Map(DEMO.products.map((p) => [p.sku, p]));
const CATALOG = toEngineCatalog(DEMO.products, { withSpecs: false });
const PROJECT_TYPES = new Set(DEMO.pricing.projectTypes.map((t) => t.key));
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[A-Za-z]{2,}$/;
const ZIP = /^\d{5}$/;
const digits = (s) => String(s || "").replace(/\D/g, "");
const dummyMarks = { wallTL: [0, 0], wallTR: [1, 0], wallBL: [0, 1], wallBR: [1, 1] };
const dummyPoints = { valve: [0, 0], head: [0, 0] };
const fail = (res, status, message, extra = {}) => res.status(status).json({ message, ...extra });

let enginePromise = null;
const engineCompat = () => (enginePromise ||= import("../utils/studio/engine/compat.mjs"));

/** Every SKU of a design must be in the demo catalog (nothing else can be priced here). */
function demoSkus(design) {
  const skus = [design?.baseId, design?.finishId, design?.fixtureId, design?.enclosureId, ...((design?.accessories || []).map((a) => a.productId))].filter((s) => s && s !== "none");
  const unknown = skus.find((s) => !PRODUCTS.has(s));
  if (unknown) throw Object.assign(new Error("That product is not in the preview catalog."), { status: 400 });
  return skus;
}

router.get("/catalog", limit("catalog", 120), (_req, res) => {
  res.set("Cache-Control", "private, no-store");
  res.json({
    enabled: true, preview: true,
    catalog: CATALOG,
    projectTypes: DEMO.pricing.projectTypes.filter((t) => t.enabled !== false).map(({ key, label, includes }) => ({ key, label, includes })),
    disclaimer: DEMO.pricing.disclaimer,
    privacyNote: DEMO.pricing.privacyNote,
    packages: [],
    version: "preview-1",
  });
});

router.post("/quote", limit("quote", 240), json, (req, res) => {
  try {
    const state = validateState({ marks: dummyMarks, points: dummyPoints, design: req.body?.design }, null);
    const projectType = PROJECT_TYPES.has(req.body?.projectType) ? req.body.projectType : "tub-to-shower";
    demoSkus(state.design);
    const result = priceDesign({ design: state.design, projectType, products: PRODUCTS, pricing: DEMO.pricing });
    return res.json({ ...publicQuote(result, DEMO.pricing, { measureSource: req.body?.measureSource === "customer" ? "customer" : "standard" }), preview: true });
  } catch (e) {
    return fail(res, e.status || 400, e.status ? e.message : "Could not price this design.");
  }
});

/**
 * "Request installation" in the preview: the same checks a customer's request
 * gets, then a DEMO reference. Nothing is stored or sent.
 */
router.post("/submit", limit("submit", 30), json, async (req, res) => {
  try {
    const b = req.body || {};
    const errors = [];
    if (String(b.name || "").trim().length < 2) errors.push({ field: "name", message: "Please enter your name." });
    if (!EMAIL.test(String(b.email || "").trim())) errors.push({ field: "email", message: "Please enter a valid email." });
    const ph = digits(b.phone);
    if (ph.length < 10 || ph.length > 15) errors.push({ field: "phone", message: "Please enter a phone number we can reach you at." });
    if (!ZIP.test(String(b.zip || "").trim())) errors.push({ field: "zip", message: "Please enter a 5-digit ZIP code." });
    if (b.consent !== true) errors.push({ field: "consent", message: "Please agree to be contacted about this request." });
    if (!b.state?.design || (!b.photo && !isExampleScene(b.exampleScene))) errors.push({ field: "design", message: "Finish your design first." });
    if (errors.length) return fail(res, 400, errors[0].message, { errors });
    const state = validateState({ marks: dummyMarks, points: dummyPoints, design: b.state.design }, null);
    const projectType = PROJECT_TYPES.has(b.projectType) ? b.projectType : "tub-to-shower";
    demoSkus(state.design);
    const { check } = await engineCompat();
    const r = check(state.design, CATALOG);
    const block = r.errors.filter((x) => !String(x.field).startsWith("accessory:"));
    if (block.length) return fail(res, 400, `This combination can't be installed as chosen: ${block[0].message}`, { errors: block });
    const result = priceDesign({ design: state.design, projectType, products: PRODUCTS, pricing: DEMO.pricing });
    // No personal data is logged: only that a preview request was tried.
    console.log(JSON.stringify({ event: "studio_preview_request", complete: result.complete, items: result.selections.length }));
    return res.json({ ok: true, preview: true, reference: `DEMO-${crypto.randomBytes(3).toString("hex").toUpperCase()}`, totalCents: result.totalCents, selections: result.selections.map((s) => ({ name: s.name, family: familyOf(PRODUCTS.get(s.sku) || {}).label || "" })) });
  } catch (e) {
    return fail(res, e.status || 400, e.status ? e.message : "Could not check this request.");
  }
});

module.exports = router;
