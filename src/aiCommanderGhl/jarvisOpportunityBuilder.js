const { cleanString } = require("./ghlActions");
const { getLocationId, redact } = require("./ghlClient");
const { executeGhlRequest } = require("./ghlUniversalExecutor");
const { fetchContactsByTag } = require("./jarvisContactOwnerAssignment");

const DEFAULT_CONCURRENCY = 2;
const OPPORTUNITY_SEARCH_LIMIT = 100;

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

function cleanAudienceValue(value) {
  return cleanQuotedValue(value)
    .replace(/\b(?:contacts?|people|leads?|customers?)\b.*$/i, "")
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
  return cleanAudienceValue(value).toLowerCase();
}

function matchFirst(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return cleanQuotedValue(match[1]);
  }
  return "";
}

function extractTagName(message) {
  const text = cleanString(message);
  const explicit = matchFirst(text, [
    /\bonly\s+contacts\s+with\s+tag\s+["']([^"']+)["']/i,
    /\ball\s+contacts\s+that\s+have\s+(?:the\s+)?tag\s+["']([^"']+)["']/i,
    /\ball\s+contacts\s+with\s+tag\s+["']([^"']+)["']/i,
    /\beveryone\s+tagged\s+["']([^"']+)["']/i,
    /\bcontacts?\s+tagged\s+["']([^"']+)["']/i,
    /\b(?:has|have|with)\s+(?:the\s+)?tag\s+["']([^"']+)["']/i,
    /\btag\s+["']([^"']+)["']/i,
    /\bexcept\s+those\s+who\s+do\s+not\s+have\s+(?:the\s+)?tag\s+["']([^"']+)["']/i,
  ]);
  if (explicit) return cleanAudienceValue(explicit);

  const unquoted = matchFirst(text, [
    /\bonly\s+contacts\s+with\s+tag\s+([a-z0-9][\w .:-]{0,100}?)(?=\s+(?:to|into|for|in|pipeline|stage)\b|[?.!]|$)/i,
    /\ball\s+contacts\s+that\s+have\s+(?:the\s+)?tag\s+([a-z0-9][\w .:-]{0,100}?)(?=\s+(?:to|into|for|in|pipeline|stage)\b|[?.!]|$)/i,
    /\ball\s+contacts\s+with\s+tag\s+([a-z0-9][\w .:-]{0,100}?)(?=\s+(?:to|into|for|in|pipeline|stage)\b|[?.!]|$)/i,
    /\beveryone\s+tagged\s+([a-z0-9][\w .:-]{0,100}?)(?=\s+(?:to|into|for|in|pipeline|stage)\b|[?.!]|$)/i,
    /\bcontacts?\s+tagged\s+([a-z0-9][\w .:-]{0,100}?)(?=\s+(?:to|into|for|in|pipeline|stage)\b|[?.!]|$)/i,
    /\b(?:has|have|with)\s+(?:the\s+)?tag\s+([a-z0-9][\w .:-]{0,100}?)(?=\s+(?:to|into|for|in|pipeline|stage)\b|[?.!]|$)/i,
    /\bexcept\s+those\s+who\s+do\s+not\s+have\s+(?:the\s+)?tag\s+([a-z0-9][\w .:-]{0,100}?)(?=\s+(?:to|into|for|in|pipeline|stage)\b|[?.!]|$)/i,
  ]);
  return cleanAudienceValue(unquoted);
}

