/**
 * The manager's sales desk: /api/admin/sales-desk/*. Owner only (it decides
 * credit and approves payouts, so it is never a grantable section).
 *
 * Every assignment, link, intake decision, credit decision, adjustment and
 * payout action is recorded: in the sales records themselves (append-only
 * where it is money) and in the Admin activity log.
 */
const express = require("express");
const mongoose = require("mongoose");
const moment = require("moment-timezone");
const auth = require("../middleware/auth");
const { PERMISSIONS, requirePermission } = require("../middleware/authorize");
const User = require("../models/User");
const Subscription = require("../models/Subscription");
const { SalesLead, LeadAssignment, SalesActivity, SalesTask, SalesCredit, SalesCreditRequest, SalesReview, SalesEvent, CommissionEntry, PayoutBatch, SalesGoal, SalesReferral } = require("../models/Sales");
const { createAdminActivityLog } = require("../utils/adminActivityLog");
const { SalesError, weekView, approveWeek, recordPayment, ledgerIntegrity, batchCsv } = require("../utils/sales/ledger");
const leads = require("../utils/sales/leads");
const views = require("../utils/sales/views");
const credit = require("../utils/sales/credit");
const evidence = require("../utils/sales/evidence");
const ghl = require("../utils/sales/ghl");
const { bonusProgress } = require("../utils/sales/bonus");
const { weekFromStart, payWeekOf, TZ } = require("../utils/sales/time");
const { requestDto } = require("./sales");

const router = express.Router();
router.use(auth, ...requirePermission(PERMISSIONS.ADMIN));

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    if (error instanceof SalesError) return res.status(error.statusCode).json({ code: error.code, message: error.message, ...error.extra });
    console.error(`sales-desk ${req.method} ${req.path} failed:`, error);
    return res.status(500).json({ code: "SERVER_ERROR", message: "Something went wrong." });
  }
};
const log = (req, action, entityType, entityId, entityName, details) =>
  createAdminActivityLog(req, { action, entityType, entityId, entityName, details }).catch((e) => console.warn("sales-desk audit failed:", e.message));

function range(req) {
  const tz = (d) => moment.tz(d, "YYYY-MM-DD", TZ);
  if (req.query.from && req.query.to) {
    const from = tz(String(req.query.from)).startOf("day");
    const to = tz(String(req.query.to)).add(1, "day").startOf("day");
    if (from.isValid() && to.isValid() && from < to) return { from: from.toDate(), to: to.toDate() };
  }
  const w = payWeekOf(new Date());
  return { from: w.startsAt, to: w.endsAt };
}

const oid = (v) => (mongoose.isValidObjectId(v) ? v : null);
async function telemarketer(id) {
  const u = oid(id) && (await User.findById(id).lean());
  if (!u || u.employeePosition !== "Telemarketer") throw new SalesError("NOT_FOUND", "Telemarketer not found.", 404);
  return u;
}

/* ------------------------------------------------------------- team */

router.get("/overview", wrap(async (req, res) => {
  const { from, to } = range(req);
  res.json(await views.teamOverview(from, to));
}));

router.get("/employees", wrap(async (_req, res) => {
  const list = await views.telemarketers();
  res.json({ employees: list.map((u) => ({ id: String(u._id), name: u.name, active: u.isActive !== false })) });
}));

router.get("/employees/:id", wrap(async (req, res) => {
  const u = await telemarketer(req.params.id);
  const { from, to } = range(req);
  res.json({
    employee: { id: String(u._id), name: u.name, active: u.isActive !== false, email: u.email || "", homeAddress: homeAddressDto(u) },
    metrics: await views.metricsFor(u._id, from, to),
    from,
    to,
    definitions: views.DEFINITIONS,
    bonus: await bonusProgress(u._id),
    earnings: await views.earningsSummary(u._id),
    statements: await views.employeeStatements(u._id),
    sales: await views.employeeSales(u._id),
    leads: await views.employeeLeads(u._id),
    goals: await views.goalsFor(u._id),
    coaching: await coachingFor(u._id),
  });
}));

function homeAddressDto(u) {
  const a = u.staffHomeAddress || {};
  return { line1: a.line1 || "", unit: a.unit || "", city: a.city || "", zip: a.zip || "" };
}

