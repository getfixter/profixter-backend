/**
 * The Shower Studio catalog's field definitions - ONE place that says what a
 * product of each category must describe. Used to:
 *   1. validate what the owner saves (validateProduct),
 *   2. generate the Admin catalog form (fieldsFor, sent to the browser),
 *   3. turn products into the visualization engine's catalog (toEngineCatalog).
 *
 * Engine ids are SKUs, so designs keep working when a product is edited, and
 * an archived product still resolves for designs that used it.
 */

const TYPES = {
  wall: [
    { id: "pan", label: "Shower wall kit" },
    { id: "tub", label: "Tub wall kit" },
  ],
  base: [
    { id: "pan", label: "Shower pan" },
    { id: "tub", label: "Acrylic tub" },
  ],
  fixture: [
    { id: "shower", label: "Shower-only trim" },
    { id: "tubShower", label: "Tub/shower trim (with spout)" },
  ],
  enclosure: [
    { id: "door", label: "Glass door" },
    { id: "rod", label: "Curtain rod" },
  ],
  accessory: [
    { id: "grabBar", label: "Grab bar" },
    { id: "shelf", label: "Corner shelf" },
    { id: "seat", label: "Fold-down seat" },
  ],
};

const n = (key, label, min, max, opts = {}) => ({ key, label, kind: "number", min, max, unit: opts.unit ?? "in", required: opts.required !== false, help: opts.help || "", step: opts.step ?? 0.125, default: opts.default });
const color = (key, label, opts = {}) => ({ key, label, kind: "color", required: opts.required !== false, help: opts.help || "", default: opts.default });
const choice = (key, label, options, opts = {}) => ({ key, label, kind: "choice", options, required: opts.required !== false, help: opts.help || "", default: opts.default ?? options[0] });
const bool = (key, label, opts = {}) => ({ key, label, kind: "bool", required: false, help: opts.help || "", default: opts.default ?? false });
const text = (key, label, opts = {}) => ({ key, label, kind: "text", required: Boolean(opts.required), max: opts.max ?? 400, help: opts.help || "", default: opts.default ?? "" });
const skus = (key, label, opts = {}) => ({ key, label, kind: "skus", required: false, help: opts.help || "", default: [] });
const kinds = (key, label, opts = {}) => ({ key, label, kind: "kinds", required: opts.required !== false, help: opts.help || "Which base types it can be installed with", default: opts.default ?? ["pan"] });
const drains = (key, label) => ({ key, label, kind: "drains", required: true, help: "Drain positions this base is sold with", default: [{ id: "end", name: "Drain at the valve end", along: 0.12, across: 0.5 }] });

