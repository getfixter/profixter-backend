/**
 * Leads (Request and EstimateLead) for the Admin, and turning one into a
 * renovation project.
 *
 * The homeowner answered real questions (budget, timeline, financing, the
 * scope of the bathroom or roof) and was shown a price range. Those answers are
 * the context for every call and every agreement that follows, so the lead
 * detail returns all of them, and conversion copies all of them onto the
 * project verbatim, as `project.qualification`. Nothing is recalculated.
 *
 * Conversion is idempotent: the project carries leadRef {model, id} under a
 * unique index and the lead carries projectId, so a second call (a retry, a
 * double tap, a second admin) returns the first project.
 */

const mongoose = require("mongoose");
const Project = require("../../models/Project");
const Request = require("../../models/Request");
const EstimateLead = require("../../models/EstimateLead");

/** URL/model slugs. The old list used "estimate:<id>" for estimate leads. */
const LEAD_SOURCES = Object.freeze({
  request: { slug: "request", model: Request, modelName: "Request" },
  estimate: { slug: "estimate", model: EstimateLead, modelName: "EstimateLead" },
});

function resolveLeadSource(value) {
  const key = String(value || "").trim().toLowerCase();
  if (key === "request" || key === "requests") return LEAD_SOURCES.request;
  if (key === "estimate" || key === "estimatelead" || key === "estimate-lead" || key === "estimates") {
    return LEAD_SOURCES.estimate;
  }
  return null;
}

/** "estimate:<id>" (old list ids) or "estimate-<id>" (new hrefs) or a bare Request id. */
function parseLeadKey(raw) {
  const value = String(raw || "").trim();
  const match = value.match(/^(request|estimate)[:-]([a-f0-9]{24})$/i);
  if (match) return { source: resolveLeadSource(match[1]), id: match[2] };
  if (mongoose.isValidObjectId(value)) return { source: LEAD_SOURCES.request, id: value };
  return null;
}

/** Statuses each model accepts (F24: the old route wrote pending_confirmation to EstimateLead). */
const MANUAL_STATUSES = Object.freeze({
  request: ["new", "contacted", "won", "lost"],
  estimate: ["new", "contacted", "qualified", "won", "lost"],
});

const SERVICE_LABELS = Object.freeze({
  roofing: "Roofing",
  siding: "Siding",
  roofing_siding: "Roofing and siding",
  both: "Roofing and siding",
  bathroom: "Bathroom",
  kitchen: "Kitchen",
  "kitchen-bathroom": "Kitchen and bathroom",
  "full-house": "Full house renovation",
  "build-new-house": "New house build",
  basement: "Basement",
  interior: "Interior",
  "community-partnership": "Community partnership",
  other: "Other",
  general: "General enquiry",
  address_request: "Address request",
  on_demand: "On-demand visit",
  general_contractor: "General contractor",
  home_improvement: "Home improvement",
  membership_interest: "Membership question",
  free_visit_request: "Free visit request",
  callback_request: "Callback request",
});

/* Request service types that are renovation leads (eligible to become projects). */
const PROJECT_REQUEST_TYPES = Object.freeze(["general_contractor", "home_improvement", "general"]);

const PROJECT_TYPE_BY_SERVICE = Object.freeze({
  roofing: "Roofing",
  roofing_siding: "Roofing",
  both: "Roofing",
  siding: "Siding",
  bathroom: "Bathroom",
  kitchen: "Kitchen",
  "kitchen-bathroom": "Kitchen",
});

/* The estimate-builder answers, grouped the way the form asks them. */
const ANSWER_FIELDS = Object.freeze({
  roof: ["roofScope", "roofSize", "roofMaterial", "roofUrgency", "roofInsurance", "roofFinish"],
  bathroom: ["bathroomScope", "bathroomSize", "bathroomItems", "bathroomFinish", "bathroomPlumbing"],
  kitchen: ["kitchenScope", "kitchenSize", "kitchenItems", "kitchenFinish", "kitchenLayout", "kitchenPlumbing"],
});

