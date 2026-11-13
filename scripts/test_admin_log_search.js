/**
 * Admin log searches keep free text out of URLs, and the campaign list.
 *
 *   - POST /api/admin/email-logs/search, /sms/messages/search,
 *     /sms/opt-outs/search, /sms/phone-status/search and
 *     /api/admin/activity-log/search take the same filters as their GETs, in
 *     the JSON body, and answer the same shape; the GETs still work;
 *   - an operator object in the body never reaches Mongo;
 *   - SMS opt-outs and phone statuses report totalPages like the other lists;
 *   - GET /api/admin/campaigns lists campaigns with totals, paged, staff-only.
 *
 * In-memory Mongo, real routers and real JWT auth. Nothing is sent.
 *
 *   node scripts/test_admin_log_search.js
 */
Object.assign(process.env, {
  NODE_ENV: "test",
  S3_BUCKET: "test-bucket",
  AWS_REGION: "us-east-1",
  JWT_SECRET: "test-secret-admin-log-search",
  STRIPE_SECRET_KEY: "sk_test_fake_never_called",
  MAIL_ADMIN: "owner@example.com",
  CLIENT_URL: "https://www.profixter.com",
  SMS_ENABLED: "false",
});

const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const User = require("../models/User");
const EmailLog = require("../models/EmailLog");
const SmsMessage = require("../models/SmsMessage");
const SmsOptOut = require("../models/SmsOptOut");
const SmsPhoneStatus = require("../models/SmsPhoneStatus");
const AdminActivityLog = require("../models/AdminActivityLog");
const EmailCampaign = require("../models/EmailCampaign");
const EmailCampaignRecipient = require("../models/EmailCampaignRecipient");
const { SECTIONS_VERSION } = require("../utils/adminAccess");

const app = express();
app.use(express.json());
app.use("/api/admin/email-logs", require("../routes/adminEmailLogs"));
app.use("/api/admin/sms", require("../routes/adminSms"));
app.use("/api/admin", require("../routes/adminCampaigns"));
app.use("/api/admin", require("../routes/admin"));

let base;
let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error.stack}`);
  }
}

const token = (user) => jwt.sign({ id: String(user._id), tv: 0 }, process.env.JWT_SECRET);
async function call(method, path, user, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(user ? { Authorization: `Bearer ${token(user)}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = {};
  try {
    json = await response.json();
  } catch {
    json = {};
  }
  return { status: response.status, body: json };
}
const ids = (res) => res.body.items.map((i) => String(i._id || i.id));

