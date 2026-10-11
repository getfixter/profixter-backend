const moment = require("moment-timezone");
const GrowthAction = require("../../models/GrowthAction");
const GrowthPolicy = require("../../models/GrowthPolicy");
const ServiceAreaWaitlist = require("../../models/ServiceAreaWaitlist");
const Subscription = require("../../models/Subscription");
const User = require("../../models/User");
const { customerMonthAvailability } = require("../customerCalendarService");
const { countyForZip } = require("../serviceArea");
const { clampMode, listDefinitions } = require("./actionRegistry");
const { engineEnabled } = require("./actionEngine");
const { buildVisibilitySummary } = require("../visibility/summary");
require("./actions");

/**
 * The Growth Command Center's own data: what the growth system is doing and
 * whether the business can take more customers.
 *
 * The money and the funnel stay in the Overview (utils/analytics/overview),
 * which the Command Center shows alongside this, so there is one definition of
 * revenue, members and conversion. This adds what the Overview cannot answer:
 *
 *   capacity    how full the calendar is for the next three weeks - the signal
 *               that decides whether to push acquisition or hold it
 *   actions     what is waiting for the owner, what ran on its own, what would
 *               have run (shadow), and how far each kind is trusted
 *   outcomes    whether the automations produced customers, not just sends
 *   demand      out-of-area waitlist, by ZIP
 *   alerts      deterministic thresholds - no model decides what is urgent
 */

const TIMEZONE = "America/New_York";
const CAPACITY_DAYS = 21;
const UTILIZATION_HIGH = 0.8;
const UTILIZATION_LOW = 0.25;

/** Booked share of visit capacity over the next `days` days (today excluded). */
async function capacityOutlook({ now = new Date(), days = CAPACITY_DAYS, monthLoader = customerMonthAvailability } = {}) {
  const start = moment.tz(now, TIMEZONE).add(1, "day").startOf("day");
  const end = start.clone().add(days - 1, "days");
  const months = new Set();
  for (let c = start.clone(); c.isSameOrBefore(end, "day"); c.add(1, "day")) months.add(c.format("YYYY-MM"));

  const byDate = new Map();
  for (const month of months) {
    const result = await monthLoader({ month, now });
    for (const day of result.days || []) byDate.set(day.date, day);
  }

  let capacity = 0;
  let booked = 0;
  let openDays = 0;
  const weeks = [];
  for (let c = start.clone(), i = 0; c.isSameOrBefore(end, "day"); c.add(1, "day"), i += 1) {
    const day = byDate.get(c.format("YYYY-MM-DD"));
    const taken = Object.values(day?.taken || {}).reduce((a, b) => a + Number(b || 0), 0);
    const remaining = Object.values(day?.remaining || {}).reduce((a, b) => a + Number(b || 0), 0);
    const dayCapacity = taken + remaining;
    if (dayCapacity > 0) openDays += 1;
    capacity += dayCapacity;
    booked += taken;
    const w = Math.floor(i / 7);
    weeks[w] = weeks[w] || { from: c.format("YYYY-MM-DD"), capacity: 0, booked: 0 };
    weeks[w].capacity += dayCapacity;
    weeks[w].booked += taken;
  }

  const utilization = capacity > 0 ? booked / capacity : null;
  return {
    from: start.format("YYYY-MM-DD"),
    to: end.format("YYYY-MM-DD"),
    days,
    openDays,
    capacity,
    booked,
    utilization,
    weeks: weeks.map((w) => ({ ...w, utilization: w.capacity > 0 ? w.booked / w.capacity : null })),
    signal:
      utilization === null
        ? "unknown"
        : utilization >= UTILIZATION_HIGH
        ? "near_full"
        : utilization <= UTILIZATION_LOW
        ? "room_to_grow"
        : "healthy",
  };
}

function publicAction(a) {
  return {
    id: String(a._id),
    type: a.type,
    status: a.status,
    summary: a.summary,
    rationale: a.rationale,
    riskTier: a.riskTier,
    modeAtProposal: a.modeAtProposal,
    heldReason: a.heldReason,
    proposedBy: a.proposedBy?.name || a.proposedBy?.kind || "",
    createdAt: a.createdAt,
    executedAt: a.executedAt,
    decidedAt: a.decidedAt,
    decidedBy: a.decidedBy?.name || null,
    expiresAt: a.expiresAt,
    lastError: a.lastError,
    result: a.result ? { reason: a.result.reason || null, to: a.result.to || null } : null,
    verification: a.verification?.status || null,
    // What the owner approves: the exact reply text, page wording, or playbook.
    preview:
      a.type === "conversation_reply"
        ? String(a.payload?.reply || "").slice(0, 1500)
        : /^seo_/.test(a.type)
        ? JSON.stringify(a.payload?.changes || {})
        : a.type === "playbook_email"
        ? `playbook ${a.payload?.playbookKey}`
        : null,
  };
}

