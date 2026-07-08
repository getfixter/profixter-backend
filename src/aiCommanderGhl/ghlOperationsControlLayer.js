const mongoose = require("mongoose");

const { auditGhlCapabilities } = require("./ghlReadCapabilities");
const { executeGhlRequest } = require("./ghlUniversalExecutor");
const { getSafeGhlDiagnostics, redact } = require("./ghlClient");
const GhlUniversalAudit = require("./ghlUniversalAudit.model");
const {
  DESTRUCTIVE_CONFIRMATION_PHRASE,
  ENDPOINTS,
  HIGH_RISK_CONFIRMATION_PHRASE,
  registryByCapability,
  registryStats,
} = require("./ghlEndpointRegistry");

function cleanString(value) {
  return String(value ?? "").trim();
}

function auditConnected() {
  return mongoose.connection?.readyState === 1;
}

function publicEndpoint(endpoint) {
  return {
    key: endpoint.key,
    group: endpoint.group,
    method: endpoint.method,
    path: endpoint.path,
    description: endpoint.description,
    requiredScopes: endpoint.requiredScopes || [],
    riskLevel: endpoint.riskLevel,
    riskCategory: endpoint.riskCategory,
    approvalRequired: endpoint.approvalRequired === true,
    requiresExtraConfirmation: endpoint.requiresExtraConfirmation === true,
    confirmationPhraseRequired: endpoint.confirmationPhrase || "",
    destructive: endpoint.destructive === true,
    enabled: endpoint.enabled !== false,
    deprecated: endpoint.deprecated === true,
    rateLimitProfile: endpoint.rateLimitProfile || "standard",
    auditLogPolicy: endpoint.auditLogPolicy || "full_sanitized",
  };
}

function groupedRegistry() {
  const groups = registryByCapability();
  return Object.entries(groups)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, endpoints]) => ({
      group,
      endpoints: endpoints.map(publicEndpoint),
      totals: {
        total: endpoints.length,
        enabled: endpoints.filter((item) => item.enabled !== false && item.deprecated !== true).length,
        read: endpoints.filter((item) => item.riskCategory === "read").length,
        write: endpoints.filter((item) => item.riskCategory === "write").length,
        highRisk: endpoints.filter((item) => item.riskCategory === "high-risk").length,
        destructive: endpoints.filter((item) => item.riskCategory === "destructive").length,
      },
    }));
}

async function recentUniversalActions(limit = 20) {
  if (!auditConnected()) return [];
  const rows = await GhlUniversalAudit.find({})
    .sort({ createdAt: -1 })
    .limit(Math.max(1, Math.min(50, Number(limit || 20))))
    .lean();

  return rows.map((row) =>
    redact({
      id: String(row._id || ""),
      createdAt: row.createdAt,
      userRequest: row.userRequest,
      reason: row.reason,
      method: row.method,
      path: row.path,
      endpointKey: row.endpointKey,
      locationId: row.locationId,
      riskLevel: row.riskLevel,
      riskCategory: row.riskCategory,
      dryRun: row.dryRun,
      approved: row.approved,
      approvalRequired: row.approvalRequired,
      requiresExtraConfirmation: row.requiresExtraConfirmation,
      status: row.status,
      resultStatus: row.resultStatus,
      error: row.error,
      responseSummary: row.responseSummary,
    })
  );
}

async function dryRunWriteCheck(input) {
  try {
    const result = await executeGhlRequest({
      ...input,
      dryRun: true,
      approved: false,
      reason: `Jarvis GHL Health Check dry-run: ${input.reason}`,
      userRequest: "Jarvis GHL Health Check",
    });
    return {
      key: result.endpointKey,
      method: result.method,
      path: result.path,
      status: "available",
      riskCategory: result.riskCategory,
      requiresApproval: result.requiresApproval,
      requiresExtraConfirmation: result.requiresExtraConfirmation,
      confirmationPhraseRequired: result.confirmationPhraseRequired,
      summary: result.summary,
    };
  } catch (error) {
    return {
      key: "",
      method: cleanString(input.method),
      path: cleanString(input.path),
      status: "unavailable",
      message: cleanString(error?.message || error),
      statusCode: error?.statusCode || null,
      ghlStatus: error?.ghlStatus || null,
    };
  }
}

