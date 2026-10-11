const AgentFinding = require("../../models/AgentFinding");
const GrowthAction = require("../../models/GrowthAction");
const EmailPlaybook = require("../../models/EmailPlaybook");
const { CouncilDecision } = require("../../models/Council");

/**
 * ONE RULE FOR THE WHOLE KINGDOM: the owner is notified only when something
 * genuinely needs them NOW - and then exactly once, in King Arthur's
 * Decisions inbox. Knights never raise a "?" of their own, and Requests is a
 * calm catalogue, not a second inbox.
 *
 * Every pending item (an action awaiting approval, a draft email playbook, a
 * content draft) is in exactly one place:
 *   decisions        in Arthur's inbox, needing the owner - the only badge
 *   being_worked_on  Arthur parked it while a knight revises it, the owner
 *                    deferred it, or Arthur is reviewing a finished revision
 *   arthur_reviewing new work Arthur has not looked at yet (his next review
 *                    takes it; it reaches the owner only if it needs them)
 *
 * NEVER STUCK, NEVER SILENT: syncAttention() puts an item into Arthur's
 * inbox for the owner when Arthur has not reviewed it within 2 days, or at
 * once when it is time-sensitive (a reply to a homeowner who wrote in) - with
 * that reason, as ONE record (the same dedupe key Arthur's recommendation
 * uses), so it is never notified twice. Clearing a notification never
 * deletes, approves, publishes, sends or cancels anything.
 */
const UNREVIEWED_DAYS = 2;
const TIME_SENSITIVE = ["conversation_reply"];

async function pendingItems() {
  const [actions, playbooks, drafts] = await Promise.all([
    GrowthAction.find({ status: "awaiting_approval" }).select("type summary proposedBy createdAt").lean(),
    EmailPlaybook.find({ status: "draft" }).select("key name subject updatedAt createdAt").lean(),
    AgentFinding.find({ kind: "content_draft", status: "open" }).select("agent title createdAt updatedAt").lean(),
  ]);
  const { robotOfAction } = require("../growth/office");
  return [
    ...actions.map((a) => ({ kind: "action", id: String(a._id), title: a.summary, robot: robotOfAction(a), agent: robotAgent(robotOfAction(a)), type: a.type, since: a.createdAt })),
    ...playbooks.map((p) => ({ kind: "playbook", id: p.key, title: `Follow-up email: ${p.subject || p.name || p.key}`, robot: "conversation", agent: "conversion", type: "playbook", since: p.createdAt || p.updatedAt })),
    ...drafts.map((f) => ({ kind: "draft", id: String(f._id), title: f.title, robot: robotOfAgent(f.agent), agent: f.agent, type: "draft", since: f.createdAt })),
  ];
}

function robotAgent(robot) {
  return { visibility: "visibility", outreach: "outreach", conversation: "conversion" }[robot] || null;
}
function robotOfAgent(agent) {
  return { visibility: "visibility", outreach: "outreach", conversion: "conversation", conversation: "conversation" }[agent] || null;
}

/** Where each pending item stands. */
async function placeOf(items) {
  const open = await CouncilDecision.find({ status: "open", "refs.0": { $exists: true } }).select("refs inbox waiting").lean();
  const byRef = new Map();
  for (const d of open) for (const r of d.refs || []) byRef.set(`${r.kind}:${r.id}`, d);
  return items.map((it) => {
    const d = byRef.get(`${it.kind}:${it.id}`);
    if (!d) return { ...it, place: "arthur_reviewing", decisionId: null };
    if (d.inbox === "waiting" || d.inbox === "review") return { ...it, place: "being_worked_on", decisionId: String(d._id), reason: d.inbox === "review" ? "King Arthur is reviewing the new version" : d.waiting?.reason || "A knight is revising it" };
    return { ...it, place: "decisions", decisionId: String(d._id) };
  });
}

/**
 * Brings what genuinely needs the owner - and Arthur has not handled - into
 * his inbox (once). Idempotent; changes nothing else.
 */
async function syncAttention({ now = new Date() } = {}) {
  const placed = await placeOf(await pendingItems());
  let added = 0;
  for (const it of placed) {
    if (it.place !== "arthur_reviewing") continue;
    const urgent = TIME_SENSITIVE.includes(it.type);
    const stale = now - new Date(it.since || now) > UNREVIEWED_DAYS * 864e5;
    if (!urgent && !stale) continue;
    const dedupeKey = `rec:${it.kind}:${it.id}`;
    if (await CouncilDecision.exists({ dedupeKey, status: "open" })) continue;
    await CouncilDecision.create({
      category: "decision",
      subject: String(it.title || "A request").slice(0, 200),
      simple: urgent
        ? "Boss, a homeowner who wrote to us is waiting for a reply - this needs your yes or no."
        : `Boss, this has waited ${UNREVIEWED_DAYS}+ days and I have not reviewed it yet, so it is here for you. You can also tell me to look at it first.`,
      detail: urgent ? "Time-sensitive: a reply to a homeowner." : `Not reviewed by King Arthur within ${UNREVIEWED_DAYS} days.`,
      agent: it.agent,
      refs: [{ kind: it.kind, id: it.id }],
      inbox: "needs_you",
      inboxHistory: [{ at: now, to: "needs_you", by: "system", note: urgent ? "Time-sensitive" : `Not reviewed by King Arthur within ${UNREVIEWED_DAYS} days` }],
      dedupeKey,
    });
    added += 1;
  }
  if (added) console.log(JSON.stringify({ event: "attention_synced", addedToInbox: added }));
  return { addedToInbox: added };
}

/**
 * The counts every part of the Kingdom shows. "needsYou" is the ONLY number
 * that may become a badge, "?" or "waiting for you" - and it is the same
 * number Arthur's Decisions inbox shows (decisions that need the owner).
 */
async function attentionSummary() {
  const placed = await placeOf(await pendingItems());
  const inboxDecisions = await CouncilDecision.countDocuments({ status: "open", category: { $in: ["decision", "uncertain"] }, inbox: { $nin: ["waiting", "review"] } });
  const byRobot = {};
  for (const it of placed) {
    if (!it.robot) continue;
    byRobot[it.robot] ||= { decisions: 0, being_worked_on: 0, arthur_reviewing: 0 };
    byRobot[it.robot][it.place] += 1;
  }
  return {
    needsYou: inboxDecisions,
    pending: placed.length,
    inDecisions: placed.filter((i) => i.place === "decisions").length,
    beingWorkedOn: placed.filter((i) => i.place === "being_worked_on").length,
    arthurReviewing: placed.filter((i) => i.place === "arthur_reviewing").length,
    byRobot,
    items: placed,
  };
}

module.exports = { TIME_SENSITIVE, UNREVIEWED_DAYS, attentionSummary, pendingItems, placeOf, syncAttention };