function extractPipelineName(message) {
  const text = cleanString(message);
  const quoted = matchFirst(text, [
    /\b(?:opportunity\s+)?pipeline\s+["']([^"']+)["']/i,
    /\bto\s+(?:the\s+)?(?:opportunity\s+)?pipeline\s+["']([^"']+)["']/i,
  ]);
  if (quoted) return quoted;

  return matchFirst(text, [
    /\b(?:opportunity\s+)?pipeline\s+([a-z0-9][\w .&'/-]{1,120}?)(?=\s+(?:in|at)\s+stage\b|\s+stage\b|[?.!]|$)/i,
    /\bto\s+(?:the\s+)?(?:opportunity\s+)?pipeline\s+([a-z0-9][\w .&'/-]{1,120}?)(?=\s+(?:in|at)\s+stage\b|\s+stage\b|[?.!]|$)/i,
  ]);
}

function extractStageName(message) {
  const text = cleanString(message);
  const quoted = matchFirst(text, [
    /\b(?:in|at)\s+stage\s+["']([^"']+)["']/i,
    /\bstage\s+["']([^"']+)["']/i,
  ]);
  if (quoted) return quoted;

  return matchFirst(text, [
    /\b(?:in|at)\s+stage\s+([a-z0-9][\w .&'/-]{1,120}?)(?=[?.!]|$)/i,
    /\bstage\s+([a-z0-9][\w .&'/-]{1,120}?)(?=[?.!]|$)/i,
  ]);
}

function parseOpportunityBuilderRequest(message) {
  return {
    audienceType: "tag",
    tagName: extractTagName(message),
    pipelineName: extractPipelineName(message),
    stageName: extractStageName(message),
  };
}

function looksLikeOpportunityBuilderRequest(message) {
  const text = cleanString(message);
  if (/\b(delete|remove|archive)\b/i.test(text)) return false;
  if (!/\b(opportunit|pipeline)\b/i.test(text)) return false;
  if (!/\b(contacts?|everyone|tagged|with tag|have tag|has tag)\b/i.test(text)) return false;
  return (
    /\b(add|create|put)\b/i.test(text) ||
    /\b(only contacts with tag|all contacts that have tag|all contacts with tag|everyone tagged|contacts tagged)\b/i.test(
      text
    )
  );
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
    tags,
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
  };
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
  error.data = {
    requestedName,
    matches: redact((partial.length ? partial : exact).map((item) => ({
      id: item.id,
      name: item.name,
    }))),
  };
  throw error;
}

function defaultApiCall(requestShape, options = {}) {
  return executeGhlRequest({
    ...requestShape,
    approved: options.approved === true,
    adminUserId: options.adminUserId,
    userRequest: options.userRequest,
  });
}

async function fetchPipelines({ apiCall, adminUserId, userRequest } = {}) {
  const call =
    apiCall ||
    ((requestShape) => defaultApiCall(requestShape, { adminUserId, userRequest }));
  const result = await call({
    method: "GET",
    path: "/opportunities/pipelines",
    query: { locationId: getLocationId() },
    reason: "Resolve opportunity pipeline and stage for Opportunity Builder",
  });
  return collectionFrom(responseData(result), [
    "pipelines",
    "data.pipelines",
    "data",
    "items",
  ])
    .map(normalizePipeline)
    .filter((pipeline) => pipeline.id || pipeline.name);
}

async function resolvePipelineAndStage({
  pipelineName,
  stageName,
  apiCall,
  adminUserId,
  userRequest,
} = {}) {
  const cleanPipelineName = cleanString(pipelineName);
  const cleanStageName = cleanString(stageName);
  if (!cleanPipelineName) {
    const error = new Error("Which opportunity pipeline should I use?");
    error.statusCode = 400;
    throw error;
  }
  if (!cleanStageName) {
    const error = new Error("Which opportunity stage should I use?");
    error.statusCode = 400;
    throw error;
  }

  const pipelines = await fetchPipelines({ apiCall, adminUserId, userRequest });
  const pipeline = resolveOneByName(pipelines, cleanPipelineName, "pipeline");
  const stage = resolveOneByName(pipeline.stages, cleanStageName, "stage");
  return { pipeline, stage, pipelines };
}

function previewContacts(contacts, limit = 10) {
  return contacts.slice(0, limit).map((contact, index) => ({
    number: index + 1,
    id: contact.id,
    name: contact.name,
    email: contact.email,
    phone: contact.phone,
  }));
}

function opportunityNameForContact(contact, pipelineName) {
  const label = cleanString(contact?.name || contact?.email || contact?.phone || contact?.id);
  return `${cleanString(pipelineName) || "Opportunity"} - ${label || "GHL Contact"}`;
}

function buildOpportunityBody({ contact, pipelineId, pipelineName, stageId }) {
  return compact({
    locationId: getLocationId(),
    pipelineId,
    pipelineStageId: stageId,
    status: "open",
    contactId: contact.id,
    name: opportunityNameForContact(contact, pipelineName),
    source: "Jarvis Opportunity Builder",
  });
}

async function dryRunOpportunityCreatePayload({
  contact,
  pipelineId,
  pipelineName,
  stageId,
  apiCall,
  adminUserId,
  userRequest,
} = {}) {
  if (!contact?.id || !pipelineId || !stageId) return null;
  const call =
    apiCall ||
    ((requestShape) => defaultApiCall(requestShape, { adminUserId, userRequest }));
  return call({
    method: "POST",
    path: "/opportunities/",
    body: buildOpportunityBody({ contact, pipelineId, pipelineName, stageId }),
    dryRun: true,
    reason: "Dry-run opportunity creation payload",
  });
}

async function prepareOpportunityBuilder({ message, adminUserId, apiCall } = {}) {
  const parsed = parseOpportunityBuilderRequest(message);
  if (!parsed.tagName) {
    const error = new Error("Which contact tag should I use for this Opportunity Builder workflow?");
    error.statusCode = 400;
    throw error;
  }

  const audience = await fetchContactsByTag({
    tagName: parsed.tagName,
    apiCall,
    adminUserId,
    userRequest: message,
  });
  const { pipeline, stage } = await resolvePipelineAndStage({
    pipelineName: parsed.pipelineName,
    stageName: parsed.stageName,
    apiCall,
    adminUserId,
    userRequest: message,
  });
  const contacts = audience.contacts.map(normalizeContact).filter((contact) => contact.id);
  const dryRun = await dryRunOpportunityCreatePayload({
    contact: contacts[0],
    pipelineId: pipeline.id,
    pipelineName: pipeline.name,
    stageId: stage.id,
    apiCall,
    adminUserId,
    userRequest: message,
  });

  return {
    capability: "opportunity_builder",
    audience: {
      type: "tag",
      tagName: audience.tagName,
      endpointUsed: audience.endpointUsed,
      partial: audience.partial,
      maxPages: audience.maxPages,
    },
    pipeline,
    stage,
    contacts,
    contactCount: contacts.length,
    totalMatched: audience.total,
    preview: previewContacts(contacts),
    opportunityCreateDryRun: dryRun,
    nothingChanged: true,
  };
}

function getConcurrency() {
  const value = Number(process.env.JARVIS_OPPORTUNITY_BUILDER_CONCURRENCY);
  if (Number.isFinite(value) && value > 0) return Math.min(10, Math.floor(value));
  return DEFAULT_CONCURRENCY;
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

function durationLabel(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function contactPreview(contact) {
  const normalized = normalizeContact(contact || {});
  return {
    id: normalized.id,
    name: normalized.name,
    email: normalized.email,
    phone: normalized.phone,
  };
}

function downloadMetadata(download) {
  const content = cleanString(download?.content);
  return {
    label: cleanString(download?.label),
    filename: cleanString(download?.filename),
    contentType: cleanString(download?.contentType),
    contentBytes: content ? Buffer.byteLength(content, "utf8") : 0,
  };
}

function auditSnapshotForDownload(report) {
  const snapshot = {
    ...report,
    downloads: asArray(report?.downloads).map(downloadMetadata),
  };
  return redact(snapshot);
}

function csvEscape(value) {
  const text = cleanString(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function errorsCsv(errors) {
  const rows = [
    [
      "contactId",
      "name",
      "email",
      "phone",
      "endpoint",
      "httpStatus",
      "message",
    ],
    ...asArray(errors).map((error) => [
      error.contactId,
      error.name,
      error.email,
      error.phone,
      error.endpointCalled,
      error.httpStatus || error.ghlStatus || error.statusCode,
      error.ghlErrorMessage || error.message,
    ]),
  ];
  return rows.map((row) => row.map(csvEscape).join(",")).join("\n");
}

function defaultReport({ tagName, pipelineName, pipelineId, stageName, stageId, contacts, startedAt }) {
  return {
    summary: {
      title: "Opportunity Builder Completed",
      status: "running",
      aiSummary: "",
    },
    stats: {
      contactsFound: asArray(contacts).length,
      opportunitiesCreated: 0,
      alreadyExisted: 0,
      failed: 0,
      skipped: 0,
      processed: 0,
      successRate: "0.0%",
    },
    warnings: [],
    downloads: [],
    recommendations: [],
    errors: [],
    executionTime: {
      ms: 0,
      label: "0s",
    },
    developerDetails: {
      tagName,
      pipelineName,
      pipelineId,
      stageName,
      stageId,
      dryRunResult: null,
      firstActualCreate: null,
      endpointCalls: [
        "GET /locations/:locationId/tags",
        "POST /contacts/search",
        "GET /opportunities/pipelines",
        "GET /opportunities/search",
        "POST /opportunities/",
      ],
      startedAt,
      failures: [],
    },
  };
}

function updateReportSummary(report, { tagName, pipelineName, stageName, executionMs }) {
  const stats = report.stats;
  const processed = Number(stats.processed || 0);
  const failed = Number(stats.failed || 0);
  const created = Number(stats.opportunitiesCreated || 0);
  const alreadyExisted = Number(stats.alreadyExisted || 0);
  stats.successRate = processed
    ? `${(((processed - failed) / processed) * 100).toFixed(1)}%`
    : "100.0%";
  report.executionTime = {
    ms: executionMs,
    label: durationLabel(executionMs),
  };
  report.summary.status = failed ? "completed_with_errors" : "completed";
  if (created > 0) {
    report.summary.aiSummary = [
      `I checked ${Number(stats.contactsFound || 0).toLocaleString("en-US")} contacts tagged "${tagName}".`,
      `${created.toLocaleString("en-US")} new opportunities were created in "${pipelineName}" / "${stageName}".`,
      `${alreadyExisted.toLocaleString("en-US")} already had an opportunity in that pipeline and were skipped.`,
      `${failed.toLocaleString("en-US")} failed.`,
    ].join(" ");
  } else if (alreadyExisted > 0 && failed === 0) {
    report.summary.aiSummary = [
      `I checked ${Number(stats.contactsFound || 0).toLocaleString("en-US")} contacts tagged "${tagName}".`,
      "No new opportunities were needed.",
      `${alreadyExisted.toLocaleString("en-US")} contacts already had an opportunity in "${pipelineName}".`,
    ].join(" ");
  } else {
    report.summary.aiSummary = [
      `I checked ${Number(stats.contactsFound || 0).toLocaleString("en-US")} contacts tagged "${tagName}".`,
      `${created.toLocaleString("en-US")} opportunities were created.`,
      `${alreadyExisted.toLocaleString("en-US")} already existed.`,
      `${failed.toLocaleString("en-US")} failed.`,
    ].join(" ");
  }

  report.warnings = failed
    ? [
        `${Number(failed).toLocaleString("en-US")} opportunity workflow records failed. Review the error report before re-running.`,
      ]
    : [];
  report.recommendations = failed
    ? ["Retry the failed contacts after reviewing the sanitized GHL response."]
    : created > 0
      ? [
          `Review the newly created "${stageName}" opportunities in "${pipelineName}".`,
          "Assign follow-up tasks or launch the next approved sales workflow.",
        ]
      : ["No opportunity creation was required. Continue with the next sales workflow."];
  report.downloads = [
    {
      label: "Download Audit Report.json",
      filename: "Opportunity Builder Audit Report.json",
      contentType: "application/json",
      content: JSON.stringify(auditSnapshotForDownload(report), null, 2),
    },
  ];
  if (failed) {
    report.downloads.push({
      label: "Download Error Report.csv",
      filename: "Opportunity Builder Error Report.csv",
      contentType: "text/csv",
      content: errorsCsv(report.errors),
    });
  }
}

function sanitizeFailure(error, contact, context = {}) {
  const request = redact(error?.request || context.request || null);
  const response = redact(error?.response || null);
  const endpointCalled =
    cleanString(request?.endpoint) ||
    [request?.method, request?.path].map(cleanString).filter(Boolean).join(" ");
  const status = error?.ghlStatus || error?.statusCode || null;
  const responseMessage = Array.isArray(response?.message)
    ? response.message.map(cleanString).filter(Boolean).join("; ")
    : cleanString(response?.message || response?.error || response?.code);
  return redact({
    actionName: "Opportunity Builder",
    step: context.step || "Creating opportunity",
    contactId: contact?.id || "",
    name: contact?.name || "",
    email: contact?.email || "",
    phone: contact?.phone || "",
    contact: contactPreview(contact),
    message: cleanString(error?.message || error),
    statusCode: error?.statusCode || null,
    ghlStatus: error?.ghlStatus || null,
    httpStatus: status,
    endpointCalled,
    payload: request?.body || null,
    request,
    response,
    ghlErrorMessage: responseMessage || cleanString(error?.message || error),
    ghlErrorBody: response,
  });
}

function opportunityMatchesContactPipeline(opportunity, contactId, pipelineId) {
  return (
    cleanString(opportunity.contactId) === cleanString(contactId) &&
    cleanString(opportunity.pipelineId) === cleanString(pipelineId)
  );
}

async function findExistingOpportunity({
  contact,
  pipelineId,
  apiCall,
  adminUserId,
  userRequest,
} = {}) {
  const call =
    apiCall ||
    ((requestShape) =>
      defaultApiCall(requestShape, {
        adminUserId,
        userRequest,
      }));
  const result = await call({
    method: "GET",
    path: "/opportunities/search",
    query: compact({
      location_id: getLocationId(),
      contact_id: contact.id,
      pipeline_id: pipelineId,
      limit: OPPORTUNITY_SEARCH_LIMIT,
      page: 1,
    }),
    reason: "Check whether contact already has an opportunity in the requested pipeline",
  });
  const opportunities = collectionFrom(responseData(result), [
    "opportunities",
    "data.opportunities",
    "data",
    "items",
  ]).map(normalizeOpportunity);
  const matches = opportunities.filter((opportunity) =>
    opportunityMatchesContactPipeline(opportunity, contact.id, pipelineId)
  );
  return {
    matches,
    endpointUsed: cleanString(result?.request?.endpoint) || "GET /opportunities/search",
  };
}

async function executeOpportunityBuilder({
  tagName,
  pipelineId,
  pipelineName,
  stageId,
  stageName,
  contacts = [],
  approved = false,
  adminUserId,
  userRequest,
  startedAt = new Date(),
  completedIndexes = [],
  initialReport = null,
  dryRunResult = null,
  onContactComplete,
  apiCall,
} = {}) {
  const cleanTagName = cleanString(tagName);
  const cleanPipelineId = cleanString(pipelineId);
  const cleanPipelineName = cleanString(pipelineName);
  const cleanStageId = cleanString(stageId);
  const cleanStageName = cleanString(stageName);
  if (approved !== true) {
    const error = new Error("Opportunity Builder requires approval before execution.");
    error.statusCode = 403;
    throw error;
  }
  if (!cleanPipelineId || !cleanStageId) {
    const error = new Error("pipelineId and stageId are required for Opportunity Builder.");
    error.statusCode = 400;
    throw error;
  }

  const safeContacts = asArray(contacts).map(normalizeContact).filter((contact) => contact.id);
  const completed = new Set(asArray(completedIndexes).map(Number).filter(Number.isFinite));
  const report =
    initialReport && typeof initialReport === "object" && initialReport.stats
      ? initialReport
      : defaultReport({
          tagName: cleanTagName,
          pipelineName: cleanPipelineName,
          pipelineId: cleanPipelineId,
          stageName: cleanStageName,
          stageId: cleanStageId,
          contacts: safeContacts,
          startedAt,
        });
  report.stats.contactsFound = safeContacts.length;
  report.stats.processed = completed.size;
  report.developerDetails = {
    ...(report.developerDetails || {}),
    tagName: cleanTagName,
    pipelineName: cleanPipelineName,
    pipelineId: cleanPipelineId,
    stageName: cleanStageName,
    stageId: cleanStageId,
    dryRunResult: redact(dryRunResult || report.developerDetails?.dryRunResult || null),
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
      const existing = await findExistingOpportunity({
        contact,
        pipelineId: cleanPipelineId,
        apiCall: call,
        adminUserId,
        userRequest,
      });
      if (existing.matches.length) {
        report.stats.alreadyExisted += 1;
      } else {
        const createRequest = {
          method: "POST",
          path: "/opportunities/",
          body: buildOpportunityBody({
            contact,
            pipelineId: cleanPipelineId,
            pipelineName: cleanPipelineName,
            stageId: cleanStageId,
          }),
          reason: `Create ${cleanPipelineName} opportunity for tagged contact`,
        };
        if (!report.developerDetails.firstActualCreate) {
          report.developerDetails.firstActualCreate = redact({
            endpoint: `${createRequest.method} ${createRequest.path}`,
            payload: createRequest.body,
            contact: contactPreview(contact),
          });
        }
        await call(createRequest);
        report.stats.opportunitiesCreated += 1;
      }
    } catch (error) {
      report.stats.failed += 1;
      report.developerDetails.failures = asArray(report.developerDetails.failures);
      const failure = sanitizeFailure(error, contact, {
        step: "Checking or creating contact opportunity",
        request: error?.request || {
          method: "WORKFLOW",
          path: "jarvis://opportunities/builder",
        },
      });
      report.developerDetails.failures.push(failure);
      report.errors = asArray(report.errors);
      report.errors.push(failure);
    } finally {
      completed.add(index);
      report.stats.processed = completed.size;
      report.stats.skipped = safeContacts.length - completed.size;
      const executionMs = Date.now() - startMs;
      updateReportSummary(report, {
        tagName: cleanTagName,
        pipelineName: cleanPipelineName,
        stageName: cleanStageName,
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
    tagName: cleanTagName,
    pipelineName: cleanPipelineName,
    stageName: cleanStageName,
    executionMs: Date.now() - startMs,
  });
  return redact(report);
}

module.exports = {
  executeOpportunityBuilder,
  looksLikeOpportunityBuilderRequest,
  parseOpportunityBuilderRequest,
  prepareOpportunityBuilder,
  resolvePipelineAndStage,
};
