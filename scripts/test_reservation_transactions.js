const assert = require("node:assert/strict");
const {
  runReservationTransaction,
} = require("../utils/reservationTransaction");

function transactionalHarness(initial) {
  const state = structuredClone(initial);
  const session = {
    async withTransaction(operation) {
      const snapshot = structuredClone(state);
      try {
        await operation();
      } catch (error) {
        Object.keys(state).forEach((key) => delete state[key]);
        Object.assign(state, snapshot);
        throw error;
      }
    },
    async endSession() {},
  };
  return {
    state,
    mongooseInstance: {
      async startSession() {
        return session;
      },
    },
  };
}

async function run() {
  for (const failedStep of ["booking", "history"]) {
    const harness = transactionalHarness({
      reservation: null,
      buckets: [],
      bookingAssigned: false,
      history: [],
    });
    await assert.rejects(
      runReservationTransaction(
        async () => {
          harness.state.reservation = "created";
          harness.state.buckets.push("10:00");
          if (failedStep === "booking") throw new Error("booking update failed");
          harness.state.bookingAssigned = true;
          if (failedStep === "history") throw new Error("history write failed");
          harness.state.history.push("reservation_created");
        },
        { mongooseInstance: harness.mongooseInstance }
      ),
      new RegExp(`${failedStep} .*failed`)
    );
    assert.deepEqual(harness.state, {
      reservation: null,
      buckets: [],
      bookingAssigned: false,
      history: [],
    });
  }

  let warning = "";
  const unsupported = new Error(
    "Transaction numbers are only allowed on a replica set member or mongos"
  );
  unsupported.code = 20;
  const unsupportedHarness = {
    async startSession() {
      return {
        async withTransaction() {
          throw unsupported;
        },
        async endSession() {},
      };
    },
  };
  await assert.rejects(
    runReservationTransaction(async () => {}, {
      mongooseInstance: unsupportedHarness,
      logger: { warn: (message) => (warning = message) },
    }),
    (error) => error.code === "TRANSACTIONS_UNAVAILABLE"
  );
  assert.match(warning, /No non-transaction fallback/);

  console.log("Reservation transaction tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
