// 📁 backend/routes/adminFreeVisits.js
/*
 * Admin: the homepage free-visit request, from "Pending Confirmation" to a
 * confirmed appointment. Reached from Admin > Jobs (the calendar) and from
 * Admin > Leads; both open the same visit, because there is only one.
 *
 *   GET  /api/admin/free-visits/:bookingId          everything submitted + a fresh eligibility check
 *   PUT  /api/admin/free-visits/:bookingId          save contact, address, job, time (conflict-checked)
 *   POST /api/admin/free-visits/:bookingId/confirm  require an address, re-check, confirm, notify once
 *   POST /api/admin/free-visits/:bookingId/decline  release the slot; the free visit is not used
 *
 * The work lives in utils/freeVisit/guestVisit; this file only translates.
 */
const express = require("express");
const mongoose = require("mongoose");
const moment = require("moment-timezone");

const router = express.Router();
const auth = require("../middleware/auth");
const { PERMISSIONS, requirePermission } = require("../middleware/authorize");
const Booking = require("../models/Booking");
const Request = require("../models/Request");
const { createAdminActivityLog } = require("../utils/adminActivityLog");
const { addressMatchKey, checkFreeVisitEligibility } = require("../utils/freeVisit/eligibility");
const { channelOf, confirmGuestVisit, declineGuestVisit, hasValidAddress, isReviewableFreeVisit, updateGuestVisit } = require("../utils/freeVisit/guestVisit");

const bookingsWrite = requirePermission(PERMISSIONS.BOOKINGS_WRITE);
const TIMEZONE = "America/New_York";

function writeError(res, error, fallback) {
  return res.status(error?.statusCode || 500).json({
    code: error?.code || "FREE_VISIT_ERROR",
    message: error?.message || fallback,
    ...(error?.eligibility ? { eligibility: publicEligibility(error.eligibility) } : {}),
  });
}

function publicEligibility(result) {
  if (!result) return null;
  return {
    decision: result.decision,
    code: result.code,
    reasons: result.reasons,
    matches: (result.matches || []).slice(0, 10),
  };
}

function validId(req, res) {
  if (!mongoose.isValidObjectId(req.params.bookingId)) {
    res.status(400).json({ code: "INVALID_BOOKING", message: "Invalid booking id" });
    return false;
  }
  return true;
}

/** The visit as the review screen shows it. */
async function presentVisit(bookingId) {
  const booking = await Booking.findById(bookingId).lean();
  if (!isReviewableFreeVisit(booking)) return null;
  const channel = channelOf(booking);
  const request = booking.guestRequestId ? await Request.findById(booking.guestRequestId).lean() : null;
  const isOpen = /^pending confirmation$/i.test(String(booking.status || ""));
  const addressKey = hasValidAddress(booking)
    ? addressMatchKey({ line1: booking.address, city: booking.city, state: booking.state, zip: booking.zip })
    : "";
  const eligibility = !isOpen
    ? null
    : channel === "online"
      ? await checkFreeVisitEligibility(
          { phone: booking.phone, email: booking.email, address: addressKey, userId: booking.user },
          {
            excludeBookingId: booking._id,
            excludeAccountAddress: booking.addressId ? { userId: booking.user, addressId: booking.addressId } : null,
          }
        )
      : await checkFreeVisitEligibility(
          { phone: booking.phone, email: booking.email, address: addressKey },
          { excludeBookingId: booking._id, excludeRequestId: booking.guestRequestId }
        );
  /* What the owner still has to collect on the call before Confirm will work. */
  const missing = [
    !String(booking.name || "").trim() ? "name" : "",
    !String(booking.phone || "").trim() ? "phone" : "",
    !String(booking.email || "").trim() ? "email" : "",
    !hasValidAddress(booking) ? "address" : "",
  ].filter(Boolean);
  const when = moment.tz(booking.date, TIMEZONE);
  return {
    booking: {
      _id: String(booking._id),
      bookingNumber: booking.bookingNumber,
      status: booking.status,
      channel,
      missing,
      date: booking.date,
      requestedDate: when.format("YYYY-MM-DD"),
      requestedTime: when.format("HH:mm"),
      name: booking.name,
      phone: booking.phone,
      email: booking.email,
      address: booking.address,
      city: booking.city,
      state: booking.state,
      zip: booking.zip,
      hasAddress: hasValidAddress(booking),
      service: booking.service,
      selectedTask: booking.selectedTask,
      note: booking.note,
      adminNote: booking.adminNote,
      images: booking.images || [],
      libraryReference: booking.libraryReference || "",
      assignedFixterName: booking.assignedFixterName || "",
      reserved: Boolean(booking.slotReservationId),
      linkedAccount: booking.user ? String(booking.user) : "",
      review: booking.freeVisitReview || null,
      confirmation: booking.freeVisitConfirmation || null,
    },
    lead: request
      ? {
          _id: String(request._id),
          status: request.status,
          createdAt: request.createdAt,
          sourcePage: request.sourcePage,
          attribution: request.attribution || null,
          consent: request.contactConsent || null,
        }
      : null,
    eligibility: publicEligibility(eligibility),
  };
}

