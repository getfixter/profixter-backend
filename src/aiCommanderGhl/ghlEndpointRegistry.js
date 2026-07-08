const DESTRUCTIVE_CONFIRMATION_PHRASE = "CONFIRM GHL DESTRUCTIVE";

function cleanString(value) {
  return String(value ?? "").trim();
}

function endpoint({
  key,
  group,
  method,
  path,
  description,
  riskLevel = "low",
  destructive = false,
  readOnly = false,
  requiresExtraConfirmation = false,
  requiresLocationId = true,
  locationParam = "locationId",
  deprecated = false,
  enabled = true,
}) {
  return {
    key,
    group,
    method: String(method || "GET").toUpperCase(),
    path,
    description,
    riskLevel,
    destructive,
    readOnly: readOnly || ["GET", "HEAD"].includes(String(method || "GET").toUpperCase()),
    requiresExtraConfirmation,
    requiresLocationId,
    locationParam,
    deprecated,
    enabled,
  };
}

const ENDPOINTS = [
  endpoint({ key: "contacts.search", group: "contacts", method: "POST", path: "/contacts/search", description: "Search contacts.", readOnly: true }),
  endpoint({ key: "contacts.get", group: "contacts", method: "GET", path: "/contacts/:contactId", description: "Get one contact.", requiresLocationId: false }),
  endpoint({ key: "contacts.create", group: "contacts", method: "POST", path: "/contacts/", description: "Create one contact.", riskLevel: "medium" }),
  endpoint({ key: "contacts.upsert", group: "contacts", method: "POST", path: "/contacts/upsert", description: "Create or update one contact.", riskLevel: "medium" }),
  endpoint({ key: "contacts.update", group: "contacts", method: "PUT", path: "/contacts/:contactId", description: "Update one contact.", riskLevel: "medium", requiresLocationId: false }),
  endpoint({ key: "contacts.delete", group: "contacts", method: "DELETE", path: "/contacts/:contactId", description: "Delete one contact.", riskLevel: "high", destructive: true, requiresExtraConfirmation: true, requiresLocationId: false }),
  endpoint({ key: "contacts.add_tags", group: "tags", method: "POST", path: "/contacts/:contactId/tags", description: "Add tags to one contact.", riskLevel: "medium", requiresLocationId: false }),
  endpoint({ key: "contacts.remove_tags", group: "tags", method: "DELETE", path: "/contacts/:contactId/tags", description: "Remove tags from one contact.", riskLevel: "medium", destructive: true, requiresLocationId: false }),
  endpoint({ key: "contacts.notes.create", group: "notes", method: "POST", path: "/contacts/:contactId/notes", description: "Create a contact note.", riskLevel: "medium", requiresLocationId: false }),
  endpoint({ key: "contacts.notes.list", group: "notes", method: "GET", path: "/contacts/:contactId/notes", description: "List notes for one contact.", requiresLocationId: false }),
  endpoint({ key: "contacts.notes.update", group: "notes", method: "PUT", path: "/contacts/:contactId/notes/:noteId", description: "Update a contact note.", riskLevel: "medium", requiresLocationId: false }),
  endpoint({ key: "contacts.notes.delete", group: "notes", method: "DELETE", path: "/contacts/:contactId/notes/:noteId", description: "Delete a contact note.", riskLevel: "high", destructive: true, requiresExtraConfirmation: true, requiresLocationId: false }),
  endpoint({ key: "contacts.tasks.create", group: "tasks", method: "POST", path: "/contacts/:contactId/tasks", description: "Create a contact task.", riskLevel: "medium", requiresLocationId: false }),
  endpoint({ key: "contacts.tasks.list", group: "tasks", method: "GET", path: "/contacts/:contactId/tasks", description: "List tasks for one contact.", requiresLocationId: false }),
  endpoint({ key: "contacts.tasks.update", group: "tasks", method: "PUT", path: "/contacts/:contactId/tasks/:taskId", description: "Update a contact task.", riskLevel: "medium", requiresLocationId: false }),
  endpoint({ key: "contacts.tasks.delete", group: "tasks", method: "DELETE", path: "/contacts/:contactId/tasks/:taskId", description: "Delete a contact task.", riskLevel: "high", destructive: true, requiresExtraConfirmation: true, requiresLocationId: false }),
  endpoint({ key: "contacts.campaign.add", group: "campaigns", method: "POST", path: "/contacts/:contactId/campaigns/:campaignId", description: "Add one contact to a campaign.", riskLevel: "medium", requiresLocationId: false }),
  endpoint({ key: "contacts.campaign.remove", group: "campaigns", method: "DELETE", path: "/contacts/:contactId/campaigns/:campaignId", description: "Remove one contact from a campaign.", riskLevel: "medium", destructive: true, requiresLocationId: false }),
  endpoint({ key: "contacts.workflow.add", group: "workflows", method: "POST", path: "/contacts/:contactId/workflow/:workflowId", description: "Add one contact to an existing workflow.", riskLevel: "high", requiresExtraConfirmation: true, requiresLocationId: false }),
  endpoint({ key: "contacts.workflow.remove", group: "workflows", method: "DELETE", path: "/contacts/:contactId/workflow/:workflowId", description: "Remove one contact from a workflow.", riskLevel: "high", destructive: true, requiresExtraConfirmation: true, requiresLocationId: false }),

  endpoint({ key: "tags.list", group: "tags", method: "GET", path: "/tags/", description: "List tags." }),
  endpoint({ key: "location.tags.list", group: "tags", method: "GET", path: "/locations/:locationId/tags", description: "List location tags.", requiresLocationId: false }),

  endpoint({ key: "opportunities.search", group: "opportunities", method: "GET", path: "/opportunities/search", description: "Search opportunities.", locationParam: "location_id" }),
  endpoint({ key: "opportunities.search.post", group: "opportunities", method: "POST", path: "/opportunities/search", description: "Search opportunities with filters.", readOnly: true, locationParam: "location_id" }),
  endpoint({ key: "opportunities.create", group: "opportunities", method: "POST", path: "/opportunities/", description: "Create one opportunity.", riskLevel: "medium" }),
  endpoint({ key: "opportunities.upsert", group: "opportunities", method: "POST", path: "/opportunities/upsert", description: "Create or update one opportunity.", riskLevel: "medium" }),
  endpoint({ key: "opportunities.update", group: "opportunities", method: "PUT", path: "/opportunities/:opportunityId", description: "Update one opportunity.", riskLevel: "medium", requiresLocationId: false }),
  endpoint({ key: "opportunities.delete", group: "opportunities", method: "DELETE", path: "/opportunities/:opportunityId", description: "Delete one opportunity.", riskLevel: "high", destructive: true, requiresExtraConfirmation: true, requiresLocationId: false }),
  endpoint({ key: "opportunities.pipelines.list", group: "pipelines", method: "GET", path: "/opportunities/pipelines", description: "List pipelines and stages." }),
  endpoint({ key: "opportunities.pipelines.create", group: "pipelines", method: "POST", path: "/opportunities/pipelines", description: "Create a pipeline.", riskLevel: "high", requiresExtraConfirmation: true }),

  endpoint({ key: "users.search", group: "users", method: "GET", path: "/users/search", description: "Search users/team members." }),
  endpoint({ key: "users.location.list", group: "users", method: "GET", path: "/locations/:locationId/users", description: "List location users.", requiresLocationId: false }),

  endpoint({ key: "calendars.list", group: "calendars", method: "GET", path: "/calendars/", description: "List calendars." }),
  endpoint({ key: "calendars.events.list", group: "calendars", method: "GET", path: "/calendars/events", description: "List calendar events." }),
  endpoint({ key: "calendars.appointments.create", group: "calendars", method: "POST", path: "/calendars/events/appointments", description: "Create an appointment.", riskLevel: "high" }),
  endpoint({ key: "calendars.appointments.update", group: "calendars", method: "PUT", path: "/calendars/events/appointments/:appointmentId", description: "Update an appointment.", riskLevel: "high" }),
  endpoint({ key: "calendars.appointments.delete", group: "calendars", method: "DELETE", path: "/calendars/events/appointments/:appointmentId", description: "Delete an appointment.", riskLevel: "high", destructive: true, requiresExtraConfirmation: true }),
  endpoint({ key: "calendars.availability.update", group: "calendars", method: "PUT", path: "/calendars/:calendarId/availability", description: "Update calendar availability.", riskLevel: "high", requiresExtraConfirmation: true, enabled: false }),

  endpoint({ key: "conversations.search", group: "conversations", method: "GET", path: "/conversations/search", description: "Search conversations." }),
  endpoint({ key: "conversations.list", group: "conversations", method: "GET", path: "/conversations/", description: "List conversations." }),
  endpoint({ key: "conversations.messages.send", group: "conversations", method: "POST", path: "/conversations/messages", description: "Send one conversation message.", riskLevel: "high", requiresExtraConfirmation: true }),

  endpoint({ key: "workflows.list", group: "workflows", method: "GET", path: "/workflows/", description: "List workflows." }),

  endpoint({ key: "locations.get", group: "locations", method: "GET", path: "/locations/:locationId", description: "Get location/sub-account details.", requiresLocationId: false }),
  endpoint({ key: "locations.custom_fields.list", group: "locations", method: "GET", path: "/locations/:locationId/customFields", description: "List custom fields.", requiresLocationId: false }),
  endpoint({ key: "locations.custom_fields.legacy", group: "locations", method: "GET", path: "/locations/customFields", description: "List custom fields.", deprecated: false }),

  endpoint({ key: "deprecated.contacts.list", group: "contacts", method: "GET", path: "/contacts/", description: "Deprecated contact listing endpoint.", deprecated: true, enabled: false }),
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

function registrySummary() {
  return ENDPOINTS.filter((item) => item.enabled && !item.deprecated)
    .map((item) => `- ${item.method} ${item.path}: ${item.description}`)
    .join("\n");
}

module.exports = {
  DESTRUCTIVE_CONFIRMATION_PHRASE,
  ENDPOINTS,
  findEndpoint,
  normalizePath,
  registrySummary,
};
