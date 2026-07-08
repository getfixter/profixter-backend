const assert = require("assert");
const fs = require("fs-extra");
const path = require("path");

const uploadRoot = path.join(__dirname, "tmp-jarvis-intent-csv");
process.env.JARVIS_UPLOAD_TMP_DIR = uploadRoot;

const servicePath = require.resolve("../src/aiCommanderGhl/aiCommanderGhl.service");
const ghlClientPath = require.resolve("../src/aiCommanderGhl/ghlClient");

const ghlRequests = [];
const plannedMessages = [];
const csvSyncPlans = [];
const campaignTemplatePlans = [];
let contactReadMode = "success";
let tagMode = "plain";

function resetReads() {
  ghlRequests.length = 0;
  contactReadMode = "success";
  tagMode = "plain";
}

function mockError(message, ghlStatus = 404) {
  const error = new Error(message);
  error.statusCode = 502;
  error.ghlStatus = ghlStatus;
  error.response = {
    message,
    Authorization: "Bearer secret-admin-jwt",
    apiKey: "secret-api-key",
  };
  return error;
}

function mockContacts(count, extra = {}) {
  return Array.from({ length: count }, (_, index) => ({
    id: `contact-${index + 1}`,
    name: `Contact ${index + 1}`,
    tags: tagMode === "potential" ? ["Potential Customer"] : ["Roofing"],
    ...extra,
  }));
}

async function writeRouterCsv() {
  await fs.ensureDir(uploadRoot);
  const fileName = "router-sample.csv";
  const absolute = path.join(uploadRoot, fileName);
  await fs.writeFile(
    absolute,
    [
      "Customer Name,Phone,Email,Address,Service,Estimate Amount",
      "John Roofer,6315551111,john@example.com,1 Roof St,Roofing,$1200",
      "Sally Siding,,sally@example.com,2 Side Ave,Siding,$2200",
    ].join("\n")
  );
  return {
    uploadId: "router-upload-1",
    originalName: fileName,
    displayName: fileName,
    mimeType: "text/csv",
    extension: "csv",
    size: (await fs.stat(absolute)).size,
    storage: "local",
    tempRef: `local:${fileName}`,
    storageKey: fileName,
  };
}

