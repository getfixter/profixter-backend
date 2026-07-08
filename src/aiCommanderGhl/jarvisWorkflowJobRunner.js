const crypto = require("crypto");

const AiCommanderGhlAudit = require("./aiCommanderGhl.audit.model");
const JarvisWorkflowJob = require("./jarvisWorkflowJob.model");
const { parseJsonObjectText } = require("./ghlActions");
const { redact } = require("./ghlClient");
const { executeContactOwnerAssignment } = require("./jarvisContactOwnerAssignment");
const { syncEstimateCsvWithGhl } = require("./jarvisCsvGhlSync");
const { executeWorkflow } = require("./jarvisWorkflowExecutor");

const runningJobs = new Set();
const PROGRESS_EVENT_LIMIT = 250;

function cleanString(value) {
  return String(value ?? "").trim();
}

function titleCase(value) {
  return cleanString(value)
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function durationLabel(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function responseMessageFromError(error) {
  const response = error?.response || {};
  const message = response.message;
  if (Array.isArray(message)) return message.map(cleanString).filter(Boolean).join("; ");
  return cleanString(message || response.error || response.code || error?.message || error);
}

function actionLabelFromType(actionType) {
  return titleCase(actionType || "workflow");
}

function firstContactFromPayload(payload = {}) {
  const preview = Array.isArray(payload.preview) ? payload.preview : [];
  const contacts = Array.isArray(payload.contacts) ? payload.contacts : [];
  const contact = preview[0] || contacts[0] || null;
  if (!contact || typeof contact !== "object") return null;
  return {
    id: cleanString(contact.id || contact.contactId),
    name: cleanString(contact.name),
    email: cleanString(contact.email),
    phone: cleanString(contact.phone),
    currentOwnerId: cleanString(contact.currentOwnerId || contact.assignedTo),
  };
}

function buildGenericWorkflowFailureReport(job, error) {
  const report = job?.report && typeof job.report === "object" ? job.report : {};
  const stats = report.stats && typeof report.stats === "object" ? report.stats : {};
  const updated = Number(stats.updated || stats.recordsChanged || 0);
  const alreadyAssigned = Number(stats.alreadyAssigned || 0);
  const processed = Number(job?.processedItems || stats.processed || 0);
  const total = Number(job?.totalItems || stats.contactsFound || 0);
  const failed = Number(stats.failed || 1);
  const remaining = Math.max(0, total - processed);
  const endpointCalled =
    cleanString(error?.request?.endpoint) ||
    [error?.request?.method, error?.request?.path].map(cleanString).filter(Boolean).join(" ");
  const httpStatus = error?.ghlStatus || error?.statusCode || null;
  const message = responseMessageFromError(error);

  return {
    actionName: actionLabelFromType(job?.actionType),
    stepFailed: cleanString(job?.currentMessage) || `Running ${actionLabelFromType(job?.actionType)}`,
    endpointCalled,
    httpStatus,
    ghlErrorMessage: message,
    ghlErrorBody: error?.response || null,
    payload: error?.request?.body || null,
    firstAffectedContact: firstContactFromPayload(job?.payload),
    anythingChangedBeforeFailure: updated > 0,
    recordsProcessedBeforeFailure: processed,
    recordsSucceeded: updated + alreadyAssigned,
    recordsChanged: updated,
    recordsFailed: failed,
    recordsRemaining: remaining,
    canResumeSafely: total > 0,
    resumeReason:
      updated > 0 || remaining > 0
        ? `${updated.toLocaleString("en-US")} updated before failure. ${remaining.toLocaleString("en-US")} remaining. You can resume safely.`
        : "No records were changed before failure. You can retry after reviewing the error.",
    message: endpointCalled
      ? `Failed while running ${actionLabelFromType(job?.actionType)}. GHL returned ${httpStatus || "an error"}: ${message}`
      : `Failed while running ${actionLabelFromType(job?.actionType)}: ${message}`,
  };
}

function workflowFailureReport({ job, error, failureReport }) {
  const report = job?.report && typeof job.report === "object" ? job.report : {};
  const finalFailureReport = failureReport || buildGenericWorkflowFailureReport(job, error);
  const started = job?.startedAt ? new Date(job.startedAt).getTime() : Date.now();
  const executionMs = Date.now() - started;
  return {
    summary: {
      title: `${actionLabelFromType(job?.actionType)} Failed`,
      status: "failed",
      aiSummary: finalFailureReport.message,
    },
    stats: {
      processed: finalFailureReport.recordsProcessedBeforeFailure || 0,
      succeeded: finalFailureReport.recordsSucceeded || 0,
      changed: finalFailureReport.recordsChanged || 0,
      failed: finalFailureReport.recordsFailed || 1,
      remaining: finalFailureReport.recordsRemaining || 0,
      canResumeSafely: finalFailureReport.canResumeSafely ? "Yes" : "No",
    },
    warnings: [
      finalFailureReport.message,
      finalFailureReport.resumeReason,
    ].filter(Boolean),
    downloads: [],
    recommendations: [
      finalFailureReport.canResumeSafely
        ? "Resume the workflow after reviewing the sanitized GHL response."
        : "Review the failed step before retrying.",
    ],
    executionTime: {
      ms: executionMs,
      label: durationLabel(executionMs),
    },
    failureReport: finalFailureReport,
    developerDetails: {
      ...(report.developerDetails || {}),
      failureReport: finalFailureReport,
      previousReport: report,
    },
  };
}

function newWorkflowJobId() {
  return `wf_${crypto.randomBytes(10).toString("hex")}`;
}

function isBackgroundWorkflowAction(action) {
  return ["sync_estimate_csv_with_ghl", "jarvis_workflow", "contact_owner_assignment"].includes(action?.actionType);
}

function statusForExecution(jobStatus) {
  if (jobStatus === "completed") return "executed";
  if (jobStatus === "failed" || jobStatus === "canceled") return "failed";
  return "running";
}

function progressEvent(message, meta = {}) {
  return {
    at: new Date().toISOString(),
    message: cleanString(message),
    meta: redact(meta),
  };
}

function publicWorkflowJob(job) {
  if (!job) return null;
  return {
    jobId: job.jobId,
    name: job.name,
    actionType: job.actionType,
    status: job.status,
    progress: {
      processed: Number(job.processedItems || 0),
      total: Number(job.totalItems || 0),
      percent: Number(job.percent || 0),
      message: cleanString(job.currentMessage),
    },
    progressEvents: Array.isArray(job.progressEvents) ? job.progressEvents.slice(-20) : [],
    report: redact(job.report),
    errors: redact(job.errors || []),
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    failedAt: job.failedAt,
    updatedAt: job.updatedAt,
  };
}

function executionResponseFromJob(job) {
  const status = statusForExecution(job.status);
  const workflowJob = publicWorkflowJob(job);
  const jobErrors = redact(job.errors || []);
  return {
    status,
    jobId: job.jobId,
    workflowJob,
    executedActions: [
      {
        actionId: job.payload?.actionId || job.actionType,
        actionType: job.actionType,
        status: job.status,
        request: {
          method: "WORKFLOW",
          path: "jarvis://workflow",
          body: {
            jobId: job.jobId,
            name: job.name,
            background: true,
          },
        },
      },
    ],
    results:
      status === "executed"
        ? [
            {
              actionId: job.payload?.actionId || job.actionType,
              actionType: job.actionType,
              extracted: { workflow: workflowJob },
              response: {
                ...redact(job.result || job.report || {}),
                workflow: workflowJob,
              },
            },
          ]
        : [],
    errors: status === "failed" ? jobErrors : [],
    failureReport:
      status === "failed"
        ? redact(
            workflowJob?.report?.failureReport ||
              jobErrors.find((item) => item?.failureReport)?.failureReport ||
              null
          )
        : null,
  };
}

async function appendProgress(jobId, message, meta = {}) {
  const event = progressEvent(message, meta);
  if (!event.message) return;
  await JarvisWorkflowJob.updateOne(
    { jobId },
    {
      $set: {
        currentMessage: event.message,
        lastHeartbeatAt: new Date(),
      },
      $push: {
        progressEvents: {
          $each: [event],
          $slice: -PROGRESS_EVENT_LIMIT,
        },
      },
    }
  );
}

async function persistRowProgress(jobId, state) {
  const event = /^Processing\s+/i.test(state.message || "")
    ? progressEvent(state.message, {
        processed: state.processedItems,
        total: state.totalItems,
      })
    : null;

  const update = {
    $set: {
      completedIndexes: state.completedIndexes,
      processedItems: state.processedItems,
      totalItems: state.totalItems,
      percent: state.percent,
      currentMessage: state.message,
      report: redact(state.report),
      lastHeartbeatAt: new Date(),
    },
  };

  if (event) {
    update.$push = {
      progressEvents: {
        $each: [event],
        $slice: -PROGRESS_EVENT_LIMIT,
      },
    };
  }

  await JarvisWorkflowJob.updateOne({ jobId }, update);
}

async function markAuditFinished(job, status, errors = []) {
  await AiCommanderGhlAudit.updateOne(
    { confirmationId: job.confirmationId },
    {
      $set: {
        status,
        executedAt: new Date(),
        exactApiCallsExecuted: [
          {
            actionId: job.payload?.actionId || job.actionType,
            actionType: job.actionType,
            status,
            request: {
              method: "WORKFLOW",
              path: "jarvis://workflow",
              body: { jobId: job.jobId, name: job.name },
            },
          },
        ],
        ghlResponses: [
          {
            actionId: job.payload?.actionId || job.actionType,
            status,
            response: redact(job.result || job.report || {}),
            rateLimit: {},
          },
        ],
        errors: redact(errors),
      },
    }
  );
}

async function runCsvWorkflowJob(job) {
  await appendProgress(job.jobId, "Workflow started.", { jobId: job.jobId });
  const result = await syncEstimateCsvWithGhl({
    files: job.payload?.files || [],
    uploadBatchId: job.payload?.uploadBatchId,
    approved: true,
    adminUserId: job.adminUserId,
    userRequest: job.originalMessage,
    startedAt: job.startedAt,
    completedIndexes: job.completedIndexes || [],
    initialReport: job.report,
    onRowComplete: (state) => persistRowProgress(job.jobId, state),
  });
  await appendProgress(job.jobId, "Finished.", {
    processed: result.processedRows,
    found: result.foundInGhl,
    missing: result.notFoundInGhl,
  });
  return result;
}

async function runContactOwnerAssignmentJob(job) {
  await appendProgress(job.jobId, "Workflow started.", { jobId: job.jobId });
  const result = await executeContactOwnerAssignment({
    ownerId: job.payload?.ownerId,
    ownerName: job.payload?.ownerName,
    tagName: job.payload?.tagName,
    contacts: job.payload?.contacts || [],
    approved: true,
    adminUserId: job.adminUserId,
    userRequest: job.originalMessage,
    startedAt: job.startedAt,
    completedIndexes: job.completedIndexes || [],
    initialReport: job.report,
    ownerLookupResult: {
      id: job.payload?.ownerId,
      name: job.payload?.ownerName,
    },
    tagSearchCount: job.payload?.contactCount,
    dryRunResult: job.payload?.dryRun,
    onContactComplete: (state) => persistRowProgress(job.jobId, state),
  });
  await appendProgress(job.jobId, "Finished.", {
    processed: result.stats?.processed || 0,
    updated: result.stats?.updated || 0,
    alreadyAssigned: result.stats?.alreadyAssigned || 0,
    failed: result.stats?.failed || 0,
  });
  return result;
}

async function runGenericWorkflowJob(job) {
  const workflow = parseJsonObjectText(job.payload?.workflowJson, "workflowJson");
  const result = await executeWorkflow({
    name: cleanString(job.payload?.workflowName || workflow.name || job.name),
    steps: Array.isArray(workflow.steps) ? workflow.steps : [],
    context: workflow.context && typeof workflow.context === "object" ? workflow.context : {},
    dryRun: job.dryRun === true || workflow.dryRun === true,
    approvalRequired: true,
    approved: true,
    confirmationPhrase: job.payload?.confirmationPhrase,
    adminUserId: job.adminUserId,
    userRequest: job.originalMessage,
    onProgress: (event) => appendProgress(job.jobId, event.message, event.meta),
  });
  if (result?.summary && result?.stats && result?.recommendations && result?.executionTime) {
    return result;
  }

  const executionMs = Date.now() - new Date(job.startedAt || Date.now()).getTime();
  const title = `${titleCase(result?.name || job.name || "Workflow")} Completed`;
  return {
    ...result,
    summary: {
      title,
      status: result?.status || "completed",
      aiSummary: `I completed the ${titleCase(result?.name || job.name || "workflow")} workflow. ${Number(result?.stepCount || 0).toLocaleString("en-US")} workflow steps ran and ${Number(result?.errors?.length || 0).toLocaleString("en-US")} errors were recorded.`,
    },
    stats: {
      workflowStepsExecuted: Number(result?.stepCount || 0),
      apiCalls: Number(result?.stepStats?.apiCalls || 0),
      loopIterations: Number(result?.stepStats?.loopIterations || 0),
      errors: Number(result?.errors?.length || 0),
      successRate: result?.errors?.length ? "0.0%" : "100.0%",
    },
    warnings: result?.errors?.length ? ["Some workflow steps recorded errors. Review the workflow log."] : [],
    downloads: [
      {
        label: "Download Audit Report.json",
        filename: "Audit Report.json",
        contentType: "application/json",
        content: JSON.stringify(redact(result || {}), null, 2),
      },
    ],
    recommendations: result?.errors?.length
      ? ["Review failed steps before re-running the workflow."]
      : ["No follow-up action is required right now."],
    executionTime: {
      ms: executionMs,
      label: durationLabel(executionMs),
    },
    developerDetails: {
      stepStats: result?.stepStats || {},
      workflowLog: result?.progress || [],
      executionTimeline: result?.progress || [],
    },
  };
}

async function runWorkflowJob(jobId) {
  if (runningJobs.has(jobId)) return;
  runningJobs.add(jobId);

  let job = null;
  try {
    job = await JarvisWorkflowJob.findOne({ jobId });
    if (!job || ["completed", "failed", "canceled"].includes(job.status)) return;

    const now = new Date();
    job.status = "running";
    job.startedAt = job.startedAt || now;
    job.lastHeartbeatAt = now;
    job.resumeCount = Number(job.resumeCount || 0) + (job.processedItems > 0 ? 1 : 0);
    await job.save();

    const result =
      job.actionType === "sync_estimate_csv_with_ghl"
        ? await runCsvWorkflowJob(job)
        : job.actionType === "contact_owner_assignment"
          ? await runContactOwnerAssignmentJob(job)
          : await runGenericWorkflowJob(job);

    job = await JarvisWorkflowJob.findOne({ jobId });
    if (!job) return;
    job.status = "completed";
    job.percent = 100;
    job.currentMessage = "Finished.";
    job.result = redact(result);
    job.report = redact(result);
    job.completedAt = new Date();
    job.lastHeartbeatAt = new Date();
    await job.save();
    await markAuditFinished(job, "executed", []);
  } catch (error) {
    const failureReport = buildGenericWorkflowFailureReport(job, error);
    const report = workflowFailureReport({ job, error, failureReport });
    const sanitizedError = redact({
      message: error?.message || String(error),
      statusCode: error?.statusCode || null,
      ghlStatus: error?.ghlStatus || null,
      request: error?.request || null,
      response: error?.response || null,
      failureReport,
    });
    await JarvisWorkflowJob.updateOne(
      { jobId },
      {
        $set: {
          status: "failed",
          currentMessage: failureReport.message || "Workflow failed.",
          report: redact(report),
          result: redact(report),
          failedAt: new Date(),
          lastHeartbeatAt: new Date(),
        },
        $push: {
          errors: sanitizedError,
          progressEvents: {
            $each: [progressEvent("Workflow failed.", sanitizedError)],
            $slice: -PROGRESS_EVENT_LIMIT,
          },
        },
      }
    );
    const failedJob = await JarvisWorkflowJob.findOne({ jobId });
    if (failedJob) await markAuditFinished(failedJob, "failed", [sanitizedError]);
  } finally {
    runningJobs.delete(jobId);
  }
}

function startWorkflowJob(jobId) {
  setImmediate(() => {
    runWorkflowJob(jobId).catch((error) => {
      console.error("Jarvis workflow job runner failed", {
        jobId,
        message: error?.message || String(error),
      });
    });
  });
}

async function createWorkflowJobForAction({ audit, action }) {
  const jobId = newWorkflowJobId();
  const actionType = action.actionType;
  const name =
    actionType === "sync_estimate_csv_with_ghl"
      ? "csv_ghl_tag_sync"
      : actionType === "contact_owner_assignment"
        ? "contact_owner_assignment"
      : cleanString(action.payload?.workflowName) || "jarvis_workflow";
  const totalItems = Number(
    action.payload?.validContacts ||
      action.payload?.contactCount ||
      (Array.isArray(action.payload?.contacts) ? action.payload.contacts.length : 0)
  );

  const job = await JarvisWorkflowJob.create({
    jobId,
    name,
    actionType,
    adminUserId: audit.adminUserId,
    confirmationId: audit.confirmationId,
    originalMessage: audit.originalMessage,
    status: "queued",
    approvalRequired: true,
    approved: true,
    dryRun: action.payload?.dryRun === true,
    payload: {
      ...redact(action.payload || {}),
      actionId: action.actionId,
    },
    totalItems,
    processedItems: 0,
    percent: 0,
    currentMessage: "Workflow queued.",
    progressEvents: [progressEvent("Workflow queued.", { jobId })],
  });

  await AiCommanderGhlAudit.updateOne(
    { confirmationId: audit.confirmationId },
    {
      $set: {
        status: "running",
        exactApiCallsExecuted: [
          {
            actionId: action.actionId,
            actionType,
            status: "queued",
            request: {
              method: "WORKFLOW",
              path: "jarvis://workflow",
              body: { jobId, name, background: true },
            },
          },
        ],
      },
    }
  );

  startWorkflowJob(jobId);
  return job;
}

async function getWorkflowJobExecutionResponse({ jobId, adminUserId }) {
  const job = await JarvisWorkflowJob.findOne({
    jobId: cleanString(jobId),
    ...(adminUserId ? { adminUserId } : {}),
  });
  if (!job) {
    const error = new Error("Workflow job not found.");
    error.statusCode = 404;
    throw error;
  }
  return executionResponseFromJob(job);
}

function scheduleWorkflowJobResume() {
  const timer = setTimeout(async () => {
    try {
      const jobs = await JarvisWorkflowJob.find({
        status: { $in: ["queued", "running"] },
      })
        .sort({ createdAt: 1 })
        .limit(10);
      for (const job of jobs) startWorkflowJob(job.jobId);
    } catch (error) {
      console.warn("Jarvis workflow resume scan failed", {
        message: error?.message || String(error),
      });
    }
  }, 2500);
  if (typeof timer.unref === "function") timer.unref();
}

module.exports = {
  createWorkflowJobForAction,
  executionResponseFromJob,
  getWorkflowJobExecutionResponse,
  isBackgroundWorkflowAction,
  publicWorkflowJob,
  runWorkflowJob,
  scheduleWorkflowJobResume,
};
