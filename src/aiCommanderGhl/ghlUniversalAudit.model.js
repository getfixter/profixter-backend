const mongoose = require("mongoose");

const GhlUniversalAuditSchema = new mongoose.Schema(
  {
    adminUserId: { type: mongoose.Schema.Types.Mixed, default: null, index: true },
    userRequest: { type: String, default: "", trim: true },
    reason: { type: String, default: "", trim: true },
    method: { type: String, required: true, trim: true },
    path: { type: String, required: true, trim: true },
    endpointKey: { type: String, default: "", trim: true, index: true },
    locationId: { type: String, default: "", trim: true, index: true },
    query: { type: mongoose.Schema.Types.Mixed, default: {} },
    body: { type: mongoose.Schema.Types.Mixed, default: null },
    dryRun: { type: Boolean, default: false },
    approved: { type: Boolean, default: false },
    requiresExtraConfirmation: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ["dry_run", "executed", "failed", "rejected"],
      required: true,
      index: true,
    },
    resultStatus: { type: Number, default: null },
    error: { type: mongoose.Schema.Types.Mixed, default: null },
    responseSummary: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  {
    timestamps: { createdAt: true, updatedAt: true },
    suppressReservedKeysWarning: true,
  }
);

GhlUniversalAuditSchema.index({ createdAt: -1 });
GhlUniversalAuditSchema.index({ adminUserId: 1, createdAt: -1 });

module.exports = mongoose.model("GhlUniversalAudit", GhlUniversalAuditSchema);
