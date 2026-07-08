const { getLocationId, getSafeTokenDiagnostics, request } = require("./ghlClient");
const { cleanString } = require("./ghlActions");
const { countCsvContacts: countCsvContactsFromContext, csvFilesFromContext } = require("./jarvisCsvProcessor");
const { auditEstimateCsvAgainstGhl } = require("./jarvisCsvGhlSync");
const { auditGhlCapabilities } = require("./ghlReadCapabilities");

const READ_TIMEOUT_MS = Number(process.env.JARVIS_GHL_READ_TIMEOUT_MS || 15000);
const CONTACT_READ_TIMEOUT_MS = Number(
  process.env.JARVIS_GHL_CONTACT_READ_TIMEOUT_MS || 20000
);
const CONTACT_PAGE_LIMIT = 100;
const CONTACT_MAX_PAGES = Number(process.env.JARVIS_CONTACT_READ_MAX_PAGES || 10);
const CONTACT_COUNT_SCAN_PAGES = Math.max(
  1,
  Math.min(
    CONTACT_MAX_PAGES,
    Number(process.env.JARVIS_CONTACT_COUNT_SCAN_PAGES || 1)
  )
);
const OPPORTUNITY_PAGE_LIMIT = 100;
const OPPORTUNITY_MAX_PAGES = Number(process.env.JARVIS_OPPORTUNITY_READ_MAX_PAGES || 10);
const CONVERSATION_PAGE_LIMIT = 100;
const CONTACT_SEARCH_ENDPOINT = "POST /contacts/search";
const LEGACY_CONTACTS_ENDPOINT = "GET /contacts/";
const POTENTIAL_CUSTOMER_TAGS = String(
  process.env.JARVIS_POTENTIAL_CUSTOMER_TAGS ||
    "Potential Customer,Potential Customers,Homeowner,Homeowners,Prospect,Lead"
)
  .split(",")
  .map((tag) => normalizeTag(tag))
  .filter(Boolean);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function compact(value) {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => {
      if (Array.isArray(item)) return item.length > 0;
      return item !== undefined && item !== null && cleanString(item) !== "";
    })
  );
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("en-US");
}

