/**
 * Plain-English versions for OLDER agent output.
 *
 * New findings, proposals and shift summaries carry a plain version written by
 * the agent itself. Records written before that have only the technical text;
 * when the owner opens them in the Growth office, this rewrites a few at a time
 * into everyday English with Claude Haiku and stores the result on the record
 * (plainBy: "explainer"), so each is translated once.
 *
 * It rewrites; it never adds facts. It is metered as AgentRun "explainer" and
 * respects the same daily and monthly AI limits as the agents. If AI is off or
 * the limit is near, nothing happens and the office shows its short fallback.
 */
const AgentRun = require("../../models/AgentRun");
const AgentFinding = require("../../models/AgentFinding");
const { agentsEnabled, dailyBudgetCents, monthlyBudgetCents, spentThisMonthCents, spentTodayCents } = require("../agents/runtime");

const MODEL = "claude-haiku-4-5-20251001";
const PER_CALL_RESERVE_CENTS = 2;
const MAX_PER_SWEEP = 6;

let clientFactory = () => {
  const { Anthropic } = require("@anthropic-ai/sdk");
  return new Anthropic();
};
function setClientFactory(fn) {
  clientFactory = fn;
}

const SCHEMA = {
  type: "object",
  properties: {
    plain: { type: "string", description: "2-4 short sentences in everyday English" },
    owner_question: { type: "string", description: "The one question the owner must answer, or empty" },
  },
  required: ["plain", "owner_question"],
  additionalProperties: false,
};

const SYSTEM = `You rewrite internal reports from Profixter's AI agents for the business owner, who is not technical.

Write as the agent speaking to its boss, in first person ("I found...", "I checked..."). 2-4 short sentences in simple everyday English: what was done or found, what it means for Profixter (getting more homeowners to book their first free visit), and what the owner needs to decide, if anything.

Rules:
- Use ONLY facts in the report. Never add numbers, causes, promises or recommendations that are not there.
- No jargon, abbreviations (CTR, GSC, SEO, CAC, API), tool names, field names, code or IDs.
- If the report asks the owner for a decision, put it as one short question in owner_question; otherwise leave owner_question empty.
- Never mention customers by name.`;

const costCents = (u = {}) => (((u.input_tokens || 0) * 1 + (u.output_tokens || 0) * 5) / 1e6) * 100;

let running = false;

async function canSpend(now) {
  if (!agentsEnabled() || !process.env.ANTHROPIC_API_KEY) return false;
  const [day, month] = await Promise.all([spentTodayCents(now), spentThisMonthCents(now)]);
  return day + PER_CALL_RESERVE_CENTS * MAX_PER_SWEEP <= dailyBudgetCents() && month + PER_CALL_RESERVE_CENTS * MAX_PER_SWEEP <= monthlyBudgetCents();
}

async function rewrite(text, robotName) {
  const res = await clientFactory().beta.messages.create({
    model: MODEL,
    max_tokens: 600,
    system: SYSTEM,
    messages: [{ role: "user", content: `Agent: ${robotName}\n\nReport:\n${String(text).slice(0, 6000)}` }],
    output_config: { format: { type: "json_schema", schema: SCHEMA } },
  });
  const raw = (res.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  const parsed = JSON.parse(raw);
  return { plain: String(parsed.plain || "").slice(0, 900), question: String(parsed.owner_question || "").slice(0, 300), cents: costCents(res.usage) };
}

/**
 * Translate up to MAX_PER_SWEEP findings and runs that lack a plain version.
 * Fire-and-forget from the office endpoints; one sweep at a time per instance.
 */
async function explainMissing({ findings = [], runs = [], robotName = "agent", now = new Date() } = {}) {
  if (running) return { skipped: "busy" };
  const todo = [
    ...findings.filter((f) => !f.plain && (f.detail || f.title)).map((f) => ({ kind: "finding", doc: f })),
    ...runs.filter((r) => r.status === "succeeded" && !r.plainSummary && r.summary).map((r) => ({ kind: "run", doc: r })),
  ].slice(0, MAX_PER_SWEEP);
  if (!todo.length) return { done: 0 };
  if (!(await canSpend(now))) return { skipped: "budget_or_off" };
  running = true;
  const meter = await AgentRun.create({ agent: "explainer", trigger: "event", status: "running", startedAt: now, model: MODEL, budgetCents: PER_CALL_RESERVE_CENTS * todo.length });
  let cents = 0;
  let done = 0;
  try {
    for (const item of todo) {
      try {
        const text =
          item.kind === "finding"
            ? `${item.doc.title}\n\n${item.doc.detail || ""}\n\nEvidence: ${item.doc.evidence || ""}`
            : item.doc.summary;
        const out = await rewrite(text, robotName);
        cents += out.cents;
        if (!out.plain) continue;
        if (item.kind === "finding") {
          await AgentFinding.updateOne({ _id: item.doc._id, plain: { $in: ["", null] } }, { $set: { plain: out.plain, ownerQuestion: out.question, plainBy: "explainer" } });
        } else {
          await AgentRun.updateOne({ _id: item.doc._id, plainSummary: { $in: ["", null] } }, { $set: { plainSummary: out.plain, plainBy: "explainer" } });
        }
        done += 1;
      } catch (error) {
        console.warn(JSON.stringify({ event: "plain_explainer_item_failed", kind: item.kind, error: String(error.message).slice(0, 200) }));
      }
    }
    await AgentRun.updateOne({ _id: meter._id }, { $set: { status: "succeeded", finishedAt: new Date(), costCents: Math.round(cents * 100) / 100, summary: `Plain-English versions written: ${done}` } });
    return { done, cents };
  } catch (error) {
    await AgentRun.updateOne({ _id: meter._id }, { $set: { status: "failed", finishedAt: new Date(), costCents: Math.round(cents * 100) / 100, error: String(error.message).slice(0, 300) } });
    return { error: error.message };
  } finally {
    running = false;
  }
}

module.exports = { MODEL, explainMissing, setClientFactory };
