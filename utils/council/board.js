const { CouncilDecision } = require("../../models/Council");
const tasks = require("./tasks");

/**
 * THE DECISIONS BOARD - the single source of truth for what the owner sees in
 * King Arthur's Decisions tab AND for everything copied from it.
 *
 * One function decides the sections, the order and the numbers; the screen
 * only displays it, and "Copy All for ChatGPT", "Copy full status report" and
 * every individual "Copy" are built from the very same board, in the very
 * same order, with the very same numbers. Decision #1 on screen is #1 in
 * ChatGPT. (Before, the screen and the report were built from two different
 * lists with different sort rules.)
 *
 * SECTIONS, in this order:
 *   needs_you        what needs the owner now: decisions first, then
 *                    "good to know" notes; ONLY decisions count toward the badge
 *   being_worked_on  waiting for a knight, the owner's "remind me", or
 *                    King Arthur reviewing a knight's finished work
 *   history          decided, handled, dismissed or archived (last 14 days)
 *
 * ORDER inside a section is fixed and deterministic:
 *   needs_you / being_worked_on: by when the item ENTERED that state (oldest
 *     first), then by record id - so a new item is added at the end and the
 *     numbers above it do not move
 *   history: most recently closed first, then by record id
 *
 * NUMBERS run 1..N without gaps from the top of the board to the bottom and
 * are recomputed on every read, so after any change (acknowledged, deferred,
 * restored, a new item) the screen and every later copy agree. The record id
 * never changes and is shown and copied beside the number.
 */
const HISTORY_DAYS = 14;
const HISTORY_LIMIT = 30;
const PARKED = ["waiting", "review"];

const SECTION_TITLES = {
  needs_you: "Needs your decision",
  being_worked_on: "Being worked on",
  history: "Completed and history",
};

const CHOICE_WORDS = {
  approve: "Approve it",
  decline: "Decline it",
  ask_for_changes: "Ask for changes first",
  wait: "Wait for now",
  acknowledge: "Just note it",
  dismiss: "Dismiss it",
  confirm: "Confirm it",
  see_reason: "See his reasoning",
};

const RESOLUTION_WORDS = {
  confirmed: "you said yes",
  rejected: "you said no / dismissed",
  handled: "handled",
  archived: "archived",
  merged: "merged as a duplicate",
  decided_elsewhere: "decided in Requests",
  replaced: "replaced by a newer proposal",
};

function enteredAt(d) {
  const moves = d.inboxHistory || [];
  const target = d.inbox === "needs_you" || !d.inbox ? "needs_you" : null;
  if (target) {
    const last = [...moves].reverse().find((h) => h.to === "needs_you");
    return new Date(last?.at || d.createdAt);
  }
  return new Date(d.waiting?.since || [...moves].reverse().find((h) => PARKED.includes(h.to))?.at || d.createdAt);
}

function closedAt(d) {
  return new Date(d.resolution?.at || d.archive?.at || d.updatedAt);
}

function byThenId(key, dir = 1) {
  return (a, b) => (key(a) - key(b)) * dir || String(a._id).localeCompare(String(b._id));
}

function typeLabel(d) {
  if (d.payload?.type === "guidance") return "Guidance change (King Arthur's proposal)";
  if (d.payload?.type === "archive_request") return "Archive request (a task you asked for)";
  if (d.category === "info") return "Good to know";
  if (d.category === "uncertain") return "Unclear - King Arthur needs facts or your view";
  return "Needs your decision";
}

function statusLabel(d, section) {
  if (section === "history") {
    const r = d.resolution?.choice;
    return `Closed - ${RESOLUTION_WORDS[r] || r || d.status}${d.resolution?.by ? ` (${d.resolution.by})` : ""}`;
  }
  if (section === "being_worked_on") {
    if (d.inbox === "review") return "Being worked on - the knight finished; King Arthur is reviewing it";
    if (d.waiting?.kind === "owner") return "Being worked on - you asked to be reminded when it is ready";
    return `Being worked on - ${d.waiting?.reason || "a knight is revising it"}`;
  }
  return d.category === "info" ? "Needs you - just acknowledge" : "Needs your decision now";
}

