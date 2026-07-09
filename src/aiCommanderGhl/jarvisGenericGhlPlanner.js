const {
  DESTRUCTIVE_CONFIRMATION_PHRASE,
  ENDPOINTS,
  HIGH_RISK_CONFIRMATION_PHRASE,
  registrySummary,
} = require("./ghlEndpointRegistry");
const {
  extractCompanyId,
  getCompanyIdFromEnv,
  getLocationId,
  redact,
} = require("./ghlClient");
const { executeGhlRequest } = require("./ghlUniversalExecutor");
const {
  GENERIC_GHL_PLANNER_SCHEMA,
  buildGenericGhlPlannerPrompt,
} = require("./jarvisGenericGhlPlanner.prompt");

const CONTACT_PAGE_LIMIT = 100;
const OPPORTUNITY_PAGE_LIMIT = 100;
const CONVERSATION_PAGE_LIMIT = 100;
const DEFAULT_MAX_RECORDS = 5000;

function cleanString(value) {
  return String(value ?? "").trim();
}

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

function collectionFrom(data, keys) {
  for (const key of keys) {
    const value = key.split(".").reduce((current, part) => current?.[part], data);
    if (Array.isArray(value)) return value;
  }
  return [];
}

function responseData(result) {
  return result?.response || result?.data || {};
}

