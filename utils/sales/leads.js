/**
 * Leads: intake, assignment, account links, activity, tasks, do-not-contact,
 * and the customer journey shown on a lead.
 *
 * Every assignment change, link, intake decision and suppression lift is
 * written to the Admin activity log as well as to the sales records.
 */
const mongoose = require("mongoose");
const moment = require("moment-timezone");
const User = require("../../models/User");
const Booking = require("../../models/Booking");
const Subscription = require("../../models/Subscription");
const SmsOptOut = require("../../models/SmsOptOut");
const { SalesLead, LeadAssignment, SalesActivity, SalesTask, ContactSuppression, SalesCredit, SalesEvent, SalesReferralCode } = require("../../models/Sales");
const { normalizePhoneE164, normalizeEmail } = require("../identity");
const { createAdminActivityLog } = require("../adminActivityLog");
const { SalesError, inTransaction } = require("./ledger");
const { reviewSalesAfterLink, saleLabel } = require("./credit");
const { TZ } = require("./time");

const EMPLOYEE_ACTIVITY = ["attempt", "voicemail", "reached_interested", "reached_not_interested", "call_back", "wrong_number", "do_not_contact", "note", "correction"];
const STAGE_AFTER = {
  attempt: "contacted",
  voicemail: "contacted",
  call_back: "contacted",
  wrong_number: "contacted",
  reached_interested: "interested",
  reached_not_interested: "not_interested",
  do_not_contact: "lost",
};
const INTAKE_PER_DAY = 25;

const isTelemarketer = (u) => Boolean(u) && u.role === "employee" && u.employeePosition === "Telemarketer";
const isCustomerAccount = (u) => Boolean(u) && String(u.role || "customer") === "customer" && !u.employeePosition;
const clean = (v, max = 500) => String(v ?? "").trim().slice(0, max);

function audit(req, action, lead, details = {}) {
  return createAdminActivityLog(req, { action, entityType: "sales_lead", entityId: lead?._id || null, entityName: lead?.name || "", details }).catch((e) => console.warn("sales audit log failed:", e.message));
}

/* ------------------------------------------------------------ do-not-contact */

/** The most restrictive state for a phone: any active suppression wins (Profixter, GHL, or a Twilio STOP). */
async function suppressionState(phone) {
  const state = { call: false, sms: false, reasons: [] };
  if (!phone) return state;
  const rows = await ContactSuppression.find({ phone }).sort({ at: -1, _id: -1 }).lean();
  const latest = new Map();
  for (const r of rows) if (!latest.has(r.channel)) latest.set(r.channel, r);
  for (const [channel, r] of latest) {
    if (r.action !== "suppress") continue;
    if (channel === "all" || channel === "call") state.call = true;
    if (channel === "all" || channel === "sms") state.sms = true;
    state.reasons.push({ channel, source: r.source, reason: r.reason, at: r.at });
  }
  const stop = await SmsOptOut.findOne({ phone });
  if (stop && stop.isActive() && stop.scope === "all") {
    state.sms = true;
    state.reasons.push({ channel: "sms", source: "customer", reason: "Replied STOP to a Profixter text", at: stop.optedOutAt });
  }
  return state;
}

async function addSuppression({ phone, channel, source, reason, actor = null, lead = null, ghlEventId = null, at = new Date() }) {
  if (!["call", "sms", "all"].includes(channel)) throw new SalesError("BAD_CHANNEL", "Choose calls, texts or both.");
  return (await ContactSuppression.create({ phone, channel, action: "suppress", source, reason: clean(reason), by: actor?._id || null, byName: actor?.name || "", lead: lead?._id || null, ghlEventId, at })).toObject();
}

