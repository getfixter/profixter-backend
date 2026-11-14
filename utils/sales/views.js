/**
 * Read models for the sales desk screens. Employee views are built only from
 * records the employee may see (their open assignments and their own credit
 * and ledger rows); manager views reuse the SAME functions per employee, so
 * the figures on both sides are always identical.
 */
const User = require("../../models/User");
const Booking = require("../../models/Booking");
const { SalesLead, LeadAssignment, SalesActivity, SalesTask, SalesCredit, SalesCreditRequest, SalesEvent, CommissionEntry, PayoutBatch, SalesReview, SalesGoal } = require("../../models/Sales");
const { bonusProgress } = require("./bonus");
const { previewCommission, saleLabel } = require("./credit");
const { suppressionState, ghlLinks, journeyFor, visitStatus } = require("./leads");
const { weekFromStart, payWeekOf, nextWeekKey } = require("./time");

const CONTACT_KINDS = ["attempt", "voicemail", "reached_interested", "reached_not_interested", "call_back", "wrong_number", "ghl_call", "ghl_sms"];
const REACHED_KINDS = ["reached_interested", "reached_not_interested"];
const initials = (name) => String(name || "").split(/\s+/).filter(Boolean).map((p) => p[0].toUpperCase()).slice(0, 2).join(". ") + (name ? "." : "");

/** The KPI dictionary returned with every metrics response. */
const DEFINITIONS = {
  newLeads: "Leads whose assignment to the employee began in the period (first assignment or reassignment to them).",
  leadsContacted: "Distinct leads with at least one logged call/text outcome or GHL call/text in the period. Rate denominator: leads assigned to the employee at any time in the period.",
  leadsReached: "Distinct leads with a 'reached' outcome in the period. Rate denominator: leads contacted.",
  registrations: "Customer accounts linked to the employee's leads that were created in the period, after the assignment began. Not a sale.",
  freeVisitsBooked: "Free-visit bookings created in the period by customers linked to the employee's leads. Not a sale.",
  freeVisitsCompleted: "Free visits marked completed in the period. Rate denominator: free visits whose date fell in the period.",
  firstPaidMemberships: "Approved commission entries for first membership payments (monthly or annual) with a verified payment in the period, including approved recovery sales.",
  annualSales: "The annual subset of first paid memberships.",
  fullDaySales: "Approved commission entries for separately paid Full Days with a verified payment in the period.",
  refunds: "Refunds recorded in the period on sales credited to the employee (count and amount). Shown for review; nothing is deducted automatically.",
  netVerifiedSales: "First paid memberships + Full Day sales in the period, minus those fully refunded by now.",
  commissionEarned: "Sum of approved ledger entries (commission, bonus, adjustments) earned in the period.",
  commissionPayable: "Approved entries on statements not yet marked paid (open or approved weeks).",
  commissionPaid: "Entries on statement lines the owner recorded as paid.",
  pendingClaims: "Sales waiting for an owner decision (held credit or credit requests). Never included in earnings.",
  followUpsOverdue: "Open follow-up tasks whose due time has passed.",
};

async function openAssignments(employeeId) {
  return LeadAssignment.find({ employee: employeeId, endedAt: null }).lean();
}

/* --------------------------------------------------------------- leads */

async function leadCard(lead, assignment, meId, tasksByLead) {
  const supp = await suppressionState(lead.phone);
  const next = (tasksByLead.get(String(lead._id)) || [])[0] || null;
  return {
    id: String(lead._id),
    name: lead.name,
    town: lead.town || "",
    phoneLast4: String(lead.phone || "").slice(-4),
    stage: lead.stage,
    linked: Boolean(lead.linkedUser),
    assignedAt: assignment?.startedAt || null,
    creditWithMe: assignment ? String(assignment.creditEmployee) === String(meId) : false,
    doNotCall: supp.call,
    doNotText: supp.sms,
    lastActivityAt: lead.lastActivityAt,
    nextTask: next ? { id: String(next._id), dueAt: next.dueAt, kind: next.kind, note: next.note } : null,
  };
}

