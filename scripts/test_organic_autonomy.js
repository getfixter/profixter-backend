/**
 * Expanded autonomous ORGANIC marketing (owner, 2026-10-12).
 *
 *   - 100% organic: paid marketing is refused everywhere an agent's words
 *     become work (tasks, focus, guidance, findings, drafts, Arthur's records,
 *     action types, posts) - while normal organic wording passes
 *   - Google Business Profile posts: RETIRED as an automatic action on
 *     2026-11-12 (GoHighLevel Social Planner removed). The copy rules still
 *     check a draft; the type is capped at shadow, an old approved or pending
 *     post is closed as skipped, rollback is refused, nothing reaches GHL
 *   - suspension: a second failure in 7 days stops an action type (shadow)
 *   - Marcus's follow-ups run on their own (approved wording only), with 7-day / 3-per-90-day caps
 *   - the action log carries agent, platform, action, time, outcome, cost
 *     and verification
 *
 * In-memory MongoDB; no network call is allowed - nothing is posted.
 *   node scripts/test_organic_autonomy.js
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.AGENTS_ENABLED = "true";
process.env.ANTHROPIC_API_KEY = "test-key-not-real";

const assert = require("assert");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

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

const GOOD = {
  summary:
    "Fall on Long Island means gutters full of leaves and drafty doors. Your first Profixter visit is free: we walk through your to-do list with you and help you choose the right service. Book it online in a minute.",
  title: "Get your home ready for fall",
  url: "https://www.profixter.com/book/free?utm_source=google&utm_medium=organic&utm_campaign=gbp_fall_prep",
  reason: "Seasonal searches for gutter cleaning are rising in Suffolk.",
};

async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  require("../utils/analytics/stripeMrr").setStripeClient({ subscriptions: { list: () => { throw new Error("not used"); } } });

  const GrowthAction = require("../models/GrowthAction");
  const GrowthPolicy = require("../models/GrowthPolicy");
  const AgentFinding = require("../models/AgentFinding");
  const { CouncilTask } = require("../models/Council");
  require("../utils/growth/actions");
  const registry = require("../utils/growth/actionRegistry");
  const engine = require("../utils/growth/actionEngine");
  const organic = require("../utils/agents/organicOnly");
  const settings = require("../utils/agents/settings");
  const tasks = require("../utils/council/tasks");
  const arthur = require("../utils/council/arthur");
  const { TOOL_DEFS } = require("../utils/agents/tools");
  const { AGENTS } = require("../utils/agents/definitions");
  const gbp = require("../utils/growth/actions/gbpPost");
  const { actionLog } = require("../utils/growth/actionLog");

  console.log("100% organic");

  await test("paid marketing is refused wherever an agent's words become work; organic wording passes", async () => {
    for (const text of [
      "Buy a premium listing on Yelp to rank higher",
      "Sponsor the Massapequa little league",
      "Boost the post about gutters for $20",
      "Pay an influencer to feature Profixter",
      "Try Local Services Ads in Suffolk",
      "Get a sponsored article in Newsday",
      "Set an ad budget for Nextdoor",
    ]) {
      assert.ok(organic.isPaid(text), text);
      assert.ok(tasks.taskProblems("outreach", text).some((p) => p.includes(organic.PAID_WHY)), `task: ${text}`);
      assert.ok(settings.validateGuidance(text).some((p) => p.includes("100% organic")), `guidance: ${text}`);
    }
    for (const text of [
      "Post a free gutter-cleaning tip on Google Business Profile for Levittown",
      "Claim the free Bing Places listing and fill in the service area",
      "Answer a homeowner question in r/longisland where business posts are allowed, disclosing Profixter",
      "Pitch a true local story about fall home prep to the Patch editor",
      "Most first free visits came from Google Ads and Google Organic last month",
    ]) {
      assert.ok(!organic.isPaid(text), text);
    }
    const ctx = { agent: "outreach", agentLabel: "Leonidas", runId: new mongoose.Types.ObjectId(), findingsThisRun: 0, findingIds: [] };
    await assert.rejects(
      TOOL_DEFS.record_finding.run({ kind: "opportunity", severity: "medium", title: "Sponsor the Babylon fall fair", detail: "d", expected_impact: "e", evidence: "ev", dedupe_key: "fair", plain: "", owner_question: "" }, ctx),
      /100% organic/
    );
    await assert.rejects(
      TOOL_DEFS.save_content_draft.run({ page_type: "directory_listing", target: "yelp", title: "Yelp", why: "x", body_markdown: "Upgrade to a premium listing for more leads.", dedupe_key: "yelp", plain: "" }, ctx),
      /100% organic/
    );
    const filed = await arthur.ARTHUR_TOOLS.file_for_owner.run({ category: "decision", subject: "Try paid ads on Nextdoor?", simple: "Boss, should we try paid ads?", detail: "x", agent: null, recommendation: "yes", dedupe_key: "nd" }, { log: [] });
    assert.strictEqual(filed.refused, true);
  });

  await test("no paid-marketing action type can even be registered", () => {
    for (const type of ["paid_listing_upgrade", "sponsor_event", "influencer_payment", "boost_post"]) {
      assert.throws(() => registry.defineAction({ type, label: "x", description: "x", riskTier: "low", defaultMode: "shadow", maxMode: "shadow", execute: async () => ({}) }), /prohibit|advertis/i, type);
    }
  });

  console.log("Google Business Profile posts");

  await test("a post is checked before it can be proposed: copy rules, organic, acquisition, link and no contact details", () => {
    assert.ok(gbp.validate(GOOD));
    const bad = (p, re) => assert.throws(() => gbp.validate({ ...GOOD, ...p }), re);
    bad({ url: "https://www.profixter.com/book/free" }, /tagged utm_source=google/);
    bad({ url: "https://evil.example/book/free?utm_source=google&utm_medium=organic" }, /button link/);
    bad({ summary: `${GOOD.summary} 20% off this week!` }, /discounts/);
    bad({ summary: `${GOOD.summary} Ask about our free inspection and estimate.` }, /inspection, estimate/);
    bad({ summary: `${GOOD.summary} Unlimited visits for members.` }, /unlimited/);
    bad({ summary: `${GOOD.summary} This post is sponsored by our partners.` }, /100% organic/);
    bad({ summary: `${GOOD.summary} Call 631-555-0199 today.` }, /phone numbers/);
    bad({ summary: `${GOOD.summary} See https://example.com` }, /No links in the text/);
    bad({ summary: "Too short." }, /80-1400/);
  });

  await test("retired 2026-11-12: Odysseus can no longer propose a Google post; he drafts it for the owner", () => {
    for (const a of Object.values(AGENTS)) assert.ok(!a.allowedActions.includes("gbp_post"), a.name);
    assert.match(AGENTS.visibility.instructions, /Google Business Profile posts are DRAFTS for the owner, never published/);
    assert.doesNotMatch(AGENTS.visibility.instructions, /EVERY SHIFT, if no post went out/);
    assert.ok(TOOL_DEFS.save_content_draft.input_schema.properties.page_type.enum.includes("gbp_post"), "a Google post can still be saved as a draft");
  });

  await test("gbp_post is capped at shadow in code: no stored policy, switch or owner button can make it publish", async () => {
    await GrowthAction.deleteMany({});
    await GrowthPolicy.deleteMany({});
    const def = registry.getDefinition("gbp_post");
    assert.deepStrictEqual([def.defaultMode, def.maxMode, def.verify, def.rollback], ["shadow", "shadow", null, null]);
    assert.match(def.retiredReason, /^ghl_retired/);
    // the live database still says "autonomous" for gbp_post: the code ceiling wins
    await GrowthPolicy.create({ type: "gbp_post", mode: "autonomous" });
    assert.strictEqual(await engine.resolveMode(def), "shadow");
    await assert.rejects(engine.setPolicyMode("gbp_post", "autonomous", { kind: "owner" }), /cannot be set above shadow/);
    await assert.rejects(engine.setPolicyMode("gbp_post", "supervised", { kind: "owner" }), /cannot be set above shadow/);
    // a "gbp_post" left in the per-type switch is ignored, and the global switch does not help either
    process.env.GROWTH_ACTIONS_ENABLED_TYPES = "gbp_post, playbook_email, seo_page_update, post_free_visit_sms";
    assert.deepStrictEqual(engine.enabledTypes(), ["playbook_email"], "only follow-up emails can be switched on by the list");
    assert.strictEqual(engine.typeEnabled("gbp_post"), false);
    process.env.GROWTH_ACTIONS_ENABLED = "true";
    const post = await engine.propose("gbp_post", GOOD, { idempotencyKey: "gbp-1", rationale: "x", proposedBy: { kind: "agent", name: "Odysseus" } });
    assert.strictEqual(post.action.status, "shadow", "recorded only");
    delete process.env.GROWTH_ACTIONS_ENABLED;
    delete process.env.GROWTH_ACTIONS_ENABLED_TYPES;
    await GrowthPolicy.deleteMany({});
  });

  await test("an old approved or pending Google post is closed as skipped with the reason, never published, and nothing reaches GoHighLevel", async () => {
    await GrowthAction.deleteMany({});
    const fetched = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      fetched.push(String(url));
      throw new Error("no network in this test");
    };
    try {
      process.env.GROWTH_ACTIONS_ENABLED = "true";
      const queued = await GrowthAction.create({ type: "gbp_post", idempotencyKey: "gbp-old-queued", status: "approved", riskTier: "medium", modeAtProposal: "autonomous", payload: { ...GOOD } });
      const ran = await engine.execute(queued._id);
      assert.strictEqual(ran.status, "skipped");
      assert.match(ran.result.reason, /^ghl_retired: Google Business Profile posts are no longer published automatically/);
      assert.ok(!ran.executedAt);
      const pending = await GrowthAction.create({ type: "gbp_post", idempotencyKey: "gbp-old-pending", status: "awaiting_approval", riskTier: "medium", modeAtProposal: "supervised", payload: { ...GOOD } });
      const approved = await engine.approve(pending._id, { kind: "owner", name: "Owner" });
      assert.strictEqual(approved.status, "skipped");
      assert.match(approved.result.reason, /^ghl_retired/);
      // the sweep closes any left in a queue, even with every switch off
      delete process.env.GROWTH_ACTIONS_ENABLED;
      const left = await GrowthAction.create({ type: "gbp_post", idempotencyKey: "gbp-old-left", status: "approved", riskTier: "medium", modeAtProposal: "autonomous", payload: { ...GOOD } });
      const swept = await engine.runSweeps();
      assert.ok(swept.retiredClosed >= 1);
      assert.strictEqual((await GrowthAction.findById(left._id).lean()).status, "skipped");
      // the execute function itself never publishes
      assert.deepStrictEqual(await gbp.execute(GOOD, { action: {}, now: new Date() }), { outcome: "skip", reason: gbp.RETIRED_REASON });
      assert.deepStrictEqual(fetched, [], "no network call at all");
      assert.ok(!require("fs").existsSync(require("path").join(__dirname, "..", "utils", "ghl", "socialPlanner.js")), "the Social Planner client is gone");
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.GROWTH_ACTIONS_ENABLED;
    }
  });

  await test("rolling back a past Google post is refused (GHL_RETIRED) and touches nothing: the live posts are the owner's to manage in Google", async () => {
    const done = await GrowthAction.create({ type: "gbp_post", idempotencyKey: "gbp-done", status: "succeeded", riskTier: "medium", modeAtProposal: "autonomous", payload: { ...GOOD }, result: { postId: "post-1" }, executedAt: new Date() });
    await assert.rejects(engine.rollback(done._id, { kind: "owner" }), (e) => e.code === "GHL_RETIRED" && e.status === 400);
    assert.strictEqual((await GrowthAction.findById(done._id).lean()).status, "succeeded", "unchanged");
  });

  await test("the Growth tab shows each post's text and, once verified, its public link", () => {
    const { publicAction } = require("../utils/growth/commandCenter");
    const base = { _id: new mongoose.Types.ObjectId(), type: "gbp_post", status: "succeeded", payload: { ...GOOD }, result: { postId: "p1" } };
    assert.match(publicAction({ ...base, verification: { status: "pending" } }).result.to, /checking that it published/);
    assert.strictEqual(publicAction({ ...base, verification: { status: "passed", detail: "published at https://g.page/r/x/post/1" } }).result.to, "Google Business Profile - https://g.page/r/x/post/1");
    assert.match(publicAction({ ...base, verification: { status: "failed", detail: "not published within 6 hours" } }).result.to, /NOT published/);
    assert.match(publicAction(base).preview, /Get your home ready for fall[\s\S]*Book button: https:\/\/www\.profixter\.com\/book\/free\?utm_source=google/);
  });

  console.log("suspension, follow-up limits, action log");

  await test("a second failure within 7 days suspends the action type completely", async () => {
    await GrowthPolicy.deleteMany({});
    await GrowthPolicy.create({ type: "seo_page_update", mode: "autonomous" });
    const def = registry.getDefinition("seo_page_update");
    const fail = (k) => GrowthAction.create({ type: "seo_page_update", idempotencyKey: k, status: "failed", riskTier: "medium", modeAtProposal: "autonomous" });
    await fail("f1");
    await engine._internal.recordFailure(def, "run failed: boom");
    assert.strictEqual((await GrowthPolicy.findOne({ type: "seo_page_update" }).lean()).mode, "supervised", "one failure: demoted");
    await fail("f2");
    await engine._internal.recordFailure(def, "run failed: boom again");
    const p = await GrowthPolicy.findOne({ type: "seo_page_update" }).lean();
    assert.strictEqual(p.mode, "shadow", "two in 7 days: suspended");
    assert.strictEqual(p.setBy.kind, "auto_suspension");
    const { suspendedTypes } = require("../utils/growth/actionLog");
    assert.deepStrictEqual((await suspendedTypes()).map((s) => s.type), ["seo_page_update"]);
  });

  await test("Marcus's follow-up emails run on their own (owner, 2026-10-27); the gate is the approved playbook", () => {
    const def = registry.getDefinition("playbook_email");
    assert.deepStrictEqual([def.defaultMode, def.maxMode, def.promoteAfter], ["autonomous", "autonomous", null]);
    assert.match(def.description, /7 days[\s\S]*3 follow-ups per person in 90 days/);
  });

  await test("the action log carries agent, platform, action, time, outcome, cost and verification", async () => {
    await GrowthAction.deleteMany({});
    await GrowthAction.create({
      type: "gbp_post",
      idempotencyKey: "log-1",
      status: "succeeded",
      riskTier: "medium",
      modeAtProposal: "supervised",
      summary: 'Post on Google Business Profile: "Get your home ready for fall"',
      proposedBy: { kind: "agent", name: "Odysseus - organic search & visibility" },
      executedAt: new Date(),
      result: { postId: "post-9", estimatedCostCents: 0 },
      verification: { status: "passed", detail: "published at https://g.page/r/profixter/post/9" },
    });
    const [row] = await actionLog({ days: 1 });
    assert.strictEqual(row.agent, "Odysseus - organic search & visibility");
    assert.strictEqual(row.platform, "google_business_profile");
    assert.match(row.action, /^gbp_post: Post on Google Business Profile/);
    assert.strictEqual(row.outcome, "published: https://g.page/r/profixter/post/9");
    assert.strictEqual(row.estimatedCostCents, 0);
    assert.match(row.verification, /^passed/);
    const { buildReport } = require("../utils/council/report");
    const { text } = await buildReport({ scope: "full" });
    assert.match(text, /## Action log \(14 days, newest first\)[\s\S]*google_business_profile[\s\S]*published: https:\/\/g\.page/);
    const h = await require("../utils/council/health").councilHealth();
    assert.deepStrictEqual(h.actions7d.gbp_post, { succeeded: 1 });
  });

  await test("Arthur and every knight carry the organic-only rule and the authorized activities; no knight must draft every shift", () => {
    assert.match(arthur.ARTHUR_RULES, /WHAT THE OWNER HAS AUTHORIZED[\s\S]*Google Business Profile posts[\s\S]*Not automated[\s\S]*100% ORGANIC/);
    for (const def of Object.values(AGENTS)) {
      assert.match(def.instructions, /100% ORGANIC: paid marketing is prohibited/, def.name);
      assert.match(def.instructions, /NOT required to produce a draft every shift/, def.name);
    }
    assert.doesNotMatch(AGENTS.outreach.instructions, /Prepare 2-4 ready-to-publish posts/);
  });

  await CouncilTask.deleteMany({});
  await AgentFinding.deleteMany({});
  await mongoose.disconnect();
  await mongo.stop();
  console.log(`\n${passed} organic-autonomy tests passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