/** The employee's home address, for the self-referral check only (owner-only, optional). */
router.put("/employees/:id/home-address", wrap(async (req, res) => {
  const u = await telemarketer(req.params.id);
  const b = req.body || {};
  const t = (v, n) => String(v || "").replace(/\s+/g, " ").trim().slice(0, n);
  const next = { line1: t(b.line1, 120), unit: t(b.unit, 40), city: t(b.city, 60), zip: t(b.zip, 10) };
  if (next.zip && !/^\d{5}(-\d{4})?$/.test(next.zip)) throw new SalesError("BAD_ZIP", "Enter a 5-digit ZIP code.");
  if (next.line1 && !next.zip) throw new SalesError("ZIP_REQUIRED", "Add the ZIP code so the address can be matched.");
  await User.updateOne({ _id: u._id }, { $set: { staffHomeAddress: next } });
  await log(req, "Sales Employee Home Address Set", "employee", u._id, u.name, { recorded: Boolean(next.line1) });
  res.json({ homeAddress: next });
}));

async function coachingFor(employeeId) {
  const goal = await SalesGoal.findOne({ employee: employeeId }).lean();
  return goal?.note || "";
}

router.put("/employees/:id/goals", wrap(async (req, res) => {
  const u = await telemarketer(req.params.id);
  const n = (v) => Math.max(0, Math.min(500, Math.trunc(Number(v) || 0)));
  const goal = await SalesGoal.findOneAndUpdate(
    { employee: u._id },
    { $set: { weeklyMemberships: n(req.body?.weeklyMemberships), weeklyFreeVisits: n(req.body?.weeklyFreeVisits), note: String(req.body?.note || "").slice(0, 500), setBy: req.accessUser._id } },
    { upsert: true, new: true }
  ).lean();
  await log(req, "Sales Goals Set", "employee", u._id, u.name, { weeklyMemberships: goal.weeklyMemberships, weeklyFreeVisits: goal.weeklyFreeVisits });
  res.json({ goals: goal });
}));

/* ------------------------------------------------------------- leads */

const INTAKE_FLAG_TEXT = {
  matches_employee_phone: "Self-referral check: this phone number is the employee's own.",
  matches_employee_email: "Self-referral check: this email is the employee's own.",
};

async function leadRow(l, open, names) {
  const supp = await leads.suppressionState(l.phone);
  return {
    id: String(l._id),
    name: l.name,
    phone: l.phone,
    town: l.town,
    status: l.status,
    stage: l.stage,
    source: l.source,
    sourcedBy: l.sourcedBy ? names.get(String(l.sourcedBy)) || "" : "",
    linked: Boolean(l.linkedUser),
    intakeFlags: (l.intakeFlags || []).map((code) => ({ code, text: INTAKE_FLAG_TEXT[code] || code })),
    assignee: open ? { id: String(open.employee), name: names.get(String(open.employee)) || "", since: open.startedAt } : null,
    creditHolder: open ? { id: String(open.creditEmployee), name: names.get(String(open.creditEmployee)) || "" } : null,
    doNotCall: supp.call,
    doNotText: supp.sms,
    lastActivityAt: l.lastActivityAt,
    createdAt: l.createdAt,
  };
}

router.get("/leads", wrap(async (req, res) => {
  const view = String(req.query.view || "all");
  const openRows = await LeadAssignment.find({ endedAt: null }).lean();
  const openBy = new Map(openRows.map((a) => [String(a.lead), a]));
  const filter = {};
  if (view === "intake") filter.status = "intake";
  else if (view === "archived") filter.status = { $in: ["archived", "rejected"] };
  else filter.status = "active";
  if (view === "unassigned") filter._id = { $nin: openRows.map((a) => a.lead) };
  if (view === "assigned") filter._id = { $in: openRows.map((a) => a.lead) };
  if (req.query.employee && oid(req.query.employee)) filter._id = { $in: openRows.filter((a) => String(a.employee) === String(req.query.employee)).map((a) => a.lead) };
  if (view === "inactive") {
    const inactive = await User.find({ employeePosition: "Telemarketer", isActive: false }).select("_id").lean();
    filter._id = { $in: openRows.filter((a) => inactive.some((u) => String(u._id) === String(a.employee))).map((a) => a.lead) };
  }
  if (req.query.q) {
    const t = String(req.query.q).trim();
    const digits = t.replace(/\D/g, "");
    filter.$or = [{ name: { $regex: t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } }, ...(digits.length >= 4 ? [{ phone: { $regex: `${digits}$` } }] : [])];
  }
  const list = await SalesLead.find(filter).sort({ createdAt: -1 }).limit(500).lean();
  const ids = new Set();
  for (const l of list) {
    if (l.sourcedBy) ids.add(String(l.sourcedBy));
    const o = openBy.get(String(l._id));
    if (o) {
      ids.add(String(o.employee));
      ids.add(String(o.creditEmployee));
    }
  }
  const names = new Map((await User.find({ _id: { $in: [...ids] } }).select("name").lean()).map((u) => [String(u._id), u.name]));
  res.json({ leads: await Promise.all(list.map((l) => leadRow(l, openBy.get(String(l._id)), names))) });
}));

