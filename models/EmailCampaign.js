const mongoose = require("mongoose");

const RecipientResultSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    status: {
      type: String,
      enum: ["sent", "failed", "skipped"],
      required: true,
    },
    providerMessageId: { type: String, default: "" },
    error: { type: String, default: "" },
  },
  { _id: false }
);

const EmailCampaignSchema = new mongoose.Schema(
  {
    campaignNumber: { type: String, required: true, unique: true, index: true },
    subject: { type: String, required: true },
    body: { type: String, required: true },
    ctaText: { type: String, default: "" },
    ctaUrl: { type: String, default: "" },
    selectedSegment: {
      type: String,
      required: true,
      enum: ["all", "subscribed", "not_subscribed", "basic", "plus", "premium", "elite"],
      index: true,
    },
    resolvedRecipientCount: { type: Number, default: 0 },
    sentCount: { type: Number, default: 0 },
    failedCount: { type: Number, default: 0 },
    skippedCount: { type: Number, default: 0 },
    adminCopySent: { type: Boolean, default: false },
    actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    actorName: { type: String, default: "" },
    actorEmail: { type: String, default: "" },
    status: {
      type: String,
      enum: ["queued", "sending", "completed", "completed_with_errors", "failed"],
      default: "queued",
      index: true,
    },
    errorsSummary: { type: [String], default: [] },
    recipientResults: { type: [RecipientResultSchema], default: [] },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    /*
     * Durable background sending (jobs/campaignSender). The request queues the
     * campaign and snapshots its recipients (models/EmailCampaignRecipient);
     * a worker holding the lease sends them. A lease that runs out (crash,
     * deploy) lets the next worker resume without resending.
     */
    idempotencyKey: { type: String, default: undefined, trim: true },
    excludedCount: { type: Number, default: 0 },
    totalRecipients: { type: Number, default: 0 },
    leaseOwner: { type: String, default: "" },
    leaseUntil: { type: Date, default: null },
    lastProgressAt: { type: Date, default: null },
  },
  { timestamps: true }
);

EmailCampaignSchema.index(
  { idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } }
);
EmailCampaignSchema.index({ status: 1, leaseUntil: 1 });

module.exports = mongoose.model("EmailCampaign", EmailCampaignSchema);
