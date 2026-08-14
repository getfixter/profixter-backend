const Booking = require("../../models/Booking");
const EmailSuppression = require("../../models/EmailSuppression");
const EstimateLead = require("../../models/EstimateLead");
const MarketingSend = require("../../models/MarketingSend");
const Subscription = require("../../models/Subscription");
const VisitEntitlement = require("../../models/VisitEntitlement");
const { subscriptionGrantsAccess } = require("../subscriptionManagement");
const {
  COOLDOWN_DAYS,
  FREQUENCY,
  HELP_WINDOW,
  RESERVED_EMAIL_DOMAINS,
  audienceEnabled,
} = require("./marketingConfig");
const { KIND, audiencesOf } = require("./marketingLibrary");

/**
 * Who a person is right now, and what they may be sent.
 *
 * Everything here reads current production state. Nothing is precomputed into a
 * list, because the entire failure mode of marketing automation is a list built
 * on Tuesday being mailed on Friday to somebody who bought on Wednesday.
 *
 * This module answers questions. It never sends.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n, now = new Date()) => new Date(now.getTime() - n * DAY_MS);

const TERMINAL_BOOKING = [
  "Canceled", "Cancelled", "Completed", "Complete", "Done", "Failed", "No-Show", "Noshow",
];

/**
 * A subscription in one of these states means a payment did not go through.
 * Stripe moves a subscription here when a charge fails and keeps retrying.
 */
const FAILED_SUBSCRIPTION_STATUS = ["past_due", "unpaid", "incomplete", "incomplete_expired"];
/** And these payment intent states mean the last attempt did not complete. */
const FAILED_PAYMENT_INTENT = ["requires_payment_method", "requires_action", "requires_confirmation"];

/** Marketing categories that should never reach somebody whose card just failed. */
const ACTIVATION_WINDOW_DAYS = 14;

/**
 * Staff, system and explicitly excluded accounts are never marketing recipients.
 *
 * A missing role counts as a customer, matching the schema default. Most of the
 * real customer base predates the role field: those records have passwords,
 * addresses, subscriptions and hundreds of bookings between them, and reading
 * an absent role as "not a customer" would silently exclude the majority of the
 * people this system exists to reach. Staff are identified positively, by an
 * explicit role or an employeePosition, never by the absence of one.
 */
