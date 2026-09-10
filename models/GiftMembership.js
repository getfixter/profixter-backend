const mongoose = require("mongoose");

/**
 * A membership one person bought for another.
 *
 * A gift is a PREPAID FIXED-TERM ENTITLEMENT, not a subscription. It is paid
 * for once, it runs for a fixed number of months, and it ends. There is no
 * renewal, no billing cycle, no Stripe subscription and no stored card behind
 * it.
 *
 * WHY THIS IS ITS OWN COLLECTION AND NOT A Subscription ROW
 *
 * The billing portal resolves a customer by looking for ANY Subscription row
 * belonging to the signed-in user that carries a stripeCustomerId
 * (routes/subscriptions.js). A gift written as a Subscription row for the
 * recipient, carrying the purchaser's customer id — which is what copying the
 * existing subscription path would produce — would therefore hand the
 * recipient the PURCHASER'S Stripe billing portal: their saved cards, their
 * invoices, their payment methods.
 *
 * So the guarantee is structural rather than defensive. There is no row
 * anywhere associating the recipient with the purchaser's Stripe customer,
 * because this collection cannot express one. See the block below.
 *
 * Two further reasons: the unique index enforcing one active subscription per
 * (user, address) would turn "a gift for someone who already pays" into a
 * duplicate-key crash rather than a handled case; and half the Subscription
 * schema — billing cycle, period boundaries, cancellation, renewal — is
 * permanently meaningless for a gift.
 */

/**
 * One Stripe refund against the gift payment.
 *
 * Kept as a list rather than a single amount because Stripe permits several
 * partial refunds against one charge, and "how much has come back" has to be
 * reconstructable from the events rather than trusted as a running total
 * somebody incremented.
 */
