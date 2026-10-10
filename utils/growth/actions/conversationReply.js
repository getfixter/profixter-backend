const mongoose = require("mongoose");
const moment = require("moment-timezone");
const ConversationThread = require("../../../models/ConversationThread");
const { ghl } = require("../../ghl/client");
const { BOOKING_CLAIM_RE } = require("../../conversation/responder");
const { defineAction } = require("../actionRegistry");

/**
 * Send ONE agent-drafted reply into a homeowner's existing GHL conversation.
 *
 * Only ever a reply: the homeowner wrote first, and this answers that message.
 * Re-checked when it runs: the thread still exists and is not opted out, the
 * homeowner has not written again (a newer message gets a fresh decision),
 * nobody from the team already answered, no booking language, and only
 * between 8am and 9pm New York time (deferred otherwise). Supervised by
 * default; earns autonomy after 10 clean sends, max 40 a day.
 */
const TYPE = "conversation_reply";

function validate(p = {}) {
  if (!mongoose.Types.ObjectId.isValid(String(p.threadId || ""))) throw new Error("conversation_reply needs a threadId");
  const reply = String(p.reply || "").trim();
  if (!reply || reply.length > 1500) throw new Error("reply must be 1-1500 characters");
  if (BOOKING_CLAIM_RE.test(reply)) throw new Error("reply claims a booking");
  return { threadId: String(p.threadId), reply, channel: p.channel === "Email" ? "Email" : "SMS", intent: String(p.intent || ""), inboundCount: Number(p.inboundCount) || 0 };
}

function windowWait(now) {
  const local = moment.tz(now, "America/New_York");
  if (local.hour() >= 8 && local.hour() < 21) return null;
  const start = local.clone().startOf("day").hour(8).minute(5);
  return (local.hour() >= 21 ? start.add(1, "day") : start).toDate();
}

async function execute(payload, { now }) {
  const wait = windowWait(now);
  if (wait) return { outcome: "defer", until: wait };
  const thread = await ConversationThread.findById(payload.threadId);
  if (!thread) return { outcome: "skip", reason: "thread_gone" };
  if (thread.optedOut) return { outcome: "skip", reason: "opted_out" };
  const inbound = thread.messages.filter((m) => m.direction === "inbound").length;
  if (inbound !== payload.inboundCount) return { outcome: "skip", reason: "homeowner_wrote_again" };
  const last = thread.messages[thread.messages.length - 1];
  if (last && last.direction === "outbound") return { outcome: "skip", reason: "already_answered" };
  if (thread.agentReplies >= 1) return { outcome: "skip", reason: "one_reply_per_message" };
  // They may have signed up since the reply was proposed: Profixter customers are never messaged through GoHighLevel.
  const { profixterCustomerCheck } = require("../../conversation/service");
  if ((await profixterCustomerCheck(thread)).customer !== false) return { outcome: "skip", reason: "profixter_customer" };

  const sent = await ghl.sendReply({
    type: payload.channel === "Email" ? "Email" : "SMS",
    contactId: thread.ghlContactId,
    message: payload.reply,
    subject: "Re: Profixter",
    html: payload.reply.replace(/\n/g, "<br>"),
  });
  const messageId = String(sent?.messageId || sent?.id || "") || null;
  thread.messages.push({ direction: "outbound", channel: thread.channel, body: payload.reply, at: new Date(), ghlMessageId: messageId, by: "agent" });
  thread.lastOutboundAt = new Date();
  thread.agentReplies += 1;
  if (thread.status !== "escalated") thread.status = "replied";
  await thread.save();
  await ghl.addTag(thread.ghlContactId, "ai_replied").catch(() => {});
  return { outcome: "done", result: { messageId, channel: payload.channel } };
}

defineAction({
  type: TYPE,
  label: "Reply to a homeowner",
  description:
    "One agent-drafted reply to a homeowner who wrote to Profixter, in the same GHL conversation. Never books anything; links to the website. 8am-9pm only, one reply per homeowner message, never after an opt-out.",
  riskTier: "medium",
  defaultMode: "supervised",
  maxMode: "autonomous",
  promoteAfter: 10,
  limits: { perDay: 40 },
  approvalTtlMs: 2 * 24 * 60 * 60 * 1000,
  verifyAfterMs: 2 * 60 * 1000,
  maxAttempts: 2,
  validate,
  describe: (p) => `Reply to a homeowner (${p.channel}, ${p.intent || "message"})`,
  subjectOf: (p) => ({ entityType: "conversation", entityId: p.threadId }),
  execute,
  verify: async (a) => (a.result?.messageId ? { passed: true, detail: "accepted by GoHighLevel" } : { passed: false, detail: "no message id returned" }),
});

module.exports = { TYPE, execute, validate, windowWait };
