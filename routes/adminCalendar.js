// routes/adminCalendar.js
const express = require("express");
const router = express.Router();
const CalendarConfig = require("../models/CalendarConfig");
const auth = require("../middleware/auth");
const { PERMISSIONS, requirePermission } = require("../middleware/authorize");

// Load or create config doc
async function getCfg() {
  let doc = await CalendarConfig.findOne();
  if (!doc) {
    doc = await CalendarConfig.create({});
  }
  return doc;
}

/**
 * GET /api/admin/calendar
 * Returns current calendar configuration for Admin UI
 */
router.get("/", auth, ...requirePermission(PERMISSIONS.SCHEDULE_READ), async (req, res) => {
  try {
    const cfg = await getCfg();

    res.json({
      timezone: cfg.timezone || "America/New_York",
      slotMinutes: cfg.slotMinutes || 60,
      closedWeekdays: cfg.closedWeekdays || [],
      defaultHours: cfg.defaultHours || [],
      overrides:
        cfg.overrides instanceof Map
          ? Object.fromEntries(cfg.overrides)
          : cfg.overrides || {},
      holidays: cfg.holidays || [],
      minLeadDays: Number.isFinite(cfg.minLeadDays)
        ? cfg.minLeadDays
        : 2,
      handymanCapacity: cfg.maxConcurrent ?? 1, // 👈 frontend name
    });
  } catch (err) {
    console.error("GET /api/admin/calendar error:", err);
    res
      .status(500)
      .json({ message: "Failed to load calendar config" });
  }
});

/**
 * PUT /api/admin/calendar
 * Updates calendar configuration from Admin UI
 */
router.put("/", auth, ...requirePermission(PERMISSIONS.SCHEDULE_WRITE), async (req, res) => {
  try {
    const body = req.body || {};
    const cfg = await getCfg();

    // timezone
    if (typeof body.timezone === "string" && body.timezone.trim()) {
      cfg.timezone = body.timezone.trim();
    }

    // slotMinutes (cast to number FIRST)
    const slotMinutesNum = Number(body.slotMinutes);
    if (Number.isFinite(slotMinutesNum)) {
      cfg.slotMinutes = Math.min(
        240,
        Math.max(15, slotMinutesNum)
      );
    }

    // minLeadDays
    const minLeadNum = Number(body.minLeadDays);
    if (Number.isFinite(minLeadNum)) {
      cfg.minLeadDays = Math.min(30, Math.max(0, minLeadNum));
    }

    // closedWeekdays
    if (Array.isArray(body.closedWeekdays)) {
      cfg.closedWeekdays = body.closedWeekdays
        .map((n) => Number(n))
        .filter((n) => Number.isFinite(n) && n >= 0 && n <= 6);
    }

    // defaultHours
    if (Array.isArray(body.defaultHours)) {
      cfg.defaultHours = body.defaultHours
        .filter((s) => typeof s === "string")
        .sort(); // "HH:MM" sorts correctly as strings
    }

    // holidays
    if (Array.isArray(body.holidays)) {
      cfg.holidays = body.holidays.filter(
        (s) => typeof s === "string"
      );
    }

    // capacity
    const capNum = Number(body.handymanCapacity);
    if (Number.isFinite(capNum)) {
      cfg.maxConcurrent = Math.max(1, capNum);
    }

    // overrides: plain object → Map<string, string[]>
    if (body.overrides && typeof body.overrides === "object") {
      const map = new Map();
      Object.entries(body.overrides).forEach(([ymd, arr]) => {
        if (!Array.isArray(arr)) {
          map.set(ymd, []);
        } else {
          map.set(
            ymd,
            arr
              .filter((s) => typeof s === "string")
              .sort()
          );
        }
      });
      cfg.overrides = map;
    }

    await cfg.save();
    res.json({ ok: true });
  } catch (err) {
    console.error("PUT /api/admin/calendar error:", err);
    res
      .status(500)
      .json({ message: "Failed to save calendar config" });
  }
});

module.exports = router;
