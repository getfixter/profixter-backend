const mongoose = require("mongoose");

/**
 * One Loyalty Benefit, issued once.
 *
 * A grant is a RECORD OF A DECISION, and it is also the thing that delivers the
 * benefit. A temporary plan upgrade is not written onto the subscription — it is
 * this row, with two dates, read back every time somebody asks what plan the
 * member effectively has. That is what lets the customer keep paying Basic while
 * being treated as Plus, and what makes the benefit end on its own without a
 * cleanup job: the dates simply stop containing today.
 *
 * WHY THE UNIQUE INDEX IS ON (track, milestone, generation)
 *
 * Because that is exactly what "already granted" means. Stripe retries, two
 * events arrive at once, an operator replays a webhook — all of them end up
 * trying to insert the same four values, and the database refuses. The
 * alternative, reading first and then writing, has a window between the read and
 * the write, and a duplicate Full Day or a second free month is real money.
 *
 * Generation is in the key on purpose. A member who genuinely leaves and comes
 * back starts a new generation, and is allowed to earn the three-month reward
 * again — once, in that generation.
 */

const LoyaltyGrantSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    userId: { type: String, required: true, index: true },
    addressId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    generation: { type: Number, required: true, default: 1 },

    milestone: { type: Number, required: true, enum: [3, 6, 12] },

    rewardKind: {
      type: String,
      required: true,
      enum: ["tier_upgrade", "loyalty_full_day", "free_month"],
    },

    /* ----------------------- Why it resolved this way ---------------------- */
    /**
     * The lowest REAL paid plan held across this milestone's own window, and
     * the plan the reward was therefore computed from.
     *
     * Stored rather than recomputed because the answer must not change later.
     * A member who asks in March why their reward was Plus and not Elite is
     * owed the figure we actually used, not the one today's data would produce.
     */
    windowMinimumPlan: {
      type: String,
      default: null,
      enum: ["basic", "plus", "premium", "elite", null],
    },
    /** Every real plan seen in the window, in order. The audit answer. */
    windowPlans: { type: [String], default: [] },
    windowStartSequence: { type: Number, default: null },
    windowEndSequence: { type: Number, default: null },
    /** The renewal that tipped them over. "Which invoice counted?" */
    triggeringInvoiceId: { type: String, default: null },

    /* ------------------------- Tier upgrade payload ------------------------ */
    /** The plan whose benefits they temporarily receive. */
    rewardPlan: {
      type: String,
      default: null,
      enum: ["basic", "plus", "premium", "elite", null],
    },
    /** One membership cycle at milestone 3, two at milestone 6. */
    cycles: { type: Number, default: null },
    effectiveFrom: { type: Date, default: null },
    effectiveUntil: { type: Date, default: null, index: true },

    /* ------------------------ Full Day / free month ------------------------ */
    visitEntitlementId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "VisitEntitlement",
      default: null,
    },
    stripeSubscriptionId: { type: String, default: null },
    stripeCouponId: { type: String, default: null },
    /**
     * Whatever discounts the subscription already carried when we attached
     * ours. Recorded because a member's promotion code is their money, and if
     * anything ever goes wrong with it this is the only place that remembers
     * what was there before we touched it.
     */
    priorDiscountIds: { type: [String], default: [] },
    /** The invoice the free month actually landed on, once proven. */
    appliedInvoiceId: { type: String, default: null },
    verifiedAmountPaidCents: { type: Number, default: null },
    /** A coupon burned by a proration is re-issued, at most twice. */
    reapplyCount: { type: Number, default: 0 },

    status: {
      type: String,
      required: true,
      default: "granted",
      enum: [
        "granted", // issued, and for a tier upgrade currently running
        "applied", // free month attached to Stripe, awaiting its invoice
        "consumed", // free month proven at $0, or a Full Day used
        "expired", // ran its course
        "superseded", // a better benefit replaced it
        "failed", // something went wrong; failureReason says what
      ],
      index: true,
    },
    failureReason: { type: String, default: null },
    /** Set when the grant needs a person to look at it. Rare by design. */
    needsReview: { type: Boolean, default: false, index: true },

    grantedAt: { type: Date, required: true, default: Date.now },
    notifiedAt: { type: Date, default: null },
    expiryNotifiedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

/** One reward per milestone, per property, per unbroken run of membership. */
LoyaltyGrantSchema.index(
  { user: 1, addressId: 1, generation: 1, milestone: 1 },
  { unique: true, name: "loyalty_grant_once_per_milestone" }
);

/** "What is running at this property right now", the entitlement lookup. */
LoyaltyGrantSchema.index(
  { user: 1, addressId: 1, status: 1, effectiveUntil: 1 },
  { name: "loyalty_grant_active_idx" }
);

module.exports = mongoose.model("LoyaltyGrant", LoyaltyGrantSchema);
