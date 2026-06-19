const mongoose = require("mongoose");
const moment = require("moment-timezone");
const Booking = require("../models/Booking");
const BookingSlotReservation = require("../models/BookingSlotReservation");
const User = require("../models/User");
const { calculateDayAvailability } = require("./availabilityService");
const { logReservationAction } = require("./bookingHistory");

const TIMEZONE = "America/New_York";
const VISIT_DURATION_MINUTES = 90;
const ACTIVE_RESERVATION_STATUSES = ["held", "reserved"];
const NON_ACTIVE_BOOKING_STATUSES = [
  "Canceled",
  "Cancelled",
  "Completed",
  "Complete",
  "Done",
  "Failed",
  "No-Show",
  "Noshow",
];

function reservationEngineEnabled() {
  return String(process.env.ENABLE_RESERVATION_ENGINE || "false").toLowerCase() === "true";
}

function serviceError(code, message, statusCode = 409) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function reservationWindow(slotStart) {
  const start = moment(slotStart);
  if (!start.isValid()) {
    throw serviceError("INVALID_SLOT", "slotStart is invalid", 400);
  }
  return {
    slotStart: start.toDate(),
    slotEnd: start.clone().add(VISIT_DURATION_MINUTES, "minutes").toDate(),
    date: start.tz(TIMEZONE).format("YYYY-MM-DD"),
    time: start.tz(TIMEZONE).format("HH:mm"),
  };
}

function overlaps(leftStart, leftEnd, rightStart, rightEnd) {
  return new Date(leftStart) < new Date(rightEnd) &&
    new Date(leftEnd) > new Date(rightStart);
}

function assignmentFields(technician, reservation, assignmentSource) {
  return {
    assignedFixterId: technician._id,
    assignedFixterName: technician.name || "",
    assignedFixterEmail: technician.email || "",
    assignedFixterPosition: technician.employeePosition || "",
    scheduledStart: reservation.slotStart,
    scheduledEnd: reservation.slotEnd,
    slotReservationId: reservation._id,
    assignmentSource,
  };
}

function historyActor({ actorUser, createdByType }) {
  if (!actorUser) {
    return {
      actorUserId: null,
      actorName: createdByType === "customer" ? "Customer" : "System",
      actorEmail: "",
      actorRole: createdByType || "system",
      actorPosition: "",
    };
  }
  return {
    actorUserId: actorUser._id,
    actorName: actorUser.name || actorUser.email || "Unknown user",
    actorEmail: actorUser.email || "",
    actorRole: actorUser.role || createdByType || "system",
    actorPosition: actorUser.employeePosition || "",
  };
}

async function activeReservationForBooking(bookingId) {
  return BookingSlotReservation.findOne({
    bookingId,
    status: { $in: ACTIVE_RESERVATION_STATUSES },
  });
}

async function technicianOverlap({
  technicianId,
  slotStart,
  slotEnd,
  excludeReservationId = null,
}) {
  // MongoDB uniquely protects exact starts. Arbitrary 90-minute interval
  // overlap is checked here because MongoDB has no native exclusion constraint.
  const query = {
    technicianId,
    status: { $in: ACTIVE_RESERVATION_STATUSES },
    slotStart: { $lt: slotEnd },
    slotEnd: { $gt: slotStart },
  };
  if (excludeReservationId) query._id = { $ne: excludeReservationId };
  return BookingSlotReservation.findOne(query).lean();
}

async function assertNoTechnicianOverlap({
  technicianId,
  slotStart,
  slotEnd,
  excludeReservationId = null,
  findOverlap = technicianOverlap,
}) {
  const conflict = await findOverlap({
    technicianId,
    slotStart,
    slotEnd,
    excludeReservationId,
  });
  if (conflict) {
    throw serviceError(
      "SLOT_CONFLICT",
      "Technician has an overlapping 90-minute reservation"
    );
  }
}

