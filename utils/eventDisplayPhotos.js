/**
 * Which booking photos the event display may show, and what it is told about them.
 *
 * WHAT LEAVES THE SERVER
 * A photo is described by an opaque id, its existing public S3 URL, a review
 * status and an opaque `group` (a hash of the booking id, so two shots of the
 * same job can share a frame). No name, address, note, date, booking number or
 * user id is ever put in the response, and the booking query itself selects
 * only `_id`, `images` and `createdAt`, so there is nothing else to leak.
 *
 * WHAT IS NEVER A CANDIDATE
 *  - anything that is not on our upload bucket (`local://`, foreign hosts)
 *  - anything that is not a .jpg/.jpeg. Since 2026-09-11 every upload is
 *    re-encoded to a metadata-free JPEG; older HEIC/PNG/WebP/PDF uploads were
 *    stored as sent and may still carry EXIF/GPS, so they are left out entirely.
 *  - repeats: the same URL twice, or the same original filename uploaded again
 *    (the 11 copies of IMG_8031.jpeg). Generic phone names such as `image.jpg`
 *    are not treated as repeats, because hundreds of different photos share them.
 *
 *  - photos on bookings owned by staff accounts: those are our own tests
 *    (the "google-logo-icon" upload), not a customer's home
 *
 * EVERY ELIGIBLE PHOTO PLAYS UNLESS AN ADMIN HIDES IT
 * The owner chose this on 2026-10-02, knowing that no filter here can see a
 * face, a piece of mail or a house number: the display is meant to rotate
 * through the whole library, and the review page exists to take individual
 * photos out. A new booking's photos join on the display's next refresh.
 */

const crypto = require("crypto");

const STATUS = Object.freeze({
  APPROVED: "approved",
  HIDDEN: "hidden",
  UNREVIEWED: "unreviewed",
});

/** Uploads are named `${Date.now()}-[customer-|admin-]${stem}.jpg`. */
const GENERIC_STEMS = new Set([
  "image",
  "images",
  "img",
  "photo",
  "photos",
  "picture",
  "pic",
  "unnamed",
  "download",
  "file",
  "blob",
  "camera",
  "screenshot",
  "upload",
]);

const DISPLAYABLE_EXTENSIONS = new Set([".jpg", ".jpeg"]);

function sha(value, length) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, length);
}

function photoId(url) {
  return sha(`photo:${url}`, 20);
}

/** Opaque and one-way: lets the client pair shots of a job without knowing which job. */
function groupId(bookingId) {
  return sha(`group:${bookingId}`, 12);
}

function allowedHosts({ bucket, region } = {}) {
  const name = String(bucket || "").trim();
  if (!name) return new Set();
  const hosts = new Set([`${name}.s3.amazonaws.com`]);
  if (region) hosts.add(`${name}.s3.${region}.amazonaws.com`);
  hosts.add(`${name}.s3.us-east-1.amazonaws.com`);
  return hosts;
}

function parseUploadUrl(raw, hosts) {
  if (typeof raw !== "string" || !raw.startsWith("https://")) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (!hosts.has(parsed.hostname.toLowerCase())) return null;
  if (parsed.search || parsed.hash) return null;
  const segments = parsed.pathname.split("/").filter(Boolean);
  const file = decodeURIComponent(segments[segments.length - 1] || "");
  const dot = file.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = file.slice(dot).toLowerCase();
  if (!DISPLAYABLE_EXTENSIONS.has(ext)) return null;
  return { url: raw, file, ext };
}

/** The customer's original filename, without our timestamp/source prefix. */
function originalStem(file) {
  const withoutExt = file.replace(/\.[^.]+$/, "");
  return withoutExt
    .replace(/^\d+-/, "")
    .replace(/^(customer|admin)-/, "")
    .toLowerCase();
}

function isGenericStem(stem) {
  // "image-3", "image (2)" are copies of a generic name; "img_8031" is a camera
  // counter and identifies one file.
  const base = stem.replace(/[-_ ]?\(?\d{1,2}\)?$/, "");
  return stem.length < 5 || GENERIC_STEMS.has(stem) || GENERIC_STEMS.has(base);
}

/**
 * Bookings (newest first) → unique displayable photos, each tied to an opaque group.
 * The first, i.e. most recent, occurrence of a repeat wins.
 */
function collectCandidates(bookings, storage) {
  const hosts = allowedHosts(storage);
  const seenUrls = new Set();
  const seenStems = new Set();
  const candidates = [];

  for (const booking of bookings || []) {
    const images = Array.isArray(booking?.images) ? booking.images : [];
    for (const raw of images) {
      const parsed = parseUploadUrl(raw, hosts);
      if (!parsed || seenUrls.has(parsed.url)) continue;
      seenUrls.add(parsed.url);

      const stem = originalStem(parsed.file);
      if (!isGenericStem(stem)) {
        if (seenStems.has(stem)) continue;
        seenStems.add(stem);
      }

      candidates.push({
        id: photoId(parsed.url),
        url: parsed.url,
        group: groupId(booking._id),
      });
    }
  }
  return candidates;
}

/** Attach stored decisions. `decisions` is [{ photoId, status }]. */
function withStatus(candidates, decisions) {
  const byId = new Map((decisions || []).map((d) => [d.photoId, d.status]));
  return candidates.map((photo) => ({
    ...photo,
    status: byId.get(photo.id) || STATUS.UNREVIEWED,
  }));
}

/** Everything not hidden: unreviewed and approved photos both play. */
function displayable(photos) {
  return photos.filter((photo) => photo.status !== STATUS.HIDDEN);
}

module.exports = {
  STATUS,
  photoId,
  groupId,
  allowedHosts,
  parseUploadUrl,
  originalStem,
  isGenericStem,
  collectCandidates,
  withStatus,
  displayable,
};
