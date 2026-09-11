const crypto = require("crypto");
const sharp = require("sharp");
const { putPublicObject, deletePublicObjects } = require("../s3");

/**
 * Turning whatever came off a phone into three safe, web-sized JPEGs.
 *
 * EVERY BYTE IS RE-ENCODED. Not "converted if the format looks unusual" - the
 * booking uploader does that and it leaves WebP untouched, metadata and all.
 * Here the decode/re-encode is unconditional, because it is the thing that
 * removes EXIF, and a pipeline that strips location data from most photos is
 * not a privacy guarantee, it is a coin toss.
 *
 * sharp writes no metadata unless asked (there is no .withMetadata() call in
 * this file, deliberately), so GPS coordinates, camera serial numbers, the
 * owner's name and the original timestamp do not survive. Orientation is the
 * one tag that matters visually, so .rotate() bakes it into the pixels first.
 *
 * The original is never stored. It is the only copy that carried EXIF, it is
 * three to five times the size of anything we serve, and nothing in the product
 * needs 12 megapixels of a fixed cabinet door.
 */

const PREFIX = "recent-work";

/** What a browser will actually be given. Three sizes is enough; ten is a hobby. */
const VARIANTS = Object.freeze([
  { name: "thumb", edge: 480, quality: 72 },
  { name: "display", edge: 1280, quality: 78 },
  { name: "full", edge: 2000, quality: 82 },
]);

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_FILES_PER_UPLOAD = 10;

/**
 * What we are willing to decode.
 *
 * Checked against the bytes, not the filename or the browser's claim: a
 * client-supplied MIME type is a suggestion from an untrusted party, and the
 * extension is just text. sharp reads the container and tells us what it
 * actually is, which is the only answer worth acting on.
 */
const ACCEPTED_FORMATS = Object.freeze(["jpeg", "jpg", "png", "webp", "heif", "avif", "tiff", "gif"]);

/** Advisory only - the real check happens after sharp has read the header. */
const ACCEPTED_MIME_HINT = /^image\/(jpeg|jpg|png|webp|heic|heif|avif|tiff|gif)$/i;

class ImageRejected extends Error {
  constructor(message) {
    super(message);
    this.name = "ImageRejected";
    this.statusCode = 400;
  }
}

/**
 * A storage key nothing outside this function can influence.
 *
 * No part of it comes from the upload. The original filename is not sanitised
 * and reused - it is discarded, because the safest way to handle a hostile
 * "../../etc/passwd.jpg" is never to let it near a key in the first place. What
 * is left is a date path for human browsing of the bucket and a random id.
 */
function buildObjectPrefix(now = new Date()) {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${PREFIX}/${yyyy}/${mm}/${crypto.randomUUID()}`;
}

/**
 * Decode, verify, and reject anything that is not really an image.
 *
 * A PHP script renamed to .jpg fails here: sharp cannot parse it, so it never
 * reaches the bucket. An "image" 40000 pixels wide fails too - it decodes fine
 * and then eats the instance's memory, which is a denial of service wearing a
 * photograph's clothes.
 */
const MAX_INPUT_PIXELS = 80_000_000;

async function inspect(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new ImageRejected("That file was empty.");
  }
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new ImageRejected("That image is larger than 25 MB.");
  }

  let meta;
  try {
    meta = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch {
    throw new ImageRejected("That file is not an image we can read.");
  }

  const format = String(meta.format || "").toLowerCase();
  if (!ACCEPTED_FORMATS.includes(format)) {
    throw new ImageRejected(`We cannot use ${format || "that"} images.`);
  }
  if (!meta.width || !meta.height) {
    throw new ImageRejected("That image has no readable dimensions.");
  }
  return meta;
}

/**
 * Render one size.
 *
 * withoutEnlargement means a small photo stays small rather than being blown up
 * into a soft mess, so "full" can legitimately be the same pixels as "display"
 * for an image that arrived small. That is fine: the URLs still differ, and the
 * page still asks for the size it wants.
 */
async function renderVariant(buffer, variant) {
  const out = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .resize(variant.edge, variant.edge, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: variant.quality, mozjpeg: true, chromaSubsampling: "4:2:0" })
    .toBuffer({ resolveWithObject: true });

  return { buffer: out.data, width: out.info.width, height: out.info.height, bytes: out.data.length };
}

/**
 * One upload, three objects, all or nothing.
 *
 * If the second variant fails to upload, the first is removed before the error
 * is thrown. Half a photo in the bucket with no row pointing at it is exactly
 * the orphan this feature is supposed to avoid creating.
 */
async function processAndStore(buffer, { now = new Date() } = {}) {
  const meta = await inspect(buffer);
  const prefix = buildObjectPrefix(now);
  const stored = {};
  const uploadedKeys = [];

  try {
    for (const variant of VARIANTS) {
      const rendered = await renderVariant(buffer, variant);
      const key = `${prefix}/${variant.name}.jpg`;
      const url = await putPublicObject({
        Key: key,
        Body: rendered.buffer,
        ContentType: "image/jpeg",
      });
      uploadedKeys.push(key);
      stored[variant.name] = {
        key,
        url,
        width: rendered.width,
        height: rendered.height,
        bytes: rendered.bytes,
      };
    }
  } catch (error) {
    await deletePublicObjects({ Keys: uploadedKeys }).catch(() => {});
    throw error;
  }

  return {
    ...stored,
    sourceFormat: String(meta.format || ""),
    sourceWidth: meta.width,
    sourceHeight: meta.height,
    objectPrefix: prefix,
  };
}

/** Every key a photo owns, for deletion. */
function keysOf(photo) {
  return [photo?.thumb?.key, photo?.display?.key, photo?.full?.key].filter(Boolean);
}

async function purgeStorage(photo) {
  const keys = keysOf(photo);
  if (!keys.length) return { deleted: 0 };
  return deletePublicObjects({ Keys: keys });
}

module.exports = {
  ACCEPTED_MIME_HINT,
  ImageRejected,
  MAX_FILES_PER_UPLOAD,
  MAX_UPLOAD_BYTES,
  PREFIX,
  VARIANTS,
  buildObjectPrefix,
  inspect,
  keysOf,
  processAndStore,
  purgeStorage,
  renderVariant,
};
