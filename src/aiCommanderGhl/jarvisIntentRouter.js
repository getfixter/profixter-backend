const { createPlan } = require("./aiCommanderGhl.service");
const { cleanString } = require("./ghlActions");
const { runReadAction, resolveReadAction } = require("./jarvisReadActions");

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

function looksLikeRead(message) {
  const readSubject =
    /\b(ghl|gohighlevel|highlevel|contacts?|customers?|leads?|tags?|opportunit|pipelines?|stages?|conversations?|messages?|workflows?|calendars?|appointments?|users?|team|custom fields?|campaigns?|forms?|surveys?|locations?|account)\b/i.test(
      message
    );
  const informationRequest =
    /\b(how many|count|total|number of|show me|show all|list|what .*exist|what workflows|what tags|what pipelines|what .*access|access do you have|capabilities|capability|scan|summarize|summary|overview)\b/i.test(
      message
    );
  const diagnosticRequest =
    /\b(check|verify|diagnos|test)\b/i.test(message) &&
    /\b(connection|access|permission|read|endpoint)\b/i.test(message);

  return readSubject && (informationRequest || diagnosticRequest);
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

function looksLikeWrite(message) {
  if (looksLikeAdvice(message) && isQuestion(message)) return false;

  return (
    /\b(create|add|send|launch|start|build|update|change|move|delete|archive|remove|assign|enroll|unenroll|tag|untag|pause|resume|cancel|schedule|book|import|sync|upsert|blast|text|sms|email)\b/i.test(
      message
    ) || /^\s*follow\s+up\b/i.test(message)
  );
}

function classifyIntent(message) {
  const clean = cleanString(message);
  if (!clean) {
    const error = new Error("message is required");
    error.statusCode = 400;
    throw error;
  }

  if (looksLikeRead(clean)) return "read";
  if (looksLikeWrite(clean)) return "write";
  if (looksLikeAdvice(clean) || isQuestion(clean)) return "advice";
  return "write";
}

function adviceAnswerFor(message) {
  const text = cleanString(message).toLowerCase();

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

function logJarvisRequest({ adminUserId, message, intent, readAction, status }) {
  console.info("Jarvis intent request", {
    adminUserId: adminUserId || null,
    intent,
    readAction: readAction || null,
    status,
    messagePreview: cleanString(message).slice(0, 240),
  });
}

async function askJarvis({ message, adminUserId }) {
  const clean = cleanString(message);
  const intent = classifyIntent(clean);

  if (intent === "write") {
    const plan = await createPlan({ message: clean, adminUserId });
    logJarvisRequest({ adminUserId, message: clean, intent, status: "planned" });
    return {
      intent: "write",
      plan,
      requiresApproval: true,
    };
  }

  if (intent === "read") {
    const readAction = resolveReadAction(clean);
    try {
      const result = await runReadAction(clean);
      logJarvisRequest({
        adminUserId,
        message: clean,
        intent,
        readAction: readAction.action,
        status: "answered",
      });
      return {
        ...result,
        intent: "read",
        requiresApproval: false,
      };
    } catch (error) {
      logJarvisRequest({
        adminUserId,
        message: clean,
        intent,
        readAction: readAction.action,
        status: "failed",
      });
      return sanitizedReadFailure(error, readAction.action);
    }
  }

  logJarvisRequest({ adminUserId, message: clean, intent, status: "answered" });
  return {
    intent: "advice",
    answer: adviceAnswerFor(clean),
    requiresApproval: false,
  };
}

module.exports = {
  adviceAnswerFor,
  askJarvis,
  classifyIntent,
  looksLikeRead,
  looksLikeWrite,
};
