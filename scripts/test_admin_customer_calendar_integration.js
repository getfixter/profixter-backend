const assert = require("node:assert/strict");
const {
  calculateDayFromContext,
} = require("../utils/availabilityService");
const {
  customerDayFromShadow,
} = require("../utils/customerCalendarService");

const date = "2026-07-01";
const now = new Date("2026-06-01T12:00:00Z");

function technician(id) {
  return {
    _id: id,
    name: `Technician ${id}`,
    email: `${id}@example.com`,
    employeePosition: "Fixter",
    employeeAvailabilityStatus: "Available",
  };
}

function context(overrides = {}) {
  return {
    companyTemplate: {
      timezone: "America/New_York",
      slotMinutes: 60,
      visitDurationMinutes: 90,
      minLeadMinutes: 0,
      maxAdvanceDays: 120,
      defaultCapacity: 2,
      weeklySchedule: [{
        weekday: 3,
        enabled: true,
        intervals: [{ startTime: "09:00", endTime: "12:00" }],
      }],
    },
    timezone: "America/New_York",
    scope: "company",
    technicianId: null,
    technicians: [technician("tech-1"), technician("tech-2")],
    technicianTemplates: [],
    availabilityOverrides: [],
    capacityOverrides: [],
    timeOff: [],
    bookings: [],
    notes: [],
    ...overrides,
  };
}

function customerDay(overrides = {}, at = now) {
  const shadowDay = calculateDayFromContext({
    date,
    context: context(overrides),
    now: at,
    includeDetails: true,
  });
  return customerDayFromShadow({
    date,
    day: shadowDay,
    reservations: [],
    now: at,
  });
}

function run() {
  const base = customerDay();
  assert.deepEqual(base.slots, ["09:00", "10:00"]);
  assert.equal(base.remaining["09:00"], 2);
  assert.equal(JSON.stringify(base).includes("Technician tech-1"), false);

  const closedDay = customerDay({
    availabilityOverrides: [{
      scopeType: "company",
      date,
      mode: "closed",
      intervals: [],
    }],
  });
  assert.deepEqual(closedDay.slots, []);
  const adjacentDate = "2026-07-08";
  const adjacentShadowDay = calculateDayFromContext({
    date: adjacentDate,
    context: context({
      availabilityOverrides: [{
        scopeType: "company",
        date,
        mode: "closed",
        intervals: [],
      }],
    }),
    now,
    includeDetails: true,
  });
  const adjacentCustomerDay = customerDayFromShadow({
    date: adjacentDate,
    day: adjacentShadowDay,
    reservations: [],
    now,
  });
  assert.deepEqual(adjacentCustomerDay.slots, ["09:00", "10:00"]);

  const closedSlot = customerDay({
    capacityOverrides: [{
      scopeType: "company",
      date,
      startTime: "09:00",
      endTime: "10:00",
      mode: "set_capacity",
      value: 0,
    }],
  });
  assert.deepEqual(closedSlot.slots, ["10:00"]);

  const removedSpot = customerDay({
    capacityOverrides: [{
      scopeType: "company",
      date,
      startTime: "09:00",
      endTime: "10:00",
      mode: "block_spots",
      value: 1,
    }],
  });
  assert.equal(removedSpot.remaining["09:00"], 1);

  const addedSpot = customerDay({
    companyTemplate: {
      ...context().companyTemplate,
      defaultCapacity: 1,
    },
    capacityOverrides: [{
      scopeType: "company",
      date,
      startTime: "09:00",
      endTime: "10:00",
      mode: "adjust_capacity",
      value: 1,
    }],
  });
  assert.equal(addedSpot.remaining["09:00"], 2);

  const timeOff = customerDay({
    timeOff: [{
      technicianId: "tech-1",
      type: "vacation",
      status: "approved",
      startAt: new Date("2026-07-01T04:00:00Z"),
      endAt: new Date("2026-07-02T04:00:00Z"),
    }],
  });
  assert.equal(timeOff.remaining["09:00"], 1);

  const technicianSchedule = customerDay({
    technicianTemplates: [{
      technicianId: "tech-1",
      active: true,
      inheritCompanyHours: false,
      weeklySchedule: [{
        weekday: 3,
        enabled: true,
        intervals: [{ startTime: "10:00", endTime: "12:00" }],
      }],
    }],
  });
  assert.equal(technicianSchedule.remaining["09:00"], 1);
  assert.equal(technicianSchedule.remaining["10:00"], 2);

  const changedCompanySchedule = customerDay({
    companyTemplate: {
      ...context().companyTemplate,
      weeklySchedule: [{
        weekday: 3,
        enabled: true,
        intervals: [{ startTime: "11:00", endTime: "14:00" }],
      }],
    },
  });
  assert.deepEqual(changedCompanySchedule.slots, ["11:00", "12:00"]);

  const todayWithPastTime = customerDay(
    {},
    new Date("2026-07-01T13:30:00Z")
  );
  assert.deepEqual(todayWithPastTime.slots, ["10:00"]);

  console.log("Admin/customer calendar integration tests passed");
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
