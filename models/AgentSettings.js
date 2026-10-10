const mongoose = require("mongoose");

/**
 * What the owner controls per agent, from the Growth office ("Teach").
 *
 * - paused: scheduled and automatic work stops (a manual "run now" still runs).
 * - guidance: owner-written notes ADDED to the agent's instructions, after the
 *   fixed rules, which always win. It is not training: it changes what the
 *   agent is told on its next run, nothing more. Validated on save
 *   (utils/agents/settings.js) so it cannot remove a business rule.
 * - history: every guidance version, for review and rollback.
 */
const versionSchema = new mongoose.Schema(
  {
    version: { type: Number, required: true },
    guidance: { type: String, default: "" },
    by: { type: String, default: "" },
    at: { type: Date, default: Date.now },
    note: { type: String, default: "" },
    rollbackOf: { type: Number, default: null },
  },
  { _id: false }
);

const agentSettingsSchema = new mongoose.Schema(
  {
    agent: { type: String, required: true, unique: true },
    paused: { type: Boolean, default: false },
    pausedBy: { type: String, default: "" },
    pausedAt: { type: Date, default: null },
    guidance: { type: String, default: "" },
    version: { type: Number, default: 0 },
    history: { type: [versionSchema], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.models.AgentSettings || mongoose.model("AgentSettings", agentSettingsSchema);
