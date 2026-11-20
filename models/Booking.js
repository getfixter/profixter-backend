const mongoose = require('mongoose');

/*
 * A homepage free-visit request is a real Booking from the moment it is made,
 * so its slot is reserved by the same engine as every other visit. Until the
 * owner confirms it, it belongs to nobody's account and has no address yet:
 * those two requirements are lifted for it, and only for it.
 */
function isGuestBooking() {
  return Boolean(this.guestRequestId || this.adminGuest || this.guestCheckout);
}

const BookingSchema = new mongoose.Schema({
  bookingNumber: { type: String, required: true },
  date: { type: Date, required: true },
  service: { type: String, required: true },

  user:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: function () { return !isGuestBooking.call(this); }, default: null },
  userId: { type: String, required: function () { return !isGuestBooking.call(this); }, default: "" },
  name:   { type: String, required: true },

  addressId: { type: mongoose.Schema.Types.ObjectId, default: null },

  // A guest visit gets its address from the owner's call; Confirm Visit requires it.
  address: { type: String, required: function () { return !isGuestBooking.call(this); }, default: "" },
  /* Apartment / unit on its own; `address` still carries it (utils/formatAddress). */
  unit:    { type: String, default: "" },
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
  /*
   * The renovation project this visit belongs to (a site visit, a measure, a
   * project work day). Set and cleared only by the project link endpoints in
   * routes/adminProjectWorkflow.js; null for every ordinary handyman visit.
   */
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: "Project", default: null, index: true },
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

  /*
   * The homepage request this visit came from (models/Request). Set only on
   * guest free visits. While status is "Pending Confirmation" the slot is
   * reserved but the owner has not called yet; isFreeFirstVisit becomes true
   * only when the owner confirms, so nothing that counts booked free visits
   * counts an unconfirmed request.
   */
  guestRequestId: { type: mongoose.Schema.Types.ObjectId, ref: "Request", default: null, index: true },
  /*
   * Booked by Admin for somebody with no account (routes/adminSales.js). The
   * contact fields and address on this booking are the whole record of them.
   * NOT a free first visit and never counted as one: free-visit eligibility
   * reads guestRequestId / isFreeFirstVisit / accessType, none of which this sets.
   */
  adminGuest: { type: Boolean, default: false },
  /*
   * Booked AND paid (One-Time or Full Day) by somebody with no account, on the
   * website (routes/guestBookings.js). Like adminGuest, the contact fields and
   * address here are the whole record of them until somebody proves the phone
   * or email on an account (utils/freeVisit/guestLink), which then links it.
   * Stays true after linking: it says how the visit was booked.
   */
  guestCheckout: { type: Boolean, default: false, index: true },
  /* The Stripe Checkout Session this paid visit was opened with (guest checkouts; the status page reads it). */
  checkoutSessionId: { type: String, default: undefined, index: true, sparse: true },
  /*
   * A paid visit's payment, settled once (routes/webhook.js, 2026-11-19).
   * claimedAt is a short lease: the webhook, a Stripe retry and the hold sweep
   * can all reach the same paid page, and only the one holding the lease
   * records it and sends the emails. declinedCount/lastDeclinedAt count cards
   * Stripe refused while the page stayed open; a decline never cancels.
   */
  /* The browser that booked it (SiteVisitor.visitorId), for a guest's sale to be counted against how they arrived. Random id, nothing personal. */
  siteVisitorId: { type: String, default: undefined, index: true, sparse: true },
  paymentSettlement: {
    sessionId: { type: String, default: "" },
    claimedAt: { type: Date, default: null },
    declinedCount: { type: Number, default: 0 },
    lastDeclinedAt: { type: Date, default: null },
  },
  /* What Stripe charged for a guest checkout (it has no VisitEntitlement): Admin's money block reads it. */
  guestPayment: {
    amountCents: { type: Number, default: null },
    currency: { type: String, default: "" },
    paymentIntentId: { type: String, default: "" },
    paidAt: { type: Date, default: null },
  },
  /* A guest checkout's private link (utils/guestVisitLink): only the token's hash is kept. */
  guestManage: {
    tokenHash: { type: String, default: "", index: true },
    issuedAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },
  },
  /*
   * The customer asked for this visit to be cancelled (from a guest link). A
   * request only: staff cancel it and refund in Stripe, as for every paid visit.
   */
  cancellationRequest: {
    at: { type: Date, default: null },
    reason: { type: String, default: "" },
    via: { type: String, default: "" },
  },
  /* When and how a guest checkout was joined to the account that proved its contact. */
  guestCheckoutLink: {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    linkedAt: { type: Date, default: null },
    linkedVia: { type: String, default: "" },
  },
  /* Who in Admin created this booking, when Admin did. Provenance only. */
  createdByAdmin: {
    by: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    byName: { type: String, default: "" },
    at: { type: Date, default: null },
  },
  /*
   * How a free first visit was asked for. "callback": the homepage request
   * (guestRequestId set, no account, the owner calls). "online": booked by a
   * signed-in customer with their own address. Both wait in "Pending
   * Confirmation" until the owner approves them; empty on every other booking
   * and on free visits made before this field existed.
   */
  freeVisitChannel: { type: String, enum: ["", "online", "callback"], default: "" },
  /*
   * What a free visit is FOR. "consultation" (from 2026-10-30): a free visit
   * to review the customer's to-do list and explain Profixter's services - no
   * labor. Empty on every free visit booked before then, which keeps the
   * 90-minute labor visit it was booked as; nothing rewrites that promise.
   */
  freeVisitPurpose: { type: String, enum: ["", "labor", "consultation"], default: "" },
  /* The browser's id for one press of "Pay" on a paid visit: a retry reopens the same checkout. */
  checkoutClientKey: { type: String, default: undefined, index: true, sparse: true },
  /*
   * The browser's id for one online free-visit submission, so a retried or
   * refreshed submit returns the booking it already made instead of a second
   * one or a refusal. Unique per account; absent everywhere else.
   */
  freeVisitClientKey: { type: String, default: undefined },
  /*
   * Who this free visit was for, frozen when it was claimed. The lifetime rule
   * reads it, so a customer editing their phone or email later cannot make a
   * used free visit disappear. Normalised: E.164 phone, canonical email,
   * street|unit|zip address key.
   */
  freeVisitIdentity: {
    phone: { type: String, default: "" },
    email: { type: String, default: "" },
    addressKey: { type: String, default: "" },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    capturedAt: { type: Date, default: null },
    /* When a guest visit was joined to an account, and from where (utils/freeVisit/guestLink). */
    linkedAt: { type: Date, default: null },
    linkedVia: { type: String, default: "" },
  },
  /* A possible repeat the server could not decide alone: the owner verifies it. */
  freeVisitReview: {
    required: { type: Boolean, default: false },
    reasons: [{ type: String }],
    matches: [{ type: mongoose.Schema.Types.Mixed }],
    checkedAt: { type: Date, default: null },
    acknowledgedAt: { type: Date, default: null },
    acknowledgedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  /*
   * The consent a guest gave by pressing the button under "By booking, you
   * agree to be contacted by call or text about your visit." It covers texts
   * about THIS visit only; see utils/sms/smsEligibility.
   */
  guestContactConsent: {
    text: { type: String, default: "" },
    at: { type: Date, default: null },
    ip: { type: String, default: "" },
  },
  /* The owner's confirmation, and the one-time claim on its notifications. */
  freeVisitConfirmation: {
    confirmedAt: { type: Date, default: null },
    confirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    notifyClaimedAt: { type: Date, default: null },
    declinedAt: { type: Date, default: null },
    declineReason: { type: String, default: "" },
  },


  note: { type: String, default: "" },
  adminNote: { type: String, default: "" },

  images: [{ type: String }],
  // A Profixter Library example the customer chose instead of (or before)
  // sending real photos: a key from utils/bookingLibrary.js, never an image
  // URL. Empty on every booking that did not use the library.
  libraryReference: { type: String, trim: true, default: "" },
  /* Booked by the Stripe webhook from a membership first-visit draft (utils/membershipFirstVisitFulfillment). */
  firstVisitDraftId: { type: mongoose.Schema.Types.ObjectId, default: undefined },
  /*
   * A free visit the customer paid to turn into a membership or One-Time
   * visit (utils/freeVisit/conversion.js). The booking, its time, reservation,
   * Fixter, notes and photos stay as they were; only what the visit IS
   * changes, and only once the payment is confirmed. `from` is the free visit
   * as it stood, kept for history. guestRequestId stays: the lead, the
   * lifetime free-visit rule and guest texting still read it.
   */
  freeVisitConversion: {
    type: {
      conversionId: { type: mongoose.Schema.Types.ObjectId, ref: "FreeVisitConversion" },
      kind: { type: String, enum: ["membership", "one_time"] },
      convertedAt: Date,
      plan: String,
      billingCycle: String,
      leadTimeRule: String,
      stripeCheckoutSessionId: String,
      from: {
        accessType: String,
        bookingType: String,
        subscription: String,
        service: String,
        selectedTask: String,
        status: String,
        paymentState: String,
        isFreeFirstVisit: Boolean,
        freeVisitChannel: String,
        freeVisitPurpose: String,
      },
    },
    default: undefined,
  },
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

  /*
   * Internal staff notes (2026-11-12): append-only, never shown to the
   * customer, never edited or removed through the API. Separate from
   * adminNote, the single free-text field the old Admin edits in place.
   * select:false so no existing query (customer routes included) can return
   * them by accident; the Admin job detail asks for them explicitly.
   */
  staffNotes: {
    type: [
      {
        text: { type: String, required: true, maxlength: 2000 },
        authorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        authorName: { type: String, default: "" },
        authorRole: { type: String, default: "" },
        at: { type: Date, default: Date.now },
      },
    ],
    select: false,
    default: undefined,
  },

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

  /*
   * The close-the-job nudge to the assigned Fixter, two hours after the visit
   * was due to start.
   *
   * Same claim shape as the customer reminders above, and for the same reason:
   * QueuedAt is a lock held while a send is in flight, SentAt is the record that
   * one went out, SkippedAt is a terminal decision not to send with a reason
   * beside it. Nothing here is derived from a stored due time - it comes from
   * date - so moving the appointment moves the nudge with it.
   *
   * This one is internal. It never reaches the customer, and it never changes
   * the booking's status: an unclosed job is a person to prompt, not a record
   * to quietly rewrite.
   */
  fixterCloseReminderQueuedAt: { type: Date },
  fixterCloseReminderSentAt: { type: Date },
  fixterCloseReminderSkippedAt: { type: Date },
  fixterCloseReminderSkipReason: { type: String, default: "" },
  fixterCloseReminderAttempts: { type: Number, default: 0 },
  fixterCloseReminderLastError: { type: String, default: "" },
  fixterCloseReminderMessageId: { type: String, default: "" },

  // Delayed post-completion review request tracking.
  completedAt: { type: Date, default: null },
  reviewRequestQueuedAt: { type: Date, default: null },
  reviewRequestSentAt: { type: Date, default: null },
  reviewRequestLockExpiresAt: { type: Date, default: null },
  reviewRequestSkippedAt: { type: Date, default: null },
  // Why it was skipped: customer_cooldown, reviewed_us, too_old (jobs/bookingReviewRequests.js).
  reviewRequestSkipReason: { type: String, default: "" },

}, { timestamps: true });

/* Useful indexes */
BookingSchema.index({ user: 1, addressId: 1, date: 1, status: 1 });
BookingSchema.index({ date: 1 });
BookingSchema.index({ assignedFixterId: 1, date: 1 });
BookingSchema.index({ bookingNumber: 1 }, { unique: false });
BookingSchema.index({ "freeVisitIdentity.phone": 1 });
BookingSchema.index({ "freeVisitIdentity.email": 1 });
BookingSchema.index(
  { user: 1, freeVisitClientKey: 1 },
  { unique: true, partialFilterExpression: { freeVisitClientKey: { $type: "string" } }, name: "free_visit_client_key_unique" }
);
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
BookingSchema.index({
  status: 1,
  date: 1,
  fixterCloseReminderSentAt: 1,
  fixterCloseReminderSkippedAt: 1,
});

module.exports = mongoose.model('Booking', BookingSchema);
