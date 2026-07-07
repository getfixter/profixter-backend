const moment = require("moment-timezone");

const {
  RoofingSalesAgentConversation,
} = require("./roofingSalesAgent.model");
const {
  CLASSIFICATION_VALUES,
  classifyRoofingLeadReply,
  normalizeHistory,
} = require("./roofingSalesAgent.prompt");
const {
  parseInboundGhlMessage,
  sanitizeForLog,
} = require("./roofingSalesAgent.webhook");
const { notifyAdmin } = require("./roofingSalesAgent.notifications");
const {
  executeAction,
  plannedCallForAction,
} = require("../../aiCommanderGhl/ghlActions");

const BLOCKED_AUTO_REPLY_CLASSIFICATIONS = new Set([
  "human_takeover",
  "angry_or_complaint",
  "stop_unsubscribe",
  "wrong_number",
  "not_interested",
]);

const HUMAN_TAKEOVER_CLASSIFICATIONS = new Set([
  "human_takeover",
  "angry_or_complaint",
]);

const STOP_AI_CLASSIFICATIONS = new Set([
  "stop_unsubscribe",
  "wrong_number",
  "not_interested",
]);

function cleanString(value) {
  return String(value || "").trim();
}

function enabled() {
  return cleanString(process.env.JARVIS_ROOFING_AGENT_ENABLED).toLowerCase() === "true";
}

function mode() {
  const value = cleanString(process.env.JARVIS_ROOFING_AGENT_MODE).toLowerCase();
  return value === "auto_reply_safe" ? "auto_reply_safe" : "suggest_only";
}

function statusForClassification(classification) {
  if (classification === "gave_callback_time") return "callback_scheduled";
  if (classification === "stop_unsubscribe" || classification === "wrong_number") {
    return "do_not_contact";
  }
  if (classification === "not_interested") return "closed_not_interested";
  if (HUMAN_TAKEOVER_CLASSIFICATIONS.has(classification)) return "human_takeover";
  if (
    [
      "interested",
      "maybe_interested",
      "wants_call",
      "pricing_question",
      "technical_question",
    ].includes(classification)
  ) {
    return "waiting_for_callback_time";
  }
  return "ai_responding";
}

function safeToAutoReply(classification) {
  return !BLOCKED_AUTO_REPLY_CLASSIFICATIONS.has(classification);
}

function normalizeClassificationResult(raw = {}) {
  const classification = CLASSIFICATION_VALUES.includes(raw.classification)
    ? raw.classification
    : "unclear";
  const humanTakeover =
    raw.humanTakeover === true || HUMAN_TAKEOVER_CLASSIFICATIONS.has(classification);

  return {
    classification,
    recommendedReply:
      classification === "stop_unsubscribe"
        ? ""
        : cleanString(raw.recommendedReply).slice(0, 500),
    callbackTimeText: cleanString(raw.callbackTimeText).slice(0, 200),
    actionsPlanned: Array.isArray(raw.actionsPlanned) ? raw.actionsPlanned : [],
    humanTakeover,
  };
}

function publicAction({
  actionType,
  description,
  supported = true,
  executed = false,
  reason = "",
  requestPreview = null,
  result = null,
  rawGhlActions = [],
}) {
  return {
    actionType,
    description,
    supported,
    executed,
    reason,
    requestPreview,
    result,
    rawGhlActions,
  };
}

function makeGhlAction(actionId, actionType, { target = {}, payload = {}, description = "" }) {
  return {
    actionId,
    actionType,
    requestedActionType: actionType,
    description,
    supported: true,
    riskLevel: "medium",
    destructive: false,
    target: {
      contactId: "",
      contactIdFromActionId: "",
      conversationId: "",
      opportunityId: "",
      pipelineId: "",
      campaignId: "",
      calendarId: "",
      workflowId: "",
      notes: "",
      ...target,
    },
    payload: {
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
      tags: [],
      customFields: [],
      stages: [],
      completed: false,
      useOpportunityProbability: false,
      monetaryValue: 0,
      ...payload,
    },
    unsupportedReason: "",
  };
}

