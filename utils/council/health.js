const AgentRun = require("../../models/AgentRun");
const AgentFinding = require("../../models/AgentFinding");
const { CouncilTask } = require("../../models/Council");
const tasks = require("./tasks");

/**
 * The Kingdom's health in ONE log line, counts and dates only - no titles,
 * instructions, summaries or anything about a customer - so the owner (or
 * Claude with the owner's read-only log access) can check production without
 * database access. Logged at boot and after every council review.
 *
 *   agents     each knight's and King Arthur's latest finished run: when, status
 *   tasks      open tasks by status; blocked; sent back after a failed check
 *   problems   risks/anomalies not verified fixed; awaiting Arthur's check; reopened
 *   focus      whether King Arthur's team focus is set, and when
 */
async function councilHealth({ now = new Date() } = {}) {
  const { PROBLEM_KINDS } = require("../agents/tools");
  const agents = {};
  for (const agent of [...tasks.SPECIALISTS, "arthur"]) {
    const r = await AgentRun.findOne({ agent, status: { $nin: ["running", "skipped"] } }).sort({ startedAt: -1 }).select("startedAt status").lean();
    agents[tasks.HERO[agent] || "Arthur"] = r ? { at: r.startedAt, status: r.status } : null;
  }
  const byStatus = await CouncilTask.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]);
  const sentBack = await CouncilTask.countDocuments({ status: { $in: tasks.OPEN }, "verification.verdict": "not_verified" });
  const open = { kind: { $in: PROBLEM_KINDS }, status: { $in: ["open", "acknowledged"] } };
  const scoped = { "archive.by": "system", "archive.category": "business_management", "archive.reason": /acquisition mission/ };
  const [archivedOutOfScope, archivedNotes, unresolved, awaitingCheck, reopened, focus] = await Promise.all([
    CouncilTask.countDocuments({ status: "archived", ...scoped }),
    AgentFinding.countDocuments({ status: "archived", ...scoped }),
    AgentFinding.countDocuments(open),
    AgentFinding.countDocuments({ ...open, "fixClaim.at": { $exists: true } }),
    AgentFinding.countDocuments({ ...open, reopenedAt: { $ne: null } }),
    tasks.teamFocus(),
  ]);
  return {
    event: "council_health",
    at: now,
    agents,
    tasks: { ...Object.fromEntries(byStatus.map((s) => [s._id, s.n])), sentBackOpen: sentBack },
    problems: { unresolved, awaitingCheck, reopened },
    focus: focus ? { set: true, at: focus.at } : { set: false },
    // existing-member work kept out of the Kingdom (archived, never deleted)
    outOfScopeArchived: { tasks: archivedOutOfScope, notes: archivedNotes },
    actions7d: await actionCounts(now),
    suspendedActionTypes: (await require("../growth/actionLog").suspendedTypes()).map((s) => s.type),
  };
}

/** Growth actions in the last 7 days by type and status (counts only). */
async function actionCounts(now) {
  const GrowthAction = require("../../models/GrowthAction");
  const rows = await GrowthAction.aggregate([
    { $match: { createdAt: { $gte: new Date(now.getTime() - 7 * 864e5) } } },
    { $group: { _id: { type: "$type", status: "$status" }, n: { $sum: 1 } } },
  ]);
  const out = {};
  for (const r of rows) (out[r._id.type] = out[r._id.type] || {})[r._id.status] = r.n;
  return out;
}

async function logCouncilHealth() {
  try {
    console.log(JSON.stringify(await councilHealth()));
  } catch (error) {
    console.error(JSON.stringify({ event: "council_health_failed", error: String(error?.message || error).slice(0, 200) }));
  }
}

module.exports = { councilHealth, logCouncilHealth };