function isMarketableAccount(user) {
  if (!user) return false;
  const role = String(user.role || "customer").toLowerCase();
  if (role !== "customer") return false;
  if (user.isActive === false) return false;
  if (user.employeePosition) return false;
  if (user.excludeFromMarketing === true) return false;

  const email = String(user.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return false;

  /*
   * Only domains that provably cannot reach a person are excluded here. Guessing
   * from the address is how a real customer eventually gets dropped: test.com is
   * a genuine registered domain and could belong to somebody. Anything else
   * suspected of being internal needs the excludeFromMarketing flag set.
   */
  const domain = email.split("@")[1];
  if (RESERVED_EMAIL_DOMAINS.has(domain)) return false;
  if (domain.endsWith(".test") || domain.endsWith(".invalid") || domain.endsWith(".localhost")) return false;

  return true;
}

/**
 * The person's audience, derived from live subscription state.
 *
 * "Active member" means a subscription that actually grants access today, using
 * the same helper the product uses, so a past-due or lapsed subscription is not
 * quietly treated as active by marketing when the customer cannot book.
 */
async function resolveAudience(user, now = new Date()) {
  const subscriptions = await Subscription.find({ user: user._id })
    .sort({ currentPeriodEnd: -1, updatedAt: -1 })
    .lean();

  const paymentTrouble = subscriptions.some(
    (s) =>
      FAILED_SUBSCRIPTION_STATUS.includes(String(s.status || "")) ||
      (FAILED_PAYMENT_INTENT.includes(String(s.latestPaymentIntentStatus || "")) &&
        daysSince(s.updatedAt, now) < COOLDOWN_DAYS.afterPaymentFailed)
  );

  const active = subscriptions.find((s) => subscriptionGrantsAccess(s, { now }));
  if (active) {
    return {
      audience: "member",
      subscription: active,
      plan: String(active.subscriptionType || "").toLowerCase(),
      billingCycle: active.billingCycle === "annual" ? "annual" : "monthly",
      cancellationPending: !!active.cancelAtPeriodEnd,
      memberSince: active.startDate || active.createdAt || null,
      paymentTrouble,
    };
  }
  if (subscriptions.length) {
    return { audience: "former_member", subscription: subscriptions[0], plan: null, paymentTrouble };
  }
  return { audience: "non_member", subscription: null, plan: null, paymentTrouble };
}

/** Global opt-out. One flag, honoured by marketing only. */
async function isUnsubscribed(email) {
  const row = await EmailSuppression.findOne({
    email: String(email || "").trim().toLowerCase(),
  }).lean();
  return !!row;
}

/**
 * Everything the scheduler needs to judge a person, gathered once.
 *
 * Deliberately one round of queries per person rather than per candidate
 * template, because a rotation of fifty templates asking the same questions
 * fifty times is how a nightly job becomes a database problem.
 */
async function buildProfile(user, now = new Date(), options = {}) {
  const audienceInfo = await resolveAudience(user, now);
  const email = String(user.email || "").trim().toLowerCase();
  /*
   * The send-time re-check runs after the claim row exists, so it has to be
   * told to ignore that row. Without this the claim counts as a marketing send
   * that happened seconds ago, and every email cancels itself on the frequency
   * cap and the reuse cooldown it just created.
   */
  const excludeSendId = options.excludeSendId || null;

  const [
    history,
    activeBookings,
    membershipBookings,
    recentCancelled,
    fullDayEntitlement,
    oneTimeEntitlement,
    freeVisitUsed,
    bookingsEver,
    projectLead,
  ] = await Promise.all([
    /*
     * The whole reuse window, not the last 90 days. The scheduler needs to know
     * when each campaign was last sent in order to decide whether it may be
     * sent again, and how many times it has gone out, which is the cycle number
     * the duplicate index keys on.
     */
    MarketingSend.find({
      user: user._id,
      ...(excludeSendId ? { _id: { $ne: excludeSendId } } : {}),
      // Delivered attempts only. A claimed row has reached nobody yet, and
      // counting it makes concurrent workers cancel one another at the recheck.
      status: { $in: ["sent", "failed"] },
      createdAt: { $gte: daysAgo(COOLDOWN_DAYS.campaignReuse * 2, now) },
    })
      .select("campaignId topic category kind status sentAt createdAt cycle")
      .sort({ createdAt: 1 })
      .lean(),
    Booking.countDocuments({ user: user._id, status: { $nin: TERMINAL_BOOKING } }),
    Booking.countDocuments({ user: user._id, accessType: "membership" }),
    Booking.countDocuments({
      user: user._id,
      status: { $in: ["Canceled", "Cancelled"] },
      updatedAt: { $gte: daysAgo(COOLDOWN_DAYS.afterBookingCancelled, now) },
    }),
    VisitEntitlement.findOne({
      user: user._id, kind: "full_day_visit",
      status: { $in: ["paid", "consumed"] },
      createdAt: { $gte: daysAgo(COOLDOWN_DAYS.afterFullDayPurchase, now) },
    }).lean(),
    VisitEntitlement.findOne({
      user: user._id, kind: "one_time_handyman_visit",
      status: { $in: ["paid", "consumed"] },
      createdAt: { $gte: daysAgo(COOLDOWN_DAYS.afterOneTimePurchase, now) },
    }).lean(),
    Booking.countDocuments({ user: user._id, isFreeFirstVisit: true }),
    Booking.countDocuments({ user: user._id }),
    /*
     * Project leads are keyed by email, not user id, because the estimate form
     * is open to people without an account. Somebody who asked us for a kitchen
     * estimate last week should not be asked to request one.
     */
    EstimateLead.findOne({
      email,
      createdAt: { $gte: daysAgo(COOLDOWN_DAYS.afterProjectLead, now) },
    }).select("service createdAt").lean(),
  ]);

  /* Per campaign: when it last went out, and how many times. */
  const campaignLastSentAt = new Map();
  const campaignCycles = new Map();
  const topicSentAt = new Map();
  const sent = history.filter((r) => r.status === "sent");

  for (const row of history) {
    const stamp = row.sentAt || row.createdAt;
    campaignCycles.set(row.campaignId, Math.max(campaignCycles.get(row.campaignId) || 0, (row.cycle || 0) + 1));
    const prev = campaignLastSentAt.get(row.campaignId);
    if (!prev || new Date(stamp) > new Date(prev)) campaignLastSentAt.set(row.campaignId, stamp);
    const prevTopic = topicSentAt.get(row.topic);
    if (!prevTopic || new Date(stamp) > new Date(prevTopic)) topicSentAt.set(row.topic, stamp);
  }

  /*
   * "When did they last actually hear from us" counts delivered mail only. A
   * row that is merely claimed has not reached anybody yet, and treating it as
   * a send is what made every email cancel itself at the re-check.
   */
  const ordered = sent.slice().sort((a, b) => new Date(a.sentAt || a.createdAt) - new Date(b.sentAt || b.createdAt));
  const last = ordered[ordered.length - 1] || null;
  const recent = ordered.slice(-HELP_WINDOW);
  const helpCount = recent.filter((r) => r.kind === KIND.HELP).length;

  const memberDays = daysSince(audienceInfo.memberSince, now);

  return {
    user,
    now,
    ...audienceInfo,
    registeredAt: user.createdAt || null,
    lastMarketingAt: last ? last.sentAt || last.createdAt : null,
    lastMarketingCategory: last ? last.category || "" : "",
    everMarketed: ordered.length > 0,
    recentKinds: recent.map((r) => r.kind || KIND.SELL),
    helpShare: recent.length ? helpCount / recent.length : null,
    campaignLastSentAt,
    campaignCycles,
    sentTopicAt: topicSentAt,
    hasActiveBooking: activeBookings > 0,
    everBooked: bookingsEver > 0,
    hasMembershipBooking: membershipBookings > 0,
    recentlyCancelledBooking: recentCancelled > 0,
    boughtFullDayRecently: !!fullDayEntitlement,
    boughtOneTimeRecently: !!oneTimeEntitlement,
    freeVisitUsed: freeVisitUsed > 0,
    projectLead: projectLead || null,
    /*
     * A new member is still being onboarded until they book or the window
     * closes. While that is true nothing except activation may send, so a
     * seasonal tip cannot consume the seven day gap and push the activation
     * nudge a week late.
     */
    inActivationWindow:
      audienceInfo.audience === "member" &&
      membershipBookings === 0 &&
      Number.isFinite(memberDays) &&
      memberDays <= ACTIVATION_WINDOW_DAYS,
  };
}

/** Days since a date, or Infinity when it never happened. */
function daysSince(date, now = new Date()) {
  if (!date) return Infinity;
  return (now.getTime() - new Date(date).getTime()) / DAY_MS;
}

/**
 * Is this person allowed to receive any marketing at all right now?
 *
 * Checked before template selection, and again immediately before the send.
 * The second check is the one that matters: a person who bought a membership
 * between being queued and being sent must not receive a conversion email.
 */
async function personEligible(profile) {
  const { user, now } = profile;

  if (!isMarketableAccount(user)) return { eligible: false, reason: "not_a_marketable_account" };
  if (!audienceEnabled(profile.audience)) {
    return { eligible: false, reason: `audience_disabled_${profile.audience}` };
  }
  if (await isUnsubscribed(user.email)) return { eligible: false, reason: "unsubscribed" };

  const sinceLast = daysSince(profile.lastMarketingAt, now);
  if (sinceLast < FREQUENCY.globalMinDays) {
    return { eligible: false, reason: "frequency_cap", daysSinceLast: Number(sinceLast.toFixed(1)) };
  }

  // Do not be cheerful at somebody straight after something went wrong.
  if (profile.recentlyCancelledBooking) {
    return { eligible: false, reason: "recent_booking_cancellation" };
  }
  if (
    profile.audience === "former_member" &&
    daysSince(profile.subscription?.cancellationDate, now) < COOLDOWN_DAYS.afterMembershipCancelled
  ) {
    return { eligible: false, reason: "recent_membership_cancellation" };
  }

  return { eligible: true, reason: "" };
}

/**
 * May this specific template go to this person?
 *
 * Every rule that could embarrass us lives here: advertising a free visit to
 * somebody who used it, an upgrade to an Elite member, annual billing to
 * somebody already annual, a project estimate to somebody who asked for one
 * last week, or anything with a price on it to somebody whose card just failed.
 */
function templateEligible(template, profile, options = {}) {
  const { now } = profile;
  const no = (reason) => ({ eligible: false, reason });

  if (!audiencesOf(template).includes(profile.audience)) return no("wrong_audience");

  /* Reuse: a content rule, not the duplicate defence. */
  const lastSent = profile.campaignLastSentAt.get(template.id);
  if (lastSent) {
    const age = daysSince(lastSent, now);
    if (age < COOLDOWN_DAYS.campaignReuse) return no("campaign_cooldown");
  }

  const topicSentAt = profile.sentTopicAt.get(template.topic);
  if (topicSentAt && daysSince(topicSentAt, now) < COOLDOWN_DAYS.sameTopic) {
    return no("topic_cooldown");
  }

  /*
   * Onboarding lockout. Nothing but activation reaches a member who has not
   * booked yet and is still inside their window.
   */
  if (profile.inActivationWindow && template.category !== "activation") {
    return no("activation_window_in_progress");
  }

  /* A first contact message only ever goes to somebody with no history at all. */
  if (template.firstContactOnly) {
    if (profile.everMarketed) return no("already_marketed");
    // Brand new accounts get the real lifecycle instead of a reintroduction.
    if (daysSince(profile.registeredAt, now) < 90) return no("account_too_new_for_reintro");
  }

  if (template.requiresFreeVisitEligible) {
    if (profile.freeVisitUsed) return no("free_visit_already_used");
    if (profile.audience !== "non_member") return no("free_visit_members_not_eligible");
    /*
     * The product would still grant the free visit: its rule is per address and
     * only looks at bookings actually flagged isFreeFirstVisit, which predates
     * most of the database. But "thanks for setting up your account, your first
     * visit is free" is the wrong thing to say to somebody who has been booking
     * with us since 2025, whatever the entitlement says.
     */
    if (profile.everBooked) return no("already_an_existing_customer");
  }

  if (template.requiresMonthlyBilling && profile.billingCycle !== "monthly") {
    return no("already_annual");
  }
  if (template.requiresAnnualPricingWorking && options.annualPricingWorking !== true) {
    // Never drive somebody to a checkout that cannot complete.
    return no("annual_pricing_unavailable");
  }
  if (template.requiresUpgradeAvailable) {
    if (profile.plan === "elite") return no("already_top_plan");
    if (!profile.plan) return no("no_plan");
  }

  /* Nobody with a price on it while their payment is failing. */
  if (profile.paymentTrouble && template.kind === KIND.SELL) {
    return no("recent_payment_failure");
  }
  // Somebody on their way out should not be sold to.
  if (profile.cancellationPending && ["upgrade", "annual", "referral"].includes(template.category)) {
    return no("cancellation_pending");
  }

  if (template.category === "full_day" && profile.boughtFullDayRecently) return no("bought_full_day_recently");
  if (template.category === "one_time" && profile.boughtOneTimeRecently) return no("bought_one_time_recently");
  /*
   * Somebody already talking to us about a project should not be asked to start
   * that conversation. Everything else stays eligible, so they keep receiving
   * the useful home fix mail while their estimate is in progress.
   */
  if (template.category === "project" && profile.projectLead) return no("recent_project_lead");

  if (template.category === "activation") {
    if (profile.hasMembershipBooking) return no("already_booked_membership_visit");
    const memberDays = daysSince(profile.memberSince, now);
    if (memberDays < template.activationDay) return no("activation_not_due");
    // A window, not a floor: past it, they move into normal rotation instead of
    // being nagged about activation forever.
    if (memberDays > ACTIVATION_WINDOW_DAYS) return no("activation_window_passed");
  }

  if (template.lifecycleDay !== undefined) {
    const age = daysSince(profile.registeredAt, now);
    if (age < template.lifecycleDay) return no("lifecycle_not_due");
  }

  if (template.season && template.season !== seasonOf(now)) return no("out_of_season");

  return { eligible: true, reason: "" };
}

function seasonOf(date = new Date()) {
  const month = new Date(date).getMonth();
  if (month <= 1 || month === 11) return "winter";
  if (month <= 4) return "spring";
  if (month <= 7) return "summer";
  return "fall";
}

module.exports = {
  ACTIVATION_WINDOW_DAYS,
  COOLDOWN_DAYS,
  FAILED_PAYMENT_INTENT,
  FAILED_SUBSCRIPTION_STATUS,
  buildProfile,
  daysSince,
  isMarketableAccount,
  isUnsubscribed,
  personEligible,
  resolveAudience,
  seasonOf,
  templateEligible,
};
