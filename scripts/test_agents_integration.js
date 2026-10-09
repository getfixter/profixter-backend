/**
 * Growth agents: the loop, its limits, the tools' privacy and permissions,
 * and the Meta actions' guards. A scripted fake model client - no API calls,
 * no spend. In-memory MongoDB.
 *
 *   node scripts/test_agents_integration.js
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

const assert = require("assert");
const path = require("path");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const mails = [];
const emailServicePath = require.resolve(path.join(__dirname, "../utils/emailService"));
require.cache[emailServicePath] = {
  id: emailServicePath,
  filename: emailServicePath,
  loaded: true,
  exports: { sendRaw: async (m) => (mails.push(m), { messageId: "m" }), sendTx: async () => ({}) },
};

const AgentRun = require("../models/AgentRun");
const AgentFinding = require("../models/AgentFinding");
const AgentMemory = require("../models/AgentMemory");
const GrowthAction = require("../models/GrowthAction");
require("../utils/growth/actions");
const { runAgent, setClientFactory, costOf } = require("../utils/agents/runtime");
const { TOOL_DEFS, overviewForAgents, toolsFor } = require("../utils/agents/tools");
const { AGENTS } = require("../utils/agents/definitions");
const meta = require("../utils/growth/actions/metaAdsActions");

let passed = 0;
async function test(name, fn) {
  await Promise.all([AgentRun.deleteMany({}), AgentFinding.deleteMany({}), AgentMemory.deleteMany({}), GrowthAction.deleteMany({})]);
  mails.length = 0;
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}`);
    throw error;
  }
}

/** A fake Anthropic client that plays back scripted turns and records requests. */
function scripted(turns, usage = { input_tokens: 1000, output_tokens: 200 }) {
  const requests = [];
  let i = 0;
  const client = {
    beta: {
      messages: {
        create: async (req) => {
          requests.push(JSON.parse(JSON.stringify(req)));
          const t = turns[Math.min(i, turns.length - 1)];
          i += 1;
          return { content: t.content, stop_reason: t.stop_reason, usage: t.usage || usage };
        },
      },
    },
  };
  return { client, requests };
}
const use = (id, name, input) => ({ type: "tool_use", id, name, input });
const text = (t) => ({ type: "text", text: t });

const def = (over = {}) => ({ ...AGENTS.marketing, maxTurns: 6, budgetCents: 50, ...over });

