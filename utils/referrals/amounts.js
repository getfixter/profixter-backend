/**
 * The reward, from Stripe's own numbers. Pure functions: no database, no network.
 *
 * Reward = the lesser of $149 and what the referred customer actually paid
 * for the MEMBERSHIP on their first paid membership invoice:
 *   - membership lines only (utils/sales/stripeEvents.invoiceAmounts): tips,
 *     extra charges, materials and other payments are never on this invoice
 *     line set, and are never counted;
 *   - after every discount (promotion codes, the welcome offer, coupons);
 *   - excluding tax;
 *   - minus refunds on that invoice's charge, with the tax share of a refund
 *     taken out in proportion (a refund returns tax too).
 * Examples: Basic at $149 earns $149.00; Basic with 10% off ($134.10) earns $134.10.
 */
const { invoiceAmounts } = require("../sales/stripeEvents");

const REWARD_CAP_CENTS = 14900;
// A paid membership invoice that counts: the first one and each renewal. A plan-change proration does not.
const COUNTED_REASONS = new Set(["subscription_create", "subscription_cycle"]);

const idOf = (v) => (v && typeof v === "object" ? v.id : v) || null;

/** Is this invoice a paid membership payment that the program counts? */
function isCountedInvoice(invoice) {
  if (!invoice?.id || !invoice.subscription) return false;
  if (invoice.status && invoice.status !== "paid") return false;
  if (!COUNTED_REASONS.has(String(invoice.billing_reason || ""))) return false;
  if (!(Number(invoice.amount_paid) > 0)) return false; // $0: a gift trial, a 100% code, complimentary
  return invoiceAmounts(invoice).paidPreTaxCents > 0;
}

function promoOf(invoice) {
  const d = invoice?.discount || (Array.isArray(invoice?.discounts) && typeof invoice.discounts[0] === "object" ? invoice.discounts[0] : null);
  if (!d) return { promoCode: "", discountSource: "" };
  const code = d.promotion_code && typeof d.promotion_code === "object" ? String(d.promotion_code.code || "") : "";
  const coupon = d.coupon || {};
  return { promoCode: code, discountSource: code ? `Promotion code ${code}` : `Coupon ${coupon.name || coupon.id || ""}`.trim() };
}

/** The invoice fields we keep, read from a Stripe invoice. */
function invoiceRecord(invoice, { plan = null, cycle = null, cardFingerprint = null } = {}) {
  const a = invoiceAmounts(invoice);
  const { promoCode, discountSource } = promoOf(invoice);
  return {
    invoiceId: invoice.id,
    subscriptionId: idOf(invoice.subscription),
    chargeId: idOf(invoice.charge),
    paymentIntentId: idOf(invoice.payment_intent),
    billingReason: invoice.billing_reason || null,
    paidAt: invoice.status_transitions?.paid_at ? new Date(invoice.status_transitions.paid_at * 1000) : new Date((invoice.created || Date.now() / 1000) * 1000),
    plan,
    cycle,
    baseCents: a.baseCents,
    discountCents: a.discountCents,
    taxCents: a.taxCents,
    amountPaidCents: Number(invoice.amount_paid || 0),
    paidPreTaxCents: a.paidPreTaxCents,
    refundedCents: 0,
    refundedPreTaxCents: 0,
    disputed: false,
    discountSource,
    promoCode,
    cardFingerprint,
  };
}

/** The pre-tax part of a refund: a refund gives back tax in the same proportion the payment carried it. */
function refundedPreTax(rec, refundedCents) {
  const refunded = Math.max(0, Math.min(Number(refundedCents) || 0, rec.amountPaidCents || 0));
  if (!(rec.amountPaidCents > 0)) return 0;
  return Math.min(rec.paidPreTaxCents, Math.round((refunded * rec.paidPreTaxCents) / rec.amountPaidCents));
}

/** Apply a charge's CUMULATIVE refund total (so a replayed event changes nothing). */
function withRefund(rec, refundedCents) {
  const refunded = Math.max(0, Math.min(Number(refundedCents) || 0, rec.amountPaidCents || 0));
  return { ...rec, refundedCents: refunded, refundedPreTaxCents: refundedPreTax(rec, refunded) };
}

function rewardCents(first) {
  if (!first) return 0;
  const net = (first.paidPreTaxCents || 0) - (first.refundedPreTaxCents || 0);
  return Math.max(0, Math.min(REWARD_CAP_CENTS, net));
}

/** Does a second invoice still count as cleared? Paid, not refunded in full, not disputed. */
function secondCleared(second) {
  if (!second?.invoiceId) return false;
  if (second.disputed) return false;
  return (second.refundedCents || 0) < (second.amountPaidCents || 0);
}

const dollars = (cents) => `$${(Math.round(Number(cents) || 0) / 100).toFixed(2)}`;

module.exports = { REWARD_CAP_CENTS, COUNTED_REASONS, isCountedInvoice, invoiceRecord, withRefund, refundedPreTax, rewardCents, secondCleared, dollars, idOf };
