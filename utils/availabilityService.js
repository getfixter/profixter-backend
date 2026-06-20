const mongoose = require("mongoose");
const moment = require("moment-timezone");
const CompanyAvailabilityTemplate = require("../models/CompanyAvailabilityTemplate");
const User = require("../models/User");
const Booking = require("../models/Booking");
const TechnicianAvailabilityTemplate = require("../models/TechnicianAvailabilityTemplate");
const AvailabilityOverride = require("../models/AvailabilityOverride");
const CapacityOverride = require("../models/CapacityOverride");
const TechnicianTimeOff = require("../models/TechnicianTimeOff");
const CalendarDayNote = require("../models/CalendarDayNote");
const { dateValidator, timeToMinutes } = require("./availabilityValidation");

const CANCELED_STATUSES = new Set(["canceled", "cancelled"]);
const NON_OCCUPYING_STATUSES = new Set([
  "canceled",
  "cancelled",
  "completed",
  "complete",
  "done",
  "failed",
  "no-show",
  "noshow",
]);

function foundationError(message) {
  const error = new Error(message);
  error.statusCode = 503;
  error.code = "SHADOW_FOUNDATION_NOT_READY";
  return error;
}

function validateScope(scope, technicianId) {
  if (!["company", "technician"].includes(scope)) {
    const error = new Error("scope must be company or technician");
    error.statusCode = 400;
    throw error;
  }
  if (scope === "technician") {
    if (!technicianId) {
      const error = new Error("technicianId is required for technician scope");
      error.statusCode = 400;
      throw error;
    }
    if (!mongoose.isValidObjectId(technicianId)) {
      const error = new Error("technicianId is invalid");
      error.statusCode = 400;
      throw error;
    }
  }
}

