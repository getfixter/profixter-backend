const Booking = require("../../models/Booking");
const User = require("../../models/User");
const { SEGMENT_DEFS } = require("../growth/segments");
const { consentStatusFor } = require("../consent/status");

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

const MIN_DAYS_FOR_RATES = 14;

/**
 * The booking funnel over ONE window (the last 30 days, or the days since page
 * tracking began if fewer), with the first free visits of those same days.
 * Step rates are given only with 14+ days of tracking; before that they are
 * null with the reason, so nobody reads a few days of data as a trend.
 */
function funnelView(f) {
  const n = (v) => (typeof v === "number" ? v : null);
  /*
   * The CURRENT flow only (since the one-step request went live): page ->
   * started -> time picked -> request sent. There is no sign-up step any more,
   * so none is shown - a near-zero "went to sign up" was being read as
   * homeowners dropping out.
   */
  const steps = {
    bookingPageViews: n(f.booking_page_view),
    bookerStarted: n(f.booker_started),
    slotChosen: n(f.slot_selected),
    requestsSent: n(f.oneStepRequests),
    firstFreeVisitsWithAccount: n(f.firstFreeVisits),
  };
  const rate = (a, b) => (a && b != null ? Math.round((b / a) * 1000) / 10 : null);
  const enough = (f.days || 0) >= MIN_DAYS_FOR_RATES;
  const began = [f.trackingSince, f.flowSince].filter(Boolean).sort().pop() || null;
  return {
    window: { from: f.since || null, through: f.through || null, days: f.days ?? null, trackingBegan: f.trackingSince || null, currentFlowSince: f.flowSince || null },
    ...steps,
    stepRatesPct: enough
      ? {
          startedOfPageViews: rate(steps.bookingPageViews, steps.bookerStarted),
          slotOfStarted: rate(steps.bookerStarted, steps.slotChosen),
          sentOfSlot: rate(steps.slotChosen, steps.requestsSent),
        }
      : null,
    caution: enough
      ? null
      : `The current booking flow (and its tracking) began ${began || "recently"}: only ${f.days ?? "a few"} day(s) of data. Step and conversion rates are withheld until there are ${MIN_DAYS_FOR_RATES}+ days. Older funnel numbers describe the retired sign-up flow and are not comparable.`,
    notes:
      "requestsSent = one-step free-visit requests not yet linked to an account (a time is held; the owner calls to confirm). firstFreeVisitsWithAccount = first free visits booked from a customer account. Signed-in customers book without a request, so the steps do not have to add up.",
  };
}

