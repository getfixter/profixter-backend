/**
 * Needs action - new renovation leads: estimate-builder leads and
 * contractor / home-improvement requests nobody has picked up yet (status
 * "new", not yet a project).
 *
 * Free-visit requests and callbacks are deliberately not here; they are the
 * bookings collector's "requests to review". Needs the Leads section.
 */
const { PERMISSIONS } = require("../../adminAccess");
const Request = require("../../../models/Request");
const EstimateLead = require("../../../models/EstimateLead");
const { SERVICE_LABELS } = require("../../projects/leadConversion");

const RENOVATION_REQUEST_TYPES = ["general_contractor", "home_improvement"];

function range(lead) {
  const low = Number(lead.estimateLow);
  const high = Number(lead.estimateHigh);
  if (Number.isFinite(low) && Number.isFinite(high) && high > 0) {
    return `shown $${Math.round(low).toLocaleString("en-US")} - $${Math.round(high).toLocaleString("en-US")}`;
  }
  return "";
}

module.exports = {
  key: "project_leads",
  order: 35,
  permission: PERMISSIONS.LEADS_MANAGE,
  async collect({ now = new Date(), limit = 25 } = {}) {
    const newFilter = { status: "new", $or: [{ projectId: null }, { projectId: { $exists: false } }] };
    const [estimates, requests, estimateCount, requestCount] = await Promise.all([
      EstimateLead.find({ ...newFilter, service: { $ne: "community-partnership" } })
        .select("name service budgetRange timeline estimateLow estimateHigh createdAt")
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean(),
      Request.find({ ...newFilter, serviceType: { $in: RENOVATION_REQUEST_TYPES } })
        .select("name serviceType message createdAt")
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean(),
      EstimateLead.countDocuments({ ...newFilter, service: { $ne: "community-partnership" } }),
      Request.countDocuments({ ...newFilter, serviceType: { $in: RENOVATION_REQUEST_TYPES } }),
    ]);

    const items = [
      ...estimates.map((lead) => ({
        id: String(lead._id),
        kind: "estimate_lead_new",
        title: `New estimate lead: ${lead.name || "Homeowner"}`,
        subtitle: [SERVICE_LABELS[lead.service] || lead.service, lead.budgetRange, lead.timeline].filter(Boolean).join(" · "),
        reason: ["Not contacted yet", range(lead)].filter(Boolean).join("; ") + ".",
        severity: "attention",
        href: `/admin/leads/estimate-${lead._id}`,
        at: lead.createdAt || now,
      })),
      ...requests.map((lead) => ({
        id: String(lead._id),
        kind: "renovation_request_new",
        title: `New project request: ${lead.name || "Homeowner"}`,
        subtitle: SERVICE_LABELS[lead.serviceType] || lead.serviceType,
        reason: lead.message ? `"${String(lead.message).slice(0, 120)}"` : "Not contacted yet.",
        severity: "attention",
        href: `/admin/leads/request-${lead._id}`,
        at: lead.createdAt || now,
      })),
    ].sort((a, b) => new Date(b.at) - new Date(a.at));

    return { count: estimateCount + requestCount, items: items.slice(0, limit) };
  },
};
