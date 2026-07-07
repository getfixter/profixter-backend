const assert = require("assert");

const servicePath = require.resolve("../src/aiCommanderGhl/aiCommanderGhl.service");
const ghlClientPath = require.resolve("../src/aiCommanderGhl/ghlClient");

const ghlRequests = [];
const plannedMessages = [];

require.cache[ghlClientPath] = {
  id: ghlClientPath,
  filename: ghlClientPath,
  loaded: true,
  exports: {
    getLocationId: () => "test-location",
    request: async (input) => {
      ghlRequests.push(input);
      if (input.method === "GET" && input.path === "/contacts/") {
        return {
          status: 200,
          data: {
            contacts: [{ id: "contact-1", name: "John Customer" }],
            total: 1284,
          },
          rateLimit: {},
        };
      }
      throw new Error(`Unexpected mocked GHL read: ${input.method} ${input.path}`);
    },
    redact: (value) => value,
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
  assert.equal(ghlRequests[0].method, "GET");
  assert.equal(ghlRequests[0].path, "/contacts/");
}

async function testAdviceRequest() {
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
  await testAdviceRequest();
  await testWriteStillRequiresApproval();
  console.log("Jarvis intent router tests passed");
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
