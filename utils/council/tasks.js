const mongoose = require("mongoose");
const { CouncilTask } = require("../../models/Council");
const { validateGuidance } = require("../agents/settings");

/**
 * Council tasks: instructions from the owner or King Arthur to one specialist.
 *
 * The life of a task is visible and each step is earned by a different party:
 *   received     the owner asked Arthur for it (owner-origin tasks only)
 *   assigned     Arthur handed it to the specialist
 *   in_progress  the specialist's shift picked it up (set by the runtime)
 *   completed    the specialist reported it done (report_to_arthur)
 *   blocked      the specialist reported it cannot be done (and why)
 *   verified / not_verified   Arthur or the owner checked the report
 *   cancelled    the owner (any task) or Arthur (his own) withdrew it
 * Nothing skips a step: Arthur cannot mark a task completed, a specialist
 * cannot verify its own work, and a task picked up by a shift that ended
 * without reporting goes back to "assigned".
 *
 * WHAT MAY BE ASSIGNED is checked here in code, not left to a prompt: the
 * same protected rules as owner guidance (no booking, no Meta ads, no mail,
 * no prices or offers, no contacting the imported list, no overriding rules)
 * plus anything that would need the owner's authority - sending messages,
 * publishing, approving, spending, switching automations on.
 */
const SPECIALISTS = ["visibility", "outreach", "conversion"];
const HERO = { visibility: "Odysseus", outreach: "Leonidas", conversion: "Marcus" };
const OPEN = ["received", "assigned", "in_progress", "blocked"];
const MAX_OPEN_PER_AGENT = 5;
const MAX_NEW_PER_DAY = 12;
const MAX_PICKUP = 3;

const NEEDS_OWNER = [
  {
    re: /\b(send|text|sms|e-?mail|call|message|reply to|contact|reach out to|dm)\b[^.\n]{0,40}\b(customers?|homeowners?|members?|leads?|people|contacts?|prospects?|clients?|partners?|businesses|them)\b/i,
    why: "Specialists never contact anyone on their own - every customer or partner message needs the owner's approval.",
  },
  {
    re: /\b(publish|go live|launch|deploy)\b[^.\n]{0,30}\b(page|pages|changes?|content|guide|article|post|campaign|it)\b/i,
    why: "Publishing goes through the owner's approval queue, not a task.",
  },
  {
    re: /\b(approve|authori[sz]e|sign off)\b/i,
    why: "Only the owner approves. Arthur cannot approve, or ask a specialist to approve, anything.",
  },
  {
    re: /\b(spend|pay for|buy|purchase|subscribe to|sign up for|hire|budget of)\b|\$\s?\d/i,
    why: "Spending money always needs the owner.",
  },
  {
    re: /\b(turn on|switch on|enable|activate|start sending)\b[^.\n]{0,30}\b(repl(y|ies)|automations?|campaigns?|messaging|texts?|emails?|sms|outreach|waves?|flows?)\b/i,
    why: "Switching on customer-facing automations is the owner's decision.",
  },
  {
    re: /\b(change|edit|modify|remove|grant|give)\b[^.\n]{0,30}\b(permissions?|access|approvals?|trust (level|policy)|policies|policy|modes?)\b/i,
    why: "Permissions, approvals and trust policies are the owner's alone.",
  },
];

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

/** Every reason this instruction may not be assigned; empty = allowed. */
function taskProblems(agent, instruction) {
  const problems = [];
  if (!SPECIALISTS.includes(agent)) problems.push(`"${agent}" is not a specialist (use visibility, outreach or conversion).`);
  const text = String(instruction || "").trim();
  if (text.length < 10) problems.push("The instruction is too short to act on.");
  if (text.length > 800) problems.push("Keep an instruction under 800 characters.");
  problems.push(...validateGuidance(text).filter((p) => !/under 1500 characters/.test(p)));
  for (const rule of NEEDS_OWNER) if (rule.re.test(text)) problems.push(rule.why);
  const scope = require("../growth/acquisitionScope");
  if (scope.outOfScope(text)) problems.push(scope.SCOPE_WHY);
  return problems;
}

