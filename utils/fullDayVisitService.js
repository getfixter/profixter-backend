const moment = require("moment-timezone");

const Booking = require("../models/Booking");
const BookingSlotReservation = require("../models/BookingSlotReservation");
const CalendarConfig = require("../models/CalendarConfig");
const ReservationTimeBucket = require("../models/ReservationTimeBucket");
const SlotCounter = require("../models/SlotCounter");
const {
  calculateDayFromContext,
  loadAvailabilityContext,
} = require("./availabilityService");
const { hoursForDate, hhmmInTZ, leadDays, ymdInTZ } = require("./legacyCalendarSlots");
const { logBookingCreated, logReservationAction } = require("./bookingHistory");
const { runReservationTransaction } = require("./reservationTransaction");
const {
  blockingReservationFilter,
  createReservationBuckets,
  deleteReservationBuckets,
  isTerminalBookingStatus,
  rankEligibleTechnicians,
  releaseExpiredHolds,
  reservationEngineEnabled,
} = require("./slotReservationService");

const TIMEZONE = "America/New_York";
const BUCKET_MS = 15 * 60 * 1000;
const FULL_DAY_SERVICE = "Full Day Fixter";
const FULL_DAY_PRODUCT_KIND = "full_day_visit";

/**
 * Full Day availability and reservation.
 *
 * Two engines, one answer. The reservation engine models a specific Fixter's
 * time, so there a Full Day is exactly what it sounds like: one Fixter, their
 * whole configured workday, held by the same ReservationTimeBucket rows that
 * hold a 90-minute visit, so a Full Day and an ordinary visit exclude each other
 * in the database rather than by agreement between two code paths.
 *
 * The legacy calendar does not know which Fixter takes which booking. It only
 * counts how many jobs can run at once. There, a Full Day is one unit of that
 * count for every hour of the day, which is the same fact expressed in the only
 * vocabulary the legacy system has. It is not per-Fixter, because nothing in the
 * legacy system is, and pretending otherwise would sell a day we cannot promise.
 */

function serviceError(code, message, statusCode = 409) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function alignUp(ms) {
  return Math.ceil(ms / BUCKET_MS) * BUCKET_MS;
}

function alignDown(ms) {
  return Math.floor(ms / BUCKET_MS) * BUCKET_MS;
}

/* ------------------------------------------------------------------ */
/* Reservation engine path                                            */
/* ------------------------------------------------------------------ */

/**
 * The span a Full Day occupies: the first configured start of the day through
 * the end of the last one, gaps included. A gap in the middle of a Fixter's day
 * is still their day; leaving it bookable would sell someone a 90-minute visit
 * inside a day we already sold.
 */
function workdaySpan(detail, date, timezone) {
  const slots = detail?.slots || [];
  if (!slots.length) return null;
  const first = slots[0];
  const last = slots[slots.length - 1];
  const start = moment.tz(`${date} ${first.time}`, "YYYY-MM-DD HH:mm", timezone);
  const end = moment.tz(`${date} ${last.endTime}`, "YYYY-MM-DD HH:mm", timezone);
  if (!start.isValid() || !end.isValid() || !end.isAfter(start)) return null;
  const startMs = alignDown(start.valueOf());
  const endMs = alignUp(end.valueOf());
  if (endMs <= startMs) return null;
  return {
    start: new Date(startMs),
    end: new Date(endMs),
    startTime: first.time,
    endTime: last.endTime,
    hours: Math.round(((endMs - startMs) / (60 * 60 * 1000)) * 10) / 10,
  };
}

function technicianStateFor(slot, technicianId) {
  return (slot.technicians || []).find(
    (entry) => String(entry.id) === String(technicianId)
  );
}

/**
 * Is the whole day inside the company's booking window? A Full Day is sold as
 * one thing, so it is bookable only when every hour of it is: half a day that
 * has already started is not a Full Day at a discount, it is a broken promise.
 */
