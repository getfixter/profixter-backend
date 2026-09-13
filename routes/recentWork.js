const express = require("express");
const multer = require("multer");
const crypto = require("crypto");

const auth = require("../middleware/auth");
const { loadAccessUser } = require("../middleware/authorize");
const WorkPhoto = require("../models/WorkPhoto");
const Booking = require("../models/Booking");
const {
  CATEGORIES,
  CATEGORY_SLUGS,
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
 * The public face of Recent Work, and the door authenticated uploaders come in.
 *
 * THE READ SIDE TAKES NO TOKEN AND RETURNS NO PERSON. It answers one question -
 * what work have you done - and the projection it answers with is built from an
 * allowlist in the service layer, so a field added to the schema next year
 * cannot leak by default. There is no route here that accepts an id and returns
 * a document; there is no way to ask for a photo that is not published.
 */

/* ------------------------------------------------------------------ */
/* Public read                                                         */
/* ------------------------------------------------------------------ */

const MAX_PAGE_SIZE = 60;
const DEFAULT_PAGE_SIZE = 24;

router.get("/", async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const page = Math.max(Number(req.query.page) || 1, 1);

    /*
     * The whole filter, and it is not negotiable by query string. A caller can
     * choose a category and a page; they cannot choose a status.
     */
    const filter = { status: STATUS.PUBLISHED };

    const requested = String(req.query.category || "").trim();
    if (requested && CATEGORY_SLUGS.includes(requested)) filter.category = requested;

    const [rows, total] = await Promise.all([
      WorkPhoto.find(filter)
        .sort({ featured: -1, sortOrder: 1, publishedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      WorkPhoto.countDocuments(filter),
    ]);

    res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    return res.json({
      photos: rows.map(service.toPublicDTO),
      page,
      limit,
      total,
      hasMore: page * limit < total,
    });
  } catch (error) {
    console.error("recent-work public read failed:", error);
    return res.status(500).json({ message: "Could not load recent work" });
  }
});

router.get("/categories", async (_req, res) => {
  try {
    const rows = await WorkPhoto.aggregate([
      { $match: { status: STATUS.PUBLISHED } },
      { $group: { _id: "$category", n: { $sum: 1 } } },
    ]);
    const counts = rows.reduce((acc, row) => ({ ...acc, [row._id]: row.n }), {});
    res.set("Cache-Control", "public, max-age=300");
    return res.json({
      categories: CATEGORIES.filter((c) => counts[c.slug]).map((c) => ({
        ...c,
        count: counts[c.slug],
      })),
    });
  } catch (error) {
    console.error("recent-work categories failed:", error);
    return res.status(500).json({ message: "Could not load categories" });
  }
});

/* ------------------------------------------------------------------ */
/* Authenticated submission                                            */
/* ------------------------------------------------------------------ */

/**
 * Where a Fixter's and a member's photos arrive.
 *
 * The UI for both is a later phase; the authorization is not, because "only
 * active members may submit" is a server rule or it is nothing. The caller does
 * not say who they are - resolveUploaderContext works it out from the account
 * and the membership authority, and a customer whose plan lapsed is refused
 * here regardless of what their browser believes.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_FILES_PER_UPLOAD },
  fileFilter: (_req, file, cb) => {
    if (!ACCEPTED_MIME_HINT.test(String(file.mimetype || ""))) {
      return cb(new ImageRejected("Only image files can be uploaded here."));
    }
    return cb(null, true);
  },
});

router.post("/submissions", auth, loadAccessUser, (req, res) => {
  upload.array("photos", MAX_FILES_PER_UPLOAD)(req, res, async (uploadError) => {
    if (uploadError) {
      const tooBig = uploadError.code === "LIMIT_FILE_SIZE";
      return res.status(400).json({
        message: tooBig
          ? "One of those images is larger than 25 MB."
          : uploadError.message || "That upload was refused.",
      });
    }

    try {
      const uploader = await service.resolveUploaderContext(req.accessUser, req.accessRole);
      const files = req.files || [];
      if (!files.length) return res.status(400).json({ message: "Choose at least one photo." });

      /*
       * Verified before a single byte is processed, so a bad claim costs one
       * indexed lookup rather than three image renders and an S3 round trip.
       */
      const booking = await service.assertBookingClaim(
        req.body.bookingNumber,
        req.accessUser,
        uploader.uploaderType
      );

      const actor = { userId: req.accessUser._id, name: req.accessUser.name || "" };
      const batchId = crypto.randomUUID();
      const created = [];
      const failed = [];

      for (const file of files) {
        try {
          const photo = await service.createFromBuffer({
            buffer: file.buffer,
            uploader,
            actor,
            fields: {
              caption: req.body.caption,
              category: req.body.category,
              /* The verified booking, never the string the client sent. */
              bookingId: booking?._id || null,
              bookingNumber: booking?.bookingNumber || "",
              batchId,
            },
          });
          /*
           * Even the uploader's own receipt is the public shape plus the two
           * facts they need: what state it is in and, for a Fixter, when it
           * goes live. Their own photo is not a reason to hand back a customer
           * record.
           */
          created.push({
            ...service.toPublicDTO(photo),
            status: photo.status,
            publishAt: photo.publishAt ? photo.publishAt.toISOString() : null,
          });
        } catch (error) {
          failed.push({ message: error?.message || "Could not process that image" });
        }
      }

      return res.status(created.length ? 201 : 400).json({ created, failed, batchId });
    } catch (error) {
      const status = Number(error?.statusCode) || 500;
      if (status >= 500) console.error("recent-work submission failed:", error);
      return res.status(status).json({ message: error?.message || "Could not submit" });
    }
  });
});