/** Only the owner can lift a restriction, with a reason. A Twilio STOP is lifted only by the customer texting START. */
async function liftSuppression(req, { phone, channel, reason }) {
  const why = clean(reason);
  if (why.length < 5) throw new SalesError("REASON_REQUIRED", "Say why the customer may be contacted again (for example, their written request).");
  const e164 = normalizePhoneE164(phone);
  if (!e164) throw new SalesError("BAD_PHONE", "Phone number is not valid.");
  const row = await ContactSuppression.create({ phone: e164, channel, action: "lift", source: "owner", reason: why, by: req.accessUser._id, byName: req.accessUser.name || "" });
  await audit(req, "Sales Do-Not-Contact Lifted", null, { phoneLast4: e164.slice(-4), channel, reason: why });
  return row.toObject();
}

/* --------------------------------------------------------------- creation */

async function createLead(req, { name, phone, email, town, zip, note, userId }, { source = "owner", status = "active", sourcedBy = null } = {}) {
  const nm = clean(name, 120);
  if (!nm) throw new SalesError("NAME_REQUIRED", "Enter the person's name.");
  let user = null;
  if (userId) {
    user = mongoose.isValidObjectId(userId) ? await User.findById(userId).lean() : null;
    if (!isCustomerAccount(user)) throw new SalesError("NOT_FOUND", "Customer not found.", 404);
  }
  const e164 = normalizePhoneE164(phone || user?.phone);
  if (!e164) throw new SalesError("BAD_PHONE", "Enter a valid US phone number.");
  try {
    const lead = await SalesLead.create({
      name: nm,
      phone: e164,
      email: normalizeEmail(email) || null,
      town: clean(town || user?.addresses?.[0]?.city, 80),
      zip: clean(zip || user?.addresses?.[0]?.zip, 10),
      source: user ? "existing_customer" : source,
      sourcedBy,
      createdBy: req.accessUser._id,
      sourceNote: clean(note, 1000),
      status,
      ...(user ? { linkedUser: user._id, link: { method: "from_account", by: req.accessUser._id, at: new Date(), reason: "Lead created from the customer's account" } } : {}),
    });
    return lead.toObject();
  } catch (error) {
    if (error?.code === 11000) throw new SalesError("DUPLICATE", "This person is already in the sales desk.", 409);
    throw error;
  }
}

/** An employee's own lead: waits in the owner's intake queue; nobody works it until approved. */
async function submitIntake(req, body) {
  const me = req.accessUser;
  const since = moment().tz(TZ).startOf("day").toDate();
  const today = await SalesLead.countDocuments({ createdBy: me._id, source: "employee_intake", createdAt: { $gte: since } });
  if (today >= INTAKE_PER_DAY) throw new SalesError("INTAKE_LIMIT", `You can add up to ${INTAKE_PER_DAY} leads a day. Ask the owner about larger lists.`, 429);
  const lead = await createLead(req, { ...body, userId: null }, { source: "employee_intake", status: "intake", sourcedBy: me._id });
  // Self-referral check: flag (never refuse) a lead whose phone or email is the employee's own.
  const { normPhone, normEmail } = require("./selfReferral");
  const flags = [];
  const mine = (await User.findById(me._id).select("phone email").lean()) || me;
  if (normPhone(mine.phone) && normPhone(mine.phone) === normPhone(lead.phone)) flags.push("matches_employee_phone");
  if (normEmail(mine.email) && normEmail(mine.email) === normEmail(lead.email)) flags.push("matches_employee_email");
  if (flags.length) {
    await SalesLead.updateOne({ _id: lead._id }, { $set: { intakeFlags: flags } });
    lead.intakeFlags = flags;
  }
  await SalesActivity.create({ lead: lead._id, actor: me._id, actorName: me.name || "", actorRole: "telemarketer", kind: "note", body: clean(body.note, 2000) || "Lead added for review.", source: "manual" });
  await audit(req, "Sales Lead Submitted", lead, { source: "employee_intake" });
  return lead;
}

