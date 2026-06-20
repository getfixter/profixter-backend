const MINUTE_MS = 60 * 1000;

const REVIEW_REQUEST_DELAY_MS = 60 * MINUTE_MS;
const REVIEW_REQUEST_LOCK_MS = 10 * MINUTE_MS;

function normalizeStatus(status) {
  return String(status || "").trim().toLowerCase();
}

function isCompletionTransition(previousStatus, nextStatus) {
  return (
    normalizeStatus(previousStatus) !== "completed" &&
    normalizeStatus(nextStatus) === "completed"
  );
}

function hasValue(value) {
  return value !== undefined && value !== null;
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
    String(value || "").trim().toLowerCase()
  );
}

function evaluateReviewRequest(booking, nowInput = new Date()) {
  const nowMs = new Date(nowInput).getTime();
  const completedAtMs = new Date(booking?.completedAt).getTime();

  if (normalizeStatus(booking?.status) !== "completed") {
    return { eligible: false, reason: "status_not_completed" };
  }
  if (!validEmail(booking?.email)) {
    return { eligible: false, reason: "missing_or_invalid_email" };
  }
  if (hasValue(booking?.reviewRequestSentAt)) {
    return { eligible: false, reason: "already_sent" };
  }
  if (hasValue(booking?.reviewRequestSkippedAt)) {
    return { eligible: false, reason: "already_skipped" };
  }
  if (!Number.isFinite(completedAtMs)) {
    return { eligible: false, reason: "missing_or_invalid_completed_at" };
  }

  const minutesSinceCompletion = (nowMs - completedAtMs) / MINUTE_MS;
  if (minutesSinceCompletion < 60) {
    return {
      eligible: false,
      reason: "waiting_60_minutes",
      minutesSinceCompletion,
    };
  }

  const lockExpiresAtMs = new Date(booking?.reviewRequestLockExpiresAt).getTime();
  if (Number.isFinite(lockExpiresAtMs) && lockExpiresAtMs > nowMs) {
    return {
      eligible: false,
      reason: "active_lock",
      minutesSinceCompletion,
    };
  }

  return {
    eligible: true,
    reason: "eligible",
    minutesSinceCompletion,
  };
}

module.exports = {
  MINUTE_MS,
  REVIEW_REQUEST_DELAY_MS,
  REVIEW_REQUEST_LOCK_MS,
  evaluateReviewRequest,
  isCompletionTransition,
  normalizeStatus,
  validEmail,
};
