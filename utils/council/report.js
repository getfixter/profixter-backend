const { CouncilMessage, CouncilTask } = require("../../models/Council");
const AgentRun = require("../../models/AgentRun");
const explain = require("../growth/explain");
const tasks = require("./tasks");
const { correctedRun } = require("../agents/claims");
const { decisionBoard } = require("./board");

/**
 * "Copy All for ChatGPT" and "Copy full status report".
 *
 * Both are built from THE DECISIONS BOARD (board.js) - the same sections, the
 * same order and the same numbers the owner sees in King Arthur's Decisions
 * tab, from top to bottom: "Decision #1" on screen is "Decision #1" here, each
 * with its permanent record id. No second list, no second sort.
 *
 * Deterministic, from records only - no AI call, nothing invented - and
 * redacted (no credentials, emails, phone numbers, street addresses or
 * homeowner names). Always ends with the owner's fixed closing request.
 * scope "full" adds the council's status after the board.
 */
const CLOSING =
  "Please review all the decisions above. Explain them in simple English, identify potential problems, and recommend what I should do for each. Do not assume I approve anything.";

function ny(d) {
  return d ? `${explain.nyTime(d)} · ${new Date(d).toISOString()}` : "unknown";
}

function field(label, value) {
  const v = String(value ?? "").trim();
  return v ? `- ${label}: ${v}` : null;
}

function block(lines) {
  return lines.filter(Boolean).join("\n");
}

/** The board as text: the three sections in screen order, every decision under its screen number. */
function boardText(board) {
  return board.sections
    .map((sec) => {
      const head = `## ${sec.title} (${sec.items.length})`;
      if (!sec.items.length) return `${head}\n${sec.key === "needs_you" ? "Nothing needs my decision right now." : "None."}`;
      return [head, ...sec.items.map((it) => it.brief)].join("\n\n");
    })
    .join("\n\n");
}

async function statusSection() {
  const { councilState } = require("./arthur");
  const s = await councilState();
  const r = s.results || {};
  const ffv = r.firstFreeVisits || {};
  const lines = [
    "## Council status",
    block([
      field("AI agents", s.switches.agentsEnabled ? "on" : "off"),
      field("Automatic website changes engine", s.switches.changesEngineOn ? "on (still asks me where required)" : "off (watch-only)"),
      field("Live replies to homeowners", s.switches.liveRepliesOn ? "on" : "off"),
      field("First free visits booked", Object.keys(ffv).length ? JSON.stringify(ffv) : "not available"),
      field("Last first free visit", r.lastFirstFreeVisitAt ? ny(r.lastFirstFreeVisitAt) : "unknown"),
      field("Website visitors (30 days)", r.visitors30),
      field("Registrations (30 days)", r.registrations30),
      field("Google search (window)", r.search ? `${r.search.clicks ?? "?"} clicks, ${r.search.impressions ?? "?"} impressions over ${r.search.windowDays} days` : "not available"),
      field("AI cost", r.aiCost ? `today $${(r.aiCost.todayCents / 100).toFixed(2)} of $${(r.aiCost.dailyCapCents / 100).toFixed(2)}; this month $${(r.aiCost.monthCents / 100).toFixed(2)} of $${(r.aiCost.monthlyCapCents / 100).toFixed(2)}` : null),
    ]),
    "",
    "## The heroes",
    ...s.heroes.map((h) =>
      block([
        `### ${h.hero}`,
        field("Status", h.statusText),
        field("Waiting for me", h.waitingForOwner),
        field("Next shift", h.nextShift),
        h.lastShift ? field("Last shift", `${ny(h.lastShift.at)} - ${h.lastShift.status}: ${h.lastShift.summary}`) : null,
      ])
    ),
  ];
  const taskRows = await CouncilTask.find({}).sort({ updatedAt: -1 }).limit(20).lean();
  lines.push("", "## Tasks (newest first)");
  lines.push(
    taskRows.length
      ? taskRows
          .map((t) => {
            const p = tasks.publicTask(t);
            return block([
              `### ${p.hero}: ${p.instruction}`,
              field("Task ID", p.id),
              field("Asked by", p.origin === "owner" ? "me (through King Arthur)" : "King Arthur"),
              field("State", p.status),
              field("History", p.history.map((h) => `${h.status} by ${h.by} (${ny(h.at)})${h.note ? ` - ${h.note}` : ""}`).join("; ")),
              p.result ? field("Specialist's report", p.result.summary) : null,
              p.verification ? field("Check", `${p.verification.verdict} by ${p.verification.by}: ${p.verification.note}`) : null,
            ]);
          })
          .join("\n\n")
      : "No tasks yet."
  );
  const runs = await AgentRun.find({ startedAt: { $gte: new Date(Date.now() - 14 * 864e5) } }).sort({ startedAt: -1 }).limit(15).lean();
  const { heroOf } = require("./arthur");
  lines.push("", "## Recent shifts (14 days)");
  lines.push(
    runs.length
      ? runs.map((r) => ({ ...r, ...correctedRun(r) })).map((x) => `- ${ny(x.startedAt)} · ${x.agent === "arthur" ? "King Arthur" : heroOf(x.agent)} · ${x.status}${x.skipReason ? ` (${x.skipReason})` : ""} · $${((x.costCents || 0) / 100).toFixed(2)} · run ${x._id}${x.plainSummary || x.summary ? `\n  ${String(x.plainSummary || x.summary).replace(/\s+/g, " ").slice(0, 400)}` : ""}`).join("\n")
      : "No shifts in the last 14 days."
  );
  const chat = await CouncilMessage.find({}).sort({ createdAt: -1 }).limit(8).lean();
  if (chat.length) {
    lines.push("", "## Last messages between me and King Arthur");
    lines.push(chat.reverse().map((m) => `- ${ny(m.createdAt)} · ${m.role === "owner" ? "Me" : "King Arthur"}: ${String(m.text).replace(/\s+/g, " ").slice(0, 500)}`).join("\n"));
  }
  return lines.join("\n");
}

