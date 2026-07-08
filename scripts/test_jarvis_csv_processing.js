const assert = require("assert");
const fs = require("fs-extra");
const path = require("path");

const uploadRoot = path.join(__dirname, "tmp-jarvis-csv-uploads");
process.env.JARVIS_UPLOAD_TMP_DIR = uploadRoot;

const ghlClientPath = require.resolve("../src/aiCommanderGhl/ghlClient");
const ghlRequests = [];

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
const { syncEstimateCsvWithGhl } = require("../src/aiCommanderGhl/jarvisCsvGhlSync");

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
  const report = await syncEstimateCsvWithGhl({ files: [file] });

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
  assert.ok(ghlRequests.some((request) => request.path === "/contacts/contact-1/tags"));
}

async function run() {
  try {
    await testCountCsvContacts();
    await testSyncEstimateCsvWithGhl();
    console.log("Jarvis CSV processing tests passed");
  } finally {
    await fs.remove(uploadRoot);
  }
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