router.post("/leads", wrap(async (req, res) => {
  const lead = await leads.createLead(req, req.body || {}, { source: "owner", status: "active" });
  await leads.audit(req, "Sales Lead Created", lead, { source: lead.source });
  if (req.body?.assignTo) await leads.assignLead(req, lead._id, { employeeId: req.body.assignTo, reason: String(req.body.reason || "New lead") });
  res.status(201).json({ lead: { id: String(lead._id) } });
}));

router.get("/leads/:id", wrap(async (req, res) => {
  const lead = oid(req.params.id) && (await SalesLead.findById(req.params.id).lean());
  if (!lead) throw new SalesError("NOT_FOUND", "Lead not found.", 404);
  const history = await LeadAssignment.find({ lead: lead._id }).sort({ startedAt: 1 }).lean();
  const ids = new Set(history.flatMap((h) => [String(h.employee), String(h.creditEmployee), String(h.startedBy)]));
  if (lead.sourcedBy) ids.add(String(lead.sourcedBy));
  const names = new Map((await User.find({ _id: { $in: [...ids] } }).select("name").lean()).map((u) => [String(u._id), u.name]));
  const linked = lead.linkedUser ? await User.findById(lead.linkedUser).select("name userId email phone createdAt").lean() : null;
  const referral = lead.linkedUser ? await SalesReferral.findOne({ user: lead.linkedUser }).lean() : null;
  const sales = lead.linkedUser ? await SalesEvent.find({ user: lead.linkedUser }).sort({ paidAt: -1 }).lean() : [];
  const credits = new Map((await SalesCredit.find({ sale: { $in: sales.map((s) => s._id) } }).lean()).map((c) => [String(c.sale), c]));
  res.json({
    lead: {
      id: String(lead._id),
      name: lead.name,
      phone: lead.phone,
      email: lead.email,
      town: lead.town,
      zip: lead.zip,
      status: lead.status,
      stage: lead.stage,
      source: lead.source,
      sourceNote: lead.sourceNote,
      sourcedBy: lead.sourcedBy ? names.get(String(lead.sourcedBy)) : null,
      intakeFlags: (lead.intakeFlags || []).map((code) => ({ code, text: INTAKE_FLAG_TEXT[code] || code })),
      ghl: { ...leads.ghlLinks(lead), contactId: lead.ghlContactId || null },
      link: lead.link,
      linkedAccount: linked ? { id: String(linked._id), name: linked.name, userId: linked.userId, since: linked.createdAt } : null,
      referral: referral ? { employee: names.get(String(referral.employee)) || String(referral.employee), code: referral.code, at: referral.at } : null,
      suggestions: lead.linkedUser ? [] : await leads.suggestAccounts(lead),
      suppression: await leads.suppressionState(lead.phone),
      assignments: history.map((h) => ({ employee: names.get(String(h.employee)) || "", employeeId: String(h.employee), creditEmployee: names.get(String(h.creditEmployee)) || "", creditDecision: h.creditDecision, startedAt: h.startedAt, startedBy: names.get(String(h.startedBy)) || h.startedByName, reason: h.reason, endedAt: h.endedAt, endReason: h.endReason })),
      journey: lead.linkedUser ? await leads.journeyFor(lead.linkedUser) : null,
      sales: sales.map((s) => ({ id: String(s._id), kind: s.kind, label: credit.saleLabel(s), paidAt: s.paidAt, identity: s.identity, amounts: s.amounts, discount: s.discount, returningCustomer: s.returningCustomer, credit: credits.get(String(s._id)) ? { status: credits.get(String(s._id)).status, employee: credits.get(String(s._id)).employee ? String(credits.get(String(s._id)).employee) : null, reason: credits.get(String(s._id)).reason, ownerAssisted: credits.get(String(s._id)).ownerAssisted } : null })),
      tasks: (await SalesTask.find({ lead: lead._id, status: "open" }).sort({ dueAt: 1 }).lean()).map((t) => ({ id: String(t._id), dueAt: t.dueAt, kind: t.kind, note: t.note, assignee: String(t.assignee) })),
      timeline: await leads.timelineFor(lead, { forOwner: true }),
    },
  });
}));

