/**
 * Renovation project workflow for the redesigned Admin.
 *
 * Mounted at /api/admin/projects, BEFORE routes/projects.js, so these new
 * paths are matched first; every path here is new and none shadows an
 * existing one. All of it needs the Projects section (projects.manage).
 *
 *   POST /search                       list with search (body), stage filter, pagination, financial columns
 *   GET  /:id/overview                 project + financials + derived stage + next steps + documents
 *   PUT  /:id/status                   manual status, with history (expectedStatus precondition)
 *   POST /:id/bookings                 link a visit (optionally as the site visit)
 *   DELETE /:id/bookings/:bookingId    unlink it
 *   PUT  /:id/schedule                 start/end and crew (expectedUpdatedAt precondition)
 *   POST /:id/substantial-completion   explicit closeout; derives the warranty end from the agreement terms
 *   POST/PATCH/DELETE /:id/punch-list  punch list items
 *   POST /:id/invoices/from-schedule   deposit / milestone invoice from the signed agreement's terms
 */

const express = require("express");
const mongoose = require("mongoose");
const auth = require("../middleware/auth");
const { PERMISSIONS, requirePermission } = require("../middleware/authorize");
const Project = require("../models/Project");
const Contract = require("../models/Contract");
const Booking = require("../models/Booking");
const User = require("../models/User");
const Invoice = require("../models/Invoice");
const { getProjectFinancialSummary } = require("../utils/projectFinancialsService");
const {
  buildDerivedStage,
  depositBilled,
  depositScheduleIndex,
  milestoneBilled,
  loadProjectOverview,
  NEXT_STEP_PROJECT_SELECT,
  STAGES,
  topNextStepsForProjects,
} = require("../utils/projects/projectWorkflow");
const { WORKMANSHIP_WARRANTY, warrantyEndsAt } = require("../config/legalEntity");
const { logProjectActivity } = require("../utils/projectActivity");

const router = express.Router();
router.use(auth, ...requirePermission(PERMISSIONS.PROJECTS_MANAGE));

const MAX_LIMIT = 50;
const STAGE_SCAN_LIMIT = 500;
/** A billing claim with no invoice after this long is a crashed attempt and may be retried. */
const STALE_CLAIM_MS = 2 * 60 * 1000;

function fail(res, status, message, code, extra = {}) {
  return res.status(status).json({ message, code, ...extra });
}

function actorName(req) {
  const actor = req.accessUser || req.authUser || {};
  return String(actor.name || actor.email || "Admin").slice(0, 160);
}

function actorId(req) {
  return req.user?.id && mongoose.isValidObjectId(req.user.id) ? req.user.id : null;
}

async function loadActiveProject(req, res, select = "") {
  if (!mongoose.isValidObjectId(req.params.id)) {
    fail(res, 400, "Invalid project ID", "INVALID_ID");
    return null;
  }
  const project = await Project.findById(req.params.id).select(select);
  if (!project) {
    fail(res, 404, "Project not found", "NOT_FOUND");
    return null;
  }
  if (project.isDeleted) {
    fail(res, 410, "This project has been deleted. Restore it first.", "PROJECT_DELETED");
    return null;
  }
  return project;
}

/** expectedUpdatedAt precondition: the caller must have seen the current version. */
function staleUpdatedAt(project, expected) {
  if (!expected) return false;
  const want = new Date(expected).getTime();
  return !Number.isFinite(want) || want !== new Date(project.updatedAt).getTime();
}

function parseDate(value) {
  if (value === null || value === "") return { value: null };
  if (value === undefined) return { skip: true };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { error: true };
  return { value: date };
}

/* ------------------------------------------------------------------ */
/* List                                                                */
/* ------------------------------------------------------------------ */

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function searchFilter(search) {
  const value = String(search || "").trim().slice(0, 120);
  if (!value) return {};
  const pattern = new RegExp(escapeRegex(value), "i");
  const or = [
    { customerName: pattern },
    { address: pattern },
    { email: pattern },
    { projectNumber: pattern },
    { "propertySnapshot.formattedAddress": pattern },
  ];
  const digits = value.replace(/\D/g, "");
  if (digits.length >= 4) or.push({ phone: new RegExp(digits.split("").join("\\D*")) });
  return { $or: or };
}