async function decideIntake(req, leadId, { approve, reason, assignTo }) {
  const lead = await SalesLead.findById(leadId);
  if (!lead || lead.status !== "intake") throw new SalesError("NOT_FOUND", "Intake lead not found.", 404);
  const why = clean(reason);
  lead.status = approve ? "active" : "rejected";
  lead.intakeDecision = { by: req.accessUser._id, byName: req.accessUser.name || "", at: new Date(), reason: why };
  await lead.save();
  await audit(req, approve ? "Sales Lead Approved" : "Sales Lead Rejected", lead, { reason: why });
  if (approve) {
    await SalesActivity.create({ lead: lead._id, actor: req.accessUser._id, actorName: req.accessUser.name || "", actorRole: "owner", kind: "intake_approved", body: why, source: "system" });
    const to = assignTo || lead.sourcedBy;
    if (to) await assignLead(req, lead._id, { employeeId: to, reason: why || "Approved from intake" });
  }
  return lead.toObject();
}

/* ------------------------------------------------------------- assignment */

async function currentAssignment(leadId) {
  return LeadAssignment.findOne({ lead: leadId, endedAt: null }).lean();
}

/**
 * Assign or reassign. On a reassignment the manager MUST choose who keeps
 * sales credit (the previous credit holder or the new assignee); the choice is
 * recorded on the new assignment row and in the activity log.
 */
async function assignLead(req, leadId, { employeeId, reason, creditDecision, moveTasks = true }) {
  const lead = await SalesLead.findById(leadId).lean();
  if (!lead || lead.status !== "active") throw new SalesError("NOT_FOUND", "Active lead not found.", 404);
  const employee = mongoose.isValidObjectId(employeeId) ? await User.findById(employeeId).lean() : null;
  if (!isTelemarketer(employee) || employee.isActive === false) throw new SalesError("NOT_TELEMARKETER", "Choose an active telemarketer.");
  const actor = req.accessUser;
  const why = clean(reason);
  const result = await inTransaction(async (session) => {
    const open = await LeadAssignment.findOne({ lead: lead._id, endedAt: null }).session(session);
    if (open && String(open.employee) === String(employee._id)) throw new SalesError("ALREADY_ASSIGNED", "This lead is already assigned to that employee.", 409);
    let creditEmployee = employee._id;
    let decision = "first_assignment";
    if (open) {
      if (!["new_assignee", "keep_previous"].includes(creditDecision)) {
        const holder = await User.findById(open.creditEmployee).select("name").lean();
        throw new SalesError("CREDIT_DECISION_REQUIRED", "Choose who keeps sales credit for this lead.", 409, { currentCreditHolder: { id: String(open.creditEmployee), name: holder?.name || "" } });
      }
      if (!why) throw new SalesError("REASON_REQUIRED", "Give a reason for the reassignment.");
      decision = creditDecision;
      creditEmployee = creditDecision === "keep_previous" ? open.creditEmployee : employee._id;
      await LeadAssignment.updateOne({ _id: open._id, endedAt: null }, { $set: { endedAt: new Date(), endedBy: actor._id, endReason: why } }, { session });
    }
    const [row] = await LeadAssignment.create(
      [{ lead: lead._id, employee: employee._id, creditEmployee, creditDecision: decision, startedAt: new Date(), startedBy: actor._id, startedByName: actor.name || "", reason: why }],
      { session }
    );
    if (open && moveTasks) {
      await SalesTask.updateMany({ lead: lead._id, assignee: open.employee, status: "open" }, { $set: { assignee: employee._id } }, { session });
    }
    return { row: row.toObject(), previous: open ? open.toObject() : null };
  });
  const credit = await User.findById(result.row.creditEmployee).select("name").lean();
  const text = result.previous
    ? `Reassigned to ${employee.name}. Sales credit: ${result.row.creditDecision === "keep_previous" ? `stays with ${credit?.name}` : `moves to ${employee.name}`}. ${why}`
    : `Assigned to ${employee.name}. ${why}`;
  await SalesActivity.create({ lead: lead._id, actor: actor._id, actorName: actor.name || "", actorRole: "owner", kind: result.previous ? "reassigned" : "assigned", body: text.trim(), source: "system" });
  await audit(req, result.previous ? "Sales Lead Reassigned" : "Sales Lead Assigned", lead, {
    to: employee.name,
    from: result.previous ? String(result.previous.employee) : null,
    creditDecision: result.row.creditDecision,
    creditEmployee: credit?.name || "",
    reason: why,
  });
  return result.row;
}