async function policiesView() {
  const rows = await GrowthPolicy.find({}).lean();
  const byType = new Map(rows.map((r) => [r.type, r]));
  return listDefinitions().map((def) => {
    const p = byType.get(def.type);
    return {
      type: def.type,
      label: def.label,
      description: def.description,
      riskTier: def.riskTier,
      mode: clampMode(p?.mode || def.defaultMode, def.maxMode),
      defaultMode: def.defaultMode,
      maxMode: def.maxMode,
      promoteAfter: def.promoteAfter,
      perDay: def.limits?.perDay || null,
      streak: p?.consecutiveVerifiedSuccesses || 0,
      verifiedSuccesses: p?.verifiedSuccesses || 0,
      failures: p?.failures || 0,
      setBy: p?.setBy?.kind || "default",
      setNote: p?.setBy?.note || "",
      setAt: p?.setBy?.at || null,
      promotedAt: p?.promotedAt || null,
      demotedAt: p?.demotedAt || null,
    };
  });
}

/**
 * Did the recovery emails bring anyone back? A person counts as recovered if a
 * subscription of theirs started within 14 days after the email. Correlation,
 * not proof - some would have come back anyway - and the panel says so.
 */
async function recoveryOutcomes({ now = new Date() } = {}) {
  const since = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const sent = await GrowthAction.find({
    type: "checkout_recovery_email",
    status: "succeeded",
    executedAt: { $gte: since },
  })
    .select("subject executedAt")
    .lean();

  let recovered = 0;
  let pendingWindow = 0;
  for (const a of sent) {
    const windowEnd = new Date(a.executedAt.getTime() + 14 * 24 * 60 * 60 * 1000);
    if (windowEnd > now) pendingWindow += 1;
    const hit = await Subscription.exists({
      user: a.subject?.entityId,
      createdAt: { $gte: a.executedAt, $lte: windowEnd },
    });
    if (hit) recovered += 1;
  }
  return { windowDays: 14, sent: sent.length, recovered, stillInWindow: pendingWindow };
}

