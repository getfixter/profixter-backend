const mongoose = require("mongoose");

/**
 * One thing the growth system wants to do, did, or was told not to do.
 *
 * Every automated growth activity - a recovery email, a follow-up text, later a
 * budget change proposed by an agent - is recorded here BEFORE it happens, and
 * the record is the only path to doing it. That is what makes the system
 * auditable and lets the owner hand over control gradually: the policy for the
 * action's type (models/GrowthPolicy) decides whether a new record waits for
 * approval, runs on its own, or is only recorded to show what would have run.
 *
 * Lifecycle:
 *
 *   shadow             recorded only; the type is in shadow mode
 *   awaiting_approval  supervised; waits for the owner
 *   approved           approved (or autonomous) and queued to run
 *   running            claimed by exactly one instance
 *   succeeded          ran; `verification` then confirms it had its effect
 *   failed             ran and failed for good (after retries)
 *   skipped            no longer applicable when it came to run (e.g. the
 *                      customer subscribed in the meantime) - not a failure
 *   rejected / expired the owner said no, or nobody decided in time
 *   rolled_back        undone after succeeding
 *
 * `idempotencyKey` is unique: proposing the same thing twice returns the first
 * record, so a retried webhook can never send a second email.
 */
const STATUSES = [
  "shadow",
  "awaiting_approval",
  "approved",
  "running",
  "succeeded",
  "failed",
  "skipped",
  "rejected",
  "expired",
  "rolled_back",
];

const actorSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ["system", "agent", "owner", "staff"], default: "system" },
    name: { type: String, default: "" },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { _id: false }
);

const growthActionSchema = new mongoose.Schema(
  {
    type: { type: String, required: true, index: true },
    idempotencyKey: { type: String, required: true, unique: true },
    status: { type: String, enum: STATUSES, required: true, index: true },

    /* The policy that applied when it was proposed, kept for the audit trail. */
    riskTier: { type: String, enum: ["low", "medium", "high"], required: true },
    modeAtProposal: { type: String, enum: ["shadow", "supervised", "autonomous"], required: true },
    /* Why an autonomous type still waited: "daily_limit", "engine_disabled"... */
    heldReason: { type: String, default: null },

    proposedBy: { type: actorSchema, default: () => ({}) },
    summary: { type: String, default: "" },
    rationale: { type: String, default: "" },
    plain: { type: String, default: "" }, // the owner-facing version, in everyday English
    subject: {
      entityType: { type: String, default: null },
      entityId: { type: String, default: null },
    },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },

    decidedBy: { type: actorSchema, default: null },
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, default: "" },

    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: null },
    claimedAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    executedAt: { type: Date, default: null },
    result: { type: mongoose.Schema.Types.Mixed, default: null },

    verification: {
      status: { type: String, enum: ["pending", "passed", "failed", "skipped", null], default: null },
      checkAfter: { type: Date, default: null },
      checkedAt: { type: Date, default: null },
      detail: { type: String, default: "" },
    },

    rollback: {
      performedAt: { type: Date, default: null },
      by: { type: actorSchema, default: null },
      result: { type: mongoose.Schema.Types.Mixed, default: null },
    },

    expiresAt: { type: Date, default: null },
  },
  { timestamps: true, minimize: false }
);

growthActionSchema.index({ status: 1, createdAt: -1 });
growthActionSchema.index({ type: 1, createdAt: -1 });
growthActionSchema.index({ type: 1, executedAt: -1 });
growthActionSchema.index({ status: 1, nextAttemptAt: 1 });
growthActionSchema.index({ "verification.status": 1, "verification.checkAfter": 1 });

growthActionSchema.statics.STATUSES = STATUSES;

module.exports = mongoose.models.GrowthAction || mongoose.model("GrowthAction", growthActionSchema);
