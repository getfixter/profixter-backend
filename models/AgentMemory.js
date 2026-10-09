const mongoose = require("mongoose");

/**
 * An agent's notebook: what it learned and wants to remember next run.
 *
 * Small on purpose - a few dozen short notes per agent, each capped - because
 * memory is for conclusions ("Instagram CAC has run 2x Facebook for 4 weeks",
 * "the Massapequa page was drafted on 10/12; check its clicks after 10/26"),
 * not for re-storing data the tools can already read. The engine enforces the
 * caps; the agent decides what is worth keeping and overwrites stale notes.
 */
const agentMemorySchema = new mongoose.Schema(
  {
    agent: { type: String, required: true },
    key: { type: String, required: true },
    content: { type: String, required: true },
  },
  { timestamps: true }
);

agentMemorySchema.index({ agent: 1, key: 1 }, { unique: true });

module.exports = mongoose.models.AgentMemory || mongoose.model("AgentMemory", agentMemorySchema);