require.cache[ghlClientPath] = {
  id: ghlClientPath,
  filename: ghlClientPath,
  loaded: true,
  exports: {
    getLocationId: () => "test-location",
    getSafeTokenDiagnostics: () => ({
      source: "GHL_AI_COMMANDER_TOKEN",
      hasToken: true,
      length: 24,
      hasLegacyGhlApiToken: false,
      legacyLength: 0,
      apiVersion: "v3",
    }),
    getSafeGhlDiagnostics: () => ({
      baseUrl: "https://services.leadconnectorhq.com",
      apiVersion: "v3",
      locationIdUsed: "test-location",
      token: {
        source: "GHL_AI_COMMANDER_TOKEN",
        hasToken: true,
        length: 24,
        hasLegacyGhlApiToken: false,
        legacyLength: 0,
        apiVersion: "v3",
      },
    }),
    request: async (input) => {
      ghlRequests.push(input);
      if (input.method === "POST" && input.path === "/contacts/search") {
        if (contactReadMode === "timeout") {
          const error = new Error("network timeout at: https://services.leadconnectorhq.com/contacts/search");
          error.type = "request-timeout";
          throw error;
        }
        if (contactReadMode === "unavailable") {
          throw mockError("GHL denied contacts read for Bearer secret-admin-jwt", 403);
        }
        assert.equal(input.body.locationId, "test-location");
        assert.equal(input.body.page, 1);
        if (contactReadMode === "partial") {
          return {
            status: 200,
            data: {
              contacts: mockContacts(100),
            },
            request: {
              endpoint: "POST /contacts/search",
            },
            rateLimit: {},
          };
        }
        return {
          status: 200,
          data: {
            contacts: [{ id: "contact-1", name: "John Customer", tags: ["Potential Customer"] }],
            total: 1284,
          },
          request: {
            endpoint: "POST /contacts/search",
          },
          rateLimit: {},
        };
      }
      if (input.method === "GET" && input.path === "/contacts/") {
        if (contactReadMode === "timeout") {
          const error = new Error("network timeout at: https://services.leadconnectorhq.com/contacts/");
          error.type = "request-timeout";
          throw error;
        }
        if (contactReadMode === "unavailable") {
          throw mockError("Legacy contacts endpoint denied Bearer secret-admin-jwt", 403);
        }
        return {
          status: 200,
          data: {
            contacts: [{ id: "contact-1", name: "John Customer" }],
            total: 1284,
          },
          request: {
            endpoint: "GET /contacts/",
          },
          rateLimit: {},
        };
      }
      if (input.method === "GET" && input.path === "/locations/test-location/tags") {
        return {
          status: 200,
          data: {
            tags:
              tagMode === "potential"
                ? [{ id: "tag-1", name: "Potential Customer" }]
                : [{ id: "tag-2", name: "Roofing" }],
          },
          request: { endpoint: "GET /locations/test-location/tags" },
          rateLimit: {},
        };
      }
      if (input.method === "GET" && input.path === "/tags/") {
        return {
          status: 200,
          data: {
            tags:
              tagMode === "potential"
                ? [{ id: "tag-1", name: "Potential Customer" }]
                : [{ id: "tag-2", name: "Roofing" }],
          },
          request: { endpoint: "GET /tags/?locationId=test-location" },
          rateLimit: {},
        };
      }
      if (input.method === "GET" && input.path === "/opportunities/pipelines") {
        return {
          status: 200,
          data: {
            pipelines: [
              {
                id: "pipeline-1",
                name: "Sales Pipeline",
                stages: [{ id: "stage-1", name: "Quoted" }],
              },
            ],
          },
          request: { endpoint: "GET /opportunities/pipelines?locationId=test-location" },
          rateLimit: {},
        };
      }
      if (input.method === "GET" && input.path === "/opportunities/search") {
        return {
          status: 200,
          data: {
            opportunities: [
              {
                id: "opp-1",
                pipelineId: "pipeline-1",
                pipelineStageId: "stage-1",
                contactId: "contact-1",
              },
            ],
            total: 1,
          },
          request: { endpoint: "GET /opportunities/search?location_id=test-location&limit=100&page=1" },
          rateLimit: {},
        };
      }
      if (input.method === "GET" && input.path === "/conversations/search") {
        return {
          status: 200,
          data: { conversations: [{ id: "conversation-1", unreadCount: 1 }], total: 1 },
          request: { endpoint: "GET /conversations/search?locationId=test-location&limit=1" },
          rateLimit: {},
        };
      }
      if (input.method === "GET" && input.path === "/workflows/") {
        return {
          status: 200,
          data: { workflows: [{ id: "workflow-1", name: "New Lead Follow Up" }] },
          request: { endpoint: "GET /workflows/?locationId=test-location" },
          rateLimit: {},
        };
      }
      if (input.method === "GET" && input.path === "/calendars/") {
        return {
          status: 200,
          data: { calendars: [{ id: "calendar-1", name: "Roofing Estimates" }] },
          request: { endpoint: "GET /calendars/?locationId=test-location" },
          rateLimit: {},
        };
      }
      if (input.method === "GET" && input.path === "/calendars/events") {
        return {
          status: 200,
          data: { events: [{ id: "event-1", title: "Estimate" }] },
          request: { endpoint: "GET /calendars/events?locationId=test-location" },
          rateLimit: {},
        };
      }
      if (input.method === "GET" && input.path === "/users/search") {
        return {
          status: 200,
          data: { users: [{ id: "user-1", name: "Taras" }] },
          request: { endpoint: "GET /users/search?locationId=test-location" },
          rateLimit: {},
        };
      }
      if (input.method === "GET" && input.path === "/locations/test-location/customFields") {
        return {
          status: 200,
          data: { customFields: [{ id: "field-1", name: "Roof Type" }] },
          request: { endpoint: "GET /locations/test-location/customFields" },
          rateLimit: {},
        };
      }
      if (input.method === "GET" && input.path === "/locations/test-location/customValues") {
        return {
          status: 200,
          data: { customValues: [{ id: "value-1", name: "Company Name", value: "Fixter" }] },
          request: { endpoint: "GET /locations/test-location/customValues" },
          rateLimit: {},
        };
      }
      if (input.method === "GET" && input.path === "/forms/") {
        return {
          status: 200,
          data: { forms: [{ id: "form-1", name: "Estimate Request" }] },
          request: { endpoint: "GET /forms/?locationId=test-location" },
          rateLimit: {},
        };
      }
      if (input.method === "GET" && input.path === "/locations/test-location") {
        return {
          status: 200,
          data: { location: { id: "test-location", name: "Fixter Test Location" } },
          request: { endpoint: "GET /locations/test-location" },
          rateLimit: {},
        };
      }
      if (
        (input.method === "GET" && input.path === "/surveys/") ||
        (input.method === "GET" && input.path === "/campaigns/")
      ) {
        throw mockError(`Endpoint unavailable for Bearer secret-admin-jwt: ${input.path}`, 404);
      }
      throw new Error(`Unexpected mocked GHL read: ${input.method} ${input.path}`);
    },
    redact: (value) => JSON.parse(
      JSON.stringify(value).replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    ),
  },
};

