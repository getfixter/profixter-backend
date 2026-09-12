/**
 * Customer documents must never be stored where the public can read them.
 *
 * On 2026-07-15 the first contract ever generated, PIH-2026-0001 v1, was
 * written to uploads/projects/... instead of private/admin/contracts/... The
 * bucket policy grants anonymous s3:GetObject on the whole uploads/ prefix for
 * booking photos, so a signed customer agreement answered 200 to anyone who
 * knew the URL. Twenty-three minutes later the prefix default was corrected
 * and every contract since has been private, which is exactly the kind of fix
 * that is invisible the next time somebody adds a document type.
 *
 * These are source and configuration assertions - no database, no network, no
 * AWS - so they can gate every deploy.
 *
 *   node scripts/test_document_storage_privacy.js
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

/** Every module that writes a customer or business document to S3. */
const DOCUMENT_MODULES = [
  "routes/adminContracts.js",
  "routes/adminChangeOrders.js",
  "routes/adminInvoices.js",
  "utils/esign/nativeSignatureService.js",
  "utils/esign/signatureService.js",
];

/** The only modules allowed to write objects the world can read. */
const PUBLIC_WRITERS = [
  "utils/bookingAttachments.js",
  "utils/recentWork/workPhotoImages.js",
  "routes/bookings.js",
];

console.log("\nDocument storage privacy\n");

test("every document prefix defaults to a private location", () => {
  const defaults = [];
  for (const file of DOCUMENT_MODULES) {
    const src = read(file);
    /* e.g.  process.env.CONTRACT_S3_PREFIX || "private/admin/contracts"  */
    const re = /process\.env\.([A-Z0-9_]*S3_PREFIX)\s*\|\|\s*"([^"]+)"/g;
    let m;
    while ((m = re.exec(src))) defaults.push({ file, name: m[1], value: m[2] });
  }
  assert.ok(defaults.length >= 4, `expected several document prefixes, found ${defaults.length}`);
  for (const d of defaults) {
    assert.ok(
      d.value.startsWith("private/"),
      `${d.file}: ${d.name} defaults to "${d.value}" - anything outside private/ is world-readable`
    );
    assert.ok(
      !/^uploads(\/|$)/.test(d.value),
      `${d.file}: ${d.name} defaults into the public photo prefix`
    );
  }
});

test("document modules never write with putPublicObject", () => {
  for (const file of DOCUMENT_MODULES) {
    const src = read(file);
    assert.ok(
      !/putPublicObject/.test(src),
      `${file} writes documents with putPublicObject - those objects are anonymously readable`
    );
    assert.ok(/putPrivateObject/.test(src), `${file} does not use putPrivateObject`);
  }
});

test("only the photo pipelines are allowed to write public objects", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        walk(rel);
      } else if (entry.name.endsWith(".js")) {
        const src = read(rel);
        /* The definition itself lives in utils/s3.js. */
        if (rel === "utils/s3.js") continue;
        if (/putPublicObject\s*\(/.test(src) && !PUBLIC_WRITERS.includes(rel)) offenders.push(rel);
      }
    }
  };
  for (const dir of ["routes", "utils", "jobs", "controllers"]) {
    if (fs.existsSync(path.join(ROOT, dir))) walk(dir);
  }
  assert.strictEqual(
    offenders.length,
    0,
    `these modules write world-readable objects and are not photo pipelines: ${offenders.join(", ")}`
  );
});

test("no document read takes its S3 key from the request", () => {
  /*
   * The key must come from a record we looked up, never from the caller.
   * An endpoint that reads req.query.key would let any authenticated user
   * name any object in the bucket and have it handed back to them.
   */
  const files = [...DOCUMENT_MODULES, "routes/adminSignatures.js", "routes/publicSigning.js", "utils/companySignature.js"];
  for (const file of files) {
    if (!fs.existsSync(path.join(ROOT, file))) continue;
    const src = read(file);
    const re = /getObjectBuffer\s*\(\s*\{\s*Key:\s*([^}]+?)\s*[},]/g;
    let m;
    while ((m = re.exec(src))) {
      const expr = m[1].trim();
      assert.ok(
        !/\breq\b/.test(expr),
        `${file}: getObjectBuffer key comes from the request (${expr})`
      );
    }
    assert.ok(
      !/readStoredPdf\s*\(\s*req\./.test(src),
      `${file}: readStoredPdf is given a request-supplied key`
    );
  }
});

test("admin document routers require authentication and admin permission", () => {
  for (const file of ["routes/adminContracts.js", "routes/adminChangeOrders.js", "routes/adminInvoices.js"]) {
    const src = read(file);
    assert.ok(
      /router\.use\(\s*auth\s*,\s*\.\.\.requirePermission\(PERMISSIONS\.ADMIN\)\s*\)/.test(src),
      `${file} does not gate the whole router behind auth + ADMIN permission`
    );
  }
});

test("Adobe Sign receives document bytes, never an S3 URL", () => {
  const src = read("utils/esign/adobeSignClient.js");
  assert.ok(/transientDocuments/.test(src), "the transient document upload is gone");
  assert.ok(
    !/s3\.amazonaws\.com|documentUrl|publicUrl/i.test(src),
    "adobeSignClient references an S3 URL - Adobe must be sent the bytes, not a link"
  );
});

test("contract email delivers the PDF as an attachment, not a link", () => {
  const src = read("routes/adminContracts.js");
  assert.ok(/attachments:\s*\[/.test(src), "contract email no longer attaches the PDF");
  assert.ok(
    !/s3\.amazonaws\.com/.test(src),
    "contract email references an S3 URL - a link in an inbox outlives any access check"
  );
});

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exit(1);
