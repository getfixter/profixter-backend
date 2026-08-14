/**
 * The transactional email system as a whole.
 *
 * Individual template suites check wording. This checks the properties that are
 * supposed to hold across every email we send, which is where the drift
 * actually happens: a stale logo on one template, an admin notification that
 * grew to seventeen rows, a subject that leaks an identifier.
 *
 * Marketing is explicitly out of scope and is not loaded here.
 */

process.env.S3_BUCKET = process.env.S3_BUCKET || "test-bucket";
process.env.MAIL_ADMIN = process.env.MAIL_ADMIN || "admin@profixter.test";

const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { TEMPLATES } = require("../utils/emailService");
const {
  renderOperationalEmail,
  safeActionUrl,
  adminLink,
} = require("../utils/operationalEmail");
const { renderAdminEventEmail } = require("../utils/adminLeadNotification");

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error.message}`);
  }
}

/** Plausible data for every template, so all of them can be rendered. */
const VARS = {
  name: "Sam Carter",
  otp: "123456",
  bookingNumber: "12345678",
  date: "2026-08-18T14:00:00.000Z",
  service: "Labor Only",
  selectedTask: "TV Mounting",
  address: "1 Test Street, Babylon NY 11702",
  plan: "Plus",
  amount: "$20",
  price: "$99",
  tipperName: "John Smith",
  approximateHours: 8,
  included: false,
  startTime: "8:00 AM",
  endTime: "4:00 PM",
  bookingType: "membership_visit",
  accessType: "membership",
  email: "sam@example.com",
  phone: "+15550001111",
  userId: "12345678",
  fixter: "Roman Hecha",
  paymentSummary: "$499 paid",
  note: "Mount the TV",
};

const RENDERED = Object.entries(TEMPLATES).map(([key, build]) => {
  const out = build(VARS);
  return { key, out, body: `${out.subject || ""}\n${out.html || ""}\n${out.text || ""}` };
});

console.log("\nEvery template renders");

test("all templates produce a subject and a body", () => {
  for (const { key, out } of RENDERED) {
    assert.ok(String(out.subject || "").trim(), `${key} has no subject`);
    assert.ok(String(out.html || "").trim(), `${key} has no html`);
  }
  assert.ok(RENDERED.length >= 20, `expected the full set, got ${RENDERED.length}`);
});

console.log("\nBranding");

test("no template carries the old Mr. Fixter mark", () => {
  for (const { key, body } of RENDERED) {
    assert.doesNotMatch(body, /mrfixter/i, `${key} still loads the old logo asset`);
    assert.doesNotMatch(body, /Mr\.?\s*Fixter/i, `${key} still says Mr. Fixter`);
  }
});

test("no transactional email depends on a remote image", () => {
  // Images are blocked by default in a lot of clients. An email whose brand
  // only exists inside an <img> is an unbranded email for those readers.
  for (const { key, out } of RENDERED) {
    assert.doesNotMatch(String(out.html), /<img\s/i, `${key} uses a remote image`);
  }
});

test("the source no longer references the retired logo constant", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "utils", "emailService.js"),
    "utf8"
  );
  assert.doesNotMatch(source, /const LOGO_URL/, "LOGO_URL should be gone");
});

console.log("\nSafety");

test("no template leaks a Mongo id, Stripe id or secret", () => {
  for (const { key, body } of RENDERED) {
    assert.doesNotMatch(body, /\bsk_(live|test)_/, `${key} leaks a Stripe secret`);
    assert.doesNotMatch(body, /\bwhsec_/, `${key} leaks a webhook secret`);
    assert.doesNotMatch(body, /\b(cs_|pi_|sub_|cus_)[A-Za-z0-9]{10,}/, `${key} leaks a Stripe id`);
  }
});

test("customer-supplied text is escaped, not injected", () => {
  const nasty = "<script>alert(1)</script>";
  const built = TEMPLATES.booking_reminder_24h({ ...VARS, address: nasty, name: nasty });
  assert.doesNotMatch(built.html, /<script>/, "customer text must never render as markup");
  assert.match(built.html, /&lt;script&gt;/, "it should appear escaped instead");
});

test("an action link can only point at our own site", () => {
  assert.equal(safeActionUrl("javascript:alert(1)"), "");
  assert.equal(safeActionUrl("http://evil.example.com"), "");
  assert.equal(safeActionUrl("//evil.example.com"), "");
  assert.match(safeActionUrl("/admin?tab=bookings"), /^https:\/\//);
  assert.equal(safeActionUrl("https://www.profixter.com/admin"), "https://www.profixter.com/admin");
});

console.log("\nOperational emails are notifications, not database dumps");

test("the shell keeps the event, the person and the value distinct", () => {
  const out = renderOperationalEmail({
    subject: "New booking - John Smith",
    event: "New booking",
    who: "John Smith",
    highlight: "Mon, Aug 18 at 10:00 AM",
    rows: [["Address", "123 Main St"], ["Visit", "Membership visit"]],
    action: { label: "View Booking", url: adminLink.booking("abc123") },
  });
  assert.match(out.html, /New booking/);
  assert.match(out.html, /John Smith/);
  assert.match(out.html, /Mon, Aug 18 at 10:00 AM/);
  assert.match(out.html, /View Booking/);
  assert.match(out.text, /^New booking\nJohn Smith/);
});

test("empty rows are dropped rather than rendered as dashes", () => {
  const out = renderOperationalEmail({
    subject: "s", event: "e",
    rows: [["Kept", "yes"], ["Dropped", ""], ["AlsoDropped", null]],
  });
  assert.match(out.html, /Kept/);
  assert.doesNotMatch(out.html, /Dropped/);
});

test("operational emails use squared corners and no emoji as structure", () => {
  const out = renderOperationalEmail({ subject: "s", event: "e", rows: [["a", "b"]] });
  assert.doesNotMatch(out.html, /border-radius:\s*(1[2-9]|[2-9]\d)px/, "no pill geometry");
  assert.doesNotMatch(out.html, /[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}]/u, "no emoji");
});

test("an admin notification stays short", () => {
  // The bound is the point: this test fails the moment someone starts adding
  // "just one more field" back onto a notification.
  const out = renderAdminEventEmail({
    subject: "One-time visit paid - Sam",
    heading: "One-time visit paid",
    who: "Sam Carter",
    highlight: "$99.00",
    fields: [["When", "Mon"], ["Task", "TV"], ["Address", "1 St"], ["Phone", "x"], ["Booking", "#1"]],
    action: { label: "View Booking", url: "/admin?tab=bookings" },
  });
  const rows = (out.html.match(/<tr>/g) || []).length;
  assert.ok(rows <= 12, `an admin notification should stay compact, got ${rows} rows`);
  assert.match(out.html, /View Booking/, "and should offer one way into Admin");
});

console.log("\nDead templates are gone");

test("templates with no call site were removed", () => {
  for (const key of [
    "estimate_lead_admin",
    "exterior_lead_admin",
    "password_reset",
    "promo_generic",
    "service_request_admin",
  ]) {
    assert.equal(TEMPLATES[key], undefined, `${key} should have been removed`);
  }
});

test("every remaining template is actually reachable from application code", () => {
  const roots = ["routes", "jobs", "utils", "controllers", "middleware"];
  let source = "";
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) source += fs.readFileSync(full, "utf8");
    }
  };
  for (const root of roots) {
    const dir = path.join(__dirname, "..", root);
    if (fs.existsSync(dir)) walk(dir);
  }
  source += fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

  const unreachable = RENDERED.map((r) => r.key).filter(
    (key) => !new RegExp(`["'\`]${key}["'\`]`).test(source)
  );
  assert.deepEqual(unreachable, [], `no call site for: ${unreachable.join(", ")}`);
});

console.log("\nSubjects");

test("no subject carries an internal identifier or is empty", () => {
  for (const { key, out } of RENDERED) {
    const subject = String(out.subject);
    assert.doesNotMatch(subject, /[0-9a-f]{24}/, `${key} subject leaks an id`);
    assert.ok(subject.length <= 90, `${key} subject is ${subject.length} chars`);
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`\n${f.name}\n`, f.error);
  process.exit(1);
}
