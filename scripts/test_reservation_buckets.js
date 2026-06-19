const assert = require("node:assert/strict");
const {
  analyzeReservationBucketAudit,
  applyBucketMove,
  bucketDocuments,
  createReservationBuckets,
  deleteReservationBuckets,
  planBucketMove,
  reservationBucketStarts,
} = require("../utils/slotReservationService");

function keys(start) {
  const slotStart = new Date(start);
  const slotEnd = new Date(slotStart.getTime() + 90 * 60 * 1000);
  return reservationBucketStarts(slotStart, slotEnd).map((value) =>
    value.toISOString()
  );
}

async function run() {
  const exact = keys("2026-07-01T14:00:00Z");
  const overlap = keys("2026-07-01T14:30:00Z");
  const nonOverlap = keys("2026-07-01T15:30:00Z");
  assert.equal(exact.length, 6);
  assert(exact.some((value) => overlap.includes(value)));
  assert(!exact.some((value) => nonOverlap.includes(value)));

  const occupied = new Set();
  const BucketModel = {
    async insertMany(rows) {
      for (const row of rows) {
        const key = `${row.technicianId}:${row.bucketStart.toISOString()}`;
        if (occupied.has(key)) {
          const error = new Error("duplicate bucket");
          error.code = 11000;
          throw error;
        }
      }
      rows.forEach((row) =>
        occupied.add(`${row.technicianId}:${row.bucketStart.toISOString()}`)
      );
    },
    deleteMany() {
      return {
        async session() {
          occupied.clear();
          return { deletedCount: 6 };
        },
      };
    },
  };
  const fakeReservation = (id, start) => ({
    _id: id,
    technicianId: "tech-1",
    bookingId: `booking-${id}`,
    slotStart: new Date(start),
    slotEnd: new Date(new Date(start).getTime() + 90 * 60 * 1000),
    status: "reserved",
    holdExpiresAt: null,
  });
  await createReservationBuckets({
    reservation: fakeReservation("one", "2026-07-01T14:00:00Z"),
    session: {},
    BucketModel,
  });
  await assert.rejects(
    createReservationBuckets({
      reservation: fakeReservation("same", "2026-07-01T14:00:00Z"),
      session: {},
      BucketModel,
    }),
    (error) => error.code === "SLOT_CONFLICT"
  );
  await assert.rejects(
    createReservationBuckets({
      reservation: fakeReservation("overlap", "2026-07-01T14:30:00Z"),
      session: {},
      BucketModel,
    }),
    (error) => error.code === "SLOT_CONFLICT"
  );
  await createReservationBuckets({
    reservation: fakeReservation("later", "2026-07-01T15:30:00Z"),
    session: {},
    BucketModel,
  });
  assert.equal(occupied.size, 12);
  await deleteReservationBuckets({
    reservationId: "one",
    session: {},
    BucketModel,
    CapacityBucketModel: {
      deleteMany() {
        return {
          async session() {
            return { deletedCount: 0 };
          },
        };
      },
    },
  });
  assert.equal(occupied.size, 0);

  const documents = bucketDocuments({
    technicianId: "tech-1",
    reservationId: "reservation-1",
    bookingId: "booking-1",
    slotStart: new Date("2026-07-01T14:00:00Z"),
    slotEnd: new Date("2026-07-01T15:30:00Z"),
    status: "reserved",
  });
  assert.equal(documents.length, 6);
  const movedDocuments = bucketDocuments({
    technicianId: "tech-1",
    reservationId: "reservation-1",
    bookingId: "booking-1",
    slotStart: new Date("2026-07-01T15:30:00Z"),
    slotEnd: new Date("2026-07-01T17:00:00Z"),
    status: "reserved",
  });
  const movePlan = planBucketMove(
    documents.map((bucket, index) => ({ ...bucket, _id: `old-${index}` })),
    movedDocuments
  );
  assert.equal(movePlan.newOnly.length, 6);
  assert.equal(movePlan.oldOnly.length, 6);
  const overlappingMove = planBucketMove(
    documents.map((bucket, index) => ({ ...bucket, _id: `old-${index}` })),
    bucketDocuments({
      technicianId: "tech-1",
      reservationId: "reservation-1",
      bookingId: "booking-1",
      slotStart: new Date("2026-07-01T14:30:00Z"),
      slotEnd: new Date("2026-07-01T16:00:00Z"),
      status: "reserved",
    })
  );
  assert.equal(overlappingMove.newOnly.length, 2);
  assert.equal(overlappingMove.oldOnly.length, 2);
  const order = [];
  await applyBucketMove({
    oldBuckets: documents.map((bucket, index) => ({
      ...bucket,
      _id: `sequence-old-${index}`,
    })),
    desiredDocuments: movedDocuments,
    session: {},
    BucketModel: {
      async insertMany() {
        order.push("insert-new");
      },
      deleteMany() {
        return {
          async session() {
            order.push("delete-old");
          },
        };
      },
    },
  });
  assert.deepEqual(order, ["insert-new", "delete-old"]);
  const conflictOrder = [];
  await assert.rejects(
    applyBucketMove({
      oldBuckets: documents.map((bucket, index) => ({
        ...bucket,
        _id: `conflict-old-${index}`,
      })),
      desiredDocuments: movedDocuments,
      session: {},
      BucketModel: {
        async insertMany() {
          conflictOrder.push("insert-new");
          const error = new Error("duplicate bucket");
          error.code = 11000;
          throw error;
        },
        deleteMany() {
          return {
            async session() {
              conflictOrder.push("delete-old");
            },
          };
        },
      },
    }),
    (error) => error.code === "SLOT_CONFLICT"
  );
  assert.deepEqual(conflictOrder, ["insert-new"]);

  const reservation = {
    _id: "reservation-1",
    bookingId: "booking-1",
    technicianId: "tech-1",
    status: "reserved",
    slotStart: new Date("2026-07-01T14:00:00Z"),
    slotEnd: new Date("2026-07-01T15:30:00Z"),
  };
  const buckets = documents.slice(0, 5).map((bucket, index) => ({
    ...bucket,
    _id: `bucket-${index}`,
  }));
  buckets.push({
    _id: "orphan-bucket",
    technicianId: "tech-2",
    reservationId: "missing-reservation",
    bookingId: "booking-2",
    bucketStart: new Date("2026-07-01T16:00:00Z"),
    bucketEnd: new Date("2026-07-01T16:15:00Z"),
    status: "reserved",
  });
  buckets.push({
    ...buckets[0],
    _id: "duplicate-key-bucket",
    reservationId: "missing-reservation-2",
  });
  buckets.push({
    ...documents[5],
    _id: "mismatched-bucket",
    technicianId: "wrong-technician",
    bucketStart: new Date("2026-07-01T16:15:00Z"),
    bucketEnd: new Date("2026-07-01T16:30:00Z"),
  });
  const audit = analyzeReservationBucketAudit({
    bookings: [{ _id: "booking-1", status: "Pending" }],
    reservations: [reservation],
    buckets,
  });
  assert.equal(audit.reservationBucketsMissing.length, 1);
  assert.deepEqual(
    new Set(audit.bucketWithoutReservation),
    new Set(["orphan-bucket", "duplicate-key-bucket"])
  );
  assert.deepEqual(audit.bucketReservationMismatch, ["mismatched-bucket"]);
  assert.equal(audit.duplicateBucketKeys.length, 1);

  const releasedAudit = analyzeReservationBucketAudit({
    bookings: [{ _id: "booking-1", status: "Canceled" }],
    reservations: [{ ...reservation, status: "released" }],
    buckets: documents.map((bucket, index) => ({
      ...bucket,
      _id: `stale-${index}`,
    })),
  });
  assert.equal(releasedAudit.staleBuckets.length, 6);

  const overlapWithoutLocks = analyzeReservationBucketAudit({
    bookings: [
      { _id: "booking-a", status: "Pending" },
      { _id: "booking-b", status: "Pending" },
    ],
    reservations: [
      {
        ...reservation,
        _id: "reservation-a",
        bookingId: "booking-a",
      },
      {
        ...reservation,
        _id: "reservation-b",
        bookingId: "booking-b",
        slotStart: new Date("2026-07-01T14:30:00Z"),
        slotEnd: new Date("2026-07-01T16:00:00Z"),
      },
    ],
    buckets: [
      {
        _id: "lock-a",
        technicianId: "tech-1",
        reservationId: "reservation-a",
        bookingId: "booking-a",
        bucketStart: new Date("2026-07-01T14:00:00Z"),
        bucketEnd: new Date("2026-07-01T14:15:00Z"),
        status: "reserved",
      },
      {
        _id: "lock-b",
        technicianId: "tech-1",
        reservationId: "reservation-b",
        bookingId: "booking-b",
        bucketStart: new Date("2026-07-01T15:45:00Z"),
        bucketEnd: new Date("2026-07-01T16:00:00Z"),
        status: "reserved",
      },
    ],
  });
  assert.equal(
    overlapWithoutLocks.overlapsNotReflectedInBuckets.length,
    1
  );

  console.log("Reservation bucket tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
