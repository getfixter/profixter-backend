/**
 * The booth display: customer booking photos on a tablet at an event.
 *
 * ADMIN ONLY
 * Everything here requires PERMISSIONS.ADMIN. The public kiosk has its own,
 * narrower routes in routes/eventDisplay.js. Fixters can read bookings, but this
 * is a set of other people's homes shown in public, and only an admin decides
 * what is taken out of it.
 *
 * NOTHING BUT PHOTOS
 * Bookings are read with `_id images createdAt user` and nothing else (`user`
 * only to drop staff test bookings), and each photo is answered as
 * { id, url, group } or { id, url, group, status } (see utils/eventDisplayPhotos.js).
 *
 * GET  /photos?scope=display  every eligible photo that is not hidden: what the tablet plays
 * GET  /photos?scope=review   every eligible photo with its status: the hide/restore grid
 * PUT  /photos                { ids, status } hide / restore (unreviewed) / approve
 */

const express = require("express");
const auth = require("../middleware/auth");
const EventDisplayPhoto = require("../models/EventDisplayPhoto");
const { PERMISSIONS, requirePermission } = require("../middleware/authorize");
const { createAdminActivityLog } = require("../utils/adminActivityLog");
const { STATUS, displayable } = require("../utils/eventDisplayPhotos");
const { loadPhotos, invalidate } = require("../utils/eventDisplayLibrary");

const router = express.Router();
const onlyAdmin = requirePermission(PERMISSIONS.ADMIN);

const MAX_IDS_PER_UPDATE = 5000;

router.get("/photos", auth, ...onlyAdmin, async (req, res) => {
  try {
    const photos = await loadPhotos();
    res.set("Cache-Control", "no-store");
    if (req.query.scope === "review") {
      const counts = { approved: 0, hidden: 0, unreviewed: 0 };
      for (const photo of photos) counts[photo.status] += 1;
      return res.json({ photos, counts, total: photos.length });
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

    // The public kiosk serves from a short cache; a hidden photo must stop now.
    invalidate();

    return res.json({ updated: photos.length, status });
  } catch (error) {
    console.error("Event display review failed:", error);
    return res.status(500).json({ message: "Could not save review" });
  }
});

module.exports = router;
