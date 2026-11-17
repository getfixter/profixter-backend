/**
 * The booking lifecycle, as an allow-list (U-7 / J-03 / J-04 / J-05, Q-4).
 *
 *   confirm    Pending              -> Confirmed
 *   complete   Confirmed            -> Completed
 *   cancel     Pending | Confirmed  -> Canceled
 *   reinstate  Canceled | Completed -> Pending | Confirmed   (explicit only)
 *
 * A free visit awaiting the owner's review ("Pending Confirmation") keeps its
 * own flow: confirm is refused with USE_FREE_VISIT_REVIEW and cancel is routed
 * to the existing decline (utils/freeVisit/guestVisit), exactly as before.
 *
 * WHY ONE WINNER. Every transition claims the booking with one atomic
 * findOneAndUpdate whose filter is the status it was read in (and, when the
 * caller sends one, its updatedAt). Two simultaneous Confirms, or a Confirm
 * racing the customer's own cancel, therefore produce exactly one change and
 * one set of customer notices; the loser gets 409 STALE and sends nothing.
 * Side effects (reservation release, emails, texts) run only after the claim,
 * and only for the request that made it.
 *
 * Both the new POST /api/admin/jobs/:id/transition and the legacy
 * PUT /api/admin/bookings/:id/status go through here, so the old Admin keeps
 * working but can no longer do what the allow-list forbids (Canceled ->
 * Confirmed and the like answer 409 INVALID_TRANSITION, pointing at Reinstate).
 */
const mongoose = require("mongoose");
const Booking = require("../models/Booking");
const CalendarConfig = require("../models/CalendarConfig");
const SlotCounter = require("../models/SlotCounter");
const VisitEntitlement = require("../models/VisitEntitlement");
const { PERMISSIONS } = require("./adminAccess");
const { createAdminActivityLog } = require("./adminActivityLog");
const { snapshot: bookingSnapshot, logBookingChanges } = require("./bookingHistory");
const {
  activeReservationForBooking,
  findEligibleTechnicians,
  moveReservationForBooking,
  releaseReservationForBooking,
  reservationEngineEnabled,
} = require("./slotReservationService");
const { releaseFullDayCapacity } = require("./fullDayVisitService");
const { restoreFullDayBenefit } = require("./fullDayEntitlements");
const { STATUS, canonicalStatus, isFreeVisit } = require("./jobs/jobStatus");
const { canAccessJob, canSeeAllJobs, forbiddenRecord, hasPerm } = require("./jobs/jobAccess");
const { notRequested, notifyStatus } = require("./jobs/jobNotifications");
const { paymentInfoFor } = require("./jobs/jobMoney");
const { resolveAssignmentFields } = require("./jobs/assignment");

const TIMEZONE = "America/New_York";
const ACTIONS = Object.freeze(["confirm", "complete", "cancel", "reinstate"]);

class TransitionError extends Error {
  constructor(code, message, statusCode = 409, extra = {}) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.extra = extra;
  }
}

function invalid(message, current) {
  return new TransitionError("INVALID_TRANSITION", message, 409, { currentStatus: current });
}

function stale(booking) {
  return new TransitionError(
    "STALE",
    "This job changed since you loaded it. Reload and try again.",
    409,
    booking
      ? { currentStatus: canonicalStatus(booking.status), updatedAt: booking.updatedAt || null }
      : {}
  );
}

const REINSTATE_HINT = "Use Reinstate to reopen it.";

/**
 * Which action a requested status means, from the current status. Used by the
 * legacy status route, which sends a target status rather than an action.
 * Returns "noop" for a status the job already has.
 */
function legacyActionFor(current, requestedStatus) {
  const to = canonicalStatus(requestedStatus);
  if (to === current) return "noop";
  if (current === STATUS.CANCELED || current === STATUS.COMPLETED) {
    throw invalid(`This job is ${current}. ${REINSTATE_HINT}`, current);
  }
  if (to === STATUS.CONFIRMED && current === STATUS.PENDING) return "confirm";
  if (to === STATUS.COMPLETED && current === STATUS.CONFIRMED) return "complete";
  if (to === STATUS.CANCELED && [STATUS.PENDING, STATUS.CONFIRMED, STATUS.PENDING_CONFIRMATION].includes(current)) return "cancel";
  if (to === STATUS.COMPLETED && current === STATUS.PENDING) {
    throw invalid("Confirm this job before marking it complete.", current);
  }
  if (to === STATUS.PENDING && current === STATUS.CONFIRMED) {
    throw invalid("A confirmed job cannot be moved back to Pending. Cancel it, or reschedule it.", current);
  }
  if (to === STATUS.CONFIRMED && current === STATUS.PENDING_CONFIRMATION) return "confirm";
  throw invalid(`A ${current} job cannot be changed to ${to}.`, current);
}