function spanInsideBookingWindow(span, companyTemplate, timezone, now) {
  const nowLocal = moment(now).tz(timezone);
  const minBookable = nowLocal
    .clone()
    .add(Number(companyTemplate?.minLeadMinutes || 0), "minutes");
  const maxBookable = nowLocal
    .clone()
    .add(Number(companyTemplate?.maxAdvanceDays || 0), "days")
    .endOf("day");
  const start = moment(span.start).tz(timezone);
  return !start.isBefore(minBookable) && !start.isAfter(maxBookable);
}

/** Fixters whose entire configured day on this date is free. */
async function engineCandidatesForDate({ context, date, now }) {
  const timezone = context.timezone || TIMEZONE;
  const detail = calculateDayFromContext({
    date,
    context,
    now,
    includeDetails: true,
  });
  const span = workdaySpan(detail, date, timezone);
  if (!span) return { span: null, candidates: [], reason: "Closed that day" };
  if (!spanInsideBookingWindow(span, context.companyTemplate, timezone, now)) {
    return { span, candidates: [], reason: "Outside the booking window" };
  }

  const wholeDayFree = (context.technicians || []).filter((technician) =>
    detail.slots.every((slot) => {
      const state = technicianStateFor(slot, technician._id);
      return !!state?.available && !state.booked;
    })
  );
  if (!wholeDayFree.length) {
    return { span, candidates: [], reason: "No Fixter is free for the whole day" };
  }

  // Anything already holding time inside the span rules that Fixter out. The
  // unique index on (technicianId, bucketStart) will refuse the write anyway;
  // this is so the customer is never offered a day that is going to be refused.
  const busy = await ReservationTimeBucket.find({
    technicianId: { $in: wholeDayFree.map((technician) => technician._id) },
    bucketStart: { $gte: span.start, $lt: span.end },
  })
    .select("technicianId")
    .lean();
  const busyIds = new Set(busy.map((entry) => String(entry.technicianId)));

  const free = wholeDayFree.filter(
    (technician) => !busyIds.has(String(technician._id))
  );
  if (!free.length) {
    return { span, candidates: [], reason: "No Fixter is free for the whole day" };
  }

  const dayStart = moment.tz(date, "YYYY-MM-DD", timezone).startOf("day").toDate();
  const dayEnd = moment.tz(date, "YYYY-MM-DD", timezone).add(1, "day").startOf("day").toDate();
  const dayBookings = await Booking.find({
    assignedFixterId: { $in: free.map((technician) => technician._id) },
    date: { $gte: dayStart, $lt: dayEnd },
  })
    .select("assignedFixterId status")
    .lean();
  const bookedIds = new Set(
    dayBookings
      .filter((booking) => !isTerminalBookingStatus(booking.status))
      .map((booking) => String(booking.assignedFixterId))
  );

  const candidates = free
    .filter((technician) => !bookedIds.has(String(technician._id)))
    .map((technician) => ({
      id: String(technician._id),
      name: technician.name || "",
      email: technician.email || "",
      position: technician.employeePosition || "",
      isDefaultFixter: !!technician.isDefaultFixter,
      dayBookingCount: 0,
      weekBookingCount: 0,
    }));

  return {
    span,
    candidates: rankEligibleTechnicians(candidates),
    reason: candidates.length ? "" : "No Fixter is free for the whole day",
  };
}

/* ------------------------------------------------------------------ */
/* Legacy calendar path                                               */
/* ------------------------------------------------------------------ */

/** How many jobs already occupy each configured hour of a legacy day. */
async function legacyDayLoad(cfg, date) {
  const timezone = cfg?.timezone || TIMEZONE;
  const hours = hoursForDate(cfg, date);
  if (!hours.length) return { hours, taken: {} };

  const counters = await SlotCounter.find({
    ymd: date,
    time: { $in: hours },
  }).lean();
  const taken = Object.fromEntries(counters.map((entry) => [entry.time, entry.count]));

  // The same sweep /api/calendar/slots does: a booking that never reached the
  // counter still occupies the hour, and Full Day must see it.
  const dayStart = new Date(`${date}T00:00:00.000Z`);
  const dayEnd = new Date(`${date}T23:59:59.999Z`);
  const live = await Booking.find({
    date: { $gte: dayStart, $lte: dayEnd },
    status: {
      $nin: [
        "Canceled",
        "Cancelled",
        "Completed",
        "Complete",
        "Done",
        "Failed",
        "No-Show",
        "Noshow",
      ],
    },
  })
    .select("date")
    .lean();
  for (const booking of live) {
    const key = hhmmInTZ(new Date(booking.date), timezone);
    if (hours.includes(key)) taken[key] = Math.max(taken[key] || 0, 0) + 1;
  }
  return { hours, taken };
}

