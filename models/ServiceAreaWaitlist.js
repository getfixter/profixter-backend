const mongoose = require("mongoose");

/**
 * Somebody outside the service area who asked to hear when we reach them.
 *
 * Before this existed the free-visit booker told an out-of-area visitor "not
 * yet" and they vanished without a trace, so there was no way to see where
 * unmet demand sits. A row here is both things: a person who opted in to ONE
 * email (the day we start serving their ZIP), and a data point for the
 * expansion question.
 *
 * Email only, by design. The form offers no SMS and none may ever be sent on
 * the strength of this row - it is not an account and carries no SMS consent.
 * `consentEmailAt` and `consentText` record exactly what was ticked, so the
 * one permitted message can be justified later.
 *
 * One row per (email, zip). Asking twice refreshes `lastRequestedAt` and never
 * creates a duplicate.
 */
const serviceAreaWaitlistSchema = new mongoose.Schema(
  {
    email: { type: String, required: true },
    emailNormalized: { type: String, required: true },
    zip: { type: String, required: true, index: true },
    source: { type: String, default: null },
    visitorId: { type: String, default: null },
    /* sanitizeAttribution() output: the browser's first touch, if it sent one. */
    attribution: { type: mongoose.Schema.Types.Mixed, default: null },

    consentEmailAt: { type: Date, required: true },
    consentText: { type: String, required: true },

    status: {
      type: String,
      enum: ["waiting", "notified", "unsubscribed"],
      default: "waiting",
      index: true,
    },
    notifiedAt: { type: Date, default: null },
    /* Incremented on every request, including the first ($inc on upsert). */
    requestCount: { type: Number, default: 0 },
    lastRequestedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

serviceAreaWaitlistSchema.index({ emailNormalized: 1, zip: 1 }, { unique: true });
serviceAreaWaitlistSchema.index({ createdAt: 1 });

module.exports = mongoose.model("ServiceAreaWaitlist", serviceAreaWaitlistSchema);
