const assert = require("node:assert/strict");
const {
  canCustomerAddAppointmentDetails,
  appendPublicNote,
  appendContentUpdate,
} = require("../utils/bookingContentUpdates");

const now = new Date("2026-07-08T12:00:00.000Z");

assert.equal(
  canCustomerAddAppointmentDetails(
    { status: "Pending", date: "2026-07-11T13:00:00.000Z" },
    now
  ).allowed,
  true
);

assert.equal(
  canCustomerAddAppointmentDetails(
    { status: "Confirmed", scheduledStart: "2026-07-10T13:00:01.000Z" },
    now
  ).allowed,
  true
);

assert.equal(
  canCustomerAddAppointmentDetails(
    { status: "Confirmed", date: "2026-07-10T11:59:59.000Z" },
    now
  ).message,
  "Appointment can only be updated more than 48 hours before the visit."
);

assert.equal(
  canCustomerAddAppointmentDetails(
    { status: "Completed", date: "2026-07-12T12:00:00.000Z" },
    now
  ).message,
  "Only pending or confirmed appointments can be updated."
);

const booking = {
  note: "Original note",
  images: ["https://example.com/old.jpg"],
  contentUpdates: [],
};
appendPublicNote(booking, "Bring ladder", {
  source: "customer",
  actorName: "Ava",
  at: now,
});
assert.match(booking.note, /Original note/);
assert.match(booking.note, /Customer added by Ava/);
assert.match(booking.note, /Bring ladder/);

appendContentUpdate(booking, {
  actor: {
    actorUserId: null,
    actorName: "Ava",
    actorEmail: "avasarafina@gmail.com",
    actorRole: "customer",
  },
  source: "customer",
  noteAdded: "Bring ladder",
  imagesAdded: ["https://example.com/new.jpg"],
});
booking.images = booking.images.concat(["https://example.com/new.jpg"]);

assert.deepEqual(booking.images, [
  "https://example.com/old.jpg",
  "https://example.com/new.jpg",
]);
assert.equal(booking.contentUpdates.length, 1);
assert.equal(booking.contentUpdates[0].source, "customer");
assert.equal(booking.contentUpdates[0].noteAdded, "Bring ladder");

console.log("Booking content update tests passed");
