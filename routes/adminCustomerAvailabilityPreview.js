const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const auth = require("../middleware/auth");
const { PERMISSIONS, requirePermission } = require("../middleware/authorize");
const {
  buildCustomerAvailabilityReadiness,
  customerCutoverStatus,
  previewEnabled,
} = require("../utils/customerAvailabilityReadiness");
const {
  backfillReservationsForFutureBookings,
} = require("../utils/slotReservationService");

router.get(
  "/customer-cutover-status",
  auth,
  ...requirePermission(PERMISSIONS.ADMIN),
  (_req, res) => res.json(customerCutoverStatus())
);

router.get(
  "/reservation-auto-assignment-preview",
  auth,
  ...requirePermission(PERMISSIONS.ADMIN),
  async (_req, res) => {
    try {
      const report = await backfillReservationsForFutureBookings({
        write: false,
      });
      return res.json({
        ...report,
        confirmationRequired: true,
        bookingIds: report.plannedAssignments.map((entry) => entry.bookingId),
      });
    } catch (error) {
      return res.status(error?.statusCode || 500).json({
        code: error?.code || "RESERVATION_AUTO_ASSIGNMENT_PREVIEW_FAILED",
        message: error?.message || "Failed to preview reservation assignments",
      });
    }
  }
);

router.post(
  "/reservation-auto-assignment",
  auth,
  ...requirePermission(PERMISSIONS.ADMIN),
  async (req, res) => {
    const bookingIds = Array.isArray(req.body?.bookingIds)
      ? [...new Set(req.body.bookingIds.map(String).filter(Boolean))]
      : [];
    if (req.body?.confirm !== true || !bookingIds.length) {
      return res.status(400).json({
        code: "ASSIGNMENT_CONFIRMATION_REQUIRED",
        message:
          "Run the dry-run preview and confirm its bookingIds before assigning.",
      });
    }
    if (bookingIds.some((bookingId) => !mongoose.isValidObjectId(bookingId))) {
      return res.status(400).json({
        code: "INVALID_BOOKING_ID",
        message: "One or more bookingIds are invalid.",
      });
    }
    try {
      const report = await backfillReservationsForFutureBookings({
        write: true,
        bookingIds,
      });
      return res.json(report);
    } catch (error) {
      return res.status(error?.statusCode || 500).json({
        code: error?.code || "RESERVATION_AUTO_ASSIGNMENT_FAILED",
        message: error?.message || "Failed to assign eligible technicians",
      });
    }
  }
);

router.get(
  "/customer-availability-preview",
  auth,
  ...requirePermission(PERMISSIONS.ADMIN),
  async (req, res) => {
    if (!previewEnabled()) {
      return res.status(404).json({
        code: "CUSTOMER_AVAILABILITY_PREVIEW_DISABLED",
        message: "Customer availability preview is disabled",
      });
    }
    try {
      const report = await buildCustomerAvailabilityReadiness({
        days: req.query.days,
      });
      return res.json(report);
    } catch (error) {
      console.error(
        "Customer availability preview failed:",
        error?.message || error
      );
      return res.status(error?.statusCode || 500).json({
        code: error?.code || "CUSTOMER_AVAILABILITY_PREVIEW_FAILED",
        message: error?.message || "Failed to build availability preview",
      });
    }
  }
);

module.exports = router;
