const GrowthAction = require("../../models/GrowthAction");
const GrowthPolicy = require("../../models/GrowthPolicy");
const { getDefinition } = require("./actionRegistry");

/**
 * THE ACTION LOG the owner asked for (2026-10-12): every action the Kingdom
 * proposed or took, with the agent responsible, the platform, what was done,
 * when, the published URL or delivery outcome, the estimated EXTERNAL cost
 * (always $0 - the Kingdom is 100% organic; AI running costs are reported
 * separately under the $5/day limit) and the verification result. Built from
 * GrowthAction records only - nothing here is written by an agent. Customer
 * identities never appear: a message shows its type and outcome, not who.
 */
const PLATFORM = {
  seo_page_update: "profixter.com",
  seo_content_update: "profixter.com",
  playbook_email: "email",
  checkout_recovery_email: "email",
  post_free_visit_sms: "sms",
  conversation_reply: "email/sms reply",
};

function platformOf(type) {
  return getDefinition(type)?.platform || PLATFORM[type] || "profixter";
}

function outcomeOf(a) {
  const r = a.result || {};
  if (a.status === "succeeded") {
    const link = /^https?:\/\//.test(String(a.verification?.detail || "").split(" at ").pop()) ? String(a.verification.detail).split(" at ").pop() : null;
    if (link) return `published: ${link}`;
    if (r.postId) return `posted (post ${r.postId})`;
    if (r.messageId || r.sid) return "delivered to the provider";
    if (r.path || a.payload?.path) return `changed ${r.path || a.payload.path}`;
    return "done";
  }
  if (a.status === "skipped") return `skipped: ${r.reason || "not applicable"}`;
  if (a.status === "failed") return `failed: ${String(a.lastError || "").slice(0, 160)}`;
  if (a.status === "awaiting_approval") return "waiting for the owner's approval";
  if (a.status === "shadow") return "recorded only (watch mode) - nothing was done";
  return a.status;
}

async function actionLog({ days = 14, limit = 60, now = new Date() } = {}) {
  const rows = await GrowthAction.find({ createdAt: { $gte: new Date(now.getTime() - days * 864e5) } })
    .sort({ createdAt: -1 })
    .limit(limit)
    .select("type status summary proposedBy createdAt executedAt result verification lastError payload.path")
    .lean();
  return rows.map((a) => ({
    at: a.executedAt || a.createdAt,
    agent: a.proposedBy?.name || a.proposedBy?.kind || "system",
    platform: platformOf(a.type),
    action: `${a.type}: ${String(a.summary || "").slice(0, 140)}`,
    outcome: outcomeOf(a),
    estimatedCostCents: Number(a.result?.estimatedCostCents) || 0,
    verification: a.verification?.status ? `${a.verification.status}${a.verification.detail ? ` - ${String(a.verification.detail).slice(0, 160)}` : ""}` : "n/a",
  }));
}

/** Action types the engine stopped by itself after repeated failures. */
async function suspendedTypes() {
  const rows = await GrowthPolicy.find({ "setBy.kind": "auto_suspension", mode: "shadow" }).select("type setBy").lean();
  return rows.map((p) => ({ type: p.type, at: p.setBy?.at || null, why: String(p.setBy?.note || "").slice(0, 200) }));
}

module.exports = { actionLog, platformOf, suspendedTypes };
