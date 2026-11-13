/**
 * Admin leads: one list over Request and EstimateLead, the full answers the
 * homeowner gave, and conversion into a renovation project.
 *
 * Mounted at /api/admin/leads. The older GET /api/admin/requests (routes/admin.js)
 * is kept unchanged for the current Admin; this router is what the redesigned
 * Admin reads.
 *
 * Search text travels in a POST body (POST /search), never in a URL.
 */

const express = require("express");
const mongoose = require("mongoose");
const auth = require("../middleware/auth");
const { PERMISSIONS, requirePermission, hasPermission } = require("../middleware/authorize");
const Request = require("../models/Request");
const EstimateLead = require("../models/EstimateLead");
const {
  LEAD_SOURCES,
  LeadConversionError,
  resolveLeadSource,
  leadListItem,
  leadDetail,
  convertLeadToProject,
} = require("../utils/projects/leadConversion");
const { logProjectActivity } = require("../utils/projectActivity");

const router = express.Router();
router.use(auth, ...requirePermission(PERMISSIONS.LEADS_MANAGE));

const MAX_LIMIT = 100;
const LIST_FIELDS_REQUEST =
  "name email phone address city state zip serviceType sourcePage status createdAt bookingId projectId";
const LIST_FIELDS_ESTIMATE =
  "name email phone address service sourcePage source status createdAt projectId budgetRange timeline estimateLow estimateHigh";

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function textFilter(search, fields) {
  const value = String(search || "").trim().slice(0, 120);
  if (!value) return {};
  const pattern = new RegExp(escapeRegex(value), "i");
  const digits = value.replace(/\D/g, "");
  const or = fields.map((field) => ({ [field]: pattern }));
  if (digits.length >= 4) or.push({ phone: new RegExp(digits.split("").join("\\D*")) });
  return { $or: or };
}

/**
 * The merged, newest-first list. Each source is capped at page*limit before
 * merging, which is exact for the requested page and keeps the query bounded.
 */
async function listLeads({ search = "", status = "", model = "", page = 1, limit = 50 }) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), MAX_LIMIT);
  const safePage = Math.max(Number(page) || 1, 1);
  const window = safePage * safeLimit;
  const statusFilter = status ? { status: String(status).slice(0, 40) } : {};
  const wantRequest = !model || model === "request";
  const wantEstimate = !model || model === "estimate";

  const requestQuery = { ...statusFilter, ...textFilter(search, ["name", "email", "address", "city", "message"]) };
  const estimateQuery = { ...statusFilter, ...textFilter(search, ["name", "email", "address", "notes"]) };

  const [requests, estimates, requestCount, estimateCount] = await Promise.all([
    wantRequest ? Request.find(requestQuery).select(LIST_FIELDS_REQUEST).sort({ createdAt: -1 }).limit(window).lean() : [],
    wantEstimate ? EstimateLead.find(estimateQuery).select(LIST_FIELDS_ESTIMATE).sort({ createdAt: -1 }).limit(window).lean() : [],
    wantRequest ? Request.countDocuments(requestQuery) : 0,
    wantEstimate ? EstimateLead.countDocuments(estimateQuery) : 0,
  ]);

  const merged = [
    ...requests.map((lead) => leadListItem(LEAD_SOURCES.request, lead)),
    ...estimates.map((lead) => leadListItem(LEAD_SOURCES.estimate, lead)),
  ].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

  return {
    leads: merged.slice((safePage - 1) * safeLimit, safePage * safeLimit),
    total: requestCount + estimateCount,
    page: safePage,
    limit: safeLimit,
  };
}

router.get("/", async (req, res) => {
  try {
    return res.json(
      await listLeads({
        status: req.query.status,
        model: String(req.query.model || "").toLowerCase(),
        page: req.query.page,
        limit: req.query.limit,
      })
    );
  } catch (error) {
    console.error("GET /admin/leads failed:", error?.message);
    return res.status(500).json({ message: "Failed to load leads", code: "SERVER_ERROR" });
  }
});

router.post("/search", async (req, res) => {
  try {
    const body = req.body || {};
    return res.json(
      await listLeads({
        search: body.search,
        status: body.status,
        model: String(body.model || "").toLowerCase(),
        page: body.page,
        limit: body.limit,
      })
    );
  } catch (error) {
    console.error("POST /admin/leads/search failed:", error?.message);
    return res.status(500).json({ message: "Failed to search leads", code: "SERVER_ERROR" });
  }
});

function resolveOr400(req, res) {
  const source = resolveLeadSource(req.params.model);
  if (!source) {
    res.status(400).json({ message: "Lead type must be request or estimate", code: "INVALID_LEAD_MODEL" });
    return null;
  }
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(400).json({ message: "Invalid lead ID", code: "INVALID_ID" });
    return null;
  }
  return source;
}

router.get("/:model/:id", async (req, res) => {
  try {
    const source = resolveOr400(req, res);
    if (!source) return null;
    const lead = await source.model.findById(req.params.id).select("-password -contactConsent.ip -contactConsent.userAgent").lean();
    if (!lead) return res.status(404).json({ message: "Lead not found", code: "NOT_FOUND" });
    return res.json({
      lead: leadDetail(source, lead, { canManageProjects: hasPermission(req, PERMISSIONS.PROJECTS_MANAGE) }),
    });
  } catch (error) {
    console.error("GET /admin/leads/:model/:id failed:", error?.message);
    return res.status(500).json({ message: "Failed to load lead", code: "SERVER_ERROR" });
  }
});

router.post("/:model/:id/convert-to-project", async (req, res) => {
  try {
    if (!hasPermission(req, PERMISSIONS.PROJECTS_MANAGE)) {
      return res.status(403).json({ message: "Creating projects needs the Projects section.", code: "FORBIDDEN" });
    }
    const source = resolveOr400(req, res);
    if (!source) return null;

    const { project, created } = await convertLeadToProject({
      source,
      leadId: req.params.id,
      body: req.body || {},
      req,
    });
    if (created) {
      await logProjectActivity(req, {
        action: "Lead Converted To Project",
        entityType: "Project",
        entityId: project._id,
        entityName: project.projectNumber,
        details: { leadModel: source.modelName, leadId: req.params.id },
      });
    }
    return res.status(created ? 201 : 200).json({
      created,
      project: {
        id: String(project._id),
        projectNumber: project.projectNumber,
        customerName: project.customerName,
        status: project.status,
        projectType: project.projectType,
        isDeleted: project.isDeleted === true,
        leadRef: { model: project.leadRef?.model || null, id: project.leadRef?.id ? String(project.leadRef.id) : null },
        qualification: project.qualification || null,
        href: `/admin/projects/${project._id}`,
      },
    });
  } catch (error) {
    if (error instanceof LeadConversionError) {
      return res.status(error.status).json({ message: error.message, code: error.code });
    }
    console.error("POST /admin/leads/:model/:id/convert-to-project failed:", error?.message);
    return res.status(500).json({ message: "Failed to create the project", code: "SERVER_ERROR" });
  }
});

module.exports = router;
module.exports.listLeads = listLeads;
