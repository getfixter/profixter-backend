const mongoose = require("mongoose");

/**
 * Turning one free visit into a paid visit (utils/freeVisit/conversion.js).
 *
 * Admin chooses Membership (plan + billing) or One-Time and makes a payment
 * link; the customer pays it themselves at Stripe. Only when Stripe confirms
 * the payment is the booking itself changed - in place, keeping its id, time,
 * reservation, Fixter, notes and photos. Until then the free visit is exactly
 * as it was.
 *
 *   open             link made (maybe sent), not paid; a Stripe page may be open
 *   paid             Stripe confirmed the payment; the booking is about to change
 *   converting       one caller is changing the booking (claim; stale after 10 min)
 *   converted        done: the booking is the paid visit; one confirmation sent
 *   needs_attention  paid, but the booking could not be changed safely; the
 *                    customer and the owner were told, the visit is unchanged
 *   closed           a needs_attention payment the owner settled by hand, with
 *                    a resolution checked with Stripe (see `resolution`)
 *   expired          the link ran out unpaid
 *   canceled         Admin withdrew the link, or a newer link replaced it
 *
 * At most one LIVE conversion per booking (index below): a second link while
 * one is open replaces it; while one is paid or needs attention, none.
 */
const LIVE_STATUSES = ["open", "paid", "converting", "needs_attention"];

