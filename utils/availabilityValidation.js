const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function timeToMinutes(value) {
  if (!TIME_RE.test(String(value || ""))) return null;
  const [hours, minutes] = String(value).split(":").map(Number);
  return hours * 60 + minutes;
}

function validateIntervals(intervals, { allowCapacity = false } = {}) {
  if (!Array.isArray(intervals)) return false;
  const normalized = intervals
    .map((interval) => ({
      start: timeToMinutes(interval?.startTime),
      end: timeToMinutes(interval?.endTime),
      capacity: interval?.capacity,
    }))
    .sort((left, right) => (left.start ?? -1) - (right.start ?? -1));

  for (let index = 0; index < normalized.length; index += 1) {
    const current = normalized[index];
    if (
      current.start === null ||
      current.end === null ||
      current.start >= current.end
    ) {
      return false;
    }
    if (
      allowCapacity &&
      current.capacity !== undefined &&
      (!Number.isInteger(current.capacity) || current.capacity < 0)
    ) {
      return false;
    }
    if (index > 0 && normalized[index - 1].end > current.start) return false;
  }
  return true;
}

function weeklyScheduleValidator(schedule, options) {
  if (!Array.isArray(schedule)) return false;
  const weekdays = new Set();
  for (const day of schedule) {
    if (!Number.isInteger(day?.weekday) || day.weekday < 0 || day.weekday > 6) {
      return false;
    }
    if (weekdays.has(day.weekday)) return false;
    weekdays.add(day.weekday);
    if (!validateIntervals(day.intervals || [], options)) return false;
  }
  return true;
}

function dateValidator(value) {
  if (!DATE_RE.test(String(value || ""))) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === String(value)
  );
}

module.exports = {
  DATE_RE,
  TIME_RE,
  dateValidator,
  timeToMinutes,
  validateIntervals,
  weeklyScheduleValidator,
};