require.cache[servicePath] = {
  id: servicePath,
  filename: servicePath,
  loaded: true,
  exports: {
    createPlan: async ({ message, adminUserId }) => {
      plannedMessages.push({ message, adminUserId });
      return {
        confirmationId: "test-confirmation",
        summary: "Create one test contact.",
        exactPlan: ["Prepare a contact create action."],
        objectsAffected: [],
        messagesToSendOrCreate: [],
        plannedApiActions: [
          {
            actionType: "create_contact",
            supported: true,
            method: "POST",
            endpoint: "/contacts/",
          },
        ],
        riskLevel: "low",
        destructive: false,
        requiresApproval: true,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      };
    },
    createEstimateCsvSyncPlan: async ({ message, adminUserId, files }) => {
      csvSyncPlans.push({ message, adminUserId, files });
      return {
        confirmationId: "csv-sync-confirmation",
        summary:
          "2 valid CSV contact rows will be checked against GHL. Existing contacts will receive missing roofing/siding tags. Missing contacts will only be reported, not created.",
        exactPlan: ["Parse CSV", "Search GHL", "Tag existing contacts only"],
        objectsAffected: ["2 CSV contact rows", "Existing GHL contacts only"],
        messagesToSendOrCreate: [],
        plannedApiActions: [
          {
            actionId: "sync_estimate_csv_with_ghl",
            actionType: "sync_estimate_csv_with_ghl",
            supported: true,
            method: "INTERNAL",
            endpoint: "jarvis://csv/sync-estimate-csv-with-ghl",
          },
        ],
        riskLevel: "medium",
        destructive: false,
        requiresApproval: true,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      };
    },
    createCampaignTemplatePlan: async ({ message, adminUserId, files }) => {
      campaignTemplatePlans.push({ message, adminUserId, files });
      return {
        confirmationId: "campaign-template-confirmation",
        summary:
          "I will create the reusable campaign template. It will not start and no SMS will be sent until you explicitly start it from Campaigns.",
        exactPlan: ["Create one reusable Jarvis campaign template."],
        objectsAffected: ["Campaign template: Roofing/Siding Re-engagement 2026"],
        messagesToSendOrCreate: [],
        plannedApiActions: [
          {
            actionId: "create_jarvis_campaign_template",
            actionType: "jarvis_campaign_template_create",
            supported: true,
            method: "INTERNAL",
            endpoint: "jarvis://campaigns/templates",
          },
        ],
        riskLevel: "medium",
        destructive: false,
        requiresApproval: true,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      };
    },
  },
};

const { askJarvis } = require("../src/aiCommanderGhl/jarvisIntentRouter");

