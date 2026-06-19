const assert = require("node:assert/strict");
const {
  analyzeReservationAudit,
  auditReservationConflicts,
} = require("../utils/slotReservationService");

function reservation(id, bookingId, technicianId = "tech-1") {
  return {
    _id: id,
    bookingId,
    technicianId,
    status: "reserved",
    slotStart: new Date("2026-07-01T14:00:00Z"),
    slotEnd: new Date("2026-07-01T15:30:00Z"),
  };
}

function assertStale(status) {
  const report = analyzeReservationAudit({
    bookings: [
      {
        _id: "booking-1",
        status,
        assignedFixterId: "tech-2",
      },
    ],
    reservations: [reservation("reservation-1", "booking-1")],
  });
  assert.deepEqual(report.reservationsForCanceledBookings, ["reservation-1"]);
  assert.deepEqual(report.assignmentMismatch, ["reservation-1"]);
  assert.equal(report.staleReservations[0].normalizedStatus, String(status).toLowerCase());
}

async function run() {
  assertStale("Canceled");
  assertStale("canceled");
  assertStale("Completed");

  const futureBookings = [
    {
      _id: "future-booking",
      date: new Date("2026-07-02T14:00:00Z"),
      status: "Pending",
      assignedFixterId: null,
    },
  ];
  const linkedBookings = [
    {
      _id: "canceled-booking",
      date: new Date("2026-06-01T14:00:00Z"),
      status: "cancelled",
      assignedFixterId: "tech-2",
    },
  ];
  const reservations = [
    reservation("stale-reservation", "canceled-booking", "tech-1"),
    {
      ...reservation("expired-hold", "future-booking", "tech-1"),
      status: "held",
      holdExpiresAt: new Date("2020-01-01T00:00:00Z"),
    },
  ];
  let bookingFindCalls = 0;
  let reservationFindCalls = 0;
  let writes = 0;
  const BookingModel = {
    find(query) {
      bookingFindCalls += 1;
      const rows = query.date ? futureBookings : linkedBookings;
      return { lean: async () => rows };
    },
    create: async () => {
      writes += 1;
    },
    updateOne: async () => {
      writes += 1;
    },
  };
  const ReservationModel = {
    find() {
      reservationFindCalls += 1;
      return { lean: async () => reservations };
    },
    create: async () => {
      writes += 1;
    },
    updateOne: async () => {
      writes += 1;
    },
  };
  const BucketModel = {
    find() {
      return {
        lean: async () => [
          {
            _id: "stale-bucket",
            technicianId: "tech-1",
            reservationId: "stale-reservation",
            bookingId: "canceled-booking",
            bucketStart: new Date("2026-07-01T14:00:00Z"),
            bucketEnd: new Date("2026-07-01T14:15:00Z"),
            status: "reserved",
          },
          {
            _id: "expired-hold-bucket",
            technicianId: "tech-1",
            reservationId: "expired-hold",
            bookingId: "future-booking",
            bucketStart: new Date("2026-07-01T14:00:00Z"),
            bucketEnd: new Date("2026-07-01T14:15:00Z"),
            status: "held",
            expiresAt: new Date("2020-01-01T00:00:00Z"),
          },
        ],
      };
    },
  };
  const report = await auditReservationConflicts({
    dependencies: {
      BookingModel,
      ReservationModel,
      BucketModel,
      CapacityBucketModel: {
        find() {
          return { lean: async () => [] };
        },
      },
      findEligibleTechnicians: async () => ({
        available: [],
        unavailable: [{ reason: "Outside schedule" }],
      }),
      availabilityForTechnician: async () => ({ available: true }),
    },
  });
  assert.deepEqual(report.reservationsForCanceledBookings, [
    "stale-reservation",
  ]);
  assert.deepEqual(report.assignmentMismatch, ["stale-reservation"]);
  assert.deepEqual(report.outsideWorkingHours, ["future-booking"]);
  assert.deepEqual(report.staleExpiredHolds.map((entry) => entry.reservationId), [
    "expired-hold",
  ]);
  assert.deepEqual(
    new Set(report.staleBuckets),
    new Set(["stale-bucket", "expired-hold-bucket"])
  );
  assert.equal(bookingFindCalls, 2);
  assert.equal(reservationFindCalls, 2);
  assert.equal(writes, 0);

  console.log("Reservation audit regression tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
