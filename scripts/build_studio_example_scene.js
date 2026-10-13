/**
 * Draws the Studio's example bathroom: an ORIGINAL illustration (no photo,
 * nothing licensed) of a dated 60" × 30" tub alcove seen straight from the
 * front, so the whole bathtub/shower area is in the picture and the new
 * walls, base, door and extras are all visible.
 *
 * Everything is drawn through one pinhole camera (principal point at the image
 * centre, as the engine assumes), so the calibration marks the engine needs
 * (facing-wall corners at the rim and top-of-tile heights, side-wall lines,
 * valve and showerhead) are exact by construction - printed at the end for
 * FrontEnd/lib/studio/examples.ts.
 *
 *   node scripts/build_studio_example_scene.js
 */
const path = require("path");
const sharp = require("sharp");

const W_IMG = 1080, H_IMG = 1350;
const CX = W_IMG / 2, CY = H_IMG / 2, F = 1380;
const CAM = { x: 30, y: 40, z: 120 }; // inches: centred on the 60" wall, chest height, 10 ft back
const W = 60, D = 30, RIM = 15, TOP = 72, CEIL = 96;
const VALVE = { x: 12, y: 34 }, SPOUT_Y = 20, HEAD = { x: 12, y: 76 };

/** World (x along the facing wall, y up, z out of the wall towards the camera) -> image. */
function P(x, y, z) {
  const zc = CAM.z - z;
  return [CX + (F * (x - CAM.x)) / zc, CY - (F * (y - CAM.y)) / zc];
}
const r1 = (v) => Math.round(v * 10) / 10;
const pts = (list) => list.map((p) => P(...p).map(r1).join(",")).join(" ");
const poly = (list, fill, extra = "") => `<polygon points="${pts(list)}" fill="${fill}" ${extra}/>`;
const line = (a, b, stroke, w = 1.4, extra = "") => { const [x1, y1] = P(...a), [x2, y2] = P(...b); return `<line x1="${r1(x1)}" y1="${r1(y1)}" x2="${r1(x2)}" y2="${r1(y2)}" stroke="${stroke}" stroke-width="${w}" ${extra}/>`; };

const PAINT = "#ece6db", PAINT_SHADE = "#ddd4c6", TILE = "#e7d7b6", GROUT = "#c9b48f", FLOOR = "#d9d3c8", FLOOR_GROUT = "#bdb5a8";
const TUB = "#f4f2ee", TUB_SHADE = "#e3dfd7", TUB_IN = "#ebe7e0";
const svg = [];
svg.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W_IMG}" height="${H_IMG}" viewBox="0 0 ${W_IMG} ${H_IMG}">`);
svg.push(`<defs>
  <linearGradient id="wall" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f3eee6"/><stop offset="1" stop-color="${PAINT}"/></linearGradient>
  <linearGradient id="left" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#d8c7a5"/><stop offset="1" stop-color="${TILE}"/></linearGradient>
  <linearGradient id="right" x1="1" y1="0" x2="0" y2="0"><stop offset="0" stop-color="#d8c7a5"/><stop offset="1" stop-color="${TILE}"/></linearGradient>
  <linearGradient id="apron" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fbfaf7"/><stop offset="1" stop-color="${TUB_SHADE}"/></linearGradient>
  <linearGradient id="basin" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ddd8cf"/><stop offset="1" stop-color="${TUB_IN}"/></linearGradient>
  <radialGradient id="vign" cx="0.5" cy="0.45" r="0.75"><stop offset="0.6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.18"/></radialGradient>
  <linearGradient id="chrome" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f5f6f7"/><stop offset="0.5" stop-color="#a9adb2"/><stop offset="1" stop-color="#e0e3e6"/></linearGradient>
</defs>`);
svg.push(`<rect width="${W_IMG}" height="${H_IMG}" fill="url(#wall)"/>`);

// bathroom floor in front of the alcove, with tiles
svg.push(poly([[-30, 0, 30], [W + 30, 0, 30], [W + 30, 0, 60], [-30, 0, 60]], FLOOR));
for (let x = -24; x <= W + 24; x += 12) svg.push(line([x, 0, 30], [x, 0, 60], FLOOR_GROUT, 1.2));
for (let z = 30; z <= 60; z += 12) svg.push(line([-30, 0, z], [W + 30, 0, z], FLOOR_GROUT, 1.2));

// the bathroom wall around the opening (plane z = 30) and baseboard
svg.push(poly([[-30, 0, 30], [0, 0, 30], [0, 140, 30], [-30, 140, 30]], PAINT));
svg.push(poly([[W, 0, 30], [W + 30, 0, 30], [W + 30, 140, 30], [W, 140, 30]], PAINT));
svg.push(poly([[-30, 0, 30.2], [0, 0, 30.2], [0, 4, 30.2], [-30, 4, 30.2]], "#f6f3ee"));
svg.push(poly([[W, 0, 30.2], [W + 30, 0, 30.2], [W + 30, 4, 30.2], [W, 4, 30.2]], "#f6f3ee"));

