const ConversationThread = require("../../models/ConversationThread");
const AgentRun = require("../../models/AgentRun");
const { decide } = require("./responder");
const { propose } = require("../growth/actionEngine");
const { agentsEnabled, dailyBudgetCents, monthlyBudgetCents, spentThisMonthCents, spentTodayCents } = require("../agents/runtime");
require("../growth/actions");

/**
 * The Conversation agent's pipeline: a homeowner's message comes in (GHL
 * webhook or the poller), the thread is updated, the agent decides, and a
 * reply - if any - becomes a conversation_reply PROPOSAL. Sending is the
 * growth engine's job under its trust policy (supervised first), never this
 * file's. Opt-outs close the thread permanently, here, before any model call.
 *
 * Every decision is metered as an AgentRun (agent "conversation", trigger
 * "event") so it counts against the same daily and monthly AI caps.
 */
const AGENT = "conversation";

/**
 * Is the person behind this GoHighLevel contact already a Profixter user?
 * Profixter customers are answered from Profixter's own channels, never
 * through GoHighLevel (scripts/test_ghl_separation.js), so such threads go to
 * a person. Fails closed: if the contact cannot be read, a person decides.
 */
async function profixterCustomerCheck(thread) {
  const User = require("../../models/User");
  const { ghl } = require("../ghl/client");
  const { normalizeEmail, extractUSNationalPhoneDigits } = require("../identity");
  try {
    const res = await ghl.getContact(thread.ghlContactId);
    const c = res?.contact || {};
    const email = normalizeEmail(c.email);
    const d = extractUSNationalPhoneDigits(c.phone);
    const or = [];
    if (email) or.push({ email });
    if (d) {
      const forms = [d, `1${d}`, `+1${d}`, `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`, `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`];
      or.push({ phone: { $in: forms } });
    }
    if (!or.length) return { customer: false };
    return { customer: Boolean(await User.exists({ $or: or })) };
  } catch (error) {
    return { customer: null, error: error.message };
  }
}

function channelOf(t) {
  const s = String(t || "").toUpperCase();
  if (s.includes("EMAIL")) return "Email";
  if (s.includes("SMS") || s.includes("TEXT")) return "SMS";
  if (s.includes("CALL")) return "Call";
  return "Other";
}

/** Add one inbound message (idempotent by GHL message id). Returns the thread. */
async function ingestInbound({ conversationId, contactId, channel, body, at, messageId, firstName, town, zip, origin }) {
  if (!conversationId || !contactId) throw new Error("conversationId and contactId are required");
  const ch = channelOf(channel);
  const thread =
    (await ConversationThread.findOne({ ghlConversationId: conversationId })) ||
    new ConversationThread({
      ghlConversationId: conversationId,
      ghlContactId: contactId,
      channel: ch === "Email" ? "Email" : "SMS",
      firstName: String(firstName || "").slice(0, 40),
      town: String(town || "").slice(0, 60),
      zip: String(zip || "").slice(0, 10),
      origin: origin || "inbound",
      refCode: Math.random().toString(36).slice(2, 10),
    });
  if (messageId && thread.messages.some((m) => m.ghlMessageId === messageId)) return thread;
  thread.messages.push({ direction: "inbound", channel: ch, body: String(body || "").slice(0, 4000), at: at ? new Date(at) : new Date(), ghlMessageId: messageId || null, by: "homeowner" });
  thread.lastInboundAt = new Date();
  thread.agentReplies = 0; // one reply per homeowner message
  if (!thread.optedOut && !["escalated"].includes(thread.status)) thread.status = "needs_reply";
  await thread.save();
  return thread;
}

/** Record an outbound message seen in GHL that we did not send (staff replied). */
async function ingestOutbound({ conversationId, body, at, messageId, by = "staff" }) {
  const thread = await ConversationThread.findOne({ ghlConversationId: conversationId });
  if (!thread || (messageId && thread.messages.some((m) => m.ghlMessageId === messageId))) return thread;
  thread.messages.push({ direction: "outbound", channel: thread.channel, body: String(body || "").slice(0, 4000), at: at ? new Date(at) : new Date(), ghlMessageId: messageId || null, by });
  thread.lastOutboundAt = new Date();
  if (thread.status === "needs_reply") thread.status = "replied";
  await thread.save();
  return thread;
}