async function employeeLeads(employeeId, { stage, q } = {}) {
  const rows = await openAssignments(employeeId);
  const filter = { _id: { $in: rows.map((r) => r.lead) }, status: "active" };
  if (stage) filter.stage = stage;
  let leads = await SalesLead.find(filter).sort({ lastActivityAt: -1, createdAt: -1 }).limit(500).lean();
  if (q) {
    const t = String(q).toLowerCase().trim();
    leads = leads.filter((l) => l.name.toLowerCase().includes(t) || String(l.phone).endsWith(t.replace(/\D/g, "") || "~"));
  }
  const tasks = await SalesTask.find({ lead: { $in: leads.map((l) => l._id) }, assignee: employeeId, status: "open" }).sort({ dueAt: 1 }).lean();
  const tasksByLead = new Map();
  for (const t of tasks) {
    const k = String(t.lead);
    if (!tasksByLead.has(k)) tasksByLead.set(k, []);
    tasksByLead.get(k).push(t);
  }
  const byLead = new Map(rows.map((r) => [String(r.lead), r]));
  return Promise.all(leads.map((l) => leadCard(l, byLead.get(String(l._id)), employeeId, tasksByLead)));
}

/** Sales on one lead's account, with this employee's credit status for each. */
async function salesForUser(userId, meId) {
  if (!userId) return [];
  const sales = await SalesEvent.find({ user: userId, kind: { $in: ["membership_first_paid", "membership_change_paid", "full_day_paid"] } }).sort({ paidAt: -1 }).lean();
  const credits = new Map((await SalesCredit.find({ sale: { $in: sales.map((s) => s._id) } }).lean()).map((c) => [String(c.sale), c]));
  const reqs = new Map((await SalesCreditRequest.find({ sale: { $in: sales.map((s) => s._id) }, status: { $in: ["pending", "needs_info", "approved"] } }).lean()).map((r) => [String(r.sale), r]));
  return sales.map((s) => {
    const c = credits.get(String(s._id));
    const r = reqs.get(String(s._id));
    let status = "unattributed";
    if (c?.status === "credited") status = String(c.employee) === String(meId) ? "credited_to_you" : "credited_to_someone_else";
    else if (c?.status === "held") status = "held_for_review";
    else if (c?.status === "rejected") status = "no_credit";
    else if (c?.reason === "returning_customer") status = "returning_customer";
    else if (c?.reason === "plan_change") status = "plan_change";
    if (r && r.status !== "approved") status = String(r.employee) === String(meId) ? `your_request_${r.status}` : "requested_by_someone_else";
    const claimable = ["unattributed", "returning_customer", "plan_change", "no_credit"].includes(status) && !r;
    return { id: String(s._id), kind: s.kind, label: saleLabel(s), plan: s.plan, cycle: s.cycle, paidAt: s.paidAt, paidPreTaxCents: s.amounts.paidPreTaxCents, status, claimable: claimable && status !== "no_credit" };
  });
}

