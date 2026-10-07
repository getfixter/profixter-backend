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
 */
const { stripe, getPlanAndBillingFromPrice } = require("../subscriptionManagement");

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CHARGES = 5000;
const cache = new Map();

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

async function fetchCharges({ from, to }) {
  const rows = [];
  let truncated = false;
  const list = stripe.charges.list({
    created: { gte: Math.floor(from.getTime() / 1000), lt: Math.floor(to.getTime() / 1000) },
    limit: 100,
    expand: ["data.invoice", "data.payment_intent"],
  });
  for await (const charge of list) {
    if (rows.length >= MAX_CHARGES) {
      truncated = true;
      break;
    }
    if (charge.status !== "succeeded" || !charge.paid) continue;
    rows.push(classifyCharge(charge));
  }
  return { rows, truncated };
}

/**
 * Collected revenue rows for [from, to). Cached for five minutes per window,
 * so flipping between date presets does not re-read Stripe every time.
 * Never throws: on failure the Overview shows "Revenue unavailable" rather
 * than a zero that looks like a real number.
 */
async function collectedRevenue({ from, to }) {
  const key = `${from.toISOString()}|${to.toISOString()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  let value;
  try {
    if (!process.env.STRIPE_SECRET_KEY) throw new Error("Stripe is not configured");
    const { rows, truncated } = await fetchCharges({ from, to });
    value = { available: true, rows, truncated };
  } catch (error) {
    console.warn("Overview revenue read failed:", error.message);
    value = { available: false, rows: [], truncated: false, error: "Revenue is temporarily unavailable." };
  }
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 50) cache.delete(cache.keys().next().value);
  return value;
}

function clearRevenueCache() {
  cache.clear();
}

module.exports = { classifyCharge, collectedRevenue, clearRevenueCache, SERVICE_KINDS };
