const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const CompanyAvailabilityTemplate = require("../models/CompanyAvailabilityTemplate");
const {
  calculateDayFromContext,
  generateSlots,
} = require("../utils/availabilityService");
const { validateIntervals } = require("../utils/availabilityValidation");

const DATE = "2026-06-22";
const NOW = new Date("2026-06-21T12:00:00Z");

function companyTemplate(weeklySchedule) {
  return {
    timezone: "America/New_York",
    slotMinutes: 60,
    minLeadMinutes: 0,
    maxAdvanceDays: 120,
    defaultCapacity: 3,
    weeklySchedule,
  };
}

function context({ scope, capacityOverrides = [] }) {
  const technicianId = new mongoose.Types.ObjectId();
  return {
    companyTemplate: companyTemplate([
      {
        weekday: 1,
        enabled: true,
        intervals: [{ startTime: "10:00", endTime: "11:00", capacity: null }],
      },
    ]),
    timezone: "America/New_York",
    scope,
    technicianId: scope === "technician" ? technicianId : null,
    technicians: [
      {
        _id: technicianId,
        name: "Test Technician",
        email: "technician@example.com",
        employeePosition: "Fixter",
        employeeAvailabilityStatus: "Available",
      },
    ],
    technicianTemplates: [
      {
        technicianId,
        active: true,
        inheritCompanyHours: true,
        weeklySchedule: [],
      },
    ],
    availabilityOverrides: [],
    capacityOverrides,
    timeOff: [],
    bookings: [],
    notes: [],
  };
}

async function run() {
  const template = new CompanyAvailabilityTemplate(
    companyTemplate([
      {
        weekday: 1,
        enabled: true,
        intervals: [{ startTime: "09:00", endTime: "17:00" }],
      },
    ])
  );
  await template.validate();
  assert.equal(
    validateIntervals(
      [{ startTime: "09:00", endTime: "10:00", capacity: null }],
      { allowCapacity: true }
    ),
    true
  );
  assert.equal(
    validateIntervals(
      [{ startTime: "09:00", endTime: "10:00", capacity: -1 }],
      { allowCapacity: true }
    ),
    false
  );
  assert.equal(
    validateIntervals(
      [{ startTime: "09:00", endTime: "10:00", capacity: Infinity }],
      { allowCapacity: true }
    ),
    false
  );

  const inherited = generateSlots(
    [{ startTime: "10:00", endTime: "11:00", capacity: null }],
    60,
    3
  );
  assert.equal(inherited.get("10:00").capacity, 3);

  const closedOverride = {
    scopeType: "company",
    date: DATE,
    startTime: "10:00",
    endTime: "11:00",
    mode: "set_capacity",
    value: 0,
  };
  for (const scope of ["company", "technician"]) {
    const closed = calculateDayFromContext({
      date: DATE,
      context: context({ scope, capacityOverrides: [closedOverride] }),
      now: NOW,
    });
    assert.equal(closed.slots[0].totalCapacity, 0);
    assert.equal(closed.slots[0].open, false);
    assert.equal(closed.slots[0].technicians[0].available, false);
    assert.equal(
      closed.slots[0].technicians[0].unavailableReason,
      "Company closed"
    );

    const restored = calculateDayFromContext({
      date: DATE,
      context: context({ scope }),
      now: NOW,
    });
    assert.equal(restored.slots[0].totalCapacity, 1);
    assert.equal(restored.slots[0].open, true);
    assert.equal(restored.slots[0].technicians[0].available, true);
  }

  console.log("calendar deployment gate regression tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
