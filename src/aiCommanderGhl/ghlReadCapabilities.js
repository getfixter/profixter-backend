const {
  extractCompanyId,
  getCompanyIdFromEnv,
  getLocationId,
  getSafeGhlDiagnostics,
  request,
  redact,
} = require("./ghlClient");
const { cleanString } = require("./ghlActions");

const DEFAULT_TIMEOUT_MS = Number(process.env.JARVIS_GHL_CAPABILITY_TIMEOUT_MS || 8000);
const CONTACT_TIMEOUT_MS = Number(process.env.JARVIS_GHL_CONTACT_READ_TIMEOUT_MS || 20000);

function compact(value) {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => {
      if (Array.isArray(item)) return item.length > 0;
      return item !== undefined && item !== null && cleanString(item) !== "";
    })
  );
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function firstNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function collectionFrom(data, keys) {
  for (const key of keys) {
    const value = key.split(".").reduce((current, part) => current?.[part], data);
    if (Array.isArray(value)) return value;
  }
  return [];
}

function totalFrom(data, items) {
  return firstNumber(
    data?.total,
    data?.totalCount,
    data?.count,
    data?.meta?.total,
    data?.meta?.totalCount,
    data?.meta?.count,
    data?.pagination?.total,
    data?.pagination?.totalCount,
    data?.contactsCount,
    data?.opportunitiesCount,
    data?.conversationsCount
  ) ?? null;
}

function endpointFrom(result, fallback) {
  return cleanString(result?.request?.endpoint || fallback);
}

function errorMessage(error) {
  return cleanString(error?.message || error) || "GHL read failed";
}

function sanitizeError(error) {
  const status = Number(error?.ghlStatus || error?.statusCode || error?.status || 0);
  return {
    type: classifyFailure(error),
    statusCode: error?.statusCode || null,
    ghlStatus: error?.ghlStatus || null,
    code: cleanString(error?.response?.code || error?.response?.error || error?.code),
    message: errorMessage(error)
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]"),
    retryable: status >= 500 || /timeout|timed out|socket hang up|abort/i.test(errorMessage(error)),
  };
}

function classifyFailure(error) {
  const status = Number(error?.ghlStatus || error?.statusCode || error?.status || 0);
  const message = errorMessage(error);
  if (/Missing GHL_AI_COMMANDER_TOKEN/i.test(message)) return "configuration_missing_token";
  if (/Missing GHL_LOCATION_ID/i.test(message)) return "configuration_missing_location";
  if (/timeout|timed out|etimedout|socket hang up|network timeout|abort/i.test(message)) {
    return "timeout";
  }
  if (status === 401 || status === 403) return "permission_denied";
  if (status === 404) return "endpoint_unavailable";
  if (status === 400 || status === 422) return "request_rejected";
  if (status >= 500) return "ghl_unavailable";
  return "read_failed";
}

async function readOnlyRequest(input) {
  return request({
    timeoutMs: DEFAULT_TIMEOUT_MS,
    logResponseBody: false,
    ...input,
  });
}

function buildTimeRange() {
  const start = new Date();
  const end = new Date(start.getTime() + 30 * 24 * 60 * 60 * 1000);
  return {
    startTime: start.toISOString(),
    endTime: end.toISOString(),
  };
}