function present(value) {
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function pickAnswers(lead) {
  const answers = {};
  for (const [group, fields] of Object.entries(ANSWER_FIELDS)) {
    const groupAnswers = {};
    for (const field of fields) {
      if (present(lead[field])) groupAnswers[field] = Array.isArray(lead[field]) ? [...lead[field]] : lead[field];
    }
    if (Object.keys(groupAnswers).length) answers[group] = groupAnswers;
  }
  return answers;
}

/** Everything the homeowner told us, in one plain object. */
function qualificationFromLead(source, lead) {
  if (source.slug === "estimate") {
    return {
      source: "EstimateLead",
      service: lead.service || "",
      serviceLabel: SERVICE_LABELS[lead.service] || lead.service || "",
      budgetRange: lead.budgetRange || "",
      timeline: lead.timeline || "",
      financing: lead.financing || "",
      estimateLow: Number.isFinite(Number(lead.estimateLow)) && present(lead.estimateLow) ? Number(lead.estimateLow) : null,
      estimateHigh: Number.isFinite(Number(lead.estimateHigh)) && present(lead.estimateHigh) ? Number(lead.estimateHigh) : null,
      answers: pickAnswers(lead),
      contactPref: lead.contactPref || "",
      bestTime: lead.bestTime || "",
      notes: lead.notes || "",
      sourcePage: lead.sourcePage || "",
      leadSource: lead.source || "",
      submittedAt: lead.createdAt || null,
    };
  }
  return {
    source: "Request",
    service: lead.serviceType || "",
    serviceLabel: SERVICE_LABELS[lead.serviceType] || lead.serviceType || "",
    budgetRange: "",
    timeline: "",
    financing: "",
    estimateLow: null,
    estimateHigh: null,
    answers: {},
    notes: lead.message || "",
    sourcePage: lead.sourcePage || "",
    requestedDate: lead.requestedDate || "",
    requestedTime: lead.requestedTime || "",
    submittedAt: lead.createdAt || null,
  };
}

function leadAddress(source, lead) {
  if (source.slug === "estimate") return String(lead.address || "").trim();
  const parts = [lead.address, lead.city, [lead.state, lead.zip].filter(Boolean).join(" ")]
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  return parts.join(", ");
}

function leadKey(source, lead) {
  return `${source.slug}-${lead._id}`;
}

/** The list row. Lean: no password field, no consent IPs, no attribution blobs. */
function leadListItem(source, lead) {
  const isEstimate = source.slug === "estimate";
  const service = isEstimate ? lead.service : lead.serviceType;
  return {
    key: leadKey(source, lead),
    legacyId: isEstimate ? `estimate:${lead._id}` : String(lead._id),
    model: source.slug,
    id: String(lead._id),
    name: lead.name || "",
    email: lead.email || "",
    phone: lead.phone || "",
    address: leadAddress(source, lead),
    service: service || "",
    serviceLabel: SERVICE_LABELS[service] || service || "",
    sourcePage: lead.sourcePage || (isEstimate ? lead.source || "estimate" : ""),
    status: lead.status || "new",
    createdAt: lead.createdAt || null,
    projectId: lead.projectId ? String(lead.projectId) : null,
    bookingId: !isEstimate && lead.bookingId ? String(lead.bookingId) : null,
    budgetRange: isEstimate ? lead.budgetRange || "" : "",
    timeline: isEstimate ? lead.timeline || "" : "",
    estimateLow: isEstimate && present(lead.estimateLow) ? Number(lead.estimateLow) : null,
    estimateHigh: isEstimate && present(lead.estimateHigh) ? Number(lead.estimateHigh) : null,
    href: `/admin/leads/${leadKey(source, lead)}`,
  };
}

function canConvert(source, lead) {
  if (lead.projectId) return false;
  if (source.slug === "estimate") return lead.service !== "community-partnership";
  return PROJECT_REQUEST_TYPES.includes(lead.serviceType || "general");
}

function leadAllowedActions(source, lead, { canManageProjects = true } = {}) {
  const followsVisit = source.slug === "request" && Boolean(lead.bookingId);
  return {
    setStatus: !followsVisit,
    statuses: followsVisit ? [] : MANUAL_STATUSES[source.slug],
    convertToProject: canManageProjects && canConvert(source, lead),
    openProject: Boolean(lead.projectId),
    delete: true,
  };
}

function leadDetail(source, lead, options = {}) {
  return {
    ...leadListItem(source, lead),
    contactPref: lead.contactPref || "",
    bestTime: lead.bestTime || "",
    message: source.slug === "estimate" ? lead.notes || "" : lead.message || "",
    qualification: qualificationFromLead(source, lead),
    requestedDate: lead.requestedDate || "",
    requestedTime: lead.requestedTime || "",
    allowedActions: leadAllowedActions(source, lead, options),
  };
}

function projectTypeFor(source, lead, requested) {
  const allowed = Project.PROJECT_TYPES;
  if (requested && allowed.includes(requested)) return requested;
  const service = source.slug === "estimate" ? lead.service : lead.serviceType;
  return PROJECT_TYPE_BY_SERVICE[service] || "Other";
}

class LeadConversionError extends Error {
  constructor(message, status = 400, code = "LEAD_CONVERSION_FAILED") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function actorName(req) {
  const actor = req?.accessUser || req?.authUser || {};
  return String(actor.name || actor.email || "Admin").slice(0, 160);
}

/**
 * Convert a lead into a project, or return the project it already became.
 * Returns { project, created }.
 */
async function convertLeadToProject({ source, leadId, body = {}, req }) {
  const lead = await source.model.findById(leadId);
  if (!lead) throw new LeadConversionError("Lead not found", 404, "NOT_FOUND");

  const findExisting = async () => {
    if (lead.projectId) {
      const linked = await Project.findById(lead.projectId);
      if (linked) return linked;
    }
    return Project.findOne({ "leadRef.model": source.modelName, "leadRef.id": lead._id });
  };

  const existing = await findExisting();
  if (existing) {
    if (!lead.projectId) await source.model.updateOne({ _id: lead._id }, { $set: { projectId: existing._id } });
    return { project: existing, created: false };
  }

  if (!canConvert(source, lead)) {
    throw new LeadConversionError(
      "This kind of request is not a renovation lead and cannot become a project.",
      409,
      "NOT_A_PROJECT_LEAD"
    );
  }

  const name = String(lead.name || "").trim();
  const address = String(body.address || "").trim().slice(0, 500) || leadAddress(source, lead);
  if (!name) throw new LeadConversionError("The lead has no name. Add one before creating a project.", 400, "NAME_REQUIRED");
  if (!address) {
    throw new LeadConversionError(
      "The lead has no address. Send the property address to create the project.",
      400,
      "ADDRESS_REQUIRED"
    );
  }

  const qualification = qualificationFromLead(source, lead.toObject());
  const actorId = req?.user?.id && mongoose.isValidObjectId(req.user.id) ? req.user.id : null;
  let project;
  try {
    project = await Project.create({
      status: "Lead",
      customerName: name.slice(0, 160),
      email: String(lead.email || "").toLowerCase().slice(0, 254),
      phone: String(lead.phone || "").slice(0, 40),
      address,
      customerSnapshot: {
        fullName: name.slice(0, 160),
        email: String(lead.email || "").toLowerCase().slice(0, 254),
        phone: String(lead.phone || "").slice(0, 40),
      },
      propertySnapshot: { formattedAddress: address },
      projectType: projectTypeFor(source, lead, String(body.projectType || "").trim()),
      notes: String(qualification.notes || "").slice(0, 10000),
      leadRef: { model: source.modelName, id: lead._id },
      qualification,
      statusHistory: [
        {
          from: "",
          to: "Lead",
          at: new Date(),
          actorId,
          actorName: actorName(req),
          reason: `Converted from ${source.slug === "estimate" ? "estimate" : "request"} lead`,
          source: "lead_conversion",
        },
      ],
    });
  } catch (error) {
    // A concurrent conversion won the unique index: return its project.
    if (error?.code === 11000) {
      const winner = await findExisting();
      if (winner) return { project: winner, created: false };
    }
    throw error;
  }

  await source.model.updateOne({ _id: lead._id }, { $set: { projectId: project._id } });
  return { project, created: true };
}

module.exports = {
  LEAD_SOURCES,
  MANUAL_STATUSES,
  SERVICE_LABELS,
  LeadConversionError,
  resolveLeadSource,
  parseLeadKey,
  qualificationFromLead,
  leadListItem,
  leadDetail,
  leadAllowedActions,
  canConvert,
  convertLeadToProject,
};
