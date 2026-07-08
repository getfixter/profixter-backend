const mongoose = require("mongoose");

const AiCommanderGhlAuditSchema = new mongoose.Schema(
  {
    adminUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    originalMessage: { type: String, required: true, trim: true },
    generatedPlan: { type: mongoose.Schema.Types.Mixed, required: true },
    confirmationId: { type: String, required: true, unique: true, index: true },
    status: {
      type: String,
      enum: ["planned", "running", "executed", "failed", "expired"],
      default: "planned",
      index: true,
    },
    exactApiCallsPlanned: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },
    exactApiCallsExecuted: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },
    ghlResponses: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },
    errors: { type: [mongoose.Schema.Types.Mixed], default: [] },
    executedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true, index: true },
  },
  {
    timestamps: { createdAt: true, updatedAt: true },
    suppressReservedKeysWarning: true,
  }
);

AiCommanderGhlAuditSchema.index({ adminUserId: 1, createdAt: -1 });
AiCommanderGhlAuditSchema.index({ status: 1, expiresAt: 1 });

module.exports = mongoose.model(
  "AiCommanderGhlAudit",
  AiCommanderGhlAuditSchema
);
