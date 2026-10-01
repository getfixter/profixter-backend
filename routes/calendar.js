// routes/calendar.js
const express = require("express");
const router = express.Router();

const CalendarConfig = require("../models/CalendarConfig");
const Booking = require("../models/Booking");
const SlotCounter = require("../models/SlotCounter");
const {
  applyMemberVisitLeadTime,
  customerCalendarConfig,
  customerDayAvailability,
  customerMonthAvailability,
  reservationEngineEnabled,
} = require("../utils/customerCalendarService");
const { hoursForDate } = require("../utils/legacyCalendarSlots");
const { earliestMemberVisitYMD } = require("../utils/bookingLeadTime");

/* ---------------- helpers ---------------- */

/*
 * `?visit=membership` — the calendar is offering a regular membership visit.
 *
 * Those are booked at least seven calendar days out (utils/bookingLeadTime.js),
 * and the availability has to agree with the booking route that enforces it.
 * The other products that read these endpoints keep their own lead time, so
 * the flag is opt-in. It changes what is displayed, never what is permitted.
 */
const isMemberVisitRequest = (req) =>
  String(req.query.visit || "").trim().toLowerCase() === "membership";
function disableLiveAvailabilityCache(res) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
}

const toMin = (hhmm) => {
  const [h, m] = String(hhmm).split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};
