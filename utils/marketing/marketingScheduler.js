const { ALL_TEMPLATES, KIND } = require("./marketingLibrary");
const {
  ANNUAL_MONTHS_CHARGED,
  ANNUAL_PRICE_TOLERANCE_CENTS,
  FREQUENCY,
  HELP_TARGET,
  SEND_WINDOW,
  TIMEZONE,
} = require("./marketingConfig");
const { daysSince, templateEligible } = require("./marketingEligibility");
const {
  stripe,
  hasStripeSecretKey,
  PLAN_PRICES,
  resolveStripePriceId,
} = require("../subscriptionManagement");

/**
 * Choosing what to send, and whether now is the time to send it.
 *
 * The scheduler decides. It does not send, and it does not write, so it can be
 * run against production read-only to see exactly what the system would do.
 */

/* ------------------------------------------------------------------ */
/* Send window                                                         */
/* ------------------------------------------------------------------ */

/** Wall-clock hour and minute in New York, whatever the server thinks it is. */
function localClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hour12: false,
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  return {
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    weekday: get("weekday"),
  };
}

/**
 * Marketing sends late morning on weekdays.
 *
 * Weekends are excluded deliberately. A Saturday email about the door that
 * sticks arrives while somebody is at home looking at the door, which sounds
 * ideal and reads as intrusive.
 */
function inSendWindow(now = new Date()) {
  const { hour, minute, weekday } = localClock(now);
  if (["Sat", "Sun"].includes(weekday)) return false;
  const minutes = hour * 60 + minute;
  const start = SEND_WINDOW.startHour * 60;
  const end = SEND_WINDOW.endHour * 60 + SEND_WINDOW.endMinute;
  return minutes >= start && minutes <= end;
}

/* ------------------------------------------------------------------ */
/* Annual pricing gate                                                 */
/* ------------------------------------------------------------------ */

const ANNUAL_CACHE_TTL_MS = 15 * 60 * 1000;
let annualCache = { checkedAt: 0, healthy: false, detail: null };

/**
 * Are the annual prices chargeable AND do they match what the copy promises?
 *
 * The copy says "pay for ten months, get twelve". Verifying only that a price
 * is active and yearly would let us promise ten months in writing while Stripe
 * charged twelve, which is worse than not emailing at all. So the amount is
 * checked against the monthly plan price times ANNUAL_MONTHS_CHARGED.
 *
 * All or nothing across the four plans: an email that compares plans should not
 * contain one option the reader cannot buy.
 *
 * Fails closed. Any error, any missing price, any wrong amount, no annual mail.
 */
async function annualPricingHealthy(now = new Date(), options = {}) {
  const force = options.force === true;
  if (!force && now.getTime() - annualCache.checkedAt < ANNUAL_CACHE_TTL_MS) {
    return annualCache.healthy;
  }
  const detail = {};
  let healthy = true;

  if (!hasStripeSecretKey()) {
    annualCache = { checkedAt: now.getTime(), healthy: false, detail: { error: "no_stripe_key" } };
    return false;
  }

  /*
   * Ask the same resolver checkout uses rather than keeping a second copy of the
   * annual price ids here. A private copy went stale once already: checkout was
   * repointed at the corrected annual prices while this gate carried on checking
   * the retired ones, so the gate's answer stopped describing what a reader of
   * the email could actually buy.
   */
  const priceIds = {};
  for (const plan of Object.keys(PLAN_PRICES)) {
    const { priceId } = await resolveStripePriceId({ plan, billingCycle: "annual" });
    priceIds[plan] = priceId;
  }

  for (const [plan, priceId] of Object.entries(priceIds)) {
    if (!priceId) {
      detail[plan] = { ok: false, error: "no_price_mapped" };
      healthy = false;
      continue;
    }
    const monthlyDollars = PLAN_PRICES[plan];
    const expectedCents = Math.round(monthlyDollars * ANNUAL_MONTHS_CHARGED * 100);
    try {
      const price = await stripe.prices.retrieve(priceId);
      const active = price.active === true;
      const yearly = price.recurring?.interval === "year";
      const oncePerYear = (price.recurring?.interval_count || 1) === 1;
      const amount = Number(price.unit_amount);
      const amountMatches =
        Number.isFinite(amount) && Math.abs(amount - expectedCents) <= ANNUAL_PRICE_TOLERANCE_CENTS;

      const ok = active && yearly && oncePerYear && amountMatches;
      detail[plan] = {
        active,
        interval: price.recurring?.interval || null,
        intervalCount: price.recurring?.interval_count || null,
        actualCents: Number.isFinite(amount) ? amount : null,
        expectedCents,
        amountMatches,
        ok,
      };
      if (!ok) healthy = false;
    } catch (error) {
      detail[plan] = {
        ok: false,
        expectedCents,
        error: error?.code || error?.message || "retrieve_failed",
      };
      healthy = false;
    }
  }

  annualCache = { checkedAt: now.getTime(), healthy, detail };
  if (!healthy) {
    console.warn(
      JSON.stringify({ level: "warn", event: "marketing_annual_pricing_unhealthy", detail })
    );
  }
  return healthy;
}

