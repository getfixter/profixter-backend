/**
 * The Telemarketer workspace API: /api/sales/*.
 *
 * Only an active employee whose position is "Telemarketer" may call it (the
 * owner uses /api/admin/sales-desk). Every lead route re-checks, on every
 * request, that the caller holds the lead's OPEN assignment: a reassigned lead,
 * an old link or a guessed id answers 404. Responses carry only what the
 * workspace needs: no cards, billing, addresses beyond the town, email, or
 * full phone numbers (the full number is revealed on request, and logged).
 * Nothing here can charge, refund, change a membership, export customer
 * lists, or see another employee's records or earnings.
 */
const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const auth = require("../middleware/auth");
const { loadAccessUser, PERMISSIONS } = require("../middleware/authorize");
const { SalesLead, LeadAssignment, SalesTask, SalesCreditRequest } = require("../models/Sales");
const { SalesError } = require("../utils/sales/ledger");
const leads = require("../utils/sales/leads");
const views = require("../utils/sales/views");
const credit = require("../utils/sales/credit");
const evidence = require("../utils/sales/evidence");
const { bonusProgress } = require("../utils/sales/bonus");
const { weekFromStart } = require("../utils/sales/time");
const { csvCell, money } = require("../utils/sales/ledger");
const { replayUnmapped } = require("../utils/sales/ghl");

const router = express.Router();

function telemarketerOnly(req, res, next) {
  const u = req.accessUser;
  if (req.accessRole === "employee" && u?.employeePosition === "Telemarketer" && u.isActive !== false && (req.permissions || []).includes(PERMISSIONS.SALES_OWN)) return next();
  return res.status(403).json({ code: "TELEMARKETERS_ONLY", message: "This workspace is for telemarketers." });
}
router.use(auth, loadAccessUser, telemarketerOnly);

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    if (error instanceof SalesError) return res.status(error.statusCode).json({ code: error.code, message: error.message, ...error.extra });
    console.error(`sales ${req.method} ${req.path} failed:`, error);
    return res.status(500).json({ code: "SERVER_ERROR", message: "Something went wrong." });
  }
};

/** The lead, only if the caller holds its open assignment. Anything else is "not found". */
async function myLead(req) {
  if (!mongoose.isValidObjectId(req.params.id)) throw new SalesError("NOT_FOUND", "Lead not found.", 404);
  const assignment = await LeadAssignment.findOne({ lead: req.params.id, employee: req.accessUser._id, endedAt: null }).lean();
  const lead = assignment && (await SalesLead.findOne({ _id: req.params.id, status: "active" }).lean());
  if (!lead) throw new SalesError("NOT_FOUND", "Lead not found.", 404);
  return { lead, assignment };
}

router.get(
  "/me",
  wrap(async (req, res) => {
    const me = req.accessUser;
    const code = await leads.referralCodeFor(me);
    res.json({ me: { id: String(me._id), name: me.name, firstName: me.firstName || "" }, referral: { code: code.code, url: leads.referralUrl(code.code) }, day: await views.myDay(me._id), goals: await views.goalsFor(me._id) });
  })
);

router.get(
  "/leads",
  wrap(async (req, res) => {
    res.json({ leads: await views.employeeLeads(req.accessUser._id, { stage: req.query.stage ? String(req.query.stage) : undefined, q: req.query.q ? String(req.query.q) : undefined }) });
  })
);

router.get(
  "/leads/:id",
  wrap(async (req, res) => {
    const { lead, assignment } = await myLead(req);
    res.json({ lead: await views.employeeLeadDetail(lead, assignment, req.accessUser._id) });
  })
);

/* The full number, on request: logged with who and when. */
router.post(
  "/leads/:id/phone",
  wrap(async (req, res) => {
    const { lead } = await myLead(req);
    await leads.audit(req, "Sales Phone Revealed", lead, { phoneLast4: String(lead.phone).slice(-4) });
    res.json({ phone: lead.phone });
  })
);

router.post(
  "/leads/:id/activities",
  wrap(async (req, res) => {
    const { lead } = await myLead(req);
    const kind = String(req.body?.kind || "");
    if (kind === "coaching") throw new SalesError("BAD_KIND", "Choose an outcome.");
    const activity = await leads.logActivity(req, lead, { kind, body: req.body?.body, channel: req.body?.channel, corrects: req.body?.corrects }, "telemarketer");
    if (req.body?.followUpAt) await leads.createTask(req, lead, { dueAt: req.body.followUpAt, kind: req.body.followUpKind, note: req.body.followUpNote }, req.accessUser._id);
    res.status(201).json({ activity });
  })
);

router.post(
  "/leads/:id/tasks",
  wrap(async (req, res) => {
    const { lead } = await myLead(req);
    res.status(201).json({ task: await leads.createTask(req, lead, req.body || {}, req.accessUser._id) });
  })
);

