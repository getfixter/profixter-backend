const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const { PERMISSIONS, requirePermission } = require("../middleware/authorize");
const Booking = require("../models/Booking");
const {
  findEligibleTechnicians,
  moveReservationForBooking,
  releaseReservationForBooking,
} = require("../utils/slotReservationService");

const bookingsAssign = requirePermission(PERMISSIONS.BOOKINGS_ASSIGN);

function writeError(res, error, fallback) {
  const status = error?.statusCode || 500;
  return res.status(status).json({
    code: error?.code || "RESERVATION_ERROR",
    message: error?.message || fallback,
  });
}

router.get(
  "/bookings/:id/assignment-options",
  auth,
  ...bookingsAssign,
  async (req, res) => {
    try {
      const booking = await Booking.findById(req.params.id).lean();
      if (!booking) return res.status(404).json({ message: "Booking not found" });
      const options = await findEligibleTechnicians({
        slotStart: booking.date,
        excludeReservationId: booking.slotReservationId || null,
      });
      return res.json({
        bookingId: String(booking._id),
        slotStart: options.slotStart,
        slotEnd: options.slotEnd,
        availableTechnicians: options.available,
        unavailableTechnicians: options.unavailable,
        recommendedTechnician: options.recommended,
      });
    } catch (error) {
      return writeError(res, error, "Failed to load assignment options");
    }
  }
);

router.post(
  "/bookings/:id/reservation/reassign",
  auth,
  ...bookingsAssign,
  async (req, res) => {
    try {
      if (req.body?.force === true) {
        return res.status(400).json({
          code: "FORCE_OVERRIDE_NOT_IMPLEMENTED",
          message: "Force override is not available.",
        });
      }
      if (!req.body?.technicianId) {
        return res.status(400).json({
          code: "TECHNICIAN_REQUIRED",
          message: "technicianId is required",
        });
      }
      const result = await moveReservationForBooking({
        bookingId: req.params.id,
        technicianId: req.body.technicianId,
        slotStart: req.body.slotStart || null,
        actorUser: req.accessUser,
        createdByType: "admin",
        assignmentSource:
          req.accessRole === "admin" ? "admin" : "general_fixter",
      });
      return res.json({
        booking: result.booking,
        reservation: result.reservation,
      });
    } catch (error) {
      return writeError(res, error, "Failed to reassign reservation");
    }
  }
);

router.post(
  "/bookings/:id/reservation/release",
  auth,
  ...requirePermission(PERMISSIONS.ADMIN),
  async (req, res) => {
    try {
      const result = await releaseReservationForBooking({
        bookingId: req.params.id,
        reason: String(req.body?.reason || "Released by Admin"),
        actorUser: req.accessUser,
        createdByType: "admin",
      });
      return res.json({
        booking: result.booking,
        reservation: result.reservation,
      });
    } catch (error) {
      return writeError(res, error, "Failed to release reservation");
    }
  }
);

module.exports = router;
