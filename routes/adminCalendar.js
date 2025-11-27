// routes/adminCalendar.js
const express = require("express");
const router = express.Router();
const CalendarConfig = require("../models/CalendarConfig");
const auth = require("../middleware/auth");

// optional: hard gate owner
const isOwner = (req) => req.user?.email === "getfixter@gmail.com";

async function getCfg() {
  let doc = await CalendarConfig.findOne();
  if (!doc) doc = await CalendarConfig.create({});
  return doc;
}

// GET /api/admin/calendar
router.get("/", auth, async (req, res) => {
  // if (!isOwner(req)) return res.status(403).json({ message: "Forbidden" });
  const cfg = await getCfg();
  res.json({
    timezone: cfg.timezone || "America/New_York",
    slotMinutes: cfg.slotMinutes || 60,
    closedWeekdays: cfg.closedWeekdays || [],
    defaultHours: cfg.defaultHours || [],
    overrides: Object.fromEntries(cfg.overrides || []),
    holidays: cfg.holidays || [],
    minLeadDays: Number.isFinite(cfg.minLeadDays) ? cfg.minLeadDays : 2,
    maxConcurrent: cfg.maxConcurrent ?? 1,
  });
});

// PUT /api/admin/calendar
router.put("/", auth, async (req, res) => {
  // if (!isOwner(req)) return res.status(403).json({ message: "Forbidden" });

  const body = req.body || {};
  const updates = {
    timezone: body.timezone || undefined,
    slotMinutes: Number.isFinite(body.slotMinutes) ? body.slotMinutes : undefined,
    closedWeekdays: Array.isArray(body.closedWeekdays) ? body.closedWeekdays : undefined,
    defaultHours: Array.isArray(body.defaultHours) ? body.defaultHours : undefined,
    holidays: Array.isArray(body.holidays) ? body.holidays : undefined,
    minLeadDays: Number.isFinite(body.minLeadDays) ? body.minLeadDays : undefined,
    maxConcurrent: Number.isFinite(body.maxConcurrent) ? body.maxConcurrent : undefined,
  };

  // Normalize overrides (object → Map of arrays)
  if (body.overrides && typeof body.overrides === "object") {
    const m = new Map();
    Object.entries(body.overrides).forEach(([k, v]) => {
      m.set(k, Array.isArray(v) ? v : []);
    });
    updates.overrides = m;
  }

  Object.keys(updates).forEach((k) => updates[k] === undefined && delete updates[k]);

  const cfg = await getCfg();
  Object.assign(cfg, updates);
  await cfg.save();

  res.json({ ok: true });
});

module.exports = router;
