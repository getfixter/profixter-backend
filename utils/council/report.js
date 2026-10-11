const { CouncilDecision, CouncilMessage, CouncilTask } = require("../../models/Council");
const AgentRun = require("../../models/AgentRun");
const explain = require("../growth/explain");
const tasks = require("./tasks");
const { correctedRun } = require("../agents/claims");

/**
 * "Copy All for ChatGPT": one plain-text report the owner pastes into ChatGPT.
 *
 * Built deterministically from records - no AI call, nothing invented. Every
 * item waiting for the owner, with: who proposed it, King Arthur's
 * recommendation (or that he has not reviewed it), the evidence, cost and
 * risk, the owner's choices, what approving does, the exact change, and the
 * timestamps and ids. scope "full" adds the council's status. Everything
 * passes through explain.redact (no credentials, emails, phone numbers,
 * street addresses or homeowner names), and the report always ends with the
 * owner's fixed closing request.
 */
const CLOSING =
  "Please review all the decisions above. Explain them in simple English, identify potential problems, and recommend what I should do for each. Do not assume I approve anything.";

const CHOICE_WORDS = {
  approve: "Approve it",
  decline: "Decline it",
  ask_for_changes: "Ask for changes first",
  wait: "Wait - decide later",
  acknowledge: "Acknowledge it (noted, no action)",
  dismiss: "Dismiss it",
  confirm: "Confirm it",
  see_reason: "See his reasoning",
};

const KIND_FACTS = {
  playbook: {
    what: "Approve the WORDING of a follow-up email. Approved emails may then be sent one person at a time to people in its audience who agreed to get our emails.",
    choices: 'Approve the wording ("Yes, use it") · Retire it ("Not now") · More details',
    ifApproved: "The wording becomes usable by the growth engine; sending is still limited by consent, frequency limits and the engine's trust level.",
    reversible: "The wording can be retired any time; emails already sent cannot be unsent.",
  },
  draft: {
    what: "A draft (page, guide, post or wording) for review. Nothing is published automatically.",
    choices: 'Use it (I publish it myself) · Not now (dismiss) · More details',
    ifApproved: "Nothing is published by the AI. Marking it used only closes the item; publishing is done by a person.",
    reversible: "Yes - nothing changes until a person publishes it.",
  },
  note: {
    what: "A note from a specialist: an opportunity, risk or unusual pattern worth knowing.",
    choices: "Acknowledge (noted) · Dismiss · Ask King Arthur to have it investigated",
    ifApproved: "Acknowledging only records that I saw it. Nothing runs.",
    reversible: "Yes.",
  },
  guidance: {
    what: "New standing guidance for a specialist, proposed by King Arthur. It steers focus and priorities in the specialist's next shifts; it cannot change fixed rules.",
    choices: "Confirm (save as a new version) · Reject",
    ifApproved: "It is saved as a new, numbered guidance version the specialist reads from its next shift. Any earlier version can be restored in one tap.",
    reversible: "Yes - restore the previous version any time.",
  },
  decision: {
    what: "A question King Arthur says only I can decide.",
    choices: "Tell King Arthur what I decide (in the council chat) · Mark it handled",
    ifApproved: "Nothing runs automatically from this record; Arthur acts only within his authority after I tell him.",
    reversible: "Yes - it is a record, not an action.",
  },
};

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

function recommendationText(d) {
  if (!d) return "King Arthur has not reviewed this yet.";
  const choice = CHOICE_WORDS[d.recommendation?.choice] || d.recommendation?.choice || "(none)";
  const label = d.category === "uncertain" ? " (he is NOT confident - the evidence is thin)" : "";
  return `${choice}${label}. Reason: ${d.recommendation?.reason || d.detail || "(none given)"}${d.simple ? `\n  In his words: "${d.simple}"` : ""}\n  (Recorded ${ny(d.updatedAt)}, record ${d._id}. This is his recommendation only - not my approval.)`;
}

