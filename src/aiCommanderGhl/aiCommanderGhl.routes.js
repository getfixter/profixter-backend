const express = require("express");

const auth = require("../../middleware/auth");
const { PERMISSIONS, requirePermission } = require("../../middleware/authorize");
const controller = require("./aiCommanderGhl.controller");

const router = express.Router();

router.use(auth, ...requirePermission(PERMISSIONS.ADMIN));

router.post("/plan", controller.plan);
router.post("/execute", controller.execute);

module.exports = router;
