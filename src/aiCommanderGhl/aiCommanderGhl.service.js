const crypto = require("crypto");

const AiCommanderGhlAudit = require("./aiCommanderGhl.audit.model");
const { executeGhlRequest } = require("./ghlUniversalExecutor");
const { executeWorkflow } = require("./jarvisWorkflowExecutor");
const {
  createWorkflowJobForAction,
  executionResponseFromJob,
  getWorkflowJobExecutionResponse,
  isBackgroundWorkflowAction,
} = require("./jarvisWorkflowJobRunner");
const { generateGhlPlan } = require("./ghlPlanner");
const { countCsvContacts } = require("./jarvisCsvProcessor");
const { syncEstimateCsvWithGhl } = require("./jarvisCsvGhlSync");
const {
  buildCampaignTemplateDraft,
  createCampaignTemplateFromPlan,
  looksLikeCampaignBuilderRequest,
} = require("./jarvisCampaignBuilder.service");
const {
  executeContactOwnerAssignment,
  looksLikeContactOwnerAssignmentRequest,
  prepareContactOwnerAssignment,
} = require("./jarvisContactOwnerAssignment");
const {
  executeOpportunityBuilder,
  looksLikeOpportunityBuilderRequest,
  prepareOpportunityBuilder,
} = require("./jarvisOpportunityBuilder");
const {
  buildGenericGhlPlan,
  buildPublicModelPlan,
  looksLikeGenericGhlPlannerRequest,
} = require("./jarvisGenericGhlPlanner");
const { executeGenericGhlWorkflow } = require("./jarvisGenericGhlWorkflow");
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
  campaignTemplateJson: "",
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

function responseMessageFromError(error) {
  const response = error?.response || {};
  const message = response.message;
  if (Array.isArray(message)) return message.map(cleanString).filter(Boolean).join("; ");
  return cleanString(message || response.error || response.code || error?.message || error);
}

function buildApprovedActionFailureReport({
  action,
  error,
  executedActions = [],
  results = [],
} = {}) {
  const responseMessage = responseMessageFromError(error);
  const endpointCalled =
    cleanString(error?.request?.endpoint) ||
    [error?.request?.method, error?.request?.path].map(cleanString).filter(Boolean).join(" ");
  const actionName = actionLabelFromType(action?.actionType);
  const succeeded = executedActions.length;
  return {
    actionName,
    stepFailed: cleanString(action?.description) || `Executing ${actionName}`,
    endpointCalled,
    httpStatus: error?.ghlStatus || error?.statusCode || null,
    ghlErrorMessage: responseMessage,
    ghlErrorBody: error?.response || null,
    payload: error?.request?.body || null,
    firstAffectedContact: action?.payload?.contactId
      ? {
          id: action.payload.contactId,
          name: cleanString(action.payload.name || action.payload.contactName),
        }
      : null,
    anythingChangedBeforeFailure: results.length > 0,
    recordsProcessedBeforeFailure: succeeded,
    recordsSucceeded: succeeded,
    recordsFailed: 1,
    recordsRemaining: 0,
    canResumeSafely: true,
    resumeReason:
      succeeded > 0
        ? `${succeeded.toLocaleString("en-US")} action completed before failure. You can retry the failed action safely after reviewing the error.`
        : "No earlier action completed before this failure. You can retry safely after reviewing the error.",
    message: endpointCalled
      ? `Failed while executing ${actionName}. GHL returned ${error?.ghlStatus || error?.statusCode || "an error"}: ${responseMessage}`
      : `Failed while executing ${actionName}: ${responseMessage}`,
  };
}

function actionLabelFromType(actionType) {
  return cleanString(actionType)
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase()) || "Approved Action";
}

