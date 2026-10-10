const { factSheet, LINKS, SITE } = require("./knowledge");

/**
 * The Conversation agent's brain: read one thread, decide what the homeowner
 * wants, and draft at most ONE reply - or none.
 *
 * The model returns a structured decision (output_config json_schema); the
 * code then enforces the rules regardless of what the model wrote:
 *   - opt-outs ("stop", "remove me", "don't text", hostility) end the thread
 *     for good, and are detected in code even if the model misses them
 *   - no booking: replies may never claim or offer to book, hold or confirm a
 *     visit; the homeowner books on the website
 *   - no URLs from the model: the code appends one tracked link chosen from
 *     a fixed list (free visit, plans, one-time, renovation)
 *   - dollar amounts only if they match the live catalogue
 *   - no discounts, guarantees, warranties or availability promises
 *   - SMS replies stay short
 * A draft that breaks a rule is not sent: the thread is escalated to a person.
 */

const MODEL = "claude-opus-5-5";
const STOP_RE = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|optout|opt out|revoke)\b|\b(stop (texting|messaging|contacting)|remove me|take me off|do not (text|contact|message)|don'?t (text|contact|message)|lose my number|unsubscribe)\b/i;
const BOOKING_CLAIM_RE = /\b(i|we)\s*(have|'ve|’ve)?\s*(booked|scheduled|reserved|confirmed|locked in|set up)\b|\byou('|’)?re (booked|scheduled|confirmed|all set for)\b|\bappointment (is|has been) (set|confirmed|booked|scheduled)\b|\b(i|we) (can|will|'ll|’ll) (book|schedule|reserve) (it|that|you|a time|your)/i;
const FORBIDDEN_RE = /\b(\d+\s?%\s?off|discount|coupon|promo code|special offer|free month|guarantee[ds]?|warrant(y|ies)|money.?back|same.?day|tomorrow at|today at|available (on|at) \d)/i;
const URL_RE = /https?:\/\/|www\.|\.com\b/i;

const DECISION_SCHEMA = {
  type: "object",
  properties: {
    intent: {
      type: "string",
      enum: ["interested_free_visit", "question", "membership_or_services", "renovation", "not_interested", "opt_out", "wrong_number", "complaint", "needs_human", "no_reply_needed"],
    },
    should_reply: { type: "boolean" },
    reply: { type: "string", description: "The reply text without any link, or empty" },
    link: { type: "string", enum: ["free_visit", "plans", "one_time", "renovation", "kitchen_bath", "none"] },
    escalate: { type: "boolean" },
    escalation_reason: { type: "string" },
    summary: { type: "string", description: "One line: who this is and what they want" },
  },
  required: ["intent", "should_reply", "reply", "link", "escalate", "escalation_reason", "summary"],
  additionalProperties: false,
};

const POLICY = `You are Profixter's conversation assistant, replying on Profixter's behalf to a Long Island homeowner who wrote to us (by text or email). Be warm, brief, plain-spoken and honest, like a helpful local business owner. One reply at a time; never pushy, never repetitive.

PRIORITIES
1. The free first visit: if they are interested or curious, explain it accurately and point them to book it themselves online (link: free_visit).
2. If they ask about regular help, membership or one-off jobs, explain those options (link: plans or one_time).
3. Only if they specifically want other work (a bathroom, kitchen, roof, siding, bigger project), mention Profixter also does renovations (link: renovation or kitchen_bath). Don't force the free visit on someone who clearly wants something else.

HARD RULES
- You never book, schedule, hold, move or confirm visits, and never say you will. The homeowner books on the website. You cannot see the calendar: never promise a day or time.
- Use only the facts provided. If they ask something the facts don't answer (insurance, licenses, warranties, exact availability, unusual jobs, prices of specific repairs, complaints, billing, anything legal), set escalate=true and reply briefly that someone from the team will follow up.
- Never offer discounts, deals, guarantees or anything not in the facts. Never invent services.
- Do NOT write any link or website address in the reply; choose "link" and the system adds the right one.
- If they ask to stop, are not interested, say wrong number, or are hostile: should_reply=false (intent opt_out / not_interested / wrong_number / complaint). Never argue or try to change their mind.
- Texts: under 300 characters. Emails: under 120 words. No emoji. Sign off as "- Profixter" on texts.
- Write in the same language they used.`;

function threadText(thread) {
  return thread.messages
    .slice(-12)
    .map((m) => `${m.direction === "inbound" ? "HOMEOWNER" : "PROFIXTER"} (${m.channel}, ${new Date(m.at).toISOString().slice(0, 16)}): ${String(m.body || "").slice(0, 1500)}`)
    .join("\n");
}

function trackedLink(link, thread) {
  const path = LINKS[link];
  if (!path) return null;
  const [p, hash] = path.split("#");
  const u = new URL(`${SITE}${p}`);
  u.searchParams.set("utm_source", thread.channel === "Email" ? "ghl_email" : "ghl_sms");
  u.searchParams.set("utm_medium", "conversation");
  u.searchParams.set("utm_campaign", thread.origin || "reply");
  if (thread.refCode) u.searchParams.set("utm_content", thread.refCode);
  return `${u.toString()}${hash ? `#${hash}` : ""}`;
}

/** Code-side rule check. Returns a list of problems (empty = OK to send). */
function checkReply(reply, { channel, allowedAmounts }) {
  const problems = [];
  if (!reply.trim()) problems.push("empty reply");
  if (BOOKING_CLAIM_RE.test(reply)) problems.push("claims or offers a booking");
  if (FORBIDDEN_RE.test(reply)) problems.push("discount, guarantee or availability promise");
  if (URL_RE.test(reply)) problems.push("contains a link or web address");
  for (const m of reply.matchAll(/\$\s?(\d[\d,]*)/g)) {
    const n = Number(m[1].replace(/,/g, ""));
    if (!allowedAmounts.has(n)) problems.push(`unknown price $${n}`);
  }
  if (/\bunlimited\b|\bvisits? (per|a) month\b/i.test(reply)) problems.push("membership described as an allowance");
  if (channel === "SMS" && reply.length > 320) problems.push("too long for a text");
  return problems;
}

let clientFactory = () => {
  const { Anthropic } = require("@anthropic-ai/sdk");
  return new Anthropic();
};
function setClientFactory(fn) {
  clientFactory = fn;
}

/**
 * Decide on one thread. Returns
 *   { decision, reply: string|null (final text incl. link), problems[], costCents }
 * Never sends anything.
 */
async function decide(thread) {
  const last = [...thread.messages].reverse().find((m) => m.direction === "inbound");
  if (last && STOP_RE.test(String(last.body || ""))) {
    return { decision: { intent: "opt_out", should_reply: false, escalate: false, summary: "Asked to stop" }, reply: null, problems: [], costCents: 0, optOut: true };
  }
  const { text: facts, allowedAmounts } = await factSheet();
  const response = await clientFactory().beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    system: [{ type: "text", text: `${POLICY}\n\n${facts}`, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: `Channel: ${thread.channel}. Homeowner first name: ${thread.firstName || "unknown"}. Town: ${thread.town || "unknown"}.\nThe conversation so far (the last message is theirs):\n${threadText(thread)}\n\nDecide and draft the reply.`,
      },
    ],
    thinking: { type: "adaptive" },
    output_config: { effort: "medium", format: { type: "json_schema", schema: DECISION_SCHEMA } },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  });
  const { costOf } = require("../agents/runtime"); // lazy: avoids a load-order cycle
  const costCents = Math.round(costOf(response.usage || {}) * 100) / 100;
  if (response.stop_reason === "refusal") {
    return { decision: { intent: "needs_human", should_reply: false, escalate: true, escalation_reason: "model declined", summary: "" }, reply: null, problems: ["refusal"], costCents };
  }
  const raw = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  let decision;
  try {
    decision = JSON.parse(raw);
  } catch {
    return { decision: { intent: "needs_human", should_reply: false, escalate: true, escalation_reason: "unreadable decision", summary: "" }, reply: null, problems: ["unparseable"], costCents };
  }
  const optOut = ["opt_out"].includes(decision.intent);
  if (!decision.should_reply || optOut || ["not_interested", "wrong_number", "complaint", "no_reply_needed"].includes(decision.intent)) {
    return { decision, reply: null, problems: [], costCents, optOut };
  }
  const problems = checkReply(String(decision.reply || ""), { channel: thread.channel, allowedAmounts });
  const link = trackedLink(decision.link, thread);
  const reply = problems.length ? null : `${String(decision.reply).trim()}${link ? `${thread.channel === "SMS" ? "\n" : "\n\n"}${link}` : ""}`;
  return { decision, reply, problems, costCents, optOut: false };
}

module.exports = { BOOKING_CLAIM_RE, DECISION_SCHEMA, STOP_RE, checkReply, decide, setClientFactory, threadText, trackedLink };
