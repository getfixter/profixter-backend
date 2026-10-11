/**
 * ONE RULE FOR THE WHOLE KINGDOM: the owner is notified only when something
 * genuinely needs them now - once, in King Arthur's Decisions.
 *
 * Walks the full notification lifecycle of a knight's draft and checks, at
 * every step, that Arthur's badge, the hall (office), the knights and
 * Requests agree - and that clearing a notification never deletes, approves,
 * publishes, sends or cancels anything.
 *
 * In-memory MongoDB, no API spend.
 *   node scripts/test_attention.js
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

async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  require("../utils/analytics/stripeMrr").setStripeClient({ subscriptions: { list: () => { throw new Error("not used"); } } });

  const AgentFinding = require("../models/AgentFinding");
  const GrowthAction = require("../models/GrowthAction");
  const { CouncilDecision, CouncilTask } = require("../models/Council");
  const office = require("../utils/growth/office");
  const { decisionBoard } = require("../utils/council/board");
  const inbox = require("../utils/council/inbox");
  const attention = require("../utils/council/attention");
  const tasks = require("../utils/council/tasks");
  const arthur = require("../utils/council/arthur");

  /** Everything the owner can see, at one moment. */
  async function everywhere() {
    office.invalidateOffice();
    const o = await office.buildOffice({ fresh: true });
    const b = await decisionBoard();
    const reqs = await office.approvalsList();
    return {
      arthurBadge: b.counts.badge,
      hallNeedsYou: o.approvals.needsYou,
      knightQuestions: o.robots.filter((r) => r.status === "needs_you").map((r) => r.key),
      robots: Object.fromEntries(o.robots.map((r) => [r.key, r.work])),
      requests: reqs.items.map((i) => ({ id: i.id, place: i.place, waiting: Boolean(i.waiting) })),
      board: b,
    };
  }
  function calm(v, label) {
    assert.strictEqual(v.arthurBadge, v.hallNeedsYou, `${label}: the hall and Arthur agree`);
    assert.deepStrictEqual(v.knightQuestions, [], `${label}: no knight ever shows a "?"`);
  }

  const draft = await AgentFinding.create({ agent: "visibility", kind: "content_draft", severity: "info", title: "gbp_post: Fall gutter check", detail: "x", body: "Post text", status: "open" });
  const draftId = String(draft._id);

  console.log("the lifecycle of a knight's draft");

  await test("a new draft: King Arthur reviews it first - no badge, no question mark anywhere", async () => {
    const v = await everywhere();
    calm(v, "new draft");
    assert.strictEqual(v.arthurBadge, 0);
    assert.deepStrictEqual(v.robots.visibility, { inDecisions: 0, beingWorkedOn: 0, arthurReviewing: 1 });
    assert.deepStrictEqual(v.requests.find((r) => r.id === draftId), { id: draftId, place: "arthur_reviewing", waiting: true });
    assert.strictEqual(await CouncilDecision.countDocuments({}), 0, "nothing in the owner's inbox yet");
  });

  let task;
  await test("Arthur sends it back for revision: 'being worked on' everywhere, still calm", async () => {
    task = (await tasks.assignTask({ agent: "visibility", instruction: "Revise the fall gutter post with a clearer local hook" })).task;
    const d = await CouncilDecision.create({ category: "decision", subject: "Fall gutter post", simple: "x", agent: "visibility", recommendation: { choice: "wait", reason: "Odysseus is revising" }, refs: [{ kind: "draft", id: draftId }], dedupeKey: `rec:draft:${draftId}` });
    await inbox.setWaiting(String(d._id), { kind: "knight", reason: "Odysseus is revising the hook", taskId: String(task._id), by: "King Arthur" });
    const v = await everywhere();
    calm(v, "being revised");
    assert.strictEqual(v.arthurBadge, 0);
    assert.deepStrictEqual(v.robots.visibility, { inDecisions: 0, beingWorkedOn: 1, arthurReviewing: 0 });
    assert.strictEqual(v.board.sections[1].items.length, 1, "it is under Being worked on");
  });

  await test("the knight finishes: it goes to Arthur first - still no badge", async () => {
    await CouncilTask.updateOne({ _id: task._id }, { $set: { status: "completed" } });
    const v = await everywhere();
    calm(v, "finished, Arthur reviewing");
    assert.strictEqual(v.arthurBadge, 0);
    assert.match(v.board.sections[1].items[0].status, /King Arthur is reviewing/);
  });

  await test("Arthur decides it needs the owner: exactly ONE notification - his badge - and the hall agrees", async () => {
    const d = await CouncilDecision.findOne({ dedupeKey: `rec:draft:${draftId}` });
    await CouncilDecision.updateOne({ _id: d._id }, { $set: { recommendation: { choice: "approve", reason: "Ready" } } });
    await inbox.setNeedsYou(String(d._id), { by: "King Arthur", note: "Ready: approve" });
    const v = await everywhere();
    calm(v, "ready for the owner");
    assert.strictEqual(v.arthurBadge, 1);
    assert.deepStrictEqual(v.robots.visibility, { inDecisions: 1, beingWorkedOn: 0, arthurReviewing: 0 }, "the knight knows - quietly");
    assert.strictEqual(await CouncilDecision.countDocuments({ status: "open" }), 1, "one record, not one per place");
  });

  await test("the owner defers it: gone from every count at once - the draft is untouched", async () => {
    const d = await CouncilDecision.findOne({ dedupeKey: `rec:draft:${draftId}` });
    await inbox.ownerDefer(String(d._id), { by: "Owner" });
    const v = await everywhere();
    calm(v, "deferred");
    assert.strictEqual(v.arthurBadge, 0);
    assert.strictEqual((await AgentFinding.findById(draftId).lean()).status, "open", "not deleted, not approved");
    await inbox.setNeedsYou(String(d._id), { by: "Owner", note: "brought back" });
    assert.strictEqual((await everywhere()).arthurBadge, 1);
  });

  await test("the owner acknowledges it in Requests: Arthur's inbox clears too - the draft is kept", async () => {
    await AgentFinding.updateOne({ _id: draftId }, { $set: { status: "acknowledged" } });
    const v = await everywhere();
    calm(v, "acknowledged");
    assert.strictEqual(v.arthurBadge, 0);
    assert.strictEqual((await CouncilDecision.findOne({ dedupeKey: `rec:draft:${draftId}` }).lean()).status, "superseded", "kept in history");
    assert.ok(await AgentFinding.exists({ _id: draftId }), "nothing deleted");
  });

  console.log("never stuck, never silent");

  await test("work Arthur has not reviewed for 2 days reaches the owner once, with the reason", async () => {
    const old = await AgentFinding.create({ agent: "outreach", kind: "content_draft", severity: "info", title: "instagram_post: Winter prep", detail: "x", status: "open" });
    await AgentFinding.collection.updateOne({ _id: old._id }, { $set: { createdAt: new Date(Date.now() - 3 * 864e5) } });
    let v = await everywhere();
    calm(v, "stale");
    assert.strictEqual(v.arthurBadge, 1);
    const d = await CouncilDecision.findOne({ dedupeKey: `rec:draft:${old._id}` }).lean();
    assert.match(d.simple, /I have not reviewed it yet/);
    v = await everywhere();
    assert.strictEqual(await CouncilDecision.countDocuments({ dedupeKey: `rec:draft:${old._id}` }), 1, "no duplicate on later reads");
    // when Arthur later recommends on it, the same record is updated
    await AgentFinding.updateOne({ _id: old._id }, { $set: { status: "dismissed" } });
    v = await everywhere();
    assert.strictEqual(v.arthurBadge, 0);
  });

  await test("a reply to a homeowner is time-sensitive: it reaches the owner at once (and only once)", async () => {
    const a = await GrowthAction.create({ type: "conversation_reply", idempotencyKey: "cr1", status: "awaiting_approval", riskTier: "medium", modeAtProposal: "supervised", summary: "Reply to a homeowner", payload: { reply: "Hi" } });
    const v = await everywhere();
    calm(v, "time-sensitive");
    assert.strictEqual(v.arthurBadge, 1);
    assert.strictEqual((await GrowthAction.findById(a._id).lean()).status, "awaiting_approval", "nothing sent");
  });

  await test("with nothing that needs the owner, the whole Kingdom is calm", async () => {
    await GrowthAction.updateMany({}, { $set: { status: "rejected" } });
    const fresh = await AgentFinding.create({ agent: "conversion", kind: "content_draft", severity: "info", title: "message_copy: follow-up", detail: "x", status: "open" });
    void fresh;
    const v = await everywhere();
    calm(v, "calm");
    assert.strictEqual(v.arthurBadge, 0);
    assert.strictEqual(v.hallNeedsYou, 0);
    assert.strictEqual(v.board.counts.badge, 0);
    assert.strictEqual(v.board.sections[0].items.filter((i) => i.category !== "info").length, 0);
  });

  void arthur;
  await mongoose.disconnect();
  await mongo.stop();
  console.log(`\n${passed} attention tests passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
