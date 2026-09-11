const express = require("express");
const multer = require("multer");
const crypto = require("crypto");

const auth = require("../middleware/auth");
const { PERMISSIONS, requirePermission } = require("../middleware/authorize");
const WorkPhoto = require("../models/WorkPhoto");
const { createAdminActivityLog } = require("../utils/adminActivityLog");
const {
  CATEGORIES,
  STATUS,
  UPLOADER_TYPE,
} = require("../utils/recentWork/workPhotoStates");
const {
  ACCEPTED_MIME_HINT,
  ImageRejected,
  MAX_FILES_PER_UPLOAD,
  MAX_UPLOAD_BYTES,
} = require("../utils/recentWork/workPhotoImages");
const service = require("../utils/recentWork/workPhotoService");

const router = express.Router();

/**
 * Admin control of the Recent Work gallery.
 *
 * Admin-only on every route, including the reads: the library carries booking
 * numbers, uploader names and internal notes, which is the private half of the
 * feature. The public half lives in routes/recentWork.js and shares nothing
 * with this file except the service layer.
 */
const onlyAdmin = requirePermission(PERMISSIONS.ADMIN);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_FILES_PER_UPLOAD },
  /*
   * A cheap first pass so an obviously wrong file is refused before it is
   * buffered. It is not the real check - the browser's Content-Type is the
   * client's opinion - and workPhotoImages re-verifies by decoding the bytes.
   */
  fileFilter: (_req, file, cb) => {
    if (!ACCEPTED_MIME_HINT.test(String(file.mimetype || ""))) {
      return cb(new ImageRejected("Only image files can be uploaded here."));
    }
    return cb(null, true);
  },
});

function actorOf(req) {
  return {
    userId: req.accessUser?._id || req.user?.id || null,
    name: req.accessUser?.name || req.accessUser?.email || "Admin",
  };
}

function fail(res, error, fallback = "Something went wrong") {
  const status = Number(error?.statusCode) || 500;
  if (status >= 500) console.error("recent-work admin error:", error);
  return res.status(status).json({ message: error?.message || fallback });
}

/** Multer rejects by throwing into the middleware chain rather than to us. */
function handleUploadErrors(handler) {
  return (req, res, next) =>
    upload.array("photos", MAX_FILES_PER_UPLOAD)(req, res, (error) => {
      if (error) {
        const tooBig = error.code === "LIMIT_FILE_SIZE";
        const tooMany = error.code === "LIMIT_FILE_COUNT";
        const message = tooBig
          ? "One of those images is larger than 25 MB."
          : tooMany
            ? `You can upload ${MAX_FILES_PER_UPLOAD} photos at a time.`
            : error.message || "That upload was refused.";
        return res.status(400).json({ message });
      }
      return handler(req, res, next);
    });
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

const VIEWS = {
  pending: { status: { $in: [STATUS.PENDING_REVIEW] } },
  scheduled: { status: STATUS.SCHEDULED },
  published: { status: STATUS.PUBLISHED },
  /* Everything we still hold, including what is live. The whole collection. */
  library: { status: { $in: [STATUS.LIBRARY, STATUS.PUBLISHED, STATUS.SCHEDULED, STATUS.REJECTED, STATUS.PENDING_REVIEW] } },
  rejected: { status: STATUS.REJECTED },
};

router.get("/", auth, ...onlyAdmin, async (req, res) => {
  try {
    const view = VIEWS[String(req.query.view || "library")] ? String(req.query.view) : "library";
    const limit = Math.min(Math.max(Number(req.query.limit) || 48, 1), 100);
    const page = Math.max(Number(req.query.page) || 1, 1);

    const filter = { deletedAt: null, ...VIEWS[view] };
    if (req.query.category) filter.category = String(req.query.category);
    if (req.query.uploaderType) filter.uploaderType = String(req.query.uploaderType);

    const search = String(req.query.q || "").trim();
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ title: rx }, { caption: rx }, { bookingNumber: rx }, { uploadedByName: rx }];
    }

    const [rows, total, counts] = await Promise.all([
      WorkPhoto.find(filter)
        .sort(view === "published" ? { featured: -1, sortOrder: 1, publishedAt: -1 } : { createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      WorkPhoto.countDocuments(filter),
      WorkPhoto.aggregate([
        { $match: { deletedAt: null } },
        { $group: { _id: "$status", n: { $sum: 1 } } },
      ]),
    ]);

    const byStatus = counts.reduce((acc, row) => ({ ...acc, [row._id]: row.n }), {});

    return res.json({
      view,
      page,
      limit,
      total,
      photos: rows.map(service.toAdminDTO),
      counts: {
        pending: byStatus[STATUS.PENDING_REVIEW] || 0,
        scheduled: byStatus[STATUS.SCHEDULED] || 0,
        published: byStatus[STATUS.PUBLISHED] || 0,
        rejected: byStatus[STATUS.REJECTED] || 0,
        library:
          (byStatus[STATUS.LIBRARY] || 0) +
          (byStatus[STATUS.PUBLISHED] || 0) +
          (byStatus[STATUS.SCHEDULED] || 0) +
          (byStatus[STATUS.REJECTED] || 0) +
          (byStatus[STATUS.PENDING_REVIEW] || 0),
      },
      categories: CATEGORIES,
    });
  } catch (error) {
    return fail(res, error, "Could not load the gallery");
  }
});