async function withinBudget(now) {
  const [day, month] = await Promise.all([spentTodayCents(now), spentThisMonthCents(now)]);
  return day + 5 <= dailyBudgetCents() && month + 5 <= monthlyBudgetCents();
}

/** Decide on one thread that needs a reply; propose the reply. */
async function processThread(thread, { now = new Date() } = {}) {
  if (thread.optedOut || thread.status !== "needs_reply") return { skipped: "not_waiting" };
  if (!agentsEnabled()) return { skipped: "agents_disabled" };
  if (await require("../agents/settings").isPaused("conversation")) return { skipped: "paused_by_owner" };
  if (!(await withinBudget(now))) return { skipped: "budget" };

  const check = await profixterCustomerCheck(thread);
  if (check.customer !== false) {
    thread.status = "escalated";
    thread.escalationReason =
      check.customer === true
        ? "Already a Profixter customer - answer from Profixter (phone, email or the app), not through GoHighLevel."
        : "Could not check whether this is a Profixter customer - a person should answer.";
    await thread.save();
    console.log(JSON.stringify({ event: "conversation_decision", thread: String(thread._id), status: "escalated", reason: check.customer === true ? "profixter_customer" : "customer_check_failed" }));
    return { status: thread.status, intent: thread.intent || null, actionId: null };
  }

  const run = await AgentRun.create({ agent: AGENT, trigger: "event", status: "running", startedAt: now, model: "claude-opus-5-5", budgetCents: 10 });
  let result;
  try {
    result = await decide(thread);
  } catch (error) {
    await AgentRun.updateOne({ _id: run._id }, { $set: { status: "failed", finishedAt: new Date(), error: String(error.message).slice(0, 500) } });
    return { error: error.message };
  }

  thread.intent = result.decision.intent;
  thread.summary = String(result.decision.summary || "").slice(0, 300);
  let actionId = null;
  if (result.optOut) {
    thread.optedOut = true;
    thread.status = "opted_out";
  } else if (result.reply) {
    const { action } = await propose(
      "conversation_reply",
      { threadId: String(thread._id), reply: result.reply, channel: thread.channel, intent: thread.intent, inboundCount: thread.messages.filter((m) => m.direction === "inbound").length },
      {
        idempotencyKey: `conversation_reply:${thread._id}:${thread.messages.length}`,
        rationale: `${thread.summary} (intent: ${thread.intent})`,
        proposedBy: { kind: "agent", name: "Conversation agent" },
        now,
      }
    );
    actionId = action?._id || null;
    thread.status = result.decision.escalate ? "escalated" : "reply_proposed";
    if (result.decision.escalate) thread.escalationReason = String(result.decision.escalation_reason || "").slice(0, 300);
  } else if (result.decision.escalate || result.problems.length) {
    thread.status = "escalated";
    thread.escalationReason = String(result.decision.escalation_reason || result.problems.join("; ") || "needs a person").slice(0, 300);
  } else {
    thread.status = "closed";
  }
  await thread.save();
  await AgentRun.updateOne(
    { _id: run._id },
    {
      $set: {
        status: "succeeded",
        finishedAt: new Date(),
        turns: 1,
        costCents: result.costCents,
        actions: actionId ? [actionId] : [],
        summary: `${thread.intent}: ${thread.summary}${result.problems.length ? ` | blocked: ${result.problems.join("; ")}` : ""}`,
      },
    }
  );
  console.log(JSON.stringify({ event: "conversation_decision", thread: String(thread._id), intent: thread.intent, status: thread.status, proposed: Boolean(actionId), problems: result.problems, costCents: result.costCents }));
  return { status: thread.status, intent: thread.intent, actionId };
}

/** Work the queue: oldest waiting first, a few per sweep. */
async function processWaiting({ now = new Date(), limit = 5 } = {}) {
  const waiting = await ConversationThread.find({ status: "needs_reply", optedOut: false }).sort({ lastInboundAt: 1 }).limit(limit);
  const out = [];
  for (const t of waiting) out.push(await processThread(t, { now }));
  return out;
}

module.exports = { channelOf, ingestInbound, ingestOutbound, processThread, processWaiting, profixterCustomerCheck };