async function unassignLead(req, leadId, reason) {
  const why = clean(reason);
  if (!why) throw new SalesError("REASON_REQUIRED", "Give a reason.");
  const open = await LeadAssignment.findOne({ lead: leadId, endedAt: null });
  if (!open) throw new SalesError("NOT_ASSIGNED", "This lead is not assigned.", 409);
  await LeadAssignment.updateOne({ _id: open._id, endedAt: null }, { $set: { endedAt: new Date(), endedBy: req.accessUser._id, endReason: why } });
  const lead = await SalesLead.findById(leadId).lean();
  await SalesActivity.create({ lead: leadId, actor: req.accessUser._id, actorName: req.accessUser.name || "", actorRole: "owner", kind: "reassigned", body: `Unassigned. ${why}`, source: "system" });
  await audit(req, "Sales Lead Unassigned", lead, { reason: why });
  return true;
}

/** Owner only: link a lead to the customer account it is. This is the verified link sales credit needs. */
async function linkLead(req, leadId, { userId, reason }) {
  const lead = await SalesLead.findById(leadId);
  if (!lead || !["active", "intake"].includes(lead.status)) throw new SalesError("NOT_FOUND", "Lead not found.", 404);
  const user = mongoose.isValidObjectId(userId) ? await User.findById(userId).lean() : null;
  if (!isCustomerAccount(user)) throw new SalesError("NOT_FOUND", "Customer not found.", 404);
  const why = clean(reason);
  if (!why) throw new SalesError("REASON_REQUIRED", "Say how you confirmed this is the same person.");
  lead.linkedUser = user._id;
  lead.link = { method: "owner", by: req.accessUser._id, at: new Date(), reason: why };
  try {
    await lead.save();
  } catch (error) {
    if (error?.code === 11000) throw new SalesError("ACCOUNT_TAKEN", "Another lead is already linked to that account.", 409);
    throw error;
  }
  await SalesActivity.create({ lead: lead._id, actor: req.accessUser._id, actorName: req.accessUser.name || "", actorRole: "owner", kind: "linked", body: `Linked to the customer account. ${why}`, source: "system" });
  await audit(req, "Sales Lead Linked", lead, { userId: String(user._id), reason: why });
  await reviewSalesAfterLink(lead.toObject());
  return lead.toObject();
}

/** Candidate accounts for the owner (never automatic): same phone, verified phones first. */
async function suggestAccounts(lead) {
  const digits = String(lead.phone || "").replace(/\D/g, "").slice(-10);
  const spellings = [lead.phone, digits, `1${digits}`, `+1${digits}`];
  const users = await User.find({ phone: { $in: spellings }, role: { $nin: ["employee", "admin"] }, employeePosition: { $in: [null, ""] } })
    .select("name userId phoneVerifiedAt createdAt addresses")
    .limit(10)
    .lean();
  return users.map((u) => ({ id: String(u._id), name: u.name || "", userId: u.userId, phoneVerified: Boolean(u.phoneVerifiedAt), town: u.addresses?.[0]?.city || "", since: u.createdAt }));
}

/* ------------------------------------------------------- activity and tasks */