async function employeeLeadDetail(lead, assignment, meId) {
  const { timelineFor } = require("./leads");
  const supp = await suppressionState(lead.phone);
  const tasks = await SalesTask.find({ lead: lead._id, assignee: meId, status: "open" }).sort({ dueAt: 1 }).lean();
  const j = lead.linkedUser ? await journeyFor(lead.linkedUser) : null;
  const creditHolder = assignment && String(assignment.creditEmployee) !== String(meId) ? "another employee" : "you";
  return {
    id: String(lead._id),
    name: lead.name,
    town: lead.town || "",
    phoneLast4: String(lead.phone || "").slice(-4),
    stage: lead.stage,
    source: lead.source,
    assignedAt: assignment?.startedAt || null,
    salesCredit: creditHolder === "you" ? "Sales credit for this lead is yours." : "Sales credit for this lead stays with another employee (manager's decision at reassignment).",
    suppression: supp,
    ghl: { ...ghlLinks(lead), contactId: lead.ghlContactId || null },
    linked: Boolean(lead.linkedUser),
    journey: j
      ? {
          registeredAt: j.registeredAt,
          phoneVerified: Boolean(j.phoneVerifiedAt),
          freeVisits: j.freeVisits.map((v) => ({ date: v.date, requestedAt: v.requestedAt, status: v.status, label: v.label, verified: v.verified })),
          membership: j.memberships[0] || null,
          membershipHistory: j.memberships,
        }
      : null,
    sales: await salesForUser(lead.linkedUser, meId),
    tasks: tasks.map((t) => ({ id: String(t._id), dueAt: t.dueAt, kind: t.kind, note: t.note })),
    timeline: await timelineFor(lead, { forOwner: false }),
  };
}

/* ------------------------------------------------------------ earnings */

function entryDto(e, leadsByUser = new Map()) {
  const lead = leadsByUser.get(String(e.user));
  return {
    id: String(e._id),
    kind: e.kind,
    product: e.product,
    amountCents: e.amountCents,
    customer: lead ? `${initials(lead.name)}${lead.town ? ` · ${lead.town}` : ""}` : e.user ? "Customer" : "",
    paidAt: e.paidAt,
    earnedAt: e.earnedAt,
    earnedWeek: e.earnedWeek,
    statementWeek: e.statementWeek,
    late: e.late,
    status: e.status,
    countsForBonus: e.countsForBonus,
    calc: {
      regularCents: e.calc?.regularCents || 0,
      discountCents: e.calc?.discountCents || 0,
      discountSource: e.calc?.discountSource || "",
      paidPreTaxCents: e.calc?.paidPreTaxCents || 0,
      taxCents: e.calc?.taxCents || 0,
      explain: e.calc?.explain || "",
      rule: e.calc?.rule ? { key: e.calc.rule.key, version: e.calc.rule.version } : null,
    },
    reason: e.reason || "",
    bonus: e.kind === "bonus" ? { periodIndex: e.bonus?.periodIndex, block: e.bonus?.block, counted: (e.bonus?.countedEntries || []).length } : null,
  };
}

async function leadsByUserFor(userIds) {
  const leads = await SalesLead.find({ linkedUser: { $in: userIds.filter(Boolean) } }).select("name town linkedUser").lean();
  return new Map(leads.map((l) => [String(l.linkedUser), l]));
}

/** Pending claims: held credits and open credit requests, with what they would pay. Never earnings. */
async function pendingClaims(employeeId) {
  const held = await SalesCredit.find({ status: "held", "claimants.employee": employeeId }).lean();
  const reqs = await SalesCreditRequest.find({ employee: employeeId, status: { $in: ["pending", "needs_info"] } }).lean();
  const sales = new Map((await SalesEvent.find({ _id: { $in: [...held.map((h) => h.sale), ...reqs.map((r) => r.sale)] } }).lean()).map((s) => [String(s._id), s]));
  const out = [];
  for (const h of held) {
    const s = sales.get(String(h.sale));
    if (!s) continue;
    const { computed } = await previewCommission(s);
    out.push({ type: "held_credit", saleId: String(s._id), label: saleLabel(s), paidAt: s.paidAt, proposedCents: computed.amountCents || 0, why: (h.holdReasons || []).join(", "), countsForBonus: s.kind === "membership_first_paid" });
  }
  for (const r of reqs) {
    const s = sales.get(String(r.sale));
    if (!s) continue;
    out.push({ type: "credit_request", requestId: String(r._id), saleId: String(s._id), label: saleLabel(s), paidAt: s.paidAt, proposedCents: r.proposed?.amountCents || 0, status: r.status, countsForBonus: Boolean(r.proposed?.countsForBonusDefault) });
  }
  return out;
}

