// backend/models/SlotCounter.js
const mongoose = require("mongoose");

/** Tracks how many bookings are occupying a given (ymd,time) slot. */
const SlotCounterSchema = new mongoose.Schema(
  {
    ymd:  { type: String, required: true }, // "YYYY-MM-DD" in service timezone
    time: { type: String, required: true }, // "HH:MM"
    count:{ type: Number, default: 0 },
  },
  { timestamps: true }
);

SlotCounterSchema.index({ ymd: 1, time: 1 }, { unique: true });

module.exports = mongoose.model("SlotCounter", SlotCounterSchema);