async function logActivity(req, lead, { kind, body, channel, corrects }, role) {
  if (!EMPLOYEE_ACTIVITY.includes(kind) && !(role === "owner" && kind === "coaching")) throw new SalesError("BAD_KIND", "Choose an outcome.");
  const me = req.accessUser;
  const text = clean(body, 2000);
  if ((kind === "note" || kind === "coaching" || kind === "correction") && !text) throw new SalesError("NOTE_REQUIRED", "Write the note.");
  const doc = await SalesActivity.create({
    lead: lead._id,
    actor: me._id,
    actorName: me.name || "",
    actorRole: role,
    kind,
    body: text,
    visibility: kind === "coaching" ? "owner" : "team",
    source: "manual",
    corrects: kind === "correction" && mongoose.isValidObjectId(corrects) ? corrects : null,
  });
  const set = { lastActivityAt: new Date() };
  if (STAGE_AFTER[kind] && !(lead.stage === "interested" && STAGE_AFTER[kind] === "contacted")) set.stage = STAGE_AFTER[kind];
  await SalesLead.updateOne({ _id: lead._id }, { $set: set });
  if (kind === "do_not_contact") {
    await addSuppression({ phone: lead.phone, channel: ["call", "sms", "all"].includes(channel) ? channel : "all", source: role === "owner" ? "owner" : "telemarketer", reason: text || "Asked not to be contacted", actor: me, lead });
    await SalesTask.updateMany({ lead: lead._id, status: "open" }, { $set: { status: "canceled" } });
    await audit(req, "Sales Do-Not-Contact Recorded", lead, { channel: channel || "all" });
  }
  return doc.toObject();
}

async function createTask(req, lead, { dueAt, kind, note }, assignee) {
  const due = new Date(dueAt);
  if (Number.isNaN(due.getTime())) throw new SalesError("BAD_DATE", "Choose when to follow up.");
  return (await SalesTask.create({ lead: lead._id, assignee, createdBy: req.accessUser._id, kind: ["call", "text", "check_booking", "other"].includes(kind) ? kind : "call", note: clean(note), dueAt: due })).toObject();
}

async function updateTask(task, { status, dueAt, note }) {
  if (status !== undefined) {
    if (!["open", "done", "canceled"].includes(status)) throw new SalesError("BAD_STATUS", "Unknown task status.");
    task.status = status;
    task.doneAt = status === "done" ? new Date() : null;
  }
  if (dueAt !== undefined) {
    const d = new Date(dueAt);
    if (Number.isNaN(d.getTime())) throw new SalesError("BAD_DATE", "Choose a valid date.");
    task.dueAt = d;
  }
  if (note !== undefined) task.note = clean(note);
  await task.save();
  return task.toObject();
}

/* --------------------------------------------------------------- journey */

const FREE_VISIT = (b) => b.accessType === "free_first_visit" || b.freeVisitChannel || /free/i.test(String(b.subscription || ""));

function visitStatus(b, now = Date.now()) {
  const s = String(b.status || "");
  if (/cancel/i.test(s)) return { status: "canceled", label: "Canceled", verified: true };
  if (/complete/i.test(s)) return { status: "completed", label: "Completed", verified: true };
  if (/no.?show/i.test(s)) return { status: "no_show", label: "No-show", verified: true };
  if (/pending/i.test(s)) return { status: "requested", label: "Requested, waiting for confirmation", verified: true };
  if (/confirm/i.test(s)) {
    // The date passed and nobody recorded what happened. Profixter does not record no-shows, so the outcome is Unknown: never guessed.
    if (b.date && new Date(b.date).getTime() < now - 6 * 3600 * 1000) return { status: "unknown", label: "Unknown", detail: "The visit date has passed and no outcome was recorded.", verified: false };
    return { status: "scheduled", label: "Scheduled", verified: true };
  }
  return { status: "other", label: s || "Unknown", verified: true };
}

