const express = require("express");
const auth = require("../middleware/auth");
const { requirePermission, PERMISSIONS } = require("../middleware/authorize");
const { buildOverview, buildList, buildMap } = require("../utils/analytics/overview");

/**
 * Admin Overview: the business numbers, their drill-down lists and the
 * customer map.
 *
 * Gated by permission, not by role, so a future Marketing role can be given
 * ANALYTICS_READ (and, separately, ANALYTICS_MAP) without becoming an admin.
 * Today only admins hold either. Every response is per-request private data:
 * never cached by a browser or a proxy.
 */
const router = express.Router();

router.use(auth, requirePermission(PERMISSIONS.ANALYTICS_READ));
router.use((req, res, next) => {
  res.set("Cache-Control", "private, no-store");
  next();
});

const params = (q) => ({
  range: String(q.range || "30d"),
  from: q.from ? String(q.from) : undefined,
  to: q.to ? String(q.to) : undefined,
});

router.get("/", async (req, res) => {
  try {
    res.json(await buildOverview(params(req.query)));
  } catch (error) {
    console.error("Overview failed:", error);
    res.status(500).json({ message: "Overview is temporarily unavailable." });
  }
});

router.get("/list", async (req, res) => {
  try {
    res.json(
      await buildList({
        ...params(req.query),
        metric: String(req.query.metric || ""),
        param: req.query.param ? String(req.query.param).slice(0, 200) : undefined,
      })
    );
  } catch (error) {
    console.error("Overview list failed:", error);
    res.status(500).json({ message: "This list is temporarily unavailable." });
  }
});

/* Customer locations are their own permission: analytics access alone is not enough. */
router.get("/map", requirePermission(PERMISSIONS.ANALYTICS_MAP), async (req, res) => {
  try {
    res.json(await buildMap());
  } catch (error) {
    console.error("Overview map failed:", error);
    res.status(500).json({ message: "The customer map is temporarily unavailable." });
  }
});

module.exports = router;
