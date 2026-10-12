/**
 * Server-side validation of a design's state as sent by the Studio page.
 * Only known fields, finite numbers, bounded sizes; masks must match the
 * photo's pixel count. Anything else is refused - the state is stored and
 * later re-rendered by staff, so it must never carry surprises.
 */

const MAX_STATE_BYTES = 400 * 1024;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isPt = (p, w, h) => Array.isArray(p) && p.length === 2 && isNum(p[0]) && isNum(p[1]) && p[0] > -w && p[0] < 2 * w && p[1] > -h && p[1] < 2 * h;
const SKU = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function fail(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function cleanMask(enc, length) {
  if (enc == null) return null;
  if (typeof enc !== "object" || enc.length !== length || (enc.first !== 0 && enc.first !== 1) || !Array.isArray(enc.runs) || enc.runs.length > 2_000_000) throw fail("Invalid mask.");
  let sum = 0;
  for (const r of enc.runs) {
    if (!Number.isInteger(r) || r < 0) throw fail("Invalid mask.");
    sum += r;
  }
  if (sum !== length) throw fail("Invalid mask.");
  return { length, first: enc.first, runs: enc.runs.slice() };
}

/**
 * @param state  { marks, points, design, masks, autoRemove }
 * @param photo  { width, height } of the stored photo (masks are validated against it)
 */
function validateState(state, photo) {
  if (!state || typeof state !== "object") throw fail("Missing design.");
  if (Buffer.byteLength(JSON.stringify(state)) > MAX_STATE_BYTES) throw fail("Design is too large.");
  const w = photo?.width || 4096, h = photo?.height || 4096;
  const marks = {};
  for (const k of ["wallTL", "wallTR", "wallBL", "wallBR"]) {
    if (!isPt(state.marks?.[k], w, h)) throw fail("The wall corner dots are missing.");
    marks[k] = state.marks[k].map(Number);
  }
  for (const k of ["leftRim", "rightRim", "leftTop", "rightTop"]) {
    const v = state.marks?.[k];
    if (Array.isArray(v) && v.length === 2 && v.every((p) => isPt(p, w, h))) marks[k] = v.map((p) => p.map(Number));
  }
  const points = {};
  for (const k of ["valve", "head"]) {
    if (!isPt(state.points?.[k], w, h)) throw fail("The valve and showerhead dots are missing.");
    points[k] = state.points[k].map(Number);
  }
  const d = state.design || {};
  const m = d.measure || {};
  const num = (v) => (isNum(v) ? v : null);
  const sku = (v, field) => {
    const s = String(v || "");
    if (s && !SKU.test(s)) throw fail(`Invalid ${field}.`);
    return s;
  };
  const accessories = (Array.isArray(d.accessories) ? d.accessories : []).slice(0, 12).map((a, i) => {
    const out = { key: String(a.key || `a${i}`).slice(0, 24), productId: sku(a.productId, "accessory") };
    if (["facing", "left", "right"].includes(a.wall)) out.wall = a.wall;
    if (["left", "right"].includes(a.corner)) out.corner = a.corner;
    out.orientation = a.orientation === "vertical" ? "vertical" : "horizontal";
    if (isNum(a.u)) out.u = a.u;
    if (!isNum(a.y)) throw fail("Accessory height is missing.");
    out.y = a.y;
    return out;
  });
  const design = {
    measure: {
      facingWidth: num(m.facingWidth), sideLength: num(m.sideLength), rimHeight: num(m.rimHeight), markHeight: num(m.markHeight),
      leftWall: Boolean(m.leftWall), rightWall: Boolean(m.rightWall),
      aboveMode: m.aboveMode === "keep" ? "keep" : "paint",
      exposure: isNum(m.exposure) ? Math.min(1.3, Math.max(0.7, m.exposure)) : 1,
    },
    baseId: sku(d.baseId, "base"), drainId: String(d.drainId || "").slice(0, 64), finishId: sku(d.finishId, "finish"),
    fixtureId: sku(d.fixtureId, "fixture"), enclosureId: d.enclosureId === "none" || !d.enclosureId ? "none" : sku(d.enclosureId, "door"),
    curtain: Boolean(d.curtain), accessories,
  };
  const len = w * h;
  const masks = {
    remove: photo ? cleanMask(state.masks?.remove ?? null, len) : null,
    keep: photo ? cleanMask(state.masks?.keep ?? null, len) : null,
  };
  return { marks, points, design, masks, autoRemove: state.autoRemove !== false };
}

/** Engine-shaped design (for compatibility checks and pricing) from a stored state. */
const designOf = (state) => state?.design || null;

module.exports = { validateState, designOf, MAX_STATE_BYTES };
