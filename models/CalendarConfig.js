// models/CalendarConfig.js
const mongoose = require("mongoose");

const CalendarConfigSchema = new mongoose.Schema(
  {
    timezone: {
      type: String,
      default: "America/New_York",
    },
    slotMinutes: {
      type: Number,
      default: 60,
      min: 15,
      max: 240,
    },
    minLeadDays: {
      type: Number,
      default: 2,
      min: 0,
      max: 30,
    }, 
    closedWeekdays: {
      type: [Number], // 0=Sun ... 6=Sat
      default: [0],
    },
    defaultHours: {
      type: [String], // "HH:MM"
      default: [],
    },
    overrides: {
      type: Map,
      of: [String],
      default: undefined, // plain object → Map
    },
    holidays: {
      type: [String], // "YYYY-MM-DD"
      default: [],
    },
    maxConcurrent: {
      type: Number,
      default: 1,
      min: 1,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("CalendarConfig", CalendarConfigSchema);
