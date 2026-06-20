const assert = require("node:assert/strict");
const {
  hoursToIntervals,
  inferLegacySlotMinutes,
} = require("../utils/availabilityBootstrap");
const { generateSlots } = require("../utils/availabilityService");

function run() {
  const legacyStarts = ["09:00", "10:00", "11:00", "12:00", "16:00"];
  const step = inferLegacySlotMinutes(legacyStarts, 60);
  assert.equal(step, 60);

  const intervals = hoursToIntervals(legacyStarts, step, 2);
  assert.deepEqual(intervals, [
    { startTime: "09:00", endTime: "13:30", capacity: 2 },
    { startTime: "16:00", endTime: "17:30", capacity: 2 },
  ]);

  const generated = generateSlots(intervals, step, 2, 90);
  for (const start of legacyStarts) assert.equal(generated.has(start), true);
  assert.equal(generated.get("16:00").endTime, "17:30");

  const oldImport = hoursToIntervals(["16:00"], 60, 2, 60);
  assert.equal(oldImport[0].endTime, "17:00");

  console.log("Legacy calendar interval import tests passed");
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
