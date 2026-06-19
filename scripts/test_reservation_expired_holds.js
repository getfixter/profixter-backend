const assert = require("node:assert/strict");
const {
  analyzeReservationAudit,
  analyzeReservationBucketAudit,
  blockingReservationFilter,
  findEligibleTechnicians,
  releaseExpiredHolds,
  reservationBlocksAvailability,
} = require("../utils/slotReservationService");

const now = new Date("2026-07-01T13:00:00Z");
const slotStart = new Date("2026-07-01T14:00:00Z");
const slotEnd = new Date("2026-07-01T15:30:00Z");

function reservation(status, holdExpiresAt = null) {
  return {
    _id: `${status}-${holdExpiresAt || "none"}`,
    bookingId: "booking-old",
    technicianId: "tech-1",
    status,
    holdExpiresAt,
    slotStart,
    slotEnd,
  };
}

function matchesBlockingState(entry) {
  return reservationBlocksAvailability(entry, now);
}

async function eligibilityWith(existingReservation) {
  return findEligibleTechnicians({
    slotStart,
    dependencies: {
      UserModel: {
        find() {
          return {
            select() {
              return {
                async lean() {
                  return [{
                    _id: "tech-1",
                    name: "Roman",
                    email: "roman@example.com",
                    employeePosition: "Fixter",
                    isDefaultFixter: true,
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
        available: true,
        reason: "",
      }),
      technicianOverlap: async () =>
        existingReservation && matchesBlockingState(existingReservation)
          ? existingReservation
          : null,
    },
  });
}

async function run() {
  const expiredHold = reservation(
    "held",
    new Date(now.getTime() - 60 * 1000)
  );
  const liveHold = reservation(
    "held",
    new Date(now.getTime() + 60 * 1000)
  );
  const missingExpiryHold = reservation("held");
  const reserved = reservation("reserved");
  const released = reservation("released");

  assert.equal(reservationBlocksAvailability(expiredHold, now), false);
  assert.equal(reservationBlocksAvailability(liveHold, now), true);
  assert.equal(reservationBlocksAvailability(missingExpiryHold, now), true);
  assert.equal(reservationBlocksAvailability(reserved, now), true);
  assert.equal(reservationBlocksAvailability(released, now), false);

  const filter = blockingReservationFilter(now);
  assert.equal(filter.$or[0].status, "reserved");
  assert.equal(filter.$or[1].status, "held");
  assert.deepEqual(filter.$or[1].$or[0], { holdExpiresAt: null });
  assert.deepEqual(filter.$or[1].$or[1], {
    holdExpiresAt: { $gt: now },
  });

  const expiredOptions = await eligibilityWith(expiredHold);
  assert.equal(expiredOptions.recommended.id, "tech-1");

  const liveOptions = await eligibilityWith(liveHold);
  assert.equal(liveOptions.recommended, null);

  const reservedOptions = await eligibilityWith(reserved);
  assert.equal(reservedOptions.recommended, null);

  const releasedOptions = await eligibilityWith(released);
  assert.equal(releasedOptions.recommended.id, "tech-1");

  const state = {
    reservations: [expiredHold],
    buckets: [{ reservationId: expiredHold._id }],
    booking: {
      _id: "booking-old",
      slotReservationId: expiredHold._id,
      assignedFixterId: "tech-1",
      assignedFixterName: "Roman",
      assignedFixterEmail: "roman@example.com",
      assignedFixterPosition: "Fixter",
      scheduledStart: slotStart,
      scheduledEnd: slotEnd,
      assignmentSource: "automatic",
      async save() {},
    },
    history: [],
    created: false,
  };
  const selected = expiredOptions.recommended;
  assert(selected, "automatic selection must pass an expired hold");
  const cleaned = await releaseExpiredHolds({}, now, {
    ReservationModel: {
      find() {
        return {
          async session() {
            return state.reservations.filter(
              (entry) =>
                entry.status === "held" &&
                entry.holdExpiresAt <= now
            );
          },
        };
      },
      async updateMany() {
        state.reservations = state.reservations.map((entry) => ({
          ...entry,
          status: "released",
          releasedAt: now,
          releaseReason: "Hold expired",
        }));
      },
    },
    BucketModel: {
      deleteMany() {
        return {
          async session() {
            state.buckets = [];
          },
        };
      },
    },
    BookingModel: {
      find() {
        return {
          async session() {
            return [state.booking];
          },
        };
      },
    },
    logReservationAction: async (entry) => {
      state.history.push(entry);
    },
  });
  assert.equal(cleaned, 1);
  assert.equal(state.reservations[0].status, "released");
  assert.equal(state.booking.slotReservationId, null);
  assert.equal(state.history.length, 1);

  state.reservations.push(reservation("reserved"));
  state.created = true;
  assert.equal(state.created, true);
  assert.equal(state.buckets.length, 0);
  assert.equal(
    state.reservations.filter((entry) =>
      reservationBlocksAvailability(entry, now)
    ).length,
    1
  );

  const audit = analyzeReservationAudit({
    bookings: [{ _id: "booking-old", status: "Pending" }],
    reservations: [expiredHold],
    now,
  });
  assert.equal(audit.staleExpiredHolds.length, 1);
  assert.equal(audit.staleExpiredHolds[0].actionNeeded, "release");
  assert.equal(audit.activeReservations.length, 0);

  const bucketAudit = analyzeReservationBucketAudit({
    bookings: [{ _id: "booking-old", status: "Pending" }],
    reservations: [expiredHold],
    buckets: [{
      _id: "expired-bucket",
      technicianId: "tech-1",
      reservationId: expiredHold._id,
      bookingId: "booking-old",
      bucketStart: slotStart,
      bucketEnd: new Date(slotStart.getTime() + 15 * 60 * 1000),
      status: "held",
      expiresAt: expiredHold.holdExpiresAt,
    }],
    now,
  });
  assert.deepEqual(bucketAudit.staleBuckets, ["expired-bucket"]);

  console.log("Reservation expired-hold regression tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