async function availabilityForTechnician({ technicianId, slotStart }) {
  const window = reservationWindow(slotStart);
  let day;
  try {
    day = await calculateDayAvailability({
      date: window.date,
      scope: "technician",
      technicianId,
    });
  } catch (error) {
    if (error.code === "SHADOW_FOUNDATION_NOT_READY") throw error;
    throw error;
  }
  const slot = day.slots.find(
    (candidate) =>
      candidate.time === window.time &&
      new Date(
        moment.tz(
          `${window.date} ${candidate.endTime}`,
          "YYYY-MM-DD HH:mm",
          TIMEZONE
        )
      ).getTime() === window.slotEnd.getTime()
  );
  const technicianState = slot?.technicians?.find(
    (technician) => String(technician.id) === String(technicianId)
  );
  return {
    available: !!slot && !!technicianState?.available && slot.totalCapacity > 0,
    reason:
      technicianState?.unavailableReason ||
      (!slot ? "The full 90-minute visit does not fit this schedule" : "Unavailable"),
    slot,
    day,
    window,
  };
}

async function bookingCountsByTechnician(technicianIds, slotStart) {
  const local = moment(slotStart).tz(TIMEZONE);
  const dayStart = local.clone().startOf("day").toDate();
  const dayEnd = local.clone().add(1, "day").startOf("day").toDate();
  const weekStart = local.clone().startOf("isoWeek").toDate();
  const weekEnd = local.clone().endOf("isoWeek").add(1, "millisecond").toDate();
  const [dayCounts, weekCounts] = await Promise.all([
    Booking.aggregate([
      {
        $match: {
          assignedFixterId: { $in: technicianIds },
          date: { $gte: dayStart, $lt: dayEnd },
          status: { $nin: NON_ACTIVE_BOOKING_STATUSES },
        },
      },
      { $group: { _id: "$assignedFixterId", count: { $sum: 1 } } },
    ]),
    Booking.aggregate([
      {
        $match: {
          assignedFixterId: { $in: technicianIds },
          date: { $gte: weekStart, $lt: weekEnd },
          status: { $nin: NON_ACTIVE_BOOKING_STATUSES },
        },
      },
      { $group: { _id: "$assignedFixterId", count: { $sum: 1 } } },
    ]),
  ]);
  return {
    day: new Map(dayCounts.map((entry) => [String(entry._id), entry.count])),
    week: new Map(weekCounts.map((entry) => [String(entry._id), entry.count])),
  };
}

function rankEligibleTechnicians(technicians) {
  return [...technicians].sort(
    (left, right) =>
      Number(right.isDefaultFixter) - Number(left.isDefaultFixter) ||
      left.dayBookingCount - right.dayBookingCount ||
      left.weekBookingCount - right.weekBookingCount ||
      String(left.id).localeCompare(String(right.id))
  );
}

async function findEligibleTechnicians({ slotStart }) {
  const window = reservationWindow(slotStart);
  const technicians = await User.find({
    role: "employee",
    isActive: { $ne: false },
    employeePosition: { $in: ["Fixter", "General Fixter"] },
  })
    .select("_id name email employeePosition isDefaultFixter")
    .lean();
  const counts = await bookingCountsByTechnician(
    technicians.map((technician) => technician._id),
    window.slotStart
  );

  const evaluated = await Promise.all(
    technicians.map(async (technician) => {
      const availability = await availabilityForTechnician({
        technicianId: technician._id,
        slotStart: window.slotStart,
      });
      const conflict = availability.available
        ? await technicianOverlap({
            technicianId: technician._id,
            slotStart: window.slotStart,
            slotEnd: window.slotEnd,
          })
        : null;
      return {
        id: String(technician._id),
        name: technician.name,
        email: technician.email,
        position: technician.employeePosition,
        isDefaultFixter: !!technician.isDefaultFixter,
        dayBookingCount: counts.day.get(String(technician._id)) || 0,
        weekBookingCount: counts.week.get(String(technician._id)) || 0,
        available: availability.available && !conflict,
        reason: conflict ? "Conflicts with another 90-minute reservation" : availability.reason,
      };
    })
  );
  const available = rankEligibleTechnicians(
    evaluated.filter((technician) => technician.available)
  );
  return {
    slotStart: window.slotStart,
    slotEnd: window.slotEnd,
    available,
    unavailable: evaluated.filter((technician) => !technician.available),
    recommended: available[0] || null,
  };
}

