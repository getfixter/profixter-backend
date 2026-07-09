const assert = require("assert");

process.env.GHL_LOCATION_ID = "test-location";
process.env.GHL_COMPANY_ID = "company-test";
process.env.JARVIS_GENERIC_GHL_WORKFLOW_CONCURRENCY = "1";

const {
  buildGenericGhlPlan,
  executeGenericGhlReadPlan,
  looksLikeGenericGhlPlannerRequest,
  parseGenericRequest,
} = require("../src/aiCommanderGhl/jarvisGenericGhlPlanner");
const { executeGenericGhlWorkflow } = require("../src/aiCommanderGhl/jarvisGenericGhlWorkflow");

const requests = [];

function makeContact(index, extra = {}) {
  return {
    id: `contact-${index}`,
    name: `Contact ${index}`,
    email: `contact${index}@example.com`,
    phone: `63155500${index}`,
    tags: ["website_registered"],
    ...extra,
  };
}

function makeOpportunity(index, extra = {}) {
  return {
    id: `opp-${index}`,
    name: `Opportunity ${index}`,
    contactId: `contact-${index}`,
    pipelineId: "pipeline-cold",
    pipelineStageId: "stage-old",
    status: "open",
    updatedAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString(),
    ...extra,
  };
}

async function apiCall(input) {
  requests.push(input);

  if (input.method === "GET" && input.path === "/locations/test-location") {
    return {
      response: { location: { id: "test-location", companyId: "company-test" } },
      request: { endpoint: "GET /locations/test-location" },
    };
  }

  if (input.method === "GET" && input.path === "/users/search") {
    assert.equal(input.query.companyId, "company-test");
    return {
      response: {
        users: [
          { id: "user-taras", name: "Taras Bandura", email: "taras@example.com" },
          { id: "user-other", name: "Other User", email: "other@example.com" },
        ],
      },
      request: { endpoint: "GET /users/search?companyId=company-test&limit=100" },
    };
  }

  if (input.method === "GET" && input.path === "/locations/test-location/tags") {
    return {
      response: {
        tags: [
          { id: "tag-website", name: "website_registered" },
          { id: "tag-premium", name: "premium" },
          { id: "tag-callback", name: "callback_needed" },
        ],
      },
      request: { endpoint: "GET /locations/test-location/tags" },
    };
  }

  if (input.method === "POST" && input.path === "/contacts/search") {
    assert.equal(input.body.locationId, "test-location");
    const filter = input.body.filters?.[0];
    let contacts = [
      makeContact(1),
      makeContact(2, { assignedTo: "user-taras" }),
      makeContact(3, { tags: ["premium"] }),
    ];
    if (filter?.value === "website_registered") {
      contacts = contacts.filter((contact) => contact.tags.includes("website_registered"));
    }
    return {
      response: {
        contacts,
        total: contacts.length,
      },
      request: { endpoint: "POST /contacts/search" },
    };
  }

  if (input.method === "GET" && input.path === "/opportunities/pipelines") {
    return {
      response: {
        pipelines: [
          {
            id: "pipeline-cold",
            name: "Profixter Cold Calls",
            stages: [
              { id: "stage-new", name: "New Lead" },
              { id: "stage-follow", name: "Follow Up" },
              { id: "stage-old", name: "Old" },
            ],
          },
        ],
      },
      request: { endpoint: "GET /opportunities/pipelines?locationId=test-location" },
    };
  }

  if (input.method === "GET" && input.path === "/opportunities/search") {
    if (input.query.contact_id) {
      return {
        response: {
          opportunities:
            input.query.contact_id === "contact-2"
              ? [
                  {
                    id: "opp-existing",
                    contactId: "contact-2",
                    pipelineId: "pipeline-cold",
                    pipelineStageId: "stage-new",
                  },
                ]
              : [],
        },
        request: { endpoint: "GET /opportunities/search?contact_id=..." },
      };
    }
    return {
      response: {
        opportunities: [
          makeOpportunity(1),
          makeOpportunity(2, {
            updatedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
          }),
          makeOpportunity(3, { pipelineStageId: "stage-follow" }),
        ],
        total: 3,
      },
      request: { endpoint: "GET /opportunities/search?location_id=test-location" },
    };
  }

  if (input.method === "GET" && input.path === "/conversations/search") {
    return {
      response: {
        conversations: [
          { id: "conv-1", contactId: "contact-1", contactName: "Ava", unreadCount: 2 },
          { id: "conv-2", contactId: "contact-2", contactName: "Liz", unreadCount: 0 },
        ],
      },
      request: { endpoint: "GET /conversations/search?locationId=test-location&limit=100" },
    };
  }

  if (input.method === "PUT" && /^\/contacts\/contact-\d+$/.test(input.path)) {
    assert.equal(input.approved, undefined);
    return {
      response: { contact: { id: input.path.split("/").pop(), ...input.body } },
      request: { endpoint: `PUT ${input.path}` },
    };
  }

  if (input.method === "POST" && input.path === "/opportunities/") {
    assert.equal(input.body.locationId, "test-location");
    assert.equal(input.body.pipelineId, "pipeline-cold");
    assert.equal(input.body.pipelineStageId, "stage-new");
    return {
      response: { opportunity: { id: `new-${input.body.contactId}` } },
      request: { endpoint: "POST /opportunities/" },
    };
  }

  if (input.method === "PUT" && /^\/opportunities\/opp-\d+$/.test(input.path)) {
    assert.equal(input.body.pipelineStageId, "stage-follow");
    return {
      response: { opportunity: { id: input.path.split("/").pop(), ...input.body } },
      request: { endpoint: `PUT ${input.path}` },
    };
  }

  if (input.method === "POST" && /^\/contacts\/contact-\d+\/tags$/.test(input.path)) {
    assert.deepEqual(input.body.tags, ["callback_needed"]);
    return {
      response: { ok: true },
      request: { endpoint: `POST ${input.path}` },
    };
  }

  throw new Error(`Unexpected request: ${input.method} ${input.path}`);
}