router.get(
  "/tasks",
  wrap(async (req, res) => {
    const rows = await LeadAssignment.find({ employee: req.accessUser._id, endedAt: null }).select("lead").lean();
    const tasks = await SalesTask.find({ assignee: req.accessUser._id, status: "open", lead: { $in: rows.map((r) => r.lead) } }).sort({ dueAt: 1 }).limit(300).lean();
    const names = new Map((await SalesLead.find({ _id: { $in: tasks.map((t) => t.lead) } }).select("name town").lean()).map((l) => [String(l._id), l]));
    res.json({ tasks: tasks.map((t) => ({ id: String(t._id), leadId: String(t.lead), name: names.get(String(t.lead))?.name || "", town: names.get(String(t.lead))?.town || "", dueAt: t.dueAt, kind: t.kind, note: t.note, overdue: t.dueAt < new Date() })) });
  })
);

router.patch(
  "/tasks/:taskId",
  wrap(async (req, res) => {
    const task = mongoose.isValidObjectId(req.params.taskId) && (await SalesTask.findOne({ _id: req.params.taskId, assignee: req.accessUser._id }));
    const open = task && (await LeadAssignment.exists({ lead: task.lead, employee: req.accessUser._id, endedAt: null }));
    if (!task || !open) throw new SalesError("NOT_FOUND", "Task not found.", 404);
    res.json({ task: await leads.updateTask(task, req.body || {}) });
  })
);

/* Map the lead to its GHL contact (paste the GHL contact link). */
router.put(
  "/leads/:id/ghl",
  wrap(async (req, res) => {
    const { lead } = await myLead(req);
    const id = await leads.setGhlContact(req, lead, req.body?.contact);
    if (id) await replayUnmapped(id);
    res.json({ ghlContactId: id, links: leads.ghlLinks({ ...lead, ghlContactId: id }) });
  })
);

/* ---------------------------------------------------------------- intake */

router.post(
  "/intake",
  wrap(async (req, res) => {
    const lead = await leads.submitIntake(req, req.body || {});
    res.status(201).json({ lead: { id: String(lead._id), name: lead.name, town: lead.town, status: lead.status } });
  })
);

router.get(
  "/intake",
  wrap(async (req, res) => {
    const list = await SalesLead.find({ createdBy: req.accessUser._id, source: "employee_intake" }).sort({ createdAt: -1 }).limit(200).lean();
    res.json({ intake: list.map((l) => ({ id: String(l._id), name: l.name, town: l.town, phoneLast4: String(l.phone).slice(-4), status: l.status, submittedAt: l.createdAt, decision: l.intakeDecision?.at ? { at: l.intakeDecision.at, reason: l.intakeDecision.reason } : null })) });
  })
);

/* ------------------------------------------------------------ earnings */

router.get("/sales", wrap(async (req, res) => res.json({ sales: await views.employeeSales(req.accessUser._id) })));
router.get("/earnings", wrap(async (req, res) => res.json({ earnings: await views.earningsSummary(req.accessUser._id) })));
router.get("/bonus", wrap(async (req, res) => res.json({ bonus: await bonusProgress(req.accessUser._id) })));
router.get("/statements", wrap(async (req, res) => res.json({ statements: await views.employeeStatements(req.accessUser._id) })));

function readWeek(req) {
  try {
    return weekFromStart(String(req.params.week)).week;
  } catch {
    throw new SalesError("BAD_WEEK", "Unknown week.", 404);
  }
}

router.get(
  "/statements/:week",
  wrap(async (req, res) => {
    res.json({ statement: await views.employeeStatement(req.accessUser._id, readWeek(req)) });
  })
);

/* The employee's own statement as CSV: their lines only, customers as initials and town. */
router.get(
  "/statements/:week/csv",
  wrap(async (req, res) => {
    const s = await views.employeeStatement(req.accessUser._id, readWeek(req));
    const rows = [["week_start", "week_end", "payday", "date_paid_by_customer", "type", "customer", "regular", "discount", "paid_excl_tax", "amount", "explanation", "late"]];
    for (const i of s.items) rows.push([s.week, s.lastDay, s.payday, i.paidAt ? new Date(i.paidAt).toISOString().slice(0, 10) : "", i.kind, i.customer, money(i.calc.regularCents), money(i.calc.discountCents), money(i.calc.paidPreTaxCents), money(i.amountCents), i.calc.explain || i.reason, i.late ? "yes" : ""]);
    rows.push(["", "", "", "", "total", "", "", "", "", money(s.totals.totalCents), s.frozen ? "approved" : "not yet approved", ""]);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="statement-${s.week}.csv"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n");
  })
);

/* ------------------------------------------------------- credit requests */

const evidenceUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: evidence.MAX_BYTES, files: 1 } }).single("file");

function requestDto(r, { forOwner = false } = {}) {
  return {
    id: String(r._id),
    leadId: r.lead ? String(r.lead) : null,
    saleId: String(r.sale),
    kind: r.kind,
    explanation: r.explanation,
    status: r.status,
    proposed: r.proposed,
    evidence: (r.evidence || []).map((e) => ({ id: String(e._id), kind: e.kind, text: e.text, fileName: e.fileName, size: e.size, addedAt: e.addedAt })),
    decisions: (r.decisions || []).map((d) => ({ action: d.action, by: forOwner || d.action === "submitted" || d.action === "employee_reply" ? d.byName : "Owner", reason: d.reason, amountCents: d.amountCents, countsForBonus: d.countsForBonus, ...(forOwner ? { selfReferralCleared: d.selfReferralCleared ?? null } : {}), at: d.at })),
    /* The self-referral signals are for the owner's review only. */
    ...(forOwner ? { selfReferral: (r.checks?.selfReferral || []).map((x) => ({ code: x.code, strength: x.strength, text: x.text })) } : {}),
    createdAt: r.createdAt,
  };
}

