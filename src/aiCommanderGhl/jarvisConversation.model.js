const mongoose = require("mongoose");

const JarvisConversationMessageSchema = new mongoose.Schema(
  {
    clientId: { type: String, default: "", trim: true },
    role: { type: String, enum: ["user", "jarvis"], required: true },
    kind: {
      type: String,
      enum: ["text", "brief", "plan", "answer", "error"],
      required: true,
    },
    text: { type: String, default: "", trim: true },
    intent: { type: String, default: "", trim: true },
    sources: { type: [String], default: [] },
    files: { type: [mongoose.Schema.Types.Mixed], default: [] },
    plan: { type: mongoose.Schema.Types.Mixed, default: null },
    data: { type: mongoose.Schema.Types.Mixed, default: null },
    error: { type: mongoose.Schema.Types.Mixed, default: null },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false, minimize: false }
);

const JarvisConversationSchema = new mongoose.Schema(
  {
    conversationId: { type: String, required: true, trim: true, index: true },
    adminUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    title: { type: String, required: true, trim: true },
    subtitle: { type: String, default: "", trim: true },
    messages: { type: [JarvisConversationMessageSchema], default: [] },
    executionByPlanId: { type: mongoose.Schema.Types.Mixed, default: {} },
    errorByPlanId: { type: mongoose.Schema.Types.Mixed, default: {} },
    canceledPlans: { type: mongoose.Schema.Types.Mixed, default: {} },
    uploadBatchIds: { type: [String], default: [] },
    workflowJobIds: { type: [String], default: [] },
    lastMessageAt: { type: Date, default: Date.now, index: true },
  },
  {
    timestamps: true,
    minimize: false,
  }
);

JarvisConversationSchema.index({ adminUserId: 1, conversationId: 1 }, { unique: true });
JarvisConversationSchema.index({ adminUserId: 1, updatedAt: -1 });
JarvisConversationSchema.index({ title: "text", "messages.text": "text" });

module.exports = mongoose.model("JarvisConversation", JarvisConversationSchema);
