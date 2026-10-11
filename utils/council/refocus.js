const AgentFinding = require("../../models/AgentFinding");
const AgentMemory = require("../../models/AgentMemory");
const { CouncilDecision, CouncilTask } = require("../../models/Council");

/**
 * The 2026-10-11 refocus: the Kingdom became a marketing team. Work that was
 * opened under the old growth mission may now be business management
 * (revenue, billing, memberships, cancellations, capacity) - the owner's.
 *
 * reviewForRefocus() sorts every OPEN council task, open council record and
 * open specialist note into "looks like business management" and
 * "marketing", and files ONE decision for the owner listing both, with a
 * recommendation. It changes nothing else: nothing is cancelled, closed,
 * approved, executed or deleted - the owner decides item by item in the
 * chamber (or tells Arthur). Runs once (a marker in Arthur's notebook).
 */
const MARKER = "system:refocus-2026-10-11-reviewed";
const BUSINESS_RE =
  /\b(revenue|mrr|recurring revenue|stripe|billing|invoices?|subscriptions? (?:stat|count|number|revenue)|cancell?ations?|churn|retention|paying members?|member(?:ship)? (?:count|numbers?|statistics|growth)|pric(?:e|es|ing)|calendar|capacity|scheduling|profit(?:able)?)\b/i;

function lineOf(kind, id, text, extra = "") {
  return `- ${kind} ${id}: ${String(text).replace(/\s+/g, " ").slice(0, 160)}${extra}`;
}

async function reviewForRefocus({ now = new Date() } = {}) {
  if (await AgentMemory.exists({ agent: "arthur", key: MARKER })) return { skipped: "done" };
  const [tasks, records, notes] = await Promise.all([
    CouncilTask.find({ status: { $in: ["received", "assigned", "in_progress", "blocked", "completed"] } }).lean(),
    CouncilDecision.find({ status: "open", category: { $in: ["decision", "uncertain", "info"] }, "payload.type": { $ne: "refocus" } }).lean(),
    AgentFinding.find({ status: "open", kind: { $ne: "report" } }).select("agent kind title detail").lean(),
  ]);
  const business = [];
  const marketing = [];
  for (const t of tasks) (BUSINESS_RE.test(`${t.instruction} ${t.why}`) ? business : marketing).push(lineOf("Task", t._id, t.instruction, ` (${t.status})`));
  for (const d of records) (BUSINESS_RE.test(`${d.subject} ${d.simple} ${d.detail}`) ? business : marketing).push(lineOf("Record", d._id, d.subject));
  for (const f of notes) (BUSINESS_RE.test(`${f.title} ${f.detail}`) ? business : marketing).push(lineOf(f.kind === "content_draft" ? "Draft" : "Note", f._id, f.title));

  if (business.length || marketing.length) {
    await CouncilDecision.create({
      category: "decision",
      subject: "Refocus review: open work from before the marketing mission",
      simple: business.length
        ? `Boss, the Kingdom is now marketing only. ${business.length} open item${business.length === 1 ? "" : "s"} look like business management (revenue, memberships, cancellations, scheduling). I changed nothing - please tell me which to cancel. ${marketing.length} marketing item${marketing.length === 1 ? "" : "s"} carry on.`
        : `Boss, the Kingdom is now marketing only. I checked all ${marketing.length} open items: they are all marketing work and carry on. Nothing was changed.`,
      detail: [
        business.length ? `LOOKS LIKE BUSINESS MANAGEMENT (yours now):\n${business.join("\n")}` : "Nothing looks like business management.",
        marketing.length ? `MARKETING (carries on):\n${marketing.join("\n")}` : "",
        "Nothing has been cancelled, closed, approved or deleted. Cancel tasks in the Tasks tab; notes in Requests.",
      ]
        .filter(Boolean)
        .join("\n\n"),
      recommendation: business.length ? { choice: "see_reason", reason: "Cancel the business-management items listed; keep the marketing ones." } : undefined,
      refs: [],
      payload: { type: "refocus", business: business.length, marketing: marketing.length },
      dedupeKey: "refocus:2026-10-11",
    });
  }
  await AgentMemory.updateOne({ agent: "arthur", key: MARKER }, { $set: { content: `Refocus review filed ${now.toISOString()}: ${business.length} business, ${marketing.length} marketing` } }, { upsert: true });
  const result = { business: business.length, marketing: marketing.length };
  console.log(JSON.stringify({ event: "council_refocus_review", ...result }));
  return result;
}

module.exports = { BUSINESS_RE, reviewForRefocus };