async function waitlistDemand({ now = new Date() } = {}) {
  const since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const [total, last30, byZip] = await Promise.all([
    ServiceAreaWaitlist.countDocuments({ status: "waiting" }),
    ServiceAreaWaitlist.countDocuments({ createdAt: { $gte: since } }),
    ServiceAreaWaitlist.aggregate([
      { $match: { status: "waiting" } },
      { $group: { _id: "$zip", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]),
  ]);
  return {
    waiting: total,
    last30Days: last30,
    topZips: byZip.map((z) => ({ zip: z._id, count: z.count, county: countyForZip(z._id) || null })),
  };
}

function buildAlerts({ capacity, queue, policies, registrationsLast72h, now }) {
  const alerts = [];
  if (capacity?.signal === "near_full") {
    alerts.push({
      level: "warning",
      key: "capacity_near_full",
      text: `The next ${capacity.days} days are ${Math.round(capacity.utilization * 100)}% booked. Hold paid acquisition or add capacity.`,
    });
  } else if (capacity?.signal === "room_to_grow") {
    alerts.push({
      level: "info",
      key: "capacity_room",
      text: `Only ${Math.round(capacity.utilization * 100)}% of the next ${capacity.days} days is booked: there is room for more customers.`,
    });
  }
  const oldPending = queue.pending.filter((a) => now - new Date(a.createdAt) > 24 * 60 * 60 * 1000);
  if (oldPending.length) {
    alerts.push({
      level: "warning",
      key: "approvals_waiting",
      text: `${oldPending.length} action${oldPending.length === 1 ? " has" : "s have"} waited over a day for your decision.`,
    });
  }
  for (const p of policies) {
    if (p.demotedAt && now - new Date(p.demotedAt) < 7 * 24 * 60 * 60 * 1000) {
      alerts.push({
        level: "warning",
        key: `demoted_${p.type}`,
        text: `"${p.label}" went back to needing approval after a failure: ${p.setNote || "see the activity log"}.`,
      });
    }
  }
  const failed = queue.recent.filter((a) => a.status === "failed");
  if (failed.length) {
    alerts.push({ level: "warning", key: "actions_failed", text: `${failed.length} recent automated action(s) failed.` });
  }
  if (registrationsLast72h === 0) {
    alerts.push({ level: "warning", key: "no_registrations", text: "No new customer accounts in the last 72 hours." });
  }
  return alerts;
}

/**
 * THE PRIMARY METRIC: new first free-visit bookings, with what feeds them.
 * Counts come from the Overview (one definition), the funnel steps from the
 * site's anonymous step beacon (models/FunnelStep).
 */
const nyDay = (d) => new Date(d).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const shiftDay = (ymd, days) => new Date(new Date(`${ymd}T12:00:00Z`).getTime() + days * 864e5).toISOString().slice(0, 10);

async function acquisitionView({ now = new Date() } = {}) {
  const { buildOverview } = require("../analytics/overview");
  const { FunnelStep, STEPS } = require("../../models/FunnelStep");
  const [o7, o30] = await Promise.all([buildOverview({ range: "7d", now }), buildOverview({ range: "30d", now })]);
  /*
   * ONE WINDOW FOR THE WHOLE FUNNEL. Page-step tracking began recently, so the
   * funnel covers the last 30 days OR the days since tracking began, whichever
   * is shorter - and the first free visits at its end are counted over exactly
   * the same days. (Comparing a few days of page views with 30 days of
   * bookings made the step rates meaningless.)
   */
  const today = nyDay(now);
  const start30 = shiftDay(today, -29);
  const firstTracked = (await FunnelStep.findOne({}).sort({ date: 1 }).select("date").lean())?.date || null;
  const since = firstTracked && firstTracked > start30 ? firstTracked : start30;
  const days = Math.round((new Date(`${today}T12:00:00Z`) - new Date(`${since}T12:00:00Z`)) / 864e5) + 1;
  const oFunnel = since === start30 ? o30 : await buildOverview({ range: "custom", from: since, to: today, now });
  const steps = await FunnelStep.aggregate([
    { $match: { date: { $gte: since, $lte: today } } },
    { $group: { _id: { step: "$step", source: "$source" }, n: { $sum: "$count" } } },
  ]);
  const byStep = Object.fromEntries(STEPS.map((s) => [s, steps.filter((x) => x._id.step === s).reduce((a, x) => a + x.n, 0)]));
  const fv = (o) => o?.kpis?.freeVisits || {};
  return {
    firstFreeVisits: {
      last7: fv(o7).firstBooked ?? null,
      prev7: fv(o7).prevFirstBooked ?? null,
      last30: fv(o30).firstBooked ?? null,
      prev30: fv(o30).prevFirstBooked ?? null,
    },
    visitors30: o30?.funnel?.visitors ?? null,
    registrations30: o30?.funnel?.registered ?? null,
    bySource30: (o30?.sources || [])
      .filter((s) => s.visitors || s.freeVisits || s.firstFreeVisits || s.registrations)
      // first free visits once per home, so the sources add up to the headline number
      .map((s) => ({ key: s.key, label: s.label, visitors: s.visitors, registrations: s.registrations, freeVisits: s.firstFreeVisits ?? s.freeVisits })),
    funnel30: {
      ...byStep,
      firstFreeVisits: fv(oFunnel).firstBooked ?? null,
      since,
      through: today,
      days,
      trackingSince: firstTracked,
      fullWindow: since === start30,
    },
    costPerFirstFreeVisitCents:
      o30?.spend?.connected && o30.spend.totalCents != null && fv(o30).firstBooked ? Math.round(o30.spend.totalCents / fv(o30).firstBooked) : null,
  };
}

async function buildCommandCenter({ now = new Date() } = {}) {
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [capacity, pending, recent, shadow, statusCounts, policies, outcomes, waitlist, registrationsLast72h, visibility, acquisition] =
    await Promise.all([
      capacityOutlook({ now }).catch((error) => ({ error: error.message, signal: "unknown" })),
      GrowthAction.find({ status: "awaiting_approval" }).sort({ createdAt: 1 }).limit(50).lean(),
      GrowthAction.find({ status: { $in: ["succeeded", "failed", "skipped", "rolled_back", "rejected", "expired"] } })
        .sort({ updatedAt: -1 })
        .limit(25)
        .lean(),
      GrowthAction.find({ status: "shadow", createdAt: { $gte: weekAgo } }).sort({ createdAt: -1 }).limit(25).lean(),
      GrowthAction.aggregate([
        { $match: { updatedAt: { $gte: weekAgo } } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
      policiesView(),
      recoveryOutcomes({ now }),
      waitlistDemand({ now }),
      User.countDocuments({
        createdAt: { $gte: new Date(now.getTime() - 72 * 60 * 60 * 1000) },
        role: { $nin: ["employee", "admin"] },
      }),
      // Never throws; each part degrades to { available: false, reason }.
      buildVisibilitySummary({ now }).catch((error) => ({ error: error.message })),
      acquisitionView({ now }).catch((error) => ({ error: error.message })),
    ]);

  const queue = {
    pending: pending.map(publicAction),
    recent: recent.map(publicAction),
    shadow: shadow.map(publicAction),
    last7Days: Object.fromEntries(statusCounts.map((s) => [s._id, s.count])),
  };

  return {
    generatedAt: now,
    engineEnabled: engineEnabled(),
    capacity,
    queue,
    policies,
    outcomes: { checkoutRecovery: outcomes },
    acquisition,
    waitlist,
    visibility,
    alerts: buildAlerts({ capacity, queue, policies, registrationsLast72h, now }),
  };
}

module.exports = { acquisitionView, buildCommandCenter, capacityOutlook, recoveryOutcomes, waitlistDemand, buildAlerts };
