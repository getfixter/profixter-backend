/**
 * CI test runner — invoked by `npm test` from .github/workflows/deploy-eb.yml.
 *
 * Runs only suites that are deterministic and need NO database, network, AWS
 * or Stripe access, so a deploy is never blocked by an environment problem.
 * Suites that require a live MongoDB are deliberately excluded and are run
 * locally against a disposable database instead.
 *
 *   npm test
 */

const { spawnSync } = require("child_process");
const path = require("path");

/** Deterministic, dependency-free suites. */
const SUITES = [
  "test_service_area.js",
  "test_change_order_totals.js",
  "test_project_financials.js",
  "test_document_dates.js",
  "test_change_order_document.js",
  "test_esign_signature_flow.js",
  "test_native_signing.js",
  "test_executed_document.js",
  "test_intro_visit_eligibility.js",
  "test_one_time_booking_policy.js",
  "test_one_time_visit_payment_flow.js",
  "test_customer_booking_cutover.js",
  "test_booking_cutover_routes.js",
  "test_slot_reservation_service.js",
  "test_booking_slot_reservation_model.js",
  "test_explicit_appointment_starts.js",
  "test_visit_entitlement_indexes.js",
  "test_admin_customer_calendar_integration.js",
  "test_customer_availability_readiness.js",
  "test_calendar_deployment_gate.js",
  "test_booking_content_updates.js",
];

/**
 * Suites intentionally NOT run in CI, and why:
 *   test_intro_visit_flows_live.js   needs a live MongoDB
 *   test_intro_visit_race_live.js    needs a live MongoDB + running backend
 *   test_intro_visit_photo_live.js   needs a live MongoDB + running backend + S3 stub
 *   test_native_signing_integration.js  boots an in-memory MongoDB binary
 *   test_native_signing_routes.js       boots an in-memory MongoDB binary
 *   test_project_financials_integration.js  boots an in-memory MongoDB binary
 *   seed_intro_visit_testdata.js     writes synthetic data, local only
 *   local_s3_stub.js                 local test helper, not a test
 */

const failed = [];

for (const suite of SUITES) {
  const file = path.join(__dirname, suite);
  process.stdout.write(`${suite.padEnd(46)}`);
  const result = spawnSync(process.execPath, [file], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "test" },
  });

  if (result.status === 0) {
    console.log("PASS");
  } else {
    console.log("FAIL");
    failed.push({ suite, out: result.stdout?.toString() || "", err: result.stderr?.toString() || "" });
  }
}

if (failed.length) {
  console.error(`\n${failed.length} suite(s) failed:\n`);
  for (const f of failed) {
    console.error(`--- ${f.suite} ---`);
    console.error(f.out.split("\n").slice(-25).join("\n"));
    console.error(f.err.split("\n").slice(-25).join("\n"));
  }
  process.exit(1);
}

console.log(`\n${SUITES.length} suites passed.`);
process.exit(0);
