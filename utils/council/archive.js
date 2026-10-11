const mongoose = require("mongoose");
const AgentFinding = require("../../models/AgentFinding");
const { CouncilDecision, CouncilTask } = require("../../models/Council");
const { BUSINESS_RE } = require("./refocus");

/**
 * Council housekeeping: King Arthur archives outdated, irrelevant or duplicate
 * work on his own - and nothing is ever deleted.
 *
 * WHAT HE MAY ARCHIVE (checked here, in code):
 *   task    a council task that is not being worked on right now (received,
 *           assigned, blocked, completed-but-unchecked). A task the OWNER asked
 *           for is never archived by Arthur: he files an archive request and
 *           the owner confirms it (resolveDecision).
 *   note    an open specialist note (opportunity, risk, anomaly, experiment,
 *           insight). Drafts and approval items are the owner's decisions and
 *           cannot be archived.
 *   record  one of his own open council records (an info note, a decision
 *           record, his own guidance proposal).
 *
 * WHY - one of three reasons, each with a check so that ACTIVE MARKETING
 * WORK cannot be archived just to tidy the dashboard:
 *   business_management  the item is about revenue, billing, memberships,
 *                        cancellations, prices or scheduling - outside the
 *                        Kingdom's marketing mission (refocus.BUSINESS_RE)
 *   duplicate            it repeats another OPEN item of the same kind,
 *                        named in duplicate_of (which must exist and be open)
 *   stale                untouched for 30+ days
 *
 * EVERY ARCHIVE keeps the item and records who, when, why, the category and
 * the state it was in; it stays visible in the chamber's history, and the
 * owner restores it with one tap (restoreItem). At most 30 archives a day.
 */
const KINDS = ["task", "note", "record"];
const CATEGORIES = ["business_management", "duplicate", "stale"];
const STALE_DAYS = 30;
const MAX_PER_DAY = 30;
const NOTE_KINDS = ["opportunity", "risk", "anomaly", "experiment", "insight"];
const TASK_ARCHIVABLE = ["received", "assigned", "blocked", "completed"];

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function textOf(kind, doc) {
  if (kind === "task") return `${doc.instruction} ${doc.why || ""}`;
  if (kind === "note") return `${doc.title} ${doc.detail || ""} ${doc.plain || ""}`;
  return `${doc.subject} ${doc.simple || ""} ${doc.detail || ""}`;
}

async function load(kind, id) {
  if (!mongoose.Types.ObjectId.isValid(id)) throw fail("bad id");
  if (kind === "task") return CouncilTask.findById(id).lean();
  if (kind === "note") return AgentFinding.findById(id).lean();
  if (kind === "record") return CouncilDecision.findById(id).lean();
  throw fail("kind must be task, note or record");
}

function archivable(kind, doc) {
  if (!doc) return "No such item.";
  if (kind === "task") {
    if (doc.status === "in_progress") return "A hero is working on this task right now - it cannot be archived.";
    if (!TASK_ARCHIVABLE.includes(doc.status)) return `This task is already ${doc.status}.`;
  }
  if (kind === "note") {
    if (doc.status !== "open") return `This note is already ${doc.status}.`;
    if (!NOTE_KINDS.includes(doc.kind)) return "Drafts and approval items are the owner's decisions - recommend instead of archiving.";
  }
  if (kind === "record") {
    if (doc.status !== "open") return `This record is already ${doc.status}.`;
  }
  return null;
}

async function checkReason(kind, doc, { category, duplicateOf }) {
  if (!CATEGORIES.includes(category)) return `category must be one of ${CATEGORIES.join(", ")}`;
  if (category === "business_management" && !BUSINESS_RE.test(textOf(kind, doc))) {
    return "This item is not about revenue, billing, memberships, cancellations, prices or scheduling - it may be active marketing work. Do not archive it to tidy up.";
  }
  if (category === "duplicate") {
    if (!duplicateOf || String(duplicateOf) === String(doc._id)) return "Name the other open item it duplicates (duplicate_of).";
    const other = await load(kind, duplicateOf).catch(() => null);
    const open = other && (kind === "task" ? [...TASK_ARCHIVABLE, "in_progress"].includes(other.status) : other.status === "open");
    if (!open) return "duplicate_of must be another OPEN item of the same kind - the one that is kept.";
  }
  if (category === "stale" && Date.now() - new Date(doc.updatedAt || doc.createdAt).getTime() < STALE_DAYS * 864e5) {
    return `Only items untouched for ${STALE_DAYS}+ days are stale.`;
  }
  return null;
}

async function archivedToday() {
  const since = new Date(Date.now() - 864e5);
  const q = { "archive.at": { $gte: since }, "archive.by": "King Arthur" };
  const [a, b, c] = await Promise.all([CouncilTask.countDocuments(q), AgentFinding.countDocuments(q), CouncilDecision.countDocuments(q)]);
  return a + b + c;
}

