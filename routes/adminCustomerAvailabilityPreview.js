const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const { PERMISSIONS, requirePermission } = require("../middleware/authorize");
const {
  buildCustomerAvailabilityReadiness,
  previewEnabled,
} = require("../utils/customerAvailabilityReadiness");

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
