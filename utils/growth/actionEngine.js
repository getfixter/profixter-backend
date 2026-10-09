const GrowthAction = require("../../models/GrowthAction");
const GrowthPolicy = require("../../models/GrowthPolicy");
const AdminActivityLog = require("../../models/AdminActivityLog");
const { clampMode, getDefinition, rank } = require("./actionRegistry");

/**
 * The one path by which the growth system acts.
 *
 *   propose()  record the intent; the type's policy decides what happens next
 *   approve()  the owner says yes to a supervised action, which then runs
 *   reject()   the owner says no
 *   rollback() undo a succeeded action whose type knows how
 *   runSweeps() the background work: execute queued actions, verify finished
 *              ones, expire stale approvals, surface interrupted runs
 *
 * GLOBAL SWITCH. Unless GROWTH_ACTIONS_ENABLED is "true", every proposal is
 * recorded in shadow - visible in the Command Center as "would have done",
 * never executed. Deploying the engine and letting it act are two decisions.
 *
 * MULTI-INSTANCE SAFETY. EB runs one to four instances. Every state change is a
 * conditional findOneAndUpdate on the current status, so only one instance can
 * claim an action, and the unique idempotencyKey means a proposal repeated by a
 * retried webhook or a second instance returns the existing record.
 *
 * AUDIT. Every transition writes AdminActivityLog (entityType "growth_action"),
 * next to everything people do in Admin.
 */

const ENTITY_TYPE = "growth_action";
const RUNNING_STALE_MS = 15 * 60 * 1000;
const VERIFY_CLAIM_MS = 10 * 60 * 1000;
const VERIFY_GIVE_UP_MS = 7 * 24 * 60 * 60 * 1000;
const COUNTED_TOWARD_LIMIT = ["approved", "running", "succeeded", "failed", "rolled_back"];

function engineEnabled() {
  return process.env.GROWTH_ACTIONS_ENABLED === "true";
}

function actorRole(actor) {
  return actor?.kind || "system";
}

async function audit(event, action, actor, details = {}) {
  try {
    await AdminActivityLog.create({
      action: `growth_action.${event}`,
      entityType: ENTITY_TYPE,
      entityId: String(action?._id || ""),
      entityName: String(action?.summary || action?.type || ""),
      actorUserId: actor?.userId || null,
      actorName: actor?.name || (actorRole(actor) === "system" ? "Growth engine" : ""),
      actorRole: actorRole(actor),
      details: { type: action?.type, status: action?.status, ...details },
      ipAddress: "",
    });
  } catch (error) {
    // The audit write must never be the reason an action is lost or repeated.
    console.error("Growth audit write failed:", error.message);
  }
}

/** The mode a type runs in now: the stored policy, else the code default, never above the ceiling. */
async function resolveMode(def) {
  const policy = await GrowthPolicy.findOne({ type: def.type }).lean();
  return clampMode(policy?.mode || def.defaultMode, def.maxMode);
}

async function usedToday(type, now) {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return GrowthAction.countDocuments({
    type,
    status: { $in: COUNTED_TOWARD_LIMIT },
    updatedAt: { $gte: since },
  });
}

/**
 * Record an intended action. Returns { action, created, mode }.
 *
 * `idempotencyKey` must identify the real-world thing being acted on (for a
 * recovery email, the Stripe session), so asking twice is harmless.
 */
async function propose(type, payload, { idempotencyKey, rationale = "", proposedBy, now = new Date() } = {}) {
  const def = getDefinition(type);
  if (!def) throw new Error(`Unknown growth action: ${type}`);
  if (!idempotencyKey) throw new Error("propose() needs an idempotencyKey");

  const clean = await def.validate(payload);
  const mode = await resolveMode(def);
  if (mode === "off") return { action: null, created: false, mode };

  let status;
  let heldReason = null;
  if (!engineEnabled()) {
    status = "shadow";
    heldReason = mode === "shadow" ? null : "engine_disabled";
  } else if (mode === "shadow") {
    status = "shadow";
  } else if (mode === "supervised") {
    status = "awaiting_approval";
  } else {
    const perDay = def.limits?.perDay;
    if (perDay && (await usedToday(type, now)) >= perDay) {
      status = "awaiting_approval";
      heldReason = "daily_limit";
    } else {
      status = "approved";
    }
  }

  const doc = {
    type,
    idempotencyKey: String(idempotencyKey),
    status,
    riskTier: def.riskTier,
    modeAtProposal: mode,
    heldReason,
    proposedBy: proposedBy || { kind: "system", name: "Growth engine" },
    summary: String(def.describe(clean) || def.label).slice(0, 300),
    rationale: String(rationale || "").slice(0, 2000),
    subject: def.subjectOf(clean) || {},
    payload: clean,
    expiresAt: status === "awaiting_approval" ? new Date(now.getTime() + def.approvalTtlMs) : null,
  };

  let action;
  try {
    action = await GrowthAction.create(doc);
  } catch (error) {
    if (error?.code === 11000) {
      const existing = await GrowthAction.findOne({ idempotencyKey: doc.idempotencyKey }).lean();
      return { action: existing, created: false, mode };
    }
    throw error;
  }

  await audit("proposed", action, doc.proposedBy, { mode, heldReason });
  return { action: action.toObject(), created: true, mode };
}