async function listRow(project, contractsByProject, now, financialsById) {
  const financials = await getProjectFinancialSummary(project._id);
  financialsById.set(String(project._id), financials);
  const contracts = contractsByProject.get(String(project._id)) || [];
  const derivedStage = buildDerivedStage({ project, contracts, financials, now });
  return {
    id: String(project._id),
    projectNumber: project.projectNumber,
    customerName: project.customerName,
    address: project.address,
    phone: project.phone,
    email: project.email,
    projectType: project.projectType,
    manualStatus: project.status,
    derivedStage,
    scheduledStart: project.scheduledStart || null,
    executedValueCents: financials.valuation.executedValueCents,
    proposedValueCents: financials.valuation.proposedValueCents,
    invoicedCents: financials.valuation.invoicedCents,
    paidCents: financials.valuation.paidCents,
    outstandingCents: financials.valuation.outstandingCents,
    createdAt: project.createdAt,
    href: `/admin/projects/${project._id}`,
  };
}

router.post("/search", async (req, res) => {
  try {
    const body = req.body || {};
    const limit = Math.min(Math.max(Number(body.limit) || 25, 1), MAX_LIMIT);
    const page = Math.max(Number(body.page) || 1, 1);
    const stage = String(body.stage || "");
    if (stage && !STAGES[stage]) return fail(res, 400, "Unknown stage", "INVALID_STAGE");
    const query = { isDeleted: { $ne: true }, ...searchFilter(body.search) };
    if (body.status) query.status = String(body.status).slice(0, 40);

    const select = `projectNumber customerName address phone email projectType status createdAt ${NEXT_STEP_PROJECT_SELECT}`;
    const now = new Date();
    let candidates;
    let total;
    if (stage) {
      // The stage is derived, so it is filtered after deriving it, over a bounded scan.
      candidates = await Project.find(query).select(select).sort({ createdAt: -1 }).limit(STAGE_SCAN_LIMIT).lean();
    } else {
      [candidates, total] = await Promise.all([
        Project.find(query).select(select).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        Project.countDocuments(query),
      ]);
    }

    const contracts = await Contract.find({ projectId: { $in: candidates.map((p) => p._id) } })
      .select("projectId contractNumber version current status depositAmountCents")
      .lean();
    const contractsByProject = new Map();
    for (const contract of contracts) {
      const key = String(contract.projectId);
      if (!contractsByProject.has(key)) contractsByProject.set(key, []);
      contractsByProject.get(key).push(contract);
    }

    const financialsById = new Map();
    let rows = await Promise.all(candidates.map((project) => listRow(project, contractsByProject, now, financialsById)));
    if (stage) {
      rows = rows.filter((row) => row.derivedStage.key === stage);
      total = rows.length;
      rows = rows.slice((page - 1) * limit, page * limit);
    }
    // The overview's top next step, for the returned page only (batched).
    const shown = new Set(rows.map((row) => row.id));
    const nextSteps = await topNextStepsForProjects(
      candidates.filter((project) => shown.has(String(project._id))),
      { financialsById, now }
    );
    rows = rows.map((row) => ({ ...row, nextStep: nextSteps.get(row.id) || null }));
    return res.json({ projects: rows, total, page, limit, stages: STAGES });
  } catch (error) {
    console.error("POST /admin/projects/search failed:", error?.message);
    return fail(res, 500, "Failed to load projects", "SERVER_ERROR");
  }
});

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

router.get("/:id/overview", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return fail(res, 400, "Invalid project ID", "INVALID_ID");
    const overview = await loadProjectOverview(req.params.id);
    if (!overview) return fail(res, 404, "Project not found", "NOT_FOUND");
    return res.json(overview);
  } catch (error) {
    console.error("GET /admin/projects/:id/overview failed:", error?.message);
    return fail(res, 500, "Failed to load the project", "SERVER_ERROR");
  }
});

/* ------------------------------------------------------------------ */
/* Manual status                                                       */
/* ------------------------------------------------------------------ */

