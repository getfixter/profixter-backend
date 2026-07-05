require("dotenv").config();

const mongoose = require("mongoose");
const Booking = require("../models/Booking");
const BookingHistory = require("../models/BookingHistory");
const EmailLog = require("../models/EmailLog");
const {
  REMINDER_24H_CATCHUP_MIN_MS,
  REMINDER_24H_MS,
  REMINDER_60M_MS,
  REMINDER_LOCK_STALE_MS,
  REMINDER_WINDOW_MS,
  evaluate24HourReminder,
  evaluate60MinuteReminder,
} = require("../utils/bookingReminderPolicy");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function argValue(name, fallback = "") {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  if (!match) return fallback;
  return match.slice(prefix.length);
}

function boolArg(name) {
  return process.argv.includes(`--${name}`);
}

function emptyField(field) {
  return {
    $or: [{ [field]: { $exists: false } }, { [field]: null }],
  };
}

function availableLock(field, staleBefore) {
  return {
    $or: [
      { [field]: { $exists: false } },
      { [field]: null },
      { [field]: { $lte: staleBefore } },
    ],
  };
}

function asDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function iso(value) {
  const date = asDate(value);
  return date ? date.toISOString() : null;
}

function ny(value) {
  const date = asDate(value);
  if (!date) return null;
  return date.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function emailValid(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
    String(value || "").trim().toLowerCase()
  );
}

function hasValue(value) {
  return value !== undefined && value !== null;
}

function hoursBetween(a, b) {
  const start = asDate(a);
  const end = asDate(b);
  if (!start || !end) return null;
  return Number(((end.getTime() - start.getTime()) / HOUR_MS).toFixed(2));
}

function line(label, value) {
  console.log(`${label}: ${value === undefined || value === null ? "" : value}`);
}

function current24hQueryState(booking, now) {
  const catchupFloor = new Date(
    now.getTime() + REMINDER_24H_CATCHUP_MIN_MS
  );
  const windowCeiling = new Date(
    now.getTime() + REMINDER_24H_MS + REMINDER_WINDOW_MS
  );
  const staleBefore = new Date(now.getTime() - REMINDER_LOCK_STALE_MS);
  const start = asDate(booking.date);
  const queuedAt = asDate(booking.reminder24hQueuedAt);
  return {
    catchupFloor: iso(catchupFloor),
    windowCeiling: iso(windowCeiling),
    statusMatches: /^confirmed$/i.test(String(booking.status || "")),
    dateMatches:
      !!start && start.getTime() > catchupFloor.getTime() &&
      start.getTime() <= windowCeiling.getTime(),
    notSent: !hasValue(booking.reminder24hSentAt),
    lockAvailable:
      !queuedAt || queuedAt.getTime() <= staleBefore.getTime(),
    staleLock: !!queuedAt && queuedAt.getTime() <= staleBefore.getTime(),
  };
}

function historical24hWindowState(booking, confirmedAt, lastDateChangeAt) {
  const start = asDate(booking.date);
  if (!start) return null;
  const target = new Date(start.getTime() - REMINDER_24H_MS);
  const scheduledWindowOpen = new Date(start.getTime() - REMINDER_24H_MS - REMINDER_WINDOW_MS);
  const scheduledWindowClose = new Date(start.getTime() - REMINDER_24H_MS + REMINDER_WINDOW_MS);
  const catchupClose = new Date(start.getTime() - REMINDER_24H_CATCHUP_MIN_MS);
  const sentAt = asDate(booking.reminder24hSentAt);
  return {
    target: iso(target),
    scheduledWindowOpen: iso(scheduledWindowOpen),
    scheduledWindowClose: iso(scheduledWindowClose),
    catchupClose: iso(catchupClose),
    confirmedAt: iso(confirmedAt),
    confirmedByScheduledWindowClose:
      !!confirmedAt && confirmedAt.getTime() <= scheduledWindowClose.getTime(),
    confirmedBeforeCatchupClosed:
      !!confirmedAt && confirmedAt.getTime() < catchupClose.getTime(),
    hoursBetweenConfirmationAndVisit: confirmedAt
      ? hoursBetween(confirmedAt, start)
      : null,
    lastDateChangeAt: iso(lastDateChangeAt),
    reminder24hSentAfterLastDateChange:
      !!sentAt &&
      (!lastDateChangeAt || sentAt.getTime() > lastDateChangeAt.getTime()),
    reminder24hLooksStaleForCurrentDate:
      !!sentAt &&
      !!lastDateChangeAt &&
      sentAt.getTime() <= lastDateChangeAt.getTime(),
  };
}

async function confirmationHistory(bookingId) {
  const entries = await BookingHistory.find({ bookingId })
    .sort({ createdAt: 1 })
    .lean();
  const confirmed = entries.find(
    (entry) => entry.actionType === "booking_confirmed"
  );
  const dateChanges = entries.filter((entry) =>
    (entry.changes || []).some((change) => change.field === "date")
  );
  return { entries, confirmedAt: confirmed?.createdAt || null, dateChanges };
}

async function emailLogsForBooking(booking) {
  const ors = [{ bookingId: booking._id }];
  if (booking.bookingNumber) ors.push({ bookingNumber: booking.bookingNumber });
  return EmailLog.find({
    $or: ors,
    templateKey: { $in: ["booking_reminder_24h", "booking_reminder_60m"] },
  })
    .sort({ createdAt: 1 })
    .select("templateKey status subject recipientEmail customerEmail source sentAt failedAt createdAt errorMessage")
    .lean();
}

