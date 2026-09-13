const Booking = require("../../models/Booking");
const WorkPhoto = require("../../models/WorkPhoto");
const {
  FIXTER_PUBLISH_DELAY_MS,
  STATUS,
  UPLOADER_TYPE,
  canTransition,
  initialStatusFor,
  isValidCategory,
} = require("./workPhotoStates");
const { processAndStore, purgeStorage } = require("./workPhotoImages");

/**
 * Everything that decides what a Recent Work photo is allowed to become.
 *
 * The routes are thin on purpose: they authenticate, they hand over files and
 * ids, and they render whatever comes back. Every rule about who may upload,
 * what a photo may turn into and what the public is allowed to see lives here,
 * so there is one place to read and one place to test - and so the Fixter and
 * member endpoints that arrive in the next phase inherit the rules rather than
 * reimplementing them slightly differently.
 */

class PhotoError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "PhotoError";
    this.statusCode = statusCode;
  }
}

/* ------------------------------------------------------------------ */
/* Who may upload, and as what                                         */
/* ------------------------------------------------------------------ */

/**
 * Is this person currently a member?
 *
 * Asked of the membership authority rather than of a string on the user
 * document: `user.subscription` is a display label that has been stale before,
 * and "may upload to our public marketing gallery" is not a question to answer
 * from a cached adjective. Any address with live cover - paid or gifted -
 * counts, because membership is a relationship with us, not with one doorway.
 */
async function hasActiveMembership(user) {
  if (!user?._id) return false;
  const { buildPerAddressCoverage } = require("../../routes/auth");
  if (typeof buildPerAddressCoverage !== "function") {
    throw new PhotoError("Membership check is unavailable", 500);
  }
  const coverage = await buildPerAddressCoverage(user);
  return Object.values(coverage || {}).some((entry) => entry?.active);
}

/**
 * Which lifecycle this caller's upload enters - or a refusal.
 *
 * This is the server-side half of the rule that a signed-in account is not by
 * itself permission to publish. A customer without live membership is turned
 * away here, where it counts, not by a button the frontend chose not to render.
 */
async function resolveUploaderContext(accessUser, accessRole) {
  if (!accessUser) throw new PhotoError("Not authenticated", 401);

  if (accessRole === "admin") {
    return { uploaderType: UPLOADER_TYPE.ADMIN, role: "admin" };
  }

  if (accessRole === "employee") {
    const position = String(accessUser.employeePosition || "");
    if (position !== "Fixter" && position !== "General Fixter") {
      throw new PhotoError("This employee role cannot upload work photos", 403);
    }
    if (accessUser.isActive === false) {
      throw new PhotoError("Employee account is inactive", 403);
    }
    return { uploaderType: UPLOADER_TYPE.FIXTER, role: position };
  }

  if (await hasActiveMembership(accessUser)) {
    return { uploaderType: UPLOADER_TYPE.MEMBER, role: "member" };
  }

  throw new PhotoError("An active membership is required to submit photos", 403);
}

/**
 * May this person attach their photo to this booking?
 *
 * A booking number is a short, guessable string that an uploader types or a
 * client sends, so accepting one on trust lets a member file their photo
 * against somebody else's job - which puts it in front of an admin captioned
 * with a stranger's booking and quietly corrupts the provenance the moderation
 * screen is read from. A member may claim a booking that is theirs; a Fixter,
 * one they were assigned. Admins are not asked, because an admin filing a photo
 * against any booking is the job.
 */
async function assertBookingClaim(bookingNumber, accessUser, uploaderType) {
  const wanted = String(bookingNumber || "").trim();
  if (!wanted) return null;

  const booking = await Booking.findOne({ bookingNumber: wanted })
    .select("_id bookingNumber userId user assignedFixterId")
    .lean();
  if (!booking) throw new PhotoError("That booking number does not exist", 404);

  if (uploaderType === UPLOADER_TYPE.MEMBER) {
    const theirs =
      String(booking.userId || "") === String(accessUser.userId || "") ||
      String(booking.user || "") === String(accessUser._id);
    if (!theirs) throw new PhotoError("That booking is not yours", 403);
  } else if (uploaderType === UPLOADER_TYPE.FIXTER) {
    if (String(booking.assignedFixterId || "") !== String(accessUser._id)) {
      throw new PhotoError("You are not assigned to that booking", 403);
    }
  }

  return booking;
}

