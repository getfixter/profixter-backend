/**
 * Public Shower Studio API (no account needed) - mounted at /api/studio.
 *
 * Privacy and safety:
 * - A design belongs to whoever holds its edit token (sent as X-Studio-Token).
 *   Only the token's hash is stored. Designs are never listed publicly.
 * - Photos are sanitized (re-encoded, metadata stripped), stored privately and
 *   readable only through short-lived signed links.
 * - Prices are computed here from the owner's price list; the visitor only
 *   ever receives the estimated total, never item prices or internal notes.
 * - Every route is rate-limited; bodies are size-limited.
 * - Submitting creates a lead (Admin -> Leads) and notifies staff. It never
 *   books an installation.
 */
const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const mongoose = require("mongoose");
const StudioDesign = require("../models/studio/StudioDesign");
const StudioPhoto = require("../models/studio/StudioPhoto");
const StudioAsset = require("../models/studio/StudioAsset");
const StudioPricing = require("../models/studio/StudioPricing");
const EstimateLead = require("../models/EstimateLead");
const User = require("../models/User");
const { rateLimit } = require("../utils/rateLimit");
const { sanitizeImageBuffer } = require("../utils/imageSanitizer");
const storage = require("../utils/studio/storage");
const { photoUrl, verify, randomId, hashToken } = require("../utils/studio/signedLinks");
const { publicCatalog } = require("../utils/studio/catalogService");
const { validateState } = require("../utils/studio/designState");
const { checkDesign, quoteDesign, blockingErrors } = require("../utils/studio/designService");
const { publicQuote } = require("../utils/studio/pricing");
const { EXAMPLE_SCENES, isExampleScene, MEASURE_LABEL } = require("../utils/studio/examples");
const PUBLIC_MEASURE = (v) => (v === "customer" ? "customer" : "standard");

const router = express.Router();

/**
 * The public Studio is OFF unless STUDIO_PUBLIC_ENABLED=true. While off (the
 * "dark" launch), the catalog answers with an empty, disabled catalog (the
 * page shows "coming soon") and every design, quote and submission route
 * answers 404 - nothing can be created or sent, even by a script. Catalog
 * images and signed photo links stay available because Admin uses them.
 */
const publicEnabled = () => process.env.STUDIO_PUBLIC_ENABLED === "true";
function requirePublic(req, res, next) {
  if (publicEnabled()) return next();
  return res.status(404).json({ message: "The Shower Studio is not available yet." });
}
const json = express.json({ limit: "512kb" });
const DRAFT_DAYS = Number(process.env.STUDIO_DRAFT_RETENTION_DAYS || 30);
const SUBMITTED_DAYS = Number(process.env.STUDIO_SUBMITTED_RETENTION_DAYS || 730);
const DAY = 864e5;

const { clientIp } = require("../utils/studio/clientIp");
const ip = (req) => clientIp(req); // spoof-resistant behind the load balancer
const limit = (name, n, windowMs, by = ip) => rateLimit({ limit: n, windowMs, keyResolver: (req) => `studio:${name}:${by(req)}`, message: "Too many requests. Please wait a moment and try again." });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 4 },
});

function err(res, status, message, extra = {}) {
  return res.status(status).json({ message, ...extra });
}

/** Load the design the caller holds a token for (constant-time compare). */
async function ownDesign(req, res) {
  const id = String(req.params.id || "");
  const token = String(req.get("x-studio-token") || "");
  if (!/^[A-Za-z0-9_-]{16,40}$/.test(id) || token.length < 20) { err(res, 404, "Design not found."); return null; }
  const d = await StudioDesign.findOne({ publicId: id, origin: "public" });
  const want = Buffer.from(d?.editTokenHash || "0".repeat(64));
  const got = Buffer.from(hashToken(token));
  if (!d || want.length !== got.length || !crypto.timingSafeEqual(want, got)) { err(res, 404, "Design not found."); return null; }
  return d;
}

async function photoInfo(d) {
  if (!d.photo) return null;
  const p = await StudioPhoto.findById(d.photo).lean();
  if (!p || p.deletedAt) return null;
  return { url: photoUrl(p.publicId), width: p.width, height: p.height };
}

