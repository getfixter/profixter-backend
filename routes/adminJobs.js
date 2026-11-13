/**
 * The new Jobs API (Admin redesign, 2026-11-12). Mounted at /api/admin.
 *
 *   GET   /jobs                              list by NY date window, lean JobRow DTOs + counts
 *   POST  /jobs/search                       all-dates search (text in the body, never the URL)
 *   GET   /jobs/:id                          JobDetail DTO with allowedActions
 *   GET   /jobs/:id/assignment-options       eligible Fixters for the job's time (bookings.assign)
 *   POST  /jobs/:id/transition               confirm | complete | cancel | reinstate (allow-list, atomic)
 *   PATCH /jobs/:id                          note / adminNote / assignedFixterId, with expectedUpdatedAt
 *   POST  /jobs/:id/notes                    append an internal staff note
 *   POST  /jobs/:id/photos                   add job photos (multipart "images")
 *   POST  /jobs/:id/reschedule               move to a new time through the reservation engine
 *   GET   /schedule                          jobs by technician + capacity for a day/week
 *   GET   /my-day                            the caller's own jobs today and tomorrow
 *
 * Every route reads and writes through the record scope in utils/jobs/jobAccess:
 * a field Fixter sees and acts on their own jobs only (Q-1). Errors are
 * { message, code }: 409 STALE, 409 INVALID_TRANSITION, 403 FORBIDDEN_RECORD.
 */
const express = require("express");
const mongoose = require("mongoose");
const moment = require("moment-timezone");

const auth = require("../middleware/auth");
const { PERMISSIONS, requirePermission } = require("../middleware/authorize");
const Booking = require("../models/Booking");
const { createAdminActivityLog } = require("../utils/adminActivityLog");
const { snapshot: bookingSnapshot, logBookingChanges } = require("../utils/bookingHistory");
const { actorSnapshot, appendContentUpdate } = require("../utils/bookingContentUpdates");
const { uploadAppointmentPhotos, storeAppointmentImages } = require("../utils/bookingAttachments");
const {
  activeReservationForBooking,
  findEligibleTechnicians,
  moveReservationForBooking,
  reservationEngineEnabled,
  resetBookingReminderEmailStateForDateChange,
} = require("../utils/slotReservationService");
const { performTransition, TransitionError } = require("../utils/bookingTransitions");
const { IdempotencyError, readIdempotencyKey, runIdempotent } = require("../utils/adminIdempotency");
const { assertJobAccess, canSeeAllJobs, JobAccessError } = require("../utils/jobs/jobAccess");
const { STATUS, TIMEZONE, canonicalStatus, isFinalStatus, isFreeVisit } = require("../utils/jobs/jobStatus");
const { JobQueryError, jobDetail, listJobs, myDay, scheduleView, searchJobs } = require("../utils/jobs/jobQueries");
const { notifyAssignment, notifyRescheduled } = require("../utils/jobs/jobNotifications");

const router = express.Router();
const bookingsRead = requirePermission(PERMISSIONS.BOOKINGS_READ);
const bookingsWrite = requirePermission(PERMISSIONS.BOOKINGS_WRITE);
const bookingsAssign = requirePermission(PERMISSIONS.BOOKINGS_ASSIGN);

function sendError(res, error, fallback) {
  const known =
    error instanceof TransitionError ||
    error instanceof JobQueryError ||
    error instanceof JobAccessError ||
    error instanceof IdempotencyError ||
    (error?.statusCode && error?.code);
  if (known) {
    const status = Number(error.statusCode) || 400;
    return res.status(status).json({ message: error.message, code: error.code, ...(error.extra || {}) });
  }
  console.error(`${fallback}:`, error);
  return res.status(500).json({ message: fallback, code: "SERVER_ERROR" });
}

function badRequest(code, message) {
  return Object.assign(new Error(message), { code, statusCode: 400 });
}

