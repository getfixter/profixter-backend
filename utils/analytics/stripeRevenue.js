/**
 * Money actually collected, read from Stripe.
 *
 * WHY STRIPE AND NOT MONGO. Mongo keeps list prices (Subscription.planPrice,
 * VisitEntitlement.priceCents) and a few amounts for gifts and renewals, but
 * not what a membership signup, an annual plan or a one-time visit actually
 * charged after coupons and tax, and it never records their refunds. Stripe's
 * charges do. So "revenue" on the Overview is: succeeded charges in the period,
 * minus what has been refunded on them, classified by evidence.
 *
 * CLASSIFICATION, strongest evidence first:
 * - charge belongs to an invoice of a subscription      -> membership
 * - invoice/PI metadata source "profixter_invoice"      -> project (excluded)
 * - PaymentIntent metadata productKind                   -> one_time / full_day /
 *                                                           gift / tip (tip excluded)
 * - anything else                                        -> other (counted, shown
 *                                                           as unclassified, never
 *                                                           folded into a bucket)
 *
 * Refunds are netted against the charge they belong to, so a refund lowers the
 * period the money came in, not the period it went out. That is the simple,
 * stable choice for a dashboard; it is stated in the UI.
 *
 * SALES TAX is recorded per charge and kept out of revenue: it is collected
 * for the state, not earned. The Overview shows it separately.
 *
 * SPEED. Paging a year of charges with their invoices took ~30s, and the
 * Overview waited for it. Charges are now mirrored into Mongo (RevenueCharge)
 * by a background sync, and the Overview reads the mirror.
 */
const { stripe, getPlanAndBillingFromPrice } = require("../subscriptionManagement");

const SERVICE_KINDS = new Set(["membership", "one_time", "full_day", "gift"]);

function idOf(value) {
  if (!value) return null;
  return typeof value === "string" ? value : value.id || null;
}

/** Pure: one Stripe charge (with invoice + payment_intent expanded) -> a revenue row. */
function classifyCharge(charge) {
  const invoice = charge.invoice && typeof charge.invoice === "object" ? charge.invoice : null;
  const pi = charge.payment_intent && typeof charge.payment_intent === "object" ? charge.payment_intent : null;
  const meta = { ...(pi?.metadata || {}), ...(charge.metadata || {}) };
  const invMeta = invoice?.metadata || {};

  let kind = "other";
  let plan = null;
  let billingCycle = null;

  const subscriptionId =
    idOf(invoice?.subscription) || idOf(invoice?.parent?.subscription_details?.subscription) || null;

  if (invMeta.source === "profixter_invoice" || meta.source === "profixter_invoice") {
    kind = "project";
  } else if (subscriptionId) {
    kind = "membership";
    const subMeta = invoice?.subscription_details?.metadata || invoice?.parent?.subscription_details?.metadata || {};
    const line = (invoice?.lines?.data || []).find((l) => l?.price?.id || l?.pricing?.price_details?.price);
    const priceId = line?.price?.id || line?.pricing?.price_details?.price || null;
    const fromPrice = priceId ? getPlanAndBillingFromPrice(priceId) : {};
    plan = String(subMeta.plan || fromPrice.plan || "").toLowerCase() || null;
    billingCycle = subMeta.billingCycle || fromPrice.billingCycle || null;
  } else if (meta.productKind === "one_time_handyman_visit") {
    kind = "one_time";
  } else if (meta.productKind === "full_day_visit") {
    kind = "full_day";
  } else if (meta.productKind === "gift_membership") {
    kind = "gift";
    plan = String(meta.plan || "").toLowerCase() || null;
  } else if (meta.productKind === "fixter_tip") {
    kind = "tip";
  }

  const cents = Number(charge.amount || 0);
  const refundedCents = Number(charge.amount_refunded || 0);
  return {
    id: charge.id,
    at: new Date(Number(charge.created || 0) * 1000),
    kind,
    service: SERVICE_KINDS.has(kind),
    plan,
    billingCycle,
    cents,
    refundedCents,
    netCents: Math.max(0, cents - refundedCents),
    stripeCustomerId: idOf(charge.customer),
    userRef: meta.userMongoId || meta.purchaserMongoId || meta.userId || invoice?.subscription_details?.metadata?.userId || null,
    subscriptionId,
  };
}

