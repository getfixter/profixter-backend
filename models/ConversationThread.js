const mongoose = require("mongoose");

/**
 * One homeowner's conversation with Profixter, mirrored from GoHighLevel so
 * the Conversation agent remembers context across messages and channels.
 *
 * Holds message text because answering requires it; the agent sees only this
 * thread (never the contact database), and the thread stores no more contact
 * detail than the channel needs. `optedOut` is permanent: once someone says
 * stop - in any words - nothing is ever sent on that thread again.
 */
const messageSchema = new mongoose.Schema(
  {
    direction: { type: String, enum: ["inbound", "outbound"], required: true },
    channel: { type: String, enum: ["SMS", "Email", "Call", "Other"], default: "SMS" },
    body: { type: String, default: "" },
    at: { type: Date, required: true },
    ghlMessageId: { type: String, default: null },
    by: { type: String, default: "" }, // "homeowner", "agent", "staff", "automation"
  },
  { _id: false }
);

const conversationThreadSchema = new mongoose.Schema(
  {
    ghlConversationId: { type: String, required: true, unique: true },
    ghlContactId: { type: String, required: true, index: true },
    channel: { type: String, enum: ["SMS", "Email", "Other"], default: "SMS" },
    firstName: { type: String, default: "" },
    town: { type: String, default: "" },
    zip: { type: String, default: "" },
    origin: { type: String, default: "unknown" }, // "cold_outreach_reply", "inbound", "website"
    messages: [messageSchema],
    status: {
      type: String,
      enum: ["needs_reply", "reply_proposed", "replied", "escalated", "closed", "opted_out"],
      default: "needs_reply",
      index: true,
    },
    optedOut: { type: Boolean, default: false, index: true },
    intent: { type: String, default: null },
    summary: { type: String, default: "" },
    escalationReason: { type: String, default: "" },
    refCode: { type: String, default: null, index: true },
    lastInboundAt: { type: Date, default: null, index: true },
    lastOutboundAt: { type: Date, default: null },
    agentReplies: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.models.ConversationThread || mongoose.model("ConversationThread", conversationThreadSchema);
