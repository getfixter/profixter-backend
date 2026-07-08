const mongoose = require("mongoose");

const JarvisCampaignTemplate = require("./jarvisCampaignTemplate.model");
const JarvisCampaignRun = require("./jarvisCampaignRun.model");
const { executeGhlRequest } = require("./ghlUniversalExecutor");
const { getLocationId, redact } = require("./ghlClient");
const { HIGH_RISK_CONFIRMATION_PHRASE } = require("./ghlEndpointRegistry");

const START_CONFIRMATION = "START CAMPAIGN";
const DEFAULT_REPLY_ESCALATIONS = [
  "price",
  "legal",
  "complaint",
  "unusual_request",
  "outside_approved_prompt",
];

const runtimeTimers = new Map();

function cleanString(value) {
  return String(value ?? "").trim();
}

function cleanList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(cleanString).filter(Boolean))];
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (Number.isFinite(number)) return Math.max(min, Math.min(max, Math.floor(number)));
  return fallback;
}

function secondsFromDelay(delay = {}) {
  const amount = clampNumber(delay.amount, 0, 0, 365);
  const unit = cleanString(delay.unit || "minutes").toLowerCase();
  if (unit === "days") return amount * 24 * 60 * 60;
  if (unit === "hours") return amount * 60 * 60;
  return amount * 60;
}

function slugStepId(index) {
  return `step_${String(index + 1).padStart(2, "0")}`;
}

function campaignRunnerEnabled() {
  return String(process.env.JARVIS_CAMPAIGN_RUNNER_ENABLED || "").toLowerCase() === "true";
}

function looksLikeCampaignBuilderRequest(message) {
  const text = cleanString(message);
  return (
    /\bcampaigns?\b/i.test(text) &&
    /\b(create|build|start|launch|run|set up|make|prepare)\b/i.test(text)
  );
}

function isRoofingSidingUseCase(message) {
  return /\b(roof|roofing|siding|roofing\/siding|re-engagement|reengagement)\b/i.test(
    cleanString(message)
  );
}

function titleFromMessage(message) {
  const clean = cleanString(message).replace(/\s+/g, " ");
  const named = clean.match(/\b(?:called|named|name it|campaign name)\s+["']?([^"'.]+)["']?/i);
  if (named?.[1]) return named[1].trim().slice(0, 90);
  if (isRoofingSidingUseCase(clean)) return "Roofing/Siding Re-engagement 2026";

  const forAudience = clean.match(/\bfor\s+(.+?)(?:\s+with|\s+that|\s+and|\s*$)/i);
  if (forAudience?.[1]) {
    const audience = forAudience[1].replace(/\b(tagged|contacts?|leads?|customers?)\b/gi, "").trim();
    if (audience) return `${audience.split(/\s+/).slice(0, 5).join(" ")} Campaign`;
  }

  return "Jarvis Campaign";
}

function quotedMessages(message) {
  const matches = [...cleanString(message).matchAll(/"([^"]{8,800})"/g)];
  return matches.map((match) => match[1].trim()).filter(Boolean).slice(0, 8);
}

