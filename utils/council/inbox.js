const mongoose = require("mongoose");
const { CouncilDecision, CouncilTask } = require("../../models/Council");

/**
 * THE OWNER'S INBOX CONTAINS ONLY WHAT NEEDS THE OWNER NOW.
 *
 * Every open council record is in exactly one place:
 *   needs_you  the owner can and should act now - the only state that counts
 *              toward the badge
 *   waiting    a knight is revising the work (kind "knight"), or the owner
 *              chose "Wait - remind me when ready" (kind "owner")
 *   review     the knight finished: King Arthur reviews the new version and
 *              either brings it back with a fresh recommendation, or waits again
 *
 * NOTHING GETS STUCK OR LOST (sweep(), run whenever the council is read and
 * in every review):
 *   - waiting on a task that is done (completed, checked, blocked, cancelled,
 *     archived) -> review
 *   - waiting longer than its limit (7 days for a knight, the owner's reminder
 *     date) -> needs_you, with the reason
 *   - in review for more than 2 days -> needs_you ("Arthur has not reviewed it")
 * Records are never deleted; every move is written to inboxHistory, and a
 * record moves only when its state really changes, so there are no duplicate
 * notifications.
 */
const KNIGHT_WAIT_DAYS = 7;
const OWNER_WAIT_DAYS = 3;
const REVIEW_DAYS = 2;
const DONE = ["completed", "verified", "not_verified", "blocked", "cancelled", "archived"];
const DAY = 864e5;

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function entry(to, by, note) {
  return { at: new Date(), to, by, note: String(note || "").slice(0, 300) };
}

async function openTask(taskId) {
  if (!taskId || !mongoose.Types.ObjectId.isValid(taskId)) return null;
  return CouncilTask.findOne({ _id: taskId, status: { $nin: DONE } }).lean();
}

/** Put an open record into "waiting" (on a knight's task, or by the owner's choice). */
async function setWaiting(id, { kind, reason, taskId = null, days = null, by }) {
  if (!mongoose.Types.ObjectId.isValid(id)) throw fail("bad id", 404);
  const d = await CouncilDecision.findOne({ _id: id, status: "open" }).lean();
  if (!d) throw fail("That is no longer open.", 404);
  let task = null;
  if (taskId) {
    task = await openTask(taskId);
    if (!task) throw fail("That task is not open - nothing to wait for.");
  }
  const limit = days ?? (kind === "owner" ? OWNER_WAIT_DAYS : KNIGHT_WAIT_DAYS);
  const waiting = {
    kind,
    reason: String(reason || "").slice(0, 400),
    taskId: task ? String(task._id) : null,
    since: new Date(),
    until: new Date(Date.now() + limit * DAY),
    by,
  };
  const note = task ? `Waiting for ${task.agent} to finish: ${String(task.instruction).slice(0, 120)}` : `Waiting until ${waiting.until.toISOString().slice(0, 10)}`;
  await CouncilDecision.updateOne({ _id: d._id, status: "open" }, { $set: { inbox: "waiting", waiting }, $push: { inboxHistory: entry("waiting", by, `${note}. ${waiting.reason}`) } });
  return { inbox: "waiting", waiting };
}

/** Back to the owner now (Arthur's fresh recommendation, a reminder, or the owner's "bring it back"). */
async function setNeedsYou(id, { by, note }) {
  await CouncilDecision.updateOne(
    { _id: id, status: "open", inbox: { $ne: "needs_you" } },
    { $set: { inbox: "needs_you" }, $unset: { waiting: "" }, $push: { inboxHistory: entry("needs_you", by, note) } }
  );
}

/**
 * The owner's "Wait - remind me when ready": if the record is about work a
 * knight is still doing, it comes back when that work is done (via Arthur's
 * review); otherwise in 3 days. Nothing is approved, dismissed or stopped.
 */
async function ownerDefer(id, { by }) {
  const d = await CouncilDecision.findOne({ _id: id, status: "open" }).lean();
  if (!d) throw fail("That is no longer open.", 404);
  let task = d.waiting?.taskId ? await openTask(d.waiting.taskId) : null;
  if (!task && d.agent) task = await CouncilTask.findOne({ agent: d.agent, status: { $in: ["assigned", "in_progress", "received"] } }).sort({ updatedAt: -1 }).lean();
  return setWaiting(id, {
    kind: "owner",
    reason: task ? "You asked to be reminded when the knight's work is ready." : `You asked to be reminded in ${OWNER_WAIT_DAYS} days.`,
    taskId: task ? String(task._id) : null,
    days: task ? KNIGHT_WAIT_DAYS : OWNER_WAIT_DAYS,
    by,
  });
}

