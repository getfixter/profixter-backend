const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * When a booking reminder is due, and until when it is still worth sending.
 *
 * This is a due-state model, not a time-window model. A reminder becomes due at
 * a fixed offset before the appointment and stays due until it has either been
 * sent or become pointless. Nothing depends on a particular cron cycle running
 * at a particular minute, which is what the old narrow windows depended on.
 *
 * The distinction matters because the scheduler is an in-process timer: it does
 * not run during a deploy, an instance replacement or a crash. Under the old
 * model a reminder whose window elapsed inside such a gap was lost silently and
 * permanently. Under this one it is simply still due when the process returns,
 * and goes out late rather than not at all.
 *
 * "Late rather than never" has a limit, and the limit is usefulness, not
 * bookkeeping. A 24-hour reminder delivered 40 minutes before the visit is not
 * a reminder, it is a surprise, so below MIN_LEAD it is abandoned deliberately
 * and recorded as skipped with a reason. Every abandonment is explicit; none is
 * an accident of timing.
 */

/** A reminder becomes due this far ahead of the appointment. */
const REMINDER_24H_LEAD_MS = 24 * HOUR_MS;
const REMINDER_60M_LEAD_MS = HOUR_MS;

/**
 * Below this much notice, a 24-hour reminder is abandoned rather than sent.
 * Two hours is the point at which "tomorrow" stops being the right word and the
 * customer is better served by the 60-minute reminder that is already coming.
 */
const REMINDER_24H_MIN_LEAD_MS = 2 * HOUR_MS;

/**
 * A 60-minute reminder is still worth sending shortly after the hour turns, and
 * even a little after the appointment start, because "we are on the way" is
 * true then. After this it is abandoned.
 */
const REMINDER_60M_GRACE_AFTER_START_MS = 15 * MINUTE_MS;

/** A claimed reminder whose worker vanished is reclaimable after this. */
const REMINDER_LOCK_STALE_MS = 10 * MINUTE_MS;

/**
 * Give up after this many failed sends. Without a ceiling a permanently
 * undeliverable address would be retried every minute until the appointment,
 * burning provider reputation and hiding real failures in the noise.
 */
const REMINDER_MAX_ATTEMPTS = 5;

const TERMINAL_STATUSES = [
  "canceled",
  "cancelled",
  "completed",
  "complete",
  "done",
  "no-show",
  "noshow",
  "failed",
];

function normalizeStatus(status) {
  return String(status || "").trim().toLowerCase();
}

function isConfirmedStatus(status) {
  return normalizeStatus(status) === "confirmed";
}

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.includes(normalizeStatus(status));
}

function hasValue(value) {
  return value !== undefined && value !== null;
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
    String(value || "").trim().toLowerCase()
  );
}

/**
 * The appointment instant, or null if there isn't a real one.
 *
 * The emptiness check is not redundant: `new Date(null)` is the epoch, not an
 * invalid date, so a booking with a null date would otherwise read as an
 * appointment in 1970 and be quietly abandoned as "already started" rather than
 * surfaced as the bad data it is.
 */
function bookingStartMs(booking) {
  const raw = booking?.date;
  if (raw === null || raw === undefined || raw === "") return null;
  const value = new Date(raw).getTime();
  return Number.isFinite(value) ? value : null;
}

/**
 * The instant each reminder becomes due.
 *
 * Derived from the appointment rather than stored, so a reschedule cannot leave
 * a stale due time behind: change the date and the due times move with it, for
 * free. All arithmetic is on absolute instants, so it is timezone and DST
 * independent. New York only ever appears in what a human reads.
 */
function reminderDueAt(booking, leadMs) {
  const startMs = bookingStartMs(booking);
  return startMs === null ? null : new Date(startMs - leadMs);
}

function due24HourAt(booking) {
  return reminderDueAt(booking, REMINDER_24H_LEAD_MS);
}

function due60MinuteAt(booking) {
  return reminderDueAt(booking, REMINDER_60M_LEAD_MS);
}

