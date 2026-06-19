const moment = require("moment-timezone");
const CompanyAvailabilityTemplate = require("../models/CompanyAvailabilityTemplate");
const BookingSlotReservation = require("../models/BookingSlotReservation");
const {
  calculateDayAvailability,
  calculateDayFromContext,
  generateSlots,
  intervalsForWeekday,
  loadAvailabilityContext,
} = require("./availabilityService");
const {
  reservationBlocksAvailability,
  reservationEngineEnabled,
} = require("./slotReservationService");

const TIMEZONE = "America/New_York";

function slotOverlap(reservation, slotStart, slotEnd) {
  return (
    new Date(reservation.slotStart) < slotEnd &&
    new Date(reservation.slotEnd) > slotStart
  );
}

async function activeReservationsForRange(
  from,
  to,
  ReservationModel = BookingSlotReservation
) {
  const rows = await ReservationModel.find({
    slotStart: { $lt: to },
    slotEnd: { $gt: from },
    status: { $in: ["held", "reserved"] },
  }).lean();
  const now = new Date();
  return rows.filter((entry) => reservationBlocksAvailability(entry, now));
}

function customerDayFromShadow({ date, day, reservations, now = new Date() }) {
  const timezone = day.timezone || TIMEZONE;
  const taken = {};
  const remaining = {};
  const slots = [];

  for (const slot of day.slots) {
    const slotStart = moment.tz(
      `${date} ${slot.time}`,
      "YYYY-MM-DD HH:mm",
      timezone
    );
    const slotEnd = slotStart.clone().add(90, "minutes");
    const overlapping = reservations.filter((entry) =>
      slotOverlap(entry, slotStart.toDate(), slotEnd.toDate())
    );
    const occupiedTechnicians = new Set(
      overlapping.map((entry) => String(entry.technicianId))
    );
    const freeEligibleTechnicians = (slot.technicians || []).filter(
      (technician) =>
        technician.available &&
        !technician.booked &&
        !occupiedTechnicians.has(String(technician.id))
    ).length;
    const used = Math.max(Number(slot.usedCapacity || 0), overlapping.length);
    const companyRemaining = Math.max(
      0,
      Number(slot.configuredCapacity || 0) - used
    );
    const realRemaining = Math.min(
      companyRemaining,
      freeEligibleTechnicians
    );
    taken[slot.time] = used;
    remaining[slot.time] = realRemaining;
    if (slot.open && realRemaining > 0) slots.push(slot.time);
  }

  return {
    date,
    timezone,
    engine: "reservation",
    visitDurationMinutes: 90,
    slots,
    taken,
    remaining,
    capacityPerSlot: Math.max(
      0,
      ...day.slots.map((slot) => Number(slot.configuredCapacity || 0))
    ),
    closed: slots.length === 0,
  };
}

async function customerDayAvailability({
  date,
  now = new Date(),
  dependencies = {},
}) {
  const calculateAvailability =
    dependencies.calculateDayAvailability || calculateDayAvailability;
  const ReservationModel =
    dependencies.ReservationModel || BookingSlotReservation;
  const day = await calculateAvailability({
    date,
    scope: "company",
    now,
  });
  const timezone = day.timezone || TIMEZONE;
  const dayStart = moment.tz(date, "YYYY-MM-DD", timezone).startOf("day");
  const reservations = await activeReservationsForRange(
    dayStart.toDate(),
    dayStart.clone().add(1, "day").toDate(),
    ReservationModel
  );
  return customerDayFromShadow({ date, day, reservations, now });
}

