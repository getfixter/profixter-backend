const mongoose = require("mongoose");

const JarvisCampaignRunSchema = new mongoose.Schema(
  {
    templateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "JarvisCampaignTemplate",
      required: true,
      index: true,
    },
    templateSnapshot: { type: mongoose.Schema.Types.Mixed, required: true },
    status: {
      type: String,
      enum: ["queued", "running", "paused", "completed", "failed", "canceled"],
      default: "queued",
      index: true,
    },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    startedAt: { type: Date, default: null },
    pausedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    nextRunAt: { type: Date, default: null, index: true },
    testMode: { type: Boolean, default: true },
    dryRun: { type: Boolean, default: true },
    currentStepIndex: { type: Number, default: 0 },
    audience: {
      type: { type: String, default: "ghl_tags" },
      tags: { type: [String], default: [] },
      limit: { type: Number, default: 0 },
      contactIds: { type: [String], default: [] },
      previewContacts: { type: [mongoose.Schema.Types.Mixed], default: [] },
      resolvedAt: { type: Date, default: null },
      partial: { type: Boolean, default: false },
      reason: { type: String, trim: true, default: "" },
    },
    stats: {
      leadCount: { type: Number, default: 0 },
      messagesQueued: { type: Number, default: 0 },
      messagesSent: { type: Number, default: 0 },
      messagesSkipped: { type: Number, default: 0 },
      replies: { type: Number, default: 0 },
      appointments: { type: Number, default: 0 },
      escalations: { type: Number, default: 0 },
      stopped: { type: Number, default: 0 },
      errors: { type: Number, default: 0 },
    },
    messageLog: { type: [mongoose.Schema.Types.Mixed], default: [] },
    events: { type: [mongoose.Schema.Types.Mixed], default: [] },
    errors: { type: [mongoose.Schema.Types.Mixed], default: [] },
  },
  {
    timestamps: { createdAt: true, updatedAt: true },
    suppressReservedKeysWarning: true,
  }
);

JarvisCampaignRunSchema.index({ templateId: 1, createdAt: -1 });
JarvisCampaignRunSchema.index({ status: 1, nextRunAt: 1 });

module.exports = mongoose.model("JarvisCampaignRun", JarvisCampaignRunSchema);
