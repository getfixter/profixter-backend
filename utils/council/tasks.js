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

/** Called by the runtime when a specialist's shift starts: hand it its open tasks. */
async function pickUpTasks(agent, runId) {
  const tasks = await CouncilTask.find({ agent, status: "assigned" }).sort({ createdAt: 1 }).limit(MAX_PICKUP).lean();
  if (!tasks.length) return "";
  await CouncilTask.updateMany(
    { _id: { $in: tasks.map((t) => t._id) }, status: "assigned" },
    { $set: { status: "in_progress", lastRun: runId }, $push: { history: entry("in_progress", HERO[agent], "Picked up in a shift") } }
  );
  const list = tasks
    .map((t) => `- task_id ${t._id} (${t.origin === "owner" ? "the owner asked" : "King Arthur asked"}): ${t.instruction}${t.why ? `\n  Why: ${t.why}` : ""}`)
    .join("\n");
  return `\n\nTASKS FROM KING ARTHUR (the owner's council manager). Do them in this shift where your tools and rules allow, alongside your normal review. For EACH task call report_to_arthur once: "completed" with what you found or did (evidence, numbers), or "blocked" with why (a rule forbids it, you lack the data or tool). Your fixed rules always win over a task - if one asks for something you may not do, report it blocked and say which rule.\n${list}`;
}

/** Called after the shift: anything picked up but not reported returns to "assigned". */
async function releaseUnreported(agent, runId) {
  await CouncilTask.updateMany(
    { agent, status: "in_progress", lastRun: runId },
    { $set: { status: "assigned" }, $push: { history: entry("assigned", "system", "The shift ended without a report - waiting for the next shift") } }
  );
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

/** Arthur's or the owner's check of a completed task. */
async function verifyTask({ taskId, verdict, note, by }) {
  if (!mongoose.Types.ObjectId.isValid(taskId)) throw new Error("bad task_id");
  if (!["verified", "not_verified"].includes(verdict)) throw new Error("verdict must be verified or not_verified");
  const task = await CouncilTask.findOneAndUpdate(
    { _id: taskId, status: "completed" },
    {
      $set: { status: verdict, verification: { verdict, note: String(note || "").slice(0, 800), by, at: new Date() } },
      $push: { history: entry(verdict, by, note) },
    },
    { new: true }
  ).lean();
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