router.get("/:bookingId", auth, ...bookingsWrite, async (req, res) => {
  if (!validId(req, res)) return;
  try {
    const visit = await presentVisit(req.params.bookingId);
    if (!visit) return res.status(404).json({ code: "NOT_A_GUEST_VISIT", message: "Free-visit request not found" });
    return res.json(visit);
  } catch (error) {
    return writeError(res, error, "Could not load the request");
  }
});

router.put("/:bookingId", auth, ...bookingsWrite, express.json(), async (req, res) => {
  if (!validId(req, res)) return;
  try {
    const body = req.body || {};
    await updateGuestVisit({
      bookingId: req.params.bookingId,
      req,
      actorUser: req.accessUser,
      fields: {
        name: body.name,
        phone: body.phone,
        email: body.email,
        address: body.address || null,
        note: body.note,
        selectedTask: body.selectedTask,
        adminNote: body.adminNote,
        date: body.date,
        time: body.time,
      },
    });
    return res.json(await presentVisit(req.params.bookingId));
  } catch (error) {
    return writeError(res, error, "Could not save the request");
  }
});

router.post("/:bookingId/confirm", auth, ...bookingsWrite, express.json(), async (req, res) => {
  if (!validId(req, res)) return;
  try {
    const result = await confirmGuestVisit({
      bookingId: req.params.bookingId,
      actorUser: req.accessUser,
      req,
      acknowledgeReview: req.body?.acknowledgeReview === true,
    });
    if (!result.alreadyConfirmed) {
      await createAdminActivityLog(req, {
        action: "Free Visit Confirmed",
        entityType: "Booking",
        entityId: result.booking._id,
        entityName: result.booking.bookingNumber || result.booking.name,
        details: {
          bookingNumber: result.booking.bookingNumber,
          customerName: result.booking.name,
          date: result.booking.date,
          reviewAcknowledged: Boolean(result.booking.freeVisitReview?.acknowledgedAt),
        },
      }).catch(() => {});
    }
    return res.json({
      ...(await presentVisit(req.params.bookingId)),
      alreadyConfirmed: result.alreadyConfirmed,
      notified: result.notified,
    });
  } catch (error) {
    return writeError(res, error, "Could not confirm the visit");
  }
});

router.post("/:bookingId/decline", auth, ...bookingsWrite, express.json(), async (req, res) => {
  if (!validId(req, res)) return;
  try {
    const kind = req.body?.kind === "canceled" ? "canceled" : "declined";
    const result = await declineGuestVisit({
      bookingId: req.params.bookingId,
      actorUser: req.accessUser,
      reason: req.body?.reason || "",
      kind,
    });
    if (!result.alreadyClosed) {
      await createAdminActivityLog(req, {
        action: kind === "declined" ? "Free Visit Request Declined" : "Free Visit Canceled",
        entityType: "Booking",
        entityId: result.booking._id,
        entityName: result.booking.bookingNumber || result.booking.name,
        details: { bookingNumber: result.booking.bookingNumber, customerName: result.booking.name, reason: req.body?.reason || "" },
      }).catch(() => {});
    }
    return res.json({ ...(await presentVisit(req.params.bookingId)), alreadyClosed: result.alreadyClosed });
  } catch (error) {
    return writeError(res, error, "Could not decline the request");
  }
});

module.exports = router;
