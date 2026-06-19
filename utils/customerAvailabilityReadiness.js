const moment = require("moment-timezone");
const CalendarConfig = require("../models/CalendarConfig");
const SlotCounter = require("../models/SlotCounter");
const Booking = require("../models/Booking");
const BookingSlotReservation = require("../models/BookingSlotReservation");
const {
  calculateDayFromContext,
  loadAvailabilityContext,
} = require("./availabilityService");
const {
  backfillReservationsForFutureBookings,
  reservationBlocksAvailability,
} = require("./slotReservationService");

const TIMEZONE = "America/New_York";
const MAX_PREVIEW_DAYS = 60;
const LEGACY_NON_OCCUPYING_STATUSES = new Set([
  "Canceled",
  "Cancelled",
  "Completed",
  "Complete",
  "Done",
  "Failed",
  "No-Show",
  "Noshow",
]);

function previewEnabled() {
  return (
    String(
      process.env.ENABLE_CUSTOMER_AVAILABILITY_PREVIEW || "false"
    ).toLowerCase() === "true"
  );
}

function configOverrides(config) {
  if (config?.overrides instanceof Map) {
    return Object.fromEntries(config.overrides);
  }
  return config?.overrides || {};
}

function legacyHoursForDate(config, date) {
  if ((config.holidays || []).includes(date)) return [];
  const overrides = configOverrides(config);
  if (Object.prototype.hasOwnProperty.call(overrides, date)) {
    return Array.isArray(overrides[date]) ? [...overrides[date]].sort() : [];
  }
  const timezone = config.timezone || TIMEZONE;
  const weekday = moment.tz(date, "YYYY-MM-DD", timezone).day();
  if ((config.closedWeekdays || []).includes(weekday)) return [];
  return Array.isArray(config.defaultHours)
    ? [...config.defaultHours].sort()
    : [];
}

function bookingTime(booking, timezone) {
  return moment(booking.date).tz(timezone).format("HH:mm");
}

function buildLegacyDay({
  date,
  config,
  counters,
  bookings,
  now = new Date(),
}) {
  const timezone = config.timezone || TIMEZONE;
  const capacity = Math.max(1, Number(config.maxConcurrent || 1));
  const day = moment.tz(date, "YYYY-MM-DD", timezone);
  const today = moment(now).tz(timezone).startOf("day");
  const leadDays = Number(config.minLeadDays || 0);
  const insideLeadWindow =
    day.diff(today, "days") >= 0 && day.diff(today, "days") < leadDays;
  let hours = insideLeadWindow ? [] : legacyHoursForDate(config, date);
  if (day.isSame(moment(now).tz(timezone), "day")) {
    const nowTime = moment(now).tz(timezone).format("HH:mm");
    hours = hours.filter((time) => time > nowTime);
  }

  const taken = new Map(
    counters
      .filter((counter) => counter.ymd === date)
      .map((counter) => [counter.time, Number(counter.count || 0)])
  );
  for (const booking of bookings) {
    if (
      new Date(booking.date).toISOString().slice(0, 10) !== date ||
      LEGACY_NON_OCCUPYING_STATUSES.has(String(booking.status || ""))
    ) {
      continue;
    }
    const time = bookingTime(booking, timezone);
    if (hours.includes(time)) {
      taken.set(time, (taken.get(time) || 0) + 1);
    }
  }

  const slots = hours.map((time) => ({
    time,
    totalCapacity: capacity,
    usedCapacity: taken.get(time) || 0,
    remainingCapacity: Math.max(0, capacity - (taken.get(time) || 0)),
    open: (taken.get(time) || 0) < capacity,
  }));
  return {
    date,
    closed: !slots.some((slot) => slot.open),
    bookingCount: slots.reduce((sum, slot) => sum + slot.usedCapacity, 0),
    slots,
  };
}

function activeReservationsForSlot(reservations, slotStart, slotEnd) {
  return reservations.filter(
    (reservation) =>
      new Date(reservation.slotStart) < slotEnd &&
      new Date(reservation.slotEnd) > slotStart
  );
}

