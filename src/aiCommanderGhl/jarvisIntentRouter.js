const {
  createCampaignTemplatePlan,
  createContactOwnerAssignmentPlan,
  createEstimateCsvSyncPlan,
  createPlan,
} = require("./aiCommanderGhl.service");
const { cleanString } = require("./ghlActions");
const {
  resolveInternalCapability,
  runInternalCapability,
} = require("./jarvisInternalCapabilityRouter");
const { looksLikeCampaignBuilderRequest } = require("./jarvisCampaignBuilder.service");
const { looksLikeContactOwnerAssignmentRequest } = require("./jarvisContactOwnerAssignment");
const { runReadAction, resolveReadAction } = require("./jarvisReadActions");

const OUTSIDE_GHL_WORKSPACE_ANSWER = "This is outside my GHL workspace. Ask ChatGPT.";
const ROUTER_TRACE_VERSION = "jarvis-intent-router-contact-owner-assignment-debug-v1";

console.info("Jarvis intent router loaded", {
  routerTraceVersion: ROUTER_TRACE_VERSION,
  registeredCapabilities: {
    contactOwnerAssignment:
      typeof looksLikeContactOwnerAssignmentRequest === "function" &&
      typeof createContactOwnerAssignmentPlan === "function",
  },
});

function hasCsvFiles(context = {}) {
  return (Array.isArray(context.files) ? context.files : []).some((file) => {
    const extension = cleanString(file?.extension || file?.originalName).toLowerCase();
    const mimeType = cleanString(file?.mimeType).toLowerCase();
    return extension.endsWith(".csv") || extension === "csv" || mimeType.includes("csv");
  });
}

function hasGhlWorkspaceSignal(message, context = {}) {
  return (
    /\b(ghl|gohighlevel|highlevel|account|contacts?|customers?|leads?|campaigns?|tasks?|notes?|tags?|opportunit|pipelines?|stages?|conversations?|messages?|sms|email|workflows?|calendars?|appointments?|users?|team|custom fields?|forms?|surveys?|locations?)\b/i.test(
      message
    ) || hasCsvFiles(context)
  );
}

function looksOutsideGhlWorkspace(message, context = {}) {
  return (
    /\b(strategy|business|copy|marketing|code|programming|website|landing page|seo|blog|brand|logo|ad creative|ad copy)\b/i.test(
      message
    ) && !hasGhlWorkspaceSignal(message, context)
  );
}

function isQuestion(message) {
  return /\?|\b(how|what|which|why|when|where|who|should|can you tell|do we have)\b/i.test(
    message
  );
}

function looksLikeAdvice(message) {
  return /\b(should|recommend|recommendation|strategy|explain|why|what is wrong|what's wrong|how should|best|call first|follow up)\b/i.test(
    message
  );
}

function looksLikeRead(message, context = {}) {
  const readSubject =
    /\b(ghl|gohighlevel|highlevel|contacts?|customers?|leads?|rows?|files?|csv|tags?|opportunit|pipelines?|stages?|conversations?|messages?|workflows?|calendars?|appointments?|users?|team|custom fields?|campaigns?|forms?|surveys?|locations?|account)\b/i.test(
      message
    ) || hasCsvFiles(context);
  const informationRequest =
    /\b(how many|count|total|number of|show me|show all|list|what .*exist|what workflows|what tags|what pipelines|what .*access|access do you have|capabilities|capability|scan|summarize|summary|overview)\b/i.test(
      message
    );
  const diagnosticRequest =
    /\b(check|verify|diagnos|test)\b/i.test(message) &&
    /\b(connection|access|permission|read|endpoint)\b/i.test(message);

  return readSubject && (informationRequest || diagnosticRequest);
}

