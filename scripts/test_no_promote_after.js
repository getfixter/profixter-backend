/**
 * No automatic promotion, and capability text that tells the truth (owner
 * decision Q-7, 2026-11-12).
 *
 *   - no growth action definition carries promoteAfter; asking for one is
 *     refused at registration;
 *   - a long run of verified successes never moves a supervised type to
 *     autonomous - for every real type that could reach autonomous;
 *     only the owner's setPolicyMode does;
 *   - the Growth Office capability text matches what the code does: Odysseus
 *     cannot publish (Google posts are drafts), Marcus's emails send on their
 *     own once the wording is approved, no "past members", GoHighLevel stated
 *     as retired, and "Watch-only" follows the real per-type switch;
 *   - the boot line does not claim the agents are off before the secrets load.
 *
 * In-memory MongoDB; nothing is executed against the outside world.
 *   node scripts/test_no_promote_after.js
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const ROOT = path.join(__dirname, "..");
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith("http://127.0.0.1")) return realFetch(url, init);
  throw new Error(`network call attempted: ${url}`);
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

async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const GrowthPolicy = require("../models/GrowthPolicy");
  const AdminActivityLog = require("../models/AdminActivityLog");
  require("../utils/growth/actions");
  const registry = require("../utils/growth/actionRegistry");
  const engine = require("../utils/growth/actionEngine");

  console.log("no automatic supervised -> autonomous");

  await test("no definition carries promoteAfter, and the source of every action file is free of it", () => {
    for (const def of registry.listDefinitions()) assert.strictEqual(def.promoteAfter, null, def.type);
    const dir = path.join(ROOT, "utils", "growth", "actions");
    for (const f of fs.readdirSync(dir)) assert.ok(!/promoteAfter/.test(fs.readFileSync(path.join(dir, f), "utf8")), f);
    for (const t of ["seo_page_update", "seo_content_update", "conversation_reply", "checkout_recovery_email", "post_free_visit_sms"]) {
      assert.ok(registry.getDefinition(t), `${t} is still defined`);
    }
  });

  await test("a definition asking for promoteAfter is refused at registration", () => {
    assert.throws(
      () => registry.defineAction({ type: "x_promote_test", label: "x", description: "x", riskTier: "low", defaultMode: "supervised", maxMode: "autonomous", promoteAfter: 1, execute: async () => ({}) }),
      /promoteAfter is not supported/
    );
  });

  await test("50 verified successes never promote any real supervised type", async () => {
    const candidates = registry.listDefinitions().filter((d) => registry.rank(d.maxMode) >= registry.rank("autonomous"));
    assert.ok(candidates.some((d) => d.type === "seo_page_update"));
    for (const def of candidates) {
      await GrowthPolicy.updateOne({ type: def.type }, { $set: { mode: "supervised" } }, { upsert: true });
      for (let i = 0; i < 50; i += 1) await engine._internal.recordVerifiedSuccess(def);
      const p = await GrowthPolicy.findOne({ type: def.type }).lean();
      assert.strictEqual(p.mode, "supervised", def.type);
      assert.strictEqual(p.consecutiveVerifiedSuccesses, 50, `${def.type}: the streak is counted for the owner to see`);
    }
    assert.ok(!(await AdminActivityLog.exists({ action: "growth_action.policy_promoted" })));
  });

  await test("the owner can still promote by hand, and the Command Center reports promoteAfter null", async () => {
    await engine.setPolicyMode("seo_page_update", "autonomous", { kind: "owner", name: "Owner" }, "by hand");
    const p = await GrowthPolicy.findOne({ type: "seo_page_update" }).lean();
    assert.deepStrictEqual([p.mode, p.setBy.kind], ["autonomous", "owner"]);
    const src = fs.readFileSync(path.join(ROOT, "utils", "growth", "commandCenter.js"), "utf8");
    assert.match(src, /promoteAfter: null/);
  });

  console.log("capability text");
  const office = require("../utils/growth/office");
  const robot = (key) => office.ROBOTS.find((r) => r.key === key);

  await test("Odysseus: cannot publish; Google posts are drafts the owner posts", () => {
    const o = robot("visibility");
    assert.match(o.cannot.join(" | "), /Publish anything on its own - Google posts are drafts you post by hand/);
    assert.ok(!o.actionTypes.includes("gbp_post"));
  });

  await test("Marcus: emails send automatically after one wording approval; no past members; GoHighLevel retired", () => {
    const m = robot("conversation");
    const all = [m.role, m.mission, ...m.does, ...m.cannot].join(" | ");
    assert.doesNotMatch(all, /past members/i);
    assert.match(m.does.join(" "), /approve the wording once/);
    assert.match(m.does.join(" "), /emails send automatically/);
    assert.doesNotMatch(m.cannot.join(" "), /Send anything without your approval/);
    assert.match(m.cannot.join(" "), /GoHighLevel \(retired\)/);
    assert.doesNotMatch(all, /GoHighLevel is out of scope/);
  });

  await test("'Watch-only' follows the real per-type switch and policy, not only the global switch", async () => {
    await GrowthPolicy.deleteMany({});
    delete process.env.GROWTH_ACTIONS_ENABLED;
    delete process.env.GROWTH_ACTIONS_ENABLED_TYPES;
    const emailRow = async () => office.capabilities(robot("conversation"), { ...(await office.capabilityFlags()), searchConsole: false }).find((c) => c.label === "Follow-up emails");
    let row = await emailRow();
    assert.deepStrictEqual([row.state, row.note], ["off", "Watch-only: nothing is sent"]);
    // the production setup: global switch off, follow-up emails on by themselves
    process.env.GROWTH_ACTIONS_ENABLED_TYPES = "playbook_email";
    row = await emailRow();
    assert.strictEqual(row.state, "on", "emails really send, so the card must not say Watch-only");
    assert.match(row.note, /automatically once you approve a playbook's wording/);
    await GrowthPolicy.create({ type: "playbook_email", mode: "supervised" });
    row = await emailRow();
    assert.strictEqual(row.state, "approval");
    const replies = office.capabilities(robot("conversation"), { ...(await office.capabilityFlags()), searchConsole: false }).find((c) => /GoHighLevel/.test(c.label));
    assert.strictEqual(replies.state, "never");
    // a leftover gbp_post in the switch shows nothing as acting
    process.env.GROWTH_ACTIONS_ENABLED_TYPES = "gbp_post";
    const seo = office.capabilities(robot("visibility"), { ...(await office.capabilityFlags()), searchConsole: false });
    assert.strictEqual(seo.find((c) => c.label === "Page wording changes").state, "off");
    assert.strictEqual(seo.find((c) => c.label === "Google Business Profile posts").note, "Drafts only - you post them by hand");
    delete process.env.GROWTH_ACTIONS_ENABLED_TYPES;
  });

  await test("the boot line no longer reports 'enabled: false' before the secret store loads", () => {
    const src = fs.readFileSync(path.join(ROOT, "jobs", "agents.js"), "utf8");
    const boot = src.slice(src.indexOf('event: "agent_jobs_started"') - 40, src.indexOf('event: "agent_jobs_started"') + 200);
    assert.doesNotMatch(boot, /enabled: agentsEnabled\(\)/);
    assert.match(src, /event: "agent_jobs_ready", enabled: agentsEnabled\(\)/, "the real state is logged after the secrets load");
    assert.ok(!src.includes("socialPlanner"), "no GoHighLevel check at boot");
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
