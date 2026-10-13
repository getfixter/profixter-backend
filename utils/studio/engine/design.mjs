// A saved design: everything needed to reproduce a preview exactly - the
// working photo, the dots, measurements, product choices and the edit masks.
// Pure functions (no DOM) so they are unit-tested in Node.

export const DESIGN_VERSION = 2;
const MAX_PHOTO_CHARS = 12 * 1024 * 1024;

/** Run-length encode a 0/1 mask: [first value, run, run, ...]. */
export function encodeMask(mask) {
  if (!mask) return null;
  const runs = [];
  let cur = mask[0] ? 1 : 0, n = 0, any = false;
  for (let i = 0; i < mask.length; i++) {
    const v = mask[i] ? 1 : 0;
    if (v) any = true;
    if (v === cur) n++;
    else { runs.push(n); cur = v; n = 1; }
  }
  runs.push(n);
  return any ? { length: mask.length, first: mask[0] ? 1 : 0, runs } : null;
}

export function decodeMask(enc, length) {
  const out = new Uint8Array(length);
  if (!enc) return out;
  if (enc.length !== length) throw new Error("Mask size does not match the photo.");
  let v = enc.first, i = 0;
  for (const r of enc.runs) {
    if (!Number.isInteger(r) || r < 0 || i + r > length) throw new Error("Corrupt mask.");
    if (v) out.fill(1, i, i + r);
    i += r; v = 1 - v;
  }
  if (i !== length) throw new Error("Corrupt mask.");
  return out;
}

const isPt = (p) => Array.isArray(p) && p.length === 2 && p.every((v) => typeof v === "number" && Number.isFinite(v));
const MARK_KEYS = ["wallTL", "wallTR", "wallBL", "wallBR"];
const LINE_KEYS = ["leftRim", "rightRim", "leftTop", "rightTop"];

/**
 * Validate and normalise a parsed design. Throws an Error with a plain message
 * when the file cannot be used. Unknown product ids are kept (autoFix replaces them).
 */
export function parseDesign(obj) {
  if (!obj || typeof obj !== "object") throw new Error("This is not a Shower Studio design file.");
  if (obj.app !== "shower-studio") throw new Error("This is not a Shower Studio design file.");
  if (!Number.isInteger(obj.version) || obj.version > DESIGN_VERSION) throw new Error(`This design was saved by a newer version (v${obj.version}).`);
  const ph = obj.photo || {};
  if (typeof ph.dataUrl !== "string" || !/^data:image\/(jpeg|png|webp);base64,/.test(ph.dataUrl)) throw new Error("The design has no photo.");
  if (ph.dataUrl.length > MAX_PHOTO_CHARS) throw new Error("The photo in this design is too large.");
  if (!Number.isInteger(ph.width) || !Number.isInteger(ph.height) || ph.width < 16 || ph.height < 16 || ph.width > 4096 || ph.height > 4096) throw new Error("The photo size in this design is invalid.");
  const marks = {};
  for (const k of MARK_KEYS) {
    if (!isPt(obj.marks?.[k])) throw new Error(`The design is missing the ${k} dot.`);
    marks[k] = obj.marks[k];
  }
  for (const k of LINE_KEYS) if (Array.isArray(obj.marks?.[k]) && obj.marks[k].length === 2 && obj.marks[k].every(isPt)) marks[k] = obj.marks[k];
  const points = {};
  for (const k of ["valve", "head"]) {
    if (!isPt(obj.points?.[k])) throw new Error(`The design is missing the ${k} dot.`);
    points[k] = obj.points[k];
  }
  const m = obj.design?.measure;
  if (!m || typeof m !== "object") throw new Error("The design has no measurements.");
  const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
  const design = {
    measure: {
      facingWidth: n(m.facingWidth), sideLength: n(m.sideLength), rimHeight: n(m.rimHeight), markHeight: n(m.markHeight),
      leftWall: Boolean(m.leftWall), rightWall: Boolean(m.rightWall),
      aboveMode: m.aboveMode === "keep" ? "keep" : "paint", exposure: Number.isFinite(m.exposure) ? Math.min(1.3, Math.max(0.7, m.exposure)) : 1,
    },
    baseId: String(obj.design.baseId || ""), drainId: String(obj.design.drainId || ""), finishId: String(obj.design.finishId || ""),
    fixtureId: String(obj.design.fixtureId || ""), enclosureId: String(obj.design.enclosureId || "none"), curtain: Boolean(obj.design.curtain),
    plumbing: ["facing", "left", "right"].includes(obj.design.plumbing?.wall) ? { wall: obj.design.plumbing.wall, ...(Number.isFinite(obj.design.plumbing.u) ? { u: obj.design.plumbing.u } : {}) } : null,
    accessories: (Array.isArray(obj.design.accessories) ? obj.design.accessories : []).slice(0, 12).map((a, i) => ({
      key: String(a.key || `a${i}`), productId: String(a.productId || ""),
      wall: ["facing", "left", "right"].includes(a.wall) ? a.wall : undefined,
      corner: ["left", "right"].includes(a.corner) ? a.corner : undefined,
      orientation: a.orientation === "vertical" ? "vertical" : "horizontal",
      u: n(a.u), y: n(a.y),
    })).map((a) => Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined))).filter((a) => Number.isFinite(a.y)),
  };
  const len = ph.width * ph.height;
  const masks = { remove: decodeMask(obj.masks?.remove || null, len), keep: decodeMask(obj.masks?.keep || null, len) };
  return {
    id: typeof obj.id === "string" ? obj.id : null,
    name: String(obj.name || "Untitled design").slice(0, 80),
    savedAt: typeof obj.savedAt === "string" ? obj.savedAt : null,
    photo: { dataUrl: ph.dataUrl, width: ph.width, height: ph.height, credit: typeof ph.credit === "string" ? ph.credit.slice(0, 600) : "" },
    marks, points, design, masks,
    autoRemove: obj.autoRemove !== false,
  };
}

export function serializeDesign({ id, name, photo, marks, points, design, masks, autoRemove, savedAt = new Date().toISOString() }) {
  return {
    app: "shower-studio", version: DESIGN_VERSION, id, name, savedAt,
    photo, marks, points, design,
    masks: { remove: encodeMask(masks.remove), keep: encodeMask(masks.keep) },
    autoRemove: autoRemove !== false,
  };
}
