const assert = require("assert");
const { BSON } = require("bson");

process.env.GHL_LOCATION_ID = "test-location";
process.env.GHL_COMPANY_ID = "company-test";
process.env.JARVIS_CONTACT_OWNER_ASSIGNMENT_CONCURRENCY = "1";

const {
  executeContactOwnerAssignment,
  fetchContactsByTag,
  looksLikeContactOwnerAssignmentRequest,
  parseContactOwnerAssignmentRequest,
  prepareContactOwnerAssignment,
  resolveOwner,
} = require("../src/aiCommanderGhl/jarvisContactOwnerAssignment");

const requests = [];
let searchMode = "withTotal";
let userSearchMode = "success";
let updateMode = "success";

function makeContact(index, extra = {}) {
  return {
    id: `contact-${index}`,
    name: `Website Contact ${index}`,
    email: `contact${index}@example.com`,
    phone: `63155500${index}`,
    tags: ["website_registered"],
    ...extra,
  };
}

async function apiCall(input) {
  requests.push(input);

  if (input.method === "GET" && input.path === "/users/search") {
    assert.equal(input.query.companyId, "company-test");
    assert.equal(input.query.locationId, undefined);
    if (userSearchMode === "authUnsupported") {
      const error = new Error("GHL API request failed with 401");
      error.statusCode = 502;
      error.ghlStatus = 401;
      error.response = {
        message: "E-102. This AuthClass is not yet supported!",
        error: "Unauthorized",
        statusCode: 401,
      };
      throw error;
    }
    return {
      response: {
        users: [
          { id: "user-taras", name: "Taras Bandura", email: "taras@example.com" },
          { id: "user-sergey", name: "Sergey Fixter", email: "sergey@example.com" },
        ],
      },
      request: { endpoint: "GET /users/search?companyId=company-test&limit=100" },
    };
  }

  if (input.method === "GET" && input.path === "/users/") {
    assert.equal(input.query.locationId, "test-location");
    return {
      response: {
        users: [
          { id: "user-taras", name: "Taras Bandura", email: "taras@example.com" },
          { id: "user-sergey", name: "Sergey Fixter", email: "sergey@example.com" },
        ],
      },
      request: { endpoint: "GET /users/?locationId=test-location" },
    };
  }

  if (input.method === "GET" && input.path === "/locations/test-location/tags") {
    return {
      response: {
        tags: [{ id: "tag-1", name: "website_registered" }],
      },
      request: { endpoint: "GET /locations/test-location/tags" },
    };
  }

  if (input.method === "POST" && input.path === "/contacts/search") {
    assert.equal(input.body.locationId, "test-location");
    assert.deepEqual(input.body.filters, [
      { field: "tags", operator: "eq", value: "website_registered" },
    ]);
    if (searchMode === "withoutTotal") {
      const page = Number(input.body.page || 1);
      return {
        response: {
          contacts:
            page === 1
              ? Array.from({ length: 100 }, (_, index) => makeContact(index + 1))
              : [makeContact(101)],
        },
        request: { endpoint: "POST /contacts/search" },
      };
    }
    return {
      response: {
        contacts: [
          makeContact(1),
          makeContact(2, { assignedTo: "user-taras" }),
          makeContact(3),
        ],
        total: 3,
      },
      request: { endpoint: "POST /contacts/search" },
    };
  }

  if (input.method === "PUT" && input.dryRun === true) {
    assert.equal(input.path, "/contacts/contact-1");
    assert.deepEqual(input.body, { assignedTo: "user-taras" });
    return {
      dryRun: true,
      method: "PUT",
      path: input.path,
      body: input.body,
      summary: "Jarvis would call PUT /contacts/contact-1 for Update one contact.",
    };
  }

  if (input.method === "PUT" && /^\/contacts\/contact-\d+$/.test(input.path)) {
    assert.deepEqual(input.body, { assignedTo: "user-taras" });
    if (updateMode === "failFirst" && input.path === "/contacts/contact-1") {
      const error = new Error("GHL API request failed with 422");
      error.statusCode = 502;
      error.ghlStatus = 422;
      error.request = {
        method: "PUT",
        endpoint: `PUT ${input.path}`,
        path: input.path,
        body: input.body,
      };
      error.response = {
        message: ["assignedTo must be a valid user ID"],
        error: "Unprocessable Entity",
        statusCode: 422,
      };
      throw error;
    }
    return {
      status: 200,
      response: { contact: { id: input.path.split("/").pop(), assignedTo: "user-taras" } },
      request: { endpoint: `PUT ${input.path}` },
    };
  }

  throw new Error(`Unexpected test request: ${input.method} ${input.path}`);
}

