/*
 * The booking transition allow-list and the job labels, without a database.
 *
 *   node scripts/test_booking_transitions.js
 */
process.env.NODE_ENV = "test";
process.env.S3_BUCKET = process.env.S3_BUCKET || "test-bucket";
process.env.AWS_REGION = process.env.AWS_REGION || "us-east-1";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_fake";
process.env.JWT_SECRET = process.env.JWT_SECRET || "x";

const assert = require("assert");
const { legacyActionFor, targetFor } = require("../utils/bookingTransitions");
const { canonicalStatus, jobType, timingLabel, jobFlags } = require("../utils/jobs/jobStatus");
const { canSeeAllJobs, jobScopeFilter, canAccessJob } = require("../utils/jobs/jobAccess");
const { PERMISSIONS } = require("../utils/adminAccess");
const { adminLink } = require("../utils/operationalEmail");

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS  ${name}`);
}
const code = (fn) => {
  try {
    fn();
  } catch (error) {
    return error.code;
  }
  return null;
};

test("allowed transitions", () => {
  assert.strictEqual(targetFor("confirm", "Pending"), "Confirmed");
  assert.strictEqual(targetFor("complete", "Confirmed"), "Completed");
  assert.strictEqual(targetFor("cancel", "Pending"), "Canceled");
  assert.strictEqual(targetFor("cancel", "Confirmed"), "Canceled");
  assert.strictEqual(targetFor("reinstate", "Canceled"), "Confirmed");
  assert.strictEqual(targetFor("reinstate", "Completed", "Pending"), "Pending");
});

test("forbidden transitions answer INVALID_TRANSITION", () => {
  for (const [action, from] of [["confirm", "Canceled"], ["confirm", "Completed"], ["complete", "Pending"], ["complete", "Canceled"], ["cancel", "Completed"], ["reinstate", "Confirmed"], ["reinstate", "Pending"]]) {
    assert.strictEqual(code(() => targetFor(action, from)), "INVALID_TRANSITION", `${action} from ${from}`);
  }
  assert.strictEqual(code(() => targetFor("reinstate", "Canceled", "Completed")), "INVALID_TARGET");
  assert.strictEqual(code(() => targetFor("delete", "Pending")), "INVALID_ACTION");
});

test("the legacy status route maps statuses onto the allow-list", () => {
  assert.strictEqual(legacyActionFor("Pending", "Confirmed"), "confirm");
  assert.strictEqual(legacyActionFor("Confirmed", "Completed"), "complete");
  assert.strictEqual(legacyActionFor("Confirmed", "Canceled"), "cancel");
  assert.strictEqual(legacyActionFor("Pending Confirmation", "Canceled"), "cancel");
  assert.strictEqual(legacyActionFor("Confirmed", "Confirmed"), "noop");
  for (const [from, to] of [["Canceled", "Confirmed"], ["Completed", "Confirmed"], ["Completed", "Pending"], ["Canceled", "Completed"], ["Pending", "Completed"], ["Confirmed", "Pending"]]) {
    assert.strictEqual(code(() => legacyActionFor(from, to)), "INVALID_TRANSITION", `${from} -> ${to}`);
  }
  try {
    legacyActionFor("Canceled", "Confirmed");
  } catch (error) {
    assert.ok(/Reinstate/.test(error.message));
  }
});

test("canonical statuses tolerate historical spellings", () => {
  assert.strictEqual(canonicalStatus("cancelled"), "Canceled");
  assert.strictEqual(canonicalStatus("done"), "Completed");
  assert.strictEqual(canonicalStatus("pending confirmation"), "Pending Confirmation");
  assert.strictEqual(canonicalStatus(""), "Pending");
});

test("types: Full Day first, Admin free visit is not Membership (J-08)", () => {
  assert.strictEqual(jobType({ bookingType: "full_day_visit", accessType: "one_time" }).type, "full_day");
  assert.strictEqual(jobType({ accessType: "admin" }).type, "admin_free");
  assert.strictEqual(jobType({ accessType: "one_time" }).type, "one_time");
  assert.strictEqual(jobType({ guestRequestId: "x", freeVisitPurpose: "consultation" }).typeLabel, "Free Visit · To-do review");
  assert.strictEqual(jobType({}).type, "member");
});

test("timing never says In progress: Scheduled now for 2h, then Not closed; Pending gets none", () => {
  const start = new Date("2026-11-12T15:00:00Z");
  const b = { status: "Confirmed", date: start };
  assert.strictEqual(timingLabel(b, new Date(start.getTime() - 60000)).key, "upcoming");
  assert.strictEqual(timingLabel(b, new Date(start.getTime() + 60000)).label, "Scheduled now");
  assert.strictEqual(timingLabel(b, new Date(start.getTime() + 2 * 3600000 + 1)).label, "Not closed");
  assert.strictEqual(timingLabel({ status: "Pending", date: start }, new Date(start.getTime() + 5 * 3600000)), null);
  assert.ok(jobFlags(b, new Date(start.getTime() + 3 * 3600000)).some((f) => f.key === "not_closed"));
});

test("record scope: without bookings.assign a caller is limited to their own jobs", () => {
  const me = { _id: "64b000000000000000000001" };
  const fixter = { accessRole: "employee", permissions: [PERMISSIONS.BOOKINGS_READ, PERMISSIONS.BOOKINGS_WRITE], accessUser: me };
  const general = { accessRole: "employee", permissions: [PERMISSIONS.BOOKINGS_READ, PERMISSIONS.BOOKINGS_ASSIGN], accessUser: me };
  assert.strictEqual(canSeeAllJobs(fixter), false);
  assert.deepStrictEqual(jobScopeFilter(fixter), { assignedFixterId: me._id });
  assert.deepStrictEqual(jobScopeFilter(general), {});
  assert.strictEqual(canAccessJob(fixter, { assignedFixterId: me._id }), true);
  assert.strictEqual(canAccessJob(fixter, { assignedFixterId: "64b000000000000000000002" }), false);
  assert.strictEqual(canAccessJob(fixter, { assignedFixterId: null }), false);
  assert.strictEqual(canAccessJob({ accessRole: "admin", permissions: [] }, {}), true);
});

test("operational email links open the new Admin pages (J-17)", () => {
  assert.strictEqual(adminLink.booking("abc"), "/admin/jobs/abc");
  assert.strictEqual(adminLink.customer("u1"), "/admin/customers/u1");
  assert.strictEqual(adminLink.lead("l1"), "/admin/leads?open=l1");
  assert.strictEqual(adminLink.lead(), "/admin/leads");
  assert.strictEqual(adminLink.bookings(), "/admin/jobs");
  assert.strictEqual(adminLink.booking(""), "");
});

console.log(`\n${passed} passed`);
