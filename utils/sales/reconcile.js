/**
 * Sales reconciliation: catches up anything a missed or failed webhook left
 * out, through the SAME idempotent functions (so running it twice, or after
 * the webhook did arrive, changes nothing). Reads Stripe and writes only our
 * own sales records; it never charges, refunds or messages anyone.
 *
 *   firstPayments  memberships started in the window that have no first-paid
 *                  sale yet: look up their subscription_create invoice
 *   refunds        credited sales whose charge shows more refunded money (in
 *                  the RevenueCharge mirror) than the refunds we recorded
 */
const Subscription = require("../../models/Subscription");
const RevenueCharge = require("../../models/RevenueCharge");
const { SalesEvent } = require("../../models/Sales");
const { onInvoicePaid, onChargeRefunded } = require("./stripeEvents");

const stripe = () => require("../subscriptionManagement").stripe;

async function firstPayments({ days = 45, limit = 200 } = {}) {
  const since = new Date(Date.now() - days * 86400000);
  const subs = await Subscription.find({ createdAt: { $gte: since }, stripeSubscriptionId: { $nin: [null, ""] } }).limit(limit).lean();
  let checked = 0;
  let recorded = 0;
  for (const sub of subs) {
    if (await SalesEvent.exists({ "stripe.subscriptionId": sub.stripeSubscriptionId, kind: "membership_first_paid" })) continue;
    checked += 1;
    const list = await stripe().invoices.list({ subscription: sub.stripeSubscriptionId, limit: 5 });
    const first = (list?.data || []).find((i) => i.billing_reason === "subscription_create" && i.status === "paid");
    if (!first) continue;
    const stripeSubscription = await stripe().subscriptions.retrieve(sub.stripeSubscriptionId);
    const doc = await Subscription.findById(sub._id);
    const r = await onInvoicePaid({ invoice: first, stripeSubscription, subscription: doc });
    if (r) recorded += 1;
  }
  return { checked, recorded };
}

async function refunds({ days = 180 } = {}) {
  const since = new Date(Date.now() - days * 86400000);
  const sales = await SalesEvent.find({ kind: { $in: ["membership_first_paid", "full_day_paid", "membership_change_paid"] }, paidAt: { $gte: since }, "stripe.chargeId": { $ne: null } }).lean();
  let checked = 0;
  let recorded = 0;
  for (const sale of sales) {
    const mirror = await RevenueCharge.findOne({ chargeId: sale.stripe.chargeId }).select("refundedCents").lean();
    if (!mirror || !(mirror.refundedCents > 0)) continue;
    const ours = await SalesEvent.find({ kind: "refund", relatesTo: sale._id }).lean();
    const recordedCents = ours.reduce((s, r) => s + (r.amounts?.amountCents || 0), 0);
    if (recordedCents >= mirror.refundedCents) continue;
    checked += 1;
    const charge = await stripe().charges.retrieve(sale.stripe.chargeId, { expand: ["refunds"] });
    const out = await onChargeRefunded(charge);
    if (out?.length) recorded += 1;
  }
  return { checked, recorded };
}

module.exports = { firstPayments, refunds };