router.post("/leads/:id/assign", wrap(async (req, res) => {
  const row = await leads.assignLead(req, req.params.id, { employeeId: req.body?.employeeId, reason: req.body?.reason, creditDecision: req.body?.creditDecision, moveTasks: req.body?.moveTasks !== false });
  res.json({ assignment: row });
}));

router.post("/leads/bulk-assign", wrap(async (req, res) => {
  const ids = (Array.isArray(req.body?.leadIds) ? req.body.leadIds : []).filter(oid).slice(0, 200);
  const assigned = [];
  const skipped = [];
  for (const id of ids) {
    if (await LeadAssignment.exists({ lead: id, endedAt: null })) {
      skipped.push({ id, reason: "already assigned (use Reassign to choose who keeps credit)" });
      continue;
    }
    try {
      await leads.assignLead(req, id, { employeeId: req.body?.employeeId, reason: req.body?.reason || "Bulk assignment" });
      assigned.push(id);
    } catch (error) {
      skipped.push({ id, reason: error.message });
    }
  }
  res.json({ assigned, skipped });
}));

router.post("/leads/:id/unassign", wrap(async (req, res) => {
  await leads.unassignLead(req, req.params.id, req.body?.reason);
  res.json({ ok: true });
}));

router.post("/leads/:id/link", wrap(async (req, res) => {
  const lead = await leads.linkLead(req, req.params.id, { userId: req.body?.userId, reason: req.body?.reason });
  res.json({ lead: { id: String(lead._id), linkedUser: String(lead.linkedUser) } });
}));

router.post("/leads/:id/notes", wrap(async (req, res) => {
  const lead = oid(req.params.id) && (await SalesLead.findById(req.params.id).lean());
  if (!lead) throw new SalesError("NOT_FOUND", "Lead not found.", 404);
  const kind = req.body?.kind === "coaching" ? "coaching" : "note";
  res.status(201).json({ activity: await leads.logActivity(req, lead, { kind, body: req.body?.body }, "owner") });
}));

router.post("/leads/:id/tasks", wrap(async (req, res) => {
  const lead = oid(req.params.id) && (await SalesLead.findById(req.params.id).lean());
  if (!lead) throw new SalesError("NOT_FOUND", "Lead not found.", 404);
  const open = await leads.currentAssignment(lead._id);
  const assignee = req.body?.assignee ? (await telemarketer(req.body.assignee))._id : open?.employee;
  if (!assignee) throw new SalesError("NO_ASSIGNEE", "Assign the lead first, or choose who follows up.");
  res.status(201).json({ task: await leads.createTask(req, lead, req.body || {}, assignee) });
}));

router.put("/leads/:id/ghl", wrap(async (req, res) => {
  const lead = oid(req.params.id) && (await SalesLead.findById(req.params.id).lean());
  if (!lead) throw new SalesError("NOT_FOUND", "Lead not found.", 404);
  const id = await leads.setGhlContact(req, lead, req.body?.contact);
  if (id) await ghl.replayUnmapped(id);
  res.json({ ghlContactId: id });
}));

router.post("/leads/:id/archive", wrap(async (req, res) => {
  const lead = oid(req.params.id) && (await SalesLead.findById(req.params.id));
  if (!lead || lead.status !== "active") throw new SalesError("NOT_FOUND", "Active lead not found.", 404);
  const why = String(req.body?.reason || "").trim();
  if (!why) throw new SalesError("REASON_REQUIRED", "Give a reason.");
  if (await LeadAssignment.exists({ lead: lead._id, endedAt: null })) await leads.unassignLead(req, lead._id, `Archived: ${why}`);
  lead.status = "archived";
  await lead.save();
  await leads.audit(req, "Sales Lead Archived", lead, { reason: why });
  res.json({ ok: true });
}));

