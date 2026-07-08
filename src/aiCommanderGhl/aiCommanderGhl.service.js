const crypto = require("crypto");

const AiCommanderGhlAudit = require("./aiCommanderGhl.audit.model");
const { executeGhlRequest } = require("./ghlUniversalExecutor");
const { executeWorkflow } = require("./jarvisWorkflowExecutor");
const { generateGhlPlan } = require("./ghlPlanner");
const { countCsvContacts } = require("./jarvisCsvProcessor");
const { syncEstimateCsvWithGhl } = require("./jarvisCsvGhlSync");
const {
  UNSUPPORTED_MESSAGE,
  cleanString,
  executeAction,
  getActionDefinition,
  isSupportedAction,
  parseJsonObjectText,
  plannedCallForAction,
  riskMax,
} = require("./ghlActions");

const PLAN_TTL_MS = 30 * 60 * 1000;

const DEFAULT_TARGET = Object.freeze({
  contactId: "",
  contactIdFromActionId: "",
  conversationId: "",
  opportunityId: "",
  pipelineId: "",
  campaignId: "",
  calendarId: "",
  workflowId: "",
  notes: "",
});

const DEFAULT_PAYLOAD = Object.freeze({
  name: "",
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  address1: "",
  city: "",
  state: "",
  postalCode: "",
  source: "",
  noteTitle: "",
  noteBody: "",
  taskTitle: "",
  taskBody: "",
  dueDate: "",
  assignedTo: "",
  pipelineId: "",
  pipelineStageId: "",
  opportunityName: "",
  status: "",
  pipelineName: "",
  campaignId: "",
  workflowId: "",
  messageType: "",
  messageBody: "",
  subject: "",
  html: "",
  calendarId: "",
  startTime: "",
  endTime: "",
  appointmentTitle: "",
  appointmentStatus: "",
  universalMethod: "",
  universalPath: "",
  universalQueryJson: "",
  universalBodyJson: "",
  universalReason: "",
  workflowName: "",
  workflowJson: "",
  confirmationPhrase: "",
  tags: [],
  customFields: [],
  stages: [],
  completed: false,
  dryRun: false,
  useOpportunityProbability: false,
  monetaryValue: 0,
});

