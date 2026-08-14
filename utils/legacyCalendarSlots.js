/**
 * The legacy calendar's idea of which times exist on a given day.
 *
 * This logic used to live only inside routes/calendar.js, which was fine while
 * one endpoint was the only thing that needed it. Full Day needs the same
 * answer, and a second copy of it would drift the first time someone changed a
 * holiday rule, so it moved here rather than being duplicated. The behaviour is
 * unchanged.
 */

const ymdInTZ = (date, timezone) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(date);

const hhmmInTZ = (date, timezone) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);

function toMinutes(hhmm) {
  const [hours, minutes] = String(hhmm).split(":").map(Number);
  return (hours || 0) * 60 + (minutes || 0);
}

function hoursForDate(cfg, ymd) {
  // holidays -> closed
  if ((cfg?.holidays || []).includes(ymd)) return [];

  // overrides -> explicit list (empty = closed)
  if (cfg?.overrides instanceof Map && cfg.overrides.has(ymd)) {
    const list = cfg.overrides.get(ymd) || [];
    return Array.isArray(list) ? list.slice().sort() : [];
  }
  if (
    !(cfg?.overrides instanceof Map) &&
    cfg?.overrides &&
    typeof cfg.overrides === "object"
  ) {
    if (Object.prototype.hasOwnProperty.call(cfg.overrides, ymd)) {
      const list = cfg.overrides[ymd] || [];
      return Array.isArray(list) ? list.slice().sort() : [];
    }
  }

  // weekly closures
  const timezone = cfg?.timezone || "America/New_York";
  const localNoon = new Date(`${ymd}T12:00:00`);
  const weekday = new Date(
    localNoon.toLocaleString("en-US", { timeZone: timezone })
  ).getDay();
  if ((cfg?.closedWeekdays || []).includes(weekday)) return [];

  // defaults
  return Array.isArray(cfg?.defaultHours) ? cfg.defaultHours.slice().sort() : [];
}

/** Days between today and the target date, in the service timezone. */
function leadDays(ymd, timezone, now = new Date()) {
  const today = new Date(now.toLocaleString("en-US", { timeZone: timezone }));
  const target = new Date(
    new Date(`${ymd}T12:00:00`).toLocaleString("en-US", { timeZone: timezone })
  );
  today.setHours(0, 0, 0, 0);
  target.setHours(0, 0, 0, 0);
  return Math.round((target - today) / (1000 * 60 * 60 * 24));
}

module.exports = {
  hhmmInTZ,
  hoursForDate,
  leadDays,
  toMinutes,
  ymdInTZ,
};