async function testReadContactCount() {
  resetReads();
  const result = await askJarvis({
    message: "How many contacts do we have in GHL?",
    adminUserId: "admin-1",
  });

  assert.equal(result.intent, "read");
  assert.equal(result.requiresApproval, false);
  assert.equal(result.data.total, 1284);
  assert.match(result.answer, /I checked GHL/i);
  assert.match(result.answer, /1,284/);
  assert.equal(plannedMessages.length, 0);
  assert.equal(ghlRequests.length, 1);
  assert.equal(ghlRequests[0].method, "POST");
  assert.equal(ghlRequests[0].path, "/contacts/search");
  assert.equal(ghlRequests[0].body.locationId, "test-location");
  assert.equal(result.data.endpointUsed, "POST /contacts/search");
  assert.equal(result.data.contactsReadPermission, "contacts_read_working");
}

async function testContactCountTimeoutDoesNotThrow() {
  resetReads();
  contactReadMode = "timeout";
  const beforePlans = plannedMessages.length;
  const result = await askJarvis({
    message: "How many contacts do we have?",
    adminUserId: "admin-1",
  });

  assert.equal(result.intent, "read");
  assert.equal(result.requiresApproval, false);
  assert.equal(result.data.partial, true);
  assert.equal(result.data.reason, "timeout");
  assert.match(result.answer, /GHL took too long/i);
  assert.equal(plannedMessages.length, beforePlans);
  contactReadMode = "success";
}

async function testContactCountPartialResult() {
  resetReads();
  contactReadMode = "partial";
  const result = await askJarvis({
    message: "How many contacts do we have?",
    adminUserId: "admin-1",
  });

  assert.equal(result.intent, "read");
  assert.equal(result.requiresApproval, false);
  assert.equal(result.data.partial, true);
  assert.equal(result.data.scanned, 100);
  assert.equal(result.data.total, null);
  assert.match(result.answer, /scanned the first 100 contacts/i);
  assert.doesNotMatch(result.answer, /\b0 contacts\b/i);
}

async function testContactUnavailableDoesNotClaimZero() {
  resetReads();
  contactReadMode = "unavailable";
  const result = await askJarvis({
    message: "How many contacts do we have?",
    adminUserId: "admin-1",
  });

  assert.equal(result.intent, "read");
  assert.equal(result.requiresApproval, false);
  assert.equal(result.data.total, null);
  assert.equal(result.data.partial, true);
  assert.equal(result.data.contactsReadPermission, "contacts_read_denied");
  assert.doesNotMatch(result.answer, /\b0 contacts\b/i);
  assert.doesNotMatch(JSON.stringify(result), /secret-admin-jwt|secret-api-key|Bearer\s+(?!\[REDACTED\])/i);
}

async function testContactsConnectionDiagnostic() {
  resetReads();
  const result = await askJarvis({
    message: "Check GHL contacts connection",
    adminUserId: "admin-1",
  });

  assert.equal(result.intent, "read");
  assert.equal(result.requiresApproval, false);
  assert.equal(result.data.locationIdUsed, "test-location");
  assert.equal(result.data.endpointUsed, "POST /contacts/search");
  assert.equal(result.data.contactsReadPermission, "contacts_read_working");
  assert.equal(result.data.firstPageContactCount, 1);
  assert.equal(result.data.total, 1284);
  assert.equal(result.data.token.source, "GHL_AI_COMMANDER_TOKEN");
  assert.equal(result.data.token.hasToken, true);
  assert.equal(result.data.token.token, undefined);
}

async function testPotentialCustomersAskForDefinition() {
  resetReads();
  const result = await askJarvis({
    message: "How many potential customers do we have?",
    adminUserId: "admin-1",
  });

  assert.equal(result.intent, "read");
  assert.equal(result.requiresApproval, false);
  assert.equal(result.data.needsDefinition, true);
  assert.match(result.answer, /What should count as a potential customer/i);
}

