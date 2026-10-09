const express = require("express");
const auth = require("../middleware/auth");
const { requirePermission, PERMISSIONS } = require("../middleware/authorize");
const GrowthAction = require("../models/GrowthAction");
require("../utils/growth/actions");
const engine = require("../utils/growth/actionEngine");
const { buildCommandCenter } = require("../utils/growth/commandCenter");

/**
 * Growth Command Center API.
 *
 * Reading is the Overview permission: whoever may see the business numbers may
 * see what the growth system is doing. Deciding is the owner's alone - approving
 * an action sends something to a customer or spends money, and changing a
 * policy decides what will run unattended from then on - so those routes need
 * the owner key, which no employee section grants.
 */
const router = express.Router();

router.use(auth);
router.use((req, res, next) => {
  res.set("Cache-Control", "private, no-store");
  next();
});

const canRead = requirePermission(PERMISSIONS.ANALYTICS_READ);
const ownerOnly = requirePermission(PERMISSIONS.ADMIN);

function ownerActor(req) {
  const user = req.accessUser || {};
  return { kind: "owner", name: user.name || user.email || "Owner", userId: user._id || null };
}

function fail(res, error, fallback) {
  const status = error?.status || 500;
  if (status >= 500) console.error(fallback, error);
  return res.status(status).json({ message: status >= 500 ? fallback : error.message });
}

router.get("/summary", canRead, async (req, res) => {
  try {
    res.json(await buildCommandCenter());
  } catch (error) {
    fail(res, error, "The Command Center is temporarily unavailable.");
  }
});

router.get("/actions", canRead, async (req, res) => {
  try {
    const filter = {};
    if (req.query.status && GrowthAction.STATUSES.includes(String(req.query.status))) {
      filter.status = String(req.query.status);
    }
    if (req.query.type) filter.type = String(req.query.type).slice(0, 80);
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const rows = await GrowthAction.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
    res.json({ actions: rows.map(({ payload, ...rest }) => rest) });
  } catch (error) {
    fail(res, error, "Could not load actions.");
  }
});

router.post("/actions/:id/approve", ownerOnly, async (req, res) => {
  try {
    res.json({ action: await engine.approve(req.params.id, ownerActor(req), req.body?.note || "") });
  } catch (error) {
    fail(res, error, "Could not approve that action.");
  }
});

router.post("/actions/:id/reject", ownerOnly, async (req, res) => {
  try {
    res.json({ action: await engine.reject(req.params.id, ownerActor(req), req.body?.note || "") });
  } catch (error) {
    fail(res, error, "Could not reject that action.");
  }
});

router.post("/actions/:id/rollback", ownerOnly, async (req, res) => {
  try {
    res.json({ action: await engine.rollback(req.params.id, ownerActor(req)) });
  } catch (error) {
    fail(res, error, "Could not roll back that action.");
  }
});

router.put("/policies/:type", ownerOnly, async (req, res) => {
  try {
    const mode = String(req.body?.mode || "");
    res.json({ policy: await engine.setPolicyMode(req.params.type, mode, ownerActor(req), req.body?.note || "") });
  } catch (error) {
    if (/Unknown growth mode/.test(error?.message || "")) error.status = 400;
    fail(res, error, "Could not change that policy.");
  }
});

module.exports = router;
