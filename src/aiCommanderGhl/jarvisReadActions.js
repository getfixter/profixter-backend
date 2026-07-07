const { getLocationId, request } = require("./ghlClient");
const { cleanString } = require("./ghlActions");

const READ_TIMEOUT_MS = Number(process.env.JARVIS_GHL_READ_TIMEOUT_MS || 15000);
const CONTACT_READ_TIMEOUT_MS = Number(
  process.env.JARVIS_GHL_CONTACT_READ_TIMEOUT_MS || Math.min(READ_TIMEOUT_MS, 8000)
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

async function readRequest(input) {
  return request({
    timeoutMs: READ_TIMEOUT_MS,
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

async function readContactsPage({ limit = CONTACT_PAGE_LIMIT, page = 0, query = {} } = {}) {
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
    result,
  };
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
      message: summary.message,
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

async function countOpportunities() {
  const locationId = getLocationId();
  const opportunities = [];
  let limited = false;
  let knownTotal = null;

  for (let page = 0; page < OPPORTUNITY_MAX_PAGES; page += 1) {
    const result = await readRequest({
      method: "GET",
      path: "/opportunities/search",
      query: {
        location_id: locationId,
        limit: OPPORTUNITY_PAGE_LIMIT,
        page: page + 1,
      },
    });
    const pageItems = collectionFrom(result.data, ["opportunities", "data", "items"]);
    knownTotal = knownTotal ?? firstNumber(
      result.data?.total,
      result.data?.totalCount,
      result.data?.meta?.total,
      result.data?.pagination?.total
    );
    opportunities.push(...pageItems);
    if (knownTotal !== null || pageItems.length < OPPORTUNITY_PAGE_LIMIT) break;
    limited = page === OPPORTUNITY_MAX_PAGES - 1;
  }

  const pipelines = await listPipelines().catch(() => null);
  const stageNames = new Map();
  for (const pipeline of pipelines?.data?.pipelines || []) {
    for (const stage of pipeline.stages || []) {
      if (stage.id) stageNames.set(stage.id, stage.name || stage.id);
    }
  }

  const byStage = {};
  for (const opportunity of opportunities) {
    const stageId = cleanString(
      opportunity?.pipelineStageId || opportunity?.stageId || opportunity?.pipeline_stage_id
    );
    const key = stageNames.get(stageId) || stageId || "Unknown stage";
    byStage[key] = (byStage[key] || 0) + 1;
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
      byStage,
      limited,
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

async function searchContactsByTag(tag) {
  const wanted = normalizeTag(tag);
  if (!wanted) {
    const error = new Error("Which tag should I check?");
    error.statusCode = 400;
    throw error;
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
  if (data.contacts) parts.push(`${formatNumber(data.contacts.total)} contacts`);
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

function resolveReadAction(message) {
  const text = cleanString(message).toLowerCase();

  if (/\b(scan|summary|summarize|overview)\b/.test(text) && /\bghl|gohighlevel|highlevel\b/.test(text)) {
    return { action: "scan_summary" };
  }

  if (/\bcontacts?\b/.test(text) && /\b(tagged|with tag|tag )\b/.test(text)) {
    return { action: "search_contacts_by_tag", tag: extractTagFromMessage(message) };
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

  if (/\bcontacts?\b/.test(text)) return { action: "count_contacts" };

  return { action: "scan_summary" };
}

async function runReadAction(message) {
  const resolved = resolveReadAction(message);
  const action = resolved.action;

  if (action === "count_contacts") return countContacts();
  if (action === "list_tags") return listTags();
  if (action === "count_opportunities") return countOpportunities();
  if (action === "list_pipelines") return listPipelines();
  if (action === "count_conversations_waiting") return countConversationsWaiting();
  if (action === "search_contacts_by_tag") return searchContactsByTag(resolved.tag);
  if (action === "list_workflows") return listWorkflows();
  return scanSummary();
}

module.exports = {
  countContacts,
  countConversationsWaiting,
  countOpportunities,
  extractTagFromMessage,
  listPipelines,
  listTags,
  listWorkflows,
  resolveReadAction,
  runReadAction,
  scanSummary,
  searchContactsByTag,
};
