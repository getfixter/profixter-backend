/*
 * Employee access: every Admin section, every kind of staff account, real routes.
 *
 *   node scripts/test_admin_access.js
 *
 * In-memory Mongo, the real routers and the real auth middleware. For each
 * account the test calls one or more endpoints of every section and checks
 * the server's answer: allowed means anything but 401/403 (a handler may still
 * 404 a made-up id), denied means 403. The expected answer comes from the
 * registry (utils/adminAccess.js), so a section added there is covered here.
 *
 * What it pins:
 * - the owner reaches everything, including owner-only tools
 * - an employee reaches exactly the sections switched on, nothing else
 * - zero sections: can sign in, reaches no section
 * - disabled: denied everywhere, re-enabled: back
 * - existing Fixter / General Fixter: exactly the access they had before
 * - managing employees is owner-only, so no employee can grant themselves more
 * - a permission removed or added takes effect on the very next request
 * - All Users acts on customers only, never the owner or staff
 * - Overview access does not reveal customer emails
 * - changes are written to the activity log with before and after
 */
const assert = require("assert");
const express = require("express");
const fetch = require("node-fetch");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-not-real";
process.env.MAIL_ADMIN = "owner@example.com";
process.env.S3_BUCKET = process.env.S3_BUCKET || "test-bucket";
process.env.AWS_REGION = process.env.AWS_REGION || "us-east-1";

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error?.message || error}`);
  }
}
const section = (t) => console.log(`\n${t}`);

async function main() {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  const User = require("../models/User");
  const AdminActivityLog = require("../models/AdminActivityLog");
  const { PERMISSIONS, SECTIONS, POSITIONS } = require("../utils/adminAccess");
  const { permissionsForUser } = require("../middleware/authorize");

  const app = express();
  app.use(express.json());
  // Mounted in server.js order for the routers under test.
  app.use("/api/auth", require("../routes/auth"));
  app.use("/api", require("../routes/promotionPopup"));
  app.use("/api/admin/overview", require("../routes/adminOverview"));
  app.use("/api/admin/calendar", require("../routes/adminCalendarShadow"));
  app.use("/api/admin/projects", require("../routes/projects"));
  app.use("/api/admin/invoices", require("../routes/adminInvoices"));
  app.use("/api/admin/fixters", require("../routes/fixters"));
  app.use("/api/admin/tips", require("../routes/adminTips"));
  app.use("/api/admin/email-logs", require("../routes/adminEmailLogs"));
  app.use("/api/admin/communications", require("../routes/adminCommunications"));
  app.use("/api/admin/recent-work", require("../routes/adminRecentWork"));
  app.use("/api/admin/gifts", require("../routes/adminGifts"));
  app.use("/api/admin", require("../routes/adminCampaigns"));
  app.use("/api/admin", require("../routes/admin"));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  let seq = 0;
  const mk = (over) =>
    User.create({
      userId: String(10000000 + ++seq),
      name: over.name || `User ${seq}`,
      email: over.email || `user${seq}@example.com`,
      phone: "+16315550" + String(100 + seq),
      password: "x",
      role: "customer",
      ...over,
    });

  const owner = await mk({ name: "Owner", email: "owner@example.com", role: "customer" });
  const customer = await mk({ name: "Casey Customer", email: "casey@example.com" });
  const fixter = await mk({ name: "Fred Fixter", role: "employee", employeePosition: "Fixter" });
  const general = await mk({ name: "Gina General", role: "employee", employeePosition: "General Fixter" });
  const emp = (name, sections, extra = {}) => mk({ name, role: "employee", employeePosition: null, employeeTitle: "Marketing Manager", adminSections: sections, ...extra });
  const overviewOnly = await emp("Olive Overview", ["overview"]);
  const photosOnly = await emp("Pat Photos", ["recent-work"]);
  const both = await emp("Bo Both", ["overview", "customer-map", "recent-work"]);
  const zero = await emp("Zed Zero", []);
  const disabled = await emp("Dee Disabled", ["overview", "customers"], { isActive: false });
  const allSections = await emp("Al All", SECTIONS.map((s) => s.id));

  const token = (u) => jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET);
  const call = (method, path, user, body) =>
    fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(user ? { Authorization: `Bearer ${token(user)}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  const fakeId = new mongoose.Types.ObjectId().toString();

  /* One or more endpoints per permission; the owner-only ones last. */
  const MATRIX = [
    [PERMISSIONS.ANALYTICS_READ, "GET", "/api/admin/overview?range=30d"],
    [PERMISSIONS.ANALYTICS_MAP, "GET", "/api/admin/overview/map"],
    [PERMISSIONS.MEMBERS_READ, "GET", "/api/admin/members"],
    [PERMISSIONS.CUSTOMERS_MANAGE, "GET", "/api/admin/users"],
    [PERMISSIONS.CUSTOMERS_MANAGE, "GET", `/api/admin/users/${customer._id}/sms-consent`],
    [PERMISSIONS.CUSTOMERS_MANAGE, "PUT", `/api/admin/users/${customer._id}`, { name: "Casey Customer" }],
    [PERMISSIONS.LEADS_MANAGE, "GET", "/api/admin/requests"],
    [PERMISSIONS.PROJECTS_MANAGE, "GET", "/api/admin/projects"],
    [PERMISSIONS.PROJECTS_MANAGE, "GET", `/api/admin/invoices/project/${fakeId}`],
    [PERMISSIONS.BOOKINGS_READ, "GET", "/api/admin/bookings"],
    [PERMISSIONS.BOOKINGS_ASSIGN, "GET", "/api/admin/booking-assignees"],
    [PERMISSIONS.SCHEDULE_READ, "GET", "/api/admin/calendar/technicians"],
    [PERMISSIONS.RECENT_WORK_MANAGE, "GET", "/api/admin/recent-work"],
    [PERMISSIONS.RECENT_WORK_MANAGE, "PATCH", `/api/admin/recent-work/${fakeId}`, { title: "x" }],
    [PERMISSIONS.RECENT_WORK_MANAGE, "DELETE", `/api/admin/recent-work/${fakeId}`],
    [PERMISSIONS.COMMUNICATIONS_MANAGE, "GET", "/api/admin/communications/templates"],
    [PERMISSIONS.COMMUNICATIONS_MANAGE, "GET", "/api/admin/segments"],
    [PERMISSIONS.COMMUNICATIONS_MANAGE, "GET", "/api/admin/email-logs"],
    [PERMISSIONS.PROMOTION_MANAGE, "GET", "/api/admin/promotion-popup"],
    [PERMISSIONS.BLACKLIST_MANAGE, "GET", "/api/admin/blacklist"],
    [PERMISSIONS.ACTIVITY_READ, "GET", "/api/admin/activity-log"],
    [PERMISSIONS.TIPS_READ, "GET", "/api/admin/tips"],
    [PERMISSIONS.ADMIN, "GET", "/api/admin/fixters"],
    [PERMISSIONS.ADMIN, "GET", "/api/admin/fixters/access-registry"],
    [PERMISSIONS.ADMIN, "POST", "/api/admin/fixters", { firstName: "Sneaky", lastName: "Self", email: "sneak@example.com", employeeTitle: "x", adminSections: ["customers"] }],
    [PERMISSIONS.ADMIN, "GET", "/api/admin/one-time-visit-settings"],
    [PERMISSIONS.ADMIN, "DELETE", `/api/admin/users/${fakeId}`],
    [PERMISSIONS.ADMIN, "GET", "/api/admin/gifts"],
    [PERMISSIONS.ADMIN, "GET", "/api/admin/bookings/reminders/debug"],
  ];

  const expectFor = (user, permission) => {
    if (String(user.email) === "owner@example.com") return "allow";
    if (permission === PERMISSIONS.ADMIN) return "deny";
    return permissionsForUser(user).includes(permission) ? "allow" : "deny";
  };

  async function sweep(label, user, { expectAll } = {}) {
    const wrong = [];
    for (const [permission, method, path, body] of MATRIX) {
      // The map is also behind Overview, so it needs both.
      let want = expectAll || expectFor(user, permission);
      if (!expectAll && permission === PERMISSIONS.ANALYTICS_MAP && expectFor(user, PERMISSIONS.ANALYTICS_READ) === "deny") want = "deny";
      const res = await call(method, path, user, body);
      const got = res.status === 401 || res.status === 403 ? "deny" : "allow";
      if (got !== want) wrong.push(`${method} ${path} -> ${res.status} (wanted ${want})`);
    }
    assert.deepStrictEqual(wrong, [], wrong.join("\n        "));
  }

  section("Who reaches what (every section, through the real routes)");
  await test("owner: every section and every owner-only tool", () => sweep("owner", owner));
  await test("Overview-only employee: Overview, nothing else", () => sweep("overview", overviewOnly));
  await test("Photos-only employee: Recent Work, not Overview, nothing else", () => sweep("photos", photosOnly));
  await test("Overview + Customer Map + Photos: exactly those", () => sweep("both", both));
  await test("zero sections: no section at all", () => sweep("zero", zero));
  await test("every section granted: still none of the owner-only tools", () => sweep("all", allSections));
  await test("disabled employee: denied everywhere", () => sweep("disabled", disabled, { expectAll: "deny" }));
  await test("existing Fixter: exactly what Fixters had", () => sweep("fixter", fixter));
  await test("existing General Fixter: exactly what General Fixters had", () => sweep("general", general));
  await test("a customer: no Admin at all", () => sweep("customer", customer, { expectAll: "deny" }));
  await test("no token: 401", async () => assert.strictEqual((await call("GET", "/api/admin/overview")).status, 401));
  await test("expired session: 401", async () => {
    const old = jwt.sign({ id: String(overviewOnly._id) }, process.env.JWT_SECRET, { expiresIn: -10 });
    const res = await fetch(`${base}/api/admin/overview`, { headers: { Authorization: `Bearer ${old}` } });
    assert.strictEqual(res.status, 401);
  });

  section("Existing staff kept exactly what they had (no migration, no new access)");
  await test("Fixter permissions are the pre-registry list", async () => {
    assert.deepStrictEqual(permissionsForUser(fixter).sort(), ["bookings.read", "bookings.write", "tips.read"]);
  });
  await test("General Fixter permissions are the pre-registry list", async () => {
    assert.deepStrictEqual(permissionsForUser(general).sort(), [...POSITIONS["General Fixter"]].sort());
  });
  await test("an employee record from before (no title, no sections fields) gets only its position", async () => {
    const legacy = await User.collection.insertOne({ userId: "99999998", name: "Legacy Fixter", email: "legacy@example.com", password: "x", role: "employee", employeePosition: "Fixter", isActive: true });
    const u = await User.findById(legacy.insertedId).lean();
    assert.deepStrictEqual(permissionsForUser(u).sort(), ["bookings.read", "bookings.write", "tips.read"]);
  });
  await test("the owner's key is never in any section or position", async () => {
    for (const s of SECTIONS) assert.ok(!s.permissions.includes(PERMISSIONS.ADMIN), s.id);
    for (const p of Object.values(POSITIONS)) assert.ok(!p.includes(PERMISSIONS.ADMIN));
  });
  await test("an unknown section id stored on a user grants nothing", async () => {
    const odd = await emp("Odd Data", ["settings", "employees", "admin.all", "overview"]);
    assert.deepStrictEqual(permissionsForUser(odd), [PERMISSIONS.ANALYTICS_READ]);
  });
  await test("Customer Map without Overview is dropped", async () => {
    const mapOnly = await emp("Map Only", ["customer-map"]);
    assert.deepStrictEqual(permissionsForUser(mapOnly), []);
  });

  section("/api/auth/me tells the frontend what to show");
  await test("employee: title, sections and computed permissions; no owner flag", async () => {
    const me = await (await call("GET", "/api/auth/me", both)).json();
    assert.strictEqual(me.employeeTitle, "Marketing Manager");
    assert.deepStrictEqual(me.adminSections, ["overview", "customer-map", "recent-work"]);
    assert.deepStrictEqual(me.permissions.sort(), ["analytics.map", "analytics.read", "recentWork.manage"]);
    assert.strictEqual(me.isOwner, false);
  });
  await test("owner: isOwner and every permission", async () => {
    const me = await (await call("GET", "/api/auth/me", owner)).json();
    assert.strictEqual(me.isOwner, true);
    assert.ok(me.permissions.includes("admin.all") && me.permissions.includes("recentWork.manage"));
  });

  section("The owner creates and edits an employee; access follows on the next request");
  let john;
  await test("Add Employee: title is free text, sections are what was switched on", async () => {
    const res = await call("POST", "/api/admin/fixters", owner, {
      firstName: "John", lastName: "Smith", email: "john@example.com", phone: "", employeePosition: "",
      employeeTitle: "Marketing Manager", adminSections: ["overview", "recent-work", "nonsense"],
    });
    assert.strictEqual(res.status, 201, await res.clone().text());
    john = (await res.json()).fixter;
    assert.strictEqual(john.employeeTitle, "Marketing Manager");
    assert.deepStrictEqual(john.adminSections, ["overview", "recent-work"]);
    assert.strictEqual(john.employeePosition, null);
  });
  const johnUser = async () => User.findById(john.id).lean();
  await test("John reaches Overview and Recent Work, not All Users", async () => {
    const u = await johnUser();
    assert.notStrictEqual((await call("GET", "/api/admin/overview?range=30d", u)).status, 403);
    assert.notStrictEqual((await call("GET", "/api/admin/recent-work", u)).status, 403);
    assert.strictEqual((await call("GET", "/api/admin/users", u)).status, 403);
  });
  await test("owner turns All Users on: the next request is allowed", async () => {
    const res = await call("PUT", `/api/admin/fixters/${john.id}`, owner, {
      firstName: "John", lastName: "Smith", phone: "", employeePosition: "", employeeTitle: "Marketing Manager",
      adminSections: ["overview", "recent-work", "customers"],
    });
    assert.strictEqual(res.status, 200, await res.clone().text());
    assert.strictEqual((await call("GET", "/api/admin/users", await johnUser())).status, 200);
  });
  await test("owner removes Overview: the next request is denied", async () => {
    await call("PUT", `/api/admin/fixters/${john.id}`, owner, {
      firstName: "John", lastName: "Smith", phone: "", employeePosition: "", employeeTitle: "Marketing Manager",
      adminSections: ["recent-work", "customers"],
    });
    assert.strictEqual((await call("GET", "/api/admin/overview?range=30d", await johnUser())).status, 403);
  });
  await test("an edit that does not send sections keeps them (older client)", async () => {
    await call("PUT", `/api/admin/fixters/${john.id}`, owner, { firstName: "John", lastName: "Smith", phone: "", employeePosition: "", employeeTitle: "Growth Lead" });
    const u = await johnUser();
    assert.deepStrictEqual(u.adminSections, ["customers", "recent-work"]);
    assert.strictEqual(u.employeeTitle, "Growth Lead");
  });
  await test("disable: denied at once; enable: back, with the same sections", async () => {
    await call("PATCH", `/api/admin/fixters/${john.id}/status`, owner, { isActive: false });
    assert.strictEqual((await call("GET", "/api/admin/recent-work", await johnUser())).status, 403);
    assert.strictEqual((await call("GET", "/api/auth/me", await johnUser())).status, 403);
    await call("PATCH", `/api/admin/fixters/${john.id}/status`, owner, { isActive: true });
    assert.strictEqual((await call("GET", "/api/admin/recent-work", await johnUser())).status, 200);
  });
  await test("an office employee cannot be the default Fixter for new jobs", async () => {
    const res = await call("PATCH", `/api/admin/fixters/${john.id}/default`, owner, { isDefault: true });
    assert.strictEqual(res.status, 400);
  });
  await test("a Fixter still needs a phone; an office employee does not", async () => {
    const res = await call("POST", "/api/admin/fixters", owner, { firstName: "No", lastName: "Phone", email: "nophone@example.com", phone: "", employeePosition: "Fixter" });
    assert.strictEqual(res.status, 400);
  });
  await test("the title is display only: 'Owner' or 'Admin' as a title grants nothing", async () => {
    const res = await call("POST", "/api/admin/fixters", owner, { firstName: "Tit", lastName: "Le", email: "title@example.com", employeeTitle: "Admin Owner", adminSections: [] });
    const u = await User.findById((await res.json()).fixter.id).lean();
    assert.deepStrictEqual(permissionsForUser(u), []);
  });

  section("Activity log");
  await test("created, permissions changed (before/after), title changed, disabled, enabled", async () => {
    const logs = await AdminActivityLog.find({ entityType: "employee", entityId: john.id }).sort({ createdAt: 1 }).lean();
    const actions = logs.map((l) => l.action);
    for (const a of ["Employee Created", "Employee Permissions Changed", "Employee Title Changed", "Employee Disabled", "Employee Enabled"]) assert.ok(actions.includes(a), `${a} missing: ${actions.join(", ")}`);
    const perm = logs.find((l) => l.action === "Employee Permissions Changed");
    assert.deepStrictEqual(perm.details.before, ["Overview", "Recent Work / Photos"]);
    assert.deepStrictEqual(perm.details.added, ["All Users"]);
    assert.strictEqual(String(perm.actorUserId), String(owner._id));
  });

  section("Least privilege inside sections");
  await test("All Users cannot touch the owner's account", async () => {
    const res = await call("PUT", `/api/admin/users/${owner._id}`, allSections, { name: "Hacked" });
    assert.strictEqual(res.status, 403);
    assert.strictEqual((await User.findById(owner._id).lean()).name, "Owner");
  });
  await test("All Users cannot touch another employee", async () => {
    assert.strictEqual((await call("PUT", `/api/admin/users/${fixter._id}`, allSections, { phone: "" })).status, 403);
  });
  await test("Blacklist cannot block the owner or staff", async () => {
    assert.strictEqual((await call("POST", `/api/admin/blacklist/${owner._id}`, allSections)).status, 403);
    assert.strictEqual((await call("POST", `/api/admin/blacklist/${general._id}`, allSections)).status, 403);
  });
  await test("the All Users list an employee sees holds customers only", async () => {
    const rows = await (await call("GET", "/api/admin/users", allSections)).json();
    const emails = rows.map((r) => r.email);
    assert.ok(emails.includes("casey@example.com"));
    assert.ok(!emails.includes("owner@example.com"), "owner listed");
  });
  await test("the owner still edits any account as before", async () => {
    assert.strictEqual((await call("PUT", `/api/admin/users/${customer._id}`, owner, { name: "Casey C" })).status, 200);
  });
  await test("Overview drill-down: no customer emails without All Users", async () => {
    const res = await (await call("GET", "/api/admin/overview/list?range=30d&metric=newCustomers", overviewOnly)).json();
    assert.ok(Array.isArray(res.rows) && res.rows.length > 0, "expected rows");
    assert.ok(res.rows.every((r) => !("email" in r)), JSON.stringify(res.rows[0]));
    const ownerRes = await (await call("GET", "/api/admin/overview/list?range=30d&metric=newCustomers", owner)).json();
    assert.ok(ownerRes.rows.some((r) => r.email), "owner keeps emails");
  });
  await test("no employee can manage employees, so none can grant themselves more", async () => {
    for (const u of [allSections, both, general]) {
      assert.strictEqual((await call("PUT", `/api/admin/fixters/${u._id}`, u, { firstName: "A", lastName: "B", adminSections: SECTIONS.map((s) => s.id) })).status, 403);
    }
  });

  server.close();
  await mongoose.disconnect();
  await mongod.stop();
  console.log(`\n${passed}/${passed + failures.length} checks passed`);
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
