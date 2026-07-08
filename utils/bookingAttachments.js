const path = require("path");
const multer = require("multer");
const sharp = require("sharp");
const { putPublicObject } = require("./s3");

const S3_BUCKET = process.env.S3_BUCKET;
const S3_PREFIX = (process.env.S3_PREFIX || "uploads").replace(/\/+$/, "");
const MAX_APPOINTMENT_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_APPOINTMENT_PHOTOS = 10;

const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

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
    fileFilter: (_req, file, cb) => {
      if (!ALLOWED_IMAGE_MIME_TYPES.has(String(file.mimetype || "").toLowerCase())) {
        const error = new Error("Appointment photos must be JPG, PNG, WEBP, HEIC, or HEIF images.");
        error.statusCode = 400;
        return cb(error);
      }
      return cb(null, true);
    },
  }).array("images", MAX_APPOINTMENT_PHOTOS);
}

function uploadAppointmentPhotos(req, res, next) {
  appointmentPhotoUpload()(req, res, (error) => {
    if (!error) return next();
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ message: "Each appointment photo must be 10 MB or smaller." });
    }
    if (error.code === "LIMIT_FILE_COUNT") {
      return res.status(400).json({ message: "Upload up to 10 appointment photos at a time." });
    }
    return res.status(error.statusCode || 400).json({
      message: error.message || "Appointment photo upload failed.",
    });
  });
}

async function prepareAppointmentImage(file) {
  const originalExt = path.extname(file.originalname || "").toLowerCase();
  const needsConversion =
    [".heic", ".heif", ".png", ".bmp", ".tiff", ".tif"].includes(originalExt) ||
    [
      "image/heic",
      "image/heif",
      "image/png",
      "image/bmp",
      "image/tiff",
    ].includes(String(file.mimetype || "").toLowerCase());

  if (needsConversion) {
    return {
      buffer: await sharp(file.buffer)
        .rotate()
        .resize(1600, 1600, {
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({
          quality: 78,
          chromaSubsampling: "4:2:0",
          mozjpeg: true,
        })
        .toBuffer(),
      ext: ".jpg",
      contentType: "image/jpeg",
    };
  }

  if ([".jpg", ".jpeg", ".webp"].includes(originalExt)) {
    return {
      buffer: await sharp(file.buffer)
        .rotate()
        .resize(1600, 1600, {
          fit: "inside",
          withoutEnlargement: true,
        })
        .toBuffer(),
      ext: originalExt || ".jpg",
      contentType: file.mimetype || "image/jpeg",
    };
  }

  return {
    buffer: file.buffer,
    ext: originalExt || ".jpg",
    contentType: file.mimetype || "application/octet-stream",
  };
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

  for (const file of files) {
    const originalExt = path.extname(file.originalname || "").toLowerCase();
    const stem = safeName(path.basename(file.originalname || "photo", originalExt));
    const prepared = await prepareAppointmentImage(file);
    const key = `${baseKey}/${Date.now()}-${source}-${stem}${prepared.ext}`;
    const url = await putPublicObject({
      Bucket: S3_BUCKET,
      Key: key,
      Body: prepared.buffer,
      ContentType: prepared.contentType,
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
