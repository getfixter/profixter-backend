// Compatibility rules for a design. The product pickers only offer compatible
// choices; check() is the gate (and what the tests exercise); autoFix() keeps a
// design valid when one choice changes another's options, and says what changed.
//
// Design shape (also what is saved):
//   measure: { facingWidth, sideLength, rimHeight, markHeight, leftWall, rightWall }
//   baseId, drainId, finishId, fixtureId, enclosureId ("none" or id), curtain (bool)
//   accessories: [{ key, productId, wall | corner, u, y, orientation }]

export const LIMITS = {
  facingWidth: [24, 72],
  sideLength: [24, 84],
  rimHeight: [6, 26],
  markHeight: [30, 120],
  fitTolerance: 0.75, // a base may be up to 3/4" off the alcove size (shimmed / trimmed by the installer)
};

/** Which side of the alcove is open (where the threshold, apron and door go). */
export function openSide(m) {
  if (!m.rightWall) return "right";
  if (!m.leftWall) return "left";
  return "front";
}

/** Alcove size as the base sees it: length along the threshold, width front to back. */
export function alcoveFootprint(m) {
  const side = openSide(m);
  return side === "front"
    ? { length: m.facingWidth, width: m.sideLength, opening: m.facingWidth, side }
    : { length: m.sideLength, width: m.facingWidth, opening: m.sideLength, side };
}

/**
 * Which hand the plumbing is on, as seen standing in front of the opening:
 * "left" | "right", or null when it cannot be said (plumbing on the back wall
 * of a front-open alcove, or no plumbing wall chosen).
 */
export function plumbingHand(design) {
  const p = design?.plumbing, m = design?.measure;
  if (!p?.wall || !m) return null;
  const open = openSide(m);
  if (open === "front") return p.wall === "left" || p.wall === "right" ? p.wall : null;
  // an alcove open on one side: the facing wall is the end of the tub
  if (p.wall === "facing") return open === "right" ? "right" : "left";
  return null;
}

/** The same base with the drain on the other end (a sibling in the catalog), if there is one. */
export function handedSibling(base, hand, catalog) {
  if (!base || !hand) return null;
  const fam = (b) => b.family?.key || String(b.name || "").replace(/\b(left|right)[- ]hand\b|\b(left|right)\b|\bL\/R\b/gi, "").replace(/\s+/g, " ").trim();
  const same = (b) => b.kind === base.kind && b.dims.length === base.dims.length && b.dims.width === base.dims.width && fam(b) === fam(base) && (b.drains || []).some((d) => d.id === hand);
  const list = (catalog.bases || []).filter(same);
  return list.find((b) => (b.variant?.color || b.color) === (base.variant?.color || base.color)) || list[0] || null;
}

export function wallLength(wall, m) {
  return wall === "facing" ? m.facingWidth : m.sideLength;
}
export function wallExists(wall, m) {
  return wall === "facing" || (wall === "left" ? m.leftWall : m.rightWall);
}

const num = (v) => typeof v === "number" && Number.isFinite(v);

export function checkMeasurements(m) {
  const errors = [];
  for (const k of ["facingWidth", "sideLength", "rimHeight"]) {
    const [lo, hi] = LIMITS[k];
    if (!num(m[k])) errors.push({ field: k, code: "missing", message: `${label(k)} is missing.` });
    else if (m[k] < lo || m[k] > hi) errors.push({ field: k, code: "range", message: `${label(k)} of ${m[k]}" is outside ${lo}–${hi}". Please re-measure.` });
  }
  if (num(m.markHeight)) {
    const [lo, hi] = LIMITS.markHeight;
    if (m.markHeight < lo || m.markHeight > hi) errors.push({ field: "markHeight", code: "range", message: `Upper dot height of ${m.markHeight}" is outside ${lo}–${hi}".` });
    else if (num(m.rimHeight) && m.markHeight < m.rimHeight + 12) errors.push({ field: "markHeight", code: "order", message: "The upper dots must be at least 12\" above the tub rim." });
  }
  if (!m.leftWall && !m.rightWall) errors.push({ field: "leftWall", code: "walls", message: "An alcove needs at least one side wall. Tick the wall(s) in the photo." });
  return errors;
}