/* ------------------------------------------------------------------ */
/* Sales tax                                                           */
/* ------------------------------------------------------------------ */

/*
 * Tax is inside what the card was charged, but it is owed to the state, not
 * earned. Membership invoices carry their own tax; One-Time, Full Day and
 * gift purchases go through Checkout, whose session records it.
 */
function invoiceTaxCents(invoice) {
  if (!invoice || typeof invoice !== "object") return 0;
  if (typeof invoice.tax === "number") return invoice.tax;
  const list = Array.isArray(invoice.total_taxes)
    ? invoice.total_taxes
    : Array.isArray(invoice.total_tax_amounts)
      ? invoice.total_tax_amounts
      : [];
  return list.reduce((sum, t) => sum + Number(t?.amount || 0), 0);
}

/** Tax inside one charge. An invoice paid by more than one charge splits its tax by amount. */
function chargeTaxFromInvoice(charge) {
  const invoice = charge.invoice && typeof charge.invoice === "object" ? charge.invoice : null;
  if (!invoice) return 0;
  const tax = invoiceTaxCents(invoice);
  const paid = Number(invoice.amount_paid || invoice.total || 0);
  const cents = Number(charge.amount || 0);
  if (!tax || !paid || cents >= paid) return Math.min(tax, cents);
  return Math.round((tax * cents) / paid);
}

async function checkoutTaxCents(paymentIntentId) {
  if (!paymentIntentId) return 0;
  const sessions = await client.checkout.sessions.list({ payment_intent: paymentIntentId, limit: 1 });
  return Number(sessions.data[0]?.total_details?.amount_tax || 0);
}

/* ------------------------------------------------------------------ */
/* The ledger                                                          */
/* ------------------------------------------------------------------ */

const STATE_KEY = "revenue-ledger";
// Re-read the last two days on every run: upserting a charge twice is harmless,
// missing one that Stripe listed late is not.
const OVERLAP_SEC = 2 * 24 * 60 * 60;
const STALE_MS = 2 * 60 * 1000;
const INTERVAL_MS = 5 * 60 * 1000;

let client = stripe;
let inFlight = null;

/** Tests swap in a fake Stripe. */
function setStripeClient(next) {
  client = next || stripe;
}

async function readState() {
  const AnalyticsState = require("../../models/AnalyticsState");
  const doc = await AnalyticsState.findOne({ key: STATE_KEY }).lean();
  return doc?.value || {};
}

async function writeState(value) {
  const AnalyticsState = require("../../models/AnalyticsState");
  await AnalyticsState.updateOne({ key: STATE_KEY }, { $set: { value } }, { upsert: true });
}

async function ledgerRow(charge) {
  const row = classifyCharge(charge);
  let taxCents = 0;
  if (row.kind !== "project" && row.kind !== "tip") {
    taxCents =
      charge.invoice && typeof charge.invoice === "object"
        ? chargeTaxFromInvoice(charge)
        : await checkoutTaxCents(idOf(charge.payment_intent));
  }
  return {
    chargeId: row.id,
    created: row.at,
    kind: row.kind,
    plan: row.plan,
    billingCycle: row.billingCycle,
    cents: row.cents,
    refundedCents: row.refundedCents,
    taxCents,
    stripeCustomerId: row.stripeCustomerId,
    userRef: row.userRef ? String(row.userRef) : null,
    subscriptionId: row.subscriptionId,
  };
}

/**
 * Bring the ledger up to date. The first run reads every charge the account
 * has ever had (once, in the background); every later run reads only charges
 * created since the last one plus refunds issued since - a page or two.
 * One run at a time per process; concurrent callers share it.
 */
