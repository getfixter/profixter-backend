const mongoose = require("mongoose");

const CLASSIFICATIONS = [
  "interested",
  "maybe_interested",
  "wants_call",
  "gave_callback_time",
  "not_interested",
  "stop_unsubscribe",
  "pricing_question",
  "technical_question",
  "angry_or_complaint",
  "wrong_number",
  "unclear",
  "human_takeover",
];

const STATUSES = [
  "new",
  "ai_responding",
  "waiting_for_callback_time",
  "callback_scheduled",
  "human_takeover",
  "closed_not_interested",
  "do_not_contact",
];

const ConversationMessageSchema = new mongoose.Schema(
  {
    role: {
      type: String,
      enum: ["system", "user", "assistant"],
      required: true,
    },
    content: { type: String, default: "" },
    at: { type: Date, default: Date.now },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: false }
);

const EventLogSchema = new mongoose.Schema(
  {
    event: { type: String, required: true },
    at: { type: Date, default: Date.now },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: false }
);

const RoofingSalesAgentConversationSchema = new mongoose.Schema(
  {
    contactId: { type: String, trim: true, default: "", index: true },
    phone: { type: String, trim: true, default: "", index: true },
    name: { type: String, trim: true, default: "" },
    campaignType: {
      type: String,
      enum: ["roofing_siding"],
      default: "roofing_siding",
      index: true,
    },
    lastIncomingMessage: { type: String, default: "" },
    lastAiReply: { type: String, default: "" },
    classification: {
      type: String,
      enum: CLASSIFICATIONS,
      default: "unclear",
      index: true,
    },
    status: {
      type: String,
      enum: STATUSES,
      default: "new",
      index: true,
    },
    callbackTimeText: { type: String, default: "" },
    conversationHistory: { type: [ConversationMessageSchema], default: [] },
    eventLog: { type: [EventLogSchema], default: [] },
    lastWebhookPayload: { type: mongoose.Schema.Types.Mixed, default: null },
    conversationId: { type: String, trim: true, default: "" },
    lastMessageId: { type: String, trim: true, default: "" },
    lastProcessedAt: { type: Date, default: null },
    lastNotifiedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    suppressReservedKeysWarning: true,
  }
);

RoofingSalesAgentConversationSchema.index(
  { contactId: 1 },
  {
    unique: true,
    partialFilterExpression: { contactId: { $type: "string", $gt: "" } },
  }
);
RoofingSalesAgentConversationSchema.index(
  { phone: 1 },
  {
    unique: false,
    partialFilterExpression: { phone: { $type: "string", $gt: "" } },
  }
);
RoofingSalesAgentConversationSchema.index({ status: 1, updatedAt: -1 });

module.exports = {
  CLASSIFICATIONS,
  STATUSES,
  RoofingSalesAgentConversation: mongoose.model(
    "RoofingSalesAgentConversation",
    RoofingSalesAgentConversationSchema
  ),
};
