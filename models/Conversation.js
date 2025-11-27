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

const ConversationSchema = new mongoose.Schema(
  {
    visitorId: String, // session or messenger ID
    channel: String,   // web | messenger | sms
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: "Lead" },
    messages: [MessageSchema],
  },
  { timestamps: true }
);

module.exports = mongoose.model("Conversation", ConversationSchema);
