const mongoose = require("mongoose");
const moment = require("moment-timezone");
const { BOOKING_CLAIM_RE } = require("../../conversation/responder");
const { defineAction } = require("../actionRegistry");

/**
 * Replies to homeowners in GoHighLevel conversations - RETIRED (2026-11-12,
 * owner decision Q-6).
 *
 * The agent used to draft a reply and, once approved, send it into the
 * homeowner's GHL conversation. The GHL inbound webhook, the 10-minute poller
 * and the send call are removed, so nothing reaches GoHighLevel from here:
 * the type is capped at "shadow", and an old record that is approved or still
 * queued is closed as skipped with reason "ghl_retired" (see the engine's
 * retired-type handling). validate/windowWait stay for the historical records
 * and the conversation tests.
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

const RETIRED_REASON = "ghl_retired: replies are no longer sent through GoHighLevel. Answer the homeowner from Profixter's own channels.";

/** Never sends. */
async function execute() {
  return { outcome: "skip", reason: RETIRED_REASON };
}

defineAction({
  type: TYPE,
  label: "Reply to a homeowner",
  description:
    "Retired 2026-11-12 with GoHighLevel: agent-drafted replies are never sent. Kept so past replies keep their history.",
  riskTier: "medium",
  defaultMode: "shadow",
  maxMode: "shadow",
  retiredReason: RETIRED_REASON,
  limits: { perDay: 40 },
  approvalTtlMs: 2 * 24 * 60 * 60 * 1000,
  verifyAfterMs: 2 * 60 * 1000,
  maxAttempts: 2,
  validate,
  describe: (p) => `Reply to a homeowner (${p.channel}, ${p.intent || "message"})`,
  subjectOf: (p) => ({ entityType: "conversation", entityId: p.threadId }),
  execute,
  verify: null,
});

module.exports = { RETIRED_REASON, TYPE, execute, validate, windowWait };