/* ------------------------------------------------------------------ */
/* Execution                                                           */
/* ------------------------------------------------------------------ */

function backoffMs(attempts) {
  return Math.min(5 * 60 * 1000 * attempts * attempts, 6 * 60 * 60 * 1000);
}

/**
 * Run one approved action, if this instance wins the claim.
 * Returns the updated action, or null when somebody else has it.
 */
async function execute(actionId, { now = new Date() } = {}) {
  const claimed = await GrowthAction.findOneAndUpdate(
    {
      _id: actionId,
      status: "approved",
      $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
    },
    { $set: { status: "running", claimedAt: now }, $inc: { attempts: 1 } },
    { new: true }
  );
  if (!claimed) return null;

  const def = getDefinition(claimed.type);
  if (!def) {
    claimed.status = "failed";
    claimed.lastError = "No definition for this action type in this build";
    await claimed.save();
    await audit("failed", claimed, null, { error: claimed.lastError });
    return claimed.toObject();
  }

  try {
    const outcome = (await def.execute(claimed.payload, { action: claimed.toObject(), now })) || {};
    /*
     * "Not now": e.g. a marketing text approved at 10pm waits for the morning
     * window instead of being suppressed for good. Not an attempt, not a
     * failure - back in the queue until `until`.
     */
    if (outcome.outcome === "defer") {
      claimed.status = "approved";
      claimed.attempts = Math.max(0, claimed.attempts - 1);
      claimed.nextAttemptAt = outcome.until || new Date(Date.now() + 60 * 60 * 1000);
      await claimed.save();
      return claimed.toObject();
    }
    if (outcome.outcome === "skip") {
      claimed.status = "skipped";
      claimed.result = { reason: outcome.reason || "not_applicable", ...(outcome.result || {}) };
      claimed.verification = { status: "skipped", checkAfter: null, checkedAt: now, detail: "" };
      await claimed.save();
      await audit("skipped", claimed, null, { reason: claimed.result.reason });
      return claimed.toObject();
    }

    claimed.status = "succeeded";
    claimed.executedAt = new Date();
    claimed.result = outcome.result || {};
    claimed.lastError = null;
    claimed.verification = def.verify
      ? { status: "pending", checkAfter: new Date(Date.now() + def.verifyAfterMs), checkedAt: null, detail: "" }
      : { status: "skipped", checkAfter: null, checkedAt: null, detail: "no verifier" };
    await claimed.save();
    await audit("succeeded", claimed, null, {});
    return claimed.toObject();
  } catch (error) {
    const message = String(error?.message || error).slice(0, 500);
    const permanent = error?.permanent === true || claimed.attempts >= def.maxAttempts;
    claimed.lastError = message;
    if (permanent) {
      claimed.status = "failed";
      await claimed.save();
      await audit("failed", claimed, null, { error: message, attempts: claimed.attempts });
      await recordFailure(def, `run failed: ${message}`);
    } else {
      claimed.status = "approved";
      claimed.nextAttemptAt = new Date(Date.now() + backoffMs(claimed.attempts));
      await claimed.save();
      await audit("retry_scheduled", claimed, null, { error: message, attempts: claimed.attempts });
    }
    return claimed.toObject();
  }
}

/* ------------------------------------------------------------------ */
/* Trust: promotion and demotion                                       */
/* ------------------------------------------------------------------ */

async function recordVerifiedSuccess(def) {
  const policy = await GrowthPolicy.findOneAndUpdate(
    { type: def.type },
    {
      $inc: { verifiedSuccesses: 1, consecutiveVerifiedSuccesses: 1 },
      $setOnInsert: { mode: def.defaultMode, "setBy.kind": "owner", "setBy.note": "code default" },
    },
    { upsert: true, new: true }
  );

  const mode = clampMode(policy.mode, def.maxMode);
  if (
    mode === "supervised" &&
    def.promoteAfter &&
    rank(def.maxMode) >= rank("autonomous") &&
    policy.consecutiveVerifiedSuccesses >= def.promoteAfter
  ) {
    const promoted = await GrowthPolicy.findOneAndUpdate(
      { type: def.type, mode: "supervised" },
      {
        $set: {
          mode: "autonomous",
          promotedAt: new Date(),
          setBy: {
            kind: "auto_promotion",
            userId: null,
            note: `${policy.consecutiveVerifiedSuccesses} consecutive verified successes`,
            at: new Date(),
          },
        },
      },
      { new: true }
    );
    if (promoted) {
      await audit("policy_promoted", { _id: promoted._id, type: def.type, summary: def.label }, null, {
        to: "autonomous",
        streak: policy.consecutiveVerifiedSuccesses,
      });
    }
  }
}