async function earningsSummary(employeeId) {
  const entries = await CommissionEntry.find({ employee: employeeId }).lean();
  const sum = (f) => entries.filter(f).reduce((s, e) => s + e.amountCents, 0);
  const claims = await pendingClaims(employeeId);
  return {
    earnedCents: sum(() => true),
    commissionCents: sum((e) => e.kind === "commission"),
    bonusCents: sum((e) => e.kind === "bonus"),
    adjustmentCents: sum((e) => e.kind === "adjustment"),
    onOpenStatementsCents: sum((e) => e.status === "open"),
    approvedUnpaidCents: sum((e) => e.status === "approved"),
    paidCents: sum((e) => e.status === "paid"),
    pendingClaimsCents: claims.reduce((s, c) => s + c.proposedCents, 0),
    pendingClaimsCount: claims.length,
    claims,
  };
}

/** The employee's statements, newest first: their line on each week that has entries. */
async function employeeStatements(employeeId) {
  const weeks = await CommissionEntry.distinct("statementWeek", { employee: employeeId });
  const current = payWeekOf(new Date()).week;
  if (!weeks.includes(current)) weeks.push(current);
  weeks.sort().reverse();
  const batches = new Map((await PayoutBatch.find({ week: { $in: weeks } }).lean()).map((b) => [b.week, b]));
  const out = [];
  for (const week of weeks.slice(0, 104)) {
    const w = weekFromStart(week);
    const b = batches.get(week);
    const entries = await CommissionEntry.find({ employee: employeeId, statementWeek: week }).lean();
    const line = b?.status === "approved" ? (b.lines || []).find((l) => String(l.employee) === String(employeeId)) : null;
    const total = line ? line.totalCents : entries.reduce((s, e) => s + e.amountCents, 0);
    out.push({
      week,
      lastDay: w.lastDay,
      payday: w.payday,
      status: b?.status === "approved" ? (line?.payment?.status === "paid" ? "paid" : "approved") : Date.now() >= w.endsAt.getTime() ? "awaiting_approval" : "this_week",
      totalCents: total,
      entries: entries.length,
      paidOn: line?.payment?.paidOn || null,
      method: line?.payment?.method || null,
    });
  }
  return out;
}

async function employeeStatement(employeeId, week) {
  const w = weekFromStart(week);
  const b = await PayoutBatch.findOne({ week }).lean();
  const entries = await CommissionEntry.find({ employee: employeeId, statementWeek: week }).sort({ earnedAt: 1 }).lean();
  const leads = await leadsByUserFor(entries.map((e) => e.user));
  const line = b?.status === "approved" ? (b.lines || []).find((l) => String(l.employee) === String(employeeId)) : null;
  const items = entries.map((e) => entryDto(e, leads));
  const totals = { commissionCents: 0, bonusCents: 0, adjustmentCents: 0, totalCents: 0 };
  for (const e of entries) {
    totals[e.kind === "commission" ? "commissionCents" : e.kind === "bonus" ? "bonusCents" : "adjustmentCents"] += e.amountCents;
    totals.totalCents += e.amountCents;
  }
  return {
    week,
    lastDay: w.lastDay,
    payday: w.payday,
    frozen: b?.status === "approved",
    approvedAt: b?.approvedAt || null,
    payment: line?.payment || null,
    totals: line ? { commissionCents: line.commissionCents, bonusCents: line.bonusCents, adjustmentCents: line.adjustmentCents, totalCents: line.totalCents } : totals,
    items,
  };
}