router.post("/intake/:id/decide", wrap(async (req, res) => {
  const lead = await leads.decideIntake(req, req.params.id, { approve: req.body?.approve === true, reason: req.body?.reason, assignTo: req.body?.assignTo || null });
  res.json({ lead: { id: String(lead._id), status: lead.status } });
}));

/* For linking a lead: find the customer account (owner only). */
router.get("/customers/search", wrap(async (req, res) => {
  const t = String(req.query.q || "").trim();
  if (t.length < 2) return res.json({ customers: [] });
  const digits = t.replace(/\D/g, "");
  const or = [{ name: { $regex: t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } }];
  if (digits.length >= 4) or.push({ phone: { $regex: `${digits}$` } }, { userId: digits });
  const list = await User.find({ $or: or, role: { $nin: ["employee", "admin"] }, employeePosition: { $in: [null, ""] } }).select("name userId phone phoneVerifiedAt addresses createdAt").limit(15).lean();
  res.json({ customers: list.map((u) => ({ id: String(u._id), name: u.name, userId: u.userId, phoneLast4: String(u.phone || "").slice(-4), phoneVerified: Boolean(u.phoneVerifiedAt), town: u.addresses?.[0]?.city || "", since: u.createdAt })) });
}));

router.post("/suppressions/lift", wrap(async (req, res) => {
  res.json({ suppression: await leads.liftSuppression(req, req.body || {}) });
}));

/* ------------------------------------------------------------ reviews */

router.get("/reviews", wrap(async (req, res) => {
  const reviews = await SalesReview.find({ status: req.query.status === "resolved" ? "resolved" : "open" }).sort({ createdAt: -1 }).limit(200).lean();
  const requests = await SalesCreditRequest.find({ status: req.query.status === "resolved" ? { $in: ["approved", "rejected", "withdrawn"] } : { $in: ["pending", "needs_info"] } }).sort({ createdAt: -1 }).limit(200).lean();
  const ids = new Set([...requests.map((r) => String(r.employee))]);
  for (const r of reviews) for (const c of r.effects?.claimants || []) ids.add(String(c.employee));
  const names = new Map((await User.find({ _id: { $in: [...ids] } }).select("name").lean()).map((u) => [String(u._id), u.name]));
  res.json({
    reviews: reviews.map((r) => ({ id: String(r._id), kind: r.kind, summary: r.summary, effects: { ...r.effects, claimants: (r.effects?.claimants || []).map((c) => ({ ...c, name: names.get(String(c.employee)) || "" })) }, status: r.status, resolution: r.resolution, createdAt: r.createdAt })),
    requests: requests.map((r) => ({ ...requestDto(r, { forOwner: true }), employee: { id: String(r.employee), name: names.get(String(r.employee)) || "" } })),
  });
}));

router.post("/reviews/:id/resolve", wrap(async (req, res) => {
  const review = oid(req.params.id) && (await SalesReview.findById(req.params.id).lean());
  if (!review) throw new SalesError("NOT_FOUND", "Review not found.", 404);
  const b = req.body || {};
  const result = review.kind === "credit_hold"
    ? await credit.resolveHold(review._id, { decision: b.decision, employeeId: b.employeeId, reason: b.reason }, req.accessUser)
    : await credit.resolveMoneyReview(review._id, { action: b.action, amountCents: b.amountCents, employeeId: b.employeeId, reason: b.reason }, req.accessUser);
  await log(req, "Sales Review Resolved", "sales_review", review._id, review.kind, { decision: b.decision || b.action, reason: b.reason, entryId: result.entry ? String(result.entry._id) : null, amountCents: result.entry?.amountCents ?? null });
  res.json({ review: result.review, entryId: result.entry ? String(result.entry._id) : null });
}));

