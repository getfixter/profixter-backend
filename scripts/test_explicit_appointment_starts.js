const assert = require("node:assert/strict");
const {
  calculateDayFromContext,
} = require("../utils/availabilityService");
const {
  customerDayFromShadow,
} = require("../utils/customerCalendarService");
const {
  backfillReservationsForFutureBookings,
  findEligibleTechnicians,
} = require("../utils/slotReservationService");

const DATE = "2026-06-23";
const NOW = new Date("2026-06-20T12:00:00Z");
const ROMAN_ID = "roman-active";
const STARTS = ["08:00", "10:30", "13:00", "15:30"];

function baseContext(overrides = {}) {
  return {
    companyTemplate: {
      timezone: "America/New_York",
      slotMinutes: 30,
      visitDurationMinutes: 90,
      minLeadMinutes: 0,
      maxAdvanceDays: 120,
      defaultCapacity: 1,
      weeklySchedule: [{
        weekday: 2,
        enabled: true,
        starts: STARTS.map((time) => ({ time })),
        intervals: [],
      }],
    },
    timezone: "America/New_York",
    scope: "company",
    technicianId: null,
    technicians: [{
      _id: ROMAN_ID,
      name: "Roman Hecha",
      email: "roman@example.com",
      employeePosition: "Fixter",
      employeeAvailabilityStatus: "Available",
      isActive: true,
    }],
    technicianTemplates: [{
      technicianId: ROMAN_ID,
      active: true,
      inheritCompanyHours: true,
      weeklySchedule: [],
    }],
    availabilityOverrides: [],
    capacityOverrides: [],
    timeOff: [],
    bookings: [],
    notes: [],
    ...overrides,
  };
}

function calculate(overrides = {}) {
  return calculateDayFromContext({
    date: DATE,
    context: baseContext(overrides),
    now: NOW,
    includeDetails: true,
  });
}

async function run() {
  const day = calculate();
  assert.deepEqual(day.slots.map((slot) => slot.time), STARTS);
  assert.deepEqual(
    day.slots.map((slot) => slot.endTime),
    ["09:30", "12:00", "14:30", "17:00"]
  );
  assert.equal(day.slots[1].technicians[0].available, true);
  assert.equal(day.slots.some((slot) => slot.time === "09:30"), false);
  assert.deepEqual(day.scheduleDiagnostics.configuredCompanyStarts, STARTS);
  assert.deepEqual(day.scheduleDiagnostics.generatedCompanyStarts, STARTS);

  const customer = customerDayFromShadow({
    date: DATE,
    day,
    reservations: [],
    now: NOW,
  });
  assert.deepEqual(customer.slots, STARTS);

  const legacyWindowOverride = calculate({
    availabilityOverrides: [{
      scopeType: "company",
      date: DATE,
      mode: "custom_hours",
      starts: [],
      intervals: [{ startTime: "08:00", endTime: "17:00" }],
    }],
  });
  assert.deepEqual(
    legacyWindowOverride.slots.map((slot) => slot.time),
    STARTS,
    "legacy day windows must retain real company starts"
  );
  assert.equal(
    legacyWindowOverride.slots.some((slot) => slot.time === "08:30"),
    false
  );

  const closedStart = calculate({
    capacityOverrides: [{
      scopeType: "company",
      date: DATE,
      startTime: "10:30",
      endTime: "12:00",
      mode: "set_capacity",
      value: 0,
    }],
  });
  assert.equal(
    closedStart.slots.find((slot) => slot.time === "10:30").open,
    false
  );
  assert.equal(
    closedStart.slots.find((slot) => slot.time === "13:00").open,
    true
  );

  const closedDay = calculate({
    availabilityOverrides: [{
      scopeType: "company",
      date: DATE,
      mode: "closed",
      starts: [],
      intervals: [],
    }],
  });
  assert.deepEqual(closedDay.slots, []);
  const adjacentDay = calculateDayFromContext({
    date: "2026-06-30",
    context: baseContext({
      availabilityOverrides: [{
        scopeType: "company",
        date: DATE,
        mode: "closed",
        starts: [],
        intervals: [],
      }],
    }),
    now: NOW,
    includeDetails: true,
  });
  assert.deepEqual(adjacentDay.slots.map((slot) => slot.time), STARTS);

  const optionsFor = async (slotStart) =>
    findEligibleTechnicians({
      slotStart,
      includeDiagnostics: true,
      dependencies: {
        UserModel: {
          find(query) {
            const rows = query._id?.$nin
              ? []
              : [{
                  _id: ROMAN_ID,
                  name: "Roman Hecha",
                  email: "roman@example.com",
                  role: "employee",
                  isActive: true,
                  employeePosition: "Fixter",
                  employeeAvailabilityStatus: "Available",
                  isDefaultFixter: true,
                }];
            return {
              select() {
                return { async lean() { return rows; } };
              },
            };
          },
        },
        TechnicianTemplateModel: {
          find() {
            return {
              select() {
                return {
                  async lean() {
                    return [{
                      technicianId: ROMAN_ID,
                      inheritCompanyHours: true,
                      active: true,
                    }];
                  },
                };
              },
            };
          },
        },
        bookingCountsByTechnician: async () => ({
          day: new Map(),
          week: new Map(),
        }),
        availabilityForTechnician: async ({ slotStart: requestedStart }) => {
          const requested = new Intl.DateTimeFormat("en-US", {
            timeZone: "America/New_York",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          }).format(requestedStart);
          const slot = day.slots.find((entry) => entry.time === requested);
          return {
            available: !!slot,
            reason: slot ? "" : "No matching company start",
            slot,
          };
        },
        technicianOverlap: async () => null,
      },
    });

  for (const time of STARTS) {
    const options = await optionsFor(
      new Date(`${DATE}T${time}:00-04:00`)
    );
    assert.equal(options.recommended.id, ROMAN_ID);
    assert.equal(options.recommended.scheduleSource, "company_inherited");
  }

  const bookings = STARTS.map((time, index) => ({
    _id: `booking-${index}`,
    date: new Date(`${DATE}T${time}:00-04:00`),
    status: "Pending",
    assignedFixterId: null,
  }));
  const dryRun = await backfillReservationsForFutureBookings({
    write: false,
    dependencies: {
      BookingModel: {
        find() {
          return { async sort() { return bookings; } };
        },
      },
      activeReservationForBooking: async () => null,
      findEligibleTechnicians: ({ slotStart }) => optionsFor(slotStart),
    },
  });
  assert.equal(dryRun.noEligibleTechnician, 0);
  assert.equal(dryRun.canReserve, 4);
  assert.equal(dryRun.plannedAssignments.length, 4);

  console.log("Explicit appointment start integration tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