async function testOwnerAssignmentPlanAndExecution() {
  requests.length = 0;
  const message = 'Assign owner Taras Bandura to contacts with tag "website_registered".';
  assert.equal(looksLikeGenericGhlPlannerRequest(message), true);
  assert.equal(parseGenericRequest(message).operation, "contact_owner_assignment");
  const plan = await buildGenericGhlPlan({ message, adminUserId: "admin-1", apiCall });

  assert.equal(plan.operation, "contact_owner_assignment");
  assert.equal(plan.approvalRequired, true);
  assert.equal(plan.execution.owner.id, "user-taras");
  assert.equal(plan.expectedAffectedRecords, 2);
  assert.ok(plan.selectedEndpoints.some((endpoint) => endpoint.key === "contacts.update"));
  assert.ok(plan.debugTrace.some((line) => /users\.search/i.test(line)));

  requests.length = 0;
  const progress = [];
  const report = await executeGenericGhlWorkflow({
    plan,
    approved: true,
    adminUserId: "admin-1",
    userRequest: message,
    apiCall,
    onRecordComplete: async (state) => progress.push(state),
  });

  assert.equal(report.stats.recordsFound, 2);
  assert.equal(report.stats.recordsChanged, 1);
  assert.equal(report.stats.skipped, 1);
  assert.equal(report.stats.failed, 0);
  assert.equal(progress.at(-1).processedItems, 2);
  assert.ok(requests.some((request) => request.method === "PUT" && request.path === "/contacts/contact-1"));
}

async function testCreateOpportunitiesWithoutTag() {
  requests.length = 0;
  const message =
    'Create opportunities in pipeline "Profixter Cold Calls" stage "New Lead" for contacts without tag "premium".';
  const plan = await buildGenericGhlPlan({ message, adminUserId: "admin-1", apiCall });
  assert.equal(plan.operation, "opportunity_create_for_contacts");
  assert.equal(plan.execution.audience.mode, "without");
  assert.equal(plan.expectedAffectedRecords, 2);
  assert.ok(plan.selectedEndpoints.some((endpoint) => endpoint.key === "opportunities.create"));

  requests.length = 0;
  const report = await executeGenericGhlWorkflow({
    plan,
    approved: true,
    adminUserId: "admin-1",
    userRequest: message,
    apiCall,
  });
  assert.equal(report.stats.recordsChanged, 1);
  assert.equal(report.stats.skipped, 1);
  assert.equal(report.stats.failed, 0);
  assert.equal(requests.filter((request) => request.path === "/opportunities/search").length, 2);
  assert.equal(requests.filter((request) => request.path === "/opportunities/").length, 1);
}

async function testUnreadConversationsReadOnly() {
  requests.length = 0;
  const message = "Show unread conversations.";
  const plan = await buildGenericGhlPlan({ message, adminUserId: "admin-1", apiCall });
  assert.equal(plan.operation, "show_unread_conversations");
  assert.equal(plan.approvalRequired, false);
  assert.equal(plan.expectedAffectedRecords, 0);
  const result = await executeGenericGhlReadPlan({ plan });
  assert.equal(result.intent, "read");
  assert.equal(result.requiresApproval, false);
  assert.match(result.answer, /1 unread conversation/i);
  assert.equal(result.data.report.stats.recordsFound, 1);
  assert.ok(!requests.some((request) => request.path === "/conversations/messages"));
}

async function testMoveOldOpportunities() {
  requests.length = 0;
  const message = 'Move opportunities older than 30 days to stage "Follow Up".';
  const plan = await buildGenericGhlPlan({ message, adminUserId: "admin-1", apiCall });
  assert.equal(plan.operation, "move_opportunities_older_than");
  assert.equal(plan.expectedAffectedRecords, 2);
  assert.equal(plan.execution.stage.id, "stage-follow");

  requests.length = 0;
  const report = await executeGenericGhlWorkflow({
    plan,
    approved: true,
    adminUserId: "admin-1",
    userRequest: message,
    apiCall,
  });
  assert.equal(report.stats.recordsChanged, 1);
  assert.equal(report.stats.skipped, 1);
  assert.equal(report.stats.failed, 0);
  assert.ok(requests.some((request) => request.method === "PUT" && request.path === "/opportunities/opp-1"));
}

async function testAddTagToContacts() {
  requests.length = 0;
  const message = 'Add tag "callback_needed" to contacts with tag "website_registered".';
  const plan = await buildGenericGhlPlan({ message, adminUserId: "admin-1", apiCall });
  assert.equal(plan.operation, "add_tag_to_contacts");
  assert.equal(plan.execution.tagName, "callback_needed");
  assert.equal(plan.expectedAffectedRecords, 2);

  requests.length = 0;
  const report = await executeGenericGhlWorkflow({
    plan,
    approved: true,
    adminUserId: "admin-1",
    userRequest: message,
    apiCall,
  });
  assert.equal(report.stats.recordsChanged, 2);
  assert.equal(report.stats.skipped, 0);
  assert.equal(report.stats.failed, 0);
  assert.equal(requests.filter((request) => /\/tags$/.test(request.path)).length, 2);
}

async function run() {
  await testOwnerAssignmentPlanAndExecution();
  await testCreateOpportunitiesWithoutTag();
  await testUnreadConversationsReadOnly();
  await testMoveOldOpportunities();
  await testAddTagToContacts();
  console.log("Jarvis Generic GHL Planner tests passed");
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
