const assert = require("assert");
const Module = require("module");

process.env.GHL_LOCATION_ID = "test-location";
process.env.GHL_AI_COMMANDER_TOKEN = "pit-test-token";

const fetchCalls = [];
const originalLoad = Module._load;

Module._load = function loadWithMockedFetch(request, parent, isMain) {
  if (request === "node-fetch") {
    return async function mockFetch(url, options) {
      fetchCalls.push({ url, options });
      return {
        ok: true,
        status: 200,
        headers: { get: () => "" },
        text: async () =>
          JSON.stringify({
            tags: [
              { id: "tag-1", name: "Roofing", active: true },
              { id: "tag-2", name: "Archive", active: false },
            ],
          }),
      };
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { executeWorkflow } = require("../src/aiCommanderGhl/jarvisWorkflowExecutor");
const {
  executionResponseFromJob,
  isBackgroundWorkflowAction,
} = require("../src/aiCommanderGhl/jarvisWorkflowJobRunner");

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

async function testWorkflowPrimitivesAndApiCall() {
  fetchCalls.length = 0;
  const result = await executeWorkflow({
    name: "test_tag_workflow",
    userRequest: "List active tags",
    steps: [
      { type: "progress", message: "Reading tags..." },
      { type: "set", var: "activeNames", value: [] },
      {
        type: "api_call",
        method: "GET",
        path: "/tags/",
        reason: "Read tags for workflow test",
        resultVar: "tagResponse",
      },
      {
        type: "filter",
        items: "$.tagResponse.response.tags",
        itemVar: "tag",
        where: { path: "$.tag.active", equals: true },
        resultVar: "activeTags",
      },
      {
        type: "loop",
        items: "$.activeTags",
        itemVar: "tag",
        progressEvery: 1,
        progressMessage: "Processing tag ${indexDisplay} / ${loopLength}...",
        steps: [
          { type: "array_push", target: "activeNames", value: "$.tag.name" },
        ],
      },
      {
        type: "condition",
        if: { path: "$.activeNames", notEmpty: true },
        then: [{ type: "progress", message: "Active tags found." }],
        else: [{ type: "progress", message: "No active tags found." }],
      },
      { type: "report", value: { activeNames: "$.activeNames" } },
    ],
  });

  assert.equal(result.status, "completed");
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0].url, /locationId=test-location/);
  assert.deepEqual(result.report.activeNames, ["Roofing"]);
  assert.equal(result.stepStats.apiCalls, 1);
  assert.equal(result.stepStats.byType.api_call, 1);
  assert.equal(result.stepStats.loopIterations, 1);
  assert.equal(result.stepStats.reportsGenerated, 1);
  assert.ok(result.progress.some((event) => event.message === "Reading tags..."));
  assert.ok(result.progress.some((event) => event.message === "Active tags found."));
}

async function testLoopContinueOnError() {
  const result = await executeWorkflow({
    name: "continue_on_error_workflow",
    context: { rows: [1, 2, 3], processed: [] },
    steps: [
      {
        type: "loop",
        items: "$.rows",
        itemVar: "row",
        continueOnError: true,
        steps: [
          {
            type: "transform",
            handler: ({ variables }) => {
              if (variables.row === 2) throw new Error("row failed");
              variables.processed.push(variables.row);
            },
          },
        ],
      },
      { type: "report", value: { processed: "$.processed" } },
    ],
  });

  assert.equal(result.status, "completed_with_errors");
  assert.deepEqual(result.report.processed, [1, 3]);
  assert.equal(result.errors.length, 1);
  assert.equal(result.stepStats.loopIterations, 3);
  assert.equal(result.stepStats.errors, 1);
  assert.match(result.errors[0].message, /row failed/);
}

function testWorkflowJobExecutionResponseShape() {
  assert.equal(isBackgroundWorkflowAction({ actionType: "sync_estimate_csv_with_ghl" }), true);
  assert.equal(isBackgroundWorkflowAction({ actionType: "create_contact" }), false);

  const response = executionResponseFromJob({
    jobId: "wf_test",
    name: "csv_ghl_tag_sync",
    actionType: "sync_estimate_csv_with_ghl",
    status: "running",
    processedItems: 50,
    totalItems: 462,
    percent: 11,
    currentMessage: "Processing 50 / 462...",
    progressEvents: [{ message: "Processing 50 / 462..." }],
    payload: { actionId: "sync_estimate_csv_with_ghl" },
    errors: [],
  });

  assert.equal(response.status, "running");
  assert.equal(response.jobId, "wf_test");
  assert.equal(response.workflowJob.progress.processed, 50);
  assert.equal(response.workflowJob.progress.total, 462);
  assert.equal(response.workflowJob.progress.percent, 11);

  const completedResponse = executionResponseFromJob({
    jobId: "wf_done",
    name: "csv_ghl_tag_sync",
    actionType: "sync_estimate_csv_with_ghl",
    status: "completed",
    processedItems: 462,
    totalItems: 462,
    percent: 100,
    currentMessage: "Finished.",
    progressEvents: [{ message: "Finished." }],
    payload: { actionId: "sync_estimate_csv_with_ghl" },
    report: {
      summary: { title: "Roofing/Siding Sync Completed" },
      stats: { csvContactsProcessed: 462 },
      warnings: [],
      downloads: [],
      recommendations: ["Import missing contacts."],
      executionTime: { label: "2m 14s" },
    },
    errors: [],
  });

  assert.equal(completedResponse.status, "executed");
  assert.equal(
    completedResponse.workflowJob.report.summary.title,
    "Roofing/Siding Sync Completed"
  );
  assert.equal(
    completedResponse.results[0].response.summary.title,
    "Roofing/Siding Sync Completed"
  );
}

async function run() {
  await quiet(async () => {
    await testWorkflowPrimitivesAndApiCall();
    await testLoopContinueOnError();
    testWorkflowJobExecutionResponseShape();
  });
  console.log("Jarvis workflow executor tests passed");
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
