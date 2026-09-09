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
 * Always the MONTHLY figure, never the annual one, even for a twelve-month
 * gift. An annual subscription is discounted because it is a commitment to
 * keep paying; a gift is a fixed block of months with no commitment attached,
 * so it is priced at the monthly rate times the number of months. Quoting the
 * annual rate would sell a year of membership for the price of ten months and
 * call it a gift.
 */
function monthlyPriceCents(plan) {
  const normalized = normalizePlan(plan);
  if (!normalized) return 0;
  const dollars = getPlanPrice(normalized, "monthly");
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

  return {
    ok: true,
    plan: normalized,
    durationMonths: months,
    perMonthCents,
    totalCents: perMonthCents * months,
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
 * relationship at all, and it needs no new Stripe product or price to be
 * created in the dashboard.
 */
function stripeLineItem({ plan, durationMonths }) {
  const quote = quoteGift({ plan, durationMonths });
  if (!quote.ok) return null;

  const planLabel = plan.charAt(0).toUpperCase() + plan.slice(1);
  return {
    quantity: 1,
    price_data: {
      currency: quote.currency,
      unit_amount: quote.totalCents,
      product_data: {
        name: `ProFixter ${planLabel} — ${quote.durationMonths}-month gift membership`,
        description:
          `${quote.durationMonths} months of ProFixter ${planLabel}, prepaid as a gift. ` +
          `One-time payment. Does not renew.`,
      },
    },
  };
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
  PLAN_NAMES,
  addMonths,
  formatTermDate,
  monthlyPriceCents,
  normalizePlan,
  quoteGift,
  stripeLineItem,
  termWindow,
};