/** The status an action leads to from `current`, or an INVALID_TRANSITION. */
function targetFor(action, current, targetStatus) {
  switch (action) {
    case "confirm":
      if (current === STATUS.PENDING) return STATUS.CONFIRMED;
      break;
    case "complete":
      if (current === STATUS.CONFIRMED) return STATUS.COMPLETED;
      if (current === STATUS.PENDING || current === STATUS.PENDING_CONFIRMATION) {
        throw invalid("Confirm this job before marking it complete.", current);
      }
      break;
    case "cancel":
      if (current === STATUS.PENDING || current === STATUS.CONFIRMED || current === STATUS.PENDING_CONFIRMATION) return STATUS.CANCELED;
      break;
    case "reinstate": {
      if (current !== STATUS.CANCELED && current !== STATUS.COMPLETED) {
        throw invalid(`Only a canceled or completed job can be reinstated; this one is ${current}.`, current);
      }
      const to = canonicalStatus(targetStatus || STATUS.CONFIRMED);
      if (to !== STATUS.CONFIRMED && to !== STATUS.PENDING) {
        throw new TransitionError("INVALID_TARGET", "A job can be reinstated as Pending or Confirmed.", 400);
      }
      return to;
    }
    default:
      throw new TransitionError("INVALID_ACTION", `action must be one of ${ACTIONS.join(", ")}`, 400);
  }
  if (current === STATUS.CANCELED || current === STATUS.COMPLETED) {
    throw invalid(`This job is ${current}. ${REINSTATE_HINT}`, current);
  }
  throw invalid(`Cannot ${action} a ${current} job.`, current);
}

/**
 * What the caller may do to this job, for the UI. Computed from the same rules
 * the server enforces, so a button the UI shows is a button that works.
 */
function allowedActionsFor(req, booking) {
  if (!canAccessJob(req, booking)) return [];
  const all = canSeeAllJobs(req);
  const write = hasPerm(req, PERMISSIONS.BOOKINGS_WRITE);
  const current = canonicalStatus(booking.status);
  const out = [];
  if (write) {
    out.push("addInternalNote", "addPhotos");
    if (current === STATUS.CONFIRMED) out.push("complete");
  }
  if (all && write) {
    if (current === STATUS.PENDING) out.push("confirm");
    if (current === STATUS.PENDING_CONFIRMATION) out.push("reviewFreeVisit");
    if ([STATUS.PENDING, STATUS.CONFIRMED, STATUS.PENDING_CONFIRMATION].includes(current)) out.push("cancel");
    if ([STATUS.PENDING, STATUS.CONFIRMED].includes(current)) out.push("reschedule", "reassign", "edit");
    if ([STATUS.CANCELED, STATUS.COMPLETED].includes(current) && !reinstateBlockerSync(booking)) out.push("reinstate");
  }
  return out;
}

/* A field Fixter (no bookings.assign) may only complete their own jobs (Q-1). */
function assertActionPermitted(req, booking, action) {
  if (!canAccessJob(req, booking)) throw forbiddenRecord();
  if (!hasPerm(req, PERMISSIONS.BOOKINGS_WRITE)) {
    throw new TransitionError("FORBIDDEN_ACTION", "You cannot change jobs.", 403);
  }
  if (action !== "complete" && !canSeeAllJobs(req)) {
    throw new TransitionError("FORBIDDEN_ACTION", "Only the owner or someone with the Jobs section can do this.", 403);
  }
}

function statusFilter(booking) {
  return booking.status === undefined || booking.status === null ? { $in: [null, ""] } : booking.status;
}

/**
 * The atomic claim: change the status only if it is still what we read (and
 * updatedAt still matches, when the caller pinned it). Returns the updated
 * document, or null when somebody else got there first.
 */
