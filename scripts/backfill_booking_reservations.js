require("dotenv").config();
const mongoose = require("mongoose");
const {
  backfillReservationsForFutureBookings,
} = require("../utils/slotReservationService");

async function run() {
  if (process.argv.includes("--smoke")) {
    let writes = 0;
    const report = await backfillReservationsForFutureBookings({
      write: false,
      dependencies: {
        BookingModel: {
          find: () => ({
            sort: async () => [
              {
                _id: "smoke-booking",
                date: new Date(Date.now() + 86400000),
                assignedFixterId: null,
              },
            ],
          }),
        },
        activeReservationForBooking: async () => null,
        findEligibleTechnicians: async () => ({
          available: [{ id: "smoke-technician" }],
          recommended: { id: "smoke-technician" },
        }),
        reserveSlotForBooking: async () => {
          writes += 1;
        },
      },
    });
    if (writes !== 0 || report.created !== 0 || report.canReserve !== 1) {
      throw new Error("Backfill dry-run smoke test failed");
    }
    console.log("Backfill dry-run smoke test passed");
    return;
  }
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required");
  const write = process.argv.includes("--write");
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false });
  const report = await backfillReservationsForFutureBookings({ write });
  console.log(JSON.stringify(report, null, 2));
}

run()
  .catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
