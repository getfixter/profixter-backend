/**
 * Durable email campaign sending (U-8 / X-03).
 *
 * Drives the real /api/admin/campaigns router over HTTP against an in-memory
 * MongoDB. The email provider is a fake injected through require.cache, so no
 * message can leave the machine.
 *
 *   node scripts/test_campaign_send_queue.js
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-campaign-secret";
process.env.EMAIL_BATCH_SIZE = "3";
process.env.EMAIL_BATCH_DELAY_MS = "0";
process.env.CAMPAIGN_SEND_RESPONSE_WAIT_MS = "0";
// The tests drive the worker themselves, so the request does not start it.
process.env.CAMPAIGN_SEND_IMMEDIATE = "false";
process.env.MAIL_ADMIN = "owner@profixter.test";

const assert = require("assert");
const http = require("http");

/* ------------------------------ fakes ------------------------------ */

const sent = []; // every email the fake provider accepted
const provider = { failFor: new Set(), throwAfter: Infinity };
const fakeEmail = {
  async sendPromo(to, payload) {
    if (sent.length >= provider.throwAfter) throw new Error("Injected provider outage");
    if (provider.failFor.has(to)) throw new Error("Injected bounce");
    sent.push({ to, subject: payload.subject, logContext: payload.logContext, headers: payload.headers });
    return { messageId: `msg-${sent.length}` };
  },
  async sendRaw() {
    throw new Error("sendRaw must not be called by campaigns");
  },
  async sendTx() {
    throw new Error("sendTx must not be called by campaigns");
  },
};

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
stub("../utils/emailService", fakeEmail);

const ADMIN = { id: null };
stub("../middleware/auth", (req, _res, next) => {
  req.user = { id: ADMIN.id };
  req.authUser = { _id: ADMIN.id, email: "owner@profixter.test", name: "Owner", role: "admin" };
  req.accessUser = { _id: ADMIN.id, email: "owner@profixter.test", name: "Owner" };
  next();
});
stub("../middleware/authorize", {
  PERMISSIONS: { COMMUNICATIONS_MANAGE: "communications.manage" },
  requirePermission: () => [(_req, _res, next) => next()],
});