async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all([AgentFinding.init(), AgentMemory.init(), GrowthAction.init()]);
  console.log("agents");

  await test("every tool schema is strict-valid (all props required, no extras)", async () => {
    const check = (schema, where) => {
      if (schema.type === "object") {
        assert.strictEqual(schema.additionalProperties, false, `${where} additionalProperties`);
        assert.deepStrictEqual([...schema.required].sort(), Object.keys(schema.properties).sort(), `${where} required`);
        for (const [k, v] of Object.entries(schema.properties)) check(v, `${where}.${k}`);
      } else if (schema.type === "array") check(schema.items, `${where}[]`);
      for (const bad of ["minimum", "maximum"]) assert.ok(!(bad in schema), `${where} uses ${bad}`);
    };
    for (const [name, d] of Object.entries(TOOL_DEFS)) check(d.input_schema, name);
    for (const a of Object.values(AGENTS)) {
      assert.strictEqual(toolsFor(a.tools).length, a.tools.length);
      if (a.allowedActions.length) assert.ok(a.tools.includes("propose_action"), `${a.name} has actions but no propose_action tool`);
    }
  });

  await test("switched off: a scheduled slot records a skipped run and calls nothing", async () => {
    delete process.env.AGENTS_ENABLED;
    let called = false;
    setClientFactory(() => ({ beta: { messages: { create: async () => ((called = true), {}) } } }));
    const run = await runAgent(def(), { trigger: "schedule" });
    assert.strictEqual(run.status, "skipped");
    assert.ok(/no_api_key|agents_disabled/.test(run.skipReason));
    assert.strictEqual(called, false);
  });

  await test("a full run: tools, a finding, a proposal held in shadow, memory, summary, cost", async () => {
    delete process.env.GROWTH_ACTIONS_ENABLED;
    const { client, requests } = scripted([
      { stop_reason: "tool_use", content: [use("t1", "read_memory", {}), use("t2", "list_findings", { scope: "all", status: "open" })] },
      {
        stop_reason: "tool_use",
        content: [
          use("t3", "record_finding", {
            kind: "insight", severity: "medium", title: "Instagram CAC 2x Facebook", detail: "d", expected_impact: "e", evidence: "x", dedupe_key: "cac:ig-vs-fb",
          }),
          use("t4", "propose_action", {
            type: "meta_adset_budget_change",
            payload_json: JSON.stringify({ adsetId: "1234567", adsetName: "FB Free visit", fromDailyBudgetCents: 2000, newDailyBudgetCents: 2400 }),
            rationale: "3 members at $40 CAC over 28 days",
            idempotency_key: "budget:1234567:2026-10-10",
          }),
          use("t5", "write_memory", { key: "cac:fb", content: "FB CAC $40 (28d to 10/10)" }),
        ],
      },
      { stop_reason: "end_turn", content: [text("Reviewed ads; proposed +20% on the FB free-visit ad set.")] },
    ]);
    setClientFactory(() => client);
    const run = await runAgent(def(), { trigger: "test" });
    assert.strictEqual(run.status, "succeeded", run.error);
    assert.strictEqual(run.turns, 3);
    assert.strictEqual(run.toolCalls.length, 5);
    assert.ok(run.toolCalls.every((c) => c.ok), JSON.stringify(run.toolCalls));
    assert.match(run.summary, /proposed \+20%/);
    assert.strictEqual(run.findings.length, 1);
    assert.strictEqual(run.actions.length, 1);
    const action = await GrowthAction.findById(run.actions[0]).lean();
    assert.strictEqual(action.status, "shadow");
    assert.strictEqual(action.riskTier, "high");
    assert.strictEqual(action.proposedBy.kind, "agent");
    assert.ok(await AgentMemory.exists({ agent: "marketing", key: "cac:fb" }));
    assert.ok(Math.abs(run.costCents - Math.round(costOf({ input_tokens: 3000, output_tokens: 600 }) * 100) / 100) < 0.01);
    // Requests: Opus 5.5, adaptive thinking, explicit effort, fallbacks, auto tool choice only.
    const r0 = requests[0];
    assert.strictEqual(r0.model, "claude-opus-5-5");
    assert.deepStrictEqual(r0.thinking, { type: "adaptive" });
    assert.strictEqual(r0.output_config.effort, "high");
    assert.strictEqual(r0.fallbacks, "default");
    assert.ok(!("tool_choice" in r0));
    // All tool results of a turn come back in ONE user message, assistant content echoed unchanged.
    const r2 = requests[2];
    const last = r2.messages[r2.messages.length - 1];
    assert.strictEqual(last.role, "user");
    assert.strictEqual(last.content.filter((b) => b.type === "tool_result").length, 3);
    assert.deepStrictEqual(r2.messages[r2.messages.length - 2].content, requests[1].messages.length ? r2.messages[r2.messages.length - 2].content : null);
  });

  await test("an action outside the agent's list is refused as a tool error, and the run carries on", async () => {
    const { client } = scripted([
      { stop_reason: "tool_use", content: [use("t1", "propose_action", { type: "checkout_recovery_email", payload_json: "{}", rationale: "r", idempotency_key: "k" })] },
      { stop_reason: "end_turn", content: [text("done")] },
    ]);
    setClientFactory(() => client);
    const run = await runAgent(def(), { trigger: "test" });
    assert.strictEqual(run.status, "succeeded");
    assert.strictEqual(run.toolCalls[0].ok, false);
    assert.match(run.toolCalls[0].error, /Not allowed/);
    assert.strictEqual(await GrowthAction.countDocuments({}), 0);
  });

  await test("a tool the agent does not have cannot be called", async () => {
    const { client } = scripted([
      { stop_reason: "tool_use", content: [use("t1", "save_content_draft", { page_type: "guide", target: "/x", title: "t", why: "w", body_markdown: "b", dedupe_key: "d" })] },
      { stop_reason: "end_turn", content: [text("done")] },
    ]);
    setClientFactory(() => client);
    const run = await runAgent(def(), { trigger: "test" });
    assert.strictEqual(run.toolCalls[0].ok, false);
    assert.strictEqual(await AgentFinding.countDocuments({}), 0);
  });

  await test("the per-run budget stops the loop", async () => {
    const { client } = scripted([{ stop_reason: "tool_use", content: [use("t1", "read_memory", {})], usage: { input_tokens: 200000, output_tokens: 20000 } }]);
    setClientFactory(() => client);
    const run = await runAgent(def({ budgetCents: 50 }), { trigger: "test" });
    assert.strictEqual(run.status, "budget_stopped");
    assert.strictEqual(run.turns, 1);
  });

  await test("the daily budget across agents skips further runs", async () => {
    process.env.AGENTS_DAILY_BUDGET_CENTS = "100";
    await AgentRun.create({ agent: "visibility", status: "succeeded", startedAt: new Date(), costCents: 90 });
    const run = await runAgent(def({ budgetCents: 50 }), { trigger: "test" });
    assert.strictEqual(run.status, "skipped");
    assert.match(run.skipReason, /daily_budget/);
    delete process.env.AGENTS_DAILY_BUDGET_CENTS;
  });

  await test("a refusal ends the run as failed with the category", async () => {
    setClientFactory(() => ({ beta: { messages: { create: async () => ({ content: [], stop_reason: "refusal", stop_details: { category: "cyber" }, usage: {} }) } } }));
    const run = await runAgent(def(), { trigger: "test" });
    assert.strictEqual(run.status, "failed");
    assert.match(run.error, /refusal: cyber/);
  });

  await test("the weekly owner report is saved and emailed once per week", async () => {
    const report = { headline: "2 new members; spend not connected", sections: [{ heading: "Customers", lines: ["2 new members vs 1"] }] };
    const { client } = scripted([
      { stop_reason: "tool_use", content: [use("t1", "publish_owner_report", report)] },
      { stop_reason: "tool_use", content: [use("t2", "publish_owner_report", report)] },
      { stop_reason: "end_turn", content: [text("done")] },
    ]);
    setClientFactory(() => client);
    await runAgent({ ...AGENTS.growth_intelligence, budgetCents: 50 }, { trigger: "test", mode: "weekly" });
    assert.strictEqual(mails.length, 1);
    assert.match(mails[0].subject, /2 new members/);
    assert.strictEqual(await AgentFinding.countDocuments({ kind: "report" }), 1);
  });

  await test("alerts to the owner are capped at 2 a day", async () => {
    const a = (id) => use(id, "alert_owner", { subject: "Bookings stopped", lines: ["0 bookings in 72h"] });
    const { client } = scripted([
      { stop_reason: "tool_use", content: [a("1")] },
      { stop_reason: "tool_use", content: [a("2")] },
      { stop_reason: "tool_use", content: [a("3")] },
      { stop_reason: "end_turn", content: [text("done")] },
    ]);
    setClientFactory(() => client);
    const run = await runAgent({ ...AGENTS.growth_intelligence, budgetCents: 50 }, { trigger: "test" });
    assert.strictEqual(mails.length, 2);
    assert.strictEqual(run.toolCalls[2].ok, false);
  });

  await test("the Overview handed to agents carries no personal data", async () => {
    const out = overviewForAgents({
      kpis: { activeMembers: { value: 40 } },
      activity: [{ text: "Jane Doe joined", who: "jane@x.com", userId: "u1" }],
      attention: [{ key: "free_visit_undecided", count: 2, tone: "info", text: "Jane Doe and 1 other" }],
      sources: [{ key: "meta_facebook", label: "Facebook", visitors: 10 }],
      campaigns: [],
    });
    const s = JSON.stringify(out);
    assert.ok(!/Jane|jane@|u1/.test(s), s);
    assert.strictEqual(out.attention[0].count, 2);
  });

  console.log("meta ad actions");

  await test("budget change: refused without a token or ceiling; capped at 20%; rollback restores", async () => {
    await assert.rejects(() => meta.executeBudget({ adsetId: "1234567", newDailyBudgetCents: 2400 }, { env: {} }), /META_ADS_MANAGE_TOKEN/);
    await assert.rejects(
      () => meta.executeBudget({ adsetId: "1234567", newDailyBudgetCents: 2400 }, { env: { META_ADS_MANAGE_TOKEN: "t" } }),
      /CEILING|META_MAX_ADSET_DAILY_BUDGET_CENTS/i
    );
    const posted = [];
    const fetchImpl = async (url, init) => {
      if (init?.method === "POST") {
        posted.push(String(init.body));
        return { ok: true, status: 200, json: async () => ({ success: true }) };
      }
      return { ok: true, status: 200, json: async () => ({ id: "1234567", name: "S", daily_budget: "2000", status: "ACTIVE" }) };
    };
    const env = { META_ADS_MANAGE_TOKEN: "secret-tok", META_MAX_ADSET_DAILY_BUDGET_CENTS: "5000" };
    await assert.rejects(() => meta.executeBudget({ adsetId: "1234567", newDailyBudgetCents: 2500 }, { env, fetchImpl }), /step limit/);
    await assert.rejects(
      () => meta.executeBudget({ adsetId: "1234567", newDailyBudgetCents: 2400 }, { env: { ...env, META_MAX_ADSET_DAILY_BUDGET_CENTS: "2200" }, fetchImpl }),
      /ceiling/
    );
    const out = await meta.executeBudget({ adsetId: "1234567", newDailyBudgetCents: 2400 }, { env, fetchImpl });
    assert.strictEqual(out.result.previousDailyBudgetCents, 2000);
    assert.match(posted[0], /daily_budget=2400/);
    await meta.rollbackBudget({ payload: { adsetId: "1234567" }, result: out.result }, { env, fetchImpl });
    assert.match(posted[1], /daily_budget=2000/);
  });

  await test("Meta actions can never be set to run unattended", async () => {
    const engine = require("../utils/growth/actionEngine");
    await assert.rejects(() => engine.setPolicyMode("meta_adset_budget_change", "autonomous", { kind: "owner" }), /cannot be set above/);
    await assert.rejects(() => engine.setPolicyMode("meta_adset_status", "autonomous", { kind: "owner" }), /cannot be set above/);
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