function tagsFromMessage(message) {
  const text = cleanString(message);
  if (isRoofingSidingUseCase(text)) return ["Roofing/Siding", "sal-roofing", "sal-siding"];

  const tagged = text.match(/\btagged\s+(.+?)(?:\s+with|\s+and|\s+only|\s+first|\s*$)/i);
  let tags = tagged?.[1]
    ? tagged[1]
        .split(/,|\bor\b|\band\b/i)
        .map((item) => item.replace(/^["']|["']$/g, "").trim())
        .filter(Boolean)
    : [];

  if (!tags.length) {
    const audience = text.match(/\bfor\s+(.+?)(?:\s+with|\s+that|\s+and|\s+first|\s*$)/i);
    const inferred = cleanString(audience?.[1])
      .replace(/\b(ghl|contacts?|customers?|leads?|audience|people)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    if (inferred && !/\b(csv|file|spreadsheet|smart list)\b/i.test(inferred)) {
      tags = [inferred];
    }
  }

  return cleanList(tags);
}

function buildDefaultMessages({ campaignName, roofingSiding }) {
  if (roofingSiding) {
    return [
      {
        channel: "sms",
        body:
          "Hi {{contact.firstName}}, this is Taras from Profixter. Are you still thinking about roofing or siding work this season?",
        waitDelay: { amount: 0, unit: "minutes", seconds: 0 },
      },
      {
        channel: "sms",
        body:
          "Just checking in. If roofing or siding is still on your list, I can help set up a quick estimate window.",
        waitDelay: { amount: 2, unit: "days", seconds: 172800 },
      },
    ];
  }

  return [
    {
      channel: "sms",
      body:
        "Hi {{contact.firstName}}, this is Taras from Profixter. Are you still interested in talking about {{campaign.name}}?",
      waitDelay: { amount: 0, unit: "minutes", seconds: 0 },
    },
    {
      channel: "sms",
      body: "Just checking in. Would a quick callback or estimate window be helpful?",
      waitDelay: { amount: 2, unit: "days", seconds: 172800 },
    },
  ].map((step) => ({
    ...step,
    body: step.body.replace("{{campaign.name}}", campaignName),
  }));
}

function messageStepsFromNaturalLanguage(message, campaignName) {
  const customMessages = quotedMessages(message);
  const roofingSiding = isRoofingSidingUseCase(message);
  const rawSteps = customMessages.length
    ? customMessages.map((body, index) => ({
        channel: "sms",
        body,
        waitDelay:
          index === 0
            ? { amount: 0, unit: "minutes", seconds: 0 }
            : { amount: 2, unit: "days", seconds: 172800 },
      }))
    : buildDefaultMessages({ campaignName, roofingSiding });

  return rawSteps.map((step, index) => ({
    stepId: slugStepId(index),
    channel: step.channel || "sms",
    subject: "",
    body: cleanString(step.body),
    waitDelay: {
      amount: clampNumber(step.waitDelay?.amount, 0, 0, 365),
      unit: ["minutes", "hours", "days"].includes(cleanString(step.waitDelay?.unit))
        ? cleanString(step.waitDelay.unit)
        : "minutes",
      seconds: secondsFromDelay(step.waitDelay),
    },
    enabled: true,
  }));
}

function uploadedCsvAudience(files, uploadBatchId) {
  const uploadedFiles = Array.isArray(files) ? files : [];
  const hasCsv = uploadedFiles.some((file) => {
    const extension = cleanString(file?.extension || file?.originalName).toLowerCase();
    return extension === "csv" || extension.endsWith(".csv");
  });
  if (!hasCsv) return null;
  return {
    type: "uploaded_csv",
    tags: [],
    smartListId: "",
    uploadBatchId: cleanString(uploadBatchId),
    files: uploadedFiles.map((file) => redact(file)),
    filters: {},
    limit: 0,
    testMode: true,
  };
}

function audienceFromNaturalLanguage({ message, files = [], uploadBatchId = "" }) {
  const csvAudience = uploadedCsvAudience(files, uploadBatchId);
  if (csvAudience) return csvAudience;

  const tags = tagsFromMessage(message);
  const testLimit = /\b(first|test mode|test)\s+(\d{1,4})\b/i.exec(message);
  const limit = testLimit?.[2]
    ? clampNumber(testLimit[2], 10, 1, 10000)
    : isRoofingSidingUseCase(message)
      ? 10
      : 25;

  return {
    type: "ghl_tags",
    tags,
    smartListId: "",
    uploadBatchId: "",
    files: [],
    filters: {},
    limit,
    testMode: true,
  };
}

function buildCampaignTemplateDraft({ message, files = [], uploadBatchId = "" }) {
  const originalMessage = cleanString(message);
  const campaignName = titleFromMessage(originalMessage);
  const roofingSiding = isRoofingSidingUseCase(originalMessage);
  const audienceDefinition = audienceFromNaturalLanguage({
    message: originalMessage,
    files,
    uploadBatchId,
  });
  const messageSteps = messageStepsFromNaturalLanguage(originalMessage, campaignName);

  return {
    campaignName,
    description: roofingSiding
      ? "Template-created re-engagement campaign for roofing and siding leads."
      : "Template-created Jarvis campaign.",
    audienceDefinition,
    messageSteps,
    stopConditions: {
      onReply: true,
      onManualTakeover: true,
      onAppointmentBooked: true,
      onUnsubscribe: true,
      stopKeywords: ["stop", "unsubscribe", "wrong number"],
    },
    replyHandlingRules: {
      aiAutoReplyAllowed: true,
      humanLikeDelay: { minSeconds: 45, maxSeconds: 180 },
      escalateWhen: DEFAULT_REPLY_ESCALATIONS,
      stopAutomationWhenManualMessageDetected: true,
    },
    aiQualificationPrompt: roofingSiding
      ? "Qualify inbound replies only for roofing or siding interest, timing, callback preference, and appointment readiness. Escalate pricing, complaints, legal issues, unusual requests, or anything outside roofing/siding re-engagement."
      : "Qualify inbound replies only inside this approved campaign's audience, messages, and rules. Escalate pricing, legal issues, complaints, unusual requests, or anything outside the approved prompt.",
    outcomeTags: roofingSiding
      ? ["Roofing/Siding", "jarvis-campaign-reengaged"]
      : ["jarvis-campaign-reengaged"],
    appointmentBookingRules: {
      mayOfferCallbackWindow: true,
      mayBookAppointment: false,
      requiresHumanForExactPricing: true,
    },
    ownerNotificationRules: {
      notifyOwnerOnInterestedReply: true,
      notifyOwnerOnEscalation: true,
      ownerLabel: "Taras",
    },
    testMode: true,
    approvalBeforeSending: true,
    status: "draft",
  };
}

function validateCampaignTemplateDraft(template) {
  const errors = [];
  if (!cleanString(template?.campaignName)) errors.push("Campaign name is required.");
  if (!Array.isArray(template?.messageSteps) || !template.messageSteps.length) {
    errors.push("At least one message step is required.");
  }
  if (!template?.audienceDefinition || typeof template.audienceDefinition !== "object") {
    errors.push("Audience definition is required.");
  }
  const audience = template?.audienceDefinition || {};
  if (audience.type === "ghl_tags" && !cleanList(audience.tags).length) {
    errors.push("A GHL tag audience needs at least one tag.");
  }
  if (audience.type === "uploaded_csv" && !cleanString(audience.uploadBatchId)) {
    errors.push("Uploaded CSV campaigns need an upload batch reference.");
  }
  if (errors.length) {
    const error = new Error(errors.join(" "));
    error.statusCode = 400;
    throw error;
  }
}

function publicTemplate(template, latestRun = null) {
  if (!template) return null;
  const record = typeof template.toObject === "function" ? template.toObject() : template;
  return {
    id: String(record._id || record.id || ""),
    campaignName: record.campaignName,
    description: record.description,
    audienceDefinition: record.audienceDefinition || {},
    messageSteps: record.messageSteps || [],
    stopConditions: record.stopConditions || {},
    replyHandlingRules: record.replyHandlingRules || {},
    aiQualificationPrompt: record.aiQualificationPrompt || "",
    outcomeTags: record.outcomeTags || [],
    appointmentBookingRules: record.appointmentBookingRules || {},
    ownerNotificationRules: record.ownerNotificationRules || {},
    testMode: record.testMode === true,
    approvalBeforeSending: record.approvalBeforeSending !== false,
    status: record.status,
    stats: record.stats || {},
    latestRun: latestRun ? publicRun(latestRun) : null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    approvedAt: record.approvedAt,
  };
}

function publicRun(run) {
  if (!run) return null;
  const record = typeof run.toObject === "function" ? run.toObject() : run;
  return {
    id: String(record._id || record.id || ""),
    templateId: String(record.templateId || ""),
    status: record.status,
    testMode: record.testMode === true,
    dryRun: record.dryRun === true,
    currentStepIndex: record.currentStepIndex || 0,
    audience: {
      type: record.audience?.type || "",
      tags: record.audience?.tags || [],
      limit: record.audience?.limit || 0,
      contactCount: Array.isArray(record.audience?.contactIds)
        ? record.audience.contactIds.length
        : 0,
      previewContacts: record.audience?.previewContacts || [],
      partial: record.audience?.partial === true,
      reason: record.audience?.reason || "",
      resolvedAt: record.audience?.resolvedAt || null,
    },
    stats: record.stats || {},
    messageLog: (record.messageLog || []).slice(-50),
    events: (record.events || []).slice(-50),
    errors: record.errors || [],
    startedAt: record.startedAt,
    pausedAt: record.pausedAt,
    completedAt: record.completedAt,
    failedAt: record.failedAt,
    nextRunAt: record.nextRunAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

async function createCampaignTemplateFromPlan({
  template,
  adminUserId,
  originalMessage = "",
  confirmationId = "",
}) {
  validateCampaignTemplateDraft(template);
  const created = await JarvisCampaignTemplate.create({
    ...template,
    source: {
      createdBy: adminUserId,
      originalMessage: cleanString(originalMessage),
      confirmationId: cleanString(confirmationId),
      createdByJarvis: true,
    },
    auditLog: [
      {
        at: new Date().toISOString(),
        event: "template_created_after_approval",
        originalMessage: cleanString(originalMessage),
      },
    ],
  });
  return publicTemplate(created);
}

async function listCampaigns({ limit = 30 } = {}) {
  const templates = await JarvisCampaignTemplate.find({})
    .sort({ updatedAt: -1 })
    .limit(Math.max(1, Math.min(100, Number(limit || 30))))
    .lean();
  const runIds = templates.map((item) => item.lastRunId).filter(Boolean);
  const runs = runIds.length
    ? await JarvisCampaignRun.find({ _id: { $in: runIds } }).lean()
    : [];
  const runsById = new Map(runs.map((run) => [String(run._id), run]));
  return {
    campaigns: templates.map((template) =>
      publicTemplate(template, template.lastRunId ? runsById.get(String(template.lastRunId)) : null)
    ),
  };
}

async function getCampaign(campaignId) {
  if (!mongoose.Types.ObjectId.isValid(campaignId)) {
    const error = new Error("Invalid campaign id.");
    error.statusCode = 400;
    throw error;
  }
  const template = await JarvisCampaignTemplate.findById(campaignId).lean();
  if (!template) {
    const error = new Error("Campaign template not found.");
    error.statusCode = 404;
    throw error;
  }
  const runs = await JarvisCampaignRun.find({ templateId: template._id })
    .sort({ createdAt: -1 })
    .limit(10)
    .lean();
  return {
    campaign: publicTemplate(template, runs[0] || null),
    runs: runs.map(publicRun),
  };
}

function normalizeContact(contact) {
  return {
    id: cleanString(contact?.id || contact?._id || contact?.contactId),
    name: cleanString(
      contact?.name ||
        contact?.contactName ||
        [contact?.firstName, contact?.lastName].map(cleanString).filter(Boolean).join(" ")
    ),
    phone: cleanString(contact?.phone),
    email: cleanString(contact?.email),
    tags: cleanList(contact?.tags || contact?.contactTags),
  };
}

function collectionFrom(data, keys) {
  for (const key of keys) {
    const value = key.split(".").reduce((current, part) => current?.[part], data);
    if (Array.isArray(value)) return value;
  }
  return [];
}

async function resolveGhlTagAudience(audience, context = {}) {
  const tags = cleanList(audience.tags);
  const limit = audience.testMode
    ? clampNumber(audience.limit, 10, 1, 1000)
    : clampNumber(audience.limit, 100, 1, 5000);
  const byId = new Map();
  const errors = [];

  for (const tag of tags) {
    try {
      const result = await executeGhlRequest({
        method: "POST",
        path: "/contacts/search",
        body: {
          page: 1,
          pageLimit: limit,
          query: tag,
        },
        approved: false,
        reason: `Resolve Jarvis campaign audience tag: ${tag}`,
        adminUserId: context.adminUserId,
        userRequest: context.userRequest,
      });
      const contacts = collectionFrom(result.response || result.data || {}, [
        "contacts",
        "data",
        "items",
      ]).map(normalizeContact);
      contacts.forEach((contact) => {
        if (!contact.id) return;
        const tagSet = new Set(contact.tags.map((item) => item.toLowerCase()));
        if (!tagSet.size || tagSet.has(tag.toLowerCase())) byId.set(contact.id, contact);
      });
    } catch (error) {
      errors.push({
        tag,
        message: cleanString(error?.message || error),
        statusCode: error?.statusCode || null,
        ghlStatus: error?.ghlStatus || null,
      });
    }
  }

  const contacts = [...byId.values()].slice(0, limit);
  return {
    type: "ghl_tags",
    tags,
    limit,
    contacts,
    partial: errors.length > 0,
    reason: errors.length
      ? "Jarvis could not fully resolve every audience tag before starting."
      : "",
    errors,
  };
}

async function resolveAudience(template, context = {}) {
  const audience = template.audienceDefinition || {};
  if (audience.type === "ghl_tags") {
    const resolved = await resolveGhlTagAudience(audience, context);
    if (resolved.contacts.length || resolved.errors.length) return resolved;
  }

  const fallbackLimit = template.testMode
    ? clampNumber(audience.limit, 10, 1, 1000)
    : clampNumber(audience.limit, 100, 1, 5000);
  return {
    type: cleanString(audience.type || "ghl_tags"),
    tags: cleanList(audience.tags),
    limit: fallbackLimit,
    contacts: [],
    partial: true,
    reason:
      audience.type === "uploaded_csv"
        ? "CSV campaign audience resolution is prepared, but contact import/sending is not enabled yet."
        : "Jarvis prepared the campaign run, but could not resolve GHL contacts for this audience yet.",
    errors: [],
  };
}

function renderMessage(body, contact, template) {
  const firstName = cleanString(contact.name).split(/\s+/)[0] || "there";
  return cleanString(body)
    .replace(/\{\{\s*contact\.firstName\s*\}\}/gi, firstName)
    .replace(/\{\{\s*contact\.name\s*\}\}/gi, cleanString(contact.name) || firstName)
    .replace(/\{\{\s*campaign\.name\s*\}\}/gi, cleanString(template.campaignName));
}

function buildMessageSchedule({ template, contacts, startedAt }) {
  const steps = (template.messageSteps || []).filter((step) => step.enabled !== false);
  const rows = [];
  for (const contact of contacts) {
    let cumulativeSeconds = 0;
    steps.forEach((step, index) => {
      cumulativeSeconds += secondsFromDelay(step.waitDelay);
      rows.push({
        logId: `${cleanString(contact.id || contact.email || contact.phone)}:${step.stepId || index}`,
        contactId: cleanString(contact.id),
        contactName: cleanString(contact.name),
        phone: cleanString(contact.phone),
        email: cleanString(contact.email),
        stepId: cleanString(step.stepId || slugStepId(index)),
        stepIndex: index,
        channel: cleanString(step.channel || "sms"),
        body: renderMessage(step.body, contact, template),
        dueAt: new Date(startedAt.getTime() + cumulativeSeconds * 1000).toISOString(),
        status: "scheduled",
        sentAt: null,
        response: null,
      });
    });
  }
  return rows;
}

async function startCampaignRun({ campaignId, adminUserId, confirmation, dryRun } = {}) {
  if (cleanString(confirmation) !== START_CONFIRMATION) {
    const error = new Error(`Type ${START_CONFIRMATION} to start this campaign.`);
    error.statusCode = 400;
    throw error;
  }
  if (!mongoose.Types.ObjectId.isValid(campaignId)) {
    const error = new Error("Invalid campaign id.");
    error.statusCode = 400;
    throw error;
  }

  const template = await JarvisCampaignTemplate.findById(campaignId);
  if (!template) {
    const error = new Error("Campaign template not found.");
    error.statusCode = 404;
    throw error;
  }
  if (!Array.isArray(template.messageSteps) || !template.messageSteps.length) {
    const error = new Error("This campaign needs at least one message step before it can start.");
    error.statusCode = 400;
    throw error;
  }

  const startedAt = new Date();
  const templateSnapshot = template.toObject();
  const safeDryRun = dryRun !== false || !campaignRunnerEnabled();
  const resolvedAudience = await resolveAudience(templateSnapshot, {
    adminUserId,
    userRequest: `Start Jarvis campaign ${template.campaignName}`,
  });
  const contacts = resolvedAudience.contacts;
  const messageLog = buildMessageSchedule({ template: templateSnapshot, contacts, startedAt });
  const stats = {
    leadCount: contacts.length || resolvedAudience.limit || 0,
    messagesQueued: messageLog.length,
    messagesSent: 0,
    messagesSkipped: 0,
    replies: 0,
    appointments: 0,
    escalations: 0,
    stopped: 0,
    errors: resolvedAudience.errors?.length || 0,
  };
  const run = await JarvisCampaignRun.create({
    templateId: template._id,
    templateSnapshot,
    status: "running",
    approvedBy: adminUserId,
    startedAt,
    nextRunAt: messageLog.length ? new Date(messageLog[0].dueAt) : null,
    testMode: template.testMode === true,
    dryRun: safeDryRun,
    currentStepIndex: 0,
    audience: {
      type: resolvedAudience.type,
      tags: resolvedAudience.tags,
      limit: resolvedAudience.limit,
      contactIds: contacts.map((contact) => contact.id).filter(Boolean),
      previewContacts: contacts.slice(0, 10),
      resolvedAt: new Date(),
      partial: resolvedAudience.partial,
      reason: resolvedAudience.reason,
    },
    stats,
    messageLog,
    events: [
      {
        at: new Date().toISOString(),
        event: "campaign_started",
        message: safeDryRun
          ? "Campaign started in dry-run mode. No SMS will be sent."
          : "Campaign started and approved for scheduled SMS sends.",
        details: {
          testMode: template.testMode === true,
          dryRun: safeDryRun,
          runnerEnabled: campaignRunnerEnabled(),
          locationId: (() => {
            try {
              return getLocationId();
            } catch {
              return "";
            }
          })(),
        },
      },
    ],
    errors: resolvedAudience.errors || [],
  });

  template.status = safeDryRun ? "approved" : "running";
  template.approvedBy = adminUserId;
  template.approvedAt = startedAt;
  template.lastRunId = run._id;
  template.stats = {
    leadCount: stats.leadCount,
    messagesSent: 0,
    replies: 0,
    appointments: 0,
  };
  template.auditLog.push({
    at: new Date().toISOString(),
    event: "campaign_run_started",
    runId: String(run._id),
    dryRun: safeDryRun,
  });
  await template.save();

  scheduleCampaignRun(run._id);
  return {
    campaign: publicTemplate(template, run),
    run: publicRun(run),
  };
}

function scheduleCampaignRun(runId, delayMs = 250) {
  const id = String(runId);
  if (runtimeTimers.has(id)) clearTimeout(runtimeTimers.get(id));
  runtimeTimers.set(
    id,
    setTimeout(() => {
      runtimeTimers.delete(id);
      processCampaignRun(id).catch((error) => {
        console.error("Jarvis campaign run failed", {
          runId: id,
          message: cleanString(error?.message || error),
        });
      });
    }, Math.max(0, Math.min(delayMs, 2147483647)))
  );
}

async function processCampaignRun(runId) {
  if (!mongoose.Types.ObjectId.isValid(runId)) return;
  const run = await JarvisCampaignRun.findById(runId);
  if (!run || run.status !== "running") return;

  const now = new Date();
  const template = run.templateSnapshot || {};
  let changed = false;
  for (const entry of run.messageLog || []) {
    if (entry.status !== "scheduled") continue;
    const dueAt = new Date(entry.dueAt);
    if (Number.isFinite(dueAt.getTime()) && dueAt > now) continue;

    changed = true;
    if (run.dryRun) {
      entry.status = "dry_run";
      entry.sentAt = new Date().toISOString();
      run.stats.messagesSkipped += 1;
      run.events.push({
        at: new Date().toISOString(),
        event: "message_dry_run",
        message: `Prepared ${entry.channel.toUpperCase()} for ${entry.contactName || entry.contactId}.`,
        details: { contactId: entry.contactId, stepId: entry.stepId },
      });
      continue;
    }

    try {
      const result = await executeGhlRequest({
        method: "POST",
        path: "/conversations/messages",
        body: {
          type: entry.channel === "email" ? "Email" : "SMS",
          contactId: entry.contactId,
          message: entry.body,
        },
        approved: true,
        confirmationPhrase: HIGH_RISK_CONFIRMATION_PHRASE,
        reason: `Jarvis approved campaign send: ${template.campaignName || "Campaign"}`,
        userRequest: `Run campaign ${template.campaignName || ""}`.trim(),
      });
      entry.status = "sent";
      entry.sentAt = new Date().toISOString();
      entry.response = redact({
        status: result.status,
        endpointKey: result.endpointKey,
        attempts: result.attempts,
      });
      run.stats.messagesSent += 1;
      run.events.push({
        at: new Date().toISOString(),
        event: "message_sent",
        message: `Sent ${entry.channel.toUpperCase()} for ${entry.contactName || entry.contactId}.`,
        details: { contactId: entry.contactId, stepId: entry.stepId },
      });
    } catch (error) {
      entry.status = "failed";
      entry.response = redact({
        message: cleanString(error?.message || error),
        statusCode: error?.statusCode || null,
        ghlStatus: error?.ghlStatus || null,
      });
      run.stats.errors += 1;
      run.errors.push(entry.response);
      run.events.push({
        at: new Date().toISOString(),
        event: "message_failed",
        message: `Could not send ${entry.channel.toUpperCase()} for ${entry.contactName || entry.contactId}.`,
        details: entry.response,
      });
    }
  }

  const remaining = (run.messageLog || []).filter((entry) => entry.status === "scheduled");
  if (!remaining.length) {
    run.status = "completed";
    run.completedAt = new Date();
    run.nextRunAt = null;
    run.events.push({
      at: new Date().toISOString(),
      event: "campaign_completed",
      message: run.dryRun
        ? "Dry run completed. No SMS was sent."
        : "Campaign run completed.",
    });
  } else {
    const nextDue = remaining
      .map((entry) => new Date(entry.dueAt))
      .filter((date) => Number.isFinite(date.getTime()))
      .sort((a, b) => a.getTime() - b.getTime())[0];
    run.nextRunAt = nextDue || null;
  }

  if (changed) await run.save();

  await JarvisCampaignTemplate.findByIdAndUpdate(run.templateId, {
    $set: {
      status: run.status === "completed" ? "completed" : run.status,
      stats: {
        leadCount: run.stats.leadCount,
        messagesSent: run.stats.messagesSent,
        replies: run.stats.replies,
        appointments: run.stats.appointments,
      },
    },
  });

  if (run.status === "running" && run.nextRunAt) {
    scheduleCampaignRun(run._id, Math.max(250, new Date(run.nextRunAt).getTime() - Date.now()));
  }
}

async function pauseCampaignRun({ campaignId, adminUserId }) {
  const template = await JarvisCampaignTemplate.findById(campaignId);
  if (!template) {
    const error = new Error("Campaign template not found.");
    error.statusCode = 404;
    throw error;
  }
  const run = template.lastRunId
    ? await JarvisCampaignRun.findById(template.lastRunId)
    : await JarvisCampaignRun.findOne({ templateId: template._id }).sort({ createdAt: -1 });
  if (!run || !["queued", "running"].includes(run.status)) {
    const error = new Error("There is no running campaign to pause.");
    error.statusCode = 409;
    throw error;
  }
  run.status = "paused";
  run.pausedAt = new Date();
  run.events.push({
    at: new Date().toISOString(),
    event: "campaign_paused",
    message: "Campaign paused by admin.",
    details: { adminUserId: String(adminUserId || "") },
  });
  await run.save();
  template.status = "paused";
  template.auditLog.push({
    at: new Date().toISOString(),
    event: "campaign_paused",
    runId: String(run._id),
  });
  await template.save();
  if (runtimeTimers.has(String(run._id))) clearTimeout(runtimeTimers.get(String(run._id)));
  return { campaign: publicTemplate(template, run), run: publicRun(run) };
}

async function resumeCampaignRun({ campaignId, adminUserId }) {
  const template = await JarvisCampaignTemplate.findById(campaignId);
  if (!template) {
    const error = new Error("Campaign template not found.");
    error.statusCode = 404;
    throw error;
  }
  const run = template.lastRunId
    ? await JarvisCampaignRun.findById(template.lastRunId)
    : await JarvisCampaignRun.findOne({ templateId: template._id }).sort({ createdAt: -1 });
  if (!run || run.status !== "paused") {
    const error = new Error("There is no paused campaign to resume.");
    error.statusCode = 409;
    throw error;
  }
  run.status = "running";
  run.events.push({
    at: new Date().toISOString(),
    event: "campaign_resumed",
    message: "Campaign resumed by admin.",
    details: { adminUserId: String(adminUserId || "") },
  });
  await run.save();
  template.status = "running";
  template.auditLog.push({
    at: new Date().toISOString(),
    event: "campaign_resumed",
    runId: String(run._id),
  });
  await template.save();
  scheduleCampaignRun(run._id);
  return { campaign: publicTemplate(template, run), run: publicRun(run) };
}

module.exports = {
  START_CONFIRMATION,
  buildCampaignTemplateDraft,
  createCampaignTemplateFromPlan,
  getCampaign,
  listCampaigns,
  looksLikeCampaignBuilderRequest,
  pauseCampaignRun,
  publicRun,
  publicTemplate,
  resumeCampaignRun,
  startCampaignRun,
  validateCampaignTemplateDraft,
};