async function claimStatus(booking, toStatus, { set = {}, unset = {}, expectedUpdatedAt = null } = {}) {
  const filter = { _id: booking._id, status: statusFilter(booking) };
  if (expectedUpdatedAt) filter.updatedAt = new Date(expectedUpdatedAt);
  const update = {
    $set: { status: toStatus, ...set },
    $push: { statusHistory: { status: booking.status, date: new Date() } },
  };
  for (const key of Object.keys(set)) delete unset[key];
  if (Object.keys(unset).length) update.$unset = unset;
  return Booking.findOneAndUpdate(filter, update, { new: true });
}

async function throwStale(bookingId) {
  const fresh = await Booking.findById(bookingId).select("status updatedAt").lean();
  throw stale(fresh);
}

const REMINDER_RESET_UNSET = {
  reminder24hQueuedAt: 1,
  reminder24hSentAt: 1,
  reminder24hSkippedAt: 1,
  reminder60mQueuedAt: 1,
  reminder60mSentAt: 1,
};
const REVIEW_LOCK_UNSET = { reviewRequestQueuedAt: 1, reviewRequestLockExpiresAt: 1 };

function actorSource(req) {
  return req?.accessRole === "admin" ? "admin" : "general_fixter";
}

async function syncLead(booking) {
  if (!booking?.guestRequestId) return;
  const { syncLeadFromBooking } = require("./freeVisit/guestVisit");
  await syncLeadFromBooking(booking.toObject ? booking.toObject() : booking).catch((e) =>
    console.error("free visit lead sync (job transition) failed:", e.message)
  );
}

async function audit(req, action, booking, details) {
  if (!req) return;
  await createAdminActivityLog(req, {
    action,
    entityType: "Booking",
    entityId: booking._id,
    entityName: booking.bookingNumber || booking.name,
    details: {
      bookingNumber: booking.bookingNumber,
      customerName: booking.name,
      date: booking.date,
      ...details,
    },
  }).catch((error) => console.error("booking activity log failed:", error.message));
}

/* --------------------------------- confirm -------------------------------- */

async function doConfirm({ req, booking, before, expectedUpdatedAt, assignedFixterId, source }) {
  const assignmentRequested = assignedFixterId !== undefined && assignedFixterId !== null;
  if (assignmentRequested && !hasPerm(req, PERMISSIONS.BOOKINGS_ASSIGN)) {
    throw new TransitionError("FORBIDDEN_ACTION", "Assignment access denied", 403);
  }
  if (assignmentRequested && !assignedFixterId) {
    throw new TransitionError("TECHNICIAN_REQUIRED", "A reserved booking cannot be unassigned", 400);
  }
  let reservedHere = false;
  if (reservationEngineEnabled()) {
    const active = await activeReservationForBooking(booking._id);
    const needsMove = assignmentRequested && String(booking.assignedFixterId || "") !== String(assignedFixterId);
    if (!active || needsMove) {
      let technicianId = assignmentRequested ? assignedFixterId : null;
      if (!technicianId && booking.bookingType !== "full_day_visit") {
        const options = await findEligibleTechnicians({ slotStart: booking.date, excludeBookingId: booking._id });
        technicianId = options.recommended?.id || null;
        if (!technicianId) {
          throw new TransitionError("SLOT_UNAVAILABLE", "No eligible technician is available for this booking");
        }
      }
      try {
        await moveReservationForBooking({
          bookingId: booking._id,
          technicianId,
          slotStart: booking.date,
          actorUser: req?.accessUser || null,
          createdByType: "admin",
          assignmentSource: assignmentRequested ? actorSource(req) : "automatic",
        });
        reservedHere = !active;
      } catch (error) {
        // A concurrent confirm reserved it first: let the status claim decide who won.
        if (error?.code !== "BOOKING_ALREADY_RESERVED") throw error;
      }
    }
  } else if (assignmentRequested) {
    await Booking.updateOne({ _id: booking._id }, { $set: await resolveAssignmentFields(assignedFixterId) });
  }

  const claimed = await claimStatus(booking, STATUS.CONFIRMED, {
    set: { reminder24hSkipReason: "" },
    unset: { ...REMINDER_RESET_UNSET, ...REVIEW_LOCK_UNSET },
    expectedUpdatedAt: reservedHere || assignmentRequested ? null : expectedUpdatedAt,
  });
  if (!claimed) {
    if (reservedHere) {
      // We reserved for a confirm that lost; if the job ended up final, give the slot back.
      const now = await Booking.findById(booking._id).select("status").lean();
      if ([STATUS.CANCELED, STATUS.COMPLETED].includes(canonicalStatus(now?.status))) {
        await releaseReservationForBooking({ bookingId: booking._id, reason: "Confirm lost to a concurrent change", createdByType: "system" }).catch(() => {});
      }
    }
    await throwStale(booking._id);
  }
  await logBookingChanges({ bookingId: claimed._id, before, after: bookingSnapshot(claimed), req });
  const notifications = await notifyStatus(claimed, "confirmed", { source });
  await syncLead(claimed);
  await audit(req, "Booking Confirmed", claimed, { previousStatus: before.status, newStatus: STATUS.CONFIRMED, assignedFixterName: claimed.assignedFixterName || "" });
  return { booking: claimed, notifications };
}