async function reserveSlotForBooking({
  bookingId,
  technicianId = null,
  slotStart = null,
  status = "reserved",
  holdExpiresAt = null,
  createdByType = "system",
  actorUser = null,
  assignmentSource = "automatic",
  historyAction = "reservation_created",
}) {
  if (!mongoose.isValidObjectId(bookingId)) {
    throw serviceError("INVALID_BOOKING", "Booking id is invalid", 400);
  }
  const booking = await Booking.findById(bookingId);
  if (!booking) throw serviceError("BOOKING_NOT_FOUND", "Booking not found", 404);
  if (NON_ACTIVE_BOOKING_STATUSES.includes(String(booking.status || ""))) {
    throw serviceError("BOOKING_INACTIVE", "Canceled or completed bookings cannot be reserved");
  }
  const existing = await activeReservationForBooking(booking._id);
  if (existing) {
    throw serviceError(
      "BOOKING_ALREADY_RESERVED",
      "Booking already has an active reservation"
    );
  }
  const desiredStart = slotStart || booking.date;
  const window = reservationWindow(desiredStart);

  let selectedId = technicianId;
  if (!selectedId) {
    const options = await findEligibleTechnicians({ slotStart: window.slotStart });
    selectedId = options.recommended?.id;
    if (!selectedId) {
      throw serviceError("TECHNICIAN_UNAVAILABLE", "No eligible technician is available");
    }
  }
  const technician = await User.findOne({
    _id: selectedId,
    role: "employee",
    isActive: { $ne: false },
    employeePosition: { $in: ["Fixter", "General Fixter"] },
  }).lean();
  if (!technician) {
    throw serviceError("TECHNICIAN_UNAVAILABLE", "Technician is invalid or inactive");
  }
  const availability = await availabilityForTechnician({
    technicianId: technician._id,
    slotStart: window.slotStart,
  });
  if (!availability.available) {
    await logReservationAction({
      bookingId: booking._id,
      actionType: "reservation_conflict",
      summary: "Reservation rejected: technician unavailable",
      actor: historyActor({ actorUser, createdByType }),
      changes: [{
        field: "reservation",
        label: "Reservation",
        oldValue: "None",
        newValue: availability.reason,
      }],
    });
    throw serviceError("TECHNICIAN_UNAVAILABLE", availability.reason);
  }
  try {
    await assertNoTechnicianOverlap({
      technicianId: technician._id,
      slotStart: window.slotStart,
      slotEnd: window.slotEnd,
    });
  } catch (error) {
    await logReservationAction({
      bookingId: booking._id,
      actionType: "reservation_conflict",
      summary: "Reservation rejected: slot conflict",
      actor: historyActor({ actorUser, createdByType }),
      changes: [{
        field: "reservation",
        label: "Reservation",
        oldValue: "None",
        newValue: "Overlapping 90-minute reservation",
      }],
    });
    throw error;
  }

  let reservation;
  try {
    reservation = await BookingSlotReservation.create({
      bookingId: booking._id,
      technicianId: technician._id,
      slotStart: window.slotStart,
      slotEnd: window.slotEnd,
      timezone: TIMEZONE,
      status,
      holdExpiresAt,
      createdByType,
      createdBy: actorUser?._id || null,
    });
  } catch (error) {
    if (error?.code === 11000) {
      throw serviceError("SLOT_CONFLICT", "Booking or technician slot was reserved concurrently");
    }
    throw error;
  }

  try {
    Object.assign(
      booking,
      assignmentFields(technician, reservation, assignmentSource)
    );
    booking.date = window.slotStart;
    await booking.save();
  } catch (error) {
    await BookingSlotReservation.updateOne(
      { _id: reservation._id },
      {
        $set: {
          status: "released",
          releasedAt: new Date(),
          releaseReason: "Booking update failed",
        },
      }
    );
    throw error;
  }

  if (historyAction) {
    await logReservationAction({
      bookingId: booking._id,
      actionType: historyAction,
      summary:
        historyAction === "reservation_backfilled"
          ? "Reservation backfilled"
          : "Reservation created",
      actor: historyActor({ actorUser, createdByType }),
      changes: [
        {
          field: "reservation",
          label: "Reservation",
          oldValue: "None",
          newValue: `${technician.name} · ${window.slotStart.toISOString()}–${window.slotEnd.toISOString()}`,
        },
      ],
    });
  }
  return { booking, reservation, technician };
}

