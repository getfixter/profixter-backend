const Booking = require("../../models/Booking");
const User = require("../../models/User");
const { SEGMENT_DEFS } = require("../growth/segments");
const { isMarketableAccount, isUnsubscribed } = require("../marketing/marketingEligibility");

/**
 * THE KINGDOM MARKETS PROFIXTER; THE OWNER RUNS IT.
 *
 * The only business data the marketing agents (King Arthur, Odysseus,
 * Leonidas, Marcus) receive. Everything here is built by WHITELIST - each
 * field is named explicitly - so nothing about revenue, MRR, Stripe, billing,
 * prices, plans, subscription statistics, cancellation analysis, ad spend or
 * calendar operations can reach a model, even if the underlying reports grow
 * new fields. scripts/test_marketing_data.js scans the outputs for any of it.
 *
 *   marketingResults()       organic acquisition: first free-visit bookings,
 *                            visitors, registrations, where they came from
 *                            (first touch), the booking funnel, towns
 *   reengagementAudiences()  for Marcus: how many people are in each
 *                            follow-up audience and how many of them may
 *                            lawfully be emailed or texted - counts only
 */

/** Organic acquisition, nothing financial. */
async function marketingResults({ now = new Date() } = {}) {
  const { acquisitionView } = require("../growth/commandCenter");
  const { buildOverview } = require("../analytics/overview");
  const [a, o30] = await Promise.all([acquisitionView({ now }), buildOverview({ range: "30d", now }).catch(() => null)]);
  const n = (v) => (typeof v === "number" ? v : null);
  return {
    firstFreeVisitBookings: {
      last7: n(a.firstFreeVisits?.last7),
      prev7: n(a.firstFreeVisits?.prev7),
      last30: n(a.firstFreeVisits?.last30),
      prev30: n(a.firstFreeVisits?.prev30),
    },
    visitors30: n(a.visitors30),
    registrations30: n(a.registrations30),
    bySource30: (a.bySource30 || []).map((s) => ({ source: s.label || s.key, key: s.key, visitors: n(s.visitors), registrations: n(s.registrations), firstFreeVisits: n(s.freeVisits) })),
    bookingFunnel30: a.funnel30
      ? {
          bookingPageViews: n(a.funnel30.booking_page_view),
          bookerStarted: n(a.funnel30.booker_started),
          slotChosen: n(a.funnel30.slot_selected),
          signupViewed: n(a.funnel30.signup_view),
          firstFreeVisits: n(a.funnel30.firstFreeVisits),
          trackingSince: a.funnel30.trackingSince || null,
        }
      : null,
    // where customers live: town names and how many customers, for local marketing - nothing else
    customerTowns: (o30?.topAreas || []).map((t) => ({ town: t.city || t.label || t.name || null, customers: n(t.customers) })).filter((t) => t.town),
    notes:
      "Organic marketing view only. First-touch attribution; Instagram vs Facebook is told apart by utm_source, so tag every organic link. Visitors counted since 2026-10-07. Revenue, memberships, billing and scheduling are the owner's and are not available to the Kingdom.",
  };
}

const DAY = 24 * 60 * 60 * 1000;
const AUDIENCES = {
  free_visit_undecided: { segment: "free_visit_undecided", label: "Had the free visit 3-60 days ago and did not join" },
  registered_never_booked: { segment: "registered_never_booked", label: "Registered 2-60 days ago and never booked" },
  former_member_recent: { segment: "former_member_recent", label: "Membership ended 14-120 days ago (past members)" },
};

/**
 * For Marcus: who could be followed up, and who may lawfully be contacted.
 * Per audience: how many people, how many may receive marketing EMAIL (a real
 * customer account, a deliverable address, not unsubscribed, not excluded),
 * how many opted in to marketing TEXTS, and how many opted out. Counts only:
 * no names, addresses, emails, phones, plans or amounts. Uses the same fixed
 * audience rules the email playbooks send to, re-checked per person.
 */
async function reengagementAudiences({ now = new Date(), sample = 150 } = {}) {
  const out = {};
  for (const [key, a] of Object.entries(AUDIENCES)) {
    const def = SEGMENT_DEFS[a.segment];
    const ids = await def.members({ now, limit: sample });
    const users = await User.find({ _id: { $in: ids } }).select("_id email role isActive employeePosition excludeFromMarketing createdAt smsPreferences").lean();
    let inAudience = 0;
    let emailable = 0;
    let textOptIn = 0;
    let optedOut = 0;
    for (const u of users) {
      if (!(await def.includes(u, { now }).catch(() => false))) continue;
      inAudience += 1;
      const unsub = await isUnsubscribed(u.email);
      if (unsub || u.excludeFromMarketing === true) optedOut += 1;
      else if (isMarketableAccount(u)) emailable += 1;
      if (u.smsPreferences?.marketingEnabled === true) textOptIn += 1;
    }
    out[key] = { audience: a.label, people: inAudience, mayEmail: emailable, optedInToMarketingTexts: textOptIn, optedOut, sampledUpTo: sample };
  }
  // the free-visit -> member step, as a count for follow-up planning (no amounts)
  const completed90 = await Booking.countDocuments({ isFreeFirstVisit: true, completedAt: { $gte: new Date(now - 90 * DAY) } });
  return {
    audiences: out,
    completedFreeVisitsLast90d: completed90,
    rules:
      "Follow-ups go only through approved email playbooks (the engine checks consent, unsubscribes, frequency caps and that the person is still in the audience at send time). Texts need marketing-text opt-in and are not available to you; GoHighLevel is out of scope. Never use more personal data than these counts.",
  };
}

module.exports = { AUDIENCES, marketingResults, reengagementAudiences };