function previewGhlAction(action) {
  try {
    return plannedCallForAction(action).requestPreview || null;
  } catch (error) {
    return { validationError: error.message };
  }
}

function callbackTaskDueDate(callbackTimeText, now = new Date()) {
  const text = cleanString(callbackTimeText).toLowerCase();
  if (!text) return "";

  let day = moment.tz(now, "America/New_York");
  if (/\btomorrow\b/.test(text)) {
    day = day.add(1, "day");
  } else {
    const weekdays = [
      "sunday",
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
    ];
    const weekdayIndex = weekdays.findIndex((weekday) =>
      new RegExp(`\\b${weekday}\\b`).test(text)
    );
    if (weekdayIndex >= 0) {
      const today = day.day();
      const delta = (weekdayIndex - today + 7) % 7 || 7;
      day = day.add(delta, "day");
    }
  }

  let hour = 10;
  let minute = 0;
  if (/\bmorning\b/.test(text)) hour = 9;
  if (/\bafternoon\b/.test(text)) hour = 13;
  if (/\bevening\b|\bafter work\b/.test(text)) hour = 17;

  const timeMatch = text.match(/\b(?:after|around|at|by)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (timeMatch) {
    hour = Number(timeMatch[1]);
    minute = Number(timeMatch[2] || 0);
    const meridiem = timeMatch[3];
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    if (!meridiem && hour >= 1 && hour <= 7) hour += 12;
  }

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return "";
  return day.hour(hour).minute(minute).second(0).millisecond(0).toISOString();
}

function actionContactTarget(conversation, upsertActionId = "") {
  if (conversation.contactId) return { contactId: conversation.contactId };
  if (upsertActionId) return { contactIdFromActionId: upsertActionId };
  return {};
}

function buildCallbackGhlActions({ conversation, callbackTimeText }) {
  const actions = [];
  let upsertActionId = "";

  if (!conversation.contactId && conversation.phone) {
    upsertActionId = "upsert_contact";
    actions.push(
      makeGhlAction(upsertActionId, "upsert_contact", {
        payload: {
          name: conversation.name || "Roofing Lead",
          phone: conversation.phone,
          source: "Roofing Sales Agent v1",
        },
        description: "Find or create the GHL contact for this inbound roofing/siding lead.",
      })
    );
  }

  const contactTarget = actionContactTarget(conversation, upsertActionId);
  if (!contactTarget.contactId && !contactTarget.contactIdFromActionId) {
    return [
      publicAction({
        actionType: "unsupported",
        description: "Create callback GHL actions",
        supported: false,
        reason: "Missing GHL contactId and phone, so contact-scoped GHL actions cannot run.",
      }),
    ];
  }

  actions.push(
    makeGhlAction("add_callback_tag", "add_contact_tags", {
      target: contactTarget,
      payload: { tags: ["roofing-call-scheduled"] },
      description: "Add roofing-call-scheduled tag to the GHL contact.",
    })
  );

  actions.push(
    makeGhlAction("create_callback_note", "create_contact_note", {
      target: contactTarget,
      payload: {
        noteTitle: "Roofing callback scheduled",
        noteBody: [
          "Roofing Sales Agent v1 callback scheduled.",
          `Lead: ${conversation.name || "-"}`,
          `Phone: ${conversation.phone || "-"}`,
          `Callback time: ${callbackTimeText || "-"}`,
          `Last message: ${conversation.lastIncomingMessage || "-"}`,
        ].join("\n"),
      },
      description: "Create a note with the callback details.",
    })
  );

  const dueDate = callbackTaskDueDate(callbackTimeText);
  if (dueDate) {
    actions.push(
      makeGhlAction("create_callback_task", "create_contact_task", {
        target: contactTarget,
        payload: {
          taskTitle: `Call roofing lead ${callbackTimeText}`,
          taskBody: `Call ${conversation.name || "roofing/siding lead"} at ${
            conversation.phone || "-"
          }. Callback time: ${callbackTimeText}.`,
          dueDate,
          assignedTo: cleanString(process.env.JARVIS_ROOFING_AGENT_ASSIGNED_TO),
        },
        description: "Create a GHL task for Taras to call the lead.",
      })
    );
  }

  const pipelineId = cleanString(process.env.JARVIS_ROOFING_AGENT_PIPELINE_ID);
  if (pipelineId) {
    actions.push(
      makeGhlAction("upsert_callback_opportunity", "upsert_opportunity", {
        target: contactTarget,
        payload: {
          pipelineId,
          pipelineStageId: cleanString(process.env.JARVIS_ROOFING_AGENT_PIPELINE_STAGE_ID),
          opportunityName: `Roofing/Siding Lead - ${conversation.name || conversation.phone || "Lead"}`,
          status: "open",
          source: "Roofing Sales Agent v1",
          assignedTo: cleanString(process.env.JARVIS_ROOFING_AGENT_ASSIGNED_TO),
        },
        description: "Create or update a Roofing/Siding Lead opportunity in GHL.",
      })
    );
  }

  const planned = actions.map((action) =>
    publicAction({
      actionType: action.actionType,
      description: action.description,
      supported: true,
      requestPreview: previewGhlAction(action),
      rawGhlActions: [action],
    })
  );

  if (!dueDate) {
    planned.push(
      publicAction({
        actionType: "create_task",
        description: "Create a GHL callback task",
        supported: false,
        reason:
          "Could not safely convert callbackTimeText to an ISO dueDate for HighLevel.",
      })
    );
  }

  if (!pipelineId) {
    planned.push(
      publicAction({
        actionType: "create_or_update_opportunity",
        description: "Create/update Roofing/Siding Lead opportunity",
        supported: false,
        reason:
          "Missing JARVIS_ROOFING_AGENT_PIPELINE_ID; HighLevel opportunity creation requires a pipelineId.",
      })
    );
  }

  planned.rawGhlActions = actions;
  return planned;
}

function buildStopTagActions(conversation) {
  if (!conversation.contactId) {
    return [
      publicAction({
        actionType: "add_tag",
        description: "Add ai-do-not-contact tag",
        supported: false,
        reason: "Missing GHL contactId for ai-do-not-contact tag.",
      }),
    ];
  }

  const action = makeGhlAction("add_do_not_contact_tag", "add_contact_tags", {
    target: { contactId: conversation.contactId },
    payload: { tags: ["ai-do-not-contact"] },
    description: "Add ai-do-not-contact tag to the GHL contact.",
  });
  const planned = [
    publicAction({
      actionType: action.actionType,
      description: action.description,
      requestPreview: previewGhlAction(action),
      rawGhlActions: [action],
    }),
  ];
  return planned;
}

function buildActionsPlanned({ conversation, classification, recommendedReply, callbackTimeText }) {
  const planned = [];

  if (recommendedReply) {
    const hasMessageTarget = !!(conversation.contactId || conversation.conversationId);
    const canSendSms = safeToAutoReply(classification) && hasMessageTarget;
    planned.push(
      publicAction({
        actionType: "store_suggested_reply",
        description: "Store the suggested SMS reply in the roofing sales conversation.",
      })
    );

    planned.push(
      publicAction({
        actionType: "send_sms_reply",
        description: "Send one GHL SMS reply to this lead.",
        supported: canSendSms,
        reason: !safeToAutoReply(classification)
          ? `Auto SMS is blocked for classification ${classification}.`
          : hasMessageTarget
            ? ""
            : "Missing GHL contactId or conversationId for one-to-one SMS reply.",
      })
    );
  }

  if (classification === "gave_callback_time") {
    planned.push(
      ...buildCallbackGhlActions({
        conversation,
        callbackTimeText,
      })
    );
    planned.push(
      publicAction({
        actionType: "notify_admin",
        description: "Notify admin that a callback time was collected.",
      })
    );
  }

  if (classification === "stop_unsubscribe") {
    planned.push(...buildStopTagActions(conversation));
    planned.push(
      publicAction({
        actionType: "stop_ai",
        description: "Stop AI for this lead and mark do_not_contact.",
      })
    );
  }

  if (classification === "not_interested" || classification === "wrong_number") {
    planned.push(
      publicAction({
        actionType: "stop_ai",
        description: "Stop AI for this lead.",
      })
    );
  }

  if (HUMAN_TAKEOVER_CLASSIFICATIONS.has(classification)) {
    planned.push(
      publicAction({
        actionType: "human_takeover",
        description: "Stop AI and route the lead to admin.",
      })
    );
    planned.push(
      publicAction({
        actionType: "notify_admin",
        description: "Notify admin that human takeover is needed.",
      })
    );
  }

  return planned;
}

async function findOrCreateConversation(inbound) {
  const query = inbound.contactId
    ? { contactId: inbound.contactId }
    : inbound.phone
      ? { phone: inbound.phone, campaignType: "roofing_siding" }
      : null;

  let conversation = query
    ? await RoofingSalesAgentConversation.findOne(query)
    : null;

  if (!conversation) {
    conversation = new RoofingSalesAgentConversation({
      contactId: inbound.contactId || "",
      phone: inbound.phone || "",
      name: inbound.name || "",
      campaignType: "roofing_siding",
      status: "new",
    });
  }

  if (inbound.contactId && !conversation.contactId) conversation.contactId = inbound.contactId;
  if (inbound.phone && !conversation.phone) conversation.phone = inbound.phone;
  if (inbound.name && !conversation.name) conversation.name = inbound.name;
  if (inbound.conversationId) conversation.conversationId = inbound.conversationId;
  if (inbound.messageId) conversation.lastMessageId = inbound.messageId;

  return conversation;
}

function appendHistory(conversation, role, content, meta = {}) {
  if (!content) return;
  conversation.conversationHistory.push({
    role,
    content,
    at: new Date(),
    meta,
  });
  if (conversation.conversationHistory.length > 50) {
    conversation.conversationHistory = conversation.conversationHistory.slice(-50);
  }
}

function logEvent(conversation, event, details = {}) {
  conversation.eventLog.push({
    event,
    at: new Date(),
    details: sanitizeForLog(details),
  });
  if (conversation.eventLog.length > 100) {
    conversation.eventLog = conversation.eventLog.slice(-100);
  }
}

async function executeGhlActions(rawActions = [], conversation, actionsPlanned) {
  const executionContext = { actionResults: {} };
  const executed = [];
  const errors = [];

  for (const action of rawActions) {
    try {
      const result = await executeAction(action, executionContext);
      executionContext.actionResults[action.actionId] = result.extracted || {};
      if (result.extracted?.contactId && !conversation.contactId) {
        conversation.contactId = result.extracted.contactId;
      }
      executed.push({
        actionId: action.actionId,
        actionType: action.actionType,
        status: result.status,
        extracted: result.extracted,
        request: result.request,
      });
      const planned = actionsPlanned.find(
        (item) =>
          item.actionType === action.actionType &&
          item.description === action.description &&
          item.executed === false
      );
      if (planned) {
        planned.executed = true;
        planned.result = { status: result.status, extracted: result.extracted };
      }
    } catch (error) {
      errors.push({
        actionId: action.actionId,
        actionType: action.actionType,
        message: error.message,
        status: error.ghlStatus || error.statusCode || null,
      });
      break;
    }
  }

  logEvent(conversation, "ghl_actions_result", { executed, errors });
  return { executed, errors };
}

async function maybeSendReply({ conversation, recommendedReply, classification, actionsPlanned }) {
  if (!recommendedReply || !safeToAutoReply(classification)) {
    return { sent: false, reason: "Auto SMS blocked by classification or empty reply." };
  }

  if (mode() !== "auto_reply_safe") {
    return { sent: false, reason: "JARVIS_ROOFING_AGENT_MODE is suggest_only." };
  }

  if (!conversation.contactId && !conversation.conversationId) {
    return {
      sent: false,
      reason: "Missing GHL contactId or conversationId for one-to-one SMS reply.",
    };
  }

  const action = makeGhlAction("send_safe_reply", "send_conversation_message", {
    target: {
      contactId: conversation.contactId || "",
      conversationId: conversation.conversationId || "",
    },
    payload: {
      messageType: "SMS",
      messageBody: recommendedReply,
    },
    description: "Send safe one-to-one SMS reply through GHL.",
  });

  const planned = actionsPlanned.find((item) => item.actionType === "send_sms_reply");
  if (planned) planned.requestPreview = previewGhlAction(action);

  try {
    const result = await executeAction(action, { actionResults: {} });
    if (planned) {
      planned.executed = true;
      planned.result = { status: result.status, extracted: result.extracted };
    }
    logEvent(conversation, "sms_reply_sent", {
      actionId: action.actionId,
      status: result.status,
      extracted: result.extracted,
    });
    return { sent: true, result };
  } catch (error) {
    if (planned) {
      planned.executed = false;
      planned.reason = error.message;
    }
    logEvent(conversation, "sms_reply_failed", {
      message: error.message,
      status: error.ghlStatus || error.statusCode || null,
    });
    return { sent: false, reason: error.message };
  }
}

async function maybeNotifyAdmin({
  conversation,
  classification,
  recommendedReply,
  actionsPlanned,
}) {
  const shouldNotify =
    classification === "gave_callback_time" ||
    HUMAN_TAKEOVER_CLASSIFICATIONS.has(classification);
  if (!shouldNotify) return null;

  const reason =
    classification === "gave_callback_time" ? "callback_scheduled" : "human_takeover";

  const planned = actionsPlanned.find((item) => item.actionType === "notify_admin");
  try {
    const result = await notifyAdmin({
      conversation,
      reason,
      classification,
      recommendedReply,
    });
    conversation.lastNotifiedAt = new Date();
    if (planned) {
      planned.supported = result.supported;
      planned.executed = result.executed;
      planned.reason = result.reason;
    }
    logEvent(conversation, "admin_notified", { reason, result });
    return result;
  } catch (error) {
    if (planned) {
      planned.executed = false;
      planned.reason = error.message;
    }
    logEvent(conversation, "admin_notification_failed", { reason, message: error.message });
    return { supported: true, executed: false, reason: error.message };
  }
}

function collectRawGhlActions(actionsPlanned) {
  const raw = [];
  for (const item of actionsPlanned) {
    if (Array.isArray(item?.rawGhlActions)) raw.push(...item.rawGhlActions);
  }
  if (Array.isArray(actionsPlanned.rawGhlActions)) raw.push(...actionsPlanned.rawGhlActions);
  return raw;
}

function stripInternalActionFields(actionsPlanned) {
  return actionsPlanned.map((action) => {
    const { rawGhlActions, ...publicFields } = action;
    return publicFields;
  });
}

async function simulateRoofingSalesAgent(input = {}) {
  const incomingMessage = cleanString(input.incomingMessage);
  if (!incomingMessage) {
    const error = new Error("incomingMessage is required");
    error.statusCode = 400;
    throw error;
  }

  const classificationResult = normalizeClassificationResult(
    await classifyRoofingLeadReply({
      contactName: input.contactName || input.name || "",
      phone: input.phone || "",
      incomingMessage,
      conversationHistory: input.conversationHistory || [],
    })
  );

  const fakeConversation = {
    contactId: cleanString(input.contactId),
    phone: cleanString(input.phone),
    name: cleanString(input.contactName || input.name),
    conversationId: cleanString(input.conversationId),
    lastIncomingMessage: incomingMessage,
    callbackTimeText: classificationResult.callbackTimeText,
    campaignType: "roofing_siding",
  };

  const actionsPlanned = buildActionsPlanned({
    conversation: fakeConversation,
    classification: classificationResult.classification,
    recommendedReply: classificationResult.recommendedReply,
    callbackTimeText: classificationResult.callbackTimeText,
  });

  return {
    classification: classificationResult.classification,
    recommendedReply: classificationResult.recommendedReply,
    actionsPlanned: stripInternalActionFields(actionsPlanned),
    humanTakeover: classificationResult.humanTakeover,
  };
}

async function handleGhlWebhook(payload = {}) {
  const inbound = parseInboundGhlMessage(payload);
  const conversation = await findOrCreateConversation(inbound);

  conversation.lastWebhookPayload = sanitizeForLog(payload);
  conversation.lastProcessedAt = new Date();

  if (!inbound.incomingMessage) {
    conversation.status = "human_takeover";
    logEvent(conversation, "unknown_webhook_payload", { inbound, payload });
    await conversation.save();
    return {
      ok: true,
      ignored: true,
      reason: "No inbound SMS body found in webhook payload.",
      conversationId: String(conversation._id),
    };
  }

  if (inbound.isLikelyOutbound) {
    logEvent(conversation, "outbound_webhook_ignored", { inbound });
    await conversation.save();
    return {
      ok: true,
      ignored: true,
      reason: "Outbound GHL message ignored.",
      conversationId: String(conversation._id),
    };
  }

  conversation.lastIncomingMessage = inbound.incomingMessage;
  appendHistory(conversation, "user", inbound.incomingMessage, {
    source: "ghl_webhook",
    messageId: inbound.messageId || "",
  });
  logEvent(conversation, "inbound_message", { inbound });

  if (!enabled()) {
    logEvent(conversation, "agent_disabled", {
      mode: mode(),
      enabled: false,
    });
    await conversation.save();
    return {
      ok: true,
      enabled: false,
      mode: mode(),
      conversationId: String(conversation._id),
      message: "Roofing Sales Agent is disabled; inbound message was stored only.",
    };
  }

  const classificationResult = normalizeClassificationResult(
    await classifyRoofingLeadReply({
      contactName: conversation.name,
      phone: conversation.phone,
      incomingMessage: inbound.incomingMessage,
      conversationHistory: normalizeHistory(conversation.conversationHistory),
    })
  );

  conversation.classification = classificationResult.classification;
  conversation.status = statusForClassification(classificationResult.classification);
  conversation.callbackTimeText = classificationResult.callbackTimeText;
  conversation.lastAiReply = classificationResult.recommendedReply;
  if (classificationResult.recommendedReply) {
    appendHistory(conversation, "assistant", classificationResult.recommendedReply, {
      source: "roofing_sales_agent",
      mode: mode(),
    });
  }

  let actionsPlanned = buildActionsPlanned({
    conversation,
    classification: classificationResult.classification,
    recommendedReply: classificationResult.recommendedReply,
    callbackTimeText: classificationResult.callbackTimeText,
  });

  logEvent(conversation, "classification", {
    classification: classificationResult.classification,
    recommendedReply: classificationResult.recommendedReply,
    callbackTimeText: classificationResult.callbackTimeText,
    actionsPlanned: stripInternalActionFields(actionsPlanned),
    humanTakeover: classificationResult.humanTakeover,
  });

  await maybeSendReply({
    conversation,
    recommendedReply: classificationResult.recommendedReply,
    classification: classificationResult.classification,
    actionsPlanned,
  });

  if (mode() === "auto_reply_safe") {
    const rawGhlActions = collectRawGhlActions(actionsPlanned).filter((action) => {
      if (
        STOP_AI_CLASSIFICATIONS.has(classificationResult.classification) &&
        action.actionId !== "add_do_not_contact_tag"
      ) {
        return false;
      }
      return true;
    });
    if (rawGhlActions.length) {
      await executeGhlActions(rawGhlActions, conversation, actionsPlanned);
    }
  } else {
    logEvent(conversation, "ghl_actions_skipped", {
      reason: "JARVIS_ROOFING_AGENT_MODE is suggest_only.",
    });
  }

  await maybeNotifyAdmin({
    conversation,
    classification: classificationResult.classification,
    recommendedReply: classificationResult.recommendedReply,
    actionsPlanned,
  });

  actionsPlanned = stripInternalActionFields(actionsPlanned);
  logEvent(conversation, "final_result", { actionsPlanned });
  await conversation.save();

  return {
    ok: true,
    enabled: true,
    mode: mode(),
    conversationId: String(conversation._id),
    classification: classificationResult.classification,
    recommendedReply: classificationResult.recommendedReply,
    actionsPlanned,
    humanTakeover: classificationResult.humanTakeover,
  };
}

module.exports = {
  BLOCKED_AUTO_REPLY_CLASSIFICATIONS,
  buildActionsPlanned,
  callbackTaskDueDate,
  enabled,
  handleGhlWebhook,
  mode,
  normalizeClassificationResult,
  safeToAutoReply,
  simulateRoofingSalesAgent,
  statusForClassification,
};
