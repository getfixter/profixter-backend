const assert = require("node:assert/strict");
const {
  analyzeReservationAudit,
  assertNoTechnicianOverlap,
  backfillReservationsForFutureBookings,
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
