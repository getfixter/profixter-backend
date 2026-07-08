const express = require("express");

const auth = require("../../middleware/auth");
const { PERMISSIONS, requirePermission } = require("../../middleware/authorize");
const controller = require("./aiCommanderGhl.controller");
const { scheduleWorkflowJobResume } = require("./jarvisWorkflowJobRunner");

const router = express.Router();

router.use(auth, ...requirePermission(PERMISSIONS.ADMIN));

router.post("/plan", controller.plan);
router.post("/execute", controller.execute);
router.get("/workflows/:jobId", controller.workflowJob);

scheduleWorkflowJobResume();

module.exports = router;