async function loadJob(req, { withNotes = false } = {}) {
  if (!mongoose.isValidObjectId(req.params.id)) throw Object.assign(new Error("Invalid job id"), { code: "INVALID_BOOKING", statusCode: 400 });
  const query = Booking.findById(req.params.id);
  if (withNotes) query.select("+staffNotes");
  const booking = await query;
  if (!booking) throw Object.assign(new Error("Job not found"), { code: "BOOKING_NOT_FOUND", statusCode: 404 });
  assertJobAccess(req, booking);
  return booking;
}

async function detailFor(req, id) {
  const booking = await Booking.findById(id).select("+staffNotes").lean();
  return booking ? jobDetail(req, booking) : null;
}

function readExpectedUpdatedAt(value, { required }) {
  if (value === undefined || value === null || value === "") {
    if (required) throw badRequest("PRECONDITION_REQUIRED", "expectedUpdatedAt is required.");
    return null;
  }
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) throw badRequest("INVALID_PRECONDITION", "expectedUpdatedAt is not a date.");
  return new Date(ms);
}

function staleError(booking) {
  return Object.assign(new Error("This job changed since you loaded it. Reload and try again."), {
    code: "STALE",
    statusCode: 409,
    extra: { currentStatus: canonicalStatus(booking?.status), updatedAt: booking?.updatedAt || null },
  });
}

function assertFresh(booking, expected) {
  if (expected && new Date(booking.updatedAt).getTime() !== expected.getTime()) throw staleError(booking);
}

/* --------------------------------- reads --------------------------------- */

router.get("/jobs", auth, ...bookingsRead, async (req, res) => {
  try {
    const result = await listJobs(req, {
      view: String(req.query.view || "today"),
      from: req.query.from,
      to: req.query.to,
      tech: req.query.tech,
      status: req.query.status,
      cursor: req.query.cursor,
      limit: req.query.limit,
    });
    return res.json(result);
  } catch (error) {
    return sendError(res, error, "Failed to load jobs");
  }
});

router.post("/jobs/search", auth, ...bookingsRead, express.json(), async (req, res) => {
  try {
    return res.json(await searchJobs(req, { q: req.body?.q, limit: req.body?.limit }));
  } catch (error) {
    return sendError(res, error, "Search failed");
  }
});

router.get("/jobs/:id", auth, ...bookingsRead, async (req, res) => {
  try {
    const booking = await loadJob(req, { withNotes: true });
    return res.json({ job: await jobDetail(req, booking.toObject()) });
  } catch (error) {
    return sendError(res, error, "Failed to load the job");
  }
});

router.get("/jobs/:id/assignment-options", auth, ...bookingsAssign, async (req, res) => {
  try {
    const booking = await loadJob(req);
    const options = await findEligibleTechnicians({
      slotStart: booking.date,
      excludeReservationId: booking.slotReservationId || null,
      excludeBookingId: booking._id,
    });
    const currentId = booking.assignedFixterId ? String(booking.assignedFixterId) : null;
    const listed = [...options.available, ...options.unavailable].some((t) => String(t.id) === currentId);
    return res.json({
      bookingId: String(booking._id),
      slotStart: options.slotStart,
      slotEnd: options.slotEnd,
      availableTechnicians: options.available,
      unavailableTechnicians: options.unavailable,
      recommendedTechnician: options.recommended,
      // The person assigned now, even when they are no longer an active Fixter (J-06).
      currentTechnician: currentId
        ? { id: currentId, name: booking.assignedFixterName || "", inactiveOrRemoved: !listed }
        : null,
    });
  } catch (error) {
    return sendError(res, error, "Failed to load assignment options");
  }
});

router.get("/schedule", auth, ...bookingsRead, async (req, res) => {
  try {
    const today = moment.tz(TIMEZONE).format("YYYY-MM-DD");
    const from = String(req.query.from || today);
    return res.json(await scheduleView(req, { from, to: req.query.to || from, tech: req.query.tech }));
  } catch (error) {
    return sendError(res, error, "Failed to load the schedule");
  }
});