function errorWithStatus(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function commanderEnabled() {
  return String(process.env.AI_COMMANDER_GHL_ENABLED || "").toLowerCase() === "true";
}

function assertCommanderEnabled() {
  if (!commanderEnabled()) {
    throw errorWithStatus("GHL AI Commander is disabled", 503);
  }
}

function assertConfigured() {
  if (!String(process.env.OPENAI_API_KEY || "").trim()) {
    throw errorWithStatus("Missing OPENAI_API_KEY", 500);
  }
  assertGhlConfigured();
}

function assertGhlConfigured() {
  if (!String(process.env.GHL_AI_COMMANDER_TOKEN || "").trim()) {
    throw errorWithStatus("Missing GHL_AI_COMMANDER_TOKEN", 500);
  }
  if (!String(process.env.GHL_LOCATION_ID || "").trim()) {
    throw errorWithStatus("Missing GHL_LOCATION_ID", 500);
  }
}

async function markExpiredPlans(now = new Date()) {
  await AiCommanderGhlAudit.updateMany(
    { status: "planned", expiresAt: { $lte: now } },
    { $set: { status: "expired" } }
  );
}

function normalizeRisk(value) {
  return ["low", "medium", "high"].includes(value) ? value : "low";
}

function normalizeAction(rawAction, index) {
  const actionType = cleanString(rawAction?.actionType) || "unsupported";
  const supported = isSupportedAction(actionType) && rawAction?.supported !== false;
  const definition = getActionDefinition(actionType);
  return {
    actionId: cleanString(rawAction?.actionId) || `action_${index + 1}`,
    actionType: supported ? actionType : "unsupported",
    requestedActionType: actionType,
    description: cleanString(rawAction?.description),
    supported,
    riskLevel: definition?.riskLevel || normalizeRisk(rawAction?.riskLevel),
    destructive: definition?.destructive || rawAction?.destructive === true,
    target: {
      ...DEFAULT_TARGET,
      ...(rawAction?.target || {}),
    },
    payload: {
      ...DEFAULT_PAYLOAD,
      ...(rawAction?.payload || {}),
      tags: Array.isArray(rawAction?.payload?.tags) ? rawAction.payload.tags : [],
      customFields: Array.isArray(rawAction?.payload?.customFields)
        ? rawAction.payload.customFields
        : [],
      stages: Array.isArray(rawAction?.payload?.stages)
        ? rawAction.payload.stages
        : [],
      completed: rawAction?.payload?.completed === true,
      dryRun: rawAction?.payload?.dryRun === true,
      useOpportunityProbability:
        rawAction?.payload?.useOpportunityProbability === true,
      monetaryValue: Number(rawAction?.payload?.monetaryValue || 0),
    },
    unsupportedReason:
      supported
        ? ""
        : cleanString(rawAction?.unsupportedReason) || UNSUPPORTED_MESSAGE,
  };
}

function messageLooksBulk(message) {
  return /\b(all|every|everyone|blast|bulk|entire list|all contacts|all leads|mass)\b/i.test(
    String(message || "")
  );
}

function actionLooksLikeMessage(action) {
  return action.actionType === "send_conversation_message";
}

function enforceSafety(modelPlan, actions, originalMessage) {
  const unsupported = [...(modelPlan.unsupportedActions || [])];
  const messageActions = actions.filter(actionLooksLikeMessage);

  if (messageActions.length > 1 || (messageActions.length && messageLooksBulk(originalMessage))) {
    for (const action of messageActions) {
      action.supported = false;
      action.actionType = "unsupported";
      action.unsupportedReason = "No bulk SMS blast in first version.";
    }
    unsupported.push({
      requestedAction: "bulk messaging",
      reason: "No bulk SMS blast in first version.",
    });
  }

  for (const action of actions) {
    const requested = `${action.requestedActionType} ${action.description}`.toLowerCase();
    if (
      requested.includes("delete contact") ||
      requested.includes("delete workflow") ||
      requested.includes("remove every campaign")
    ) {
      action.supported = false;
      action.actionType = "unsupported";
      action.unsupportedReason = UNSUPPORTED_MESSAGE;
      unsupported.push({
        requestedAction: action.description || action.requestedActionType,
        reason: UNSUPPORTED_MESSAGE,
      });
    }
  }

  return unsupported;
}

function publicPlanFromModel({
  modelPlan,
  actions,
  unsupportedActions,
  confirmationId,
  expiresAt,
}) {
  let riskLevel = normalizeRisk(modelPlan.riskLevel);
  let destructive = modelPlan.destructive === true;
  const plannedApiActions = actions.map((action) => {
    const planned = plannedCallForAction(action);
    riskLevel = riskMax(riskLevel, planned.riskLevel || action.riskLevel || "low");
    destructive = destructive || planned.destructive === true || action.destructive === true;
    return planned;
  });

  if (unsupportedActions.length) {
    riskLevel = riskMax(riskLevel, "high");
  }

  return {
    confirmationId,
    summary: cleanString(modelPlan.summary),
    exactPlan: Array.isArray(modelPlan.exactPlan) ? modelPlan.exactPlan : [],
    objectsAffected: Array.isArray(modelPlan.objectsAffected)
      ? modelPlan.objectsAffected
      : [],
    messagesToSendOrCreate: Array.isArray(modelPlan.messagesToSendOrCreate)
      ? modelPlan.messagesToSendOrCreate
      : [],
    plannedApiActions,
    unsupportedActions,
    riskLevel,
    destructive,
    requiresApproval: true,
    expiresAt: expiresAt.toISOString(),
  };
}

function responseError(error) {
  if (!error) return "Unknown error";
  if (error.ghlStatus || error.response || error.request) {
    return {
      message: cleanString(error.message || "GHL API request failed"),
      ghlStatus: error.ghlStatus || null,
      request: error.request || null,
      response: error.response || null,
    };
  }
  return cleanString(error.message || error);
}

async function createPlan({ message, adminUserId }) {
  assertCommanderEnabled();
  assertConfigured();
  await markExpiredPlans();

  const originalMessage = cleanString(message);
  if (!originalMessage) {
    throw errorWithStatus("message is required", 400);
  }

  const modelPlan = await generateGhlPlan(originalMessage);
  const actions = Array.isArray(modelPlan.plannedActions)
    ? modelPlan.plannedActions.map(normalizeAction)
    : [];
  const unsupportedActions = enforceSafety(modelPlan, actions, originalMessage);
  const confirmationId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + PLAN_TTL_MS);
  const publicPlan = publicPlanFromModel({
    modelPlan,
    actions,
    unsupportedActions,
    confirmationId,
    expiresAt,
  });

  await AiCommanderGhlAudit.create({
    adminUserId,
    originalMessage,
    generatedPlan: {
      modelPlan,
      normalizedActions: actions,
      publicPlan,
    },
    confirmationId,
    status: "planned",
    exactApiCallsPlanned: publicPlan.plannedApiActions,
    expiresAt,
  });

  return publicPlan;
}