/** The whole report as text. scope: "pending" (decisions only) or "full" (decisions + status). */
/** board: pass the board already shown (GET /office/council) so the copy is built from that exact board. */
async function buildReport({ scope = "pending", now = new Date(), board: given = null } = {}) {
  const board = given || (await decisionBoard({ now }));
  const head = [
    `# Profixter AI council - ${scope === "full" ? "full status report" : "King Arthur's decisions"}`,
    `Generated ${ny(now)} from the system's records (nothing in this report was written by AI except where it quotes an agent).`,
    "The decisions below are in exactly the order and numbering of King Arthur's Decisions tab on my screen. Refer to them by their number (and record ID).",
    "",
    explain.CONTEXT,
    "",
    "## Who is who",
    "- King Arthur: my AI marketing director. He coordinates the knights, reviews their drafts, assigns tasks and recommends. He cannot approve, send messages, spend money, publish, book visits, change ads, prices, offers or permissions. His recommendation is never my approval.",
    "- Odysseus: organic search & visibility (Google, Google Business Profile, local SEO, AI search, Yelp and other directories).",
    "- Leonidas: organic social & community (Instagram and Facebook posts, local communities; no paid ads, no mail, no cold lists).",
    "- Marcus: customer re-engagement (consent-compliant follow-ups for free visits that did not join, registrations that never booked, past members).",
    "",
    `Summary: ${board.counts.decisions} decision(s) and ${board.counts.info} note(s) need me now; ${board.counts.beingWorkedOn} being worked on; ${board.counts.history} completed in the last 14 days.`,
  ];
  const parts = [...head, "", boardText(board)];
  if (scope === "full") parts.push("", await statusSection());
  parts.push("", "## My request", CLOSING);
  return {
    text: explain.redact(parts.join("\n")),
    count: board.counts.needsYou,
    waiting: board.counts.beingWorkedOn,
    order: board.sections.flatMap((sec) => sec.items.map((it) => ({ number: it.number, id: it.id, section: sec.key }))),
    generatedAt: now,
  };
}

module.exports = { CLOSING, boardText, buildReport };