/** Everything the owner needs to decide a credit request. */
router.get("/credit-requests/:id", wrap(async (req, res) => {
  const r = oid(req.params.id) && (await SalesCreditRequest.findById(req.params.id).lean());
  if (!r) throw new SalesError("NOT_FOUND", "Request not found.", 404);
  const sale = await SalesEvent.findById(r.sale).lean();
  const employee = await User.findById(r.employee).select("name").lean();
  const customer = await User.findById(r.user).select("name userId createdAt").lean();
  const memberships = await Subscription.find({ user: r.user }).sort({ createdAt: 1 }).select("subscriptionType billingCycle status startDate cancellationDate currentPeriodEnd paymentMethod stripeSubscriptionId createdAt").lean();
  const previous = await CommissionEntry.find({ user: r.user }).sort({ earnedAt: 1 }).lean();
  const prevNames = new Map((await User.find({ _id: { $in: previous.map((p) => p.employee) } }).select("name").lean()).map((u) => [String(u._id), u.name]));
  const priorSales = await SalesEvent.find({ user: r.user, _id: { $ne: r.sale } }).sort({ paidAt: 1 }).lean();
  const creditRow = await SalesCredit.findOne({ sale: r.sale }).lean();
  res.json({
    request: { ...requestDto(r, { forOwner: true }), employee: { id: String(r.employee), name: employee?.name || "" } },
    customer: customer ? { id: String(customer._id), name: customer.name, userId: customer.userId, since: customer.createdAt } : null,
    sale: sale ? { id: String(sale._id), kind: sale.kind, label: credit.saleLabel(sale), plan: sale.plan, cycle: sale.cycle, paidAt: sale.paidAt, identity: sale.identity, amounts: sale.amounts, discount: sale.discount, returningCustomer: sale.returningCustomer, stripe: { invoiceId: sale.stripe.invoiceId, billingReason: sale.stripe.billingReason } } : null,
    currentCredit: creditRow ? { status: creditRow.status, reason: creditRow.reason } : null,
    membershipHistory: memberships.map((m) => ({ plan: m.subscriptionType, cycle: m.billingCycle, status: m.status, startDate: m.startDate || m.createdAt, endedOn: m.cancellationDate || null, complimentary: m.paymentMethod === "complimentary" })),
    previousCommissions: previous.map((p) => ({ id: String(p._id), employee: prevNames.get(String(p.employee)) || "", kind: p.kind, product: p.product, amountCents: p.amountCents, paidAt: p.paidAt, status: p.status, explain: p.calc?.explain || p.reason })),
    previousSales: priorSales.map((s) => ({ id: String(s._id), kind: s.kind, label: credit.saleLabel(s), paidAt: s.paidAt, amountCents: s.amounts?.amountCents || 0 })),
    bonusEffect: sale?.kind === "membership_change_paid"
      ? "A plan change counts toward the 20-membership bonus only if you choose so."
      : r.proposed?.countsForBonusDefault ? "Approving counts this sale once toward the 20-membership bonus, in the bonus month of its payment date." : "This sale does not count toward the bonus.",
  });
}));

router.post("/credit-requests/:id/decide", wrap(async (req, res) => {
  const b = req.body || {};
  const result = await credit.decideRequest(req.params.id, { action: b.action, reason: b.reason, amountCents: b.amountCents, countsForBonus: b.countsForBonus, selfReferralCleared: b.selfReferralCleared === true }, req.accessUser);
  await log(req, "Sales Credit Request Decided", "sales_credit_request", result.request._id, result.request.kind, { action: b.action, reason: b.reason, amountCents: result.entry?.amountCents ?? null, countsForBonus: b.countsForBonus ?? null, selfReferralCleared: b.selfReferralCleared === true ? true : null });
  res.json({ request: requestDto(result.request, { forOwner: true }), entryId: result.entry ? String(result.entry._id) : null });
}));

router.get("/credit-requests/:id/files/:fileId", wrap(async (req, res) => {
  const r = oid(req.params.id) && (await SalesCreditRequest.findById(req.params.id).lean());
  if (!r) throw new SalesError("NOT_FOUND", "Request not found.", 404);
  await evidence.sendFile(res, r, req.params.fileId);
}));

/* -------------------------------------------------------- commissions */

router.get("/commissions", wrap(async (req, res) => {
  const filter = {};
  if (req.query.employee && oid(req.query.employee)) filter.employee = req.query.employee;
  if (req.query.week) filter.statementWeek = String(req.query.week);
  const list = await CommissionEntry.find(filter).sort({ earnedAt: -1 }).limit(500).lean();
  const leadsBy = await views.leadsByUserFor(list.map((e) => e.user));
  const names = new Map((await User.find({ _id: { $in: list.map((e) => e.employee) } }).select("name").lean()).map((u) => [String(u._id), u.name]));
  res.json({ entries: list.map((e) => ({ ...views.entryDto(e, leadsBy), employee: { id: String(e.employee), name: names.get(String(e.employee)) || "" }, createdByName: e.createdByName })) });
}));

