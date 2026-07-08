const assert = require("assert");
const Module = require("module");

process.env.GHL_LOCATION_ID = "test-location";
process.env.GHL_AI_COMMANDER_TOKEN = "pit-test-token";
process.env.JARVIS_GHL_UNIVERSAL_RETRIES = "1";
process.env.JARVIS_GHL_UNIVERSAL_TIMEOUT_MS = "2000";
process.env.JARVIS_GHL_RETRY_BASE_MS = "0";
process.env.JARVIS_GHL_RETRY_MAX_MS = "10";

const fetchCalls = [];
const fetchQueue = [];
const originalLoad = Module._load;

function mockResponse(status, data, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => headers[String(name || "").toLowerCase()] || "",
    },
    text: async () => JSON.stringify(data || {}),
  };
}

Module._load = function loadWithMockedFetch(request, parent, isMain) {
  if (request === "node-fetch") {
    return async function mockFetch(url, options) {
      fetchCalls.push({ url, options });
      const next = fetchQueue.shift();
      if (next instanceof Error) throw next;
      return next || mockResponse(200, { ok: true });
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const {
  DESTRUCTIVE_CONFIRMATION_PHRASE,
} = require("../src/aiCommanderGhl/ghlEndpointRegistry");
const { executeGhlRequest } = require("../src/aiCommanderGhl/ghlUniversalExecutor");

function reset() {
  fetchCalls.length = 0;
  fetchQueue.length = 0;
}

async function quiet(fn) {
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.info = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.info = originalInfo;
    console.warn = originalWarn;
    console.error = originalError;
  }
}

async function testReadSearchPostWithoutApproval() {
  reset();
  fetchQueue.push(mockResponse(200, { contacts: [{ id: "contact-1" }], total: 1 }));
  const result = await executeGhlRequest({
    method: "POST",
    path: "/contacts/search",
    body: {
      page: 1,
      pageLimit: 1,
      apiKey: "secret-key",
    },
    reason: "Count contacts",
    userRequest: "How many contacts do I have?",
  });

  assert.equal(fetchCalls.length, 1);
  assert.equal(result.requiresApproval, false);
  assert.equal(result.endpointKey, "contacts.search");
  assert.equal(result.body.apiKey, "[REDACTED]");
  assert.equal(result.request.headers.Authorization, "[REDACTED]");
  assert.equal(JSON.parse(fetchCalls[0].options.body).locationId, "test-location");
}

async function testGetInjectsLocationQuery() {
  reset();
  fetchQueue.push(mockResponse(200, { tags: [] }));
  const result = await executeGhlRequest({
    method: "GET",
    path: "/tags/",
    reason: "List tags",
  });

  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0].url, /locationId=test-location/);
  assert.equal(result.requiresApproval, false);
}

async function testWriteRequiresApproval() {
  reset();
  await assert.rejects(
    () =>
      executeGhlRequest({
        method: "POST",
        path: "/contacts/",
        body: { firstName: "AI", phone: "6315551111" },
        reason: "Create contact",
      }),
    /require Jarvis approval/
  );
  assert.equal(fetchCalls.length, 0);
}

async function testDryRunWriteDoesNotCallGhl() {
  reset();
  const result = await executeGhlRequest({
    method: "POST",
    path: "/contacts/",
    body: { firstName: "AI", phone: "6315551111" },
    reason: "Preview create contact",
    dryRun: true,
  });

  assert.equal(fetchCalls.length, 0);
  assert.equal(result.dryRun, true);
  assert.equal(result.requiresApproval, true);
  assert.equal(result.path, "/contacts/");
}

async function testDeprecatedEndpointRejected() {
  reset();
  await assert.rejects(
    () =>
      executeGhlRequest({
        method: "GET",
        path: "/contacts/",
        reason: "Use deprecated list contacts",
      }),
    /disabled or deprecated/
  );
  assert.equal(fetchCalls.length, 0);
}

async function testDeleteRequiresConfirmationPhrase() {
  reset();
  await assert.rejects(
    () =>
      executeGhlRequest({
        method: "DELETE",
        path: "/contacts/contact-1",
        approved: true,
        reason: "Delete contact",
      }),
    /requires the exact confirmation phrase/
  );
  assert.equal(fetchCalls.length, 0);
}

async function testDeleteWithPhraseExecutes() {
  reset();
  fetchQueue.push(mockResponse(200, { deleted: true }));
  const result = await executeGhlRequest({
    method: "DELETE",
    path: "/contacts/contact-1",
    approved: true,
    confirmationPhrase: DESTRUCTIVE_CONFIRMATION_PHRASE,
    reason: "Delete contact",
  });

  assert.equal(fetchCalls.length, 1);
  assert.equal(result.requiresExtraConfirmation, true);
  assert.equal(result.status, 200);
}

async function testLocationMismatchRejected() {
  reset();
  await assert.rejects(
    () =>
      executeGhlRequest({
        method: "GET",
        path: "/locations/wrong-location",
        reason: "Read location",
      }),
    /does not match/
  );
  assert.equal(fetchCalls.length, 0);
}

async function testRetriesRateLimitedRequest() {
  reset();
  fetchQueue.push(mockResponse(429, { message: "Too many requests" }, { "retry-after": "0" }));
  fetchQueue.push(mockResponse(200, { tags: [{ id: "tag-1", name: "Roofing" }] }));

  const result = await executeGhlRequest({
    method: "GET",
    path: "/tags/",
    reason: "List tags with retry",
  });

  assert.equal(fetchCalls.length, 2);
  assert.equal(result.status, 200);
  assert.equal(result.rateLimit.retryAfter, "");
  assert.equal(result.attempts, 2);
}

async function run() {
  await quiet(async () => {
    await testReadSearchPostWithoutApproval();
    await testGetInjectsLocationQuery();
    await testWriteRequiresApproval();
    await testDryRunWriteDoesNotCallGhl();
    await testDeprecatedEndpointRejected();
    await testDeleteRequiresConfirmationPhrase();
    await testDeleteWithPhraseExecutes();
    await testLocationMismatchRejected();
    await testRetriesRateLimitedRequest();
  });
  console.log("GHL universal executor tests passed");
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