async function releaseReservationForBooking({
  bookingId,
  reason = "Released",
  actorUser = null,
  createdByType = "system",
  clearAssignment = true,
}) {
  const booking = await Booking.findById(bookingId);
  if (!booking) throw serviceError("BOOKING_NOT_FOUND", "Booking not found", 404);
  const reservation = await activeReservationForBooking(booking._id);
  if (!reservation) {
    throw serviceError("RESERVATION_NOT_FOUND", "Active reservation not found", 404);
  }
  const oldDescription = `${booking.assignedFixterName || "Technician"} · ${reservation.slotStart.toISOString()}–${reservation.slotEnd.toISOString()}`;
  reservation.status = "released";
  reservation.releasedAt = new Date();
  reservation.releaseReason = reason;
  await reservation.save();
  try {
    if (clearAssignment) {
      booking.assignedFixterId = null;
      booking.assignedFixterName = "";
      booking.assignedFixterEmail = "";
      booking.assignedFixterPosition = "";
      booking.scheduledStart = null;
      booking.scheduledEnd = null;
      booking.slotReservationId = null;
      booking.assignmentSource = "";
      await booking.save();
    }
  } catch (error) {
    reservation.status = "reserved";
    reservation.releasedAt = null;
    reservation.releaseReason = "";
    await reservation.save();
    throw error;
  }
  await logReservationAction({
    bookingId: booking._id,
    actionType: "reservation_released",
    summary: "Reservation released",
    actor: historyActor({ actorUser, createdByType }),
    changes: [
      {
        field: "reservation",
        label: "Reservation",
        oldValue: oldDescription,
        newValue: reason,
      },
    ],
  });
  return { booking, reservation };
}

async function moveReservationForBooking({
  bookingId,
  technicianId,
  slotStart = null,
  actorUser = null,
  createdByType = "admin",
  assignmentSource = "admin",
}) {
  const booking = await Booking.findById(bookingId);
  if (!booking) throw serviceError("BOOKING_NOT_FOUND", "Booking not found", 404);
  const previous = await activeReservationForBooking(booking._id);
  const desiredStart = slotStart || booking.date;
  const oldDescription = previous
    ? `${booking.assignedFixterName || "Technician"} · ${previous.slotStart.toISOString()}–${previous.slotEnd.toISOString()}`
    : "None";

  if (previous) {
    previous.status = "released";
    previous.releasedAt = new Date();
    previous.releaseReason = "Moved";
    await previous.save();
  }
  let result;
  try {
    result = await reserveSlotForBooking({
      bookingId,
      technicianId,
      slotStart: desiredStart,
      createdByType,
      actorUser,
      assignmentSource,
      historyAction: null,
    });
  } catch (error) {
    if (previous) {
      previous.status = "reserved";
      previous.releasedAt = null;
      previous.releaseReason = "";
      await previous.save();
    }
    throw error;
  }
  await logReservationAction({
    bookingId,
    actionType: "reservation_moved",
    summary: "Reservation moved",
    actor: historyActor({ actorUser, createdByType }),
    changes: [
      {
        field: "reservation",
        label: "Reservation",
        oldValue: oldDescription,
        newValue: `${result.technician.name} · ${result.reservation.slotStart.toISOString()}–${result.reservation.slotEnd.toISOString()}`,
      },
    ],
  });
  return result;
}

