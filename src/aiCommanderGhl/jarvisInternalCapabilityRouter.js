const { cleanString } = require("./ghlActions");
const { redact } = require("./ghlClient");
const { classifyFailure } = require("./ghlReadCapabilities");
const { buildGhlControlCenterReport } = require("./ghlOperationsControlLayer");
const {
  countContacts,
  countConversationsWaiting,
  countOpportunities,
  getLocationInfo,
  listCalendars,
  listCampaigns,
  listCustomFields,
  listCustomValues,
  listPipelines,
  listTags,
  listUsers,
  listWorkflows,
} = require("./jarvisReadActions");

function hasGhlSignal(text) {
  return /\b(ghl|gohighlevel|highlevel|account|workspace|setup|crm|pipeline|tag|opportunit|workflow|conversation|campaign|calendar|settings?|diagnostic|health check|report)\b/.test(
    text
  );
}

function isWriteCampaignRequest(text) {
  return (
    /\bcampaigns?\b/.test(text) &&
    /\b(create|build|launch|start|send|schedule|run|activate)\b/.test(text) &&
    !/\b(builder|audit|review|diagnos|health check|status|list)\b/.test(text)
  );
}

function hasSpecificReviewSubject(text) {
  return /\b(campaign builder|campaigns?|pipelines?|stages?|tags?|opportunit|workflows?|conversations?|messages?|inbox|settings?|configuration|location|custom fields?|custom values?)\b/.test(
    text
  );
}

function hasUploadedFiles(context = {}) {
  return Array.isArray(context.files) && context.files.length > 0;
}

function capability(label, action, aliases = []) {
  return {
    action,
    label,
    aliases,
  };
}

function resolveInternalCapability(message, context = {}) {
  const text = cleanString(message).toLowerCase();
  if (!text || !hasGhlSignal(text)) return null;

  if (
    hasUploadedFiles(context) &&
    /\b(csv|file|uploaded|attached|spreadsheet|estimate file)\b/.test(text)
  ) {
    return null;
  }

  if (/\b(health check|control center|diagnostics?|diagnose|diagnostic report)\b/.test(text)) {
    return capability("GHL Health Check", "health_check", [
      "diagnostics",
      "control center",
    ]);
  }

  if (/\b(pipeline|pipelines|stages?)\b/.test(text) && /\b(review|audit|inspect|diagnos|health|setup)\b/.test(text)) {
    return capability("Pipeline Review", "pipeline_review");
  }

  if (/\btags?\b/.test(text) && /\b(review|audit|inspect|diagnos|health|setup)\b/.test(text)) {
    return capability("Tag Review", "tag_review");
  }

  if (/\bopportunit/.test(text) && /\b(review|audit|inspect|diagnos|health|setup)\b/.test(text)) {
    return capability("Opportunity Review", "opportunity_review");
  }

  if (/\bworkflows?\b/.test(text) && /\b(review|audit|inspect|diagnos|health|setup)\b/.test(text)) {
    return capability("Workflow Review", "workflow_review");
  }

  if (/\b(conversations?|messages?|inbox)\b/.test(text) && /\b(review|audit|inspect|diagnos|health|setup)\b/.test(text)) {
    return capability("Conversation Review", "conversation_review");
  }

  if (/\b(settings?|setup|configuration|location|custom fields?|custom values?)\b/.test(text) && /\b(review|audit|inspect|diagnos|health)\b/.test(text)) {
    return capability("Settings Review", "settings_review");
  }

  if (
    /\bcampaign builder\b/.test(text) ||
    (/\bcampaigns?\b/.test(text) && /\b(review|audit|inspect|diagnos|health|status|list)\b/.test(text) && !isWriteCampaignRequest(text))
  ) {
    return capability("Campaign Builder Review", "campaign_builder_review");
  }

  if (/\breports?\b/.test(text) && /\b(run|generate|show|review|audit|ghl|account)\b/.test(text)) {
    return capability("GHL Reports", "reports");
  }

  if (
    /\b(audit|review|inspect|scan)\b/.test(text) &&
    /\b(ghl|gohighlevel|highlevel|account|setup|workspace|crm)\b/.test(text) &&
    !hasSpecificReviewSubject(text)
  ) {
    return capability("GHL Account Audit", "account_audit", [
      "account audit",
      "setup review",
    ]);
  }

  return null;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("en-US");
}

function errorSummary(error) {
  return redact({
    type: classifyFailure(error),
    statusCode: error?.statusCode || null,
    ghlStatus: error?.ghlStatus || null,
    code: cleanString(error?.response?.code || error?.response?.error || error?.code),
    message: cleanString(error?.message || error) || "Internal Jarvis module failed.",
  });
}

