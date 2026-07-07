const express = require("express");

const auth = require("../../../middleware/auth");
const { PERMISSIONS, requirePermission } = require("../../../middleware/authorize");
const controller = require("./roofingSalesAgent.controller");

const router = express.Router();

router.post(
  "/admin/jarvis/roofing-agent/simulate",
  auth,
  ...requirePermission(PERMISSIONS.ADMIN),
  controller.simulate
);

router.post("/jarvis/roofing-agent/ghl-webhook", controller.ghlWebhook);

module.exports = router;