router.put("/:id/status", async (req, res) => {
  try {
    const project = await loadActiveProject(req, res);
    if (!project) return null;
    const status = String(req.body?.status || "");
    if (!Project.PROJECT_STATUSES.includes(status)) return fail(res, 400, "Invalid project status", "INVALID_STATUS");
    const expected = req.body?.expectedStatus;
    if (expected !== undefined && expected !== project.status) {
      return fail(res, 409, "The project status changed since you opened it. Reload and try again.", "STALE", {
        currentStatus: project.status,
      });
    }
    if (status === project.status) return res.json({ project: { id: String(project._id), status } });
    const reason = String(req.body?.reason || "").slice(0, 1000);
    const updated = await Project.findOneAndUpdate(
      { _id: project._id, status: project.status },
      {
        $set: { status },
        $push: {
          statusHistory: { from: project.status, to: status, at: new Date(), actorId: actorId(req), actorName: actorName(req), reason, source: "manual" },
        },
      },
      { new: true, runValidators: true }
    );
    if (!updated) return fail(res, 409, "The project status changed at the same moment. Reload and try again.", "STALE");
    await logProjectActivity(req, {
      action: "Project Status Changed",
      entityType: "Project",
      entityId: project._id,
      entityName: project.projectNumber,
      before: { status: project.status },
      after: { status },
      reason,
    });
    return res.json({ project: { id: String(updated._id), status: updated.status, updatedAt: updated.updatedAt } });
  } catch (error) {
    console.error("PUT /admin/projects/:id/status failed:", error?.message);
    return fail(res, 500, "Failed to update the project status", "SERVER_ERROR");
  }
});

/* ------------------------------------------------------------------ */
/* Linked visits                                                       */
/* ------------------------------------------------------------------ */

router.post("/:id/bookings", async (req, res) => {
  try {
    const project = await loadActiveProject(req, res);
    if (!project) return null;
    const bookingId = String(req.body?.bookingId || "");
    if (!mongoose.isValidObjectId(bookingId)) return fail(res, 400, "Invalid booking ID", "INVALID_ID");
    const booking = await Booking.findOneAndUpdate(
      { _id: bookingId, $or: [{ projectId: null }, { projectId: { $exists: false } }, { projectId: project._id }] },
      { $set: { projectId: project._id } },
      { new: true }
    ).select("bookingNumber projectId");
    if (!booking) {
      const exists = await Booking.exists({ _id: bookingId });
      if (!exists) return fail(res, 404, "Booking not found", "NOT_FOUND");
      return fail(res, 409, "This visit is already linked to another project.", "BOOKING_LINKED_ELSEWHERE");
    }
    const set = req.body?.siteVisit === true ? { siteVisitBookingId: booking._id } : {};
    const updated = await Project.findByIdAndUpdate(
      project._id,
      { $addToSet: { linkedBookingIds: booking._id }, ...(Object.keys(set).length ? { $set: set } : {}) },
      { new: true }
    ).select("linkedBookingIds siteVisitBookingId updatedAt");
    await logProjectActivity(req, {
      action: "Project Visit Linked",
      entityType: "Project",
      entityId: project._id,
      entityName: project.projectNumber,
      details: { bookingId: String(booking._id), bookingNumber: booking.bookingNumber, siteVisit: req.body?.siteVisit === true },
    });
    return res.json({
      linkedBookingIds: updated.linkedBookingIds.map(String),
      siteVisitBookingId: updated.siteVisitBookingId ? String(updated.siteVisitBookingId) : null,
      updatedAt: updated.updatedAt,
    });
  } catch (error) {
    console.error("POST /admin/projects/:id/bookings failed:", error?.message);
    return fail(res, 500, "Failed to link the visit", "SERVER_ERROR");
  }
});

