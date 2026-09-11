const moment = require("moment-timezone");

const { PLAN_CATALOG, getPlanPrice } = require("../subscriptionManagement");
const { TIMEZONE, isSupportedDuration } = require("./giftConfig");

/**
 * What a gift costs, and exactly how long it lasts.
 *
 * PRICING HAS ONE SOURCE AND THIS IS NOT IT. Everything here reads
 * PLAN_CATALOG in utils/subscriptionManagement, which already holds the live
 * monthly prices and the live Stripe price ids. A second copy of the numbers
 * would be a second thing to update the next time a price moves, and the one
 * that got missed would be the one customers were charged from.
 */

const PLAN_NAMES = ["basic", "plus", "premium", "elite"];

function normalizePlan(plan) {
  const value = String(plan || "").trim().toLowerCase();
  return PLAN_NAMES.includes(value) ? value : null;
}

/**
 * The monthly price a gift is priced from.
 *
 * The monthly rate, which prices every gift length except twelve months.
 * See annualPriceCents below for why a year is different.
 */
function monthlyPriceCents(plan) {
  const normalized = normalizePlan(plan);
  if (!normalized) return 0;
  const dollars = getPlanPrice(normalized, "monthly");
  return Math.round(Number(dollars || 0) * 100);
}

/** Twelve months, at any length, is one year. */
const ANNUAL_MONTHS = 12;

/**
 * The annual membership price, which is what a twelve-month gift costs.
 *
 * THIS REVERSED AN EARLIER DECISION, deliberately and on instruction. A
 * twelve-month gift used to be quoted at twelve times the monthly rate, on
 * the reasoning that the annual discount buys a commitment and a gift
 * commits to nothing. The business decision is that somebody gifting a full
 * year should pay what a year costs - Pay 10, Get 12 - and the recipient
 * still receives all twelve months.
 *
 * READ FROM THE CATALOG, never restated here. getPlanPrice is the same
 * accessor the membership checkout uses, so a gifted year and a bought year
 * cannot drift apart: changing the annual price in one place changes both.
 *
 * Zero when a plan has no annual price, and the caller falls back to the
 * monthly arithmetic rather than refusing to quote - a missing annual price
 * should not take a plan off sale.
 */
function annualPriceCents(plan) {
  const normalized = normalizePlan(plan);
  if (!normalized) return 0;
  const dollars = getPlanPrice(normalized, "annual");
  return Math.round(Number(dollars || 0) * 100);
}

/**
 * What the purchaser is quoted, before any promotion code.
 *
 * Stripe applies the discount itself at checkout, so this is deliberately the
 * pre-discount figure. What was actually paid comes back from the completed
 * session and is recorded separately; this number is never used as the amount
 * charged.
 */
function quoteGift({ plan, durationMonths }) {
  const normalized = normalizePlan(plan);
  const months = Number(durationMonths);

  if (!normalized) {
    return { ok: false, reason: "unknown_plan" };
  }
  if (!isSupportedDuration(months)) {
    return { ok: false, reason: "unsupported_duration" };
  }

  const perMonthCents = monthlyPriceCents(normalized);
  if (!perMonthCents) {
    return { ok: false, reason: "plan_has_no_price" };
  }

  /*
   * Twelve months is sold at the annual membership price; every other
   * length is the monthly rate times the months.
   *
   * ONE CALCULATION, HERE. stripeLineItem builds the Checkout amount from
   * this quote rather than doing its own arithmetic, and the options
   * endpoint serves the purchase screen from it too, so the price shown,
   * the price charged and the price recorded cannot disagree.
   */
  const listCents = perMonthCents * months;
  const annualCents = months === ANNUAL_MONTHS ? annualPriceCents(normalized) : 0;
  const onAnnualRate = annualCents > 0;
  const totalCents = onAnnualRate ? annualCents : listCents;

  return {
    ok: true,
    plan: normalized,
    durationMonths: months,
    perMonthCents,
    totalCents,
    /*
     * How this total was reached, so a screen can say "Pay 10, get 12"
     * instead of printing a multiplication that no longer adds up.
     */
    pricingBasis: onAnnualRate ? "annual" : "monthly",
    /* What the same months would cost at the monthly rate, and the gap. */
    listCents,
    savingsCents: Math.max(listCents - totalCents, 0),
    currency: "usd",
    /* The live recurring price id, carried for reference only. A gift is
     * never billed against it; see stripeLineItem below. */
    referenceStripePriceId: PLAN_CATALOG[normalized]?.monthly?.stripePriceId || null,
  };
}