function legacySpan(date, hours, cfg) {
  const timezone = cfg?.timezone || TIMEZONE;
  const slotMinutes = Math.max(15, Number(cfg?.slotMinutes || 60));
  const start = moment.tz(`${date} ${hours[0]}`, "YYYY-MM-DD HH:mm", timezone);
  const end = moment
    .tz(`${date} ${hours[hours.length - 1]}`, "YYYY-MM-DD HH:mm", timezone)
    .add(slotMinutes, "minutes");
  if (!start.isValid() || !end.isValid()) return null;
  return {
    start: start.toDate(),
    end: end.toDate(),
    startTime: hours[0],
    endTime: end.format("HH:mm"),
    hours: Math.round(((end.valueOf() - start.valueOf()) / (60 * 60 * 1000)) * 10) / 10,
  };
}

function legacyDayAvailable({ cfg, date, hours, taken, now }) {
  if (!hours.length) return { available: false, reason: "Closed that day" };
  const timezone = cfg?.timezone || TIMEZONE;
  const diff = leadDays(date, timezone, now);
  if (diff < Number(cfg?.minLeadDays || 0)) {
    return { available: false, reason: "Outside the booking window" };
  }
  const capacity = Math.max(1, Number(cfg?.maxConcurrent ?? 1));
  const full = hours.some((hour) => (taken[hour] || 0) >= capacity);
  return full
    ? { available: false, reason: "Another job is already booked that day" }
    : { available: true, reason: "" };
}

/**
 * Claim one unit of company capacity for every hour of a legacy day.
 *
 * Conditional per hour, exactly like the single-slot gate the one-time flow
 * uses, and rolled back hour by hour if any of them is lost. The legacy
 * calendar has no transaction to lean on, which is precisely why the reserved
 * hours are unwound rather than left behind on failure.
 */
