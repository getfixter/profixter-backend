/**
 * Signature ink measurement.
 *
 * A signature is usually a small stroke floating in a much larger transparent
 * canvas. Scaling the canvas to the signature box shrinks the writing to a
 * smudge; scaling the ink puts it on the rule at a readable size. These tests
 * pin that measurement, and pin the fallback - an unreadable asset must
 * degrade to plain fitting, never throw, because a signature that cannot be
 * measured must still not stop a document being produced.
 *
 *   node scripts/test_png_ink_box.js
 */

const assert = require("assert");
const zlib = require("zlib");
const { pngInkBox, placeInkInBox } = require("../utils/pngInkBox");

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n += 1) {
    c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * Build a real RGBA PNG with an opaque rectangle at a known position, so the
 * expected bounding box is known exactly rather than eyeballed.
 */
function makePng(width, height, ink) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const opaque =
        ink && x >= ink.x && x < ink.x + ink.width && y >= ink.y && y < ink.y + ink.height;
      raw[rowStart + 1 + x * 4 + 3] = opaque ? 255 : 0;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

console.log("\nMeasuring ink");

test("finds a stroke floating in a large transparent canvas", () => {
  const png = makePng(400, 300, { x: 40, y: 120, width: 300, height: 40 });
  assert.deepStrictEqual(pngInkBox(png), {
    x: 40,
    y: 120,
    width: 300,
    height: 40,
    canvasWidth: 400,
    canvasHeight: 300,
  });
});

test("a fully transparent image measures nothing", () =>
  assert.strictEqual(pngInkBox(makePng(50, 50, null)), null));

test("ink touching every edge measures the whole canvas", () => {
  const box = pngInkBox(makePng(20, 10, { x: 0, y: 0, width: 20, height: 10 }));
  assert.strictEqual(box.width, 20);
  assert.strictEqual(box.height, 10);
});

console.log("\nDegrading safely");

test("junk returns null instead of throwing", () => {
  assert.strictEqual(pngInkBox(Buffer.from("not a png at all")), null);
  assert.strictEqual(pngInkBox(Buffer.alloc(0)), null);
  assert.strictEqual(pngInkBox(null), null);
});

test("a truncated PNG returns null instead of throwing", () => {
  const png = makePng(40, 40, { x: 5, y: 5, width: 10, height: 10 });
  assert.strictEqual(pngInkBox(png.subarray(0, 40)), null);
});

test("an RGB PNG with no alpha channel is not guessed at", () => {
  const png = makePng(20, 20, { x: 1, y: 1, width: 5, height: 5 });
  png[25] = 2; // colour type RGB
  assert.strictEqual(pngInkBox(png), null);
});

console.log("\nPlacing ink in a box");

test("the ink fills the box, not the canvas", () => {
  const ink = { x: 65, y: 417, width: 1437, height: 184, canvasWidth: 1536, canvasHeight: 1024 };
  const placed = placeInkInBox(ink, { x: 58, y: 100, width: 200, height: 30 });
  const scale = placed.width / ink.canvasWidth;
  assert.ok(Math.abs(ink.width * scale - 200) < 0.01, "ink spans the full box width");
  assert.ok(ink.height * scale <= 30.01, "ink fits within the box height");
  // The drawn image is far larger than the box; the surround is transparent.
  assert.ok(placed.width > 200);
});

test("the ink lands where the box is, not where the canvas corner is", () => {
  const ink = { x: 65, y: 417, width: 1437, height: 184, canvasWidth: 1536, canvasHeight: 1024 };
  const box = { x: 58, y: 100, width: 200, height: 30 };
  const placed = placeInkInBox(ink, box);
  const scale = placed.width / ink.canvasWidth;
  assert.ok(Math.abs(placed.x + ink.x * scale - box.x) < 0.01, "ink left edge sits at the box");
});

test("a wide box centres a narrow signature rather than stretching it", () => {
  const ink = { x: 0, y: 0, width: 100, height: 100, canvasWidth: 100, canvasHeight: 100 };
  const placed = placeInkInBox(ink, { x: 0, y: 0, width: 200, height: 50 });
  const scale = placed.width / ink.canvasWidth;
  assert.strictEqual(ink.height * scale, 50, "height-constrained");
  assert.strictEqual(placed.x, 75, "centred horizontally in the 200-wide box");
});

test("no ink means no placement, so the caller falls back", () =>
  assert.strictEqual(placeInkInBox(null, { x: 0, y: 0, width: 10, height: 10 }), null));

console.log(`\n${passed} passed, ${failures.length} failed.`);
if (failures.length) process.exit(1);