function firstNumeric(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function inferModuleStats(key, data = {}) {
  if (key === "pipelines") {
    return {
      total: firstNumeric(data.totalPipelines, data.total),
      details: {
        stages: firstNumeric(data.totalStages),
      },
    };
  }
  if (key === "contacts") {
    return {
      total: firstNumeric(data.total, data.scanned),
      partial: data.partial === true,
      exactCountAvailable: data.exactCountAvailable === true,
    };
  }
  if (key === "opportunities") {
    return {
      total: firstNumeric(data.total, data.counted),
      partial: data.limited === true,
      exactCountAvailable: data.exactCountAvailable === true,
    };
  }
  if (key === "conversations") {
    return {
      waiting: firstNumeric(data.waiting),
      returned: firstNumeric(data.returned),
      total: firstNumeric(data.totalReturnedByGhl, data.returned),
      partial: data.limited === true,
    };
  }

  return {
    total: firstNumeric(data.total),
    returned: firstNumeric(data.returned),
    exactCountAvailable: data.exactCountAvailable === true,
  };
}

async function runModule(key, label, runner) {
  try {
    const result = await runner();
    const data = redact(result?.data || {});
    return {
      key,
      label,
      status: "completed",
      answer: cleanString(result?.answer),
      stats: inferModuleStats(key, data),
      sources: Array.isArray(result?.sources) ? result.sources.map(cleanString).filter(Boolean) : [],
      data,
    };
  } catch (error) {
    return {
      key,
      label,
      status: "failed",
      error: errorSummary(error),
      sources: ["GHL"],
      data: null,
    };
  }
}

async function runSettingsModules() {
  const modules = await Promise.all([
    runModule("location", "Location/account info", getLocationInfo),
    runModule("custom_fields", "Custom fields", listCustomFields),
    runModule("custom_values", "Custom values", listCustomValues),
  ]);
  return modules;
}

async function runAccountAuditModules() {
  const primary = await Promise.all([
    runModule("contacts", "Contacts", countContacts),
    runModule("tags", "Tags", listTags),
    runModule("pipelines", "Pipelines and stages", listPipelines),
    runModule("opportunities", "Opportunities", countOpportunities),
    runModule("workflows", "Workflows", listWorkflows),
    runModule("conversations", "Conversations", countConversationsWaiting),
    runModule("users", "Users/team members", listUsers),
    runModule("calendars", "Calendars", listCalendars),
    runModule("campaigns", "Campaigns", listCampaigns),
  ]);
  const settings = await runSettingsModules();
  return [...primary, ...settings];
}

function compactModuleLine(module) {
  if (module.status !== "completed") {
    return `${module.label} failed (${module.error?.type || "module_failed"})`;
  }

  const stats = module.stats || {};
  if (Number.isFinite(Number(stats.total))) return `${module.label}: ${formatNumber(stats.total)}`;
  if (Number.isFinite(Number(stats.waiting))) return `${module.label}: ${formatNumber(stats.waiting)} waiting`;
  if (Number.isFinite(Number(stats.returned))) return `${module.label}: ${formatNumber(stats.returned)} returned`;
  return `${module.label}: completed`;
}

function buildCombinedReport({ action, label, modules, extra = {} }) {
  const completed = modules.filter((module) => module.status === "completed");
  const failed = modules.filter((module) => module.status !== "completed");
  const warnings = failed.map((module) => ({
    module: module.key,
    label: module.label,
    reason: module.error?.type || "module_failed",
    message: module.error?.message || "The internal module failed.",
  }));

  const answer = [
    `I ran the ${label} internal capability.`,
    completed.length
      ? `Completed ${formatNumber(completed.length)} modules: ${completed.slice(0, 8).map(compactModuleLine).join("; ")}${completed.length > 8 ? "; and more" : ""}.`
      : "No modules completed successfully.",
    failed.length
      ? `Needs attention: ${failed.map((module) => `${module.label} (${module.error?.type || "module_failed"})`).join("; ")}.`
      : "All modules completed without internal errors.",
  ].join(" ");

  return {
    intent: "read",
    answer,
    data: {
      internalCapability: action,
      title: label,
      status: failed.length ? "partial" : "completed",
      modules,
      completedModules: completed.length,
      failedModules: failed.length,
      warnings,
      ...extra,
    },
    sources: [...new Set(modules.flatMap((module) => module.sources || []))],
    requiresApproval: false,
  };
}

function healthAnswer(report) {
  const summary = report?.summary || {};
  const failing = Number(summary.failingCapabilities || 0);
  return [
    "I ran the GHL Health Check internal capability.",
    `Working capabilities: ${formatNumber(summary.workingCapabilities || 0)}.`,
    `Needs attention: ${formatNumber(failing)}.`,
    `Registry coverage: ${formatNumber(summary.registryEnabledEndpoints || 0)} enabled endpoints.`,
    failing
      ? "I included the failing modules and sanitized reasons in the report."
      : "I did not find failing read capabilities in this health check.",
  ].join(" ");
}

async function runHealthCheck(context = {}) {
  try {
    const report = await buildGhlControlCenterReport({ adminUserId: context.adminUserId });
    return {
      intent: "read",
      answer: healthAnswer(report),
      data: {
        internalCapability: "health_check",
        title: "GHL Health Check",
        status: "completed",
        healthCheckEndpoint: "GET /api/admin/jarvis/ghl-control/health",
        controlCenter: report,
        diagnostics: report.diagnostics,
        working: report.capabilities?.working || [],
        failing: report.capabilities?.failing || [],
        capabilities: report.capabilities?.all || [],
        summary: report.summary,
        recommendations: report.recommendations || [],
      },
      sources: ["Jarvis GHL Control Center", "GHL capability audit"],
      requiresApproval: false,
    };
  } catch (error) {
    return buildCombinedReport({
      action: "health_check",
      label: "GHL Health Check",
      modules: [
        {
          key: "ghl_control_center",
          label: "GHL Control Center",
          status: "failed",
          error: errorSummary(error),
          sources: ["Jarvis GHL Control Center"],
          data: null,
        },
      ],
      extra: {
        healthCheckEndpoint: "GET /api/admin/jarvis/ghl-control/health",
      },
    });
  }
}

async function runPipelineReview() {
  const modules = await Promise.all([
    runModule("pipelines", "Pipelines and stages", listPipelines),
    runModule("opportunities", "Opportunities", countOpportunities),
  ]);
  return buildCombinedReport({ action: "pipeline_review", label: "Pipeline Review", modules });
}

async function runSettingsReview() {
  const modules = await runSettingsModules();
  return buildCombinedReport({ action: "settings_review", label: "Settings Review", modules });
}

async function runInternalCapability({ capability: resolved, context = {} } = {}) {
  const capabilityToRun = resolved || resolveInternalCapability(context.userRequest || "");
  if (!capabilityToRun) return null;

  switch (capabilityToRun.action) {
    case "health_check":
      return runHealthCheck(context);
    case "account_audit":
      return buildCombinedReport({
        action: "account_audit",
        label: "GHL Account Audit",
        modules: await runAccountAuditModules(),
      });
    case "pipeline_review":
      return runPipelineReview();
    case "tag_review":
      return buildCombinedReport({
        action: "tag_review",
        label: "Tag Review",
        modules: [await runModule("tags", "Tags", listTags)],
      });
    case "opportunity_review":
      return buildCombinedReport({
        action: "opportunity_review",
        label: "Opportunity Review",
        modules: [
          await runModule("opportunities", "Opportunities", countOpportunities),
          await runModule("pipelines", "Pipelines and stages", listPipelines),
        ],
      });
    case "workflow_review":
      return buildCombinedReport({
        action: "workflow_review",
        label: "Workflow Review",
        modules: [await runModule("workflows", "Workflows", listWorkflows)],
      });
    case "conversation_review":
      return buildCombinedReport({
        action: "conversation_review",
        label: "Conversation Review",
        modules: [await runModule("conversations", "Conversations", countConversationsWaiting)],
      });
    case "settings_review":
      return runSettingsReview();
    case "campaign_builder_review":
      return buildCombinedReport({
        action: "campaign_builder_review",
        label: "Campaign Builder Review",
        modules: [await runModule("campaigns", "Campaigns", listCampaigns)],
        extra: {
          note: "Campaign creation and starts still require approval before anything sends.",
        },
      });
    case "reports":
      return buildCombinedReport({
        action: "reports",
        label: "GHL Reports",
        modules: await Promise.all([
          runModule("contacts", "Contacts", countContacts),
          runModule("pipelines", "Pipelines and stages", listPipelines),
          runModule("opportunities", "Opportunities", countOpportunities),
          runModule("conversations", "Conversations", countConversationsWaiting),
        ]),
      });
    default:
      return null;
  }
}

module.exports = {
  resolveInternalCapability,
  runInternalCapability,
};