/** Sales credited to, held for, or requested by the employee. */
async function employeeSales(employeeId) {
  const credits = await SalesCredit.find({ $or: [{ employee: employeeId }, { status: "held", "claimants.employee": employeeId }] }).sort({ createdAt: -1 }).limit(300).lean();
  const reqs = await SalesCreditRequest.find({ employee: employeeId }).sort({ createdAt: -1 }).limit(300).lean();
  const saleIds = [...credits.map((c) => c.sale), ...reqs.map((r) => r.sale)];
  const sales = new Map((await SalesEvent.find({ _id: { $in: saleIds } }).lean()).map((s) => [String(s._id), s]));
  const entries = new Map((await CommissionEntry.find({ sale: { $in: saleIds }, kind: "commission" }).lean()).map((e) => [String(e.sale), e]));
  const leads = await leadsByUserFor([...sales.values()].map((s) => s.user));
  const refunds = await SalesEvent.find({ relatesTo: { $in: saleIds }, kind: { $in: ["refund", "dispute_opened", "dispute_closed"] } }).lean();
  const seen = new Set();
  const out = [];
  const push = (s, credit, req) => {
    if (!s || seen.has(String(s._id))) return;
    seen.add(String(s._id));
    const e = entries.get(String(s._id));
    const mine = e && String(e.employee) === String(employeeId);
    const lead = leads.get(String(s.user));
    out.push({
      saleId: String(s._id),
      label: saleLabel(s),
      customer: lead ? `${initials(lead.name)}${lead.town ? ` · ${lead.town}` : ""}` : "Customer",
      paidAt: s.paidAt,
      verified: true,
      attribution: mine ? "approved" : credit?.status === "held" ? "pending_review" : req ? `request_${req.status}` : credit?.status || "none",
      commission: mine ? entryDto(e, leads) : null,
      amounts: { regularCents: s.amounts.regularCents, discountCents: s.amounts.discountCents, discountSource: s.discount?.source || "", paidPreTaxCents: s.amounts.paidPreTaxCents, taxCents: s.amounts.taxCents },
      refunds: refunds.filter((r) => String(r.relatesTo) === String(s._id)).map((r) => ({ kind: r.kind, amountCents: r.amounts.amountCents, at: r.paidAt, status: r.disputeStatus || null })),
    });
  };
  for (const r of reqs) push(sales.get(String(r.sale)), null, r);
  for (const c of credits) push(sales.get(String(c.sale)), c, null);
  return out.sort((a, b) => new Date(b.paidAt) - new Date(a.paidAt));
}

/* ------------------------------------------------------------- my day */

async function myDay(employeeId, now = new Date()) {
  const rows = await openAssignments(employeeId);
  const leadIds = rows.map((r) => r.lead);
  const leads = new Map((await SalesLead.find({ _id: { $in: leadIds }, status: "active" }).lean()).map((l) => [String(l._id), l]));
  const endOfToday = require("moment-timezone")(now).tz("America/New_York").endOf("day").toDate();
  const tasks = await SalesTask.find({ assignee: employeeId, status: "open", lead: { $in: [...leads.keys()] }, dueAt: { $lte: endOfToday } }).sort({ dueAt: 1 }).limit(100).lean();
  const taskRow = (t) => ({ id: String(t.id || t._id), leadId: String(t.lead), name: leads.get(String(t.lead))?.name || "", town: leads.get(String(t.lead))?.town || "", dueAt: t.dueAt, kind: t.kind, note: t.note, overdue: new Date(t.dueAt) < now });
  const fresh = rows.filter((r) => leads.has(String(r.lead)) && !leads.get(String(r.lead)).lastActivityAt).sort((a, b) => b.startedAt - a.startedAt).slice(0, 20);
  const users = [...leads.values()].filter((l) => l.linkedUser).map((l) => l.linkedUser);
  const soon = await Booking.find({ user: { $in: users }, date: { $gte: new Date(now.getTime() - 86400000), $lte: new Date(now.getTime() + 7 * 86400000) } }).select("user date status accessType freeVisitChannel subscription").sort({ date: 1 }).lean();
  const byUser = new Map([...leads.values()].filter((l) => l.linkedUser).map((l) => [String(l.linkedUser), l]));
  return {
    tasks: tasks.map(taskRow),
    overdueCount: tasks.filter((t) => new Date(t.dueAt) < now).length,
    newAssignments: fresh.map((r) => ({ leadId: String(r.lead), name: leads.get(String(r.lead)).name, town: leads.get(String(r.lead)).town || "", assignedAt: r.startedAt })),
    upcomingVisits: soon
      .filter((b) => b.accessType === "free_first_visit" || b.freeVisitChannel)
      .map((b) => ({ leadId: String(byUser.get(String(b.user))?._id || ""), name: byUser.get(String(b.user))?.name || "", date: b.date, ...visitStatus(b, now.getTime()) })),
    leadsCount: leads.size,
    bonus: await bonusProgress(employeeId, now),
    earnings: await earningsSummary(employeeId),
  };
}

