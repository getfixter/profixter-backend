const mongoose = require("mongoose");

const AdminActivityLogSchema = new mongoose.Schema(
  {
    action: { type: String, required: true, trim: true, index: true },
    entityType: { type: String, required: true, trim: true, index: true },
    entityId: { type: String, default: "", trim: true, index: true },
    entityName: { type: String, default: "", trim: true },
    actorUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    actorName: { type: String, default: "", trim: true },
    actorRole: { type: String, default: "", trim: true },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
    ipAddress: { type: String, default: "", trim: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

AdminActivityLogSchema.index({ createdAt: -1 });
AdminActivityLogSchema.index({ actorUserId: 1, createdAt: -1 });
AdminActivityLogSchema.index({ entityType: 1, createdAt: -1 });
AdminActivityLogSchema.index({ action: 1, createdAt: -1 });

module.exports = mongoose.model("AdminActivityLog", AdminActivityLogSchema);
