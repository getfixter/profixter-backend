const assert = require("node:assert/strict");
const {
  assertEditableCalendarDate,
  isPastCalendarDate,
  todayInTimezone,
} = require("../utils/shadowCalendarDatePolicy");

const now = new Date("2026-06-19T04:30:00Z");

assert.equal(todayInTimezone(now), "2026-06-19");
assert.equal(isPastCalendarDate("2026-06-18", now), true);
assert.equal(isPastCalendarDate("2026-06-19", now), false);
assert.doesNotThrow(() => assertEditableCalendarDate("2026-06-19", now));
assert.throws(
  () => assertEditableCalendarDate("2026-06-18", now),
  /Past days are read-only/
);

console.log("Shadow calendar past-date policy test passed");
