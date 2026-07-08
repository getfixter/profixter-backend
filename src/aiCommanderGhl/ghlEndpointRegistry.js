const HIGH_RISK_CONFIRMATION_PHRASE = "CONFIRM GHL HIGH RISK";
const DESTRUCTIVE_CONFIRMATION_PHRASE = "CONFIRM GHL DESTRUCTIVE";

function cleanString(value) {
  return String(value ?? "").trim();
}

function cleanList(value) {
  if (!Array.isArray(value)) return [];
  return value.map(cleanString).filter(Boolean);
}

function inferRiskCategory({ method, readOnly, riskLevel, destructive }) {
  if (destructive) return "destructive";
  if (readOnly || ["GET", "HEAD"].includes(cleanString(method).toUpperCase())) return "read";
  if (riskLevel === "high") return "high-risk";
  return "write";
}

function endpoint({
  key,
  group,
  method,
  path,
  description,
  requiredScopes = [],
  riskLevel = "low",
  riskCategory = "",
  destructive = false,
  readOnly = false,
  approvalRequired,
  requiresExtraConfirmation,
  confirmationPhrase = "",
  payloadSchema = {},
  rateLimitProfile = "standard",
  auditLogPolicy = "full_sanitized",
  requiresLocationId = true,
  locationParam = "locationId",
  deprecated = false,
  enabled = true,
  docs = "",
}) {
  const upperMethod = cleanString(method || "GET").toUpperCase();
  const finalReadOnly = readOnly || ["GET", "HEAD"].includes(upperMethod);
  const finalRiskCategory =
    riskCategory || inferRiskCategory({ method: upperMethod, readOnly: finalReadOnly, riskLevel, destructive });
  const finalConfirmationPhrase =
    confirmationPhrase ||
    (destructive
      ? DESTRUCTIVE_CONFIRMATION_PHRASE
      : finalRiskCategory === "high-risk"
        ? HIGH_RISK_CONFIRMATION_PHRASE
        : "");
  const finalApprovalRequired =
    approvalRequired !== undefined ? approvalRequired === true : finalReadOnly !== true;
  const finalRequiresExtraConfirmation =
    requiresExtraConfirmation !== undefined
      ? requiresExtraConfirmation === true
      : Boolean(finalConfirmationPhrase);

  return {
    key,
    group,
    method: upperMethod,
    path,
    description,
    requiredScopes: cleanList(requiredScopes),
    riskLevel,
    riskCategory: finalRiskCategory,
    destructive,
    readOnly: finalReadOnly,
    approvalRequired: finalApprovalRequired,
    requiresExtraConfirmation: finalRequiresExtraConfirmation,
    confirmationPhrase: finalConfirmationPhrase,
    payloadSchema,
    rateLimitProfile,
    auditLogPolicy,
    requiresLocationId,
    locationParam,
    deprecated,
    enabled,
    docs,
  };
}