const hhmm = (mins) =>
  `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;

const hhmmInTZ = (d, tz) => {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit", 
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const h = p.find((x) => x.type === "hour").value;
  const m = p.find((x) => x.type === "minute").value;
  return `${h}:${m}`;
};

const ymdInTZ = (d, tz) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d); // YYYY-MM-DD

/** Normalize one CalendarConfig doc so it's always in a safe shape */
async function normalizeCfg(doc) {
  if (!doc) doc = await CalendarConfig.create({});
  let changed = false;

  // overrides: accept Map | plain object | empty
  if (doc.overrides && !(doc.overrides instanceof Map)) {
    try {
      doc.overrides = new Map(Object.entries(doc.overrides || {}));
      changed = true;
    } catch {
      doc.overrides = new Map();
      changed = true;
    }
  }
  if (!doc.overrides) {
    doc.overrides = new Map();
    changed = true;
  }

  // guard arrays
  if (!Array.isArray(doc.defaultHours)) {
    doc.defaultHours = [];
    changed = true;
  }
  if (!Array.isArray(doc.closedWeekdays)) {
    doc.closedWeekdays = [];
    changed = true;
  }
  if (!Array.isArray(doc.holidays)) {
    doc.holidays = [];
    changed = true;
  }

  // sane capacity
  if (!Number.isFinite(doc.maxConcurrent) || doc.maxConcurrent < 1) {
    doc.maxConcurrent = 1;
    changed = true;
  }

  if (changed) await doc.save();
  return doc;
}

async function getCfg() {
  let doc = await CalendarConfig.findOne();
  doc = await normalizeCfg(doc);
  return doc;
}

/* ---------------- public endpoints ---------------- */

// GET /api/calendar/config
router.get("/config", async (_req, res) => {
  try {
    if (reservationEngineEnabled()) {
      return res.json(await customerCalendarConfig());
    }
    const cfg = await getCfg();
    const overridesObj =
      cfg.overrides instanceof Map
        ? Object.fromEntries(cfg.overrides)
        : (typeof cfg.overrides === "object" && cfg.overrides !== null ? cfg.overrides : {});

    res.json({
      timezone: cfg.timezone || "America/New_York",
      slotMinutes: cfg.slotMinutes || 60,
      minLeadDays: Number.isFinite(cfg.minLeadDays) ? cfg.minLeadDays : 2,
      /*
       * The first date this customer can actually be offered.
       *
       * A date and nothing else. No rule, no number, no reason — the calendar
       * uses it the way it uses every other availability answer, and there is
       * nothing here for a curious customer or an integration to deduce the
       * seven-day policy from. `memberVisitMinLeadDays: 7` was in this payload
       * for one draft and published the whole rule in a single public field.
       */
      earliestBookableDate: earliestMemberVisitYMD(),
      closedWeekdays: cfg.closedWeekdays || [],
      overrides: overridesObj, // safe plain object
      holidays: cfg.holidays || [],
      // 👇 capacity == # handymen set in admin (maxConcurrent)
      maxConcurrent: cfg.maxConcurrent ?? 1,
      defaultHours: cfg.defaultHours || [],
    });
  } catch (e) {
    console.error("GET /api/calendar/config error:", e?.stack || e?.message || e);
    res.status(500).json({ message: "Failed to read calendar config" });
  }
});

// GET /api/calendar/slots?date=YYYY-MM-DD
// Public so customers can see availability without auth.
router.get("/slots", async (req, res) => {
  try {
    disableLiveAvailabilityCache(res);
    const date = String(req.query.date || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ message: "Missing or invalid date (YYYY-MM-DD)" });
    }
    const memberVisit = isMemberVisitRequest(req);
    if (reservationEngineEnabled()) {
      return res.json(await customerDayAvailability({ date, memberVisit }));
    }
    const respond = (day) =>
      res.json(memberVisit ? applyMemberVisitLeadTime(day) : day);

    const cfg = await getCfg();
    const tz = cfg.timezone || "America/New_York";
    const maxCap = Math.max(1, Number(cfg.maxConcurrent ?? 1));

    // lead time
    const todayLocal = new Date(new Date().toLocaleString("en-US", { timeZone: tz }));
    const targetLocal = new Date(new Date(`${date}T12:00:00`).toLocaleString("en-US", { timeZone: tz }));
    todayLocal.setHours(0, 0, 0, 0);
    targetLocal.setHours(0, 0, 0, 0);
    const diffDays = Math.round((targetLocal - todayLocal) / (1000 * 60 * 60 * 24));
    const minLead = Number(cfg.minLeadDays || 0);
    if (diffDays >= 0 && diffDays < minLead) {
      return respond({ date, slots: [], candidateSlots: [], taken: {}, capacityPerSlot: maxCap });
    }

    // base hours
    let hours = hoursForDate(cfg, date);
    if (!hours.length) {
      return respond({ date, slots: [], candidateSlots: [], taken: {}, capacityPerSlot: maxCap });
    }

    // filter past times if same day
    const todayYMD = ymdInTZ(new Date(), tz);
    if (date === todayYMD) {
      const nowLocal = new Date(new Date().toLocaleString("en-US", { timeZone: tz }));
      const nowMin = toMin(hhmmInTZ(nowLocal, tz));
      hours = hours.filter((h) => toMin(h) > nowMin);
    }

    // read counts from SlotCounter (fast)
    const counters = await SlotCounter.find({ ymd: date, time: { $in: hours } }).lean();
    const taken = Object.fromEntries(counters.map((c) => [c.time, c.count]));

    // sweep: include any open bookings that aren't reflected in counters (rare)
    const dayStart = new Date(`${date}T00:00:00.000Z`);
    const dayEnd = new Date(`${date}T23:59:59.999Z`);
    const live = await Booking.find({
      date: { $gte: dayStart, $lte: dayEnd },
      status: {
        $nin: [
          "Canceled", "Cancelled", "Completed", "Complete", "Done", "Failed", "No-Show", "Noshow"
        ],
      },
    }).select("date status");

    for (const b of live) {
      const key = hhmmInTZ(new Date(b.date), tz);
      if (hours.includes(key)) taken[key] = Math.max(taken[key] || 0, 0) + 1;
    }

    // Expose remaining capacity while keeping "full" ones visible as disabled in UI
    const candidateSlots = hours.map((h) => ({
      time: h,
      available: (taken[h] || 0) < maxCap,
    }));
    const slots = candidateSlots.filter((s) => s.available).map((s) => s.time);
    respond({ date, slots, candidateSlots, taken, capacityPerSlot: maxCap });
  } catch (e) {
    console.error("slots error:", e?.stack || e?.message || e);
    res.status(500).json({ message: "Failed to load slots" });
  }
});

router.get("/month", async (req, res) => {
  disableLiveAvailabilityCache(res);
  if (!reservationEngineEnabled()) {
    return res.status(404).json({
      code: "RESERVATION_ENGINE_DISABLED",
      message: "Customer month availability uses the legacy calendar",
    });
  }
  try {
    return res.json(
      await customerMonthAvailability({
        month: String(req.query.month || ""),
        memberVisit: isMemberVisitRequest(req),
      })
    );
  } catch (error) {
    return res.status(error?.statusCode || 500).json({
      code: error?.code || "CALENDAR_ERROR",
      message: error?.message || "Failed to load month availability",
    });
  }
});

module.exports = router;