function explainBooking({ booking, confirmedAt, dateChanges, logs, now }) {
  const start = asDate(booking.date);
  const eligibility24 = evaluate24HourReminder(booking, now);
  const eligibility60 = evaluate60MinuteReminder(booking, now);
  const query24Now = current24hQueryState(booking, now);
  const lastDateChange = dateChanges[dateChanges.length - 1] || null;
  const lastDateChangeAt = asDate(lastDateChange?.createdAt);
  const historical24 = historical24hWindowState(
    booking,
    confirmedAt,
    lastDateChangeAt
  );
  const logs24 = logs.filter((log) => log.templateKey === "booking_reminder_24h");
  const logs60 = logs.filter((log) => log.templateKey === "booking_reminder_60m");
  const logs24AfterLastDateChange = logs24.filter((log) => {
    const createdAt = asDate(log.createdAt);
    return createdAt && (!lastDateChangeAt || createdAt > lastDateChangeAt);
  });

  console.log("\n============================================================");
  line("Booking", `${booking.bookingNumber || ""} ${booking._id}`);
  line("Customer", `${booking.name || ""} <${booking.email || ""}>`);
  line("Type", `${booking.bookingType || ""} / ${booking.accessType || ""}`);
  line("Status", booking.status);
  line("Date UTC", iso(start));
  line("Date New York", ny(start));
  line("Hours until/since visit", hoursBetween(now, start));
  line("Email valid now", emailValid(booking.email));
  line("reminder24hQueuedAt", iso(booking.reminder24hQueuedAt));
  line("reminder24hSentAt", iso(booking.reminder24hSentAt));
  line("reminder24hSkippedAt", iso(booking.reminder24hSkippedAt));
  line("reminder24hSkipReason", booking.reminder24hSkipReason || "");
  line("reminder60mQueuedAt", iso(booking.reminder60mQueuedAt));
  line("reminder60mSentAt", iso(booking.reminder60mSentAt));
  line("Confirmed at", iso(confirmedAt));
  line(
    "Confirmed hours before visit",
    historical24?.hoursBetweenConfirmationAndVisit
  );
  line("Date changes in history", dateChanges.length);
  line("Last date change at", iso(lastDateChangeAt));
  line("24h logs after last date change", logs24AfterLastDateChange.length);

  console.log("24h eligibility now:", JSON.stringify(eligibility24, null, 2));
  console.log("60m eligibility now:", JSON.stringify(eligibility60, null, 2));
  console.log("24h Mongo query match now:", JSON.stringify(query24Now, null, 2));
  console.log("Historical 24h window:", JSON.stringify(historical24, null, 2));
  console.log(
    "Reminder email logs:",
    JSON.stringify(
      [...logs24, ...logs60].map((log) => ({
        templateKey: log.templateKey,
        status: log.status,
        subject: log.subject,
        recipientEmail: log.recipientEmail,
        customerEmail: log.customerEmail,
        source: log.source,
        sentAt: iso(log.sentAt),
        failedAt: iso(log.failedAt),
        createdAt: iso(log.createdAt),
        errorMessage: log.errorMessage || "",
      })),
      null,
      2
    )
  );
}

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGO_URI or MONGODB_URI is required");
  }

  const now = new Date();
  const limit = Math.min(500, Math.max(1, Number(argValue("limit", "50"))));
  const daysBack = Math.max(1, Number(argValue("daysBack", "45")));
  const daysForward = Math.max(0, Number(argValue("daysForward", "14")));
  const bookingArg = argValue("booking", "").trim();
  const allInRange = boolArg("all");
  const missingOnly = boolArg("missingOnly");

  await mongoose.connect(uri, { autoIndex: false });

  const query = {};
  if (bookingArg) {
    query.$or = [{ bookingNumber: bookingArg }];
    if (mongoose.Types.ObjectId.isValid(bookingArg)) {
      query.$or.push({ _id: bookingArg });
    }
  } else {
    query.date = {
      $gte: new Date(now.getTime() - daysBack * DAY_MS),
      $lte: new Date(now.getTime() + daysForward * DAY_MS),
    };
    if (!allInRange) {
      query.reminder60mSentAt = { $exists: true, $ne: null };
    }
    if (missingOnly) {
      query.$and = [
        emptyField("reminder24hSentAt"),
      ];
    }
  }

  const bookings = await Booking.find(query)
    .sort({ date: -1 })
    .limit(limit)
    .lean();

  console.log("Booking reminder diagnosis");
  console.log({
    nowUtc: now.toISOString(),
    nowNewYork: ny(now),
    queryMode: bookingArg
      ? "single booking"
      : allInRange
        ? "all bookings in range"
        : missingOnly
          ? "60m sent and 24h sent field missing"
          : "60m sent; inspect 24h missing or stale",
    count: bookings.length,
    daysBack,
    daysForward,
    limit,
  });

  for (const booking of bookings) {
    const [{ confirmedAt, dateChanges }, logs] = await Promise.all([
      confirmationHistory(booking._id),
      emailLogsForBooking(booking),
    ]);
    explainBooking({ booking, confirmedAt, dateChanges, logs, now });
  }

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error("Booking reminder diagnosis failed:", error.message);
  try {
    await mongoose.disconnect();
  } catch (_) {
    // ignore cleanup errors
  }
  process.exitCode = 1;
});