function explainLooksLikeRead(message, context = {}) {
  const readSubjectRegex =
    /\b(ghl|gohighlevel|highlevel|contacts?|customers?|leads?|rows?|files?|csv|tags?|opportunit|pipelines?|stages?|conversations?|messages?|workflows?|calendars?|appointments?|users?|team|custom fields?|campaigns?|forms?|surveys?|locations?|account)\b/i;
  const informationRequestRegex =
    /\b(how many|count|total|number of|show me|show all|list|what .*exist|what workflows|what tags|what pipelines|what .*access|access do you have|capabilities|capability|scan|summarize|summary|overview)\b/i;
  const diagnosticVerbRegex = /\b(check|verify|diagnos|test)\b/i;
  const diagnosticTargetRegex = /\b(connection|access|permission|read|endpoint)\b/i;
  const readSubject = readSubjectRegex.test(message) || hasCsvFiles(context);
  const informationRequest = informationRequestRegex.test(message);
  const diagnosticRequest =
    diagnosticVerbRegex.test(message) && diagnosticTargetRegex.test(message);

  return {
    matched: readSubject && (informationRequest || diagnosticRequest),
    readSubject,
    informationRequest,
    diagnosticRequest,
    regexes: {
      readSubject:
        "\\b(ghl|gohighlevel|highlevel|contacts?|customers?|leads?|rows?|files?|csv|tags?|...)\\b",
      informationRequest:
        "\\b(how many|count|total|number of|show me|show all|list|what .*exist|...)\\b",
      diagnosticRequest:
        "\\b(check|verify|diagnos|test)\\b + \\b(connection|access|permission|read|endpoint)\\b",
    },
  };
}

function sanitizedReadFailure(error, action) {
  const message = cleanString(error?.message || error)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]");
  const timedOut = /timeout|timed out|etimedout|socket hang up|abort/i.test(message);

  return {
    intent: "read",
    answer: timedOut
      ? "I could not finish that GHL read because GHL took too long."
      : "I could not finish that GHL read from the available endpoint.",
    data: {
      readAction: action,
      error: {
        statusCode: error?.statusCode || null,
        ghlStatus: error?.ghlStatus || null,
        message: message || "GHL read failed",
      },
    },
    sources: ["GHL"],
    requiresApproval: false,
  };
}

function looksLikeCsvSync(message, context = {}) {
  return (
    hasCsvFiles(context) &&
    /\b(sync|tag|tags?|update|add|apply|process)\b/i.test(message) &&
    /\b(ghl|gohighlevel|highlevel|contacts?|leads?|roofing|siding|tags?)\b/i.test(message)
  );
}

function looksLikeCsvAudit(message, context = {}) {
  return (
    hasCsvFiles(context) &&
    /\b(audit|match|find|check|compare|against)\b/i.test(message) &&
    /\b(ghl|gohighlevel|highlevel|contacts?|customers?|leads?)\b/i.test(message)
  );
}

function looksLikeWrite(message, context = {}) {
  if (looksLikeCsvSync(message, context)) return true;
  if (looksLikeAdvice(message) && isQuestion(message)) return false;

  return (
    /\b(create|add|send|launch|start|build|update|change|move|delete|archive|remove|assign|enroll|unenroll|tag|untag|pause|resume|cancel|schedule|book|import|sync|upsert|blast|text|sms|email)\b/i.test(
      message
    ) || /^\s*follow\s+up\b/i.test(message)
  );
}

function explainLooksLikeWrite(message, context = {}) {
  const matched = looksLikeWrite(message, context);
  return {
    matched,
    csvSync: looksLikeCsvSync(message, context),
    adviceQuestionSkipped: looksLikeAdvice(message) && isQuestion(message),
    regex:
      "\\b(create|add|send|launch|start|build|update|change|move|delete|archive|remove|assign|...)\\b",
  };
}

function classifyIntent(message, context = {}) {
  const clean = cleanString(message);
  if (!clean) {
    const error = new Error("message is required");
    error.statusCode = 400;
    throw error;
  }

  if (looksOutsideGhlWorkspace(clean, context)) return "advice";
  if (looksLikeContactOwnerAssignmentRequest(clean)) return "write";
  if (looksLikeCsvSync(clean, context)) return "write";
  if (looksLikeCsvAudit(clean, context)) return "read";
  if (looksLikeRead(clean, context)) return "read";
  if (looksLikeWrite(clean, context)) return "write";
  if (looksLikeAdvice(clean) || isQuestion(clean)) return "advice";
  return "write";
}

