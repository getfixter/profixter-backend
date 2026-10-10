const mongoose = require("mongoose");

/**
 * Something an agent concluded: an opportunity, a risk, an anomaly, an
 * insight, a creative brief, a content draft.
 *
 * Findings persist across runs so an agent sees its own open items next time
 * and does not rediscover the same thing weekly (`dedupeKey` makes recording
 * the same finding twice a refresh, not a duplicate). An agent closes its own
 * findings when the data says they are resolved; the owner can acknowledge or
 * dismiss them from the Command Center. Content drafts live here too: the
 * draft body is the deliverable, and publishing it is a separate decision.
 */
const agentFindingSchema = new mongoose.Schema(
  {
    agent: { type: String, required: true, index: true },
    run: { type: mongoose.Schema.Types.ObjectId, ref: "AgentRun", default: null },
    kind: {
      type: String,
      enum: ["opportunity", "risk", "anomaly", "insight", "experiment", "creative_brief", "content_draft", "report"],
      required: true,
    },
    severity: { type: String, enum: ["info", "low", "medium", "high"], default: "info" },
    title: { type: String, required: true },
    detail: { type: String, default: "" },
    // The owner-facing version: everyday English, written by the agent (or by the
    // plain-English explainer for older records - plainBy says which).
    plain: { type: String, default: "" },
    ownerQuestion: { type: String, default: "" },
    plainBy: { type: String, default: "" },
    expectedImpact: { type: String, default: "" },
    evidence: { type: mongoose.Schema.Types.Mixed, default: null },
    /* For content drafts: the publishable body (markdown) and its target. */
    body: { type: String, default: "" },
    target: { type: String, default: "" },
    dedupeKey: { type: String, default: null },
    status: {
      type: String,
      enum: ["open", "acknowledged", "resolved", "dismissed", "superseded"],
      default: "open",
      index: true,
    },
    statusNote: { type: String, default: "" },
    statusBy: { type: String, default: "" },
    seenCount: { type: Number, default: 1 },
    lastSeenAt: { type: Date, default: null },
  },
  { timestamps: true }
);

agentFindingSchema.index({ agent: 1, dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: "string" } } });
agentFindingSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.models.AgentFinding || mongoose.model("AgentFinding", agentFindingSchema);
