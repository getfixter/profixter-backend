/**
 * Two-level communication in the Growth office: every approval, note, shift,
 * mistake, robot and the results board has a plain-English version and a
 * self-contained "Copy for ChatGPT" brief. Briefs come only from real records,
 * ask ChatGPT to evaluate (not rubber-stamp) approvals, and never carry
 * secrets or customer contact details. Older records get a plain version from
 * the budget-capped explainer, written once.
 *
 * Scripted model (no API spend), in-memory MongoDB, no network.
 *   node scripts/test_office_explain_integration.js
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

const assert = require("assert");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const AgentRun = require("../models/AgentRun");
const AgentFinding = require("../models/AgentFinding");
const GrowthAction = require("../models/GrowthAction");
const EmailPlaybook = require("../models/EmailPlaybook");
const ConversationThread = require("../models/ConversationThread");
require("../utils/growth/actions");
const explain = require("../utils/growth/explain");
const office = require("../utils/growth/office");
const plainExplainer = require("../utils/growth/plainExplainer");
const { runTool } = require("../utils/agents/tools");
const { AGENTS } = require("../utils/agents/definitions");
const { splitOwnerSummary } = require("../utils/agents/runtime");

let passed = 0;
async function test(name, fn) {
  await Promise.all([AgentRun.deleteMany({}), AgentFinding.deleteMany({}), GrowthAction.deleteMany({}), EmailPlaybook.deleteMany({}), ConversationThread.deleteMany({})]);
  office.invalidateOffice();
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}`);
    throw error;
  }
}

const JARGON = /\b(CTR|GSC|SEO|CAC|API|payload|metaTitle|metaDescription|idempotency|GrowthAction|null|undefined)\b/;

async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());

  await test("redact removes secrets and customer contact details", async () => {
    const t = explain.redact("key sk-ant-abc123def456ghi789 token pit-1234567890abcdef mail pat@example.com call (631) 555-0101 at 12 Main St for Pat", { names: ["Pat"] });
    for (const bad of ["sk-ant", "pit-1234", "pat@example.com", "555-0101", "12 Main St", "Pat"]) assert.ok(!t.includes(bad), `${bad} leaked: ${t}`);
  });

  await test("an SEO approval: plain question with Yes/No, and a full brief that asks ChatGPT to evaluate", async () => {
    const a = await GrowthAction.create({
      type: "seo_page_update",
      idempotencyKey: "s1",
      status: "awaiting_approval",
      riskTier: "low",
      modeAtProposal: "supervised",
      proposedBy: { kind: "agent", name: "Visibility & Organic Acquisition agent" },
      summary: "New title for /services/bathroom-repair",
      rationale: "180 impressions, 1.1% CTR at position 7 for 'bathroom repair long island'",
      payload: { path: "/services/bathroom-repair", changes: { metaDescription: "Bathroom repairs on Long Island by local Fixters. Your first visit is free." }, targetQueries: ["bathroom repair long island"], reason: "low CTR" },
    });
    const { items } = await office.approvalsList();
    const it = items.find((x) => x.id === String(a._id));
    assert.match(it.simple.say, /Boss/);
    assert.match(it.simple.say, /won't change our services or prices/);
    assert.match(it.simple.ask, /Can I update the bathroom repair page\?/);
    assert.ok(!JARGON.test(it.simple.say + it.simple.ask), it.simple.say);
    const c = it.chatgpt;
    for (const must of ["Background (for ChatGPT)", String(a._id), "Before:", "After: \"Bathroom repairs on Long Island", "Reversible?", "What happens if I approve", "Do NOT assume I will approve", "180 impressions"]) {
      assert.ok(c.includes(must), `brief lacks ${must}`);
    }
    assert.match(c, /could not be read right now/, "a missing before-value is said, not invented");
  });

  await test("a reply approval shows the conversation without the homeowner's name, email or phone", async () => {
    const t = await ConversationThread.create({
      ghlConversationId: "c1",
      ghlContactId: "x1",
      channel: "SMS",
      firstName: "Patricia",
      town: "Lindenhurst",
      status: "reply_proposed",
      messages: [{ direction: "inbound", channel: "SMS", body: "Hi I'm Patricia, is the visit free? call me 631-555-0199 or pat@example.com", at: new Date() }],
    });
    await GrowthAction.create({
      type: "conversation_reply",
      idempotencyKey: "r1",
      status: "awaiting_approval",
      riskTier: "medium",
      modeAtProposal: "supervised",
      proposedBy: { kind: "agent", name: "Conversation agent" },
      summary: "Reply to Patricia",
      rationale: "Patricia asked about the free visit",
      payload: { threadId: String(t._id), reply: "Hi Patricia, yes - your first visit is free. - Profixter", channel: "SMS", inboundCount: 1 },
    });
    const { items } = await office.approvalsList();
    const it = items[0];
    assert.strictEqual(it.robot, "conversation");
    assert.match(it.simple.say, /homeowner in Lindenhurst/);
    assert.match(it.simple.ask, /Can I send this reply\?/);
    const all = JSON.stringify(it);
    for (const bad of ["Patricia", "631-555-0199", "pat@example.com"]) assert.ok(!all.includes(bad), `${bad} leaked`);
    assert.match(it.chatgpt, /cannot be unsent/);
  });

  await test("a playbook approval quotes the exact email and its audience", async () => {
    await EmailPlaybook.create({
      key: "pb1",
      name: "Undecided after the free visit",
      segment: "free_visit_undecided",
      subject: "How did your free visit go?",
      headline: "Thanks for having us",
      paragraphs: ["We hope the visit helped."],
      ctaLabel: "See plans",
      ctaRoute: "/membership/plans",
      status: "draft",
      createdBy: "Conversion agent",
    });
    const { items } = await office.approvalsList();
    const it = items.find((x) => x.kind === "playbook");
    assert.match(it.simple.ask, /Can I use this email\?/);
    assert.ok(it.chatgpt.includes("Subject: How did your free visit go?"));
    assert.ok(it.chatgpt.includes("Had the free visit 3-60 days ago"));
  });

  await test("notes: the agent's plain words when it wrote them, an honest fallback when not", async () => {
    await AgentFinding.create({ agent: "outreach", kind: "opportunity", severity: "high", title: "Member referrals look strongest", detail: "Referral programs convert...", evidence: "37 members", plain: "Boss, our members could bring their neighbors. Want me to plan a small test?", ownerQuestion: "Should I plan a referral test?" });
    await AgentFinding.create({ agent: "visibility", kind: "risk", severity: "medium", title: "GSC not connected", detail: "CTR unknown" });
    const { notes } = await office.approvalsList();
    const withPlain = notes.find((n) => n.robot === "outreach");
    const without = notes.find((n) => n.robot === "visibility");
    assert.match(withPlain.simple.say, /neighbors/);
    assert.strictEqual(withPlain.simple.ask, "Should I plan a referral test?");
    assert.strictEqual(without.simple.pendingSimple, true);
    assert.match(without.chatgpt, /CTR unknown/, "the brief keeps the technical detail");
  });

  await test("shift reports: the agent's FOR THE OWNER part is the simple version", async () => {
    const parts = splitOwnerSummary("FOR THE OWNER: Boss, I checked our pages. Nothing needed changing.\nDETAILS: 12 pages, 0 proposals; GSC rows 340.");
    await AgentRun.create({ agent: "visibility", status: "succeeded", trigger: "schedule", startedAt: new Date(), costCents: 31, ...parts });
    await AgentRun.create({ agent: "visibility", status: "failed", trigger: "schedule", startedAt: new Date(Date.now() - 1000), error: "transient: 529 overloaded" });
    const d = await office.robotDetail("visibility");
    assert.match(d.runs[0].simple.say, /^Boss, I checked our pages/);
    assert.match(d.runs[0].chatgpt, /12 pages, 0 proposals/);
    assert.match(d.runs[1].simple.say, /AI service was busy/);
    assert.ok(d.mistakes.length && d.mistakes[0].simple.say);
    assert.match(d.explained.simple.say, /^Hi Boss! I'm Odysseus/);
    assert.match(d.teach.explained.chatgpt, /Help me write short, clear guidance/);
  });

  await test("the results board brief uses only real numbers and says what is missing", async () => {
    const fake = {
      kpis: { firstFreeVisits: { last7: 2, prev7: 1, last30: 5, prev30: 12 }, funnel30: null, search: null, searchReason: "not connected", conversations30: { total: 0, qualified: 0 }, bySource30: [] },
      costs: { todayCents: 18, monthCents: 151, dailyCapCents: 500, monthlyCapCents: 7500 },
      approvals: { total: 1, notes: 2 },
      robots: [],
      conversationsEnabled: false,
    };
    const e = explain.explainResults(fake);
    assert.match(e.simple.say, /This week, 2 homeowners booked their first free visit - 1 more than last week\./);
    assert.match(e.chatgpt, /Google clicks: not available \(not connected\)/);
    const none = explain.explainResults({ ...fake, kpis: { ...fake.kpis, firstFreeVisits: null } });
    assert.match(none.simple.say, /can't see this week's bookings/);
  });

  await test("agents now write plain words on findings and proposals", async () => {
    const ctx = { agent: "visibility", agentLabel: "Visibility & Organic Acquisition agent", toolNames: AGENTS.visibility.tools, allowedActions: AGENTS.visibility.allowedActions, findingsThisRun: 0, findingIds: [], actionIds: [] };
    await runTool(
      "record_finding",
      { kind: "insight", severity: "low", title: "t", detail: "d", expected_impact: "e", evidence: "ev", dedupe_key: "k", plain: "Boss, I learned something small.", owner_question: null },
      ctx
    );
    const f = await AgentFinding.findOne({ dedupeKey: "k" }).lean();
    assert.strictEqual(f.plain, "Boss, I learned something small.");
    assert.strictEqual(f.plainBy, "agent");
    for (const name of ["record_finding", "propose_action", "save_content_draft"]) {
      assert.ok(require("../utils/agents/tools").TOOL_DEFS[name].input_schema.properties.plain, `${name} lacks plain`);
    }
  });

  await test("the explainer writes missing plain versions once, metered, and only when AI is on and in budget", async () => {
    const f = await AgentFinding.create({ agent: "visibility", kind: "risk", severity: "medium", title: "GSC not connected", detail: "CTR unknown" });
    const agentWritten = await AgentFinding.create({ agent: "visibility", kind: "risk", severity: "low", title: "x", detail: "y", plain: "Mine." });
    let calls = 0;
    plainExplainer.setClientFactory(() => ({
      beta: { messages: { create: async () => ((calls += 1), { usage: { input_tokens: 800, output_tokens: 90 }, content: [{ type: "text", text: JSON.stringify({ plain: "Boss, I can't see Google data yet.", owner_question: "" }) }] }) } },
    }));
    delete process.env.AGENTS_ENABLED;
    assert.deepStrictEqual(await plainExplainer.explainMissing({ findings: [f.toObject()] }), { skipped: "budget_or_off" });
    assert.strictEqual(calls, 0);
    process.env.AGENTS_ENABLED = "true";
    process.env.ANTHROPIC_API_KEY = "test-key-not-real";
    const out = await plainExplainer.explainMissing({ findings: [f.toObject(), agentWritten.toObject()], robotName: "Odysseus" });
    assert.strictEqual(out.done, 1);
    assert.strictEqual(calls, 1, "agent-written plain text is never rewritten");
    const after = await AgentFinding.findById(f._id).lean();
    assert.strictEqual(after.plain, "Boss, I can't see Google data yet.");
    assert.strictEqual(after.plainBy, "explainer");
    const meter = await AgentRun.findOne({ agent: "explainer" }).lean();
    assert.ok(meter && meter.costCents > 0 && meter.status === "succeeded");
    delete process.env.AGENTS_ENABLED;
    delete process.env.ANTHROPIC_API_KEY;
  });

  await mongoose.disconnect();
  await mongo.stop();
  console.log(`\n${passed} passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