function entry(status, by, note = "") {
  return { at: new Date(), status, by, note: String(note).slice(0, 300) };
}

/**
 * Create a task (or return the open one with the same meaning).
 * Throws { problems } when the rules or caps refuse it.
 */
async function assignTask({ agent, instruction, why = "", origin = "arthur", ownerName = "Owner" }) {
  const problems = taskProblems(agent, instruction);
  const scope = require("../growth/acquisitionScope");
  if (!problems.includes(scope.SCOPE_WHY) && scope.outOfScope(why)) problems.push(scope.SCOPE_WHY);
  if (problems.length) {
    const err = new Error("task_refused");
    err.problems = problems;
    throw err;
  }
  const dedupeKey = `${agent}:${normalize(instruction)}`;
  const existing = await CouncilTask.findOne({ dedupeKey, status: { $in: OPEN } }).lean();
  if (existing) return { task: existing, duplicate: true };
  const [openCount, todayCount] = await Promise.all([
    CouncilTask.countDocuments({ agent, status: { $in: OPEN } }),
    CouncilTask.countDocuments({ createdAt: { $gte: new Date(Date.now() - 864e5) } }),
  ]);
  if (openCount >= MAX_OPEN_PER_AGENT) {
    const err = new Error("task_refused");
    err.problems = [`${HERO[agent]} already has ${openCount} open tasks. Finish or cancel one first.`];
    throw err;
  }
  if (todayCount >= MAX_NEW_PER_DAY) {
    const err = new Error("task_refused");
    err.problems = [`The council already created ${todayCount} tasks in the last day (limit ${MAX_NEW_PER_DAY}).`];
    throw err;
  }
  const history =
    origin === "owner"
      ? [entry("received", ownerName, "The owner asked for this"), entry("assigned", "King Arthur", `Given to ${HERO[agent]}`)]
      : [entry("assigned", "King Arthur", `Given to ${HERO[agent]}`)];
  const task = await CouncilTask.create({
    agent,
    instruction: String(instruction).trim().slice(0, 800),
    why: String(why || "").trim().slice(0, 600),
    origin,
    status: "assigned",
    history,
    dedupeKey,
  });
  return { task: task.toObject(), duplicate: false };
}

const FOCUS_KEY = "team-focus";

/**
 * What the whole team is working toward this week, written by King Arthur
 * (set_team_focus) and read at the start of EVERY specialist shift - so the
 * three knights pull the same way between his reviews. Null when unset.
 */
async function teamFocus() {
  const AgentMemory = require("../../models/AgentMemory");
  const row = await AgentMemory.findOne({ agent: "arthur", key: FOCUS_KEY }).lean();
  return row?.content ? { text: row.content, at: row.updatedAt } : null;
}

async function setTeamFocus(text) {
  const AgentMemory = require("../../models/AgentMemory");
  const clean = String(text || "").trim();
  if (clean.length < 20) throw Object.assign(new Error("focus_refused"), { problems: ["Say the focus in a few sentences."] });
  if (clean.length > 900) throw Object.assign(new Error("focus_refused"), { problems: ["Keep the focus under 900 characters."] });
  const problems = validateGuidance(clean).filter((p) => !/under 1500 characters/.test(p));
  for (const rule of NEEDS_OWNER) if (rule.re.test(clean)) problems.push(rule.why);
  const scope = require("../growth/acquisitionScope");
  if (scope.outOfScope(clean)) problems.push(scope.SCOPE_WHY);
  if (problems.length) throw Object.assign(new Error("focus_refused"), { problems });
  await AgentMemory.updateOne({ agent: "arthur", key: FOCUS_KEY }, { $set: { content: clean } }, { upsert: true });
  return clean;
}

/**
 * Called by the runtime when a specialist's shift starts: King Arthur's
 * current focus, what the other knights are doing (so nobody duplicates or
 * contradicts them), and this knight's own open tasks - with the reason when
 * a task was sent back.
 */