async function testPotentialCustomersUsesConfiguredTag() {
  resetReads();
  tagMode = "potential";
  const result = await askJarvis({
    message: "How many potential customers do we have?",
    adminUserId: "admin-1",
  });

  assert.equal(result.intent, "read");
  assert.equal(result.requiresApproval, false);
  assert.equal(result.data.inferredDefinition.type, "tag");
  assert.equal(result.data.inferredDefinition.tagName, "Potential Customer");
  assert.match(result.answer, /Potential Customer/);
  assert.doesNotMatch(result.answer, /\b0 contacts\b/i);
}

async function testCapabilitiesDiagnosticSanitizesFailures() {
  resetReads();
  const result = await askJarvis({
    message: "What GHL access do you have?",
    adminUserId: "admin-1",
  });

  const text = JSON.stringify(result);
  assert.equal(result.intent, "read");
  assert.equal(result.requiresApproval, false);
  assert.ok(result.data.working.some((item) => item.key === "contacts"));
  assert.ok(result.data.working.some((item) => item.key === "pipelines"));
  assert.ok(result.data.working.some((item) => item.key === "custom_values"));
  assert.ok(result.data.failing.some((item) => item.key === "surveys"));
  assert.ok(result.data.failing.some((item) => item.reason === "endpoint_unavailable"));
  assert.equal(result.data.diagnostics.locationIdUsed, "test-location");
  assert.equal(result.data.diagnostics.baseUrl, "https://services.leadconnectorhq.com");
  assert.equal(result.data.controlCenter.title, "Jarvis GHL Health Check");
  assert.equal(result.data.controlCenter.approvalRules.highRisk, "CONFIRM GHL HIGH RISK");
  assert.equal(result.data.controlCenter.approvalRules.destructive, "CONFIRM GHL DESTRUCTIVE");
  assert.ok(result.data.controlCenter.registry.summary || result.data.controlCenter.summary);
  assert.doesNotMatch(text, /secret-admin-jwt|secret-api-key|Bearer\s+(?!\[REDACTED\])/i);
}

async function testHealthCheckUsesInternalCapability() {
  resetReads();
  const beforePlans = plannedMessages.length;
  const result = await askJarvis({
    message: "Run a complete GHL Health Check.",
    adminUserId: "admin-1",
  });

  const text = JSON.stringify(result);
  assert.equal(result.intent, "read");
  assert.equal(result.requiresApproval, false);
  assert.equal(result.data.internalCapability, "health_check");
  assert.equal(result.data.healthCheckEndpoint, "GET /api/admin/jarvis/ghl-control/health");
  assert.equal(result.data.controlCenter.title, "Jarvis GHL Health Check");
  assert.ok(result.data.working.some((item) => item.key === "contacts"));
  assert.ok(result.data.failing.some((item) => item.key === "campaigns"));
  assert.equal(plannedMessages.length, beforePlans);
  assert.doesNotMatch(result.answer, /GHL rejected/i);
  assert.doesNotMatch(text, /secret-admin-jwt|secret-api-key|Bearer\s+(?!\[REDACTED\])/i);
}

async function testAccountAuditUsesInternalModules() {
  resetReads();
  const beforePlans = plannedMessages.length;
  const result = await askJarvis({
    message: "Audit my GHL account.",
    adminUserId: "admin-1",
  });

  const moduleKeys = result.data.modules.map((item) => item.key);
  assert.equal(result.intent, "read");
  assert.equal(result.requiresApproval, false);
  assert.equal(result.data.internalCapability, "account_audit");
  assert.ok(moduleKeys.includes("contacts"));
  assert.ok(moduleKeys.includes("tags"));
  assert.ok(moduleKeys.includes("pipelines"));
  assert.ok(moduleKeys.includes("opportunities"));
  assert.ok(moduleKeys.includes("workflows"));
  assert.ok(moduleKeys.includes("conversations"));
  assert.ok(moduleKeys.includes("users"));
  assert.ok(moduleKeys.includes("calendars"));
  assert.ok(moduleKeys.includes("campaigns"));
  assert.ok(moduleKeys.includes("location"));
  assert.ok(moduleKeys.includes("custom_fields"));
  assert.ok(moduleKeys.includes("custom_values"));
  assert.ok(result.data.modules.find((item) => item.key === "campaigns").status === "failed");
  assert.ok(result.data.warnings.some((item) => item.module === "campaigns"));
  assert.equal(plannedMessages.length, beforePlans);
  assert.ok(ghlRequests.some((request) => request.path === "/contacts/search"));
  assert.ok(ghlRequests.some((request) => request.path === "/opportunities/pipelines"));
  assert.doesNotMatch(result.answer, /GHL rejected/i);
}