router.delete("/:id/bookings/:bookingId", async (req, res) => {
  try {
    const project = await loadActiveProject(req, res);
    if (!project) return null;
    if (!mongoose.isValidObjectId(req.params.bookingId)) return fail(res, 400, "Invalid booking ID", "INVALID_ID");
    await Booking.updateOne({ _id: req.params.bookingId, projectId: project._id }, { $set: { projectId: null } });
    const unset = String(project.siteVisitBookingId || "") === req.params.bookingId ? { siteVisitBookingId: null } : {};
    const updated = await Project.findByIdAndUpdate(
      project._id,
      { $pull: { linkedBookingIds: req.params.bookingId }, ...(Object.keys(unset).length ? { $set: unset } : {}) },
      { new: true }
    ).select("linkedBookingIds siteVisitBookingId updatedAt");
    await logProjectActivity(req, {
      action: "Project Visit Unlinked",
      entityType: "Project",
      entityId: project._id,
      entityName: project.projectNumber,
      details: { bookingId: req.params.bookingId },
    });
    return res.json({
      linkedBookingIds: updated.linkedBookingIds.map(String),
      siteVisitBookingId: updated.siteVisitBookingId ? String(updated.siteVisitBookingId) : null,
      updatedAt: updated.updatedAt,
    });
  } catch (error) {
    console.error("DELETE /admin/projects/:id/bookings/:bookingId failed:", error?.message);
    return fail(res, 500, "Failed to unlink the visit", "SERVER_ERROR");
  }
});

/* ------------------------------------------------------------------ */
/* Schedule and crew                                                   */
/* ------------------------------------------------------------------ */

router.put("/:id/schedule", async (req, res) => {
  try {
    const project = await loadActiveProject(req, res);
    if (!project) return null;
    if (staleUpdatedAt(project, req.body?.expectedUpdatedAt)) {
      return fail(res, 409, "The project changed since you opened it. Reload and try again.", "STALE");
    }
    const set = {};
    for (const field of ["scheduledStart", "scheduledEnd"]) {
      const parsed = parseDate(req.body?.[field]);
      if (parsed.error) return fail(res, 400, `${field} is not a valid date`, "INVALID_DATE");
      if (!parsed.skip) set[field] = parsed.value;
    }
    const start = "scheduledStart" in set ? set.scheduledStart : project.scheduledStart;
    const end = "scheduledEnd" in set ? set.scheduledEnd : project.scheduledEnd;
    if (start && end && new Date(end) < new Date(start)) {
      return fail(res, 400, "The end date is before the start date.", "INVALID_DATE");
    }
    if (req.body?.assignedFixterIds !== undefined) {
      const ids = [...new Set((Array.isArray(req.body.assignedFixterIds) ? req.body.assignedFixterIds : []).map(String))];
      if (ids.some((id) => !mongoose.isValidObjectId(id))) return fail(res, 400, "Invalid technician ID", "INVALID_ID");
      const staff = await User.countDocuments({ _id: { $in: ids }, role: { $in: ["employee", "admin"] } });
      if (staff !== ids.length) return fail(res, 400, "Only staff accounts can be assigned to a project.", "INVALID_ASSIGNEE");
      set.assignedFixterIds = ids;
    }
    const before = {
      scheduledStart: project.scheduledStart || null,
      scheduledEnd: project.scheduledEnd || null,
      assignedFixterIds: (project.assignedFixterIds || []).map(String),
    };
    const updated = await Project.findByIdAndUpdate(project._id, { $set: set }, { new: true, runValidators: true }).select(
      "scheduledStart scheduledEnd assignedFixterIds updatedAt"
    );
    await logProjectActivity(req, {
      action: "Project Schedule Updated",
      entityType: "Project",
      entityId: project._id,
      entityName: project.projectNumber,
      before,
      after: {
        scheduledStart: updated.scheduledStart,
        scheduledEnd: updated.scheduledEnd,
        assignedFixterIds: updated.assignedFixterIds.map(String),
      },
    });
    return res.json({
      scheduledStart: updated.scheduledStart,
      scheduledEnd: updated.scheduledEnd,
      assignedFixterIds: updated.assignedFixterIds.map(String),
      updatedAt: updated.updatedAt,
    });
  } catch (error) {
    console.error("PUT /admin/projects/:id/schedule failed:", error?.message);
    return fail(res, 500, "Failed to update the schedule", "SERVER_ERROR");
  }
});

/* ------------------------------------------------------------------ */
/* Closeout                                                            */
/* ------------------------------------------------------------------ */

