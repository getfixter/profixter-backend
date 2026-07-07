const assert = require("assert");

const servicePath = require.resolve("../src/aiCommanderGhl/aiCommanderGhl.service");
const ghlClientPath = require.resolve("../src/aiCommanderGhl/ghlClient");

const ghlRequests = [];
const plannedMessages = [];
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
  assert.ok(result.data.failing.some((item) => item.key === "surveys"));
  assert.ok(result.data.failing.some((item) => item.reason === "endpoint_unavailable"));
  assert.equal(result.data.diagnostics.locationIdUsed, "test-location");
  assert.equal(result.data.diagnostics.baseUrl, "https://services.leadconnectorhq.com");
  assert.doesNotMatch(text, /secret-admin-jwt|secret-api-key|Bearer\s+(?!\[REDACTED\])/i);
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

async function run() {
  await testReadContactCount();
  await testContactCountTimeoutDoesNotThrow();
  await testContactCountPartialResult();
  await testContactUnavailableDoesNotClaimZero();
  await testContactsConnectionDiagnostic();
  await testPotentialCustomersAskForDefinition();
  await testPotentialCustomersUsesConfiguredTag();
  await testCapabilitiesDiagnosticSanitizesFailures();
  await testLeadsByPipelineUsesOpportunityRead();
  await testAdviceRequest();
  await testWriteStillRequiresApproval();
  console.log("Jarvis intent router tests passed");
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
