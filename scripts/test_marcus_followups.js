/**
 * Marcus's automated email follow-ups next to the lifecycle marketing system
 * (2026-10-27).
 *
 *   - one inbox, two senders: the lifecycle system's weekly floor counts
 *     Marcus's sends, and Marcus counts the lifecycle's
 *   - while the lifecycle's scripted post-free-visit sequence runs for a
 *     person, Marcus stays out; after it ends he may follow up
 *   - the automation audit shows playbook wording, links and rule checks,
 *     and carries no customer data
 *
 * In-memory MongoDB; nothing is sent.
 *   node scripts/test_marcus_followups.js
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.ENABLE_MARKETING_EMAILS = "true";
delete process.env.MARKETING_AUDIENCES;

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
  const User = require("../models/User");
  const Booking = require("../models/Booking");
  const GrowthAction = require("../models/GrowthAction");
  const MarketingSend = require("../models/MarketingSend");
  const EmailPlaybook = require("../models/EmailPlaybook");
  const { buildProfile, personEligible } = require("../utils/marketing/marketingEligibility");
  const { lifecycleSequenceActive } = require("../utils/growth/actions/playbookEmail");
  const { automationAudit } = require("../utils/growth/automationAudit");

  let n = 0;
  const customer = (extra = {}) =>
    User.create({ userId: `M${++n}`, name: "Pat Homeowner", email: `pat${n}@homeowner-mail.net`, password: "x", phone: `+1631555${String(4000 + n)}`, role: "customer", createdAt: new Date(Date.now() - 40 * DAY), ...extra });
  const freeVisitDone = (user, daysAgo) =>
    Booking.collection.insertOne({ user: user._id, isFreeFirstVisit: true, accessType: "free_first_visit", status: "Completed", completedAt: new Date(Date.now() - daysAgo * DAY), date: new Date(Date.now() - daysAgo * DAY), createdAt: new Date(Date.now() - (daysAgo + 3) * DAY) });
  const playbookSent = (user, daysAgo) =>
    GrowthAction.create({ type: "playbook_email", idempotencyKey: `pb:${user._id}:${daysAgo}`, status: "succeeded", riskTier: "medium", modeAtProposal: "autonomous", subject: { entityType: "user", entityId: String(user._id) }, executedAt: new Date(Date.now() - daysAgo * DAY) });

  console.log("one inbox, two senders");

  await test("the lifecycle system counts a Marcus email from 2 days ago: no lifecycle email inside the weekly floor", async () => {
    const u = await customer();
    let p = await buildProfile(u, new Date());
    assert.strictEqual(p.lastMarketingAt, null);
    await playbookSent(u, 2);
    p = await buildProfile(u, new Date());
    assert.ok(p.lastMarketingAt && Date.now() - new Date(p.lastMarketingAt) < 3 * DAY, "the playbook send is the last marketing touch");
    assert.strictEqual(p.everMarketed, true);
    const verdict = await personEligible(p);
    assert.strictEqual(verdict.eligible, false);
    assert.strictEqual(verdict.reason, "frequency_cap");
  });

  await test("a lifecycle email that is newer than the playbook one still counts", async () => {
    const u = await customer();
    await playbookSent(u, 20);
    await MarketingSend.collection.insertOne({ user: u._id, email: u.email, campaignId: "x", status: "sent", sentAt: new Date(Date.now() - 1 * DAY), createdAt: new Date(Date.now() - 1 * DAY) });
    const p = await buildProfile(u, new Date());
    assert.ok(Date.now() - new Date(p.lastMarketingAt) < 2 * DAY);
  });

  console.log("no double follow-up");

  await test("Marcus stays out while the lifecycle post-free-visit sequence runs, and may follow up after it", async () => {
    const during = await customer();
    await freeVisitDone(during, 10);
    assert.strictEqual(await lifecycleSequenceActive(during, new Date()), true, "day 10 after the free visit: the lifecycle sequence owns it");
    const after = await customer();
    await freeVisitDone(after, 45);
    assert.strictEqual(await lifecycleSequenceActive(after, new Date()), false, "day 45: the sequence is over");
    process.env.ENABLE_MARKETING_EMAILS = "false";
    assert.strictEqual(await lifecycleSequenceActive(during, new Date()), false, "with the lifecycle system off there is nothing to collide with");
    process.env.ENABLE_MARKETING_EMAILS = "true";
    process.env.MARKETING_AUDIENCES = "member";
    assert.strictEqual(await lifecycleSequenceActive(during, new Date()), false, "nor when it does not write to non-members");
    delete process.env.MARKETING_AUDIENCES;
  });

  console.log("automation audit");

  await test("the audit shows each playbook's wording, real link and rule checks - and no customer data", async () => {
    await EmailPlaybook.collection.insertMany([
      { key: "never-booked-nudge", name: "Never booked", status: "approved", version: 2, approvedVersion: 2, segment: "registered_never_booked", ctaRoute: "book", subject: "Your free visit is waiting", preheader: "p", headline: "h", paragraphs: ["One free visit per customer."], ctaLabel: "Book", closing: "c", createdAt: new Date() },
      { key: "undecided-bad-link", name: "Undecided", status: "approved", version: 1, approvedVersion: 1, segment: "free_visit_undecided", ctaRoute: "bookFree", subject: "s", preheader: "p", headline: "h", paragraphs: ["One free visit per home."], ctaLabel: "Book", closing: "c", createdAt: new Date() },
    ]);
    const a = await automationAudit();
    const good = a.playbooks.find((p) => p.key === "never-booked-nudge");
    assert.match(good.buttonGoesTo, /\/book\/free$/, "an old 'book' button is read as the free visit for never-booked prospects");
    assert.deepStrictEqual([good.copyProblems, good.buttonProblem], [[], null]);
    const bad = a.playbooks.find((p) => p.key === "undecided-bad-link");
    assert.ok(bad.copyProblems.length, "'one per home' is caught");
    assert.ok(bad.buttonProblem, "the free visit offered again to someone who had it is caught");
    assert.ok(a.lifecycle && Array.isArray(a.lifecycle.audiences));
    assert.doesNotMatch(JSON.stringify(a), /homeowner-mail\.net|\+1631/, "no customer emails or phones");
  });

  console.log("playbook wording");

  await test("a corrected draft is saved as the next version, still a draft, once - and the old wording is kept in the log", async () => {
    const { applyPlaybookRevisions, REVISIONS } = require("../utils/growth/playbookRevisions");
    await EmailPlaybook.collection.insertOne({ key: "registered-never-booked-v1", name: "n", status: "draft", version: 1, approvedVersion: null, segment: "registered_never_booked", ctaRoute: "book", subject: "s", preheader: "p", headline: "h", paragraphs: ["It's free, one per home."], ctaLabel: "c", closing: "x", createdAt: new Date(), updatedAt: new Date() });
    const logged = [];
    const orig = console.log;
    console.log = (line) => logged.push(String(line));
    let applied;
    try {
      applied = await applyPlaybookRevisions();
    } finally {
      console.log = orig;
    }
    assert.deepStrictEqual(applied, [{ key: "registered-never-booked-v1", version: 2 }, { key: "registered-never-booked-v1", version: 3 }], "v1 -> v2 -> the owner's final v3");
    assert.ok(logged.some((l) => l.includes("playbook_revised_previous") && l.includes("one per home")), "the replaced wording is logged");
    const pb = await EmailPlaybook.findOne({ key: "registered-never-booked-v1" }).lean();
    assert.deepStrictEqual([pb.status, pb.version, pb.approvedVersion], ["draft", 3, null], "not approved by this");
    assert.deepStrictEqual(pb.paragraphs, REVISIONS[1].fields.paragraphs);
    assert.strictEqual(pb.paragraphs[2], "Booking is simple: choose an available day and time on our website and submit your request. We'll confirm your visit with you.");
    assert.deepStrictEqual(await applyPlaybookRevisions(), [], "idempotent");
    const { automationAudit } = require("../utils/growth/automationAudit");
    const row = (await automationAudit()).playbooks.find((p) => p.key === "registered-never-booked-v1");
    assert.deepStrictEqual([row.copyProblems, row.buttonProblem], [[], null]);
    assert.match(row.buttonGoesTo, /\/book\/free$/);
    // a draft never sends
    const { execute } = require("../utils/growth/actions/playbookEmail");
    const u = await customer();
    const r = await execute({ userId: String(u._id), playbookKey: "registered-never-booked-v1" }, { action: { _id: new mongoose.Types.ObjectId() }, now: new Date() });
    assert.deepStrictEqual(r, { outcome: "skip", reason: "playbook_not_approved" });
  });

  console.log("pacing");

  await test("never the whole audience at once: 3 per hourly run, 12 per day, daytime only, nothing parked for the owner, nobody used up", async () => {
    const engine = require("../utils/growth/actionEngine");
    const { proposePlaybookEmails, execute: send, PER_DAY, PER_RUN } = require("../utils/growth/actions/playbookEmail");
    process.env.GROWTH_ACTIONS_ENABLED_TYPES = "playbook_email";
    await EmailPlaybook.updateOne({ key: "registered-never-booked-v1" }, { $set: { status: "approved", approvedVersion: 3 } });
    await GrowthAction.collection.deleteMany({});
    for (let i = 0; i < 10; i += 1) await customer({ createdAt: new Date(Date.now() - 20 * DAY) });
    const busy = await customer({ createdAt: new Date(Date.now() - 20 * DAY) });
    await MarketingSend.collection.insertOne({ user: busy._id, email: busy.email, campaignId: "y", status: "sent", sentAt: new Date(Date.now() - 2 * DAY), createdAt: new Date(Date.now() - 2 * DAY) });
    const ny = (h) => new Date(new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }) + `T${String(h).padStart(2, "0")}:30:00-04:00`);

    assert.deepStrictEqual(await proposePlaybookEmails({ propose: engine.propose, now: ny(3) }), { proposed: 0, reason: "outside_send_hours" });
    const r = await proposePlaybookEmails({ propose: engine.propose, now: ny(14) });
    assert.strictEqual(r.proposed, PER_RUN, "3 per run");
    assert.strictEqual(await GrowthAction.countDocuments({ type: "playbook_email", status: "approved" }), PER_RUN);
    assert.ok(!(await GrowthAction.exists({ "subject.entityId": String(busy._id) })), "emailed this week: not queued, and not used up");

    // the day's limit reached: nothing queued, nothing parked for approval
    await GrowthAction.insertMany(Array.from({ length: PER_DAY }, (_, i) => ({ type: "playbook_email", idempotencyKey: `sent-${i}`, status: "succeeded", riskTier: "medium", modeAtProposal: "autonomous", executedAt: new Date(), subject: { entityType: "user", entityId: String(new mongoose.Types.ObjectId()) } })));
    assert.deepStrictEqual(await proposePlaybookEmails({ propose: engine.propose, now: ny(15) }), { proposed: 0, reason: "daily_limit" });
    assert.strictEqual(await GrowthAction.countDocuments({ type: "playbook_email", status: "awaiting_approval" }), 0, "never in the owner's approvals");

    // and at the moment of sending: a queued email waits rather than going over 12
    const queued = await GrowthAction.findOne({ type: "playbook_email", status: "approved" }).lean();
    const out = await send(queued.payload, { action: queued, now: ny(15) });
    assert.strictEqual(out.outcome, "defer", "12 already sent in 24 hours");
    const night = await send(queued.payload, { action: queued, now: ny(23) });
    assert.strictEqual(night.outcome, "defer", "not at night");
    delete process.env.GROWTH_ACTIONS_ENABLED_TYPES;
  });

  await mongoose.disconnect();
  await mongo.stop();
  console.log(`\n${passed} Marcus follow-up tests passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
