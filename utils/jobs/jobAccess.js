/**
 * Record-level access to bookings ("jobs") for Admin staff.
 *
 * Owner decision Q-1 (2026-11-12): a field Fixter - an employee whose field
 * work is "Fixter" and who has not been granted the Jobs section (which is
 * what carries bookings.assign) - may only list, read and act on the bookings
 * assigned to them. The rule is enforced here, on the server, for every
 * booking read and write; a client flag such as ?assigned=me can narrow a
 * wider caller's view but can never widen a scoped caller's.
 *
 * Who is scoped is decided by permission, not by title, so the registry in
 * utils/adminAccess.js stays the one place that says who may do what:
 *   - the owner                        -> every booking
 *   - holds bookings.assign            -> every booking (General Fixter, Jobs section)
 *   - holds bookings.read without it   -> only bookings whose assignedFixterId is them
 */
const mongoose = require("mongoose");
const { PERMISSIONS } = require("../adminAccess");

function hasPerm(req, permission) {
  return req?.accessRole === "admin" || (req?.permissions || []).includes(permission);
}

/** True when the caller sees and acts on every booking. */
function canSeeAllJobs(req) {
  return hasPerm(req, PERMISSIONS.BOOKINGS_ASSIGN);
}

function callerId(req) {
  return req?.accessUser?._id || null;
}

/**
 * The Mongo filter that limits a booking query to what the caller may see.
 * `{}` for a wider caller; `{ assignedFixterId: me }` for a scoped one.
 */
function jobScopeFilter(req) {
  if (canSeeAllJobs(req)) return {};
  const id = callerId(req);
  // No id means no identity to scope to: match nothing rather than everything.
  return { assignedFixterId: id || new mongoose.Types.ObjectId() };
}

/** Whether this booking (lean or document) is inside the caller's scope. */
function canAccessJob(req, booking) {
  if (!booking) return false;
  if (canSeeAllJobs(req)) return true;
  const id = callerId(req);
  return Boolean(id && booking.assignedFixterId && String(booking.assignedFixterId) === String(id));
}

class JobAccessError extends Error {
  constructor(code, message, statusCode) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function forbiddenRecord() {
  return new JobAccessError("FORBIDDEN_RECORD", "This job is not assigned to you.", 403);
}

/** Throw 403 FORBIDDEN_RECORD unless the caller may see this booking. */
function assertJobAccess(req, booking) {
  if (!canAccessJob(req, booking)) throw forbiddenRecord();
}

/** The response for a scope denial, in the shared error shape. */
function sendForbiddenRecord(res) {
  return res.status(403).json({ code: "FORBIDDEN_RECORD", message: "This job is not assigned to you." });
}

module.exports = {
  JobAccessError,
  assertJobAccess,
  canAccessJob,
  canSeeAllJobs,
  forbiddenRecord,
  hasPerm,
  jobScopeFilter,
  sendForbiddenRecord,
};
