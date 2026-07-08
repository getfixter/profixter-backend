const assert = require("assert");
const fs = require("fs-extra");
const path = require("path");

const uploadRoot = path.join(__dirname, "tmp-jarvis-csv-uploads");
process.env.JARVIS_UPLOAD_TMP_DIR = uploadRoot;

const ghlClientPath = require.resolve("../src/aiCommanderGhl/ghlClient");
const ghlRequests = [];
let retrySearchFailuresRemaining = 0;

require.cache[ghlClientPath] = {
  id: ghlClientPath,
  filename: ghlClientPath,
  loaded: true,
  exports: {
    getLocationId: () => "test-location",
    request: async (input) => {
      ghlRequests.push(input);
      if (input.method === "POST" && input.path === "/contacts/search") {
        const query = String(input.body?.query || "").toLowerCase();
        if (query.includes("5559990000") || query.includes("+15559990000")) {
          if (retrySearchFailuresRemaining > 0) {
            retrySearchFailuresRemaining -= 1;
            const error = new Error("GHL API request failed with 429");
            error.statusCode = 502;
            error.ghlStatus = 429;
            error.response = { statusCode: 429, message: "Too Many Requests" };
            throw error;
          }
          return {
            status: 200,
            data: {
              contacts: [
                {
                  id: "contact-retry",
                  name: "Rachel Retry",
                  phone: "+15559990000",
                  tags: ["Roofing/Siding", "sal-roofing"],
                },
              ],
            },
            request: { endpoint: "POST /contacts/search" },
            rateLimit: {},
          };
        }
        if (query.includes("6315551111") || query.includes("+16315551111")) {
          return {
            status: 200,
            data: {
              contacts: [
                {
                  id: "contact-1",
                  name: "John Roofer",
                  phone: "+16315551111",
                  tags: ["Roofing/Siding"],
                },
              ],
            },
            request: { endpoint: "POST /contacts/search" },
            rateLimit: {},
          };
        }
        if (query.includes("sally@example.com")) {
          return {
            status: 200,
            data: {
              contacts: [
                {
                  id: "contact-2",
                  name: "Sally Siding",
                  email: "sally@example.com",
                  tags: ["Roofing/Siding", "sal-siding"],
                },
              ],
            },
            request: { endpoint: "POST /contacts/search" },
            rateLimit: {},
          };
        }
        return {
          status: 200,
          data: { contacts: [] },
          request: { endpoint: "POST /contacts/search" },
          rateLimit: {},
        };
      }

      if (input.method === "POST" && input.path === "/contacts/contact-1/tags") {
        assert.deepEqual(input.body.tags, ["sal-roofing"]);
        return {
          status: 200,
          data: { ok: true },
          request: { endpoint: "POST /contacts/contact-1/tags" },
          rateLimit: {},
        };
      }

      throw new Error(`Unexpected GHL request: ${input.method} ${input.path}`);
    },
    redact: (value) => value,
  },
};

const { countCsvContacts } = require("../src/aiCommanderGhl/jarvisCsvProcessor");
const {
  auditEstimateCsvAgainstGhl,
  syncEstimateCsvWithGhl,
} = require("../src/aiCommanderGhl/jarvisCsvGhlSync");

function findDownload(report, filename) {
  return (report.downloads || []).find((download) => download.filename === filename);
}

