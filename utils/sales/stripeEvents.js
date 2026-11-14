/**
 * Stripe webhook hooks for the sales desk. Each one turns a verified payment
 * into a SalesEvent (written once, keyed by Stripe ids) and lets credit.js
 * decide credit. They never throw into the webhook: a sales problem must never
 * turn a processed payment into a 500 that makes Stripe retry it (the nightly
 * reconciliation and a replay can catch up, idempotently).
 *
 * WHAT COUNTS
 * - Membership: invoice.paid with billing_reason "subscription_create" and
 *   money actually paid. "subscription_cycle" (renewals) is ignored entirely.
 *   "subscription_update" (a paid plan change) is recorded as
 *   membership_change_paid: never credited automatically.
 * - Full Day: a separately PAID Full Day (entitlement source "purchase",
 *   Checkout payment_status "paid"). Membership and loyalty days never reach here.
 * - Commissionable amount: only the membership lines of the invoice, after
 *   discounts, excluding tax. Tips, materials, extra charges and anything else
 *   are separate payments and never part of these events.
 * - Time: Stripe's payment time (invoice status_transitions.paid_at, the
 *   charge's created time), never the webhook's arrival.
 */
const User = require("../../models/User");
const Subscription = require("../../models/Subscription");
const { SalesEvent } = require("../../models/Sales");
const { recordSale, creditForSale, recordRefund, recordDispute } = require("./credit");
const { catalogCycleCents, catalogMonthlyCents } = require("./rules");

const idOf = (v) => (v && typeof v === "object" ? v.id : v) || null;
const sum = (list, f) => (Array.isArray(list) ? list : []).reduce((s, x) => s + (Number(f(x)) || 0), 0);

function log(level, event, details) {
  const line = JSON.stringify({ at: new Date().toISOString(), area: "sales", event, ...details });
  if (level === "error") console.error(line);
  else console.log(line);
}

/** Verified only when the payment's Stripe customer is the account's, or our checkout put this account's id on it. */
function identityFor(user, { customerId, metadata }) {
  if (user?.stripeCustomerId && customerId && String(user.stripeCustomerId) === String(customerId)) return "stripe_customer";
  const m = metadata || {};
  const ids = [m.userId, m.userMongoId].filter(Boolean).map(String);
  if (user && ids.some((id) => id === String(user.userId) || id === String(user._id))) return "checkout_account";
  return "unverified";
}

function membershipLines(invoice) {
  const lines = invoice?.lines?.data || [];
  return lines.filter((l) => l.type === "subscription" || l.subscription || l.price?.recurring || l.plan);
}

/** Pre-tax money actually paid for the membership lines of an invoice, and its parts. */
function invoiceAmounts(invoice) {
  const lines = membershipLines(invoice);
  let base;
  let discount;
  if (lines.length) {
    base = sum(lines, (l) => (typeof l.amount_excluding_tax === "number" ? l.amount_excluding_tax : l.amount));
    discount = sum(lines, (l) => sum(l.discount_amounts, (d) => d.amount));
  } else {
    base = Number(invoice.subtotal_excluding_tax ?? invoice.subtotal ?? 0);
    discount = sum(invoice.total_discount_amounts, (d) => d.amount);
  }
  const tax = typeof invoice.tax === "number" ? invoice.tax : sum(invoice.total_tax_amounts, (t) => t.amount);
  const paidPreTax = Math.max(0, Math.min(base - discount, Number(invoice.amount_paid || 0) - tax));
  return { baseCents: base, discountCents: Math.max(0, discount), taxCents: Math.max(0, tax), paidPreTaxCents: paidPreTax };
}

function discountSource(invoice, stripeSubscription) {
  const md = stripeSubscription?.metadata || {};
  if (md.welcomeOffer) return { source: md.welcomeOffer === "first_month_20" ? "Welcome offer: 20% off the first payment" : `Welcome offer (${md.welcomeOffer})`, code: "", couponId: idOf(invoice?.discount?.coupon) || "" };
  const d = invoice?.discount || (Array.isArray(invoice?.discounts) && typeof invoice.discounts[0] === "object" ? invoice.discounts[0] : null);
  if (d) {
    const coupon = d.coupon || {};
    const promo = d.promotion_code && typeof d.promotion_code === "object" ? d.promotion_code.code : "";
    return { source: promo ? `Promotion code ${promo}` : `Coupon ${coupon.name || coupon.id || ""}`.trim(), code: promo || "", couponId: coupon.id || "" };
  }
  return { source: "", code: "", couponId: "" };
}

async function isReturningCustomer(userId, subscriptionId, stripeSubscriptionId) {
  const earlier = await Subscription.exists({
    user: userId,
    _id: { $ne: subscriptionId },
    stripeSubscriptionId: { $nin: [null, "", stripeSubscriptionId] },
  });
  if (earlier) return true;
  return Boolean(await SalesEvent.exists({ user: userId, kind: "membership_first_paid", "stripe.subscriptionId": { $ne: stripeSubscriptionId } }));
}