function annualPricingDetail() {
  return annualCache.detail;
}

/* ------------------------------------------------------------------ */
/* Selection                                                           */
/* ------------------------------------------------------------------ */

/**
 * Has enough time passed for this audience's normal rotation?
 *
 * The 7 day floor is the hard rule and nothing overrides it. The per audience
 * pace is the softer target once somebody is past their opening lifecycle, so a
 * long-standing member hears from us every two or three weeks rather than
 * weekly. Lifecycle, activation and first contact bypass the pace, because
 * those are time-sensitive and the point is that they land on the right day.
 */
/** The target gap between rotation emails, per audience. */
function paceFor(audience) {
  if (audience === "member") return FREQUENCY.memberRotationDays;
  if (audience === "former_member") return FREQUENCY.formerMemberRotationDays;
  return FREQUENCY.nonMemberRotationDays;
}

function rotationReady(profile, template) {
  const sinceLast = daysSince(profile.lastMarketingAt, profile.now);
  // The hard floor is not negotiable, whatever the priority. personEligible
  // enforces it too; a scheduler that could hand back a send inside the floor
  // is one refactor away from that being the only check left.
  if (sinceLast < FREQUENCY.globalMinDays) return false;

  if (template.priority >= 75) return true;
  return sinceLast >= paceFor(profile.audience);
}

/** FNV-1a over person and campaign. Deterministic, and different per person. */
function jitter(profile, template) {
  const key = `${profile.user?._id || profile.user?.email || ""}:${template.id}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * Should the next email be a helpful one?
 *
 * Members already pay us, so most of what they receive should help them use
 * what they bought rather than sell them the next thing. Priority alone could
 * not deliver that: the old hard rule against two consecutive emails of the
 * same category forced strict alternation and pinned the ratio at 50/50.
 *
 * This measures the recent mix and steers, rather than alternating. It is a
 * preference, not a quota: if no helpful campaign is eligible the scheduler
 * still sends something useful rather than nothing.
 */
function wantsHelp(profile) {
  if (profile.helpShare === null || profile.helpShare === undefined) return true;
  return profile.helpShare < HELP_TARGET;
}

/**
 * Pick the single best campaign for one person, or nothing.
 *
 * Ordering, in strict order of precedence:
 *   1. priority, so activation beats a rotation email
 *   2. whether it matches the help or sell steer for this slot
 *   3. category variety, as a preference and never as a veto
 *   4. earliest unsent lifecycle step, so the opening sequence runs in order
 *   5. the topic they have gone longest without hearing about
 *   6. a stable per person hash, so cohorts do not move in lockstep
 *
 * Step 3 used to be a filter. As a filter it permanently starved any audience
 * with few categories: a former member ran out of non-fix campaigns and then
 * every fix campaign was blocked forever by the one before it. Diversity is
 * worth preferring and never worth going silent for.
 */
function selectCampaign(profile, options = {}) {
  const considered = [];
  const eligible = [];

  for (const template of ALL_TEMPLATES) {
    const verdict = templateEligible(template, profile, options);
    if (!verdict.eligible) {
      considered.push({ id: template.id, rejected: verdict.reason });
      continue;
    }
    if (!rotationReady(profile, template)) {
      considered.push({ id: template.id, rejected: "rotation_pace" });
      continue;
    }
    eligible.push(template);
  }

  const preferHelp = wantsHelp(profile);
  /*
   * The help steer governs the long-run rotation only. Activation, first
   * contact and the opening lifecycle have a scripted order and must not be
   * resequenced by it: without this exemption a member intro at day 15 could
   * overtake the day 7 email simply because the mix wanted a selling email.
   */
  const SCRIPTED = 75;
  const kindRank = (t) =>
    t.priority >= SCRIPTED ? 0 : (t.kind === KIND.HELP) === preferHelp ? 0 : 1;
  const categoryRank = (t) =>
    profile.lastMarketingCategory && t.category === profile.lastMarketingCategory ? 1 : 0;

  eligible.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    if (kindRank(a) !== kindRank(b)) return kindRank(a) - kindRank(b);
    if (categoryRank(a) !== categoryRank(b)) return categoryRank(a) - categoryRank(b);

    const aLife = a.lifecycleDay ?? a.activationDay ?? Infinity;
    const bLife = b.lifecycleDay ?? b.activationDay ?? Infinity;
    if (aLife !== bLife) return aLife - bLife;

    const aTopic = profile.sentTopicAt.get(a.topic);
    const bTopic = profile.sentTopicAt.get(b.topic);
    const aSeen = aTopic ? new Date(aTopic).getTime() : 0;
    const bSeen = bTopic ? new Date(bTopic).getTime() : 0;
    if (aSeen !== bSeen) return aSeen - bSeen;

    return jitter(profile, a) - jitter(profile, b);
  });

  return {
    template: eligible[0] || null,
    eligibleCount: eligible.length,
    preferredHelp: preferHelp,
    considered,
  };
}

module.exports = {
  annualPricingDetail,
  paceFor,
  annualPricingHealthy,
  inSendWindow,
  localClock,
  rotationReady,
  selectCampaign,
  wantsHelp,
};
