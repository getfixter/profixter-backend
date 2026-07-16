const assert = require("node:assert/strict");
const {
  customerDayAvailability,
  customerMonthAvailability,
} = require("../utils/customerCalendarService");
const {
  cancelBookingWithReservation,
  createBookingWithReservation,
  createCapacityBuckets,
  reservationEngineEnabled,
} = require("../utils/slotReservationService");

function queryResult(value) {
  return {
    async session() {
      return value;
    },
  };
}

async function run() {
  const previousFlag = process.env.ENABLE_RESERVATION_ENGINE;
  delete process.env.ENABLE_RESERVATION_ENGINE;
  assert.equal(reservationEngineEnabled(), false);
  process.env.ENABLE_RESERVATION_ENGINE = "true";
  assert.equal(reservationEngineEnabled(), true);
  if (previousFlag === undefined) delete process.env.ENABLE_RESERVATION_ENGINE;
  else process.env.ENABLE_RESERVATION_ENGINE = previousFlag;

  const customerDay = await customerDayAvailability({
    date: "2026-07-01",
    now: new Date("2026-06-01T12:00:00Z"),
    dependencies: {
      calculateDayAvailability: async () => ({
        timezone: "America/New_York",
        slots: [{
          time: "10:00",
          configuredCapacity: 2,
          usedCapacity: 0,
          open: true,
          technicians: [
            { id: "tech-1", name: "Roman", available: true },
            { id: "tech-2", name: "Alex", available: true },
          ],
        }],
      }),
      ReservationModel: {
        find() {
          return {
            async lean() {
              return [{
                technicianId: "tech-1",
                status: "reserved",
                slotStart: new Date("2026-07-01T14:00:00Z"),
                slotEnd: new Date("2026-07-01T15:30:00Z"),
              }];
            },
          };
        },
      },
    },
  });
  assert.deepEqual(customerDay.slots, ["10:00"]);
  assert.equal(customerDay.available, true);
  assert.equal(customerDay.availableSlotCount, 1);
  assert.equal(customerDay.remaining["10:00"], 1);
  assert.equal(JSON.stringify(customerDay).includes("Roman"), false);

  let contextLoads = 0;
  const month = await customerMonthAvailability({
    month: "2026-07",
    now: new Date("2026-06-01T12:00:00Z"),
    dependencies: {
      loadAvailabilityContext: async () => {
        contextLoads += 1;
        return { timezone: "America/New_York" };
      },
      calculateDayFromContext: ({ date }) => ({
        date,
        timezone: "America/New_York",
        slots: [{
          time: "10:00",
          configuredCapacity: 1,
          usedCapacity: 0,
          open: true,
          technicians: [{ id: "tech-1", available: true, booked: false }],
        }],
      }),
      ReservationModel: {
        find() {
          return { async lean() { return []; } };
        },
      },
    },
  });
  assert.equal(contextLoads, 1);
  assert.equal(month.days.length, 31);
  assert.deepEqual(month.days[0].slots, ["10:00"]);
  assert.equal(month.days[0].available, true);
  assert.equal(month.days[0].availableSlotCount, 1);

  const state = {
    booking: null,
    reservation: null,
    technicianBuckets: [],
    capacityBuckets: [],
    history: [],
  };
  const bookingId = "507f1f77bcf86cd799439011";
  const reservationId = "507f1f77bcf86cd799439012";
  const session = {};
  const created = await createBookingWithReservation({
    bookingData: {
      bookingNumber: "12345678",
      service: "Labor Only",
      user: "507f1f77bcf86cd799439013",
      userId: "U1",
      name: "Customer",
      address: "1 Main St",
      phone: "555",
      email: "customer@example.com",
      subscription: "Basic",
      note: "Fix a door",
      status: "Pending",
    },
    slotStart: new Date("2026-07-01T14:00:00Z"),
    dependencies: {
      findEligibleTechnicians: async () => ({
        recommended: { id: "tech-1" },
      }),
      UserModel: {
        findOne() {
          return {
            async lean() {
              return {
                _id: "tech-1",
                name: "Roman",
                email: "roman@example.com",
                employeePosition: "Fixter",
              };
            },
          };
        },
      },
      availabilityForTechnician: async () => ({
        available: true,
        slot: { totalCapacity: 2 },
      }),
      runReservationTransaction: async (operation) => operation(session),
      releaseExpiredHolds: async () => 0,
      BookingModel: {
        async create([data]) {
          const booking = {
            ...data,
            _id: bookingId,
            async save() {
              state.booking = this;
            },
          };
          state.booking = booking;
          return [booking];
        },
      },
      ReservationModel: {
        async create([data]) {
          const reservation = {
            ...data,
            _id: reservationId,
          };
          state.reservation = reservation;
          return [reservation];
        },
      },
      BucketModel: {
        async insertMany(rows) {
          state.technicianBuckets.push(...rows);
        },
      },
      CapacityBucketModel: {
        find() {
          return {
            session() {
              return { async lean() { return []; } };
            },
          };
        },
        async insertMany(rows) {
          state.capacityBuckets.push(...rows);
        },
      },
      logBookingCreated: async () => state.history.push("booking_created"),
      logReservationAction: async () =>
        state.history.push("reservation_created"),
    },
  });
  assert.equal(created.booking.slotReservationId, reservationId);
  assert.equal(state.technicianBuckets.length, 6);
  assert.equal(state.capacityBuckets.length, 6);
  assert.deepEqual(state.history, [
    "booking_created",
    "reservation_created",
  ]);

  const rollbackState = {
    bookings: [],
    reservations: [],
    technicianBuckets: [],
    capacityBuckets: [],
  };
  const transactionRunner = async (operation) => {
    const snapshot = structuredClone(rollbackState);
    try {
      return await operation({});
    } catch (error) {
      Object.assign(rollbackState, snapshot);
      throw error;
    }
  };
  await assert.rejects(
    createBookingWithReservation({
      bookingData: {
        bookingNumber: "87654321",
        service: "Labor Only",
        user: "507f1f77bcf86cd799439013",
        userId: "U1",
        name: "Customer",
        address: "1 Main St",
        phone: "555",
        email: "customer@example.com",
        subscription: "Basic",
        note: "Fix a door",
        status: "Pending",
      },
      slotStart: new Date("2026-07-01T17:00:00Z"),
      dependencies: {
        findEligibleTechnicians: async () => ({
          recommended: { id: "tech-1" },
        }),
        UserModel: {
          findOne() {
            return {
              async lean() {
                return {
                  _id: "tech-1",
                  name: "Roman",
                  email: "roman@example.com",
                  employeePosition: "Fixter",
                };
              },
            };
          },
        },
        availabilityForTechnician: async () => ({
          available: true,
          slot: { totalCapacity: 1 },
        }),
        runReservationTransaction: transactionRunner,
        releaseExpiredHolds: async () => 0,
        BookingModel: {
          async create([data]) {
            const booking = {
              ...data,
              _id: bookingId,
              async save() {},
            };
            rollbackState.bookings.push(bookingId);
            return [booking];
          },
        },
        ReservationModel: {
          async create([data]) {
            rollbackState.reservations.push(reservationId);
            return [{ ...data, _id: reservationId }];
          },
        },
        BucketModel: {
          async insertMany(rows) {
            rollbackState.technicianBuckets.push(...rows);
          },
        },
        CapacityBucketModel: {
          find() {
            return {
              session() {
                return { async lean() { return []; } };
              },
            };
          },
          async insertMany(rows) {
            rollbackState.capacityBuckets.push(...rows);
          },
        },
        logBookingCreated: async () => {},
        logReservationAction: async () => {
          throw new Error("history write failed");
        },
      },
    }),
    /history write failed/
  );
  assert.deepEqual(rollbackState, {
    bookings: [],
    reservations: [],
    technicianBuckets: [],
    capacityBuckets: [],
  });

  await assert.rejects(
    createCapacityBuckets({
      reservation: state.reservation,
      capacity: 1,
      session,
      CapacityBucketModel: {
        find() {
          return {
            session() {
              return {
                async lean() {
                  return state.capacityBuckets;
                },
              };
            },
          };
        },
      },
    }),
    (error) => error.code === "SLOT_UNAVAILABLE"
  );
  await assert.rejects(
    createCapacityBuckets({
      reservation: state.reservation,
      capacity: 1,
      usedCapacity: 1,
      session,
      CapacityBucketModel: {
        find() {
          return {
            session() {
              return { async lean() { return []; } };
            },
          };
        },
      },
    }),
    (error) => error.code === "SLOT_UNAVAILABLE"
  );
  await assert.rejects(
    createCapacityBuckets({
      reservation: {
        ...state.reservation,
        _id: "507f1f77bcf86cd799439099",
        slotStart: new Date("2026-07-01T14:30:00Z"),
        slotEnd: new Date("2026-07-01T16:00:00Z"),
      },
      capacity: 1,
      session,
      CapacityBucketModel: {
        find() {
          return {
            session() {
              return {
                async lean() {
                  return state.capacityBuckets.filter(
                    (entry) =>
                      new Date(entry.bucketStart) >=
                        new Date("2026-07-01T14:30:00Z") &&
                      new Date(entry.bucketStart) <
                        new Date("2026-07-01T16:00:00Z")
                  );
                },
              };
            },
          };
        },
      },
    }),
    (error) => error.code === "SLOT_UNAVAILABLE"
  );

  const cancelState = {
    booking: {
      ...state.booking,
      statusHistory: [],
      async save() {},
    },
    reservation: {
      ...state.reservation,
      status: "reserved",
      async save() {},
    },
    deletedTechnician: false,
    deletedCapacity: false,
    history: [],
  };
  const canceled = await cancelBookingWithReservation({
    bookingId,
    dependencies: {
      runReservationTransaction: async (operation) => operation(session),
      BookingModel: {
        findById() {
          return queryResult(cancelState.booking);
        },
      },
      ReservationModel: {
        findOne() {
          return queryResult(cancelState.reservation);
        },
      },
      BucketModel: {
        deleteMany() {
          return {
            async session() {
              cancelState.deletedTechnician = true;
            },
          };
        },
      },
      CapacityBucketModel: {
        deleteMany() {
          return {
            async session() {
              cancelState.deletedCapacity = true;
            },
          };
        },
      },
      logBookingChanges: async () => cancelState.history.push("canceled"),
      logReservationAction: async () => cancelState.history.push("released"),
    },
  });
  assert.equal(canceled.booking.status, "Canceled");
  assert.equal(canceled.reservation.status, "released");
  assert.equal(cancelState.deletedTechnician, true);
  assert.equal(cancelState.deletedCapacity, true);
  assert.deepEqual(cancelState.history, ["canceled", "released"]);

  console.log("Customer booking cutover tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