function membershipState(sub) {
  if (!sub) return null;
  const live = ["active", "trialing", "past_due", "unpaid"].includes(sub.status);
  let state = live ? (sub.cancelAtPeriodEnd ? "ending" : sub.status === "past_due" || sub.status === "unpaid" ? "payment_problem" : "active") : "ended";
  if (sub.paymentMethod === "complimentary" && live) state = "complimentary";
  return { plan: sub.subscriptionType, cycle: sub.billingCycle || "monthly", state, startDate: sub.startDate || sub.createdAt, endsOn: sub.cancelAtPeriodEnd ? sub.currentPeriodEnd : null, endedOn: live ? null : sub.cancellationDate || sub.currentPeriodEnd || null };
}

/**
 * What a telemarketer may see about their linked customer: meaningful,
 * verified milestones only (no browsing history, no billing details).
 */
async function journeyFor(userId) {
  if (!userId) return null;
  const user = await User.findById(userId).select("createdAt phoneVerifiedAt signupMethod").lean();
  if (!user) return null;
  const visits = await Booking.find({ user: userId }).select("date status accessType freeVisitChannel subscription bookingType createdAt completedAt").sort({ date: -1 }).limit(20).lean();
  const subs = await Subscription.find({ user: userId }).sort({ createdAt: -1 }).limit(10).lean();
  const sales = await SalesEvent.find({ user: userId }).sort({ paidAt: -1 }).limit(30).lean();
  return {
    registeredAt: user.createdAt,
    phoneVerifiedAt: user.phoneVerifiedAt || null,
    freeVisits: visits.filter(FREE_VISIT).map((b) => ({ id: String(b._id), date: b.date, requestedAt: b.createdAt, ...visitStatus(b) })),
    otherVisits: visits.filter((b) => !FREE_VISIT(b)).length,
    memberships: subs.map(membershipState).filter(Boolean),
    purchases: sales.map((s) => ({ id: String(s._id), kind: s.kind, label: saleKindLabel(s), plan: s.plan, cycle: s.cycle, paidAt: s.paidAt, amountCents: s.amounts?.amountCents || 0 })),
  };
}

function saleKindLabel(s) {
  if (s.kind === "refund") return "Refund";
  if (s.kind === "dispute_opened") return "Chargeback opened";
  if (s.kind === "dispute_closed") return `Chargeback closed (${s.disputeStatus || "unknown"})`;
  return saleLabel(s);
}

/** The lead's timeline, newest first. `forOwner` adds coaching notes. */
async function timelineFor(lead, { forOwner = false } = {}) {
  const items = [];
  const acts = await SalesActivity.find({ lead: lead._id, ...(forOwner ? {} : { visibility: "team" }) }).sort({ at: -1 }).limit(200).lean();
  for (const a of acts) {
    items.push({ at: a.at, kind: a.kind, text: a.body, by: a.actorName, origin: a.source === "ghl" ? "ghl" : a.source === "system" ? "system" : "employee", visibility: a.visibility, id: String(a._id), corrects: a.corrects ? String(a.corrects) : null, ghl: a.source === "ghl" ? a.ghl : undefined });
  }
  const j = lead.linkedUser ? await journeyFor(lead.linkedUser) : null;
  if (j) {
    items.push({ at: j.registeredAt, kind: "registered", text: "Created a Profixter account", origin: "system" });
    if (j.phoneVerifiedAt) items.push({ at: j.phoneVerifiedAt, kind: "phone_verified", text: "Verified their phone", origin: "system" });
    for (const v of j.freeVisits) {
      items.push({ at: v.requestedAt, kind: "free_visit_requested", text: "Requested a free visit", origin: "system" });
      if (v.status !== "requested") items.push({ at: v.date || v.requestedAt, kind: `free_visit_${v.status}`, text: v.status === "unknown" ? "Free visit outcome: Unknown (no outcome recorded)" : `Free visit: ${v.label}`, origin: v.verified ? "system" : "unknown" });
    }
    for (const p of j.purchases) items.push({ at: p.paidAt, kind: p.kind, text: p.label, origin: "system" });
  }
  return items.filter((i) => i.at).sort((a, b) => new Date(b.at) - new Date(a.at));
}