/* -------------------------------- complete -------------------------------- */

async function doComplete({ req, booking, before, expectedUpdatedAt, source }) {
  const claimed = await claimStatus(booking, STATUS.COMPLETED, {
    set: { completedAt: new Date() },
    unset: { reviewRequestQueuedAt: 1, reviewRequestLockExpiresAt: 1, reviewRequestSkippedAt: 1 },
    expectedUpdatedAt,
  });
  if (!claimed) await throwStale(booking._id);

  if (reservationEngineEnabled() || claimed.slotReservationId) {
    // Keeps the assignment (and slotReservationId): the record of who did the job.
    await releaseReservationForBooking({
      bookingId: claimed._id,
      actorUser: req?.accessUser || null,
      createdByType: "admin",
      reason: "Booking completed",
      clearAssignment: false,
    }).catch((error) => {
      if (error?.code !== "RESERVATION_NOT_FOUND") console.error("completion reservation release failed:", error.message);
    });
  }
  let completed = claimed;
  // A one-step visit still without an account joins the one account that proved its phone/email.
  if (completed.guestRequestId && !completed.user) {
    await require("./freeVisit/guestLink").linkCompletedGuestVisitQuietly(completed).catch((e) =>
      console.error("guest visit link on completion failed:", e.message)
    );
  }
  completed = (await Booking.findById(claimed._id)) || claimed;
  await logBookingChanges({ bookingId: completed._id, before, after: bookingSnapshot(completed), req });
  const notifications = await notifyStatus(completed, "completed", { source });
  await syncLead(completed);
  await audit(req, "Booking Completed", completed, { previousStatus: before.status, newStatus: STATUS.COMPLETED });
  return { booking: completed, notifications };
}

/* --------------------------------- cancel --------------------------------- */

async function releaseLegacySlot(booking) {
  try {
    const cfg = await CalendarConfig.findOne().lean();
    const tz = cfg?.timezone || TIMEZONE;
    const d = new Date(booking.date);
    const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
    const time = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
    await SlotCounter.updateOne({ ymd, time }, { $inc: { count: -1 } });
  } catch (error) {
    console.log("Slot free (admin cancel) error:", error.message);
  }
}

