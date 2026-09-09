const mongoose = require("mongoose");

/**
 * One SMS, attempted or deliberately not sent.
 *
 * This collection is three things at once, and it is worth being explicit about
 * which, because they have different lifetimes and the design only makes sense
 * if all three are held together:
 *
 *   1. The audit record. What ProFixter said to a customer, when, and what the
 *      carrier did with it. Kept forever.
 *   2. The idempotency claim. A row exists from the moment a worker decides to
 *      send, not from the moment a send succeeds, so the unique index on
 *      dedupeKey is what stops a retried Lambda, an overlapping sweep or a
 *      redeployed instance sending a second copy.
 *   3. The retry queue. A transient provider failure leaves a row in
 *      retry_scheduled with nextAttemptAt set, and the sweep picks it up.
 *
 * Modelled on MarketingSend, which already proved this shape for email, rather
 * than on the reminder fields hung off Booking. Per-booking fields cannot
 * represent a message with no booking, and message history grows without bound.
 */
const SmsMessageSchema = new mongoose.Schema(
  {
    /*
     * Who this went to. All three are denormalised deliberately: an audit that
     * needs a join to answer "what did we send this person" stops being usable
     * exactly when it matters, and the phone number is the only field that
     * records what we actually dialled rather than what the user record says
     * today.
     */
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    userId: { type: String, default: "", index: true },
    toPhone: { type: String, default: "", index: true },
    recipientName: { type: String, default: "" },

    booking: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", default: null, index: true },
    bookingNumber: { type: String, default: "", index: true },
    subscription: { type: mongoose.Schema.Types.ObjectId, ref: "Subscription", default: null, index: true },

    /** The notification type from utils/sms/smsTypes. Never a free string. */
    notificationType: { type: String, required: true, index: true },
    /**
     * Transactional or marketing.
     *
     * Stored rather than derived at read time so an audit answers what the
     * classification WAS when we sent, even if the registry is later changed.
     * The two obey different consent rules and that distinction has to survive
     * in the record.
     */
    channelClass: {
      type: String,
      enum: ["transactional", "marketing"],
      required: true,
      index: true,
    },
    /** Marketing only: which campaign, and which cycle of it. */
    campaignId: { type: String, default: "", index: true },
    campaignCycle: { type: Number, default: 0, min: 0 },

    /** Exactly what we rendered. Never rebuilt from the template at read time. */
    body: { type: String, default: "" },
    segments: { type: Number, default: 0 },

    provider: { type: String, default: "twilio" },
    providerMessageSid: { type: String, default: "", index: true },
    providerStatus: { type: String, default: "" },
    providerErrorCode: { type: String, default: "" },
    providerErrorMessage: { type: String, default: "" },

    /*
     * The lifecycle.
     *
     * pending          claimed, not yet handed to the provider
     * sending          in flight, a lock held by one worker
     * sent             the provider accepted it
     * delivered        the carrier confirmed it (status callback)
     * undelivered      the carrier rejected it after accepting (status callback)
     * failed           permanently failed, will not be retried
     * retry_scheduled  transient failure, nextAttemptAt is set
     * suppressed       eligibility refused it; no send was attempted, ever
     * simulated        SMS_ENABLED=false; rendered and recorded, never sent
     *
     * suppressed and simulated are terminal and deliberately still consume the
     * dedupeKey. Turning sending on must not release a backlog of stale
     * messages at a customer, and an opt-out must not be re-evaluated hourly
     * until it flips.
     */
    status: {
      type: String,
      enum: [
        "pending",
        "sending",
        "sent",
        "delivered",
        "undelivered",
        "failed",
        "retry_scheduled",
        "suppressed",
        "simulated",
      ],
      required: true,
      default: "pending",
      index: true,
    },
    /** Why a message was suppressed, or why a retry was abandoned. */
    suppressionReason: { type: String, default: "" },

    scheduledFor: { type: Date, default: null, index: true },
    attemptedAt: { type: Date, default: null },
    sentAt: { type: Date, default: null, index: true },
    deliveredAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    lockExpiresAt: { type: Date, default: null },
    nextAttemptAt: { type: Date, default: null, index: true },
    attempts: { type: Number, default: 0 },

    /**
     * The idempotency key. See utils/sms/smsDedupe for how one is built.
     *
     * Every key embeds the occurrence it belongs to, so a rescheduled booking
     * produces a genuinely different key and gets a genuinely new reminder,
     * while a replayed webhook or a doubled worker produces the same key and
     * is refused by the database rather than by a check-then-write race.
     */
    dedupeKey: { type: String, required: true },

    /** Free-form breadcrumb: which job, route or webhook asked for this. */
    source: { type: String, default: "" },
  },
  { timestamps: true }
);

/*
 * The whole duplicate defence.
 *
 * Not partial, and not filtered by status: a suppressed or simulated row must
 * block a later duplicate just as firmly as a delivered one, because all three
 * mean "this occurrence has already been decided".
 */
SmsMessageSchema.index({ dedupeKey: 1 }, { unique: true, name: "sms_dedupe_key_unique_idx" });

/** The retry sweep's selector. */
SmsMessageSchema.index({ status: 1, nextAttemptAt: 1 }, { name: "sms_retry_idx" });
/** Admin: everything sent to one person, newest first. */
SmsMessageSchema.index({ user: 1, createdAt: -1 }, { name: "sms_user_history_idx" });
SmsMessageSchema.index({ toPhone: 1, createdAt: -1 }, { name: "sms_phone_history_idx" });
SmsMessageSchema.index({ createdAt: -1 }, { name: "sms_recent_idx" });
SmsMessageSchema.index({ status: 1, createdAt: -1 }, { name: "sms_status_idx" });
/** Marketing frequency caps and campaign reporting. */
SmsMessageSchema.index(
  { user: 1, channelClass: 1, sentAt: -1 },
  { name: "sms_user_class_sent_idx" }
);
SmsMessageSchema.index({ campaignId: 1, sentAt: -1 }, { name: "sms_campaign_idx" });

module.exports = mongoose.model("SmsMessage", SmsMessageSchema);
