const assert = require("node:assert/strict");
const {
  buildLegacyDay,
  compareAvailabilityDays,
  previewEnabled,
} = require("../utils/customerAvailabilityReadiness");
const router = require("../routes/adminCustomerAvailabilityPreview");
const {
  PERMISSIONS,
  permissionsForUser,
} = require("../middleware/authorize");

function run() {
  const previousFlag = process.env.ENABLE_CUSTOMER_AVAILABILITY_PREVIEW;
  delete process.env.ENABLE_CUSTOMER_AVAILABILITY_PREVIEW;
  assert.equal(previewEnabled(), false);
  process.env.ENABLE_CUSTOMER_AVAILABILITY_PREVIEW = "true";
  assert.equal(previewEnabled(), true);
  if (previousFlag === undefined) {
    delete process.env.ENABLE_CUSTOMER_AVAILABILITY_PREVIEW;
  } else {
    process.env.ENABLE_CUSTOMER_AVAILABILITY_PREVIEW = previousFlag;
  }

  const legacy = buildLegacyDay({
    date: "2026-07-01",
    config: {
      timezone: "America/New_York",
      minLeadDays: 0,
      maxConcurrent: 2,
      defaultHours: ["10:00", "11:00"],
      closedWeekdays: [],
      holidays: [],
      overrides: {},
    },
    counters: [{ ymd: "2026-07-01", time: "10:00", count: 1 }],
    bookings: [{
      date: new Date("2026-07-01T14:00:00Z"),
      status: "canceled",
    }],
    now: new Date("2026-06-01T12:00:00Z"),
  });
  assert.equal(legacy.slots.length, 2);
  assert.equal(legacy.slots[0].remainingCapacity, 0);

  const report = compareAvailabilityDays({
    legacyDays: [legacy],
    shadowDays: [{
      date: "2026-07-01",
      closed: false,
      usedCapacity: 0,
      slots: [
        {
          time: "10:00",
          totalCapacity: 1,
          usedCapacity: 0,
          open: true,
        },
        {
          time: "12:00",
          totalCapacity: 1,
          usedCapacity: 0,
          open: true,
        },
      ],
    }],
    reservations: [{
      _id: "reservation-1",
      status: "reserved",
      slotStart: new Date("2026-07-01T14:00:00Z"),
      slotEnd: new Date("2026-07-01T15:30:00Z"),
    }],
    now: new Date("2026-06-01T12:00:00Z"),
  });
  assert.equal(report.decision, "NO");
  assert.equal(report.mismatchCounts.legacyOnlySlots, 1);
  assert.equal(report.mismatchCounts.shadowOnlySlots, 2);
  assert.equal(report.mismatchCounts.capacityMismatch, 1);
  assert.equal(report.mismatchCounts.bookingCountMismatch, 1);
  assert(report.mismatchCounts.reservationConflict >= 1);

  const admin = permissionsForUser({ role: "admin" });
  const general = permissionsForUser({
    role: "employee",
    employeePosition: "General Fixter",
  });
  assert(admin.includes(PERMISSIONS.ADMIN));
  assert(!general.includes(PERMISSIONS.ADMIN));

  const route = router.stack.find(
    (layer) => layer.route?.path === "/customer-availability-preview"
  );
  assert(route);
  assert.equal(route.route.methods.get, true);
  assert.equal(route.route.stack.length, 4);

  console.log("Customer availability readiness tests passed");
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