const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const User = require("../models/User");
const EmailCampaign = require("../models/EmailCampaign");
const EmailCampaignRecipient = require("../models/EmailCampaignRecipient");
const EmailSuppression = require("../models/EmailSuppression");
const AdminActivityLog = require("../models/AdminActivityLog");
const sender = require("../jobs/campaignSender");

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.stack || err.message}`);
  }
}

let base = "";
async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

async function seedCustomers(n) {
  const docs = [];
  for (let i = 0; i < n; i += 1) {
    docs.push({
      name: `Customer ${i}`,
      userId: `U${1000 + i}`,
      email: `c${i}@example.test`,
      password: "x".repeat(20),
      role: "customer",
      phone: `631555${String(1000 + i)}`,
    });
  }
  await User.collection.insertMany(docs);
}

function sendsTo(email) {
  return sent.filter((row) => row.to === email).length;
}

async function reset() {
  sent.length = 0;
  provider.failFor.clear();
  provider.throwAfter = Infinity;
  await Promise.all([
    EmailCampaign.deleteMany({}),
    EmailCampaignRecipient.deleteMany({}),
    AdminActivityLog.deleteMany({}),
    EmailSuppression.deleteMany({}),
  ]);
}

async function main() {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([EmailCampaign.init(), EmailCampaignRecipient.init()]);
  ADMIN.id = new mongoose.Types.ObjectId();

  const app = express();
  app.use(express.json());
  app.use("/api/admin", require("../routes/adminCampaigns"));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  await seedCustomers(8);
  const BODY = { segment: "all", subject: "Spring tune-up", body: "Hello {{firstName}}", ctaText: "", ctaUrl: "" };

  await test("send queues a campaign with a recipient snapshot and the admin copy", async () => {
    await reset();
    const res = await call("POST", "/api/admin/campaigns/send", { ...BODY, idempotencyKey: "k-1" });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.match(res.body.campaignId, /^EML-\d{4}-\d{5}$/);
    assert.strictEqual(res.body.total, 8);
    assert.strictEqual(res.body.adminCopySent, true);
    assert.ok(["queued", "sending", "completed"].includes(res.body.status));
    const campaign = await EmailCampaign.findById(res.body.id).lean();
    assert.strictEqual(campaign.idempotencyKey, "k-1");
    assert.strictEqual(await EmailCampaignRecipient.countDocuments({ campaignId: campaign._id }), 8);
    assert.strictEqual(sendsTo("owner@profixter.test"), 1, "admin copy sent once");
    // Let the in-process kick finish before the next test.
    await sender.processCampaign(campaign._id);
  });

  await test("activity log records the queued campaign", async () => {
    const log = await AdminActivityLog.findOne({ action: "email_campaign_queued" }).lean();
    assert.ok(log, "activity log missing");
    assert.strictEqual(log.entityType, "EmailCampaign");
    assert.strictEqual(log.details.recipientCount, 8);
    assert.strictEqual(log.details.segment, "all");
  });

  await test("worker sends every recipient exactly once", async () => {
    await reset();
    const res = await call("POST", "/api/admin/campaigns/send", BODY);
    await sender.processCampaign(res.body.id);
    await sender.runCampaignSenderCycle();
    for (let i = 0; i < 8; i += 1) assert.strictEqual(sendsTo(`c${i}@example.test`), 1, `c${i}`);
    const campaign = await EmailCampaign.findById(res.body.id).lean();
    assert.strictEqual(campaign.status, "completed");
    assert.strictEqual(campaign.sentCount, 8);
    assert.strictEqual(campaign.recipientResults.length, 8);
    const row = sent.find((item) => item.to === "c0@example.test");
    assert.strictEqual(row.logContext.source, "adminCampaignSend");
    assert.strictEqual(row.logContext.templateKey, "campaign");
    assert.ok(row.headers["List-Unsubscribe"], "unsubscribe header kept");
  });

  await test("same idempotencyKey returns the existing campaign and sends nothing", async () => {
    await reset();
    const first = await call("POST", "/api/admin/campaigns/send", { ...BODY, idempotencyKey: "k-dup" });
    await sender.processCampaign(first.body.id);
    const before = sent.length;
    const again = await call("POST", "/api/admin/campaigns/send", { ...BODY, idempotencyKey: "k-dup" });
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.body.id, first.body.id);
    assert.strictEqual(again.body.duplicate, true);
    assert.strictEqual(sent.length, before, "replay must not send");
    assert.strictEqual(await EmailCampaign.countDocuments({}), 1);
  });

  await test("identical segment+subject while still sending returns the in-flight campaign", async () => {
    await reset();
    const first = await call("POST", "/api/admin/campaigns/send", BODY);
    // Hold the campaign as if a worker is mid-send.
    await EmailCampaign.updateOne(
      { _id: first.body.id },
      { $set: { status: "sending", leaseOwner: "other", leaseUntil: new Date(Date.now() + 60000) } }
    );
    const second = await call("POST", "/api/admin/campaigns/send", BODY);
    assert.strictEqual(second.body.id, first.body.id);
    assert.strictEqual(second.body.code, "CAMPAIGN_ALREADY_SENDING");
    assert.strictEqual(await EmailCampaign.countDocuments({}), 1);
    assert.strictEqual(sendsTo("owner@profixter.test"), 1, "no second admin copy");
  });

  await test("crash mid-campaign then resume: nobody is emailed twice, the rest are sent", async () => {
    await reset();
    const res = await call("POST", "/api/admin/campaigns/send", BODY);
    const id = res.body.id;
    // Worker A stops after 4 recipients (process death between batches).
    const a = await sender.processCampaign(id, { owner: "worker-a", stopAfter: 4 });
    assert.strictEqual(a.stopped, true);
    // Simulate worker A dying with one row claimed but not closed.
    const half = await EmailCampaignRecipient.findOneAndUpdate(
      { campaignId: id, status: "pending" },
      { $set: { status: "sending", claimedBy: "worker-a" } },
      { sort: { index: 1 }, new: true }
    );
    // Worker B cannot take over while A's lease is live.
    const blocked = await sender.processCampaign(id, { owner: "worker-b" });
    assert.strictEqual(blocked.claimed, false);
    // A's lease expires.
    await EmailCampaign.updateOne({ _id: id }, { $set: { leaseUntil: new Date(Date.now() - 1000) } });
    const b = await sender.processCampaign(id, { owner: "worker-b" });
    assert.strictEqual(b.finished, true);

    for (let i = 0; i < 8; i += 1) {
      assert.ok(sendsTo(`c${i}@example.test`) <= 1, `c${i} emailed twice`);
    }
    assert.strictEqual(sendsTo(half.email), 0, "interrupted row is never resent");
    const interrupted = await EmailCampaignRecipient.findById(half._id).lean();
    assert.strictEqual(interrupted.status, "failed");
    assert.match(interrupted.error, /interrupted/);
    const campaign = await EmailCampaign.findById(id).lean();
    assert.strictEqual(campaign.sentCount, 7);
    assert.strictEqual(campaign.failedCount, 1);
    assert.strictEqual(campaign.status, "completed_with_errors");
  });

  await test("provider outage leaves failures recorded; resume sends only pending rows", async () => {
    await reset();
    const res = await call("POST", "/api/admin/campaigns/send", BODY);
    const id = res.body.id;
    // Admin copy is sent[0]; allow two customer sends, then the provider fails.
    provider.throwAfter = 3;
    await sender.processCampaign(id, { owner: "worker-a", stopAfter: 3 });
    provider.throwAfter = Infinity;
    const failedRows = await EmailCampaignRecipient.find({ campaignId: id, status: "failed" }).lean();
    assert.strictEqual(failedRows.length, 1);
    await EmailCampaign.updateOne({ _id: id }, { $set: { leaseUntil: new Date(Date.now() - 1000) } });

    const resumed = await call("POST", `/api/admin/campaigns/${id}/resume`);
    assert.strictEqual(resumed.status, 200, JSON.stringify(resumed.body));
    await sender.processCampaign(id);
    for (let i = 0; i < 8; i += 1) assert.ok(sendsTo(`c${i}@example.test`) <= 1, `c${i} twice`);
    assert.strictEqual(sendsTo(failedRows[0].email), 0, "a failed row is not retried");
    const campaign = await EmailCampaign.findById(id).lean();
    assert.strictEqual(campaign.sentCount, 7);
    const log = await AdminActivityLog.findOne({ action: "email_campaign_resumed" }).lean();
    assert.ok(log, "resume is logged");

    const nothing = await call("POST", `/api/admin/campaigns/${id}/resume`);
    assert.strictEqual(nothing.status, 409);
    assert.strictEqual(nothing.body.code, "NOTHING_TO_RESUME");
  });

  await test("an address unsubscribed after queueing is skipped, not sent", async () => {
    await reset();
    const res = await call("POST", "/api/admin/campaigns/send", BODY);
    await EmailSuppression.create({ email: "c2@example.test", reason: "unsubscribe", suppressedAt: new Date() });
    await sender.processCampaign(res.body.id);
    assert.strictEqual(sendsTo("c2@example.test"), 0);
    const row = await EmailCampaignRecipient.findOne({ campaignId: res.body.id, email: "c2@example.test" }).lean();
    assert.strictEqual(row.status, "skipped");
  });

  await test("GET progress by id and by campaign number", async () => {
    await reset();
    provider.failFor.add("c5@example.test");
    const res = await call("POST", "/api/admin/campaigns/send", BODY);
    await sender.processCampaign(res.body.id);
    for (const key of [res.body.id, res.body.campaignId]) {
      const progress = await call("GET", `/api/admin/campaigns/${key}`);
      assert.strictEqual(progress.status, 200);
      const c = progress.body.campaign;
      for (const field of ["_id", "status", "subject", "segment", "total", "sent", "failed", "pending", "createdAt", "startedAt", "completedAt"]) {
        assert.ok(field in c, `missing ${field}`);
      }
      assert.strictEqual(c.total, 8);
      assert.strictEqual(c.sent, 7);
      assert.strictEqual(c.failed, 1);
      assert.strictEqual(c.pending, 0);
      assert.strictEqual(progress.body.recentFailures[0].email, "c5@example.test");
    }
    const missing = await call("GET", "/api/admin/campaigns/EML-1999-00001");
    assert.strictEqual(missing.status, 404);
  });

  await test("current Admin composer: a small campaign answers with its final counts", async () => {
    await reset();
    process.env.CAMPAIGN_SEND_IMMEDIATE = "true";
    process.env.CAMPAIGN_SEND_RESPONSE_WAIT_MS = "10000";
    try {
      const res = await call("POST", "/api/admin/campaigns/send", { ...BODY, subject: "Inline answer" });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.status, "completed");
      assert.strictEqual(res.body.sent, 8);
      assert.strictEqual(res.body.total, 8);
      assert.strictEqual(res.body.failed, 0);
      assert.strictEqual(res.body.adminCopySent, true);
      assert.deepStrictEqual(res.body.errors, []);
    } finally {
      process.env.CAMPAIGN_SEND_IMMEDIATE = "false";
      process.env.CAMPAIGN_SEND_RESPONSE_WAIT_MS = "0";
    }
  });

  await test("admin copy failure: campaign failed and no customer is emailed, ever", async () => {
    await reset();
    provider.failFor.add("owner@profixter.test");
    const res = await call("POST", "/api/admin/campaigns/send", { ...BODY, subject: "Other subject" });
    assert.strictEqual(res.status, 500);
    const campaign = await EmailCampaign.findOne({ subject: "Other subject" }).lean();
    assert.strictEqual(campaign.status, "failed");
    await EmailCampaign.updateOne({ _id: campaign._id }, { $set: { leaseUntil: null } });
    await sender.runCampaignSenderCycle();
    assert.strictEqual(sent.length, 0);
  });

  server.close();
  await mongoose.disconnect();
  await mongod.stop();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
