const assert = require("node:assert/strict");
const {
  backfillReservationsForFutureBookings,
  createReservationBuckets,
  isTerminalBookingStatus,
  normalizeBookingStatus,
} = require("../utils/slotReservationService");

const terminalStatuses = [
  "canceled",
  "Canceled",
  "CANCELLED",
  "completed",
  "Done",
  "failed",
  "No-Show",
  "no_show",
  "No Show",
];

async function run() {
  assert.equal(normalizeBookingStatus(" NO_SHOW "), "no-show");
  for (const status of terminalStatuses) {
    assert.equal(isTerminalBookingStatus(status), true, status);
  }
  assert.equal(isTerminalBookingStatus("Pending"), false);

  const future = new Date(Date.now() + 86400000);
  future.setUTCMinutes(Math.floor(future.getUTCMinutes() / 15) * 15, 0, 0);
  const bookings = [
    ...terminalStatuses.map((status, index) => ({
      _id: `terminal-${index}`,
      date: future,
      status,
      assignedFixterId: null,
    })),
    {
      _id: "active-booking",
      date: future,
      status: "Pending",
      assignedFixterId: null,
    },
  ];
  const BookingModel = {
    find: () => ({ sort: async () => bookings }),
  };
  let writes = 0;
  let bucketWrites = 0;
  const dependencies = {
    BookingModel,
    activeReservationForBooking: async () => null,
    findEligibleTechnicians: async () => ({
      available: [{ id: "technician-1" }],
      recommended: { id: "technician-1" },
    }),
    reserveSlotForBooking: async ({ bookingId }) => {
      writes += 1;
      assert.equal(String(bookingId), "active-booking");
      await createReservationBuckets({
        reservation: {
          _id: "reservation-1",
          technicianId: "technician-1",
          bookingId,
          slotStart: future,
          slotEnd: new Date(future.getTime() + 90 * 60 * 1000),
          status: "reserved",
          holdExpiresAt: null,
        },
        session: {},
        BucketModel: {
          async insertMany(rows) {
            bucketWrites += rows.length;
          },
        },
      });
    },
  };

  const dryRun = await backfillReservationsForFutureBookings({
    write: false,
    dependencies,
  });
  assert.equal(dryRun.activeFutureBookings, 1);
  assert.equal(dryRun.terminalBookingsSkipped, terminalStatuses.length);
  assert.equal(dryRun.canReserve, 1);
  assert.equal(writes, 0);

  const writeRun = await backfillReservationsForFutureBookings({
    write: true,
    dependencies,
  });
  assert.equal(writeRun.created, 1);
  assert.equal(writes, 1);
  assert.equal(bucketWrites, 6);

  console.log("Reservation backfill status tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
