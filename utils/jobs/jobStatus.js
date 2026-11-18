/**
 * What a booking IS, in the words the new Jobs screens use: its canonical
 * status, its type, its timing label and its attention flags.
 *
 * Pure functions over a booking (lean or document). The list, the detail, the
 * counts and the Needs-action collector all read from here, so the same
 * booking can never be "not closed" in one place and fine in another.
 */
const moment = require("moment-timezone");
const { FIXTER_CLOSE_LAG_MS } = require("../bookingReminderPolicy");

const TIMEZONE = "America/New_York";
const VISIT_MINUTES = 90;

/* The five statuses the system writes, plus a bucket for anything unexpected. */
const STATUS = Object.freeze({
  PENDING: "Pending",
  PENDING_CONFIRMATION: "Pending Confirmation",
  CONFIRMED: "Confirmed",
  COMPLETED: "Completed",
  CANCELED: "Canceled",
});

/* Mongo matchers for each canonical status, tolerant of historical spellings. */
const STATUS_MATCHERS = Object.freeze({
  [STATUS.PENDING]: /^\s*pending\s*$/i,
  [STATUS.PENDING_CONFIRMATION]: /^\s*pending[\s_-]*confirmation\s*$/i,
  [STATUS.CONFIRMED]: /^\s*confirmed\s*$/i,
  [STATUS.COMPLETED]: /^\s*(completed|complete|done)\s*$/i,
  [STATUS.CANCELED]: /^\s*(canceled|cancelled)\s*$/i,
});

function canonicalStatus(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return STATUS.PENDING; // the model default; old rows can lack it
  for (const [status, matcher] of Object.entries(STATUS_MATCHERS)) {
    if (matcher.test(raw)) return status;
  }
  return raw;
}

function statusMatcher(statuses) {
  return { $in: statuses.map((status) => STATUS_MATCHERS[status]).filter(Boolean) };
}

function isRequestStatus(status) {
  const s = canonicalStatus(status);
  return s === STATUS.PENDING || s === STATUS.PENDING_CONFIRMATION;
}

function isFinalStatus(status) {
  const s = canonicalStatus(status);
  return s === STATUS.COMPLETED || s === STATUS.CANCELED;
}

/* ------------------------------- type ------------------------------- */

function isFreeVisit(booking) {
  /* Converted to a paid visit (utils/freeVisit/conversion.js): it keeps guestRequestId for its lead, but it is not free any more. */
  if (booking?.freeVisitConversion?.convertedAt) return false;
  return Boolean(
    booking?.accessType === "free_first_visit" ||
      booking?.isFreeFirstVisit ||
      booking?.guestRequestId ||
      booking?.freeVisitChannel
  );
}

/**
 * The job's type key and label.
 *
 * Full Day is checked first: a paid Full Day carries accessType "one_time",
 * and calling it a One-Time Visit is the mislabel the Full Day work fixed once
 * already. Admin's own free visit (accessType "admin") is its own type, not
 * "Membership" (J-08).
 */
function jobType(booking) {
  if (booking?.bookingType === "full_day_visit") return { type: "full_day", typeLabel: "Full Day" };
  if (booking?.accessType === "admin") return { type: "admin_free", typeLabel: "Admin free visit" };
  if (isFreeVisit(booking)) {
    return booking.freeVisitPurpose === "consultation"
      ? { type: "free_visit", typeLabel: "Free Visit · To-do review" }
      : { type: "free_visit", typeLabel: "Free First Visit" };
  }
  if (booking?.bookingType === "one_time_handyman_visit" || booking?.accessType === "one_time") {
    return { type: "one_time", typeLabel: "One-Time Visit" };
  }
  return { type: "member", typeLabel: "Membership visit" };
}

/* ------------------------------ timing ------------------------------ */

/* `date` is the appointment start everywhere (reminders, the close nudge, queries); scheduledStart mirrors it. */
function startOf(booking) {
  const date = new Date(booking?.date || booking?.scheduledStart);
  return Number.isNaN(date.getTime()) ? null : date;
}

