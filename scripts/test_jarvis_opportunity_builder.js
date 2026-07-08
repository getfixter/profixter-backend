const assert = require("assert");

process.env.GHL_LOCATION_ID = "test-location";
process.env.JARVIS_OPPORTUNITY_BUILDER_CONCURRENCY = "1";

const {
  executeOpportunityBuilder,
  looksLikeOpportunityBuilderRequest,
  parseOpportunityBuilderRequest,
  prepareOpportunityBuilder,
} = require("../src/aiCommanderGhl/jarvisOpportunityBuilder");

const requests = [];
let createMode = "success";

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
    return {
      response: {
        contacts: [makeContact(1), makeContact(2), makeContact(3)],
        total: 3,
      },
      request: { endpoint: "POST /contacts/search" },
    };
  }

  if (input.method === "GET" && input.path === "/opportunities/pipelines") {
    return {
      response: {
        pipelines: [
          {
            id: "pipeline-cold-calls",
            name: "Profixter Cold Calls",
            stages: [
              { id: "stage-new-lead", name: "New Lead" },
              { id: "stage-called", name: "Called" },
            ],
          },
        ],
      },
      request: { endpoint: "GET /opportunities/pipelines?locationId=test-location" },
    };
  }

  if (input.method === "POST" && input.path === "/opportunities/" && input.dryRun === true) {
    assert.equal(input.body.locationId, "test-location");
    assert.equal(input.body.pipelineId, "pipeline-cold-calls");
    assert.equal(input.body.pipelineStageId, "stage-new-lead");
    assert.equal(input.body.contactId, "contact-1");
    return {
      dryRun: true,
      method: "POST",
      path: input.path,
      body: input.body,
      summary: "Jarvis would call POST /opportunities/ for Create one opportunity.",
    };
  }

  if (input.method === "GET" && input.path === "/opportunities/search") {
    assert.equal(input.query.location_id, "test-location");
    assert.equal(input.query.pipeline_id, "pipeline-cold-calls");
    assert.ok(input.query.contact_id);
    const contactId = input.query.contact_id;
    return {
      response: {
        opportunities:
          contactId === "contact-2"
            ? [
                {
                  id: "opp-existing",
                  name: "Existing website lead",
                  contactId,
                  pipelineId: "pipeline-cold-calls",
                  pipelineStageId: "stage-new-lead",
                },
              ]
            : [],
        total: contactId === "contact-2" ? 1 : 0,
      },
      request: {
        endpoint: `GET /opportunities/search?location_id=test-location&contact_id=${contactId}&pipeline_id=pipeline-cold-calls`,
      },
    };
  }

  if (input.method === "POST" && input.path === "/opportunities/") {
    assert.equal(input.body.locationId, "test-location");
    assert.equal(input.body.pipelineId, "pipeline-cold-calls");
    assert.equal(input.body.pipelineStageId, "stage-new-lead");
    assert.match(input.body.name, /Profixter Cold Calls/);
    if (createMode === "failContact3" && input.body.contactId === "contact-3") {
      const error = new Error("GHL API request failed with 422");
      error.statusCode = 502;
      error.ghlStatus = 422;
      error.request = {
        method: "POST",
        endpoint: "POST /opportunities/",
        path: "/opportunities/",
        body: input.body,
      };
      error.response = {
        message: "contactId is invalid",
        error: "Unprocessable Entity",
        statusCode: 422,
      };
      throw error;
    }
    return {
      status: 201,
      response: {
        opportunity: {
          id: `opp-${input.body.contactId}`,
          contactId: input.body.contactId,
          pipelineId: input.body.pipelineId,
          pipelineStageId: input.body.pipelineStageId,
        },
      },
      request: { endpoint: "POST /opportunities/" },
    };
  }

  throw new Error(`Unexpected test request: ${input.method} ${input.path}`);
}