const ENDPOINTS = [
  endpoint({
    key: "contacts.search",
    group: "contacts",
    method: "POST",
    path: "/contacts/search",
    description: "Search contacts.",
    requiredScopes: ["contacts.readonly"],
    readOnly: true,
    approvalRequired: false,
    payloadSchema: { page: "number", pageLimit: "number", query: "string", filters: "array" },
  }),
  endpoint({ key: "contacts.get", group: "contacts", method: "GET", path: "/contacts/:contactId", description: "Get one contact.", requiredScopes: ["contacts.readonly"], requiresLocationId: false }),
  endpoint({ key: "contacts.create", group: "contacts", method: "POST", path: "/contacts/", description: "Create one contact.", requiredScopes: ["contacts.write"], riskLevel: "medium", payloadSchema: { locationId: "string", firstName: "string", lastName: "string", email: "string", phone: "string" } }),
  endpoint({ key: "contacts.upsert", group: "contacts", method: "POST", path: "/contacts/upsert", description: "Create or update one contact.", requiredScopes: ["contacts.write"], riskLevel: "medium" }),
  endpoint({ key: "contacts.update", group: "contacts", method: "PUT", path: "/contacts/:contactId", description: "Update one contact.", requiredScopes: ["contacts.write"], riskLevel: "medium", requiresLocationId: false }),
  endpoint({ key: "contacts.delete", group: "contacts", method: "DELETE", path: "/contacts/:contactId", description: "Delete one contact.", requiredScopes: ["contacts.write"], riskLevel: "high", destructive: true, requiresLocationId: false }),
  endpoint({ key: "contacts.bulk.tags.update", group: "contacts", method: "POST", path: "/contacts/bulk/tags/update/:type", description: "Add or remove tags for multiple contacts.", requiredScopes: ["contacts.write"], riskLevel: "high", rateLimitProfile: "bulk", payloadSchema: { locationId: "string", contactIds: "array", tags: "array" } }),

  endpoint({ key: "contacts.add_tags", group: "tags", method: "POST", path: "/contacts/:contactId/tags", description: "Add tags to one contact.", requiredScopes: ["contacts.write"], riskLevel: "medium", requiresLocationId: false, payloadSchema: { tags: "array" } }),
  endpoint({ key: "contacts.remove_tags", group: "tags", method: "DELETE", path: "/contacts/:contactId/tags", description: "Remove tags from one contact.", requiredScopes: ["contacts.write"], riskLevel: "medium", destructive: true, requiresLocationId: false, payloadSchema: { tags: "array" } }),
  endpoint({ key: "location.tags.list", group: "tags", method: "GET", path: "/locations/:locationId/tags", description: "List location tags.", requiredScopes: ["locations/tags.readonly"], requiresLocationId: false, docs: "https://marketplace.gohighlevel.com/docs/ghl/locations/get-location-tags/" }),
  endpoint({ key: "location.tags.create", group: "tags", method: "POST", path: "/locations/:locationId/tags", description: "Create a location tag.", requiredScopes: ["locations/tags.write"], riskLevel: "medium", requiresLocationId: false, docs: "https://marketplace.gohighlevel.com/docs/ghl/locations/create-tag" }),
  endpoint({ key: "location.tags.get", group: "tags", method: "GET", path: "/locations/:locationId/tags/:tagId", description: "Get one location tag.", requiredScopes: ["locations/tags.readonly"], requiresLocationId: false }),
  endpoint({ key: "location.tags.update", group: "tags", method: "PUT", path: "/locations/:locationId/tags/:tagId", description: "Update one location tag.", requiredScopes: ["locations/tags.write"], riskLevel: "medium", requiresLocationId: false }),
  endpoint({ key: "location.tags.delete", group: "tags", method: "DELETE", path: "/locations/:locationId/tags/:tagId", description: "Delete one location tag.", requiredScopes: ["locations/tags.write"], riskLevel: "high", destructive: true, requiresLocationId: false }),
  endpoint({ key: "tags.list.legacy", group: "tags", method: "GET", path: "/tags/", description: "List tags with legacy-compatible path.", requiredScopes: ["locations/tags.readonly"] }),

  endpoint({ key: "contacts.notes.create", group: "notes", method: "POST", path: "/contacts/:contactId/notes", description: "Create a contact note.", requiredScopes: ["contacts.write"], riskLevel: "medium", requiresLocationId: false }),
  endpoint({ key: "contacts.notes.list", group: "notes", method: "GET", path: "/contacts/:contactId/notes", description: "List notes for one contact.", requiredScopes: ["contacts.readonly"], requiresLocationId: false }),
  endpoint({ key: "contacts.notes.update", group: "notes", method: "PUT", path: "/contacts/:contactId/notes/:noteId", description: "Update a contact note.", requiredScopes: ["contacts.write"], riskLevel: "medium", requiresLocationId: false }),
  endpoint({ key: "contacts.notes.delete", group: "notes", method: "DELETE", path: "/contacts/:contactId/notes/:noteId", description: "Delete a contact note.", requiredScopes: ["contacts.write"], riskLevel: "high", destructive: true, requiresLocationId: false }),
  endpoint({ key: "contacts.tasks.create", group: "tasks", method: "POST", path: "/contacts/:contactId/tasks", description: "Create a contact task.", requiredScopes: ["contacts.write"], riskLevel: "medium", requiresLocationId: false }),
  endpoint({ key: "contacts.tasks.list", group: "tasks", method: "GET", path: "/contacts/:contactId/tasks", description: "List tasks for one contact.", requiredScopes: ["contacts.readonly"], requiresLocationId: false }),
  endpoint({ key: "contacts.tasks.update", group: "tasks", method: "PUT", path: "/contacts/:contactId/tasks/:taskId", description: "Update a contact task.", requiredScopes: ["contacts.write"], riskLevel: "medium", requiresLocationId: false }),
  endpoint({ key: "contacts.tasks.delete", group: "tasks", method: "DELETE", path: "/contacts/:contactId/tasks/:taskId", description: "Delete a contact task.", requiredScopes: ["contacts.write"], riskLevel: "high", destructive: true, requiresLocationId: false }),
  endpoint({ key: "locations.tasks.search", group: "tasks", method: "POST", path: "/locations/:locationId/tasks/search", description: "Search location tasks.", requiredScopes: ["locations/tasks.readonly"], readOnly: true, approvalRequired: false, requiresLocationId: false, docs: "https://marketplace.gohighlevel.com/docs/ghl/locations/task-search/" }),

  endpoint({ key: "contacts.campaign.add", group: "campaigns", method: "POST", path: "/contacts/:contactId/campaigns/:campaignId", description: "Add one contact to a campaign.", requiredScopes: ["contacts.write"], riskLevel: "medium", requiresLocationId: false }),
  endpoint({ key: "contacts.campaign.remove", group: "campaigns", method: "DELETE", path: "/contacts/:contactId/campaigns/:campaignId", description: "Remove one contact from a campaign.", requiredScopes: ["contacts.write"], riskLevel: "medium", destructive: true, requiresLocationId: false }),

  endpoint({ key: "contacts.workflow.add", group: "workflows", method: "POST", path: "/contacts/:contactId/workflow/:workflowId", description: "Add one contact to an existing workflow.", requiredScopes: ["workflows.write"], riskLevel: "high", requiresLocationId: false }),
  endpoint({ key: "contacts.workflow.remove", group: "workflows", method: "DELETE", path: "/contacts/:contactId/workflow/:workflowId", description: "Remove one contact from a workflow.", requiredScopes: ["workflows.write"], riskLevel: "high", destructive: true, requiresLocationId: false }),
  endpoint({ key: "workflows.list", group: "workflows", method: "GET", path: "/workflows/", description: "List workflows.", requiredScopes: ["workflows.readonly"] }),

  endpoint({ key: "opportunities.search", group: "opportunities", method: "GET", path: "/opportunities/search", description: "Search opportunities.", requiredScopes: ["opportunities.readonly"], locationParam: "location_id", docs: "https://marketplace.gohighlevel.com/docs/ghl/opportunities/search-opportunities-advanced/" }),
  endpoint({ key: "opportunities.search.post", group: "opportunities", method: "POST", path: "/opportunities/search", description: "Search opportunities with filters.", requiredScopes: ["opportunities.readonly"], readOnly: true, approvalRequired: false, locationParam: "location_id" }),
  endpoint({ key: "opportunities.get", group: "opportunities", method: "GET", path: "/opportunities/:id", description: "Get one opportunity.", requiredScopes: ["opportunities.readonly"], requiresLocationId: false }),
  endpoint({ key: "opportunities.create", group: "opportunities", method: "POST", path: "/opportunities/", description: "Create one opportunity.", requiredScopes: ["opportunities.write"], riskLevel: "medium" }),
  endpoint({ key: "opportunities.upsert", group: "opportunities", method: "POST", path: "/opportunities/upsert", description: "Create or update one opportunity.", requiredScopes: ["opportunities.write"], riskLevel: "medium" }),
  endpoint({ key: "opportunities.update", group: "opportunities", method: "PUT", path: "/opportunities/:opportunityId", description: "Update one opportunity.", requiredScopes: ["opportunities.write"], riskLevel: "medium", requiresLocationId: false }),
  endpoint({ key: "opportunities.delete", group: "opportunities", method: "DELETE", path: "/opportunities/:opportunityId", description: "Delete one opportunity.", requiredScopes: ["opportunities.write"], riskLevel: "high", destructive: true, requiresLocationId: false }),
  endpoint({ key: "opportunities.pipelines.list", group: "pipelines", method: "GET", path: "/opportunities/pipelines", description: "List pipelines and stages.", requiredScopes: ["opportunities.readonly"] }),
  endpoint({ key: "opportunities.pipelines.create", group: "pipelines", method: "POST", path: "/opportunities/pipelines", description: "Create a pipeline.", requiredScopes: ["opportunities.write"], riskLevel: "high" }),
  endpoint({ key: "opportunities.pipelines.update", group: "pipelines", method: "PUT", path: "/opportunities/pipelines/:pipelineId", description: "Update a pipeline.", requiredScopes: ["opportunities.write"], riskLevel: "high", requiresLocationId: false }),
  endpoint({ key: "opportunities.pipelines.delete", group: "pipelines", method: "DELETE", path: "/opportunities/pipelines/:pipelineId", description: "Delete a pipeline.", requiredScopes: ["opportunities.write"], riskLevel: "high", destructive: true, requiresLocationId: false, enabled: false }),

  endpoint({
    key: "users.search",
    group: "users",
    method: "GET",
    path: "/users/search",
    description: "Search users/team members.",
    requiredScopes: ["users.readonly"],
    requiresLocationId: false,
    payloadSchema: { companyId: "string", query: "string", limit: "number" },
    docs: "https://marketplace.gohighlevel.com/docs/ghl/users/search-users/",
  }),
  endpoint({
    key: "users.location.list",
    group: "users",
    method: "GET",
    path: "/users/",
    description: "List users/team members for a configured location.",
    requiredScopes: ["users.readonly"],
    payloadSchema: { locationId: "string" },
    docs: "https://marketplace.gohighlevel.com/docs/ghl/users/get-user-by-location",
  }),
  endpoint({
    key: "users.location.invalid",
    group: "users",
    method: "GET",
    path: "/locations/:locationId/users",
    description: "Invalid legacy location-user lookup path. Disabled because current GHL user search requires companyId.",
    requiredScopes: ["users.readonly"],
    requiresLocationId: false,
    enabled: false,
  }),
  endpoint({ key: "users.update", group: "users", method: "PUT", path: "/users/:userId", description: "Update a user/team member.", requiredScopes: ["users.write"], riskLevel: "high", requiresLocationId: false, enabled: false }),

  endpoint({ key: "calendars.list", group: "calendars", method: "GET", path: "/calendars/", description: "List calendars.", requiredScopes: ["calendars.readonly"], docs: "https://marketplace.gohighlevel.com/docs/ghl/calendars/get-calendars/" }),
  endpoint({ key: "calendars.events.list", group: "calendars", method: "GET", path: "/calendars/events", description: "List calendar events.", requiredScopes: ["calendars/events.readonly"] }),
  endpoint({ key: "calendars.appointments.create", group: "calendars", method: "POST", path: "/calendars/events/appointments", description: "Create an appointment.", requiredScopes: ["calendars/events.write"], riskLevel: "high" }),
  endpoint({ key: "calendars.appointments.update", group: "calendars", method: "PUT", path: "/calendars/events/appointments/:appointmentId", description: "Update an appointment.", requiredScopes: ["calendars/events.write"], riskLevel: "high" }),
  endpoint({ key: "calendars.appointments.delete", group: "calendars", method: "DELETE", path: "/calendars/events/appointments/:appointmentId", description: "Delete an appointment.", requiredScopes: ["calendars/events.write"], riskLevel: "high", destructive: true }),
  endpoint({ key: "calendars.availability.update", group: "calendars", method: "PUT", path: "/calendars/:calendarId/availability", description: "Update calendar availability.", requiredScopes: ["calendars.write"], riskLevel: "high", enabled: false }),

  endpoint({ key: "conversations.search", group: "conversations", method: "GET", path: "/conversations/search", description: "Search conversations.", requiredScopes: ["conversations.readonly"] }),
  endpoint({ key: "conversations.list", group: "conversations", method: "GET", path: "/conversations/", description: "List conversations.", requiredScopes: ["conversations.readonly"] }),
  endpoint({ key: "conversations.messages.list", group: "conversations", method: "GET", path: "/conversations/:conversationId/messages", description: "List messages for one conversation.", requiredScopes: ["conversations/message.readonly"], requiresLocationId: false, docs: "https://marketplace.gohighlevel.com/docs/ghl/conversations/get-messages/" }),
  endpoint({ key: "conversations.messages.send", group: "conversations", method: "POST", path: "/conversations/messages", description: "Send one conversation message.", requiredScopes: ["conversations/message.write"], riskLevel: "high" }),

  endpoint({ key: "locations.get", group: "locations", method: "GET", path: "/locations/:locationId", description: "Get location/sub-account details.", requiredScopes: ["locations.readonly"], requiresLocationId: false }),
  endpoint({ key: "locations.custom_fields.list", group: "custom_fields", method: "GET", path: "/locations/:locationId/customFields", description: "List custom fields.", requiredScopes: ["locations/customFields.readonly"], requiresLocationId: false, docs: "https://marketplace.gohighlevel.com/docs/ghl/locations/get-custom-fields/" }),
  endpoint({ key: "locations.custom_fields.create", group: "custom_fields", method: "POST", path: "/locations/:locationId/customFields", description: "Create a custom field.", requiredScopes: ["locations/customFields.write"], riskLevel: "medium", requiresLocationId: false }),
  endpoint({ key: "locations.custom_fields.get", group: "custom_fields", method: "GET", path: "/locations/:locationId/customFields/:id", description: "Get one custom field.", requiredScopes: ["locations/customFields.readonly"], requiresLocationId: false }),
  endpoint({ key: "locations.custom_fields.update", group: "custom_fields", method: "PUT", path: "/locations/:locationId/customFields/:id", description: "Update a custom field.", requiredScopes: ["locations/customFields.write"], riskLevel: "medium", requiresLocationId: false }),
  endpoint({ key: "locations.custom_fields.delete", group: "custom_fields", method: "DELETE", path: "/locations/:locationId/customFields/:id", description: "Delete a custom field.", requiredScopes: ["locations/customFields.write"], riskLevel: "high", destructive: true, requiresLocationId: false }),
  endpoint({ key: "locations.custom_fields.legacy", group: "custom_fields", method: "GET", path: "/locations/customFields", description: "List custom fields with legacy-compatible path.", requiredScopes: ["locations/customFields.readonly"] }),

  endpoint({ key: "locations.custom_values.list", group: "custom_values", method: "GET", path: "/locations/:locationId/customValues", description: "List custom values.", requiredScopes: ["locations/customValues.readonly"], requiresLocationId: false, docs: "https://marketplace.gohighlevel.com/docs/ghl/locations/get-custom-values" }),
  endpoint({ key: "locations.custom_values.create", group: "custom_values", method: "POST", path: "/locations/:locationId/customValues", description: "Create a custom value.", requiredScopes: ["locations/customValues.write"], riskLevel: "medium", requiresLocationId: false, docs: "https://marketplace.gohighlevel.com/docs/ghl/locations/create-custom-value" }),
  endpoint({ key: "locations.custom_values.get", group: "custom_values", method: "GET", path: "/locations/:locationId/customValues/:id", description: "Get one custom value.", requiredScopes: ["locations/customValues.readonly"], requiresLocationId: false }),
  endpoint({ key: "locations.custom_values.update", group: "custom_values", method: "PUT", path: "/locations/:locationId/customValues/:id", description: "Update a custom value.", requiredScopes: ["locations/customValues.write"], riskLevel: "medium", requiresLocationId: false }),
  endpoint({ key: "locations.custom_values.delete", group: "custom_values", method: "DELETE", path: "/locations/:locationId/customValues/:id", description: "Delete a custom value.", requiredScopes: ["locations/customValues.write"], riskLevel: "high", destructive: true, requiresLocationId: false }),

  endpoint({ key: "forms.list", group: "forms", method: "GET", path: "/forms/", description: "List forms.", requiredScopes: ["forms.readonly"], docs: "https://marketplace.gohighlevel.com/docs/ghl/forms/get-forms/" }),
  endpoint({ key: "forms.submissions.list", group: "forms", method: "GET", path: "/forms/submissions", description: "List form submissions.", requiredScopes: ["forms.readonly"] }),
  endpoint({ key: "surveys.list", group: "surveys", method: "GET", path: "/surveys/", description: "List surveys.", requiredScopes: ["surveys.readonly"], docs: "https://marketplace.gohighlevel.com/docs/ghl/surveys/get-surveys/" }),
  endpoint({ key: "surveys.submissions.list", group: "surveys", method: "GET", path: "/surveys/submissions", description: "List survey submissions.", requiredScopes: ["surveys.readonly"] }),

  endpoint({ key: "campaigns.list", group: "campaigns", method: "GET", path: "/campaigns/", description: "List GHL campaigns if the token can access this API.", requiredScopes: ["campaigns.readonly"] }),

  endpoint({ key: "phone.system.read", group: "phone", method: "GET", path: "/phone-system/:locationId/settings", description: "Read LC Phone/SMS settings when available.", requiredScopes: ["phone.readonly"], requiresLocationId: false, enabled: false }),
  endpoint({ key: "email.reputation.read", group: "email", method: "GET", path: "/emails/reputation", description: "Read email reputation settings when available.", requiredScopes: ["emails.readonly"], enabled: false }),

  endpoint({ key: "deprecated.contacts.list", group: "contacts", method: "GET", path: "/contacts/", description: "Deprecated contact listing endpoint.", requiredScopes: ["contacts.readonly"], deprecated: true, enabled: false }),
];