function label(k) {
  return { facingWidth: "Facing wall width", sideLength: "Side wall length", rimHeight: "Tub rim height", markHeight: "Upper dot height" }[k] || k;
}

const byId = (list, id) => (list || []).find((x) => x.id === id) || null;

export function kitFor(finish, base) {
  return (finish?.kits || []).find((k) => k.for === base?.kind) || null;
}

/** A wall kit that exists for this base kind, fits the alcove, and pairs with the base. */
export function kitUsable(kit, base, m) {
  if (!kit) return false;
  if (kit.requiresBase && !kit.requiresBase.includes(base.id)) return false;
  if (!kit.fits) return true;
  const fp = alcoveFootprint(m), e = 0.01;
  return fp.length >= kit.fits.length[0] - e && fp.length <= kit.fits.length[1] + e && fp.width >= kit.fits.width[0] - e && fp.width <= kit.fits.width[1] + e;
}

/** Does this base fit the alcove? (length along the opening, width front to back) */
export function baseFits(base, m) {
  const fp = alcoveFootprint(m);
  const t = LIMITS.fitTolerance;
  return Math.abs(base.dims.length - fp.length) <= t && Math.abs(base.dims.width - fp.width) <= t;
}

export function enclosureFits(enc, base, m) {
  if (!enc) return true;
  const fp = alcoveFootprint(m);
  if (enc.forKinds && !enc.forKinds.includes(base.kind)) return false;
  const [lo, hi] = enc.opening;
  return fp.opening >= lo && fp.opening <= hi;
}

