const mongoose = require("mongoose");

const JarvisWorkflowJobSchema = new mongoose.Schema(
  {
    jobId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true, trim: true, index: true },
    actionType: { type: String, required: true, trim: true },
    adminUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    confirmationId: { type: String, required: true, index: true },
    originalMessage: { type: String, default: "", trim: true },
    status: {
      type: String,
      enum: ["queued", "running", "completed", "failed", "canceled"],
      default: "queued",
      index: true,
    },
    approvalRequired: { type: Boolean, default: true },
    approved: { type: Boolean, default: false },
    dryRun: { type: Boolean, default: false },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    completedIndexes: { type: [Number], default: [] },
    totalItems: { type: Number, default: 0 },
    processedItems: { type: Number, default: 0 },
    percent: { type: Number, default: 0 },
    currentMessage: { type: String, default: "", trim: true },
    progressEvents: { type: [mongoose.Schema.Types.Mixed], default: [] },
    report: { type: mongoose.Schema.Types.Mixed, default: null },
    errors: { type: [mongoose.Schema.Types.Mixed], default: [] },
    result: { type: mongoose.Schema.Types.Mixed, default: null },
    resumeCount: { type: Number, default: 0 },
    lastHeartbeatAt: { type: Date, default: null, index: true },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
  },
  {
    timestamps: { createdAt: true, updatedAt: true },
    minimize: false,
    suppressReservedKeysWarning: true,
  }
);

JarvisWorkflowJobSchema.index({ adminUserId: 1, createdAt: -1 });
JarvisWorkflowJobSchema.index({ status: 1, updatedAt: 1 });

module.exports = mongoose.model("JarvisWorkflowJob", JarvisWorkflowJobSchema);