function adviceAnswerFor(message) {
  const text = cleanString(message).toLowerCase();

  if (looksOutsideGhlWorkspace(text)) return OUTSIDE_GHL_WORKSPACE_ANSWER;

  if (/\bcampaign\b/.test(text)) {
    return [
      "I would start with a focused reactivation campaign today.",
      "Best first move: target warm leads who already know Profixter, keep the message simple, and offer a specific next step like a roofing estimate, membership check-in, or callback window.",
      "I would not blast everyone. I would choose one audience, write one clear offer, and let you approve the exact copy before anything sends.",
    ].join(" ");
  }

  if (/\bleads?.*(call first)|call first|priority|prioritize/.test(text)) {
    return [
      "I would call the hottest leads first: anyone who replied recently, asked for pricing, gave a callback window, or has an estimate-related tag.",
      "After that, work leads with open opportunities, then older leads with no response. The goal is to spend your first calls where intent is already visible.",
    ].join(" ");
  }

  if (/\bpipeline\b/.test(text)) {
    return [
      "The first things I would check are stage balance, stuck opportunities, missing follow-up tasks, and whether won/lost stages are being updated consistently.",
      "A healthy pipeline should make the next action obvious for every lead.",
    ].join(" ");
  }

  if (/\bfollow up\b/.test(text)) {
    return [
      "I would follow up with a short, useful message that gives the customer an easy reply.",
      "For example: ask whether they want a quick call, a pricing range, or a specific appointment window. Keep it human and give them one simple decision.",
    ].join(" ");
  }

  return [
    "Here is how I would think about it.",
    "Keep the next move specific, reversible, and easy to approve. If the work touches GHL records or customer messages, I will prepare the plan first and wait for approval before anything changes.",
  ].join(" ");
}

function buildRouteTrace({ message, context, internalCapability = null }) {
  const clean = cleanString(message);
  return {
    routerTraceVersion: ROUTER_TRACE_VERSION,
    rawUserMessage: message,
    normalizedMessage: clean,
    registeredCapabilities: {
      contactOwnerAssignment:
        typeof looksLikeContactOwnerAssignmentRequest === "function" &&
        typeof createContactOwnerAssignmentPlan === "function",
    },
    evaluationOrder: [
      "outside_workspace",
      "contact_owner_assignment",
      "internal_capability",
      "classify_intent",
      "write_planners",
      "read_actions",
      "advice",
    ],
    checks: {
      outsideWorkspace: looksOutsideGhlWorkspace(clean, context),
      contactOwnerAssignment: looksLikeContactOwnerAssignmentRequest(clean),
      internalCapability: internalCapability
        ? {
            action: internalCapability.action,
            label: internalCapability.label,
          }
        : null,
      csvSync: looksLikeCsvSync(clean, context),
      csvAudit: looksLikeCsvAudit(clean, context),
      read: explainLooksLikeRead(clean, context),
      write: explainLooksLikeWrite(clean, context),
      advice: looksLikeAdvice(clean),
      question: isQuestion(clean),
    },
    matchedIntent: "",
    matchedCapability: "",
    matchedRoute: "",
    fallbackReason: "",
  };
}

function logJarvisRequest({
  adminUserId,
  message,
  intent,
  matchedIntent,
  matchedCapability,
  matchedRoute,
  fallbackReason,
  readAction,
  status,
  trace,
  error,
}) {
  console.info("Jarvis intent trace", {
    adminUserId: adminUserId || null,
    routerTraceVersion: ROUTER_TRACE_VERSION,
    rawUserMessage: cleanString(message),
    intent,
    matchedIntent: matchedIntent || trace?.matchedIntent || intent || null,
    matchedCapability: matchedCapability || trace?.matchedCapability || null,
    matchedRoute: matchedRoute || trace?.matchedRoute || null,
    fallbackReason: fallbackReason || trace?.fallbackReason || "",
    readAction: readAction || null,
    status,
    messagePreview: cleanString(message).slice(0, 240),
    registeredCapabilities: trace?.registeredCapabilities || {
      contactOwnerAssignment:
        typeof looksLikeContactOwnerAssignmentRequest === "function" &&
        typeof createContactOwnerAssignmentPlan === "function",
    },
    evaluationOrder: trace?.evaluationOrder || [],
    checks: trace?.checks || {},
    error: error
      ? {
          message: cleanString(error?.message || error),
          statusCode: error?.statusCode || null,
          ghlStatus: error?.ghlStatus || null,
        }
      : null,
  });
}

