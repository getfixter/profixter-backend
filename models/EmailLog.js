const mongoose = require("mongoose");

const EmailLogSchema = new mongoose.Schema(
  {
    templateKey: { type: String, default: "", trim: true, index: true },
    subject: { type: String, default: "", trim: true },
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