async function createPlan({ message, adminUserId }) {
  assertCommanderEnabled();
  assertConfigured();
  await markExpiredPlans();

  const originalMessage = cleanString(message);
  if (!originalMessage) {
    throw errorWithStatus("message is required", 400);
  }

  if (looksLikeCampaignBuilderRequest(originalMessage)) {
    return createCampaignTemplatePlan({ message: originalMessage, adminUserId });
  }

  if (looksLikeContactOwnerAssignmentRequest(originalMessage)) {
    return createContactOwnerAssignmentPlan({ message: originalMessage, adminUserId });
  }

  if (looksLikeGenericGhlPlannerRequest(originalMessage)) {
    try {
      return await createGenericGhlPlannerPlan({ message: originalMessage, adminUserId });
    } catch (error) {
      if (!looksLikeOpportunityBuilderRequest(originalMessage)) throw error;
    }
  }

  if (looksLikeOpportunityBuilderRequest(originalMessage)) {
    return createOpportunityBuilderPlan({ message: originalMessage, adminUserId });
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

async function createCampaignTemplatePlan({ message, adminUserId, files = [], uploadBatchId = "" }) {
  assertCommanderEnabled();
  assertGhlConfigured();
  await markExpiredPlans();

  const originalMessage = cleanString(message);
  if (!originalMessage) {
    throw errorWithStatus("message is required", 400);
  }

  const template = buildCampaignTemplateDraft({ message: originalMessage, files, uploadBatchId });
  const audience = template.audienceDefinition || {};
  const messageCount = Array.isArray(template.messageSteps) ? template.messageSteps.length : 0;
  const confirmationId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + PLAN_TTL_MS);
  const actions = [
    normalizeAction(
      {
        actionId: "create_jarvis_campaign_template",
        actionType: "jarvis_campaign_template_create",
        supported: true,
        riskLevel: "medium",
        description:
          "Create a reusable Jarvis campaign template. This does not start the campaign or send messages.",
        target: {},
        payload: {
          campaignTemplateJson: JSON.stringify(template),
          campaignName: template.campaignName,
          startAfterCreate: false,
        },
      },
      0
    ),
  ];
  const audienceText =
    audience.type === "ghl_tags"
      ? `GHL contacts with tags: ${(audience.tags || []).join(", ")}`
      : audience.type === "uploaded_csv"
        ? "contacts from the attached CSV"
        : audience.type || "campaign audience";
  const modelPlan = {
    summary: `I will create the reusable campaign template "${template.campaignName}". It will not start and no SMS will be sent until you explicitly start it from Campaigns.`,
    exactPlan: [
      "Create one reusable Jarvis campaign template.",
      `Set the audience to ${audienceText}.`,
      `Prepare ${messageCount} message step${messageCount === 1 ? "" : "s"} with wait delays.`,
      "Save stop conditions for replies, manual takeover, appointments, unsubscribe, and stop keywords.",
      "Save AI reply rules with human-like delay and escalation for price, legal, complaints, unusual requests, and anything outside the approved prompt.",
      "Keep approval-before-sending enabled. Starting the campaign remains a separate explicit approval.",
    ],
    objectsAffected: [
      `Campaign template: ${template.campaignName}`,
      `Audience: ${audienceText}`,
      `${messageCount} message step${messageCount === 1 ? "" : "s"}`,
      "No contacts messaged during template creation",
    ],
    messagesToSendOrCreate: (template.messageSteps || []).map((step, index) => ({
      channel: step.channel || "sms",
      timing:
        index === 0
          ? "Initial message"
          : `After ${step.waitDelay?.amount || 0} ${step.waitDelay?.unit || "minutes"}`,
      subject: `Step ${index + 1}`,
      body: step.body,
    })),
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
      campaignTemplate: template,
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

async function createContactOwnerAssignmentPlan({ message, adminUserId }) {
  assertCommanderEnabled();
  assertGhlConfigured();
  await markExpiredPlans();

  const originalMessage = cleanString(message);
  if (!originalMessage) {
    throw errorWithStatus("message is required", 400);
  }

  const prepared = await prepareContactOwnerAssignment({
    message: originalMessage,
    adminUserId,
  });
  const contactCount = Number(prepared.contactCount || 0);
  const ownerName = cleanString(prepared.owner?.name || prepared.owner?.requestedName);
  const ownerId = cleanString(prepared.owner?.id);
  const tagName = cleanString(prepared.audience?.tagName);
  const dryRunEndpoint = cleanString(
    prepared.ownerUpdateDryRun?.summary ||
      prepared.ownerUpdateDryRun?.request?.endpoint ||
      prepared.ownerUpdateDryRun?.path
  );
  const previewLines = prepared.preview.map((contact) => {
    const label = cleanString(contact.name || contact.email || contact.phone || contact.id);
    const details = [contact.email, contact.phone].map(cleanString).filter(Boolean).join(" / ");
    return `${contact.number}. ${label}${details ? ` (${details})` : ""}`;
  });

  const confirmationId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + PLAN_TTL_MS);
  const actions = [
    normalizeAction(
      {
        actionId: "contact_owner_assignment",
        actionType: "contact_owner_assignment",
        supported: true,
        riskLevel: "medium",
        description:
          "Assign the resolved GHL owner to every saved contact in the tagged audience after approval.",
        target: {},
        payload: {
          ownerName,
          ownerId,
          audienceType: prepared.audience?.type || "tag",
          tagName,
          contactCount,
          totalMatched: prepared.totalMatched,
          partial: prepared.audience?.partial === true,
          endpointUsed: prepared.audience?.endpointUsed,
          preview: prepared.preview,
          contacts: prepared.contacts,
          dryRun: prepared.ownerUpdateDryRun,
        },
      },
      0
    ),
  ];
  const modelPlan = {
    summary: [
      `I found ${contactCount.toLocaleString("en-US")} contacts with tag "${tagName}".`,
      `Owner: ${ownerName}.`,
      "Nothing has been changed.",
      "Approve to assign this owner and skip contacts already assigned.",
    ].join(" "),
    exactPlan: [
      `Resolve owner "${ownerName}" to GHL user ID ${ownerId}.`,
      `Search GHL contacts where tag equals "${tagName}".`,
      `Count matches: ${contactCount.toLocaleString("en-US")} contacts.`,
      "Preview the first 10 contacts before approval.",
      dryRunEndpoint
        ? `Dry-run validated the contact owner update payload: ${dryRunEndpoint}.`
        : "No contact update dry-run was needed because the audience is empty.",
      "After approval, loop through the saved contact list.",
      `Update each contact with assignedTo = ${ownerId}.`,
      "Skip contacts that already have this owner.",
      "Return contacts found, updated, already assigned, failed, and execution time.",
      ...previewLines.map((line) => `Preview: ${line}`),
    ],
    objectsAffected: [
      `${contactCount.toLocaleString("en-US")} contacts tagged "${tagName}"`,
      `Owner: ${ownerName}`,
      "No SMS, emails, tags, opportunities, or public records",
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
      contactOwnerAssignment: {
        owner: prepared.owner,
        audience: prepared.audience,
        contactCount,
        preview: prepared.preview,
        ownerUpdateDryRun: prepared.ownerUpdateDryRun,
      },
    },
    confirmationId,
    status: "planned",
    exactApiCallsPlanned: publicPlan.plannedApiActions,
    expiresAt,
  });

  return publicPlan;
}

async function createOpportunityBuilderPlan({ message, adminUserId }) {
  assertCommanderEnabled();
  assertGhlConfigured();
  await markExpiredPlans();

  const originalMessage = cleanString(message);
  if (!originalMessage) {
    throw errorWithStatus("message is required", 400);
  }

  const prepared = await prepareOpportunityBuilder({
    message: originalMessage,
    adminUserId,
  });
  const contactCount = Number(prepared.contactCount || 0);
  const tagName = cleanString(prepared.audience?.tagName);
  const pipelineName = cleanString(prepared.pipeline?.name);
  const pipelineId = cleanString(prepared.pipeline?.id);
  const stageName = cleanString(prepared.stage?.name);
  const stageId = cleanString(prepared.stage?.id);
  const dryRunEndpoint = cleanString(
    prepared.opportunityCreateDryRun?.summary ||
      prepared.opportunityCreateDryRun?.request?.endpoint ||
      prepared.opportunityCreateDryRun?.path
  );
  const previewLines = prepared.preview.map((contact) => {
    const label = cleanString(contact.name || contact.email || contact.phone || contact.id);
    const details = [contact.email, contact.phone].map(cleanString).filter(Boolean).join(" / ");
    return `${contact.number}. ${label}${details ? ` (${details})` : ""}`;
  });

  const confirmationId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + PLAN_TTL_MS);
  const actions = [
    normalizeAction(
      {
        actionId: "opportunity_builder",
        actionType: "opportunity_builder",
        supported: true,
        riskLevel: "medium",
        description:
          "Create missing opportunities for every saved tagged contact after approval.",
        target: {},
        payload: {
          audienceType: prepared.audience?.type || "tag",
          tagName,
          contactCount,
          totalMatched: prepared.totalMatched,
          partial: prepared.audience?.partial === true,
          endpointUsed: prepared.audience?.endpointUsed,
          preview: prepared.preview,
          contacts: prepared.contacts,
          pipelineName,
          pipelineId,
          stageName,
          stageId,
          pipelineStageId: stageId,
          opportunityCreateDryRun: prepared.opportunityCreateDryRun,
        },
      },
      0
    ),
  ];
  const modelPlan = {
    summary: [
      `I found ${contactCount.toLocaleString("en-US")} contacts with tag "${tagName}".`,
      `Pipeline: ${pipelineName}.`,
      `Stage: ${stageName}.`,
      "Nothing has been changed.",
      "Approve to check each contact for an existing opportunity and create only the missing ones.",
    ].join(" "),
    exactPlan: [
      `Search GHL contacts where tag equals "${tagName}".`,
      `Count matches: ${contactCount.toLocaleString("en-US")} contacts.`,
      `Resolve opportunity pipeline "${pipelineName}" to ID ${pipelineId}.`,
      `Resolve stage "${stageName}" to ID ${stageId}.`,
      "Preview the first 10 contacts before approval.",
      dryRunEndpoint
        ? `Dry-run validated the opportunity create payload: ${dryRunEndpoint}.`
        : "No opportunity create dry-run was needed because the audience is empty.",
      "After approval, loop through the saved contact list.",
      `For each contact, search existing opportunities in pipeline "${pipelineName}".`,
      "If an opportunity already exists in that pipeline, skip that contact.",
      `If no opportunity exists, create one in "${pipelineName}" / "${stageName}".`,
      "Return contacts found, opportunities created, already existed, failed, and execution time.",
      ...previewLines.map((line) => `Preview: ${line}`),
    ],
    objectsAffected: [
      `${contactCount.toLocaleString("en-US")} contacts tagged "${tagName}"`,
      `Pipeline: ${pipelineName}`,
      `Stage: ${stageName}`,
      "No SMS, emails, tags, or customer-facing records",
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
      opportunityBuilder: {
        audience: prepared.audience,
        pipeline: prepared.pipeline,
        stage: prepared.stage,
        contactCount,
        preview: prepared.preview,
        opportunityCreateDryRun: prepared.opportunityCreateDryRun,
      },
    },
    confirmationId,
    status: "planned",
    exactApiCallsPlanned: publicPlan.plannedApiActions,
    expiresAt,
  });

  return publicPlan;
}