async function askJarvis({ message, adminUserId, files = [], uploadBatchId = "" }) {
  const clean = cleanString(message);
  const context = { files, uploadBatchId, adminUserId, userRequest: clean };
  const internalCapability = resolveInternalCapability(clean, context);
  const trace = buildRouteTrace({ message: clean, context, internalCapability });

  try {
    if (looksOutsideGhlWorkspace(clean, context)) {
      trace.matchedIntent = "outside_workspace";
      trace.matchedCapability = "outside_workspace";
      trace.matchedRoute = "advice:outside_workspace";
      trace.fallbackReason =
        "looksOutsideGhlWorkspace matched before GHL workspace routes.";
      logJarvisRequest({
        adminUserId,
        message: clean,
        intent: "advice",
        matchedIntent: trace.matchedIntent,
        matchedCapability: trace.matchedCapability,
        matchedRoute: trace.matchedRoute,
        fallbackReason: trace.fallbackReason,
        status: "outside_workspace",
        trace,
      });
      return {
        intent: "advice",
        answer: OUTSIDE_GHL_WORKSPACE_ANSWER,
        requiresApproval: false,
      };
    }

    if (looksLikeContactOwnerAssignmentRequest(clean)) {
      trace.matchedIntent = "contact_owner_assignment";
      trace.matchedCapability = "jarvisContactOwnerAssignment";
      trace.matchedRoute = "approval_workflow:contact_owner_assignment";
      trace.fallbackReason =
        "Matched before internal capabilities, generic read actions, and generic write planning.";
      const plan = await createContactOwnerAssignmentPlan({ message: clean, adminUserId });
      logJarvisRequest({
        adminUserId,
        message: clean,
        intent: "write",
        matchedIntent: trace.matchedIntent,
        matchedCapability: trace.matchedCapability,
        matchedRoute: trace.matchedRoute,
        fallbackReason: trace.fallbackReason,
        status: "planned",
        trace,
      });
      return {
        intent: "write",
        plan,
        requiresApproval: true,
      };
    }

    if (internalCapability) {
      trace.matchedIntent = `internal:${internalCapability.action}`;
      trace.matchedCapability = internalCapability.label;
      trace.matchedRoute = `internal_capability:${internalCapability.action}`;
      trace.fallbackReason =
        "Internal capability matched before generic read/write routing.";
      const result = await runInternalCapability({
        capability: internalCapability,
        context,
      });
      logJarvisRequest({
        adminUserId,
        message: clean,
        intent: "read",
        matchedIntent: trace.matchedIntent,
        matchedCapability: trace.matchedCapability,
        matchedRoute: trace.matchedRoute,
        fallbackReason: trace.fallbackReason,
        readAction: `internal:${internalCapability.action}`,
        status: result?.data?.status === "partial" ? "partial" : "answered",
        trace,
      });
      return {
        ...result,
        intent: "read",
        requiresApproval: false,
      };
    }

    const intent = classifyIntent(clean, context);

    if (intent === "write") {
      const plannerRoute = looksLikeCsvSync(clean, context)
        ? "approval_workflow:csv_sync"
        : looksLikeCampaignBuilderRequest(clean)
          ? "approval_workflow:campaign_template"
          : "approval_workflow:generic_ai_commander";
      trace.matchedIntent = plannerRoute.replace("approval_workflow:", "");
      trace.matchedCapability =
        plannerRoute === "approval_workflow:csv_sync"
          ? "jarvisCsvGhlSync"
          : plannerRoute === "approval_workflow:campaign_template"
            ? "jarvisCampaignBuilder"
            : "aiCommanderGhl";
      trace.matchedRoute = plannerRoute;
      trace.fallbackReason =
        plannerRoute === "approval_workflow:generic_ai_commander"
          ? "No specialized Jarvis workflow matched, so the request fell back to generic AI Commander planning."
          : "";
      const plan = looksLikeCsvSync(clean, context)
        ? await createEstimateCsvSyncPlan({ message: clean, adminUserId, files, uploadBatchId })
        : looksLikeCampaignBuilderRequest(clean)
          ? await createCampaignTemplatePlan({ message: clean, adminUserId, files, uploadBatchId })
        : await createPlan({ message: clean, adminUserId });
      logJarvisRequest({
        adminUserId,
        message: clean,
        intent,
        matchedIntent: trace.matchedIntent,
        matchedCapability: trace.matchedCapability,
        matchedRoute: trace.matchedRoute,
        fallbackReason: trace.fallbackReason,
        status: "planned",
        trace,
      });
      return {
        intent: "write",
        plan,
        requiresApproval: true,
      };
    }

    if (intent === "read") {
      const readAction = resolveReadAction(clean, context);
      trace.matchedIntent = readAction.action;
      trace.matchedCapability = "jarvisReadActions";
      trace.matchedRoute = `read_action:${readAction.action}`;
      trace.fallbackReason =
        readAction.action === "count_contacts"
          ? "looksLikeRead matched and resolveReadAction selected count_contacts. Check trace.checks.read for the regex flags that made this a read request."
          : "";
      const result = await runReadAction(clean, context);
      logJarvisRequest({
        adminUserId,
        message: clean,
        intent,
        matchedIntent: trace.matchedIntent,
        matchedCapability: trace.matchedCapability,
        matchedRoute: trace.matchedRoute,
        fallbackReason: trace.fallbackReason,
        readAction: readAction.action,
        status: "answered",
        trace,
      });
      return {
        ...result,
        intent: "read",
        requiresApproval: false,
      };
    }

    trace.matchedIntent = "advice";
    trace.matchedCapability = "jarvisAdvice";
    trace.matchedRoute = "advice";
    trace.fallbackReason =
      "No specialized Jarvis workflow, internal capability, write route, or read action matched.";
    logJarvisRequest({
      adminUserId,
      message: clean,
      intent,
      matchedIntent: trace.matchedIntent,
      matchedCapability: trace.matchedCapability,
      matchedRoute: trace.matchedRoute,
      fallbackReason: trace.fallbackReason,
      status: "answered",
      trace,
    });
    return {
      intent: "advice",
      answer: adviceAnswerFor(clean),
      requiresApproval: false,
    };
  } catch (error) {
    if (trace.matchedRoute?.startsWith("read_action:")) {
      logJarvisRequest({
        adminUserId,
        message: clean,
        intent: "read",
        matchedIntent: trace.matchedIntent,
        matchedCapability: trace.matchedCapability,
        matchedRoute: trace.matchedRoute,
        fallbackReason: trace.fallbackReason,
        readAction: trace.matchedIntent,
        status: "failed",
        trace,
        error,
      });
      return sanitizedReadFailure(error, trace.matchedIntent);
    }

    logJarvisRequest({
      adminUserId,
      message: clean,
      intent: trace.matchedRoute?.startsWith("approval_workflow:") ? "write" : "unknown",
      matchedIntent: trace.matchedIntent,
      matchedCapability: trace.matchedCapability,
      matchedRoute: trace.matchedRoute,
      fallbackReason: trace.fallbackReason,
      status: "failed",
      trace,
      error,
    });
    throw error;
  }
}

module.exports = {
  adviceAnswerFor,
  askJarvis,
  classifyIntent,
  hasGhlWorkspaceSignal,
  looksLikeRead,
  looksLikeCsvAudit,
  looksLikeCsvSync,
  looksLikeWrite,
  looksOutsideGhlWorkspace,
  OUTSIDE_GHL_WORKSPACE_ANSWER,
};
