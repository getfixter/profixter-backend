/**
 * The event display's photo library, read from bookings, shared by the admin
 * routes (review, hide/restore) and the public kiosk routes.
 *
 * One function decides what is eligible, so the public screen and the admin
 * grid can never disagree about it. Reads only: bookings are queried with
 * `_id images createdAt user`, and nothing here writes to a booking.
 *
 * The public kiosk asks for the library every few minutes and for an image
 * every few seconds, so the eligible set is cached briefly. Any hide/restore
 * clears the cache, so a hidden photo stops being served at once.
 */

const Booking = require("../models/Booking");
const User = require("../models/User");
const EventDisplayPhoto = require("../models/EventDisplayPhoto");
const { collectCandidates, withStatus, displayable } = require("./eventDisplayPhotos");

/** Backstop, not paging: there are ~1,200 bookings with photos today. */
const BOOKING_SCAN_LIMIT = 10000;
const CACHE_MS = 60 * 1000;

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

/** Every eligible photo with its review status: [{ id, url, group, status }]. */
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

let cached = null; // { at, list, byId }
let inflight = null;

/** What may be shown: not hidden. Cached for a minute; see invalidate(). */
async function displayIndex() {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached;
  if (!inflight) {
    inflight = loadPhotos()
      .then((photos) => {
        const list = displayable(photos).map(({ id, url, group }) => ({ id, url, group }));
        cached = { at: Date.now(), list, byId: new Map(list.map((p) => [p.id, p])) };
        return cached;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

function invalidate() {
  cached = null;
}

/** The S3 key behind one of our upload URLs. */
function keyFromUrl(url) {
  return decodeURIComponent(new URL(url).pathname.replace(/^\/+/, ""));
}

module.exports = { loadPhotos, displayIndex, invalidate, keyFromUrl };
