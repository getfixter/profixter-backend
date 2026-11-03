const mongoose = require("mongoose");

/*
 * The first visit of a membership, booked before paying (2026-11-03), kept on
 * the server so it is booked when Stripe confirms the payment - whether or not
 * the customer ever comes back to the website.
 * utils/membershipFirstVisitFulfillment.js owns every transition:
 *
 *   draft -> checkout_open -> paid -> fulfilling -> booked
 *                          \-> expired (the page lapsed unpaid; photos deleted)
 *   fulfilling -> needs_admin  (the time was gone, or it could not be booked
 *                               after retries: Admin is told and the customer
 *                               can pick another time; the exemption is kept)
 *   needs_admin -> rebooked    (the customer booked another time themselves)
 *
 * Nothing here is a booking until `booked`; the Booking it made carries
 * firstVisitDraftId back to this record.
 */
const MembershipFirstVisitDraftSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    userId: { type: String, default: "" },
    addressId: { type: mongoose.Schema.Types.ObjectId, required: true },
    service: { type: String, default: "", trim: true },
    note: { type: String, default: "" },
    images: { type: [String], default: [] },
    s3Keys: { type: [String], default: [] },
    requestedDate: { type: String, required: true },
    requestedTime: { type: String, required: true },
    slotStart: { type: Date, required: true },
    holdId: { type: String, default: "" },
    checkoutSessionId: { type: String, default: null, index: true },
    status: {
      type: String,
      enum: ["draft", "checkout_open", "paid", "fulfilling", "booked", "needs_admin", "rebooked", "expired"],
      default: "draft",
      index: true,
    },
    subscriptionId: { type: mongoose.Schema.Types.ObjectId, ref: "Subscription", default: null, index: true },
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", default: null },
    paidAt: { type: Date, default: null },
    fulfillingAt: { type: Date, default: null },
    bookedAt: { type: Date, default: null },
    attempts: { type: Number, default: 0 },
    failureReason: { type: String, default: "" },
    adminNotifiedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

MembershipFirstVisitDraftSchema.index({ status: 1, updatedAt: 1 });

module.exports = mongoose.model("MembershipFirstVisitDraft", MembershipFirstVisitDraftSchema);
