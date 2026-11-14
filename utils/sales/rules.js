/**
 * Commission rules (owner-confirmed 2026-11-13), versioned. A rule is never
 * edited once used; a change is a new version with a later effectiveFrom, and
 * every ledger entry carries a snapshot of the rule and prices it used.
 *
 *   membership_monthly  50% of the amount actually paid for the first
 *                       qualifying payment, excluding sales tax
 *   membership_annual   one month's REGULAR price of that plan (catalog
 *                       monthly price at the time of sale), for a genuine paid sale
 *   full_day            $100 for a separately paid Full Day
 *   bonus_volume        $500 for every 20 qualifying membership sales in a
 *                       month-long period, no cap
 */
const { CommissionRule } = require("../../models/Sales");
const { PLAN_CATALOG } = require("../subscriptionManagement");

const V1_EFFECTIVE = new Date("2026-01-01T05:00:00.000Z");

const DEFAULT_RULES = [
  { key: "membership_monthly", version: 1, params: { method: "percent_of_paid_pre_tax", rateBps: 5000, rounding: "half_up_cent" }, note: "50% of the first payment actually paid, excluding tax" },
  { key: "membership_annual", version: 1, params: { method: "catalog_monthly_regular" }, note: "One month's regular plan price" },
  { key: "full_day", version: 1, params: { method: "fixed", amountCents: 10000 }, note: "$100 per separately paid Full Day" },
  { key: "bonus_volume", version: 1, params: { threshold: 20, amountCents: 50000, stacking: true, period: "calendar_month_from_first_sale" }, note: "$500 per 20 qualifying memberships in a month-long period" },
];

let seeded = null;
async function ensureRules() {
  if (seeded) return seeded;
  seeded = (async () => {
    for (const r of DEFAULT_RULES) {
      try {
        await CommissionRule.create({ ...r, effectiveFrom: V1_EFFECTIVE });
      } catch (error) {
        if (error?.code !== 11000) throw error;
      }
    }
  })();
  try {
    await seeded;
  } catch (error) {
    seeded = null;
    throw error;
  }
  return seeded;
}

/** The rule in force at `at` (highest version whose effectiveFrom ≤ at). */
async function ruleAt(key, at = new Date()) {
  await ensureRules();
  const rule = await CommissionRule.findOne({ key, effectiveFrom: { $lte: at } }).sort({ version: -1 }).lean();
  if (!rule) throw new Error(`No ${key} commission rule in force at ${new Date(at).toISOString()}`);
  return { key: rule.key, version: rule.version, params: rule.params };
}

const dollars = (cents) => `$${(cents / 100).toFixed(2)}`;

function catalogMonthlyCents(plan) {
  const entry = PLAN_CATALOG[String(plan || "").toLowerCase()];
  return entry ? Math.round(Number(entry.monthly.price) * 100) : null;
}
function catalogCycleCents(plan, cycle) {
  const entry = PLAN_CATALOG[String(plan || "").toLowerCase()];
  const c = entry && entry[cycle === "annual" ? "annual" : "monthly"];
  return c ? Math.round(Number(c.price) * 100) : null;
}

/**
 * What a sale earns under `rule`. Pure: the same inputs always give the same
 * cents. Returns { amountCents, product, method, explain } or { amountCents: 0, reason }.
 */
function computeCommission(sale, rule) {
  const paid = Math.max(0, Math.trunc(sale.amounts?.paidPreTaxCents || 0));
  if (paid <= 0) return { amountCents: 0, reason: "nothing_paid", explain: "No payment was made, so no commission." };
  if (sale.kind === "full_day_paid") {
    const amount = Math.trunc(rule.params.amountCents);
    return { amountCents: amount, product: "full_day", method: rule.params.method, explain: `Full Day sale: fixed ${dollars(amount)}` };
  }
  if (sale.cycle === "annual") {
    const monthly = sale.amounts?.regularMonthlyCents ?? catalogMonthlyCents(sale.plan);
    if (!monthly) return { amountCents: 0, reason: "unknown_plan", explain: "The plan is not in the catalog." };
    return {
      amountCents: monthly,
      regularMonthlyCents: monthly,
      product: "membership_annual",
      method: rule.params.method,
      explain: `Annual ${label(sale.plan)}: one month's regular price, ${dollars(monthly)}`,
    };
  }
  // 50% of the payment excluding tax, rounded half up to the cent.
  const amount = Math.floor((paid * rule.params.rateBps + 5000) / 10000);
  return {
    amountCents: amount,
    product: "membership_monthly",
    method: rule.params.method,
    explain: `Monthly ${label(sale.plan)}: 50% of ${dollars(paid)} paid excluding tax = ${dollars(amount)}`,
  };
}

const label = (plan) => {
  const p = String(plan || "");
  return p ? p.charAt(0).toUpperCase() + p.slice(1) : "membership";
};

function ruleKeyForSale(sale) {
  if (sale.kind === "full_day_paid") return "full_day";
  return sale.cycle === "annual" ? "membership_annual" : "membership_monthly";
}

module.exports = { DEFAULT_RULES, ensureRules, ruleAt, computeCommission, ruleKeyForSale, catalogMonthlyCents, catalogCycleCents, dollars, label };