/** Archive one item (no deletion). Returns { archived } or { requested } for the owner's own tasks. */
async function archiveItem({ kind, id, reason, category, duplicateOf = null, by = "King Arthur", asOwner = false }) {
  if (!KINDS.includes(kind)) throw fail("kind must be task, note or record");
  const why = String(reason || "").trim();
  if (why.length < 10) throw fail("Give a real reason (at least a sentence).");
  const doc = await load(kind, id);
  const blocked = archivable(kind, doc);
  if (blocked) throw fail(blocked, 409);
  if (!asOwner) {
    const bad = await checkReason(kind, doc, { category, duplicateOf });
    if (bad) throw fail(bad);
    if ((await archivedToday()) >= MAX_PER_DAY) throw fail(`Already ${MAX_PER_DAY} archives in the last day - the rest can wait.`, 429);
    // The owner's own requests are the owner's: Arthur asks.
    if (kind === "task" && doc.origin === "owner") {
      const dedupeKey = `archive-request:task:${doc._id}`;
      const existing = await CouncilDecision.findOne({ dedupeKey, status: "open" }).lean();
      if (existing) return { requested: true, decisionId: String(existing._id), duplicate: true };
      const d = await CouncilDecision.create({
        category: "decision",
        subject: `Archive your task "${String(doc.instruction).slice(0, 90)}"?`,
        simple: `Boss, you asked for this task, so I need your OK to archive it. Reason: ${why.slice(0, 300)}`,
        detail: `Task ${doc._id} (${doc.status}) for ${doc.agent}: ${doc.instruction}\nCategory: ${category}${duplicateOf ? ` (duplicate of ${duplicateOf})` : ""}\nArchiving keeps it in history; it can be restored.`,
        agent: doc.agent,
        recommendation: { choice: "confirm", reason: why.slice(0, 600) },
        refs: [],
        payload: { type: "archive_request", kind: "task", id: String(doc._id), reason: why.slice(0, 600), category, duplicateOf: duplicateOf ? String(duplicateOf) : null },
        dedupeKey,
      });
      return { requested: true, decisionId: String(d._id) };
    }
  }
  const archive = { by, at: new Date(), reason: why.slice(0, 600), category: asOwner ? category || "owner" : category, previousStatus: doc.status };
  const note = `Archived (${archive.category}): ${archive.reason}`;
  if (kind === "task") {
    await CouncilTask.updateOne(
      { _id: doc._id, status: doc.status },
      { $set: { status: "archived", archive }, $push: { history: { at: archive.at, status: "archived", by, note: note.slice(0, 300) } } }
    );
  } else if (kind === "note") {
    await AgentFinding.updateOne({ _id: doc._id, status: "open" }, { $set: { status: "archived", archive, statusBy: by, statusNote: note.slice(0, 500) } });
  } else {
    await CouncilDecision.updateOne({ _id: doc._id, status: "open" }, { $set: { status: "archived", archive, resolution: { choice: "archived", by, at: archive.at, note: archive.reason } } });
  }
  return { archived: true, kind, id: String(doc._id), previousStatus: doc.status };
}

/** The owner restores an archived item to the state it was in. */
async function restoreItem({ kind, id, by }) {
  if (!KINDS.includes(kind)) throw fail("kind must be task, note or record");
  const doc = await load(kind, id);
  if (!doc || doc.status !== "archived") throw fail("That item is not archived.", 404);
  const back = doc.archive?.previousStatus || (kind === "task" ? "assigned" : "open");
  const at = new Date();
  const set = { status: back, "archive.restoredBy": by, "archive.restoredAt": at };
  if (kind === "task") await CouncilTask.updateOne({ _id: doc._id, status: "archived" }, { $set: set, $push: { history: { at, status: back, by, note: "Restored from the archive" } } });
  else if (kind === "note") await AgentFinding.updateOne({ _id: doc._id, status: "archived" }, { $set: { ...set, statusBy: by, statusNote: "Restored from the archive" } });
  else await CouncilDecision.updateOne({ _id: doc._id, status: "archived" }, { $set: { ...set, resolution: null } });
  return { restored: true, kind, id: String(doc._id), status: back };
}

/** Everything archived in the last N days, newest first - for the chamber's history. */
async function archivedList({ days = 60 } = {}) {
  const since = new Date(Date.now() - days * 864e5);
  const q = { status: "archived", "archive.at": { $gte: since } };
  const [tasks, notes, records] = await Promise.all([
    CouncilTask.find(q).sort({ "archive.at": -1 }).limit(100).lean(),
    AgentFinding.find(q).sort({ "archive.at": -1 }).limit(100).lean(),
    CouncilDecision.find(q).sort({ "archive.at": -1 }).limit(100).lean(),
  ]);
  const row = (kind, d, title) => ({ kind, id: String(d._id), title: String(title || "").slice(0, 200), archive: d.archive || null });
  return [...tasks.map((t) => row("task", t, t.instruction)), ...notes.map((n) => row("note", n, n.title)), ...records.map((r) => row("record", r, r.subject))].sort(
    (a, b) => new Date(b.archive?.at || 0) - new Date(a.archive?.at || 0)
  );
}

module.exports = { CATEGORIES, MAX_PER_DAY, STALE_DAYS, archiveItem, archivedList, restoreItem };