function pathTemplateToRegex(template) {
  const cleanTemplate = cleanString(template).replace(/\/+$/g, "") || "/";
  const segments = cleanTemplate.split("/").map((segment) => {
    if (segment.startsWith(":")) {
      return `(?<${segment.slice(1)}>[^/]+)`;
    }
    return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return new RegExp(`^${segments.join("/") || "/"}\\/?$`);
}

function normalizePath(path) {
  const clean = cleanString(path);
  if (!clean.startsWith("/") || clean.includes("://")) {
    const error = new Error("GHL path must be a relative API path.");
    error.statusCode = 400;
    throw error;
  }
  return clean.replace(/\/{2,}/g, "/");
}

function findEndpoint({ method, path }) {
  const upperMethod = cleanString(method || "GET").toUpperCase();
  const cleanPath = normalizePath(path);
  for (const item of ENDPOINTS) {
    if (item.method !== upperMethod) continue;
    const match = cleanPath.replace(/\/+$/g, "").match(pathTemplateToRegex(item.path));
    if (match) {
      return {
        endpoint: item,
        params: match.groups || {},
      };
    }
  }
  return null;
}

function registryByCapability() {
  return ENDPOINTS.reduce((groups, item) => {
    if (!groups[item.group]) groups[item.group] = [];
    groups[item.group].push(item);
    return groups;
  }, {});
}

function registryStats() {
  const stats = {
    total: ENDPOINTS.length,
    enabled: 0,
    disabled: 0,
    deprecated: 0,
    read: 0,
    write: 0,
    highRisk: 0,
    destructive: 0,
    groups: {},
  };

  for (const item of ENDPOINTS) {
    if (item.enabled && !item.deprecated) stats.enabled += 1;
    if (!item.enabled) stats.disabled += 1;
    if (item.deprecated) stats.deprecated += 1;
    if (item.riskCategory === "read") stats.read += 1;
    if (item.riskCategory === "write") stats.write += 1;
    if (item.riskCategory === "high-risk") stats.highRisk += 1;
    if (item.riskCategory === "destructive") stats.destructive += 1;
    if (!stats.groups[item.group]) {
      stats.groups[item.group] = { total: 0, enabled: 0, write: 0, highRisk: 0, destructive: 0 };
    }
    stats.groups[item.group].total += 1;
    if (item.enabled && !item.deprecated) stats.groups[item.group].enabled += 1;
    if (item.riskCategory === "write") stats.groups[item.group].write += 1;
    if (item.riskCategory === "high-risk") stats.groups[item.group].highRisk += 1;
    if (item.riskCategory === "destructive") stats.groups[item.group].destructive += 1;
  }

  return stats;
}

function registrySummary() {
  return ENDPOINTS.filter((item) => item.enabled && !item.deprecated)
    .map((item) => `- ${item.method} ${item.path}: ${item.description} [${item.riskCategory}]`)
    .join("\n");
}

module.exports = {
  DESTRUCTIVE_CONFIRMATION_PHRASE,
  ENDPOINTS,
  HIGH_RISK_CONFIRMATION_PHRASE,
  findEndpoint,
  normalizePath,
  registryByCapability,
  registryStats,
  registrySummary,
};