async function writeSampleCsv() {
  await fs.ensureDir(uploadRoot);
  const fileName = "sample-estimates.csv";
  const absolute = path.join(uploadRoot, fileName);
  await fs.writeFile(
    absolute,
    [
      "Customer Name,Phone,Email,Address,Service,Estimate Amount",
      "John Roofer,6315551111,john@example.com,1 Roof St,Roofing Repair,$1200",
      "Sally Siding,,sally@example.com,2 Side Ave,Siding,$2200",
      "Bob Missing,,,3 Unknown Rd,Roofing,$800",
      ",,,,,$900",
    ].join("\n")
  );
  return {
    uploadId: "upload-1",
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

async function writeRetryCsv() {
  await fs.ensureDir(uploadRoot);
  const fileName = "retry-estimates.csv";
  const absolute = path.join(uploadRoot, fileName);
  await fs.writeFile(
    absolute,
    [
      "Customer Name,Phone,Email,Address,Service,Estimate Amount",
      "Rachel Retry,5559990000,,9 Retry Rd,Roofing,$900",
    ].join("\n")
  );
  return {
    uploadId: "upload-retry",
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

async function testCountCsvContacts() {
  const file = await writeSampleCsv();
  const result = await countCsvContacts({ files: [file] });

  assert.equal(result.totalRows, 4);
  assert.equal(result.validContacts, 3);
  assert.equal(result.invalidRows, 1);
  assert.deepEqual(result.files[0].sampleHeaders.slice(0, 3), [
    "Customer Name",
    "Phone",
    "Email",
  ]);
  assert.equal(result.files[0].preview[0].phone, "+16315551111");
  assert.equal(result.files[0].preview[1].email, "sally@example.com");
}

async function testSyncEstimateCsvWithGhl() {
  ghlRequests.length = 0;
  const file = await writeSampleCsv();
  const report = await syncEstimateCsvWithGhl({ files: [file], approved: true });

  assert.equal(report.totalRows, 4);
  assert.equal(report.validContacts, 3);
  assert.equal(report.foundInGhl, 2);
  assert.equal(report.notFoundInGhl, 1);
  assert.equal(report.alreadyTagged, 1);
  assert.equal(report.newlyTagged, 1);
  assert.equal(report.multipleMatches, 0);
  assert.equal(report.errors.length, 0);
  assert.equal(report.createdContacts, 0);
  assert.equal(report.missingContacts[0].name, "Bob Missing");
  assert.equal(report.summary.title, "Roofing/Siding Sync Completed");
  assert.match(report.summary.aiSummary, /I checked all 3 estimate contacts/);
  assert.equal(report.stats.csvContactsProcessed, 3);
  assert.equal(report.stats.contactsFoundInGhl, 2);
  assert.equal(report.stats.missingContacts, 1);
  assert.equal(report.stats.newRoofingSidingTagsAdded, 1);
  assert.equal(report.stats.alreadyTagged, 1);
  assert.equal(report.stats.errors, 0);
  assert.ok(report.executionTime.label);
  assert.ok(findDownload(report, "Missing Contacts.csv").content.includes("Bob Missing"));
  assert.ok(findDownload(report, "Audit Report.json").content.includes("Roofing/Siding Sync Completed"));
  assert.ok(report.recommendations.some((item) => /Import the 1 missing contacts/.test(item)));
  assert.ok(report.recommendations.some((item) => /Launch the Roofing\/Siding campaign/.test(item)));
  assert.equal(report.developerDetails.apiCalls[0].path, "/contacts/search");
  assert.ok(report.developerDetails.workflowLog.some((event) => event.message === "Finished."));
  assert.equal(report.workflow.name, "csv_ghl_tag_sync");
  assert.ok(report.workflow.progress.some((event) => event.message === "Reading CSV..."));
  assert.ok(report.workflow.progress.some((event) => event.message === "Finished."));
  assert.ok(ghlRequests.some((request) => request.path === "/contacts/contact-1/tags"));
}

async function testAuditEstimateCsvAgainstGhlDoesNotMutate() {
  ghlRequests.length = 0;
  const file = await writeSampleCsv();
  const report = await auditEstimateCsvAgainstGhl({ files: [file] });

  assert.equal(report.totalRows, 4);
  assert.equal(report.validContacts, 3);
  assert.equal(report.foundInGhl, 2);
  assert.equal(report.notFoundInGhl, 1);
  assert.equal(report.newlyTagged, 0);
  assert.equal(report.alreadyTagged, 0);
  assert.equal(report.summary.title, "CSV Audit Completed");
  assert.match(report.summary.aiSummary, /No GHL records were changed/);
  assert.equal(report.stats.csvContactsProcessed, 3);
  assert.equal(report.stats.contactsFoundInGhl, 2);
  assert.equal(report.stats.missingContacts, 1);
  assert.equal(report.stats.newRoofingSidingTagsAdded, 0);
  assert.ok(report.warnings.some((warning) => /read-only audit/.test(warning)));
  assert.ok(findDownload(report, "Missing Contacts.csv").content.includes("Bob Missing"));
  assert.ok(findDownload(report, "Audit Report.json").content.includes("CSV Audit Completed"));
  assert.ok(report.recommendations.some((item) => /Run the Roofing\/Siding tag sync/.test(item)));
  assert.equal(report.workflow.name, "csv_ghl_audit");
  assert.ok(report.workflow.progress.some((event) => event.message === "Audit complete."));
  assert.ok(!ghlRequests.some((request) => /\/tags$/.test(request.path)));
}

async function testSyncResumeSkipsCompletedRowsAndPersistsEachRemainingRow() {
  ghlRequests.length = 0;
  const saves = [];
  const file = await writeSampleCsv();
  const report = await syncEstimateCsvWithGhl({
    files: [file],
    approved: true,
    completedIndexes: [0],
    initialReport: {
      totalRows: 4,
      validContacts: 3,
      processedRows: 3,
      foundInGhl: 1,
      notFoundInGhl: 0,
      alreadyTagged: 0,
      newlyTagged: 1,
      multipleMatches: 0,
      errors: [],
      missingContacts: [],
      files: [],
      limited: false,
      limit: 5000,
      createdContacts: 0,
    },
    onRowComplete: (state) => saves.push(state),
  });

  assert.equal(report.foundInGhl, 2);
  assert.equal(report.notFoundInGhl, 1);
  assert.equal(report.newlyTagged, 1);
  assert.equal(report.alreadyTagged, 1);
  assert.equal(report.summary.title, "Roofing/Siding Sync Completed");
  assert.equal(report.stats.csvContactsProcessed, 3);
  assert.ok(findDownload(report, "Missing Contacts.csv").content.includes("Bob Missing"));
  assert.equal(saves.length, 2);
  assert.ok(saves.at(-1).completedIndexes.includes(0));
  assert.ok(saves.at(-1).completedIndexes.includes(1));
  assert.ok(saves.at(-1).completedIndexes.includes(2));
  assert.ok(!ghlRequests.some((request) => String(request.body?.query || "").includes("6315551111")));
  assert.ok(!ghlRequests.some((request) => request.path === "/contacts/contact-1/tags"));
}

async function testFailedRowRetryResolvesRateLimitedSearch() {
  ghlRequests.length = 0;
  retrySearchFailuresRemaining = 1;
  const file = await writeRetryCsv();
  const report = await syncEstimateCsvWithGhl({ files: [file], approved: true });

  assert.equal(report.totalRows, 1);
  assert.equal(report.validContacts, 1);
  assert.equal(report.foundInGhl, 1);
  assert.equal(report.notFoundInGhl, 0);
  assert.equal(report.errors.length, 0);
  assert.equal(report.resolvedAfterRetry, 1);
  assert.equal(report.resolvedAfterRetryFound, 1);
  assert.equal(report.stepStats.contactMatching.errors, 0);
  assert.equal(report.stepStats.contactMatching.resolvedAfterRetry, 1);
  assert.equal(report.stats.contactsFoundInGhl, 1);
  assert.equal(report.stats.resolvedAfterRetry, 1);
  assert.equal(report.stats.unresolvedErrors, 0);
  assert.equal(report.stats.errors, 0);
  assert.ok(!findDownload(report, "Error Report.csv"));
  assert.ok(report.warnings.some((warning) => /resolved after retry/.test(warning)));
  assert.ok(
    report.workflow.progress.some((event) =>
      /Failed-row retry resolved 1 \/ 1/.test(event.message)
    )
  );
  assert.equal(
    ghlRequests.filter((request) =>
      String(request.body?.query || "").includes("+15559990000")
    ).length,
    2
  );
}

async function run() {
  try {
    await testCountCsvContacts();
    await testAuditEstimateCsvAgainstGhlDoesNotMutate();
    await testSyncEstimateCsvWithGhl();
    await testSyncResumeSkipsCompletedRowsAndPersistsEachRemainingRow();
    await testFailedRowRetryResolvesRateLimitedSearch();
    console.log("Jarvis CSV processing tests passed");
  } finally {
    await fs.remove(uploadRoot);
  }
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
