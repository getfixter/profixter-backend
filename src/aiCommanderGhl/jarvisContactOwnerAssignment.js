const { cleanString } = require("./ghlActions");
const { getLocationId, redact } = require("./ghlClient");
const { executeGhlRequest } = require("./ghlUniversalExecutor");

const CONTACT_PAGE_LIMIT = 100;
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_CONCURRENCY = 2;

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

function firstNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function knownTotalFrom(data) {
  return firstNumber(
    data?.total,
    data?.totalCount,
    data?.count,
    data?.meta?.total,
    data?.meta?.totalCount,
    data?.pagination?.total,
    data?.pagination?.totalCount
  );
}

function normalizeName(value) {
  return cleanString(value)
    .toLowerCase()
    .replace(/["']/g, "")
    .replace(/[^a-z0-9@._+-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanQuotedValue(value) {
  return cleanString(value)
    .replace(/^["']+|["']+$/g, "")
    .replace(/[?.!,]+$/g, "")
    .trim();
}

function cleanTagValue(value) {
  return cleanQuotedValue(value)
    .replace(/\b(?:contacts?|that|who|currently|has|have|with|please|thanks|thank you)\b.*$/i, "")
    .trim();
}

function normalizeTag(value) {
  return cleanTagValue(value).toLowerCase();
}

function responseData(result) {
  return result?.response || result?.data || {};
}

function defaultApiCall(requestShape, options = {}) {
  return executeGhlRequest({
    ...requestShape,
    approved: options.approved === true,
    adminUserId: options.adminUserId,
    userRequest: options.userRequest,
  });
}

function matchFirst(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return cleanQuotedValue(match[1]);
  }
  return "";
}

function extractOwnerName(message) {
  const text = cleanString(message);
  const ownerBeforeAudience = matchFirst(text, [
    /\bassign\s+(?:the\s+)?owner\s+["']([^"']+)["']\s+to\b/i,
    /\bassign\s+(?:the\s+)?owner\s+([a-z][a-z .'-]{1,80}?)\s+to\s+(?:all|every|each|the|contacts?\b)/i,
    /\bassign\s+["']([^"']+)["']\s+to\s+every\s+contact\b/i,
    /\bassign\s+([a-z][a-z .'-]{1,80}?)\s+to\s+every\s+contact\b/i,
  ]);
  if (
    ownerBeforeAudience &&
    !/\b(all|every|contacts?|tagged|with tag|smart list)\b/i.test(ownerBeforeAudience)
  ) {
    return ownerBeforeAudience;
  }

  const ownerAfterAudience = matchFirst(text, [
    /\bassign\s+(?:all|every)\s+.+?\s+contacts?\s+to\s+["']?([a-z][a-z .'-]{1,80}?)(?:[?.!]|$)/i,
    /\bassign\s+.+?\s+with\s+tag\s+.+?\s+to\s+["']?([a-z][a-z .'-]{1,80}?)(?:[?.!]|$)/i,
  ]);
  return ownerAfterAudience;
}

function extractSmartListName(message) {
  return matchFirst(cleanString(message), [
    /\bsmart\s+list\s+["']([^"']+)["']/i,
    /\bsmart\s+list\s+([a-z0-9][\w .:-]{1,100}?)(?:[?.!]|$)/i,
  ]);
}

function extractTagName(message) {
  const text = cleanString(message);
  const explicit = matchFirst(text, [
    /\b(?:has|have)\s+(?:the\s+)?tag\s+["']([^"']+)["']/i,
    /\bwith\s+tag\s+["']([^"']+)["']/i,
    /\btagged\s+["']([^"']+)["']/i,
    /\btag\s+["']([^"']+)["']/i,
    /\b(?:has|have)\s+(?:the\s+)?tag\s+([a-z0-9][\w .:-]{0,100})/i,
    /\bwith\s+tag\s+([a-z0-9][\w .:-]{0,100})/i,
    /\btagged\s+([a-z0-9][\w .:-]{0,100})/i,
  ]);
  if (explicit) return cleanTagValue(explicit);

  const audienceBeforeContacts = matchFirst(text, [
    /\b(?:all|every)\s+([a-z0-9][\w.:-]{1,100})\s+contacts?\b/i,
  ]);
  if (audienceBeforeContacts && !/^contacts?$/i.test(audienceBeforeContacts)) {
    return cleanTagValue(audienceBeforeContacts);
  }

  return "";
}

function parseContactOwnerAssignmentRequest(message) {
  const ownerName = extractOwnerName(message);
  const smartListName = extractSmartListName(message);
  const tagName = smartListName ? "" : extractTagName(message);
  const audienceType = smartListName ? "smart_list" : "tag";

  return {
    ownerName,
    audienceType,
    tagName,
    smartListName,
  };
}

function looksLikeContactOwnerAssignmentRequest(message) {
  const text = cleanString(message);
  if (!/\bassign\b/i.test(text)) return false;
  if (!/\b(owner|contacts?)\b/i.test(text)) return false;
  return /\b(tagged|with tag|has the tag|has tag|smart list|all|every)\b/i.test(text);
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
    role: cleanString(item?.role || item?.type),
  };
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
    assignedTo: cleanString(item?.assignedTo || item?.assignedUserId || item?.ownerId || item?.userId),
    tags,
  };
}

async function fetchUsers({ apiCall, adminUserId, userRequest } = {}) {
  const locationId = getLocationId();
  const call =
    apiCall ||
    ((requestShape) => defaultApiCall(requestShape, { adminUserId, userRequest }));
  const requests = [
    { method: "GET", path: "/users/search", query: { locationId, limit: 100 } },
    { method: "GET", path: `/locations/${encodeURIComponent(locationId)}/users` },
  ];
  let lastError = null;
  for (const requestShape of requests) {
    try {
      const result = await call({
        ...requestShape,
        reason: "Resolve GHL user for contact owner assignment",
      });
      const users = collectionFrom(responseData(result), ["users", "teamMembers", "data", "items"])
        .map(normalizeUser)
        .filter((user) => user.id);
      if (users.length) return users;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return [];
}

function resolveUserByName(users, ownerName) {
  const wanted = normalizeName(ownerName);
  const exact = users.filter((user) => {
    const fullName = normalizeName(user.name);
    const firstLast = normalizeName(`${user.firstName || ""} ${user.lastName || ""}`);
    return fullName === wanted || firstLast === wanted || normalizeName(user.email) === wanted;
  });
  if (exact.length === 1) return exact[0];

  const partial = users.filter((user) => {
    const fullName = normalizeName(user.name);
    const firstLast = normalizeName(`${user.firstName || ""} ${user.lastName || ""}`);
    return fullName.includes(wanted) || firstLast.includes(wanted);
  });
  if (partial.length === 1) return partial[0];

  const error = new Error(
    partial.length > 1 || exact.length > 1
      ? `I found multiple GHL users matching "${ownerName}". Use the exact user name or email.`
      : `I could not find a GHL user named "${ownerName}".`
  );
  error.statusCode = 400;
  error.data = {
    ownerName,
    matchingUsers: redact((partial.length ? partial : exact).map((user) => ({
      id: user.id,
      name: user.name,
      email: user.email,
    }))),
  };
  throw error;
}

async function resolveOwner({ ownerName, apiCall, adminUserId, userRequest } = {}) {
  const cleanOwnerName = cleanString(ownerName);
  if (!cleanOwnerName) {
    const error = new Error("Which GHL user should own these contacts?");
    error.statusCode = 400;
    throw error;
  }
  const users = await fetchUsers({ apiCall, adminUserId, userRequest });
  const owner = resolveUserByName(users, cleanOwnerName);
  return {
    ...owner,
    requestedName: cleanOwnerName,
  };
}

async function resolveCanonicalTagName({ tagName, apiCall, adminUserId, userRequest } = {}) {
  const wanted = cleanTagValue(tagName);
  if (!wanted) {
    const error = new Error("Which contact tag should I use for this owner assignment?");
    error.statusCode = 400;
    throw error;
  }

  const locationId = getLocationId();
  const call =
    apiCall ||
    ((requestShape) => defaultApiCall(requestShape, { adminUserId, userRequest }));
  try {
    const result = await call({
      method: "GET",
      path: `/locations/${encodeURIComponent(locationId)}/tags`,
      reason: "Resolve canonical GHL tag for contact owner assignment",
    });
    const tags = collectionFrom(responseData(result), ["tags", "data", "items"]);
    const exact = tags.find((tag) => normalizeTag(tag?.name || tag?.tag || tag?.label) === normalizeTag(wanted));
    if (exact) return cleanString(exact.name || exact.tag || exact.label) || wanted;
  } catch {
    return wanted;
  }
  return wanted;
}

function contactHasTag(contact, tagName) {
  const wanted = normalizeTag(tagName);
  return asArray(contact.tags).some((tag) => normalizeTag(tag) === wanted);
}

function getMaxPages() {
  const value = Number(process.env.JARVIS_CONTACT_OWNER_ASSIGNMENT_MAX_PAGES);
  if (Number.isFinite(value) && value > 0) return Math.min(500, Math.floor(value));
  return DEFAULT_MAX_PAGES;
}

function getConcurrency() {
  const value = Number(process.env.JARVIS_CONTACT_OWNER_ASSIGNMENT_CONCURRENCY);
  if (Number.isFinite(value) && value > 0) return Math.min(10, Math.floor(value));
  return DEFAULT_CONCURRENCY;
}

async function fetchContactsByTag({
  tagName,
  apiCall,
  adminUserId,
  userRequest,
  maxPages = getMaxPages(),
} = {}) {
  const canonicalTagName = await resolveCanonicalTagName({
    tagName,
    apiCall,
    adminUserId,
    userRequest,
  });
  const call =
    apiCall ||
    ((requestShape) => defaultApiCall(requestShape, { adminUserId, userRequest }));
  const contacts = [];
  let total = null;
  let partial = false;
  let endpointUsed = "POST /contacts/search";

  for (let page = 1; page <= maxPages; page += 1) {
    const result = await call({
      method: "POST",
      path: "/contacts/search",
      body: compact({
        locationId: getLocationId(),
        page,
        pageLimit: CONTACT_PAGE_LIMIT,
        filters: [{ field: "tags", operator: "eq", value: canonicalTagName }],
      }),
      reason: `Find contacts tagged ${canonicalTagName} for contact owner assignment`,
    });
    const data = responseData(result);
    const rawContacts = collectionFrom(data, ["contacts", "data", "items"]);
    const pageContacts = rawContacts.map(normalizeContact).filter((contact) => contact.id);
    contacts.push(...pageContacts);
    const knownTotal = knownTotalFrom(data);
    if (knownTotal !== null) total = knownTotal;
    endpointUsed = cleanString(result?.request?.endpoint) || endpointUsed;

    if (knownTotal !== null && contacts.length >= knownTotal) break;
    if (pageContacts.length < CONTACT_PAGE_LIMIT) break;
    if (page === maxPages) partial = true;
  }

  const filteredContacts = contacts.filter((contact) =>
    contact.tags.length ? contactHasTag(contact, canonicalTagName) : true
  );
  const finalTotal = total !== null ? total : filteredContacts.length;
  return {
    tagName: canonicalTagName,
    contacts: filteredContacts,
    total: finalTotal,
    partial: partial || (total !== null && filteredContacts.length < total),
    endpointUsed,
    maxPages,
  };
}

function previewContacts(contacts, limit = 10) {
  return contacts.slice(0, limit).map((contact, index) => ({
    number: index + 1,
    id: contact.id,
    name: contact.name,
    email: contact.email,
    phone: contact.phone,
    currentOwnerId: contact.assignedTo,
  }));
}

async function prepareContactOwnerAssignment({ message, adminUserId, apiCall } = {}) {
  const parsed = parseContactOwnerAssignmentRequest(message);
  if (parsed.audienceType === "smart_list") {
    const error = new Error(
      `Contact Owner Assignment recognized Smart List "${parsed.smartListName}", but this backend does not have a registered GHL endpoint for saved Smart List membership yet. Use a tag-based audience for now.`
    );
    error.statusCode = 422;
    throw error;
  }
  const owner = await resolveOwner({
    ownerName: parsed.ownerName,
    apiCall,
    adminUserId,
    userRequest: message,
  });
  const audience = await fetchContactsByTag({
    tagName: parsed.tagName,
    apiCall,
    adminUserId,
    userRequest: message,
  });
  return {
    capability: "contact_owner_assignment",
    owner,
    audience: {
      type: "tag",
      tagName: audience.tagName,
      endpointUsed: audience.endpointUsed,
      partial: audience.partial,
      maxPages: audience.maxPages,
    },
    contacts: audience.contacts,
    contactCount: audience.contacts.length,
    totalMatched: audience.total,
    preview: previewContacts(audience.contacts),
    nothingChanged: true,
  };
}

function defaultReport({ ownerName, ownerId, tagName, contacts, startedAt }) {
  return {
    summary: {
      title: "Contact Owner Assignment Completed",
      status: "running",
      aiSummary: "",
    },
    stats: {
      contactsFound: asArray(contacts).length,
      updated: 0,
      alreadyAssigned: 0,
      failed: 0,
      skipped: 0,
      processed: 0,
      successRate: "0.0%",
    },
    warnings: [],
    downloads: [],
    recommendations: [],
    executionTime: {
      ms: 0,
      label: "0s",
    },
    developerDetails: {
      ownerId,
      ownerName,
      tagName,
      endpointCalls: [
        "GET /users/search",
        "GET /locations/:locationId/tags",
        "POST /contacts/search",
        "PUT /contacts/:contactId",
      ],
      startedAt,
      failures: [],
    },
  };
}

function durationLabel(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function updateReportSummary(report, { ownerName, tagName, executionMs }) {
  const stats = report.stats;
  const processed = Number(stats.processed || 0);
  const failed = Number(stats.failed || 0);
  stats.successRate = processed
    ? `${(((processed - failed) / processed) * 100).toFixed(1)}%`
    : "100.0%";
  report.executionTime = {
    ms: executionMs,
    label: durationLabel(executionMs),
  };
  report.summary.status = failed ? "completed_with_errors" : "completed";
  report.summary.aiSummary = [
    `I checked ${Number(stats.contactsFound || 0).toLocaleString("en-US")} contacts tagged "${tagName}".`,
    `${Number(stats.updated || 0).toLocaleString("en-US")} contacts were assigned to ${ownerName}.`,
    `${Number(stats.alreadyAssigned || 0).toLocaleString("en-US")} were already assigned to ${ownerName}.`,
    `${Number(stats.failed || 0).toLocaleString("en-US")} failed.`,
  ].join(" ");
  report.warnings = failed
    ? [`${Number(failed).toLocaleString("en-US")} contact owner updates failed. Review the error report before re-running.`]
    : [];
  report.recommendations = failed
    ? ["Retry the failed contacts after checking the sanitized error report."]
    : ["Spot-check the assigned contacts in GHL and continue with the next operational workflow."];
  report.downloads = [
    {
      label: "Download Audit Report.json",
      filename: "Contact Owner Assignment Audit Report.json",
      contentType: "application/json",
      content: JSON.stringify(redact(report), null, 2),
    },
  ];
}

async function mapWithConcurrency(items, limit, worker) {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      await worker(items[currentIndex], currentIndex);
    }
  });
  await Promise.all(workers);
}

function sanitizeFailure(error, contact) {
  return redact({
    contactId: contact?.id || "",
    name: contact?.name || "",
    email: contact?.email || "",
    phone: contact?.phone || "",
    message: cleanString(error?.message || error),
    statusCode: error?.statusCode || null,
    ghlStatus: error?.ghlStatus || null,
    request: error?.request || null,
    response: error?.response || null,
  });
}

async function executeContactOwnerAssignment({
  ownerId,
  ownerName,
  tagName,
  contacts = [],
  approved = false,
  adminUserId,
  userRequest,
  startedAt = new Date(),
  completedIndexes = [],
  initialReport = null,
  onContactComplete,
  apiCall,
} = {}) {
  const cleanOwnerId = cleanString(ownerId);
  const cleanOwnerName = cleanString(ownerName);
  const cleanTagName = cleanString(tagName);
  if (!cleanOwnerId) {
    const error = new Error("ownerId is required for contact owner assignment.");
    error.statusCode = 400;
    throw error;
  }
  if (approved !== true) {
    const error = new Error("Contact owner assignment requires approval before execution.");
    error.statusCode = 403;
    throw error;
  }

  const safeContacts = asArray(contacts).map(normalizeContact).filter((contact) => contact.id);
  const completed = new Set(asArray(completedIndexes).map(Number).filter(Number.isFinite));
  const report =
    initialReport && typeof initialReport === "object" && initialReport.stats
      ? initialReport
      : defaultReport({
          ownerName: cleanOwnerName,
          ownerId: cleanOwnerId,
          tagName: cleanTagName,
          contacts: safeContacts,
          startedAt,
        });
  report.stats.contactsFound = safeContacts.length;
  report.stats.processed = completed.size;
  report.developerDetails = {
    ...(report.developerDetails || {}),
    ownerId: cleanOwnerId,
    ownerName: cleanOwnerName,
    tagName: cleanTagName,
  };
  const call =
    apiCall ||
    ((requestShape) =>
      defaultApiCall(requestShape, {
        approved: true,
        adminUserId,
        userRequest,
      }));
  const startMs = new Date(startedAt || Date.now()).getTime();

  await mapWithConcurrency(safeContacts, getConcurrency(), async (contact, index) => {
    if (completed.has(index)) return;
    try {
      if (cleanString(contact.assignedTo) === cleanOwnerId) {
        report.stats.alreadyAssigned += 1;
      } else {
        await call({
          method: "PUT",
          path: `/contacts/${encodeURIComponent(contact.id)}`,
          body: { assignedTo: cleanOwnerId },
          reason: `Assign contact owner to ${cleanOwnerName}`,
        });
        report.stats.updated += 1;
      }
    } catch (error) {
      report.stats.failed += 1;
      report.developerDetails.failures = asArray(report.developerDetails.failures);
      report.developerDetails.failures.push(sanitizeFailure(error, contact));
    } finally {
      completed.add(index);
      report.stats.processed = completed.size;
      report.stats.skipped = safeContacts.length - completed.size;
      const executionMs = Date.now() - startMs;
      updateReportSummary(report, {
        ownerName: cleanOwnerName,
        tagName: cleanTagName,
        executionMs,
      });
      if (onContactComplete) {
        await onContactComplete({
          completedIndexes: Array.from(completed).sort((a, b) => a - b),
          processedItems: completed.size,
          totalItems: safeContacts.length,
          percent: safeContacts.length
            ? Math.round((completed.size / safeContacts.length) * 100)
            : 100,
          message: `Processing ${completed.size}/${safeContacts.length}`,
          report,
        });
      }
    }
  });

  updateReportSummary(report, {
    ownerName: cleanOwnerName,
    tagName: cleanTagName,
    executionMs: Date.now() - startMs,
  });
  return redact(report);
}

module.exports = {
  executeContactOwnerAssignment,
  fetchContactsByTag,
  looksLikeContactOwnerAssignmentRequest,
  parseContactOwnerAssignmentRequest,
  prepareContactOwnerAssignment,
  resolveOwner,
};
