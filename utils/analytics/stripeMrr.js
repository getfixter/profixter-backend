/**
 * Monthly recurring revenue, read from Stripe subscriptions.
 *
 * Mongo stores each membership's list price (Subscription.planPrice) but not
 * the coupon on it. MRR from list prices overstated the business: on Oct 7,
 * 2026 it showed $6,713 while Stripe would bill $5,953 a month - seven members
 * on a 25% retention coupon and two on 100% off were counted at full price.
 *
 * So the Overview reports three numbers and never mixes them:
 *   netCents        what active memberships bill per month after ongoing discounts
 *   fullPriceCents  the same memberships at list price
 *   discountCents   the difference
 *
 * Rules, each pinned by scripts/test_admin_overview_mrr.js:
 * - only `active` and `past_due` subscriptions; trialing, unpaid, canceled and
 *   incomplete are not recurring revenue (trialing is counted separately)
 * - annual (or any multi-month) prices are divided into a monthly equivalent
 * - a coupon counts while it applies: `forever`, or `repeating` until its end
 *   date; a `once` coupon was used on the first invoice and is ignored after
 * - percent_off scales the price; amount_off comes off each invoice, so it is
 *   spread over the invoice's months; never below zero
 * - a coupon restricted to products only discounts those products
 * - 100% off is a comped member: in the member count, 0 in MRR, not "paying"
 * - scheduled cancellations still bill until they end; they are reported as
 *   "ending" so the at-risk amount is visible
 * - tax is excluded: prices are tax-exclusive
 */
const { stripe, getPlanAndBillingFromPrice } = require("../subscriptionManagement");

const CACHE_TTL_MS = 5 * 60 * 1000;
const FIRST_LOAD_TIMEOUT_MS = 5000;

let client = stripe;
let cached = null; // { at, value }
let inFlight = null;

function setStripeClient(next) {
  client = next || stripe;
  cached = null;
}

function monthsOf(recurring) {
  const n = Number(recurring?.interval_count || 1);
  switch (recurring?.interval) {
    case "year":
      return 12 * n;
    case "month":
      return n;
    case "week":
      return (n * 7) / (365 / 12);
    case "day":
      return n / (365 / 12);
    default:
      return 1;
  }
}

const productOf = (price) => (typeof price?.product === "string" ? price.product : price?.product?.id || null);

function activeDiscounts(sub, nowSec) {
  const list = Array.isArray(sub.discounts) && sub.discounts.length ? sub.discounts : sub.discount ? [sub.discount] : [];
  return list
    .filter((d) => d && typeof d === "object")
    .map((d) => ({ d, coupon: d.coupon || d.source?.coupon || null }))
    .filter(({ d, coupon }) => coupon && coupon.duration !== "once" && !(d.end && d.end <= nowSec) && !(d.start && d.start > nowSec));
}

/** Pure: one Stripe subscription -> its monthly list and net value, in cents. */
function subscriptionMonthly(sub, nowSec) {
  const items = (sub.items?.data || []).map((it) => {
    const months = monthsOf(it.price?.recurring);
    const invoiceCents = Number(it.price?.unit_amount || 0) * Number(it.quantity || 1);
    return { product: productOf(it.price), priceId: it.price?.id || null, months, invoiceCents, listMonthly: invoiceCents / months };
  });
  const listMonthly = items.reduce((s, it) => s + it.listMonthly, 0);
  const net = items.map((it) => ({ ...it, netMonthly: it.listMonthly }));
  for (const { coupon } of activeDiscounts(sub, nowSec)) {
    const only = coupon.applies_to?.products?.length ? new Set(coupon.applies_to.products) : null;
    const eligible = net.filter((it) => !only || only.has(it.product));
    if (!eligible.length) continue;
    if (coupon.percent_off) {
      for (const it of eligible) it.netMonthly *= 1 - Number(coupon.percent_off) / 100;
    } else if (coupon.amount_off) {
      // Off the invoice, spread over the months that invoice covers, shared across eligible items.
      const off = Number(coupon.amount_off) / eligible[0].months;
      const base = eligible.reduce((s, it) => s + it.netMonthly, 0);
      for (const it of eligible) {
        const share = base > 0 ? (off * it.netMonthly) / base : 0;
        it.netMonthly = Math.max(0, it.netMonthly - share);
      }
    }
  }
  const netMonthly = net.reduce((s, it) => s + it.netMonthly, 0);
  const plan = getPlanAndBillingFromPrice(items[0]?.priceId).plan || sub.metadata?.plan || null;
  return {
    id: sub.id,
    status: sub.status,
    plan: plan ? String(plan).toLowerCase() : null,
    annual: items.some((it) => it.months >= 12),
    listCents: Math.round(listMonthly),
    netCents: Math.round(netMonthly),
    ending: !!(sub.cancel_at_period_end || sub.cancel_at),
  };
}

