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

function generateSlots(intervals, slotMinutes, defaultCapacity = 1) {
  const slots = new Map();
  for (const interval of intervals || []) {
    const start = timeToMinutes(interval.startTime);
    const end = timeToMinutes(interval.endTime);
    if (start === null || end === null || start >= end) continue;
    for (let minute = start; minute + slotMinutes <= end; minute += slotMinutes) {
      const time = minutesToTime(minute);
      slots.set(time, {
        time,
        endTime: minutesToTime(minute + slotMinutes),
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

function intervalsForWeekday(template, weekday) {
  const day = (template?.weeklySchedule || []).find(
    (entry) => entry.weekday === weekday
  );
  return day?.enabled ? day.intervals || [] : [];
}

function applyAvailabilityOverride(baseIntervals, override) {
  if (!override) return baseIntervals;
  if (override.mode === "closed") return [];
  if (override.mode === "custom_hours") return override.intervals || [];
  if (override.mode === "open" && override.intervals?.length) {
    return override.intervals;
  }
  return baseIntervals;
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
  const companyIntervals = applyAvailabilityOverride(
    intervalsForWeekday(companyTemplate, weekday),
    companyOverride
  );
  const companySlots = generateSlots(
    companyIntervals,
    companyTemplate.slotMinutes,
    companyTemplate.defaultCapacity
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
    const baseIntervals =
      !template || template.inheritCompanyHours
        ? companyIntervals
        : intervalsForWeekday(template, weekday);
    const technicianOverride = dayAvailabilityOverrides.find(
      (override) =>
        override.scopeType === "technician" &&
        String(override.technicianId) === id
    );
    const intervals = applyAvailabilityOverride(
      baseIntervals,
      technicianOverride
    );
    const generated = generateSlots(
      intervals,
      companyTemplate.slotMinutes,
      1
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
  intervalsForWeekday,
  loadAvailabilityContext,
  timeOffOverlaps,
};
