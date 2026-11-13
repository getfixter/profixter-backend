/**
 * A customer's billing, read from Stripe, for the Admin profile. READ ONLY.
 *
 * Nothing here charges, refunds or changes anything: refunds stay in Stripe
 * (owner decision Q-9), and every row carries a Stripe dashboard link so the
 * owner can act there. Lean on purpose: no client secrets, no hosted invoice
 * or receipt URLs (those are capability links meant for the customer), no
 * payment method fingerprints - brand, last four and expiry only.
 *
 * Cached per customer for 60 seconds so a profile that is opened, closed and
 * reopened does not ask Stripe again. When Stripe is down or not configured
 * the answer is { available: false, reason } and the rest of the profile works.
 */
const Subscription = require("../../models/Subscription");
const AdditionalCharge = require("../../models/AdditionalCharge");
const sm = require("../subscriptionManagement");

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map();
let client = null;

/** Tests inject a fake Stripe here; production uses the shared client. */
function setStripeClient(next) {
  client = next;
  cache.clear();
}
const stripeClient = () => client || sm.stripe;

function dashboardBase() {
  const key = String(process.env.STRIPE_SECRET_KEY || "");
  return key.startsWith("sk_test_") ? "https://dashboard.stripe.com/test" : "https://dashboard.stripe.com";
}
const dash = (path) => `${dashboardBase()}/${path}`;

const iso = (unix) => (unix ? new Date(Number(unix) * 1000).toISOString() : null);

function invoiceRow(invoice) {
  return {
    id: invoice.id,
    number: invoice.number || null,
    status: invoice.status || null,
    billingReason: invoice.billing_reason || null,
    totalCents: Number(invoice.total || 0),
    amountDueCents: Number(invoice.amount_due || 0),
    amountPaidCents: Number(invoice.amount_paid || 0),
    amountRemainingCents: Number(invoice.amount_remaining || 0),
    currency: invoice.currency || "usd",
    createdAt: iso(invoice.created),
    periodStart: iso(invoice.period_start),
    periodEnd: iso(invoice.period_end),
    attemptCount: Number(invoice.attempt_count || 0),
    nextPaymentAttempt: iso(invoice.next_payment_attempt),
    subscriptionId: typeof invoice.subscription === "string" ? invoice.subscription : invoice.subscription?.id || null,
    dashboardUrl: dash(`invoices/${invoice.id}`),
  };
}

function chargeRow(charge) {
  const paymentIntent = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id || null;
  return {
    id: charge.id,
    paymentIntentId: paymentIntent,
    amountCents: Number(charge.amount || 0),
    amountRefundedCents: Number(charge.amount_refunded || 0),
    refunded: Boolean(charge.refunded),
    currency: charge.currency || "usd",
    status: charge.status || null,
    paid: Boolean(charge.paid),
    failureCode: charge.failure_code || null,
    failureMessage: charge.failure_message || null,
    description: charge.description || null,
    createdAt: iso(charge.created),
    card: charge.payment_method_details?.card
      ? { brand: charge.payment_method_details.card.brand || null, last4: charge.payment_method_details.card.last4 || null }
      : null,
    dashboardUrl: dash(`payments/${paymentIntent || charge.id}`),
  };
}

function subscriptionRow(subscription) {
  const item = subscription.items?.data?.[0] || null;
  const mapped = sm.mapStripePriceToPlan(item?.price || null);
  return {
    id: subscription.id,
    status: subscription.status || null,
    plan: mapped.plan || null,
    billingCycle: mapped.billingCycle || null,
    priceCents: item?.price?.unit_amount ?? null,
    addressId: subscription.metadata?.addressId || null,
    cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
    cancelAt: iso(subscription.cancel_at),
    currentPeriodEnd: iso(subscription.current_period_end),
    createdAt: iso(subscription.created),
    dashboardUrl: dash(`subscriptions/${subscription.id}`),
  };
}

function paymentMethodOf(customer) {
  const pm = customer?.invoice_settings?.default_payment_method;
  const card = pm && typeof pm === "object" ? pm.card : null;
  if (!card) return null;
  return { brand: card.brand || null, last4: card.last4 || null, expMonth: card.exp_month || null, expYear: card.exp_year || null };
}

async function upcomingFor(stripe, customerId) {
  try {
    const invoice = await stripe.invoices.createPreview({ customer: customerId });
    return {
      customerId,
      amountDueCents: Number(invoice.amount_due || 0),
      currency: invoice.currency || "usd",
      nextPaymentAttempt: iso(invoice.next_payment_attempt),
      periodEnd: iso(invoice.period_end),
      subscriptionId: typeof invoice.subscription === "string" ? invoice.subscription : invoice.subscription?.id || null,
    };
  } catch (error) {
    // No upcoming invoice is a normal answer, not an outage.
    if (error?.code === "invoice_upcoming_none" || error?.statusCode === 404) return null;
    throw error;
  }
}

