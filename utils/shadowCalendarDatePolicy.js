const moment = require("moment-timezone");
const { dateValidator } = require("./availabilityValidation");

const SHADOW_CALENDAR_TIMEZONE = "America/New_York";

function todayInTimezone(
  now = new Date(),
  timezone = SHADOW_CALENDAR_TIMEZONE
) {
  return moment(now).tz(timezone).format("YYYY-MM-DD");
}

function isPastCalendarDate(
  date,
  now = new Date(),
  timezone = SHADOW_CALENDAR_TIMEZONE
) {
  return dateValidator(date) && date < todayInTimezone(now, timezone);
}

function assertEditableCalendarDate(
  date,
  now = new Date(),
  timezone = SHADOW_CALENDAR_TIMEZONE
) {
  if (!dateValidator(date)) {
    const error = new Error("date must be YYYY-MM-DD");
    error.statusCode = 400;
    throw error;
  }
  if (isPastCalendarDate(date, now, timezone)) {
    const error = new Error("Past days are read-only.");
    error.statusCode = 400;
    throw error;
  }
}

function dateForInstant(value, timezone = SHADOW_CALENDAR_TIMEZONE) {
  const parsed = moment(value);
  return parsed.isValid() ? parsed.tz(timezone).format("YYYY-MM-DD") : "";
}

module.exports = {
  SHADOW_CALENDAR_TIMEZONE,
  assertEditableCalendarDate,
  dateForInstant,
  isPastCalendarDate,
  todayInTimezone,
};
