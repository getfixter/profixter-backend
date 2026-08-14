const mongoose = require("mongoose");

/**
 * One marketing email, attempted or sent.
 *
 * Deliberately its own collection rather than fields on User. Marketing history
 * grows without bound, is queried by campaign as often as by person, and must
 * never share state with the transactional reminder fields. Sharing those was
 * exactly the bug that suppressed the 24-hour reminder email for eight months.
 *
 * This is also the idempotency record. The unique index below is what stops two
 * EB instances sending the same campaign to the same person, so a row exists
 * from the moment a worker claims the send, not from the moment it succeeds.
 */
const MarketingSendSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    userId: { type: String, default: "", index: true },
    email: { type: String, required: true, lowercase: true, trim: true, index: true },

    /** Versioned, so revised copy stays distinguishable in history. */
    campaignId: { type: String, required: true, index: true },
    /**
     * How many times this person has received this campaign, starting at 0.
     *
     * This is what separates the two guarantees that used to be tangled
     * together. "Do not send this twice by accident" is the unique index below,
     * which now includes the cycle. "Do not send this again for fifteen months"
     * is a content rule in the eligibility check. Before, one index tried to be
     * both, and the side effect was that every customer eventually ran out of
     * marketing permanently.
     */
    cycle: { type: Number, default: 0, min: 0 },
    audience: { type: String, enum: ["non_member", "member", "former_member"], required: true, index: true },
    category: { type: String, default: "", index: true },
    /** "help" or "sell". Read back to steer the long run mix per person. */
    kind: { type: String, default: "", index: true },
    topic: { type: String, default: "", index: true },

    status: {
      type: String,
      enum: ["claimed", "sent", "failed", "cancelled"],
      required: true,
      default: "claimed",
      index: true,
    },

    claimedAt: { type: Date, default: Date.now },
    sentAt: { type: Date, default: null, index: true },
    failedAt: { type: Date, default: null },
    attempts: { type: Number, default: 0 },

    providerMessageId: { type: String, default: "" },
    failureReason: { type: String, default: "" },
    /** Why a claimed send was abandoned at the send-time re-check. */
    cancelledReason: { type: String, default: "" },

    subject: { type: String, default: "" },
    /** Whether they were opted in at the moment we sent, for auditing. */
    unsubscribedAtSend: { type: Boolean, default: false },
  },
  { timestamps: true }
);

/*
 * One person receives one campaign once per cycle.
 *
 * This is the whole duplicate defence. Every worker that wants to send cycle N
 * of a campaign to a person tries to insert the same key; the database lets one
 * through and the rest get a duplicate-key error they treat as "somebody else
 * has it". Two servers that both read "they have had this once" both compute
 * cycle 1 and collide, which is exactly what we want.
 *
 * It deliberately does NOT prevent a deliberate resend fifteen months later:
 * that is cycle 2, a different key, and is governed by the reuse cooldown in
 * the eligibility check instead.
 *
 * Cancelled rows are excluded so a send abandoned at the send-time re-check
 * does not consume a cycle number.
 */
MarketingSendSchema.index(
  { user: 1, campaignId: 1, cycle: 1 },
  {
    unique: true,
    name: "one_campaign_cycle_per_user",
    partialFilterExpression: { status: { $in: ["claimed", "sent", "failed"] } },
  }
);

/** "When did this person last hear from marketing at all", the frequency cap. */
MarketingSendSchema.index({ user: 1, sentAt: -1 });
/** "What has this person seen on this topic", the rotation cooldown. */
MarketingSendSchema.index({ user: 1, topic: 1, sentAt: -1 });
MarketingSendSchema.index({ campaignId: 1, sentAt: -1 });

module.exports = mongoose.model("MarketingSend", MarketingSendSchema);