async function pickUpTasks(agent, runId) {
  const [mine, others, focus] = await Promise.all([
    CouncilTask.find({ agent, status: "assigned" }).sort({ createdAt: 1 }).limit(MAX_PICKUP).lean(),
    CouncilTask.find({ agent: { $ne: agent, $in: SPECIALISTS }, status: { $in: OPEN } }).sort({ createdAt: 1 }).limit(10).lean(),
    teamFocus(),
  ]);
  const parts = [];
  if (focus) parts.push(`\n\nKING ARTHUR'S FOCUS FOR THE TEAM (set ${new Date(focus.at).toISOString().slice(0, 10)}): ${focus.text}\nLet it decide what you do first this shift.`);
  if (others.length) {
    parts.push(
      `\n\nWHAT THE OTHER KNIGHTS ARE ON (do not duplicate it; build on it where it helps your own work):\n${others
        .map((t) => `- ${HERO[t.agent]} (${t.status.replace("_", " ")}): ${t.instruction.slice(0, 200)}`)
        .join("\n")}`
    );
  }
  if (mine.length) {
    await CouncilTask.updateMany(
      { _id: { $in: mine.map((t) => t._id) }, status: "assigned" },
      { $set: { status: "in_progress", lastRun: runId }, $push: { history: entry("in_progress", HERO[agent], "Picked up in a shift") } }
    );
    const list = mine
      .map((t) => {
        const sentBack = t.verification?.verdict === "not_verified" ? `\n  SENT BACK after a check - fix this before reporting again: ${t.verification.note}` : "";
        return `- task_id ${t._id} (${t.origin === "owner" ? "the owner asked" : "King Arthur asked"}): ${t.instruction}${t.why ? `\n  Why: ${t.why}` : ""}${sentBack}`;
      })
      .join("\n");
    parts.push(
      `\n\nTASKS FROM KING ARTHUR (the owner's council manager). Do them in this shift where your tools and rules allow, alongside your normal review. For EACH task call report_to_arthur once: "completed" ONLY when the task's result is actually achieved, with the evidence (numbers, what you re-checked); "blocked" with why (a rule forbids it, you lack the data or tool, or it needs the owner). A draft waiting for the owner is "drafted", not a fixed problem - say so. Your fixed rules always win over a task - if one asks for something you may not do, report it blocked and say which rule.\n${list}`
    );
  }
  return parts.join("");
}

const MISSED_NOTE = "The shift ended without a report - waiting for the next shift";
const MAX_MISSED_SHIFTS = 2;
const MAX_FAILED_CHECKS = 3;
const countHistory = (t, test) => (t.history || []).filter(test).length;

/**
 * Called after the shift: anything picked up but not reported returns to
 * "assigned" - until it has slipped MAX_MISSED_SHIFTS shifts, when it becomes
 * "blocked" so King Arthur must deal with it instead of it looping quietly.
 */
async function releaseUnreported(agent, runId) {
  const rows = await CouncilTask.find({ agent, status: "in_progress", lastRun: runId }).lean();
  for (const t of rows) {
    const missed = countHistory(t, (h) => h.note === MISSED_NOTE) + 1;
    const stuck = missed >= MAX_MISSED_SHIFTS;
    await CouncilTask.updateOne(
      { _id: t._id, status: "in_progress" },
      stuck
        ? { $set: { status: "blocked", result: { summary: `${HERO[agent]} picked this up in ${missed} shifts without reporting on it.`, by: "system", at: new Date() } }, $push: { history: entry("blocked", "system", `${MISSED_NOTE.split(" - ")[0]} (${missed} shifts in a row) - back to King Arthur`) } }
        : { $set: { status: "assigned" }, $push: { history: entry("assigned", "system", MISSED_NOTE) } }
    );
  }
}

/** The specialist's report (tool report_to_arthur). Only its own task, only while in progress. */
async function reportTask({ taskId, agent, runId, status, summary }) {
  if (!mongoose.Types.ObjectId.isValid(taskId)) throw new Error("bad task_id");
  if (!["completed", "blocked"].includes(status)) throw new Error("status must be completed or blocked");
  const text = String(summary || "").trim();
  if (text.length < 10) throw new Error("Say what you found or did (at least a sentence).");
  const task = await CouncilTask.findOneAndUpdate(
    { _id: taskId, agent, status: "in_progress", lastRun: runId },
    {
      $set: { status, result: { summary: text.slice(0, 2000), by: HERO[agent], at: new Date() } },
      $push: { history: entry(status, HERO[agent], text.slice(0, 200)) },
    },
    { new: true }
  ).lean();
  if (!task) throw new Error("No task of yours with that id is in progress in this shift.");
  return { id: String(task._id), status: task.status };
}

