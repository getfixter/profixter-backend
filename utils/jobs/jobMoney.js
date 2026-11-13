/**
 * What a job is worth to the customer, for display. Never moves money.
 *
 * Refunds stay in Stripe (owner decision Q-9): this only says what was paid,
 * that cancelling does not refund it, and where in the Stripe dashboard the
 * payment is. Ids are payment-intent / checkout ids, which are references, not
 * secrets; no key, client secret or token is read or returned.
 */
const VisitEntitlement = require("../../models/VisitEntitlement");
const Tip = require("../../models/Tip");
const { isFreeVisit } = require("./jobStatus");

const REFUND_NOTE = "Canceling does not refund. Refunds are made in Stripe.";

function stripeDashboardBase() {
  const key = String(process.env.STRIPE_SECRET_KEY || "");
  return key.startsWith("sk_test") ? "https://dashboard.stripe.com/test" : "https://dashboard.stripe.com";
}

function stripePaymentUrl(paymentIntentId) {
  const id = String(paymentIntentId || "").trim();
  if (!/^pi_[A-Za-z0-9_]+$/.test(id)) return null;
  return `${stripeDashboardBase()}/payments/${id}`;
}

async function entitlementFor(booking) {
  if (!booking?.entitlementId) return null;
  return VisitEntitlement.findById(booking.entitlementId)
    .select("source status priceCents currency stripePaymentIntentId stripeCheckoutSessionId purchasedAt")
    .lean();
}

/** The payment facts the cancel response and the detail screen show. */
async function paymentInfoFor(booking, { entitlement } = {}) {
  const ent = entitlement === undefined ? await entitlementFor(booking) : entitlement;
  const purchased = ent && ent.source === "purchase";
  const paid = booking?.paymentState === "paid" || Boolean(purchased && ["paid", "consumed"].includes(ent.status));
  const paymentIntentId = purchased ? ent.stripePaymentIntentId || null : null;
  return {
    paymentState: booking?.paymentState || "not_required",
    paid,
    paidCents: paid ? (purchased && Number.isFinite(ent.priceCents) ? ent.priceCents : null) : 0,
    currency: (purchased && ent.currency) || "usd",
    paidAt: paid && purchased ? ent.purchasedAt || null : null,
    stripePaymentIntentId: paymentIntentId,
    stripeCheckoutSessionId: purchased ? ent.stripeCheckoutSessionId || null : null,
    stripeDashboardUrl: stripePaymentUrl(paymentIntentId),
    refunded: booking?.paymentState === "refunded",
    refundNote: paid ? REFUND_NOTE : "",
  };
}

async function tipCentsFor(bookingId) {
  const rows = await Tip.aggregate([
    { $match: { booking: bookingId, status: { $in: ["succeeded", "partially_refunded"] } } },
    { $group: { _id: null, cents: { $sum: "$amountCents" } } },
  ]);
  return rows[0]?.cents || 0;
}

/**
 * The money block of the job detail:
 *   { kind, label, amountCents?, paidAt?, stripeUrl?, tipCents? }
 * kind is one of membership_included | paid | payment_pending | payment_failed |
 * refunded | free | admin_free | full_day_included | full_day_loyalty.
 */
async function moneyBlockFor(booking) {
  const ent = await entitlementFor(booking);
  const tipCents = await tipCentsFor(booking._id).catch(() => 0);
  const withTip = (block) => (tipCents ? { ...block, tipCents } : block);
  if (booking.bookingType === "full_day_visit" && ent?.source === "membership_benefit") {
    return withTip({ kind: "full_day_included", label: "Included with the Elite membership" });
  }
  if (booking.bookingType === "full_day_visit" && ent?.source === "loyalty_benefit") {
    return withTip({ kind: "full_day_loyalty", label: "Loyalty Full Day (no charge)" });
  }
  const info = await paymentInfoFor(booking, { entitlement: ent });
  if (info.refunded) return withTip({ kind: "refunded", label: "Refunded in Stripe" });
  if (info.paid) {
    return withTip({
      kind: "paid",
      label: info.paidCents != null ? "Paid for this visit" : "Paid for this visit (amount in Stripe)",
      ...(info.paidCents != null ? { amountCents: info.paidCents } : {}),
      ...(info.paidAt ? { paidAt: info.paidAt } : {}),
      ...(info.stripeDashboardUrl ? { stripeUrl: info.stripeDashboardUrl } : {}),
    });
  }
  if (booking.paymentState === "pending") {
    return withTip({ kind: "payment_pending", label: "Awaiting payment", ...(ent?.priceCents ? { amountCents: ent.priceCents } : {}) });
  }
  if (["failed", "expired"].includes(booking.paymentState)) {
    return withTip({ kind: "payment_failed", label: booking.paymentState === "expired" ? "Payment window expired" : "Payment failed" });
  }
  if (booking.accessType === "admin") return withTip({ kind: "admin_free", label: "Complimentary (Admin free visit)" });
  if (isFreeVisit(booking)) return withTip({ kind: "free", label: "Free Visit (no charge)" });
  return withTip({ kind: "membership_included", label: "Included in the membership" });
}

module.exports = {
  REFUND_NOTE,
  moneyBlockFor,
  paymentInfoFor,
  stripePaymentUrl,
  tipCentsFor,
};
