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
// Money and operations - NOT marketing words like "content calendar" or "scheduling posts".
const BUSINESS_RE =
  /\b(revenue|mrr|recurring revenue|stripe|billing|invoices?|subscriptions? (?:stat|count|number|revenue)|cancell?ations?|churn|retention|paying members?|member(?:ship)? (?:count|numbers?|statistics|growth)|pric(?:e|es|ing) (?:change|increase|cut|test|analysis)|calendar capacity|capacity|(?:visit|appointment|booking) scheduling|scheduling capacity|profit(?:able|ability)?|(?:members?|customers?|people) (?:who )?(?:cancel|leave|quit)\w*|(?:failed|declined|late|missed) payments?|payments? (?:failed|failures?|declined|issues?)|past[- ]due|card (?:declined|failed|expired))\b/i;

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

const BILLING_RE = /\b(billing|invoices?|stripe|(?:failed|declined|late|missed) payments?|payments? (?:failed|failures?|declined|issues?)|past[- ]due|card (?:declined|failed|expired)|refunds?|chargebacks?)\b/i;

/**
 * Keep the marketing view marketing-only - without deleting history:
 *  - the retired weekly business report(s) of the old "Growth Intelligence"
 *    digest (members, revenue, cancellations) are archived;
 *  - any open specialist note about billing or payments (e.g. failed
 *    payments) is archived - billing is the owner's and no agent needs it.
 * Both keep their full record and appear in the chamber's Archived list,
 * restorable by the owner. Idempotent: only OPEN items are touched.
 */
async function retireBusinessRecords({ now = new Date() } = {}) {
  const at = now;
  const reports = await AgentFinding.find({ kind: "report", status: { $ne: "archived" } }).select("_id status").lean();
  for (const r of reports) {
    await AgentFinding.updateOne(
      { _id: r._id, status: r.status },
      {
        $set: {
          status: "archived",
          statusBy: "system",
          statusNote: "Retired weekly business report (from before the marketing refocus) - kept in history",
          archive: { by: "system", at, reason: "Retired weekly business report from before the marketing refocus: members, revenue and cancellations are the owner's. Kept in history.", category: "retired_report", previousStatus: r.status },
        },
      }
    );
  }
  const open = await AgentFinding.find({ status: "open", kind: { $ne: "report" } }).select("title detail plain").lean();
  const billing = open.filter((f) => BILLING_RE.test(`${f.title} ${f.detail || ""} ${f.plain || ""}`));
  for (const f of billing) {
    await AgentFinding.updateOne(
      { _id: f._id, status: "open" },
      {
        $set: {
          status: "archived",
          statusBy: "system",
          statusNote: "Billing information is the owner's - archived out of the marketing view, kept in history",
          archive: { by: "system", at, reason: "Billing and payment information is the owner's, not the marketing Kingdom's. Kept in history.", category: "business_management", previousStatus: "open" },
        },
      }
    );
  }
  const result = { reports: reports.length, billingNotes: billing.length };
  if (reports.length || billing.length) console.log(JSON.stringify({ event: "business_records_retired", ...result }));
  return result;
}

module.exports = { BILLING_RE, BUSINESS_RE, retireBusinessRecords, reviewForRefocus };