// alcove ceiling, back wall, side walls (old tile to 72", paint above)
svg.push(poly([[0, CEIL, 0], [W, CEIL, 0], [W, CEIL, D], [0, CEIL, D]], "#f4f0e9"));
svg.push(poly([[0, TOP, 0], [W, TOP, 0], [W, CEIL, 0], [0, CEIL, 0]], PAINT));
svg.push(poly([[0, TOP, 0], [0, TOP, D], [0, CEIL, D], [0, CEIL, 0]], PAINT_SHADE));
svg.push(poly([[W, TOP, 0], [W, TOP, D], [W, CEIL, D], [W, CEIL, 0]], PAINT_SHADE));
svg.push(poly([[0, 0, 0], [W, 0, 0], [W, TOP, 0], [0, TOP, 0]], TILE));
svg.push(poly([[0, 0, 0], [0, 0, D], [0, TOP, D], [0, TOP, 0]], "url(#left)"));
svg.push(poly([[W, 0, 0], [W, 0, D], [W, TOP, D], [W, TOP, 0]], "url(#right)"));
const T = 4.25;
for (let y = RIM; y <= TOP + 0.01; y += T) {
  svg.push(line([0, y, 0], [W, y, 0], GROUT, 1.6));
  svg.push(line([0, y, 0], [0, y, D], GROUT, 1.6));
  svg.push(line([W, y, 0], [W, y, D], GROUT, 1.6));
}
for (let x = 0; x <= W + 0.01; x += T) svg.push(line([x, RIM, 0], [x, TOP, 0], GROUT, 1.4));
for (let z = 0; z <= D + 0.01; z += T) { svg.push(line([0, RIM, z], [0, TOP, z], GROUT, 1.4)); svg.push(line([W, RIM, z], [W, TOP, z], GROUT, 1.4)); }
svg.push(line([0, TOP, 0], [W, TOP, 0], "#b9a37c", 3));
svg.push(line([0, TOP, 0], [0, TOP, D], "#b9a37c", 3));
svg.push(line([W, TOP, 0], [W, TOP, D], "#b9a37c", 3));
// corner shading
svg.push(line([0, RIM, 0], [0, CEIL, 0], "#00000022", 6));
svg.push(line([W, RIM, 0], [W, CEIL, 0], "#00000022", 6));

// old fixtures on the back wall: chrome valve, spout, showerhead and arm
const [vx, vy] = P(VALVE.x, VALVE.y, 0.3);
svg.push(`<circle cx="${r1(vx)}" cy="${r1(vy)}" r="30" fill="url(#chrome)" stroke="#8d9196" stroke-width="2"/><rect x="${r1(vx - 6)}" y="${r1(vy - 34)}" width="12" height="36" rx="5" fill="url(#chrome)" stroke="#8d9196"/>`);
const [sx, sy] = P(VALVE.x, SPOUT_Y, 0.3);
svg.push(`<rect x="${r1(sx - 9)}" y="${r1(sy - 7)}" width="18" height="34" rx="7" fill="url(#chrome)" stroke="#8d9196"/>`);
const [hx, hy] = P(HEAD.x, HEAD.y, 0.3);
svg.push(`<rect x="${r1(hx - 5)}" y="${r1(hy - 3)}" width="44" height="9" rx="4" fill="url(#chrome)" stroke="#8d9196"/><ellipse cx="${r1(hx + 44)}" cy="${r1(hy + 14)}" rx="20" ry="13" fill="url(#chrome)" stroke="#8d9196" stroke-width="2"/>`);

// the old bathtub: rim, basin, apron
svg.push(poly([[0, RIM, 0], [W, RIM, 0], [W, RIM, D], [0, RIM, D]], TUB));
const inset = [[3.5, RIM, 3], [W - 3.5, RIM, 3], [W - 3.5, RIM, D - 3.5], [3.5, RIM, D - 3.5]];
const floor = [[7, 2, 7], [W - 7, 2, 7], [W - 7, 2, D - 8], [7, 2, D - 8]];
svg.push(poly([inset[0], inset[1], floor[1], floor[0]], "#e6e2da")); // back wall of the basin
svg.push(poly([inset[0], inset[3], floor[3], floor[0]], "#ddd8ce")); // left end
svg.push(poly([inset[1], inset[2], floor[2], floor[1]], "#ddd8ce")); // right end
svg.push(poly(floor, "url(#basin)"));
svg.push(poly([inset[3], inset[2], floor[2], floor[3]], "#f0ede7")); // front inner wall (mostly hidden)
const [dx, dy] = P(10, 2, 15);
svg.push(`<ellipse cx="${r1(dx)}" cy="${r1(dy)}" rx="13" ry="5" fill="#9fa3a8"/>`);
svg.push(poly([[0, 0, D], [W, 0, D], [W, RIM, D], [0, RIM, D]], "url(#apron)"));
svg.push(line([0, RIM, D], [W, RIM, D], "#ffffff", 3));
svg.push(line([0, 0.3, D + 0.3], [W, 0.3, D + 0.3], "#00000030", 5));

svg.push(`<rect width="${W_IMG}" height="${H_IMG}" fill="url(#vign)"/>`);
svg.push("</svg>");

(async () => {
  const out = path.join(__dirname, "..", "..", "FrontEnd", "public", "studio", "example-alcove.jpg");
  await sharp(Buffer.from(svg.join("\n"))).jpeg({ quality: 88, mozjpeg: true }).toFile(out);
  const at = (x, y, z) => P(x, y, z).map((v) => Math.round(v));
  const marks = {
    wallTL: at(0, TOP, 0), wallTR: at(W, TOP, 0), wallBL: at(0, RIM, 0), wallBR: at(W, RIM, 0),
    leftRim: [at(0, RIM, 6), at(0, RIM, 26)], rightRim: [at(W, RIM, 6), at(W, RIM, 26)],
    leftTop: [at(0, TOP, 6), at(0, TOP, 26)], rightTop: [at(W, TOP, 6), at(W, TOP, 26)],
  };
  const scene = {
    id: "example-alcove-1", width: W_IMG, height: H_IMG, marks,
    points: { valve: at(VALVE.x, VALVE.y, 0), head: at(HEAD.x, HEAD.y, 0) },
    measure: { facingWidth: W, sideLength: D, rimHeight: RIM, markHeight: TOP, leftWall: true, rightWall: true },
  };
  console.log(out);
  console.log(JSON.stringify(scene));
})();
