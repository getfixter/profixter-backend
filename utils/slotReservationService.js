const mongoose = require("mongoose");
const moment = require("moment-timezone");
const Booking = require("../models/Booking");
const BookingSlotReservation = require("../models/BookingSlotReservation");
const ReservationTimeBucket = require("../models/ReservationTimeBucket");
const ReservationCapacityBucket = require("../models/ReservationCapacityBucket");
const User = require("../models/User");
const TechnicianAvailabilityTemplate = require("../models/TechnicianAvailabilityTemplate");
const { calculateDayAvailability } = require("./availabilityService");
const {
  snapshot: bookingSnapshot,
  logBookingChanges,
  logBookingCreated,
  logReservationAction,
} = require("./bookingHistory");
const { runReservationTransaction } = require("./reservationTransaction");

const TIMEZONE = "America/New_York";
const VISIT_DURATION_MINUTES = 90;
const BUCKET_MINUTES = 15;
const ACTIVE_RESERVATION_STATUSES = ["held", "reserved"];
const TERMINAL_BOOKING_STATUSES = new Set([
  "canceled",
  "cancelled",
  "completed",
  "complete",
  "done",
  "failed",
  "no-show",
  "noshow",
]);

function normalizeBookingStatus(status) {
  return String(status || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

function isTerminalBookingStatus(status) {
  return TERMINAL_BOOKING_STATUSES.has(normalizeBookingStatus(status));
}

function reservationBlocksAvailability(reservation, now = new Date()) {
  if (reservation?.status === "reserved") return true;
  if (reservation?.status !== "held") return false;
  if (!reservation.holdExpiresAt) return true;
  const expiresAt = new Date(reservation.holdExpiresAt);
  if (Number.isNaN(expiresAt.getTime())) return true;
  return expiresAt > now;
}

function blockingReservationFilter(now = new Date()) {
  return {
    $or: [
      { status: "reserved" },
      {
        status: "held",
        $or: [
          { holdExpiresAt: null },
          { holdExpiresAt: { $gt: now } },
        ],
      },
    ],
  };
}

function reservationEngineEnabled() {
  return String(process.env.ENABLE_RESERVATION_ENGINE || "false").toLowerCase() === "true";
}

function serviceError(code, message, statusCode = 409) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

async function runReservationTransactionWithRetry(
  operation,
  attempts = 2,
  transactionRunner = runReservationTransaction
) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await transactionRunner(operation);
    } catch (error) {
      lastError = error;
      if (
        !["SLOT_CONFLICT", "SLOT_UNAVAILABLE"].includes(error?.code) ||
        attempt === attempts - 1
      ) {
        throw error;
      }
    }
  }
  throw lastError;
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

function reservationBucketStarts(slotStart, slotEnd) {
  const start = new Date(slotStart);
  const end = new Date(slotEnd);
  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    start.getTime() % (BUCKET_MINUTES * 60 * 1000) !== 0
  ) {
    throw serviceError(
      "INVALID_SLOT",
      "Reservation starts must align to a 15-minute boundary",
      400
    );
  }
  const starts = [];
  for (
    let cursor = start.getTime();
    cursor < end.getTime();
    cursor += BUCKET_MINUTES * 60 * 1000
  ) {
    starts.push(new Date(cursor));
  }
  return starts;
}

function bucketDocuments({
  technicianId,
  reservationId,
  bookingId,
  slotStart,
  slotEnd,
  status,
  expiresAt,
}) {
  return reservationBucketStarts(slotStart, slotEnd).map((bucketStart) => ({
    technicianId,
    bucketStart,
    bucketEnd: new Date(
      bucketStart.getTime() + BUCKET_MINUTES * 60 * 1000
    ),
    reservationId,
    bookingId,
    status,
    expiresAt: status === "held" ? expiresAt : null,
  }));
}

function capacityBucketDocuments({
  reservationId,
  bookingId,
  slotStart,
  slotEnd,
  capacityUnit,
  status,
  expiresAt,
}) {
  return reservationBucketStarts(slotStart, slotEnd).map((bucketStart) => ({
    bucketStart,
    bucketEnd: new Date(
      bucketStart.getTime() + BUCKET_MINUTES * 60 * 1000
    ),
    capacityUnit,
    reservationId,
    bookingId,
    status,
    expiresAt: status === "held" ? expiresAt : null,
  }));
}

async function createCapacityBuckets({
  reservation,
  capacity,
  usedCapacity = 0,
  session,
  CapacityBucketModel = ReservationCapacityBucket,
}) {
  const safeCapacity = Math.max(0, Math.floor(Number(capacity || 0)));
  if (!safeCapacity) {
    throw serviceError("SLOT_UNAVAILABLE", "This time is unavailable");
  }
  const starts = reservationBucketStarts(
    reservation.slotStart,
    reservation.slotEnd
  );
  const occupied = await CapacityBucketModel.find({
    bucketStart: { $in: starts },
  })
    .session(session)
    .lean();
  let capacityUnit = null;
  for (let unit = 1; unit <= safeCapacity; unit += 1) {
    const blocked =
      unit <= Math.max(0, Math.floor(Number(usedCapacity || 0))) ||
      starts.some((start) =>
        occupied.some(
          (entry) =>
            entry.capacityUnit === unit &&
            new Date(entry.bucketStart).getTime() === start.getTime()
        )
      );
    if (!blocked) {
      capacityUnit = unit;
      break;
    }
  }
  if (!capacityUnit) {
    throw serviceError("SLOT_UNAVAILABLE", "This time is fully booked");
  }
  const documents = capacityBucketDocuments({
    reservationId: reservation._id,
    bookingId: reservation.bookingId,
    slotStart: reservation.slotStart,
    slotEnd: reservation.slotEnd,
    capacityUnit,
    status: reservation.status,
    expiresAt: reservation.holdExpiresAt,
  });
  try {
    await CapacityBucketModel.insertMany(documents, {
      session,
      ordered: true,
    });
  } catch (error) {
    if (error?.code === 11000) {
      throw serviceError(
        "SLOT_CONFLICT",
        "Company capacity was reserved concurrently"
      );
    }
    throw error;
  }
  return documents;
}

function planBucketMove(oldBuckets, desiredDocuments) {
  const oldByKey = new Map(
    oldBuckets.map((bucket) => [
      `${bucket.technicianId}:${new Date(bucket.bucketStart).toISOString()}`,
      bucket,
    ])
  );
  const desiredKeys = new Set(
    desiredDocuments.map(
      (bucket) =>
        `${bucket.technicianId}:${new Date(bucket.bucketStart).toISOString()}`
    )
  );
  return {
    newOnly: desiredDocuments.filter(
      (bucket) =>
        !oldByKey.has(
          `${bucket.technicianId}:${new Date(bucket.bucketStart).toISOString()}`
        )
    ),
    oldOnly: oldBuckets.filter(
      (bucket) =>
        !desiredKeys.has(
          `${bucket.technicianId}:${new Date(bucket.bucketStart).toISOString()}`
        )
    ),
  };
}