async function customerIdsFor(user) {
  const ids = new Set();
  if (user.stripeCustomerId) ids.add(String(user.stripeCustomerId));
  const fromSubs = await Subscription.distinct("stripeCustomerId", { user: user._id, stripeCustomerId: { $nin: [null, ""] } });
  for (const id of fromSubs) ids.add(String(id));
  return [...ids].filter((id) => id.startsWith("cus_")).slice(0, 5);
}

/**
 * @returns {{ available: true, cachedAt, customers:[{id,dashboardUrl,defaultPaymentMethod}], subscriptions, invoices, payments, upcoming }
 *          | { available: false, reason }}
 */
async function billingForCustomer(user, { now = Date.now(), fresh = false } = {}) {
  const key = String(user._id);
  const hit = cache.get(key);
  if (!fresh && hit && now - hit.at < CACHE_TTL_MS) return { ...hit.value, cached: true };

  if (!client && !sm.hasStripeSecretKey()) return { available: false, reason: "stripe_not_configured" };

  const customerIds = await customerIdsFor(user);
  const stripe = stripeClient();
  try {
    const customers = [];
    const subscriptions = [];
    const invoices = [];
    const payments = [];
    const upcoming = [];
    for (const customerId of customerIds) {
      const [customer, subs, invs, charges, next] = await Promise.all([
        stripe.customers.retrieve(customerId, { expand: ["invoice_settings.default_payment_method"] }),
        stripe.subscriptions.list({ customer: customerId, status: "all", limit: 20, expand: ["data.items.data.price"] }),
        stripe.invoices.list({ customer: customerId, limit: 24 }),
        stripe.charges.list({ customer: customerId, limit: 24 }),
        upcomingFor(stripe, customerId),
      ]);
      customers.push({ id: customerId, deleted: Boolean(customer?.deleted), defaultPaymentMethod: paymentMethodOf(customer), dashboardUrl: dash(`customers/${customerId}`) });
      subscriptions.push(...(subs?.data || []).map(subscriptionRow));
      invoices.push(...(invs?.data || []).map(invoiceRow));
      payments.push(...(charges?.data || []).map(chargeRow));
      if (next) upcoming.push(next);
    }
    /*
     * Charge extra payments are already among the Stripe charges above when
     * they were made on this customer: they are LABELLED there, never added
     * twice. Only extras paid where Stripe has no customer of this account
     * (a link paid as a guest) are listed on their own, from our records.
     */
    const extraRecords = await AdditionalCharge.find({ user: user._id }).sort({ createdAt: -1 }).limit(50).lean();
    const byIntent = new Map(extraRecords.filter((r) => r.paymentIntentId).map((r) => [r.paymentIntentId, r]));
    for (const row of payments) {
      const r = row.paymentIntentId ? byIntent.get(row.paymentIntentId) : null;
      if (r) row.extraCharge = { id: String(r._id), number: r.number, bookingId: String(r.booking), bookingNumber: r.bookingNumber, description: r.description };
    }
    const shown = new Set(payments.map((p) => p.paymentIntentId).filter(Boolean));
    const additionalCharges = extraRecords.map((r) => ({
      id: String(r._id),
      number: r.number,
      bookingId: String(r.booking),
      bookingNumber: r.bookingNumber,
      description: r.description,
      status: r.status,
      totalCents: r.totalCents,
      taxStatus: r.tax?.status || "not_calculated",
      refundedCents: Number(r.refundedCents || 0),
      paidAt: r.paidAt || null,
      createdAt: r.createdAt,
      inPayments: Boolean(r.paymentIntentId && shown.has(r.paymentIntentId)),
      stripeUrl: r.paymentIntentId ? dash(`payments/${r.paymentIntentId}`) : null,
    }));
    const byNewest = (a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
    const value = {
      available: true,
      cachedAt: new Date(now).toISOString(),
      customers,
      subscriptions: subscriptions.sort(byNewest),
      invoices: invoices.sort(byNewest),
      payments: payments.sort(byNewest),
      upcoming,
      additionalCharges,
      refundsNote: "Refunds are made in Stripe. Cancelling a membership or a visit does not refund anything.",
    };
    cache.set(key, { at: now, value });
    return value;
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "admin_customer_billing_failed", userId: key, message: error?.message || String(error) }));
    return { available: false, reason: "stripe_unavailable" };
  }
}

module.exports = { CACHE_TTL_MS, billingForCustomer, dashboardUrl: dash, setStripeClient };