async function testParse() {
  const message =
    'Assign the owner "Taras Bandura" to every contact that currently has the tag "website_registered".';
  assert.equal(looksLikeContactOwnerAssignmentRequest(message), true);
  assert.deepEqual(parseContactOwnerAssignmentRequest(message), {
    ownerName: "Taras Bandura",
    audienceType: "tag",
    tagName: "website_registered",
    smartListName: "",
  });

  const shorthand = parseContactOwnerAssignmentRequest(
    "Assign all roofing contacts to Sergey."
  );
  assert.equal(shorthand.ownerName, "Sergey");
  assert.equal(shorthand.tagName, "roofing");
}

async function testPrepareAndExecute() {
  requests.length = 0;
  searchMode = "withTotal";
  const prepared = await prepareContactOwnerAssignment({
    message:
      'Assign the owner "Taras Bandura" to every contact that currently has the tag "website_registered".',
    adminUserId: "admin-1",
    apiCall,
  });

  assert.equal(prepared.capability, "contact_owner_assignment");
  assert.equal(prepared.owner.id, "user-taras");
  assert.equal(prepared.owner.name, "Taras Bandura");
  assert.equal(prepared.audience.tagName, "website_registered");
  assert.equal(prepared.contactCount, 3);
  assert.equal(prepared.preview.length, 3);
  assert.equal(prepared.preview[0].name, "Website Contact 1");
  assert.equal(prepared.ownerUpdateDryRun.dryRun, true);
  assert.equal(prepared.nothingChanged, true);
  const userLookup = requests.find((request) => request.path === "/users/search");
  assert.ok(userLookup);
  assert.equal(userLookup.query.companyId, "company-test");
  assert.equal(userLookup.query.locationId, undefined);
  assert.ok(!requests.some((request) => request.path === "/locations/test-location/users"));
  assert.ok(requests.some((request) => request.path === "/contacts/search"));
  assert.ok(requests.some((request) => request.method === "PUT" && request.dryRun === true));

  requests.length = 0;
  const progress = [];
  const report = await executeContactOwnerAssignment({
    ownerId: prepared.owner.id,
    ownerName: prepared.owner.name,
    tagName: prepared.audience.tagName,
    contacts: prepared.contacts,
    approved: true,
    adminUserId: "admin-1",
    userRequest: "Assign owner",
    apiCall,
    onContactComplete: async (state) => {
      progress.push(state);
    },
  });

  assert.equal(report.summary.title, "Contact Owner Assignment Completed");
  assert.equal(report.stats.contactsFound, 3);
  assert.equal(report.stats.updated, 2);
  assert.equal(report.stats.alreadyAssigned, 1);
  assert.equal(report.stats.failed, 0);
  assert.equal(report.stats.processed, 3);
  assert.equal(report.stats.successRate, "100.0%");
  assert.match(report.summary.aiSummary, /2 contacts were assigned to Taras Bandura/i);
  assert.equal(requests.filter((request) => request.method === "PUT").length, 2);
  assert.equal(progress.at(-1).processedItems, 3);
  assert.equal(progress.at(-1).percent, 100);
}

async function testProgressReportDoesNotRecursivelyGrow() {
  requests.length = 0;
  updateMode = "success";
  const contacts = Array.from({ length: 25 }, (_, index) => makeContact(index + 1));
  const sizes = [];

  const report = await executeContactOwnerAssignment({
    ownerId: "user-taras",
    ownerName: "Taras Bandura",
    tagName: "website_registered",
    contacts,
    approved: true,
    adminUserId: "admin-1",
    userRequest: "Assign owner",
    apiCall,
    onContactComplete: async (state) => {
      const document = { report: state.report };
      sizes.push(Buffer.byteLength(JSON.stringify(document), "utf8"));
      const serialized = BSON.serialize(document);
      assert.ok(serialized.length > 0);
      assert.equal(BSON.deserialize(serialized).report.stats.processed, state.processedItems);
    },
  });

  const actualPuts = requests.filter((request) => request.method === "PUT" && request.dryRun !== true);
  assert.ok(actualPuts.length > 0);
  assert.equal(actualPuts[0].path, "/contacts/contact-1");
  assert.deepEqual(actualPuts[0].body, { assignedTo: "user-taras" });
  assert.equal(report.stats.updated, 25);
  assert.equal(report.stats.failed, 0);
  assert.ok(Math.max(...sizes) < 1_000_000);

  const auditDownload = report.downloads.find(
    (download) => download.filename === "Contact Owner Assignment Audit Report.json"
  );
  assert.ok(auditDownload);
  const auditPayload = JSON.parse(auditDownload.content);
  assert.equal(auditPayload.downloads[0].content, undefined);
  assert.equal(typeof auditPayload.downloads[0].contentBytes, "number");
}