router.post("/:id/substantial-completion", async (req, res) => {
  try {
    const project = await loadActiveProject(req, res);
    if (!project) return null;
    if (req.body?.confirm !== true) {
      return fail(res, 400, "Confirm that the work is substantially complete.", "CONFIRMATION_REQUIRED");
    }
    if (project.substantialCompletionAt) {
      return fail(res, 409, "This project is already marked substantially complete.", "INVALID_TRANSITION", {
        substantialCompletionAt: project.substantialCompletionAt,
      });
    }
    const signed = await Contract.exists({ projectId: project._id, status: "Signed" });
    if (!signed) {
      return fail(res, 409, "Only a project with a signed agreement can be marked substantially complete.", "INVALID_TRANSITION");
    }
    const parsed = parseDate(req.body?.completedAt);
    if (parsed.error) return fail(res, 400, "completedAt is not a valid date", "INVALID_DATE");
    const completedAt = parsed.value || new Date();
    if (completedAt.getTime() > Date.now() + 60 * 1000) {
      return fail(res, 400, "Substantial completion cannot be in the future.", "INVALID_DATE");
    }
    const ends = warrantyEndsAt(completedAt);
    const updated = await Project.findOneAndUpdate(
      { _id: project._id, substantialCompletionAt: null },
      {
        $set: {
          substantialCompletionAt: completedAt,
          substantialCompletionBy: actorId(req),
          warrantyEndsAt: ends,
          warrantyTermsVersion: ends ? WORKMANSHIP_WARRANTY.termsVersion : "",
        },
      },
      { new: true }
    ).select("substantialCompletionAt warrantyEndsAt warrantyTermsVersion updatedAt");
    if (!updated) return fail(res, 409, "This project was marked complete at the same moment.", "STALE");
    await logProjectActivity(req, {
      action: "Project Substantially Complete",
      entityType: "Project",
      entityId: project._id,
      entityName: project.projectNumber,
      after: { substantialCompletionAt: completedAt, warrantyEndsAt: ends },
    });
    return res.json({
      substantialCompletionAt: updated.substantialCompletionAt,
      warrantyEndsAt: updated.warrantyEndsAt,
      warrantyTermsVersion: updated.warrantyTermsVersion,
      warranty: WORKMANSHIP_WARRANTY.months ? { months: WORKMANSHIP_WARRANTY.months, startsAt: WORKMANSHIP_WARRANTY.startsAt } : null,
      updatedAt: updated.updatedAt,
    });
  } catch (error) {
    console.error("POST /admin/projects/:id/substantial-completion failed:", error?.message);
    return fail(res, 500, "Failed to record substantial completion", "SERVER_ERROR");
  }
});

function serializePunchList(project) {
  return (project.punchList || []).map((item) => ({
    id: String(item._id),
    text: item.text,
    done: Boolean(item.done),
    doneAt: item.doneAt || null,
    createdAt: item.createdAt || null,
  }));
}

router.post("/:id/punch-list", async (req, res) => {
  try {
    const project = await loadActiveProject(req, res);
    if (!project) return null;
    const text = String(req.body?.text || "").trim().slice(0, 500);
    if (!text) return fail(res, 400, "Describe the punch list item.", "TEXT_REQUIRED");
    if ((project.punchList || []).length >= 200) return fail(res, 409, "The punch list is full (200 items).", "LIMIT_REACHED");
    const updated = await Project.findByIdAndUpdate(
      project._id,
      { $push: { punchList: { text, done: false, createdAt: new Date(), createdBy: actorId(req) } } },
      { new: true }
    ).select("punchList updatedAt");
    await logProjectActivity(req, {
      action: "Punch List Item Added",
      entityType: "Project",
      entityId: project._id,
      entityName: project.projectNumber,
      details: { text },
    });
    return res.status(201).json({ punchList: serializePunchList(updated), updatedAt: updated.updatedAt });
  } catch (error) {
    console.error("POST /admin/projects/:id/punch-list failed:", error?.message);
    return fail(res, 500, "Failed to add the punch list item", "SERVER_ERROR");
  }
});

