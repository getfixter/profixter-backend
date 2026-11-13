/**
 * Idempotency for externally visible Admin actions.
 *
 *   const result = await runIdempotent({ req, action: "job.transition", key, entityId }, async () => ({
 *     httpStatus: 200,
 *     body: {...},
 *   }));
 *   res.status(result.httpStatus).json(result.body);
 *
 * - First call with a key: claims it, runs `work`, stores { httpStatus, body }.
 * - Same key again after it finished: returns the stored result, runs nothing
 *   (`replayed: true`).
 * - Same key while the first is still running: 409 IDEMPOTENCY_IN_PROGRESS.
 * - `work` throws: the claim is removed, so a retry with the same key runs.
 * - Only 2xx results are stored; a 4xx refusal releases the key too, because
 *   the client must be able to fix the request and try again.
 */
const AdminIdempotencyRecord = require("../models/AdminIdempotencyRecord");

const TTL_MS = 24 * 60 * 60 * 1000;
const KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,120}$/;

class IdempotencyError extends Error {
  constructor(code, message, statusCode) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function readIdempotencyKey(value) {
  const key = String(value || "").trim();
  if (!key) throw new IdempotencyError("IDEMPOTENCY_KEY_REQUIRED", "idempotencyKey is required for this action.", 400);
  if (!KEY_PATTERN.test(key)) throw new IdempotencyError("IDEMPOTENCY_KEY_INVALID", "idempotencyKey must be 8-120 letters, digits, dashes or underscores.", 400);
  return key;
}

function scopeFor(req, action) {
  return `${action}:${String(req?.accessUser?._id || req?.user?.id || "anonymous")}`;
}

async function runIdempotent({ req, action, key, entityId = "" }, work) {
  const scope = scopeFor(req, action);
  const existing = await AdminIdempotencyRecord.findOne({ scope, key }).lean();
  if (existing) {
    if (existing.entityId && entityId && existing.entityId !== String(entityId)) {
      throw new IdempotencyError("IDEMPOTENCY_KEY_REUSED", "This idempotencyKey was already used for a different record.", 409);
    }
    if (existing.status === "completed") {
      return { httpStatus: existing.httpStatus, body: existing.response, replayed: true };
    }
    throw new IdempotencyError("IDEMPOTENCY_IN_PROGRESS", "This action is already being processed.", 409);
  }

  let claim;
  try {
    claim = await AdminIdempotencyRecord.create({
      key,
      scope,
      actorUserId: req?.accessUser?._id || null,
      entityId: String(entityId || ""),
      status: "pending",
      expiresAt: new Date(Date.now() + TTL_MS),
    });
  } catch (error) {
    if (error?.code === 11000) {
      // Lost the race to an identical request: report it the same way.
      const winner = await AdminIdempotencyRecord.findOne({ scope, key }).lean();
      if (winner?.status === "completed") return { httpStatus: winner.httpStatus, body: winner.response, replayed: true };
      throw new IdempotencyError("IDEMPOTENCY_IN_PROGRESS", "This action is already being processed.", 409);
    }
    throw error;
  }

  let result;
  try {
    result = await work();
  } catch (error) {
    await AdminIdempotencyRecord.deleteOne({ _id: claim._id }).catch(() => {});
    throw error;
  }
  const httpStatus = Number(result?.httpStatus || 200);
  if (httpStatus >= 200 && httpStatus < 300) {
    // Stored as plain JSON so a replay is byte-for-byte the same answer.
    const body = JSON.parse(JSON.stringify(result.body ?? null));
    await AdminIdempotencyRecord.updateOne({ _id: claim._id }, { $set: { status: "completed", httpStatus, response: body } });
    return { httpStatus, body, replayed: false };
  }
  await AdminIdempotencyRecord.deleteOne({ _id: claim._id }).catch(() => {});
  return { httpStatus, body: result.body, replayed: false };
}

module.exports = {
  IdempotencyError,
  TTL_MS,
  readIdempotencyKey,
  runIdempotent,
};
