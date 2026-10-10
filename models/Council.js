const mongoose = require("mongoose");

/**
 * The council: King Arthur, the owner's AI manager, over the three specialist
 * agents (Odysseus = visibility, Leonidas = outreach, Marcus Aurelius =
 * conversion/conversations).
 *
 * CouncilTask      an instruction to one specialist, with a visible life:
 *                  received -> assigned -> in_progress -> completed -> verified
 *                  (or blocked / not_verified / cancelled). Arthur issuing an
 *                  instruction never marks it done: only the specialist's own
 *                  report moves it to "completed", and only Arthur's review of
 *                  that report (or the owner) marks it "verified".
 * CouncilMessage   the owner <-> Arthur conversation.
 * CouncilDecision  what Arthur filed for the owner, by category:
 *                  routine (he handled it), info (worth knowing), decision
 *                  (needs the owner), uncertain (unclear - needs the owner or
 *                  more facts). Recommendations about existing approval items
 *                  point at them by ref; guidance changes Arthur proposes wait
 *                  here for the owner's confirmation.
 */
const historySchema = new mongoose.Schema(
  { at: { type: Date, default: Date.now }, status: String, by: String, note: String },
  { _id: false }
);

const taskSchema = new mongoose.Schema(
  {
    agent: { type: String, required: true, index: true }, // visibility | outreach | conversion
    instruction: { type: String, required: true },
    why: { type: String, default: "" },
    origin: { type: String, enum: ["owner", "arthur"], default: "arthur" },
    status: {
      type: String,
      enum: ["received", "assigned", "in_progress", "completed", "blocked", "verified", "not_verified", "cancelled"],
      default: "assigned",
      index: true,
    },
    history: { type: [historySchema], default: [] },
    lastRun: { type: mongoose.Schema.Types.ObjectId, ref: "AgentRun", default: null },
    result: { summary: String, by: String, at: Date },
    verification: { verdict: String, note: String, by: String, at: Date },
    dedupeKey: { type: String, default: null },
  },
  { timestamps: true }
);
taskSchema.index({ agent: 1, status: 1, createdAt: -1 });

const actionSchema = new mongoose.Schema(
  { type: String, ref: String, label: String, ok: Boolean },
  { _id: false }
);

const messageSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ["owner", "arthur"], required: true },
    text: { type: String, required: true },
    actions: { type: [actionSchema], default: [] },
    run: { type: mongoose.Schema.Types.ObjectId, ref: "AgentRun", default: null },
    kind: { type: String, default: "chat" }, // chat | briefing
  },
  { timestamps: true }
);

const decisionSchema = new mongoose.Schema(
  {
    category: { type: String, enum: ["routine", "info", "decision", "uncertain"], required: true, index: true },
    subject: { type: String, required: true },
    simple: { type: String, default: "" }, // Arthur's words to the owner
    detail: { type: String, default: "" }, // the technical context
    agent: { type: String, default: null },
    recommendation: { choice: String, reason: String },
    refs: [{ kind: String, id: String }],
    payload: { type: mongoose.Schema.Types.Mixed, default: null }, // e.g. { type: "guidance", agent, guidance }
    status: { type: String, enum: ["open", "resolved", "superseded"], default: "open", index: true },
    resolution: { choice: String, by: String, at: Date, note: String },
    dedupeKey: { type: String, default: null, index: true },
  },
  { timestamps: true }
);

const CouncilTask = mongoose.models.CouncilTask || mongoose.model("CouncilTask", taskSchema);
const CouncilMessage = mongoose.models.CouncilMessage || mongoose.model("CouncilMessage", messageSchema);
const CouncilDecision = mongoose.models.CouncilDecision || mongoose.model("CouncilDecision", decisionSchema);

module.exports = { CouncilDecision, CouncilMessage, CouncilTask };