/**
 * Arthur's or the owner's check of a completed task.
 * "not_verified" SENDS IT BACK: the task returns to the specialist with the
 * reason (it is not finished, so it must not look finished). After
 * MAX_FAILED_CHECKS failed checks it becomes "blocked" for Arthur to rethink.
 */
async function verifyTask({ taskId, verdict, note, by }) {
  if (!mongoose.Types.ObjectId.isValid(taskId)) throw new Error("bad task_id");
  if (!["verified", "not_verified"].includes(verdict)) throw new Error("verdict must be verified or not_verified");
  const current = await CouncilTask.findOne({ _id: taskId, status: "completed" }).lean();
  if (!current) throw new Error("Only a task the specialist reported as completed can be checked.");
  const verification = { verdict, note: String(note || "").slice(0, 800), by, at: new Date() };
  let update;
  if (verdict === "verified") {
    update = { $set: { status: "verified", verification }, $push: { history: entry("verified", by, note) } };
  } else {
    const failed = countHistory(current, (h) => h.status === "not_verified") + 1;
    const giveUp = failed >= MAX_FAILED_CHECKS;
    const back = giveUp
      ? entry("blocked", "system", `Failed the check ${failed} times - back to King Arthur to rethink or cancel`)
      : entry("assigned", "system", `Sent back to ${HERO[current.agent]}: ${String(note || "").slice(0, 200)}`);
    update = { $set: { status: giveUp ? "blocked" : "assigned", verification }, $push: { history: { $each: [entry("not_verified", by, note), back] } } };
  }
  const task = await CouncilTask.findOneAndUpdate({ _id: taskId, status: "completed" }, update, { new: true }).lean();
  if (!task) throw new Error("Only a task the specialist reported as completed can be checked.");
  return task;
}

/** The owner may cancel any open task; Arthur only the ones he started himself. */
async function cancelTask({ taskId, by, asOwner, note = "" }) {
  if (!mongoose.Types.ObjectId.isValid(taskId)) throw new Error("bad task_id");
  const filter = { _id: taskId, status: { $in: OPEN } };
  if (!asOwner) filter.origin = "arthur";
  const task = await CouncilTask.findOneAndUpdate(
    filter,
    { $set: { status: "cancelled" }, $push: { history: entry("cancelled", by, note) } },
    { new: true }
  ).lean();
  if (!task) throw new Error(asOwner ? "No open task with that id." : "Arthur can only cancel open tasks he started himself - the owner's requests stay until the owner cancels them.");
  return task;
}

function publicTask(t) {
  return {
    id: String(t._id),
    agent: t.agent,
    hero: HERO[t.agent] || t.agent,
    instruction: t.instruction,
    why: t.why || "",
    origin: t.origin,
    status: t.status,
    result: t.result?.summary ? { summary: t.result.summary, at: t.result.at } : null,
    verification: t.verification?.verdict ? { verdict: t.verification.verdict, note: t.verification.note, by: t.verification.by, at: t.verification.at } : null,
    history: (t.history || []).map((h) => ({ at: h.at, status: h.status, by: h.by, note: h.note })),
    archive: t.archive?.at ? t.archive : null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

module.exports = {
  HERO,
  MAX_FAILED_CHECKS,
  MAX_MISSED_SHIFTS,
  setTeamFocus,
  teamFocus,
  MAX_NEW_PER_DAY,
  MAX_OPEN_PER_AGENT,
  NEEDS_OWNER,
  OPEN,
  SPECIALISTS,
  assignTask,
  cancelTask,
  pickUpTasks,
  publicTask,
  releaseUnreported,
  reportTask,
  taskProblems,
  verifyTask,
};
