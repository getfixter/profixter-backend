const { getLocationId, redact } = require("./ghlClient");
const { executeGhlRequest } = require("./ghlUniversalExecutor");

const DEFAULT_CONCURRENCY = 2;

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

function normalizeTag(value) {
  return cleanString(value).toLowerCase();
}

function recordHasTag(record, tagName) {
  const wanted = normalizeTag(tagName);
  return asArray(record?.tags).some((tag) => {
    if (typeof tag === "string") return normalizeTag(tag) === wanted;
    return normalizeTag(tag?.name || tag?.tag || tag?.label) === wanted;
  });
}

function getConcurrency() {
  const value = Number(process.env.JARVIS_GENERIC_GHL_WORKFLOW_CONCURRENCY);
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

function endpointList(plan) {
  return asArray(plan?.selectedEndpoints).map((endpoint) => ({
    key: endpoint.key,
    method: endpoint.method,
    path: endpoint.path,
    reason: endpoint.reason,
  }));
}

function defaultReport({ plan, records, startedAt }) {
  return {
    operation: cleanString(plan?.operation),
    summary: {
      title: "Generic GHL Workflow Completed",
      status: "running",
      aiSummary: "",
    },
    stats: {
      recordsFound: asArray(records).length,
      recordsChanged: 0,
      skipped: 0,
      failed: 0,
      processed: 0,
      successRate: "0.0%",
    },
    warnings: [],
    downloads: [],
    recommendations: [],
    errors: [],
    endpointsUsed: endpointList(plan),
    requestedObjective: cleanString(plan?.objective),
    rollbackNotes: asArray(plan?.rollbackNotes),
    canResumeSafely: true,
    executionTime: { ms: 0, label: "0s" },
    developerDetails: {
      plannerVersion: cleanString(plan?.plannerVersion),
      debugTrace: asArray(plan?.debugTrace),
      workflowComposition: asArray(plan?.execution?.composition),
      firstMutation: null,
      startedAt,
    },
  };
}

function updateReportSummary(report, plan, executionMs) {
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
  const changed = Number(stats.recordsChanged || 0);
  const skipped = Number(stats.skipped || 0);
  report.summary.title = `${cleanString(plan?.objective || "Generic GHL Workflow")} Completed`;
  report.summary.aiSummary = [
    `I handled: ${cleanString(plan?.objective || "the requested GHL workflow")}.`,
    `${Number(stats.recordsFound || 0).toLocaleString("en-US")} records were found.`,
    `${changed.toLocaleString("en-US")} records changed.`,
    `${skipped.toLocaleString("en-US")} skipped.`,
    `${failed.toLocaleString("en-US")} failed.`,
  ].join(" ");
  report.warnings = failed
    ? [`${failed.toLocaleString("en-US")} record(s) failed. Review the sanitized error details.`]
    : [];
  report.recommendations = failed
    ? ["Resume or retry the failed records after reviewing the error report."]
    : ["Spot-check the changed records in GHL and continue with the next approved workflow."];
  report.downloads = [
    {
      label: "Download Audit Report.json",
      filename: "Generic GHL Workflow Audit Report.json",
      contentType: "application/json",
      content: JSON.stringify(
        redact({
          ...report,
          downloads: asArray(report.downloads).map((download) => ({
            label: download.label,
            filename: download.filename,
            contentType: download.contentType,
          })),
        }),
        null,
        2
      ),
    },
  ];
}

function recordPreview(record) {
  return {
    id: cleanString(record?.id || record?.contactId || record?.opportunityId),
    name: cleanString(record?.name || record?.contactName),
    email: cleanString(record?.email),
    phone: cleanString(record?.phone),
    pipelineStageId: cleanString(record?.pipelineStageId),
  };
}

function sanitizeFailure(error, record, context = {}) {
  const request = redact(error?.request || context.request || null);
  const response = redact(error?.response || null);
  const endpointCalled =
    cleanString(request?.endpoint) ||
    [request?.method, request?.path].map(cleanString).filter(Boolean).join(" ");
  const responseMessage = Array.isArray(response?.message)
    ? response.message.map(cleanString).filter(Boolean).join("; ")
    : cleanString(response?.message || response?.error || response?.code);
  return redact({
    actionName: "Generic GHL Workflow",
    step: context.step || "Executing generic workflow record",
    record: recordPreview(record),
    endpointCalled,
    httpStatus: error?.ghlStatus || error?.statusCode || null,
    message: cleanString(error?.message || error),
    ghlErrorMessage: responseMessage || cleanString(error?.message || error),
    request,
    response,
    canResumeSafely: true,
  });
}

function defaultApiCall(requestShape, options = {}) {
  return executeGhlRequest({
    ...requestShape,
    approved: options.approved === true,
    confirmationPhrase: options.confirmationPhrase,
    adminUserId: options.adminUserId,
    userRequest: options.userRequest,
  });
}

async function findExistingOpportunity({ contactId, pipelineId, call }) {
  const result = await call({
    method: "GET",
    path: "/opportunities/search",
    query: compact({
      location_id: getLocationId(),
      contact_id: contactId,
      pipeline_id: pipelineId,
      limit: 100,
      page: 1,
    }),
    reason: "Generic workflow checking existing opportunity before create",
  });
  const opportunities = collectionFrom(responseData(result), [
    "opportunities",
    "data.opportunities",
    "data",
    "items",
  ]);
  return opportunities.some((opportunity) => {
    const oppContactId = cleanString(opportunity?.contactId || opportunity?.contact_id || opportunity?.contact?.id);
    const oppPipelineId = cleanString(opportunity?.pipelineId || opportunity?.pipeline_id || opportunity?.pipeline?.id);
    return oppContactId === cleanString(contactId) && oppPipelineId === cleanString(pipelineId);
  });
}

function opportunityName(contact, pipelineName) {
  const label = cleanString(contact?.name || contact?.email || contact?.phone || contact?.id);
  return `${cleanString(pipelineName) || "Opportunity"} - ${label || "GHL Contact"}`;
}

async function executeRecord({ plan, record, call, report }) {
  const operation = cleanString(plan?.operation);
  const execution = plan?.execution || {};

  if (operation === "contact_owner_assignment") {
    const owner = execution.owner || {};
    if (cleanString(record.assignedTo) === cleanString(owner.id)) {
      report.stats.skipped += 1;
      return;
    }
    const request = {
      method: "PUT",
      path: `/contacts/${encodeURIComponent(record.id)}`,
      body: { assignedTo: owner.id },
      reason: "Generic workflow assigning contact owner",
    };
    if (!report.developerDetails.firstMutation) {
      report.developerDetails.firstMutation = redact({
        endpoint: `${request.method} ${request.path}`,
        payload: request.body,
        record: recordPreview(record),
      });
    }
    await call(request);
    report.stats.recordsChanged += 1;
    return;
  }

  if (operation === "opportunity_create_for_contacts") {
    const pipeline = execution.pipeline || {};
    const stage = execution.stage || {};
    const exists = await findExistingOpportunity({
      contactId: record.id,
      pipelineId: pipeline.id,
      call,
    });
    if (exists) {
      report.stats.skipped += 1;
      return;
    }
    const request = {
      method: "POST",
      path: "/opportunities/",
      body: compact({
        locationId: getLocationId(),
        pipelineId: pipeline.id,
        pipelineStageId: stage.id,
        status: "open",
        contactId: record.id,
        name: opportunityName(record, pipeline.name),
        source: "Jarvis Generic GHL Planner",
      }),
      reason: "Generic workflow creating missing opportunity",
    };
    if (!report.developerDetails.firstMutation) {
      report.developerDetails.firstMutation = redact({
        endpoint: `${request.method} ${request.path}`,
        payload: request.body,
        record: recordPreview(record),
      });
    }
    await call(request);
    report.stats.recordsChanged += 1;
    return;
  }

  if (operation === "move_opportunities_older_than") {
    const stage = execution.stage || {};
    if (cleanString(record.pipelineStageId) === cleanString(stage.id)) {
      report.stats.skipped += 1;
      return;
    }
    const request = {
      method: "PUT",
      path: `/opportunities/${encodeURIComponent(record.id)}`,
      body: compact({
        pipelineId: execution.pipeline?.id || record.pipelineId,
        pipelineStageId: stage.id,
        status: record.status || "open",
      }),
      reason: "Generic workflow moving opportunity stage",
    };
    if (!report.developerDetails.firstMutation) {
      report.developerDetails.firstMutation = redact({
        endpoint: `${request.method} ${request.path}`,
        payload: request.body,
        record: recordPreview(record),
      });
    }
    await call(request);
    report.stats.recordsChanged += 1;
    return;
  }

  if (operation === "add_tag_to_contacts") {
    const tagName = cleanString(execution.tagName);
    if (recordHasTag(record, tagName)) {
      report.stats.skipped += 1;
      return;
    }
    const request = {
      method: "POST",
      path: `/contacts/${encodeURIComponent(record.id)}/tags`,
      body: { tags: [tagName] },
      reason: "Generic workflow adding tag to contact",
    };
    if (!report.developerDetails.firstMutation) {
      report.developerDetails.firstMutation = redact({
        endpoint: `${request.method} ${request.path}`,
        payload: request.body,
        record: recordPreview(record),
      });
    }
    await call(request);
    report.stats.recordsChanged += 1;
    return;
  }

  const error = new Error(`Unsupported generic GHL workflow operation: ${operation}`);
  error.statusCode = 422;
  throw error;
}

async function executeGenericGhlWorkflow({
  plan,
  approved = false,
  adminUserId,
  userRequest,
  confirmationPhrase = "",
  startedAt = new Date(),
  completedIndexes = [],
  initialReport = null,
  onRecordComplete,
  apiCall,
} = {}) {
  if (approved !== true) {
    const error = new Error("Generic GHL workflow requires approval before execution.");
    error.statusCode = 403;
    throw error;
  }
  const safePlan = plan && typeof plan === "object" ? plan : {};
  const records = asArray(safePlan.execution?.records);
  const completed = new Set(asArray(completedIndexes).map(Number).filter(Number.isFinite));
  const report =
    initialReport && typeof initialReport === "object" && initialReport.stats
      ? initialReport
      : defaultReport({ plan: safePlan, records, startedAt });
  report.stats.recordsFound = records.length;
  report.stats.processed = completed.size;

  const call =
    apiCall ||
    ((requestShape) =>
      defaultApiCall(requestShape, {
        approved: true,
        confirmationPhrase,
        adminUserId,
        userRequest,
      }));
  const startMs = new Date(startedAt || Date.now()).getTime();

  await mapWithConcurrency(records, getConcurrency(), async (record, index) => {
    if (completed.has(index)) return;
    try {
      await executeRecord({ plan: safePlan, record, call, report });
    } catch (error) {
      report.stats.failed += 1;
      const failure = sanitizeFailure(error, record);
      report.errors = asArray(report.errors);
      report.errors.push(failure);
    } finally {
      completed.add(index);
      report.stats.processed = completed.size;
      const executionMs = Date.now() - startMs;
      updateReportSummary(report, safePlan, executionMs);
      if (onRecordComplete) {
        await onRecordComplete({
          completedIndexes: Array.from(completed).sort((a, b) => a - b),
          processedItems: completed.size,
          totalItems: records.length,
          percent: records.length ? Math.round((completed.size / records.length) * 100) : 100,
          message: `Processing ${completed.size}/${records.length}`,
          report,
        });
      }
    }
  });

  updateReportSummary(report, safePlan, Date.now() - startMs);
  return redact(report);
}

module.exports = {
  executeGenericGhlWorkflow,
};
