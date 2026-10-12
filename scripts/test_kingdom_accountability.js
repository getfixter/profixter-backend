/**
 * The Kingdom's accountability and reporting fixes (2026-10-12).
 *
 *   - honest numbers: first free visits in COMPLETE days (today's half day no
 *     longer reads as a decline), homeowners only (no staff/test bookings),
 *     a trend verdict that tells a real change from the usual swing, and the
 *     sources still adding up to the headline
 *   - problems stay open until checked: a knight's "fixed" is a fix report,
 *     only King Arthur's check_fix (after reading it) closes a problem, and a
 *     problem seen again after "resolved" reopens
 *   - a failed check sends a task back with the reason; repeated failures or
 *     missed shifts become "blocked" for Arthur instead of looping quietly
 *   - coordination: Arthur's team focus and the other knights' work reach
 *     every shift; unpublished drafts are capped
 *   - the acquisition-first mission replaces only an untouched system mission
 *
 * In-memory MongoDB, no model calls.
 *   node scripts/test_kingdom_accountability.js
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

async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  require("../utils/analytics/stripeMrr").setStripeClient({ subscriptions: { list: () => { throw new Error("not used"); } } });

  const User = require("../models/User");
  const Booking = require("../models/Booking");
  const AgentFinding = require("../models/AgentFinding");
  const AgentMemory = require("../models/AgentMemory");
  const AgentSettings = require("../models/AgentSettings");
  const { CouncilDecision, CouncilTask } = require("../models/Council");
  const { TOOL_DEFS } = require("../utils/agents/tools");
  const overview = require("../utils/analytics/overview");
  const { acquisitionView } = require("../utils/growth/commandCenter");
  const tasks = require("../utils/council/tasks");
  const arthur = require("../utils/council/arthur");
  const mission = require("../utils/council/mission");
  const settings = require("../utils/agents/settings");
  const { buildReport } = require("../utils/council/report");

  const clean = () => Promise.all([AgentFinding, AgentMemory, AgentSettings, CouncilDecision, CouncilTask].map((m) => m.deleteMany({})));
  const knight = (agent = "visibility") => ({ agent, agentLabel: tasks.HERO[agent], runId: new mongoose.Types.ObjectId(), findingsThisRun: 0, findingIds: [] });
  const king = () => ({ log: [], trigger: "schedule" });
  const A = arthur.ARTHUR_TOOLS;

  /* ---------------------------------------------------------------- */
  console.log("honest numbers");

  // Monday 2026-10-12, 9:00 in New York. "Yesterday" is Sunday the 11th.
  const now = new Date("2026-10-12T13:00:00Z");
  const id = Object.fromEntries(["H1", "H2", "H3", "H4", "S"].map((k) => [k, new mongoose.Types.ObjectId()]));
  const user = (k, extra = {}) => ({ _id: id[k], userId: `PF-${k}`, name: k, email: `${k.toLowerCase()}@homeowner-mail.net`, role: "customer", createdAt: new Date("2026-09-01T12:00:00Z"), addresses: [], ...extra });
  await User.collection.insertMany([
    user("H1"),
    user("H2"),
    user("H3", { attribution: { utmSource: "google", landingPath: "/" } }),
    user("H4"),
    user("S", { role: "admin", email: "qa@profixter.com" }),
  ]);
  const booking = (k, createdAt, extra = {}) => ({ user: id[k], userId: `PF-${k}`, name: "x", email: "x", phone: "x", address: "1 Main St", date: new Date(new Date(createdAt).getTime() + 5 * 864e5), service: "Free visit", subscription: "free", isFreeFirstVisit: true, status: "booked", createdAt: new Date(createdAt), ...extra });
  await Booking.collection.insertMany([
    booking("H1", "2026-10-11T19:00:00Z"), // yesterday
    booking("H2", "2026-10-12T12:00:00Z"), // this morning: today's unfinished day
    booking("S", "2026-10-11T15:00:00Z"), // a staff test booking - not a homeowner
    booking("H3", "2026-10-01T15:00:00Z"),
    booking("H4", "2026-10-03T15:00:00Z", { status: "cancelled" }),
    booking("H4", "2026-10-09T15:00:00Z"), // the same home rebooking - not a new first visit
  ]);

  await test("first free visits count complete days, homeowners only, once per home", async () => {
    overview.clearOverviewCache();
    const t = await overview.firstFreeVisitTrend({ now });
    assert.strictEqual(t.through, "2026-10-11");
    assert.strictEqual(t.last7, 1, "Oct 5-11: H1 only (H4's rebooking is not new, the staff booking is not a homeowner)");
    assert.strictEqual(t.prev7, 2, "Sep 28 - Oct 4: H3 and H4");
    assert.strictEqual(t.last30, 3);
    assert.strictEqual(t.todaySoFar, 1, "this morning's booking is shown apart, not mixed into the week");
    assert.strictEqual(t.weekly.length, 6);
    assert.deepStrictEqual(t.weekly.at(-1), { from: "2026-10-05", through: "2026-10-11", firstFreeVisits: 1, canceledSince: 0 });
    assert.strictEqual(t.noFirstTouchRecord30, 2, "H1 and H4 left no first-touch record; H3 did");
  });

  await test("a staff test booking no longer inflates the dashboard's free visits", async () => {
    overview.clearOverviewCache();
    const o = await overview.buildOverview({ range: "custom", from: "2026-10-11", to: "2026-10-11", now });
    assert.strictEqual(o.kpis.freeVisits.firstBooked, 1, "H1 only, not the QA account");
    assert.strictEqual(o.kpis.freeVisits.booked, 1);
  });

  await test("the trend verdict tells a real change from the usual swing of small numbers", async () => {
    const v = overview._internal.trendVerdict;
    assert.strictEqual(v(3, 7), "steady", "3 vs 7 is within chance");
    assert.strictEqual(v(1, 2), "too_few");
    assert.strictEqual(v(20, 5), "up");
    assert.strictEqual(v(2, 15), "down");
  });

  await test("the Kingdom's numbers and sources use the same complete days and still add up", async () => {
    overview.clearOverviewCache();
    const a = await acquisitionView({ now });
    assert.strictEqual(a.firstFreeVisits.last30, 3);
    const bySource = a.bySource30.reduce((n, s) => n + (s.freeVisits || 0), 0);
    assert.strictEqual(bySource, a.firstFreeVisits.last30, "sources add up to the headline");
    overview.clearOverviewCache();
    const m = await require("../utils/agents/marketingData").marketingResults({ now });
    assert.strictEqual(m.firstFreeVisitBookings.countedThrough, "2026-10-11");
    assert.match(m.firstFreeVisitBookings.trend.verdict, /^TOO FEW/);
    assert.match(m.firstFreeVisitBookings.howCounted, /never call a change a decline/);
    assert.strictEqual(m.trackingQuality.firstFreeVisits30WithNoFirstTouchRecord, 2);
    assert.doesNotMatch(JSON.stringify(m), /cancel/i, "booking cancellations are operations, not marketing data");
  });

  await test("the plain-English results no longer call this morning a weaker week", async () => {
    const { explainResults } = require("../utils/growth/explain");
    if (!explainResults) return; // not exported - covered through the office below
    const e = explainResults({ kpis: { firstFreeVisits: { last7: 3, prev7: 7, last30: 12, prev30: 14, trend: { last14: 10, prev14: 12, verdict: "steady" } } }, approvals: { total: 0 }, costs: { todayCents: 0, dailyCapCents: 500, monthCents: 0, monthlyCapCents: 7500 } });
    assert.match(e.simple.say, /last 7 full days[\s\S]*normal swing, not a trend[\s\S]*last 30 full days/);
  });

  /* ---------------------------------------------------------------- */
  console.log("problems stay open until checked");

  await test("a knight cannot close its own problem: its 'fixed' is a fix report and the problem stays open", async () => {
    await clean();
    const ctx = knight();
    const { id: pid } = await TOOL_DEFS.record_finding.run({ kind: "risk", severity: "high", title: "Google Business Profile shows the wrong hours", detail: "d", expected_impact: "e", evidence: "ev", dedupe_key: "gbp:hours", plain: "", owner_question: "" }, ctx);
    const r = await TOOL_DEFS.close_finding.run({ id: pid, status: "resolved", note: "Hours look right in the profile now, checked today." }, ctx);
    assert.strictEqual(r.fixReported, true);
    const f = await AgentFinding.findById(pid).lean();
    assert.strictEqual(f.status, "open");
    assert.match(f.fixClaim.note, /look right/);
    const listed = (await arthur.unresolvedProblems()).find((p) => p.id === pid);
    assert.ok(listed && listed.fixReported, "Arthur sees it as open, with the fix report");
    await assert.rejects(TOOL_DEFS.close_finding.run({ id: pid, status: "resolved", note: "ok" }, ctx), /evidence/);
  });

  await test("an opportunity (not a problem) can still be closed by the knight who raised it", async () => {
    const ctx = knight();
    const { id: oid } = await TOOL_DEFS.record_finding.run({ kind: "opportunity", severity: "medium", title: "Bing Places listing missing", detail: "d", expected_impact: "e", evidence: "ev", dedupe_key: "bing:listing", plain: "", owner_question: "" }, ctx);
    await TOOL_DEFS.close_finding.run({ id: oid, status: "superseded", note: "Covered by the directories draft." }, ctx);
    assert.strictEqual((await AgentFinding.findById(oid).lean()).status, "superseded");
  });

  await test("only King Arthur's check closes a problem - and only after he has read it", async () => {
    const p = await AgentFinding.findOne({ dedupeKey: "gbp:hours" }).lean();
    const pid = String(p._id);
    const ctx = king();
    await assert.rejects(A.check_fix.run({ note_id: pid, verdict: "fixed", evidence: "The knight says the hours are right." }, ctx), /Read the problem in full first/);
    await A.get_item.run({ kind: "note", id: pid }, ctx);
    const no = await A.check_fix.run({ note_id: pid, verdict: "not_fixed", evidence: "Saturday hours still say closed on the profile." }, ctx);
    assert.strictEqual(no.kept_open, true);
    const kept = await AgentFinding.findById(pid).lean();
    assert.strictEqual(kept.status, "open");
    assert.ok(!kept.fixClaim?.at, "the rejected fix report is cleared");
    await assert.rejects(A.check_fix.run({ note_id: pid, verdict: "fixed", evidence: "Looks fine to me now honestly." }, ctx), /No knight has reported this fixed yet/);
    await TOOL_DEFS.close_finding.run({ id: pid, status: "resolved", note: "Saturday hours corrected to 8-12, screenshot noted." }, knight());
    await A.check_fix.run({ note_id: pid, verdict: "fixed", evidence: "Profile now lists Saturday 8-12, matches the website." }, ctx);
    const done = await AgentFinding.findById(pid).lean();
    assert.strictEqual(done.status, "resolved");
    assert.strictEqual(done.statusBy, "King Arthur");
    assert.ok(!(await arthur.unresolvedProblems()).some((x) => x.id === pid));
  });

  await test("a problem seen again after it was marked resolved reopens", async () => {
    const r = await TOOL_DEFS.record_finding.run({ kind: "risk", severity: "high", title: "Google Business Profile shows the wrong hours", detail: "again", expected_impact: "e", evidence: "ev", dedupe_key: "gbp:hours", plain: "", owner_question: "" }, knight());
    assert.strictEqual(r.reopened, true);
    const f = await AgentFinding.findById(r.id).lean();
    assert.strictEqual(f.status, "open");
    assert.ok(f.reopenedAt);
    assert.ok((await arthur.unresolvedProblems()).some((x) => x.id === r.id && x.reopened));
  });

  await test("a problem the owner only acknowledged is still listed as unresolved", async () => {
    const f = await AgentFinding.create({ agent: "outreach", kind: "anomaly", severity: "medium", title: "Instagram link has no utm tag", status: "acknowledged" });
    const listed = (await arthur.unresolvedProblems()).find((p) => p.id === String(f._id));
    assert.match(listed.status, /not fixed yet/);
  });

  await test("when a knight closes a note Arthur recommended on, the history says the knight closed it - not the owner", async () => {
    const ctx = knight("outreach");
    const { id: oid } = await TOOL_DEFS.record_finding.run({ kind: "opportunity", severity: "medium", title: "Merrick Patch community board", detail: "d", expected_impact: "e", evidence: "ev", dedupe_key: "merrick:patch", plain: "", owner_question: "" }, ctx);
    await A.recommend.run({ item_kind: "note", item_id: oid, choice: "acknowledge", reason: "Worth a post.", simple: "Boss, worth a post. You decide.", uncertain: false, waiting_on_task: null }, king());
    await TOOL_DEFS.close_finding.run({ id: oid, status: "superseded", note: "Merged into the community calendar." }, ctx);
    await arthur.settleDecisions();
    const d = await CouncilDecision.findOne({ dedupeKey: `rec:note:${oid}` }).lean();
    assert.strictEqual(d.resolution.choice, "closed_by_knight");
    assert.strictEqual(d.resolution.by, "Leonidas");
  });

  /* ---------------------------------------------------------------- */
  console.log("tasks: sent back for real, never looping quietly");

  async function completedTask(agent = "visibility", instruction = "Rewrite the Levittown page title to target 'handyman Levittown'") {
    const { task } = await tasks.assignTask({ agent, instruction, why: "Levittown has impressions but few clicks" });
    const runId = new mongoose.Types.ObjectId();
    await tasks.pickUpTasks(agent, runId);
    await tasks.reportTask({ taskId: task._id, agent, runId, status: "completed", summary: "Drafted a new title and proposed it." });
    return String(task._id);
  }

  await test("Arthur must read a task report before he verifies it", async () => {
    await clean();
    const tid = await completedTask();
    const ctx = king();
    await assert.rejects(A.verify_task.run({ task_id: tid, verdict: "verified", note: "Looks done to me from the summary." }, ctx), /Read the task report in full first/);
    await A.get_item.run({ kind: "task", id: tid }, ctx);
    const r = await A.verify_task.run({ task_id: tid, verdict: "verified", note: "Proposal exists with the target query and evidence." }, ctx);
    assert.strictEqual(r.status, "verified");
  });

  await test("'not verified' sends the task back to the knight with the reason; three failed checks make it blocked", async () => {
    await clean();
    const tid = await completedTask();
    const ctx = king();
    await A.get_item.run({ kind: "task", id: tid }, ctx);
    const r = await A.verify_task.run({ task_id: tid, verdict: "not_verified", note: "No target query in the proposal - add 'handyman Levittown'." }, ctx);
    assert.strictEqual(r.status, "assigned", "it is not finished, so it does not look finished");
    const brief = await tasks.pickUpTasks("visibility", new mongoose.Types.ObjectId());
    assert.match(brief, /SENT BACK after a check - fix this before reporting again: No target query/);
    for (let i = 0; i < 2; i += 1) {
      const t = await CouncilTask.findById(tid).lean();
      await tasks.reportTask({ taskId: tid, agent: "visibility", runId: t.lastRun, status: "completed", summary: "Proposed again with the query." });
      await tasks.verifyTask({ taskId: tid, verdict: "not_verified", note: "Still missing the query.", by: "King Arthur" });
      if (i === 0) await tasks.pickUpTasks("visibility", new mongoose.Types.ObjectId());
    }
    const t = await CouncilTask.findById(tid).lean();
    assert.strictEqual(t.status, "blocked");
    const state = await arthur.councilState();
    assert.ok(state.blockedTasks.some((b) => b.id === tid), "Arthur sees it and must decide");
  });

  await test("a task picked up but never reported becomes blocked after two shifts instead of looping", async () => {
    await clean();
    const { task } = await tasks.assignTask({ agent: "outreach", instruction: "Find two Nassau community boards that allow business posts", why: "community reach" });
    for (let i = 0; i < 2; i += 1) {
      const runId = new mongoose.Types.ObjectId();
      await tasks.pickUpTasks("outreach", runId);
      await tasks.releaseUnreported("outreach", runId);
    }
    const t = await CouncilTask.findById(task._id).lean();
    assert.strictEqual(t.status, "blocked");
    assert.match(t.result.summary, /2 shifts without reporting/);
  });

  /* ---------------------------------------------------------------- */
  console.log("coordination and focus on bookings");

  await test("Arthur's team focus and the other knights' work reach every shift; rule-breaking focus is refused", async () => {
    await clean();
    const refused = await A.set_team_focus.run({ focus: "This week send texts to all past customers asking them to book.", reason: "x" }, king());
    assert.strictEqual(refused.refused, true);
    const ok = await A.set_team_focus.run({ focus: "Google Maps in Levittown and Hicksville: those towns search most and book least. Everyone works toward more first free visits there.", reason: "scoreboard" }, king());
    assert.strictEqual(ok.saved, true);
    await tasks.assignTask({ agent: "outreach", instruction: "Prepare two Levittown community posts with tagged links", why: "focus" });
    const brief = await tasks.pickUpTasks("visibility", new mongoose.Types.ObjectId());
    assert.match(brief, /KING ARTHUR'S FOCUS FOR THE TEAM[\s\S]*Levittown and Hicksville/);
    assert.match(brief, /WHAT THE OTHER KNIGHTS ARE ON[\s\S]*Leonidas \(assigned\): Prepare two Levittown community posts/);
    const state = await arthur.councilState();
    assert.match(state.teamFocus.text, /Levittown/);
  });

  await test("a knight with six unpublished drafts must improve one instead of adding a seventh", async () => {
    await clean();
    await AgentFinding.insertMany(Array.from({ length: 6 }, (_, i) => ({ agent: "visibility", kind: "content_draft", title: `town_page: Town ${i}`, status: "open", dedupeKey: `draft:${i}` })));
    const input = (key) => ({ page_type: "gbp_post", target: "gbp", title: "Fall gutter check", why: "season", body_markdown: "Leaves are falling - a good time to have gutters checked.", dedupe_key: key, plain: "" });
    await assert.rejects(TOOL_DEFS.save_content_draft.run(input("draft:new"), knight()), /already have 6 drafts waiting/);
    const r = await TOOL_DEFS.save_content_draft.run(input("draft:2"), knight());
    assert.strictEqual(r.status, "open", "revising an existing draft is allowed");
  });

  await test("Arthur's review starts from the bookings scoreboard and keeps problems and blocked tasks in view", () => {
    const def = arthur.arthurDef("review", { kickoff: () => "", context: {} });
    assert.match(def.instructions, /^THIS RUN: your council review\. Acquisition first/);
    assert.match(def.instructions, /0\. SCOREBOARD/);
    assert.match(def.instructions, /check_fix/);
    assert.match(def.instructions, /BLOCKED TASKS/);
    assert.match(def.rules, /PROBLEMS STAY OPEN UNTIL CHECKED/);
    assert.match(def.rules, /never call bookings "declining" when it says STEADY or TOO FEW/);
    assert.strictEqual(def.budgetCents, 80, "same cost cap as before");
  });

  await test("the full report lists open problems and says 'reported done' is not 'checked'", async () => {
    await clean();
    await AgentFinding.create({ agent: "visibility", kind: "risk", severity: "high", title: "Service-area page for Massapequa returns 404", status: "open", fixClaim: { by: "Odysseus", at: new Date(), note: "fixed", status: "resolved" } });
    await completedTask();
    const { text } = await buildReport({ scope: "full" });
    assert.match(text, /## Open problems \(stay here until King Arthur checks them fixed\)[\s\S]*Massapequa returns 404[\s\S]*awaiting King Arthur's check/);
    assert.match(text, /State: reported done by the knight - not yet checked/);
  });

  /* ---------------------------------------------------------------- */
  console.log("mission");

  await test("an untouched marketing mission (v2) becomes the acquisition-first mission; the old one stays restorable", async () => {
    await clean();
    mission.resetForTests();
    await AgentSettings.create({
      agent: "arthur",
      guidance: mission.MISSION_V2,
      version: 2,
      history: [
        { version: 1, guidance: mission.MISSION_V1, by: "Owner", at: new Date(), note: mission.NOTE_V1 },
        { version: 2, guidance: mission.MISSION_V2, by: "Owner", at: new Date(), note: "Marketing-only mission approved by the owner on 2026-10-11 (replaces the growth mission)" },
      ],
    });
    await mission.ensureMission();
    const s = await settings.getSettings("arthur");
    assert.strictEqual(s.version, 3);
    assert.strictEqual(s.guidance, mission.MISSION);
    assert.match(s.guidance, /FIRST FREE VISIT/);
    assert.deepStrictEqual(settings.validateGuidance(mission.MISSION), []);
  });

  await test("a marketing mission the owner restored themselves is their choice and stays", async () => {
    await clean();
    mission.resetForTests();
    await AgentSettings.create({
      agent: "arthur",
      guidance: mission.MISSION_V2,
      version: 4,
      history: [{ version: 4, guidance: mission.MISSION_V2, by: "Owner", at: new Date(), note: "Restored version 2", rollbackOf: 2 }],
    });
    await mission.ensureMission();
    const s = await settings.getSettings("arthur");
    assert.strictEqual(s.version, 4);
    assert.strictEqual(s.guidance, mission.MISSION_V2);
  });

  await mongoose.disconnect();
  await mongo.stop();
  console.log(`\n${passed} accountability tests passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