async function view(d) {
  return {
    id: d.publicId,
    status: d.status,
    projectType: d.projectType,
    state: d.state,
    exampleScene: d.exampleScene,
    measureSource: d.measureSource,
    photo: await photoInfo(d),
    submittedAt: d.submittedAt,
    customer: d.status === "draft" ? undefined : { name: d.customer.name, email: d.customer.email },
  };
}

// ---------------------------------------------------------------- catalog
router.get("/catalog", limit("catalog", 120, 60_000), async (_req, res) => {
  try {
    res.set("Cache-Control", "public, max-age=30");
    if (!publicEnabled()) {
      return res.json({ enabled: false, catalog: { finishes: [], bases: [], fixtures: [], enclosures: [], accessories: [], specs: {} }, projectTypes: [], packages: [], disclaimer: "", version: "off" });
    }
    return res.json({ enabled: true, ...(await publicCatalog()) });
  } catch (e) {
    console.error("studio catalog failed:", e.message);
    return err(res, 500, "The product catalog is unavailable right now.");
  }
});

/** Catalog images (product photos, textures) - public marketing images. */
router.get("/assets/:publicId", limit("asset", 600, 60_000), async (req, res) => {
  try {
    const a = await StudioAsset.findOne({ publicId: String(req.params.publicId) }).lean();
    if (!a) return err(res, 404, "Not found.");
    const buf = await storage.get(a.storageKey);
    res.set({ "Content-Type": a.contentType, "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff" });
    return res.send(buf);
  } catch {
    return err(res, 404, "Not found.");
  }
});

// ---------------------------------------------------------------- designs
router.post("/designs", requirePublic, limit("create", 20, 60 * 60_000), json, async (req, res) => {
  try {
    const token = randomId(24);
    const d = await StudioDesign.create({
      publicId: randomId(16),
      origin: "public",
      editTokenHash: hashToken(token),
      projectType: ["tub-to-shower", "shower-replacement", "tub-replacement"].includes(req.body?.projectType) ? req.body.projectType : "tub-to-shower",
      exampleScene: isExampleScene(req.body?.exampleScene) ? req.body.exampleScene : null,
      measureSource: PUBLIC_MEASURE(req.body?.measureSource),
      deleteAfter: new Date(Date.now() + DRAFT_DAYS * DAY),
    });
    return res.status(201).json({ id: d.publicId, token, deleteAfter: d.deleteAfter });
  } catch (e) {
    console.error("studio create failed:", e.message);
    return err(res, 500, "Could not start a design.");
  }
});

router.get("/designs/:id", requirePublic, limit("read", 120, 60_000), async (req, res) => {
  const d = await ownDesign(req, res);
  if (!d) return null;
  return res.json(await view(d));
});

router.put("/designs/:id", requirePublic, limit("save", 120, 60_000), json, async (req, res) => {
  try {
    const d = await ownDesign(req, res);
    if (!d) return null;
    if (d.status !== "draft") return err(res, 409, "This design was already sent to Profixter. Our team will continue it with you.");
    if (req.body?.exampleScene !== undefined && !d.photo) {
      if (req.body.exampleScene !== null && !isExampleScene(req.body.exampleScene)) return err(res, 400, "Unknown example bathroom.");
      d.exampleScene = req.body.exampleScene;
    }
    if (req.body?.measureSource !== undefined) d.measureSource = PUBLIC_MEASURE(req.body.measureSource);
    const photo = d.photo ? await StudioPhoto.findById(d.photo).lean() : d.exampleScene ? EXAMPLE_SCENES[d.exampleScene] : null;
    if (req.body?.state) {
      d.state = validateState(req.body.state, photo);
      await assertPublicProducts(d.state.design);
    }
    if (["tub-to-shower", "shower-replacement", "tub-replacement"].includes(req.body?.projectType)) d.projectType = req.body.projectType;
    d.deleteAfter = new Date(Date.now() + DRAFT_DAYS * DAY);
    await d.save();
    return res.json({ ok: true, savedAt: d.updatedAt });
  } catch (e) {
    return err(res, e.status || 500, e.status ? e.message : "Could not save the design.");
  }
});

