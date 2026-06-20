const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

const REMINDER_WINDOW_MS = 15 * MINUTE_MS;
const REMINDER_24H_MS = 24 * HOUR_MS;
const REMINDER_60M_MS = HOUR_MS;
const REMINDER_24H_CATCHUP_MIN_MS = 2 * HOUR_MS;
const REMINDER_LOCK_STALE_MS = 10 * MINUTE_MS;

function normalizeStatus(status) {
  return String(status || "").trim().toLowerCase();
}

function isConfirmedStatus(status) {
  return normalizeStatus(status) === "confirmed";
}

function isTerminalStatus(status) {
  return [
    "canceled",
    "cancelled",
    "completed",
    "complete",
    "done",
    "no-show",
    "noshow",
    "failed",
  ].includes(normalizeStatus(status));
}

function hasValue(value) {
  return value !== undefined && value !== null;
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
    String(value || "").trim().toLowerCase()
  );
}

function bookingStartMs(booking) {
  const value = new Date(booking?.date).getTime();
  return Number.isFinite(value) ? value : null;
}

function evaluate24HourReminder(booking, nowInput = new Date()) {
  const nowMs = new Date(nowInput).getTime();
  const startMs = bookingStartMs(booking);

  if (!isConfirmedStatus(booking?.status) || isTerminalStatus(booking?.status)) {
    return { eligible: false, reason: "status_not_confirmed" };
  }
  if (!validEmail(booking?.email)) {
    return { eligible: false, reason: "missing_or_invalid_email" };
  }
  if (hasValue(booking?.reminder24hSentAt)) {
    return { eligible: false, reason: "already_sent" };
  }
  if (hasValue(booking?.reminder24hSkippedAt)) {
    return { eligible: false, reason: "already_skipped" };
  }
  if (startMs === null) {
    return { eligible: false, reason: "invalid_booking_date" };
  }

  const msUntilBooking = startMs - nowMs;
  if (msUntilBooking <= 0) {
    return { eligible: false, reason: "appointment_started", msUntilBooking };
  }
  if (msUntilBooking <= REMINDER_24H_CATCHUP_MIN_MS) {
    return {
      eligible: false,
      shouldMarkSkipped: true,
      reason: "less_than_or_equal_to_2h_remaining",
      msUntilBooking,
    };
  }
  if (msUntilBooking > REMINDER_24H_MS + REMINDER_WINDOW_MS) {
    return { eligible: false, reason: "more_than_24h15m_away", msUntilBooking };
  }

  const mode =
    msUntilBooking >= REMINDER_24H_MS - REMINDER_WINDOW_MS
      ? "scheduled_window"
      : "catch_up";

  return {
    eligible: true,
    reason: mode,
    mode,
    msUntilBooking,
  };
}

function evaluate60MinuteReminder(booking, nowInput = new Date()) {
  const nowMs = new Date(nowInput).getTime();
  const startMs = bookingStartMs(booking);

  if (!isConfirmedStatus(booking?.status) || isTerminalStatus(booking?.status)) {
    return { eligible: false, reason: "status_not_confirmed" };
  }
  if (!validEmail(booking?.email)) {
    return { eligible: false, reason: "missing_or_invalid_email" };
  }
  if (hasValue(booking?.reminder60mSentAt)) {
    return { eligible: false, reason: "already_sent" };
  }
  if (startMs === null) {
    return { eligible: false, reason: "invalid_booking_date" };
  }

  const msUntilBooking = startMs - nowMs;
  const eligible =
    msUntilBooking <= REMINDER_60M_MS + REMINDER_WINDOW_MS &&
    msUntilBooking >= -REMINDER_WINDOW_MS;

  return {
    eligible,
    reason: eligible ? "scheduled_window" : "outside_60m_window",
    msUntilBooking,
  };
}

module.exports = {
  HOUR_MS,
  REMINDER_24H_CATCHUP_MIN_MS,
  REMINDER_24H_MS,
  REMINDER_60M_MS,
  REMINDER_LOCK_STALE_MS,
  REMINDER_WINDOW_MS,
  evaluate24HourReminder,
  evaluate60MinuteReminder,
  isConfirmedStatus,
  isTerminalStatus,
};
