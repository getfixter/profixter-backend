const assert = require("assert");
const Module = require("module");

process.env.GHL_LOCATION_ID = "test-location";
process.env.GHL_AI_COMMANDER_TOKEN = "pit-test-token";
delete process.env.AI_COMMANDER_GHL_API_VERSION;

let lastFetchCall = null;
const originalLoad = Module._load;
Module._load = function loadWithMockedFetch(request, parent, isMain) {
  if (request === "node-fetch") {
    return async function mockFetch(url, options) {
      lastFetchCall = { url, options };
      return {
        ok: true,
        status: 200,
        headers: { get: () => "" },
        text: async () => JSON.stringify({ ok: true }),
      };
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { buildRequestForAction } = require("../src/aiCommanderGhl/ghlActions");
const { request } = require("../src/aiCommanderGhl/ghlClient");

function testCreateContactPayload() {
  const request = buildRequestForAction({
    actionId: "action_1",
    actionType: "create_contact",
    target: {},
    payload: {
      name: "AI Test Contact",
      phone: "6315991363",
      tags: ["ai-test"],
      customFields: [{ key: "ignored_on_create", value: "not sent" }],
    },
  });

  assert.equal(request.method, "POST");
  assert.equal(request.path, "/contacts/");
  assert.deepEqual(request.body, {
    firstName: "AI",
    lastName: "Test Contact",
    phone: "+16315991363",
    tags: ["ai-test"],
    locationId: "test-location",
  });
}

function testUpsertOpportunityPayload() {
  const request = buildRequestForAction({
    actionId: "action_2",
    actionType: "upsert_opportunity",
    target: {
      contactId: "contact-123",
    },
    payload: {
      pipelineId: "pipeline-123",
      pipelineStageId: "stage-123",
      opportunityName: "Roofing/Siding Lead - AI Test Contact",
      status: "open",
      source: "Roofing Sales Agent v1",
    },
  });

  assert.equal(request.method, "POST");
  assert.equal(request.path, "/opportunities/upsert");
  assert.deepEqual(request.body, {
    pipelineId: "pipeline-123",
    name: "Roofing/Siding Lead - AI Test Contact",
    pipelineStageId: "stage-123",
    status: "open",
    contactId: "contact-123",
    source: "Roofing Sales Agent v1",
    locationId: "test-location",
  });
}

async function testDefaultGhlVersionHeader() {
  const originalInfo = console.info;
  const originalError = console.error;
  console.info = () => {};
  console.error = () => {};

  try {
    await request({ method: "GET", path: "/contacts/mock-contact" });
  } finally {
    console.info = originalInfo;
    console.error = originalError;
  }

  assert.ok(lastFetchCall);
  assert.equal(lastFetchCall.options.headers.Authorization, "Bearer pit-test-token");
  assert.equal(lastFetchCall.options.headers.Version, "v3");
}

async function run() {
  testCreateContactPayload();
  testUpsertOpportunityPayload();
  await testDefaultGhlVersionHeader();
  console.log("AI Commander GHL action payload tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
