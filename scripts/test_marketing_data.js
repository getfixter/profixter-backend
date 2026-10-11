/**
 * The Kingdom markets Profixter; the owner runs it (2026-10-11).
 *
 * Holds in place: no agent (and not King Arthur) has any revenue, billing,
 * Stripe, subscription-statistics, cancellation-analysis, ad-spend or
 * calendar tool - the tools do not exist; the marketing data the agents do
 * get carries no financial fields and no personal data; Marcus's follow-up
 * audiences are counts plus lawful-contact counts; the mission change is a
 * new, reversible version; the refocus review lists outdated work and
 * changes nothing; web research is available to the right heroes and metered.
 *
 * In-memory MongoDB, no API spend.
 *   node scripts/test_marketing_data.js
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

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

const DAY = 864e5;

async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  require("../utils/analytics/stripeMrr").setStripeClient({ subscriptions: { list: () => { throw new Error("stripe not used in this test"); } } });

  const User = require("../models/User");
  const Booking = require("../models/Booking");
  const Subscription = require("../models/Subscription");
  const EmailSuppression = require("../models/EmailSuppression");
  const AgentFinding = require("../models/AgentFinding");
  const AgentSettings = require("../models/AgentSettings");
  const AgentMemory = require("../models/AgentMemory");
  const { CouncilDecision, CouncilTask } = require("../models/Council");
  const { AGENTS } = require("../utils/agents/definitions");
  const { TOOL_DEFS, toolsFor } = require("../utils/agents/tools");
  const { costOf, SHARED_RULES } = require("../utils/agents/runtime");
  const arthur = require("../utils/council/arthur");
  const mission = require("../utils/council/mission");
  const settings = require("../utils/agents/settings");

  console.log("permissions");

  const FINANCIAL = /business_overview|growth_status|ad_performance|conversion_details|revenue|mrr|stripe|billing|subscription|invoice|price|capacity|calendar|owner_report|alert_owner/i;

  await test("no financial, billing or operations tool exists - for any hero or for King Arthur", async () => {
    for (const name of Object.keys(TOOL_DEFS)) assert.doesNotMatch(name, FINANCIAL, `tool ${name} exists`);
    for (const def of Object.values(AGENTS)) for (const t of def.tools) assert.doesNotMatch(t, FINANCIAL, `${def.name}: ${t}`);
    for (const t of arthur.ARTHUR_TOOL_NAMES) assert.doesNotMatch(t, FINANCIAL, `arthur: ${t}`);
    assert.deepStrictEqual(Object.keys(AGENTS).sort(), ["conversion", "outreach", "visibility"], "the business digest agent is retired");
  });

  await test("the roles: Odysseus search & visibility, Leonidas organic social, Marcus re-engagement", async () => {
    assert.match(AGENTS.visibility.instructions, /Google Business Profile/);
    assert.match(AGENTS.visibility.instructions, /Yelp/);
    assert.match(AGENTS.outreach.instructions, /Instagram account and Facebook Page \(organic posts only\)/);
    assert.match(AGENTS.outreach.instructions, /No paid campaigns, no boosting/);
    assert.match(AGENTS.conversion.instructions, /had their free first visit but did not become members/);
    assert.ok(AGENTS.conversion.tools.includes("get_reengagement_audiences"));
    assert.ok(!AGENTS.conversion.tools.includes("web_search"), "Marcus works from audience counts, not the open web");
    for (const k of ["visibility", "outreach"]) assert.ok(AGENTS[k].tools.includes("web_search"), `${k} can research`);
    assert.match(SHARED_RULES, /The owner runs the business/);
    assert.match(SHARED_RULES, /do not analyse or report on them/);
    assert.match(arthur.ARTHUR_RULES, /MARKETING DIRECTOR/);
    assert.doesNotMatch(arthur.ARTHUR_RULES, /get_business_overview|net MRR|paying members/);
  });

  await test("GoHighLevel stays untouched: no agent has a GoHighLevel tool", async () => {
    for (const def of Object.values(AGENTS)) for (const t of def.tools) assert.doesNotMatch(t, /ghl|gohighlevel|crm/i, t);
  });

  await test("web research: Anthropic's web search, capped per request and metered into the run budget", async () => {
    const [ws] = toolsFor(["web_search"]);
    assert.deepStrictEqual(ws, { type: "web_search_20260209", name: "web_search", max_uses: 4 });
    assert.strictEqual(costOf({ server_tool_use: { web_search_requests: 3 } }), 3, "3 searches = 3 cents");
  });

  console.log("data minimization");

  const now = new Date();
  const ids = Object.fromEntries(["A", "B", "C", "D", "E"].map((k) => [k, new mongoose.Types.ObjectId()]));
  const u = (k, extra) => ({ _id: ids[k], userId: `PF-${k}`, name: `${k}lice Secretname`, email: `${k.toLowerCase()}@homeowner-mail.net`, phone: "516-555-0100", role: "customer", isActive: true, createdAt: new Date(now - 10 * DAY), ...extra });
  await User.collection.insertMany([
    u("A", { createdAt: new Date(now - 40 * DAY), smsPreferences: { marketingEnabled: true } }), // free visit, did not join, may email
    u("B", { createdAt: new Date(now - 40 * DAY) }), // free visit, did not join, unsubscribed
    u("C"), // registered, never booked
    u("D", { createdAt: new Date(now - 300 * DAY) }), // past member
    u("E", { createdAt: new Date(now - 300 * DAY) }), // current member
  ]);
  const visit = (k, daysAgo) => ({ user: ids[k], userId: `PF-${k}`, name: "x", email: "x", phone: "x", address: "1 Main St", date: new Date(now - daysAgo * DAY), service: "Free visit", subscription: "free", isFreeFirstVisit: true, status: "completed", completedAt: new Date(now - daysAgo * DAY), createdAt: new Date(now - (daysAgo + 3) * DAY) });
  await Booking.collection.insertMany([visit("A", 10), visit("B", 12)]);
  await EmailSuppression.create({ email: "b@homeowner-mail.net", reason: "unsubscribe" });
  await Subscription.collection.insertMany([
    { user: ids.D, status: "canceled", subscriptionType: "plus", planPrice: 249, stripeSubscriptionId: "sub_D", cancellationDate: new Date(now - 30 * DAY), startDate: new Date(now - 200 * DAY) },
    { user: ids.E, status: "active", accessStatus: "active", subscriptionType: "premium", planPrice: 349, stripeSubscriptionId: "sub_E", startDate: new Date(now - 100 * DAY), currentPeriodEnd: new Date(now + 20 * DAY) },
  ]);

  const MONEYISH_KEYS = /cents|revenue|mrr|price|amount|plan|billing|stripe|subscription|invoice|spend|cac|roas|cancel|reason|paying|mrr|tenure|retention/i;
  function scan(obj, path = "") {
    if (Array.isArray(obj)) return obj.forEach((v, i) => scan(v, `${path}[${i}]`));
    if (obj && typeof obj === "object") {
      for (const [k, v] of Object.entries(obj)) {
        assert.doesNotMatch(k, MONEYISH_KEYS, `financial field ${path}.${k}`);
        if (k === "notes" || k === "rules") continue; // fixed explanatory text, not data
        scan(v, `${path}.${k}`);
      }
      return;
    }
    if (typeof obj === "string") assert.doesNotMatch(obj, /@|Secretname|555-0100|Main St|\$\d/, `personal or money data at ${path}: ${obj}`);
  }

  await test("the marketing results carry no financial fields and no personal data", async () => {
    const out = await TOOL_DEFS.get_acquisition.run({});
    scan(out);
    assert.ok("firstFreeVisitBookings" in out && "bySource30" in out && "bookingFunnel30" in out);
    assert.ok(!("costPerFirstFreeVisitCents" in out));
  });

  await test("Marcus's follow-up audiences: counts and lawful-contact counts only", async () => {
    const out = await TOOL_DEFS.get_reengagement_audiences.run({});
    scan(out);
    const a = out.audiences;
    assert.deepStrictEqual([a.free_visit_undecided.people, a.free_visit_undecided.mayEmail, a.free_visit_undecided.optedOut, a.free_visit_undecided.optedInToMarketingTexts], [2, 1, 1, 1]);
    assert.deepStrictEqual([a.registered_never_booked.people, a.registered_never_booked.mayEmail], [1, 1]);
    assert.strictEqual(a.former_member_recent.people, 1);
    assert.match(out.rules, /GoHighLevel is out of scope/);
  });

  await test("a follow-up email playbook can only target the three re-engagement audiences", async () => {
    const seg = TOOL_DEFS.save_email_playbook.input_schema.properties.segment.enum;
    assert.deepStrictEqual(seg.sort(), ["former_member_recent", "free_visit_undecided", "registered_never_booked"]);
  });

  console.log("mission and refocus");

  await test("the marketing mission replaces the growth mission as a NEW version; the old one stays restorable", async () => {
    await AgentSettings.create({ agent: "arthur", guidance: mission.MISSION_V1, version: 1, history: [{ version: 1, guidance: mission.MISSION_V1, by: "Owner", at: new Date(), note: mission.NOTE_V1 }] });
    mission.resetForTests();
    await mission.ensureMission();
    const s = await settings.getSettings("arthur");
    assert.strictEqual(s.version, 2);
    assert.strictEqual(s.guidance, mission.MISSION);
    assert.match(s.history[1].note, /Marketing-only mission approved by the owner on 2026-10-11/);
    assert.strictEqual(s.history[0].guidance, mission.MISSION_V1);
    assert.deepStrictEqual(settings.validateGuidance(mission.MISSION), []);
    mission.resetForTests();
    await mission.ensureMission();
    assert.strictEqual((await settings.getSettings("arthur")).version, 2, "applied once");
    const r = await settings.rollbackGuidance("arthur", 1, { by: "Owner" });
    assert.strictEqual(r.settings.guidance, mission.MISSION_V1, "the growth mission can be restored");
    mission.resetForTests();
    await mission.ensureMission();
    const after = await settings.getSettings("arthur");
    assert.strictEqual(after.version, 3, "a growth mission the owner restored is their choice and stays");
    assert.strictEqual(after.guidance, mission.MISSION_V1);
  });

  await test("the refocus review lists outdated business work and marketing work - and changes nothing", async () => {
    const { reviewForRefocus } = require("../utils/council/refocus");
    const biz = await CouncilTask.create({ agent: "conversion", instruction: "Analyse cancellations by plan and tenure", origin: "arthur", status: "assigned", history: [] });
    const mkt = await CouncilTask.create({ agent: "outreach", instruction: "Draft three Instagram posts about fall gutter care", origin: "owner", status: "assigned", history: [] });
    const note = await AgentFinding.create({ agent: "conversion", kind: "insight", severity: "medium", title: "MRR fell 4% this month", detail: "x", status: "open" });
    const r = await reviewForRefocus();
    assert.deepStrictEqual(r, { business: 2, marketing: 1 });
    const d = await CouncilDecision.findOne({ "payload.type": "refocus" }).lean();
    assert.strictEqual(d.status, "open");
    assert.match(d.detail, /LOOKS LIKE BUSINESS MANAGEMENT[\s\S]*Analyse cancellations[\s\S]*MRR fell/);
    assert.match(d.detail, /MARKETING \(carries on\)[\s\S]*Instagram posts/);
    assert.match(d.detail, /Nothing has been cancelled, closed, approved or deleted/);
    assert.strictEqual((await CouncilTask.findById(biz._id).lean()).status, "assigned", "not cancelled");
    assert.strictEqual((await CouncilTask.findById(mkt._id).lean()).status, "assigned");
    assert.strictEqual((await AgentFinding.findById(note._id).lean()).status, "open", "not closed");
    assert.deepStrictEqual(await reviewForRefocus(), { skipped: "done" }, "runs once");
    assert.ok(await AgentMemory.exists({ agent: "arthur", key: "system:refocus-2026-10-11-reviewed" }));
  });

  await mongoose.disconnect();
  await mongo.stop();
  console.log(`\n${passed} marketing-refocus tests passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