const GiftRefundSchema = new mongoose.Schema(
  {
    stripeRefundId: { type: String, required: true },
    amountCents: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "usd", lowercase: true },
    reason: { type: String, default: "" },
    stripeCreatedAt: { type: Date, default: null },
    recordedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const GiftMembershipSchema = new mongoose.Schema(
  {
    /** Short human-readable reference for support conversations. */
    giftNumber: { type: String, required: true, unique: true, index: true },

    /* ------------------------------ Purchaser ----------------------------- */
    purchaser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    /**
     * Frozen at purchase.
     *
     * The recipient is shown the purchaser's NAME only, and only so the
     * invitation can say who it is from. Nothing else about the purchaser is
     * ever exposed to them.
     */
    purchaserSnapshot: {
      name: { type: String, default: "" },
      email: { type: String, default: "", lowercase: true, trim: true },
    },

    /* ------------------------------ Recipient ----------------------------- */
    /** Normalised at write time; the invitation target and the claim guard. */
    recipientEmail: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    recipientFirstName: { type: String, default: "", trim: true },
    recipientLastName: { type: String, default: "", trim: true },

    /* ---------------------------- Presentation ---------------------------- */
    /*
     * How the gift is PRESENTED, and nothing more.
     *
     * These two decide the words on the card and in the email. They are read
     * only by templates — never by pricing, entitlement, access or anything
     * Stripe sees. Keeping them beside the terms rather than inside them is
     * what stops "a birthday gift" quietly becoming a different product.
     *
     * Both are sanitised at write time (utils/gifts/giftOccasions) rather than
     * at render, so the database can never hold something a future template
     * would have to remember to escape.
     */
    occasion: {
      type: String,
      enum: ["neutral", "new_home", "congratulations", "birthday", "thank_you", "just_because"],
      default: "neutral",
    },
    /** Optional, from the purchaser. Capped and stripped of markup on write. */
    personalMessage: { type: String, default: "", maxlength: 200 },

    /** Null until claimed. Set to the CUSTOMER account, never an employee one. */
    recipient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },

    /*
     * What the purchaser typed, and what the recipient actually confirmed.
     *
     * Addresses live inside the User document, so the purchaser cannot create
     * the recipient's property — not before that account exists and not
     * afterwards without writing into somebody else's record. The snapshot is
     * a convenience for the claim screen and is never authoritative; addressId
     * points into the RECIPIENT's own addresses once they confirm it.
     */
    addressSnapshot: {
      line1: { type: String, default: "" },
      city: { type: String, default: "" },
      state: { type: String, default: "" },
      zip: { type: String, default: "" },
    },
    addressId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },

    /* -------------------------------- Terms ------------------------------- */
    plan: {
      type: String,
      enum: ["basic", "plus", "premium", "elite"],
      required: true,
      index: true,
    },
    /** 2 at launch. The schema has never been the thing limiting this. */
    durationMonths: { type: Number, required: true, min: 1, max: 24 },

    /*
     * The lifecycle state.
     *
     * DELIBERATELY NOT THE THING THAT GRANTS ACCESS. Whether a gift is usable
     * right now is computed from startAt and endAt every time it is asked
     * (see utils/gifts/giftAccess), so a delayed or missed lifecycle sweep can
     * never leave a customer locked out of a gift they hold. This field
     * records how far through its life the gift is, not whether it works.
     */
    status: {
      type: String,
      enum: ["purchased", "invited", "claimed", "cancelled"],
      required: true,
      default: "purchased",
      index: true,
    },

    /*
     * The entitlement window. Both are set at CLAIM, not at purchase.
     *
     * startAt may be in the future: a gift claimed by somebody with paid
     * coverage, or a second gift claimed while the first is running, is queued
     * to begin when the coverage ahead of it ends rather than overlapping and
     * wasting days that were paid for.
     */
    startAt: { type: Date, default: null, index: true },
    endAt: { type: Date, default: null, index: true },

    /* ------------------------------- Payment ------------------------------ */
    /*
     * WHAT THIS BLOCK MUST NEVER CONTAIN
     *
     * No stripeCustomerId. No stripeSubscriptionId. No stripePriceId tied to a
     * recurring price. No payment method reference of any kind.
     *
     * Those fields are exactly what a billing-portal or subscription lookup
     * searches for, and their absence is the reason a recipient cannot reach
     * the purchaser's card. A test asserts this schema never gains them.
     *
     * The two identifiers below are records of a single completed charge. They
     * confer no ability to charge anything again, and they are also the
     * idempotency keys: a replayed webhook collides on the unique index rather
     * than creating a second gift.
     */
    stripeCheckoutSessionId: { type: String, default: null },
    stripePaymentIntentId: { type: String, default: null },
    stripeChargeId: { type: String, default: null },

    amountSubtotalCents: { type: Number, default: 0, min: 0 },
    discountCents: { type: Number, default: 0, min: 0 },

    /*
     * Tax as Stripe calculated it, never as we guessed it.
     *
     * Automatic tax is on for gifts exactly as it is for memberships, so the
     * figure that matters is the one on the completed Checkout Session. It is
     * recorded for the books and for support; nothing reads it back to decide
     * what somebody is owed, and nothing recomputes it.
     *
     * amountPaidCents below stays the tax-INCLUSIVE total (Stripe's
     * amount_total), which is what a refund is measured against — so refund
     * classification keeps working unchanged now that tax is collected.
     */
    taxCents: { type: Number, default: 0, min: 0 },
    /** Stripe's own word for whether it managed to calculate: complete, failed… */
    automaticTaxStatus: { type: String, default: "" },

    amountPaidCents: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: "usd", lowercase: true },

    /** For the audit trail. Never re-applied to anything. */
    promotionCodeId: { type: String, default: "" },
    couponId: { type: String, default: "" },

    /* ------------------------------- Refunds ------------------------------ */
    /*
     * Synchronised from Stripe, and deliberately DOES NOT revoke the gift.
     *
     * A refund webhook silently ending a membership somebody is using is worse
     * than a manual step: the refund may be a partial goodwill gesture, a
     * duplicate-charge correction, or a chargeback we intend to contest.
     * Revocation is an explicit Admin action; this block only keeps the money
     * accurate.
     */
    refundStatus: {
      type: String,
      enum: ["none", "partial", "full"],
      default: "none",
      index: true,
    },
    amountRefundedCents: { type: Number, default: 0, min: 0 },
    refunds: { type: [GiftRefundSchema], default: [] },
    lastRefundAt: { type: Date, default: null },

    /* ---------------------------- Claim token ----------------------------- */
    /*
     * TOKEN EXPIRY AND GIFT VALUE ARE TWO DIFFERENT THINGS.
     *
     * The token is a credential sitting in somebody's inbox, so it expires for
     * security. The gift is money that was paid, so it does not evaporate
     * because a link went stale — an expired token leaves the gift fully
     * intact and re-issuable by Admin.
     *
     * Only the HASH is stored. The token itself is never written to the
     * database or a log, so a database read cannot yield a working claim link.
     * Re-issuing replaces the hash, which is what makes every previously
     * issued token stop working.
     */
    claimTokenHash: { type: String, default: "", index: true },
    claimTokenVersion: { type: Number, default: 0 },
    claimTokenIssuedAt: { type: Date, default: null },
    claimTokenExpiresAt: { type: Date, default: null, index: true },
    claimTokenReissuedCount: { type: Number, default: 0 },

    /* ------------------------------ Timeline ------------------------------ */
    purchasedAt: { type: Date, default: null },
    invitedAt: { type: Date, default: null },
    claimedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    cancelledReason: { type: String, default: "" },
    cancelledByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    /** Bookkeeping only. Never read to decide access. */
    lifecycleNotes: { type: String, default: "" },
    endingSoonEmailAt: { type: Date, default: null },
    expiredEmailAt: { type: Date, default: null },
  },
  { timestamps: true }
);

/*
 * The duplicate defence, matching the pattern VisitEntitlement already uses
 * for one-time purchases: partial so the many nulls before payment do not
 * collide with each other, unique so a replayed webhook cannot create a second
 * gift from one payment.
 */
GiftMembershipSchema.index(
  { stripeCheckoutSessionId: 1 },
  {
    unique: true,
    name: "gift_unique_checkout_session",
    partialFilterExpression: { stripeCheckoutSessionId: { $type: "string" } },
  }
);
GiftMembershipSchema.index(
  { stripePaymentIntentId: 1 },
  {
    unique: true,
    name: "gift_unique_payment_intent",
    partialFilterExpression: { stripePaymentIntentId: { $type: "string" } },
  }
);

/** "What does this person hold", the access lookup. */
GiftMembershipSchema.index(
  { recipient: 1, status: 1, startAt: 1, endAt: 1 },
  { name: "gift_recipient_window_idx" }
);
/** "What is waiting for this email", the claim lookup. */
GiftMembershipSchema.index(
  { recipientEmail: 1, status: 1 },
  { name: "gift_recipient_email_idx" }
);
/** Admin listing, newest first. */
GiftMembershipSchema.index({ createdAt: -1 }, { name: "gift_recent_idx" });
GiftMembershipSchema.index({ purchaser: 1, createdAt: -1 }, { name: "gift_purchaser_idx" });

module.exports = mongoose.model("GiftMembership", GiftMembershipSchema);
