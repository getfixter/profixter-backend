const mongoose = require('mongoose');

const BookingSchema = new mongoose.Schema({
  bookingNumber: { type: String, required: true },
  date: { type: Date, required: true },
  service: { type: String, required: true },

  user:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  userId: { type: String, required: true },
  name:   { type: String, required: true },

  addressId: { type: mongoose.Schema.Types.ObjectId, default: null },

  address: { type: String, required: true, default: "" },
  city:    { type: String, default: "" },
  state:   { type: String, default: "" },
  zip:     { type: String, default: "" },
  county:  { type: String, default: "" },

  phone: { type: String, required: true },
  email: { type: String, required: true }, 

  // kept for display/legacy; not used for gating after create
  subscription: { type: String, required: true },
  accessType: {
    type: String,
    enum: ["membership", "one_time", "free_first_visit", "admin"],
    default: "membership",
    index: true,
  },
  bookingType: {
    type: String,
    // full_day_visit reserves a Fixter's whole configured workday rather than
    // a single slot. Everything else about the record is unchanged, which is
    // what lets it flow through history, reminders and Admin untouched.
    enum: ["membership_visit", "one_time_handyman_visit", "full_day_visit"],
    default: "membership_visit",
    index: true,
  },
  paymentState: {
    type: String,
    enum: ["not_required", "pending", "paid", "failed", "expired", "refunded"],
    default: "not_required",
    index: true,
  },
  entitlementId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "VisitEntitlement",
    default: null,
    index: true,
  },
  selectedTask: { type: String, trim: true, default: "" },
  paymentHoldExpiresAt: { type: Date, default: null, index: true },
  reservationIssue: {
    status: { type: String, default: "" },
    message: { type: String, default: "" },
    code: { type: String, default: "" },
    stripeCheckoutSessionId: { type: String, default: "" },
    holdExpiresAt: { type: Date, default: null },
    occurredAt: { type: Date, default: null },
  },
    // ✅ Free first visit tracking (per address)
  isFreeFirstVisit: { type: Boolean, default: false },
  freeFirstVisitClaimedAt: { type: Date, default: null },


  note: { type: String, default: "" },
  adminNote: { type: String, default: "" },

  images: [{ type: String }],
  contentUpdates: [
    {
      actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      actorName: { type: String, default: "" },
      actorEmail: { type: String, default: "" },
      actorRole: { type: String, enum: ["admin", "employee", "customer", "system"], default: "system" },
      source: { type: String, enum: ["admin", "customer"], required: true },
      noteAdded: { type: String, default: "" },
      imagesAdded: [{ type: String }],
      createdAt: { type: Date, default: Date.now },
    },
  ],

  status: { type: String, default: "Pending" }, // Pending | Confirmed | Completed | Canceled | ...
  statusHistory: [{ status: String, date: Date }],
  cancellationReason: { type: String },
  paymentStatus: { type: String },
  feedback: { type: String },
  assignedHandyman: { type: String },
  assignedFixterId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null,
    index: true,
  },
  assignedFixterName: { type: String, default: "" },
  assignedFixterEmail: { type: String, default: "" },
  assignedFixterPosition: {
    type: String,
    enum: ["Fixter", "General Fixter", ""],
    default: "",
  },
  scheduledStart: { type: Date, default: null, index: true },
  scheduledEnd: { type: Date, default: null },
  slotReservationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "BookingSlotReservation",
    default: null,
    index: true,
  },
  assignmentSource: {
    type: String,
    enum: ["", "automatic", "admin", "general_fixter", "backfill", "system"],
    default: "",
  },

  /*
   * Reminder state.
   *
   * QueuedAt is a lock held while a send is in flight, SentAt is the record of
   * success, SkippedAt records a deliberate abandonment with a reason. Attempts
   * and LastError exist so a repeatedly failing address is visible and bounded
   * rather than retried until the appointment. MessageId is the provider's
   * receipt, kept for operational tracing and never shown to a customer.
   *
   * There is no stored "due at": it is derived from date, so a reschedule moves
   * both reminders automatically and cannot leave a stale due time behind.
   */
  reminder24hQueuedAt: { type: Date },
  reminder24hSentAt:   { type: Date },
  reminder24hSkippedAt: { type: Date },
  reminder24hSkipReason: { type: String, default: "" },
  reminder24hAttempts: { type: Number, default: 0 },
  reminder24hLastError: { type: String, default: "" },
  reminder24hMessageId: { type: String, default: "" },
  /*
   * The SMS channel, tracked separately from the email.
   *
   * These are two independent deliveries that happen to be ordered, and one
   * field cannot represent both: if it did, a failed CRM tag would either be
   * silently lost or would force the email to be sent a second time to retry
   * it. This is the same mistake that let an unrelated SMS process claim
   * reminder24hSentAt and suppress the email entirely.
   */
  reminder24hTagAt: { type: Date, default: null },
  reminder24hTagAttempts: { type: Number, default: 0 },
  reminder24hTagError: { type: String, default: "" },
  reminder60mQueuedAt: { type: Date },
  reminder60mSentAt:   { type: Date },
  reminder60mSkippedAt: { type: Date },
  reminder60mSkipReason: { type: String, default: "" },
  reminder60mAttempts: { type: Number, default: 0 },
  reminder60mLastError: { type: String, default: "" },
  reminder60mMessageId: { type: String, default: "" },
  reminder60mTagAt: { type: Date, default: null },
  reminder60mTagAttempts: { type: Number, default: 0 },
  reminder60mTagError: { type: String, default: "" },

  // Delayed post-completion review request tracking.
  completedAt: { type: Date, default: null },
  reviewRequestQueuedAt: { type: Date, default: null },
  reviewRequestSentAt: { type: Date, default: null },
  reviewRequestLockExpiresAt: { type: Date, default: null },
  reviewRequestSkippedAt: { type: Date, default: null },

}, { timestamps: true });

/* Useful indexes */
BookingSchema.index({ user: 1, addressId: 1, date: 1, status: 1 });
BookingSchema.index({ date: 1 });
BookingSchema.index({ assignedFixterId: 1, date: 1 });
BookingSchema.index({ bookingNumber: 1 }, { unique: false });
BookingSchema.index({
  status: 1,
  completedAt: 1,
  reviewRequestSentAt: 1,
  reviewRequestLockExpiresAt: 1,
});

/*
 * The two reminder sweeps run every minute and select on exactly these fields.
 * Without an index each cycle is a collection scan that grows with every
 * booking ever taken, which is the sort of cost that only shows up as a slow
 * cycle long after it started mattering.
 */
BookingSchema.index({ status: 1, date: 1, reminder24hSentAt: 1, reminder24hSkippedAt: 1 });
BookingSchema.index({ status: 1, date: 1, reminder60mSentAt: 1, reminder60mSkippedAt: 1 });

module.exports = mongoose.model('Booking', BookingSchema);