async function applyBucketMove({
  oldBuckets,
  desiredDocuments,
  session,
  BucketModel = ReservationTimeBucket,
}) {
  const { newOnly, oldOnly } = planBucketMove(
    oldBuckets,
    desiredDocuments
  );
  if (newOnly.length) {
    try {
      await BucketModel.insertMany(newOnly, {
        session,
        ordered: true,
      });
    } catch (error) {
      if (error?.code === 11000) {
        throw serviceError(
          "SLOT_CONFLICT",
          "Technician has an overlapping reservation"
        );
      }
      throw error;
    }
  }
  const oldOnlyIds = oldOnly.map((bucket) => bucket._id);
  if (oldOnlyIds.length) {
    await BucketModel.deleteMany({
      _id: { $in: oldOnlyIds },
    }).session(session);
  }
  return { newOnly, oldOnly };
}

async function applyCapacityBucketMove({
  reservation,
  oldBuckets,
  capacity,
  usedCapacity = 0,
  session,
  CapacityBucketModel = ReservationCapacityBucket,
}) {
  const safeCapacity = Math.max(0, Math.floor(Number(capacity || 0)));
  if (!safeCapacity) {
    throw serviceError("SLOT_UNAVAILABLE", "This time is unavailable");
  }
  const starts = reservationBucketStarts(
    reservation.slotStart,
    reservation.slotEnd
  );
  const occupied = await CapacityBucketModel.find({
    bucketStart: { $in: starts },
    reservationId: { $ne: reservation._id },
  })
    .session(session)
    .lean();
  let capacityUnit = null;
  for (let unit = 1; unit <= safeCapacity; unit += 1) {
    const blocked =
      unit <= Math.max(0, Math.floor(Number(usedCapacity || 0))) ||
      starts.some((start) =>
        occupied.some(
          (entry) =>
            entry.capacityUnit === unit &&
            new Date(entry.bucketStart).getTime() === start.getTime()
        )
      );
    if (!blocked) {
      capacityUnit = unit;
      break;
    }
  }
  if (!capacityUnit) {
    throw serviceError("SLOT_UNAVAILABLE", "This time is fully booked");
  }
  const desired = capacityBucketDocuments({
    reservationId: reservation._id,
    bookingId: reservation.bookingId,
    slotStart: reservation.slotStart,
    slotEnd: reservation.slotEnd,
    capacityUnit,
    status: reservation.status,
    expiresAt: reservation.holdExpiresAt,
  });
  const oldByKey = new Map(
    oldBuckets.map((entry) => [
      `${entry.capacityUnit}:${new Date(entry.bucketStart).toISOString()}`,
      entry,
    ])
  );
  const desiredKeys = new Set(
    desired.map(
      (entry) =>
        `${entry.capacityUnit}:${new Date(entry.bucketStart).toISOString()}`
    )
  );
  const newOnly = desired.filter(
    (entry) =>
      !oldByKey.has(
        `${entry.capacityUnit}:${new Date(entry.bucketStart).toISOString()}`
      )
  );
  const oldOnly = oldBuckets.filter(
    (entry) =>
      !desiredKeys.has(
        `${entry.capacityUnit}:${new Date(entry.bucketStart).toISOString()}`
      )
  );
  try {
    if (newOnly.length) {
      await CapacityBucketModel.insertMany(newOnly, {
        session,
        ordered: true,
      });
    }
  } catch (error) {
    if (error?.code === 11000) {
      throw serviceError(
        "SLOT_CONFLICT",
        "Company capacity was reserved concurrently"
      );
    }
    throw error;
  }
  if (oldOnly.length) {
    await CapacityBucketModel.deleteMany({
      _id: { $in: oldOnly.map((entry) => entry._id) },
    }).session(session);
  }
  return { capacityUnit, newOnly, oldOnly };
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

async function activeReservationForBooking(bookingId, session = null) {
  const query = BookingSlotReservation.findOne({
    bookingId,
    ...blockingReservationFilter(),
  });
  if (session) query.session(session);
  return query;
}

async function releaseExpiredHolds(
  session,
  now = new Date(),
  dependencies = {}
) {
  const ReservationModel =
    dependencies.ReservationModel || BookingSlotReservation;
  const BucketModel = dependencies.BucketModel || ReservationTimeBucket;
  const CapacityBucketModel =
    dependencies.CapacityBucketModel || ReservationCapacityBucket;
  const BookingModel = dependencies.BookingModel || Booking;
  const writeHistory = dependencies.logReservationAction || logReservationAction;
  const expired = await ReservationModel.find({
    status: "held",
    holdExpiresAt: { $lte: now },
  }).session(session);
  if (!expired.length) return 0;
  const reservationIds = expired.map((entry) => entry._id);
  await BucketModel.deleteMany({
    reservationId: { $in: reservationIds },
  }).session(session);
  await CapacityBucketModel.deleteMany({
    reservationId: { $in: reservationIds },
  }).session(session);
  await ReservationModel.updateMany(
    { _id: { $in: reservationIds } },
    {
      $set: {
        status: "released",
        releasedAt: now,
        releaseReason: "Hold expired",
      },
    },
    { session }
  );
  const bookings = await BookingModel.find({
    slotReservationId: { $in: reservationIds },
  }).session(session);
  for (const booking of bookings) {
    const reservation = expired.find(
      (entry) => String(entry._id) === String(booking.slotReservationId)
    );
    booking.assignedFixterId = null;
    booking.assignedFixterName = "";
    booking.assignedFixterEmail = "";
    booking.assignedFixterPosition = "";
    booking.scheduledStart = null;
    booking.scheduledEnd = null;
    booking.slotReservationId = null;
    booking.assignmentSource = "";
    await booking.save({ session });
    await writeHistory({
      bookingId: booking._id,
      actionType: "reservation_released",
      summary: "Reservation hold expired",
      actor: historyActor({ createdByType: "system" }),
      changes: [
        {
          field: "reservation",
          label: "Reservation",
          oldValue: reservation
            ? `${reservation.slotStart.toISOString()}–${reservation.slotEnd.toISOString()}`
            : "Held reservation",
          newValue: "Hold expired",
        },
      ],
      session,
    });
  }
  return expired.length;
}

async function createReservationBuckets({
  reservation,
  session,
  BucketModel = ReservationTimeBucket,
}) {
  const documents = bucketDocuments({
    technicianId: reservation.technicianId,
    reservationId: reservation._id,
    bookingId: reservation.bookingId,
    slotStart: reservation.slotStart,
    slotEnd: reservation.slotEnd,
    status: reservation.status,
    expiresAt: reservation.holdExpiresAt,
  });
  try {
    await BucketModel.insertMany(documents, {
      session,
      ordered: true,
    });
  } catch (error) {
    if (error?.code === 11000) {
      throw serviceError(
        "SLOT_CONFLICT",
        "Technician has an overlapping reservation"
      );
    }
    throw error;
  }
  return documents;
}

async function deleteReservationBuckets({
  reservationId,
  session,
  BucketModel = ReservationTimeBucket,
  CapacityBucketModel = ReservationCapacityBucket,
}) {
  const [technicianBuckets, capacityBuckets] = await Promise.all([
    BucketModel.deleteMany({ reservationId }).session(session),
    CapacityBucketModel.deleteMany({ reservationId }).session(session),
  ]);
  return { technicianBuckets, capacityBuckets };
}

async function ensureReservationLocks(
  reservationId,
  { dependencies = {} } = {}
) {
  const ReservationModel =
    dependencies.ReservationModel || BookingSlotReservation;
  const BucketModel = dependencies.BucketModel || ReservationTimeBucket;
  const CapacityBucketModel =
    dependencies.CapacityBucketModel || ReservationCapacityBucket;
  const getAvailability =
    dependencies.availabilityForTechnician || availabilityForTechnician;
  const transactionRunner =
    dependencies.runReservationTransaction || runReservationTransaction;
  return transactionRunner(async (session) => {
    const reservation = await ReservationModel.findById(reservationId).session(
      session
    );
    if (!reservation || !reservationBlocksAvailability(reservation)) {
      return { repaired: false, reason: "inactive" };
    }
    const availability = await getAvailability({
      technicianId: reservation.technicianId,
      slotStart: reservation.slotStart,
    });
    if (!availability.available || availability.slot?.totalCapacity <= 0) {
      throw serviceError(
        "TECHNICIAN_UNAVAILABLE",
        availability.reason || "Reservation is outside availability"
      );
    }
    const [oldTechnicianBuckets, oldCapacityBuckets] = await Promise.all([
      BucketModel.find({ reservationId: reservation._id }).session(session),
      CapacityBucketModel.find({ reservationId: reservation._id }).session(
        session
      ),
    ]);
    const desiredTechnicianBuckets = bucketDocuments({
      technicianId: reservation.technicianId,
      reservationId: reservation._id,
      bookingId: reservation.bookingId,
      slotStart: reservation.slotStart,
      slotEnd: reservation.slotEnd,
      status: reservation.status,
      expiresAt: reservation.holdExpiresAt,
    });
    const technicianMove = await applyBucketMove({
      oldBuckets: oldTechnicianBuckets,
      desiredDocuments: desiredTechnicianBuckets,
      session,
      BucketModel,
    });
    const capacityMove = await applyCapacityBucketMove({
      reservation,
      oldBuckets: oldCapacityBuckets,
      capacity: availability.slot.totalCapacity,
      usedCapacity: Math.max(
        0,
        Number(availability.slot.usedCapacity || 0) -
          Number(
            (availability.slot.bookings || []).some(
              (entry) =>
                String(entry.id) === String(reservation.bookingId)
            )
          )
      ),
      session,
      CapacityBucketModel,
    });
    return {
      repaired:
        technicianMove.newOnly.length > 0 ||
        capacityMove.newOnly.length > 0,
      technicianBucketsAdded: technicianMove.newOnly.length,
      capacityBucketsAdded: capacityMove.newOnly.length,
    };
  });
}

async function technicianOverlap({
  technicianId,
  slotStart,
  slotEnd,
  excludeReservationId = null,
  now = new Date(),
}) {
  // MongoDB uniquely protects exact starts. Arbitrary 90-minute interval
  // overlap is checked here because MongoDB has no native exclusion constraint.
  const query = {
    technicianId,
    ...blockingReservationFilter(now),
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
  const scheduleDiagnostics = day?.scheduleDiagnostics || {};
  const unavailableReason =
    technicianState?.unavailableReason ||
    (!slot
      ? `No company start matches ${window.date} ${window.time}; check company hours, day/slot closures, start interval, and 90-minute fit`
      : "Technician is unavailable");
  return {
    available: !!slot && !!technicianState?.available && slot.totalCapacity > 0,
    reason: unavailableReason,
    slot,
    day,
    window,
    diagnostics: {
      ...scheduleDiagnostics,
      requestedStart: window.time,
      requestedEnd: moment(window.slotEnd)
        .tz(TIMEZONE)
        .format("HH:mm"),
    },
  };
}

async function bookingCountsByTechnician(technicianIds, slotStart) {
  const local = moment(slotStart).tz(TIMEZONE);
  const dayStart = local.clone().startOf("day").toDate();
  const dayEnd = local.clone().add(1, "day").startOf("day").toDate();
  const weekStart = local.clone().startOf("isoWeek").toDate();
  const weekEnd = local.clone().endOf("isoWeek").add(1, "millisecond").toDate();
  const [dayBookings, weekBookings] = await Promise.all([
    Booking.find({
      assignedFixterId: { $in: technicianIds },
      date: { $gte: dayStart, $lt: dayEnd },
    })
      .select("assignedFixterId status")
      .lean(),
    Booking.find({
      assignedFixterId: { $in: technicianIds },
      date: { $gte: weekStart, $lt: weekEnd },
    })
      .select("assignedFixterId status")
      .lean(),
  ]);
  const countByTechnician = (bookings) => {
    const counts = new Map();
    for (const booking of bookings) {
      if (isTerminalBookingStatus(booking.status)) continue;
      const key = String(booking.assignedFixterId);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  };
  return {
    day: countByTechnician(dayBookings),
    week: countByTechnician(weekBookings),
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

async function findEligibleTechnicians({
  slotStart,
  excludeReservationId = null,
  includeDiagnostics = false,
  dependencies = {},
}) {
  const UserModel = dependencies.UserModel || User;
  const TechnicianTemplateModel =
    dependencies.TechnicianTemplateModel || TechnicianAvailabilityTemplate;
  const getBookingCounts =
    dependencies.bookingCountsByTechnician || bookingCountsByTechnician;
  const getAvailability =
    dependencies.availabilityForTechnician || availabilityForTechnician;
  const findOverlap = dependencies.technicianOverlap || technicianOverlap;
  const window = reservationWindow(slotStart);
  const technicians = await UserModel.find({
    role: "employee",
    isActive: { $ne: false },
    employeePosition: { $in: ["Fixter", "General Fixter"] },
  })
    .select(
      "_id name email role isActive employeePosition employeeAvailabilityStatus isDefaultFixter"
    )
    .lean();
  const templates = includeDiagnostics && technicians.length
    ? await TechnicianTemplateModel.find({
        technicianId: { $in: technicians.map((technician) => technician._id) },
        active: true,
      })
        .select("technicianId inheritCompanyHours weeklySchedule active")
        .lean()
    : [];
  const templateByTechnician = new Map(
    templates.map((template) => [String(template.technicianId), template])
  );
  const counts = await getBookingCounts(
    technicians.map((technician) => technician._id),
    window.slotStart
  );

  const evaluated = await Promise.all(
    technicians.map(async (technician) => {
      const availability = await getAvailability({
        technicianId: technician._id,
        slotStart: window.slotStart,
      });
      const conflict = availability.available
        ? await findOverlap({
            technicianId: technician._id,
            slotStart: window.slotStart,
            slotEnd: window.slotEnd,
            excludeReservationId,
          })
        : null;
      return {
        id: String(technician._id),
        name: technician.name,
        email: technician.email,
        position: technician.employeePosition,
        isDefaultFixter: !!technician.isDefaultFixter,
        accountActive: technician.isActive !== false,
        availabilityStatus:
          technician.employeeAvailabilityStatus || "Available",
        scheduleSource:
          templateByTechnician.get(String(technician._id))
            ?.inheritCompanyHours === false
            ? "technician"
            : "company_inherited",
        dayBookingCount: counts.day.get(String(technician._id)) || 0,
        weekBookingCount: counts.week.get(String(technician._id)) || 0,
        available: availability.available && !conflict,
        reason: conflict
          ? "Conflicts with another 90-minute reservation"
          : availability.available
            ? ""
            : availability.reason,
        rejectionCode: conflict
          ? "reservation_overlap"
          : availability.available
            ? null
            : availability.slot
              ? "technician_or_capacity_unavailable"
              : "no_matching_company_start",
        requestedDate: window.date,
        requestedTime: window.time,
        requestedEnd: window.slotEnd,
        availabilityDiagnostics: availability.diagnostics || null,
      };
    })
  );
  let excluded = [];
  if (includeDiagnostics) {
    const structurallyExcluded = await UserModel.find({
      $or: [
        { role: "employee" },
        { employeePosition: { $in: ["Fixter", "General Fixter"] } },
        { isDefaultFixter: true },
      ],
      _id: { $nin: technicians.map((technician) => technician._id) },
    })
      .select(
        "_id name email role isActive employeePosition employeeAvailabilityStatus isDefaultFixter"
      )
      .lean();
    excluded = structurallyExcluded.map((technician) => {
      const reasons = [];
      if (technician.role !== "employee") {
        reasons.push(`Role is ${technician.role || "unset"}, not employee`);
      }
      if (technician.isActive === false) {
        reasons.push("Employee account is inactive");
      }
      if (!["Fixter", "General Fixter"].includes(technician.employeePosition)) {
        reasons.push(
          `Position is ${technician.employeePosition || "unset"}, not Fixter or General Fixter`
        );
      }
      return {
        id: String(technician._id),
        name: technician.name,
        email: technician.email,
        position: technician.employeePosition,
        isDefaultFixter: !!technician.isDefaultFixter,
        accountActive: technician.isActive !== false,
        availabilityStatus:
          technician.employeeAvailabilityStatus || "Available",
        available: false,
        rejectionCode: "account_not_eligible",
        reason: reasons.join("; ") || "Account does not meet technician rules",
      };
    });
  }
  const available = rankEligibleTechnicians(
    evaluated.filter((technician) => technician.available)
  );
  return {
    slotStart: window.slotStart,
    slotEnd: window.slotEnd,
    available,
    unavailable: [
      ...evaluated.filter((technician) => !technician.available),
      ...excluded,
    ],
    evaluatedTechnicians: [...evaluated, ...excluded],
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
  if (isTerminalBookingStatus(booking.status)) {
    throw serviceError("BOOKING_INACTIVE", "Canceled or completed bookings cannot be reserved");
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
    return await runReservationTransaction(async (session) => {
      await releaseExpiredHolds(session);
      const transactionalBooking = await Booking.findById(bookingId).session(
        session
      );
      if (!transactionalBooking) {
        throw serviceError("BOOKING_NOT_FOUND", "Booking not found", 404);
      }
      if (isTerminalBookingStatus(transactionalBooking.status)) {
        throw serviceError(
          "BOOKING_INACTIVE",
          "Canceled or completed bookings cannot be reserved"
        );
      }
      const existing = await activeReservationForBooking(
        transactionalBooking._id,
        session
      );
      if (existing) {
        throw serviceError(
          "BOOKING_ALREADY_RESERVED",
          "Booking already has an active reservation"
        );
      }

      const [reservation] = await BookingSlotReservation.create(
        [
          {
            bookingId: transactionalBooking._id,
            technicianId: technician._id,
            slotStart: window.slotStart,
            slotEnd: window.slotEnd,
            timezone: TIMEZONE,
            status,
            holdExpiresAt,
            createdByType,
            createdBy: actorUser?._id || null,
          },
        ],
        { session }
      );
      await createReservationBuckets({ reservation, session });
      await createCapacityBuckets({
        reservation,
        capacity: availability.slot?.totalCapacity,
        usedCapacity: Math.max(
          0,
          Number(availability.slot?.usedCapacity || 0) -
            Number(
              (availability.slot?.bookings || []).some(
                (entry) =>
                  String(entry.id) === String(transactionalBooking._id)
              )
            )
        ),
        session,
      });

      Object.assign(
        transactionalBooking,
        assignmentFields(technician, reservation, assignmentSource)
      );
      transactionalBooking.date = window.slotStart;
      await transactionalBooking.save({ session });

      if (historyAction) {
        await logReservationAction({
          bookingId: transactionalBooking._id,
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
          session,
        });
      }
      return {
        booking: transactionalBooking,
        reservation,
        technician,
      };
    });
  } catch (error) {
    if (error?.code === 11000) {
      throw serviceError("SLOT_CONFLICT", "Booking or technician slot was reserved concurrently");
    }
    if (error.code === "SLOT_CONFLICT") {
      // Conflict history cannot be in the rolled-back transaction.
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
    }
    throw error;
  }
}

async function createBookingWithReservation({
  bookingData,
  slotStart,
  technicianId = null,
  createdByType = "customer",
  actorUser = null,
  assignmentSource = "automatic",
  dependencies = {},
}) {
  const BookingModel = dependencies.BookingModel || Booking;
  const ReservationModel =
    dependencies.ReservationModel || BookingSlotReservation;
  const BucketModel = dependencies.BucketModel || ReservationTimeBucket;
  const CapacityBucketModel =
    dependencies.CapacityBucketModel || ReservationCapacityBucket;
  const UserModel = dependencies.UserModel || User;
  const getEligible =
    dependencies.findEligibleTechnicians || findEligibleTechnicians;
  const getAvailability =
    dependencies.availabilityForTechnician || availabilityForTechnician;
  const transactionRunner =
    dependencies.runReservationTransaction || runReservationTransaction;
  const releaseExpired =
    dependencies.releaseExpiredHolds || releaseExpiredHolds;
  const writeBookingCreated =
    dependencies.logBookingCreated || logBookingCreated;
  const writeReservationAction =
    dependencies.logReservationAction || logReservationAction;
  const window = reservationWindow(slotStart);
  let selectedId = technicianId;
  if (!selectedId) {
    const options = await getEligible({
      slotStart: window.slotStart,
    });
    selectedId = options.recommended?.id;
    if (!selectedId) {
      throw serviceError(
        "SLOT_UNAVAILABLE",
        "This time is no longer available"
      );
    }
  }
  const technician = await UserModel.findOne({
    _id: selectedId,
    role: "employee",
    isActive: { $ne: false },
    employeePosition: { $in: ["Fixter", "General Fixter"] },
  }).lean();
  if (!technician) {
    throw serviceError(
      "SLOT_UNAVAILABLE",
      "No eligible technician is available"
    );
  }
  const availability = await getAvailability({
    technicianId: technician._id,
    slotStart: window.slotStart,
  });
  if (!availability.available || availability.slot?.totalCapacity <= 0) {
    throw serviceError(
      "SLOT_UNAVAILABLE",
      availability.reason || "This time is unavailable"
    );
  }

  try {
    return await runReservationTransactionWithRetry(async (session) => {
      await releaseExpired(session);
      const [booking] = await BookingModel.create(
        [{ ...bookingData, date: window.slotStart }],
        { session }
      );
      const [reservation] = await ReservationModel.create(
        [{
          bookingId: booking._id,
          technicianId: technician._id,
          slotStart: window.slotStart,
          slotEnd: window.slotEnd,
          timezone: TIMEZONE,
          status: "reserved",
          holdExpiresAt: null,
          createdByType,
          createdBy: actorUser?._id || null,
        }],
        { session }
      );
      await createReservationBuckets({
        reservation,
        session,
        BucketModel,
      });
      await createCapacityBuckets({
        reservation,
        capacity: availability.slot.totalCapacity,
        usedCapacity: availability.slot.usedCapacity || 0,
        session,
        CapacityBucketModel,
      });
      Object.assign(
        booking,
        assignmentFields(technician, reservation, assignmentSource)
      );
      await booking.save({ session });
      await writeBookingCreated({
        booking,
        actor: historyActor({ actorUser, createdByType }),
        session,
      });
      await writeReservationAction({
        bookingId: booking._id,
        actionType: "reservation_created",
        summary: "Reservation created",
        actor: historyActor({ actorUser, createdByType }),
        changes: [{
          field: "reservation",
          label: "Reservation",
          oldValue: "None",
          newValue: `${window.slotStart.toISOString()}-${window.slotEnd.toISOString()}`,
        }],
        session,
      });
      return { booking, reservation, technician };
    },
    Math.max(2, Number(availability.slot.totalCapacity || 1) + 1),
    transactionRunner);
  } catch (error) {
    if (
      error?.code === 11000 ||
      ["SLOT_CONFLICT", "TECHNICIAN_UNAVAILABLE"].includes(error?.code)
    ) {
      throw serviceError(
        "SLOT_UNAVAILABLE",
        "This time is no longer available"
      );
    }
    throw error;
  }
}

async function releaseReservationForBooking({
  bookingId,
  reason = "Released",
  actorUser = null,
  createdByType = "system",
  clearAssignment = true,
}) {
  return runReservationTransaction(async (session) => {
    const booking = await Booking.findById(bookingId).session(session);
    if (!booking) {
      throw serviceError("BOOKING_NOT_FOUND", "Booking not found", 404);
    }
    const reservation = await BookingSlotReservation.findOne({
      bookingId: booking._id,
      status: { $in: ACTIVE_RESERVATION_STATUSES },
    }).session(session);
    if (!reservation) {
      throw serviceError(
        "RESERVATION_NOT_FOUND",
        "Active reservation not found",
        404
      );
    }
    const oldDescription = `${booking.assignedFixterName || "Technician"} · ${reservation.slotStart.toISOString()}–${reservation.slotEnd.toISOString()}`;
    await deleteReservationBuckets({
      reservationId: reservation._id,
      session,
    });
    reservation.status = "released";
    reservation.releasedAt = new Date();
    reservation.releaseReason = reason;
    await reservation.save({ session });

    if (clearAssignment) {
      booking.assignedFixterId = null;
      booking.assignedFixterName = "";
      booking.assignedFixterEmail = "";
      booking.assignedFixterPosition = "";
      booking.scheduledStart = null;
      booking.scheduledEnd = null;
      booking.slotReservationId = null;
      booking.assignmentSource = "";
      await booking.save({ session });
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
      session,
    });
    return { booking, reservation };
  });
}

async function transitionBookingWithReservation({
  bookingId,
  actorUser = null,
  createdByType = "customer",
  reason = "Booking canceled",
  status = "Canceled",
  clearAssignment = true,
  dependencies = {},
}) {
  const BookingModel = dependencies.BookingModel || Booking;
  const ReservationModel =
    dependencies.ReservationModel || BookingSlotReservation;
  const BucketModel = dependencies.BucketModel || ReservationTimeBucket;
  const CapacityBucketModel =
    dependencies.CapacityBucketModel || ReservationCapacityBucket;
  const transactionRunner =
    dependencies.runReservationTransaction || runReservationTransaction;
  const writeBookingChanges =
    dependencies.logBookingChanges || logBookingChanges;
  const writeReservationAction =
    dependencies.logReservationAction || logReservationAction;
  return transactionRunner(async (session) => {
    const booking = await BookingModel.findById(bookingId).session(session);
    if (!booking) {
      throw serviceError("BOOKING_NOT_FOUND", "Booking not found", 404);
    }
    const before = bookingSnapshot(booking);
    const reservation = await ReservationModel.findOne({
      bookingId: booking._id,
      status: { $in: ACTIVE_RESERVATION_STATUSES },
    }).session(session);
    if (reservation) {
      await deleteReservationBuckets({
        reservationId: reservation._id,
        session,
        BucketModel,
        CapacityBucketModel,
      });
      reservation.status = "released";
      reservation.releasedAt = new Date();
      reservation.releaseReason = reason;
      await reservation.save({ session });
    }
    booking.statusHistory = (booking.statusHistory || []).concat({
      status: booking.status,
      date: new Date(),
    });
    booking.status = status;
    if (clearAssignment) {
      booking.assignedFixterId = null;
      booking.assignedFixterName = "";
      booking.assignedFixterEmail = "";
      booking.assignedFixterPosition = "";
      booking.scheduledStart = null;
      booking.scheduledEnd = null;
      booking.slotReservationId = null;
      booking.assignmentSource = "";
    }
    await booking.save({ session });
    const actor = historyActor({ actorUser, createdByType });
    await writeBookingChanges({
      bookingId: booking._id,
      before,
      after: bookingSnapshot(booking),
      actor,
      session,
    });
    if (reservation) {
      await writeReservationAction({
        bookingId: booking._id,
        actionType: "reservation_released",
        summary: "Reservation released",
        actor,
        changes: [{
          field: "reservation",
          label: "Reservation",
          oldValue: `${reservation.slotStart.toISOString()}-${reservation.slotEnd.toISOString()}`,
          newValue: reason,
        }],
        session,
      });
    }
    return { booking, reservation };
  });
}

async function cancelBookingWithReservation(options) {
  return transitionBookingWithReservation({
    ...options,
    status: "Canceled",
    clearAssignment: true,
  });
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
  const desiredStart = slotStart || booking.date;
  const window = reservationWindow(desiredStart);
  const technician = await User.findOne({
    _id: technicianId,
    role: "employee",
    isActive: { $ne: false },
    employeePosition: { $in: ["Fixter", "General Fixter"] },
  }).lean();
  if (!technician) {
    throw serviceError(
      "TECHNICIAN_UNAVAILABLE",
      "Technician is invalid or inactive"
    );
  }
  const availability = await availabilityForTechnician({
    technicianId: technician._id,
    slotStart: window.slotStart,
  });
  if (!availability.available) {
    throw serviceError("TECHNICIAN_UNAVAILABLE", availability.reason);
  }

  const previous = await activeReservationForBooking(booking._id);
  if (!previous) {
    return reserveSlotForBooking({
      bookingId,
      technicianId,
      slotStart: desiredStart,
      createdByType,
      actorUser,
      assignmentSource,
      historyAction: "reservation_moved",
    });
  }

  try {
    return await runReservationTransaction(async (session) => {
      await releaseExpiredHolds(session);
      const transactionalBooking = await Booking.findById(bookingId).session(
        session
      );
      const reservation = await activeReservationForBooking(
        bookingId,
        session
      );
      if (!transactionalBooking || !reservation) {
        throw serviceError(
          "RESERVATION_NOT_FOUND",
          "Active reservation not found",
          404
        );
      }
      const oldDescription = `${transactionalBooking.assignedFixterName || "Technician"} · ${reservation.slotStart.toISOString()}–${reservation.slotEnd.toISOString()}`;
      const oldBuckets = await ReservationTimeBucket.find({
        reservationId: reservation._id,
      }).session(session);
      const oldCapacityBuckets = await ReservationCapacityBucket.find({
        reservationId: reservation._id,
      }).session(session);
      const desiredDocuments = bucketDocuments({
        technicianId: technician._id,
        reservationId: reservation._id,
        bookingId: transactionalBooking._id,
        slotStart: window.slotStart,
        slotEnd: window.slotEnd,
        status: reservation.status,
        expiresAt: reservation.holdExpiresAt,
      });
      await applyBucketMove({
        oldBuckets,
        desiredDocuments,
        session,
      });

      reservation.technicianId = technician._id;
      reservation.slotStart = window.slotStart;
      reservation.slotEnd = window.slotEnd;
      await applyCapacityBucketMove({
        reservation,
        oldBuckets: oldCapacityBuckets,
        capacity: availability.slot?.totalCapacity,
        usedCapacity: Math.max(
          0,
          Number(availability.slot?.usedCapacity || 0) -
            Number(
              (availability.slot?.bookings || []).some(
                (entry) =>
                  String(entry.id) === String(transactionalBooking._id)
              )
            )
        ),
        session,
      });
      await reservation.save({ session });
      Object.assign(
        transactionalBooking,
        assignmentFields(technician, reservation, assignmentSource)
      );
      transactionalBooking.date = window.slotStart;
      await transactionalBooking.save({ session });
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
            newValue: `${technician.name} · ${window.slotStart.toISOString()}–${window.slotEnd.toISOString()}`,
          },
        ],
        session,
      });
      return {
        booking: transactionalBooking,
        reservation,
        technician,
      };
    });
  } catch (error) {
    if (error?.code === 11000) {
      throw serviceError(
        "SLOT_CONFLICT",
        "Technician slot was reserved concurrently"
      );
    }
    throw error;
  }
}

async function backfillReservationsForFutureBookings({
  write = false,
  bookingIds = null,
  dependencies = {},
} = {}) {
  const BookingModel = dependencies.BookingModel || Booking;
  const getActiveReservation =
    dependencies.activeReservationForBooking || activeReservationForBooking;
  const getOptions =
    dependencies.findEligibleTechnicians || findEligibleTechnicians;
  const reserve = dependencies.reserveSlotForBooking || reserveSlotForBooking;
  const ensureLocks =
    dependencies.ensureReservationLocks || ensureReservationLocks;
  const now = new Date();
  const bookingQuery = {
    date: { $gte: now },
    ...(Array.isArray(bookingIds) && bookingIds.length
      ? { _id: { $in: bookingIds } }
      : {}),
  };
  const futureBookings = await BookingModel.find(bookingQuery).sort({ date: 1 });
  const bookings = futureBookings.filter(
    (booking) => !isTerminalBookingStatus(booking.status)
  );
  const report = {
    dryRun: !write,
    totalFutureBookings: futureBookings.length,
    terminalBookingsSkipped: futureBookings.length - bookings.length,
    activeFutureBookings: bookings.length,
    alreadyReserved: 0,
    repairedReservationLocks: 0,
    canReserve: 0,
    created: 0,
    noEligibleTechnician: 0,
    conflicts: 0,
    outsideWorkingHours: 0,
    missingFoundation: 0,
    plannedAssignments: [],
    issues: [],
    errors: [],
  };
  for (const booking of bookings) {
    try {
      const existingReservation = await getActiveReservation(booking._id);
      if (existingReservation) {
        report.alreadyReserved += 1;
        if (write) {
          const repair = await ensureLocks(existingReservation._id);
          if (repair?.repaired) report.repairedReservationLocks += 1;
        }
        continue;
      }
      const options = await getOptions({
        slotStart: booking.date,
        includeDiagnostics: true,
      });
      const preferred = booking.assignedFixterId
        ? options.available.find(
            (technician) =>
              String(technician.id) === String(booking.assignedFixterId)
          )
        : null;
      const selected = preferred || options.recommended;
      if (!selected) {
        report.noEligibleTechnician += 1;
        report.issues.push({
          category: "noEligibleTechnician",
          bookingId: String(booking._id),
          slotStart: booking.date,
          assignedFixterId: booking.assignedFixterId
            ? String(booking.assignedFixterId)
            : null,
          techniciansEvaluated: options.evaluatedTechnicians ||
            options.unavailable ||
            [],
        });
        continue;
      }
      report.canReserve += 1;
      report.plannedAssignments.push({
        bookingId: String(booking._id),
        requestedStart: booking.date,
        technicianId: selected.id,
        technicianName: selected.name || "",
        isDefaultFixter: !!selected.isDefaultFixter,
        dayBookingCount: selected.dayBookingCount || 0,
        weekBookingCount: selected.weekBookingCount || 0,
        assignmentReason: preferred
          ? "existing_booking_assignment_is_eligible"
          : selected.isDefaultFixter
            ? "default_fixter_then_workload_ranking"
            : "workload_ranking",
      });
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
      let category = null;
      if (error.code === "SHADOW_FOUNDATION_NOT_READY") {
        report.missingFoundation += 1;
        category = "missingFoundation";
      } else if (error.code === "SLOT_CONFLICT") {
        report.conflicts += 1;
        category = "slotConflict";
      } else if (error.code === "TECHNICIAN_UNAVAILABLE") {
        report.outsideWorkingHours += 1;
        category = "outsideWorkingHours";
      } else {
        report.errors.push({
          bookingId: String(booking._id),
          message: error.message,
        });
      }
      if (category) {
        report.issues.push({
          category,
          bookingId: String(booking._id),
          slotStart: booking.date,
          message: error.message,
        });
      }
    }
  }
  return report;
}

function analyzeReservationAudit({ bookings, reservations, now = new Date() }) {
  const bookingById = new Map(bookings.map((booking) => [String(booking._id), booking]));
  const activeReservations = reservations.filter((entry) =>
    reservationBlocksAvailability(entry, now)
  );
  const staleExpiredHolds = reservations
    .filter(
      (entry) =>
        entry.status === "held" &&
        entry.holdExpiresAt &&
        new Date(entry.holdExpiresAt) <= now
    )
    .map((entry) => ({
      reservationId: String(entry._id),
      bookingId: String(entry.bookingId),
      holdExpiresAt: entry.holdExpiresAt,
      actionNeeded: "release",
    }));
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
  const staleReservations = activeReservations
    .filter((reservation) => {
      const booking = bookingById.get(String(reservation.bookingId));
      return booking && isTerminalBookingStatus(booking.status);
    })
    .map((reservation) => ({
      reservationId: String(reservation._id),
      bookingId: String(reservation.bookingId),
      bookingStatus:
        bookingById.get(String(reservation.bookingId))?.status || "",
      normalizedStatus: normalizeBookingStatus(
        bookingById.get(String(reservation.bookingId))?.status
      ),
      actionNeeded: "release",
    }));
  const missingReservations = bookings
    .filter(
      (booking) =>
        !isTerminalBookingStatus(booking.status) &&
        !(activeByBooking.get(String(booking._id)) || []).length
    )
    .map((booking) => String(booking._id));
  const reservationsWithoutBookings = activeReservations
    .filter((reservation) => !bookingById.has(String(reservation.bookingId)))
    .map((reservation) => String(reservation._id));
  const duplicateActiveReservations = [...activeByBooking.entries()]
    .filter(([, entries]) => entries.length > 1)
    .map(([bookingId, entries]) => ({
      bookingId,
      reservationIds: entries.map((entry) => String(entry._id)),
    }));
  return {
    bookingById,
    activeReservations,
    activeByBooking,
    technicianOverlaps,
    assignmentMismatch,
    staleReservations,
    staleExpiredHolds,
    missingReservations,
    reservationsWithoutBookings,
    duplicateActiveReservations,
    // Compatibility aliases for the original report keys.
    reservationsForCanceledBookings: staleReservations.map(
      (entry) => entry.reservationId
    ),
    futureBookingsWithoutReservations: missingReservations,
    bookingsWithMultipleActiveReservations: duplicateActiveReservations,
  };
}

function analyzeReservationBucketAudit({
  bookings,
  reservations,
  buckets,
  now = new Date(),
}) {
  const bookingById = new Map(
    bookings.map((booking) => [String(booking._id), booking])
  );
  const reservationById = new Map(
    reservations.map((reservation) => [
      String(reservation._id),
      reservation,
    ])
  );
  const bucketsByReservation = new Map();
  for (const bucket of buckets) {
    const key = String(bucket.reservationId);
    bucketsByReservation.set(key, [
      ...(bucketsByReservation.get(key) || []),
      bucket,
    ]);
  }
  const reservationBucketsMissing = [];
  const bucketReservationMismatch = [];
  const staleBuckets = [];
  const bucketWithoutReservation = [];
  const bucketsByTechnicianTime = new Map();
  for (const bucket of buckets) {
    const key = `${bucket.technicianId}:${new Date(
      bucket.bucketStart
    ).toISOString()}`;
    bucketsByTechnicianTime.set(key, [
      ...(bucketsByTechnicianTime.get(key) || []),
      bucket,
    ]);
  }

  for (const reservation of reservations.filter((entry) =>
    ACTIVE_RESERVATION_STATUSES.includes(entry.status)
  )) {
    const expected = new Set(
      reservationBucketStarts(
        reservation.slotStart,
        reservation.slotEnd
      ).map((value) => value.toISOString())
    );
    const actual = bucketsByReservation.get(String(reservation._id)) || [];
    const actualStarts = new Set(
      actual.map((bucket) => new Date(bucket.bucketStart).toISOString())
    );
    const missing = [...expected].filter((value) => !actualStarts.has(value));
    if (missing.length) {
      reservationBucketsMissing.push({
        reservationId: String(reservation._id),
        missingBucketStarts: missing,
      });
    }
    for (const bucket of actual) {
      if (
        String(bucket.technicianId) !== String(reservation.technicianId) ||
        String(bucket.bookingId) !== String(reservation.bookingId) ||
        !expected.has(new Date(bucket.bucketStart).toISOString())
      ) {
        bucketReservationMismatch.push(String(bucket._id));
      }
    }
  }

  for (const bucket of buckets) {
    const reservation = reservationById.get(String(bucket.reservationId));
    if (!reservation) {
      bucketWithoutReservation.push(String(bucket._id));
      continue;
    }
    const booking = bookingById.get(String(reservation.bookingId));
    const expiredHeld =
      reservation.status === "held" &&
      reservation.holdExpiresAt &&
      new Date(reservation.holdExpiresAt) <= now;
    if (
      reservation.status === "released" ||
      expiredHeld ||
      (booking && isTerminalBookingStatus(booking.status))
    ) {
      staleBuckets.push(String(bucket._id));
    }
  }

  const overlapAnalysis = analyzeReservationAudit({
    bookings,
    reservations,
    now,
  });
  const overlapsNotReflectedInBuckets = overlapAnalysis.technicianOverlaps
    .filter((overlap) => {
      const bucketSets = overlap.reservationIds.map(
        (reservationId) =>
          new Set(
            (bucketsByReservation.get(reservationId) || []).map((bucket) =>
              new Date(bucket.bucketStart).toISOString()
            )
          )
      );
      return ![...bucketSets[0]].some((value) => bucketSets[1].has(value));
    });

  return {
    reservationBucketsMissing,
    bucketWithoutReservation,
    bucketReservationMismatch: Array.from(
      new Set(bucketReservationMismatch)
    ),
    overlapsNotReflectedInBuckets,
    staleBuckets: Array.from(new Set(staleBuckets)),
    duplicateBucketKeys: [...bucketsByTechnicianTime.entries()]
      .filter(([, entries]) => entries.length > 1)
      .map(([key, entries]) => ({
        key,
        bucketIds: entries.map((entry) => String(entry._id)),
      })),
  };
}

function analyzeReservationCapacityBucketAudit({
  bookings,
  reservations,
  buckets,
  now = new Date(),
}) {
  const bookingById = new Map(
    bookings.map((booking) => [String(booking._id), booking])
  );
  const reservationById = new Map(
    reservations.map((reservation) => [
      String(reservation._id),
      reservation,
    ])
  );
  const byReservation = new Map();
  const byKey = new Map();
  for (const bucket of buckets) {
    const reservationId = String(bucket.reservationId);
    byReservation.set(reservationId, [
      ...(byReservation.get(reservationId) || []),
      bucket,
    ]);
    const key = `${new Date(bucket.bucketStart).toISOString()}:${bucket.capacityUnit}`;
    byKey.set(key, [...(byKey.get(key) || []), bucket]);
  }
  const capacityBucketsMissing = [];
  const capacityBucketWithoutReservation = [];
  const capacityBucketReservationMismatch = [];
  const staleCapacityBuckets = [];
  for (const reservation of reservations.filter((entry) =>
    reservationBlocksAvailability(entry, now)
  )) {
    const expected = reservationBucketStarts(
      reservation.slotStart,
      reservation.slotEnd
    );
    const actual = byReservation.get(String(reservation._id)) || [];
    const actualStarts = new Set(
      actual.map((entry) => new Date(entry.bucketStart).toISOString())
    );
    const missing = expected
      .map((entry) => entry.toISOString())
      .filter((entry) => !actualStarts.has(entry));
    if (missing.length) {
      capacityBucketsMissing.push({
        reservationId: String(reservation._id),
        missingBucketStarts: missing,
      });
    }
    for (const bucket of actual) {
      if (
        String(bucket.bookingId) !== String(reservation.bookingId) ||
        !expected.some(
          (entry) =>
            entry.getTime() === new Date(bucket.bucketStart).getTime()
        )
      ) {
        capacityBucketReservationMismatch.push(String(bucket._id));
      }
    }
  }
  for (const bucket of buckets) {
    const reservation = reservationById.get(String(bucket.reservationId));
    if (!reservation) {
      capacityBucketWithoutReservation.push(String(bucket._id));
      continue;
    }
    const booking = bookingById.get(String(reservation.bookingId));
    if (
      !reservationBlocksAvailability(reservation, now) ||
      (booking && isTerminalBookingStatus(booking.status))
    ) {
      staleCapacityBuckets.push(String(bucket._id));
    }
  }
  return {
    capacityBucketsMissing,
    capacityBucketWithoutReservation,
    capacityBucketReservationMismatch: [
      ...new Set(capacityBucketReservationMismatch),
    ],
    staleCapacityBuckets: [...new Set(staleCapacityBuckets)],
    duplicateCapacityBucketKeys: [...byKey.entries()]
      .filter(([, entries]) => entries.length > 1)
      .map(([key, entries]) => ({
        key,
        bucketIds: entries.map((entry) => String(entry._id)),
      })),
  };
}

async function auditReservationConflicts({ dependencies = {} } = {}) {
  const BookingModel = dependencies.BookingModel || Booking;
  const ReservationModel =
    dependencies.ReservationModel || BookingSlotReservation;
  const BucketModel =
    dependencies.BucketModel || ReservationTimeBucket;
  const CapacityBucketModel =
    dependencies.CapacityBucketModel || ReservationCapacityBucket;
  const getOptions =
    dependencies.findEligibleTechnicians || findEligibleTechnicians;
  const getAvailability =
    dependencies.availabilityForTechnician || availabilityForTechnician;
  const now = new Date();
  const [futureBookings, initialReservations, buckets, capacityBuckets] =
    await Promise.all([
    BookingModel.find({
      date: { $gte: now },
    }).lean(),
    ReservationModel.find({
      $or: [
        { status: { $in: ACTIVE_RESERVATION_STATUSES } },
        { slotStart: { $gte: now } },
      ],
    }).lean(),
    BucketModel.find({}).lean(),
    CapacityBucketModel.find({}).lean(),
  ]);
  const bucketReservationIds = Array.from(
    new Set(
      [...buckets, ...capacityBuckets].map((bucket) =>
        String(bucket.reservationId)
      )
    )
  );
  const bucketReservations = bucketReservationIds.length
    ? await ReservationModel.find({
        _id: { $in: bucketReservationIds },
      }).lean()
    : [];
  const reservationMap = new Map();
  for (const reservation of [
    ...initialReservations,
    ...bucketReservations,
  ]) {
    reservationMap.set(String(reservation._id), reservation);
  }
  const reservations = Array.from(reservationMap.values());
  const linkedBookingIds = Array.from(
    new Set(reservations.map((reservation) => String(reservation.bookingId)))
  );
  const linkedBookings = linkedBookingIds.length
    ? await BookingModel.find({ _id: { $in: linkedBookingIds } }).lean()
    : [];
  const completeBookingMap = new Map();
  for (const booking of [...futureBookings, ...linkedBookings]) {
    completeBookingMap.set(String(booking._id), booking);
  }
  const bookings = Array.from(completeBookingMap.values());
  const {
    bookingById,
    activeReservations,
    technicianOverlaps,
    assignmentMismatch,
    staleReservations,
    staleExpiredHolds,
    missingReservations,
    reservationsWithoutBookings,
    duplicateActiveReservations,
  } = analyzeReservationAudit({ bookings, reservations, now });
  const outsideAvailability = [];
  const noEligibleTechnician = [];
  const outsideWorkingHours = [];
  for (const booking of futureBookings.filter(
    (entry) =>
      !isTerminalBookingStatus(entry.status) &&
      missingReservations.includes(String(entry._id))
  )) {
    try {
      const options = await getOptions({ slotStart: booking.date });
      if (!options.available.length) {
        const reasons = options.unavailable.map((entry) =>
          String(entry.reason || "").toLowerCase()
        );
        const outsideSchedule =
          reasons.length > 0 &&
          reasons.every(
            (reason) =>
              reason.includes("outside schedule") ||
              reason.includes("does not fit")
          );
        (outsideSchedule ? outsideWorkingHours : noEligibleTechnician).push(
          String(booking._id)
        );
      }
    } catch (error) {
      if (error.code === "SHADOW_FOUNDATION_NOT_READY") {
        noEligibleTechnician.push(String(booking._id));
      } else {
        outsideWorkingHours.push(String(booking._id));
      }
    }
  }
  for (const reservation of activeReservations) {
    const booking = bookingById.get(String(reservation.bookingId));
    if (!booking) continue;
    try {
      const availability = await getAvailability({
        technicianId: reservation.technicianId,
        slotStart: reservation.slotStart,
      });
      if (!availability.available) outsideAvailability.push(String(reservation._id));
    } catch {
      outsideAvailability.push(String(reservation._id));
    }
  }
  const bucketAudit = analyzeReservationBucketAudit({
    bookings,
    reservations,
    buckets,
    now,
  });
  const capacityBucketAudit = analyzeReservationCapacityBucketAudit({
    bookings,
    reservations,
    buckets: capacityBuckets,
    now,
  });
  return {
    generatedAt: new Date(),
    missingReservation: missingReservations,
    duplicateActiveReservations,
    staleReservationForTerminalBooking: staleReservations,
    staleExpiredHolds,
    assignmentMismatch,
    technicianOverlap: technicianOverlaps,
    reservationWithoutBooking: reservationsWithoutBookings,
    reservationOutsideAvailability: outsideAvailability,
    noEligibleTechnician,
    outsideWorkingHours,
    ...bucketAudit,
    ...capacityBucketAudit,
    // Compatibility aliases for existing consumers.
    futureBookingsWithoutReservations: missingReservations,
    reservationsWithoutBookings,
    bookingsWithMultipleActiveReservations: duplicateActiveReservations,
    technicianOverlaps,
    reservationsForCanceledBookings: staleReservations.map(
      (entry) => entry.reservationId
    ),
    reservationsOutsideAvailability: outsideAvailability,
  };
}

module.exports = {
  ACTIVE_RESERVATION_STATUSES,
  TERMINAL_BOOKING_STATUSES,
  TIMEZONE,
  VISIT_DURATION_MINUTES,
  analyzeReservationAudit,
  analyzeReservationBucketAudit,
  analyzeReservationCapacityBucketAudit,
  applyCapacityBucketMove,
  applyBucketMove,
  assertNoTechnicianOverlap,
  auditReservationConflicts,
  backfillReservationsForFutureBookings,
  blockingReservationFilter,
  bucketDocuments,
  capacityBucketDocuments,
  cancelBookingWithReservation,
  createBookingWithReservation,
  createCapacityBuckets,
  createReservationBuckets,
  deleteReservationBuckets,
  ensureReservationLocks,
  findEligibleTechnicians,
  isTerminalBookingStatus,
  moveReservationForBooking,
  overlaps,
  planBucketMove,
  normalizeBookingStatus,
  rankEligibleTechnicians,
  releaseExpiredHolds,
  releaseReservationForBooking,
  reservationBlocksAvailability,
  reservationEngineEnabled,
  reservationBucketStarts,
  reservationWindow,
  reserveSlotForBooking,
  transitionBookingWithReservation,
};