/** Organic acquisition, nothing financial. */
async function marketingResults({ now = new Date() } = {}) {
  const { acquisitionView } = require("../growth/commandCenter");
  const { buildOverview } = require("../analytics/overview");
  const [a, o30] = await Promise.all([acquisitionView({ now }), buildOverview({ range: "30d", now }).catch(() => null)]);
  const n = (v) => (typeof v === "number" ? v : null);
  const f = a.firstFreeVisits || {};
  const TREND_WORDS = {
    up: "UP - more than normal week-to-week chance",
    down: "DOWN - fewer than normal week-to-week chance",
    steady: "STEADY - the difference is within the normal swing for numbers this small; do not call it a rise or a decline",
    too_few: "TOO FEW to call a trend either way",
  };
  return {
    firstFreeVisitBookings: {
      countedThrough: f.through || null,
      last7: n(f.last7),
      prev7: n(f.prev7),
      last30: n(f.last30),
      prev30: n(f.prev30),
      todaySoFar: n(f.todaySoFar),
      weekly: (f.weekly || []).map((w) => ({ from: w.from, through: w.through, firstFreeVisits: n(w.firstFreeVisits) })),
      trend: f.trend ? { last14Days: n(f.trend.last14), previous14Days: n(f.trend.prev14), verdict: TREND_WORDS[f.trend.verdict] || null } : null,
      howCounted:
        "Once per home at its earliest free-visit booking, homeowner accounts only (staff and test accounts excluded). Complete days only, through yesterday - today's unfinished day is shown apart as todaySoFar. ACCOUNT BOOKINGS ONLY: one-step requests are in oneStepFreeVisitRequests, and allNewFreeVisits is the two together - the number to judge. Quote the trend verdict; never call a change a decline when it says STEADY or TOO FEW.",
    },
    /*
     * Since 2026-10-23 most new homeowners send a one-step request instead of
     * booking from an account, and those are not in firstFreeVisitBookings.
     * The two together are the real number of new free visits.
     */
    oneStepFreeVisitRequests: a.oneStepRequests
      ? {
          last7: n(a.oneStepRequests.last7),
          prev7: n(a.oneStepRequests.prev7),
          last30: n(a.oneStepRequests.last30),
          prev30: n(a.oneStepRequests.prev30),
          todaySoFar: n(a.oneStepRequests.todaySoFar),
          last30AwaitingCall: n(a.oneStepRequests.last30AwaitingCall),
          last30Confirmed: n(a.oneStepRequests.last30Confirmed),
          last30ByPage: a.oneStepRequests.last30ByPage || null,
          howCounted:
            "Free-visit requests from the homepage or /book/free (time + name, mobile, email; no account). The time is held at once and the owner calls to confirm. Counted when sent, complete days through yesterday, only while not linked to an account (a confirmed one linked to an account moves into firstFreeVisitBookings), so the two never overlap. Awaiting the owner's call is normal, not a drop-off.",
        }
      : null,
    allNewFreeVisits: a.oneStepRequests
      ? (() => {
          const r = a.oneStepRequests;
          const sum = (x, y) => (typeof x === "number" && typeof y === "number" ? x + y : null);
          const last14 = sum(f.trend?.last14, r.last14);
          const prev14 = sum(f.trend?.prev14, r.prev14);
          const { _internal } = require("../analytics/overview");
          return {
            last7: sum(f.last7, r.last7),
            prev7: sum(f.prev7, r.prev7),
            last30: sum(f.last30, r.last30),
            prev30: sum(f.prev30, r.prev30),
            trend: last14 != null && prev14 != null ? { last14Days: last14, previous14Days: prev14, verdict: TREND_WORDS[_internal.trendVerdict(last14, prev14)] || null } : null,
            howCounted: "THE SCOREBOARD: first free visits booked from an account + one-step requests. Judge new-customer bookings by this, not by either part alone.",
          };
        })()
      : null,
    bookingFlow: a.bookingFlow
      ? {
          currentFlowSince: a.bookingFlow.since,
          changes: a.bookingFlow.changes,
          meaning:
            "The free-visit booking is now ONE STEP on both the homepage and /book/free: pick a time, enter name, mobile and email, send. No account, no photo, no sign-up page. The old drop-off between choosing a time and signing up belonged to the retired flow and was fixed by this change - do not report it as a current problem. Judge the new flow only on data since currentFlowSince.",
        }
      : null,
    // the acquisition's final step, counted once per customer - aggregate only, nothing about members
    newMembershipPurchases: a.newMembershipPurchases
      ? {
          last7: n(a.newMembershipPurchases.last7),
          prev7: n(a.newMembershipPurchases.prev7),
          last30: n(a.newMembershipPurchases.last30),
          prev30: n(a.newMembershipPurchases.prev30),
          weekly: (f.weekly || []).map((w) => ({ from: w.from, newMembershipPurchases: n(w.newMembershipPurchases) })),
          howCounted:
            "A customer's FIRST paid membership, once per customer (renewals, re-joins and gifts are not new conversions). This is where the Kingdom's work for that customer ends.",
        }
      : null,
    trackingQuality: {
      firstFreeVisits30WithNoFirstTouchRecord: n(f.noFirstTouchRecord30),
      meaning:
        "Bookings by accounts whose browser left no first-touch record (usually accounts created before first-touch tracking began on 2026-10-06, or a browser that blocked it). They are counted under Direct / Unknown but are UNTRACKED, not proof of direct traffic. This share shrinks as older accounts age out; it is not a tracking failure to fix.",
    },
    visitors30: n(a.visitors30),
    registrations30: n(a.registrations30),
    bySource30: (a.bySource30 || []).map((s) => ({ source: s.label || s.key, key: s.key, visitors: n(s.visitors), registrations: n(s.registrations), firstFreeVisits: n(s.freeVisits) })),
    bookingFunnel: a.funnel30 ? funnelView(a.funnel30) : null,
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
    const users = await User.find({ _id: { $in: ids } }).select("_id email phone role isActive employeePosition excludeFromMarketing createdAt smsPreferences emailPreferences").lean();
    let inAudience = 0;
    let emailable = 0;
    let textOptIn = 0;
    let optedOut = 0;
    for (const u of users) {
      if (!(await def.includes(u, { now }).catch(() => false))) continue;
      inAudience += 1;
      // the same reading the send paths use: suppression list for email, opt-in + no STOP for texts
      const st = await consentStatusFor(u);
      if (st.email === "unsubscribed" || st.email === "blocked" || u.excludeFromMarketing === true) optedOut += 1;
      else if (st.email === "opted_in" || st.email === "existing_customer") emailable += 1;
      if (st.smsMarketing === "opted_in") textOptIn += 1;
    }
    out[key] = { audience: a.label, people: inAudience, mayEmail: emailable, optedInToMarketingTexts: textOptIn, optedOut, sampledUpTo: sample };
  }
  // the free-visit -> member step, as a count for follow-up planning (no amounts)
  const completed90 = await Booking.countDocuments({ isFreeFirstVisit: true, completedAt: { $gte: new Date(now - 90 * DAY) } });
  return {
    audiences: out,
    completedFreeVisitsLast90d: completed90,
    rules:
      "Acquisition follow-ups only: a person who has ever had a membership is never in these audiences, and the engine re-checks membership and consent at the moment of sending. Follow-ups go only through approved email playbooks (the engine checks consent, unsubscribes, frequency caps and that the person is still in the audience at send time). Texts need marketing-text opt-in and are not available to you; GoHighLevel is out of scope. Never use more personal data than these counts.",
  };
}

module.exports = { AUDIENCES, marketingResults, reengagementAudiences };
