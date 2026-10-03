/**
 * The Profixter Library: generic reference images a customer can pick when
 * they have no photo of the job to hand ("I need my faucet fixed, but I'm not
 * at home").
 *
 * WHAT IT IS
 * Ten Profixter-owned example pictures of common small jobs, named after the
 * site's own Popular Tasks. The images live in the frontend
 * (public/images/booking-library); a booking stores only the KEY, in
 * Booking.libraryReference.
 *
 * WHAT IT IS NOT
 * A photo of the customer's home. It is never written into Booking.images,
 * which holds only real customer (or admin) photos: the Event Display, the
 * booking history and every staff view treat `images` as photographs of the
 * actual job, and a stock picture there would be a lie in the data.
 *
 * A booking can carry a reference AND real photos (added at booking or later
 * from the account page). The reference then remains useful as the job type.
 */

const LIBRARY = Object.freeze([
  { key: "faucet", label: "Faucet & Leak" },
  { key: "light_fixture", label: "Light Fixture" },
  { key: "tv_mounting", label: "TV Mounting" },
  { key: "door", label: "Door & Lock" },
  { key: "drywall", label: "Drywall Patch" },
  { key: "caulking", label: "Caulking" },
  { key: "furniture_assembly", label: "Furniture Assembly" },
  { key: "shelves", label: "Shelves & Hanging" },
  { key: "paint", label: "Paint Touch-Up" },
  { key: "small_fixes", label: "Several Small Fixes" },
]);

const BY_KEY = new Map(LIBRARY.map((item) => [item.key, item]));

function libraryLabel(key) {
  return BY_KEY.get(String(key || ""))?.label || "";
}

/**
 * Read `libraryReference` from a booking request body.
 * Empty means "none". Anything else must be a known key, so a crafted request
 * cannot store free text in the field.
 */
function readLibraryReference(body) {
  const raw = String(body?.libraryReference ?? "").trim();
  if (!raw) return { ok: true, key: "" };
  if (!BY_KEY.has(raw)) {
    return {
      ok: false,
      status: 400,
      message: "Please choose one of the Profixter examples.",
      code: "INVALID_LIBRARY_REFERENCE",
    };
  }
  return { ok: true, key: raw };
}

module.exports = { LIBRARY, libraryLabel, readLibraryReference };