async function recordFailure(def, reason) {
  const policy = await GrowthPolicy.findOneAndUpdate(
    { type: def.type },
    {
      $inc: { failures: 1 },
      $set: { consecutiveVerifiedSuccesses: 0, lastFailureAt: new Date() },
      $setOnInsert: { mode: def.defaultMode, "setBy.kind": "owner", "setBy.note": "code default" },
    },
    { upsert: true, new: true }
  );

  if (clampMode(policy.mode, def.maxMode) === "autonomous") {
    const demoted = await GrowthPolicy.findOneAndUpdate(
      { type: def.type, mode: "autonomous" },
      {
        $set: {
          mode: "supervised",
          demotedAt: new Date(),
          setBy: { kind: "auto_demotion", userId: null, note: String(reason).slice(0, 300), at: new Date() },
        },
      },
      { new: true }
    );
    if (demoted) {
      await audit("policy_demoted", { _id: demoted._id, type: def.type, summary: def.label }, null, {
        to: "supervised",
        reason,
      });
    }
  }
}

/** Owner sets a type's mode. Refuses anything above the type's ceiling. */
async function setPolicyMode(type, mode, actor, note = "") {
  const def = getDefinition(type);
  if (!def) throw Object.assign(new Error(`Unknown growth action: ${type}`), { status: 404 });
  rank(mode);
  if (rank(mode) > rank(def.maxMode)) {
    throw Object.assign(new Error(`${def.label} cannot be set above ${def.maxMode}`), { status: 400 });
  }
  const policy = await GrowthPolicy.findOneAndUpdate(
    { type },
    {
      $set: {
        mode,
        setBy: { kind: "owner", userId: actor?.userId || null, note: String(note).slice(0, 300), at: new Date() },
        // A fresh grant of trust starts a fresh streak.
        ...(mode === "supervised" ? { consecutiveVerifiedSuccesses: 0 } : {}),
      },
    },
    { upsert: true, new: true }
  );
  await audit("policy_set", { _id: policy._id, type, summary: def.label }, actor, { mode, note });
  return policy.toObject();
}

/* ------------------------------------------------------------------ */
/* Owner decisions                                                     */
/* ------------------------------------------------------------------ */

function httpError(message, status) {
  return Object.assign(new Error(message), { status });
}

async function approve(actionId, actor, note = "") {
  const action = await GrowthAction.findOneAndUpdate(
    { _id: actionId, status: "awaiting_approval" },
    {
      $set: {
        status: "approved",
        decidedBy: actor,
        decidedAt: new Date(),
        decisionNote: String(note).slice(0, 500),
        nextAttemptAt: null,
        expiresAt: null,
      },
    },
    { new: true }
  );
  if (!action) throw httpError("This action is no longer waiting for approval.", 409);
  await audit("approved", action, actor, { note });
  if (!engineEnabled()) return action.toObject();
  return (await execute(action._id)) || action.toObject();
}

async function reject(actionId, actor, note = "") {
  const action = await GrowthAction.findOneAndUpdate(
    { _id: actionId, status: "awaiting_approval" },
    {
      $set: {
        status: "rejected",
        decidedBy: actor,
        decidedAt: new Date(),
        decisionNote: String(note).slice(0, 500),
        expiresAt: null,
      },
    },
    { new: true }
  );
  if (!action) throw httpError("This action is no longer waiting for approval.", 409);
  // A "no" is evidence too: the streak toward unattended running starts again.
  await GrowthPolicy.updateOne({ type: action.type }, { $set: { consecutiveVerifiedSuccesses: 0 } });
  await audit("rejected", action, actor, { note });
  return action.toObject();
}

async function rollback(actionId, actor) {
  const current = await GrowthAction.findById(actionId);
  if (!current) throw httpError("Action not found.", 404);
  const def = getDefinition(current.type);
  if (!def?.rollback) throw httpError("This kind of action cannot be undone automatically.", 400);
  if (current.status !== "succeeded") throw httpError("Only a succeeded action can be rolled back.", 409);

  const result = await def.rollback(current.toObject(), { actor });
  const action = await GrowthAction.findOneAndUpdate(
    { _id: actionId, status: "succeeded" },
    { $set: { status: "rolled_back", rollback: { performedAt: new Date(), by: actor, result: result || {} } } },
    { new: true }
  );
  if (!action) throw httpError("The action changed while it was being rolled back.", 409);
  await audit("rolled_back", action, actor, { result: result || {} });
  return action.toObject();
}

