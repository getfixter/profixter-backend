// models/CalendarConfig.js
const mongoose = require("mongoose");

const CalendarConfigSchema = new mongoose.Schema(
  {
    timezone: { type: String, default: "America/New_York" }, // IANA TZ
    slotMinutes: { type: Number, default: 60 },

    /** Minimum lead days (UI/UX + backend gate) */
    minLeadDays: { type: Number, default: 2 },

    /** Days closed every week: 0..6 (Sun..Sat) */
    closedWeekdays: { type: [Number], default: [] },

    /**
     * Admin capacity = number of available handymen per slot.
     * Frontend shows this as "spots" and backend gates on it.
     */
    maxConcurrent: { type: Number, default: 1, min: 1 },

    /**
     * Default open hours like ["09:00","10:30","13:00"].
     * Applied when there is no explicit override and not a holiday/closed day.
     */
    defaultHours: { type: [String], default: [] },

    /**
     * Date-specific overrides: Map<"YYYY-MM-DD", string[]>
     * Example: overrides["2025-10-15"] = ["09:00","11:00","14:00"]
     */
    overrides: {
      type: Map,
      of: [String],
      default: undefined, // we normalize to Map on read/create
    },

    /** Hard-closed days (strings "YYYY-MM-DD") */
    holidays: { type: [String], default: [] },
  },
  { timestamps: true }
);

/** Ensure arrays are sorted/time-like and values are strings HH:MM */
function normalizeHours(arr) {
  if (!Array.isArray(arr)) return [];
  const cleaned = arr
    .map((s) => String(s || "").trim())
    .filter((s) => /^\d{2}:\d{2}$/.test(s));
  // sort by minutes
  const toMin = (hhmm) => {
    const [h, m] = hhmm.split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  cleaned.sort((a, b) => toMin(a) - toMin(b));
  return cleaned;
}

/** Pre save: coerce overrides to Map and hours to clean arrays */
CalendarConfigSchema.pre("save", function (next) {
  // overrides: if plain object, convert to Map
  if (this.overrides && !(this.overrides instanceof Map)) {
    try {
      this.overrides = new Map(Object.entries(this.overrides || {}));
    } catch {
      this.overrides = new Map();
    }
  }
  // clean defaultHours
  this.defaultHours = normalizeHours(this.defaultHours);

  // clean overrides arrays
  if (this.overrides instanceof Map) {
    for (const [k, v] of this.overrides) {
      this.overrides.set(k, normalizeHours(v));
    }
  }

  // ensure sane capacity
  if (!Number.isFinite(this.maxConcurrent) || this.maxConcurrent < 1) {
    this.maxConcurrent = 1;
  }

  next();
});

module.exports = mongoose.model("CalendarConfig", CalendarConfigSchema);