const FreeVisitConversionSchema = new mongoose.Schema(
  {
    booking: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", required: true, index: true },
    bookingNumber: { type: String, default: "" },
    kind: { type: String, enum: ["membership", "one_time"], required: true },
    plan: { type: String, default: "" },
    billingCycle: { type: String, default: "" },
    /* What the visit will be called once paid (its selectedTask). The customer's own notes are never touched. */
    task: { type: String, default: "" },
    priceCents: { type: Number, default: null },

    /* The account that pays. Required for a membership; a guest's One-Time visit has none. */
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    addressId: { type: mongoose.Schema.Types.ObjectId, default: null },
    /* How the account was settled when the link was made: already on it, linked by Admin, or created by Admin. */
    accountSource: { type: String, enum: ["", "booking", "linked", "created", "customer"], default: "" },
    /*
     * Who started it: Admin (a payment link it made and may send), or the
     * customer from their own visit card, signed in (no link: their own
     * Stripe page). Everything after the payment is the same code.
     */
    source: { type: String, enum: ["admin", "customer"], default: "admin" },
    /* The 20% first-payment offer was on this conversion's Stripe page (customer-started memberships only). */
    welcomeOfferApplied: { type: Boolean, default: false },
    contact: {
      name: { type: String, default: "" },
      email: { type: String, default: "" },
      phone: { type: String, default: "" },
    },

    /* The visit as it was when the link was made. A payment only converts a visit that still matches. */
    snapshot: {
      date: { type: Date, default: null },
      status: { type: String, default: "" },
      slotReservationId: { type: mongoose.Schema.Types.ObjectId, default: null },
      assignedFixterId: { type: mongoose.Schema.Types.ObjectId, default: null },
      freeVisitChannel: { type: String, default: "" },
      addressKey: { type: String, default: "" },
      /* The account the visit was on (null for a guest): a payment never moves a visit off an account it was linked to meanwhile. */
      user: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    },

    /*
     * The member seven-day rule for this visit (memberships only):
     *   none                    the visit is 7+ days out
     *   first_visit_exemption   a new membership's first visit (the existing rule, utils/membershipFirstVisit)
     *   admin_override          Admin overrode it, with a reason (by, at, reason recorded)
     */
    leadTime: {
      rule: { type: String, enum: ["", "none", "first_visit_exemption", "admin_override"], default: "" },
      earliestMemberDate: { type: String, default: "" },
      override: {
        by: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        byName: { type: String, default: "" },
        at: { type: Date, default: null },
        reason: { type: String, default: "" },
      },
    },

    status: { type: String, enum: ["open", "paid", "converting", "converted", "needs_attention", "closed", "expired", "canceled"], default: "open", index: true },
    link: { type: mongoose.Schema.Types.ObjectId, ref: "AdminPaymentLink", default: null },
    linkExpiresAt: { type: Date, default: null },

    /* The Stripe page currently open for this link (reused on a second press), and every page ever opened. */
    checkout: {
      sessionId: { type: String, default: "" },
      url: { type: String, default: "" },
      expiresAt: { type: Date, default: null },
      openingUntil: { type: Date, default: null },
    },
    sessionIds: { type: [String], default: [] },

    /* What the customer agreed to before the Stripe page opened. */
    terms: {
      acceptedAt: { type: Date, default: null },
      version: { type: String, default: "" },
      text: { type: String, default: "" },
      /* "regular" or "welcome": the price wording the customer was shown and accepted. */
      variant: { type: String, default: "" },
      ipHash: { type: String, default: "" },
      userAgent: { type: String, default: "" },
    },

    payment: {
      sessionId: { type: String, default: "" },
      paidAt: { type: Date, default: null },
      amountCents: { type: Number, default: null },
      currency: { type: String, default: "" },
      paymentIntentId: { type: String, default: "" },
      stripeSubscriptionId: { type: String, default: "" },
      subscriptionId: { type: mongoose.Schema.Types.ObjectId, ref: "Subscription", default: null },
      entitlementId: { type: mongoose.Schema.Types.ObjectId, ref: "VisitEntitlement", default: null },
      /* Further paid Stripe pages for this conversion (a double payment): recorded, the owner told once each, never converted. */
      extraSessionIds: { type: [String], default: [] },
    },

    attempts: { type: Number, default: 0 },
    convertingAt: { type: Date, default: null },
    convertedAt: { type: Date, default: null },
    attention: {
      reason: { type: String, default: "" },
      message: { type: String, default: "" },
      at: { type: Date, default: null },
    },
    /*
     * The converted visit was later canceled by Admin (declined, say). The
     * payment and - for a membership - the subscription it started are NOT
     * touched by that: they stay under Needs action until Admin records what
     * was done (utils/freeVisit/paymentResolution.js). Reinstating the visit
     * resolves it as "visit_reinstated".
     */
    afterCancel: {
      at: { type: Date, default: null },
      by: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      byName: { type: String, default: "" },
      reason: { type: String, default: "" },
      bookingStatusBefore: { type: String, default: "" },
      resolvedAt: { type: Date, default: null },
    },
    /*
     * How a paid conversion's money was settled by hand (a "needs attention"
     * close, or after the visit was canceled). Checked with Stripe when
     * recorded: a refund must show in Stripe; "membership canceled" needs a
     * subscription that will not bill again. Never done automatically.
     *   refunded | kept                           (One-Time)
     *   membership_canceled | membership_kept     (membership)
     *   visit_reinstated                          (the canceled visit came back)
     */
    resolution: {
      kind: { type: String, default: "" },
      for: { type: String, default: "" },
      note: { type: String, default: "" },
      at: { type: Date, default: null },
      by: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      byName: { type: String, default: "" },
      /* Membership: Admin's own statement that the first payment was refunded in Stripe (not read from Stripe). */
      firstPaymentRefunded: { type: Boolean, default: null },
      /* What Stripe showed when it was recorded. */
      verified: { type: mongoose.Schema.Types.Mixed, default: null },
    },
    /* Each notice is claimed once, before it is sent: replays and retries cannot send it twice. */
    notices: {
      customerConvertedAt: { type: Date, default: null },
      adminConvertedAt: { type: Date, default: null },
      customerAttentionAt: { type: Date, default: null },
      adminAttentionAt: { type: Date, default: null },
    },
    /* Which channels the link was sent by (once each). */
    sends: [
      {
        channel: { type: String, enum: ["email", "sms"] },
        to: { type: String, default: "" },
        result: { type: String, default: "" },
        at: { type: Date, default: null },
        by: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        byName: { type: String, default: "" },
      },
    ],
    history: [
      {
        at: { type: Date, default: Date.now },
        event: { type: String, required: true },
        by: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        byName: { type: String, default: "" },
        detail: { type: mongoose.Schema.Types.Mixed, default: null },
      },
    ],
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    createdByName: { type: String, default: "" },
  },
  { timestamps: true }
);

FreeVisitConversionSchema.index(
  { booking: 1 },
  { unique: true, name: "free_visit_conversion_one_live_per_booking", partialFilterExpression: { status: { $in: LIVE_STATUSES } } }
);
FreeVisitConversionSchema.index({ status: 1, updatedAt: 1 });
FreeVisitConversionSchema.index({ "afterCancel.at": 1, "afterCancel.resolvedAt": 1 }, { partialFilterExpression: { "afterCancel.at": { $type: "date" } } });

const FreeVisitConversion = mongoose.model("FreeVisitConversion", FreeVisitConversionSchema);
FreeVisitConversion.LIVE_STATUSES = LIVE_STATUSES;
module.exports = FreeVisitConversion;
