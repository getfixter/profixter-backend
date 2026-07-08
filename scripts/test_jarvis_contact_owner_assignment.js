const assert = require("assert");

process.env.GHL_LOCATION_ID = "test-location";

const {
  executeContactOwnerAssignment,
  fetchContactsByTag,
  looksLikeContactOwnerAssignmentRequest,
  parseContactOwnerAssignmentRequest,
  prepareContactOwnerAssignment,
} = require("../src/aiCommanderGhl/jarvisContactOwnerAssignment");

const requests = [];
let searchMode = "withTotal";

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
    return {
      response: {
        users: [
          { id: "user-taras", name: "Taras Bandura", email: "taras@example.com" },
          { id: "user-sergey", name: "Sergey Fixter", email: "sergey@example.com" },
        ],
      },
      request: { endpoint: "GET /users/search?locationId=test-location" },
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

  if (input.method === "PUT" && /^\/contacts\/contact-[13]$/.test(input.path)) {
    assert.deepEqual(input.body, { assignedTo: "user-taras" });
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
  assert.equal(prepared.nothingChanged, true);
  assert.ok(requests.some((request) => request.path === "/users/search"));
  assert.ok(requests.some((request) => request.path === "/contacts/search"));

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

async function run() {
  await testParse();
  await testPrepareAndExecute();
  await testContactSearchPaginatesWithoutTotal();
  console.log("Jarvis contact owner assignment tests passed");
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
