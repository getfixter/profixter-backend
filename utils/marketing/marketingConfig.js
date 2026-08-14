/**
 * Marketing email configuration.
 *
 * Everything here is deliberately separate from the transactional system. A
 * marketing failure, a marketing suppression or a marketing config mistake must
 * never be able to stop a booking confirmation or a password reset, so the two
 * share a transport and nothing else.
 */

/** Off until switched on. Deployment and activation are separate decisions. */
function marketingEnabled() {
  return String(process.env.ENABLE_MARKETING_EMAILS || "false").toLowerCase() === "true";
}

const ALL_AUDIENCES = ["member", "non_member", "former_member"];

/**
 * Which audiences may receive marketing, for ramping.
 *
 * The master switch above still governs everything. This is the second dial:
 * it lets the first week go to members only, who know us and are the least
 * likely to report us as spam, before the domain has any sending reputation.
 *
 * Unset means all three, so this can only ever narrow, never widen.
 */
function enabledAudiences() {
  const raw = String(process.env.MARKETING_AUDIENCES || "").trim();
  if (!raw) return new Set(ALL_AUDIENCES);
  const chosen = raw.split(",").map((a) => a.trim().toLowerCase()).filter((a) => ALL_AUDIENCES.includes(a));
  return new Set(chosen.length ? chosen : ALL_AUDIENCES);
}

function audienceEnabled(audience) {
  return enabledAudiences().has(audience);
}

const TIMEZONE = "America/New_York";

/**
 * Marketing goes out late morning, local time. Not because a minute has been
 * proven optimal, but because a cron firing at 03:00 is how a useful reminder
 * becomes a nuisance. Adjustable without touching the scheduler.
 */
const SEND_WINDOW = {
  startHour: Number(process.env.MARKETING_SEND_START_HOUR || 10),
  endHour: Number(process.env.MARKETING_SEND_END_HOUR || 11),
  endMinute: Number(process.env.MARKETING_SEND_END_MINUTE || 30),
};

/**
 * How often a person may hear from marketing at all.
 *
 * The hard floor applies to every marketing email regardless of type, so an
 * activation nudge today cannot be followed by a project promotion tomorrow.
 * The per-audience targets are the pace the rotation aims at once somebody is
 * past their opening lifecycle: members hear from us less, because they have
 * already bought and the job is to help them use it.
 */
/*
 * The pace has to be sustainable against the library, or the system burns
 * through every campaign and then goes quiet until the reuse cooldown expires.
 *
 * The arithmetic is: an audience with N campaigns on a P day pace consumes the
 * whole library in N * P days, and the first campaign becomes reusable after
 * COOLDOWN_DAYS.campaignReuse days. If N * P is shorter than the reuse window,
 * the difference is a silence. The first draft had 27 non member campaigns on a
 * 12 day pace against a 450 day reuse window, which is 324 against 450, and the
 * simulator duly found a 137 day gap.
 *
 * So these are not taste. Each pace is set so that N * P is at or above the
 * reuse window, and test_marketing_longterm asserts the invariant directly so
 * that adding a campaign or changing a number cannot quietly reintroduce a
 * drought.
 */
const FREQUENCY = {
  globalMinDays: Number(process.env.MARKETING_MIN_DAYS || 7),
  /** 27 campaigns. 27 x 14 = 378, comfortably over the 365 day reuse window. */
  nonMemberRotationDays: Number(process.env.MARKETING_NON_MEMBER_DAYS || 14),
  /** 33 campaigns. 33 x 17 = 561, with room to spare. */
  memberRotationDays: Number(process.env.MARKETING_MEMBER_DAYS || 17),
  /**
   * 16 campaigns. 16 x 23 = 368. Also the right pace on its own terms: three
   * weeks is the correct cadence for somebody who already chose to leave.
   */
  formerMemberRotationDays: Number(process.env.MARKETING_FORMER_MEMBER_DAYS || 23),
};

/**
 * Cooling periods, in days.
 *
 * Two kinds. Product cooldowns stop us advertising something a person just
 * bought or just asked about. Lifecycle cooldowns stop us being cheerful at
 * somebody immediately after something went wrong, which is the difference
 * between a useful reminder and a company that is not paying attention.
 */
const COOLDOWN_DAYS = {
  /**
   * How long before a person may receive the same campaign again.
   *
   * The first version of this system never repeated a campaign, which meant
   * every audience ran out of content inside a year and then went silent
   * forever.
   *
   * 365 days is the low end of the twelve to eighteen month range, chosen for
   * arithmetic rather than taste: the sustainable pace for an audience is this
   * window divided by the number of campaigns available to it, and at fifteen
   * months the non member library was too small to fill the gap. See FREQUENCY.
   *
   * This is a content rule. It is NOT what stops concurrent workers sending the
   * same email twice; that is the unique index on user, campaign and cycle.
   */
  campaignReuse: Number(process.env.MARKETING_REUSE_DAYS || 365),
  sameTopic: 90,
  planUpgrade: 75,
  annualOffer: 75,
  projectPromo: 75,
  referral: 75,
  afterFullDayPurchase: 60,
  afterOneTimePurchase: 30,
  afterProjectLead: 60,
  afterBookingCancelled: 7,
  afterPaymentFailed: 14,
  afterMembershipCancelled: 14,
};

/**
 * The physical postal address, required in every marketing email by CAN-SPAM.
 *
 * A constant rather than a per-template string: a compliance requirement that
 * can be forgotten on one template out of forty is not a requirement. The
 * scheduler refuses to send if this is ever emptied.
 */
