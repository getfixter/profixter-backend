const AgentFinding = require("../../models/AgentFinding");
const { CouncilDecision, CouncilTask } = require("../../models/Council");
const EmailPlaybook = require("../../models/EmailPlaybook");
const { ACQUISITION_SEGMENTS, outOfScope } = require("../growth/acquisitionScope");

/**
 * The owner's rule (2026-10-12): the Kingdom is new-customer acquisition
 * only, and Kingdom work about existing members' operations is archived -
 * never deleted. This sweep archives every OPEN task, note or King Arthur
 * record whose text is about existing members, their bookings, visits,
 * scheduling, payments, billing, cancellations or membership management
 * (acquisitionScope.outOfScope). The owner ordered it, so the owner's own
 * tasks are included (no archive request - that would only notify them).
 *
 * Email playbooks written for people who already bought a membership
 * (past members, scheduled cancellations) are retired the same way.
 *
 * Never touched: a task a knight is working on right now (the next sweep
 * gets it), content drafts and approval items (the owner's decisions).
 * Everything archived keeps its full record and appears in the chamber's
 * Archived list, restorable with one tap. Idempotent; runs at boot and
 * before every council review - no AI call.
 */
const BY = "system";
const REASON = "Outside the new-customer acquisition mission (owner's rule, 2026-10-12): existing members' operations belong to the owner, not the Kingdom. Kept in history.";
const TASK_OPEN = ["received", "assigned", "blocked", "completed"];
const NOTE_KINDS = ["opportunity", "risk", "anomaly", "experiment", "insight", "creative_brief"];

async function archiveOutOfScope({ now = new Date() } = {}) {
  const archive = (previousStatus) => ({ by: BY, at: now, reason: REASON, category: "business_management", previousStatus });
  const [taskRows, notes, records] = await Promise.all([
    CouncilTask.find({ status: { $in: TASK_OPEN } }).select("instruction why status").lean(),
    AgentFinding.find({ status: { $in: ["open", "acknowledged"] }, kind: { $in: NOTE_KINDS } }).select("title detail plain status").lean(),
    CouncilDecision.find({ status: "open", "payload.type": { $ne: "guidance" } }).select("subject simple detail").lean(),
  ]);
  const out = { tasks: 0, notes: 0, records: 0, playbooks: 0 };
  // follow-up wording for people who already bought a membership (past members, scheduled cancellations): retired, kept
  const pb = await EmailPlaybook.updateMany(
    { segment: { $nin: ACQUISITION_SEGMENTS }, status: { $in: ["draft", "approved"] } },
    { $set: { status: "retired", statusNote: "Retired: its audience already bought a membership - outside the new-customer acquisition mission (owner, 2026-10-12)" } }
  );
  out.playbooks = pb.modifiedCount;
  for (const t of taskRows.filter((x) => outOfScope(`${x.instruction} ${x.why || ""}`))) {
    const r = await CouncilTask.updateOne(
      { _id: t._id, status: t.status },
      { $set: { status: "archived", archive: archive(t.status) }, $push: { history: { at: now, status: "archived", by: BY, note: "Archived: outside the new-customer acquisition mission" } } }
    );
    out.tasks += r.modifiedCount;
  }
  for (const f of notes.filter((x) => outOfScope(`${x.title} ${x.detail || ""} ${x.plain || ""}`))) {
    const r = await AgentFinding.updateOne(
      { _id: f._id, status: f.status },
      { $set: { status: "archived", statusBy: BY, statusNote: "Archived: outside the new-customer acquisition mission", archive: archive(f.status) } }
    );
    out.notes += r.modifiedCount;
  }
  for (const d of records.filter((x) => outOfScope(`${x.subject} ${x.simple || ""} ${x.detail || ""}`))) {
    const r = await CouncilDecision.updateOne(
      { _id: d._id, status: "open" },
      { $set: { status: "archived", archive: archive("open"), resolution: { choice: "archived", by: BY, at: now, note: REASON } } }
    );
    out.records += r.modifiedCount;
  }
  if (out.tasks || out.notes || out.records || out.playbooks) console.log(JSON.stringify({ event: "kingdom_scope_archived", ...out }));
  return out;
}

module.exports = { archiveOutOfScope };
