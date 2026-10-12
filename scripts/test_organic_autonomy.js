/**
 * Expanded autonomous ORGANIC marketing (owner, 2026-10-12).
 *
 *   - 100% organic: paid marketing is refused everywhere an agent's words
 *     become work (tasks, focus, guidance, findings, drafts, Arthur's records,
 *     action types, posts) - while normal organic wording passes
 *   - Google Business Profile posts: validated copy and link; only the one
 *     connected Google account can ever be posted to (never Facebook or
 *     Instagram); not connected = skipped, not pretended; once per 3 days;
 *     never the same text; verified by reading the post back; rollback deletes
 *   - suspension: a second failure in 7 days stops an action type (shadow)
 *   - Marcus's follow-ups start supervised, with 7-day / 3-per-90-day caps
 *   - the action log carries agent, platform, action, time, outcome, cost
 *     and verification
 *
 * In-memory MongoDB; GoHighLevel is a scripted fake - nothing is posted.
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
    "Fall on Long Island means gutters full of leaves and drafty doors. Your first Profixter visit is free: a real 90-minute working visit where your Fixter fixes things on your list, not an inspection. Book it online in a minute.",
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
  const social = require("../utils/ghl/socialPlanner");
  const gbp = require("../utils/growth/actions/gbpPost");
  const { actionLog } = require("../utils/growth/actionLog");

  /* A scripted Social Planner. */
  let accounts = [];
  let posts = {};
  let calls = [];
  social.setFetchForTests(async (url, opts = {}) => {
    const u = new URL(url);
    calls.push({ method: opts.method, path: u.pathname, body: opts.body ? JSON.parse(opts.body) : null });
    const reply = (status, data) => ({ ok: status < 300, status, statusText: "", text: async () => JSON.stringify(data) });
    if (opts.method === "GET" && /\/accounts$/.test(u.pathname)) return reply(200, { results: { accounts } });
    if (opts.method === "GET" && u.pathname === "/users/") return reply(200, { users: [{ id: "user-admin", roles: { role: "admin" } }] });
    if (opts.method === "POST" && /\/posts$/.test(u.pathname)) {
      const id = `post-${Object.keys(posts).length + 1}`;
      posts[id] = { _id: id, status: "scheduled" };
      return reply(201, { results: { post: { _id: id } } });
    }
    const m = u.pathname.match(/\/posts\/([^/]+)$/);
    if (m && opts.method === "GET") return reply(200, { results: { post: posts[m[1]] || { status: "deleted" } } });
    if (m && opts.method === "DELETE") {
      delete posts[m[1]];
      return reply(200, { success: true });
    }
    return reply(404, { message: "unknown" });
  });
  const GOOGLE = { id: "acc-google", platform: "google", name: "ProFixter Handyman", active: true, isExpired: false };
  const FACEBOOK = { id: "acc-fb", platform: "facebook", name: "Mr.Fixter", active: true, isExpired: false };
  const INSTAGRAM = { id: "acc-ig", platform: "instagram", name: "mrfixter.ny", active: true, isExpired: false };
  const ctxFor = () => ({ action: { _id: new mongoose.Types.ObjectId() }, now: new Date() });

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
    bad({ summary: `${GOOD.summary} Ask about our free inspection and estimate.` }, /inspection or estimate/);
    bad({ summary: `${GOOD.summary} Unlimited visits for members.` }, /unlimited/);
    bad({ summary: `${GOOD.summary} This post is sponsored by our partners.` }, /100% organic/);
    bad({ summary: `${GOOD.summary} Call 631-555-0199 today.` }, /phone numbers/);
    bad({ summary: `${GOOD.summary} See https://example.com` }, /No links in the text/);
    bad({ summary: "Too short." }, /80-1400/);
  });

  await test("not connected = skipped and said so - never pretended", async () => {
    delete process.env.GHL_SOCIAL_TOKEN;
    assert.deepStrictEqual(await gbp.execute(GOOD, ctxFor()), { outcome: "skip", reason: "not_connected" });
  });

  await test("only the one connected Google account can be posted to - Facebook and Instagram never", async () => {
    process.env.GHL_SOCIAL_TOKEN = "test-token";
    accounts = [FACEBOOK, INSTAGRAM];
    await assert.rejects(gbp.execute(GOOD, ctxFor()), /No active Google Business Profile/);
    accounts = [FACEBOOK, INSTAGRAM, GOOGLE, { ...GOOGLE, id: "acc-google-2" }];
    await assert.rejects(gbp.execute(GOOD, ctxFor()), /More than one Google Business Profile/);
    accounts = [FACEBOOK, INSTAGRAM, { ...GOOGLE, isExpired: true }];
    await assert.rejects(gbp.execute(GOOD, ctxFor()), /No active Google Business Profile/);
    accounts = [FACEBOOK, GOOGLE, INSTAGRAM];
    calls = [];
    const r = await gbp.execute(GOOD, ctxFor());
    assert.strictEqual(r.outcome, "done");
    const post = calls.find((c) => c.method === "POST");
    assert.deepStrictEqual(post.body.accountIds, ["acc-google"], "only the Google account is in the request");
    assert.strictEqual(post.body.gmbPostDetails.url, GOOD.url);
    assert.strictEqual(post.body.gmbPostDetails.actionType, "book");
    assert.strictEqual(r.result.platform, "google_business_profile");
    assert.strictEqual(r.result.estimatedCostCents, 0);
  });

  await test("once per 3 days and never the same text twice", async () => {
    await GrowthAction.create({ type: "gbp_post", idempotencyKey: "gbp-old", status: "succeeded", riskTier: "medium", modeAtProposal: "supervised", executedAt: new Date(Date.now() - 864e5), result: { fingerprint: "x" } });
    assert.deepStrictEqual(await gbp.execute({ ...GOOD, summary: `${GOOD.summary} New.` }, ctxFor()), { outcome: "skip", reason: "posted_recently" });
    await GrowthAction.updateOne({ idempotencyKey: "gbp-old" }, { $set: { executedAt: new Date(Date.now() - 10 * 864e5) } });
    const first = await gbp.execute(GOOD, ctxFor());
    await GrowthAction.create({ type: "gbp_post", idempotencyKey: "gbp-same", status: "succeeded", riskTier: "medium", modeAtProposal: "supervised", executedAt: new Date(Date.now() - 5 * 864e5), result: { fingerprint: first.result.fingerprint } });
    await GrowthAction.deleteOne({ idempotencyKey: "gbp-old" });
    assert.deepStrictEqual(await gbp.execute(GOOD, ctxFor()), { outcome: "skip", reason: "duplicate_text" });
    await GrowthAction.deleteMany({});
  });

  await test("verified only when the Social Planner says published; failed = failed; rollback deletes the post", async () => {
    const r = await gbp.execute(GOOD, ctxFor());
    const action = { result: r.result };
    assert.strictEqual((await gbp.verify(action)).passed, null, "still scheduled: not yet a success");
    posts[r.result.postId] = { status: "published", postUrl: "https://g.page/r/profixter/post/123" };
    assert.deepStrictEqual(await gbp.verify(action), { passed: true, detail: "published at https://g.page/r/profixter/post/123" });
    posts[r.result.postId] = { status: "failed", error: "Google rejected the post" };
    assert.strictEqual((await gbp.verify(action)).passed, false);
    const def = registry.getDefinition("gbp_post");
    await def.rollback({ result: r.result });
    assert.ok(!posts[r.result.postId], "deleted");
  });

  await test("Odysseus may propose Google Business Profile posts; it starts supervised and earns autonomy after 3 verified posts", () => {
    assert.ok(AGENTS.visibility.allowedActions.includes("gbp_post"));
    for (const a of ["outreach", "conversion"]) assert.ok(!AGENTS[a].allowedActions.includes("gbp_post"));
    const def = registry.getDefinition("gbp_post");
    assert.deepStrictEqual([def.defaultMode, def.maxMode, def.promoteAfter, def.limits.perDay], ["supervised", "autonomous", 3, 1]);
  });

  await test("the read-only connection check: token, auth, accounts - no post, no token in the output", async () => {
    delete process.env.GHL_SOCIAL_TOKEN;
    assert.deepStrictEqual((await social.connectionCheck()).auth, "no_token");
    process.env.GHL_SOCIAL_TOKEN = "pit-secret-test-token";
    accounts = [GOOGLE, FACEBOOK, INSTAGRAM];
    calls = [];
    const c = await social.connectionCheck();
    assert.strictEqual(c.tokenLoaded, true);
    assert.strictEqual(c.auth, "ok");
    assert.strictEqual(c.googleBusinessProfile, "ready");
    assert.deepStrictEqual(c.postableByKingdom, ["google"], "Facebook and Instagram are listed as connected but never postable");
    assert.deepStrictEqual(c.accounts.map((a) => a.platform).sort(), ["facebook", "google", "instagram"]);
    assert.ok(calls.every((x) => x.method === "GET"), "read-only");
    assert.doesNotMatch(JSON.stringify(c), /pit-secret/);
    social.setFetchForTests(async () => ({ ok: false, status: 401, statusText: "", text: async () => JSON.stringify({ message: "Invalid token pit-secret-test-token" }) }));
    const bad = await social.connectionCheck();
    assert.strictEqual(bad.auth, "error");
    assert.doesNotMatch(JSON.stringify(bad), /pit-secret/, "a token echoed in an error is redacted");
    process.env.GHL_SOCIAL_TOKEN = "test-token";
  });

  console.log("suspension, follow-up limits, action log");

  await test("a second failure within 7 days suspends the action type completely", async () => {
    await GrowthPolicy.deleteMany({});
    await GrowthPolicy.create({ type: "gbp_post", mode: "autonomous" });
    const def = registry.getDefinition("gbp_post");
    const fail = (k) => GrowthAction.create({ type: "gbp_post", idempotencyKey: k, status: "failed", riskTier: "medium", modeAtProposal: "autonomous" });
    await fail("f1");
    await engine._internal.recordFailure(def, "run failed: boom");
    assert.strictEqual((await GrowthPolicy.findOne({ type: "gbp_post" }).lean()).mode, "supervised", "one failure: demoted");
    await fail("f2");
    await engine._internal.recordFailure(def, "run failed: boom again");
    const p = await GrowthPolicy.findOne({ type: "gbp_post" }).lean();
    assert.strictEqual(p.mode, "shadow", "two in 7 days: suspended");
    assert.strictEqual(p.setBy.kind, "auto_suspension");
    const { suspendedTypes } = require("../utils/growth/actionLog");
    assert.deepStrictEqual((await suspendedTypes()).map((s) => s.type), ["gbp_post"]);
  });

  await test("Marcus's follow-up emails start supervised", () => {
    const def = registry.getDefinition("playbook_email");
    assert.deepStrictEqual([def.defaultMode, def.maxMode, def.promoteAfter], ["supervised", "autonomous", 5]);
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

  social.setFetchForTests(null);
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
