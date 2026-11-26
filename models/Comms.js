const mongoose = require("mongoose");

/**
 * Supporting records for Communications (utils/comms). The conversation and
 * the message have their own files; these are the smaller pieces.
 */
const ObjectId = mongoose.Schema.Types.ObjectId;

/* ------------------------------------------------------------ bulk send */
/**
 * A bulk SMS: a message, one Profixter line, and an audience snapshot.
 *
 * THE CONFIRMED NUMBER IS A CEILING. `confirmedCount` is the eligible count the
 * person saw and confirmed. The worker never sends to more recipients than
 * that, and recipients are only the rows snapshotted before confirmation, so
 * no later change to a segment can make a bulk send reach more people.
 */
const BulkSendSchema = new mongoose.Schema(
  {
    number: { type: String, required: true },
    name: { type: String, default: "" },
    purpose: { type: String, enum: ["service", "marketing"], required: true },
    lineNumber: { type: String, required: true },
    /** The text with {firstName}-style fields; each recipient's resolved copy is stored on its row. */
    body: { type: String, required: true },
    savedReply: { type: ObjectId, ref: "CommSavedReply", default: null },
    audience: {
      type: { type: String, enum: ["selected", "segment"], required: true },
      userIds: [{ type: ObjectId, ref: "User" }],
      segment: { type: String, default: "" },
      label: { type: String, default: "" },
    },
    /*
     * draft           being composed; audience not frozen
     * previewed       audience snapshotted; counts shown
     * pending_approval confirmed by someone who may not approve; owner must approve
     * scheduled       approved, waiting for scheduledFor
     * sending         the worker is processing recipients
     * completed       every recipient reached a final state
     * canceled        stopped; pending recipients were canceled
     */
    status: { type: String, default: "draft" },
    scheduledFor: { type: Date, default: null },
    snapshotAt: { type: Date, default: null },
    /*
     * SHA-256 of exactly what was previewed: line, purpose, message, and every
     * recipient's customer, phone and personalised text (utils/comms/bulk.js
     * snapshotDigest). Confirm and approval must quote it; the worker re-checks
     * it before sending and halts on any difference.
     */
    snapshotHash: { type: String, default: "" },
    haltedReason: { type: String, default: "" },
    confirmedCount: { type: Number, default: 0 },
    counts: {
      total: { type: Number, default: 0 },
      eligible: { type: Number, default: 0 },
      excluded: { type: Number, default: 0 },
    },
    exclusions: { type: Map, of: Number, default: {} },
    createdBy: { type: ObjectId, ref: "User", required: true },
    createdByName: { type: String, default: "" },
    confirmedBy: { type: ObjectId, ref: "User", default: null },
    confirmedAt: { type: Date, default: null },
    approvedBy: { type: ObjectId, ref: "User", default: null },
    approvedByName: { type: String, default: "" },
    approvedAt: { type: Date, default: null },
    canceledBy: { type: ObjectId, ref: "User", default: null },
    canceledAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    perMinute: { type: Number, default: 30 },
    confirmKey: { type: String, default: undefined },
    lockExpiresAt: { type: Date, default: null },
    version: { type: Number, default: 0 },
  },
  { timestamps: true }
);
BulkSendSchema.index({ number: 1 }, { unique: true });
BulkSendSchema.index({ status: 1, scheduledFor: 1 });
BulkSendSchema.index({ confirmKey: 1 }, { unique: true, partialFilterExpression: { confirmKey: { $type: "string" } } });

const BulkRecipientSchema = new mongoose.Schema(
  {
    bulk: { type: ObjectId, ref: "CommBulkSend", required: true },
    user: { type: ObjectId, ref: "User", default: null },
    name: { type: String, default: "" },
    phone: { type: String, default: "" },
    body: { type: String, default: "" },
    /*
     * eligible   in the confirmed audience, not yet sent
     * excluded   left out at snapshot time (reason says why); never sent
     * sending    claimed by the worker
     * sent / delivered / undelivered / failed / unknown   provider outcome
     * skipped    eligible at snapshot, refused by the recheck at send time
     * canceled   the send was canceled before this one went out
     */
    status: { type: String, required: true },
    reason: { type: String, default: "" },
    message: { type: ObjectId, ref: "CommMessage", default: null },
    attempts: { type: Number, default: 0 },
    lockExpiresAt: { type: Date, default: null },
    processedAt: { type: Date, default: null },
    retryOf: { type: ObjectId, ref: "CommBulkRecipient", default: undefined },
    /** 0 for the confirmed audience; a retry of a confirmed failure is the next round. */
    round: { type: Number, default: 0 },
  },
  { timestamps: true }
);
BulkRecipientSchema.index({ bulk: 1, status: 1 });
BulkRecipientSchema.index(
  { bulk: 1, phone: 1, round: 1 },
  { unique: true, name: "bulk_phone_round_unique", partialFilterExpression: { phone: { $type: "string", $gt: "" } } }
);
BulkRecipientSchema.index({ retryOf: 1 }, { unique: true, partialFilterExpression: { retryOf: { $type: "objectId" } } });

