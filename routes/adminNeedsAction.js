/**
 * GET /api/admin/needs-action?limit=25
 *
 * Any signed-in staff account; each section is filtered by the caller's own
 * permissions and record scope (utils/needsAction). A customer gets 403.
 */
const express = require("express");
const auth = require("../middleware/auth");
const { loadAccessUser } = require("../middleware/authorize");
const { collectNeedsAction } = require("../utils/needsAction");

const router = express.Router();

router.get("/", auth, loadAccessUser, async (req, res) => {
  try {
    if (req.accessRole !== "admin" && !(req.permissions || []).length) {
      return res.status(403).json({ message: "Access denied", code: "FORBIDDEN" });
    }
    const limit = Math.min(Math.max(1, Number(req.query.limit) || 25), 100);
    return res.json(await collectNeedsAction({ accessUser: req.accessUser, limit }));
  } catch (error) {
    console.error("needs-action failed:", error);
    return res.status(500).json({ message: "Failed to load Needs action", code: "SERVER_ERROR" });
  }
});

module.exports = router;
