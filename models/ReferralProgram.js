/**
 * Customer referral program (2026-11-20): a personal link for every customer,
 * and a check of up to $149 when a NEW household they referred pays for a
 * membership twice. See utils/referrals for the rules; these are the records.
 *
 * - ReferralCode: one personal code per customer account (the link /r/<code>).
 * - CustomerReferral: one per REFERRED account (unique), from the moment the
 *   referral is attributed to the reward's last step (check mailed). The
 *   unique index on `referred` is what makes "one reward per referred
 *   customer" a database fact rather than a hope; the household rule (one per
 *   home) is checked by utils/referrals/signals and flagged for the owner.
 *
 * The legacy models/Referral.js (the 2025 "accept a referral ID" form) is left
 * untouched: its rows are history and never become rewards automatically.
 */
const mongoose = require("mongoose");

const { Schema } = mongoose;

const ReferralCodeSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    code: { type: String, required: true },
  },
  { timestamps: true }
);
ReferralCodeSchema.index({ user: 1 }, { unique: true });
ReferralCodeSchema.index({ code: 1 }, { unique: true });

const STATUSES = [
  "attributed", // referred, nothing paid yet
  "pending", // first paid membership invoice recorded; waiting for the second
  "eligible", // second paid invoice cleared: ready for the owner
  "approved", // owner approved after a fresh recheck against Stripe
  "mailed", // owner mailed the check (reference recorded)
  "void", // no reward (refunded, voided by the owner, chargeback)
  "not_eligible", // never could earn one (already a member, staff account ...)
];

const InvoiceSchema = new Schema(
  {
    invoiceId: { type: String, default: null },
    subscriptionId: { type: String, default: null },
    chargeId: { type: String, default: null },
    paymentIntentId: { type: String, default: null },
    billingReason: { type: String, default: null },
    paidAt: { type: Date, default: null },
    plan: { type: String, default: null },
    cycle: { type: String, default: null },
    // Membership lines only, from the Stripe invoice (cents).
    baseCents: { type: Number, default: 0 },
    discountCents: { type: Number, default: 0 },
    taxCents: { type: Number, default: 0 },
    amountPaidCents: { type: Number, default: 0 },
    paidPreTaxCents: { type: Number, default: 0 },
    // From the paying charge: cumulative, so a replayed refund event changes nothing.
    refundedCents: { type: Number, default: 0 },
    refundedPreTaxCents: { type: Number, default: 0 },
    disputed: { type: Boolean, default: false },
    discountSource: { type: String, default: "" },
    promoCode: { type: String, default: "" },
    cardFingerprint: { type: String, default: null },
  },
  { _id: false }
);

const FlagSchema = new Schema(
  {
    code: { type: String, required: true },
    strength: { type: String, default: "review" }, // same_person | household | payment | review
    text: { type: String, default: "" },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const PayeeSchema = new Schema(
  {
    name: { type: String, default: "" },
    line1: { type: String, default: "" },
    line2: { type: String, default: "" },
    city: { type: String, default: "" },
    state: { type: String, default: "" },
    zip: { type: String, default: "" },
    confirmedAt: { type: Date, default: null },
    // customer: the referrer, signed in and freshly re-verified; owner: entered by the owner after confirming with them.
    confirmedBy: { type: String, enum: ["customer", "owner", null], default: null },
    note: { type: String, default: "" },
  },
  { _id: false }
);

const CustomerReferralSchema = new Schema(
  {
    referrer: { type: Schema.Types.ObjectId, ref: "User", required: true },
    referred: { type: Schema.Types.ObjectId, ref: "User", required: true },
    code: { type: String, required: true },
    // How the referral reached the account: at sign-up, a signed-in claim, at checkout, the old ?ref= link.
    via: { type: String, enum: ["signup", "claim", "checkout", "legacy_accept"], required: true },
    capturedAt: { type: Date, default: null }, // when the friend opened the link (browser clock, clamped)
    status: { type: String, enum: STATUSES, default: "attributed" },
    reason: { type: String, default: "" },
    first: { type: InvoiceSchema, default: null },
    second: { type: InvoiceSchema, default: null },
    amountCents: { type: Number, default: 0 },
    flags: { type: [FlagSchema], default: [] },
    flagsReview: {
      clearedAt: { type: Date, default: null },
      by: { type: Schema.Types.ObjectId, ref: "User", default: null },
      note: { type: String, default: "" },
      // The flag codes the owner looked at: a NEW flag after this re-opens the review.
      codes: { type: [String], default: [] },
    },
    payee: { type: PayeeSchema, default: () => ({}) },
    approval: {
      at: { type: Date, default: null },
      by: { type: Schema.Types.ObjectId, ref: "User", default: null },
      amountCents: { type: Number, default: 0 },
    },
    check: {
      reference: { type: String, default: "" },
      mailedAt: { type: Date, default: null },
      by: { type: Schema.Types.ObjectId, ref: "User", default: null },
      note: { type: String, default: "" },
    },
    lastRecheck: {
      at: { type: Date, default: null },
      ok: { type: Boolean, default: null },
      changes: { type: [String], default: [] },
    },
    notified: {
      referrerPendingAt: { type: Date, default: null },
      referrerReadyAt: { type: Date, default: null },
      ownerReadyAt: { type: Date, default: null },
      ownerAttentionAt: { type: Date, default: null },
    },
    // A problem after approval (refund, chargeback): stays until the owner looks.
    attention: { type: String, default: "" },
    history: {
      type: [
        new Schema(
          {
            at: { type: Date, default: Date.now },
            event: { type: String, required: true },
            by: { type: String, default: "system" },
            detail: { type: String, default: "" },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
  },
  // Two webhooks for the same referral can land together: a stale save fails and is retried (utils/referrals/engine).
  { timestamps: true, optimisticConcurrency: true }
);
CustomerReferralSchema.index({ referred: 1 }, { unique: true });
CustomerReferralSchema.index({ referrer: 1, createdAt: -1 });
CustomerReferralSchema.index({ status: 1, updatedAt: -1 });
CustomerReferralSchema.index({ "first.invoiceId": 1 }, { sparse: true });
CustomerReferralSchema.index({ "second.invoiceId": 1 }, { sparse: true });
CustomerReferralSchema.index({ "first.chargeId": 1 }, { sparse: true });
CustomerReferralSchema.index({ "second.chargeId": 1 }, { sparse: true });

module.exports = {
  STATUSES,
  ReferralCode: mongoose.models.ReferralCode || mongoose.model("ReferralCode", ReferralCodeSchema),
  CustomerReferral: mongoose.models.CustomerReferral || mongoose.model("CustomerReferral", CustomerReferralSchema),
};