/** Field definitions by category and type. Keys are paths inside `engine`. */
function fieldsFor(category, type) {
  switch (category) {
    case "wall":
      return [
        color("color", "Panel colour", { help: "Approximate colour used to draw the panels", default: "#f3f3ef" }),
        text("material", "Material", { default: "acrylic" }),
        choice("pattern.type", "Surface", ["tile", "smooth", "beadboard"], { default: "tile" }),
        choice("pattern.orientation", "Tile direction", ["horizontal", "vertical"], { required: false, default: "horizontal" }),
        choice("pattern.bond", "Tile layout", ["running", "stack"], { required: false, default: "running" }),
        n("pattern.tileW", "Tile width", 0.5, 48, { required: false, default: 12 }),
        n("pattern.tileH", "Tile height", 0.5, 48, { required: false, default: 4 }),
        n("pattern.groutW", "Grout line width", 0, 1, { required: false, default: 0.125, step: 0.0625 }),
        color("pattern.groutColor", "Grout colour", { required: false }),
        n("pattern.boardW", "Board width (beadboard)", 1, 12, { required: false }),
        n("pattern.grooveW", "Groove width (beadboard)", 0.05, 1, { required: false }),
        n("gloss", "Gloss (0 matte – 1 glossy)", 0, 1, { unit: "", step: 0.05, default: 0.7 }),
        n("kit.height", "Panel height above the base", 30, 100, { default: type === "tub" ? 60 : 76 }),
        n("kit.fitsLengthMin", "Fits alcove length from", 24, 96, { default: 56 }),
        n("kit.fitsLengthMax", "Fits alcove length to", 24, 96, { default: 60 }),
        n("kit.fitsWidthMin", "Fits alcove depth from", 20, 72, { default: 28 }),
        n("kit.fitsWidthMax", "Fits alcove depth to", 20, 72, { default: 32 }),
        skus("kit.requiresBase", "Only with these bases (SKUs)", { help: "Leave empty when any fitting base works" }),
        skus("kit.preferredBase", "Designed around these bases (SKUs)", { help: "Shows a check-the-pairing warning with other bases" }),
        kinds("kit.forKinds", "Kit works over", { required: false, default: [], help: "Leave empty for the product type only; tick both for kits sold for showers and tubs" }),
      ];
    case "base":
      return [
        n("length", "Length (along the opening)", 24, 96, { default: 60 }),
        n("width", "Depth (front to back)", 20, 72, { default: 30 }),
        n("height", "Height", 1, 30, { default: type === "tub" ? 16 : 2.75 }),
        color("color", "Colour", { default: "#f3f3ef" }),
        text("material", "Material", { default: "acrylic" }),
        n("geometry.thresholdW", "Threshold / apron deck width", 0.5, 8, { default: type === "tub" ? 3.5 : 2.5 }),
        bool("thresholdVerified", "Threshold width is from the spec sheet", { help: "Unverified widths only warn about door minimums" }),
        n("geometry.ledgeW", "Ledge width at the walls", 0.25, 8, { default: type === "tub" ? 3.5 : 1.25 }),
        n("geometry.floorDrop", type === "tub" ? "Interior depth (rim to floor)" : "Floor drop", 0.25, 24, { default: type === "tub" ? 13.5 : 1.6 }),
        n("geometry.slope", "Inner wall slope", 0.5, 8, { required: false, default: type === "tub" ? 3.5 : 1.6 }),
        drains("drains", "Drain options"),
      ];
    case "fixture":
      return [
        color("finishColor", "Finish colour", { default: "#e6e8ea" }),
        n("roughness", "Finish roughness (0 polished – 1 matte)", 0, 1, { unit: "", step: 0.05, default: 0.12 }),
        n("geometry.plateR", "Trim plate radius", 1, 6, { default: 3.5 }),
        n("geometry.leverLen", "Lever length", 1, 8, { default: 4.2 }),
        n("geometry.armLen", "Shower arm length", 3, 16, { default: 7 }),
        n("geometry.headDiameter", "Showerhead diameter", 1, 12, { default: 3 }),
        ...(type === "tubShower"
          ? [
              n("geometry.spoutReach", "Tub spout reach", 2, 12, { default: 7 }),
              n("geometry.spoutAboveRim", "Spout height above the tub rim", 1, 12, { default: 4.5 }),
              n("spoutBelowValveMin", "Spout below valve, minimum", 0, 30, { required: false, default: 8 }),
              n("spoutBelowValveMax", "Spout below valve, maximum", 0, 30, { required: false, default: 18 }),
            ]
          : []),
      ];
    case "enclosure":
      return type === "door"
        ? [
            kinds("forKinds", "For"),
            n("openingMin", "Fits openings from", 20, 96, { default: 56 }),
            n("openingMax", "Fits openings to", 20, 96, { default: 60 }),
            n("glassHeight", "Glass height", 40, 96, { default: 72 }),
            n("glassThickness", "Glass thickness", 0.125, 0.75, { default: 0.25, step: 0.0625 }),
            choice("frame", "Frame", ["framed", "semi", "frameless"], { default: "semi" }),
            color("frameColor", "Frame colour", { default: "#e6e8ea" }),
            n("minThreshold", "Minimum threshold width", 0, 6, { default: 1 }),
            n("overlap", "Panel overlap", 0, 8, { required: false, default: 2 }),
          ]
        : [
            kinds("forKinds", "For"),
            n("openingMin", "Fits openings from", 20, 96, { default: 54 }),
            n("openingMax", "Fits openings to", 20, 96, { default: 72 }),
            n("mountHeight", "Mounting height above the floor", 50, 96, { default: 75 }),
            n("diameter", "Rod diameter", 0.5, 2, { default: 1 }),
            n("bow", "Curve (0 = straight)", 0, 12, { default: 6 }),
            color("finishColor", "Finish colour", { default: "#e6e8ea" }),
          ];
    case "accessory":
      if (type === "grabBar")
        return [
          n("length", "Length (centre to centre)", 6, 60, { default: 24 }),
          n("diameter", "Tube diameter", 0.75, 2, { default: 1.25 }),
          n("clearance", "Clearance from the wall", 0.5, 3, { default: 1.5 }),
          n("flange", "Flange diameter", 1, 5, { default: 3.25 }),
          color("finishColor", "Finish colour", { default: "#c9ccce" }),
          n("roughness", "Finish roughness", 0, 1, { unit: "", step: 0.05, default: 0.35 }),
          n("ratedLoad", "Rated load", 0, 2000, { unit: "lb", step: 1, required: false, default: 500 }),
        ];
      if (type === "shelf")
        return [
          n("leg", "Leg length along each wall", 4, 18, { default: 9 }),
          n("thickness", "Thickness", 0.1, 2, { default: 0.4 }),
          bool("metal", "Metal finish", { default: true }),
          color("color", "Colour", { default: "#b8bbbe" }),
        ];
      return [
        n("width", "Seat width", 10, 40, { default: 20 }),
        n("depth", "Seat depth (folded down)", 8, 24, { default: 16 }),
        color("color", "Seat colour", { default: "#a8784c" }),
        color("frameColor", "Frame colour", { default: "#c9ccce" }),
        n("ratedLoad", "Rated load", 0, 2000, { unit: "lb", step: 1, required: false, default: 400 }),
      ];
    default:
      return [];
  }
}

