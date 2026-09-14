/**
 * The Loyalty Benefits ladder, and the two switches that decide whether it runs.
 *
 * Everything the program promises is in one table here, so changing the ladder
 * is one edit rather than a search. Nothing in this file touches a database, a
 * clock or Stripe.
 *
 * FAILS CLOSED, TWICE OVER.
 *
 * The program is inert unless LOYALTY_ENABLED is true AND LOYALTY_EFFECTIVE_AT
 * parses as a date. Both are required because they answer different questions:
 * the first is "is this feature on", the second is "from when does anything
 * count", and a missing answer to either must never be guessed. Deploying the
 * code and turning the program on stay two separate decisions, matching how
 * gifts, marketing and SMS already work in this codebase.
 *
 * THE EFFECTIVE TIMESTAMP IS THE WHOLE NO-RETROACTIVE-CREDIT GUARANTEE.
 *
 * Not a guard somebody has to remember to write. The only way a month enters
 * the ledger is a renewal invoice paid at or after this instant, so on launch
 * day there is no historical data to read and no backfill to skip. A member of
 * nine years and a member of nine days both start at zero, and no code path
 * exists that could do otherwise.
 */

const MILESTONES = [3, 6, 12];

/** Each milestone's own window of months. Non-overlapping, on purpose. */
const MILESTONE_WINDOWS = {
  3: { start: 1, end: 3 },
  6: { start: 4, end: 6 },
  12: { start: 7, end: 12 },
};

/** What a member of each plan temporarily receives. Elite is the top. */
const UPGRADE_MAP = {
  basic: "plus",
  plus: "premium",
  premium: "elite",
  elite: null,
};

const PLAN_RANK = { basic: 1, plus: 2, premium: 3, elite: 4 };

/** How many membership cycles a temporary upgrade runs for. */
const UPGRADE_CYCLES = { 3: 1, 6: 2 };

/** How long an Elite member has to use a Loyalty Full Day. */
const LOYALTY_FULL_DAY_VALID_DAYS = 90;

/**
 * How long a gap may be before it stops being payment trouble and starts being
 * a break.
 *
 * Forty-five days clears Stripe's longest default dunning cycle with a month to
 * spare, so a member whose card fails and is fixed three weeks later keeps
 * everything, while somebody who genuinely leaves and returns in the spring
 * starts a new generation.
 */
const DEFAULT_BREAK_DAYS = 45;

/** The most gifted months that may be carried into a paid membership. */
const GIFT_SEED_CAP_MONTHS = 3;

function isEnabled(env = process.env) {
  return String(env.LOYALTY_ENABLED || "").trim().toLowerCase() === "true";
}

/** The instant the program began, or null if it has not been set. */
function effectiveAt(env = process.env) {
  const raw = String(env.LOYALTY_EFFECTIVE_AT || "").trim();
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function breakDays(env = process.env) {
  const raw = Number(env.LOYALTY_BREAK_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BREAK_DAYS;
}

/**
 * Whether the program can act at all right now.
 *
 * One call answers it for every caller — the webhook, the API, the account
 * screen — so there is no chance of the backend counting months the front end
 * refuses to show, or the reverse.
 */
function loyaltyActive(env = process.env) {
  return isEnabled(env) && !!effectiveAt(env);
}

/**
 * Whether the 30% cancellation save offer is still shown.
 *
 * Loyalty progress is the first cancellation screen either way. This decides
 * only whether the discount survives as a second screen behind it, so it can be
 * retired later by clearing one environment variable rather than by a deploy.
 * Absent means yes, which is today's behaviour.
 */
function retentionOfferEnabled(env = process.env) {
  return String(env.RETENTION_OFFER_ENABLED || "true").trim().toLowerCase() !== "false";
}

module.exports = {
  MILESTONES,
  MILESTONE_WINDOWS,
  UPGRADE_MAP,
  UPGRADE_CYCLES,
  PLAN_RANK,
  LOYALTY_FULL_DAY_VALID_DAYS,
  DEFAULT_BREAK_DAYS,
  GIFT_SEED_CAP_MONTHS,
  isEnabled,
  effectiveAt,
  breakDays,
  loyaltyActive,
  retentionOfferEnabled,
};
