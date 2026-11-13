/**
 * Who may use Charge customer (both entry points: a booking and a customer
 * profile). One rule, used by the routes, the service, the job sheet's
 * allowedActions and the customer profile's allowedActions:
 *
 *   Owner           accessRole "admin"                                   allowed
 *   General Fixter  role "employee", employeePosition "General Fixter",  allowed
 *                   active (loadAccessUser already refuses inactive ones)
 *   Fixter (field)  employeePosition "Fixter"                            denied
 *   anyone else     (customers, employees with only custom sections)     denied
 *
 * This is a charge-only rule: it grants nothing else (no membership, refund,
 * customer-edit or customer-list rights). Which bookings and customers a
 * General Fixter can open is decided by their existing permissions
 * (bookings.assign, members.read), unchanged.
 */
const CHARGE_POSITIONS = Object.freeze(["General Fixter"]);

function chargeRoleOf(req) {
  if (req?.accessRole === "admin") return "owner";
  const u = req?.accessUser || null;
  if (req?.accessRole === "employee" && u && u.isActive !== false && CHARGE_POSITIONS.includes(String(u.employeePosition || ""))) return "general_fixter";
  return null;
}

const canChargeCustomers = (req) => Boolean(chargeRoleOf(req));

const DENIED = { code: "CHARGE_NOT_ALLOWED", message: "Only the owner or a General Fixter can charge customers." };

module.exports = { CHARGE_POSITIONS, DENIED, canChargeCustomers, chargeRoleOf };
