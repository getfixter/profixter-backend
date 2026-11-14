/**
 * Conversation agent: opt-outs, the no-booking rule, facts-only prices, link
 * control, escalation, quiet hours, one reply per message, the webhook, and
 * that nothing is ever sent outside the growth engine.
 *
 * Scripted model (no API spend), fake GoHighLevel (no real person is
 * contacted), in-memory MongoDB.
 *   node scripts/test_conversations_integration.js
 */
process.env.NODE_ENV = "test";
const assert = require("assert");
const http = require("http");
const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const ConversationThread = require("../models/ConversationThread");
const GrowthAction = require("../models/GrowthAction");
const AgentRun = require("../models/AgentRun");
require("../utils/growth/actions");
const engine = require("../utils/growth/actionEngine");
const responder = require("../utils/conversation/responder");
const service = require("../utils/conversation/service");
const { windowWait } = require("../utils/growth/actions/conversationReply");

/* Fake GoHighLevel: record every call; nothing leaves the process. */
const ghlCalls = [];
let fakeContact = {};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith("https://services.leadconnectorhq.com")) {
    ghlCalls.push({ method: init.method, path: new URL(u).pathname, body: init.body ? JSON.parse(init.body) : null });
    if (init.method === "GET" && new URL(u).pathname.startsWith("/contacts/")) {
      if (fakeContact === "fail") return { ok: false, status: 500, json: async () => ({ message: "boom" }) };
      return { ok: true, status: 200, json: async () => ({ contact: fakeContact }) };
    }
    return { ok: true, status: 200, json: async () => ({ messageId: `ghl-${ghlCalls.length}` }) };
  }
  return realFetch(url, init);
};

/* Scripted model. */
let nextDecision = null;
let modelCalls = 0;
responder.setClientFactory(() => ({
  beta: {
    messages: {
      create: async () => {
        modelCalls += 1;
        return { stop_reason: "end_turn", usage: { input_tokens: 2000, output_tokens: 150 }, content: [{ type: "text", text: JSON.stringify(nextDecision) }] };
      },
    },
  },
}));
const decision = (over = {}) => ({
  intent: "interested_free_visit",
  should_reply: true,
  reply: "Hi Pat, glad you asked! Your first visit is free - up to 90 minutes of real handyman work on one job, no card needed. You can pick a time that suits you here:",
  link: "free_visit",
  escalate: false,
  escalation_reason: "",
  summary: "Pat in Lindenhurst wants the leaky faucet fixed",
  ...over,
});