async function createEstimateCsvSyncPlan({ message, adminUserId, files, uploadBatchId }) {
  assertCommanderEnabled();
  assertGhlConfigured();
  await markExpiredPlans();

  const originalMessage = cleanString(message);
  if (!originalMessage) {
    throw errorWithStatus("message is required", 400);
  }

  const csvSummary = await countCsvContacts({ files, uploadBatchId });
  if (!csvSummary.validContacts) {
    throw errorWithStatus("The attached CSV does not contain valid contact rows.", 400);
  }

  const confirmationId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + PLAN_TTL_MS);
  const actions = [
    normalizeAction(
      {
        actionId: "sync_estimate_csv_with_ghl",
        actionType: "sync_estimate_csv_with_ghl",
        supported: true,
        riskLevel: "medium",
        description:
          "Find uploaded estimate CSV contacts in GHL and add missing roofing/siding tags to existing contacts only.",
        target: {},
        payload: {
          files,
          uploadBatchId,
          totalRows: csvSummary.totalRows,
          validContacts: csvSummary.validContacts,
          createMissingContacts: false,
        },
      },
      0
    ),
  ];
  const modelPlan = {
    summary: `${csvSummary.validContacts.toLocaleString("en-US")} valid CSV contact rows will be checked against GHL. Existing matching contacts will receive missing roofing/siding tags. Missing contacts will only be reported, not created.`,
    exactPlan: [
      "Run a composed Jarvis workflow for the uploaded CSV.",
      "Parse the uploaded CSV on the backend.",
      "Loop through each valid row and search GHL by phone first, then email, then name plus address.",
      "For existing contacts, add missing Roofing/Siding, sal-roofing, and sal-siding tags when indicated by the CSV row.",
      "Report missing contacts, multiple matches, per-row errors, and totals.",
      "Do not create new contacts from this CSV.",
    ],
    objectsAffected: [
      `${csvSummary.validContacts.toLocaleString("en-US")} CSV contact rows`,
      "Existing matching GHL contacts only",
      "Missing contacts are report-only",
    ],
    messagesToSendOrCreate: [],
    riskLevel: "medium",
    destructive: false,
  };
  const publicPlan = publicPlanFromModel({
    modelPlan,
    actions,
    unsupportedActions: [],
    confirmationId,
    expiresAt,
  });

  await AiCommanderGhlAudit.create({
    adminUserId,
    originalMessage,
    generatedPlan: {
      modelPlan,
      normalizedActions: actions,
      publicPlan,
      csvSummary,
    },
    confirmationId,
    status: "planned",
    exactApiCallsPlanned: publicPlan.plannedApiActions,
    expiresAt,
  });

  return publicPlan;
}

async function executeInternalAction(action, executionContext = {}) {
  if (action.actionType === "sync_estimate_csv_with_ghl") {
    const report = await syncEstimateCsvWithGhl({
      files: action.payload?.files || [],
      uploadBatchId: action.payload?.uploadBatchId,
      approved: true,
      adminUserId: executionContext.adminUserId,
      userRequest: executionContext.userRequest,
    });
    return {
      actionId: action.actionId,
      actionType: action.actionType,
      request: {
        method: "INTERNAL",
        path: "jarvis://csv/sync-estimate-csv-with-ghl",
        body: {
          fileCount: Array.isArray(action.payload?.files) ? action.payload.files.length : 0,
          createMissingContacts: false,
        },
      },
      response: report,
      status: "executed",
      rateLimit: {},
      extracted: { report },
    };
  }

  if (action.actionType === "universal_ghl_request") {
    const payload = action.payload || {};
    const query = parseJsonObjectText(payload.universalQueryJson, "universalQueryJson");
    const body = parseJsonObjectText(payload.universalBodyJson, "universalBodyJson");
    const result = await executeGhlRequest({
      method: payload.universalMethod,
      path: payload.universalPath,
      query,
      body,
      reason: payload.universalReason,
      dryRun: payload.dryRun === true,
      approved: true,
      confirmationPhrase: payload.confirmationPhrase,
      adminUserId: executionContext.adminUserId,
      userRequest: executionContext.userRequest,
    });
    return {
      actionId: action.actionId,
      actionType: action.actionType,
      request: {
        method: "UNIVERSAL",
        path: "jarvis://ghl/universal",
        body: {
          method: result.method,
          path: result.path,
          query: result.query || {},
          body: result.body || null,
          dryRun: result.dryRun === true,
          reason: cleanString(payload.universalReason),
          confirmationPhrase: cleanString(payload.confirmationPhrase)
            ? "[PROVIDED]"
            : "",
        },
      },
      response: result,
      status: result.status || (result.dryRun ? "dry_run" : "executed"),
      rateLimit: result.rateLimit || {},
      extracted: { report: result },
    };
  }

  if (action.actionType === "jarvis_workflow") {
    const payload = action.payload || {};
    const workflow = parseJsonObjectText(payload.workflowJson, "workflowJson");
    const result = await executeWorkflow({
      name: cleanString(payload.workflowName || workflow.name || "jarvis_workflow"),
      steps: Array.isArray(workflow.steps) ? workflow.steps : [],
      context: workflow.context && typeof workflow.context === "object" ? workflow.context : {},
      dryRun: payload.dryRun === true || workflow.dryRun === true,
      approvalRequired: true,
      approved: true,
      confirmationPhrase: payload.confirmationPhrase,
      adminUserId: executionContext.adminUserId,
      userRequest: executionContext.userRequest,
    });
    return {
      actionId: action.actionId,
      actionType: action.actionType,
      request: {
        method: "WORKFLOW",
        path: "jarvis://workflow",
        body: {
          name: result.name,
          stepCount: result.stepCount,
          dryRun: result.dryRun,
          approvalRequired: result.approvalRequired,
        },
      },
      response: result,
      status: result.status,
      rateLimit: {},
      extracted: { workflow: result },
    };
  }

  return null;
}