async function createGenericGhlPlannerPlan({ message, adminUserId }) {
  assertCommanderEnabled();
  assertGhlConfigured();
  await markExpiredPlans();

  const originalMessage = cleanString(message);
  if (!originalMessage) {
    throw errorWithStatus("message is required", 400);
  }

  const genericPlan = await buildGenericGhlPlan({
    message: originalMessage,
    adminUserId,
  });
  if (!genericPlan || genericPlan.approvalRequired !== true) {
    throw errorWithStatus("Generic GHL Planner did not produce an approval workflow.", 422);
  }

  const confirmationId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + PLAN_TTL_MS);
  const actions = [
    normalizeAction(
      {
        actionId: "generic_ghl_workflow",
        actionType: "generic_ghl_workflow",
        supported: true,
        riskLevel: genericPlan.riskLevel,
        destructive: genericPlan.selectedEndpoints?.some((endpoint) => endpoint.destructive),
        description: genericPlan.objective,
        target: {},
        payload: {
          workflowName: genericPlan.workflow?.name || "generic_ghl_workflow",
          genericPlanJson: JSON.stringify(genericPlan),
          recordCount: Number(genericPlan.expectedAffectedRecords || 0),
          confirmationPhrase: "",
        },
      },
      0
    ),
  ];
  const modelPlan = buildPublicModelPlan(genericPlan);
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
      genericGhlPlan: genericPlan,
    },
    confirmationId,
    status: "planned",
    exactApiCallsPlanned: publicPlan.plannedApiActions,
    expiresAt,
  });

  return publicPlan;
}

