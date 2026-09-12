/**
 * Where Stripe sends a customer back to.
 *
 * Backing out of checkout used to land on "/" carrying plan and billingCycle in
 * the query string - and nothing on the homepage read either one, so somebody
 * who hesitated was returned to the top of the funnel with their choice
 * silently discarded. The plans page restores the cycle and address from those
 * params and says plainly that nothing was charged, so that is where a
 * cancelled session belongs.
 *
 * This pins both return URLs by reading the route source, because getting them
 * wrong is invisible until a real customer abandons a real checkout.
 *
 *   node scripts/test_checkout_return_urls.js
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

const src = fs
  .readFileSync(path.join(__dirname, "..", "routes", "stripe.js"), "utf8")
  .replace(/\r\n/g, "\n");

console.log("\nStripe checkout return URLs\n");

test("cancel_url returns to the plan comparison, not the homepage", () => {
  const match = src.match(/cancel_url:\s*`([^`]+)`/);
  assert.ok(match, "no cancel_url found in routes/stripe.js");
  const url = match[1];
  assert.ok(
    url.includes("/membership/plans"),
    `cancel_url points at ${url} - a cancelled checkout should land on the comparison`
  );
  assert.ok(
    !/\$\{CLIENT_URL\}\/\?/.test(url),
    `cancel_url still returns to the bare homepage: ${url}`
  );
});

test("cancel_url carries the selection forward", () => {
  const url = src.match(/cancel_url:\s*`([^`]+)`/)[1];
  for (const param of ["canceled=true", "plan=", "billingCycle="]) {
    assert.ok(url.includes(param), `cancel_url is missing ${param}: ${url}`);
  }
});

test("success_url still carries the Stripe session id", () => {
  const match = src.match(/success_url:\s*`([^`]+)`/);
  assert.ok(match, "no success_url found");
  const url = match[1];
  assert.ok(url.includes("/confirmationpage"), `success_url points at ${url}`);
  assert.ok(
    url.includes("session_id={CHECKOUT_SESSION_ID}"),
    "success_url must carry {CHECKOUT_SESSION_ID} for attribution"
  );
});

test("duplicate membership on one address is still refused", () => {
  assert.ok(
    /already has an active plan/i.test(src),
    "the 409 guard against two memberships on one address is gone"
  );
});

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exit(1);