async function doCancel({ req, booking, before, expectedUpdatedAt, reason, source }) {
  const cancellationReason = String(reason || "").trim().slice(0, 300) || "Canceled by Admin";
  const claimed = await claimStatus(booking, STATUS.CANCELED, {
    set: { cancellationReason },
    unset: { ...REVIEW_LOCK_UNSET },
    expectedUpdatedAt,
  });
  if (!claimed) await throwStale(booking._id);

  // The benefit goes back before the schedule is cleared: it is judged on the booked day (J-10).
  let fullDayRestore = null;
  if (booking.bookingType === "full_day_visit") {
    fullDayRestore = await restoreFullDayBenefit({ booking }).catch((error) => {
      console.error("Full Day entitlement restore (admin cancel) failed:", error.message);
      return { restored: false, reason: "restore_failed" };
    });
  }

  const active = await activeReservationForBooking(claimed._id).catch(() => null);
  if (active) {
    await releaseReservationForBooking({
      bookingId: claimed._id,
      actorUser: req?.accessUser || null,
      createdByType: "admin",
      reason: cancellationReason,
      clearAssignment: true,
    }).catch((error) => {
      if (error?.code !== "RESERVATION_NOT_FOUND") console.error("cancel reservation release failed:", error.message);
    });
  } else if (booking.bookingType === "full_day_visit") {
    await releaseFullDayCapacity(booking).catch((error) => console.log("Full Day capacity release error:", error.message));
  } else if (!reservationEngineEnabled()) {
    await releaseLegacySlot(booking);
  }
  const canceled = (await Booking.findById(claimed._id)) || claimed;
  await logBookingChanges({ bookingId: canceled._id, before, after: bookingSnapshot(canceled), req });
  const payment = await paymentInfoFor(canceled).catch(() => null);
  /*
   * A visit converted from a free visit (utils/freeVisit/conversion.js) was
   * paid for, and a membership one started a subscription. Canceling it
   * touches neither: it records that the payment now needs Admin's decision
   * (Needs action) and says so in the result. Nothing is refunded or canceled.
   */
  let conversionPayment = null;
  if (canceled.freeVisitConversion?.convertedAt) {
    conversionPayment = await require("./freeVisit/paymentResolution")
      .recordCanceledAfterPayment({ booking: canceled, admin: req?.accessUser || null, reason: cancellationReason, statusBefore: before.status })
      .catch((error) => {
        console.error("converted visit cancel follow-up failed:", error.message);
        return null;
      });
    if (conversionPayment) conversionPayment.message = require("./freeVisit/paymentResolution").followUpText(conversionPayment);
  }
  const notifications = await notifyStatus(canceled, "canceled", { source });
  await syncLead(canceled);
  await audit(req, "Booking Manually Canceled", canceled, {
    customerEmail: canceled.email,
    service: canceled.service,
    previousStatus: before.status,
    newStatus: STATUS.CANCELED,
    reason: cancellationReason,
    fullDayRestored: Boolean(fullDayRestore?.restored),
    paidCents: payment?.paidCents ?? null,
    ...(conversionPayment ? { convertedVisitPayment: { kind: conversionPayment.kind, amountCents: conversionPayment.amountCents, followUp: "after_cancel" } } : {}),
  });
  return {
    booking: canceled,
    notifications,
    payment,
    ...(conversionPayment ? { conversionPayment } : {}),
    fullDayRestore: fullDayRestore ? { restored: Boolean(fullDayRestore.restored), kind: fullDayRestore.kind || null, reason: fullDayRestore.reason || "" } : null,
  };
}

/* -------------------------------- reinstate ------------------------------- */

/** Why a final job cannot be reopened, from the booking alone (no queries). */
function reinstateBlockerSync(booking) {
  const current = canonicalStatus(booking.status);
  if (["pending", "failed", "expired", "refunded"].includes(booking.paymentState)) {
    return { code: "PAYMENT_NOT_COMPLETED", message: "This visit was never paid (or was refunded). Create a new visit instead." };
  }
  if (current === STATUS.CANCELED && !booking.freeVisitConversion?.convertedAt && (booking.guestRequestId || booking.freeVisitChannel === "online")) {
    return { code: "USE_FREE_VISIT_REVIEW", message: "A declined free-visit request cannot be reopened. Ask the customer to request again." };
  }
  return null;
}

async function reinstateBlocker(booking) {
  const sync = reinstateBlockerSync(booking);
  if (sync) return sync;
  if (canonicalStatus(booking.status) === STATUS.CANCELED && booking.bookingType === "full_day_visit" && booking.entitlementId) {
    const ent = await VisitEntitlement.findById(booking.entitlementId).select("source status").lean();
    if (ent && ent.source !== "purchase" && ent.status !== "consumed") {
      return { code: "BENEFIT_RETURNED", message: "This Full Day's free day was given back when it was canceled. Book a new Full Day instead." };
    }
  }
  return null;
}

