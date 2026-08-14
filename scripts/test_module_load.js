/**
 * Every route and util module actually loads.
 *
 * Written after a rename left a stale name in a module.exports block. The file
 * was syntactically perfect, so `node --check` passed and the deploy went out;
 * the ReferenceError only fired when Node evaluated the export list at require
 * time, which took the whole API down with a 502 until it was rolled back. The
 * one test that covered that export existed but had never been added to the CI
 * list, so nothing loaded the file on the way to production.
 *
 * This is the cheap general guard: require every module and let load-time
 * errors — stale exports, missing files, circular requires that resolve to
 * undefined, bad destructuring at module scope — surface here rather than on an
 * instance. It asserts nothing about behaviour; that is each module's own test.
 *
 * Deliberately limited to routes/ and utils/, which are pure module graphs.
 * jobs/ is excluded because loading it arms schedulers.
 *
 *   node scripts/test_module_load.js
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";
// Loading a module must never depend on secrets being present. These are set to
// obvious fakes so a missing local .env cannot be mistaken for a real failure.
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_fake_module_load";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.JWT_RESET_SECRET = process.env.JWT_RESET_SECRET || "test-reset-secret";
// A handful of modules assert on this at load rather than at first use.
process.env.S3_BUCKET = process.env.S3_BUCKET || "profixter-test-bucket";
process.env.AWS_REGION = process.env.AWS_REGION || "us-east-1";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DIRECTORIES = ["routes", "utils"];

function jsFilesIn(dir) {
  const absolute = path.join(ROOT, dir);
  if (!fs.existsSync(absolute)) return [];
  const out = [];
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFilesIn(relative));
    else if (entry.name.endsWith(".js")) out.push(relative);
  }
  return out;
}

const files = DIRECTORIES.flatMap(jsFilesIn).sort();
const failures = [];
let loaded = 0;

for (const file of files) {
  try {
    const exported = require(path.join(ROOT, file));

    // A module whose exports object contains an undefined value is usually a
    // rename that left the old name behind, or a circular require caught
    // mid-initialisation. Neither is a syntax error and both break at runtime.
    if (exported && typeof exported === "object" && !Array.isArray(exported)) {
      for (const [name, value] of Object.entries(exported)) {
        if (value === undefined) {
          throw new Error(`exports "${name}" as undefined`);
        }
      }
    }

    loaded += 1;
  } catch (error) {
    failures.push({ file, message: error?.message || String(error) });
    console.log(`  FAIL  ${file}`);
  }
}

console.log(`\nmodule load: ${loaded} loaded, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  FAIL  ${f.file}\n        ${f.message}`);
  process.exit(1);
}

// Some modules open handles (Stripe agents, mongoose buffers) that would keep
// the loop alive. Loading is all that was under test.
process.exit(0);