async function testSetupReviewUsesInternalModules() {
  resetReads();
  const beforePlans = plannedMessages.length;
  const result = await askJarvis({
    message: "Review my GHL setup.",
    adminUserId: "admin-1",
  });

  assert.equal(result.intent, "read");
  assert.equal(result.requiresApproval, false);
  assert.equal(result.data.internalCapability, "settings_review");
  assert.ok(result.data.modules.some((item) => item.key === "location"));
  assert.ok(result.data.modules.some((item) => item.key === "custom_fields"));
  assert.ok(result.data.modules.some((item) => item.key === "custom_values"));
  assert.equal(plannedMessages.length, beforePlans);
}

async function testSpecificReviewDoesNotBecomeAccountAudit() {
  resetReads();
  const beforePlans = plannedMessages.length;
  const result = await askJarvis({
    message: "Review my GHL pipelines.",
    adminUserId: "admin-1",
  });

  const moduleKeys = result.data.modules.map((item) => item.key);
  assert.equal(result.intent, "read");
  assert.equal(result.requiresApproval, false);
  assert.equal(result.data.internalCapability, "pipeline_review");
  assert.deepEqual(moduleKeys.sort(), ["opportunities", "pipelines"].sort());
  assert.equal(plannedMessages.length, beforePlans);
}

async function testCsvCountUsesUploadedFileNotGhl() {
  resetReads();
  const file = await writeRouterCsv();
  const result = await askJarvis({
    message: "How many contacts are in this file?",
    adminUserId: "admin-1",
    files: [file],
    uploadBatchId: "batch-1",
  });

  assert.equal(result.intent, "read");
  assert.equal(result.requiresApproval, false);
  assert.equal(result.data.totalRows, 2);
  assert.equal(result.data.validContacts, 2);
  assert.deepEqual(result.data.sampleHeaders.slice(0, 2), ["Customer Name", "Phone"]);
  assert.equal(ghlRequests.length, 0);
  assert.match(result.answer, /2 valid contact rows/i);
}

async function testCsvAuditComposesGhlSearchWorkflow() {
  resetReads();
  const beforePlans = plannedMessages.length;
  const file = await writeRouterCsv();
  const result = await askJarvis({
    message: "Audit this CSV against GHL.",
    adminUserId: "admin-1",
    files: [file],
    uploadBatchId: "batch-1",
  });

  assert.equal(result.intent, "read");
  assert.equal(result.requiresApproval, false);
  assert.match(result.answer, /audited the CSV against GHL/i);
  assert.match(result.answer, /Nothing was changed/i);
  assert.equal(result.data.workflow.name, "csv_ghl_audit");
  assert.ok(result.data.workflow.progress.some((event) => event.message === "Reading CSV..."));
  assert.ok(ghlRequests.some((request) => request.path === "/contacts/search"));
  assert.ok(!ghlRequests.some((request) => /\/tags$/.test(request.path)));
  assert.equal(plannedMessages.length, beforePlans);
}

async function testCsvSyncCreatesApprovalPlan() {
  resetReads();
  const beforePlans = plannedMessages.length;
  const beforeCsvPlans = csvSyncPlans.length;
  const file = await writeRouterCsv();
  const result = await askJarvis({
    message: "Find these contacts in GHL and tag roofing/siding leads.",
    adminUserId: "admin-1",
    files: [file],
    uploadBatchId: "batch-1",
  });

  assert.equal(result.intent, "write");
  assert.equal(result.requiresApproval, true);
  assert.equal(result.plan.confirmationId, "csv-sync-confirmation");
  assert.equal(csvSyncPlans.length, beforeCsvPlans + 1);
  assert.equal(csvSyncPlans.at(-1).files.length, 1);
  assert.equal(plannedMessages.length, beforePlans);
}