router.patch("/:id/punch-list/:itemId", async (req, res) => {
  try {
    const project = await loadActiveProject(req, res);
    if (!project) return null;
    const item = project.punchList.id(req.params.itemId);
    if (!item) return fail(res, 404, "Punch list item not found", "NOT_FOUND");
    const before = { text: item.text, done: item.done };
    if (req.body?.text !== undefined) {
      const text = String(req.body.text || "").trim().slice(0, 500);
      if (!text) return fail(res, 400, "Describe the punch list item.", "TEXT_REQUIRED");
      item.text = text;
    }
    if (req.body?.done !== undefined) {
      const done = req.body.done === true;
      if (done !== item.done) {
        item.done = done;
        item.doneAt = done ? new Date() : null;
        item.doneBy = done ? actorId(req) : null;
      }
    }
    await project.save();
    await logProjectActivity(req, {
      action: "Punch List Item Updated",
      entityType: "Project",
      entityId: project._id,
      entityName: project.projectNumber,
      before,
      after: { text: item.text, done: item.done },
    });
    return res.json({ punchList: serializePunchList(project), updatedAt: project.updatedAt });
  } catch (error) {
    console.error("PATCH /admin/projects/:id/punch-list/:itemId failed:", error?.message);
    return fail(res, 500, "Failed to update the punch list item", "SERVER_ERROR");
  }
});

router.delete("/:id/punch-list/:itemId", async (req, res) => {
  try {
    const project = await loadActiveProject(req, res);
    if (!project) return null;
    const item = project.punchList.id(req.params.itemId);
    if (!item) return fail(res, 404, "Punch list item not found", "NOT_FOUND");
    const text = item.text;
    item.deleteOne();
    await project.save();
    await logProjectActivity(req, {
      action: "Punch List Item Removed",
      entityType: "Project",
      entityId: project._id,
      entityName: project.projectNumber,
      details: { text },
    });
    return res.json({ punchList: serializePunchList(project), updatedAt: project.updatedAt });
  } catch (error) {
    console.error("DELETE /admin/projects/:id/punch-list/:itemId failed:", error?.message);
    return fail(res, 500, "Failed to remove the punch list item", "SERVER_ERROR");
  }
});

/* ------------------------------------------------------------------ */
/* Deposit / milestone invoices                                        */
/* ------------------------------------------------------------------ */

/**
 * Bill the deposit, or one payment-schedule row, of the SIGNED agreement.
 *
 * The invoice itself is created by the existing invoice draft route
 * (POST /api/admin/invoices/project/:projectId/draft with createFromContract
 * and billing.mode "amount"), so every rule that route enforces still applies.
 * What is added here is the amount (taken from the agreement, never typed)
 * and a per-row claim on the project, so the same deposit or milestone can be
 * billed only once: a retry with the same idempotencyKey returns the first
 * invoice, and a different key gets 409 ALREADY_BILLED. A row whose invoice
 * was voided may be billed again.
 */
const adminInvoicesRouter = require("./adminInvoices");

