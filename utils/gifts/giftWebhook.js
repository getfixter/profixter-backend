const GiftMembership = require("../../models/GiftMembership");
const User = require("../../models/User");
const { normalizeEmail } = require("../identity");
const { issueInvitation, recordPurchasedGift, syncRefund } = require("./giftService");

/**
 * Turning a confirmed Stripe payment into a gift.
 *
 * THIS IS THE ONLY PLACE A GIFT COMES INTO EXISTENCE.
 *
 * Not the checkout route, and emphatically not the browser's success redirect.
 * A redirect is a claim by the client that a payment happened; a gift is worth
 * several hundred dollars, and the only trustworthy statement that money moved
 * is Stripe telling us so on a signed webhook.
 *
 * Kept in utils rather than inline in routes/webhook.js so the routing file
 * gains one small branch rather than two hundred lines, matching how the
 * One-Time Visit and Full Day handlers are already organised.
 */

const GIFT_PRODUCT_KIND = "gift_membership";

/** Whether a Stripe object belongs to this feature. */
function isGiftSession(session) {
  return session?.metadata?.productKind === GIFT_PRODUCT_KIND;
}

/**
 * What the purchaser actually paid, read from Stripe rather than from us.
 *
 * The quote we showed is what we asked for; these are what Stripe took, after
 * whatever promotion code the purchaser applied. Recording our own figure
 * would make the books disagree with the payment processor the first time a
 * coupon was used.
 */
function paymentFromSession(session) {
  const discount = session?.total_details?.amount_discount;
  const promo = session?.discounts?.[0];

  return {
    checkoutSessionId: session?.id || null,
    paymentIntentId:
      typeof session?.payment_intent === "string"
        ? session.payment_intent
        : session?.payment_intent?.id || null,
    amountSubtotalCents: Number(session?.amount_subtotal || 0),
    discountCents: Number(discount || 0),
    amountPaidCents: Number(session?.amount_total || 0),
    currency: String(session?.currency || "usd").toLowerCase(),
    promotionCodeId:
      typeof promo?.promotion_code === "string"
        ? promo.promotion_code
        : promo?.promotion_code?.id || "",
    couponId: typeof promo?.coupon === "string" ? promo.coupon : promo?.coupon?.id || "",
  };
}

/**
 * Handle a completed gift checkout.
 *
 * Idempotent twice over: the caller already holds the StripeWebhookEvent lock
 * for this event id, and the unique index on the checkout session means a
 * replay that slips past it still cannot produce a second gift.
 *
 * Returns the gift and whether it was newly created, so the caller knows
 * whether to send the emails — a replay must not re-invite anybody.
 */
async function handleGiftCheckoutCompleted(session, { Model = GiftMembership } = {}) {
  if (!isGiftSession(session)) return { handled: false };

  /*
   * An unpaid session is not a gift. Stripe sends checkout.session.completed
   * for sessions whose payment is still processing, so this is checked
   * explicitly rather than assumed from the event name.
   */
  if (session.payment_status && session.payment_status !== "paid") {
    console.warn(
      JSON.stringify({
        event: "gift_checkout_not_paid",
        stripeSessionId: session.id,
        paymentStatus: session.payment_status,
      })
    );
    return { handled: true, created: false, reason: "not_paid" };
  }

  const meta = session.metadata || {};
  const purchaser = meta.purchaserMongoId
    ? await User.findById(meta.purchaserMongoId)
    : null;

  if (!purchaser) {
    console.error(
      JSON.stringify({
        event: "gift_checkout_purchaser_missing",
        stripeSessionId: session.id,
      })
    );
    return { handled: true, created: false, reason: "purchaser_missing" };
  }

  const result = await recordPurchasedGift({
    purchaser,
    plan: meta.plan,
    durationMonths: Number(meta.durationMonths),
    recipient: {
      email: normalizeEmail(meta.recipientEmail),
      firstName: meta.recipientFirstName,
      lastName: meta.recipientLastName,
    },
    address: {
      line1: meta.addressLine1,
      city: meta.addressCity,
      state: meta.addressState,
      zip: meta.addressZip,
    },
    payment: paymentFromSession(session),
    Model,
  });

  if (!result.created) {
    console.log(
      JSON.stringify({
        event: "gift_checkout_replayed",
        stripeSessionId: session.id,
        giftNumber: result.gift?.giftNumber || "",
      })
    );
    return { handled: true, created: false, gift: result.gift, duplicate: true };
  }

  // The invitation token is minted here, not at purchase-screen time, because
  // until this moment there was nothing to invite anybody to.
  const invitation = await issueInvitation(result.gift, { Model });

  console.log(
    JSON.stringify({
      event: "gift_purchased",
      giftNumber: result.gift.giftNumber,
      plan: result.gift.plan,
      durationMonths: result.gift.durationMonths,
      amountPaidCents: result.gift.amountPaidCents,
      discountCents: result.gift.discountCents,
      hasPromotionCode: Boolean(result.gift.promotionCodeId),
    })
  );

  return { handled: true, created: true, gift: result.gift, invitation };
}

/**
 * Keep refund state in step with Stripe.
 *
 * Deliberately does NOT revoke the entitlement. A refund can be a partial
 * goodwill gesture, a duplicate-charge correction, or a chargeback we intend
 * to contest, and a webhook silently ending a membership somebody is using is
 * a worse failure than money and access disagreeing for a while. Revocation is
 * an Admin decision made on accurate numbers, which is what this provides.
 */
async function handleGiftRefund(charge, { Model = GiftMembership } = {}) {
  const paymentIntentId =
    typeof charge?.payment_intent === "string"
      ? charge.payment_intent
      : charge?.payment_intent?.id || null;

  if (!paymentIntentId) return { handled: false };

  const gift = await Model.findOne({ stripePaymentIntentId: paymentIntentId });
  if (!gift) return { handled: false };

  const refunds = charge?.refunds?.data || [];
  const results = [];
  for (const refund of refunds) {
    const synced = await syncRefund({ gift: await Model.findById(gift._id), refund, Model });
    results.push(synced);
  }

  // Remember the charge for the audit trail now that we know which it was.
  if (charge?.id && !gift.stripeChargeId) {
    await Model.updateOne({ _id: gift._id }, { $set: { stripeChargeId: charge.id } });
  }

  return { handled: true, giftNumber: gift.giftNumber, refunds: results.length };
}

module.exports = {
  GIFT_PRODUCT_KIND,
  handleGiftCheckoutCompleted,
  handleGiftRefund,
  isGiftSession,
  paymentFromSession,
};
