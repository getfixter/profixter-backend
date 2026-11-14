/**
 * GoHighLevel retirement (owner decision Q-6, 2026-11-12).
 *
 *   - Google Business Profile posts can never be published by the system:
 *     not autonomously, not after an owner approval, not from an old queue,
 *     whatever the stored GrowthPolicy or the switches say. Rollback is
 *     refused, so nothing touches the posts already on Google.
 *   - The GoHighLevel reply agent cannot send: the client has no send call,
 *     the action never sends, the inbound webhook is gone (404) and the
 *     10-minute poller is gone. Stored threads stay readable.
 *   - The rep-attribution webhook (/api/ghl/lead-assigned) stays mounted but answers 410 (retired 2026-11):
 *     rep commissions still depend on it.
 *   - The communication settings no longer warn about GHL workflows.
 *
 * In-memory MongoDB. Every network call fails the test - nothing leaves the process.
 *   node scripts/test_ghl_retirement.js
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");
const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const ROOT = path.join(__dirname, "..");
const realFetch = globalThis.fetch;
const outbound = [];
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith("http://127.0.0.1")) return realFetch(url, init);
  outbound.push(u);
  throw new Error(`network call attempted: ${u}`);
};

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}`);
    throw error;
  }
}

const GOOD_POST = {
  summary:
    "Fall on Long Island means gutters full of leaves and drafty doors. Your first Profixter visit is free: we walk through your to-do list with you and help you choose the right service. Book it online in a minute.",
  title: "Get your home ready for fall",
  url: "https://www.profixter.com/book/free?utm_source=google&utm_medium=organic&utm_campaign=gbp_fall_prep",
  reason: "seasonal",
};

async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const GrowthAction = require("../models/GrowthAction");
  const GrowthPolicy = require("../models/GrowthPolicy");
  const ConversationThread = require("../models/ConversationThread");
  require("../utils/growth/actions");
  const registry = require("../utils/growth/actionRegistry");
  const engine = require("../utils/growth/actionEngine");
  const { AGENTS } = require("../utils/agents/definitions");
  const owner = { kind: "owner", name: "Owner" };

  console.log("Google Business Profile posting is impossible");

  await test("no agent may propose gbp_post", () => {
    for (const a of Object.values(AGENTS)) assert.ok(!(a.allowedActions || []).includes("gbp_post"), a.name);
  });

  await test("gbp_post cannot run autonomously: the code ceiling beats a live 'autonomous' policy and every switch", async () => {
    await GrowthPolicy.create({ type: "gbp_post", mode: "autonomous", setBy: { kind: "owner", note: "standing approval 2026-10-12" } });
    process.env.GROWTH_ACTIONS_ENABLED = "true";
    process.env.GROWTH_ACTIONS_ENABLED_TYPES = "gbp_post";
    const def = registry.getDefinition("gbp_post");
    assert.strictEqual(await engine.resolveMode(def), "shadow");
    assert.strictEqual(engine.enabledTypes().includes("gbp_post"), false);
    const { action } = await engine.propose("gbp_post", GOOD_POST, { idempotencyKey: "r-gbp-1", proposedBy: { kind: "agent", name: "Odysseus" } });
    assert.strictEqual(action.status, "shadow");
    await engine.runSweeps();
    assert.strictEqual((await GrowthAction.findById(action._id).lean()).status, "shadow", "a shadow record is never executed");
    await assert.rejects(engine.setPolicyMode("gbp_post", "autonomous", owner), /cannot be set above shadow/);
    // the stored policy document is left exactly as it was (the brief: never change live GrowthPolicy documents)
    assert.strictEqual((await GrowthPolicy.findOne({ type: "gbp_post" }).lean()).mode, "autonomous");
  });

  await test("gbp_post cannot publish even if approved: the refusal is recorded on the action", async () => {
    const queued = await GrowthAction.create({ type: "gbp_post", idempotencyKey: "r-gbp-q", status: "approved", riskTier: "medium", modeAtProposal: "autonomous", payload: GOOD_POST });
    const ran = await engine.execute(queued._id);
    assert.strictEqual(ran.status, "skipped");
    assert.match(ran.result.reason, /^ghl_retired/);
    const pending = await GrowthAction.create({ type: "gbp_post", idempotencyKey: "r-gbp-p", status: "awaiting_approval", riskTier: "medium", modeAtProposal: "supervised", payload: GOOD_POST });
    const approved = await engine.approve(pending._id, owner, "go");
    assert.strictEqual(approved.status, "skipped");
    assert.match(approved.result.reason, /^ghl_retired/);
    const done = await GrowthAction.create({ type: "gbp_post", idempotencyKey: "r-gbp-done", status: "succeeded", riskTier: "medium", modeAtProposal: "autonomous", payload: GOOD_POST, result: { postId: "p" }, executedAt: new Date() });
    await assert.rejects(engine.rollback(done._id, owner), (e) => e.code === "GHL_RETIRED");
    delete process.env.GROWTH_ACTIONS_ENABLED;
    delete process.env.GROWTH_ACTIONS_ENABLED_TYPES;
  });

  await test("the Growth API returns the refusal as { message, code: GHL_RETIRED }", async () => {
    const done = await GrowthAction.create({ type: "gbp_post", idempotencyKey: "r-gbp-api", status: "succeeded", riskTier: "medium", modeAtProposal: "autonomous", payload: GOOD_POST, result: { postId: "p" }, executedAt: new Date() });
    const stub = (m, exports) => {
      const resolved = require.resolve(m);
      require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
    };
    stub("../middleware/auth", (req, _res, next) => {
      req.user = { id: String(new mongoose.Types.ObjectId()) };
      req.authUser = { email: "owner@profixter.test", role: "admin" };
      req.accessUser = { email: "owner@profixter.test", role: "admin", permissions: ["admin.all"] };
      next();
    });
    stub("../middleware/authorize", { PERMISSIONS: { ADMIN: "admin.all", GROWTH_READ: "growth.read" }, requirePermission: () => [(_q, _s, n) => n()] });
    const app = express();
    app.use(express.json());
    app.use("/api/admin/growth", require("../routes/adminGrowth"));
    const server = http.createServer(app).listen(0);
    try {
      const res = await realFetch(`http://127.0.0.1:${server.address().port}/api/admin/growth/actions/${done._id}/rollback`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      assert.strictEqual(res.status, 400);
      const body = await res.json();
      assert.strictEqual(body.code, "GHL_RETIRED");
      assert.match(body.message, /retired/);
    } finally {
      server.close();
    }
  });

  await test("the Social Planner client is deleted", () => {
    assert.ok(!fs.existsSync(path.join(ROOT, "utils", "ghl", "socialPlanner.js")));
  });

  console.log("GoHighLevel replies cannot be sent");

  await test("the GHL client has no send, tag or note call", () => {
    const { ghl } = require("../utils/ghl/client");
    for (const gone of ["sendReply", "addTag", "addNote", "searchInbound", "getMessages"]) assert.strictEqual(ghl[gone], undefined, gone);
  });

  await test("an approved conversation reply is skipped with the reason; the thread is untouched", async () => {
    const t = await ConversationThread.create({ ghlConversationId: "cv1", ghlContactId: "ct1", channel: "SMS", status: "reply_proposed", messages: [{ direction: "inbound", channel: "SMS", body: "is it free?", at: new Date() }] });
    const a = await GrowthAction.create({ type: "conversation_reply", idempotencyKey: "r-cr-1", status: "approved", riskTier: "medium", modeAtProposal: "supervised", payload: { threadId: String(t._id), reply: "Hi", channel: "SMS", inboundCount: 1 } });
    process.env.GROWTH_ACTIONS_ENABLED = "true";
    const out = await engine.execute(a._id, { now: new Date("2026-10-12T15:00:00Z") });
    delete process.env.GROWTH_ACTIONS_ENABLED;
    assert.strictEqual(out.status, "skipped");
    assert.match(out.result.reason, /^ghl_retired/);
    const after = await ConversationThread.findById(t._id).lean();
    assert.strictEqual(after.messages.length, 1);
    assert.strictEqual(after.agentReplies || 0, 0);
    assert.deepStrictEqual(registry.getDefinition("conversation_reply").maxMode, "shadow");
  });

  await test("/api/ghl/inbound-message is gone (404); /api/ghl/lead-assigned is retired (410)", async () => {
    process.env.GHL_WEBHOOK_SECRET = "hook-secret";
    process.env.CONVERSATIONS_ENABLED = "true";
    const app = express();
    app.use(express.json());
    app.use("/api/ghl", require("../routes/ghl"));
    const server = http.createServer(app).listen(0);
    const base = `http://127.0.0.1:${server.address().port}/api/ghl`;
    const post = (p, body) => realFetch(`${base}${p}`, { method: "POST", headers: { "Content-Type": "application/json", "x-ghl-secret": "hook-secret" }, body: JSON.stringify(body) });
    try {
      assert.strictEqual((await post("/inbound-message", { contactId: "c", conversationId: "v", body: "hi" })).status, 404);
      assert.strictEqual((await post("/lead-assigned", {})).status, 410, "retired cold-call commission: answers 410, writes nothing");
    } finally {
      server.close();
      delete process.env.CONVERSATIONS_ENABLED;
    }
    const serverSrc = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
    assert.match(serverSrc, /app\.use\("\/api\/ghl"/, "kept mounted for rep attribution");
  });

  await test("the 10-minute GHL conversation poller is gone; only the read-only postal audience sync remains", () => {
    const jobs = require("../jobs/conversations");
    assert.strictEqual(jobs.pollOnce, undefined);
    assert.strictEqual(typeof jobs.syncOutreachOnce, "function");
    const src = fs.readFileSync(path.join(ROOT, "jobs", "conversations.js"), "utf8");
    assert.ok(!src.includes('"*/10 * * * *"'));
  });

  await test("the Growth conversations view reports the reply agent as retired", () => {
    const src = fs.readFileSync(path.join(ROOT, "routes", "adminGrowth.js"), "utf8");
    assert.match(src, /enabled: false,\s*retired: true/);
  });

  console.log("Stale GHL text");

  await test("communication settings carry no 'GHL may duplicate this' warnings", () => {
    const cs = require("../utils/communications/communicationSettings");
    for (const key of Object.keys(cs.SMS_SETTINGS)) assert.strictEqual(cs.SMS_SETTINGS[key].ghlOverlap, undefined, key);
    const shown = cs.smsSettingsFor("BOOKING_REMINDER_24H");
    assert.doesNotMatch(String(shown.ghlOverlap), /may duplicate|Verify before enabling/);
  });

  assert.deepStrictEqual(outbound, [], "no network call was attempted");
  await mongoose.disconnect();
  await mongo.stop();
  console.log(`\n${passed} passed`);
}

main().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
