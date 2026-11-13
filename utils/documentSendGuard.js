/**
 * Duplicate protection for customer-facing document sends (agreement, change
 * order and invoice emails; native signature requests and reminders).
 *
 *   const result = await runDocumentSend(
 *     { req, action: "contract.email", entityId: contract._id, recipient },
 *     async () => ({ httpStatus: 200, body: {...} })
 *   );
 *   res.status(result.httpStatus).json(result.body);
 *
 * Two layers:
 *
 * 1. `idempotencyKey` in the JSON body (the `Idempotency-Key` header is read
 *    as a fallback but never required; CORS does not allow it from browsers).
 *    Delegates to utils/adminIdempotency: a replay of the same key returns the
 *    stored answer with `replayed: true` and sends nothing.
 *
 * 2. No key (the frontend released before this change): a 60-second window
 *    per action + document + recipient, shared by every admin. A second send
 *    of the same document to the same address inside the window sends nothing
 *    and returns the first answer with `duplicate: true`. If the first send is
 *    still running, the second waits briefly for it; if it never finishes the
 *    second gets 409 SEND_IN_PROGRESS. A different recipient is a different
 *    window, so it sends.
 *
 * Only 2xx answers are remembered; a failure or refusal releases the claim so
 * the admin can fix the problem and retry at once.
 */
const crypto = require("crypto");
const AdminIdempotencyRecord = require("../models/AdminIdempotencyRecord");
const { IdempotencyError, readIdempotencyKey, runIdempotent } = require("./adminIdempotency");

const DUPLICATE_WINDOW_MS = 60 * 1000;
const WAIT_FOR_FIRST_MS = 10 * 1000;
const WAIT_STEP_MS = 200;

function rawKeyFrom(req) {
  const fromBody = req?.body?.idempotencyKey;
  if (fromBody !== undefined && fromBody !== null && String(fromBody).trim() !== "") return fromBody;
  const fromHeader = typeof req?.get === "function" ? req.get("Idempotency-Key") : "";
  return fromHeader || "";
}

function guardKey(entityId, recipient) {
  return crypto
    .createHash("sha256")
    .update(`${String(entityId)}|${String(recipient || "").trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, 64);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function finish(result, extra) {
  const body = result.body && typeof result.body === "object" && !Array.isArray(result.body)
    ? { ...result.body, ...extra }
    : result.body;
  return { httpStatus: result.httpStatus, body };
}

async function claimWindow(scope, key, entityId, req) {
  const now = Date.now();
  // A record past its window is dead even before the TTL monitor removes it.
  await AdminIdempotencyRecord.deleteOne({ scope, key, expiresAt: { $lte: new Date(now) } });
  try {
    return await AdminIdempotencyRecord.create({
      key,
      scope,
      actorUserId: req?.accessUser?._id || null,
      entityId: String(entityId || ""),
      status: "pending",
      expiresAt: new Date(now + DUPLICATE_WINDOW_MS),
    });
  } catch (error) {
    if (error?.code === 11000) return null;
    throw error;
  }
}

async function waitForFirst(scope, key) {
  const deadline = Date.now() + WAIT_FOR_FIRST_MS;
  for (;;) {
    const existing = await AdminIdempotencyRecord.findOne({ scope, key }).lean();
    if (!existing) return { gone: true };
    if (existing.status === "completed") return { record: existing };
    if (Date.now() >= deadline) return { pending: true };
    await sleep(WAIT_STEP_MS);
  }
}

async function runWindowed({ req, action, entityId, recipient, storeBody, stillCurrent }, work) {
  const scope = `send-guard:${action}`;
  const key = guardKey(entityId, recipient);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const claim = await claimWindow(scope, key, entityId, req);
    if (claim) {
      let result;
      try {
        result = await work();
      } catch (error) {
        await AdminIdempotencyRecord.deleteOne({ _id: claim._id }).catch(() => {});
        throw error;
      }
      const httpStatus = Number(result?.httpStatus || 200);
      if (httpStatus >= 200 && httpStatus < 300) {
        const body = JSON.parse(JSON.stringify(result.body ?? null));
        const stored = typeof storeBody === "function" ? storeBody(JSON.parse(JSON.stringify(body))) : body;
        await AdminIdempotencyRecord.updateOne(
          { _id: claim._id },
          { $set: { status: "completed", httpStatus, response: stored } }
        );
      } else {
        await AdminIdempotencyRecord.deleteOne({ _id: claim._id }).catch(() => {});
      }
      return { httpStatus, body: result.body };
    }

    const waited = await waitForFirst(scope, key);
    if (waited.record && typeof stillCurrent === "function" && !(await stillCurrent(waited.record.response))) {
      // What the first send produced is gone (e.g. its signing request expired
      // or was revoked), so this is a new send, not a repeat.
      await AdminIdempotencyRecord.deleteOne({ _id: waited.record._id }).catch(() => {});
      continue;
    }
    if (waited.record) {
      return finish({ httpStatus: waited.record.httpStatus, body: waited.record.response }, { duplicate: true });
    }
    if (waited.pending) {
      throw new IdempotencyError(
        "SEND_IN_PROGRESS",
        "This document is already being sent to this address. Check its history before sending again.",
        409
      );
    }
    // The first attempt failed and released the window: try to claim it.
  }
  throw new IdempotencyError("SEND_IN_PROGRESS", "This document is already being sent to this address.", 409);
}

/**
 * `stillCurrent(previousBody)` (optional, window only): resolve false when the
 * first send's result no longer stands, so the repeat sends after all.
 */
async function runDocumentSend({ req, action, entityId, recipient = "", storeBody = null, stillCurrent = null }, work) {
  const raw = rawKeyFrom(req);
  if (raw) {
    const key = readIdempotencyKey(raw);
    const result = await runIdempotent({ req, action, key, entityId: String(entityId || ""), storeBody }, work);
    return result.replayed ? finish(result, { replayed: true }) : { httpStatus: result.httpStatus, body: result.body };
  }
  return runWindowed({ req, action, entityId, recipient, storeBody, stillCurrent }, work);
}

/** Maps a guard refusal to `{message, code}`; returns false for other errors. */
function sendGuardError(res, error) {
  if (!(error instanceof IdempotencyError)) return false;
  res.status(error.statusCode || 409).json({ message: error.message, code: error.code });
  return true;
}

module.exports = {
  DUPLICATE_WINDOW_MS,
  runDocumentSend,
  sendGuardError,
};