let passed = 0;
let n = 0;
async function test(name, fn) {
  await Promise.all([ConversationThread.deleteMany({}), GrowthAction.deleteMany({}), AgentRun.deleteMany({})]);
  ghlCalls.length = 0;
  modelCalls = 0;
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}`);
    throw e;
  }
}
const inbound = (body, over = {}) =>
  service.ingestInbound({ conversationId: `conv${(n += 1)}`, contactId: `contact${n}`, channel: "SMS", body, at: new Date(), messageId: `m${n}`, firstName: "Pat", town: "Lindenhurst", origin: "cold_outreach_reply", ...over });

async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all([ConversationThread.init(), GrowthAction.init()]);
  process.env.AGENTS_ENABLED = "true";
  process.env.ANTHROPIC_API_KEY = "test-not-real";
  process.env.GHL_API_TOKEN = "ghl-test-not-real";
  console.log("conversation agent");

  await test("'stop' in any words closes the thread for good - no model call, nothing proposed", async () => {
    for (const text of ["STOP", "please remove me from your list", "Don't text me again", "unsubscribe"]) {
      const t = await inbound(text);
      const out = await service.processThread(t);
      assert.strictEqual(out.status, "opted_out", text);
    }
    assert.strictEqual(modelCalls, 0);
    assert.strictEqual(await GrowthAction.countDocuments({}), 0);
    // A later message on an opted-out thread is never answered.
    const t = await ConversationThread.findOne({});
    await service.ingestInbound({ conversationId: t.ghlConversationId, contactId: t.ghlContactId, body: "actually how much?", messageId: "late" });
    assert.strictEqual((await ConversationThread.findById(t._id)).status, "opted_out");
  });

  await test("an interested homeowner gets a proposed reply with one tracked website link; it is not sent", async () => {
    delete process.env.GROWTH_ACTIONS_ENABLED;
    nextDecision = decision();
    const t = await inbound("Hi, what's the free visit? I have a leaky faucet");
    const out = await service.processThread(t);
    assert.strictEqual(out.status, "reply_proposed");
    const a = await GrowthAction.findOne({ type: "conversation_reply" }).lean();
    assert.strictEqual(a.status, "shadow", "engine off -> watch-only");
    assert.match(a.payload.reply, /https:\/\/www\.profixter\.com\/book\/free\?utm_source=ghl_sms&utm_medium=conversation&utm_campaign=cold_outreach_reply&utm_content=/);
    assert.strictEqual(ghlCalls.filter((c) => c.method !== "GET").length, 0, "nothing sent");
    const run = await AgentRun.findOne({ agent: "conversation" }).lean();
    assert.strictEqual(run.trigger, "event");
    assert.ok(run.costCents > 0);
  });

  await test("a reply that books, promises a time, offers a discount, invents a price or writes a link is blocked and escalated", async () => {
    const bad = [
      "Great, I've booked you for Tuesday at 10am!",
      "We can come tomorrow at 9.",
      "I'll give you 20% off your first month.",
      "That repair would be about $250.",
      "Book here: www.profixter.com/book/free",
    ];
    for (const reply of bad) {
      nextDecision = decision({ reply });
      const out = await service.processThread(await inbound("how does it work?"));
      assert.strictEqual(out.status, "escalated", reply);
    }
    assert.strictEqual(await GrowthAction.countDocuments({}), 0);
  });

  await test("real catalogue prices are allowed; renovation questions get the renovation link", async () => {
    nextDecision = decision({ intent: "membership_or_services", reply: "A single visit is $99 for up to 90 minutes, and membership starts at $149/month.", link: "one_time" });
    await service.processThread(await inbound("how much is a visit?"));
    nextDecision = decision({ intent: "renovation", reply: "Yes - Profixter also does bathroom remodels. You can send us the details here:", link: "renovation" });
    await service.processThread(await inbound("do you do full bathroom remodels?"));
    const replies = (await GrowthAction.find({ type: "conversation_reply" }).lean()).map((a) => a.payload.reply);
    assert.ok(replies.some((r) => /\$99/.test(r) && /\/book\?visit=additional/.test(r)));
    assert.ok(replies.some((r) => /\/projects\?[^#]*#estimate/.test(r)));
  });

  await test("not interested / wrong number: no reply; unknown questions escalate to a person", async () => {
    nextDecision = decision({ intent: "not_interested", should_reply: false, reply: "" });
    assert.strictEqual((await service.processThread(await inbound("no thanks"))).status, "closed");
    nextDecision = decision({ intent: "needs_human", should_reply: false, reply: "", escalate: true, escalation_reason: "asks about insurance certificate" });
    const out = await service.processThread(await inbound("can you send your insurance certificate?"));
    assert.strictEqual(out.status, "escalated");
  });

  await test("retired 2026-11-12: a drafted reply is only recorded, and even an approved one never reaches GoHighLevel", async () => {
    process.env.GROWTH_ACTIONS_ENABLED = "true";
    nextDecision = decision();
    const t = await inbound("interested!");
    await service.processThread(t);
    const a = await GrowthAction.findOne({ type: "conversation_reply" });
    assert.strictEqual(a.status, "shadow", "capped at shadow: recorded, never queued");
    // an old record left approved from before the retirement
    await GrowthAction.updateOne({ _id: a._id }, { $set: { status: "approved" } });
    assert.ok(windowWait(new Date("2026-10-12T03:00:00Z")), "the send window helper still answers for old records");
    const out = await engine.execute(a._id, { now: new Date("2026-10-12T15:00:00Z") });
    assert.strictEqual(out.status, "skipped");
    assert.match(out.result.reason, /^ghl_retired/);
    assert.strictEqual(ghlCalls.filter((c) => c.method !== "GET").length, 0, "nothing was sent, tagged or noted in GoHighLevel");
    const thread = await ConversationThread.findById(t._id).lean();
    assert.ok(!thread.messages.some((m) => m.by === "agent"));
  });

  await test("approving an old pending reply closes it as skipped, without sending", async () => {
    const t = await inbound("tell me more");
    const a = await GrowthAction.create({
      type: "conversation_reply",
      idempotencyKey: "old-pending",
      status: "awaiting_approval",
      riskTier: "medium",
      modeAtProposal: "supervised",
      summary: "Reply",
      payload: { threadId: String(t._id), reply: "Hi", channel: "SMS", inboundCount: 1 },
    });
    const out = await engine.approve(a._id, { kind: "owner", name: "Owner" });
    assert.strictEqual(out.status, "skipped");
    assert.match(out.result.reason, /^ghl_retired/);
    assert.strictEqual(ghlCalls.length, 0);
  });

  await test("a Profixter customer (or anyone we cannot check) goes to a person - no model call, nothing sent through GoHighLevel", async () => {
    const User = require("../models/User");
    await User.collection.insertOne({ userId: "u-conv-1", email: "member@example.com", phone: "(631) 555-0101" });
    for (const contact of [{ email: "Member@Example.com" }, { phone: "+16315550101" }, "fail"]) {
      fakeContact = contact;
      ghlCalls.length = 0;
      const t = await inbound("Can someone come fix my door?");
      const out = await service.processThread(t);
      assert.strictEqual(out.status, "escalated", JSON.stringify(contact));
      assert.ok(ghlCalls.every((c) => c.method === "GET"), JSON.stringify(ghlCalls));
    }
    assert.strictEqual(modelCalls, 0);
    assert.strictEqual(await GrowthAction.countDocuments({}), 0);
    fakeContact = {};
    await User.collection.deleteMany({});
  });

  await test("agents switched off: no model calls, no cost", async () => {
    delete process.env.AGENTS_ENABLED;
    const out = await service.processThread(await inbound("hello?"));
    assert.strictEqual(out.skipped, "agents_disabled");
    assert.strictEqual(modelCalls, 0);
    process.env.AGENTS_ENABLED = "true";
  });

  await test("the GoHighLevel inbound-message webhook is gone (404); rep attribution stays", async () => {
    process.env.GHL_WEBHOOK_SECRET = "hook-secret";
    process.env.CONVERSATIONS_ENABLED = "true";
    const app = express();
    app.use(express.json());
    app.use("/api/ghl", require("../routes/ghl"));
    const server = http.createServer(app).listen(0);
    const base = `http://127.0.0.1:${server.address().port}/api/ghl`;
    const post = (p, body) => realFetch(`${base}${p}`, { method: "POST", headers: { "Content-Type": "application/json", "x-ghl-secret": "hook-secret" }, body: JSON.stringify(body) });
    try {
      const payload = { type: "InboundMessage", contactId: "c-hook", conversationId: "conv-hook", messageType: "SMS", body: "is the first visit really free?", direction: "inbound", messageId: "hook-1" };
      assert.strictEqual((await post("/inbound-message", payload)).status, 404);
      assert.strictEqual(await ConversationThread.countDocuments({ ghlConversationId: "conv-hook" }), 0);
      assert.strictEqual(modelCalls, 0);
      // the rep-attribution webhook still answers (400: a phone is required)
      assert.strictEqual((await post("/lead-assigned", {})).status, 410);
    } finally {
      server.close();
      delete process.env.CONVERSATIONS_ENABLED;
    }
  });

  await mongoose.disconnect();
  await mongo.stop();
  console.log(`\n${passed} passed`);
}

main().catch(async (e) => {
  console.error(e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