function compareAvailabilityDays({
  legacyDays,
  shadowDays,
  reservations = [],
  timezone = TIMEZONE,
  now = new Date(),
}) {
  const mismatches = {
    legacyOnlySlots: [],
    shadowOnlySlots: [],
    capacityMismatch: [],
    closedDayMismatch: [],
    bookingCountMismatch: [],
    noEligibleTechnician: [],
    reservationConflict: [],
  };
  const shadowByDate = new Map(shadowDays.map((day) => [day.date, day]));

  for (const legacyDay of legacyDays) {
    const shadowDay = shadowByDate.get(legacyDay.date);
    if (!shadowDay) continue;
    if (legacyDay.closed !== shadowDay.closed) {
      mismatches.closedDayMismatch.push({
        date: legacyDay.date,
        legacyClosed: legacyDay.closed,
        shadowClosed: shadowDay.closed,
      });
    }
    if (legacyDay.bookingCount !== shadowDay.usedCapacity) {
      mismatches.bookingCountMismatch.push({
        date: legacyDay.date,
        legacyBookingCount: legacyDay.bookingCount,
        shadowBookingCount: shadowDay.usedCapacity,
      });
    }

    const legacyByTime = new Map(
      legacyDay.slots.map((slot) => [slot.time, slot])
    );
    const shadowByTime = new Map(
      shadowDay.slots.map((slot) => [slot.time, slot])
    );
    const times = new Set([...legacyByTime.keys(), ...shadowByTime.keys()]);

    for (const time of times) {
      const legacy = legacyByTime.get(time);
      const shadow = shadowByTime.get(time);
      if (legacy?.open && !shadow?.open) {
        mismatches.legacyOnlySlots.push({ date: legacyDay.date, time });
      }
      if (shadow?.open && !legacy?.open) {
        mismatches.shadowOnlySlots.push({ date: legacyDay.date, time });
      }
      if (
        legacy &&
        shadow &&
        legacy.totalCapacity !== shadow.totalCapacity
      ) {
        mismatches.capacityMismatch.push({
          date: legacyDay.date,
          time,
          legacyCapacity: legacy.totalCapacity,
          shadowCapacity: shadow.totalCapacity,
        });
      }
      if (legacy?.open && shadow && shadow.totalCapacity === 0) {
        mismatches.noEligibleTechnician.push({
          date: legacyDay.date,
          time,
        });
      }
      if (shadow) {
        const slotStart = moment.tz(
          `${legacyDay.date} ${time}`,
          "YYYY-MM-DD HH:mm",
          timezone
        );
        const slotEnd = slotStart.clone().add(90, "minutes");
        const conflicts = activeReservationsForSlot(
          reservations.filter((entry) =>
            reservationBlocksAvailability(entry, now)
          ),
          slotStart.toDate(),
          slotEnd.toDate()
        );
        if (conflicts.length !== shadow.usedCapacity) {
          mismatches.reservationConflict.push({
            date: legacyDay.date,
            time,
            activeReservations: conflicts.length,
            shadowBookingCount: shadow.usedCapacity,
            reservationIds: conflicts.map((entry) => String(entry._id)),
          });
        }
      }
    }
  }

  const blockerCategories = [
    "legacyOnlySlots",
    "shadowOnlySlots",
    "capacityMismatch",
    "closedDayMismatch",
    "noEligibleTechnician",
    "reservationConflict",
  ];
  const blockers = blockerCategories
    .filter((category) => mismatches[category].length)
    .map((category) => ({
      category,
      count: mismatches[category].length,
    }));
  const warnings = mismatches.bookingCountMismatch.length
    ? [{
        category: "bookingCountMismatch",
        count: mismatches.bookingCountMismatch.length,
      }]
    : [];

  return {
    safeToCutOver: blockers.length === 0,
    decision: blockers.length === 0 ? "YES" : "NO",
    blockers,
    warnings,
    mismatchCounts: Object.fromEntries(
      Object.entries(mismatches).map(([key, values]) => [key, values.length])
    ),
    mismatches,
  };
}