async function customerMonthAvailability({
  month,
  now = new Date(),
  dependencies = {},
}) {
  if (!/^\d{4}-\d{2}$/.test(String(month || ""))) {
    const error = new Error("month must be YYYY-MM");
    error.statusCode = 400;
    throw error;
  }
  const start = moment.tz(`${month}-01`, "YYYY-MM-DD", true, TIMEZONE);
  if (!start.isValid() || start.format("YYYY-MM") !== month) {
    const error = new Error("month must be valid");
    error.statusCode = 400;
    throw error;
  }
  const end = start.clone().endOf("month");
  const loadContext =
    dependencies.loadAvailabilityContext || loadAvailabilityContext;
  const calculateFromContext =
    dependencies.calculateDayFromContext || calculateDayFromContext;
  const ReservationModel =
    dependencies.ReservationModel || BookingSlotReservation;
  const context = await loadContext({
    from: start.format("YYYY-MM-DD"),
    to: end.format("YYYY-MM-DD"),
    scope: "company",
  });
  const timezone = context.timezone || TIMEZONE;
  const reservations = await activeReservationsForRange(
    moment.tz(start.format("YYYY-MM-DD"), "YYYY-MM-DD", timezone).toDate(),
    moment
      .tz(end.format("YYYY-MM-DD"), "YYYY-MM-DD", timezone)
      .add(1, "day")
      .toDate(),
    ReservationModel
  );
  const days = [];
  for (
    let cursor = start.clone();
    cursor.isSameOrBefore(end, "day");
    cursor.add(1, "day")
  ) {
    const date = cursor.format("YYYY-MM-DD");
    const shadowDay = calculateFromContext({
      date,
      context,
      now,
      includeDetails: true,
    });
    const detail = customerDayFromShadow({
      date,
      day: shadowDay,
      reservations,
      now,
    });
    days.push({
      date,
      open: detail.slots.length > 0,
      slotCount: detail.slots.length,
      slots: detail.slots,
      taken: detail.taken,
      remaining: detail.remaining,
      capacityPerSlot: detail.capacityPerSlot,
    });
  }
  return {
    month,
    engine: "reservation",
    visitDurationMinutes: 90,
    days,
  };
}

async function suggestNextAvailableSlots({
  slotStart,
  limit = 5,
  searchDays = 14,
}) {
  const start = moment(slotStart).tz(TIMEZONE);
  const suggestions = [];
  for (
    let dayOffset = 0;
    dayOffset <= searchDays && suggestions.length < limit;
    dayOffset += 1
  ) {
    const date = start.clone().startOf("day").add(dayOffset, "days");
    const detail = await customerDayAvailability({
      date: date.format("YYYY-MM-DD"),
    });
    for (const time of detail.slots) {
      const candidate = moment.tz(
        `${detail.date} ${time}`,
        "YYYY-MM-DD HH:mm",
        detail.timezone
      );
      if (candidate.isAfter(start)) {
        suggestions.push({
          date: detail.date,
          time,
          start: candidate.toISOString(),
        });
      }
      if (suggestions.length >= limit) break;
    }
  }
  return suggestions;
}

async function customerCalendarConfig() {
  const template = await CompanyAvailabilityTemplate.findOne({
    active: true,
  }).lean();
  if (!template) {
    const error = new Error("Customer calendar foundation is not ready");
    error.code = "SHADOW_FOUNDATION_NOT_READY";
    error.statusCode = 503;
    throw error;
  }
  const defaultHours = new Set();
  const closedWeekdays = [];
  for (let weekday = 0; weekday < 7; weekday += 1) {
    const intervals = intervalsForWeekday(template, weekday);
    if (!intervals.length) closedWeekdays.push(weekday);
    for (const slot of generateSlots(
      intervals,
      template.slotMinutes,
      template.defaultCapacity,
      90
    ).values()) {
      defaultHours.add(slot.time);
    }
  }
  return {
    timezone: template.timezone || TIMEZONE,
    slotMinutes: template.slotMinutes,
    slotStepMinutes: template.slotMinutes,
    visitDurationMinutes: 90,
    minLeadDays: Math.ceil(Number(template.minLeadMinutes || 0) / 1440),
    maxAdvanceDays: template.maxAdvanceDays,
    closedWeekdays,
    overrides: {},
    holidays: [],
    maxConcurrent: template.defaultCapacity,
    defaultHours: [...defaultHours].sort(),
    engine: "reservation",
  };
}

module.exports = {
  customerCalendarConfig,
  customerDayAvailability,
  customerDayFromShadow,
  customerMonthAvailability,
  reservationEngineEnabled,
  suggestNextAvailableSlots,
};
