const mongoose = require("mongoose");

/**
 * One row per recipient of a queued email campaign.
 *
 * The recipient list is snapshotted when the owner presses Send, so the worker
 * sends to exactly the audience that was confirmed. Each row moves
 * pending -> sending -> sent | failed | skipped, and only a row that is still
 * "pending" can ever be claimed. A row left in "sending" by a worker that died
 * is never retried: it is closed as failed ("interrupted") because the email
 * may already have left. One missed email is recoverable; a duplicate is not.
 */
const EmailCampaignRecipientSchema = new mongoose.Schema(
  {
    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "EmailCampaign", required: true },
    index: { type: Number, required: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    /** The audience row exactly as resolveAudience returned it (merge-tag values). */
    recipient: { type: mongoose.Schema.Types.Mixed, default: {} },
    status: {
      type: String,
      enum: ["pending", "sending", "sent", "failed", "skipped"],
      default: "pending",
    },
    attempts: { type: Number, default: 0 },
    claimedAt: { type: Date, default: null },
    claimedBy: { type: String, default: "" },
    sentAt: { type: Date, default: null },
    providerMessageId: { type: String, default: "" },
    error: { type: String, default: "" },
  },
  { timestamps: true }
);

EmailCampaignRecipientSchema.index({ campaignId: 1, email: 1 }, { unique: true });
EmailCampaignRecipientSchema.index({ campaignId: 1, status: 1, index: 1 });

module.exports = mongoose.model("EmailCampaignRecipient", EmailCampaignRecipientSchema);