/** All pending decisions as numbered sections. */
async function pendingSections() {
  const { approvalsList } = require("../growth/office");
  const { settleDecisions, heroOf } = require("./arthur");
  await settleDecisions();
  const [approvals, decisions] = await Promise.all([approvalsList(), CouncilDecision.find({ status: "open" }).sort({ createdAt: 1 }).lean()]);
  const rec = Object.fromEntries(decisions.filter((d) => d.refs?.[0]).map((d) => [`${d.refs[0].kind}:${d.refs[0].id}`, d]));
  const out = [];

  for (const i of [...approvals.items, ...approvals.notes].sort((a, b) => new Date(a.at) - new Date(b.at))) {
    const facts = i.kind === "action" ? explain.ACTION_FACTS[i.type] || {} : KIND_FACTS[i.kind] || {};
    const d = rec[`${i.kind}:${i.id}`];
    out.push({
      title: i.title,
      body: block([
        field("Type", i.kind === "action" ? `Approval request (${i.type})` : i.kind === "playbook" ? "Follow-up email wording" : i.kind === "draft" ? "Draft for review" : `Note (${i.severity || "info"})`),
        field("ID", i.kind === "playbook" ? `playbook ${i.id}` : i.id),
        field("From", heroOf(i.robot) || "the growth system"),
        field("Proposed / updated", ny(i.at)),
        field("What it is", facts.what || i.title),
        field("In plain words", i.simple?.say),
        `- King Arthur's recommendation: ${recommendationText(d)}`,
        field("Evidence (from the specialist)", i.detail),
        field("Cost", "No money is spent by this item. Any AI time is within the existing monthly AI cap."),
        field("Risk (system rating)", i.risk || (i.kind === "note" ? i.severity : null) || "not rated"),
        field("Reversible?", facts.reversible),
        field("My choices", i.kind === "action" ? 'Approve ("Yes, do it") · Decline ("Not now") · More details' : facts.choices),
        field("What approving does", facts.ifApproved),
        field("If I decline", i.kind === "note" ? null : "Nothing happens. It may be proposed again only if the data changes."),
        i.preview ? `- Exact change / text:\n${String(i.preview).split("\n").map((l) => `    ${l}`).join("\n")}` : null,
      ]),
    });
  }

  for (const d of decisions.filter((x) => x.payload?.type === "guidance")) {
    const f = KIND_FACTS.guidance;
    out.push({
      title: d.subject,
      body: block([
        field("Type", "Guidance change proposed by King Arthur"),
        field("ID", String(d._id)),
        field("For", heroOf(d.payload.agent)),
        field("Proposed", ny(d.createdAt)),
        field("What it is", f.what),
        field("In plain words", d.simple),
        `- King Arthur's recommendation: Confirm. Reason: ${d.recommendation?.reason || d.detail}\n  (His proposal only - nothing changes until I confirm.)`,
        field("Cost", "None."),
        field("Reversible?", f.reversible),
        field("My choices", f.choices),
        field("What confirming does", f.ifApproved),
        `- Exact change (guidance version ${d.payload.baseVersion} → ${d.payload.baseVersion + 1}):\n    BEFORE: ${d.payload.previous ? d.payload.previous.replace(/\n/g, "\n            ") : "(no guidance)"}\n    AFTER:  ${d.payload.guidance.replace(/\n/g, "\n            ")}`,
      ]),
    });
  }

  for (const d of decisions.filter((x) => !x.refs?.length && !x.payload && ["decision", "uncertain"].includes(x.category))) {
    const f = KIND_FACTS.decision;
    out.push({
      title: d.subject,
      body: block([
        field("Type", d.category === "uncertain" ? "Unclear - King Arthur needs more facts or my view" : "A decision only I can make (raised by King Arthur)"),
        field("ID", String(d._id)),
        field("Concerns", d.agent ? heroOf(d.agent) : "the whole council"),
        field("Raised", ny(d.createdAt)),
        field("In plain words", d.simple),
        field("Details and evidence", d.detail),
        `- King Arthur's recommendation: ${d.recommendation?.reason || "none - he is asking for my view"}`,
        field("Cost", "This record spends nothing."),
        field("My choices", f.choices),
        field("What deciding does", f.ifApproved),
      ]),
    });
  }
  return out;
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
  const info = await CouncilDecision.find({ category: { $in: ["info", "routine"] } }).sort({ updatedAt: -1 }).limit(12).lean();
  lines.push("", "## King Arthur's recent records (info and routine)");
  lines.push(info.length ? info.map((d) => `- ${ny(d.updatedAt)} · ${d.category} · ${d.subject}${d.simple ? ` - "${d.simple}"` : ""}`).join("\n") : "None yet.");
  const chat = await CouncilMessage.find({}).sort({ createdAt: -1 }).limit(8).lean();
  if (chat.length) {
    lines.push("", "## Last messages between me and King Arthur");
    lines.push(chat.reverse().map((m) => `- ${ny(m.createdAt)} · ${m.role === "owner" ? "Me" : "King Arthur"}: ${String(m.text).replace(/\s+/g, " ").slice(0, 500)}`).join("\n"));
  }
  return lines.join("\n");
}

/** The whole report as text. scope: "pending" (decisions only) or "full" (decisions + status). */
async function buildReport({ scope = "pending", now = new Date() } = {}) {
  const sections = await pendingSections();
  const head = [
    `# Profixter AI council - ${scope === "full" ? "full status report" : "everything waiting for my decision"}`,
    `Generated ${ny(now)} from the system's records (nothing in this report was written by AI except where it quotes an agent).`,
    "",
    explain.CONTEXT,
    "",
    "## Who is who",
    "- King Arthur: my AI manager. He reviews the specialists' work, recommends, assigns tasks and escalates. He cannot approve, send messages, spend money, book visits, change ads, prices, offers, booking rules or permissions. His recommendation is never my approval.",
    "- Odysseus: search specialist (Google, Maps, AI search, page wording, town pages).",
    "- Leonidas: outreach specialist (researches lawful new ways to reach homeowners; no mail, no Meta ads, no imported lists).",
    "- Marcus: conversations and website specialist (follow-up emails, replies to homeowners who write in - business-only).",
  ];
  const body = sections.length
    ? [`## Decisions waiting for me (${sections.length})`, ...sections.map((s, n) => `### ${n + 1}. ${s.title}\n${s.body}`)].join("\n\n")
    : "## Decisions waiting for me\nNothing is waiting for my decision right now.";
  const parts = [...head, "", body];
  if (scope === "full") parts.push("", await statusSection());
  parts.push("", "## My request", CLOSING);
  return { text: explain.redact(parts.join("\n")), count: sections.length, generatedAt: now };
}

module.exports = { CLOSING, buildReport };
