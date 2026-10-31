// 📁 backend/models/Request.js
const mongoose = require("mongoose");

const RequestSchema = new mongoose.Schema({
  // old fields (kept so you do not break existing usage)
  name: { type: String, trim: true },
  email: { type: String, trim: true, lowercase: true },
  password: { type: String, default: "" },
  phone: { type: String, trim: true },
  address: { type: String, trim: true, default: "" },
  city: { type: String, trim: true, default: "" },
  state: { type: String, trim: true, default: "" },
  zip: { type: String, trim: true, default: "" },
  county: { type: String, trim: true, default: "" },

  // new fields for public service-request forms
  message: { type: String, trim: true, default: "" },
  serviceType: {
    type: String,
    trim: true,
    default: "general",
    enum: [
      "general",
      "address_request",
      "on_demand",
      "general_contractor",
      "home_improvement",
      // Somebody on the home page who wants membership explained on the phone.
      // The same Lead record as every other enquiry, so it lands in the one
      // Leads list the admin already works from.
      "membership_interest",
      // The homepage free-visit booker, submitted without an account. It asks
      // for a day and time and reserves that slot as a Booking pending the
      // owner's confirmation (utils/freeVisit/guestVisit).
      "free_visit_request",
      // "Request a Callback" from the Free Visit popup: somebody with a
      // question who wants a person to ring them. Nothing is booked.
      "callback_request",
    ],
  },
  sourcePage: { type: String, trim: true, default: "" },
  status: {
    type: String,
    trim: true,
    default: "new",
    /*
     * A free-visit request's status follows its visit (the Booking it is linked
     * to): pending_confirmation, confirmed, completed, declined, canceled.
     * Those are written by utils/freeVisit/guestVisit and nothing else.
     */
    enum: ["new", "pending_confirmation", "confirmed", "completed", "declined", "canceled", "contacted", "won", "lost"],
  },
  /* The reserved visit this free-visit request is. */
  bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", default: null, index: true },
  /* Why a request could not get a reservation (backfill of older requests). */
  reservationIssue: {
    code: { type: String, default: "" },
    message: { type: String, default: "" },
    at: { type: Date, default: null },
  },

  /*
   * Free-visit requests only (serviceType "free_visit_request"). Every other
   * kind of Request leaves these empty.
   */
  requestedDate: { type: String, trim: true, default: "" }, // YYYY-MM-DD, New York
  requestedTime: { type: String, trim: true, default: "" }, // HH:mm, New York
  requestedAt: { type: Date, default: null },
  images: [{ type: String }],
  libraryReference: { type: String, trim: true, default: "" },
  /* utm_* and click ids as they were on the page URL, plus the stored first touch. */
  attribution: { type: mongoose.Schema.Types.Mixed, default: undefined },
  /*
   * The evidence for texting this person about the visit: the exact line shown
   * next to the button they pressed, when, from where. utils/sms/smsEligibility
   * reads this, and only this, for FREE_VISIT_REQUEST_RECEIVED.
   */
  contactConsent: {
    text: { type: String, default: "" },
    at: { type: Date, default: null },
    ip: { type: String, default: "" },
    userAgent: { type: String, default: "" },
    pageUrl: { type: String, default: "" },
  },
  metaEventId: { type: String, trim: true, default: "" },

  /**
   * Collapses repeat submissions of the same enquiry into one lead.
   *
   * A read-then-write check cannot do this: three taps arrive together, all
   * three read "nothing yet", and all three insert. Only a unique index
   * serialises them, so the key is written on the document and the database
   * refuses the second.
   *
   * Sparse, so every request that does not set one is unaffected, and scoped to
   * a short time window by its caller so a genuine later enquiry still lands.
   */
  dedupeKey: {
    type: String,
    trim: true,
    default: undefined,
  },

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

RequestSchema.index(
  { dedupeKey: 1 },
  { unique: true, sparse: true, name: "request_dedupe_key_idx" }
);

module.exports = mongoose.model("Request", RequestSchema);