async function backfillReservationsForFutureBookings({
  write = false,
  dependencies = {},
} = {}) {
  const BookingModel = dependencies.BookingModel || Booking;
  const getActiveReservation =
    dependencies.activeReservationForBooking || activeReservationForBooking;
  const getOptions =
    dependencies.findEligibleTechnicians || findEligibleTechnicians;
  const reserve = dependencies.reserveSlotForBooking || reserveSlotForBooking;
  const now = new Date();
  const bookings = await BookingModel.find({
    date: { $gte: now },
    status: { $nin: NON_ACTIVE_BOOKING_STATUSES },
  }).sort({ date: 1 });
  const report = {
    dryRun: !write,
    totalFutureBookings: bookings.length,
    alreadyReserved: 0,
    canReserve: 0,
    created: 0,
    noEligibleTechnician: 0,
    conflicts: 0,
    outsideWorkingHours: 0,
    missingFoundation: 0,
    errors: [],
  };
  for (const booking of bookings) {
    try {
      if (await getActiveReservation(booking._id)) {
        report.alreadyReserved += 1;
        continue;
      }
      const options = await getOptions({ slotStart: booking.date });
      const preferred = booking.assignedFixterId
        ? options.available.find(
            (technician) =>
              String(technician.id) === String(booking.assignedFixterId)
          )
        : null;
      const selected = preferred || options.recommended;
      if (!selected) {
        report.noEligibleTechnician += 1;
        continue;
      }
      report.canReserve += 1;
      if (write) {
        await reserve({
          bookingId: booking._id,
          technicianId: selected.id,
          slotStart: booking.date,
          createdByType: "system",
          assignmentSource: "backfill",
          historyAction: "reservation_backfilled",
        });
        report.created += 1;
      }
    } catch (error) {
      if (error.code === "SHADOW_FOUNDATION_NOT_READY") report.missingFoundation += 1;
      else if (error.code === "SLOT_CONFLICT") report.conflicts += 1;
      else if (error.code === "TECHNICIAN_UNAVAILABLE") report.outsideWorkingHours += 1;
      else report.errors.push({ bookingId: String(booking._id), message: error.message });
    }
  }
  return report;
}