router.get("/my-day", auth, ...bookingsRead, async (req, res) => {
  try {
    return res.json(await myDay(req));
  } catch (error) {
    return sendError(res, error, "Failed to load your day");
  }
});

/* ------------------------------- transition ------------------------------ */

router.post("/jobs/:id/transition", auth, ...bookingsWrite, express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    const action = String(body.action || "");
    if (!body.expectedStatus) throw badRequest("PRECONDITION_REQUIRED", "expectedStatus is required.");
    const key = readIdempotencyKey(body.idempotencyKey);
    if (!mongoose.isValidObjectId(req.params.id)) throw badRequest("INVALID_BOOKING", "Invalid job id");
    const result = await runIdempotent({ req, action: `job.transition.${action}`, key, entityId: req.params.id }, async () => {
      const outcome = await performTransition({
        req,
        bookingId: req.params.id,
        action,
        expectedStatus: body.expectedStatus,
        expectedUpdatedAt: readExpectedUpdatedAt(body.expectedUpdatedAt, { required: false }),
        assignedFixterId: body.assignedFixterId || undefined,
        targetStatus: body.targetStatus,
        notifyCustomer: action === "reinstate" ? body.notifyCustomer === true : undefined,
        reason: body.reason,
        source: "adminJobTransition",
      });
      return {
        httpStatus: 200,
        body: {
          booking: await detailFor(req, outcome.booking._id),
          transition: outcome.transition,
          notifications: outcome.notifications || [],
          ...(outcome.payment ? { payment: outcome.payment } : {}),
          ...(outcome.fullDayRestore ? { fullDayRestore: outcome.fullDayRestore } : {}),
          ...(outcome.routedTo ? { routedTo: outcome.routedTo } : {}),
        },
      };
    });
    return res.status(result.httpStatus).json({ ...result.body, replayed: result.replayed });
  } catch (error) {
    return sendError(res, error, "Failed to change the job");
  }
});

/* ---------------------------------- edit --------------------------------- */

