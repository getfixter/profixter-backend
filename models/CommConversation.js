const mongoose = require("mongoose");

/**
 * One conversation in the shared Communications inbox (utils/comms).
 *
 * A conversation belongs to ONE external contact, keyed by `contactKey`:
 * "tel:+16315551234" for a phone number, or "ghl:<contactId>" for an imported
 * GoHighLevel contact that has no phone. Every message keeps the Profixter
 * line it actually used (CommMessage.lineNumber), so one thread can show
 * texts from more than one of our numbers, and the composer defaults to the
 * line the customer last heard from.
 *
 * WHO THE CONTACT IS, IS AN EXPLICIT FACT, NEVER A GUESS AT READ TIME.
 * `user` is set when exactly one customer owns the number, or when an admin
 * links it. Several matches leave it "ambiguous" with the candidates listed,
 * and nothing is shown on any customer's timeline until somebody chooses.
 * Each message is stamped with the customer it belonged to WHEN it happened,
 * so a recycled number never pulls one customer's history onto another's.
 */
const CommConversationSchema = new mongoose.Schema(
  {
    contactKey: { type: String, required: true },
    /** E.164, or "" for a contact known only by email or GHL id. */
    externalPhone: { type: String, default: "" },
    externalEmail: { type: String, default: "", lowercase: true, trim: true },

    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    linkState: { type: String, enum: ["linked", "unknown", "ambiguous"], default: "unknown" },
    candidateUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    linkedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    linkedAt: { type: Date, default: null },
    /** Shown when no customer is linked: the GHL contact name, or the phone. */
    displayName: { type: String, default: "" },

    /** The line the customer last heard from or wrote to (composer default). */
    lineNumber: { type: String, default: "" },

    lastMessageAt: { type: Date, default: null },
    lastPreview: { type: String, default: "" },
    lastDirection: { type: String, default: "" },
    lastKind: { type: String, default: "" },
    lastChannel: { type: String, default: "" },
    lastInboundAt: { type: Date, default: null },
    lastManualOutboundAt: { type: Date, default: null },

    unreadCount: { type: Number, default: 0 },
    needsReply: { type: Boolean, default: false },
    archived: { type: Boolean, default: false },
    archivedAt: { type: Date, default: null },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    assignedToName: { type: String, default: "" },
    deliveryProblem: { type: Boolean, default: false },

    /** Channels present in the thread, for the channel filter. */
    channels: { type: [String], default: [] },
    lines: { type: [String], default: [] },
    /** True while every message came from a history import (hidden from the default inbox until linked). */
    importOnly: { type: Boolean, default: true },
    importContactId: { type: String, default: "" },

    /** Bumped on every change; the live inbox polls on changedAt. */
    version: { type: Number, default: 0 },
    changedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true }
);

CommConversationSchema.index({ contactKey: 1 }, { unique: true, name: "comm_conv_contact_unique" });
CommConversationSchema.index({ archived: 1, lastMessageAt: -1 }, { name: "comm_conv_inbox" });
CommConversationSchema.index({ changedAt: 1 }, { name: "comm_conv_changed" });
CommConversationSchema.index({ user: 1, lastMessageAt: -1 }, { name: "comm_conv_user" });
CommConversationSchema.index({ externalPhone: 1 }, { name: "comm_conv_phone" });
CommConversationSchema.index({ assignedTo: 1, lastMessageAt: -1 }, { name: "comm_conv_assigned" });
CommConversationSchema.index({ unreadCount: 1, lastMessageAt: -1 }, { name: "comm_conv_unread" });
CommConversationSchema.index({ linkState: 1, lastMessageAt: -1 }, { name: "comm_conv_link" });

module.exports = mongoose.model("CommConversation", CommConversationSchema);