const get = (obj, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
function set(obj, path, v) {
  const ks = path.split(".");
  let o = obj;
  for (const k of ks.slice(0, -1)) o = o[k] && typeof o[k] === "object" ? o[k] : (o[k] = {});
  o[ks[ks.length - 1]] = v;
}

const HEX = /^#[0-9a-f]{6}$/i;
const SKU = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Validate and normalise a product's engine fields. Returns { engine, errors: [{field, message}] }. */
function validateEngine(category, type, input) {
  const errors = [];
  if (!TYPES[category]) return { engine: {}, errors: [{ field: "category", message: "Unknown category." }] };
  if (!TYPES[category].some((t) => t.id === type)) return { engine: {}, errors: [{ field: "type", message: "Choose a product type." }] };
  const engine = {};
  for (const f of fieldsFor(category, type)) {
    let v = get(input || {}, f.key);
    const empty = v === undefined || v === null || v === "" || (f.kind === "kinds" && !f.required && Array.isArray(v) && !v.length);
    if (empty) {
      if (f.required) errors.push({ field: f.key, message: `${f.label} is required.` });
      continue;
    }
    if (f.kind === "number") {
      v = Number(v);
      if (!Number.isFinite(v) || v < f.min || v > f.max) { errors.push({ field: f.key, message: `${f.label} must be between ${f.min} and ${f.max}${f.unit ? " " + f.unit : ""}.` }); continue; }
    } else if (f.kind === "color") {
      v = String(v).trim();
      if (!HEX.test(v)) { errors.push({ field: f.key, message: `${f.label} must be a colour like #f3f3ef.` }); continue; }
    } else if (f.kind === "choice") {
      if (!f.options.includes(v)) { errors.push({ field: f.key, message: `${f.label}: choose one of ${f.options.join(", ")}.` }); continue; }
    } else if (f.kind === "bool") {
      v = v === true || v === "true";
    } else if (f.kind === "text") {
      v = String(v).trim().slice(0, f.max);
    } else if (f.kind === "skus") {
      v = (Array.isArray(v) ? v : String(v).split(/[\s,]+/)).map((x) => String(x).trim()).filter(Boolean);
      if (v.some((x) => !SKU.test(x))) { errors.push({ field: f.key, message: `${f.label}: list SKUs separated by commas.` }); continue; }
    } else if (f.kind === "kinds") {
      v = (Array.isArray(v) ? v : [v]).filter((x) => x === "pan" || x === "tub");
      if (!v.length) { errors.push({ field: f.key, message: `${f.label}: choose shower base, tub or both.` }); continue; }
    } else if (f.kind === "drains") {
      if (!Array.isArray(v) || !v.length || v.length > 6) { errors.push({ field: f.key, message: "Add one to six drain options." }); continue; }
      const out = [];
      for (const d of v) {
        const along = Number(d?.along), across = Number(d?.across);
        const id = String(d?.id || "").trim(), name = String(d?.name || "").trim().slice(0, 120);
        if (!SKU.test(id) || !name || !(along >= 0 && along <= 1) || !(across >= 0 && across <= 1)) { errors.push({ field: f.key, message: "Each drain needs an id, a name, and positions between 0 and 1." }); break; }
        out.push({ id, name, along, across });
      }
      v = out;
    }
    set(engine, f.key, v);
  }
  // cross-field rules
  const pairs = [["kit.fitsLengthMin", "kit.fitsLengthMax"], ["kit.fitsWidthMin", "kit.fitsWidthMax"], ["openingMin", "openingMax"], ["spoutBelowValveMin", "spoutBelowValveMax"]];
  for (const [a, b] of pairs) {
    const lo = get(engine, a), hi = get(engine, b);
    if (Number.isFinite(lo) && Number.isFinite(hi) && lo > hi) errors.push({ field: b, message: "The upper limit must not be below the lower limit." });
  }
  if (category === "wall" && engine.pattern?.type === "tile" && !(engine.pattern.tileW && engine.pattern.tileH)) errors.push({ field: "pattern.tileW", message: "Tile patterns need a tile width and height." });
  return { engine, errors };
}

/** Product-level validation (identity and pricing). */
function validateProduct(body, { creating }) {
  const errors = [];
  const out = {};
  if (creating) {
    const sku = String(body.sku || "").trim();
    if (!SKU.test(sku)) errors.push({ field: "sku", message: "SKU: letters, digits, dot, dash or underscore (up to 64)." });
    out.sku = sku;
    out.category = String(body.category || "");
  }
  for (const [k, max, req] of [["name", 160, true], ["manufacturer", 120], ["model", 120], ["description", 4000], ["colorName", 80]]) {
    if (body[k] === undefined && !creating) continue;
    const v = String(body[k] ?? "").trim();
    if (req && !v) errors.push({ field: k, message: "Name is required." });
    if (v.length > max) errors.push({ field: k, message: `${k} is too long.` });
    out[k] = v;
  }
  if (body.type !== undefined || creating) out.type = String(body.type || "");
  if (body.specs !== undefined) {
    if (!Array.isArray(body.specs) || body.specs.length > 60) errors.push({ field: "specs", message: "Up to 60 specifications." });
    else
      out.specs = body.specs.map((s) => ({
        key: String(s.key || s.label || "").trim().slice(0, 80) || "spec",
        label: String(s.label || s.key || "").trim().slice(0, 120),
        value: String(s.value ?? "").trim().slice(0, 200),
        unit: String(s.unit || "").trim().slice(0, 60),
        status: ["VERIFIED", "ESTIMATE", "APPROXIMATE"].includes(s.status) ? s.status : "ESTIMATE",
        source: /^https?:\/\//.test(String(s.source || "")) ? String(s.source).slice(0, 600) : "",
      }));
  }
  if (body.sources !== undefined) out.sources = (Array.isArray(body.sources) ? body.sources : []).filter((u) => /^https?:\/\//.test(String(u))).slice(0, 20).map((u) => String(u).slice(0, 600));
  for (const k of ["isPublic", "featured"]) if (body[k] !== undefined) out[k] = Boolean(body[k]);
  if (body.sortOrder !== undefined) out.sortOrder = Number.isFinite(Number(body.sortOrder)) ? Math.round(Number(body.sortOrder)) : 0;
  if (body.visualStatus !== undefined) out.visualStatus = body.visualStatus === "verified" ? "verified" : "illustrative";
  if (body.pricing !== undefined) {
    const p = body.pricing || {};
    const cents = (v, label, key) => {
      if (v === null || v === "" || v === undefined) return null;
      const c = Math.round(Number(v));
      if (!Number.isFinite(c) || c < 0 || c > 100_000_00) { errors.push({ field: `pricing.${key}`, message: `${label} must be between $0 and $100,000.` }); return null; }
      return c;
    };
    out.pricing = {
      priceCents: cents(p.priceCents, "Price", "priceCents"),
      costCents: cents(p.costCents, "Material cost", "costCents"),
      installCents: cents(p.installCents, "Installation adder", "installCents") ?? 0,
      internalNote: String(p.internalNote || "").trim().slice(0, 1000),
    };
  }
  if (body.review !== undefined) {
    const r = body.review || {};
    out.review = {};
    for (const k of ["info", "visual"]) if (r[k] !== undefined) out.review[k] = r[k] === true;
  }
  if (body.compatibility !== undefined) {
    const c = body.compatibility || {};
    out.compatibility = { status: c.status === "reviewed" ? "reviewed" : "unverified", note: String(c.note || "").trim().slice(0, 1000) };
  }
  return { value: out, errors };
}

const hexToNum = (h) => (typeof h === "string" && HEX.test(h) ? parseInt(h.slice(1), 16) : h);

/**
 * Products -> the visualization engine's catalog shape.
 * `assetUrl(assetId)` turns an asset id into a URL. Pricing is never included.
 */
function toEngineCatalog(products, { assetUrl = () => null, manufacturerPhotos = false, withSpecs = true } = {}) {
  const cat = { finishes: [], bases: [], fixtures: [], enclosures: [], accessories: [], specs: {} };
  for (const p of products) {
    const e = p.engine || {};
    // Manufacturer photos are previews for staff only (rights unconfirmed); the public catalog never gets them.
    // (Cloudinary-hosted ones are shrunk to a small modern-format thumbnail by the manufacturer's CDN.)
    const extRaw = manufacturerPhotos ? (p.externalMedia || []).find((m) => m.kind === "photo")?.url || null : null;
    const extPhoto = extRaw ? extRaw.replace(/^(https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/)/, "$1c_limit,w_480,f_auto,q_auto/") : null;
    const ownPhoto = p.assets?.photos?.[0]?.assetId ? assetUrl(p.assets.photos[0].assetId) : null;
    const common = {
      id: p.sku, name: p.name, manufacturer: p.manufacturer, model: p.model, specsId: p.sku,
      note: p.description || "", visualStatus: p.visualStatus || "illustrative", status: p.status,
      photo: ownPhoto || extPhoto,
      ...(!ownPhoto && extPhoto ? { photoSource: "manufacturer-preview" } : {}),
      photos: (p.assets?.photos || []).map((x) => ({ url: assetUrl(x.assetId), alt: x.alt || p.name })),
      featured: Boolean(p.featured), sortOrder: p.sortOrder || 0,
      // product family and this variant's size / colour, so pickers show one card per family
      family: familyOf(p), variant: variantOf(p),
    };
    if (withSpecs) cat.specs[p.sku] = {
      name: p.name, manufacturer: p.manufacturer, model: p.model,
      specs: Object.fromEntries((p.specs || []).map((s) => [s.label || s.key, { value: s.value, unit: s.unit, status: s.status, source: s.source }])),
      sources: p.sources || [],
    };
    if (p.category === "wall") {
      const k = e.kit || {};
      const kitKinds = Array.isArray(k.forKinds) && k.forKinds.length ? k.forKinds : [p.type];
      cat.finishes.push({
        ...common, material: e.material || "acrylic", color: e.color, gloss: e.gloss ?? 0.7,
        pattern: e.pattern?.type === "smooth" ? { type: "smooth" } : { ...e.pattern },
        kits: kitKinds.map((kind) => ({
          for: kind, model: p.model, height: k.height,
          fits: { length: [k.fitsLengthMin, k.fitsLengthMax], width: [k.fitsWidthMin, k.fitsWidthMax] },
          ...(k.requiresBase?.length ? { requiresBase: k.requiresBase } : {}),
          ...(k.preferredBase?.length ? { preferredBase: k.preferredBase } : {}),
        })),
        texture: p.assets?.texture?.assetId ? { url: assetUrl(p.assets.texture.assetId), widthIn: p.assets.texture.widthIn || 12, heightIn: p.assets.texture.heightIn || 12 } : null,
      });
    } else if (p.category === "base") {
      cat.bases.push({
        ...common, kind: p.type, material: e.material || "acrylic", color: e.color,
        dims: { length: e.length, width: e.width, height: e.height },
        geometry: { ...(e.geometry || {}) }, drains: e.drains || [], thresholdVerified: Boolean(e.thresholdVerified),
      });
    } else if (p.category === "fixture") {
      const g = e.geometry || {};
      cat.fixtures.push({
        ...common, kind: p.type, finishColor: hexToNum(e.finishColor),
        geometry: {
          plateR: g.plateR, leverLen: g.leverLen, armLen: g.armLen, headDiameter: g.headDiameter, roughness: e.roughness,
          ...(p.type === "tubShower" ? { spout: { reach: g.spoutReach, aboveRim: g.spoutAboveRim } } : {}),
        },
        ...(p.type === "tubShower" && Number.isFinite(e.spoutBelowValveMin) && Number.isFinite(e.spoutBelowValveMax) ? { spoutBelowValve: [e.spoutBelowValveMin, e.spoutBelowValveMax] } : {}),
      });
    } else if (p.category === "enclosure") {
      const base = { ...common, kind: p.type, forKinds: e.forKinds || ["pan"], opening: [e.openingMin, e.openingMax] };
      cat.enclosures.push(p.type === "door"
        ? { ...base, glassHeight: e.glassHeight, glassThickness: e.glassThickness, frame: e.frame, frameColor: hexToNum(e.frameColor), minThreshold: e.minThreshold, overlap: e.overlap ?? 2 }
        : { ...base, mountHeight: e.mountHeight, diameter: e.diameter, bow: e.bow ?? 0, finishColor: hexToNum(e.finishColor) });
    } else if (p.category === "accessory") {
      if (p.type === "grabBar")
        cat.accessories.push({ ...common, type: "grabBar", length: e.length, flange: e.flange, ratedLoad: e.ratedLoad, render: { length: e.length, diameter: e.diameter, clearance: e.clearance, flange: e.flange, finishColor: hexToNum(e.finishColor), roughness: e.roughness } });
      else if (p.type === "shelf")
        cat.accessories.push({ ...common, type: "shelf", leg: e.leg, render: { leg: e.leg, thickness: e.thickness, metal: Boolean(e.metal), color: e.metal ? hexToNum(e.color) : e.color } });
      else
        cat.accessories.push({ ...common, type: "seat", width: e.width, depth: e.depth, ratedLoad: e.ratedLoad, render: { width: e.width, depth: e.depth, color: e.color, frameColor: hexToNum(e.frameColor) } });
    }
  }
  const order = (a, b) => (b.featured - a.featured) || (a.sortOrder - b.sortOrder) || a.name.localeCompare(b.name);
  for (const k of ["finishes", "bases", "fixtures", "enclosures", "accessories"]) cat[k].sort(order);
  return cat;
}

/** What is missing for a product to be shown well (the owner's completeness review). */
function completeness(p) {
  const issues = [];
  const { errors } = validateEngine(p.category, p.type, p.engine);
  if (errors.length) issues.push({ level: "error", message: `Visualization details incomplete: ${errors[0].message}` });
  if (!p.assets?.photos?.length) issues.push({ level: "warn", message: "No product photo." });
  if (p.category === "wall" && !p.assets?.texture?.assetId) issues.push({ level: "info", message: "No texture image: the pattern is drawn from its tile size (illustrative)." });
  if (p.pricing?.priceCents == null) issues.push({ level: "warn", message: "No price: designs using it show no estimate." });
  if (!(p.specs || []).length) issues.push({ level: "info", message: "No specifications listed." });
  if (!(p.specs || []).some((s) => s.status === "VERIFIED")) issues.push({ level: "info", message: "No VERIFIED specification." });
  if (p.source?.manufacturer) {
    for (const why of publishBlockers(p)) issues.push({ level: "warn", message: why });
    if ((p.source.pendingReview || []).length) issues.push({ level: "warn", message: `${p.source.pendingReview.length} manufacturer change(s) to review.` });
    if ((p.externalMedia || []).some((m) => m.kind === "photo") && !p.assets?.photos?.length) issues.push({ level: "info", message: "Manufacturer photos are Admin previews only until image rights are confirmed." });
  }
  return issues;
}

/**
 * Why a manufacturer product cannot be published yet (empty = it can).
 * Owner-made products are not limited by these rules.
 */
function publishBlockers(p) {
  if (!p.source?.manufacturer) return [];
  if (p.source.unitSku) return []; // a unit's integral walls follow the unit
  const out = [];
  if (p.pricing?.priceCents == null) out.push("Set your selling price before publishing.");
  if (!p.assets?.photos?.length) out.push("Add a photo customers may see: upload one you are licensed to use, or copy the manufacturer's once image rights are confirmed.");
  if (p.compatibility?.status !== "reviewed") out.push("Compatibility is unverified: review what it fits and pairs with, then mark it reviewed.");
  if (p.review?.info !== true) out.push("Approve the product information (name, description, specifications).");
  if (p.review?.visual !== true) out.push(`Check the illustrative preview and approve it${p.source.visualIssues?.length ? ` (${p.source.visualIssues.length} point(s) to check)` : ""}.`);
  if (p.source.availability === "discontinued" || p.source.availability === "unlisted") out.push(`The manufacturer lists it as ${p.source.availability}.`);
  return out;
}

/**
 * Where a product stands, for the catalog manager:
 *   published | archived
 *   ready      - a draft with nothing missing: the owner can publish it
 *   review     - priced and photographed; waiting for the owner's checks
 *   incomplete - missing a selling price, a photo, or drawing details
 */
function readiness(p) {
  if (p.status === "archived") return { stage: "archived", blockers: [] };
  const engineErrors = validateEngine(p.category, p.type, p.engine).errors.map((e) => `Visualization details: ${e.message}`);
  const blockers = [...engineErrors, ...publishBlockers(p)];
  if (p.status === "published") return { stage: "published", blockers };
  if (!blockers.length) return { stage: "ready", blockers };
  const basicsMissing = engineErrors.length || (p.source?.manufacturer && !p.source.unitSku && (p.pricing?.priceCents == null || !p.assets?.photos?.length));
  return { stage: basicsMissing ? "incomplete" : "review", blockers };
}

const slugify = (v) => String(v || "").toLowerCase().normalize("NFKD").replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
/** The product family a product belongs to: a manufacturer series, a unit (its walls), or itself. */
function familyOf(p) {
  if (p.source?.unitSku) return { key: `unit:${p.source.unitSku}`, name: p.name };
  if (p.source?.manufacturer && p.source.seriesName) {
    return { key: `${p.source.manufacturer}:${p.category}:${slugify(p.source.seriesName)}`, name: p.source.seriesName.replace(/[®™]/g, "").replace(/\s+/g, " ").trim() };
  }
  return { key: `sku:${p.sku}`, name: p.name };
}
const inch = (v) => (Number.isFinite(v) ? `${Math.round(v * 100) / 100}″` : "");
/** This variant's size and colour within its family. */
function variantOf(p) {
  const e = p.engine || {};
  let size = "";
  if (p.category === "wall") size = [e.kit?.fitsLengthMax, e.kit?.fitsWidthMax, e.kit?.height].every(Number.isFinite) ? `${inch(e.kit.fitsLengthMax)} × ${inch(e.kit.fitsWidthMax)} × ${inch(e.kit.height)}` : "";
  else if (p.category === "base") {
    const d = (e.drains || []).length === 1 && e.drains[0].id !== "center" ? `, ${e.drains[0].name.toLowerCase()}` : "";
    size = Number.isFinite(e.length) ? `${inch(e.length)} × ${inch(e.width)}${d}` : "";
  } else if (p.category === "accessory" && Number.isFinite(e.length)) size = inch(e.length);
  else if (p.category === "accessory" && Number.isFinite(e.width)) size = inch(e.width);
  const model = p.source?.modelNumber || p.model || "";
  return { size, model, color: p.colorName || "", colorHex: typeof e.color === "string" ? e.color : typeof e.finishColor === "string" ? e.finishColor : null };
}

module.exports = { publishBlockers, readiness, familyOf, variantOf, TYPES, fieldsFor, validateEngine, validateProduct, toEngineCatalog, completeness, SKU_PATTERN: SKU };