router.patch("/jobs/:id", auth, ...bookingsWrite, express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    if (body.date !== undefined || body.slotStart !== undefined) {
      throw badRequest("USE_RESCHEDULE", "Use POST /api/admin/jobs/:id/reschedule to change the time.");
    }
    const expected = readExpectedUpdatedAt(body.expectedUpdatedAt, { required: true });
    const booking = await loadJob(req);
    assertFresh(booking, expected);

    // Only fields that actually differ from what is stored count as changes (J-06).
    const set = {};
    if (body.note !== undefined && String(body.note) !== String(booking.note || "")) set.note = String(body.note).slice(0, 5000);
    if (body.adminNote !== undefined && String(body.adminNote) !== String(booking.adminNote || "")) set.adminNote = String(body.adminNote).slice(0, 5000);
    const assignmentChanged =
      body.assignedFixterId !== undefined && String(body.assignedFixterId || "") !== String(booking.assignedFixterId || "");

    const scoped = !canSeeAllJobs(req);
    if (scoped && (set.note !== undefined || assignmentChanged)) {
      throw Object.assign(new Error("You can add notes and photos to your jobs; ask the office to change the description or the Fixter."), {
        code: "FORBIDDEN_ACTION",
        statusCode: 403,
      });
    }
    if (assignmentChanged && isFinalStatus(booking.status)) {
      throw new TransitionError("INVALID_TRANSITION", `This job is ${canonicalStatus(booking.status)}. Reinstate it before changing the Fixter.`);
    }
    if (!Object.keys(set).length && !assignmentChanged) {
      return res.json({ booking: await detailFor(req, booking._id), changed: [], notifications: [] });
    }

    const before = bookingSnapshot(booking);
    // The stale gate: one atomic write conditional on the updatedAt the editor loaded.
    const gated = await Booking.findOneAndUpdate(
      { _id: booking._id, updatedAt: booking.updatedAt },
      { $set: Object.keys(set).length ? set : { adminNote: booking.adminNote || "" } },
      { new: true }
    );
    if (!gated) throw staleError(await Booking.findById(booking._id).select("status updatedAt").lean());

    const notifications = [];
    if (assignmentChanged) {
      try {
        if (reservationEngineEnabled()) {
          if (!body.assignedFixterId && (await activeReservationForBooking(booking._id))) {
            throw Object.assign(new Error("A reserved booking cannot be unassigned"), { code: "TECHNICIAN_REQUIRED", statusCode: 400 });
          }
          await moveReservationForBooking({
            bookingId: booking._id,
            technicianId: body.assignedFixterId,
            slotStart: booking.date,
            actorUser: req.accessUser,
            createdByType: "admin",
            assignmentSource: req.accessRole === "admin" ? "admin" : "general_fixter",
          });
        } else {
          const { resolveAssignmentFields } = require("../utils/jobs/assignment");
          await Booking.updateOne({ _id: booking._id }, { $set: await resolveAssignmentFields(body.assignedFixterId || null) });
        }
      } catch (error) {
        // All or nothing: the note edits made by the gate are put back.
        const revert = {};
        for (const key of Object.keys(set)) revert[key] = booking[key] || "";
        if (Object.keys(revert).length) await Booking.updateOne({ _id: booking._id }, { $set: revert }).catch(() => {});
        throw error;
      }
    }
    const after = await Booking.findById(booking._id);
    await logBookingChanges({ bookingId: after._id, before, after: bookingSnapshot(after), req });
    if (assignmentChanged) {
      notifications.push({ ...(await notifyAssignment(after, { previousFixterId: before.assignedFixterId, source: "adminJobEdit" })), purpose: "assignment" });
    }
    const changed = [...Object.keys(set), ...(assignmentChanged ? ["assignedFixterId"] : [])];
    await createAdminActivityLog(req, {
      action: "Booking Edited",
      entityType: "Booking",
      entityId: after._id,
      entityName: after.bookingNumber || after.name,
      details: {
        bookingNumber: after.bookingNumber,
        changed,
        ...(assignmentChanged ? { fixterBefore: before.assignedFixterName || "", fixterAfter: after.assignedFixterName || "" } : {}),
      },
    }).catch(() => {});
    return res.json({ booking: await detailFor(req, after._id), changed, notifications });
  } catch (error) {
    return sendError(res, error, "Failed to update the job");
  }
});

/* ------------------------------ notes, photos ---------------------------- */

router.post("/jobs/:id/notes", auth, ...bookingsWrite, express.json(), async (req, res) => {
  try {
    const text = String(req.body?.text || "").trim();
    if (!text) throw badRequest("NOTE_REQUIRED", "Write the note first.");
    if (text.length > 2000) throw badRequest("NOTE_TOO_LONG", "A note can be at most 2000 characters.");
    const booking = await loadJob(req);
    const note = {
      _id: new mongoose.Types.ObjectId(),
      text,
      authorId: req.accessUser?._id || null,
      authorName: String(req.accessUser?.name || req.accessUser?.email || "Staff").slice(0, 120),
      authorRole: req.accessRole === "admin" ? "owner" : String(req.accessUser?.employeePosition || "employee"),
      at: new Date(),
    };
    // Append-only: $push, never a rewrite of the list.
    await Booking.updateOne({ _id: booking._id }, { $push: { staffNotes: note } });
    await createAdminActivityLog(req, {
      action: "Job Note Added",
      entityType: "Booking",
      entityId: booking._id,
      entityName: booking.bookingNumber || booking.name,
      details: { bookingNumber: booking.bookingNumber, noteId: String(note._id), excerpt: text.slice(0, 200) },
    }).catch(() => {});
    return res.status(201).json({
      note: { id: String(note._id), text: note.text, authorId: note.authorId ? String(note.authorId) : null, authorName: note.authorName, authorRole: note.authorRole, at: note.at },
      booking: await detailFor(req, booking._id),
    });
  } catch (error) {
    return sendError(res, error, "Failed to add the note");
  }
});

