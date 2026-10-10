/**
 * Growth agents: the loop, its limits, the tools' privacy and permissions,
 * caps, schedules, secrets and retry. A scripted fake model client - no API calls,
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
const registry = require("../utils/growth/actionRegistry");
const { nextRun, nextRunFor } = require("../utils/agents/schedule");
const secrets = require("../utils/secrets");
const { isTransient } = require("../utils/agents/runtime");

/* A harmless internal action, so the propose path can be exercised. */
registry.defineAction({
  type: "test_internal_note",
  label: "Test internal note",
  description: "test",
  riskTier: "low",
  defaultMode: "shadow",
  maxMode: "autonomous",
  execute: async () => ({ outcome: "done" }),
});

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

const def = (over = {}) => ({
  ...AGENTS.conversion,
  tools: [...AGENTS.conversion.tools, "propose_action"],
  allowedActions: ["test_internal_note"],
  maxTurns: 6,
  budgetCents: 50,
  ...over,
});

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
            type: "test_internal_note",
            payload_json: JSON.stringify({ note: "x" }),
            rationale: "evidence",
            idempotency_key: "note:2026-10-10",
          }),
          use("t5", "write_memory", { key: "cac:fb", content: "FB CAC $40 (28d to 10/10)" }),
        ],
      },
      { stop_reason: "end_turn", content: [text("Reviewed the funnel; recorded the free-visit conversion gap.")] },
    ]);
    setClientFactory(() => client);
    const run = await runAgent(def(), { trigger: "test" });
    assert.strictEqual(run.status, "succeeded", run.error);
    assert.strictEqual(run.turns, 3);
    assert.strictEqual(run.toolCalls.length, 5);
    assert.ok(run.toolCalls.every((c) => c.ok), JSON.stringify(run.toolCalls));
    assert.match(run.summary, /Reviewed/);
    assert.strictEqual(run.findings.length, 1);
    assert.strictEqual(run.actions.length, 1);
    const action = await GrowthAction.findById(run.actions[0]).lean();
    assert.strictEqual(action.status, "shadow");
    assert.strictEqual(action.riskTier, "low");
    assert.strictEqual(action.proposedBy.kind, "agent");
    assert.ok(await AgentMemory.exists({ agent: "conversion", key: "cac:fb" }));
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
      { stop_reason: "tool_use", content: [use("t1", "publish_owner_report", { headline: "h", sections: [] })] },
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

  console.log("operations");

  await test("the production agents propose nothing: no agent has an allowed action", async () => {
    for (const a of Object.values(AGENTS)) assert.deepStrictEqual(a.allowedActions, [], a.name);
    assert.deepStrictEqual(Object.keys(AGENTS).sort(), ["conversion", "growth_intelligence", "visibility"]);
  });

  await test("the monthly budget across agents skips further runs", async () => {
    process.env.AGENTS_MONTHLY_BUDGET_CENTS = "100";
    await AgentRun.create({ agent: "visibility", status: "succeeded", startedAt: new Date(), costCents: 80 });
    const run = await runAgent(def({ budgetCents: 50 }), { trigger: "test" });
    assert.strictEqual(run.status, "skipped");
    assert.match(run.skipReason, /monthly_budget/);
    delete process.env.AGENTS_MONTHLY_BUDGET_CENTS;
  });

  await test("transient API failures are marked for one retry; permanent ones are not", async () => {
    assert.strictEqual(isTransient({ status: 529 }), true);
    assert.strictEqual(isTransient({ status: 429 }), true);
    assert.strictEqual(isTransient({ message: "Connection error." }), true);
    assert.strictEqual(isTransient({ status: 401 }), false);
    assert.strictEqual(isTransient({ status: 400 }), false);
    setClientFactory(() => ({ beta: { messages: { create: async () => { throw Object.assign(new Error("Overloaded"), { status: 529 }); } } } }));
    const run = await runAgent(def(), { trigger: "test" });
    assert.strictEqual(run.status, "failed");
    assert.match(run.error, /^transient:/);
  });

  await test("next scheduled run is computed in New York time", async () => {
    // Friday 2026-10-09 22:00 NY -> daily check (Tue-Sun) next fires Sat 07:40 NY = 11:40Z.
    const from = new Date("2026-10-10T02:00:00Z");
    assert.strictEqual(nextRun("40 7 * * 0,2-6", { from }).toISOString(), "2026-10-10T11:40:00.000Z");
    // Monday-only 09:30 NY from that Friday night -> Mon 2026-10-12 13:30Z.
    assert.strictEqual(nextRun("30 9 * * 1", { from }).toISOString(), "2026-10-12T13:30:00.000Z");
    const gi = nextRunFor(AGENTS.growth_intelligence, { from });
    assert.strictEqual(gi.mode, "daily");
    assert.throws(() => nextRun("*/5 * * * *"), /Unsupported/);
  });

  await test("secrets load from Parameter Store by allow-listed name, never overriding an explicit variable", async () => {
    const env = { ANTHROPIC_API_KEY: "", META_ADS_ACCESS_TOKEN: "explicit-wins" };
    secrets.setClientFactory(() => ({
      send: async () => ({
        Parameters: [
          { Name: "/profixter/prod/ANTHROPIC_API_KEY", Value: "sk-from-ssm" },
          { Name: "/profixter/prod/META_ADS_ACCESS_TOKEN", Value: "from-ssm" },
          { Name: "/profixter/prod/MONGO_URI", Value: "should-not-load" },
        ],
      }),
    }));
    const out = await secrets.loadParameterSecrets({ env });
    assert.strictEqual(env.ANTHROPIC_API_KEY, "sk-from-ssm");
    assert.strictEqual(env.META_ADS_ACCESS_TOKEN, "explicit-wins");
    assert.strictEqual(env.MONGO_URI, undefined);
    assert.deepStrictEqual(out.loaded, ["ANTHROPIC_API_KEY"]);
    secrets.setClientFactory(() => ({ send: async () => { throw Object.assign(new Error("denied"), { name: "AccessDeniedException" }); } }));
    const denied = await secrets.loadParameterSecrets({ env: {} });
    assert.match(denied.error, /access_denied/);
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