/* ------------------------------------------------------------------ */
/* Sweeps                                                              */
/* ------------------------------------------------------------------ */

async function executionSweep({ now = new Date(), limit = 20 } = {}) {
  if (!engineEnabled()) return { executed: 0 };
  const due = await GrowthAction.find({
    status: "approved",
    $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
  })
    .sort({ createdAt: 1 })
    .limit(limit)
    .select("_id")
    .lean();
  let executed = 0;
  for (const { _id } of due) {
    if (await execute(_id, { now })) executed += 1;
  }
  return { executed };
}

async function verificationSweep({ now = new Date(), limit = 50 } = {}) {
  const due = await GrowthAction.find({
    status: "succeeded",
    "verification.status": "pending",
    "verification.checkAfter": { $lte: now },
  })
    .limit(limit)
    .select("_id")
    .lean();

  let checked = 0;
  for (const { _id } of due) {
    // Claim by pushing checkAfter out, so a second instance skips it.
    const action = await GrowthAction.findOneAndUpdate(
      { _id, "verification.status": "pending", "verification.checkAfter": { $lte: now } },
      { $set: { "verification.checkAfter": new Date(now.getTime() + VERIFY_CLAIM_MS) } },
      { new: true }
    );
    if (!action) continue;
    const def = getDefinition(action.type);
    if (!def?.verify) continue;

    let verdict;
    try {
      verdict = (await def.verify(action.toObject(), { now })) || {};
    } catch (error) {
      verdict = { passed: null, detail: `verifier error: ${error.message}` };
    }

    if (verdict.passed === true || verdict.passed === false) {
      action.verification.status = verdict.passed ? "passed" : "failed";
      action.verification.checkedAt = now;
      action.verification.detail = String(verdict.detail || "").slice(0, 500);
      await action.save();
      await audit(verdict.passed ? "verified" : "verification_failed", action, null, { detail: verdict.detail });
      if (verdict.passed) await recordVerifiedSuccess(def);
      else await recordFailure(def, `verification failed: ${verdict.detail || ""}`);
      checked += 1;
    } else if (action.executedAt && now - action.executedAt > VERIFY_GIVE_UP_MS) {
      action.verification.status = "skipped";
      action.verification.checkedAt = now;
      action.verification.detail = `inconclusive: ${verdict.detail || "no signal"}`;
      await action.save();
    }
  }
  return { checked };
}

async function expirySweep({ now = new Date() } = {}) {
  const stale = await GrowthAction.find({ status: "awaiting_approval", expiresAt: { $lte: now } })
    .select("_id")
    .limit(100)
    .lean();
  let expired = 0;
  for (const { _id } of stale) {
    const action = await GrowthAction.findOneAndUpdate(
      { _id, status: "awaiting_approval", expiresAt: { $lte: now } },
      { $set: { status: "expired" } },
      { new: true }
    );
    if (action) {
      expired += 1;
      await audit("expired", action, null, {});
    }
  }
  return { expired };
}

/**
 * A run that never finished. The instance died, or a deploy replaced it,
 * somewhere inside execute(). Whether the side effect happened is unknown, so
 * it is NOT retried blindly - a second recovery email is worse than none. It
 * goes back to the owner with the reason, and counts as a failure for trust.
 */
async function interruptedSweep({ now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - RUNNING_STALE_MS);
  const stuck = await GrowthAction.find({ status: "running", claimedAt: { $lte: cutoff } })
    .select("_id")
    .limit(50)
    .lean();
  let surfaced = 0;
  for (const { _id } of stuck) {
    const action = await GrowthAction.findOneAndUpdate(
      { _id, status: "running", claimedAt: { $lte: cutoff } },
      {
        $set: {
          status: "awaiting_approval",
          heldReason: "interrupted",
          lastError: "The run was interrupted; it may or may not have taken effect.",
          expiresAt: new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000),
        },
      },
      { new: true }
    );
    if (!action) continue;
    surfaced += 1;
    await audit("interrupted", action, null, {});
    const def = getDefinition(action.type);
    if (def) await recordFailure(def, "run interrupted");
  }
  return { surfaced };
}

async function runSweeps({ now = new Date() } = {}) {
  const interrupted = await interruptedSweep({ now });
  const executed = await executionSweep({ now });
  const verified = await verificationSweep({ now });
  const expired = await expirySweep({ now });
  return { ...interrupted, ...executed, ...verified, ...expired };
}

module.exports = {
  approve,
  engineEnabled,
  execute,
  executionSweep,
  expirySweep,
  interruptedSweep,
  propose,
  reject,
  resolveMode,
  rollback,
  runSweeps,
  setPolicyMode,
  verificationSweep,
};