/** Moves waiting and review records along. Safe to run any time; idempotent. */
async function sweep({ now = new Date() } = {}) {
  // first close records whose item was decided anywhere (Requests, a knight panel), so every view agrees
  await require("./arthur").settleDecisions();
  const moved = { toReview: 0, toYou: 0 };
  const open = await CouncilDecision.find({ status: "open", inbox: { $in: ["waiting", "review"] } }).lean();
  for (const d of open) {
    if (d.inbox === "waiting") {
      const task = d.waiting?.taskId && mongoose.Types.ObjectId.isValid(d.waiting.taskId) ? await CouncilTask.findById(d.waiting.taskId).select("status agent").lean() : null;
      if (task && DONE.includes(task.status)) {
        const r = await CouncilDecision.updateOne(
          { _id: d._id, inbox: "waiting" },
          { $set: { inbox: "review", "waiting.since": now }, $push: { inboxHistory: entry("review", "system", `The knight's task is ${task.status} - King Arthur reviews the new version`) } }
        );
        moved.toReview += r.modifiedCount;
      } else if (d.waiting?.taskId && !task) {
        await setNeedsYou(d._id, { by: "system", note: "The task it waited on no longer exists" });
        moved.toYou += 1;
      } else if (d.waiting?.until && new Date(d.waiting.until) <= now) {
        await setNeedsYou(d._id, { by: "system", note: d.waiting.kind === "owner" ? "Your reminder" : `Still waiting after ${KNIGHT_WAIT_DAYS} days - please take a look` });
        moved.toYou += 1;
      }
    } else if (d.inbox === "review") {
      const since = new Date(d.waiting?.since || d.updatedAt);
      if (now - since > REVIEW_DAYS * DAY) {
        await setNeedsYou(d._id, { by: "system", note: `Ready since ${since.toISOString().slice(0, 10)} - King Arthur has not reviewed it yet` });
        moved.toYou += 1;
      }
    }
  }
  await require("./attention").syncAttention({ now });
  return moved;
}

/**
 * One-time sort of records that were already open when the inbox arrived:
 * anything Arthur recommended to "wait" goes to waiting (on that knight's
 * latest open task, if any); everything else stays in the owner's inbox.
 * Nothing is approved, sent, published or discarded.
 */
async function classifyExisting() {
  const open = await CouncilDecision.find({ status: "open", inbox: { $exists: false } }).lean();
  const result = { waiting: 0, needsYou: 0 };
  for (const d of open) {
    if (d.recommendation?.choice === "wait") {
      const task = d.agent ? await CouncilTask.findOne({ agent: d.agent, status: { $in: ["assigned", "in_progress", "received"] } }).sort({ updatedAt: -1 }).lean() : null;
      await CouncilDecision.updateOne(
        { _id: d._id },
        {
          $set: {
            inbox: "waiting",
            waiting: { kind: "knight", reason: d.recommendation.reason || "King Arthur recommended waiting", taskId: task ? String(task._id) : null, since: new Date(), until: new Date(Date.now() + KNIGHT_WAIT_DAYS * DAY), by: "system" },
          },
          $push: { inboxHistory: entry("waiting", "system", task ? `Sorted on arrival of the new inbox: waiting for ${task.agent}'s task` : "Sorted on arrival of the new inbox: King Arthur recommended waiting") },
        }
      );
      result.waiting += 1;
    } else {
      await CouncilDecision.updateOne({ _id: d._id }, { $set: { inbox: "needs_you" }, $push: { inboxHistory: entry("needs_you", "system", "Sorted on arrival of the new inbox") } });
      result.needsYou += 1;
    }
  }
  if (open.length) console.log(JSON.stringify({ event: "council_inbox_classified", ...result }));
  return result;
}

/** Pending approval items that sit in waiting/review - kept out of the Requests badge. */
async function waitingRefs() {
  const rows = await CouncilDecision.find({ status: "open", inbox: { $in: ["waiting", "review"] }, "refs.0": { $exists: true } }).select("refs inbox waiting").lean();
  const map = new Map();
  for (const d of rows) for (const r of d.refs || []) map.set(`${r.kind}:${r.id}`, { inbox: d.inbox, reason: d.waiting?.reason || "", since: d.waiting?.since || null });
  return map;
}

module.exports = { KNIGHT_WAIT_DAYS, OWNER_WAIT_DAYS, REVIEW_DAYS, classifyExisting, ownerDefer, setNeedsYou, setWaiting, sweep, waitingRefs };
