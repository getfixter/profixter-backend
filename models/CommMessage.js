const mongoose = require("mongoose");

/**
 * One entry in a customer's communication history (utils/comms).
 *
 * Every channel lands here in one shape so the inbox, the customer timeline
 * and search can page through it with one index:
 *   sms     texts in and out (manual, automated, bulk, imported)
 *   call    calls (metadata; a recording only when the source provides one)
 *   email   emails held by a connected source (GoHighLevel); Profixter's own
 *           sent emails stay in EmailLog and are merged into the timeline
 *   chat    other connected chat channels (GoHighLevel webchat, Facebook...)
 *   note    internal notes. NEVER sent to anyone.
 *   system  events worth seeing in the thread: opt-out, link changes
 *
 * IDEMPOTENT BY CONSTRUCTION. A provider id (Twilio SID, GHL message id), an
 * automated SmsMessage row, and a client idempotency key are each unique, so a
 * replayed webhook, an overlapping import or a double-clicked Send lands on
 * the row that already exists.
 */
const MediaSchema = new mongoose.Schema(
  {
    key: { type: String, default: "" },
    contentType: { type: String, default: "" },
    size: { type: Number, default: 0 },
    name: { type: String, default: "" },
    /** Imported media we did not copy: shown as "available in the source". */
    external: { type: Boolean, default: false },
  },
  { _id: false }
);

const CommMessageSchema = new mongoose.Schema(
  {
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: "CommConversation", default: null },
    /** The customer this belonged to when it happened (see CommConversation). */
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    channel: { type: String, enum: ["sms", "call", "email", "chat", "note", "system"], required: true },
    /** Original channel label from an imported source ("Facebook", "Webchat"). */
    channelLabel: { type: String, default: "" },
    direction: { type: String, enum: ["inbound", "outbound", "internal"], required: true },
    /** customer | manual | automation | bulk | note | system | import */
    kind: { type: String, required: true },

    body: { type: String, default: "" },
    subject: { type: String, default: "" },
    media: { type: [MediaSchema], default: [] },
    /** True when the source gave us metadata only (no body). */
    metadataOnly: { type: Boolean, default: false },

    fromAddress: { type: String, default: "" },
    toAddress: { type: String, default: "" },
    /** The Profixter number used (E.164), for texts and calls. */
    lineNumber: { type: String, default: "" },

    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    authorName: { type: String, default: "" },
    /** For automation: the SmsTypes notification type that produced it. */
    automationType: { type: String, default: "" },
    purpose: { type: String, enum: ["", "service", "marketing"], default: "" },

    /*
     * queued sending sent delivered undelivered failed unknown received
     * suppressed canceled scheduled logged
     * `unknown`: the request to Twilio timed out; reconcile finds the truth
     * before anything is retried (utils/comms/reconcile.js).
     */
    status: { type: String, default: "logged" },
    statusRank: { type: Number, default: 0 },
    errorCode: { type: String, default: "" },
    errorMessage: { type: String, default: "" },
    segments: { type: Number, default: 0 },

    provider: { type: String, default: "profixter" },
    providerId: { type: String, default: "" },
    providerStatus: { type: String, default: "" },
    attemptedAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },

    idempotencyKey: { type: String, default: undefined },
    retryOf: { type: mongoose.Schema.Types.ObjectId, ref: "CommMessage", default: undefined },
    smsMessage: { type: mongoose.Schema.Types.ObjectId, ref: "SmsMessage", default: undefined },
    bulkSend: { type: mongoose.Schema.Types.ObjectId, ref: "CommBulkSend", default: null },
    bulkRecipient: { type: mongoose.Schema.Types.ObjectId, ref: "CommBulkRecipient", default: null },
    booking: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", default: null },

    call: {
      durationSec: { type: Number, default: 0 },
      status: { type: String, default: "" },
      hasRecording: { type: Boolean, default: false },
      transcript: { type: String, default: "" },
    },

    /** Where it came from: "twilio_webhook", "manual", "sms_mirror", "twilio_import", "ghl_import". */
    origin: { type: String, default: "" },
    importRun: { type: mongoose.Schema.Types.ObjectId, ref: "CommImportRun", default: null },

    occurredAt: { type: Date, required: true },
  },
  { timestamps: true }
);

CommMessageSchema.index({ conversation: 1, occurredAt: -1, _id: -1 }, { name: "comm_msg_thread" });
CommMessageSchema.index({ user: 1, occurredAt: -1, _id: -1 }, { name: "comm_msg_user" });
CommMessageSchema.index(
  { provider: 1, providerId: 1 },
  { unique: true, name: "comm_msg_provider_unique", partialFilterExpression: { providerId: { $type: "string", $gt: "" } } }
);
CommMessageSchema.index(
  { idempotencyKey: 1 },
  { unique: true, name: "comm_msg_idem_unique", partialFilterExpression: { idempotencyKey: { $type: "string" } } }
);
CommMessageSchema.index(
  { smsMessage: 1 },
  { unique: true, name: "comm_msg_smsmessage_unique", partialFilterExpression: { smsMessage: { $type: "objectId" } } }
);
CommMessageSchema.index(
  { retryOf: 1 },
  { unique: true, name: "comm_msg_retry_unique", partialFilterExpression: { retryOf: { $type: "objectId" } } }
);
CommMessageSchema.index({ status: 1, attemptedAt: 1 }, { name: "comm_msg_status" });
CommMessageSchema.index({ body: "text", subject: "text" }, { name: "comm_msg_text", default_language: "none" });

module.exports = mongoose.model("CommMessage", CommMessageSchema);