/** invoice.paid → a first membership payment (or a paid plan change). */
async function onInvoicePaid({ invoice, stripeSubscription, subscription }) {
  try {
    const reason = invoice?.billing_reason;
    if (!invoice?.id || !subscription?.user) return null;
    if (reason !== "subscription_create" && reason !== "subscription_update") return null; // renewals and the rest: never commission
    if (invoice.status && invoice.status !== "paid") return null;
    if (!(Number(invoice.amount_paid) > 0)) return null; // $0 (gift trial, 100% code, complimentary): not a paid sale
    const user = await User.findById(subscription.user).select("userId stripeCustomerId").lean();
    if (!user) return null;
    const amounts = invoiceAmounts(invoice);
    if (!(amounts.paidPreTaxCents > 0)) return null;
    const plan = String(subscription.subscriptionType || "").toLowerCase() || null;
    const cycle = subscription.billingCycle === "annual" ? "annual" : "monthly";
    const regular = reason === "subscription_create" ? catalogCycleCents(plan, cycle) ?? amounts.baseCents : amounts.baseCents;
    const paidAt = invoice.status_transitions?.paid_at ? new Date(invoice.status_transitions.paid_at * 1000) : new Date(invoice.created * 1000);
    const sellerId = stripeSubscription?.metadata?.adminUserId || null;
    const kind = reason === "subscription_create" ? "membership_first_paid" : "membership_change_paid";
    const { sale, created } = await recordSale({
      sourceKey: `invoice:${invoice.id}`,
      kind,
      user: user._id,
      identity: identityFor(user, { customerId: idOf(invoice.customer), metadata: stripeSubscription?.metadata }),
      plan,
      cycle,
      stripe: {
        customerId: idOf(invoice.customer),
        subscriptionId: idOf(invoice.subscription),
        invoiceId: invoice.id,
        chargeId: idOf(invoice.charge),
        paymentIntentId: idOf(invoice.payment_intent),
        priceId: membershipLines(invoice)[0]?.price?.id || subscription.stripePriceId || null,
        billingReason: reason,
      },
      amounts: {
        regularCents: regular,
        discountCents: Math.max(amounts.discountCents, regular - amounts.paidPreTaxCents > 0 && kind === "membership_first_paid" ? regular - amounts.paidPreTaxCents : 0),
        paidPreTaxCents: amounts.paidPreTaxCents,
        taxCents: amounts.taxCents,
        amountCents: Number(invoice.amount_paid),
        regularMonthlyCents: catalogMonthlyCents(plan),
      },
      discount: discountSource(invoice, stripeSubscription),
      returningCustomer: kind === "membership_first_paid" ? await isReturningCustomer(user._id, subscription._id, idOf(invoice.subscription)) : false,
      subscription: subscription._id,
      paidAt,
      paidAtSource: invoice.status_transitions?.paid_at ? "stripe_invoice" : "event_created",
      seller: /^[a-f0-9]{24}$/i.test(String(sellerId || "")) ? sellerId : null,
    });
    if (created) log("info", "sale_recorded", { kind, invoiceId: invoice.id, saleId: String(sale._id) });
    return creditForSale(sale);
  } catch (error) {
    log("error", "invoice_paid_failed", { invoiceId: invoice?.id, message: String(error?.message || error).slice(0, 300) });
    return null;
  }
}

/** A separately paid Full Day (after the webhook has stamped the booking and entitlement paid). */
async function onFullDayPaid({ session, booking, entitlement, user, stripe }) {
  try {
    if (!user || !session?.id) return null; // a guest visit has no account: nothing to attribute
    if (session.payment_status !== "paid") return null;
    if (!entitlement || entitlement.source !== "purchase") return null;
    const subtotal = Number(session.amount_subtotal || 0);
    const discount = Number(session.total_details?.amount_discount || 0);
    const tax = Number(session.total_details?.amount_tax || 0);
    const paidPreTax = Math.max(0, subtotal - discount);
    if (!(paidPreTax > 0)) return null;
    const piId = idOf(session.payment_intent);
    let paidAt = null;
    let chargeId = null;
    if (piId && stripe) {
      try {
        const pi = await stripe.paymentIntents.retrieve(piId, { expand: ["latest_charge"] });
        const ch = pi?.latest_charge;
        if (ch && typeof ch === "object") {
          chargeId = ch.id;
          if (ch.created) paidAt = new Date(ch.created * 1000);
        } else if (typeof ch === "string") chargeId = ch;
      } catch (error) {
        log("warn", "full_day_charge_lookup_failed", { sessionId: session.id, message: String(error?.message || error).slice(0, 200) });
      }
    }
    const { sale } = await recordSale({
      sourceKey: `fullday:${piId || session.id}`,
      kind: "full_day_paid",
      user: user._id,
      identity: identityFor(user, { customerId: idOf(session.customer), metadata: session.metadata }),
      plan: null,
      cycle: null,
      stripe: { customerId: idOf(session.customer), paymentIntentId: piId, chargeId, checkoutSessionId: session.id },
      amounts: { regularCents: subtotal, discountCents: discount, paidPreTaxCents: paidPreTax, taxCents: tax, amountCents: Number(session.amount_total || 0) },
      booking: booking?._id || null,
      entitlement: entitlement._id,
      paidAt: paidAt || new Date((session.created || Date.now() / 1000) * 1000),
      paidAtSource: paidAt ? "stripe_charge" : "event_created",
      seller: /^[a-f0-9]{24}$/i.test(String(session.metadata?.adminUserId || "")) ? session.metadata.adminUserId : null,
    });
    return creditForSale(sale);
  } catch (error) {
    log("error", "full_day_paid_failed", { sessionId: session?.id, message: String(error?.message || error).slice(0, 300) });
    return null;
  }
}

async function onChargeRefunded(charge) {
  try {
    return await recordRefund(charge);
  } catch (error) {
    log("error", "refund_failed", { chargeId: charge?.id, message: String(error?.message || error).slice(0, 300) });
    return null;
  }
}

async function onDispute(dispute, phase) {
  try {
    return await recordDispute(dispute, phase);
  } catch (error) {
    log("error", "dispute_failed", { disputeId: dispute?.id, message: String(error?.message || error).slice(0, 300) });
    return null;
  }
}

module.exports = { onInvoicePaid, onFullDayPaid, onChargeRefunded, onDispute, invoiceAmounts, identityFor };