async function doReinstate({ req, booking, before, expectedUpdatedAt, assignedFixterId, targetStatus, notifyCustomer, reason, source }) {
  const blocker = await reinstateBlocker(booking);
  if (blocker) throw new TransitionError(blocker.code, blocker.message, 409);
  const to = targetFor("reinstate", canonicalStatus(booking.status), targetStatus);
  const engine = reservationEngineEnabled();

  // Availability first: nothing changes if the time can no longer be honoured.
  let technicianId = assignedFixterId || null;
  if (engine && booking.bookingType !== "full_day_visit") {
    const options = await findEligibleTechnicians({ slotStart: booking.date, excludeBookingId: booking._id });
    const availableIds = new Set(options.available.map((t) => String(t.id)));
    if (technicianId && !availableIds.has(String(technicianId))) {
      const why = options.unavailable.find((t) => String(t.id) === String(technicianId));
      throw new TransitionError("TECHNICIAN_UNAVAILABLE", why?.reason || "That Fixter is not available at this time.");
    }
    if (!technicianId && booking.assignedFixterId && availableIds.has(String(booking.assignedFixterId))) {
      technicianId = String(booking.assignedFixterId);
    }
    if (!technicianId) technicianId = options.recommended?.id || null;
    if (!technicianId) throw new TransitionError("SLOT_UNAVAILABLE", "No Fixter is available at this time any more. Reschedule instead.");
  }

  const originalStatus = booking.status;
  const set = { cancellationReason: "" };
  const unset = { ...REVIEW_LOCK_UNSET, reviewRequestSkippedAt: 1 };
  if (canonicalStatus(originalStatus) === STATUS.COMPLETED) set.completedAt = null;
  if (to === STATUS.CONFIRMED) {
    Object.assign(unset, REMINDER_RESET_UNSET);
    set.reminder24hSkipReason = "";
  }
  const claimed = await claimStatus(booking, to, { set, unset, expectedUpdatedAt });
  if (!claimed) await throwStale(booking._id);

  if (engine) {
    try {
      // Re-reserve even when slotReservationId is still set: completion and
      // cancellation release the reservation but completion keeps the id (J-05).
      const active = await activeReservationForBooking(claimed._id);
      if (!active || (technicianId && String(claimed.assignedFixterId || "") !== String(technicianId))) {
        await moveReservationForBooking({
          bookingId: claimed._id,
          technicianId,
          slotStart: claimed.date,
          actorUser: req?.accessUser || null,
          createdByType: "admin",
          assignmentSource: actorSource(req),
        });
      }
    } catch (error) {
      // Put it back exactly as it was; the job stays closed and nobody is told anything.
      await Booking.updateOne(
        { _id: claimed._id, status: to },
        {
          $set: {
            status: originalStatus,
            cancellationReason: booking.cancellationReason || "",
            completedAt: booking.completedAt || null,
          },
          $pop: { statusHistory: 1 },
        }
      ).catch(() => {});
      throw new TransitionError(error?.code || "SLOT_UNAVAILABLE", error?.message || "The time could not be reserved again.", error?.statusCode && error.statusCode < 500 ? error.statusCode : 409);
    }
  } else if (assignedFixterId) {
    await Booking.updateOne({ _id: claimed._id }, { $set: await resolveAssignmentFields(assignedFixterId) });
  }

  const reinstated = (await Booking.findById(claimed._id)) || claimed;
  await logBookingChanges({ bookingId: reinstated._id, before, after: bookingSnapshot(reinstated), req });
  let notifications = notRequested();
  if (notifyCustomer === true) {
    notifications = to === STATUS.CONFIRMED
      ? await notifyStatus(reinstated, "confirmed", { source })
      : [{ channel: "email", status: "skipped", reason: "no_template_for_pending" }, { channel: "sms", status: "skipped", reason: "no_template_for_pending" }];
  }
  await syncLead(reinstated);
  await audit(req, "Booking Reinstated", reinstated, {
    previousStatus: before.status,
    newStatus: to,
    reason: String(reason || "").slice(0, 300),
    notifiedCustomer: notifyCustomer === true,
    assignedFixterName: reinstated.assignedFixterName || "",
  });
  /* A converted visit canceled and now back: its payment no longer waits for a decision. */
  if (reinstated.freeVisitConversion?.convertedAt) {
    await require("./freeVisit/paymentResolution")
      .reinstatedAfterCancel({ booking: reinstated, admin: req?.accessUser || null })
      .catch((error) => console.error("converted visit reinstate follow-up failed:", error.message));
  }
  return { booking: reinstated, notifications };
}