function analyzeReservationAudit({ bookings, reservations }) {
  const bookingById = new Map(bookings.map((booking) => [String(booking._id), booking]));
  const activeReservations = reservations.filter((entry) =>
    ACTIVE_RESERVATION_STATUSES.includes(entry.status)
  );
  const activeByBooking = new Map();
  for (const reservation of activeReservations) {
    const key = String(reservation.bookingId);
    activeByBooking.set(key, [...(activeByBooking.get(key) || []), reservation]);
  }
  const technicianOverlaps = [];
  const byTechnician = new Map();
  for (const reservation of activeReservations) {
    const key = String(reservation.technicianId);
    byTechnician.set(key, [...(byTechnician.get(key) || []), reservation]);
  }
  for (const [technicianId, entries] of byTechnician) {
    entries.sort((left, right) => new Date(left.slotStart) - new Date(right.slotStart));
    for (let index = 1; index < entries.length; index += 1) {
      if (
        overlaps(
          entries[index - 1].slotStart,
          entries[index - 1].slotEnd,
          entries[index].slotStart,
          entries[index].slotEnd
        )
      ) {
        technicianOverlaps.push({
          technicianId,
          reservationIds: [
            String(entries[index - 1]._id),
            String(entries[index]._id),
          ],
        });
      }
    }
  }
  const assignmentMismatch = activeReservations
    .filter((reservation) => {
      const booking = bookingById.get(String(reservation.bookingId));
      return (
        booking &&
        String(booking.assignedFixterId || "") !==
          String(reservation.technicianId)
      );
    })
    .map((reservation) => String(reservation._id));
  const reservationsForCanceledBookings = activeReservations
    .filter((reservation) => {
      const booking = bookingById.get(String(reservation.bookingId));
      return (
        booking &&
        NON_ACTIVE_BOOKING_STATUSES.includes(String(booking.status || ""))
      );
    })
    .map((reservation) => String(reservation._id));
  return {
    bookingById,
    activeReservations,
    activeByBooking,
    technicianOverlaps,
    assignmentMismatch,
    reservationsForCanceledBookings,
    futureBookingsWithoutReservations: bookings
      .filter((booking) => !(activeByBooking.get(String(booking._id)) || []).length)
      .map((booking) => String(booking._id)),
    reservationsWithoutBookings: activeReservations
      .filter((reservation) => !bookingById.has(String(reservation.bookingId)))
      .map((reservation) => String(reservation._id)),
    bookingsWithMultipleActiveReservations: [...activeByBooking.entries()]
      .filter(([, entries]) => entries.length > 1)
      .map(([bookingId, entries]) => ({
        bookingId,
        reservationIds: entries.map((entry) => String(entry._id)),
      })),
  };
}

async function auditReservationConflicts() {
  const now = new Date();
  const [bookings, reservations] = await Promise.all([
    Booking.find({
      date: { $gte: now },
      status: { $nin: NON_ACTIVE_BOOKING_STATUSES },
    }).lean(),
    BookingSlotReservation.find({
      $or: [
        { status: { $in: ACTIVE_RESERVATION_STATUSES } },
        { slotStart: { $gte: now } },
      ],
    }).lean(),
  ]);
  const {
    bookingById,
    activeReservations,
    activeByBooking,
    technicianOverlaps,
    assignmentMismatch,
    reservationsForCanceledBookings,
    futureBookingsWithoutReservations,
    bookingsWithMultipleActiveReservations,
  } = analyzeReservationAudit({ bookings, reservations });
  const outsideAvailability = [];
  for (const reservation of activeReservations) {
    const booking = bookingById.get(String(reservation.bookingId)) ||
      (await Booking.findById(reservation.bookingId).lean());
    if (!booking) continue;
    bookingById.set(String(booking._id), booking);
    try {
      const availability = await availabilityForTechnician({
        technicianId: reservation.technicianId,
        slotStart: reservation.slotStart,
      });
      if (!availability.available) outsideAvailability.push(String(reservation._id));
    } catch {
      outsideAvailability.push(String(reservation._id));
    }
  }
  return {
    generatedAt: new Date(),
    futureBookingsWithoutReservations,
    reservationsWithoutBookings: activeReservations
      .filter((reservation) => !bookingById.has(String(reservation.bookingId)))
      .map((reservation) => String(reservation._id)),
    bookingsWithMultipleActiveReservations,
    technicianOverlaps,
    assignmentMismatch,
    reservationsForCanceledBookings,
    reservationsOutsideAvailability: outsideAvailability,
  };
}

module.exports = {
  ACTIVE_RESERVATION_STATUSES,
  TIMEZONE,
  VISIT_DURATION_MINUTES,
  analyzeReservationAudit,
  assertNoTechnicianOverlap,
  auditReservationConflicts,
  backfillReservationsForFutureBookings,
  findEligibleTechnicians,
  moveReservationForBooking,
  overlaps,
  rankEligibleTechnicians,
  releaseReservationForBooking,
  reservationEngineEnabled,
  reservationWindow,
  reserveSlotForBooking,
};