router.post("/jobs/:id/photos", auth, ...bookingsWrite, uploadAppointmentPhotos, async (req, res) => {
  try {
    const booking = await loadJob(req);
    if (!(req.files || []).length) throw badRequest("PHOTOS_REQUIRED", "Attach at least one photo.");
    const before = bookingSnapshot(booking);
    const upload = await storeAppointmentImages({
      files: req.files || [],
      bookingDate: booking.date,
      bookingNumber: booking.bookingNumber,
      source: "admin",
    });
    if (upload.images.length) {
      booking.images = (booking.images || []).concat(upload.images);
      appendContentUpdate(booking, {
        actor: actorSnapshot(req.accessUser, req.accessRole || "admin"),
        source: "admin",
        imagesAdded: upload.images,
      });
      await booking.save();
      await logBookingChanges({ bookingId: booking._id, before, after: bookingSnapshot(booking), req });
      await createAdminActivityLog(req, {
        action: "Job Photos Added",
        entityType: "Booking",
        entityId: booking._id,
        entityName: booking.bookingNumber || booking.name,
        details: { bookingNumber: booking.bookingNumber, photos: upload.images.length },
      }).catch(() => {});
    }
    return res.status(201).json({ added: upload.images.length, booking: await detailFor(req, booking._id) });
  } catch (error) {
    return sendError(res, error, "Failed to add the photos");
  }
});

/* -------------------------------- reschedule ----------------------------- */

function readNewStart(body) {
  if (body.slotStart) {
    const d = new Date(body.slotStart);
    if (Number.isNaN(d.getTime())) throw badRequest("INVALID_TIME", "slotStart is not a date.");
    return d;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(body.date || "")) && /^\d{2}:\d{2}$/.test(String(body.time || ""))) {
    const m = moment.tz(`${body.date} ${body.time}`, "YYYY-MM-DD HH:mm", true, TIMEZONE);
    if (m.isValid()) return m.toDate();
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(body.date || "")) && !body.time) {
    // A Full Day moves by day; the engine picks the workday's hours.
    return moment.tz(`${body.date} 12:00`, "YYYY-MM-DD HH:mm", TIMEZONE).toDate();
  }
  throw badRequest("TIME_REQUIRED", "Send slotStart (ISO) or date and time (NY).");
}