/* ------------------------------------------------------------- metrics */

async function metricsFor(employeeId, from, to) {
  const inRange = { $gte: from, $lt: to };
  const everAssigned = await LeadAssignment.find({ employee: employeeId, startedAt: { $lt: to }, $or: [{ endedAt: null }, { endedAt: { $gte: from } }] }).lean();
  const leadIds = [...new Set(everAssigned.map((a) => String(a.lead)))];
  const newLeads = everAssigned.filter((a) => a.startedAt >= from && a.startedAt < to).length;
  const acts = await SalesActivity.find({ lead: { $in: leadIds }, at: inRange, kind: { $in: CONTACT_KINDS }, $or: [{ actor: employeeId }, { source: "ghl" }] }).select("lead kind").lean();
  const contacted = new Set(acts.map((a) => String(a.lead)));
  const reached = new Set(acts.filter((a) => REACHED_KINDS.includes(a.kind)).map((a) => String(a.lead)));
  const leads = await SalesLead.find({ _id: { $in: leadIds }, linkedUser: { $ne: null } }).select("linkedUser").lean();
  const firstStart = new Map();
  for (const a of everAssigned) {
    const k = String(a.lead);
    if (!firstStart.has(k) || a.startedAt < firstStart.get(k)) firstStart.set(k, a.startedAt);
  }
  const users = leads.map((l) => l.linkedUser);
  const registered = await User.find({ _id: { $in: users }, createdAt: inRange }).select("createdAt").lean();
  const leadOfUser = new Map(leads.map((l) => [String(l.linkedUser), String(l._id)]));
  const registrations = registered.filter((u) => u.createdAt >= (firstStart.get(leadOfUser.get(String(u._id))) || 0)).length;
  const free = { $or: [{ accessType: "free_first_visit" }, { freeVisitChannel: { $in: ["online", "callback"] } }] };
  const freeBooked = await Booking.countDocuments({ user: { $in: users }, createdAt: inRange, ...free });
  const freeCompleted = await Booking.countDocuments({ user: { $in: users }, completedAt: inRange, ...free });
  const freeDue = await Booking.countDocuments({ user: { $in: users }, date: { $gte: from, $lt: to < new Date() ? to : new Date() }, ...free });
  const entries = await CommissionEntry.find({ employee: employeeId }).lean();
  const sales = entries.filter((e) => e.kind === "commission" && e.paidAt >= from && e.paidAt < to);
  const memberships = sales.filter((e) => e.product.startsWith("membership_") && e.countsForBonus);
  const saleIds = sales.map((e) => e.sale).filter(Boolean);
  const refundsInRange = await SalesEvent.find({ kind: "refund", relatesTo: { $in: entries.filter((e) => e.kind === "commission").map((e) => e.sale) }, paidAt: inRange }).lean();
  const allRefunds = await SalesEvent.find({ kind: "refund", relatesTo: { $in: saleIds } }).lean();
  const refundedBy = new Map();
  for (const r of allRefunds) refundedBy.set(String(r.relatesTo), (refundedBy.get(String(r.relatesTo)) || 0) + r.amounts.amountCents);
  const saleDocs = new Map((await SalesEvent.find({ _id: { $in: saleIds } }).lean()).map((s) => [String(s._id), s]));
  const fullyRefunded = sales.filter((e) => {
    const s = saleDocs.get(String(e.sale));
    return s && (refundedBy.get(String(s._id)) || 0) >= s.amounts.amountCents;
  }).length;
  const earned = entries.filter((e) => e.earnedAt >= from && e.earnedAt < to);
  const overdue = await SalesTask.countDocuments({ assignee: employeeId, status: "open", dueAt: { $lt: new Date() } });
  const claims = await pendingClaims(employeeId);
  return {
    newLeads,
    assignedInPeriod: leadIds.length,
    leadsContacted: contacted.size,
    leadsReached: reached.size,
    registrations,
    freeVisitsBooked: freeBooked,
    freeVisitsCompleted: freeCompleted,
    freeVisitsDue: freeDue,
    firstPaidMemberships: memberships.length,
    annualSales: memberships.filter((e) => e.product === "membership_annual").length,
    fullDaySales: sales.filter((e) => e.product === "full_day").length,
    refunds: { count: refundsInRange.length, amountCents: refundsInRange.reduce((s, r) => s + r.amounts.amountCents, 0) },
    netVerifiedSales: memberships.length + sales.filter((e) => e.product === "full_day").length - fullyRefunded,
    commissionEarnedCents: earned.reduce((s, e) => s + e.amountCents, 0),
    commissionPayableCents: entries.filter((e) => e.status !== "paid").reduce((s, e) => s + e.amountCents, 0),
    commissionPaidCents: entries.filter((e) => e.status === "paid").reduce((s, e) => s + e.amountCents, 0),
    pendingClaims: claims.length,
    followUpsOverdue: overdue,
    rates: {
      contactRate: leadIds.length ? contacted.size / leadIds.length : null,
      reachRate: contacted.size ? reached.size / contacted.size : null,
      showRate: freeDue ? freeCompleted / freeDue : null,
      closeRate: reached.size ? memberships.length / reached.size : null,
    },
  };
}

