/**
 * Needs action - jobs: requests to review, upcoming unassigned jobs, Confirmed
 * jobs more than 2 hours past their start and not closed (FIXTER_CLOSE_LAG_MS),
 * payment problems and reservation issues.
 *
 * The query is needsActionFilter in utils/jobs/jobQueries, the same one the
 * Jobs list's needs_action view and its needsAction count use, so the three
 * numbers are always equal. Scoped like every job read: a field Fixter sees
 * only their own jobs. One item per booking, with its most serious reason.
 */
const moment = require("moment-timezone");
const { PERMISSIONS } = require("../../adminAccess");
const { needsActionBookings, needsActionReason } = require("../../jobs/jobQueries");
const { TIMEZONE, jobType } = require("../../jobs/jobStatus");

const TITLES = {
  job_request: "Request to review",
  job_unassigned: "No Fixter assigned",
  job_not_closed: "Not closed",
  job_payment_problem: "Payment problem",
  job_reservation_issue: "Reservation issue",
};

module.exports = {
  key: "bookings",
  order: 10,
  permission: PERMISSIONS.BOOKINGS_READ,
  async collect({ now = new Date(), limit = 25, req }) {
    const { count, rows } = await needsActionBookings(req, { now, limit });
    const items = [];
    for (const booking of rows) {
      const why = needsActionReason(booking, now);
      if (!why) continue;
      const when = booking.date ? moment.tz(booking.date, TIMEZONE).format("ddd, MMM D, h:mm A") : "";
      items.push({
        id: String(booking._id),
        kind: why.kind,
        title: `${TITLES[why.kind]}: ${booking.name || "Customer"}`,
        subtitle: [jobType(booking).typeLabel, when, booking.city || ""].filter(Boolean).join(" · "),
        reason: why.reason,
        severity: why.severity,
        href: `/admin/jobs/${booking._id}`,
        at: booking.date || null,
      });
    }
    return { count, items };
  },
};