function cleanQuotedValue(value) {
  return cleanString(value)
    .replace(/^["']+|["']+$/g, "")
    .replace(/[?.!,]+$/g, "")
    .trim();
}

function normalizeName(value) {
  return cleanString(value)
    .toLowerCase()
    .replace(/["']/g, "")
    .replace(/[^a-z0-9@._&/+-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTag(value) {
  return cleanQuotedValue(value).toLowerCase();
}

function matchFirst(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return cleanQuotedValue(match[1]);
  }
  return "";
}

function endpointByKey(key) {
  const endpoint = ENDPOINTS.find((item) => item.key === key);
  if (!endpoint || !endpoint.enabled || endpoint.deprecated) {
    const error = new Error(`GHL endpoint ${key} is not enabled in Jarvis's registry.`);
    error.statusCode = 422;
    throw error;
  }
  return endpoint;
}

function endpointSelection(key, reason) {
  const endpoint = endpointByKey(key);
  return {
    key: endpoint.key,
    group: endpoint.group,
    method: endpoint.method,
    path: endpoint.path,
    riskLevel: endpoint.riskLevel,
    riskCategory: endpoint.riskCategory,
    destructive: endpoint.destructive,
    approvalRequired: endpoint.approvalRequired,
    reason,
  };
}

function callFactory({ apiCall, adminUserId, userRequest } = {}) {
  return (
    apiCall ||
    ((requestShape) =>
      executeGhlRequest({
        ...requestShape,
        adminUserId,
        userRequest,
      }))
  );
}

function getMaxRecords() {
  const value = Number(process.env.JARVIS_GENERIC_GHL_MAX_RECORDS);
  if (Number.isFinite(value) && value > 0) return Math.min(25000, Math.floor(value));
  return DEFAULT_MAX_RECORDS;
}

function normalizeContact(item) {
  const firstName = cleanString(item?.firstName);
  const lastName = cleanString(item?.lastName);
  const tags = asArray(item?.tags)
    .map((tag) => {
      if (typeof tag === "string") return cleanString(tag);
      return cleanString(tag?.name || tag?.tag || tag?.label);
    })
    .filter(Boolean);
  return {
    id: cleanString(item?.id || item?._id || item?.contactId),
    name: cleanString(item?.name || `${firstName} ${lastName}`),
    firstName,
    lastName,
    email: cleanString(item?.email).toLowerCase(),
    phone: cleanString(item?.phone),
    assignedTo: cleanString(item?.assignedTo || item?.assignedUserId || item?.ownerId),
    tags,
  };
}

function normalizeUser(item) {
  const firstName = cleanString(item?.firstName);
  const lastName = cleanString(item?.lastName);
  return {
    id: cleanString(item?.id || item?._id || item?.userId),
    name: cleanString(item?.name || `${firstName} ${lastName}`),
    firstName,
    lastName,
    email: cleanString(item?.email).toLowerCase(),
  };
}

function normalizeStage(item) {
  return {
    id: cleanString(item?.id || item?._id || item?.stageId || item?.pipelineStageId),
    name: cleanString(item?.name || item?.title),
  };
}

function normalizePipeline(item) {
  return {
    id: cleanString(item?.id || item?._id || item?.pipelineId),
    name: cleanString(item?.name || item?.title),
    stages: asArray(item?.stages || item?.pipelineStages)
      .map(normalizeStage)
      .filter((stage) => stage.id || stage.name),
  };
}

function normalizeOpportunity(item) {
  return {
    id: cleanString(item?.id || item?._id || item?.opportunityId),
    name: cleanString(item?.name || item?.title),
    contactId: cleanString(item?.contactId || item?.contact_id || item?.contact?.id),
    pipelineId: cleanString(item?.pipelineId || item?.pipeline_id || item?.pipeline?.id),
    pipelineStageId: cleanString(
      item?.pipelineStageId || item?.stageId || item?.pipeline_stage_id || item?.stage?.id
    ),
    status: cleanString(item?.status),
    updatedAt: cleanString(item?.updatedAt || item?.lastStatusChangeAt || item?.dateUpdated),
    createdAt: cleanString(item?.createdAt || item?.dateAdded),
    monetaryValue: Number(item?.monetaryValue || item?.value || 0),
  };
}

function normalizeConversation(item) {
  const unreadCount = Number(item?.unreadCount || item?.unread_count || item?.unread || 0);
  return {
    id: cleanString(item?.id || item?._id || item?.conversationId),
    contactId: cleanString(item?.contactId || item?.contact_id || item?.contact?.id),
    contactName: cleanString(item?.contactName || item?.contact?.name || item?.fullName),
    lastMessageBody: cleanString(item?.lastMessageBody || item?.lastMessage || item?.message),
    unreadCount,
    inbox: cleanString(item?.inbox || item?.status),
    updatedAt: cleanString(item?.updatedAt || item?.lastMessageDate),
  };
}

function contactHasTag(contact, tagName) {
  const wanted = normalizeTag(tagName);
  return asArray(contact.tags).some((tag) => normalizeTag(tag) === wanted);
}

function resolveOneByName(items, requestedName, label) {
  const wanted = normalizeName(requestedName);
  if (!wanted) {
    const error = new Error(`Which ${label} should I use?`);
    error.statusCode = 400;
    throw error;
  }
  const exact = items.filter((item) => normalizeName(item.name) === wanted);
  if (exact.length === 1) return exact[0];
  const partial = items.filter((item) => normalizeName(item.name).includes(wanted));
  if (partial.length === 1) return partial[0];
  const error = new Error(
    exact.length > 1 || partial.length > 1
      ? `I found multiple ${label}s matching "${requestedName}". Use the exact ${label} name.`
      : `I could not find a ${label} named "${requestedName}".`
  );
  error.statusCode = 400;
  error.data = redact({ requestedName, matches: partial.length ? partial : exact });
  throw error;
}

function extractTagAfterKeyword(message, keyword) {
  const text = cleanString(message);
  const quoted = matchFirst(text, [
    new RegExp(`\\b${keyword}\\s+(?:the\\s+)?tag\\s+["']([^"']+)["']`, "i"),
    new RegExp(`\\b${keyword}\\s+["']([^"']+)["']`, "i"),
  ]);
  if (quoted) return quoted;
  return matchFirst(text, [
    new RegExp(
      `\\b${keyword}\\s+(?:the\\s+)?tag\\s+([a-z0-9][\\w .:-]{0,100}?)(?=\\s+(?:to|into|for|in|with|without|where|that|and)\\b|[?.!]|$)`,
      "i"
    ),
    new RegExp(
      `\\b${keyword}\\s+([a-z0-9][\\w .:-]{0,100}?)(?=\\s+(?:to|into|for|in|with|without|where|that|and)\\b|[?.!]|$)`,
      "i"
    ),
  ]);
}

function extractAudienceTag(message) {
  const text = cleanString(message);
  const quotedPattern = /\b(?:tag|tagged)\b\s*["']([^"']+)["']/gi;
  const unquotedPattern =
    /\b(?:tag|tagged)\b\s+([a-z0-9][\w .:-]{0,100}?)(?=\s+(?:to|into|for|in|pipeline|stage|and|where|that|who|which)\b|[?.!,]|$)/gi;
  const candidates = [];
  for (const pattern of [quotedPattern, unquotedPattern]) {
    let match = pattern.exec(text);
    while (match) {
      candidates.push({
        tagName: cleanQuotedValue(match[1]),
        index: match.index,
        raw: match[0],
      });
      match = pattern.exec(text);
    }
  }
  candidates.sort((a, b) => a.index - b.index);

  const candidate = candidates.find((item) => item.tagName);
  if (!candidate) return { mode: "all", tagName: "", filters: [] };

  const before = text.slice(Math.max(0, candidate.index - 120), candidate.index).toLowerCase();
  const after = text
    .slice(candidate.index, Math.min(text.length, candidate.index + candidate.raw.length + 40))
    .toLowerCase();
  const context = `${before} ${after}`;
  const negative =
    /\b(except|excluding|exclude|without)\b/i.test(context) ||
    /\b(?:does|do|did)\s+not\s+have\b/i.test(context) ||
    /\bnot\s+(?:have|having|tagged)\b/i.test(context);
  const mode = negative ? "without" : "with";
  return {
    mode,
    tagName: candidate.tagName,
    filters: [
      {
        field: "tags",
        operator: mode === "without" ? "does_not_include" : "includes",
        value: candidate.tagName,
      },
    ],
  };
}

function extractOwnerName(message) {
  return matchFirst(cleanString(message), [
    /\bassign\s+(?:the\s+)?owner\s+["']([^"']+)["']\s+to\b/i,
    /\bassign\s+(?:the\s+)?owner\s+([a-z][a-z .'-]{1,80}?)\s+to\s+(?:all|every|contacts?)/i,
  ]);
}

function extractPipelineName(message) {
  const text = cleanString(message);
  return matchFirst(text, [
    /\b(?:opportunity\s+)?pipeline\s+["']([^"']+)["']/i,
    /\b(?:opportunity\s+)?pipeline\s+([a-z0-9][\w .&'/-]{1,120}?)(?=\s+(?:in|at)\s+stage\b|\s+stage\b|[?.!]|$)/i,
  ]);
}

function extractStageName(message) {
  const text = cleanString(message);
  return matchFirst(text, [
    /\b(?:in|at|to)\s+stage\s+["']([^"']+)["']/i,
    /\bstage\s+["']([^"']+)["']/i,
    /\b(?:in|at|to)\s+stage\s+([a-z0-9][\w .&'/-]{1,120}?)(?=[?.!]|$)/i,
    /\bstage\s+([a-z0-9][\w .&'/-]{1,120}?)(?=[?.!]|$)/i,
  ]);
}

function extractDays(message) {
  const value = Number(matchFirst(cleanString(message), [/\bolder\s+than\s+(\d+)\s+days?\b/i]));
  return Number.isFinite(value) && value > 0 ? value : 30;
}

function parseGenericRequest(message) {
  const text = cleanString(message);
  const lower = text.toLowerCase();

  if (/\bunread\b/i.test(text) && /\b(conversations?|messages?)\b/i.test(text)) {
    return { operation: "show_unread_conversations" };
  }

  if (/\bassign\b/i.test(text) && /\bowner\b/i.test(text) && /\bcontacts?\b/i.test(text)) {
    return {
      operation: "contact_owner_assignment",
      ownerName: extractOwnerName(text),
      audience: extractAudienceTag(text),
    };
  }

  if (/\b(create|add|put)\b/i.test(text) && /\bopportunit|pipeline\b/i.test(text) && /\bcontacts?\b/i.test(text)) {
    return {
      operation: "opportunity_create_for_contacts",
      pipelineName: extractPipelineName(text),
      stageName: extractStageName(text),
      audience: extractAudienceTag(text),
    };
  }

  if (/\bmove\b/i.test(text) && /\bopportunit/i.test(text) && /\bstage\b/i.test(text)) {
    return {
      operation: "move_opportunities_older_than",
      days: extractDays(text),
      pipelineName: extractPipelineName(text),
      stageName: extractStageName(text),
    };
  }

  if (/\b(add|apply)\b/i.test(text) && /\btag\b/i.test(text) && /\bcontacts?\b/i.test(text)) {
    const targetTag = extractTagAfterKeyword(text, "(?:add|apply)");
    const audience = extractAudienceTag(text.replace(new RegExp(`\\b(?:add|apply)\\s+(?:the\\s+)?tag\\s+["']?${targetTag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?`, "i"), ""));
    return {
      operation: "add_tag_to_contacts",
      tagName: targetTag,
      audience,
    };
  }

  if (/\b(ghl|gohighlevel|contacts?|opportunit|pipelines?|tags?|conversations?|tasks?|calendars?|notes?)\b/i.test(lower)) {
    return { operation: "unsupported_generic" };
  }
  return null;
}

function looksLikeGenericGhlPlannerRequest(message) {
  const parsed = parseGenericRequest(message);
  return Boolean(parsed && parsed.operation !== "unsupported_generic");
}

async function resolveCompanyId({ call, locationId }) {
  const configured = getCompanyIdFromEnv();
  if (configured) return configured;
  const result = await call({
    method: "GET",
    path: `/locations/${encodeURIComponent(locationId)}`,
    reason: "Resolve companyId for generic GHL user search",
  });
  const companyId = extractCompanyId(responseData(result));
  if (companyId) return companyId;
  const error = new Error("GHL companyId is required for user lookup. Set GHL_COMPANY_ID.");
  error.statusCode = 500;
  throw error;
}

async function resolveOwner({ ownerName, call, adminUserId, userRequest, debugTrace }) {
  const cleanOwnerName = cleanString(ownerName);
  if (!cleanOwnerName) {
    const error = new Error("Which GHL user should own these contacts?");
    error.statusCode = 400;
    throw error;
  }
  const locationId = getLocationId();
  const companyId = await resolveCompanyId({ call, locationId });
  const result = await call({
    method: "GET",
    path: "/users/search",
    query: { companyId, limit: 100 },
    reason: "Resolve owner by full name or email for generic GHL workflow",
    adminUserId,
    userRequest,
  });
  debugTrace.push(`Resolved owner with users.search using companyId for "${cleanOwnerName}".`);
  const users = collectionFrom(responseData(result), ["users", "teamMembers", "data", "items"])
    .map(normalizeUser)
    .filter((user) => user.id);
  return resolveOneByName(users, cleanOwnerName, "user");
}

async function resolveCanonicalTag({ tagName, call, debugTrace }) {
  const wanted = cleanQuotedValue(tagName);
  if (!wanted) return "";
  try {
    const locationId = getLocationId();
    const result = await call({
      method: "GET",
      path: `/locations/${encodeURIComponent(locationId)}/tags`,
      reason: `Resolve canonical GHL tag "${wanted}"`,
    });
    const tags = collectionFrom(responseData(result), ["tags", "data", "items"]);
    const exact = tags.find((tag) => normalizeTag(tag?.name || tag?.tag || tag?.label) === normalizeTag(wanted));
    if (exact) {
      const name = cleanString(exact.name || exact.tag || exact.label);
      debugTrace.push(`Resolved tag "${wanted}" to canonical GHL tag "${name}".`);
      return name || wanted;
    }
  } catch (error) {
    debugTrace.push(`Could not resolve tag "${wanted}" from tags endpoint, using requested tag text.`);
  }
  return wanted;
}

async function fetchContactsForAudience({ audience, call, debugTrace, maxRecords = getMaxRecords() }) {
  const mode = audience?.mode || "all";
  const requestedTag = cleanString(audience?.tagName);
  const tagName = requestedTag ? await resolveCanonicalTag({ tagName: requestedTag, call, debugTrace }) : "";
  const contacts = [];
  let total = null;
  let partial = false;

  for (let page = 1; contacts.length < maxRecords; page += 1) {
    const body = compact({
      locationId: getLocationId(),
      page,
      pageLimit: CONTACT_PAGE_LIMIT,
      filters:
        mode === "with" && tagName
          ? [{ field: "tags", operator: "eq", value: tagName }]
          : [],
    });
    const result = await call({
      method: "POST",
      path: "/contacts/search",
      body,
      reason:
        mode === "with" && tagName
          ? `Find contacts with tag "${tagName}" for generic GHL workflow`
          : "Find contacts for generic GHL workflow",
    });
    const data = responseData(result);
    const rawContacts = collectionFrom(data, ["contacts", "data.contacts", "data", "items"]);
    const pageContacts = rawContacts.map(normalizeContact).filter((contact) => contact.id);
    const filtered = pageContacts.filter((contact) => {
      if (mode === "with" && tagName) return contactHasTag(contact, tagName) || contact.tags.length === 0;
      if (mode === "without" && tagName) return !contactHasTag(contact, tagName);
      return true;
    });
    contacts.push(...filtered.slice(0, Math.max(0, maxRecords - contacts.length)));
    const knownTotal = Number(data?.total || data?.totalCount || data?.meta?.total || 0);
    if (Number.isFinite(knownTotal) && knownTotal > 0) total = knownTotal;
    if (pageContacts.length < CONTACT_PAGE_LIMIT) break;
    if (contacts.length >= maxRecords) partial = true;
    if (page > 500) {
      partial = true;
      break;
    }
  }

  debugTrace.push(
    `Selected contacts.search for audience ${mode}${tagName ? ` tag "${tagName}"` : ""}; prepared ${contacts.length} record(s).`
  );
  return {
    mode,
    tagName,
    filters:
      tagName
        ? [
            {
              field: "tags",
              operator: mode === "without" ? "does_not_include" : "includes",
              value: tagName,
            },
          ]
        : [],
    contacts,
    total: total || contacts.length,
    partial,
  };
}

async function fetchPipelines({ call, debugTrace }) {
  const result = await call({
    method: "GET",
    path: "/opportunities/pipelines",
    query: { locationId: getLocationId() },
    reason: "Resolve pipeline and stage for generic GHL workflow",
  });
  debugTrace.push("Selected opportunities.pipelines.list to resolve pipeline/stage names.");
  return collectionFrom(responseData(result), ["pipelines", "data.pipelines", "data", "items"])
    .map(normalizePipeline)
    .filter((pipeline) => pipeline.id || pipeline.name);
}

function resolvePipelineStageFromList({ pipelines, pipelineName, stageName }) {
  const cleanPipelineName = cleanString(pipelineName);
  const cleanStageName = cleanString(stageName);
  let pipeline = null;
  if (cleanPipelineName) {
    pipeline = resolveOneByName(pipelines, cleanPipelineName, "pipeline");
  } else {
    const stageMatches = [];
    for (const item of pipelines) {
      const stage = item.stages.find((candidate) => normalizeName(candidate.name) === normalizeName(cleanStageName));
      if (stage) stageMatches.push({ pipeline: item, stage });
    }
    if (stageMatches.length === 1) return stageMatches[0];
    const error = new Error(
      stageMatches.length > 1
        ? `I found stage "${cleanStageName}" in multiple pipelines. Include the pipeline name.`
        : `I could not find a stage named "${cleanStageName}".`
    );
    error.statusCode = 400;
    throw error;
  }
  const stage = resolveOneByName(pipeline.stages, cleanStageName, "stage");
  return { pipeline, stage };
}

async function collectOlderOpportunities({ days, call, debugTrace, maxRecords = getMaxRecords() }) {
  const cutoffMs = Date.now() - Number(days || 30) * 24 * 60 * 60 * 1000;
  const opportunities = [];
  let partial = false;
  for (let page = 1; opportunities.length < maxRecords; page += 1) {
    const result = await call({
      method: "GET",
      path: "/opportunities/search",
      query: {
        location_id: getLocationId(),
        limit: OPPORTUNITY_PAGE_LIMIT,
        page,
      },
      reason: `Find opportunities older than ${days} days for generic GHL workflow`,
    });
    const raw = collectionFrom(responseData(result), ["opportunities", "data.opportunities", "data", "items"]);
    const pageItems = raw.map(normalizeOpportunity).filter((item) => item.id);
    for (const opportunity of pageItems) {
      const comparableDate = Date.parse(opportunity.updatedAt || opportunity.createdAt || "");
      if (Number.isFinite(comparableDate) && comparableDate < cutoffMs) {
        opportunities.push(opportunity);
        if (opportunities.length >= maxRecords) break;
      }
    }
    if (pageItems.length < OPPORTUNITY_PAGE_LIMIT) break;
    if (opportunities.length >= maxRecords) partial = true;
    if (page > 500) {
      partial = true;
      break;
    }
  }
  debugTrace.push(`Selected opportunities.search and filtered opportunities older than ${days} days.`);
  return { opportunities, partial, cutoff: new Date(cutoffMs).toISOString() };
}

async function fetchUnreadConversations({ call, debugTrace }) {
  const result = await call({
    method: "GET",
    path: "/conversations/search",
    query: { locationId: getLocationId(), limit: CONVERSATION_PAGE_LIMIT },
    reason: "Show unread conversations through generic GHL planner",
  });
  const conversations = collectionFrom(responseData(result), ["conversations", "data.conversations", "data", "items"])
    .map(normalizeConversation)
    .filter((conversation) => conversation.unreadCount > 0);
  debugTrace.push("Selected conversations.search and filtered conversations with unreadCount > 0.");
  return conversations;
}

function previewRecords(records, limit = 10) {
  return asArray(records).slice(0, limit).map((record, index) => ({
    number: index + 1,
    id: record.id,
    name: record.name || record.contactName,
    email: record.email,
    phone: record.phone,
  }));
}

function endpointListFor(keys) {
  const reasons = {
    "contacts.search": "Find contact audience.",
    "contacts.update": "Update matching contacts.",
    "contacts.add_tags": "Add requested tag to matching contacts.",
    "users.search": "Resolve requested owner.",
    "location.tags.list": "Resolve tag names.",
    "opportunities.pipelines.list": "Resolve pipeline and stage.",
    "opportunities.search": "Find or check opportunities.",
    "opportunities.create": "Create missing opportunities.",
    "opportunities.update": "Move existing opportunities.",
    "conversations.search": "Find unread conversations.",
    "locations.get": "Resolve company/location details.",
  };
  return keys.map((key) => endpointSelection(key, reasons[key] || "Selected by generic planner."));
}

function workflowStepsForPlan(plan) {
  return asArray(plan.selectedEndpoints).map((endpoint, index) => ({
    id: `endpoint_${index + 1}`,
    type: "call_endpoint",
    endpointKey: endpoint.key,
    method: endpoint.method,
    path: endpoint.path,
    reason: endpoint.reason,
  }));
}

function basePlan({ operation, objective, neededData, selectedEndpoints, approvalRequired, riskLevel, expectedAffectedRecords, rollbackNotes, debugTrace, execution }) {
  return {
    planner: "generic_ghl_planner",
    plannerVersion: "generic-ghl-planner-v1",
    operation,
    objective,
    neededData,
    selectedEndpoints,
    workflow: {
      name: `generic_${operation}`,
      steps: workflowStepsForPlan({ selectedEndpoints }),
      composition: execution?.composition || [],
    },
    approvalRequired,
    riskLevel,
    expectedAffectedRecords,
    rollbackNotes,
    debugTrace,
    execution: redact(execution || {}),
    confirmationPhraseRequired:
      riskLevel === "high"
        ? HIGH_RISK_CONFIRMATION_PHRASE
        : selectedEndpoints.some((endpoint) => endpoint.destructive)
          ? DESTRUCTIVE_CONFIRMATION_PHRASE
          : "",
  };
}

async function buildGenericGhlPlan({ message, adminUserId, apiCall, intentHint = "" } = {}) {
  const parsed = parseGenericRequest(message);
  if (!parsed || parsed.operation === "unsupported_generic") return null;
  const call = callFactory({ apiCall, adminUserId, userRequest: message });
  const debugTrace = [`Generic planner parsed operation: ${parsed.operation}.`];

  if (parsed.operation === "show_unread_conversations") {
    const selectedEndpoints = endpointListFor(["conversations.search"]);
    const conversations = await fetchUnreadConversations({ call, debugTrace });
    return basePlan({
      operation: parsed.operation,
      objective: "Show unread GHL conversations.",
      neededData: ["Unread/open conversation records"],
      selectedEndpoints,
      approvalRequired: false,
      riskLevel: "low",
      expectedAffectedRecords: 0,
      rollbackNotes: ["Read-only request. No rollback is needed."],
      debugTrace,
      execution: {
        conversations,
        recordCount: conversations.length,
        composition: ["Call conversations.search", "Filter unread conversations", "Return report"],
      },
    });
  }

  if (parsed.operation === "contact_owner_assignment") {
    const selectedEndpoints = endpointListFor([
      "locations.get",
      "users.search",
      "location.tags.list",
      "contacts.search",
      "contacts.update",
    ]);
    const owner = await resolveOwner({
      ownerName: parsed.ownerName,
      call,
      adminUserId,
      userRequest: message,
      debugTrace,
    });
    const audience = await fetchContactsForAudience({ audience: parsed.audience, call, debugTrace });
    return basePlan({
      operation: parsed.operation,
      objective: `Assign owner ${owner.name} to matching contacts.`,
      neededData: ["GHL user ID", "Contact audience by tag"],
      selectedEndpoints,
      approvalRequired: true,
      riskLevel: audience.contacts.length > 100 ? "high" : "medium",
      expectedAffectedRecords: audience.contacts.length,
      rollbackNotes: [
        "Contact owner changes can be reversed by reassigning the previous owner from the audit report.",
      ],
      debugTrace,
      execution: {
        owner,
        audience,
        records: audience.contacts,
        recordCount: audience.contacts.length,
        partial: audience.partial,
        composition: [
          "Resolve owner with users.search",
          "Find contacts by tag with contacts.search",
          "Loop contacts",
          "Skip contacts already assigned",
          "Update assignedTo with contacts.update",
          "Report changed/skipped/failed",
        ],
      },
    });
  }

  if (parsed.operation === "opportunity_create_for_contacts") {
    const selectedEndpoints = endpointListFor([
      "location.tags.list",
      "contacts.search",
      "opportunities.pipelines.list",
      "opportunities.search",
      "opportunities.create",
    ]);
    const audience = await fetchContactsForAudience({ audience: parsed.audience, call, debugTrace });
    const pipelines = await fetchPipelines({ call, debugTrace });
    const { pipeline, stage } = resolvePipelineStageFromList({
      pipelines,
      pipelineName: parsed.pipelineName,
      stageName: parsed.stageName,
    });
    return basePlan({
      operation: parsed.operation,
      objective: `Create missing opportunities in ${pipeline.name} / ${stage.name} for matching contacts.`,
      neededData: ["Contact audience", "Pipeline ID", "Stage ID", "Existing opportunities by contact"],
      selectedEndpoints,
      approvalRequired: true,
      riskLevel: audience.contacts.length > 100 ? "high" : "medium",
      expectedAffectedRecords: audience.contacts.length,
      rollbackNotes: [
        "Created opportunities can be manually deleted or moved in GHL if needed.",
        "The workflow skips contacts that already have an opportunity in the target pipeline.",
      ],
      debugTrace,
      execution: {
        audience,
        pipeline,
        stage,
        records: audience.contacts,
        recordCount: audience.contacts.length,
        partial: audience.partial,
        composition: [
          "Search Contacts with contacts.search",
          audience.tagName
            ? `Filter contacts where tags ${audience.mode === "without" ? "does not include" : "includes"} "${audience.tagName}"`
            : "Filter contacts with the requested logical conditions",
          "Resolve pipeline/stage with opportunities.pipelines.list",
          "Loop matching contacts",
          "Check Opportunity with opportunities.search",
          "Create Opportunity with opportunities.create when missing",
          "Report found/changed/skipped/failed",
        ],
      },
    });
  }

  if (parsed.operation === "move_opportunities_older_than") {
    const selectedEndpoints = endpointListFor([
      "opportunities.search",
      "opportunities.pipelines.list",
      "opportunities.update",
    ]);
    const older = await collectOlderOpportunities({ days: parsed.days, call, debugTrace });
    const pipelines = await fetchPipelines({ call, debugTrace });
    const { pipeline, stage } = resolvePipelineStageFromList({
      pipelines,
      pipelineName: parsed.pipelineName,
      stageName: parsed.stageName,
    });
    return basePlan({
      operation: parsed.operation,
      objective: `Move opportunities older than ${parsed.days} days to ${stage.name}.`,
      neededData: ["Opportunities", "Target stage ID"],
      selectedEndpoints,
      approvalRequired: true,
      riskLevel: older.opportunities.length > 100 ? "high" : "medium",
      expectedAffectedRecords: older.opportunities.length,
      rollbackNotes: [
        "Opportunity stage moves can be reversed from the audit report by moving records back to their previous stage.",
      ],
      debugTrace,
      execution: {
        days: parsed.days,
        cutoff: older.cutoff,
        pipeline,
        stage,
        records: older.opportunities,
        recordCount: older.opportunities.length,
        partial: older.partial,
        composition: [
          "Search opportunities",
          `Filter records older than ${parsed.days} days`,
          "Resolve target stage",
          "Loop opportunities",
          "Update pipelineStageId",
          "Report changed/skipped/failed",
        ],
      },
    });
  }

  if (parsed.operation === "add_tag_to_contacts") {
    const selectedEndpoints = endpointListFor([
      "location.tags.list",
      "contacts.search",
      "contacts.add_tags",
    ]);
    if (!parsed.tagName) {
      const error = new Error("Which tag should I add?");
      error.statusCode = 400;
      throw error;
    }
    const targetTag = await resolveCanonicalTag({ tagName: parsed.tagName, call, debugTrace });
    const audience = await fetchContactsForAudience({ audience: parsed.audience, call, debugTrace });
    return basePlan({
      operation: parsed.operation,
      objective: `Add tag ${targetTag} to matching contacts.`,
      neededData: ["Target tag", "Contact audience"],
      selectedEndpoints,
      approvalRequired: true,
      riskLevel: audience.contacts.length > 100 ? "high" : "medium",
      expectedAffectedRecords: audience.contacts.length,
      rollbackNotes: ["The tag can be removed from affected contacts using the audit report."],
      debugTrace,
      execution: {
        tagName: targetTag,
        audience,
        records: audience.contacts,
        recordCount: audience.contacts.length,
        partial: audience.partial,
        composition: [
          "Resolve requested tag",
          "Find matching contacts",
          "Loop contacts",
          "Skip contacts already tagged",
          "Add tag with contacts.add_tags",
          "Report changed/skipped/failed",
        ],
      },
    });
  }

  return null;
}

function formatEndpointList(endpoints) {
  return asArray(endpoints).map((endpoint) => `${endpoint.method} ${endpoint.path}`);
}

function buildApprovalSummary(plan) {
  const count = Number(plan?.expectedAffectedRecords || 0);
  const approval = plan?.approvalRequired
    ? "Nothing has been changed. Approve to run this workflow."
    : "This is read-only. No approval is required.";
  const partial = plan?.execution?.partial
    ? " I prepared a safe partial record set because the full audience may exceed the configured limit."
    : "";
  return [
    plan?.objective || "Generic GHL workflow prepared.",
    `Records found: ${count.toLocaleString("en-US")}.`,
    `Endpoints: ${formatEndpointList(plan?.selectedEndpoints).join(", ")}.`,
    approval,
    partial,
  ].join(" ");
}

function buildPublicModelPlan(plan) {
  return {
    summary: buildApprovalSummary(plan),
    exactPlan: [
      `Objective: ${plan.objective}`,
      ...asArray(plan.neededData).map((item) => `Needed data: ${item}`),
      ...asArray(plan.workflow?.composition || plan.execution?.composition).map((step) => `Workflow: ${step}`),
      ...asArray(plan.selectedEndpoints).map(
        (endpoint) => `Endpoint: ${endpoint.method} ${endpoint.path} - ${endpoint.reason}`
      ),
      ...asArray(plan.debugTrace).map((line) => `Trace: ${line}`),
    ],
    objectsAffected: [
      `${Number(plan.expectedAffectedRecords || 0).toLocaleString("en-US")} expected record(s)`,
      `Risk: ${plan.riskLevel}`,
      ...(plan.execution?.partial ? ["Prepared record set is partial due to safety limit"] : []),
    ],
    messagesToSendOrCreate: [],
    riskLevel: plan.riskLevel,
    destructive: asArray(plan.selectedEndpoints).some((endpoint) => endpoint.destructive),
  };
}

function readAnswerFromReport(report) {
  if (report?.operation === "show_unread_conversations") {
    const count = Number(report.stats?.recordsFound || 0);
    if (!count) return "I checked GHL. There are no unread conversations in the scanned inbox results.";
    return `I checked GHL. I found ${count.toLocaleString("en-US")} unread conversation${count === 1 ? "" : "s"}.`;
  }
  return report?.summary?.aiSummary || "I checked GHL and prepared the report.";
}

async function executeGenericGhlReadPlan({ plan } = {}) {
  if (!plan || plan.approvalRequired) {
    const error = new Error("Generic read plan is required.");
    error.statusCode = 400;
    throw error;
  }
  const started = Date.now();
  if (plan.operation === "show_unread_conversations") {
    const conversations = asArray(plan.execution?.conversations);
    const report = {
      operation: plan.operation,
      summary: {
        title: "Unread Conversations",
        status: "completed",
        aiSummary: conversations.length
          ? `I found ${conversations.length.toLocaleString("en-US")} unread conversation${conversations.length === 1 ? "" : "s"}.`
          : "I found no unread conversations in the scanned inbox results.",
      },
      stats: {
        recordsFound: conversations.length,
        recordsChanged: 0,
        skipped: 0,
        failed: 0,
      },
      endpointsUsed: plan.selectedEndpoints,
      records: conversations.slice(0, 25),
      warnings: [],
      recommendations: conversations.length
        ? ["Review the unread conversations and reply to the most recent homeowner requests first."]
        : ["No unread conversation follow-up is needed from this scan."],
      executionTime: {
        ms: Date.now() - started,
      },
      debugTrace: plan.debugTrace,
    };
    report.executionTime.label = `${Math.round(report.executionTime.ms / 1000)}s`;
    return {
      intent: "read",
      answer: readAnswerFromReport(report),
      data: redact({
        genericPlanner: true,
        plan,
        report,
      }),
      sources: ["GHL conversations"],
      requiresApproval: false,
    };
  }

  const error = new Error(`Generic read operation ${plan.operation} is not executable yet.`);
  error.statusCode = 422;
  throw error;
}

module.exports = {
  GENERIC_GHL_PLANNER_SCHEMA,
  buildGenericGhlPlan,
  buildGenericGhlPlannerPrompt,
  buildPublicModelPlan,
  executeGenericGhlReadPlan,
  looksLikeGenericGhlPlannerRequest,
  parseGenericRequest,
};
