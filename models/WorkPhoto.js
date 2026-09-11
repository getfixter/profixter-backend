const mongoose = require("mongoose");
const {
  ALL_STATUSES,
  ALL_UPLOADER_TYPES,
  CATEGORY_SLUGS,
  STATUS,
} = require("../utils/recentWork/workPhotoStates");

/**
 * One photograph of real work, on its way to (or already on) the public site.
 *
 * TWO HALVES, AND THE SEPARATION IS THE POINT.
 *
 * The top of this schema is what the world may see: a title, a caption, a
 * category, three image URLs. The bottom is ours: who uploaded it, which
 * booking it came from, which customer's home it is, who approved it. The
 * public API projects only the first half, and it does so from an explicit
 * allowlist rather than by deleting fields from a document - because a
 * blacklist forgets the field somebody adds next year, and the cost of
 * forgetting here is a customer's address on the homepage.
 *
 * RECENT WORK OWNS ITS IMAGES. Every row points at objects created for it,
 * under its own prefix, even when the photo started life on a booking. So
 * deleting one can never reach through a shared URL and remove an operational
 * booking photo somebody still needs.
 */
const VariantSchema = new mongoose.Schema(
  {
    key: { type: String, default: "", trim: true },
    url: { type: String, default: "", trim: true },
    width: { type: Number, default: 0 },
    height: { type: Number, default: 0 },
    bytes: { type: Number, default: 0 },
  },
  { _id: false }
);

const WorkPhotoSchema = new mongoose.Schema(
  {
    /* ----------------------------- public ----------------------------- */
    title: { type: String, default: "", trim: true, maxlength: 120 },
    caption: { type: String, default: "", trim: true, maxlength: 400 },
    category: {
      type: String,
      default: "general-handyman",
      trim: true,
      enum: CATEGORY_SLUGS,
      index: true,
    },
    /*
     * Three sizes, no original. A 12MP camera file is worse than useless on a
     * marketing page, and it is also the only copy carrying EXIF - so not
     * keeping it is a privacy decision as much as a storage one.
     */
    thumb: { type: VariantSchema, default: () => ({}) },
    display: { type: VariantSchema, default: () => ({}) },
    full: { type: VariantSchema, default: () => ({}) },

    /* ------------------------------ state ----------------------------- */
    /* No index:true - status leads three compound indexes below. */
    status: {
      type: String,
      required: true,
      enum: ALL_STATUSES,
      default: STATUS.LIBRARY,
    },
    /** When a SCHEDULED photo becomes public. Null for every other status. */
    publishAt: { type: Date, default: null },
    /** Currently-public since. Cleared on unpublish. */
    publishedAt: { type: Date, default: null },
    /** The first time it ever went public. Never cleared: it is history. */
    firstPublishedAt: { type: Date, default: null },
    unpublishedAt: { type: Date, default: null },

    featured: { type: Boolean, default: false, index: true },
    /**
     * Manual ordering, smaller first. Phase 1 leaves this at 0 for everything
     * and orders by featured + recency; the field exists so a future curated
     * running order does not need a migration.
     */
    sortOrder: { type: Number, default: 0 },

    /* ---------------------------- internal ---------------------------- */
    uploaderType: {
      type: String,
      required: true,
      enum: ALL_UPLOADER_TYPES,
      index: true,
    },
    uploadedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    uploadedByName: { type: String, default: "", trim: true },
    uploadedByRole: { type: String, default: "", trim: true },

    /** Optional provenance. Never projected publicly, in any form. */
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", default: null, index: true },
    bookingNumber: { type: String, default: "", trim: true, index: true },
    customerUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    /**
     * A LOCALITY, AND ONLY A LOCALITY. "Babylon, NY". Never a street number, a
     * street name, a unit, a ZIP or a coordinate.
     *
     * It is typed by an admin and nothing derives it. In particular nothing
     * copies it from the booking this photo came from, even though that booking
     * is one field away and has a perfectly good city on it: the moment an
     * address field can flow into a public one by default, the only thing
     * standing between a customer's front door and the homepage is whoever
     * wrote the copying code being careful that day. If we ever do suggest the
     * town from a booking it will be booking.city alone, explicitly, and still
     * only as a suggestion an admin confirms.
     */
    publicLocation: { type: String, default: "", trim: true, maxlength: 80 },
    internalNote: { type: String, default: "", trim: true, maxlength: 500 },

    /* --------------------------- moderation --------------------------- */
    reviewedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    reviewedByName: { type: String, default: "", trim: true },
    reviewedAt: { type: Date, default: null },
    rejectionReason: { type: String, default: "", trim: true, maxlength: 300 },

    /* ---------------------------- deletion ---------------------------- */
    /* Leads the deletedAt+storagePurgedAt index below; no singleton needed. */
    deletedAt: { type: Date, default: null },
    deletedByName: { type: String, default: "", trim: true },
    /**
     * Set once the S3 objects are actually gone. A row with deletedAt but no
     * storagePurgedAt is the one case a sweep must retry: the record says
     * deleted while the bytes are still sitting in the bucket.
     */
    storagePurgedAt: { type: Date, default: null },
    storagePurgeError: { type: String, default: "", trim: true },

    /** Groups photos uploaded together, so a multi-photo job reads as one job. */
    batchId: { type: String, default: "", trim: true, index: true },
  },
  { timestamps: true }
);

/* The public query: status + ordering. */
WorkPhotoSchema.index({ status: 1, featured: -1, sortOrder: 1, publishedAt: -1 });
/* The scheduler: everything due, cheaply. */
WorkPhotoSchema.index({ status: 1, publishAt: 1 });
/* Admin library browsing and counts. */
WorkPhotoSchema.index({ status: 1, createdAt: -1 });
WorkPhotoSchema.index({ deletedAt: 1, storagePurgedAt: 1 });

module.exports = mongoose.models.WorkPhoto || mongoose.model("WorkPhoto", WorkPhotoSchema);