/**
 * The Checkout line item for a gift.
 *
 * INLINE price_data, NOT the recurring price id.
 *
 * Handing Stripe the membership's recurring price would create a subscription,
 * which is the one thing a gift must never be: it would put the purchaser on a
 * renewing charge and give the recipient something to resume. An inline
 * one-time amount produces a single payment that creates no billing
 * relationship at all.
 *
 * THE ONE INVARIANT THIS FUNCTION EXISTS TO HOLD
 *
 * The object it returns has no `recurring` key, at any depth, ever. That
 * absence is what makes a gift structurally incapable of becoming a
 * subscription — not a check somewhere else that could be forgotten. A test
 * asserts it on the real returned object rather than on the source text.
 *
 * `product` vs `product_data`
 *
 * Given a stable gift Product id, the amount is attached to that Product, so
 * coupons can be restricted to (or away from) gifts and the tax code lives in
 * Stripe where it belongs. Without one, Stripe mints a throwaway product from
 * `product_data`. In a running application that second shape is unreachable:
 * the route refuses to open checkout until the four Products are configured.
 * It exists so the pricing unit stays testable on its own.
 *
 * `tax_behavior` is required whenever automatic tax is on. ProFixter quotes
 * US-style prices with tax added on top, so it is exclusive.
 */
function stripeLineItem({ plan, durationMonths, productId = "", taxCode = "" }) {
  const quote = quoteGift({ plan, durationMonths });
  if (!quote.ok) return null;

  const planLabel = plan.charAt(0).toUpperCase() + plan.slice(1);

  const price_data = {
    currency: quote.currency,
    unit_amount: quote.totalCents,
    tax_behavior: "exclusive",
  };

  if (productId) {
    price_data.product = String(productId);
  } else {
    price_data.product_data = {
      name: `ProFixter ${planLabel} — ${quote.durationMonths}-month gift membership`,
      description:
        `${quote.durationMonths} months of ProFixter ${planLabel}, prepaid as a gift. ` +
        `One-time payment. Does not renew.`,
      ...(taxCode ? { tax_code: String(taxCode) } : {}),
    };
  }

  return { quantity: 1, price_data };
}

/* -------------------------------------------------------------------------- */
/* Term arithmetic                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The end of a term that starts at `start` and runs `months` calendar months.
 *
 * CALENDAR MONTHS, IN NEW YORK, NOT A FIXED NUMBER OF DAYS.
 *
 * A customer told they have two months expects the same date two months later,
 * not sixty-one days. Doing it in New York rather than UTC keeps the local date
 * stable: a term starting on the 9th ends on the 9th, whichever side of a
 * daylight-saving change each end falls on.
 *
 * Month-end is clamped rather than overflowing, which moment does correctly:
 * 31 December plus two months is 28 February, not 3 March. Without the clamp a
 * gift bought on the 31st would quietly run a few days long every time.
 */
function addMonths(start, months) {
  const from = moment.tz(start, TIMEZONE);
  if (!from.isValid()) return null;
  return from.clone().add(Number(months), "months").toDate();
}

/** The window a term occupies, given when it begins. */
function termWindow(startAt, durationMonths) {
  const start = startAt ? new Date(startAt) : null;
  if (!start || !Number.isFinite(start.getTime())) return null;
  const end = addMonths(start, durationMonths);
  if (!end) return null;
  return { startAt: start, endAt: end };
}

/** How a term reads to a human, in New York. */
function formatTermDate(value) {
  const m = moment.tz(value, TIMEZONE);
  return m.isValid() ? m.format("MMMM D, YYYY") : "";
}

module.exports = {
  ANNUAL_MONTHS,
  annualPriceCents,
  PLAN_NAMES,
  addMonths,
  formatTermDate,
  monthlyPriceCents,
  normalizePlan,
  quoteGift,
  stripeLineItem,
  termWindow,
};