function loadActionsFromAudit(audit) {
  const actions = audit?.generatedPlan?.normalizedActions;
  return Array.isArray(actions) ? actions : [];
}

function hasUnsupportedActions(audit, actions) {
  const unsupported = audit?.generatedPlan?.publicPlan?.unsupportedActions;
  return (
    (Array.isArray(unsupported) && unsupported.length > 0) ||
    actions.some((action) => !action.supported || action.actionType === "unsupported")
  );
}

async function executePlan({ confirmationId }) {
  assertCommanderEnabled();
  assertGhlConfigured();
  await markExpiredPlans();

  const cleanConfirmationId = cleanString(confirmationId);
  if (!cleanConfirmationId) {
    throw errorWithStatus("confirmationId is required", 400);
  }

  const audit = await AiCommanderGhlAudit.findOne({
    confirmationId: cleanConfirmationId,
  });
  if (!audit) {
    throw errorWithStatus("Plan not found for confirmationId", 404);
  }
  if (audit.status === "expired" || audit.expiresAt <= new Date()) {
    audit.status = "expired";
    await audit.save();
    throw errorWithStatus("Plan expired. Create a new plan.", 410);
  }
  if (audit.status !== "planned") {
    throw errorWithStatus(`Plan is already ${audit.status}`, 409);
  }

  const actions = loadActionsFromAudit(audit);
  const executableActions = actions.filter(
    (action) => action.supported && action.actionType !== "unsupported"
  );

  if (!executableActions.length || hasUnsupportedActions(audit, actions)) {
    const errors = [
      hasUnsupportedActions(audit, actions)
        ? UNSUPPORTED_MESSAGE
        : "No executable GHL actions were saved for this plan.",
    ];
    audit.status = "failed";
    audit.errors = errors;
    audit.executedAt = new Date();
    await audit.save();
    return {
      status: "failed",
      executedActions: [],
      results: [],
      errors,
    };
  }

  const executedActions = [];
  const results = [];
  const ghlResponses = [];
  const errors = [];
  const executionContext = {
    actionResults: {},
    adminUserId: audit.adminUserId,
    userRequest: audit.originalMessage,
  };

  for (const action of executableActions) {
    try {
      const result = (await executeInternalAction(action, executionContext)) ||
        (await executeAction(action, executionContext));
      executedActions.push({
        actionId: result.actionId,
        actionType: result.actionType,
        status: result.status,
        request: result.request,
      });
      results.push({
        actionId: result.actionId,
        actionType: result.actionType,
        extracted: result.extracted,
        response: result.response,
      });
      ghlResponses.push({
        actionId: result.actionId,
        status: result.status,
        response: result.response,
        rateLimit: result.rateLimit,
      });
      executionContext.actionResults[action.actionId] = result.extracted || {};
    } catch (error) {
      errors.push(responseError(error));
      if (error.request || error.response) {
        ghlResponses.push({
          actionId: action.actionId,
          status: error.ghlStatus || null,
          request: error.request || null,
          response: error.response || null,
        });
      }
      break;
    }
  }

  audit.status = errors.length ? "failed" : "executed";
  audit.executedAt = new Date();
  audit.exactApiCallsExecuted = executedActions;
  audit.ghlResponses = ghlResponses;
  audit.errors = errors;
  await audit.save();

  return {
    status: errors.length ? "failed" : "executed",
    executedActions,
    results,
    errors,
  };
}

module.exports = {
  createEstimateCsvSyncPlan,
  createPlan,
  executePlan,
};