async function stampLegacyFullDay({ cfg, date, hours }) {
  const capacity = Math.max(1, Number(cfg?.maxConcurrent ?? 1));
  const stamped = [];
  for (const hour of hours) {
    const gate = await SlotCounter.findOneAndUpdate(
      {
        ymd: date,
        time: hour,
        $or: [{ count: { $lt: capacity } }, { count: { $exists: false } }],
      },
      { $inc: { count: 1 }, $setOnInsert: { ymd: date, time: hour } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    if (!gate || gate.count > capacity) {
      if (gate) stamped.push(hour);
      await releaseLegacyFullDay({ date, hours: stamped });
      throw serviceError(
        "SLOT_UNAVAILABLE",
        "That day is no longer free. Please choose another date."
      );
    }
    stamped.push(hour);
  }
  return stamped;
}

async function releaseLegacyFullDay({ date, hours }) {
  for (const hour of hours || []) {
    try {
      await SlotCounter.updateOne({ ymd: date, time: hour }, { $inc: { count: -1 } });
    } catch (error) {
      console.warn("Full Day legacy slot release failed:", error.message);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Public availability                                                */
/* ------------------------------------------------------------------ */

async function fullDayAvailabilityForRange({ from, to, now = new Date() }) {
  if (!isValidDate(from) || !isValidDate(to)) {
    throw serviceError("INVALID_RANGE", "from and to must be YYYY-MM-DD", 400);
  }
  const start = moment.tz(from, "YYYY-MM-DD", true, TIMEZONE);
  const end = moment.tz(to, "YYYY-MM-DD", true, TIMEZONE);
  if (!start.isValid() || !end.isValid() || end.isBefore(start)) {
    throw serviceError("INVALID_RANGE", "Invalid date range", 400);
  }
  if (end.diff(start, "days") > 92) {
    throw serviceError("RANGE_TOO_LARGE", "Range cannot exceed 92 days", 400);
  }

  const days = [];
  if (reservationEngineEnabled()) {
    const context = await loadAvailabilityContext({ from, to, scope: "company" });
    for (
      let cursor = start.clone();
      cursor.isSameOrBefore(end, "day");
      cursor.add(1, "day")
    ) {
      const date = cursor.format("YYYY-MM-DD");
      const result = await engineCandidatesForDate({ context, date, now });
      days.push({
        date,
        available: result.candidates.length > 0,
        fixtersAvailable: result.candidates.length,
        startTime: result.span?.startTime || "",
        endTime: result.span?.endTime || "",
        hours: result.span?.hours || 0,
        reason: result.candidates.length ? "" : result.reason,
      });
    }
    return { timezone: TIMEZONE, engine: "reservation", days };
  }

  const cfg = await CalendarConfig.findOne().lean();
  for (
    let cursor = start.clone();
    cursor.isSameOrBefore(end, "day");
    cursor.add(1, "day")
  ) {
    const date = cursor.format("YYYY-MM-DD");
    const { hours, taken } = await legacyDayLoad(cfg, date);
    const verdict = legacyDayAvailable({ cfg, date, hours, taken, now });
    const span = hours.length ? legacySpan(date, hours, cfg) : null;
    days.push({
      date,
      available: verdict.available,
      // The legacy calendar counts jobs, not people. One free unit is one Full
      // Day, and reporting it as such keeps the shape of the response identical
      // for both engines without inventing a headcount we do not have.
      fixtersAvailable: verdict.available ? 1 : 0,
      startTime: span?.startTime || "",
      endTime: span?.endTime || "",
      hours: span?.hours || 0,
      reason: verdict.reason,
    });
  }
  return { timezone: TIMEZONE, engine: "legacy", days };
}

async function assertFullDayBookable({ date, now = new Date() }) {
  if (!isValidDate(date)) {
    throw serviceError("INVALID_DATE", "date must be YYYY-MM-DD", 400);
  }
  if (reservationEngineEnabled()) {
    const context = await loadAvailabilityContext({
      from: date,
      to: date,
      scope: "company",
    });
    const result = await engineCandidatesForDate({ context, date, now });
    if (!result.candidates.length) {
      throw serviceError(
        "FULL_DAY_UNAVAILABLE",
        result.reason || "That day is not available for a Full Day."
      );
    }
    return { engine: "reservation", span: result.span, candidates: result.candidates };
  }
  const cfg = await CalendarConfig.findOne().lean();
  const { hours, taken } = await legacyDayLoad(cfg, date);
  const verdict = legacyDayAvailable({ cfg, date, hours, taken, now });
  if (!verdict.available) {
    throw serviceError(
      "FULL_DAY_UNAVAILABLE",
      verdict.reason || "That day is not available for a Full Day."
    );
  }
  return { engine: "legacy", cfg, hours, span: legacySpan(date, hours, cfg) };
}

/* ------------------------------------------------------------------ */
/* Booking                                                            */
/* ------------------------------------------------------------------ */

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

/**
 * Create the booking and take the day off the board in one step.
 *
 * Under the reservation engine that is a single transaction, so a Full Day
 * either owns every bucket of the Fixter's workday or owns none of them. Under
 * the legacy calendar the hours are claimed first and the booking second, and
 * the hours are given back if the booking fails, because the legacy path has no
 * transaction and a claimed hour with no booking behind it is the worse of the
 * two failures to leave lying around.
 */
async function createFullDayBooking({
  bookingData,
  date,
  reservationStatus = "reserved",
  holdExpiresAt = null,
  actorUser = null,
  createdByType = "customer",
  now = new Date(),
}) {
  const bookable = await assertFullDayBookable({ date, now });

  if (bookable.engine === "legacy") {
    const stamped = await stampLegacyFullDay({
      cfg: bookable.cfg,
      date,
      hours: bookable.hours,
    });
    try {
      const booking = new Booking({
        ...bookingData,
        date: bookable.span.start,
        scheduledStart: bookable.span.start,
        scheduledEnd: bookable.span.end,
      });
      await booking.save();
      await logBookingCreated({
        booking,
        actor: historyActor({ actorUser, createdByType }),
      });
      return {
        booking,
        reservation: null,
        technician: null,
        span: bookable.span,
        legacyHours: stamped,
      };
    } catch (error) {
      await releaseLegacyFullDay({ date, hours: stamped });
      throw error;
    }
  }

  const { span, candidates } = bookable;
  let lastError = null;
  // Walk the ranked Fixters. The unique bucket index is the only thing that
  // truly decides, so losing a race to another customer means trying the next
  // Fixter rather than telling this one the day is gone.
  for (const candidate of candidates) {
    try {
      return await runReservationTransaction(async (session) => {
        await releaseExpiredHolds(session, now);
        const [booking] = await Booking.create(
          [
            {
              ...bookingData,
              date: span.start,
              assignedFixterId: candidate.id,
              assignedFixterName: candidate.name,
              assignedFixterEmail: candidate.email,
              assignedFixterPosition: candidate.position,
              scheduledStart: span.start,
              scheduledEnd: span.end,
              assignmentSource: "automatic",
            },
          ],
          { session }
        );
        const [reservation] = await BookingSlotReservation.create(
          [
            {
              bookingId: booking._id,
              technicianId: candidate.id,
              kind: "full_day",
              slotStart: span.start,
              slotEnd: span.end,
              timezone: TIMEZONE,
              status: reservationStatus,
              holdExpiresAt,
              createdByType,
              createdBy: actorUser?._id || null,
            },
          ],
          { session }
        );
        await createReservationBuckets({ reservation, session });
        booking.slotReservationId = reservation._id;
        await booking.save({ session });
        await logBookingCreated({
          booking,
          actor: historyActor({ actorUser, createdByType }),
          session,
        });
        await logReservationAction({
          bookingId: booking._id,
          actionType:
            reservationStatus === "held"
              ? "reservation_hold_created"
              : "reservation_created",
          summary:
            reservationStatus === "held"
              ? "Full Day reservation hold created"
              : "Full Day reservation created",
          actor: historyActor({ actorUser, createdByType }),
          changes: [
            {
              field: "reservation",
              label: "Reservation",
              oldValue: "None",
              newValue: `${candidate.name} · Full Day ${span.start.toISOString()}-${span.end.toISOString()}`,
            },
          ],
          session,
        });
        return {
          booking,
          reservation,
          technician: candidate,
          span,
          legacyHours: [],
        };
      });
    } catch (error) {
      lastError = error;
      if (error?.code === 11000 || error?.code === "SLOT_CONFLICT") continue;
      throw error;
    }
  }
  throw (
    lastError && lastError.code !== 11000
      ? lastError
      : serviceError(
          "FULL_DAY_UNAVAILABLE",
          "That day was just taken. Please choose another date."
        )
  );
}

/** Give a Full Day's time back, whichever engine is holding it. */
async function releaseFullDayCapacity(booking) {
  if (!booking) return;
  if (booking.slotReservationId) {
    try {
      await runReservationTransaction(async (session) => {
        const reservation = await BookingSlotReservation.findOne({
          _id: booking.slotReservationId,
          status: { $in: ["held", "reserved"] },
        }).session(session);
        if (!reservation) return;
        await deleteReservationBuckets({ reservationId: reservation._id, session });
        reservation.status = "released";
        reservation.releasedAt = new Date();
        reservation.releaseReason = "Full Day released";
        await reservation.save({ session });
      });
    } catch (error) {
      console.warn("Full Day reservation release failed:", error.message);
    }
    return;
  }
  const cfg = await CalendarConfig.findOne().lean();
  const timezone = cfg?.timezone || TIMEZONE;
  const date = ymdInTZ(new Date(booking.date), timezone);
  const hours = hoursForDate(cfg, date);
  await releaseLegacyFullDay({ date, hours });
}

module.exports = {
  FULL_DAY_PRODUCT_KIND,
  FULL_DAY_SERVICE,
  TIMEZONE,
  assertFullDayBookable,
  blockingReservationFilter,
  createFullDayBooking,
  engineCandidatesForDate,
  fullDayAvailabilityForRange,
  legacyDayAvailable,
  legacyDayLoad,
  legacySpan,
  releaseFullDayCapacity,
  releaseLegacyFullDay,
  stampLegacyFullDay,
  workdaySpan,
};