/* ------------------------------------------------------------ settings */
/**
 * The owner's switches, kept in the database because the hosting
 * environment's variable space is full. One document, _id "comms".
 *
 * Every switch defaults to the behaviour Profixter had before
 * Communications existed: manual and bulk sending off, the inbound
 * "not monitored" auto-reply on, history imports off.
 */
const SettingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: "comms" },
    manualSendingEnabled: { type: Boolean, default: false },
    bulkSendingEnabled: { type: Boolean, default: false },
    inboundAutoReply: { type: String, enum: ["on", "off"], default: "on" },
    /* Reply to someone who texted first but never opted in (off: the A2P campaign registers sign-up/account consent only). */
    replyWithoutOptIn: { type: Boolean, default: false },
    /** Profixter lines from Twilio (refreshed read-only by the owner). Empty = the configured number. */
    senders: [
      {
        number: { type: String },
        label: { type: String, default: "" },
        messagingServiceSid: { type: String, default: "" },
        sms: { type: Boolean, default: true },
        mms: { type: Boolean, default: false },
        _id: false,
      },
    ],
    sendersRefreshedAt: { type: Date, default: null },
    registration: {
      checkedAt: { type: Date, default: null },
      campaignStatus: { type: String, default: "" },
      usecase: { type: String, default: "" },
      error: { type: String, default: "" },
    },
    ghlHistoryAutoImport: { type: Boolean, default: false },
    updatedBy: { type: ObjectId, ref: "User", default: null },
    version: { type: Number, default: 0 },
  },
  { timestamps: true }
);

const SavedReplySchema = new mongoose.Schema(
  {
    title: { type: String, required: true, maxlength: 80 },
    body: { type: String, required: true, maxlength: 1000 },
    purpose: { type: String, enum: ["service", "marketing"], default: "service" },
    createdBy: { type: ObjectId, ref: "User", default: null },
    archived: { type: Boolean, default: false },
  },
  { timestamps: true }
);

/* ------------------------------------------------------------- imports */
/**
 * One history import (backfill) with its checkpoint. Resumable: the cursor is
 * saved after every page, so an interrupted run continues where it stopped,
 * and message-level unique ids make re-reading a page harmless.
 */
const ImportRunSchema = new mongoose.Schema(
  {
    source: { type: String, enum: ["sms_mirror", "twilio_messages", "twilio_calls", "ghl"], required: true },
    status: { type: String, enum: ["idle", "running", "paused", "done", "failed"], default: "idle" },
    cursor: { type: mongoose.Schema.Types.Mixed, default: null },
    counts: {
      pages: { type: Number, default: 0 },
      fetched: { type: Number, default: 0 },
      inserted: { type: Number, default: 0 },
      duplicates: { type: Number, default: 0 },
      skipped: { type: Number, default: 0 },
      matched: { type: Number, default: 0 },
      unmatched: { type: Number, default: 0 },
      errors: { type: Number, default: 0 },
    },
    earliestAt: { type: Date, default: null },
    latestAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    lastError: { type: String, default: "" },
    startedBy: { type: ObjectId, ref: "User", default: null },
    lockExpiresAt: { type: Date, default: null },
    heartbeatAt: { type: Date, default: null },
  },
  { timestamps: true }
);
ImportRunSchema.index({ source: 1 }, { unique: true });

/* ---------------------------------------------- early status callbacks */
/** A Twilio status that arrived before the send that produced it was saved. */
const PendingStatusSchema = new mongoose.Schema({
  sid: { type: String, required: true },
  status: { type: String, required: true },
  errorCode: { type: String, default: "" },
  at: { type: Date, default: () => new Date(), expires: 60 * 60 * 24 },
});
PendingStatusSchema.index({ sid: 1 });

/* ---------------------------------------------------------- monitoring */
const HealthEventSchema = new mongoose.Schema({
  type: { type: String, required: true },
  detail: { type: String, default: "" },
  at: { type: Date, default: () => new Date(), expires: 60 * 60 * 24 * 14 },
});
HealthEventSchema.index({ type: 1, at: -1 });

/* ---------------------------------------------------------------- media */
/** An image uploaded for an outbound MMS, stored privately in S3. */
const MediaUploadSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    contentType: { type: String, required: true },
    size: { type: Number, required: true },
    name: { type: String, default: "" },
    uploadedBy: { type: ObjectId, ref: "User", required: true },
    usedBy: { type: ObjectId, ref: "CommMessage", default: null },
  },
  { timestamps: true }
);

module.exports = {
  CommBulkSend: mongoose.model("CommBulkSend", BulkSendSchema),
  CommBulkRecipient: mongoose.model("CommBulkRecipient", BulkRecipientSchema),
  CommSettings: mongoose.model("CommSettings", SettingsSchema, "comm_settings"),
  CommSavedReply: mongoose.model("CommSavedReply", SavedReplySchema),
  CommImportRun: mongoose.model("CommImportRun", ImportRunSchema),
  CommPendingStatus: mongoose.model("CommPendingStatus", PendingStatusSchema),
  CommHealthEvent: mongoose.model("CommHealthEvent", HealthEventSchema),
  CommMediaUpload: mongoose.model("CommMediaUpload", MediaUploadSchema),
};
