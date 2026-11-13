/**
 * The assignment fields for a booking when the reservation engine is off
 * (the engine writes them itself through moveReservationForBooking).
 * `null` / "" clears the assignment; anything else must be an active Fixter.
 */
const User = require("../../models/User");

async function resolveAssignmentFields(assignedFixterId) {
  if (assignedFixterId === "" || assignedFixterId === null || assignedFixterId === undefined) {
    return { assignedFixterId: null, assignedFixterName: "", assignedFixterEmail: "", assignedFixterPosition: "" };
  }
  const fixter = await User.findOne({
    _id: assignedFixterId,
    role: "employee",
    isActive: true,
    employeePosition: { $in: ["Fixter", "General Fixter"] },
  }).lean();
  if (!fixter) {
    const error = new Error("Assigned employee is invalid or inactive");
    error.statusCode = 400;
    error.code = "TECHNICIAN_UNAVAILABLE";
    throw error;
  }
  return {
    assignedFixterId: fixter._id,
    assignedFixterName: fixter.name,
    assignedFixterEmail: fixter.email,
    assignedFixterPosition: fixter.employeePosition,
  };
}

module.exports = { resolveAssignmentFields };