async function buildCustomerAvailabilityReadiness({
  days = 30,
  now = new Date(),
  dependencies = {},
} = {}) {
  const previewDays = Math.min(
    MAX_PREVIEW_DAYS,
    Math.max(30, Math.trunc(Number(days) || 30))
  );
  const ConfigModel = dependencies.CalendarConfig || CalendarConfig;
  const CounterModel = dependencies.SlotCounter || SlotCounter;
  const BookingModel = dependencies.Booking || Booking;
  const ReservationModel =
    dependencies.BookingSlotReservation || BookingSlotReservation;
  const loadShadowContext =
    dependencies.loadAvailabilityContext || loadAvailabilityContext;
  const calculateShadowDay =
    dependencies.calculateDayFromContext || calculateDayFromContext;
  const runBackfill =
    dependencies.backfillReservationsForFutureBookings ||
    backfillReservationsForFutureBookings;

  const config = await ConfigModel.findOne().lean();
  if (!config) {
    const error = new Error("Legacy CalendarConfig is missing");
    error.code = "LEGACY_CALENDAR_NOT_READY";
    error.statusCode = 503;
    throw error;
  }
  const timezone = config.timezone || TIMEZONE;
  const from = moment(now).tz(timezone).startOf("day");
  const to = from.clone().add(previewDays - 1, "days");
  const fromDate = from.format("YYYY-MM-DD");
  const toDate = to.format("YYYY-MM-DD");
  const shadowContext = await loadShadowContext({
    from: fromDate,
    to: toDate,
    scope: "company",
  });
  const [counters, bookings, reservations] = await Promise.all([
    CounterModel.find({ ymd: { $gte: fromDate, $lte: toDate } }).lean(),
    BookingModel.find({
      date: {
        $gte: new Date(`${fromDate}T00:00:00.000Z`),
        $lte: new Date(`${toDate}T23:59:59.999Z`),
      },
    })
      .select("date status")
      .lean(),
    ReservationModel.find({
      slotStart: { $lt: to.clone().add(1, "day").toDate() },
      slotEnd: { $gt: from.toDate() },
      status: { $in: ["held", "reserved"] },
    }).lean(),
  ]);

  const legacyDays = [];
  const shadowDays = [];
  for (
    let cursor = from.clone();
    cursor.isSameOrBefore(to, "day");
    cursor.add(1, "day")
  ) {
    const date = cursor.format("YYYY-MM-DD");
    legacyDays.push(
      buildLegacyDay({ date, config, counters, bookings, now })
    );
    shadowDays.push(
      calculateShadowDay({
        date,
        context: shadowContext,
        now,
        includeDetails: false,
      })
    );
  }

  const comparison = compareAvailabilityDays({
    legacyDays,
    shadowDays,
    reservations,
    timezone,
    now,
  });
  const backfillReadiness = await runBackfill({ write: false });
  const backfillBlocked =
    backfillReadiness.conflicts > 0 ||
    backfillReadiness.noEligibleTechnician > 0 ||
    backfillReadiness.outsideWorkingHours > 0 ||
    backfillReadiness.missingFoundation > 0 ||
    backfillReadiness.errors?.length > 0;
  if (backfillBlocked) {
    comparison.safeToCutOver = false;
    comparison.decision = "NO";
    comparison.blockers.push({
      category: "reservationBackfillReadiness",
      count:
        backfillReadiness.conflicts +
        backfillReadiness.noEligibleTechnician +
        backfillReadiness.outsideWorkingHours +
        backfillReadiness.missingFoundation +
        (backfillReadiness.errors?.length || 0),
    });
  }
  const reservationEngineCurrentlyEnabled =
    String(process.env.ENABLE_RESERVATION_ENGINE || "false").toLowerCase() ===
    "true";
  const mongoTransactionsVerified =
    String(process.env.MONGO_TRANSACTIONS_VERIFIED || "false").toLowerCase() ===
    "true";
  if (reservationEngineCurrentlyEnabled) {
    comparison.safeToCutOver = false;
    comparison.decision = "NO";
    comparison.blockers.push({
      category: "reservationEngineAlreadyEnabled",
      count: 1,
    });
  }
  if (!mongoTransactionsVerified) {
    comparison.safeToCutOver = false;
    comparison.decision = "NO";
    comparison.blockers.push({
      category: "mongoTransactionProbeNotVerified",
      count: 1,
    });
  }

  return {
    generatedAt: new Date(),
    previewOnly: true,
    featureFlag: "ENABLE_CUSTOMER_AVAILABILITY_PREVIEW",
    reservationEngineEnabled: reservationEngineCurrentlyEnabled,
    mongoTransactionsVerified,
    range: { from: fromDate, to: toDate, days: previewDays, timezone },
    ...comparison,
    backfillReadiness,
  };
}

module.exports = {
  MAX_PREVIEW_DAYS,
  buildCustomerAvailabilityReadiness,
  buildLegacyDay,
  compareAvailabilityDays,
  legacyHoursForDate,
  previewEnabled,
};