async function testContactSearchPaginatesWithoutTotal() {
  requests.length = 0;
  searchMode = "withoutTotal";
  const result = await fetchContactsByTag({
    tagName: "website_registered",
    apiCall,
  });

  assert.equal(result.contacts.length, 101);
  assert.equal(result.total, 101);
  assert.equal(requests.filter((request) => request.path === "/contacts/search").length, 2);
  searchMode = "withTotal";
}

async function testOwnerResolvesByEmail() {
  requests.length = 0;
  const owner = await resolveOwner({
    ownerName: "taras@example.com",
    apiCall,
  });

  assert.equal(owner.id, "user-taras");
  assert.equal(owner.email, "taras@example.com");
  const userLookup = requests.find((request) => request.path === "/users/search");
  assert.ok(userLookup);
  assert.equal(userLookup.query.companyId, "company-test");
  assert.ok(!requests.some((request) => request.path === "/locations/test-location/users"));
}

async function testOwnerLookupFallsBackWhenUserSearchAuthUnsupported() {
  requests.length = 0;
  userSearchMode = "authUnsupported";
  const owner = await resolveOwner({
    ownerName: "Taras Bandura",
    apiCall,
  });

  assert.equal(owner.id, "user-taras");
  assert.ok(requests.some((request) => request.path === "/users/search"));
  assert.ok(requests.some((request) => request.path === "/users/"));
  assert.ok(!requests.some((request) => request.path === "/locations/test-location/users"));
  userSearchMode = "success";
}

async function testFailedOwnerUpdateReturnsDetailedReport() {
  requests.length = 0;
  searchMode = "withTotal";
  updateMode = "failFirst";
  const prepared = await prepareContactOwnerAssignment({
    message:
      'Assign the owner "Taras Bandura" to every contact that currently has the tag "website_registered".',
    adminUserId: "admin-1",
    apiCall,
  });

  requests.length = 0;
  const report = await executeContactOwnerAssignment({
    ownerId: prepared.owner.id,
    ownerName: prepared.owner.name,
    tagName: prepared.audience.tagName,
    contacts: prepared.contacts,
    approved: true,
    adminUserId: "admin-1",
    userRequest: "Assign owner",
    ownerLookupResult: prepared.owner,
    tagSearchCount: prepared.contactCount,
    dryRunResult: prepared.ownerUpdateDryRun,
    apiCall,
  });

  assert.equal(report.summary.status, "completed_with_errors");
  assert.equal(report.stats.failed, 1);
  assert.equal(report.stats.updated, 1);
  assert.equal(report.failureReport.actionName, "Contact Owner Assignment");
  assert.equal(report.failureReport.stepFailed, "Updating contact owner");
  assert.equal(report.failureReport.endpointCalled, "PUT /contacts/contact-1");
  assert.equal(report.failureReport.httpStatus, 422);
  assert.match(report.failureReport.ghlErrorMessage, /assignedTo must be a valid user ID/i);
  assert.equal(report.failureReport.firstAffectedContact.id, "contact-1");
  assert.equal(report.failureReport.anythingChangedBeforeFailure, true);
  assert.equal(report.failureReport.recordsProcessedBeforeFailure, 3);
  assert.equal(report.failureReport.recordsSucceeded, 2);
  assert.equal(report.failureReport.recordsFailed, 1);
  assert.equal(report.failureReport.canResumeSafely, true);
  assert.match(report.summary.aiSummary, /can be retried safely|resume safely/i);
  assert.deepEqual(report.developerDetails.firstActualUpdate.payload, { assignedTo: "user-taras" });
  assert.equal(report.developerDetails.ownerLookupResult.id, "user-taras");
  assert.equal(report.developerDetails.tagSearchCount, 3);
  assert.equal(report.developerDetails.dryRunResult.dryRun, true);
  assert.doesNotMatch(JSON.stringify(report), /Bearer\s+(?!\\[REDACTED\\])/i);
  updateMode = "success";
}

async function run() {
  await testParse();
  await testPrepareAndExecute();
  await testProgressReportDoesNotRecursivelyGrow();
  await testContactSearchPaginatesWithoutTotal();
  await testOwnerResolvesByEmail();
  await testOwnerLookupFallsBackWhenUserSearchAuthUnsupported();
  await testFailedOwnerUpdateReturnsDetailedReport();
  console.log("Jarvis contact owner assignment tests passed");
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