/** Full check of a design against the catalog. */
export function check(design, catalog) {
  const errors = [], warnings = [], notes = [];
  const m = design.measure;
  errors.push(...checkMeasurements(m));
  const base = byId(catalog.bases, design.baseId);
  const finish = byId(catalog.finishes, design.finishId);
  const fixture = byId(catalog.fixtures, design.fixtureId);
  const enc = design.enclosureId && design.enclosureId !== "none" ? byId(catalog.enclosures, design.enclosureId) : null;
  if (!base) errors.push({ field: "baseId", code: "missing_product", message: "Choose a shower base or tub." });
  if (!finish) errors.push({ field: "finishId", code: "missing_product", message: "Choose a wall finish." });
  if (!fixture) errors.push({ field: "fixtureId", code: "missing_product", message: "Choose a fixture." });
  if (design.enclosureId && design.enclosureId !== "none" && !enc) errors.push({ field: "enclosureId", code: "missing_product", message: "That door or rod is no longer in the catalog." });
  if (errors.length) return { ok: false, errors, warnings, notes };

  const fp = alcoveFootprint(m);
  if (!baseFits(base, m)) {
    errors.push({ field: "baseId", code: "base_size", message: `${base.name} is ${base.dims.length}×${base.dims.width}"; the alcove measures ${fp.length}×${fp.width}". Choose a base that fits, or re-measure.` });
  }
  if (base.drains && !base.drains.some((d) => d.id === design.drainId)) {
    errors.push({ field: "drainId", code: "drain", message: `${base.name} does not come with that drain position.` });
  }
  const hand = plumbingHand(design);
  if (hand && ["left", "right"].includes(design.drainId) && design.drainId !== hand) {
    warnings.push({ field: "drainId", code: "drain_hand", message: `The plumbing is on the ${hand}, but this ${base.kind === "tub" ? "tub" : "base"} drains on the ${design.drainId}. Choose the ${hand}-hand version or move the plumbing.` });
  }
  const kit = kitFor(finish, base);
  if (!kit) {
    errors.push({ field: "finishId", code: "kit_kind", message: `${finish.name} has no ${base.kind === "tub" ? "tub" : "shower"} wall kit in the catalog.` });
  } else {
    if (kit.requiresBase && !kit.requiresBase.includes(base.id)) {
      const names = kit.requiresBase.map((id) => byId(catalog.bases, id)?.name || id).join(" or ");
      errors.push({ field: "finishId", code: "kit_base", message: `${finish.name} is made only for ${names}.` });
    }
    if (kit.preferredBase && !kit.preferredBase.includes(base.id)) {
      warnings.push({ field: "finishId", code: "kit_base_pref", message: `${finish.name} is designed around ${kit.preferredBase.map((id) => byId(catalog.bases, id)?.name || id).join(" / ")}; check the pairing with the manufacturer.` });
    }
    if (kit.fits && (fp.length > kit.fits.length[1] + 0.01 || fp.length < kit.fits.length[0] - 0.01 || fp.width > kit.fits.width[1] + 0.01 || fp.width < kit.fits.width[0] - 0.01)) {
      errors.push({ field: "finishId", code: "kit_size", message: `The ${finish.name} ${base.kind} kit (${kit.model}) covers ${kit.fits.length.join("–")}" × ${kit.fits.width.join("–")}" alcoves; this one is ${fp.length}×${fp.width}".` });
    }
  }
  if (base.kind === "tub" && fixture.kind !== "tubShower") {
    errors.push({ field: "fixtureId", code: "fixture_kind", message: "A tub needs a tub/shower trim with a spout." });
  }
  if (base.kind === "pan" && fixture.kind === "tubShower") {
    errors.push({ field: "fixtureId", code: "fixture_kind", message: "A shower base takes a shower-only trim (no tub spout)." });
  }
  if (enc && !enclosureFits(enc, base, m)) {
    const why = enc.forKinds && !enc.forKinds.includes(base.kind)
      ? `${enc.name} is made for ${enc.forKinds.join(" / ")} installations, not a ${base.kind === "tub" ? "tub" : "shower base"}.`
      : `${enc.name} fits openings of ${enc.opening[0]}–${enc.opening[1]}"; this opening is ${fp.opening}".`;
    errors.push({ field: "enclosureId", code: "enclosure_fit", message: why });
  }
  if (enc && enc.kind === "door" && enc.minThreshold && base.geometry?.thresholdW != null && base.geometry.thresholdW < enc.minThreshold) {
    const msg = `${enc.name} needs a threshold at least ${enc.minThreshold}" wide; ${base.name}'s is ${base.geometry.thresholdW}"`;
    if (base.thresholdVerified) errors.push({ field: "enclosureId", code: "threshold", message: msg + "." });
    else warnings.push({ field: "enclosureId", code: "threshold", message: msg + " (an ESTIMATE - the manufacturer does not publish it). Confirm before ordering." });
  }
  const valve = !design.valveWall ? null : Array.isArray(design.valveWall) ? { wall: "facing", u: design.valveWall[0], y: design.valveWall[1] } : design.valveWall;
  if (fixture.spoutBelowValve && valve && fixture.geometry?.spout) {
    const spoutY = base.dims.height + fixture.geometry.spout.aboveRim;
    const drop = valve.y - spoutY;
    const [lo, hi] = fixture.spoutBelowValve;
    if (drop < lo || drop > hi) warnings.push({ field: "fixtureId", code: "spout_drop", message: `The tub spout would sit ${drop.toFixed(1)}" below the valve; ${fixture.name} allows ${lo}–${hi}". Move the valve dot or plan a valve relocation.` });
  }
  if (enc && kit && enc.kind === "door" && base.dims.height + enc.glassHeight > base.dims.height + kit.height + 2) {
    warnings.push({ field: "enclosureId", code: "door_taller", message: `The door glass (${enc.glassHeight}") stands taller than the ${kit.height}" wall panels.` });
  }
  if (design.curtain && (!enc || enc.kind !== "rod")) {
    warnings.push({ field: "curtain", code: "curtain_rod", message: "A curtain needs a rod; the curtain is not shown." });
  }

  // accessories
  const wallTop = kit ? base.dims.height + kit.height : base.dims.height + 60;
  if (enc && enc.kind === "rod" && enc.mountHeight > wallTop + 2) warnings.push({ field: "enclosureId", code: "rod_height", message: `The rod at ${enc.mountHeight}" mounts above the ${kit?.height}" panels - its flanges go into the painted wall.` });
  const floor = base.kind === "tub" ? base.dims.height - (base.geometry?.floorDrop ?? 13) : base.dims.height - (base.geometry?.floorDrop ?? 1.6);
  const placed = [];
  for (const a of design.accessories || []) {
    const p = byId(catalog.accessories, a.productId);
    if (!p) { errors.push({ field: `accessory:${a.key}`, code: "missing_product", message: "An accessory is no longer in the catalog." }); continue; }
    if (p.type === "shelf") {
      const need = a.corner === "right" ? ["facing", "right"] : ["facing", "left"];
      if (!need.every((w) => wallExists(w, m))) errors.push({ field: `accessory:${a.key}`, code: "corner", message: `${p.name}: there is no ${a.corner} corner in this alcove.` });
      if (a.y < base.dims.height + 8 || a.y > wallTop - 4) errors.push({ field: `accessory:${a.key}`, code: "height", message: `${p.name}: place it between ${base.dims.height + 8}" and ${wallTop - 4}" from the floor.` });
      placed.push({ key: a.key, wall: "facing", u0: a.corner === "right" ? m.facingWidth - p.leg : 0, u1: a.corner === "right" ? m.facingWidth : p.leg, y0: a.y - 1, y1: a.y + 1, name: p.name });
      continue;
    }
    if (!wallExists(a.wall, m)) { errors.push({ field: `accessory:${a.key}`, code: "wall", message: `${p.name}: there is no ${a.wall} wall.` }); continue; }
    const wl = wallLength(a.wall, m);
    if (p.type === "seat" && base.kind !== "pan") {
      errors.push({ field: `accessory:${a.key}`, code: "seat_tub", message: `${p.name} is for showers; it cannot go over a tub.` });
      continue;
    }
    const half = (p.type === "grabBar" && a.orientation !== "vertical" ? p.length : p.type === "seat" ? p.width : p.flange ?? 3) / 2;
    const vhalf = p.type === "grabBar" && a.orientation === "vertical" ? p.length / 2 : p.type === "seat" ? 6 : (p.flange ?? 3) / 2;
    if (a.u - half < 1 || a.u + half > wl - 1) errors.push({ field: `accessory:${a.key}`, code: "bounds", message: `${p.name} runs past the end of the ${a.wall} wall (${wl}").` });
    if (a.y - vhalf < base.dims.height + 1 || a.y + vhalf > wallTop) errors.push({ field: `accessory:${a.key}`, code: "bounds", message: `${p.name} must sit on the new wall panels (${base.dims.height}"–${wallTop}").` });
    if (p.type === "grabBar") {
      const above = a.y - floor;
      if (a.orientation !== "vertical" && (above < 33 || above > 36)) warnings.push({ field: `accessory:${a.key}`, code: "ada_height", message: `${p.name} is ${above.toFixed(1)}" above the shower floor; ADA guidance for horizontal bars is 33–36".` });
      notes.push(`${p.name}: must be anchored into blocking or with approved wall anchors through the panels.`);
    }
    if (p.type === "seat") {
      const above = a.y - floor;
      if (above < 17 || above > 19) warnings.push({ field: `accessory:${a.key}`, code: "ada_height", message: `${p.name} seat is ${above.toFixed(1)}" above the shower floor; ADA guidance is 17–19".` });
      if (p.depth > fp.width - 12) warnings.push({ field: `accessory:${a.key}`, code: "seat_depth", message: `${p.name} leaves less than 12" of standing room when down.` });
      notes.push(`${p.name}: needs solid backing in the wall; check the rated load (${p.ratedLoad ?? "see spec"} lb).`);
    }
    if (valve && a.wall === valve.wall) {
      const r = (catalog.fixtures.find((f) => f.id === design.fixtureId)?.geometry?.plateR ?? 3.5) + 1;
      const nearest = [Math.max(a.u - half, Math.min(valve.u, a.u + half)), Math.max(a.y - vhalf, Math.min(valve.y, a.y + vhalf))];
      if (Math.hypot(nearest[0] - valve.u, nearest[1] - valve.y) < r) errors.push({ field: `accessory:${a.key}`, code: "valve", message: `${p.name} overlaps the faucet.` });
    }
    placed.push({ key: a.key, wall: a.wall, u0: a.u - half, u1: a.u + half, y0: a.y - vhalf, y1: a.y + vhalf, name: p.name });
  }
  for (let i = 0; i < placed.length; i++)
    for (let j = i + 1; j < placed.length; j++) {
      const A = placed[i], B = placed[j];
      if (A.wall !== B.wall) continue;
      if (A.u0 < B.u1 && B.u0 < A.u1 && A.y0 < B.y1 && B.y0 < A.y1) errors.push({ field: `accessory:${B.key}`, code: "overlap", message: `${B.name} overlaps ${A.name}.` });
    }
  return { ok: errors.length === 0, errors, warnings, notes: [...new Set(notes)] };
}

