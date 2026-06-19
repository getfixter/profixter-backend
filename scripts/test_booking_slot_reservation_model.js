const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const BookingSlotReservation = require("../models/BookingSlotReservation");
const BookingHistory = require("../models/BookingHistory");

async function run() {
  const bookingId = new mongoose.Types.ObjectId();
  const technicianId = new mongoose.Types.ObjectId();
  const slotStart = new Date("2026-07-01T14:00:00Z");
  const valid = new BookingSlotReservation({
    bookingId,
    technicianId,
    slotStart,
    slotEnd: new Date(slotStart.getTime() + 90 * 60 * 1000),
    status: "reserved",
    createdByType: "system",
  });
  await valid.validate();

  const invalidDuration = new BookingSlotReservation({
    bookingId,
    technicianId,
    slotStart,
    slotEnd: new Date(slotStart.getTime() + 60 * 60 * 1000),
    status: "reserved",
    createdByType: "system",
  });
  await assert.rejects(invalidDuration.validate(), /exactly 90 minutes/);

  const invalidHold = new BookingSlotReservation({
    bookingId,
    technicianId,
    slotStart,
    slotEnd: new Date(slotStart.getTime() + 90 * 60 * 1000),
    status: "held",
    createdByType: "customer",
  });
  await assert.rejects(invalidHold.validate(), /holdExpiresAt/);

  const indexes = BookingSlotReservation.schema.indexes();
  assert(
    indexes.some(
      ([fields, options]) =>
        fields.bookingId === 1 &&
        options.unique &&
        options.name === "one_active_reservation_per_booking"
    )
  );
  assert(
    indexes.some(
      ([fields, options]) =>
        fields.technicianId === 1 &&
        fields.slotStart === 1 &&
        options.unique &&
        options.name === "one_active_reservation_per_technician_start"
    )
  );
  const historyActions =
    BookingHistory.schema.path("actionType").options.enum || [];
  for (const action of [
    "reservation_created",
    "reservation_released",
    "reservation_moved",
    "reservation_backfilled",
    "reservation_conflict",
  ]) {
    assert(historyActions.includes(action), `Missing history action ${action}`);
  }
  console.log("BookingSlotReservation model tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