router.post("/:id/invoices/from-schedule", async (req, res, next) => {
  try {
    const project = await loadActiveProject(req, res);
    if (!project) return null;
    const kind = String(req.body?.kind || "");
    if (!["deposit", "milestone"].includes(kind)) return fail(res, 400, "kind must be deposit or milestone", "INVALID_KIND");
    const idempotencyKey = String(req.body?.idempotencyKey || req.get("Idempotency-Key") || "").trim().slice(0, 200);
    if (!idempotencyKey) return fail(res, 400, "An idempotencyKey is required for billing actions.", "IDEMPOTENCY_KEY_REQUIRED");

    const contract = await Contract.findOne({ projectId: project._id, status: "Signed" }).sort({ version: -1 });
    if (!contract) return fail(res, 409, "Bill from the agreement once the customer has signed it.", "AGREEMENT_NOT_SIGNED");

    let amountCents;
    let label;
    let scheduleIndex = null;
    if (kind === "deposit") {
      amountCents = Number(contract.depositAmountCents || 0);
      label = "Deposit";
      if (amountCents <= 0) return fail(res, 409, "The signed agreement has no deposit.", "NO_DEPOSIT");
    } else {
      scheduleIndex = Number(req.body?.scheduleIndex);
      const row = Number.isInteger(scheduleIndex) ? (contract.paymentSchedule || [])[scheduleIndex] : null;
      if (!row) return fail(res, 400, "That payment schedule row does not exist.", "INVALID_SCHEDULE_INDEX");
      if (scheduleIndex === depositScheduleIndex(contract.paymentSchedule)) {
        return fail(res, 409, "That row is the deposit. Use kind \"deposit\".", "USE_DEPOSIT");
      }
      amountCents = Number(row.amountCents || 0);
      // Cleaned as the draft route cleans billing.label, so the invoice line matches it exactly.
      label = String(row.label || "").replace(/\u0000/g, "").trim().slice(0, 240);
      if (amountCents <= 0) return fail(res, 409, "That payment schedule row has no amount.", "NO_AMOUNT");
    }

    /*
     * Review fix 2026-11-13. The claim is keyed per PROJECT + row, not per
     * agreement version, so a revised and re-signed agreement cannot bill the
     * same deposit or milestone again. Before claiming, the same server-side
     * helpers the overview uses decide whether the row is already billed -
     * including deposits and milestones invoiced by hand before this route
     * existed, and claims made under an older agreement version.
     */
    const claimKey = `${project._id}:${kind}:${scheduleIndex ?? ""}`;
    const projectInvoices = await Invoice.find({ projectId: project._id, isArchived: { $ne: true } })
      .select("status isArchived contractId invoiceTotalCents invoiceNumber lineItems.description createdAt")
      .lean();
    const invoicesById = new Map(projectInvoices.map((invoice) => [String(invoice._id), invoice]));
    const currentClaims = (await Project.findById(project._id).select("billingClaims").lean())?.billingClaims || [];
    const sameRow = (row) => row.kind === kind && (kind === "deposit" || Number(row.scheduleIndex) === Number(scheduleIndex));
    const liveClaimInvoice = (row) => {
      const invoice = row.invoiceId ? invoicesById.get(String(row.invoiceId)) : null;
      return invoice && !["Voided", "Superseded"].includes(invoice.status) ? invoice : null;
    };
    const replayable = currentClaims.find((row) => sameRow(row) && row.idempotencyKey === idempotencyKey && liveClaimInvoice(row));
    if (replayable) {
      const invoice = liveClaimInvoice(replayable);
      return res.status(200).json({ replayed: true, invoiceId: String(invoice._id), invoiceNumber: invoice.invoiceNumber, kind, scheduleIndex });
    }
    // Claims under the current key are settled by the atomic claim below; everything else billed is a refusal.
    const otherClaims = currentClaims.filter((row) => row.claimKey !== claimKey);
    const billedElsewhere =
      kind === "deposit"
        ? depositBilled({ billingClaims: otherClaims }, contract, projectInvoices, invoicesById)
        : milestoneBilled({ billingClaims: otherClaims }, contract, scheduleIndex, projectInvoices, invoicesById);
    if (billedElsewhere) {
      const byClaim = currentClaims.find((row) => sameRow(row) && liveClaimInvoice(row));
      const invoice = byClaim ? liveClaimInvoice(byClaim) : null;
      return fail(res, 409, `This ${kind} is already billed${invoice?.invoiceNumber ? ` (invoice #${invoice.invoiceNumber})` : ""}.`, "ALREADY_BILLED", {
        invoiceId: invoice ? String(invoice._id) : null,
      });
    }

    /*
     * The invoice this claim produced, if one was created but never stamped
     * on the claim (the stamp failed or the process died). Never release a
     * claim whose invoice exists: stamp it instead.
     */
    const invoiceCreatedFor = async (row) => {
      const since = new Date(new Date(row.claimedAt || 0).getTime() - 5000);
      return Invoice.findOne({
        projectId: project._id,
        isArchived: { $ne: true },
        status: { $nin: ["Voided", "Superseded"] },
        createdAt: { $gte: since },
        "lineItems.description": label,
      })
        .select("_id invoiceNumber status")
        .lean();
    };
    const stampClaim = (row, invoiceId) =>
      Project.updateOne(
        { _id: project._id, billingClaims: { $elemMatch: { _id: row._id, invoiceId: null } } },
        { $set: { "billingClaims.$.invoiceId": invoiceId } }
      );

    const claim = {
      claimKey,
      kind,
      scheduleIndex,
      contractId: contract._id,
      idempotencyKey,
      invoiceId: null,
      claimedAt: new Date(),
      claimedBy: actorId(req),
    };

    // Atomic claim; on conflict decide replay / re-bill / refuse.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const claimed = await Project.findOneAndUpdate(
        { _id: project._id, "billingClaims.claimKey": { $ne: claimKey } },
        { $push: { billingClaims: claim } },
        { new: true }
      ).select("_id");
      if (claimed) break;

      const current = await Project.findById(project._id).select("billingClaims").lean();
      const existing = (current.billingClaims || []).find((row) => row.claimKey === claimKey);
      if (!existing) continue;
      let invoice = existing.invoiceId ? await Invoice.findById(existing.invoiceId).select("status invoiceNumber").lean() : null;
      const stale = !existing.invoiceId && Date.now() - new Date(existing.claimedAt).getTime() > STALE_CLAIM_MS;
      if (stale) {
        // A stale claim whose invoice was in fact created is billed, not abandoned.
        const created = await invoiceCreatedFor(existing);
        if (created) {
          await stampClaim(existing, created._id);
          existing.invoiceId = created._id;
          invoice = created;
        }
      }
      const releasable =
        (invoice && ["Voided", "Superseded"].includes(invoice.status)) ||
        (!existing.invoiceId && stale);
      if (releasable && attempt === 0) {
        await Project.updateOne({ _id: project._id }, { $pull: { billingClaims: { _id: existing._id } } });
        continue;
      }
      if (existing.idempotencyKey === idempotencyKey && invoice) {
        return res.status(200).json({ replayed: true, invoiceId: String(invoice._id), invoiceNumber: invoice.invoiceNumber, kind, scheduleIndex });
      }
      if (!existing.invoiceId) return fail(res, 409, "This invoice is already being created. Try again in a moment.", "IN_PROGRESS");
      return fail(res, 409, `This ${kind} is already billed (invoice #${invoice?.invoiceNumber || ""}).`, "ALREADY_BILLED", {
        invoiceId: String(existing.invoiceId),
      });
    }

    // Release only a claim that produced no invoice; one that did is stamped instead.
    const release = async () => {
      const current = await Project.findById(project._id).select("billingClaims").lean();
      const mine = (current?.billingClaims || []).find((row) => row.claimKey === claimKey && !row.invoiceId && row.idempotencyKey === idempotencyKey);
      if (!mine) return null;
      const created = await invoiceCreatedFor(mine);
      if (created) return stampClaim(mine, created._id);
      return Project.updateOne({ _id: project._id }, { $pull: { billingClaims: { _id: mine._id, invoiceId: null } } });
    };

    // Hand over to the existing draft route, capturing its answer to stamp the claim.
    const originalJson = res.json.bind(res);
    res.json = (payload) => {
      res.json = originalJson;
      const invoiceId = payload?.invoice?.id || payload?.invoice?._id;
      if (res.statusCode === 201 && invoiceId) {
        Project.updateOne(
          { _id: project._id, "billingClaims.claimKey": claimKey },
          { $set: { "billingClaims.$.invoiceId": invoiceId } }
        )
          .then(() =>
            logProjectActivity(req, {
              action: kind === "deposit" ? "Deposit Invoice Created" : "Milestone Invoice Created",
              entityType: "Invoice",
              entityId: invoiceId,
              entityName: payload?.invoice?.invoiceNumber || "",
              details: { projectId: String(project._id), contractId: String(contract._id), kind, scheduleIndex, amountCents },
            })
          )
          .catch((error) => console.error("billing claim stamp failed:", error?.message))
          .finally(() => originalJson({ ...payload, kind, scheduleIndex }));
        return res;
      }
      release().catch(() => null).finally(() => originalJson(payload));
      return res;
    };

    req.url = `/project/${project._id}/draft`;
    req.body = {
      createFromContract: true,
      contractId: String(contract._id),
      billing: { mode: "amount", amountCents, label },
    };
    return adminInvoicesRouter(req, res, (error) => {
      res.json = originalJson;
      release().catch(() => null);
      return next(error);
    });
  } catch (error) {
    console.error("POST /admin/projects/:id/invoices/from-schedule failed:", error?.message);
    return fail(res, 500, "Failed to create the invoice", "SERVER_ERROR");
  }
});

module.exports = router;
