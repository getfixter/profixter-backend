/**
 * Where the ink actually is inside a signature PNG.
 *
 * A signature exported from a drawing app, or captured from a signature pad,
 * is usually a small stroke floating in a much larger transparent canvas. Fit
 * that whole canvas into a signature box and the visible ink shrinks to a
 * smudge - the canvas is what gets scaled, not the writing.
 *
 * This finds the bounding box of the non-transparent pixels so the renderer
 * can scale and position the IMAGE such that the INK lands on the signature
 * rule at a readable size. The file itself is never touched: this is geometry,
 * not editing. A signature asset is a legal artifact and is stored exactly as
 * supplied.
 *
 * Returns null rather than throwing for anything it cannot read, so an
 * unusual PNG degrades to the plain fit-the-whole-canvas behaviour instead of
 * stopping a document being produced.
 */

const zlib = require("zlib");

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Alpha-bearing colour types: 4 = grey+alpha, 6 = RGBA. */
const CHANNELS = { 4: 2, 6: 4 };

/** Paeth predictor, per the PNG specification. */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function readHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33) return null;
  if (!buffer.subarray(0, 8).equals(PNG_MAGIC)) return null;
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colorType: buffer[25],
    interlaced: buffer[28] === 1,
  };
}

/** Concatenated IDAT payloads, in file order. */
function readPixelData(buffer) {
  const parts = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    if (type === "IDAT") parts.push(buffer.subarray(offset + 8, offset + 8 + length));
    if (type === "IEND") break;
    offset += 12 + length;
  }
  return parts.length ? Buffer.concat(parts) : null;
}

/**
 * The opaque bounding box of a PNG.
 *
 * @param {Buffer} buffer   raw PNG bytes, unmodified
 * @param {number} alphaFloor  alpha above which a pixel counts as ink. A small
 *   floor ignores the near-invisible halo antialiasing leaves behind, which
 *   would otherwise stretch the box to the whole canvas.
 * @returns {{x:number,y:number,width:number,height:number,
 *            canvasWidth:number,canvasHeight:number}|null}
 */
function pngInkBox(buffer, alphaFloor = 8) {
  try {
    const header = readHeader(buffer);
    if (!header) return null;

    // Only the straightforward, overwhelmingly common encodings are handled.
    // Anything else falls back rather than risking a wrong box.
    const channels = CHANNELS[header.colorType];
    if (!channels || header.bitDepth !== 8 || header.interlaced) return null;
    if (!header.width || !header.height) return null;

    const data = readPixelData(buffer);
    if (!data) return null;
    const raw = zlib.inflateSync(data);

    const { width, height } = header;
    const stride = width * channels;
    if (raw.length < height * (stride + 1)) return null;

    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;

    // Only two scanlines are needed at a time: the current one and the one
    // above it, which the filters reference.
    let previous = Buffer.alloc(stride);
    let current = Buffer.alloc(stride);
    let cursor = 0;

    for (let y = 0; y < height; y += 1) {
      const filter = raw[cursor];
      cursor += 1;
      const line = raw.subarray(cursor, cursor + stride);
      cursor += stride;

      for (let x = 0; x < stride; x += 1) {
        const left = x >= channels ? current[x - channels] : 0;
        const up = previous[x];
        const upLeft = x >= channels ? previous[x - channels] : 0;
        const value = line[x];
        let out;
        if (filter === 0) out = value;
        else if (filter === 1) out = value + left;
        else if (filter === 2) out = value + up;
        else if (filter === 3) out = value + ((left + up) >> 1);
        else if (filter === 4) out = value + paeth(left, up, upLeft);
        else return null; // unknown filter: do not guess
        current[x] = out & 0xff;
      }

      // Alpha is the last channel of each pixel.
      for (let x = 0; x < width; x += 1) {
        if (current[x * channels + channels - 1] > alphaFloor) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }

      const swap = previous;
      previous = current;
      current = swap;
    }

    if (maxX < 0) return null; // fully transparent

    return {
      x: minX,
      y: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
      canvasWidth: width,
      canvasHeight: height,
    };
  } catch {
    return null;
  }
}

/**
 * Placement that puts the INK inside a target box.
 *
 * Returns the width, height and top-left corner to draw the whole image at, so
 * that its ink fills `box`. The transparent surround spills outside the box and
 * draws nothing, which is why the image may be far larger than the box itself.
 *
 * @param {object} ink   result of pngInkBox
 * @param {object} box   {x, y, width, height} target area for the ink, with y
 *                       measured from the top, as pdfkit does.
 * @returns {{x:number,y:number,width:number,height:number}|null}
 */
function placeInkInBox(ink, box) {
  if (!ink || !ink.width || !ink.height) return null;
  const scale = Math.min(box.width / ink.width, box.height / ink.height);
  if (!Number.isFinite(scale) || scale <= 0) return null;

  const inkWidth = ink.width * scale;
  const inkHeight = ink.height * scale;

  return {
    width: ink.canvasWidth * scale,
    height: ink.canvasHeight * scale,
    // Shift the image so its ink corner lands where the box wants it, and
    // centre the ink within the box on both axes.
    x: box.x + (box.width - inkWidth) / 2 - ink.x * scale,
    y: box.y + (box.height - inkHeight) / 2 - ink.y * scale,
  };
}

module.exports = { pngInkBox, placeInkInBox };