router.post("/designs/:id/photo", requirePublic, limit("photo", 30, 60 * 60_000), (req, res) => {
  upload.single("photo")(req, res, async (uploadError) => {
    try {
      if (uploadError) return err(res, 400, uploadError.code === "LIMIT_FILE_SIZE" ? "Photos must be 20 MB or smaller." : "Upload one photo.");
      const d = await ownDesign(req, res);
      if (!d) return null;
      if (d.status !== "draft") return err(res, 409, "This design was already sent.");
      if (!req.file) return err(res, 400, "Choose a photo.");
      const clean = await sanitizeImageBuffer(req.file.buffer);
      const sharp = require("sharp");
      const meta = await sharp(clean.buffer).metadata();
      const key = storage.newKey("photos");
      await storage.put(key, clean.buffer, "image/jpeg");
      const p = await StudioPhoto.create({
        publicId: randomId(18), designId: d._id, kind: "original", storageKey: key, contentType: "image/jpeg",
        bytes: clean.buffer.length, width: meta.width, height: meta.height,
        sha256: crypto.createHash("sha256").update(clean.buffer).digest("hex"),
      });
      // a new photo replaces the old one; the old file is deleted
      if (d.photo) await deletePhoto(d.photo);
      d.photo = p._id;
      d.exampleScene = null; // their own bathroom now, not the example
      d.state = null; // dots and masks belong to the old photo
      await d.save();
      return res.status(201).json({ photo: { url: photoUrl(p.publicId), width: p.width, height: p.height } });
    } catch (e) {
      return err(res, e.statusCode || e.status || 500, e.statusCode || e.status ? e.message : "That photo could not be processed. Please try a different one.");
    }
  });
});

/** The rendered preview of the visitor's design, sent with the request (private). */
router.post("/designs/:id/preview", requirePublic, limit("preview", 60, 60 * 60_000), (req, res) => {
  upload.single("preview")(req, res, async (uploadError) => {
    try {
      if (uploadError) return err(res, 400, "Upload one image.");
      const d = await ownDesign(req, res);
      if (!d) return null;
      if (d.status !== "draft") return err(res, 409, "This design was already sent.");
      if (!req.file) return err(res, 400, "No preview image.");
      const clean = await sanitizeImageBuffer(req.file.buffer);
      const meta = await require("sharp")(clean.buffer).metadata();
      const key = storage.newKey("previews");
      await storage.put(key, clean.buffer, "image/jpeg");
      const p = await StudioPhoto.create({
        publicId: randomId(18), designId: d._id, kind: "preview", storageKey: key, contentType: "image/jpeg",
        bytes: clean.buffer.length, width: meta.width, height: meta.height, sha256: crypto.createHash("sha256").update(clean.buffer).digest("hex"),
      });
      if (d.preview) await deletePhoto(d.preview);
      d.preview = p._id;
      await d.save();
      return res.status(201).json({ ok: true });
    } catch (e) {
      return err(res, e.statusCode || e.status || 500, e.statusCode || e.status ? e.message : "Could not save the preview.");
    }
  });
});

async function deletePhoto(photoId) {
  const p = await StudioPhoto.findById(photoId);
  if (!p || p.deletedAt) return;
  await storage.remove(p.storageKey).catch(() => {});
  p.deletedAt = new Date();
  await p.save();
}

/** The visitor can delete their own (unsent) design and its photo at any time. */
router.delete("/designs/:id", requirePublic, limit("delete", 30, 60 * 60_000), async (req, res) => {
  const d = await ownDesign(req, res);
  if (!d) return null;
  if (d.status !== "draft") return err(res, 409, "This design was already sent to Profixter. Ask us and we will delete it.");
  if (d.photo) await deletePhoto(d.photo);
  await StudioDesign.deleteOne({ _id: d._id });
  return res.json({ ok: true });
});