function endEstimate(booking) {
  const end = booking?.scheduledEnd ? new Date(booking.scheduledEnd) : null;
  if (end && !Number.isNaN(end.getTime())) return end;
  const start = startOf(booking);
  return start ? new Date(start.getTime() + VISIT_MINUTES * 60 * 1000) : null;
}

/**
 * The clock-derived label for a Confirmed job.
 *
 * Deliberately never "In progress": nothing records that a Fixter arrived, so
 * the clock reaching the start time proves only that the job is scheduled now.
 * From start to start + 2h (FIXTER_CLOSE_LAG_MS, the Fixter close nudge) it is
 * "Scheduled now"; after that "Not closed". Pending and final jobs get none.
 */
function timingLabel(booking, now = new Date()) {
  if (canonicalStatus(booking?.status) !== STATUS.CONFIRMED) return null;
  const start = startOf(booking);
  if (!start) return null;
  const nowMs = now.getTime();
  if (nowMs < start.getTime()) return { key: "upcoming", label: "Upcoming" };
  if (nowMs < start.getTime() + FIXTER_CLOSE_LAG_MS) return { key: "scheduled_now", label: "Scheduled now" };
  return { key: "not_closed", label: "Not closed" };
}

function isNotClosed(booking, now = new Date()) {
  return timingLabel(booking, now)?.key === "not_closed";
}

/* ------------------------------- flags ------------------------------ */

/**
 * Attention flags. `severity` is "attention" (somebody should look) or
 * "problem" (something is wrong now). Final jobs carry only payment flags.
 */
function jobFlags(booking, now = new Date()) {
  const flags = [];
  const status = canonicalStatus(booking?.status);
  const final = isFinalStatus(status);
  if (status === STATUS.PENDING_CONFIRMATION) {
    flags.push({ key: "request_review", label: "Free visit to review", severity: "attention" });
  } else if (status === STATUS.PENDING) {
    flags.push({ key: "request_review", label: "Needs confirming", severity: "attention" });
  }
  if (!final && !booking?.assignedFixterId) flags.push({ key: "unassigned", label: "Unassigned", severity: "attention" });
  if (isNotClosed(booking, now)) flags.push({ key: "not_closed", label: "Not closed", severity: "problem" });
  if (booking?.paymentState === "pending" && !final) flags.push({ key: "payment_pending", label: "Awaiting payment", severity: "attention" });
  if (["failed", "expired"].includes(booking?.paymentState) && !final) {
    flags.push({ key: "payment_problem", label: "Payment failed", severity: "problem" });
  }
  if (booking?.reservationIssue?.status && !final) {
    flags.push({ key: "reservation_issue", label: "Reservation needs review", severity: "problem" });
  }
  if (booking?.cancellationRequest?.at && !final) {
    flags.push({ key: "cancel_requested", label: "Customer asked to cancel", severity: "problem" });
  }
  if (booking?.freeVisitReview?.required && !booking?.freeVisitReview?.acknowledgedAt && !final) {
    flags.push({ key: "repeat_check", label: "Verify free visit", severity: "attention" });
  }
  return flags;
}

/* ------------------------------ helpers ----------------------------- */

function nyDay(date) {
  return moment.tz(date, TIMEZONE).format("YYYY-MM-DD");
}

/** [start, end) of a NY calendar day as Dates. */
function nyDayBounds(ymd) {
  const start = moment.tz(ymd, "YYYY-MM-DD", true, TIMEZONE);
  if (!start.isValid()) return null;
  return { start: start.toDate(), end: start.clone().add(1, "day").toDate() };
}

function shortAddress(booking) {
  const line = String(booking?.address || "").trim();
  return line;
}

function fullAddress(booking) {
  return [booking?.address, booking?.city, [booking?.state, booking?.zip].filter(Boolean).join(" ")]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(", ");
}

module.exports = {
  STATUS,
  STATUS_MATCHERS,
  TIMEZONE,
  VISIT_MINUTES,
  canonicalStatus,
  endEstimate,
  fullAddress,
  isFinalStatus,
  isFreeVisit,
  isNotClosed,
  isRequestStatus,
  jobFlags,
  jobType,
  nyDay,
  nyDayBounds,
  shortAddress,
  startOf,
  statusMatcher,
  timingLabel,
};