/** Conditions that stop a reminder regardless of which one it is. */
function commonBlock(booking, sentField, skippedField) {
  if (!isConfirmedStatus(booking?.status) || isTerminalStatus(booking?.status)) {
    return { eligible: false, reason: "status_not_confirmed" };
  }
  if (!validEmail(booking?.email)) {
    return { eligible: false, reason: "missing_or_invalid_email" };
  }
  if (hasValue(booking?.[sentField])) {
    return { eligible: false, reason: "already_sent" };
  }
  if (hasValue(booking?.[skippedField])) {
    return { eligible: false, reason: "already_skipped" };
  }
  if (bookingStartMs(booking) === null) {
    return { eligible: false, reason: "invalid_booking_date" };
  }
  return null;
}

function attemptsExceeded(booking, attemptsField) {
  return Number(booking?.[attemptsField] || 0) >= REMINDER_MAX_ATTEMPTS;
}

/**
 * The 24-hour reminder.
 *
 * Due from 24 hours before the appointment. Stays due, and is sent late if the
 * scheduler was not running, until fewer than two hours remain. A booking
 * created inside its own 24-hour window is due immediately, which is what makes
 * a short-notice booking still get one reminder rather than none.
 */
function evaluate24HourReminder(booking, nowInput = new Date()) {
  const blocked = commonBlock(
    booking,
    "reminder24hSentAt",
    "reminder24hSkippedAt"
  );
  if (blocked) return blocked;

  const nowMs = new Date(nowInput).getTime();
  const msUntilBooking = bookingStartMs(booking) - nowMs;

  if (msUntilBooking <= 0) {
    return {
      eligible: false,
      shouldMarkSkipped: true,
      reason: "appointment_started",
      msUntilBooking,
    };
  }
  if (msUntilBooking < REMINDER_24H_MIN_LEAD_MS) {
    return {
      eligible: false,
      shouldMarkSkipped: true,
      reason: "less_than_2h_notice",
      msUntilBooking,
    };
  }
  if (msUntilBooking > REMINDER_24H_LEAD_MS) {
    return { eligible: false, reason: "not_yet_due", msUntilBooking };
  }
  if (attemptsExceeded(booking, "reminder24hAttempts")) {
    return {
      eligible: false,
      shouldMarkSkipped: true,
      reason: "max_attempts_exceeded",
      msUntilBooking,
    };
  }

  // On time or recovered: the same email either way, but the distinction is
  // worth logging, because a rising catch-up rate means the scheduler is
  // missing cycles and that is worth knowing before customers notice.
  const mode =
    msUntilBooking >= REMINDER_24H_LEAD_MS - 5 * MINUTE_MS
      ? "on_time"
      : "catch_up";

  return { eligible: true, reason: mode, mode, msUntilBooking };
}

/**
 * The 60-minute reminder.
 *
 * Due from an hour before, and still sent up to fifteen minutes after the
 * appointment start. Its recovery window is necessarily short: unlike the
 * 24-hour reminder there is no honest way to deliver it late, because once the
 * visit is under way there is nothing left to remind anyone about.
 */
function evaluate60MinuteReminder(booking, nowInput = new Date()) {
  const blocked = commonBlock(
    booking,
    "reminder60mSentAt",
    "reminder60mSkippedAt"
  );
  if (blocked) return blocked;

  const nowMs = new Date(nowInput).getTime();
  const msUntilBooking = bookingStartMs(booking) - nowMs;

  if (msUntilBooking < -REMINDER_60M_GRACE_AFTER_START_MS) {
    return {
      eligible: false,
      shouldMarkSkipped: true,
      reason: "appointment_started",
      msUntilBooking,
    };
  }
  if (msUntilBooking > REMINDER_60M_LEAD_MS) {
    return { eligible: false, reason: "not_yet_due", msUntilBooking };
  }
  if (attemptsExceeded(booking, "reminder60mAttempts")) {
    return {
      eligible: false,
      shouldMarkSkipped: true,
      reason: "max_attempts_exceeded",
      msUntilBooking,
    };
  }

  const mode =
    msUntilBooking >= REMINDER_60M_LEAD_MS - 5 * MINUTE_MS
      ? "on_time"
      : "catch_up";

  return { eligible: true, reason: mode, mode, msUntilBooking };
}

