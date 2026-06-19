require("dotenv").config();
const mongoose = require("mongoose");
const {
  analyzeReservationAudit,
  auditReservationConflicts,
} = require("../utils/slotReservationService");

async function run() {
  if (process.argv.includes("--smoke")) {
    const report = analyzeReservationAudit({
      bookings: [{ _id: "booking-1" }],
      reservations: [
        {
          _id: "reservation-1",
          bookingId: "booking-1",
          technicianId: "technician-1",
          status: "reserved",
          slotStart: new Date("2026-07-01T14:00:00Z"),
          slotEnd: new Date("2026-07-01T15:30:00Z"),
        },
        {
          _id: "reservation-2",
          bookingId: "booking-1",
          technicianId: "technician-1",
          status: "held",
          slotStart: new Date("2026-07-01T15:00:00Z"),
          slotEnd: new Date("2026-07-01T16:30:00Z"),
        },
      ],
    });
    if (
      report.activeByBooking.get("booking-1")?.length !== 2 ||
      report.technicianOverlaps.length !== 1
    ) {
      throw new Error("Reservation audit smoke test failed");
    }
    console.log("Reservation audit smoke test passed");
    return;
  }
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required");
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false });
  const report = await auditReservationConflicts();
  console.log(JSON.stringify(report, null, 2));
}

run()
  .catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