function normalizeTag(value) {
  return cleanString(value)
    .replace(/^["']+|["'.,?!]+$/g, "")
    .trim()
    .toLowerCase();
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
  ) ?? items.length;
}

function nextThirtyDayRange() {
  const start = new Date();
  const end = new Date(start.getTime() + 30 * 24 * 60 * 60 * 1000);
  return {
    startTime: start.toISOString(),
    endTime: end.toISOString(),
  };
}

async function readRequest(input) {
  return request({
    timeoutMs: READ_TIMEOUT_MS,
    logResponseBody: false,
    ...input,
  });
}

async function tryRead(requests) {
  let lastError = null;
  for (const item of requests) {
    try {
      return await readRequest(item);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function requestEndpoint(result, fallback = "") {
  return cleanString(result?.request?.endpoint || fallback);
}

function sanitizeReadError(error) {
  const message = cleanString(error?.message || error);
  return {
    statusCode: error?.statusCode || null,
    ghlStatus: error?.ghlStatus || null,
    message:
      message
        .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
        .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]") ||
      "GHL read failed",
    code: cleanString(error?.response?.code || error?.response?.error || error?.code),
  };
}

function contactsPermissionFromError(error) {
  const status = Number(error?.ghlStatus || error?.statusCode || error?.status || 0);
  if (status === 401 || status === 403) return "contacts_read_denied";
  if (status === 400 || status === 422) return "contacts_request_rejected";
  return "contacts_read_failed";
}

async function searchContactsPage({
  limit = CONTACT_PAGE_LIMIT,
  page = 0,
  filters = [],
  query = "",
} = {}) {
  const body = compact({
    locationId: getLocationId(),
    page: page + 1,
    pageLimit: limit,
    query,
    filters,
  });
  const result = await readRequest({
    method: "POST",
    path: "/contacts/search",
    timeoutMs: CONTACT_READ_TIMEOUT_MS,
    body,
  });
  const contacts = collectionFrom(result.data, ["contacts", "data", "items"]);
  return {
    contacts,
    total: totalFrom(result.data, contacts),
    endpointUsed: requestEndpoint(result, CONTACT_SEARCH_ENDPOINT),
    result,
  };
}

async function legacyContactsPage({ limit = CONTACT_PAGE_LIMIT, page = 0, query = {} } = {}) {
  const locationId = getLocationId();
  const skip = page * limit;
  const result = await readRequest({
    method: "GET",
    path: "/contacts/",
    timeoutMs: CONTACT_READ_TIMEOUT_MS,
    query: compact({
      locationId,
      limit,
      skip,
      ...query,
    }),
  });
  const contacts = collectionFrom(result.data, ["contacts", "data", "items"]);
  return {
    contacts,
    total: totalFrom(result.data, contacts),
    endpointUsed: requestEndpoint(result, LEGACY_CONTACTS_ENDPOINT),
    result,
  };
}

async function readContactsPage({
  limit = CONTACT_PAGE_LIMIT,
  page = 0,
  query = {},
  filters = [],
} = {}) {
  try {
    return await searchContactsPage({
      limit,
      page,
      query: query.query || "",
      filters,
    });
  } catch (searchError) {
    try {
      const legacy = await legacyContactsPage({ limit, page, query });
      return {
        ...legacy,
        searchError,
      };
    } catch (legacyError) {
      legacyError.searchError = searchError;
      throw legacyError;
    }
  }
}

function readErrorSummary(error) {
  const message = cleanString(error?.message || error);
  const status = error?.ghlStatus || error?.statusCode || error?.status || null;
  const timedOut =
    /timeout|timed out|etimedout|socket hang up|network timeout|abort/i.test(message) ||
    error?.type === "request-timeout";

  return {
    message,
    status,
    timedOut,
  };
}

function contactCountPartialAnswer({ scanned, error, sources = ["GHL contacts"] }) {
  const summary = readErrorSummary(error);
  const sanitizedError = sanitizeReadError(error);
  const prefix = summary.timedOut
    ? "I could not finish counting contacts because GHL took too long."
    : "I could not finish counting contacts because GHL did not return a complete contact count.";

  return {
    intent: "read",
    answer: scanned > 0
      ? `${prefix} I scanned the first ${formatNumber(scanned)} contacts. Exact full count requires pagination.`
      : `${prefix} I could not scan any contacts before the request stopped.`,
    data: {
      total: null,
      scanned,
      partial: true,
      limited: true,
      exactCountAvailable: false,
      reason: summary.timedOut ? "timeout" : "ghl_read_failed",
      ghlStatus: summary.status,
      message: sanitizedError.message,
      error: sanitizedError,
      contactsReadPermission: contactsPermissionFromError(error),
    },
    sources,
  };
}

async function countContacts() {
  let firstPage;
  try {
    firstPage = await readContactsPage({ limit: CONTACT_PAGE_LIMIT, page: 0 });
  } catch (error) {
    return contactCountPartialAnswer({ scanned: 0, error });
  }

  let counted = firstPage.contacts.length;
  const knownTotal =
    firstNumber(
      firstPage.result.data?.total,
      firstPage.result.data?.totalCount,
      firstPage.result.data?.count,
      firstPage.result.data?.meta?.total,
      firstPage.result.data?.pagination?.total
    ) ?? null;

  if (knownTotal !== null) {
    return {
      intent: "read",
      answer: `I checked GHL. You currently have ${formatNumber(knownTotal)} contacts in GHL.`,
      data: {
        total: knownTotal,
        countedDirectly: firstPage.contacts.length,
        limited: false,
        partial: false,
        exactCountAvailable: true,
        endpointUsed: firstPage.endpointUsed,
        locationIdUsed: getLocationId(),
        contactsReadPermission: "contacts_read_working",
      },
      sources: ["GHL contacts"],
    };
  }

  let limited = firstPage.contacts.length >= CONTACT_PAGE_LIMIT;
  for (let page = 1; page < CONTACT_COUNT_SCAN_PAGES && limited; page += 1) {
    let nextPage;
    try {
      nextPage = await readContactsPage({ limit: CONTACT_PAGE_LIMIT, page });
    } catch (error) {
      return contactCountPartialAnswer({ scanned: counted, error });
    }
    counted += nextPage.contacts.length;
    limited = nextPage.contacts.length >= CONTACT_PAGE_LIMIT;
  }

  const limit = CONTACT_PAGE_LIMIT * CONTACT_COUNT_SCAN_PAGES;
  return {
    intent: "read",
    answer: limited
      ? `I checked GHL. I scanned the first ${formatNumber(counted)} contacts. Exact full count requires pagination.`
      : `I checked GHL. You currently have ${formatNumber(counted)} contacts in GHL.`,
    data: {
      total: limited ? null : counted,
      scanned: counted,
      partial: limited,
      limited,
      limit,
      exactCountAvailable: !limited,
      endpointUsed: firstPage.endpointUsed,
      locationIdUsed: getLocationId(),
      contactsReadPermission: "contacts_read_working",
    },
    sources: ["GHL contacts"],
  };
}

function tagFromContact(contact) {
  const tags = contact?.tags || contact?.contactTags || contact?.additionalEmails;
  return asArray(tags)
    .map((tag) => {
      if (typeof tag === "string") return { name: tag, id: "" };
      return {
        name: cleanString(tag?.name || tag?.tag || tag?.label),
        id: cleanString(tag?.id || tag?._id),
      };
    })
    .filter((tag) => tag.name);
}

async function listTags() {
  const locationId = getLocationId();
  let result = null;
  try {
    result = await tryRead([
      { method: "GET", path: "/tags/", query: { locationId } },
      { method: "GET", path: `/locations/${encodeURIComponent(locationId)}/tags` },
    ]);
  } catch {
    const page = await readContactsPage({ limit: CONTACT_PAGE_LIMIT, page: 0 });
    const byName = new Map();
    for (const contact of page.contacts) {
      for (const tag of tagFromContact(contact)) {
        const key = tag.name.toLowerCase();
        if (!byName.has(key)) byName.set(key, tag);
      }
    }
    const tags = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    return {
      intent: "read",
      answer: tags.length
        ? `I checked GHL. I found ${formatNumber(tags.length)} tags in the first ${formatNumber(page.contacts.length)} contacts I could safely scan: ${tags.slice(0, 20).map((tag) => tag.name).join(", ")}${tags.length > 20 ? ", and more." : "."}`
        : "I checked GHL. I could not find tags from the safely scanned contact sample.",
      data: {
        tags,
        limited: true,
        scannedContacts: page.contacts.length,
      },
      sources: ["GHL contacts"],
    };
  }

  const tags = collectionFrom(result.data, ["tags", "data", "items"])
    .map((tag) => ({
      id: cleanString(tag?.id || tag?._id),
      name: cleanString(tag?.name || tag?.tag || tag?.label),
    }))
    .filter((tag) => tag.name);

  return {
    intent: "read",
    answer: tags.length
      ? `I checked GHL. You have ${formatNumber(tags.length)} tags: ${tags.slice(0, 25).map((tag) => tag.name).join(", ")}${tags.length > 25 ? ", and more." : "."}`
      : "I checked GHL. I did not find any tags.",
    data: { tags, total: tags.length },
    sources: ["GHL tags"],
  };
}

function normalizePipelines(data) {
  return collectionFrom(data, ["pipelines", "data", "items"]).map((pipeline) => ({
    id: cleanString(pipeline?.id || pipeline?._id),
    name: cleanString(pipeline?.name || pipeline?.title),
    stages: asArray(pipeline?.stages || pipeline?.pipelineStages).map((stage) => ({
      id: cleanString(stage?.id || stage?._id),
      name: cleanString(stage?.name || stage?.title),
      position: Number(stage?.position || 0),
    })),
  }));
}

async function listPipelines() {
  const result = await readRequest({
    method: "GET",
    path: "/opportunities/pipelines",
    query: { locationId: getLocationId() },
  });
  const pipelines = normalizePipelines(result.data);
  const stageCount = pipelines.reduce((total, pipeline) => total + pipeline.stages.length, 0);

  return {
    intent: "read",
    answer: pipelines.length
      ? `I checked GHL. You have ${formatNumber(pipelines.length)} pipelines with ${formatNumber(stageCount)} stages total. ${pipelines.slice(0, 6).map((pipeline) => `${pipeline.name || "Untitled"} (${pipeline.stages.length} stages)`).join("; ")}.`
      : "I checked GHL. I did not find any opportunity pipelines.",
    data: {
      pipelines,
      totalPipelines: pipelines.length,
      totalStages: stageCount,
    },
    sources: ["GHL pipelines"],
  };
}

async function readOpportunityPages({ maxPages = OPPORTUNITY_MAX_PAGES } = {}) {
  const locationId = getLocationId();
  const opportunities = [];
  let limited = false;
  let knownTotal = null;
  let endpointUsed = "";

  for (let page = 0; page < maxPages; page += 1) {
    const result = await readRequest({
      method: "GET",
      path: "/opportunities/search",
      query: {
        location_id: locationId,
        limit: OPPORTUNITY_PAGE_LIMIT,
        page: page + 1,
      },
    });
    endpointUsed = endpointUsed || requestEndpoint(result);
    const pageItems = collectionFrom(result.data, ["opportunities", "data", "items"]);
    knownTotal = knownTotal ?? firstNumber(
      result.data?.total,
      result.data?.totalCount,
      result.data?.meta?.total,
      result.data?.pagination?.total
    );
    opportunities.push(...pageItems);
    if (knownTotal !== null || pageItems.length < OPPORTUNITY_PAGE_LIMIT) break;
    limited = page === maxPages - 1;
  }

  return {
    opportunities,
    knownTotal,
    limited,
    endpointUsed,
  };
}

async function countOpportunities() {
  const { opportunities, knownTotal, limited, endpointUsed } = await readOpportunityPages();

  const pipelines = await listPipelines().catch(() => null);
  const stageNames = new Map();
  const pipelineNames = new Map();
  const stageToPipeline = new Map();
  for (const pipeline of pipelines?.data?.pipelines || []) {
    if (pipeline.id) pipelineNames.set(pipeline.id, pipeline.name || pipeline.id);
    for (const stage of pipeline.stages || []) {
      if (stage.id) stageNames.set(stage.id, stage.name || stage.id);
      if (stage.id && pipeline.id) stageToPipeline.set(stage.id, pipeline.id);
    }
  }

  const byStage = {};
  const byPipeline = {};
  const uniqueContactIds = new Set();
  for (const opportunity of opportunities) {
    const stageId = cleanString(
      opportunity?.pipelineStageId || opportunity?.stageId || opportunity?.pipeline_stage_id
    );
    const pipelineId = cleanString(
      opportunity?.pipelineId || opportunity?.pipeline_id || stageToPipeline.get(stageId)
    );
    const key = stageNames.get(stageId) || stageId || "Unknown stage";
    const pipelineKey = pipelineNames.get(pipelineId) || pipelineId || "Unknown pipeline";
    const contactId = cleanString(
      opportunity?.contactId || opportunity?.contact_id || opportunity?.contact?.id
    );
    if (contactId) uniqueContactIds.add(contactId);
    byStage[key] = (byStage[key] || 0) + 1;
    byPipeline[pipelineKey] = (byPipeline[pipelineKey] || 0) + 1;
  }

  const total = knownTotal ?? opportunities.length;
  return {
    intent: "read",
    answer: limited
      ? `I checked GHL. I safely counted at least ${formatNumber(opportunities.length)} opportunities before hitting the read limit.`
      : `I checked GHL. You currently have ${formatNumber(total)} opportunities in GHL.`,
    data: {
      total,
      counted: opportunities.length,
      uniqueContactsWithOpportunities: uniqueContactIds.size || null,
      byPipeline,
      byStage,
      limited,
      endpointUsed,
      exactCountAvailable: knownTotal !== null || !limited,
    },
    sources: ["GHL opportunities", "GHL pipelines"],
  };
}

async function countConversationsWaiting() {
  const result = await tryRead([
    {
      method: "GET",
      path: "/conversations/search",
      query: {
        locationId: getLocationId(),
        limit: CONVERSATION_PAGE_LIMIT,
      },
    },
    {
      method: "GET",
      path: "/conversations/",
      query: {
        locationId: getLocationId(),
        limit: CONVERSATION_PAGE_LIMIT,
      },
    },
  ]);
  const conversations = collectionFrom(result.data, ["conversations", "data", "items"]);
  const waiting = conversations.filter((conversation) => {
    const status = cleanString(conversation?.status || conversation?.state).toLowerCase();
    return (
      conversation?.unreadCount > 0 ||
      conversation?.unread === true ||
      status === "open" ||
      status === "unread" ||
      status === "waiting"
    );
  });
  const total = firstNumber(
    result.data?.total,
    result.data?.totalCount,
    result.data?.meta?.total,
    result.data?.pagination?.total
  ) ?? conversations.length;

  return {
    intent: "read",
    answer: `I checked GHL. I found ${formatNumber(waiting.length)} conversations that look waiting, unread, or open in the first ${formatNumber(conversations.length)} conversations returned.`,
    data: {
      waiting: waiting.length,
      returned: conversations.length,
      totalReturnedByGhl: total,
      limited: total > conversations.length,
    },
    sources: ["GHL conversations"],
  };
}

async function listWorkflows() {
  const result = await readRequest({
    method: "GET",
    path: "/workflows/",
    query: { locationId: getLocationId() },
  });
  const workflows = collectionFrom(result.data, ["workflows", "data", "items"])
    .map((workflow) => ({
      id: cleanString(workflow?.id || workflow?._id),
      name: cleanString(workflow?.name || workflow?.title),
      status: cleanString(workflow?.status),
    }))
    .filter((workflow) => workflow.name || workflow.id);

  return {
    intent: "read",
    answer: workflows.length
      ? `I checked GHL. You have ${formatNumber(workflows.length)} workflows: ${workflows.slice(0, 20).map((workflow) => workflow.name || workflow.id).join(", ")}${workflows.length > 20 ? ", and more." : "."}`
      : "I checked GHL. I did not find any workflows.",
    data: { workflows, total: workflows.length },
    sources: ["GHL workflows"],
  };
}

function simpleRecord(item) {
  return {
    id: cleanString(item?.id || item?._id),
    name: cleanString(item?.name || item?.title || item?.calendarName || item?.firstName),
    status: cleanString(item?.status || item?.state),
    email: cleanString(item?.email),
  };
}

async function listReadCategory({
  label,
  dataKey,
  requests,
  collectionKeys,
  sources,
  emptyLabel = label,
  mapItem = simpleRecord,
}) {
  const result = await tryRead(requests);
  const items = collectionFrom(result.data, collectionKeys)
    .map(mapItem)
    .filter((item) => item.name || item.id || item.email);
  const knownTotal = firstNumber(
    result.data?.total,
    result.data?.totalCount,
    result.data?.meta?.total,
    result.data?.pagination?.total
  );
  const total = knownTotal ?? items.length;

  return {
    intent: "read",
    answer: items.length
      ? `I checked GHL. I found ${formatNumber(total)} ${label}: ${items.slice(0, 20).map((item) => item.name || item.email || item.id).join(", ")}${items.length > 20 ? ", and more." : "."}`
      : `I checked GHL. I did not find any ${emptyLabel}.`,
    data: {
      [dataKey]: items,
      total,
      returned: items.length,
      endpointUsed: requestEndpoint(result),
      exactCountAvailable: knownTotal !== null || items.length < 100,
    },
    sources,
  };
}

async function listCalendars() {
  return listReadCategory({
    label: "calendars",
    dataKey: "calendars",
    requests: [{ method: "GET", path: "/calendars/", query: { locationId: getLocationId() } }],
    collectionKeys: ["calendars", "data", "items"],
    sources: ["GHL calendars"],
  });
}

async function listAppointments() {
  const range = nextThirtyDayRange();
  return listReadCategory({
    label: "appointments in the next 30 days",
    dataKey: "appointments",
    requests: [
      { method: "GET", path: "/calendars/events", query: { locationId: getLocationId(), ...range } },
      {
        method: "GET",
        path: "/calendars/events/appointments",
        query: { locationId: getLocationId(), ...range },
      },
    ],
    collectionKeys: ["events", "appointments", "data", "items"],
    sources: ["GHL appointments"],
    mapItem: (item) => ({
      id: cleanString(item?.id || item?._id),
      name: cleanString(item?.title || item?.name || item?.contactName),
      status: cleanString(item?.status),
      startTime: cleanString(item?.startTime || item?.start),
    }),
  });
}

async function listUsers() {
  const locationId = getLocationId();
  return listReadCategory({
    label: "users or team members",
    dataKey: "users",
    requests: [
      { method: "GET", path: "/users/search", query: { locationId, limit: 100 } },
      { method: "GET", path: `/locations/${encodeURIComponent(locationId)}/users` },
      { method: "GET", path: "/users/", query: { locationId, limit: 100 } },
    ],
    collectionKeys: ["users", "teamMembers", "data", "items"],
    sources: ["GHL users"],
    mapItem: (item) => ({
      id: cleanString(item?.id || item?._id),
      name: cleanString(item?.name || `${item?.firstName || ""} ${item?.lastName || ""}`),
      email: cleanString(item?.email),
      role: cleanString(item?.role || item?.type),
    }),
  });
}

async function listCustomFields() {
  const locationId = getLocationId();
  return listReadCategory({
    label: "custom fields",
    dataKey: "customFields",
    requests: [
      { method: "GET", path: `/locations/${encodeURIComponent(locationId)}/customFields` },
      { method: "GET", path: "/locations/customFields", query: { locationId } },
    ],
    collectionKeys: ["customFields", "fields", "data", "items"],
    sources: ["GHL custom fields"],
    mapItem: (item) => ({
      id: cleanString(item?.id || item?._id),
      name: cleanString(item?.name || item?.fieldKey || item?.placeholder),
      dataType: cleanString(item?.dataType || item?.type),
    }),
  });
}

async function listCampaigns() {
  return listReadCategory({
    label: "campaigns",
    dataKey: "campaigns",
    requests: [{ method: "GET", path: "/campaigns/", query: { locationId: getLocationId() } }],
    collectionKeys: ["campaigns", "data", "items"],
    sources: ["GHL campaigns"],
  });
}

async function listForms() {
  return listReadCategory({
    label: "forms",
    dataKey: "forms",
    requests: [{ method: "GET", path: "/forms/", query: { locationId: getLocationId() } }],
    collectionKeys: ["forms", "data", "items"],
    sources: ["GHL forms"],
  });
}

async function listSurveys() {
  return listReadCategory({
    label: "surveys",
    dataKey: "surveys",
    requests: [{ method: "GET", path: "/surveys/", query: { locationId: getLocationId() } }],
    collectionKeys: ["surveys", "data", "items"],
    sources: ["GHL surveys"],
  });
}

async function getLocationInfo() {
  const locationId = getLocationId();
  const result = await readRequest({
    method: "GET",
    path: `/locations/${encodeURIComponent(locationId)}`,
  });
  const location = result.data?.location || result.data?.data || result.data || {};
  const name = cleanString(location?.name || location?.businessName || location?.companyName);
  return {
    intent: "read",
    answer: name
      ? `I checked GHL. This token is pointed at the "${name}" location.`
      : "I checked GHL. I could read the configured location, but GHL did not return a location name.",
    data: {
      location: {
        id: cleanString(location?.id || location?._id || locationId),
        name,
        timezone: cleanString(location?.timezone),
      },
      endpointUsed: requestEndpoint(result),
    },
    sources: ["GHL location"],
  };
}

async function searchContactsByTag(tag) {
  const wanted = normalizeTag(tag);
  if (!wanted) {
    const error = new Error("Which tag should I check?");
    error.statusCode = 400;
    throw error;
  }

  const filteredPage = await searchContactsPage({
    limit: CONTACT_PAGE_LIMIT,
    page: 0,
    filters: [{ field: "tags", operator: "eq", value: wanted }],
  }).catch(() => null);

  if (filteredPage) {
    const knownTotal = firstNumber(
      filteredPage.result.data?.total,
      filteredPage.result.data?.totalCount,
      filteredPage.result.data?.count,
      filteredPage.result.data?.meta?.total,
      filteredPage.result.data?.pagination?.total
    );
    const total = knownTotal ?? filteredPage.contacts.length;
    const exact = knownTotal !== null || filteredPage.contacts.length < CONTACT_PAGE_LIMIT;

    return {
      intent: "read",
      answer: exact
        ? `I checked GHL. I found ${formatNumber(total)} contacts tagged "${wanted}".`
        : `I checked GHL. I scanned the first ${formatNumber(filteredPage.contacts.length)} contacts tagged "${wanted}". Exact full count requires pagination.`,
      data: {
        tag: wanted,
        total: exact ? total : null,
        contacts: filteredPage.contacts.slice(0, 50).map((contact) => ({
          id: cleanString(contact?.id || contact?._id),
          name: cleanString(contact?.name || `${contact?.firstName || ""} ${contact?.lastName || ""}`),
          email: cleanString(contact?.email),
          phone: cleanString(contact?.phone),
        })),
        returnedContacts: Math.min(filteredPage.contacts.length, 50),
        scanned: filteredPage.contacts.length,
        limited: !exact,
        partial: !exact,
        exactCountAvailable: exact,
        endpointUsed: filteredPage.endpointUsed,
        locationIdUsed: getLocationId(),
      },
      sources: ["GHL contacts"],
    };
  }

  const matches = [];
  let scanned = 0;
  let limited = false;

  for (let page = 0; page < CONTACT_MAX_PAGES; page += 1) {
    const current = await readContactsPage({ limit: CONTACT_PAGE_LIMIT, page });
    scanned += current.contacts.length;
    for (const contact of current.contacts) {
      const tags = tagFromContact(contact).map((item) => normalizeTag(item.name));
      if (tags.includes(wanted)) {
        matches.push({
          id: cleanString(contact?.id || contact?._id),
          name: cleanString(contact?.name || `${contact?.firstName || ""} ${contact?.lastName || ""}`),
          email: cleanString(contact?.email),
          phone: cleanString(contact?.phone),
          tags,
        });
      }
    }
    if (current.contacts.length < CONTACT_PAGE_LIMIT) break;
    limited = page === CONTACT_MAX_PAGES - 1;
  }

  return {
    intent: "read",
    answer: limited
      ? `I checked GHL. I found at least ${formatNumber(matches.length)} contacts tagged "${wanted}" after safely scanning ${formatNumber(scanned)} contacts.`
      : `I checked GHL. I found ${formatNumber(matches.length)} contacts tagged "${wanted}".`,
    data: {
      tag: wanted,
      total: matches.length,
      contacts: matches.slice(0, 50),
      returnedContacts: Math.min(matches.length, 50),
      scanned,
      limited,
    },
    sources: ["GHL contacts"],
  };
}

async function scanSummary() {
  const [contacts, pipelines, tags] = await Promise.allSettled([
    countContacts(),
    listPipelines(),
    listTags(),
  ]);

  const data = {
    contacts: contacts.status === "fulfilled" ? contacts.value.data : null,
    pipelines: pipelines.status === "fulfilled" ? pipelines.value.data : null,
    tags: tags.status === "fulfilled" ? tags.value.data : null,
    unavailable: [
      contacts.status === "rejected" ? "contacts" : "",
      pipelines.status === "rejected" ? "pipelines" : "",
      tags.status === "rejected" ? "tags" : "",
    ].filter(Boolean),
  };

  const parts = [];
  if (data.contacts) {
    if (Number.isFinite(Number(data.contacts.total))) {
      parts.push(`${formatNumber(data.contacts.total)} contacts`);
    } else if (Number.isFinite(Number(data.contacts.scanned))) {
      parts.push(`first ${formatNumber(data.contacts.scanned)} contacts scanned`);
    }
  }
  if (data.pipelines) {
    parts.push(
      `${formatNumber(data.pipelines.totalPipelines)} pipelines and ${formatNumber(data.pipelines.totalStages)} stages`
    );
  }
  if (data.tags) parts.push(`${formatNumber(data.tags.total || data.tags.tags?.length || 0)} tags`);

  return {
    intent: "read",
    answer: parts.length
      ? `I checked GHL. Snapshot: ${parts.join(", ")}.`
      : "I checked GHL, but I could not complete the summary from the available read endpoints.",
    data,
    sources: ["GHL contacts", "GHL pipelines", "GHL tags"],
  };
}

function extractTagFromMessage(message) {
  const text = cleanString(message);
  const patterns = [
    /\btagged\s+["']?([a-z0-9][\w .:-]{1,80})/i,
    /\bwith\s+tag\s+["']?([a-z0-9][\w .:-]{1,80})/i,
    /\btag\s+["']?([a-z0-9][\w .:-]{1,80})/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return normalizeTag(
        match[1]
          .replace(/\b(in|from|on|please|thanks|thank you)\b.*$/i, "")
          .replace(/[?.!,]+$/g, "")
      );
    }
  }
  return "";
}

function clarifyPotentialCustomers() {
  return {
    intent: "read",
    answer:
      'What should count as a potential customer: all contacts, contacts with a specific tag, or contacts in a specific pipeline/opportunity stage?',
    data: {
      needsDefinition: true,
      options: ["all contacts", "contacts with a specific tag", "contacts in a pipeline/opportunity stage"],
    },
    sources: [],
  };
}

function findPotentialTag(tags) {
  const byName = new Map(
    asArray(tags).map((tag) => [normalizeTag(tag?.name || tag?.tag || tag?.label), tag])
  );
  for (const candidate of POTENTIAL_CUSTOMER_TAGS) {
    if (byName.has(candidate)) return byName.get(candidate);
  }
  return null;
}

function findPotentialPipeline(pipelines) {
  const clearProspect = /\b(prospect|potential|lead|estimate|inquir|new)\b/i;
  const disqualifier = /\b(customer|won|closed|lost|complete|sold)\b/i;
  for (const pipeline of asArray(pipelines)) {
    if (clearProspect.test(pipeline.name) && !disqualifier.test(pipeline.name)) {
      return { pipeline, stage: null, reason: "pipeline name" };
    }
    for (const stage of asArray(pipeline.stages)) {
      const label = `${pipeline.name || ""} ${stage.name || ""}`;
      if (clearProspect.test(label) && !disqualifier.test(stage.name || "")) {
        return { pipeline, stage, reason: "pipeline stage" };
      }
    }
  }
  return null;
}

async function countContactsByOpportunityDefinition(definition) {
  const { opportunities, knownTotal, limited, endpointUsed } = await readOpportunityPages();
  const matching = opportunities.filter((opportunity) => {
    const pipelineId = cleanString(opportunity?.pipelineId || opportunity?.pipeline_id);
    const stageId = cleanString(
      opportunity?.pipelineStageId || opportunity?.stageId || opportunity?.pipeline_stage_id
    );
    if (definition.stage?.id) return stageId === definition.stage.id;
    if (definition.pipeline?.id) {
      const stageIds = new Set(asArray(definition.pipeline.stages).map((stage) => stage.id).filter(Boolean));
      return pipelineId === definition.pipeline.id || stageIds.has(stageId);
    }
    return false;
  });
  const contactIds = new Set(
    matching
      .map((opportunity) =>
        cleanString(opportunity?.contactId || opportunity?.contact_id || opportunity?.contact?.id)
      )
      .filter(Boolean)
  );
  const uniqueContacts = contactIds.size || null;
  const count = uniqueContacts ?? matching.length;
  const targetName = definition.stage?.name
    ? `${definition.pipeline.name || "matching pipeline"} / ${definition.stage.name}`
    : definition.pipeline?.name || "matching pipeline";

  return {
    intent: "read",
    answer: uniqueContacts !== null
      ? `I checked GHL. I used the "${targetName}" opportunity area as the potential-customer definition and found ${formatNumber(uniqueContacts)} unique contacts attached to it.`
      : `I checked GHL. I used the "${targetName}" opportunity area as the potential-customer definition and found ${formatNumber(matching.length)} matching opportunities. GHL did not return contact IDs for an exact unique-contact count.`,
    data: {
      inferredDefinition: {
        type: definition.stage?.id ? "pipeline_stage" : "pipeline",
        pipelineId: definition.pipeline?.id || null,
        pipelineName: definition.pipeline?.name || null,
        stageId: definition.stage?.id || null,
        stageName: definition.stage?.name || null,
        reason: definition.reason,
      },
      total: count,
      uniqueContacts,
      matchingOpportunities: matching.length,
      opportunityTotal: knownTotal,
      limited,
      partial: limited,
      exactCountAvailable: !limited && uniqueContacts !== null,
      endpointUsed,
    },
    sources: ["GHL opportunities", "GHL pipelines"],
  };
}

async function countPotentialCustomers() {
  const tagsResult = await listTags().catch(() => null);
  const tag = findPotentialTag(tagsResult?.data?.tags);
  if (tag?.name) {
    const result = await searchContactsByTag(tag.name);
    return {
      ...result,
      answer: `${result.answer} I used the "${tag.name}" tag as the potential-customer definition.`,
      data: {
        ...result.data,
        inferredDefinition: {
          type: "tag",
          tagId: cleanString(tag.id),
          tagName: cleanString(tag.name),
        },
      },
    };
  }

  const pipelinesResult = await listPipelines().catch(() => null);
  const definition = findPotentialPipeline(pipelinesResult?.data?.pipelines);
  if (definition) return countContactsByOpportunityDefinition(definition);

  return clarifyPotentialCustomers();
}

async function checkContactsConnection() {
  const safeToken = getSafeTokenDiagnostics();
  let locationId = "";
  try {
    locationId = getLocationId();
    const page = await searchContactsPage({ limit: 1, page: 0 });
    const total =
      firstNumber(
        page.result.data?.total,
        page.result.data?.totalCount,
        page.result.data?.count,
        page.result.data?.meta?.total,
        page.result.data?.pagination?.total
      ) ?? null;

    return {
      intent: "read",
      answer: total !== null
        ? `I checked GHL. Contacts read permission works for this location, and GHL reports ${formatNumber(total)} contacts.`
        : `I checked GHL. Contacts read permission works for this location, and the first page returned ${formatNumber(page.contacts.length)} contact${page.contacts.length === 1 ? "" : "s"}. GHL did not return an exact total in that response.`,
      data: {
        token: safeToken,
        locationIdUsed: locationId,
        endpointUsed: page.endpointUsed,
        contactsReadPermission: "contacts_read_working",
        firstPageContactCount: page.contacts.length,
        total,
        exactCountAvailable: total !== null,
      },
      sources: ["GHL contacts"],
    };
  } catch (error) {
    return {
      intent: "read",
      answer:
        "I checked GHL. Contacts read permission is not working from this token/location right now.",
      data: {
        token: safeToken,
        locationIdUsed: locationId || null,
        endpointUsed: CONTACT_SEARCH_ENDPOINT,
        contactsReadPermission: contactsPermissionFromError(error),
        firstPageContactCount: 0,
        total: null,
        exactCountAvailable: false,
        error: sanitizeReadError(error),
      },
      sources: ["GHL contacts"],
    };
  }
}

async function diagnoseGhlAccess() {
  const audit = await auditGhlCapabilities();
  const workingLabels = audit.working.map((item) => item.label);
  const failingLabels = audit.failing.map((item) => `${item.label}: ${item.reason}`);

  return {
    intent: "read",
    answer: [
      "I checked GHL access from the backend.",
      workingLabels.length
        ? `Working: ${workingLabels.join(", ")}.`
        : "I could not confirm any working read capabilities.",
      failingLabels.length
        ? `Needs attention: ${failingLabels.join("; ")}.`
        : "I did not find failing read capabilities in this audit.",
    ].join(" "),
    data: {
      diagnostics: audit.diagnostics,
      working: audit.working,
      failing: audit.failing,
      capabilities: audit.capabilities,
    },
    sources: ["GHL capability audit"],
  };
}

function hasCsvFiles(context = {}) {
  return csvFilesFromContext(context).length > 0;
}

async function countCsvContacts(context = {}) {
  const summary = await countCsvContactsFromContext(context);
  const fileNames = summary.files.map((file) => file.file.originalName).join(", ");
  const firstHeaders = summary.files[0]?.sampleHeaders || [];

  return {
    intent: "read",
    answer: summary.files.length === 1
      ? `I checked the CSV. ${fileNames} has ${formatNumber(summary.validContacts)} valid contact rows out of ${formatNumber(summary.totalRows)} total rows.`
      : `I checked the CSV files. They have ${formatNumber(summary.validContacts)} valid contact rows out of ${formatNumber(summary.totalRows)} total rows.`,
    data: {
      totalRows: summary.totalRows,
      validContacts: summary.validContacts,
      invalidRows: summary.invalidRows,
      sampleHeaders: firstHeaders,
      files: summary.files,
    },
    sources: ["Uploaded CSV"],
  };
}

async function auditCsvAgainstGhl(context = {}) {
  const report = await auditEstimateCsvAgainstGhl({
    ...context,
    userRequest: context.userRequest || "Audit uploaded CSV against GHL",
  });
  return {
    intent: "read",
    answer:
      `I audited the CSV against GHL. I found ${formatNumber(report.foundInGhl)} matching contacts, ${formatNumber(report.notFoundInGhl)} missing contacts, and ${formatNumber(report.multipleMatches)} rows with multiple possible matches. Nothing was changed.`,
    data: report,
    sources: ["Uploaded CSV", "GHL contacts"],
  };
}

function resolveReadAction(message, context = {}) {
  const text = cleanString(message).toLowerCase();

  if (
    hasCsvFiles(context) &&
    /\b(audit|match|find|check|compare|against)\b/.test(text) &&
    /\b(ghl|gohighlevel|highlevel|contacts?|customers?|leads?)\b/.test(text)
  ) {
    return { action: "audit_csv_against_ghl" };
  }

  if (
    hasCsvFiles(context) &&
    /\b(csv|file|uploaded|attached|contacts?|customers?|leads?|rows?)\b/.test(text) &&
    /\b(how many|count|total|number of|analyze|scan)\b/.test(text)
  ) {
    return { action: "count_csv_contacts" };
  }

  if (
    /\b(check|diagnos|test|verify)\b/.test(text) &&
    /\b(connection|access|permission|read|endpoint)\b/.test(text) &&
    /\bcontacts?\b/.test(text)
  ) {
    return { action: "check_contacts_connection" };
  }

  if (
    /\b(what .*access|access do you have|capabilities|capability|full ghl access|audit)\b/.test(text) &&
    /\b(ghl|gohighlevel|highlevel|access|capabilities|capability)\b/.test(text)
  ) {
    return { action: "diagnose_ghl_access" };
  }

  if (/\b(scan|summary|summarize|overview)\b/.test(text) && /\bghl|gohighlevel|highlevel\b/.test(text)) {
    return { action: "scan_summary" };
  }

  if (/\bpotential customers?\b/.test(text)) {
    if (/\b(tagged|with tag|tag )\b/.test(text)) {
      return { action: "search_contacts_by_tag", tag: extractTagFromMessage(message) };
    }
    if (/\b(opportunit|pipeline|stage)\b/.test(text)) {
      return { action: "count_opportunities" };
    }
    return { action: "count_potential_customers" };
  }

  if (/\bcontacts?\b/.test(text) && /\b(tagged|with tag|tag )\b/.test(text)) {
    return { action: "search_contacts_by_tag", tag: extractTagFromMessage(message) };
  }

  if (
    (/\b(leads?|opportunit)/.test(text) && /\b(pipeline|stage|how many|count|total|each|by)\b/.test(text)) ||
    (/\bcontacts?\b/.test(text) && /\b(pipeline|stage|opportunit)\b/.test(text))
  ) {
    return { action: "count_opportunities" };
  }

  if (/\bcontacts?\b/.test(text) && /\b(how many|count|total|number of)\b/.test(text)) {
    return { action: "count_contacts" };
  }

  if (/\btags?\b/.test(text) && /\b(show|list|what|all|have|exist)\b/.test(text)) {
    return { action: "list_tags" };
  }

  if (/\bopportunit/.test(text) && /\b(count|how many|stage|pipeline|total|each)\b/.test(text)) {
    return { action: "count_opportunities" };
  }

  if (/\bpipelines?\b|\bstages?\b/.test(text) && /\b(show|list|what|all|have|exist)\b/.test(text)) {
    return { action: "list_pipelines" };
  }

  if (/\bconversations?\b/.test(text) && /\b(waiting|unread|open|how many|count)\b/.test(text)) {
    return { action: "count_conversations_waiting" };
  }

  if (/\bworkflows?\b/.test(text) && /\b(show|list|what|all|have|exist)\b/.test(text)) {
    return { action: "list_workflows" };
  }

  if (/\bcalendars?\b/.test(text) && /\b(show|list|what|all|have|exist)\b/.test(text)) {
    return { action: "list_calendars" };
  }

  if (/\bappointments?\b/.test(text) && /\b(show|list|what|all|have|exist|how many|count)\b/.test(text)) {
    return { action: "list_appointments" };
  }

  if (/\b(users?|team members?|staff)\b/.test(text) && /\b(show|list|what|all|have|exist)\b/.test(text)) {
    return { action: "list_users" };
  }

  if (/\bcustom fields?\b/.test(text) && /\b(show|list|what|all|have|exist)\b/.test(text)) {
    return { action: "list_custom_fields" };
  }

  if (/\bcampaigns?\b/.test(text) && /\b(show|list|what|all|have|exist)\b/.test(text)) {
    return { action: "list_campaigns" };
  }

  if (/\bforms?\b/.test(text) && /\b(show|list|what|all|have|exist)\b/.test(text)) {
    return { action: "list_forms" };
  }

  if (/\bsurveys?\b/.test(text) && /\b(show|list|what|all|have|exist)\b/.test(text)) {
    return { action: "list_surveys" };
  }

  if (/\b(location|account)\b/.test(text) && /\b(show|what|which|info|details)\b/.test(text)) {
    return { action: "get_location_info" };
  }

  if (/\bcontacts?\b/.test(text)) return { action: "count_contacts" };

  return { action: "scan_summary" };
}

async function runReadAction(message, context = {}) {
  const resolved = resolveReadAction(message, context);
  const action = resolved.action;

  if (action === "audit_csv_against_ghl") return auditCsvAgainstGhl({ ...context, userRequest: message });
  if (action === "count_csv_contacts") return countCsvContacts(context);
  if (action === "count_contacts") return countContacts();
  if (action === "list_tags") return listTags();
  if (action === "count_opportunities") return countOpportunities();
  if (action === "list_pipelines") return listPipelines();
  if (action === "count_conversations_waiting") return countConversationsWaiting();
  if (action === "search_contacts_by_tag") return searchContactsByTag(resolved.tag);
  if (action === "count_potential_customers") return countPotentialCustomers();
  if (action === "clarify_potential_customers") return clarifyPotentialCustomers();
  if (action === "check_contacts_connection") return checkContactsConnection();
  if (action === "diagnose_ghl_access") return diagnoseGhlAccess();
  if (action === "list_workflows") return listWorkflows();
  if (action === "list_calendars") return listCalendars();
  if (action === "list_appointments") return listAppointments();
  if (action === "list_users") return listUsers();
  if (action === "list_custom_fields") return listCustomFields();
  if (action === "list_campaigns") return listCampaigns();
  if (action === "list_forms") return listForms();
  if (action === "list_surveys") return listSurveys();
  if (action === "get_location_info") return getLocationInfo();
  return scanSummary();
}

module.exports = {
  auditCsvAgainstGhl,
  countContacts,
  countCsvContacts,
  countConversationsWaiting,
  countOpportunities,
  countPotentialCustomers,
  checkContactsConnection,
  clarifyPotentialCustomers,
  diagnoseGhlAccess,
  extractTagFromMessage,
  getLocationInfo,
  listAppointments,
  listCalendars,
  listCampaigns,
  listCustomFields,
  listForms,
  listPipelines,
  listSurveys,
  listTags,
  listUsers,
  listWorkflows,
  resolveReadAction,
  runReadAction,
  scanSummary,
  searchContactsByTag,
};
