/**
 * The public event kiosk: real booking photos, and nothing else.
 *
 * NO LOGIN, SO NOTHING THAT IDENTIFIES ANYONE
 * The admin feed answers with S3 URLs, and those URLs carry the booking date
 * and booking number in their path (uploads/2026-09-20/booking-1234/...). The
 * public kiosk therefore never sees one. It gets opaque ids, and each image is
 * fetched through this route, re-encoded on the way so no metadata can ride
 * along, and served from our own domain.
 *
 * GET /photos             { photos: [{ id, group }], total }
 *                         every eligible photo that is not hidden
 * GET /photos/:id/image   the JPEG; 404 for an unknown or hidden id
 *
 * Viewing only. Review, hide and restore stay in routes/adminEventDisplay.js
 * behind PERMISSIONS.ADMIN, and nothing here writes anything.
 *
 * Limits are per connection and generous enough for a kiosk (a new photo
 * every few seconds, for hours) while making a bulk download slow.
 */

const express = require("express");
const sharp = require("sharp");
const { getObjectBuffer } = require("../utils/s3");
const { rateLimit } = require("../utils/rateLimit");
const { displayIndex, keyFromUrl } = require("../utils/eventDisplayLibrary");

const router = express.Router();

function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return (forwarded || req.ip || req.socket?.remoteAddress || "").slice(0, 64);
}

/*
 * Each limiter needs its OWN key. utils/rateLimit keeps one counter per
 * (window, key), so two limiters with the same window and key share a single
 * counter. That is what took the kiosk down on 2026-10-03: every image counted
 * against the feed's 120, and after ~120 images from one network the feed
 * answered 429 and /event showed the brand with no photos.
 */
const feedKey = (req) => {
  const ip = clientIp(req);
  return ip ? `event-display-feed:${ip}` : null;
};
const imageKey = (req) => {
  const ip = clientIp(req);
  return ip ? `event-display-image:${ip}` : null;
};

// The kiosk asks for the list once per load and every 30 minutes.
const feedLimiter = rateLimit({ limit: 120, windowMs: 10 * 60 * 1000, keyResolver: feedKey });
// A kiosk running all day, plus a reload or two and a phone on the same
// network, stays far below this; a bulk download of the library still takes
// the better part of ten minutes.
const imageLimiter = rateLimit({ limit: 2000, windowMs: 10 * 60 * 1000, keyResolver: imageKey });

const ID_PATTERN = /^[0-9a-f]{20}$/;
const MAX_EDGE = 1600;

/**
 * Recently served images, so a kiosk looping through the library does not
 * fetch and re-encode the same photo from S3 every time. Bounded by count.
 */
const RENDER_CACHE_SIZE = 60;
const renderCache = new Map();

function remember(id, buffer) {
  renderCache.delete(id);
  renderCache.set(id, buffer);
  while (renderCache.size > RENDER_CACHE_SIZE) {
    renderCache.delete(renderCache.keys().next().value);
  }
}

/** Fetch from S3 and re-encode: oriented, bounded, and with no EXIF/GPS/ICC. */
async function render(photo) {
  const original = await getObjectBuffer({ Key: keyFromUrl(photo.url) });
  return sharp(original, { failOn: "error" })
    .rotate()
    .resize(MAX_EDGE, MAX_EDGE, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
}

router.get("/photos", feedLimiter, async (req, res) => {
  try {
    const index = await displayIndex();
    res.set("Cache-Control", "no-store");
    return res.json({
      photos: index.list.map(({ id, group }) => ({ id, group })),
      total: index.list.length,
    });
  } catch (error) {
    console.error("Public event display feed failed:", error);
    return res.status(500).json({ message: "Could not load photos" });
  }
});

router.get("/photos/:id/image", imageLimiter, async (req, res) => {
  const id = String(req.params.id || "");
  if (!ID_PATTERN.test(id)) return res.status(404).end();

  try {
    // Checked on every request, cache or not: a hidden photo stops here.
    const photo = (await displayIndex()).byId.get(id);
    if (!photo) {
      renderCache.delete(id);
      return res.status(404).end();
    }

    let buffer = renderCache.get(id);
    if (!buffer) {
      buffer = await render(photo);
      remember(id, buffer);
    }

    res.set({
      "Content-Type": "image/jpeg",
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "cross-origin",
    });
    return res.send(buffer);
  } catch (error) {
    // Missing object, unreadable image or S3 trouble: the kiosk skips it.
    console.error("Public event display image failed:", error?.name || error?.message || error);
    return res.status(404).end();
  }
});

module.exports = router;