router.post("/adjustments", wrap(async (req, res) => {
  const b = req.body || {};
  const { entry, created } = await credit.createAdjustment({ employeeId: b.employeeId, amountCents: b.amountCents, reason: b.reason, idempotencyKey: b.idempotencyKey }, req.accessUser);
  if (created) await log(req, "Sales Adjustment Recorded", "commission_entry", entry._id, "adjustment", { employeeId: String(entry.employee), amountCents: entry.amountCents, reason: entry.reason, statementWeek: entry.statementWeek });
  res.status(created ? 201 : 200).json({ entry: views.entryDto(entry.toObject ? entry.toObject() : entry) });
}));

/* ------------------------------------------------------------ payouts */

router.get("/payouts", wrap(async (_req, res) => {
  const weeks = new Set(await CommissionEntry.distinct("statementWeek"));
  const batches = await PayoutBatch.find({}).lean();
  for (const b of batches) weeks.add(b.week);
  weeks.add(payWeekOf(new Date()).week);
  const out = [];
  for (const week of [...weeks].sort().reverse().slice(0, 104)) {
    const v = await weekView(week);
    if (!v.lines.length && week !== payWeekOf(new Date()).week && v.status !== "approved") continue;
    out.push({ week, lastDay: v.lastDay, payday: v.payday, status: v.status, totalCents: v.lines.reduce((s, l) => s + l.totalCents, 0), employees: v.lines.length, unpaid: v.status === "approved" ? v.lines.filter((l) => l.payment?.status !== "paid").length : null });
  }
  const check = await ledgerIntegrity();
  res.json({ payouts: out, integrity: { ok: check.ok, problems: check.problems.slice(0, 20), approvedWeeks: check.approvedWeeks } });
}));

function readWeek(req) {
  try {
    return weekFromStart(String(req.params.week)).week;
  } catch {
    throw new SalesError("BAD_WEEK", "Unknown week.", 404);
  }
}

router.get("/payouts/:week", wrap(async (req, res) => {
  const v = await weekView(readWeek(req));
  const leadsBy = await views.leadsByUserFor(v.entries.map((e) => e.user));
  res.json({ payout: { ...v, entries: v.entries.map((e) => ({ ...views.entryDto(e, leadsBy), employee: String(e.employee) })) } });
}));

router.post("/payouts/:week/approve", wrap(async (req, res) => {
  const batch = await approveWeek(readWeek(req), req.accessUser);
  await log(req, "Sales Payout Week Approved", "payout_batch", batch._id, batch.week, { totalCents: batch.lines.reduce((s, l) => s + l.totalCents, 0), employees: batch.lines.length });
  res.json({ payout: batch });
}));

router.post("/payouts/:week/lines/:employeeId/paid", wrap(async (req, res) => {
  const batch = await recordPayment(readWeek(req), req.params.employeeId, req.body || {}, req.accessUser);
  const line = batch.lines.find((l) => String(l.employee) === String(req.params.employeeId));
  await log(req, "Sales Payout Recorded", "payout_batch", batch._id, batch.week, { employee: line?.employeeName, totalCents: line?.totalCents, paidOn: line?.payment?.paidOn, method: line?.payment?.method, reference: line?.payment?.reference });
  res.json({ payout: batch });
}));

router.get("/payouts/:week/csv", wrap(async (req, res) => {
  const week = readWeek(req);
  const batch = await PayoutBatch.findOne({ week }).lean();
  if (!batch || batch.status !== "approved") throw new SalesError("NOT_APPROVED", "Approve the week to export it for payroll.", 409);
  await log(req, "Sales Payout Exported", "payout_batch", batch._id, week, { rows: batch.lines.length });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="payout-${week}.csv"`);
  res.setHeader("Cache-Control", "no-store");
  res.send(batchCsv(batch));
}));

/* ---------------------------------------------------------------- GHL */

router.get("/ghl", wrap(async (_req, res) => res.json({ ghl: await ghl.syncStatus() })));
router.post("/ghl/events/:id/retry", wrap(async (req, res) => {
  const doc = oid(req.params.id) && (await ghl.retryOne(req.params.id));
  if (!doc) throw new SalesError("NOT_FOUND", "Event not found.", 404);
  res.json({ event: { id: String(doc._id), status: doc.status, outcome: doc.outcome, lastError: doc.lastError } });
}));

module.exports = router;