async function run() {
  const owner = await User.create({ userId: "90000001", name: "Owner", email: "owner@example.com", role: "admin" });
  const clerk = await User.create({ userId: "90000002", name: "Clerk", email: "clerk@example.com", role: "employee", adminSections: ["customers"], adminSectionsVersion: SECTIONS_VERSION });
  const now = new Date();

  await EmailLog.collection.insertMany([
    { templateKey: "booking_confirmed", subject: "Your visit with Smith", recipientEmail: "smith@example.com", customerName: "John Smith", status: "sent", createdAt: new Date(now - 3000) },
    { templateKey: "booking_confirmed", subject: "Your visit", recipientEmail: "ann@example.com", customerName: "Ann Jones", status: "sent", createdAt: new Date(now - 2000) },
    { templateKey: "invoice", subject: "Invoice", recipientEmail: "smith@example.com", customerName: "John Smith", status: "failed", createdAt: new Date(now - 1000) },
  ]);
  await SmsMessage.collection.insertMany([
    { notificationType: "booking_reminder", toPhone: "+16315991363", recipientName: "John Smith", body: "Reminder for Smith", status: "delivered", dedupeKey: "a", createdAt: new Date(now - 2000) },
    { notificationType: "booking_reminder", toPhone: "+15165550000", recipientName: "Ann Jones", body: "Reminder", status: "delivered", dedupeKey: "b", createdAt: new Date(now - 1000) },
  ]);
  await SmsOptOut.collection.insertMany([
    { phone: "+16315991363", scope: "all", source: "carrier_keyword", optedOutAt: new Date(now - 2000) },
    { phone: "+15165550000", scope: "marketing", source: "admin", optedOutAt: new Date(now - 1000) },
    { phone: "+15165550001", scope: "all", source: "admin", optedOutAt: new Date(now - 500) },
  ]);
  await SmsPhoneStatus.collection.insertMany([
    { phone: "+16315991363", status: "undeliverable", updatedAt: now },
    { phone: "+15165550000", status: "valid", updatedAt: now },
  ]);
  await AdminActivityLog.collection.insertMany([
    { action: "Customer Edited", entityType: "user", entityName: "John Smith", actorName: "Owner", createdAt: new Date(now - 2000) },
    { action: "Booking Rescheduled", entityType: "Booking", entityName: "Ann Jones", actorName: "Owner", createdAt: new Date(now - 1000) },
  ]);

  console.log("\nPOST search variants");

  await test("email logs: POST /search matches GET ?search=, filters combine, totals and paging agree", async () => {
    const get = await call("GET", "/api/admin/email-logs?search=smith&status=sent", owner);
    const post = await call("POST", "/api/admin/email-logs/search", owner, { search: "smith", status: "sent" });
    assert.equal(post.status, 200, JSON.stringify(post.body));
    assert.deepEqual(ids(post), ids(get));
    assert.equal(post.body.total, 1);
    assert.equal(post.body.totalPages, 1);
    const paged = await call("POST", "/api/admin/email-logs/search", owner, { search: "smith", limit: 1, page: 2 });
    assert.equal(paged.body.total, 2);
    assert.equal(paged.body.items.length, 1);
    assert.equal(paged.body.page, 2);
    assert.equal((await call("POST", "/api/admin/email-logs/search", clerk, { search: "smith" })).status, 403);
  });

  await test("an operator object in the body is ignored, never sent to Mongo", async () => {
    const res = await call("POST", "/api/admin/email-logs/search", owner, { recipientEmail: { $ne: "" }, status: { $gt: "" } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.total, 3, "the object filters were dropped, not applied");
    const activity = await call("POST", "/api/admin/activity-log/search", owner, { actorUserId: { $ne: null } });
    assert.equal(activity.status, 200, JSON.stringify(activity.body));
    assert.equal(activity.body.total, 2);
  });

  await test("activity log: POST /activity-log/search matches the GET", async () => {
    const get = await call("GET", "/api/admin/activity-log?search=smith", owner);
    const post = await call("POST", "/api/admin/activity-log/search", owner, { search: "smith" });
    assert.equal(post.status, 200, JSON.stringify(post.body));
    assert.deepEqual(ids(post), ids(get));
    assert.equal(post.body.total, 1);
    assert.equal(post.body.items[0].entityName, "John Smith");
    assert.ok("totalPages" in post.body);
  });

  await test("SMS messages: POST /messages/search with a pasted phone and free text", async () => {
    const post = await call("POST", "/api/admin/sms/messages/search", owner, { phone: "(631) 599-1363" });
    assert.equal(post.status, 200, JSON.stringify(post.body));
    assert.equal(post.body.total, 1);
    assert.equal(post.body.items[0].recipientName, "John Smith");
    const text = await call("POST", "/api/admin/sms/messages/search", owner, { search: "smith" });
    const get = await call("GET", "/api/admin/sms/messages?search=smith", owner);
    assert.deepEqual(ids(text), ids(get));
  });

  await test("SMS opt-outs and phone status: POST search by phone, and totalPages like the other lists", async () => {
    const list = await call("GET", "/api/admin/sms/opt-outs?limit=2", owner);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(list.body.total, 3);
    assert.equal(list.body.totalPages, 2);
    const found = await call("POST", "/api/admin/sms/opt-outs/search", owner, { phone: "631-599-1363" });
    assert.equal(found.status, 200, JSON.stringify(found.body));
    assert.equal(found.body.total, 1);
    assert.equal(found.body.totalPages, 1);
    assert.equal(found.body.items[0].phone, "+16315991363");
    const scoped = await call("POST", "/api/admin/sms/opt-outs/search", owner, { scope: "all" });
    assert.equal(scoped.body.total, 2);
    const status = await call("POST", "/api/admin/sms/phone-status/search", owner, { phone: "(631) 599-1363" });
    assert.equal(status.status, 200, JSON.stringify(status.body));
    assert.equal(status.body.total, 1);
    assert.equal(status.body.totalPages, 1);
    assert.equal(status.body.items[0].status, "undeliverable");
  });

  console.log("\nCampaign list");

  await test("GET /campaigns lists newest first with totals from the queue, paged, without bodies", async () => {
    const older = await EmailCampaign.create({ campaignNumber: "C-0001", subject: "Old news", body: "secret body text", selectedSegment: "all", status: "completed", sentCount: 7, failedCount: 1, skippedCount: 2, actorName: "Owner", actorUserId: owner._id, createdAt: new Date(now - 864e5) });
    const newer = await EmailCampaign.create({ campaignNumber: "C-0002", subject: "Fall tune-up", body: "another secret body", selectedSegment: "plus", status: "sending", excludedCount: 1, totalRecipients: 5, actorName: "Owner", actorUserId: owner._id });
    const rows = ["sent", "sent", "failed", "pending", "skipped"].map((status, index) => ({ campaignId: newer._id, index, email: `r${index}@example.com`, status }));
    await EmailCampaignRecipient.insertMany(rows);

    const res = await call("GET", "/api/admin/campaigns?limit=1", owner);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.total, 2);
    assert.equal(res.body.totalPages, 2);
    const first = res.body.items[0];
    assert.equal(first.id, String(newer._id));
    assert.equal(first.subject, "Fall tune-up");
    assert.equal(first.segment, "plus");
    assert.equal(first.status, "sending");
    assert.deepEqual(first.totals, { queued: 1, sent: 2, failed: 1, skipped: 2, total: 5 });
    assert.deepEqual(first.createdBy, { id: String(owner._id), name: "Owner" });
    const second = await call("GET", "/api/admin/campaigns?limit=1&page=2", owner);
    assert.equal(second.body.items[0].id, String(older._id));
    assert.deepEqual(second.body.items[0].totals, { queued: 0, sent: 7, failed: 1, skipped: 2, total: 10 }, "stored counters before the queue existed");
    const text = JSON.stringify([res.body, second.body]);
    assert.ok(!text.includes("secret body"), "no campaign body in the list");
    assert.ok(!text.includes("r0@example.com"), "no recipient addresses in the list");
    assert.equal((await call("GET", "/api/admin/campaigns", clerk)).status, 403);
  });
}

(async () => {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await User.syncIndexes();
  const server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run();
  } finally {
    server.close();
    await mongoose.disconnect();
    await mongod.stop();
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
  process.exit(0);
})();