/**
 * Whether a date change is big enough to be a different appointment.
 *
 * Saving a booking without moving it must not resend anything; moving it to
 * another day must. A minute of drift from a round-trip through the database is
 * not a reschedule, so the comparison has a small tolerance rather than testing
 * raw equality.
 */
function isMaterialDateChange(previousDate, nextDate, toleranceMs = MINUTE_MS) {
  const previousMs = new Date(previousDate).getTime();
  const nextMs = new Date(nextDate).getTime();
  if (!Number.isFinite(previousMs) || !Number.isFinite(nextMs)) return false;
  return Math.abs(nextMs - previousMs) > toleranceMs;
}

/**
 * The reminder state a rescheduled booking should carry.
 *
 * Everything is cleared, because the new appointment has had no reminders. The
 * customer told about Monday has been told nothing about Thursday, and
 * suppressing Thursday's reminder because Monday's was sent is the bug that
 * looks most like correct deduplication.
 */
function clearedReminderState() {
  return {
    reminder24hQueuedAt: null,
    reminder24hSentAt: null,
    reminder24hSkippedAt: null,
    reminder24hSkipReason: "",
    reminder24hAttempts: 0,
    reminder24hLastError: "",
    reminder24hMessageId: "",
    reminder24hTagAt: null,
    reminder24hTagAttempts: 0,
    reminder24hTagError: "",
    reminder60mQueuedAt: null,
    reminder60mSentAt: null,
    reminder60mSkippedAt: null,
    reminder60mSkipReason: "",
    reminder60mAttempts: 0,
    reminder60mLastError: "",
    reminder60mMessageId: "",
    reminder60mTagAt: null,
    reminder60mTagAttempts: 0,
    reminder60mTagError: "",
  };
}

/**
 * Whether the CRM tag still needs applying for an already-sent reminder.
 *
 * Separate from the email deliberately. The tag is what makes the SMS go out,
 * and it can fail on its own, so it needs its own retry that does not put a
 * second copy of the email in the customer's inbox. It is only worth retrying
 * while the reminder itself is still meaningful.
 */
function evaluateTagRetry(booking, kind, nowInput = new Date()) {
  const sentField = kind === "24h" ? "reminder24hSentAt" : "reminder60mSentAt";
  const tagField = kind === "24h" ? "reminder24hTagAt" : "reminder60mTagAt";
  const attemptsField =
    kind === "24h" ? "reminder24hTagAttempts" : "reminder60mTagAttempts";

  if (!hasValue(booking?.[sentField])) {
    return { eligible: false, reason: "email_not_sent" };
  }
  if (hasValue(booking?.[tagField])) {
    return { eligible: false, reason: "already_tagged" };
  }
  if (attemptsExceeded(booking, attemptsField)) {
    return { eligible: false, reason: "max_attempts_exceeded" };
  }
  if (isTerminalStatus(booking?.status)) {
    return { eligible: false, reason: "status_not_confirmed" };
  }
  const startMs = bookingStartMs(booking);
  if (startMs === null) return { eligible: false, reason: "invalid_booking_date" };
  // Past the appointment there is nothing left to text anyone about.
  if (startMs - new Date(nowInput).getTime() < -REMINDER_60M_GRACE_AFTER_START_MS) {
    return { eligible: false, reason: "appointment_started" };
  }
  return { eligible: true, reason: "tag_pending" };
}

module.exports = {
  HOUR_MS,
  MINUTE_MS,
  REMINDER_24H_LEAD_MS,
  REMINDER_24H_MIN_LEAD_MS,
  REMINDER_60M_GRACE_AFTER_START_MS,
  REMINDER_60M_LEAD_MS,
  REMINDER_LOCK_STALE_MS,
  REMINDER_MAX_ATTEMPTS,
  clearedReminderState,
  due24HourAt,
  due60MinuteAt,
  evaluate24HourReminder,
  evaluate60MinuteReminder,
  evaluateTagRetry,
  isConfirmedStatus,
  isMaterialDateChange,
  isTerminalStatus,
};