const BUSINESS = {
  name: "ProFixter",
  addressLine: "245 42nd Street, Lindenhurst, NY 11757",
  phone: "631-599-1363",
};

/** Real routes only. A CTA is checked against this list before it can ship. */
const ROUTES = {
  book: "/book",
  bookMembership: "/book?visit=membership",
  bookOneTime: "/book?visit=additional",
  bookFullDay: "/book?visit=full-day",
  bookPriority: "/book?visit=priority",
  membership: "/membership",
  plans: "/membership/plans",
  projects: "/projects",
  projectEstimate: "/projects#estimate",
  account: "/account",
  services: "/services",
  renovations: "/renovations",
};

/*
 * Two different hosts, on purpose.
 *
 * Customer-facing links go to the www site. Deliberately not derived from
 * PUBLIC_SITE_BASE_URL or CLIENT_URL, both of which are the apex in production
 * and answer with a 307 to www: a redirect on every marketing click costs
 * nothing functionally and everything in click attribution and reputation.
 *
 * The unsubscribe link goes to the API host, because /api/email/unsubscribe is
 * an Express route. Pointing it at the site would produce an unsubscribe link
 * that 404s, which is both useless and a compliance failure.
 */
const SITE_URL = (process.env.MARKETING_SITE_BASE_URL || "https://www.profixter.com").replace(/\/+$/, "");
const API_BASE_URL = (
  process.env.API_URL ||
  process.env.PUBLIC_API_BASE_URL ||
  "https://api.profixter.com"
).replace(/\/+$/, "");

function routeUrl(routeKey) {
  const path = ROUTES[routeKey];
  if (!path) throw new Error(`Unknown marketing route: ${routeKey}`);
  return `${SITE_URL}${path}`;
}

/**
 * How many people a single run may email.
 *
 * Small on purpose, and small by default. Nobody in the database has any
 * marketing history, so on the first morning every customer is eligible at
 * once: without a low default, switching the flag on would mail the entire
 * historical database in ninety minutes. The defaults below turn that into a
 * ramp of roughly a week, and raising them is a deliberate act.
 *
 * The first real batches are also the ones that decide the sending reputation,
 * and a reputation is far easier to keep than to repair.
 */
const BATCH = {
  maxPerRun: Number(process.env.MARKETING_MAX_PER_RUN || 10),
  maxPerDay: Number(process.env.MARKETING_MAX_PER_DAY || 25),
  // SES allows 14/sec; nowhere near that is needed and pacing looks human.
  delayBetweenSendsMs: 400,
};

const MAX_ATTEMPTS = 3;

/**
 * How much of a member's marketing should be helping rather than selling.
 *
 * Members already pay us. The job is to remind them what their Fixter can do,
 * not to sell them the next thing. Priority alone could not deliver this: the
 * rule against two consecutive emails of the same category forced strict
 * alternation and pinned the ratio at 50/50 no matter how the tiers were set.
 * The scheduler now steers toward this share directly.
 *
 * Applied as a target over the recent window, not as a quota. If no helpful
 * campaign is available the scheduler sends something useful rather than
 * nothing.
 */
const HELP_TARGET = Number(process.env.MARKETING_HELP_TARGET || 0.65);
/**
 * How many recent sends the help ratio is measured over.
 *
 * Twelve rather than six because the window quantises the achievable ratio.
 * Over six emails the only values available are sixths, and a 0.65 target
 * oscillates between four sixths and three sixths, averaging 58%. Twelve gives
 * fine enough steps to actually land on the target, and for a member on a 17
 * day pace it looks back about six months, which is the right horizon for
 * "what has the mix been lately".
 */
const HELP_WINDOW = 12;

/**
 * The annual offer, as the copy states it: pay for ten months, get twelve.
 *
 * The price gate multiplies the monthly plan price by this number and refuses
 * to run any annual campaign unless Stripe agrees. If the offer ever changes,
 * change it here and the copy and the gate stay in step.
 */
const ANNUAL_MONTHS_CHARGED = Number(process.env.MARKETING_ANNUAL_MONTHS || 10);
/** Tolerance in cents when comparing Stripe's price to the advertised offer. */
const ANNUAL_PRICE_TOLERANCE_CENTS = 100;

/**
 * Domains reserved by RFC 2606 and RFC 6761. Mail to these cannot reach a real
 * person, so excluding them is safe in a way that guessing at "test.com" is
 * not: test.com is a genuine registered domain and could belong to a customer.
 * Anything else suspected of being a test account needs the explicit
 * excludeFromMarketing flag on the user record.
 */
const RESERVED_EMAIL_DOMAINS = new Set([
  "example.com", "example.org", "example.net", "example.edu",
  "test", "invalid", "localhost", "local",
]);

module.exports = {
  ALL_AUDIENCES,
  ANNUAL_MONTHS_CHARGED,
  ANNUAL_PRICE_TOLERANCE_CENTS,
  API_BASE_URL,
  BATCH,
  BUSINESS,
  COOLDOWN_DAYS,
  FREQUENCY,
  HELP_TARGET,
  HELP_WINDOW,
  MAX_ATTEMPTS,
  RESERVED_EMAIL_DOMAINS,
  ROUTES,
  SEND_WINDOW,
  SITE_URL,
  TIMEZONE,
  audienceEnabled,
  enabledAudiences,
  marketingEnabled,
  routeUrl,
};
