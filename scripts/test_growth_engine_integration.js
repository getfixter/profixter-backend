/**
 * Growth engine: trust ladder, idempotency, limits, demotion, sweeps, the
 * checkout recovery action and the out-of-area waitlist route.
 *
 * Integration suite (in-memory MongoDB), so it is NOT in run_ci_tests.js,
 * like the other *_integration suites:
 *
 *   node scripts/test_growth_engine_integration.js
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-unsubscribe-tokens";

const assert = require("assert");
const path = require("path");
const http = require("http");
const mongoose = require("mongoose");
const express = require("express");
const { MongoMemoryServer } = require("mongodb-memory-server");

/* Stub the mail sender before anything requires it. */
const sent = [];
const emailServicePath = require.resolve(path.join(__dirname, "../utils/emailService"));
require.cache[emailServicePath] = {
  id: emailServicePath,
  filename: emailServicePath,
  loaded: true,
  exports: {
    sendRaw: async (msg) => {
      sent.push(msg);
      return { messageId: `msg-${sent.length}` };
    },
    sendTx: async () => ({}),
  },
};

const GrowthAction = require("../models/GrowthAction");
const GrowthPolicy = require("../models/GrowthPolicy");
const AdminActivityLog = require("../models/AdminActivityLog");
const User = require("../models/User");
const Subscription = require("../models/Subscription");
const EmailSuppression = require("../models/EmailSuppression");
const ServiceAreaWaitlist = require("../models/ServiceAreaWaitlist");
const registry = require("../utils/growth/actionRegistry");
const engine = require("../utils/growth/actionEngine");
require("../utils/growth/actions");
const { proposeCheckoutRecovery } = require("../utils/growth/checkoutRecovery");
const { capacityOutlook, buildCommandCenter } = require("../utils/growth/commandCenter");