async function testParse() {
  const message =
    'Add all contacts with tag "website_registered" to the opportunity pipeline "Profixter Cold Calls" in stage "New Lead".';
  assert.equal(looksLikeOpportunityBuilderRequest(message), true);
  assert.deepEqual(parseOpportunityBuilderRequest(message), {
    audienceType: "tag",
    tagName: "website_registered",
    pipelineName: "Profixter Cold Calls",
    stageName: "New Lead",
  });

  const variants = [
    "Only contacts with tag website_registered to pipeline Profixter Cold Calls in stage New Lead.",
    "Add all contacts that have tag website_registered to the opportunity pipeline Profixter Cold Calls in stage New Lead.",
    "Put everyone tagged website_registered into pipeline Profixter Cold Calls in stage New Lead.",
    "Add all contacts except those who do not have tag website_registered to the opportunity pipeline Profixter Cold Calls in stage New Lead.",
  ];
  for (const variant of variants) {
    assert.equal(looksLikeOpportunityBuilderRequest(variant), true);
    const parsed = parseOpportunityBuilderRequest(variant);
    assert.equal(parsed.tagName, "website_registered");
    assert.equal(parsed.pipelineName, "Profixter Cold Calls");
    assert.equal(parsed.stageName, "New Lead");
  }
}

async function testPrepareAndExecute() {
  requests.length = 0;
  createMode = "success";
  const prepared = await prepareOpportunityBuilder({
    message:
      'Add all contacts with tag "website_registered" to the opportunity pipeline "Profixter Cold Calls" in stage "New Lead".',
    adminUserId: "admin-1",
    apiCall,
  });

  assert.equal(prepared.capability, "opportunity_builder");
  assert.equal(prepared.audience.tagName, "website_registered");
  assert.equal(prepared.contactCount, 3);
  assert.equal(prepared.pipeline.id, "pipeline-cold-calls");
  assert.equal(prepared.stage.id, "stage-new-lead");
  assert.equal(prepared.preview.length, 3);
  assert.equal(prepared.opportunityCreateDryRun.dryRun, true);
  assert.equal(prepared.nothingChanged, true);
  assert.ok(requests.some((request) => request.path === "/contacts/search"));
  assert.ok(requests.some((request) => request.path === "/opportunities/pipelines"));
  assert.ok(
    requests.some((request) => request.path === "/opportunities/" && request.dryRun === true)
  );

  requests.length = 0;
  const progress = [];
  const report = await executeOpportunityBuilder({
    tagName: prepared.audience.tagName,
    pipelineId: prepared.pipeline.id,
    pipelineName: prepared.pipeline.name,
    stageId: prepared.stage.id,
    stageName: prepared.stage.name,
    contacts: prepared.contacts,
    approved: true,
    adminUserId: "admin-1",
    userRequest: "Create opportunities",
    apiCall,
    onContactComplete: async (state) => {
      progress.push(state);
    },
  });

  assert.equal(report.summary.title, "Opportunity Builder Completed");
  assert.equal(report.stats.contactsFound, 3);
  assert.equal(report.stats.opportunitiesCreated, 2);
  assert.equal(report.stats.alreadyExisted, 1);
  assert.equal(report.stats.failed, 0);
  assert.equal(report.stats.processed, 3);
  assert.equal(report.stats.successRate, "100.0%");
  assert.match(report.summary.aiSummary, /2 new opportunities were created/i);
  assert.equal(requests.filter((request) => request.path === "/opportunities/search").length, 3);
  assert.equal(
    requests.filter((request) => request.method === "POST" && request.path === "/opportunities/").length,
    2
  );
  assert.equal(progress.at(-1).processedItems, 3);
  assert.equal(progress.at(-1).percent, 100);
}

async function testFailedCreateContinues() {
  requests.length = 0;
  createMode = "failContact3";
  const contacts = [makeContact(1), makeContact(2), makeContact(3)];
  const report = await executeOpportunityBuilder({
    tagName: "website_registered",
    pipelineId: "pipeline-cold-calls",
    pipelineName: "Profixter Cold Calls",
    stageId: "stage-new-lead",
    stageName: "New Lead",
    contacts,
    approved: true,
    adminUserId: "admin-1",
    userRequest: "Create opportunities",
    apiCall,
  });

  assert.equal(report.stats.contactsFound, 3);
  assert.equal(report.stats.opportunitiesCreated, 1);
  assert.equal(report.stats.alreadyExisted, 1);
  assert.equal(report.stats.failed, 1);
  assert.equal(report.stats.processed, 3);
  assert.equal(report.summary.status, "completed_with_errors");
  assert.equal(report.errors[0].contactId, "contact-3");
  assert.match(report.errors[0].ghlErrorMessage, /contactId is invalid/);
  assert.ok(report.downloads.some((download) => /Error Report\.csv/.test(download.filename)));
}

async function run() {
  await testParse();
  await testPrepareAndExecute();
  await testFailedCreateContinues();
  console.log("Jarvis Opportunity Builder tests passed");
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
