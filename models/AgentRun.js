const mongoose = require("mongoose");

/**
 * One execution of a growth agent: the persistent task history.
 *
 * Every scheduled or manual run leaves exactly one row, whatever happened -
 * a run that was skipped (budget, lease, missing key) says why, so "the agent
 * did nothing this week" is always explainable from the record. The tool
 * calls are kept by name and outcome (not their data), which together with
 * the findings and proposed actions linked here is the audit trail of what
 * the agent looked at and what it decided.
 */
const agentRunSchema = new mongoose.Schema(
  {
    agent: { type: String, required: true, index: true },
    trigger: { type: String, enum: ["schedule", "manual", "test"], default: "schedule" },
    status: {
      type: String,
      enum: ["running", "succeeded", "failed", "budget_stopped", "skipped"],
      required: true,
      index: true,
    },
    skipReason: { type: String, default: null },
    model: { type: String, default: null },
    startedAt: { type: Date, required: true },
    finishedAt: { type: Date, default: null },
    turns: { type: Number, default: 0 },
    usage: {
      inputTokens: { type: Number, default: 0 },
      outputTokens: { type: Number, default: 0 },
      cacheReadTokens: { type: Number, default: 0 },
      cacheWriteTokens: { type: Number, default: 0 },
    },
    costCents: { type: Number, default: 0 },
    budgetCents: { type: Number, default: 0 },
    stopReason: { type: String, default: null },
    toolCalls: [
      {
        _id: false,
        name: String,
        ok: Boolean,
        ms: Number,
        error: String,
      },
    ],
    findings: [{ type: mongoose.Schema.Types.ObjectId, ref: "AgentFinding" }],
    actions: [{ type: mongoose.Schema.Types.ObjectId, ref: "GrowthAction" }],
    summary: { type: String, default: "" },
    error: { type: String, default: null },
  },
  { timestamps: true }
);

agentRunSchema.index({ agent: 1, startedAt: -1 });
agentRunSchema.index({ startedAt: -1 });

module.exports = mongoose.models.AgentRun || mongoose.model("AgentRun", agentRunSchema);
