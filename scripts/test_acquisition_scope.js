/**
 * The Kingdom is a NEW-CUSTOMER ACQUISITION system (owner's rule, 2026-10-12):
 * find homeowners -> registration -> first free visit -> membership -> DONE.
 *
 *   - anyone who has had a membership (paid, ended, or a gift) is out of every
 *     acquisition audience, and every send re-checks it at the moment it runs
 *   - prospects stay in: registered-never-booked, free-visit-never-joined
 *   - members' bookings never count as first free visits; conversions count
 *     once; new membership purchases are tracked once per customer
 *   - tasks, focus, findings and Arthur's records about existing members'
 *     operations are refused; old ones are archived (never deleted); member
 *     playbooks are retired
 *
 * In-memory MongoDB, no model calls, nothing sent.
 *   node scripts/test_acquisition_scope.js
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

const DAY = 864e5;

async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  require("../utils/analytics/stripeMrr").setStripeClient({ subscriptions: { list: () => { throw new Error("not used"); } } });

  const User = require("../models/User");
  const Booking = require("../models/Booking");
  const Subscription = require("../models/Subscription");
  const GiftMembership = require("../models/GiftMembership");
  const EmailPlaybook = require("../models/EmailPlaybook");
  const AgentFinding = require("../models/AgentFinding");
  const AgentMemory = require("../models/AgentMemory");
  const AgentSettings = require("../models/AgentSettings");
  const { CouncilDecision, CouncilTask } = require("../models/Council");
  require("../utils/growth/actions");
  const { getDefinition } = require("../utils/growth/actionRegistry");
  const scope = require("../utils/growth/acquisitionScope");
  const { SEGMENT_DEFS } = require("../utils/growth/segments");
  const { TOOL_DEFS } = require("../utils/agents/tools");
  const { AGENTS } = require("../utils/agents/definitions");
  const tasks = require("../utils/council/tasks");
  const arthur = require("../utils/council/arthur");
  const mission = require("../utils/council/mission");
  const settings = require("../utils/agents/settings");
  const overview = require("../utils/analytics/overview");
  const { archiveOutOfScope } = require("../utils/council/scopeSweep");

  const now = new Date("2026-10-12T16:00:00Z");
  const id = Object.fromEntries(["NEW", "PROSPECT", "FV", "MEMBER", "FORMER", "GIFT", "FORMER_FV", "INCOMPLETE"].map((k) => [k, new mongoose.Types.ObjectId()]));
  const user = (k, extra = {}) => ({ _id: id[k], userId: `PF-${k}`, name: k, email: `${k.toLowerCase()}@homeowner-mail.net`, role: "customer", isActive: true, createdAt: new Date(now - 20 * DAY), addresses: [], ...extra });
  await User.collection.insertMany(Object.keys(id).map((k) => user(k)));
  const sub = (k, extra) => ({ user: id[k], userId: `PF-${k}`, subscriptionType: "plus", billingCycle: "monthly", planPrice: 249, stripeSubscriptionId: `sub_${k}_${Math.random()}`, startDate: new Date(now - 100 * DAY), ...extra });
  await Subscription.collection.insertMany([
    sub("MEMBER", { status: "active", accessStatus: "active", currentPeriodEnd: new Date(now.getTime() + 20 * DAY) }),
    sub("FORMER", { status: "canceled", cancellationDate: new Date(now - 30 * DAY) }),
    sub("FORMER_FV", { status: "canceled", cancellationDate: new Date(now - 40 * DAY) }),
    sub("INCOMPLETE", { status: "incomplete" }), // a checkout that never started a membership
  ]);
  await GiftMembership.collection.insertOne({ recipient: id.GIFT, status: "claimed", plan: "plus", startAt: new Date(now - 10 * DAY), endAt: new Date(now.getTime() + 80 * DAY) });
  const fv = (k, extra = {}) => ({ user: id[k], userId: `PF-${k}`, name: "x", email: "x", phone: "x", address: "1 Main St", service: "Free visit", subscription: "free", isFreeFirstVisit: true, status: "completed", date: new Date(now - 10 * DAY), completedAt: new Date(now - 10 * DAY), createdAt: new Date(now - 14 * DAY), ...extra });
  await Booking.collection.insertMany([fv("FV"), fv("FORMER_FV"), fv("MEMBER", { status: "booked", completedAt: null, createdAt: new Date(now - 5 * DAY), date: new Date(now.getTime() + 2 * DAY) })]);

  console.log("who is a prospect");

  await test("a membership of any kind ends acquisition - paid, ended, or a gift; a checkout that never started does not", async () => {
    assert.strictEqual(await scope.hasMembership(id.MEMBER), true);
    assert.strictEqual(await scope.hasMembership(id.FORMER), true, "past members are finished too");
    assert.strictEqual(await scope.hasMembership(id.GIFT), true);
    assert.strictEqual(await scope.hasMembership(id.INCOMPLETE), false);
    assert.strictEqual(await scope.hasMembership(id.PROSPECT), false);
  });

  await test("prospects stay in the follow-up audiences; anyone who has had a membership is out", async () => {
    const u = async (k) => User.findById(id[k]).lean();
    const undecided = SEGMENT_DEFS.free_visit_undecided;
    assert.strictEqual(await undecided.includes(await u("FV"), { now }), true, "had the free visit, never joined: a prospect");
    assert.strictEqual(await undecided.includes(await u("FORMER_FV"), { now }), false, "had the free visit, then a membership that ended: finished");
    const never = SEGMENT_DEFS.registered_never_booked;
    assert.strictEqual(await never.includes(await u("PROSPECT"), { now }), true);
    assert.strictEqual(await never.includes(await u("FORMER"), { now }), false);
    assert.strictEqual(await never.includes(await u("GIFT"), { now }), false);
    assert.deepStrictEqual(TOOL_DEFS.save_email_playbook.input_schema.properties.segment.enum.sort(), [...scope.ACQUISITION_SEGMENTS].sort());
  });

  console.log("every send re-checks membership at the moment it runs");

  const playbook = (key, segment) =>
    EmailPlaybook.create({ key, name: key, segment, status: "approved", version: 1, approvedVersion: 1, subject: "Your free visit", preheader: "p", headline: "h", paragraphs: ["A short helpful note."], ctaLabel: "Book", ctaRoute: "/book/free", closing: "Profixter", createdBy: "test" });
  const run = (type, payload) => getDefinition(type).execute(payload, { action: { _id: new mongoose.Types.ObjectId() }, now });

  await test("a playbook email to someone who bought a membership is skipped, even if they were queued as a prospect", async () => {
    await playbook("undecided-v1", "free_visit_undecided");
    // FV joins after being queued
    await Subscription.collection.insertOne(sub("FV", { status: "active", accessStatus: "active", startDate: new Date(now - 1 * DAY), currentPeriodEnd: new Date(now.getTime() + 29 * DAY) }));
    const r = await run("playbook_email", { userId: String(id.FV), playbookKey: "undecided-v1" });
    assert.deepStrictEqual(r, { outcome: "skip", reason: "membership_purchased" });
    await Subscription.deleteMany({ user: id.FV });
  });

  await test("a playbook written for past members or scheduled cancellations can never send", async () => {
    await EmailPlaybook.collection.insertOne({ key: "winback-v1", segment: "former_member_recent", status: "approved", version: 1, approvedVersion: 1, subject: "We miss you", preheader: "p", headline: "h", paragraphs: ["Come back."], ctaLabel: "Book", ctaRoute: "/book", closing: "Profixter", createdBy: "test" });
    const r = await run("playbook_email", { userId: String(id.FORMER), playbookKey: "winback-v1" });
    assert.deepStrictEqual(r, { outcome: "skip", reason: "outside_acquisition_scope" });
  });

  await test("the post-visit text and the checkout reminder skip anyone who has had a membership", async () => {
    await User.updateOne({ _id: id.FORMER_FV }, { $set: { smsPreferences: { marketingEnabled: true } } });
    const sms = await run("post_free_visit_sms", { userId: String(id.FORMER_FV), bookingId: String(new mongoose.Types.ObjectId()), completedAt: new Date(now - 3 * DAY) });
    assert.deepStrictEqual(sms, { outcome: "skip", reason: "membership_purchased" });
    const mail = await run("checkout_recovery_email", { userId: String(id.FORMER), stripeSessionId: "cs_test_1", plan: "plus", billingCycle: "monthly" });
    assert.deepStrictEqual(mail, { outcome: "skip", reason: "membership_purchased" });
  });

  console.log("counting");

  await test("a member's booking is never a first free visit; new memberships count once per customer; gifts are not purchases", async () => {
    overview.clearOverviewCache();
    const t = await overview.firstFreeVisitTrend({ now });
    // FV (Sep 28) and FORMER_FV (Sep 28) were not members when they booked; MEMBER's flagged booking (Oct 7) was a member's
    assert.strictEqual(t.last30, 2);
    assert.strictEqual(t.last7, 0, "the member's booking this week is not a new customer");
    // MEMBER/FORMER/FORMER_FV started 100 days ago (outside 30d); add one customer with two paid memberships in the window
    const twice = new mongoose.Types.ObjectId();
    await User.collection.insertOne({ ...user("NEW"), _id: twice, userId: "PF-TWICE", email: "twice@homeowner-mail.net" });
    await Subscription.collection.insertMany([
      sub("NEW", { user: twice, status: "canceled", startDate: new Date(now - 20 * DAY), cancellationDate: new Date(now - 15 * DAY) }),
      sub("NEW", { user: twice, status: "active", accessStatus: "active", startDate: new Date(now - 10 * DAY), currentPeriodEnd: new Date(now.getTime() + 20 * DAY) }),
    ]);
    overview.clearOverviewCache();
    const t2 = await overview.firstFreeVisitTrend({ now });
    assert.strictEqual(t2.newMembershipPurchases.last30, 1, "the re-join is not a second conversion; the gift is not a purchase");
  });

  await test("the Kingdom sees new membership purchases only as an aggregate count", async () => {
    overview.clearOverviewCache();
    const m = await require("../utils/agents/marketingData").marketingResults({ now });
    assert.strictEqual(m.newMembershipPurchases.last30, 1);
    assert.match(m.newMembershipPurchases.howCounted, /once per customer/);
    assert.doesNotMatch(JSON.stringify(m.newMembershipPurchases), /PF-|@|cents|price|plan"/i);
  });

  console.log("no Kingdom work about existing members");

  const clean = () => Promise.all([AgentFinding, AgentMemory, AgentSettings, CouncilDecision, CouncilTask].map((x) => x.deleteMany({})));

  await test("tasks, focus, findings and Arthur's records about existing members are refused in code", async () => {
    await clean();
    for (const text of [
      "Analyse why members cancel and what retention offers to try",
      "Review member bookings scheduled for this week",
      "Look into the booking the owner deleted yesterday",
      "Draft a win-back email for past members",
      "Check which existing members have failed payments",
    ]) {
      assert.ok(tasks.taskProblems("conversion", text).includes(scope.SCOPE_WHY), text);
    }
    assert.deepStrictEqual(tasks.taskProblems("visibility", "Draft two Google Business Profile posts for Levittown homeowners"), []);
    await assert.rejects(tasks.assignTask({ agent: "conversion", instruction: "Look at the membership renewals due next month", why: "x" }), (e) => e.problems.includes(scope.SCOPE_WHY));
    await assert.rejects(tasks.setTeamFocus("This week the team reviews existing members' service visits and upgrades their memberships."), (e) => e.problems.includes(scope.SCOPE_WHY));
    const ctx = { agent: "conversion", agentLabel: "Marcus", runId: new mongoose.Types.ObjectId(), findingsThisRun: 0, findingIds: [] };
    await assert.rejects(
      TOOL_DEFS.record_finding.run({ kind: "risk", severity: "high", title: "Two members have past-due payments", detail: "d", expected_impact: "e", evidence: "ev", dedupe_key: "pay", plain: "", owner_question: "" }, ctx),
      /Outside the acquisition mission/
    );
    const ok = await TOOL_DEFS.record_finding.run({ kind: "opportunity", severity: "medium", title: "Massapequa homeowners ask about gutter cleaning", detail: "d", expected_impact: "e", evidence: "ev", dedupe_key: "gutters", plain: "", owner_question: "" }, ctx);
    assert.ok(ok.id, "acquisition work is unaffected");
    const filed = await arthur.ARTHUR_TOOLS.file_for_owner.run({ category: "info", subject: "Members cancelled more this month", simple: "Boss, more cancellations.", detail: "x", agent: null, recommendation: null, dedupe_key: "cancels" }, { log: [] });
    assert.strictEqual(filed.refused, true);
  });

  await test("old Kingdom work about existing members is archived, never deleted - prospects' work and drafts are kept", async () => {
    await clean();
    const mk = (instruction, extra = {}) => CouncilTask.create({ agent: "conversion", instruction, origin: "arthur", status: "assigned", history: [], ...extra });
    const member = await mk("Analyse cancellations by plan and tenure");
    const ownerTask = await mk("Follow up on member bookings scheduled this week", { origin: "owner" });
    const working = await mk("Check failed payments for members", { status: "in_progress" });
    const prospect = await mk("Draft a follow-up for people who registered but never booked");
    const note = await AgentFinding.create({ agent: "conversion", kind: "insight", severity: "medium", title: "Existing members book mostly on Mondays", status: "open" });
    const draft = await AgentFinding.create({ agent: "conversion", kind: "content_draft", severity: "medium", title: "message_copy: renewal reminder", status: "open" });
    const record = await CouncilDecision.create({ category: "info", subject: "Cancellations rose", simple: "Boss, cancellations rose.", status: "open" });
    await EmailPlaybook.collection.insertOne({ key: "cancel-save-v1", segment: "cancellation_scheduled", status: "draft", version: 1, subject: "s", paragraphs: ["p"], createdBy: "test" });

    const r = await archiveOutOfScope({ now });
    assert.deepStrictEqual(r, { tasks: 2, notes: 1, records: 1, playbooks: 2 }, "the member task, the owner's member task, the note, the record; the win-back and cancel-save playbooks");
    const t = await CouncilTask.findById(member._id).lean();
    assert.strictEqual(t.status, "archived");
    assert.strictEqual(t.archive.previousStatus, "assigned", "restorable to where it was");
    assert.match(t.archive.reason, /acquisition mission/);
    assert.strictEqual((await CouncilTask.findById(ownerTask._id).lean()).status, "archived", "the owner ordered it, so no archive request (no notification)");
    assert.strictEqual((await CouncilTask.findById(working._id).lean()).status, "in_progress", "never pulled out from under a shift");
    assert.strictEqual((await CouncilTask.findById(prospect._id).lean()).status, "assigned", "prospect work stays");
    assert.strictEqual((await AgentFinding.findById(note._id).lean()).status, "archived");
    assert.strictEqual((await AgentFinding.findById(draft._id).lean()).status, "open", "drafts are the owner's decision");
    assert.strictEqual((await CouncilDecision.findById(record._id).lean()).status, "archived");
    assert.strictEqual((await EmailPlaybook.findOne({ key: "cancel-save-v1" }).lean()).status, "retired");
    assert.strictEqual(await CouncilTask.countDocuments({}), 4, "nothing deleted");
    assert.deepStrictEqual(await archiveOutOfScope({ now }), { tasks: 0, notes: 0, records: 0, playbooks: 0 }, "idempotent");
    const h = await require("../utils/council/health").councilHealth();
    assert.deepStrictEqual(h.outOfScopeArchived, { tasks: 2, notes: 1 });
  });

  console.log("instructions and mission");

  await test("every knight and King Arthur carry the acquisition-only rule; Marcus has no past-member audience", () => {
    for (const def of Object.values(AGENTS)) assert.match(def.instructions, /ACQUISITION ONLY: find new homeowners -> registration -> first free visit -> membership purchase -> done/, def.name);
    assert.doesNotMatch(AGENTS.conversion.instructions, /- past members, when it is appropriate/);
    assert.match(arthur.ARTHUR_RULES, /THE KINGDOM IS A NEW-CUSTOMER ACQUISITION SYSTEM/);
    assert.match(arthur.ARTHUR_RULES, /Routine operational changes \(a booking the owner removed, a reschedule\) are not marketing events: never investigate them/);
  });

  await test("an untouched acquisition-first mission (v3) becomes the new-customer mission (v4); an owner-edited one stays", async () => {
    await clean();
    mission.resetForTests();
    await AgentSettings.create({ agent: "arthur", guidance: mission.MISSION_V3, version: 3, history: [{ version: 3, guidance: mission.MISSION_V3, by: "Owner", at: new Date(), note: mission.NOTE_V3 }] });
    await mission.ensureMission();
    const s = await settings.getSettings("arthur");
    assert.strictEqual(s.version, 4);
    assert.match(s.guidance, /NEW CUSTOMER ACQUISITION[\s\S]*DONE/);
    await clean();
    mission.resetForTests();
    await AgentSettings.create({ agent: "arthur", guidance: mission.MISSION_V3, version: 5, history: [{ version: 5, guidance: mission.MISSION_V3, by: "Owner", at: new Date(), note: "Restored version 3", rollbackOf: 3 }] });
    await mission.ensureMission();
    assert.strictEqual((await settings.getSettings("arthur")).version, 5);
  });

  await mongoose.disconnect();
  await mongo.stop();
  console.log(`\n${passed} acquisition-scope tests passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