/** Pure: Stripe subscriptions -> the Overview's MRR block. */
function computeMrr(subscriptions, now = new Date()) {
  const nowSec = Math.floor(now.getTime() / 1000);
  const billing = subscriptions.filter((s) => s.status === "active" || s.status === "past_due");
  const rows = billing.map((s) => subscriptionMonthly(s, nowSec));
  const sum = (list, key) => list.reduce((s, r) => s + r[key], 0);
  const byPlan = {};
  for (const r of rows) {
    if (!r.plan) continue;
    byPlan[r.plan] ||= { netCents: 0, fullPriceCents: 0, members: 0, paying: 0, comped: 0 };
    byPlan[r.plan].netCents += r.netCents;
    byPlan[r.plan].fullPriceCents += r.listCents;
    byPlan[r.plan].members += 1;
    if (r.netCents > 0) byPlan[r.plan].paying += 1;
    else if (r.listCents > 0) byPlan[r.plan].comped += 1;
  }
  const ending = rows.filter((r) => r.ending);
  return {
    available: true,
    source: "stripe",
    asOf: now,
    netCents: sum(rows, "netCents"),
    fullPriceCents: sum(rows, "listCents"),
    discountCents: sum(rows, "listCents") - sum(rows, "netCents"),
    members: rows.length,
    payingMembers: rows.filter((r) => r.netCents > 0).length,
    compedMembers: rows.filter((r) => r.netCents === 0 && r.listCents > 0).length,
    discountedMembers: rows.filter((r) => r.netCents > 0 && r.netCents < r.listCents).length,
    annualMembers: rows.filter((r) => r.annual).length,
    pastDueMembers: rows.filter((r) => r.status === "past_due").length,
    trialingMembers: subscriptions.filter((s) => s.status === "trialing").length,
    endingMembers: ending.length,
    endingCents: sum(ending, "netCents"),
    byPlan,
  };
}

async function fetchMrr() {
  const subs = [];
  for (const status of ["active", "past_due", "trialing"]) {
    for await (const s of client.subscriptions.list({ status, limit: 100, expand: ["data.discounts"] })) subs.push(s);
  }
  return computeMrr(subs, new Date());
}

function refresh() {
  if (!inFlight) {
    inFlight = fetchMrr()
      .then((value) => {
        cached = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/**
 * The MRR block, fast. A fresh copy is returned at once; a stale one is
 * returned at once and refreshed behind it; with nothing cached, Stripe gets
 * five seconds (it takes ~0.3s) before the Overview answers without it.
 */
async function currentMrr() {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  if (cached) {
    refresh().catch((e) => console.warn("MRR refresh failed:", e.message));
    return cached.value;
  }
  try {
    return await Promise.race([
      refresh(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), FIRST_LOAD_TIMEOUT_MS).unref?.()),
    ]);
  } catch (error) {
    console.warn("MRR read failed:", error.message);
    return { available: false, error: "Recurring revenue is unavailable right now." };
  }
}

module.exports = { computeMrr, subscriptionMonthly, currentMrr, setStripeClient, monthsOf };
