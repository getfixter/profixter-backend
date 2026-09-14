const mongoose = require("mongoose");

/**
 * One membership month that actually counted toward Loyalty Benefits.
 *
 * THE LEDGER IS THE SOURCE OF TRUTH. There is no counter anywhere that says
 * "this member has four months". Four rows means four months, and everything
 * the program decides — progress, milestones, which plan a reward resolves to —
 * is derived from these rows at the moment it is asked. A counter would drift
 * the first time a webhook was replayed or a payment reversed; rows cannot.
 *
 * WHAT PUTS A ROW HERE, AND NOTHING ELSE PUTS A ROW HERE
 *
 * A Stripe invoice for a MONTHLY membership reaching `paid` with
 * `billing_reason === "subscription_cycle"`, dated at or after the program's
 * effective timestamp. That is the renewal boundary: the member was billed for
 * another month and the money moved.
 *
 * Deliberately NOT counted: `subscription_create` (signing up is not staying),
 * `subscription_update` (an upgrade proration is a plan change, and counting it
 * would let anyone manufacture months from the billing portal), manual invoices,
 * project invoices, gift payments and tips. Every one of those is a paid invoice
 * on the same Stripe customer, and none of them is a membership renewal.
 *
 * The one exception is `gift_seed`: months a gift recipient genuinely received
 * before converting to their own membership, written once at conversion. They
 * carry no invoice because no invoice exists — the gift was paid for by somebody
 * else, in one payment, months earlier.
 *
 * WHY THE TRACK IS (user, addressId)
 *
 * A membership covers a property, not a person — Subscription enforces one
 * active row per (user, address) at the database level, and a customer with two
 * houses has two plans, two billing cycles and two independent relationships
 * with us. Loyalty follows the membership, so a Premium house and a Basic house
 * earn separately and neither can borrow the other's progress.
 */

const LoyaltyCycleSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    userId: { type: String, required: true, index: true },
    addressId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },

    /**
     * The REAL paid plan for this month, stamped at the time it was counted.
     *
     * This is what makes the window-minimum rule possible, and it is the reason
     * a plan history has to be written down rather than read off the
     * subscription later: `subscription.subscriptionType` only ever knows what
     * the plan is now. A member who was Basic for three months and is Elite
     * today would otherwise look like they had always been Elite.
     *
     * A temporary loyalty upgrade is NOT a paid plan and never lands here.
     */
    plan: {
      type: String,
      required: true,
      enum: ["basic", "plus", "premium", "elite"],
    },

    /**
     * Which unbroken run of membership this month belongs to.
     *
     * Increments when a member returns after a genuine break, which is what
     * restarts their progress without deleting anything. Grants are unique per
     * (track, milestone, generation), so somebody who leaves for a year and
     * comes back can earn the three-month reward again — once.
     */
    generation: { type: Number, required: true, default: 1, index: true },

    /** Position within the generation, including reversed rows. Audit only. */
    sequence: { type: Number, required: true },

    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },

    source: {
      type: String,
      required: true,
      enum: ["subscription_cycle", "gift_seed"],
      default: "subscription_cycle",
    },

    stripeInvoiceId: { type: String, default: null },
    stripeSubscriptionId: { type: String, default: null, index: true },
    /** The gift these seeded months came from. Null for real renewals. */
    giftMembershipId: { type: mongoose.Schema.Types.ObjectId, default: null },

    amountPaidCents: { type: Number, default: 0 },
    countedAt: { type: Date, required: true, default: Date.now },

    /**
     * Money that came back.
     *
     * A refunded or successfully disputed month is not a month the member kept
     * paying for, so it stops counting. The row is never deleted: anybody asking
     * why a milestone moved backwards needs to see that it happened and why.
     */
    reversed: { type: Boolean, default: false, index: true },
    reversedAt: { type: Date, default: null },
    reversedReason: { type: String, default: null },
  },
  { timestamps: true }
);

/**
 * One invoice, one month. This is the whole defence against double counting.
 *
 * Stripe re-delivers events, retries after a 500, and can deliver the same
 * invoice through more than one event type. All of those arrive here trying to
 * insert the same stripeInvoiceId, and the database refuses the second. Checking
 * first and then writing would leave a window between the two; this leaves none.
 *
 * Partial because gift seeds carry no invoice and their many nulls would
 * otherwise collide with each other.
 */
LoyaltyCycleSchema.index(
  { stripeInvoiceId: 1 },
  {
    unique: true,
    name: "loyalty_cycle_unique_invoice",
    partialFilterExpression: { stripeInvoiceId: { $type: "string" } },
  }
);

/**
 * One seed per gift, on the same reasoning. A recipient who converts, cancels
 * and converts again must not be seeded twice from the same two gifted months.
 */
LoyaltyCycleSchema.index(
  { giftMembershipId: 1 },
  {
    unique: true,
    name: "loyalty_cycle_unique_gift_seed",
    partialFilterExpression: { giftMembershipId: { $type: "objectId" } },
  }
);

/** "How far along is this property", the question every read starts with. */
LoyaltyCycleSchema.index(
  { user: 1, addressId: 1, generation: 1, periodStart: 1 },
  { name: "loyalty_cycle_track_idx" }
);

module.exports = mongoose.model("LoyaltyCycle", LoyaltyCycleSchema);
