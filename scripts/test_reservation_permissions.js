const assert = require("node:assert/strict");
const {
  PERMISSIONS,
  permissionsForUser,
} = require("../middleware/authorize");
const router = require("../routes/adminBookingReservations");

const admin = permissionsForUser({ role: "admin", email: "admin@example.com" });
const general = permissionsForUser({
  role: "employee",
  employeePosition: "General Fixter",
});
const fixter = permissionsForUser({
  role: "employee",
  employeePosition: "Fixter",
});
const customer = permissionsForUser({ role: "customer" });

assert(admin.includes(PERMISSIONS.BOOKINGS_ASSIGN));
assert(general.includes(PERMISSIONS.BOOKINGS_ASSIGN));
assert(!fixter.includes(PERMISSIONS.BOOKINGS_ASSIGN));
assert(!customer.includes(PERMISSIONS.BOOKINGS_ASSIGN));

const routes = router.stack
  .filter((layer) => layer.route)
  .map((layer) => ({
    path: layer.route.path,
    method: Object.keys(layer.route.methods)[0],
    handlers: layer.route.stack.length,
  }));
assert(
  routes.some(
    (route) =>
      route.path === "/bookings/:id/assignment-options" &&
      route.method === "get" &&
      route.handlers === 4
  )
);
assert(
  routes.some(
    (route) =>
      route.path === "/bookings/:id/reservation/reassign" &&
      route.method === "post" &&
      route.handlers === 4
  )
);
assert(
  routes.some(
    (route) =>
      route.path === "/bookings/:id/reservation/release" &&
      route.method === "post" &&
      route.handlers === 4
  )
);

console.log("Reservation permission smoke tests passed");
