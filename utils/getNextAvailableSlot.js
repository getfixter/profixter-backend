const Booking = require("../models/Booking");
const CalendarConfig = require("../models/CalendarConfig");
const moment = require("moment-timezone");

/**
 * Returns next available appointment datetime in ISO format, or null if none.
 */
async function getNextAvailableSlot() {
  const config = await CalendarConfig.findOne().lean();
  if (!config || !config.defaultHours?.length) return null;

  const {
    timezone = "America/New_York",
    slotMinutes = 60,
    minLeadDays = 2,
    closedWeekdays = [],
    defaultHours = [],
    overrides = new Map(),
    holidays = [],
    maxConcurrent = 1,
  } = config;

  const startDate = moment().tz(timezone).add(minLeadDays, "days").startOf("day");
  const maxDate = moment(startDate).add(30, "days");

  for (let d = moment(startDate); d.isBefore(maxDate); d.add(1, "day")) {
    const dateStr = d.format("YYYY-MM-DD");
    const weekday = d.day();

    if (closedWeekdays.includes(weekday)) continue;
    if (holidays.includes(dateStr)) continue;

    const hours = overrides instanceof Map && overrides.has(dateStr)
      ? overrides.get(dateStr)
      : defaultHours;

    for (const hour of hours) {
      const [h, m] = hour.split(":").map(Number);
      const slotDate = moment.tz(dateStr, timezone).set({ hour: h, minute: m });
      const slotStart = slotDate.toDate();

      const existing = await Booking.countDocuments({
        date: slotStart,
        status: { $ne: "Canceled" },
      });

      if (existing < maxConcurrent) {
        return slotDate.toISOString();
      }
    }
  }

  return null;
}

module.exports = { getNextAvailableSlot };