function buildCapabilityDefinitions(locationId, companyId = "") {
  const encodedLocationId = encodeURIComponent(locationId);
  const eventRange = buildTimeRange();
  const cleanCompanyId = cleanString(companyId);

  return [
    {
      key: "contacts",
      label: "Contacts",
      collectionKeys: ["contacts", "data", "items"],
      requests: [
        {
          method: "POST",
          path: "/contacts/search",
          timeoutMs: CONTACT_TIMEOUT_MS,
          body: { locationId, page: 1, pageLimit: 1 },
        },
      ],
    },
    {
      key: "opportunities",
      label: "Opportunities",
      collectionKeys: ["opportunities", "data", "items"],
      requests: [
        {
          method: "GET",
          path: "/opportunities/search",
          query: { location_id: locationId, limit: 1, page: 1 },
        },
        {
          method: "POST",
          path: "/opportunities/search",
          body: { locationId, page: 1, pageLimit: 1 },
        },
      ],
    },
    {
      key: "pipelines",
      label: "Pipelines and stages",
      collectionKeys: ["pipelines", "data", "items"],
      requests: [
        {
          method: "GET",
          path: "/opportunities/pipelines",
          query: { locationId },
        },
      ],
    },
    {
      key: "tags",
      label: "Tags",
      collectionKeys: ["tags", "data", "items"],
      requests: [
        { method: "GET", path: `/locations/${encodedLocationId}/tags` },
        { method: "GET", path: "/tags/", query: { locationId } },
      ],
    },
    {
      key: "conversations",
      label: "Conversations and messages",
      collectionKeys: ["conversations", "data", "items"],
      requests: [
        { method: "GET", path: "/conversations/search", query: { locationId, limit: 1 } },
        { method: "GET", path: "/conversations/", query: { locationId, limit: 1 } },
      ],
    },
    {
      key: "workflows",
      label: "Workflows",
      collectionKeys: ["workflows", "data", "items"],
      requests: [{ method: "GET", path: "/workflows/", query: { locationId } }],
    },
    {
      key: "tasks",
      label: "Tasks",
      collectionKeys: ["tasks", "data", "items"],
      requests: [
        {
          method: "POST",
          path: `/locations/${encodedLocationId}/tasks/search`,
          body: { page: 1, pageLimit: 1 },
        },
      ],
    },
    {
      key: "calendars",
      label: "Calendars",
      collectionKeys: ["calendars", "data", "items"],
      requests: [{ method: "GET", path: "/calendars/", query: { locationId } }],
    },
    {
      key: "appointments",
      label: "Appointments",
      collectionKeys: ["events", "appointments", "data", "items"],
      requests: [
        { method: "GET", path: "/calendars/events", query: { locationId, ...eventRange } },
        {
          method: "GET",
          path: "/calendars/events/appointments",
          query: { locationId, ...eventRange },
        },
      ],
    },
    {
      key: "users",
      label: "Users and team members",
      collectionKeys: ["users", "teamMembers", "data", "items"],
      requests: [
        ...(cleanCompanyId
          ? [
              {
                method: "GET",
                path: "/users/search",
                query: { companyId: cleanCompanyId, limit: 1 },
              },
            ]
          : []),
        { method: "GET", path: "/users/", query: { locationId } },
      ],
    },
    {
      key: "custom_fields",
      label: "Custom fields",
      collectionKeys: ["customFields", "fields", "data", "items"],
      requests: [
        { method: "GET", path: `/locations/${encodedLocationId}/customFields` },
        { method: "GET", path: "/locations/customFields", query: { locationId } },
      ],
    },
    {
      key: "custom_values",
      label: "Custom values",
      collectionKeys: ["customValues", "values", "data", "items"],
      requests: [
        { method: "GET", path: `/locations/${encodedLocationId}/customValues` },
      ],
    },
    {
      key: "campaigns",
      label: "Campaigns",
      collectionKeys: ["campaigns", "data", "items"],
      requests: [{ method: "GET", path: "/campaigns/", query: { locationId } }],
    },
    {
      key: "forms",
      label: "Forms",
      collectionKeys: ["forms", "data", "items"],
      requests: [{ method: "GET", path: "/forms/", query: { locationId } }],
    },
    {
      key: "surveys",
      label: "Surveys",
      collectionKeys: ["surveys", "data", "items"],
      requests: [{ method: "GET", path: "/surveys/", query: { locationId } }],
    },
    {
      key: "location",
      label: "Location/account info",
      collectionKeys: ["locations", "data", "items"],
      requests: [{ method: "GET", path: `/locations/${encodedLocationId}` }],
    },
  ];
}

function summarizeResult(capability, result, requestInput) {
  const items = collectionFrom(result.data, capability.collectionKeys);
  const total = totalFrom(result.data, items);
  const exact = total !== null;
  return {
    key: capability.key,
    label: capability.label,
    status: "working",
    endpointUsed: endpointFrom(
      result,
      `${requestInput.method} ${requestInput.path}`
    ),
    resultShape: {
      itemCount: items.length,
      total,
      exactCountAvailable: exact,
      paginationNeeded: !exact && items.length > 0,
    },
  };
}

async function probeCapability(capability) {
  let lastError = null;
  if (!capability.requests.length) {
    return {
      key: capability.key,
      label: capability.label,
      status: "failing",
      endpointUsed: "",
      reason: "configuration_missing_company_id",
      error: {
        type: "configuration_missing_company_id",
        statusCode: 500,
        ghlStatus: null,
        code: "",
        message: "GHL user search requires companyId.",
        retryable: false,
      },
    };
  }

  for (const requestInput of capability.requests) {
    try {
      const result = await readOnlyRequest(requestInput);
      return summarizeResult(capability, result, requestInput);
    } catch (error) {
      lastError = error;
    }
  }

  const error = sanitizeError(lastError);
  return {
    key: capability.key,
    label: capability.label,
    status: "failing",
    endpointUsed: capability.requests.map((item) => `${item.method} ${item.path}`).join(" -> "),
    reason: error.type,
    error,
  };
}

async function resolveCompanyIdForCapabilities(locationId) {
  const configured = getCompanyIdFromEnv();
  if (configured) return configured;

  try {
    const result = await readOnlyRequest({
      method: "GET",
      path: `/locations/${encodeURIComponent(locationId)}`,
    });
    return extractCompanyId(result.data);
  } catch {
    return "";
  }
}

async function auditGhlCapabilities() {
  const diagnostics = getSafeGhlDiagnostics();
  let locationId = "";
  try {
    locationId = getLocationId();
  } catch (error) {
    const errorDetails = sanitizeError(error);
    return {
      diagnostics,
      working: [],
      failing: buildCapabilityDefinitions("missing-location").map((capability) => ({
        key: capability.key,
        label: capability.label,
        status: "failing",
        endpointUsed: capability.requests.map((item) => `${item.method} ${item.path}`).join(" -> "),
        reason: errorDetails.type,
        error: errorDetails,
      })),
      capabilities: [],
    };
  }

  const companyId = await resolveCompanyIdForCapabilities(locationId);
  const definitions = buildCapabilityDefinitions(locationId, companyId);
  const settled = await Promise.all(definitions.map((capability) => probeCapability(capability)));
  const working = settled.filter((item) => item.status === "working");
  const failing = settled.filter((item) => item.status !== "working");

  return {
    diagnostics,
    working,
    failing,
    capabilities: settled.map((item) => redact(item)),
  };
}

module.exports = {
  auditGhlCapabilities,
  buildCapabilityDefinitions,
  classifyFailure,
  collectionFrom,
  compact,
  firstNumber,
  sanitizeError,
};