/** The board: sections in order, every item numbered 1..N from top to bottom. */
async function decisionBoard({ now = new Date() } = {}) {
  const { settleDecisions } = require("./arthur");
  await settleDecisions();
  await require("./inbox").sweep({ now });
  const since = new Date(now - HISTORY_DAYS * 864e5);
  const [open, closed] = await Promise.all([
    CouncilDecision.find({ status: "open" }).lean(),
    CouncilDecision.find({ status: { $ne: "open" }, updatedAt: { $gte: since }, category: { $ne: "routine" } }).lean(),
  ]);
  const parked = (d) => PARKED.includes(d.inbox);
  const needsDecisions = open.filter((d) => !parked(d) && d.category !== "info").sort(byThenId(enteredAt));
  const needsInfo = open.filter((d) => !parked(d) && d.category === "info").sort(byThenId(enteredAt));
  const working = open.filter(parked).sort(byThenId(enteredAt));
  const history = closed.sort(byThenId(closedAt, -1)).slice(0, HISTORY_LIMIT);

  let n = 0;
  const item = (d, section) => ({
    number: ++n,
    id: String(d._id),
    section,
    sectionTitle: SECTION_TITLES[section],
    type: typeLabel(d),
    status: statusLabel(d, section),
    category: d.category,
    subject: d.subject,
    simple: d.simple || "",
    detail: d.detail || "",
    agent: d.agent || null,
    hero: d.agent ? tasks.HERO[d.agent] || d.agent : null,
    recommendation: d.recommendation?.choice ? d.recommendation : null,
    refs: (d.refs || []).map((r) => ({ kind: r.kind, id: r.id })),
    guidance: d.payload?.type === "guidance" ? { agent: d.payload.agent, text: d.payload.guidance, previous: d.payload.previous, baseVersion: d.payload.baseVersion } : null,
    archiveRequest: d.payload?.type === "archive_request" ? { kind: d.payload.kind, id: d.payload.id, reason: d.payload.reason, category: d.payload.category } : null,
    inbox: d.inbox || "needs_you",
    waiting: d.waiting?.since ? { kind: d.waiting.kind, reason: d.waiting.reason, taskId: d.waiting.taskId, since: d.waiting.since, until: d.waiting.until } : null,
    inboxHistory: (d.inboxHistory || []).slice(-10),
    recordStatus: d.status,
    resolution: d.resolution?.choice ? d.resolution : null,
    archive: d.archive?.at ? d.archive : null,
    createdAt: d.createdAt,
    at: section === "history" ? closedAt(d) : enteredAt(d),
  });
  const sections = [
    { key: "needs_you", title: SECTION_TITLES.needs_you, items: [...needsDecisions.map((d) => item(d, "needs_you")), ...needsInfo.map((d) => item(d, "needs_you"))] },
    { key: "being_worked_on", title: SECTION_TITLES.being_worked_on, items: working.map((d) => item(d, "being_worked_on")) },
    { key: "history", title: SECTION_TITLES.history, items: history.map((d) => item(d, "history")) },
  ];
  // the brief for each item is built from the board itself, so a copy always matches the screen
  const enrich = await approvalFacts(sections.flatMap((s) => s.items));
  const { redact } = require("../growth/explain");
  for (const s of sections) {
    for (const it of s.items) {
      it.brief = redact(itemBrief(it, enrich));
      // the per-item "Copy for ChatGPT": the same text as in the full report, plus the question
      it.copy = `${it.brief}\n\nThis is decision #${it.number} (record ${it.id}) on King Arthur's Decisions tab, in the "${it.sectionTitle}" section. King Arthur is my AI marketing director; his recommendation is not my approval. Please explain it in simple English, point out problems, and recommend what I should do. Do not assume I approve anything.`;
    }
  }
  return {
    generatedAt: now,
    sections,
    counts: {
      badge: needsDecisions.length, // only decisions that need the owner now
      needsYou: needsDecisions.length + needsInfo.length,
      decisions: needsDecisions.length,
      info: needsInfo.length,
      beingWorkedOn: working.length,
      history: history.length,
    },
  };
}

/** Exact changes, risk and reversibility for items that point at a pending approval (from Requests). */
async function approvalFacts(items) {
  if (!items.some((i) => i.refs.length)) return new Map();
  const { approvalsList } = require("../growth/office");
  const { items: pending, notes } = await approvalsList();
  return new Map([...pending, ...notes].map((x) => [`${x.kind}:${x.id}`, x]));
}

function ny(d) {
  if (!d) return "unknown";
  const t = new Date(d);
  return `${t.toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" })} (New York) · ${t.toISOString()}`;
}

/** One decision as text - the same words in the per-item Copy and in the full reports. */
function itemBrief(it, enrich = new Map()) {
  const ref = it.refs[0];
  const facts = ref ? enrich.get(`${ref.kind}:${ref.id}`) : null;
  const L = [];
  const add = (label, v) => {
    const s = String(v ?? "").trim();
    if (s) L.push(`- ${label}: ${s}`);
  };
  L.push(`### Decision #${it.number}: ${it.subject}`);
  add("Record ID", it.id);
  add("Section", it.sectionTitle);
  add("Status", it.status);
  add("Type", it.type);
  if (it.hero) add("Concerns", it.hero);
  add("Raised", ny(it.createdAt));
  add(it.section === "history" ? "Closed" : "In this section since", ny(it.at));
  add("In King Arthur's words", it.simple);
  if (it.recommendation) add("King Arthur's recommendation (not my approval)", `${CHOICE_WORDS[it.recommendation.choice] || it.recommendation.choice}. ${it.recommendation.reason || ""}`);
  if (it.detail && it.detail !== it.recommendation?.reason) add("Details and evidence", it.detail);
  if (ref) add("About", `${ref.kind} ${ref.id}${facts ? ` - ${facts.title}` : ""}`);
  if (facts?.risk) add("Risk (system rating)", facts.risk);
  const actionFacts = facts?.type ? require("../growth/explain").ACTION_FACTS[facts.type] : null;
  if (actionFacts) {
    add("What it does", actionFacts.what);
    add("What approving does", actionFacts.ifApproved);
    add("Reversible?", actionFacts.reversible);
  }
  if (facts?.preview) L.push(`- Exact change / text:\n${String(facts.preview).split("\n").map((l) => `    ${l}`).join("\n")}`);
  if (it.guidance) L.push(`- Exact change (guidance version ${it.guidance.baseVersion} -> ${it.guidance.baseVersion + 1}):\n    BEFORE: ${it.guidance.previous || "(no guidance)"}\n    AFTER:  ${it.guidance.text}`);
  if (it.archiveRequest) add("Archive request", `${it.archiveRequest.kind} ${it.archiveRequest.id} - ${it.archiveRequest.reason}`);
  if (it.waiting?.until && it.section === "being_worked_on") add("Comes back to me by", ny(it.waiting.until));
  if (it.section === "needs_you") add("Cost", "This record spends nothing; any approval follows the existing rules.");
  return L.join("\n");
}

module.exports = { SECTION_TITLES, decisionBoard, itemBrief };
