// backend/models/Conversation.js
const mongoose = require("mongoose");

const MessageSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ["system", "user", "assistant"] },
    content: String,
    meta: Object,
  },
  { _id: false, timestamps: true }
);

const AttachmentSchema = new mongoose.Schema(
  {
    filename: String,
    contentType: String,
    size: Number,
    kind: {
      type: String,
      enum: ["image", "pdf", "other"],
      default: "other",
    },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const ConversationSchema = new mongoose.Schema(
  {
    visitorId: String, // session or messenger ID
    channel: String,   // web | messenger | sms
    mode: {
      type: String,
      enum: ["sales", "home_support"],
      default: "sales",
      index: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: "Lead" },
    messages: [MessageSchema],
    attachments: [AttachmentSchema],
    summary: { type: String, default: "" },
    lastMessageAt: { type: Date, default: Date.now, index: true },
    expiresAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

ConversationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
ConversationSchema.index({ visitorId: 1, channel: 1, mode: 1 });

module.exports = mongoose.model("Conversation", ConversationSchema);
