const mongoose = require("mongoose");

const CampaignMessageStepSchema = new mongoose.Schema(
  {
    stepId: { type: String, required: true, trim: true },
    channel: { type: String, enum: ["sms", "email"], default: "sms" },
    subject: { type: String, trim: true, default: "" },
    body: { type: String, required: true, trim: true },
    waitDelay: {
      amount: { type: Number, default: 0 },
      unit: { type: String, enum: ["minutes", "hours", "days"], default: "minutes" },
      seconds: { type: Number, default: 0 },
    },
    enabled: { type: Boolean, default: true },
  },
  { _id: false }
);

const CampaignAudienceSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["ghl_tags", "smart_list", "uploaded_csv", "custom_query"],
      default: "ghl_tags",
    },
    tags: { type: [String], default: [] },
    smartListId: { type: String, trim: true, default: "" },
    uploadBatchId: { type: String, trim: true, default: "" },
    files: { type: [mongoose.Schema.Types.Mixed], default: [] },
    filters: { type: mongoose.Schema.Types.Mixed, default: {} },
    limit: { type: Number, default: 0 },
    testMode: { type: Boolean, default: true },
  },
  { _id: false }
);

const JarvisCampaignTemplateSchema = new mongoose.Schema(
  {
    campaignName: { type: String, required: true, trim: true, index: true },
    description: { type: String, trim: true, default: "" },
    audienceDefinition: { type: CampaignAudienceSchema, default: () => ({}) },
    messageSteps: { type: [CampaignMessageStepSchema], default: [] },
    stopConditions: { type: mongoose.Schema.Types.Mixed, default: {} },
    replyHandlingRules: { type: mongoose.Schema.Types.Mixed, default: {} },
    aiQualificationPrompt: { type: String, trim: true, default: "" },
    outcomeTags: { type: [String], default: [] },
    appointmentBookingRules: { type: mongoose.Schema.Types.Mixed, default: {} },
    ownerNotificationRules: { type: mongoose.Schema.Types.Mixed, default: {} },
    testMode: { type: Boolean, default: true },
    approvalBeforeSending: { type: Boolean, default: true },
    status: {
      type: String,
      enum: ["draft", "approved", "running", "paused", "completed", "archived"],
      default: "draft",
      index: true,
    },
    source: {
      createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
      originalMessage: { type: String, trim: true, default: "" },
      confirmationId: { type: String, trim: true, default: "" },
      createdByJarvis: { type: Boolean, default: true },
    },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    approvedAt: { type: Date, default: null },
    lastRunId: { type: mongoose.Schema.Types.ObjectId, ref: "JarvisCampaignRun", default: null },
    stats: {
      leadCount: { type: Number, default: 0 },
      messagesSent: { type: Number, default: 0 },
      replies: { type: Number, default: 0 },
      appointments: { type: Number, default: 0 },
    },
    auditLog: { type: [mongoose.Schema.Types.Mixed], default: [] },
  },
  {
    timestamps: { createdAt: true, updatedAt: true },
    suppressReservedKeysWarning: true,
  }
);

JarvisCampaignTemplateSchema.index({ "source.createdBy": 1, updatedAt: -1 });
JarvisCampaignTemplateSchema.index({ status: 1, updatedAt: -1 });

module.exports = mongoose.model("JarvisCampaignTemplate", JarvisCampaignTemplateSchema);