/* ------------------------------------------------------------------ */
/* Uploading                                                           */
/* ------------------------------------------------------------------ */

/**
 * Admin upload. One request, up to ten photos, shared metadata.
 *
 * Partial success is reported rather than hidden: nine good photos and one
 * corrupt file returns the nine and names the one, because throwing the batch
 * away over a single bad frame is how you lose the photos somebody just walked
 * back to the van to take.
 */
router.post(
  "/",
  auth,
  ...onlyAdmin,
  handleUploadErrors(async (req, res) => {
    try {
      const files = req.files || [];
      if (!files.length) return res.status(400).json({ message: "Choose at least one photo." });

      const uploader = { uploaderType: UPLOADER_TYPE.ADMIN, role: "admin" };
      const actor = actorOf(req);
      const batchId = crypto.randomUUID();
      const publishNow = String(req.body.publishNow) === "true";

      const created = [];
      const failed = [];

      for (const [index, file] of files.entries()) {
        try {
          const photo = await service.createFromBuffer({
            buffer: file.buffer,
            uploader,
            actor,
            fields: {
              title: req.body.title,
              caption: req.body.caption,
              category: req.body.category,
              publicLocation: req.body.publicLocation,
              internalNote: req.body.internalNote,
              bookingNumber: req.body.bookingNumber,
              publishNow,
              batchId,
            },
          });
          created.push(service.toAdminDTO(photo.toObject()));
        } catch (error) {
          failed.push({
            name: String(file.originalname || `Photo ${index + 1}`).slice(0, 120),
            message: error?.message || "Could not process that image",
          });
        }
      }

      if (created.length) {
        await createAdminActivityLog(req, {
          action: publishNow ? "recent_work.upload_published" : "recent_work.upload_library",
          entityType: "work_photo",
          entityId: batchId,
          entityName: `${created.length} photo${created.length === 1 ? "" : "s"}`,
          details: { batchId, count: created.length, publishNow, failed: failed.length },
        }).catch(() => {});
      }

      return res.status(created.length ? 201 : 400).json({
        created,
        failed,
        batchId,
        message: created.length
          ? `${created.length} photo${created.length === 1 ? "" : "s"} uploaded`
          : "None of those files could be used",
      });
    } catch (error) {
      return fail(res, error, "Upload failed");
    }
  })
);

/* ------------------------------------------------------------------ */
/* Moderating                                                          */
/* ------------------------------------------------------------------ */

const audit = (req, action, photo, details = {}) =>
  createAdminActivityLog(req, {
    action,
    entityType: "work_photo",
    entityId: String(photo._id),
    entityName: photo.title || photo.bookingNumber || "Work photo",
    details: { status: photo.status, uploaderType: photo.uploaderType, ...details },
  }).catch(() => {});

router.post("/:id/publish", auth, ...onlyAdmin, async (req, res) => {
  try {
    const photo = await service.publish(req.params.id, actorOf(req));
    await audit(req, "recent_work.publish", photo);
    return res.json({ photo: service.toAdminDTO(photo.toObject()) });
  } catch (error) {
    return fail(res, error, "Could not publish");
  }
});

router.post("/:id/unpublish", auth, ...onlyAdmin, async (req, res) => {
  try {
    const photo = await service.unpublish(req.params.id, actorOf(req));
    await audit(req, "recent_work.unpublish", photo);
    return res.json({ photo: service.toAdminDTO(photo.toObject()) });
  } catch (error) {
    return fail(res, error, "Could not unpublish");
  }
});

router.post("/:id/reject", auth, ...onlyAdmin, async (req, res) => {
  try {
    const photo = await service.reject(req.params.id, actorOf(req), req.body?.reason);
    await audit(req, "recent_work.reject", photo, { reason: photo.rejectionReason });
    return res.json({ photo: service.toAdminDTO(photo.toObject()) });
  } catch (error) {
    return fail(res, error, "Could not reject");
  }
});

router.patch("/:id", auth, ...onlyAdmin, async (req, res) => {
  try {
    const photo = await service.updateDetails(req.params.id, req.body || {});
    await audit(req, "recent_work.edit", photo, { fields: Object.keys(req.body || {}) });
    return res.json({ photo: service.toAdminDTO(photo.toObject()) });
  } catch (error) {
    return fail(res, error, "Could not save");
  }
});

router.delete("/:id", auth, ...onlyAdmin, async (req, res) => {
  try {
    const photo = await service.remove(req.params.id, actorOf(req));
    await audit(req, "recent_work.delete", photo, {
      storagePurged: Boolean(photo.storagePurgedAt),
    });
    return res.json({
      deleted: true,
      storagePurged: Boolean(photo.storagePurgedAt),
      message: photo.storagePurgedAt
        ? "Photo deleted"
        : "Photo removed. Its files are queued for cleanup.",
    });
  } catch (error) {
    return fail(res, error, "Could not delete");
  }
});

module.exports = router;
