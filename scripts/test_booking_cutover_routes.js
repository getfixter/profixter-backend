const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const calendarRouter = require("../routes/calendar");
const reservationRouter = require("../routes/adminBookingReservations");
const {
  PERMISSIONS,
  permissionsForUser,
} = require("../middleware/authorize");

const calendarRoutes = calendarRouter.stack
  .filter((layer) => layer.route)
  .map((layer) => ({
    path: layer.route.path,
    methods: layer.route.methods,
  }));
assert(
  calendarRoutes.some(
    (route) => route.path === "/month" && route.methods.get
  )
);
assert(
  calendarRoutes.some(
    (route) => route.path === "/slots" && route.methods.get
  )
);

const adminRoutes = reservationRouter.stack
  .filter((layer) => layer.route)
  .map((layer) => layer.route.path);
assert(adminRoutes.includes("/bookings/:id/assignment-options"));
assert(adminRoutes.includes("/bookings/:id/reservation/reassign"));
assert(adminRoutes.includes("/bookings/:id/reservation/release"));

const general = permissionsForUser({
  role: "employee",
  employeePosition: "General Fixter",
});
const fixter = permissionsForUser({
  role: "employee",
  employeePosition: "Fixter",
});
assert(general.includes(PERMISSIONS.BOOKINGS_ASSIGN));
assert(!fixter.includes(PERMISSIONS.BOOKINGS_ASSIGN));

const bookingsSource = fs.readFileSync(
  path.join(__dirname, "../routes/bookings.js"),
  "utf8"
);
assert.match(bookingsSource, /reservationEngineEnabled\(\)/);
assert.match(bookingsSource, /createBookingWithReservation/);
assert.match(bookingsSource, /cancelBookingWithReservation/);
assert.match(bookingsSource, /SLOT_UNAVAILABLE/);
assert.match(
  bookingsSource,
  /-assignedFixterId -assignedFixterName -assignedFixterEmail/
);

const adminSource = fs.readFileSync(
  path.join(__dirname, "../routes/admin.js"),
  "utf8"
);
assert.match(adminSource, /cancelBookingWithReservation/);
assert.match(adminSource, /moveReservationForBooking/);

console.log("Booking cutover route tests passed");