function syncRevenueLedger({ now = new Date() } = {}) {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const RevenueCharge = require("../../models/RevenueCharge");
    const state = await readState();
    const startedAt = Math.floor(now.getTime() / 1000);
    const created = state.lastChargeCreated ? { gte: state.lastChargeCreated - OVERLAP_SEC } : null;
    let maxCreated = state.lastChargeCreated || 0;
    let ops = [];
    let seen = 0;
    const flush = async () => {
      if (ops.length) await RevenueCharge.bulkWrite(ops, { ordered: false });
      ops = [];
    };
    const params = { limit: 100, expand: ["data.invoice", "data.payment_intent"] };
    if (created) params.created = created;
    for await (const charge of client.charges.list(params)) {
      seen += 1;
      maxCreated = Math.max(maxCreated, Number(charge.created || 0));
      if (charge.status !== "succeeded" || !charge.paid) continue;
      const row = await ledgerRow(charge);
      ops.push({ updateOne: { filter: { chargeId: row.chargeId }, update: { $set: row }, upsert: true } });
      if (ops.length >= 200) await flush();
    }
    await flush();

    // Refunds on charges already mirrored. The first run needs none: each charge carried its own.
    let refunds = 0;
    if (state.lastRefundCheck) {
      const list = client.refunds.list({ created: { gte: state.lastRefundCheck - OVERLAP_SEC }, limit: 100, expand: ["data.charge"] });
      for await (const refund of list) {
        const charge = refund.charge && typeof refund.charge === "object" ? refund.charge : null;
        if (!charge) continue;
        refunds += 1;
        await RevenueCharge.updateOne({ chargeId: charge.id }, { $set: { refundedCents: Number(charge.amount_refunded || 0) } });
      }
    }

    const value = {
      backfilledAt: state.backfilledAt || new Date(),
      lastChargeCreated: maxCreated || startedAt,
      lastRefundCheck: startedAt,
      lastSyncAt: new Date(),
      lastRun: { charges: seen, refunds },
    };
    await writeState(value);
    return value;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

function kickSync() {
  syncRevenueLedger().catch((error) => console.warn("Revenue ledger sync failed:", error.message));
}

/** Boot: sync now (the first deploy backfills), then every five minutes. */
function startRevenueLedgerSync() {
  if (!process.env.STRIPE_SECRET_KEY || process.env.NODE_ENV === "test") return;
  setTimeout(kickSync, 5000).unref?.();
  setInterval(kickSync, INTERVAL_MS).unref?.();
}

/**
 * Collected revenue rows for [from, to), read from the ledger. Never calls
 * Stripe on the request path: a stale ledger is refreshed in the background,
 * and the answer says how fresh it is. Never throws: on failure the Overview
 * shows "Revenue unavailable" rather than a zero that looks like a real number.
 */
async function collectedRevenue({ from, to }) {
  try {
    const RevenueCharge = require("../../models/RevenueCharge");
    const state = await readState();
    if (!state.backfilledAt) {
      kickSync();
      return {
        available: false,
        syncing: true,
        rows: [],
        truncated: false,
        error: "Revenue is loading from Stripe for the first time. It will appear in a minute.",
      };
    }
    if (!state.lastSyncAt || Date.now() - new Date(state.lastSyncAt).getTime() > STALE_MS) kickSync();
    const docs = await RevenueCharge.find({ created: { $gte: from, $lt: to } }).lean();
    const rows = docs.map((d) => ({
      id: d.chargeId,
      at: d.created,
      kind: d.kind,
      service: SERVICE_KINDS.has(d.kind),
      plan: d.plan,
      billingCycle: d.billingCycle,
      cents: d.cents,
      refundedCents: d.refundedCents || 0,
      netCents: Math.max(0, d.cents - (d.refundedCents || 0)),
      taxCents: d.taxCents || 0,
      stripeCustomerId: d.stripeCustomerId,
      userRef: d.userRef,
      subscriptionId: d.subscriptionId,
    }));
    return { available: true, rows, truncated: false, syncedAt: state.lastSyncAt };
  } catch (error) {
    console.warn("Overview revenue read failed:", error.message);
    return { available: false, rows: [], truncated: false, error: "Revenue is temporarily unavailable." };
  }
}

/** Nothing to clear any more: the ledger is the cache. Kept for callers. */
function clearRevenueCache() {}

module.exports = {
  classifyCharge,
  invoiceTaxCents,
  chargeTaxFromInvoice,
  collectedRevenue,
  syncRevenueLedger,
  startRevenueLedgerSync,
  setStripeClient,
  clearRevenueCache,
  SERVICE_KINDS,
};
