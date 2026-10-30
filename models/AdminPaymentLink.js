const mongoose = require("mongoose");

/**
 * A payment link Admin sent: profixter.com/pay/<token>.
 *
 * The link is ours, not Stripe's, on purpose. A Stripe Checkout page lives at
 * most 24 hours and is fixed the moment it is made; this link opens a FRESH
 * checkout each time it is used, after asking again whether it is still safe
 * to - so a membership link can never bill a home that has bought one since,
 * and a link opened tomorrow still works.
 *
 * Only a hash of the token is stored. The plain token exists in the message
 * sent to the customer and nowhere else.
 */
const AdminPaymentLinkSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true, unique: true },
    kind: { type: String, enum: ["membership", "one_time", "full_day"], required: true },

    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    addressId: { type: mongoose.Schema.Types.ObjectId, default: null },
    plan: { type: String, default: "" },
    billingCycle: { type: String, default: "" },
    booking: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", default: null, index: true },

    itemLabel: { type: String, default: "" },
    status: { type: String, enum: ["open", "paid", "expired", "canceled"], default: "open", index: true },
    expiresAt: { type: Date, required: true },

    sentVia: { type: [String], default: [] },
    sentTo: { email: { type: String, default: "" }, phone: { type: String, default: "" } },
    delivery: { email: { type: String, default: "" }, sms: { type: String, default: "" } },

    lastSessionId: { type: String, default: "" },
    openedCount: { type: Number, default: 0 },
    lastOpenedAt: { type: Date, default: null },
    paidAt: { type: Date, default: null },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    createdByName: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.models.AdminPaymentLink || mongoose.model("AdminPaymentLink", AdminPaymentLinkSchema);