/** Private photo by signed, expiring link. */
router.get("/photos/:publicId", limit("photoRead", 300, 60_000), async (req, res) => {
  const id = String(req.params.publicId || "");
  if (!verify(id, req.query.exp, req.query.sig)) return err(res, 403, "This link has expired.");
  const p = await StudioPhoto.findOne({ publicId: id, deletedAt: null }).lean();
  if (!p) return err(res, 404, "Not found.");
  try {
    const buf = await storage.get(p.storageKey);
    res.set({ "Content-Type": p.contentType, "Cache-Control": "private, max-age=600", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
    return res.send(buf);
  } catch {
    return err(res, 404, "Not found.");
  }
});

// ---------------------------------------------------------------- price
router.post("/quote", requirePublic, limit("quote", 240, 60_000), json, async (req, res) => {
  try {
    const state = validateState({ marks: dummyMarks, points: dummyPoints, design: req.body?.design }, null);
    const projectType = String(req.body?.projectType || "tub-to-shower");
    await assertPublicProducts(state.design);
    const { result, pricing } = await quoteDesign(state.design, projectType);
    return res.json(publicQuote(result, pricing, { measureSource: PUBLIC_MEASURE(req.body?.measureSource) }));
  } catch (e) {
    return err(res, e.status || 500, e.status ? e.message : "Could not price this design.");
  }
});
/**
 * Visitors may only design with products that are published and shown on the
 * website: an unpublished product's price must never be computable from outside.
 */
async function assertPublicProducts(design) {
  const skus = [design?.baseId, design?.finishId, design?.fixtureId, design?.enclosureId, ...((design?.accessories || []).map((a) => a.productId))].filter((s) => s && s !== "none");
  if (!skus.length) return;
  const StudioProduct = require("../models/studio/StudioProduct");
  const ok = await StudioProduct.countDocuments({ sku: { $in: [...new Set(skus)] }, status: "published", isPublic: true });
  if (ok !== new Set(skus).size) throw Object.assign(new Error("Some of the chosen products are no longer available. Please choose again."), { status: 400 });
}

const dummyMarks = { wallTL: [0, 0], wallTR: [1, 0], wallBL: [0, 1], wallBR: [1, 1] };
const dummyPoints = { valve: [0, 0], head: [0, 0] };

// ---------------------------------------------------------------- submit
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[A-Za-z]{2,}$/;
const PHONE_DIGITS = (s) => String(s || "").replace(/\D/g, "");
const ZIP = /^\d{5}(-\d{4})?$/;
const submitLimitByEmail = (req) => `studio:submit-email:${String(req.body?.email || "").toLowerCase().trim()}`;

router.post(
  "/designs/:id/submit",
  requirePublic,
  limit("submit", 10, 60 * 60_000),
  json,
  rateLimit({ limit: 5, windowMs: DAY, keyResolver: submitLimitByEmail, message: "We already have several requests from this email today. Our team will be in touch." }),
  async (req, res) => {
    try {
      const d = await ownDesign(req, res);
      if (!d) return null;
      if (d.status !== "draft") return res.json({ ok: true, alreadySubmitted: true, submittedAt: d.submittedAt }); // idempotent
      const b = req.body || {};
      // bots: hidden field filled, or submitted within seconds of starting
      if (b.website) return res.json({ ok: true });
      const name = String(b.name || "").trim().slice(0, 160);
      const email = String(b.email || "").trim().toLowerCase();
      const phone = String(b.phone || "").trim().slice(0, 40);
      const zip = String(b.zip || "").trim();
      const address = String(b.address || "").trim().slice(0, 500);
      const errors = [];
      if (name.length < 2) errors.push({ field: "name", message: "Please enter your name." });
      if (!EMAIL.test(email)) errors.push({ field: "email", message: "Please enter a valid email." });
      if (PHONE_DIGITS(phone).length < 10 || PHONE_DIGITS(phone).length > 15) errors.push({ field: "phone", message: "Please enter a phone number we can reach you at." });
      if (!ZIP.test(zip)) errors.push({ field: "zip", message: "Please enter a 5-digit ZIP code." });
      if (b.consent !== true) errors.push({ field: "consent", message: "Please agree to be contacted about this request." });
      // a photo is optional: a design on an example bathroom is a complete request
      if (!d.state || (!d.photo && !isExampleScene(d.exampleScene))) errors.push({ field: "design", message: "Finish your design first." });
      if (errors.length) return err(res, 400, errors[0].message, { errors });
      // a real person takes more than a few seconds from starting a design to sending it
      if (Date.now() - new Date(d.createdAt).getTime() < 8000) return err(res, 400, "Please review your design before sending it.");

      await assertPublicProducts(d.state.design);
      const compat = await checkDesign(d.state.design, d.projectType);
      const block = blockingErrors(compat);
      if (block.length) return err(res, 400, `This combination can't be installed as chosen: ${block[0].message}`, { errors: block });
      const { result } = await quoteDesign(d.state.design, d.projectType);

      d.customer = {
        name, email, phone, address, zip,
        contactPref: ["phone", "text", "email"].includes(b.contactPref) ? b.contactPref : "phone",
        notes: String(b.notes || "").trim().slice(0, 2000),
      };
      d.consentAt = new Date();
      d.selections = result.selections;
      d.priceSnapshot = { at: new Date(), pricingVersion: result.pricingVersion, complete: result.complete, missing: result.missing, lines: result.lines, totalCents: result.totalCents };
      d.status = "submitted";
      d.submittedAt = new Date();
      d.deleteAfter = new Date(Date.now() + SUBMITTED_DAYS * DAY);
      const existing = await User.findOne({ email }).select("_id").lean();
      if (existing) d.customerId = existing._id;

      const typeLabel = { "tub-to-shower": "Tub-to-shower conversion", "shower-replacement": "Shower replacement", "tub-replacement": "Bathtub replacement" }[d.projectType];
      const totalDollars = result.complete ? Math.round(result.totalCents / 100) : undefined;
      const lead = await EstimateLead.create({
        service: "bathroom",
        name, phone, email,
        address: address ? `${address}${zip && !address.includes(zip) ? ` ${zip}` : ""}` : `ZIP ${zip}`,
        contactPref: d.customer.contactPref === "text" ? "text" : d.customer.contactPref,
        sourcePage: "/shower-studio",
        source: "shower_studio",
        notes: [
          `Shower Studio: ${typeLabel}`,
          d.photo ? "Customer photo attached (private, in Admin -> Shower Studio)." : "No photo: designed on the example bathroom.",
          `Size: ${MEASURE_LABEL[d.measureSource] || MEASURE_LABEL.standard}${d.measureSource === "standard" ? "" : ` - ${d.state.design.measure.facingWidth}" × ${d.state.design.measure.sideLength}"`}.`,
          ...result.selections.map((s) => `- ${s.name}${s.quantity > 1 ? ` ×${s.quantity}` : ""}`),
          result.complete ? `Estimated total shown: ${(result.totalCents / 100).toFixed(2)}` : "No total shown (prices incomplete): Price confirmed after review.",
          d.customer.notes ? `Customer notes: ${d.customer.notes}` : "",
        ].filter(Boolean).join("\n"),
        bathroomItems: [d.projectType === "tub-replacement" ? "tub" : "shower"],
        estimateLow: totalDollars,
        estimateHigh: totalDollars,
        studioDesignId: d._id,
      });
      d.leadId = lead._id;
      await d.save();

      notifyStaff(d, lead, typeLabel, result).catch((e) => console.error("studio lead notification failed:", e.message));
      return res.json({ ok: true, submittedAt: d.submittedAt, reference: String(lead._id).slice(-6).toUpperCase() });
    } catch (e) {
      console.error("studio submit failed:", e.message);
      return err(res, e.status || 500, e.status ? e.message : "We could not send your request. Please try again or call us.");
    }
  }
);

async function notifyStaff(d, lead, typeLabel, result) {
  const { sendAdminLeadNotification } = require("../utils/adminLeadNotification");
  return sendAdminLeadNotification({
    service: "bathroom",
    name: d.customer.name,
    email: d.customer.email,
    phone: d.customer.phone,
    address: lead.address,
    contactPref: d.customer.contactPref,
    sourcePage: "/shower-studio",
    notes: `${typeLabel} designed in the Shower Studio.\n${d.photo ? "With the customer's photo." : "On the example bathroom (no photo)."} Size: ${MEASURE_LABEL[d.measureSource] || MEASURE_LABEL.standard}.\n${result.complete ? `Estimated total shown: ${(result.totalCents / 100).toFixed(2)}` : "No estimate shown (prices incomplete)."}\nOpen it in Admin → Shower Studio.`,
    estimateLow: lead.estimateLow,
    estimateHigh: lead.estimateHigh,
  }, { logContext: { source: "shower_studio" } });
}

module.exports = router;
module.exports._deletePhoto = deletePhoto;
void mongoose;