async function dryRunWriteChecks() {
  return Promise.all([
    dryRunWriteCheck({
      method: "POST",
      path: "/locations/:locationId/tags",
      body: { name: "jarvis-health-check-dry-run" },
      reason: "Create tag",
    }),
    dryRunWriteCheck({
      method: "POST",
      path: "/contacts/",
      body: {
        firstName: "Jarvis",
        lastName: "Dry Run",
        source: "Jarvis Health Check",
      },
      reason: "Create contact",
    }),
    dryRunWriteCheck({
      method: "POST",
      path: "/opportunities/",
      body: {
        title: "Jarvis Dry Run Opportunity",
        status: "open",
      },
      reason: "Create opportunity",
    }),
  ]);
}

function recommendationsFrom({ capabilities, stats, dryRuns }) {
  const recommendations = [];
  const failing = capabilities.failing || [];
  const working = capabilities.working || [];
  const failingKeys = new Set(failing.map((item) => item.key));
  const workingKeys = new Set(working.map((item) => item.key));

  if (workingKeys.has("contacts") && workingKeys.has("conversations")) {
    recommendations.push("Jarvis can safely inspect core CRM and conversation data.");
  }
  if (failingKeys.has("contacts")) {
    recommendations.push("Fix contacts read access first. Contacts are required for most GHL operations.");
  }
  if (failingKeys.has("workflows")) {
    recommendations.push("Workflow APIs are unavailable or out of scope. Keep workflow changes behind manual review until that scope works.");
  }
  if (failingKeys.has("forms") || failingKeys.has("surveys")) {
    recommendations.push("Forms or surveys are unavailable from the current token. Jarvis will report that clearly instead of guessing.");
  }
  if ((stats.highRisk || 0) > 0 || (stats.destructive || 0) > 0) {
    recommendations.push("Keep high-risk and destructive actions behind explicit confirmation phrases.");
  }
  if ((dryRuns || []).some((item) => item.status === "unavailable")) {
    recommendations.push("Some safe dry-run writes could not be validated. Treat those setup actions as unavailable until scopes are confirmed.");
  }
  if (!recommendations.length) {
    recommendations.push("GHL control checks passed. Jarvis can continue using read actions freely and write actions through approved plans.");
  }
  return recommendations;
}

async function buildGhlControlCenterReport({ adminUserId = null } = {}) {
  const generatedAt = new Date().toISOString();
  const diagnostics = getSafeGhlDiagnostics();
  const [capabilities, dryRuns, recentActions] = await Promise.all([
    auditGhlCapabilities(),
    dryRunWriteChecks(),
    recentUniversalActions(20),
  ]);
  const stats = registryStats();
  const groups = groupedRegistry();
  const failedRecentActions = recentActions.filter((item) =>
    ["failed", "rejected"].includes(cleanString(item.status))
  );

  const report = {
    title: "Jarvis GHL Health Check",
    generatedAt,
    adminUserId: adminUserId ? String(adminUserId) : null,
    diagnostics,
    approvalRules: {
      read: "Read actions execute immediately.",
      write: "Write actions require Jarvis approval.",
      highRisk: HIGH_RISK_CONFIRMATION_PHRASE,
      destructive: DESTRUCTIVE_CONFIRMATION_PHRASE,
      campaignStart: "START CAMPAIGN",
    },
    registry: {
      stats,
      groups,
      enabledEndpoints: ENDPOINTS.filter((item) => item.enabled !== false && item.deprecated !== true).map(publicEndpoint),
      disabledOrDeprecatedEndpoints: ENDPOINTS.filter((item) => item.enabled === false || item.deprecated === true).map(publicEndpoint),
    },
    capabilities: {
      working: capabilities.working || [],
      failing: capabilities.failing || [],
      all: capabilities.capabilities || [],
    },
    dryRunWrites: dryRuns,
    recentActions,
    failedActions: failedRecentActions,
  };

  return {
    ...report,
    summary: {
      workingCapabilities: report.capabilities.working.length,
      failingCapabilities: report.capabilities.failing.length,
      registryEnabledEndpoints: stats.enabled,
      writeEndpoints: stats.write,
      highRiskEndpoints: stats.highRisk,
      destructiveEndpoints: stats.destructive,
      recentActions: recentActions.length,
      failedActions: failedRecentActions.length,
    },
    recommendations: recommendationsFrom({ capabilities, stats, dryRuns }),
  };
}

module.exports = {
  buildGhlControlCenterReport,
  publicEndpoint,
};