async function testLeadsByPipelineUsesOpportunityRead() {
  resetReads();
  const result = await askJarvis({
    message: "How many leads are in each pipeline stage?",
    adminUserId: "admin-1",
  });

  assert.equal(result.intent, "read");
  assert.equal(result.requiresApproval, false);
  assert.equal(result.data.total, 1);
  assert.equal(result.data.byStage.Quoted, 1);
  assert.ok(ghlRequests.some((request) => request.path === "/opportunities/search"));
}

async function testAdviceRequest() {
  resetReads();
  const beforeReads = ghlRequests.length;
  const result = await askJarvis({
    message: "What campaign should I run today?",
    adminUserId: "admin-1",
  });

  assert.equal(result.intent, "advice");
  assert.equal(result.requiresApproval, false);
  assert.ok(result.answer);
  assert.equal(ghlRequests.length, beforeReads);
  assert.equal(plannedMessages.length, 0);
}

async function testGeneralOutsideWorkspaceRequest() {
  resetReads();
  const beforeReads = ghlRequests.length;
  const beforePlans = plannedMessages.length;
  const result = await askJarvis({
    message: "Write marketing copy for my website homepage.",
    adminUserId: "admin-1",
  });

  assert.equal(result.intent, "advice");
  assert.equal(result.requiresApproval, false);
  assert.equal(result.answer, "This is outside my GHL workspace. Ask ChatGPT.");
  assert.equal(ghlRequests.length, beforeReads);
  assert.equal(plannedMessages.length, beforePlans);
}

async function testWriteStillRequiresApproval() {
  resetReads();
  const result = await askJarvis({
    message: "Create a test contact named AI Test Contact, phone 6315991363, tag ai-test.",
    adminUserId: "admin-1",
  });

  assert.equal(result.intent, "write");
  assert.equal(result.requiresApproval, true);
  assert.equal(result.plan.requiresApproval, true);
  assert.equal(result.plan.confirmationId, "test-confirmation");
  assert.equal(plannedMessages.length, 1);
  assert.match(plannedMessages[0].message, /Create a test contact/);
}

async function testCampaignTemplateRequestRequiresApproval() {
  resetReads();
  const beforePlans = campaignTemplatePlans.length;
  const result = await askJarvis({
    message: "Create a sales campaign for Roofing/Siding Re-engagement 2026.",
    adminUserId: "admin-1",
  });

  assert.equal(result.intent, "write");
  assert.equal(result.requiresApproval, true);
  assert.equal(result.plan.requiresApproval, true);
  assert.equal(result.plan.confirmationId, "campaign-template-confirmation");
  assert.equal(result.plan.plannedApiActions[0].actionType, "jarvis_campaign_template_create");
  assert.match(result.plan.summary, /no SMS will be sent/i);
  assert.equal(campaignTemplatePlans.length, beforePlans + 1);
}

async function run() {
  try {
    await testReadContactCount();
    await testContactCountTimeoutDoesNotThrow();
    await testContactCountPartialResult();
    await testContactUnavailableDoesNotClaimZero();
    await testContactsConnectionDiagnostic();
    await testPotentialCustomersAskForDefinition();
    await testPotentialCustomersUsesConfiguredTag();
    await testCapabilitiesDiagnosticSanitizesFailures();
    await testHealthCheckUsesInternalCapability();
    await testAccountAuditUsesInternalModules();
    await testSetupReviewUsesInternalModules();
    await testSpecificReviewDoesNotBecomeAccountAudit();
    await testCsvCountUsesUploadedFileNotGhl();
    await testCsvAuditComposesGhlSearchWorkflow();
    await testCsvSyncCreatesApprovalPlan();
    await testLeadsByPipelineUsesOpportunityRead();
    await testAdviceRequest();
    await testGeneralOutsideWorkspaceRequest();
    await testWriteStillRequiresApproval();
    await testCampaignTemplateRequestRequiresApproval();
    console.log("Jarvis intent router tests passed");
  } finally {
    await fs.remove(uploadRoot);
  }
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