/* -------------------------------------------------------------- GHL links */

function ghlLinks(lead) {
  const loc = process.env.GHL_LOCATION_ID;
  if (!loc) return { contact: null, conversation: null, note: "Set the GHL location to enable links." };
  return {
    contact: lead.ghlContactId ? `https://app.gohighlevel.com/v2/location/${encodeURIComponent(loc)}/contacts/detail/${encodeURIComponent(lead.ghlContactId)}` : null,
    conversation: lead.ghlConversationId ? `https://app.gohighlevel.com/v2/location/${encodeURIComponent(loc)}/conversations/conversations/${encodeURIComponent(lead.ghlConversationId)}` : null,
  };
}

/** Accept a pasted GHL contact link or a bare id. */
function readGhlContactId(value) {
  const v = clean(value, 300);
  if (!v) return null;
  const m = v.match(/contacts\/detail\/([A-Za-z0-9]{8,40})/);
  const id = m ? m[1] : v;
  if (!/^[A-Za-z0-9]{8,40}$/.test(id)) throw new SalesError("BAD_GHL_ID", "Paste the GHL contact link or its contact id.");
  return id;
}

async function setGhlContact(req, lead, value) {
  const id = readGhlContactId(value);
  try {
    await SalesLead.updateOne({ _id: lead._id }, { $set: { ghlContactId: id } });
  } catch (error) {
    if (error?.code === 11000) throw new SalesError("GHL_TAKEN", "That GHL contact is already mapped to another lead.", 409);
    throw error;
  }
  await audit(req, "Sales Lead GHL Contact Set", lead, { ghlContactId: id });
  return id;
}

/* ---------------------------------------------------------- referral code */

async function referralCodeFor(employee) {
  const existing = await SalesReferralCode.findOne({ employee: employee._id, active: true }).lean();
  if (existing) return existing;
  for (let i = 0; i < 5; i += 1) {
    const code = `${String(employee.firstName || employee.name || "PF").replace(/[^A-Za-z]/g, "").slice(0, 4).toUpperCase() || "PF"}${Math.floor(1000 + Math.random() * 9000)}`;
    try {
      return (await SalesReferralCode.create({ employee: employee._id, code })).toObject();
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }
  }
  throw new Error("could not create a referral code");
}

function referralUrl(code) {
  const base = String(process.env.CLIENT_URL || "https://www.profixter.com").replace(/\/+$/, "");
  return `${base}/?source=referral&ref=${encodeURIComponent(code)}`;
}

/** At signup: an account created through an employee's referral link (evidence, written once). */
async function recordReferralSignup(user) {
  try {
    const a = user?.attribution || {};
    const code = String(a.refCode || "").trim();
    if (!code || String(a.refSource || "").toLowerCase() !== "referral") return null;
    const rc = await SalesReferralCode.findOne({ code, active: true }).lean();
    if (!rc) return null;
    const { SalesReferral } = require("../../models/Sales");
    return (await SalesReferral.create({ user: user._id, employee: rc.employee, code, at: new Date() })).toObject();
  } catch (error) {
    if (error?.code !== 11000) console.error("sales referral record failed:", error.message);
    return null;
  }
}

module.exports = {
  EMPLOYEE_ACTIVITY,
  isTelemarketer,
  isCustomerAccount,
  suppressionState,
  addSuppression,
  liftSuppression,
  createLead,
  submitIntake,
  decideIntake,
  currentAssignment,
  assignLead,
  unassignLead,
  linkLead,
  suggestAccounts,
  logActivity,
  createTask,
  updateTask,
  journeyFor,
  timelineFor,
  visitStatus,
  ghlLinks,
  readGhlContactId,
  setGhlContact,
  referralCodeFor,
  referralUrl,
  recordReferralSignup,
  audit,
};