function minutesToTime(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(
    minutes % 60
  ).padStart(2, "0")}`;
}

function generateSlots(
  intervals,
  slotStepMinutes,
  defaultCapacity = 1,
  visitDurationMinutes = 90
) {
  const slots = new Map();
  for (const interval of intervals || []) {
    const start = timeToMinutes(interval.startTime);
    const end = timeToMinutes(interval.endTime);
    if (start === null || end === null || start >= end) continue;
    for (
      let minute = start;
      minute + visitDurationMinutes <= end;
      minute += slotStepMinutes
    ) {
      const time = minutesToTime(minute);
      slots.set(time, {
        time,
        endTime: minutesToTime(minute + visitDurationMinutes),
        capacity: Math.max(
          0,
          interval.capacity !== null &&
          interval.capacity !== undefined &&
          Number.isFinite(Number(interval.capacity))
            ? Number(interval.capacity)
            : Number(defaultCapacity || 0)
        ),
      });
    }
  }
  return slots;
}

function generateSlotsFromStarts(
  starts,
  defaultCapacity = 1,
  visitDurationMinutes = 90
) {
  const slots = new Map();
  for (const entry of starts || []) {
    const time = typeof entry === "string" ? entry : entry?.time;
    const minute = timeToMinutes(time);
    if (minute === null || minute + visitDurationMinutes > 24 * 60) continue;
    const capacity =
      typeof entry === "string" ? null : entry?.capacity;
    slots.set(time, {
      time,
      endTime: minutesToTime(minute + visitDurationMinutes),
      capacity: Math.max(
        0,
        capacity !== null &&
        capacity !== undefined &&
        Number.isFinite(Number(capacity))
          ? Number(capacity)
          : Number(defaultCapacity || 0)
      ),
    });
  }
  return new Map(
    [...slots.entries()].sort(
      ([left], [right]) => timeToMinutes(left) - timeToMinutes(right)
    )
  );
}

function intervalsForWeekday(template, weekday) {
  const day = (template?.weeklySchedule || []).find(
    (entry) => entry.weekday === weekday
  );
  return day?.enabled ? day.intervals || [] : [];
}

function startsForWeekday(template, weekday) {
  const day = (template?.weeklySchedule || []).find(
    (entry) => entry.weekday === weekday
  );
  return day?.enabled ? day.starts || [] : [];
}

function scheduleForWeekday(template, weekday) {
  return {
    starts: startsForWeekday(template, weekday),
    intervals: intervalsForWeekday(template, weekday),
  };
}

function startsWithinIntervals(starts, intervals, visitDurationMinutes = 90) {
  if (!starts?.length || !intervals?.length) return [];
  return starts.filter((entry) => {
    const time = typeof entry === "string" ? entry : entry?.time;
    const start = timeToMinutes(time);
    if (start === null) return false;
    return intervals.some((interval) => {
      const intervalStart = timeToMinutes(interval.startTime);
      const intervalEnd = timeToMinutes(interval.endTime);
      return (
        intervalStart !== null &&
        intervalEnd !== null &&
        start >= intervalStart &&
        start + visitDurationMinutes <= intervalEnd
      );
    });
  });
}

function applyAvailabilityOverride(baseSchedule, override) {
  if (!override) return baseSchedule;
  if (override.mode === "closed") return { starts: [], intervals: [] };
  if (override.mode === "custom_hours") {
    const overrideStarts = override.starts || [];
    const overrideIntervals = override.intervals || [];
    return {
      starts:
        overrideStarts.length > 0
          ? overrideStarts
          : startsWithinIntervals(baseSchedule.starts, overrideIntervals),
      intervals: overrideIntervals,
    };
  }
  if (
    override.mode === "open" &&
    (override.starts?.length || override.intervals?.length)
  ) {
    const overrideStarts = override.starts || [];
    const overrideIntervals = override.intervals || [];
    return {
      starts:
        overrideStarts.length > 0
          ? overrideStarts
          : startsWithinIntervals(baseSchedule.starts, overrideIntervals),
      intervals: overrideIntervals,
    };
  }
  return baseSchedule;
}

function generateScheduleSlots(
  schedule,
  slotStepMinutes,
  defaultCapacity,
  visitDurationMinutes
) {
  if (schedule?.starts?.length) {
    return generateSlotsFromStarts(
      schedule.starts,
      defaultCapacity,
      visitDurationMinutes
    );
  }
  return generateSlots(
    schedule?.intervals || [],
    slotStepMinutes,
    defaultCapacity,
    visitDurationMinutes
  );
}

function rangeApplies(override, time) {
  if (!override.startTime && !override.endTime) return true;
  return time >= override.startTime && time < override.endTime;
}

function applyCapacity(baseCapacity, overrides, time) {
  let capacity = Math.max(0, Number(baseCapacity || 0));
  for (const override of overrides || []) {
    if (!rangeApplies(override, time)) continue;
    if (override.mode === "set_capacity") capacity = override.value;
    if (override.mode === "adjust_capacity") capacity += override.value;
    if (override.mode === "block_spots") capacity -= override.value;
    capacity = Math.max(0, capacity);
  }
  return capacity;
}

function timeOffOverlaps(timeOff, slotStart, slotEnd) {
  return (
    timeOff.status === "approved" &&
    new Date(timeOff.startAt) < slotEnd &&
    new Date(timeOff.endAt) > slotStart
  );
}

function bookingTime(booking, timezone) {
  return moment(booking.date).tz(timezone).format("HH:mm");
}

async function loadAvailabilityContext({
  from,
  to,
  scope = "company",
  technicianId = null,
}) {
  validateScope(scope, technicianId);
  const companyTemplate = await CompanyAvailabilityTemplate.findOne({
    active: true,
  }).lean();
  if (!companyTemplate) {
    throw foundationError(
      "Shadow calendar foundation is not ready. An Admin must run foundation bootstrap."
    );
  }

  const timezone = companyTemplate.timezone || "America/New_York";
  const start = moment.tz(from, "YYYY-MM-DD", true, timezone).startOf("day");
  const endExclusive = moment
    .tz(to, "YYYY-MM-DD", true, timezone)
    .add(1, "day")
    .startOf("day");
  if (!start.isValid() || !endExclusive.isValid()) {
    const error = new Error("Invalid availability date range");
    error.statusCode = 400;
    throw error;
  }

  const technicianQuery = {
    role: "employee",
    isActive: { $ne: false },
    employeePosition: { $in: ["Fixter", "General Fixter"] },
  };
  if (scope === "technician") technicianQuery._id = technicianId;

  const technicians = await User.find(technicianQuery)
    .select(
      "_id name firstName lastName email employeePosition employeeAvailabilityStatus isActive"
    )
    .sort({ name: 1 })
    .lean();
  if (scope === "technician" && !technicians.length) {
    const error = new Error("Technician not found or inactive");
    error.statusCode = 404;
    throw error;
  }

  const technicianIds = technicians.map((technician) => technician._id);
  const dateRange = { $gte: from, $lte: to };
  const scopedRecords = [
    { scopeType: "company" },
    { scopeType: "technician", technicianId: { $in: technicianIds } },
  ];
  const [
    technicianTemplates,
    availabilityOverrides,
    capacityOverrides,
    timeOff,
    bookings,
    notes,
  ] = await Promise.all([
    TechnicianAvailabilityTemplate.find({
      technicianId: { $in: technicianIds },
      active: true,
    }).lean(),
    AvailabilityOverride.find({
      date: dateRange,
      $or: scopedRecords,
    }).lean(),
    CapacityOverride.find({
      date: dateRange,
      $or: scopedRecords,
    }).lean(),
    TechnicianTimeOff.find({
      technicianId: { $in: technicianIds },
      status: "approved",
      startAt: { $lt: endExclusive.toDate() },
      endAt: { $gt: start.toDate() },
    }).lean(),
    Booking.find({
      date: { $gte: start.toDate(), $lt: endExclusive.toDate() },
    })
      .select(
        "_id bookingNumber date status service assignedFixterId assignedFixterName name"
      )
      .lean(),
    CalendarDayNote.find({ date: dateRange }).lean(),
  ]);

  return {
    companyTemplate,
    timezone,
    scope,
    technicianId,
    technicians,
    technicianTemplates,
    availabilityOverrides,
    capacityOverrides,
    timeOff,
    bookings,
    notes,
  };
}

function calculateDayFromContext({
  date,
  context,
  now = new Date(),
  includeDetails = true,
}) {
  const {
    companyTemplate,
    timezone,
    scope,
    technicianId,
    technicians,
    technicianTemplates,
    availabilityOverrides,
    capacityOverrides,
    timeOff,
    bookings,
    notes,
  } = context;
  const day = moment.tz(date, "YYYY-MM-DD", true, timezone);
  const weekday = day.day();
  const dayStart = day.clone().startOf("day").toDate();
  const dayEnd = day.clone().add(1, "day").startOf("day").toDate();

  const dayAvailabilityOverrides = availabilityOverrides.filter(
    (override) => override.date === date
  );
  const dayCapacityOverrides = capacityOverrides.filter(
    (override) => override.date === date
  );
  const dayTimeOff = timeOff.filter(
    (entry) =>
      new Date(entry.startAt) < dayEnd && new Date(entry.endAt) > dayStart
  );
  const dayBookings = bookings.filter(
    (booking) =>
      new Date(booking.date) >= dayStart && new Date(booking.date) < dayEnd
  );
  const dayNote = notes.find((note) => note.date === date);

  const companyOverride = dayAvailabilityOverrides.find(
    (override) => override.scopeType === "company"
  );
  const companySchedule = applyAvailabilityOverride(
    scheduleForWeekday(companyTemplate, weekday),
    companyOverride
  );
  const companySlots = generateScheduleSlots(
    companySchedule,
    companyTemplate.slotMinutes,
    companyTemplate.defaultCapacity,
    companyTemplate.visitDurationMinutes || 90
  );
  const companyCapacityOverrides = dayCapacityOverrides.filter(
    (override) => override.scopeType === "company"
  );
  const templateByTechnician = new Map(
    technicianTemplates.map((template) => [
      String(template.technicianId),
      template,
    ])
  );

  const technicianAvailability = new Map();
  const technicianSlotStates = new Map();
  for (const technician of technicians) {
    const id = String(technician._id);
    const template = templateByTechnician.get(id);
    const technicianSchedule = template
      ? scheduleForWeekday(template, weekday)
      : null;
    const baseSchedule =
      !template || template.inheritCompanyHours
        ? companySchedule
        : {
            ...technicianSchedule,
            starts:
              technicianSchedule.starts.length > 0
                ? technicianSchedule.starts
                : startsWithinIntervals(
                    companySchedule.starts,
                    technicianSchedule.intervals
                  ),
          };
    const technicianOverride = dayAvailabilityOverrides.find(
      (override) =>
        override.scopeType === "technician" &&
        String(override.technicianId) === id
    );
    const schedule = applyAvailabilityOverride(
      baseSchedule,
      technicianOverride
    );
    const generated = generateScheduleSlots(
      schedule,
      companyTemplate.slotMinutes,
      1,
      companyTemplate.visitDurationMinutes || 90
    );
    const technicianCapacityOverrides = dayCapacityOverrides.filter(
      (override) =>
        override.scopeType === "technician" &&
        String(override.technicianId) === id
    );
    const technicianTimeOff = dayTimeOff.filter(
      (entry) => String(entry.technicianId) === id
    );

    const availableTimes = new Set();
    const slotStates = new Map();
    for (const companySlot of companySlots.values()) {
      const slot = generated.get(companySlot.time);
      const companyCapacity = applyCapacity(
        companySlot.capacity,
        companyCapacityOverrides,
        companySlot.time
      );
      const slotStart = moment.tz(
        `${date} ${companySlot.time}`,
        "YYYY-MM-DD HH:mm",
        timezone
      ).toDate();
      const slotEnd = moment.tz(
        `${date} ${companySlot.endTime}`,
        "YYYY-MM-DD HH:mm",
        timezone
      ).toDate();
      const matchingTimeOff = technicianTimeOff.find((entry) =>
        timeOffOverlaps(entry, slotStart, slotEnd)
      );
      const capacity = slot
        ? applyCapacity(1, technicianCapacityOverrides, companySlot.time)
        : 0;
      const available =
        companyCapacity > 0 && !!slot && !matchingTimeOff && capacity > 0;
      if (available) {
        availableTimes.add(companySlot.time);
      }
      slotStates.set(companySlot.time, {
        available,
        unavailableReason: matchingTimeOff
          ? matchingTimeOff.type === "sick"
            ? "Sick"
            : matchingTimeOff.type === "training"
              ? "Training"
              : "Time off"
          : !slot
            ? "Outside schedule"
            : companyCapacity <= 0
              ? "Company closed"
            : capacity <= 0
              ? "Blocked"
              : "",
      });
    }
    technicianAvailability.set(id, availableTimes);
    technicianSlotStates.set(id, slotStates);
  }

  const scopedBookings =
    scope === "technician"
      ? dayBookings.filter(
          (booking) =>
            String(booking.assignedFixterId || "") === String(technicianId)
        )
      : dayBookings;
  const visibleBookings = scopedBookings.filter(
    (booking) =>
      !CANCELED_STATUSES.has(String(booking.status || "").toLowerCase())
  );
  const occupyingBookings = scopedBookings.filter(
    (booking) =>
      !NON_OCCUPYING_STATUSES.has(String(booking.status || "").toLowerCase())
  );
  const nowLocal = moment(now).tz(timezone);
  const minBookable = nowLocal
    .clone()
    .add(companyTemplate.minLeadMinutes, "minutes");
  const maxBookable = nowLocal
    .clone()
    .add(companyTemplate.maxAdvanceDays, "days")
    .endOf("day");

  const slots = Array.from(companySlots.values()).map((companySlot) => {
    const availableTechnicians = technicians.filter((technician) =>
      technicianAvailability.get(String(technician._id))?.has(companySlot.time)
    );
    const slotBookings = occupyingBookings.filter(
      (booking) => bookingTime(booking, timezone) === companySlot.time
    );
    const configuredCapacity = applyCapacity(
      companySlot.capacity,
      companyCapacityOverrides,
      companySlot.time
    );
    const totalCapacity =
      scope === "technician"
        ? configuredCapacity > 0 && availableTechnicians.length
          ? 1
          : 0
        : Math.min(configuredCapacity, availableTechnicians.length);
    const usedCapacity = slotBookings.length;
    const slotStart = moment.tz(
      `${date} ${companySlot.time}`,
      "YYYY-MM-DD HH:mm",
      timezone
    );
    const insideBookingWindow =
      !slotStart.isBefore(minBookable) && !slotStart.isAfter(maxBookable);

    return {
      time: companySlot.time,
      endTime: companySlot.endTime,
      configuredCapacity,
      totalCapacity,
      usedCapacity,
      remainingCapacity: insideBookingWindow
        ? Math.max(0, totalCapacity - usedCapacity)
        : 0,
      open: insideBookingWindow && totalCapacity > usedCapacity,
      ...(includeDetails
        ? {
            technicians: technicians.map((technician) => {
              const id = String(technician._id);
              const state = technicianSlotStates
                .get(id)
                ?.get(companySlot.time) || {
                available: false,
                unavailableReason: "Outside schedule",
              };
              return {
                id,
                name: technician.name,
                position: technician.employeePosition,
                visibilityStatus:
                  technician.employeeAvailabilityStatus || "Available",
                available: state.available,
                unavailableReason: state.unavailableReason,
                booked: slotBookings.some(
                  (booking) =>
                    String(booking.assignedFixterId || "") === id
                ),
              };
            }),
            bookings: slotBookings.map((booking) => ({
              id: String(booking._id),
              bookingNumber: booking.bookingNumber,
              customerName: booking.name,
              service: booking.service,
              status: booking.status,
              assignedFixterId: booking.assignedFixterId
                ? String(booking.assignedFixterId)
                : null,
              assignedFixterName: booking.assignedFixterName || "",
            })),
          }
        : {}),
    };
  });

  const result = {
    date,
    timezone,
    scope,
    technicianId: technicianId ? String(technicianId) : null,
    shadowMode: true,
    bookingCount: visibleBookings.length,
    openSlotCount: slots.filter((slot) => slot.open).length,
    usedCapacity: slots.reduce((sum, slot) => sum + slot.usedCapacity, 0),
    totalCapacity: slots.reduce((sum, slot) => sum + slot.totalCapacity, 0),
    closed: slots.length === 0 || !slots.some((slot) => slot.open),
    reducedCapacity: slots.some(
      (slot) => slot.totalCapacity < slot.configuredCapacity
    ),
    hasOverrides:
      dayAvailabilityOverrides.length > 0 ||
      dayCapacityOverrides.length > 0,
    hasTimeOff: dayTimeOff.length > 0,
    note: dayNote?.note || "",
    slots,
  };
  if (includeDetails) {
    result.scheduleDiagnostics = {
      weekday,
      companyDayEnabled:
        !!(companyTemplate.weeklySchedule || []).find(
          (entry) => entry.weekday === weekday
        )?.enabled,
      configuredCompanyStarts: (companySchedule.starts || []).map(
        (entry) => (typeof entry === "string" ? entry : entry.time)
      ),
      configuredCompanyIntervals: (companySchedule.intervals || []).map(
        (entry) => ({
          startTime: entry.startTime,
          endTime: entry.endTime,
        })
      ),
      generatedCompanyStarts: slots.map((entry) => entry.time),
      generatedCompanySlots: slots.map((entry) => ({
        time: entry.time,
        endTime: entry.endTime,
      })),
    };
    result.technicians = technicians.map((technician) => ({
      id: String(technician._id),
      name: technician.name,
      email: technician.email,
      position: technician.employeePosition,
      visibilityStatus:
        technician.employeeAvailabilityStatus || "Available",
    }));
  }
  return result;
}

async function calculateDayAvailability({
  date,
  scope = "company",
  technicianId = null,
  now = new Date(),
}) {
  if (!dateValidator(date)) {
    const error = new Error("date must be YYYY-MM-DD");
    error.statusCode = 400;
    throw error;
  }
  const context = await loadAvailabilityContext({
    from: date,
    to: date,
    scope,
    technicianId,
  });
  return calculateDayFromContext({
    date,
    context,
    now,
    includeDetails: true,
  });
}

async function calculateMonthSummary({
  month,
  scope = "company",
  technicianId = null,
  now = new Date(),
}) {
  if (!/^\d{4}-\d{2}$/.test(String(month || ""))) {
    const error = new Error("month must be YYYY-MM");
    error.statusCode = 400;
    throw error;
  }
  const start = moment(`${month}-01`, "YYYY-MM-DD", true);
  if (!start.isValid() || start.format("YYYY-MM") !== month) {
    const error = new Error("month must be valid");
    error.statusCode = 400;
    throw error;
  }
  const end = start.clone().endOf("month");
  const context = await loadAvailabilityContext({
    from: start.format("YYYY-MM-DD"),
    to: end.format("YYYY-MM-DD"),
    scope,
    technicianId,
  });
  const days = [];
  for (
    let cursor = start.clone();
    cursor.isSameOrBefore(end, "day");
    cursor.add(1, "day")
  ) {
    const detail = calculateDayFromContext({
      date: cursor.format("YYYY-MM-DD"),
      context,
      now,
      includeDetails: false,
    });
    days.push({
      date: detail.date,
      bookingCount: detail.bookingCount,
      openSlotCount: detail.openSlotCount,
      usedCapacity: detail.usedCapacity,
      totalCapacity: detail.totalCapacity,
      closed: detail.closed,
      reducedCapacity: detail.reducedCapacity,
      hasOverrides: detail.hasOverrides,
      hasTimeOff: detail.hasTimeOff,
      hasNote: !!detail.note,
    });
  }
  return {
    month,
    scope,
    technicianId,
    shadowMode: true,
    batched: true,
    days,
  };
}

module.exports = {
  CANCELED_STATUSES,
  NON_OCCUPYING_STATUSES,
  applyAvailabilityOverride,
  applyCapacity,
  calculateDayAvailability,
  calculateDayFromContext,
  calculateMonthSummary,
  generateSlots,
  generateSlotsFromStarts,
  generateScheduleSlots,
  intervalsForWeekday,
  startsForWeekday,
  scheduleForWeekday,
  startsWithinIntervals,
  loadAvailabilityContext,
  timeOffOverlaps,
};