/* ---------------------------------- entry --------------------------------- */

/**
 * Run one transition.
 *
 * @param {object} args
 * @param {object} args.req                 the Express request (accessUser, permissions) - for scope, history, audit
 * @param {string} args.bookingId
 * @param {string} args.action              confirm | complete | cancel | reinstate
 * @param {string} [args.expectedStatus]    precondition: 409 STALE when the job's status differs
 * @param {string} [args.expectedUpdatedAt] precondition: 409 STALE when updatedAt differs
 * @param {string} [args.assignedFixterId]  confirm / reinstate: who to assign
 * @param {string} [args.targetStatus]      reinstate: "Confirmed" (default) or "Pending"
 * @param {boolean} [args.notifyCustomer]   reinstate only; default false
 * @param {string} [args.reason]            cancel / reinstate: recorded on the job and in the audit
 * @param {string} [args.source]            the notification source label
 * @returns {Promise<{ booking, transition: {action, from, to}, notifications, payment?, fullDayRestore?, noop? }>}
 */
async function performTransition(args) {
  const { req, bookingId, action, expectedStatus = null, expectedUpdatedAt = null, source = "adminJobTransition" } = args;
  if (!ACTIONS.includes(action)) {
    throw new TransitionError("INVALID_ACTION", `action must be one of ${ACTIONS.join(", ")}`, 400);
  }
  if (!mongoose.isValidObjectId(bookingId)) throw new TransitionError("INVALID_BOOKING", "Invalid booking id", 400);
  const booking = await Booking.findById(bookingId);
  if (!booking) throw new TransitionError("BOOKING_NOT_FOUND", "Booking not found", 404);
  assertActionPermitted(req, booking, action);

  const current = canonicalStatus(booking.status);
  if (expectedStatus && canonicalStatus(expectedStatus) !== current) throw stale(booking);
  if (expectedUpdatedAt) {
    const expectedMs = new Date(expectedUpdatedAt).getTime();
    if (!Number.isFinite(expectedMs)) throw new TransitionError("INVALID_PRECONDITION", "expectedUpdatedAt is not a date", 400);
    if (new Date(booking.updatedAt).getTime() !== expectedMs) throw stale(booking);
  }

  /* A free visit awaiting review keeps its review flow (address, lifetime rule, one notice). */
  if (current === STATUS.PENDING_CONFIRMATION && isFreeVisit(booking)) {
    if (action === "cancel") {
      const { declineGuestVisit } = require("./freeVisit/guestVisit");
      const declined = await declineGuestVisit({ bookingId: booking._id, actorUser: req?.accessUser || null, reason: args.reason || "", kind: "declined" });
      if (!declined.alreadyClosed) {
        await audit(req, "Free Visit Request Declined", declined.booking, { reason: String(args.reason || "").slice(0, 300) });
      }
      return {
        booking: declined.booking,
        transition: { action, from: current, to: STATUS.CANCELED },
        notifications: [],
        routedTo: "free_visit_decline",
      };
    }
    throw new TransitionError(
      "USE_FREE_VISIT_REVIEW",
      booking.guestRequestId
        ? "Open this free-visit request and use Confirm Visit: it needs the service address first."
        : "Open this online free visit and use Approve: the free-visit rules are checked there."
    );
  }

  const to = targetFor(action, current, args.targetStatus);
  const before = bookingSnapshot(booking);
  const common = { req, booking, before, expectedUpdatedAt, source };
  let result;
  if (action === "confirm") result = await doConfirm({ ...common, assignedFixterId: args.assignedFixterId });
  else if (action === "complete") result = await doComplete(common);
  else if (action === "cancel") result = await doCancel({ ...common, reason: args.reason });
  else result = await doReinstate({ ...common, assignedFixterId: args.assignedFixterId, targetStatus: to, notifyCustomer: args.notifyCustomer, reason: args.reason });
  return { ...result, transition: { action, from: current, to } };
}

module.exports = {
  ACTIONS,
  TransitionError,
  allowedActionsFor,
  legacyActionFor,
  performTransition,
  reinstateBlocker,
  targetFor,
};