/* ------------------------------------------------------------------ */
/* What a contributor may see of their own                             */
/* ------------------------------------------------------------------ */

/** How far back a job stays offerable, and how many to offer. */
const JOB_PICKER_DAYS = 120;
const JOB_PICKER_LIMIT = 30;

/**
 * The jobs this person may legitimately attach a photo to.
 *
 * EXISTS SO THE PICKER CANNOT BE A LIST OF OTHER PEOPLE'S WORK.
 *
 * The upload route already refuses a booking the caller has no claim on, so
 * this is not the security boundary - assertBookingClaim is, and it runs
 * whatever this returns. What this does is make the boundary usable: a Fixter
 * standing in a hallway needs the three jobs they did today, not a booking
 * number to type from memory.
 *
 * The scope is deliberately the same rule the upload enforces, written the same
 * way round: a member sees bookings that are theirs, a Fixter sees bookings
 * they were assigned. Anything else would offer a job the upload would then
 * refuse, which is a worse experience than not offering it.
 *
 * Lean on purpose. The Jobs tab already has an endpoint that returns whole
 * bookings with the customer populated, and reusing it here would ship a
 * customer's name, email and phone to a phone on a hallway connection to draw a
 * dropdown. This returns what a dropdown needs.
 */
router.get("/my-jobs", auth, loadAccessUser, async (req, res) => {
  try {
    const uploader = await service.resolveUploaderContext(req.accessUser, req.accessRole);

    const since = new Date(Date.now() - JOB_PICKER_DAYS * 24 * 60 * 60 * 1000);
    const scope = { date: { $gte: since } };

    if (uploader.uploaderType === UPLOADER_TYPE.MEMBER) {
      scope.$or = [{ user: req.accessUser._id }, { userId: req.accessUser.userId }];
    } else if (uploader.uploaderType === UPLOADER_TYPE.FIXTER) {
      scope.assignedFixterId = req.accessUser._id;
    }
    /* An admin is not narrowed; the admin gallery is where they normally work. */

    const bookings = await Booking.find(scope)
      .select("bookingNumber date service status city")
      .sort({ date: -1 })
      .limit(JOB_PICKER_LIMIT)
      .lean();

    return res.json({
      jobs: bookings
        .filter((b) => b.bookingNumber)
        .map((b) => ({
          bookingNumber: b.bookingNumber,
          date: b.date ? new Date(b.date).toISOString() : null,
          service: b.service || "",
          status: b.status || "",
          /*
           * Town only. A picker needs enough to tell two jobs apart on the same
           * day; the street address is not that, and this response is read by a
           * Fixter's phone rather than by the admin screen.
           */
          city: b.city || "",
        })),
    });
  } catch (error) {
    const status = Number(error?.statusCode) || 500;
    if (status >= 500) console.error("recent-work my-jobs failed:", error);
    return res.status(status).json({ message: error?.message || "Could not load jobs" });
  }
});

/**
 * The photos this person submitted, and what became of them.
 *
 * Scoped to the caller by uploadedByUserId, so it cannot become a window onto
 * anybody else's submissions. It exists because a contributor who uploads into
 * silence has no way to tell a successful submission from a lost one, and the
 * honest answer - "we have it, an admin decides" - is worth showing.
 *
 * Carries the public shape plus the status. Not the internal note, not the
 * reviewer, not the rejection reason: an admin's working notes are not
 * correspondence, and a contributor being told a human said no is the product
 * decision, not a critique they get to read.
 */
router.get("/my-submissions", auth, loadAccessUser, async (req, res) => {
  try {
    await service.resolveUploaderContext(req.accessUser, req.accessRole);

    const rows = await WorkPhoto.find({
      uploadedByUserId: req.accessUser._id,
      status: { $ne: STATUS.ARCHIVED },
    })
      .sort({ createdAt: -1 })
      .limit(60)
      .lean();

    return res.json({
      submissions: rows.map((photo) => ({
        ...service.toPublicDTO(photo),
        status: photo.status,
        bookingNumber: photo.bookingNumber || "",
        createdAt: photo.createdAt ? new Date(photo.createdAt).toISOString() : null,
      })),
    });
  } catch (error) {
    const status = Number(error?.statusCode) || 500;
    if (status >= 500) console.error("recent-work my-submissions failed:", error);
    return res.status(status).json({ message: error?.message || "Could not load submissions" });
  }
});

module.exports = router;
