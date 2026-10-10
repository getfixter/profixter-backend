const Booking = require("../../models/Booking");
const EmailSuppression = require("../../models/EmailSuppression");
const GrowthAction = require("../../models/GrowthAction");
const MarketingSend = require("../../models/MarketingSend");
const ServiceAreaWaitlist = require("../../models/ServiceAreaWaitlist");
const Subscription = require("../../models/Subscription");
const User = require("../../models/User");

/**
 * Profixter's own conversion funnel, for the Conversion & Customer Growth
 * agent. Counts and rates only: no names, emails, phones, addresses or free
 * text from customers (cancellation reasons are reduced to their most common
 * short values, clipped).
 *
 * Where customers stall, in the order the business makes money:
 *   registered -> free visit booked -> completed -> member -> retained
 * plus the automations working those gaps and the consent available to them.
 */

const DAY = 24 * 60 * 60 * 1000;
const ACTIVE = ["active", "trialing"];
const isCustomer = { role: { $nin: ["employee", "admin"] }, employeePosition: { $in: [null, ""] } };

function bucket(days) {
  if (days <= 7) return "0-7d";
  if (days <= 30) return "8-30d";
  if (days <= 90) return "31-90d";
  return "90d+";
}

async function conversionDetails({ now = new Date() } = {}) {
  const d30 = new Date(now - 30 * DAY);
  const d90 = new Date(now - 90 * DAY);

  const [registered30, freeVisits, subs, customersTotal, marketingSmsOptIn, transactionalSmsOptIn] = await Promise.all([
    User.find({ ...isCustomer, createdAt: { $gte: d90 } }).select("_id createdAt").lean(),
    Booking.find({ isFreeFirstVisit: true, createdAt: { $gte: new Date(now - 180 * DAY) } }).select("user status completedAt createdAt").lean(),
    Subscription.find({})
      .select("user status startDate cancellationDate cancellationReason cancellationFeedback createdAt updatedAt cancelAtPeriodEnd subscriptionType billingCycle")
      .lean(),
    User.countDocuments(isCustomer),
    User.countDocuments({ ...isCustomer, "smsPreferences.marketingEnabled": true }),
    User.countDocuments({ ...isCustomer, "smsPreferences.transactionalEnabled": true }),
  ]);

  const subsByUser = new Map();
  for (const s of subs) {
    const k = String(s.user);
    if (!subsByUser.has(k)) subsByUser.set(k, []);
    subsByUser.get(k).push(s);
  }
  const everMember = (userId) => (subsByUser.get(String(userId)) || []).some((s) => s.startDate);
  const memberSince = (userId) =>
    (subsByUser.get(String(userId)) || []).map((s) => new Date(s.startDate || s.createdAt)).sort((a, b) => a - b)[0] || null;
  const freeByUser = new Map();
  for (const b of freeVisits) {
    const k = String(b.user);
    if (!freeByUser.has(k)) freeByUser.set(k, []);
    freeByUser.get(k).push(b);
  }

  // Registered (last 90 days) and what happened next.
  const neverBooked = {};
  let bookedFree = 0;
  let becameMember = 0;
  for (const u of registered30) {
    const hasFree = freeByUser.has(String(u._id));
    if (hasFree) bookedFree += 1;
    if (everMember(u._id)) becameMember += 1;
    if (!hasFree && !everMember(u._id)) {
      const b = bucket((now - new Date(u.createdAt)) / DAY);
      neverBooked[b] = (neverBooked[b] || 0) + 1;
    }
  }

  // Completed free visits (last 180 days) -> membership.
  const completed = freeVisits.filter((b) => b.completedAt || /complete|done/i.test(String(b.status || "")));
  let converted = 0;
  const daysToConvert = [];
  const notConverted = {};
  for (const b of completed) {
    const since = memberSince(b.user);
    const done = new Date(b.completedAt || b.createdAt);
    if (since && since >= new Date(done - 7 * DAY)) {
      converted += 1;
      daysToConvert.push(Math.max(0, Math.round((since - done) / DAY)));
    } else {
      const k = bucket((now - done) / DAY);
      notConverted[k] = (notConverted[k] || 0) + 1;
    }
  }
  daysToConvert.sort((a, b) => a - b);

  // Retention.
  const active = subs.filter((s) => ACTIVE.includes(String(s.status)));
  const cancelled90 = subs.filter((s) => s.cancellationDate && new Date(s.cancellationDate) >= d90);
  const reasons = {};
  for (const s of cancelled90) {
    const r = String(s.cancellationReason || "not given").trim().toLowerCase().slice(0, 60);
    reasons[r] = (reasons[r] || 0) + 1;
  }
  const tenureMonths = active.map((s) => (now - new Date(s.startDate || s.createdAt)) / (30 * DAY));

  /*
   * Who leaves, and after how much use. For each cancellation in the last 90
   * days and each scheduled one: plan, months as a member, membership visits
   * actually booked in that time, how it ended (customer, payment failure,
   * admin...), and the customer's own stated reason when given.
   */
  const leaving = [...cancelled90, ...active.filter((s) => s.cancelAtPeriodEnd)];
  const usage = leaving.length
    ? await Booking.aggregate([
        { $match: { user: { $in: leaving.map((s) => s.user) }, accessType: "membership" } },
        { $project: { user: 1, createdAt: 1, status: 1 } },
      ])
    : [];
  const scrub = (t) =>
    String(t || "")
      .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "[email]")
      .replace(/\+?\d[\d\s().-]{7,}\d/g, "[phone]")
      .slice(0, 160);
  const tenureBucket = (m) => (m < 1 ? "<1 month" : m < 3 ? "1-3 months" : m < 6 ? "3-6 months" : m < 12 ? "6-12 months" : "12+ months");
  const howEnded = (s) => {
    const r = String(s.cancellationReason || "");
    if (s.cancelAtPeriodEnd && !s.cancellationDate) return "scheduled_by_customer";
    if (/payment/i.test(r)) return "payment_failure";
    if (/admin/i.test(r)) return "admin";
    if (/duplicate/i.test(r)) return "duplicate_cleanup";
    return "customer_or_stripe";
  };
  const profile = leaving.map((s) => {
    const start = new Date(s.startDate || s.createdAt);
    const end = s.cancellationDate ? new Date(s.cancellationDate) : now;
    const visits = usage.filter(
      (b) => String(b.user) === String(s.user) && new Date(b.createdAt) >= start && new Date(b.createdAt) <= end && !/cancel/i.test(String(b.status || ""))
    ).length;
    const months = (end - start) / (30 * DAY);
    return {
      plan: s.subscriptionType || null,
      cycle: s.billingCycle || null,
      scheduled: Boolean(s.cancelAtPeriodEnd && !s.cancellationDate),
      tenure: tenureBucket(months),
      membershipVisitsBooked: visits,
      ended: howEnded(s),
      reason: s.cancellationFeedback?.category || null,
      note: s.cancellationFeedback?.note ? scrub(s.cancellationFeedback.note) : null,
    };
  });
  const countBy = (key) => profile.reduce((acc, x) => ((acc[x[key] ?? "unknown"] = (acc[x[key] ?? "unknown"] || 0) + 1), acc), {});

  // Automations working the gaps.
  const [actions, sends, unsubs, waitlist] = await Promise.all([
    GrowthAction.aggregate([
      { $match: { createdAt: { $gte: d30 } } },
      { $group: { _id: { type: "$type", status: "$status" }, n: { $sum: 1 } } },
    ]),
    MarketingSend.aggregate([
      { $match: { status: "sent", sentAt: { $gte: d30 } } },
      { $group: { _id: { category: "$category", audience: "$audience" }, n: { $sum: 1 } } },
    ]),
    EmailSuppression.countDocuments({ reason: { $in: ["unsubscribe", "complaint"] }, createdAt: { $gte: d30 } }),
    ServiceAreaWaitlist.countDocuments({ status: "waiting" }),
  ]);

  return {
    window: { registrationsSince: d90.toISOString().slice(0, 10), freeVisitsSince: new Date(now - 180 * DAY).toISOString().slice(0, 10) },
    registrations90d: {
      total: registered30.length,
      bookedFreeVisit: bookedFree,
      becameMember,
      neverBookedNorJoinedByAge: neverBooked,
    },
    freeVisitToMember180d: {
      completedFreeVisits: completed.length,
      becameMembers: converted,
      rate: completed.length ? Math.round((converted / completed.length) * 1000) / 10 : null,
      medianDaysToJoin: daysToConvert.length ? daysToConvert[Math.floor(daysToConvert.length / 2)] : null,
      notYetMembersByAgeSinceVisit: notConverted,
    },
    retention: {
      activeMemberships: active.length,
      scheduledToCancel: active.filter((s) => s.cancelAtPeriodEnd).length,
      pastDueOrUnpaid: subs.filter((s) => ["past_due", "unpaid"].includes(String(s.status))).length,
      cancelledLast90d: cancelled90.length,
      systemCancellationCodes: Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 8),
      leavers: {
        note: "Cancelled in the last 90 days plus scheduled to cancel. 'reason' is what the customer chose after cancelling (optional, asked since 2026-10-10).",
        total: profile.length,
        byPlan: countBy("plan"),
        byTenure: countBy("tenure"),
        byHowEnded: countBy("ended"),
        byStatedReason: countBy("reason"),
        usedNoMembershipVisits: profile.filter((x) => x.membershipVisitsBooked === 0).length,
        detail: profile.slice(0, 40),
      },
      activeTenureMonths: tenureMonths.length
        ? { median: Math.round(tenureMonths.sort((a, b) => a - b)[Math.floor(tenureMonths.length / 2)] * 10) / 10, under3: tenureMonths.filter((m) => m < 3).length }
        : null,
    },
    reachableAudience: {
      customers: customersTotal,
      marketingSmsOptIn,
      serviceSmsOptIn: transactionalSmsOptIn,
      emailUnsubscribesLast30d: unsubs,
    },
    automationsLast30d: actions.map((a) => ({ type: a._id.type, status: a._id.status, count: a.n })),
    lifecycleEmailsSentLast30d: sends.map((s) => ({ category: s._id.category || "other", audience: s._id.audience, sent: s.n })),
    outOfAreaWaitlist: waitlist,
    notes: [
      "Checkout abandonment is visible as checkout_recovery_email proposals (one per expired membership checkout).",
      "No-shows are not recorded, so a completed free visit means status or completedAt says so.",
      "Small numbers: treat single-customer changes as noise.",
    ],
  };
}

module.exports = { conversionDetails };
