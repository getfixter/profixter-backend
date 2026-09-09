const crypto = require("crypto");

const GiftMembership = require("../../models/GiftMembership");
const Subscription = require("../../models/Subscription");
const { normalizeEmail } = require("../identity");
const { findCustomerByEmail } = require("../userLookup");
const { coverageEndsAt, giftAccessState } = require("./giftAccess");
const { createClaimToken } = require("./giftClaimToken");
const { normalizePlan, quoteGift, termWindow } = require("./giftPricing");
const { selfGiftingAllowed } = require("./giftConfig");

/**
 * Buying, claiming and reconciling a gift.
 *
 * Two rules govern everything in this file, and both exist to keep the
 * purchaser's money and the recipient's access from ever touching:
 *
 *   1. No code path here creates or updates a Subscription document. The only
 *      read of Subscription is to find out when somebody's existing paid
 *      coverage ends, so a gift can be queued behind it rather than wasting
 *      days on top of it. That read never writes.
 *
 *   2. Nothing here stores a Stripe customer or subscription id on a gift.
 *      The schema has no field for one; this is the reminder for anyone
 *      tempted to add it.
 */

function giftNumber() {
  // Short, unambiguous, and not sequential: a support reference nobody can
  // guess their way along.
  return `G${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

/* -------------------------------------------------------------------------- */
/* Purchase                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Whether this purchase is allowed, before any money is involved.
 *
 * Every refusal is a reason string rather than a thrown error, because the
 * purchase screen has to explain what went wrong and "something failed" is not
 * an explanation.
 */
async function validateGiftPurchase({
  purchaser,
  plan,
  durationMonths,
  recipientEmail,
  UserLookup = { findCustomerByEmail },
}) {
  const normalizedPlan = normalizePlan(plan);
  const quote = quoteGift({ plan: normalizedPlan, durationMonths });
  if (!quote.ok) return { ok: false, reason: quote.reason };

  const email = normalizeEmail(recipientEmail);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, reason: "invalid_recipient_email" };
  }

  /*
   * SELF-GIFTING IS BLOCKED FOR LAUNCH, and the reason is the promotion codes
   * rather than anything philosophical about gifting yourself.
   *
   * Gift checkout accepts promotion codes. If somebody may name their own
   * account as the recipient, then every gift coupon becomes a way to buy
   * their own membership at a discount — which is not what any of those codes
   * were created for and not a decision the pricing has been reviewed against.
   *
   * Checked on the ACCOUNT as well as the typed address, so using a second
   * spelling of your own email does not get past it.
   */
  if (!selfGiftingAllowed()) {
    const purchaserEmail = normalizeEmail(purchaser?.email);
    if (purchaserEmail && purchaserEmail === email) {
      return { ok: false, reason: "self_gift_not_allowed" };
    }
    const existing = await UserLookup.findCustomerByEmail(email);
    if (existing && String(existing._id) === String(purchaser?._id)) {
      return { ok: false, reason: "self_gift_not_allowed" };
    }
  }

  return { ok: true, plan: normalizedPlan, quote, recipientEmail: email };
}

/**
 * Record a paid gift.
 *
 * Called ONLY from the Stripe webhook, on a session Stripe has confirmed as
 * paid. Never from the browser's success redirect: a redirect is a claim by
 * the client that a payment happened, and a gift is worth hundreds of dollars.
 *
 * Idempotent through the unique index on the checkout session, so a replayed
 * webhook returns the gift that already exists instead of creating a second.
 */
async function recordPurchasedGift({
  purchaser,
  plan,
  durationMonths,
  recipient,
  address,
  payment,
  Model = GiftMembership,
}) {
  const email = normalizeEmail(recipient?.email);

  const doc = {
    giftNumber: giftNumber(),
    purchaser: purchaser?._id || null,
    purchaserSnapshot: {
      name: String(purchaser?.name || "").slice(0, 120),
      email: normalizeEmail(purchaser?.email) || "",
    },
    recipientEmail: email,
    recipientFirstName: String(recipient?.firstName || "").slice(0, 80),
    recipientLastName: String(recipient?.lastName || "").slice(0, 80),
    addressSnapshot: {
      line1: String(address?.line1 || "").slice(0, 200),
      city: String(address?.city || "").slice(0, 100),
      state: String(address?.state || "").slice(0, 40),
      zip: String(address?.zip || "").slice(0, 20),
    },
    plan: normalizePlan(plan),
    durationMonths: Number(durationMonths),
    status: "purchased",
    purchasedAt: new Date(),
    stripeCheckoutSessionId: payment?.checkoutSessionId || null,
    stripePaymentIntentId: payment?.paymentIntentId || null,
    stripeChargeId: payment?.chargeId || null,
    amountSubtotalCents: Number(payment?.amountSubtotalCents || 0),
    discountCents: Number(payment?.discountCents || 0),
    taxCents: Number(payment?.taxCents || 0),
    automaticTaxStatus: String(payment?.automaticTaxStatus || ""),
    amountPaidCents: Number(payment?.amountPaidCents || 0),
    currency: String(payment?.currency || "usd").toLowerCase(),
    promotionCodeId: String(payment?.promotionCodeId || ""),
    couponId: String(payment?.couponId || ""),
  };

  try {
    const created = await Model.create(doc);
    return { created: true, gift: created };
  } catch (error) {
    if (error?.code === 11000) {
      // The webhook was replayed. Whichever attempt lost the race, the gift
      // that exists is the right one.
      const existing = await Model.findOne({
        stripeCheckoutSessionId: payment?.checkoutSessionId,
      });
      return { created: false, gift: existing, duplicate: true };
    }
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* Invitation                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Mint an invitation for a gift, replacing any previous one.
 *
 * Used both for the first invitation and for an Admin re-issue, because they
 * are the same operation: the version increments, the stored hash is replaced,
 * and every link handed out before this moment stops verifying. That last part
 * is what re-issuing after a stale or leaked link is for.
 *
 * The gift itself is untouched — this never changes the term, the money or the
 * status beyond marking it invited.
 */
async function issueInvitation(gift, { reissue = false, Model = GiftMembership } = {}) {
  const nextVersion = Number(gift.claimTokenVersion || 0) + 1;
  const { token, fields } = createClaimToken({ giftId: gift._id, version: nextVersion });

  await Model.updateOne(
    { _id: gift._id },
    {
      $set: {
        ...fields,
        status: gift.status === "purchased" ? "invited" : gift.status,
        invitedAt: gift.invitedAt || new Date(),
      },
      $inc: { claimTokenReissuedCount: reissue ? 1 : 0 },
    }
  );

  return { token, expiresAt: fields.claimTokenExpiresAt, version: nextVersion };
}

/* -------------------------------------------------------------------------- */
/* Claim                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Whether this signed-in account may claim this gift.
 *
 * Enforced server-side and by email, because the link travels: it gets
 * forwarded, it sits in a shared inbox, it ends up in a screenshot. Holding
 * the link is not evidence of being the intended recipient.
 */
function claimantMatches(gift, user) {
  const intended = normalizeEmail(gift?.recipientEmail);
  const actual = normalizeEmail(user?.email);
  return Boolean(intended && actual && intended === actual);
}

/**
 * When a newly claimed gift should begin.
 *
 * Behind everything the recipient already holds, so nothing is spent twice:
 * an existing paid membership runs to its end, then any gifts already queued,
 * and only then this one. If nothing is ahead, it starts now.
 *
 * The paid subscription is READ ONLY, for its end date. Nothing in this
 * function or its callers writes to it — a gift must never modify, cancel,
 * pause or downgrade a membership somebody is paying for.
 */
async function computeStartAt(
  { recipientId, addressId, now = new Date() },
  { SubscriptionModel = Subscription, GiftModel = GiftMembership } = {}
) {
  const paid = await SubscriptionModel.findOne({
    user: recipientId,
    addressId,
    status: { $in: ["active", "trialing"] },
  })
    .select("currentPeriodEnd cancellationDate nextPaymentDate")
    .lean();

  const existingGifts = await GiftModel.find({
    recipient: recipientId,
    addressId,
    status: "claimed",
  })
    .select("status startAt endAt")
    .lean();

  const paidCoverageEndsAt =
    paid?.currentPeriodEnd || paid?.cancellationDate || paid?.nextPaymentDate || null;

  const ahead = coverageEndsAt({ paidCoverageEndsAt, existingGifts }, now);
  return ahead || new Date(now);
}

/**
 * Attach a gift to an account and set its window.
 *
 * The window is computed and PERSISTED here rather than left for a worker,
 * which is what makes access correct without one: from this moment the record
 * says exactly when the gift runs, and every access check reads those dates.
 */
async function claimGift({
  gift,
  user,
  addressId,
  now = new Date(),
  Model = GiftMembership,
  dependencies = {},
}) {
  if (!claimantMatches(gift, user)) {
    return { ok: false, reason: "recipient_mismatch" };
  }
  if (gift.status === "claimed") {
    return { ok: false, reason: "already_claimed" };
  }
  if (gift.status === "cancelled") {
    return { ok: false, reason: "gift_cancelled" };
  }
  if (!addressId) {
    return { ok: false, reason: "address_required" };
  }

  const startAt = await computeStartAt(
    { recipientId: user._id, addressId, now },
    dependencies
  );
  const window = termWindow(startAt, gift.durationMonths);
  if (!window) return { ok: false, reason: "invalid_term" };

  /*
   * Conditional on the status still being unclaimed, so two tabs racing the
   * same link produce one claim and one no-op rather than two windows.
   */
  const result = await Model.updateOne(
    { _id: gift._id, status: { $in: ["purchased", "invited"] } },
    {
      $set: {
        recipient: user._id,
        addressId,
        status: "claimed",
        claimedAt: new Date(now),
        startAt: window.startAt,
        endAt: window.endAt,
        // The link has done its job. Clearing the hash makes it unusable
        // immediately rather than leaving a working credential in an inbox.
        claimTokenHash: "",
      },
    }
  );

  if (result.modifiedCount !== 1) {
    return { ok: false, reason: "already_claimed" };
  }

  const claimed = await Model.findById(gift._id).lean();
  return {
    ok: true,
    gift: claimed,
    queued: giftAccessState(claimed, now).state === "queued",
  };
}

/* -------------------------------------------------------------------------- */
/* Refunds                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Bring a gift's refund state in line with Stripe.
 *
 * DOES NOT REVOKE THE ENTITLEMENT, and that is a deliberate policy choice
 * rather than an omission. A refund can be a partial goodwill gesture, a
 * correction of a duplicated charge, or a chargeback we intend to contest —
 * and a webhook silently ending a membership somebody is actively using is a
 * worse failure than money and access briefly disagreeing. Revocation is an
 * explicit Admin action; this keeps the money accurate so that decision can be
 * made on facts.
 *
 * Idempotent by refund id: Stripe re-delivers, and a re-delivered refund must
 * not be counted twice.
 */
async function syncRefund({ gift, refund, Model = GiftMembership }) {
  if (!gift || !refund?.id) return { ok: false, reason: "missing_input" };

  const already = (gift.refunds || []).some((r) => r.stripeRefundId === refund.id);
  if (already) {
    return { ok: true, duplicate: true, refundStatus: gift.refundStatus };
  }

  const amountCents = Number(refund.amount || 0);
  const refundedTotal = Number(gift.amountRefundedCents || 0) + amountCents;
  const paid = Number(gift.amountPaidCents || 0);

  /*
   * "Full" means the whole captured amount has come back. Compared with >= so
   * that a rounding difference or an over-refund still reads as full rather
   * than sitting at partial forever.
   */
  const refundStatus = refundedTotal <= 0 ? "none" : refundedTotal >= paid ? "full" : "partial";

  const result = await Model.updateOne(
    { _id: gift._id, "refunds.stripeRefundId": { $ne: refund.id } },
    {
      $push: {
        refunds: {
          stripeRefundId: refund.id,
          amountCents,
          currency: String(refund.currency || gift.currency || "usd").toLowerCase(),
          reason: String(refund.reason || ""),
          stripeCreatedAt: refund.created ? new Date(refund.created * 1000) : null,
          recordedAt: new Date(),
        },
      },
      $set: {
        amountRefundedCents: refundedTotal,
        refundStatus,
        lastRefundAt: new Date(),
      },
    }
  );

  if (result.modifiedCount !== 1) {
    // Somebody else recorded it between the check and the write.
    return { ok: true, duplicate: true };
  }

  console.log(
    JSON.stringify({
      event: "gift_refund_synced",
      giftNumber: gift.giftNumber,
      refundStatus,
      amountRefundedCents: refundedTotal,
      amountPaidCents: paid,
      entitlementRevoked: false,
    })
  );

  return { ok: true, refundStatus, amountRefundedCents: refundedTotal };
}

module.exports = {
  claimGift,
  claimantMatches,
  computeStartAt,
  giftNumber,
  issueInvitation,
  recordPurchasedGift,
  syncRefund,
  validateGiftPurchase,
};
