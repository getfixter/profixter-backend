const assert = require("node:assert/strict");
const {
  analyzeReservationAudit,
  assertNoTechnicianOverlap,
  backfillReservationsForFutureBookings,
  findEligibleTechnicians,
  overlaps,
  rankEligibleTechnicians,
  reservationEngineEnabled,
  reservationWindow,
} = require("../utils/slotReservationService");

async function run() {
  const window = reservationWindow("2026-07-01T10:00:00-04:00");
  assert.equal(window.slotEnd.toISOString(), "2026-07-01T15:30:00.000Z");
  assert.equal(
    overlaps(
      "2026-07-01T14:00:00Z",
      "2026-07-01T15:30:00Z",
      "2026-07-01T15:00:00Z",
      "2026-07-01T16:30:00Z"
    ),
    true
  );
  assert.equal(
    overlaps(
      "2026-07-01T14:00:00Z",
      "2026-07-01T15:30:00Z",
      "2026-07-01T15:30:00Z",
      "2026-07-01T17:00:00Z"
    ),
    false
  );
  await assert.rejects(
    assertNoTechnicianOverlap({
      technicianId: "tech-1",
      slotStart: new Date("2026-07-01T14:00:00Z"),
      slotEnd: new Date("2026-07-01T15:30:00Z"),
      findOverlap: async () => ({ _id: "reservation-conflict" }),
    }),
    (error) => error.code === "SLOT_CONFLICT"
  );

  const ranked = rankEligibleTechnicians([
    {
      id: "b",
      isDefaultFixter: false,
      dayBookingCount: 0,
      weekBookingCount: 0,
    },
    {
      id: "a",
      isDefaultFixter: true,
      dayBookingCount: 10,
      weekBookingCount: 10,
    },
  ]);
  assert.equal(ranked[0].id, "a");

  const diagnosticOptions = await findEligibleTechnicians({
    slotStart: "2026-07-01T10:00:00-04:00",
    includeDiagnostics: true,
    dependencies: {
      UserModel: {
        find(query) {
          const rows = query._id?.$nin
            ? [{
                _id: "tech-inactive",
                name: "Inactive Tech",
                role: "employee",
                isActive: false,
                employeePosition: "Fixter",
                employeeAvailabilityStatus: "Inactive",
              }]
            : [{
                _id: "tech-scheduled",
                name: "Scheduled Tech",
                role: "employee",
                isActive: true,
                employeePosition: "Fixter",
                employeeAvailabilityStatus: "Available",
                isDefaultFixter: false,
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
                    technicianId: "tech-scheduled",
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
      availabilityForTechnician: async () => ({
        available: false,
        reason: "Outside schedule",
        slot: {},
      }),
      technicianOverlap: async () => null,
    },
  });
  assert.equal(diagnosticOptions.available.length, 0);
  assert.equal(diagnosticOptions.evaluatedTechnicians.length, 2);
  assert.equal(
    diagnosticOptions.evaluatedTechnicians[0].scheduleSource,
    "company_inherited"
  );
  assert.match(
    diagnosticOptions.evaluatedTechnicians[1].reason,
    /inactive/i
  );
  const previousFlag = process.env.ENABLE_RESERVATION_ENGINE;
  delete process.env.ENABLE_RESERVATION_ENGINE;
  assert.equal(reservationEngineEnabled(), false);
  process.env.ENABLE_RESERVATION_ENGINE = "true";
  assert.equal(reservationEngineEnabled(), true);
  if (previousFlag === undefined) delete process.env.ENABLE_RESERVATION_ENGINE;
  else process.env.ENABLE_RESERVATION_ENGINE = previousFlag;

  let writes = 0;
  const bookings = [
    {
      _id: "booking-1",
      date: new Date("2026-07-01T14:00:00Z"),
      assignedFixterId: null,
    },
  ];
  const BookingModel = {
    find: () => ({
      sort: async () => bookings,
    }),
  };
  const dryRun = await backfillReservationsForFutureBookings({
    write: false,
    dependencies: {
      BookingModel,
      activeReservationForBooking: async () => null,
      findEligibleTechnicians: async () => ({
        available: [{ id: "technician-1" }],
        recommended: { id: "technician-1" },
      }),
      reserveSlotForBooking: async () => {
        writes += 1;
      },
    },
  });
  assert.equal(dryRun.canReserve, 1);
  assert.equal(dryRun.plannedAssignments.length, 1);
  assert.equal(dryRun.created, 0);
  assert.equal(writes, 0);
  const writeRun = await backfillReservationsForFutureBookings({
    write: true,
    dependencies: {
      BookingModel,
      activeReservationForBooking: async () => null,
      findEligibleTechnicians: async () => ({
        available: [{ id: "technician-1" }],
        recommended: { id: "technician-1" },
      }),
      reserveSlotForBooking: async () => {
        writes += 1;
      },
    },
  });
  assert.equal(writeRun.created, 1);
  assert.equal(writes, 1);

  const blockedDryRun = await backfillReservationsForFutureBookings({
    write: false,
    dependencies: {
      BookingModel,
      activeReservationForBooking: async () => null,
      findEligibleTechnicians: async () => ({
        available: [],
        unavailable: [{
          id: "technician-1",
          name: "Roman",
          available: false,
          reason: "Outside schedule",
          rejectionCode: "technician_or_capacity_unavailable",
        }],
        evaluatedTechnicians: [{
          id: "technician-1",
          name: "Roman",
          available: false,
          reason: "Outside schedule",
          rejectionCode: "technician_or_capacity_unavailable",
        }],
        recommended: null,
      }),
    },
  });
  assert.equal(blockedDryRun.noEligibleTechnician, 1);
  assert.equal(blockedDryRun.issues[0].bookingId, "booking-1");
  assert.equal(
    blockedDryRun.issues[0].techniciansEvaluated[0].reason,
    "Outside schedule"
  );

  const audit = analyzeReservationAudit({
    bookings: [
      { _id: "booking-1", assignedFixterId: "tech-2", status: "Pending" },
      { _id: "booking-2", assignedFixterId: null, status: "Pending" },
    ],
    reservations: [
      {
        _id: "r1",
        bookingId: "booking-1",
        technicianId: "tech-1",
        status: "reserved",
        slotStart: new Date("2026-07-01T14:00:00Z"),
        slotEnd: new Date("2026-07-01T15:30:00Z"),
      },
      {
        _id: "r2",
        bookingId: "booking-1",
        technicianId: "tech-1",
        status: "held",
        slotStart: new Date("2026-07-01T15:00:00Z"),
        slotEnd: new Date("2026-07-01T16:30:00Z"),
      },
    ],
  });
  assert.equal(audit.activeByBooking.get("booking-1").length, 2);
  assert.equal(audit.technicianOverlaps.length, 1);
  assert.deepEqual(audit.futureBookingsWithoutReservations, ["booking-2"]);
  assert.equal(audit.bookingsWithMultipleActiveReservations.length, 1);
  assert.equal(audit.assignmentMismatch.length, 2);

  console.log("Slot reservation service tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
