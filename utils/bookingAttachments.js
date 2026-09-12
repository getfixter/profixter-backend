const multer = require("multer");
const { putPublicObject } = require("./s3");
const {
  MAX_PHOTO_BYTES,
  MAX_PHOTOS,
  ensureSanitized,
  sanitizeUploadedPhotos,
  stemOf,
} = require("./imageSanitizer");

const S3_BUCKET = process.env.S3_BUCKET;
const S3_PREFIX = (process.env.S3_PREFIX || "uploads").replace(/\/+$/, "");
const MAX_APPOINTMENT_PHOTO_BYTES = MAX_PHOTO_BYTES;
const MAX_APPOINTMENT_PHOTOS = MAX_PHOTOS;

function safeName(name) {
  return String(name || "photo")
    .normalize("NFKD")
    .replace(/[^\w.\-]+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 120);
}

function appointmentPhotoUpload() {
  return multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: MAX_APPOINTMENT_PHOTO_BYTES,
      files: MAX_APPOINTMENT_PHOTOS,
    },
    /*
     * No fileFilter on the declared MIME type. It is written by the client, so
     * it can neither admit nor exclude anything honestly: a phone that sends a
     * JPEG as application/octet-stream would be refused, and a PDF announcing
     * itself as image/jpeg would be waved through. What the file actually is
     * gets decided after the bytes arrive, in sanitizeUploadedPhotos.
     */
  }).array("images", MAX_APPOINTMENT_PHOTOS);
}

function uploadAppointmentPhotos(req, res, next) {
  appointmentPhotoUpload()(req, res, (error) => {
    /* Bytes are in. Now find out what they really are before anyone uses them. */
    if (!error) return sanitizeUploadedPhotos(req, res, next);
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ message: "Each appointment photo must be 20 MB or smaller." });
    }
    if (error.code === "LIMIT_FILE_COUNT") {
      return res.status(400).json({ message: "Upload up to 10 appointment photos at a time." });
    }
    return res.status(error.statusCode || 400).json({
      message: error.message || "Appointment photo upload failed.",
    });
  });
}

async function storeAppointmentImages({
  files = [],
  bookingDate,
  bookingNumber,
  source = "appointment-update",
}) {
  const images = [];
  const uploadedS3Keys = [];
  const date = bookingDate ? new Date(bookingDate) : new Date();
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const formattedDate = `${yyyy}-${mm}-${dd}`;

  if (!files.length) return { images, uploadedS3Keys };

  if (!S3_BUCKET) {
    for (const file of files) {
      images.push(`local://${source}/${safeName(file.originalname)}`);
    }
    return { images, uploadedS3Keys };
  }

  const baseKey = `${S3_PREFIX}/${formattedDate}/booking-${safeName(bookingNumber)}`;

  /*
   * Sanitize every photo before writing any of them. One bad file in a batch
   * should leave nothing behind in S3 to clean up afterwards.
   */
  const prepared = [];
  for (const file of files) prepared.push(await ensureSanitized(file));

  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    const ready = prepared[i];
    const stem = safeName(stemOf(file.originalname));
    const key = `${baseKey}/${Date.now()}-${source}-${stem}${ready.ext}`;
    const url = await putPublicObject({
      Bucket: S3_BUCKET,
      Key: key,
      Body: ready.buffer,
      /* Ours, from what we produced - never the Content-Type the client sent. */
      ContentType: ready.contentType,
    });
    uploadedS3Keys.push(key);
    images.push(url);
  }

  return { images, uploadedS3Keys };
}

module.exports = {
  MAX_APPOINTMENT_PHOTO_BYTES,
  MAX_APPOINTMENT_PHOTOS,
  uploadAppointmentPhotos,
  storeAppointmentImages,
};
