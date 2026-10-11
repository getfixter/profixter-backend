/**
 * THE DECISIONS BOARD: what the owner sees in King Arthur's Decisions tab and
 * what every copy contains are the same list - same sections, same order,
 * same numbers, same permanent record ids - through every change.
 *
 * Regression for: "Can't measure CAC..." was first on screen but #2 in the
 * copied report (two lists, two sort rules).
 *
 * In-memory MongoDB, no API spend.
 *   node scripts/test_decision_board.js
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

const MIN = 60 * 1000;

async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  require("../utils/analytics/stripeMrr").setStripeClient({ subscriptions: { list: () => { throw new Error("not used"); } } });

  const { CouncilDecision, CouncilTask } = require("../models/Council");
  const GrowthAction = require("../models/GrowthAction");
  const { decisionBoard } = require("../utils/council/board");
  const { buildReport, CLOSING } = require("../utils/council/report");
  const inbox = require("../utils/council/inbox");
  const arthur = require("../utils/council/arthur");

  const t0 = Date.now() - 600 * MIN;
  const at = (m) => new Date(t0 + m * MIN);
  const mk = (subject, extra = {}, minute = 0) =>
    CouncilDecision.collection.insertOne({ category: "decision", subject, simple: `Boss, ${subject}.`, status: "open", inbox: "needs_you", refs: [], createdAt: at(minute), updatedAt: at(minute), ...extra }).then((r) => String(r.insertedId));

  /** The board as the screen shows it: [number, id, section] from top to bottom. */
  const screen = (b) => b.sections.flatMap((s) => s.items.map((i) => [i.number, i.id, s.key]));
  /** The copied report, read back: every "### Decision #n" heading with its record id and section. */
  function readReport(text) {
    const out = [];
    let section = null;
    for (const line of text.split("\n")) {
      const sec = line.match(/^## (Needs your decision|Being worked on|Completed and history) \(\d+\)$/);
      if (sec) section = { "Needs your decision": "needs_you", "Being worked on": "being_worked_on", "Completed and history": "history" }[sec[1]];
      const h = line.match(/^### Decision #(\d+): /);
      if (h) out.push([Number(h[1]), null, section]);
      const id = line.match(/^- Record ID: ([a-f0-9]{24})$/);
      if (id) out[out.length - 1][1] = id[1];
    }
    return out;
  }
  async function assertScreenEqualsCopies(label) {
    const b = await decisionBoard();
    const s = screen(b);
    // numbers 1..N with no gaps, top to bottom
    assert.deepStrictEqual(s.map((x) => x[0]), s.map((_, i) => i + 1), `${label}: contiguous numbers`);
    // Copy All (built from this same board, and built fresh) and the full report match the screen exactly
    for (const r of [await buildReport({ board: b }), await buildReport(), await buildReport({ scope: "full" })]) {
      assert.deepStrictEqual(readReport(r.text), s, `${label}: report order = screen order`);
      assert.ok(r.text.trim().endsWith(CLOSING));
    }
    // each item's own copy carries its screen number and permanent id, word for word as in the report
    const full = (await buildReport({ board: b })).text;
    for (const sec of b.sections) {
      for (const it of sec.items) {
        assert.match(it.copy, new RegExp(`^### Decision #${it.number}: `));
        assert.ok(it.copy.includes(`- Record ID: ${it.id}`));
        assert.ok(it.copy.includes(`decision #${it.number} (record ${it.id})`));
        assert.ok(full.includes(it.brief), `${label}: the item's copy text is the report's text for #${it.number}`);
      }
    }
    return b;
  }

  console.log("one board for the screen and every copy");

  const ids = {};
  await test("different decision types land in their sections, in a fixed order, numbered 1..N", async () => {
    const task = await CouncilTask.create({ agent: "outreach", instruction: "Revise the fall gutters post", origin: "arthur", status: "assigned", history: [] });
    ids.cac = await mk("Can't measure CAC: Meta spend not connected", { category: "uncertain" }, 10);
    ids.title = await mk("New Google title for the drywall page", { recommendation: { choice: "approve", reason: "Low risk" } }, 20);
    ids.guidance = await mk("New guidance for Leonidas", { payload: { type: "guidance", agent: "outreach", guidance: "Post twice a week.", previous: "", baseVersion: 0 }, recommendation: { choice: "confirm", reason: "x" } }, 5);
    ids.info = await mk("Search data is flowing", { category: "info" }, 1);
    ids.wait = await mk("Fall gutters post", { inbox: "waiting", waiting: { kind: "knight", reason: "Leonidas is revising", taskId: String(task._id), since: at(30), until: new Date(Date.now() + 5 * 864e5) } }, 2);
    ids.review = await mk("Bing Places profile", { inbox: "review", waiting: { kind: "knight", since: at(40) } }, 3);
    ids.done = await mk("Old resolved item", { status: "resolved", resolution: { choice: "handled", by: "Owner", at: at(50) } }, 0);
    const b = await assertScreenEqualsCopies("initial");
    const order = b.sections.flatMap((s) => s.items.map((i) => i.id));
    // needs you: decisions by when they arrived (guidance 5, CAC 10, title 20), then good-to-know; then being worked on (by since); then history
    assert.deepStrictEqual(order, [ids.guidance, ids.cac, ids.title, ids.info, ids.wait, ids.review, ids.done]);
    assert.strictEqual(b.counts.badge, 3, "only the three decisions count toward the badge");
    assert.strictEqual(b.counts.beingWorkedOn, 2);
  });

  await test("acknowledging moves the item to history; everything renumbers without gaps; the record id stays", async () => {
    await arthur.resolveDecision({ id: ids.info, choice: "done", by: "Owner" });
    const b = await assertScreenEqualsCopies("after acknowledge");
    const moved = b.sections.find((s) => s.key === "history").items.find((i) => i.id === ids.info);
    assert.ok(moved, "same id, now in history");
    assert.strictEqual(b.sections[0].items.length, 3);
  });

  await test("deferring and bringing back move it between sections; numbers and copies follow", async () => {
    await inbox.ownerDefer(ids.cac, { by: "Owner" });
    let b = await assertScreenEqualsCopies("after defer");
    assert.ok(b.sections[1].items.some((i) => i.id === ids.cac));
    assert.strictEqual(b.counts.badge, 2);
    await inbox.setNeedsYou(ids.cac, { by: "Owner", note: "You brought it back" });
    b = await assertScreenEqualsCopies("after bring back");
    // it re-entered the inbox last, so it is now the last decision - and the copy says so too
    const needs = b.sections[0].items.filter((i) => i.category !== "info").map((i) => i.id);
    assert.strictEqual(needs.at(-1), ids.cac);
  });

  await test("a knight finishing moves a waiting item to review; its number and copy update together", async () => {
    await CouncilTask.updateMany({}, { $set: { status: "completed" } });
    const b = await assertScreenEqualsCopies("after the knight finished");
    const it = b.sections[1].items.find((i) => i.id === ids.wait);
    assert.match(it.status, /King Arthur is reviewing/);
    assert.ok(it.copy.includes(it.status));
  });

  await test("a new decision appears at the end of its section; earlier numbers do not move", async () => {
    const before = (await decisionBoard()).sections[0].items.map((i) => [i.number, i.id]);
    ids.fresh = await mk("Yelp profile text ready", { createdAt: new Date(), updatedAt: new Date() });
    const b = await assertScreenEqualsCopies("after a new decision");
    const after = b.sections[0].items.map((i) => [i.number, i.id]);
    assert.deepStrictEqual(after.slice(0, before.length), before, "the earlier decisions keep their numbers");
    assert.strictEqual(after.at(-1)[1], ids.fresh);
  });

  await test("an item decided in Requests leaves the inbox at once - the screen and copies agree, no stale entry", async () => {
    const a = await GrowthAction.create({ type: "seo_page_update", idempotencyKey: "k1", status: "awaiting_approval", riskTier: "low", modeAtProposal: "supervised", summary: "Title", payload: { path: "/x", changes: { metaTitle: "X | Profixter" } } });
    const rec = await mk("Approve the /x title?", { refs: [{ kind: "action", id: String(a._id) }], createdAt: new Date(), updatedAt: new Date() });
    let b = await assertScreenEqualsCopies("with a Requests item");
    assert.ok(b.sections[0].items.some((i) => i.id === rec));
    await GrowthAction.updateOne({ _id: a._id }, { $set: { status: "succeeded" } });
    b = await assertScreenEqualsCopies("after it was decided in Requests");
    assert.ok(!b.sections[0].items.some((i) => i.id === rec));
    assert.ok(b.sections[2].items.some((i) => i.id === rec), "kept in history");
    const all = b.sections.flatMap((s) => s.items.map((i) => i.id));
    assert.strictEqual(new Set(all).size, all.length, "no duplicates");
  });

  await test("nothing was approved, dismissed or changed by reading or copying", async () => {
    const before = await CouncilDecision.find({}).lean();
    await decisionBoard();
    await buildReport();
    await buildReport({ scope: "full" });
    const after = await CouncilDecision.find({}).lean();
    assert.deepStrictEqual(after.map((d) => [String(d._id), d.status, d.inbox]), before.map((d) => [String(d._id), d.status, d.inbox]));
  });

  await mongoose.disconnect();
  await mongo.stop();
  console.log(`\n${passed} decision-board tests passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