async function telemarketers({ includeInactive = true } = {}) {
  return User.find({ role: "employee", employeePosition: "Telemarketer", ...(includeInactive ? {} : { isActive: { $ne: false } }) }).select("name firstName lastName email isActive createdAt").sort({ name: 1 }).lean();
}

async function teamOverview(from, to) {
  const people = await telemarketers();
  const rows = [];
  for (const p of people) {
    rows.push({
      employee: { id: String(p._id), name: p.name, active: p.isActive !== false },
      metrics: await metricsFor(p._id, from, to),
      bonus: await bonusProgress(p._id),
      openLeads: await LeadAssignment.countDocuments({ employee: p._id, endedAt: null }),
    });
  }
  const unassigned = await SalesLead.countDocuments({ status: "active", _id: { $nin: await LeadAssignment.distinct("lead", { endedAt: null }) } });
  const intake = await SalesLead.countDocuments({ status: "intake" });
  const reviews = await SalesReview.countDocuments({ status: "open" });
  const requests = await SalesCreditRequest.countDocuments({ status: { $in: ["pending", "needs_info"] } });
  const inactiveOwners = await LeadAssignment.countDocuments({ endedAt: null, employee: { $in: people.filter((p) => p.isActive === false).map((p) => p._id) } });
  return { from, to, rows, queues: { unassigned, intake, reviews, requests, leadsWithInactiveEmployee: inactiveOwners }, definitions: DEFINITIONS };
}

async function goalsFor(employeeId) {
  return (await SalesGoal.findOne({ employee: employeeId }).lean()) || { weeklyMemberships: 0, weeklyFreeVisits: 0, note: "" };
}

module.exports = {
  DEFINITIONS,
  initials,
  employeeLeads,
  employeeLeadDetail,
  salesForUser,
  entryDto,
  leadsByUserFor,
  pendingClaims,
  earningsSummary,
  employeeStatements,
  employeeStatement,
  employeeSales,
  myDay,
  metricsFor,
  telemarketers,
  teamOverview,
  goalsFor,
  nextWeekKey,
};