router.post("/jobs/:id/reschedule", auth, ...bookingsAssign, express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    const key = readIdempotencyKey(body.idempotencyKey);
    const expected = readExpectedUpdatedAt(body.expectedUpdatedAt, { required: true });
    if (!mongoose.isValidObjectId(req.params.id)) throw badRequest("INVALID_BOOKING", "Invalid job id");
    const result = await runIdempotent({ req, action: "job.reschedule", key, entityId: req.params.id }, async () => {
      const booking = await loadJob(req);
      assertFresh(booking, expected);
      const current = canonicalStatus(booking.status);
      if (current === STATUS.PENDING_CONFIRMATION && isFreeVisit(booking)) {
        throw new TransitionError("USE_FREE_VISIT_REVIEW", "Change a free-visit request's time in its review.");
      }
      if (current !== STATUS.PENDING && current !== STATUS.CONFIRMED) {
        throw new TransitionError("INVALID_TRANSITION", `A ${current} job cannot be rescheduled.`, 409, { currentStatus: current });
      }
      const isFullDay = booking.bookingType === "full_day_visit";
      const newStart = readNewStart(body);
      if (!isFullDay && newStart.getTime() < Date.now() - 5 * 60 * 1000) throw badRequest("TIME_PASSED", "That time has already passed.");
      const requestedTech = body.assignedFixterId ? String(body.assignedFixterId) : null;
      const previousDate = booking.date;
      const before = bookingSnapshot(booking);
      const sameTime = isFullDay
        ? moment.tz(previousDate, TIMEZONE).format("YYYY-MM-DD") === moment.tz(newStart, TIMEZONE).format("YYYY-MM-DD")
        : new Date(previousDate).getTime() === newStart.getTime();
      if (sameTime && (!requestedTech || requestedTech === String(booking.assignedFixterId || ""))) {
        throw badRequest("NO_CHANGE", "That is already the job's time.");
      }

      if (reservationEngineEnabled()) {
        let technicianId = requestedTech;
        if (!technicianId && !isFullDay) {
          const options = await findEligibleTechnicians({
            slotStart: newStart,
            excludeReservationId: booking.slotReservationId || null,
            excludeBookingId: booking._id,
          });
          const ids = new Set(options.available.map((t) => String(t.id)));
          technicianId = booking.assignedFixterId && ids.has(String(booking.assignedFixterId))
            ? String(booking.assignedFixterId)
            : options.recommended?.id || null;
          if (!technicianId) throw new TransitionError("SLOT_UNAVAILABLE", "No Fixter is available at that time.");
        }
        await moveReservationForBooking({
          bookingId: booking._id,
          technicianId,
          slotStart: newStart,
          actorUser: req.accessUser,
          createdByType: "admin",
          assignmentSource: req.accessRole === "admin" ? "admin" : "general_fixter",
        });
      } else {
        resetBookingReminderEmailStateForDateChange(booking, newStart);
        booking.date = newStart;
        if (requestedTech) {
          const { resolveAssignmentFields } = require("../utils/jobs/assignment");
          Object.assign(booking, await resolveAssignmentFields(requestedTech));
        }
        await booking.save();
      }
      const after = await Booking.findById(booking._id);
      await logBookingChanges({ bookingId: after._id, before, after: bookingSnapshot(after), req });
      if (after.guestRequestId) {
        const { syncLeadFromBooking } = require("../utils/freeVisit/guestVisit");
        await syncLeadFromBooking(after.toObject()).catch(() => {});
      }

      const notifications = [];
      const timeMoved = new Date(after.date).getTime() !== new Date(previousDate).getTime();
      if (body.notifyCustomer === false) {
        notifications.push({ channel: "email", status: "skipped", reason: "not_requested", purpose: "reschedule" });
        notifications.push({ channel: "sms", status: "skipped", reason: "not_requested", purpose: "reschedule" });
      } else {
        if (timeMoved) {
          for (const n of await notifyRescheduled(after, { previousDate, source: "adminJobReschedule" })) notifications.push({ ...n, purpose: "reschedule" });
        }
        if (String(after.assignedFixterId || "") !== String(before.assignedFixterId || "")) {
          notifications.push({ ...(await notifyAssignment(after, { previousFixterId: before.assignedFixterId, source: "adminJobReschedule" })), purpose: "assignment" });
        }
      }
      await createAdminActivityLog(req, {
        action: "Booking Rescheduled",
        entityType: "Booking",
        entityId: after._id,
        entityName: after.bookingNumber || after.name,
        details: {
          bookingNumber: after.bookingNumber,
          previousDate,
          newDate: after.date,
          fixterBefore: before.assignedFixterName || "",
          fixterAfter: after.assignedFixterName || "",
          notifications: notifications.map((n) => `${n.purpose}:${n.channel}:${n.status}`),
        },
      }).catch(() => {});
      return { httpStatus: 200, body: { booking: await detailFor(req, after._id), notifications } };
    });
    return res.status(result.httpStatus).json({ ...result.body, replayed: result.replayed });
  } catch (error) {
    return sendError(res, error, "Failed to reschedule the job");
  }
});

module.exports = router;
