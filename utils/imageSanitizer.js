/**
 * Booking photo sanitization.
 *
 * Every photograph a customer or admin attaches to a booking passes through
 * here before it is allowed anywhere near S3.
 *
 * The rule this module exists to enforce: what a file IS is decided by its
 * bytes, never by its name or by the Content-Type the client typed on the
 * request. The previous pipeline branched on path.extname(), so a JPEG sent
 * with no extension matched neither the "convert" list nor the "re-encode"
 * list and fell through a fallback that stored the original bytes untouched -
 * EXIF, GPS coordinates and camera serial included - into a public bucket.
 * There is no fallback here. A buffer either decodes as an image we accept and
 * comes back re-encoded, or it is rejected.
 *
 * Re-encoding is what removes the metadata: sharp does not carry EXIF across
 * unless asked to, so the output has no GPS, no device make or model, no
 * timestamps. Orientation is baked into the pixels first, so an image that
 * relied on an EXIF orientation flag still appears the right way up after the
 * flag is gone.
 */

const sharp = require("sharp");

/**
 * Formats we accept, named as sharp reports them from the file's own bytes.
 *
 * svg is deliberately absent. sharp can rasterize it, which makes it easy to
 * accept by accident, but an SVG is a document that can carry script and
 * external references - not a photograph of a bathroom.
 */
const ACCEPTED_FORMATS = new Set(["jpeg", "png", "webp", "heif", "gif", "tiff"]);

/** Roomy for a phone photo, far below what would hurt a 1 GB instance. */
const MAX_PHOTO_BYTES = 20 * 1024 * 1024;
const MAX_PHOTOS = 10;

/**
 * A 48 MP phone camera lands near 50 million pixels. 100 million leaves room
 * for a large DSLR frame while refusing the compressed-pixel bombs that decode
 * to gigabytes - those are cheap to send and expensive to open.
 */
const MAX_INPUT_PIXELS = 100 * 1000 * 1000;

const MAX_EDGE = 1600;
const JPEG_QUALITY = 82;

const FRIENDLY_MESSAGE =
  "Photos must be real JPG, PNG, WEBP, HEIC, or HEIF images, and under 20 MB each.";

function photoError(message) {
  const error = new Error(message || FRIENDLY_MESSAGE);
  error.statusCode = 400;
  error.code = "INVALID_PHOTO";
  return error;
}

/**
 * Re-encode one buffer to a clean JPEG, or throw a 400-shaped error.
 *
 * Returns the ext and contentType to store with it. Both describe what we
 * produced, never what the client claimed, which is why an uploaded file can
 * no longer choose the Content-Type it will later be served with.
 */
async function sanitizeImageBuffer(input) {
  if (!Buffer.isBuffer(input) || !input.length) throw photoError("That photo was empty.");
  if (input.length > MAX_PHOTO_BYTES) {
    throw photoError("Each photo must be 20 MB or smaller.");
  }

  let meta;
  try {
    meta = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch {
    /* Not decodable as any image sharp knows - a renamed PDF, HTML, anything. */
    throw photoError(FRIENDLY_MESSAGE);
  }

  if (!meta || !ACCEPTED_FORMATS.has(meta.format)) throw photoError(FRIENDLY_MESSAGE);
  if (!meta.width || !meta.height) throw photoError(FRIENDLY_MESSAGE);
  if (meta.width * meta.height > MAX_INPUT_PIXELS) {
    throw photoError("That photo is too large to process. Please use a standard camera photo.");
  }

  let buffer;
  try {
    buffer = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
      /*
       * Bake orientation in before the metadata carrying it is dropped, or a
       * sideways photo stays sideways forever.
       */
      .rotate()
      .resize(MAX_EDGE, MAX_EDGE, { fit: "inside", withoutEnlargement: true })
      /* Flatten onto white: JPEG has no alpha, and unflattened transparency turns black. */
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: JPEG_QUALITY, chromaSubsampling: "4:2:0", mozjpeg: true })
      .toBuffer();
  } catch {
    throw photoError("That photo could not be processed. Please try a different file.");
  }

  if (!buffer || !buffer.length) throw photoError(FRIENDLY_MESSAGE);

  return {
    buffer,
    ext: ".jpg",
    contentType: "image/jpeg",
    sourceFormat: meta.format,
    width: meta.width,
    height: meta.height,
  };
}

/**
 * Sanitize once and remember it on the file.
 *
 * Upload code calls this rather than trusting that the middleware ran, so
 * there is no route - present or future - through which an unsanitized buffer
 * reaches S3. When the middleware has already run this is just a lookup.
 */
async function ensureSanitized(file) {
  if (!file) throw photoError(FRIENDLY_MESSAGE);
  if (file.sanitizedImage) return file.sanitizedImage;
  const result = await sanitizeImageBuffer(file.buffer);
  file.buffer = result.buffer;
  file.sanitizedImage = result;
  return result;
}

/**
 * Express middleware: sanitize every uploaded photo before the route does any
 * work at all.
 *
 * Running here rather than at upload time is what keeps a half-finished
 * request from leaving anything behind. If the third of five photos is a
 * renamed PDF, the request is refused before the first one has been written to
 * S3 and before any booking record exists, so there is nothing to roll back.
 */
function sanitizeUploadedPhotos(req, res, next) {
  const files = req.files || [];
  if (!files.length) return next();
  if (files.length > MAX_PHOTOS) {
    return res.status(400).json({ message: `Upload up to ${MAX_PHOTOS} photos at a time.` });
  }

  (async () => {
    for (const file of files) await ensureSanitized(file);
  })()
    .then(() => next())
    .catch((error) => {
      res
        .status(error.statusCode || 400)
        .json({ message: error.message || FRIENDLY_MESSAGE });
    });
}

/** Filename stem without its extension, case-insensitively. */
function stemOf(originalname) {
  return String(originalname || "photo").replace(/\.[A-Za-z0-9]{1,8}$/, "") || "photo";
}

module.exports = {
  ACCEPTED_FORMATS,
  MAX_PHOTO_BYTES,
  MAX_PHOTOS,
  MAX_INPUT_PIXELS,
  MAX_EDGE,
  JPEG_QUALITY,
  photoError,
  sanitizeImageBuffer,
  ensureSanitized,
  sanitizeUploadedPhotos,
  stemOf,
};