router.get(
  "/credit-requests",
  wrap(async (req, res) => {
    const list = await SalesCreditRequest.find({ employee: req.accessUser._id }).sort({ createdAt: -1 }).limit(200).lean();
    res.json({ requests: list.map((r) => requestDto(r)) });
  })
);

router.post(
  "/credit-requests",
  wrap(async (req, res) => {
    const b = req.body || {};
    const refs = (Array.isArray(b.ghlReferences) ? b.ghlReferences : []).slice(0, 10).map((t) => ({ kind: "ghl_reference", text: String(t).slice(0, 1000), addedBy: req.accessUser._id }));
    const notes = b.note ? [{ kind: "note", text: String(b.note).slice(0, 1000), addedBy: req.accessUser._id }] : [];
    const r = await credit.createRequest(req.accessUser, { leadId: b.leadId, saleId: b.saleId, kind: b.kind, explanation: b.explanation, evidence: [...refs, ...notes] });
    await leads.audit(req, "Sales Credit Requested", { _id: r.lead, name: "" }, { requestId: String(r._id), saleId: String(r.sale), kind: r.kind, proposedCents: r.proposed.amountCents });
    res.status(201).json({ request: requestDto(r) });
  })
);

async function myRequest(req) {
  const r = mongoose.isValidObjectId(req.params.rid) && (await SalesCreditRequest.findOne({ _id: req.params.rid, employee: req.accessUser._id }));
  if (!r) throw new SalesError("NOT_FOUND", "Request not found.", 404);
  return r;
}

router.get(
  "/credit-requests/:rid",
  wrap(async (req, res) => {
    res.json({ request: requestDto((await myRequest(req)).toObject()) });
  })
);

/* Add evidence: a GHL reference, a note, or ONE file (PDF, PNG or JPEG, checked by its bytes). */
router.post(
  "/credit-requests/:rid/evidence",
  (req, res, next) => evidenceUpload(req, res, (err) => (err ? res.status(400).json({ code: "UPLOAD_FAILED", message: err.code === "LIMIT_FILE_SIZE" ? "Files can be up to 5 MB." : "Upload failed." }) : next())),
  wrap(async (req, res) => {
    const r = await myRequest(req);
    if (!["pending", "needs_info"].includes(r.status)) throw new SalesError("CLOSED", "This request is already decided.", 409);
    if (r.evidence.length >= 20) throw new SalesError("TOO_MANY", "A request can hold up to 20 pieces of evidence.", 409);
    let item;
    if (req.file) {
      const stored = await evidence.storeFile({ requestId: String(r._id), file: req.file });
      item = { kind: "file", text: String(req.body?.text || "").slice(0, 1000), ...stored, addedBy: req.accessUser._id };
    } else {
      const kind = req.body?.kind === "note" ? "note" : "ghl_reference";
      const text = String(req.body?.text || "").trim();
      if (!text) throw new SalesError("EMPTY", "Add a GHL reference, a note or a file.");
      item = { kind, text: text.slice(0, 1000), addedBy: req.accessUser._id };
    }
    r.evidence.push(item);
    await r.save();
    res.status(201).json({ request: requestDto(r.toObject()) });
  })
);

router.post(
  "/credit-requests/:rid/reply",
  wrap(async (req, res) => {
    const r = await myRequest(req);
    if (r.status !== "needs_info") throw new SalesError("NOT_WAITING", "The owner has not asked for more information.", 409);
    const text = String(req.body?.reason || req.body?.text || "").trim();
    if (!text) throw new SalesError("EMPTY", "Write your answer.");
    r.status = "pending";
    r.decisions.push({ action: "employee_reply", by: req.accessUser._id, byName: req.accessUser.name || "", reason: text.slice(0, 1000) });
    await r.save();
    res.json({ request: requestDto(r.toObject()) });
  })
);

router.post(
  "/credit-requests/:rid/withdraw",
  wrap(async (req, res) => {
    const r = await myRequest(req);
    if (!["pending", "needs_info"].includes(r.status)) throw new SalesError("CLOSED", "This request is already decided.", 409);
    r.status = "withdrawn";
    r.decisions.push({ action: "withdrawn", by: req.accessUser._id, byName: req.accessUser.name || "", reason: String(req.body?.reason || "").slice(0, 500) });
    await r.save();
    res.json({ request: requestDto(r.toObject()) });
  })
);

router.get(
  "/credit-requests/:rid/files/:fileId",
  wrap(async (req, res) => {
    const r = await myRequest(req);
    await evidence.sendFile(res, r, req.params.fileId);
  })
);

module.exports = router;
module.exports.requestDto = requestDto;
