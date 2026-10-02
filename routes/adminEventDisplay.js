/**
 * The booth display: customer booking photos on a tablet at an event.
 *
 * ADMIN ONLY
 * Both endpoints require PERMISSIONS.ADMIN. Fixters can read bookings, but this
 * is a curated set of other people's homes and only an admin decides what of it
 * goes in front of the public.
 *
 * NOTHING BUT PHOTOS
 * Bookings are read with `_id images createdAt` and nothing else, and each photo
 * is answered as { id, url, status, group } (see utils/eventDisplayPhotos.js).
 *
 * GET  /photos?scope=display  approved photos only: what the tablet plays
 * GET  /photos?scope=review   every candidate with its status, and which of the
 *                             unreviewed ones are in tonight's shortlist
 * PUT  /photos                { ids, status } approve / hide / un-review
 */

const express = require("express");
const auth = require("../middleware/auth");
const Booking = require("../models/Booking");
const User = require("../models/User");
const EventDisplayPhoto = require("../models/EventDisplayPhoto");
const { PERMISSIONS, requirePermission } = require("../middleware/authorize");
const { createAdminActivityLog } = require("../utils/adminActivityLog");
const {
  STATUS,
  collectCandidates,
  withStatus,
  displayable,
  shortlist,
} = require("../utils/eventDisplayPhotos");

const router = express.Router();
const onlyAdmin = requirePermission(PERMISSIONS.ADMIN);

/** Backstops, not paging: there are ~1,200 bookings with photos today. */
const BOOKING_SCAN_LIMIT = 10000;
const MAX_IDS_PER_UPDATE = 5000;

function storage() {
  return {
    bucket: process.env.S3_BUCKET,
    region: process.env.S3_REGION || process.env.AWS_REGION || "us-east-1",
  };
}

/** Accounts whose bookings are our own tests: admins (by role or the admin email) and employees. */
async function staffUserIds() {
  const adminEmail = String(process.env.MAIL_ADMIN || "getfixter@gmail.com").trim().toLowerCase();
  const staff = await User.find({
    $or: [{ role: { $in: ["admin", "employee"] } }, { email: adminEmail }],
  })
    .select("_id")
    .lean();
  return new Set(staff.map((u) => String(u._id)));
}

async function loadPhotos() {
  const [bookings, staff] = await Promise.all([
    Booking.find({ "images.0": { $exists: true } })
      .select("_id images createdAt user")
      .sort({ createdAt: -1 })
      .limit(BOOKING_SCAN_LIMIT)
      .lean(),
    staffUserIds(),
  ]);
  const customerBookings = bookings.filter((b) => !staff.has(String(b.user)));
  const candidates = collectCandidates(customerBookings, storage());
  const decisions = await EventDisplayPhoto.find({ photoId: { $in: candidates.map((p) => p.id) } })
    .select("photoId status")
    .lean();
  return withStatus(candidates, decisions);
}

router.get("/photos", auth, ...onlyAdmin, async (req, res) => {
  try {
    const photos = await loadPhotos();
    res.set("Cache-Control", "no-store");
    if (req.query.scope === "review") {
      const picked = shortlist(photos);
      const counts = { approved: 0, hidden: 0, unreviewed: 0, shortlist: picked.size };
      for (const photo of photos) counts[photo.status] += 1;
      return res.json({
        photos: photos.map((photo) => ({ ...photo, shortlisted: picked.has(photo.id) })),
        counts,
        total: photos.length,
      });
    }
    const shown = displayable(photos).map(({ id, url, group }) => ({ id, url, group }));
    return res.json({ photos: shown, total: shown.length });
  } catch (error) {
    console.error("Event display photos failed:", error);
    return res.status(500).json({ message: "Could not load photos" });
  }
});

router.put("/photos", auth, ...onlyAdmin, async (req, res) => {
  const { ids, status } = req.body || {};
  if (!Object.values(STATUS).includes(status)) {
    return res.status(400).json({ message: "status must be approved, hidden or unreviewed" });
  }
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_IDS_PER_UPDATE) {
    return res.status(400).json({ message: `ids must be a list of 1 to ${MAX_IDS_PER_UPDATE} photo ids` });
  }

  try {
    // Only ids that are real candidates right now; the URL comes from the
    // booking, never from the request.
    const wanted = new Set(ids.map(String));
    const photos = (await loadPhotos()).filter((photo) => wanted.has(photo.id));
    if (photos.length === 0) return res.status(404).json({ message: "No matching photos" });

    if (status === STATUS.UNREVIEWED) {
      await EventDisplayPhoto.deleteMany({ photoId: { $in: photos.map((p) => p.id) } });
    } else {
      const reviewedAt = new Date();
      await EventDisplayPhoto.bulkWrite(
        photos.map((photo) => ({
          updateOne: {
            filter: { photoId: photo.id },
            update: {
              $set: { url: photo.url, status, reviewedBy: req.user?.id || null, reviewedAt },
            },
            upsert: true,
          },
        }))
      );
    }

    await createAdminActivityLog(req, {
      action: "event_display_photos_reviewed",
      entityType: "event_display",
      entityId: "photos",
      entityName: "Event display",
      details: { status, count: photos.length },
    }).catch((error) => console.error("Event display activity log failed:", error));

    return res.json({ updated: photos.length, status });
  } catch (error) {
    console.error("Event display review failed:", error);
    return res.status(500).json({ message: "Could not save review" });
  }
});

module.exports = router;