/* ------------------------------------------------------------------ */
/* Creating                                                            */
/* ------------------------------------------------------------------ */

function cleanText(value, max) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * Store one file and record it.
 *
 * The image is written to S3 before the row exists, which means a crash between
 * the two leaves objects nothing points at. That is the safer of the two
 * orderings: the alternative leaves a row whose image 404s on the public site.
 * Orphans cost pennies and are swept up; a broken photo on the homepage is
 * visible to customers.
 */
async function createFromBuffer({
  buffer,
  uploader,
  actor,
  fields = {},
  now = new Date(),
}) {
  const stored = await processAndStore(buffer, { now });

  const category = isValidCategory(fields.category) ? fields.category : "general-handyman";
  const publishNow = uploader.uploaderType === UPLOADER_TYPE.ADMIN && fields.publishNow === true;
  const status = initialStatusFor(uploader.uploaderType, { publishNow });

  const doc = {
    title: cleanText(fields.title, 120),
    caption: cleanText(fields.caption, 400),
    category,
    thumb: stored.thumb,
    display: stored.display,
    full: stored.full,
    status,
    uploaderType: uploader.uploaderType,
    uploadedByUserId: actor?.userId || null,
    uploadedByName: cleanText(actor?.name, 120),
    uploadedByRole: uploader.role || "",
    bookingId: fields.bookingId || null,
    bookingNumber: cleanText(fields.bookingNumber, 40),
    customerUserId: fields.customerUserId || null,
    publicLocation: cleanText(fields.publicLocation, 80),
    internalNote: cleanText(fields.internalNote, 500),
    batchId: cleanText(fields.batchId, 64),
    publishAt: status === STATUS.SCHEDULED ? new Date(now.getTime() + FIXTER_PUBLISH_DELAY_MS) : null,
    publishedAt: status === STATUS.PUBLISHED ? now : null,
    firstPublishedAt: status === STATUS.PUBLISHED ? now : null,
  };

  try {
    return await WorkPhoto.create(doc);
  } catch (error) {
    /* No row means nothing will ever reference these objects. Take them back. */
    await purgeStorage(stored).catch(() => {});
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Moving between states                                               */
/* ------------------------------------------------------------------ */

function assertTransition(photo, next) {
  if (!photo) throw new PhotoError("Photo not found", 404);
  if (photo.status === next) return false;
  if (!canTransition(photo.status, next)) {
    throw new PhotoError(`A ${photo.status} photo cannot become ${next}`, 409);
  }
  return true;
}

/**
 * Publish.
 *
 * The update is conditional on the status we read, so two admins tapping
 * Publish on the same photo produce one write and one no-op rather than two
 * writes racing over publishedAt. Same shape as the booking-reminder claims:
 * the filter is the lock.
 */
async function publish(photoId, actor, now = new Date()) {
  const photo = await WorkPhoto.findById(photoId);
  if (!assertTransition(photo, STATUS.PUBLISHED)) return photo;

  const updated = await WorkPhoto.findOneAndUpdate(
    { _id: photo._id, status: photo.status },
    {
      $set: {
        status: STATUS.PUBLISHED,
        publishedAt: now,
        publishAt: null,
        unpublishedAt: null,
        rejectionReason: "",
        reviewedByUserId: actor?.userId || null,
        reviewedByName: cleanText(actor?.name, 120),
        reviewedAt: now,
        ...(photo.firstPublishedAt ? {} : { firstPublishedAt: now }),
      },
    },
    { new: true }
  );
  if (!updated) throw new PhotoError("That photo changed while you were working on it", 409);
  return updated;
}

/** Withdraw from the public site. Keeps everything; this is not a delete. */
async function unpublish(photoId, actor, now = new Date()) {
  const photo = await WorkPhoto.findById(photoId);
  if (!assertTransition(photo, STATUS.LIBRARY)) return photo;

  const updated = await WorkPhoto.findOneAndUpdate(
    { _id: photo._id, status: photo.status },
    {
      $set: {
        status: STATUS.LIBRARY,
        publishedAt: null,
        publishAt: null,
        unpublishedAt: now,
        reviewedByUserId: actor?.userId || null,
        reviewedByName: cleanText(actor?.name, 120),
        reviewedAt: now,
      },
    },
    { new: true }
  );
  if (!updated) throw new PhotoError("That photo changed while you were working on it", 409);
  return updated;
}

/** Refuse a member submission. Must never be a route to visibility. */
async function reject(photoId, actor, reason = "", now = new Date()) {
  const photo = await WorkPhoto.findById(photoId);
  if (!assertTransition(photo, STATUS.REJECTED)) return photo;

  const updated = await WorkPhoto.findOneAndUpdate(
    { _id: photo._id, status: photo.status },
    {
      $set: {
        status: STATUS.REJECTED,
        publishedAt: null,
        publishAt: null,
        rejectionReason: cleanText(reason, 300),
        reviewedByUserId: actor?.userId || null,
        reviewedByName: cleanText(actor?.name, 120),
        reviewedAt: now,
      },
    },
    { new: true }
  );
  if (!updated) throw new PhotoError("That photo changed while you were working on it", 409);
  return updated;
}

/** Edit the public-facing wording. Never touches state. */
async function updateDetails(photoId, patch = {}) {
  const set = {};
  if (patch.title !== undefined) set.title = cleanText(patch.title, 120);
  if (patch.caption !== undefined) set.caption = cleanText(patch.caption, 400);
  if (patch.publicLocation !== undefined) set.publicLocation = cleanText(patch.publicLocation, 80);
  if (patch.internalNote !== undefined) set.internalNote = cleanText(patch.internalNote, 500);
  if (patch.category !== undefined) {
    if (!isValidCategory(patch.category)) throw new PhotoError("Unknown category", 400);
    set.category = patch.category;
  }
  if (patch.featured !== undefined) set.featured = patch.featured === true;
  if (patch.sortOrder !== undefined) set.sortOrder = Number(patch.sortOrder) || 0;

  if (!Object.keys(set).length) throw new PhotoError("Nothing to update", 400);

  const updated = await WorkPhoto.findOneAndUpdate(
    { _id: photoId, deletedAt: null },
    { $set: set },
    { new: true }
  );
  if (!updated) throw new PhotoError("Photo not found", 404);
  return updated;
}

/**
 * Delete: the bytes go, the row stays as a tombstone.
 *
 * Two operations that can fail independently, ordered so neither failure lies.
 * The row is archived first, so the photo leaves every view immediately even if
 * S3 is having a bad afternoon; then the objects are removed. If that second
 * step fails the row keeps deletedAt with no storagePurgedAt, which is exactly
 * what the cleanup sweep looks for. What cannot happen is a row disappearing
 * while its images stay in the bucket forever with nothing pointing at them.
 */
async function remove(photoId, actor, now = new Date()) {
  const photo = await WorkPhoto.findById(photoId);
  if (!photo) throw new PhotoError("Photo not found", 404);
  if (photo.deletedAt) return photo;

  const archived = await WorkPhoto.findOneAndUpdate(
    { _id: photo._id, deletedAt: null },
    {
      $set: {
        status: STATUS.ARCHIVED,
        deletedAt: now,
        deletedByName: cleanText(actor?.name, 120),
        publishedAt: null,
        publishAt: null,
        featured: false,
      },
    },
    { new: true }
  );
  if (!archived) return WorkPhoto.findById(photoId);

  try {
    await purgeStorage(archived);
    archived.storagePurgedAt = new Date();
    archived.storagePurgeError = "";
  } catch (error) {
    archived.storagePurgeError = String(error?.message || "purge failed").slice(0, 300);
  }
  await archived.save();
  return archived;
}

/**
 * Retry storage for rows deleted while S3 was unreachable.
 *
 * Small, bounded, and safe to run on every scheduler tick: it only ever touches
 * rows that already say they are deleted.
 */
async function purgePendingDeletions(limit = 25) {
  const stale = await WorkPhoto.find({ deletedAt: { $ne: null }, storagePurgedAt: null })
    .limit(limit)
    .lean();

  let purged = 0;
  for (const photo of stale) {
    try {
      await purgeStorage(photo);
      await WorkPhoto.updateOne(
        { _id: photo._id },
        { $set: { storagePurgedAt: new Date(), storagePurgeError: "" } }
      );
      purged += 1;
    } catch (error) {
      await WorkPhoto.updateOne(
        { _id: photo._id },
        { $set: { storagePurgeError: String(error?.message || "").slice(0, 300) } }
      );
    }
  }
  return { scanned: stale.length, purged };
}

/**
 * Promote every Fixter upload whose five minutes are up.
 *
 * One conditional updateMany, which is both the work and the lock: a second
 * worker running the same statement a millisecond later matches nothing,
 * because the rows it would have claimed are no longer SCHEDULED. Nothing is
 * held in memory, so a restart mid-sweep loses nothing and a process that was
 * down for an hour simply publishes everything that came due while it was away.
 */
async function publishDueScheduled(now = new Date()) {
  const due = await WorkPhoto.find({
    status: STATUS.SCHEDULED,
    publishAt: { $lte: now },
    deletedAt: null,
  })
    .select("_id firstPublishedAt")
    .limit(200)
    .lean();

  if (!due.length) return { published: 0 };

  const neverPublished = due.filter((p) => !p.firstPublishedAt).map((p) => p._id);
  const previously = due.filter((p) => p.firstPublishedAt).map((p) => p._id);

  let published = 0;
  if (neverPublished.length) {
    const result = await WorkPhoto.updateMany(
      { _id: { $in: neverPublished }, status: STATUS.SCHEDULED },
      { $set: { status: STATUS.PUBLISHED, publishedAt: now, firstPublishedAt: now, publishAt: null } }
    );
    published += result.modifiedCount || 0;
  }
  if (previously.length) {
    const result = await WorkPhoto.updateMany(
      { _id: { $in: previously }, status: STATUS.SCHEDULED },
      { $set: { status: STATUS.PUBLISHED, publishedAt: now, publishAt: null } }
    );
    published += result.modifiedCount || 0;
  }
  return { published };
}

/* ------------------------------------------------------------------ */
/* Projections                                                         */
/* ------------------------------------------------------------------ */

/**
 * What the world sees.
 *
 * AN ALLOWLIST, BUILT FIELD BY FIELD. Not a document with the private parts
 * deleted: that approach silently publishes whatever gets added to the schema
 * next, and the fields next to these are a customer's name and the street their
 * house is on. Anything not written out here cannot leave the building.
 */
function toPublicDTO(photo) {
  return {
    id: String(photo._id),
    title: photo.title || "",
    caption: photo.caption || "",
    category: photo.category || "general-handyman",
    location: photo.publicLocation || "",
    featured: Boolean(photo.featured),
    /*
     * No publishedAt, and no other date.
     *
     * Nothing public rendered it, and a date beside a photograph of
     * somebody's kitchen answers a question nobody asked while quietly
     * dating the gallery: a visitor who sees "March" on the newest picture
     * has learned something about how often we post, not about the work.
     * The timestamps stay on the row for the admin and for auditing.
     */
    thumbUrl: photo.thumb?.url || "",
    imageUrl: photo.display?.url || "",
    fullUrl: photo.full?.url || "",
    width: photo.display?.width || 0,
    height: photo.display?.height || 0,
  };
}

/** What an admin sees: the public fields plus the provenance they moderate on. */
function toAdminDTO(photo) {
  return {
    ...toPublicDTO(photo),
    /* Carried here rather than in the public shape, where it is nobody's business. */
    publishedAt: photo.publishedAt ? new Date(photo.publishedAt).toISOString() : null,
    status: photo.status,
    uploaderType: photo.uploaderType,
    uploadedByName: photo.uploadedByName || "",
    uploadedByRole: photo.uploadedByRole || "",
    bookingNumber: photo.bookingNumber || "",
    internalNote: photo.internalNote || "",
    publishAt: photo.publishAt ? new Date(photo.publishAt).toISOString() : null,
    firstPublishedAt: photo.firstPublishedAt ? new Date(photo.firstPublishedAt).toISOString() : null,
    unpublishedAt: photo.unpublishedAt ? new Date(photo.unpublishedAt).toISOString() : null,
    reviewedByName: photo.reviewedByName || "",
    reviewedAt: photo.reviewedAt ? new Date(photo.reviewedAt).toISOString() : null,
    rejectionReason: photo.rejectionReason || "",
    batchId: photo.batchId || "",
    createdAt: photo.createdAt ? new Date(photo.createdAt).toISOString() : null,
    sourceWidth: photo.full?.width || 0,
    sourceHeight: photo.full?.height || 0,
    bytes: (photo.thumb?.bytes || 0) + (photo.display?.bytes || 0) + (photo.full?.bytes || 0),
  };
}

module.exports = {
  PhotoError,
  assertBookingClaim,
  createFromBuffer,
  hasActiveMembership,
  publish,
  publishDueScheduled,
  purgePendingDeletions,
  reject,
  remove,
  resolveUploaderContext,
  toAdminDTO,
  toPublicDTO,
  unpublish,
  updateDetails,
};