/** Options the pickers should offer for the current design. */
export function options(design, catalog) {
  const m = design.measure;
  const base = byId(catalog.bases, design.baseId);
  return {
    bases: catalog.bases.filter((b) => baseFits(b, m)),
    finishes: catalog.finishes.filter((f) => base && kitUsable(kitFor(f, base), base, m)),
    fixtures: catalog.fixtures.filter((f) => base && (base.kind === "tub" ? f.kind === "tubShower" : f.kind !== "tubShower")),
    enclosures: catalog.enclosures.filter((e) => base && enclosureFits(e, base, m)),
    accessories: catalog.accessories.filter((a) => a.type !== "seat" || base?.kind === "pan"),
  };
}

/**
 * Keep a design valid after a change: swap in compatible choices and drop
 * accessories that no longer fit. Returns { design, changes: [human-readable] }.
 */
export function autoFix(design, catalog) {
  const d = structuredClone(design);
  const changes = [];
  const opts = () => options(d, catalog);
  let base = byId(catalog.bases, d.baseId);
  if (!base || !baseFits(base, d.measure)) {
    const fit = opts().bases.find((b) => !base || b.kind === base.kind) || opts().bases[0];
    if (fit && fit.id !== d.baseId) { changes.push(`Base changed to ${fit.name} to fit the ${alcoveFootprint(d.measure).length}×${alcoveFootprint(d.measure).width}" alcove.`); d.baseId = fit.id; base = fit; }
  }
  if (!base) return { design: d, changes };
  const hand = plumbingHand(d);
  if (hand && base.drains && !base.drains.some((x) => x.id === hand)) {
    const sib = handedSibling(base, hand, catalog);
    if (sib && baseFits(sib, d.measure)) { d.baseId = sib.id; base = sib; changes.push(`Switched to the ${hand}-hand drain version to match the plumbing.`); }
  }
  if (hand && base.drains?.some((x) => x.id === hand)) d.drainId = hand;
  if (base.drains && !base.drains.some((x) => x.id === d.drainId)) { d.drainId = base.drains[0].id; }
  const o = opts();
  if (!o.finishes.some((f) => f.id === d.finishId) && o.finishes[0]) {
    changes.push(`Wall finish changed to ${o.finishes[0].name}: the previous finish has no ${base.kind === "tub" ? "tub" : "shower"} kit.`);
    d.finishId = o.finishes[0].id;
  }
  if (!o.fixtures.some((f) => f.id === d.fixtureId) && o.fixtures[0]) {
    changes.push(`Fixture changed to ${o.fixtures[0].name} to suit the ${base.kind === "tub" ? "tub" : "shower base"}.`);
    d.fixtureId = o.fixtures[0].id;
  }
  if (d.enclosureId && d.enclosureId !== "none" && !o.enclosures.some((e) => e.id === d.enclosureId)) {
    const old = byId(catalog.enclosures, d.enclosureId);
    const same = o.enclosures.find((e) => e.kind === old?.kind);
    changes.push(same ? `${old?.name || "Door"} swapped for ${same.name}, which fits this opening.` : `${old?.name || "Door"} removed: it does not fit this opening.`);
    d.enclosureId = same ? same.id : "none";
  }
  const before = d.accessories?.length || 0;
  d.accessories = (d.accessories || []).filter((a) => {
    const p = byId(catalog.accessories, a.productId);
    if (!p) return false;
    if (p.type === "seat" && base.kind !== "pan") { changes.push(`${p.name} removed: seats are for showers, not tubs.`); return false; }
    if (p.type === "shelf") return (a.corner === "right" ? d.measure.rightWall : d.measure.leftWall);
    if (!wallExists(a.wall, d.measure)) { changes.push(`${p.name} removed: there is no ${a.wall} wall.`); return false; }
    return true;
  });
  if (d.accessories.length < before && !changes.length) changes.push("An accessory was removed because its wall is gone.");
  return { design: d, changes };
}