let passed = 0;
async function test(name, fn) {
  await GrowthAction.deleteMany({});
  await GrowthPolicy.deleteMany({});
  await AdminActivityLog.deleteMany({});
  sent.length = 0;
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}`);
    throw error;
  }
}

/* A controllable test action. */
const calls = { execute: 0, verify: 0 };
const behaviour = { execute: "done", verify: true };
registry.defineAction({
  type: "test_action",
  label: "Test action",
  description: "test",
  riskTier: "medium",
  defaultMode: "supervised",
  maxMode: "autonomous",
  promoteAfter: 2,
  limits: { perDay: 3 },
  verifyAfterMs: 0,
  maxAttempts: 2,
  describe: (p) => `test ${p.n}`,
  execute: async () => {
    calls.execute += 1;
    if (behaviour.execute === "throw") throw Object.assign(new Error("boom"), { permanent: true });
    if (behaviour.execute === "transient") throw new Error("flaky");
    if (behaviour.execute === "skip") return { outcome: "skip", reason: "nope" };
    return { outcome: "done", result: { ok: true } };
  },
  verify: async () => {
    calls.verify += 1;
    return { passed: behaviour.verify, detail: "test" };
  },
});

const later = (ms) => new Date(Date.now() + ms);

async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all([GrowthAction.init(), GrowthPolicy.init(), ServiceAreaWaitlist.init()]);

  console.log("growth engine");

  await test("engine disabled: every proposal is shadow, nothing runs", async () => {
    delete process.env.GROWTH_ACTIONS_ENABLED;
    behaviour.execute = "done";
    const { action } = await engine.propose("test_action", { n: 1 }, { idempotencyKey: "k1" });
    assert.strictEqual(action.status, "shadow");
    assert.strictEqual(action.heldReason, "engine_disabled");
    const before = calls.execute;
    await engine.runSweeps();
    assert.strictEqual(calls.execute, before);
    assert.ok(await AdminActivityLog.exists({ action: "growth_action.proposed" }));
  });

  process.env.GROWTH_ACTIONS_ENABLED = "true";

  await test("supervised by default, and a repeated proposal returns the first", async () => {
    const a = await engine.propose("test_action", { n: 1 }, { idempotencyKey: "same" });
    const b = await engine.propose("test_action", { n: 2 }, { idempotencyKey: "same" });
    assert.strictEqual(a.action.status, "awaiting_approval");
    assert.strictEqual(b.created, false);
    assert.strictEqual(String(b.action._id), String(a.action._id));
    assert.strictEqual(await GrowthAction.countDocuments({}), 1);
  });

  await test("approve runs it; verification counts; streak promotes to autonomous", async () => {
    const owner = { kind: "owner", name: "Owner" };
    for (let i = 0; i < 2; i += 1) {
      const { action } = await engine.propose("test_action", { n: i }, { idempotencyKey: `p${i}` });
      const done = await engine.approve(action._id, owner);
      assert.strictEqual(done.status, "succeeded");
      await engine.verificationSweep({ now: later(1000) });
    }
    const policy = await GrowthPolicy.findOne({ type: "test_action" }).lean();
    assert.strictEqual(policy.mode, "autonomous");
    assert.strictEqual(policy.setBy.kind, "auto_promotion");

    const { action } = await engine.propose("test_action", { n: 9 }, { idempotencyKey: "auto" });
    assert.strictEqual(action.status, "approved");
    await engine.executionSweep();
    assert.strictEqual((await GrowthAction.findById(action._id)).status, "succeeded");
  });

  await test("a failure demotes an autonomous type back to supervised", async () => {
    await engine.setPolicyMode("test_action", "autonomous", { kind: "owner", name: "Owner" });
    behaviour.execute = "throw";
    const { action } = await engine.propose("test_action", { n: 1 }, { idempotencyKey: "f1" });
    await engine.executionSweep();
    assert.strictEqual((await GrowthAction.findById(action._id)).status, "failed");
    const policy = await GrowthPolicy.findOne({ type: "test_action" }).lean();
    assert.strictEqual(policy.mode, "supervised");
    assert.strictEqual(policy.setBy.kind, "auto_demotion");
    behaviour.execute = "done";
  });

  await test("a failed verification also demotes", async () => {
    await engine.setPolicyMode("test_action", "autonomous", { kind: "owner" });
    behaviour.verify = false;
    await engine.propose("test_action", { n: 1 }, { idempotencyKey: "v1" });
    await engine.executionSweep();
    await engine.verificationSweep({ now: later(1000) });
    assert.strictEqual((await GrowthPolicy.findOne({ type: "test_action" })).mode, "supervised");
    behaviour.verify = true;
  });

  await test("transient errors retry with backoff, then fail at maxAttempts", async () => {
    await engine.setPolicyMode("test_action", "autonomous", { kind: "owner" });
    behaviour.execute = "transient";
    const { action } = await engine.propose("test_action", { n: 1 }, { idempotencyKey: "t1" });
    await engine.executionSweep();
    let row = await GrowthAction.findById(action._id);
    assert.strictEqual(row.status, "approved");
    assert.ok(row.nextAttemptAt > new Date());
    await engine.executionSweep({ now: later(60 * 60 * 1000) });
    row = await GrowthAction.findById(action._id);
    assert.strictEqual(row.status, "failed");
    assert.strictEqual(row.attempts, 2);
    behaviour.execute = "done";
  });

  await test("the daily limit holds autonomous actions for approval", async () => {
    await engine.setPolicyMode("test_action", "autonomous", { kind: "owner" });
    const statuses = [];
    for (let i = 0; i < 4; i += 1) {
      const { action } = await engine.propose("test_action", { n: i }, { idempotencyKey: `l${i}` });
      statuses.push([action.status, action.heldReason]);
    }
    assert.deepStrictEqual(statuses[3], ["awaiting_approval", "daily_limit"]);
    assert.ok(statuses.slice(0, 3).every(([s]) => s === "approved"));
  });

  await test("a skip is recorded as skipped, not as a failure", async () => {
    await engine.setPolicyMode("test_action", "autonomous", { kind: "owner" });
    behaviour.execute = "skip";
    const { action } = await engine.propose("test_action", { n: 1 }, { idempotencyKey: "s1" });
    await engine.executionSweep();
    const row = await GrowthAction.findById(action._id);
    assert.strictEqual(row.status, "skipped");
    assert.strictEqual((await GrowthPolicy.findOne({ type: "test_action" })).mode, "autonomous");
    behaviour.execute = "done";
  });

  await test("reject resets the streak; double decisions are refused", async () => {
    await GrowthPolicy.create({ type: "test_action", mode: "supervised", consecutiveVerifiedSuccesses: 1 });
    const { action } = await engine.propose("test_action", { n: 1 }, { idempotencyKey: "r1" });
    await engine.reject(action._id, { kind: "owner" }, "no");
    assert.strictEqual((await GrowthPolicy.findOne({ type: "test_action" })).consecutiveVerifiedSuccesses, 0);
    await assert.rejects(() => engine.approve(action._id, { kind: "owner" }), /no longer waiting/);
  });

  await test("ceilings: high risk cannot be autonomous; owner cannot exceed maxMode", async () => {
    assert.throws(() =>
      registry.defineAction({
        type: "x_high",
        label: "x",
        description: "x",
        riskTier: "high",
        defaultMode: "supervised",
        maxMode: "autonomous",
        execute: async () => ({}),
      })
    );
    registry.defineAction({
      type: "x_capped",
      label: "x",
      description: "x",
      riskTier: "high",
      defaultMode: "supervised",
      maxMode: "supervised",
      execute: async () => ({}),
    });
    await assert.rejects(() => engine.setPolicyMode("x_capped", "autonomous", { kind: "owner" }), /cannot be set above/);
    registry._unregister("x_capped");
  });

  await test("an interrupted run goes back to the owner, never silently retried", async () => {
    const { action } = await engine.propose("test_action", { n: 1 }, { idempotencyKey: "i1" });
    await GrowthAction.updateOne(
      { _id: action._id },
      { $set: { status: "running", claimedAt: new Date(Date.now() - 60 * 60 * 1000) } }
    );
    await engine.interruptedSweep();
    const row = await GrowthAction.findById(action._id);
    assert.strictEqual(row.status, "awaiting_approval");
    assert.strictEqual(row.heldReason, "interrupted");
  });

  await test("stale approvals expire", async () => {
    const { action } = await engine.propose("test_action", { n: 1 }, { idempotencyKey: "e1" });
    await engine.expirySweep({ now: later(4 * 24 * 60 * 60 * 1000) });
    assert.strictEqual((await GrowthAction.findById(action._id)).status, "expired");
  });

  console.log("checkout recovery");

  const makeUser = (over = {}) =>
    User.create({
      name: "Pat Doe",
      firstName: "Pat",
      email: `pat${Math.random().toString(36).slice(2, 7)}@homeowner-fixture.net`,
      password: "x".repeat(20),
      phone: "6315550100",
      userId: String(10000000 + Math.floor(Math.random() * 89999999)),
      ...over,
    });
  const session = (user, over = {}) => ({
    id: `cs_test_${Math.random().toString(36).slice(2, 10)}`,
    mode: "subscription",
    status: "expired",
    created: Math.floor(Date.now() / 1000) - 86400,
    metadata: { plan: "plus", billingCycle: "monthly", userId: String(user._id) },
    ...over,
  });
  const finder = async (s) => User.findById(s.metadata.userId);

  await test("an expired membership checkout proposes once, supervised", async () => {
    const user = await makeUser();
    const s = session(user);
    const first = await proposeCheckoutRecovery(s, finder);
    const again = await proposeCheckoutRecovery(s, finder);
    assert.strictEqual(first.status, "awaiting_approval");
    assert.strictEqual(again, null);
    assert.match(first.summary, /Plus \(monthly\)/);
    assert.strictEqual(await proposeCheckoutRecovery({ ...s, id: "cs_x", mode: "payment" }, finder), null);
  });

  await test("approved recovery sends one marketing email with unsubscribe", async () => {
    const user = await makeUser();
    const action = await proposeCheckoutRecovery(session(user), finder);
    const done = await engine.approve(action._id, { kind: "owner", name: "Owner" });
    assert.strictEqual(done.status, "succeeded");
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].to, user.email);
    assert.ok(sent[0].headers["List-Unsubscribe"]);
    assert.match(sent[0].html, /Plus plan/);
    assert.match(sent[0].html, /membership\/plans/);
    assert.doesNotMatch(sent[0].html, /unlimited/i);
    assert.strictEqual(sent[0].logContext.emailType, "marketing");
  });

  await test("recovery skips members, the unsubscribed, and repeat reminders", async () => {
    const member = await makeUser();
    await Subscription.create({
      user: member._id,
      addressId: new mongoose.Types.ObjectId(),
      subscriptionType: "plus",
      status: "active",
      startDate: new Date(),
      currentPeriodEnd: later(20 * 24 * 60 * 60 * 1000),
      stripeSubscriptionId: "sub_test_1",
      accessStatus: "active",
      userId: member.userId,
      nextPaymentDate: later(20 * 24 * 60 * 60 * 1000),
      latestPaymentDate: new Date(),
    }).catch((e) => {
      throw new Error(`fixture subscription: ${e.message}`);
    });
    const m = await proposeCheckoutRecovery(session(member), finder);
    assert.strictEqual((await engine.approve(m._id, { kind: "owner" })).status, "skipped");

    const unsub = await makeUser();
    await EmailSuppression.create({ email: unsub.email, reason: "unsubscribe" }).catch(async () => {
      await EmailSuppression.collection.insertOne({ email: unsub.email });
    });
    const u = await proposeCheckoutRecovery(session(unsub), finder);
    assert.strictEqual((await engine.approve(u._id, { kind: "owner" })).result.reason, "unsubscribed");

    const repeat = await makeUser();
    const r1 = await proposeCheckoutRecovery(session(repeat), finder);
    await engine.approve(r1._id, { kind: "owner" });
    const r2 = await proposeCheckoutRecovery(session(repeat), finder);
    const second = await engine.approve(r2._id, { kind: "owner" });
    assert.strictEqual(second.status, "skipped");
    assert.strictEqual(second.result.reason, "reminded_recently");
    assert.strictEqual(sent.filter((m2) => m2.to === repeat.email).length, 1);
  });

  console.log("waitlist route");

  await test("waitlist validates, refuses served ZIPs, and dedupes", async () => {
    await ServiceAreaWaitlist.deleteMany({});
    const app = express();
    app.use(express.json());
    app.use("/api/service-area", require("../routes/serviceArea"));
    const server = http.createServer(app).listen(0);
    const base = `http://127.0.0.1:${server.address().port}/api/service-area/waitlist`;
    const post = (body) =>
      fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    try {
      assert.strictEqual((await (await post({ email: "nope", zip: "10001", consentEmail: true })).json()).code, "INVALID_EMAIL");
      assert.strictEqual((await (await post({ email: "a@b.co", zip: "10001", consentEmail: "true" })).json()).code, "CONSENT_REQUIRED");
      assert.strictEqual((await (await post({ email: "a@b.co", zip: "11757", consentEmail: true })).json()).code, "IN_SERVICE_AREA");
      assert.strictEqual((await post({ email: "A@B.co", zip: "10001", consentEmail: true, attribution: { utmSource: "fb" } })).status, 201);
      assert.strictEqual((await post({ email: "a@b.co", zip: "10001", consentEmail: true })).status, 201);
      const rows = await ServiceAreaWaitlist.find({}).lean();
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].requestCount, 2);
      assert.strictEqual(rows[0].consentText, "Email me when Profixter starts serving my area");
    } finally {
      server.close();
    }
  });

  console.log("command center");

  await test("capacity outlook sums taken vs capacity and signals room to grow", async () => {
    const loader = async ({ month }) => ({
      days: Array.from({ length: 31 }, (_, i) => ({
        date: `${month}-${String(i + 1).padStart(2, "0")}`,
        taken: { "08:00": i % 4 === 0 ? 1 : 0, "10:30": 0 },
        remaining: { "08:00": i % 4 === 0 ? 0 : 1, "10:30": 1 },
      })),
    });
    const out = await capacityOutlook({ now: new Date("2026-10-09T12:00:00Z"), days: 21, monthLoader: loader });
    assert.strictEqual(out.capacity, 42);
    assert.ok(out.booked > 0 && out.booked < 10);
    assert.strictEqual(out.signal, "room_to_grow");
    assert.strictEqual(out.weeks.length, 3);
  });

  await test("summary assembles even when the calendar cannot be read", async () => {
    await engine.propose("test_action", { n: 1 }, { idempotencyKey: "cc1" });
    const summary = await buildCommandCenter();
    assert.strictEqual(summary.queue.pending.length, 1);
    assert.ok(summary.policies.some((p) => p.type === "checkout_recovery_email" && p.mode === "supervised"));
    assert.ok(summary.capacity);
    assert.ok(Array.isArray(summary.alerts));
    assert.strictEqual(summary.queue.pending[0].payload, undefined);
  });

  await mongoose.disconnect();
  await mongo.stop();
  console.log(`\n${passed} passed`);
}

main().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
