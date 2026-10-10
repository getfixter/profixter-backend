const moment = require("moment-timezone");

/**
 * The next time a cron slot fires, for the Command Center's "next run".
 *
 * Supports exactly the shape the agent schedules use - "m h * * dow", where m
 * and h are numbers and dow is "*", a number, a list or a range ("0,2-6") -
 * and refuses anything else rather than guessing.
 */
function parseDow(field) {
  if (field === "*") return new Set([0, 1, 2, 3, 4, 5, 6]);
  const out = new Set();
  for (const part of field.split(",")) {
    const m = part.match(/^(\d)(?:-(\d))?$/);
    if (!m) throw new Error(`Unsupported day-of-week field: ${field}`);
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    for (let d = a; d <= b; d += 1) out.add(d % 7);
  }
  return out;
}

function nextRun(cron, { from = new Date(), timezone = "America/New_York" } = {}) {
  const [min, hour, dom, mon, dow] = String(cron).trim().split(/\s+/);
  if (!/^\d+$/.test(min) || !/^\d+$/.test(hour) || dom !== "*" || mon !== "*") {
    throw new Error(`Unsupported cron for nextRun: ${cron}`);
  }
  const days = parseDow(dow);
  const start = moment.tz(from, timezone);
  for (let i = 0; i <= 7; i += 1) {
    const candidate = start.clone().add(i, "days").hour(Number(hour)).minute(Number(min)).second(0).millisecond(0);
    if (candidate.isAfter(start) && days.has(candidate.day())) return candidate.toDate();
  }
  return null;
}

/** The soonest next run across an agent's schedules. */
function nextRunFor(def, opts) {
  const times = (def.schedules || []).map((s) => ({ at: nextRun(s.cron, opts), label: s.label, mode: s.mode }));
  times.sort((a, b) => a.at - b.at);
  return times[0] || null;
}

module.exports = { nextRun, nextRunFor };
