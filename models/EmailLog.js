const mongoose = require("mongoose");

const EmailLogSchema = new mongoose.Schema(
  {
    templateKey: { type: String, default: "", trim: true, index: true },
    subject: { type: String, default: "", trim: true },

    /*
     * What the customer actually received, frozen at the moment we sent it.
     *
     * FORWARD-ONLY, AND THE GAP IS PERMANENT.
     *
     * Until these fields existed this collection recorded that an email was
     * sent and what its subject was, but never its content. Those older rows
     * cannot be repaired: the body was rendered, handed to the transport and
     * discarded, and reconstructing one from today's template would be a
     * fabrication that looks exactly like evidence. Admin shows them as
     * "snapshot unavailable" rather than guessing, and `bodySnapshot` being
     * false is what marks them.
     *
     * Kept here rather than derived from the template on read for the same
     * reason SmsMessage stores its body: editing a template tomorrow must not
     * rewrite what somebody was told today.
     */
    bodySnapshot: { type: Boolean, default: false },
    html: { type: String, default: "" },
    text: { type: String, default: "" },
    recipientEmail: { type: String, default: "", lowercase: true, trim: true, index: true },
    recipientName: { type: String, default: "", trim: true },
    customerEmail: { type: String, default: "", lowercase: true, trim: true, index: true },
    customerName: { type: String, default: "", trim: true },
    userId: { type: mongoose.Schema.Types.Mixed, default: null },
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", default: null },
    bookingNumber: { type: String, default: "", trim: true, index: true },
    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "EmailCampaign", default: null },
    campaignNumber: { type: String, default: "", trim: true },
    source: { type: String, default: "", trim: true },
    emailType: { type: String, default: "", trim: true, index: true },
    status: {
      type: String,
      enum: ["sent", "failed"],
      required: true,
      index: true,
    },
    sentAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    provider: { type: String, default: "nodemailer", trim: true },
    providerMessageId: { type: String, default: "", trim: true, index: true },
    providerResponse: { type: String, default: "" },
    errorMessage: { type: String, default: "" },
    errorCode: { type: String, default: "", trim: true },
    responseCode: { type: String, default: "", trim: true },
  },
  { timestamps: true }
);

EmailLogSchema.index({ createdAt: -1 });
EmailLogSchema.index({ userId: 1, createdAt: -1 });
EmailLogSchema.index({ templateKey: 1, createdAt: -1 });
EmailLogSchema.index({ bookingNumber: 1, createdAt: -1 });
EmailLogSchema.index({ customerEmail: 1, createdAt: -1 });
EmailLogSchema.index({ recipientEmail: 1, createdAt: -1 });
EmailLogSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model("EmailLog", EmailLogSchema);