async function executeInternalAction(action, executionContext = {}) {
  if (action.actionType === "jarvis_campaign_template_create") {
    const template = parseJsonObjectText(
      action.payload?.campaignTemplateJson,
      "campaignTemplateJson"
    );
    const created = await createCampaignTemplateFromPlan({
      template,
      adminUserId: executionContext.adminUserId,
      originalMessage: executionContext.userRequest,
      confirmationId: executionContext.confirmationId,
    });
    return {
      actionId: action.actionId,
      actionType: action.actionType,
      request: {
        method: "INTERNAL",
        path: "jarvis://campaigns/templates",
        body: {
          campaignName: created.campaignName,
          audienceType: created.audienceDefinition?.type,
          messageSteps: created.messageSteps?.length || 0,
          approvalBeforeSending: created.approvalBeforeSending,
        },
      },
      response: {
        campaign: created,
        summary:
          "Campaign template created. Nothing has started and no SMS has been sent.",
      },
      status: "executed",
      rateLimit: {},
      extracted: { campaign: created },
    };
  }

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

  if (action.actionType === "contact_owner_assignment") {
    const report = await executeContactOwnerAssignment({
      ownerId: action.payload?.ownerId,
      ownerName: action.payload?.ownerName,
      tagName: action.payload?.tagName,
      contacts: action.payload?.contacts || [],
      approved: true,
      adminUserId: executionContext.adminUserId,
      userRequest: executionContext.userRequest,
      ownerLookupResult: {
        id: action.payload?.ownerId,
        name: action.payload?.ownerName,
      },
      tagSearchCount: action.payload?.contactCount,
      dryRunResult: action.payload?.dryRun,
    });
    return {
      actionId: action.actionId,
      actionType: action.actionType,
      request: {
        method: "WORKFLOW",
        path: "jarvis://contacts/owner-assignment",
        body: {
          ownerName: action.payload?.ownerName,
          tagName: action.payload?.tagName,
          contactCount: Array.isArray(action.payload?.contacts)
            ? action.payload.contacts.length
            : Number(action.payload?.contactCount || 0),
        },
      },
      response: report,
      status: "executed",
      rateLimit: {},
      extracted: { report },
    };
  }

  if (action.actionType === "opportunity_builder") {
    const report = await executeOpportunityBuilder({
      tagName: action.payload?.tagName,
      pipelineId: action.payload?.pipelineId,
      pipelineName: action.payload?.pipelineName,
      stageId: action.payload?.stageId || action.payload?.pipelineStageId,
      stageName: action.payload?.stageName,
      contacts: action.payload?.contacts || [],
      approved: true,
      adminUserId: executionContext.adminUserId,
      userRequest: executionContext.userRequest,
      dryRunResult: action.payload?.opportunityCreateDryRun,
    });
    return {
      actionId: action.actionId,
      actionType: action.actionType,
      request: {
        method: "WORKFLOW",
        path: "jarvis://opportunities/builder",
        body: {
          tagName: action.payload?.tagName,
          pipelineName: action.payload?.pipelineName,
          stageName: action.payload?.stageName,
          contactCount: Array.isArray(action.payload?.contacts)
            ? action.payload.contacts.length
            : Number(action.payload?.contactCount || 0),
        },
      },
      response: report,
      status: "executed",
      rateLimit: {},
      extracted: { report },
    };
  }

  if (action.actionType === "generic_ghl_workflow") {
    const genericPlan = parseJsonObjectText(action.payload?.genericPlanJson, "genericPlanJson");
    const report = await executeGenericGhlWorkflow({
      plan: genericPlan,
      approved: true,
      adminUserId: executionContext.adminUserId,
      userRequest: executionContext.userRequest,
      confirmationPhrase: action.payload?.confirmationPhrase,
    });
    return {
      actionId: action.actionId,
      actionType: action.actionType,
      request: {
        method: "WORKFLOW",
        path: "jarvis://ghl/generic-workflow",
        body: {
          objective: genericPlan.objective,
          operation: genericPlan.operation,
          expectedAffectedRecords: genericPlan.expectedAffectedRecords,
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

  const backgroundWorkflowAction = executableActions.find(isBackgroundWorkflowAction);
  if (backgroundWorkflowAction) {
    const job = await createWorkflowJobForAction({
      audit,
      action: backgroundWorkflowAction,
    });
    return executionResponseFromJob(job);
  }

  const executedActions = [];
  const results = [];
  const ghlResponses = [];
  const errors = [];
  const executionContext = {
    actionResults: {},
    adminUserId: audit.adminUserId,
    userRequest: audit.originalMessage,
    confirmationId: audit.confirmationId,
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
      const baseError = responseError(error);
      const failureReport = buildApprovedActionFailureReport({
        action,
        error,
        executedActions,
        results,
      });
      errors.push(
        typeof baseError === "object" && baseError
          ? {
              ...baseError,
              failureReport,
            }
          : {
              message: cleanString(baseError),
              failureReport,
            }
      );
      if (error.request || error.response) {
        ghlResponses.push({
          actionId: action.actionId,
          status: error.ghlStatus || null,
          request: error.request || null,
          response: error.response || null,
          failureReport,
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
  createCampaignTemplatePlan,
  createContactOwnerAssignmentPlan,
  createEstimateCsvSyncPlan,
  createGenericGhlPlannerPlan,
  createOpportunityBuilderPlan,
  createPlan,
  executePlan,
  getWorkflowJobExecutionResponse,
};
