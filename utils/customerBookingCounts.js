const Booking = require("../models/Booking");

/**
 * How many visits each customer has actually had.
 *
 * A visit counts when its booking is closed as done and its appointment has
 * started. That covers membership visits, paid one-time visits, Full Days and
 * free first visits alike, because all of them are Booking rows; what decides
 * it is the status, not how the visit was paid for.
 *
 * Deliberately left out:
 *  - Pending, Confirmed, Canceled and declined bookings. Only a closed job is a
 *    visit that happened.
 *  - A booking marked done whose appointment is still in the future. That is a
 *    status set by mistake, not a visit.
 *  - Homepage guest requests with no account. They belong to nobody until a
 *    person signs up, and matching them by phone or e-mail would guess.
 *
 * Counted from the booking records every time, never stored, so there is no
 * number to drift out of step with the jobs themselves.
 */

/** The same two words the Fixter screens already count as finished. */
const COMPLETED_STATUS = /^\s*(completed|done)\s*$/i;

function completedVisitFilter(now = new Date()) {
  return { status: COMPLETED_STATUS, date: { $lte: now } };
}

/**
 * Completed visits per customer, keyed by the user's Mongo id.
 *
 * One aggregate for the whole list rather than one query per customer, because
 * the Customers screen loads everybody at once. Older bookings may carry only
 * the public userId, so both keys are matched and folded into one count.
 */
async function completedBookingCountsForUsers(users = [], { now = new Date() } = {}) {
  const counts = new Map();
  const list = (Array.isArray(users) ? users : []).filter((user) => user?._id);
  if (!list.length) return counts;

  const byPublicId = new Map();
  for (const user of list) {
    counts.set(String(user._id), 0);
    if (user.userId) byPublicId.set(String(user.userId), String(user._id));
  }

  const rows = await Booking.aggregate([
    {
      $match: {
        ...completedVisitFilter(now),
        $or: [
          { user: { $in: list.map((user) => user._id) } },
          { userId: { $in: [...byPublicId.keys()] } },
        ],
      },
    },
    { $group: { _id: { user: "$user", userId: "$userId" }, count: { $sum: 1 } } },
  ]);

  for (const row of rows) {
    const key = row._id.user ? String(row._id.user) : byPublicId.get(String(row._id.userId || ""));
    if (!key || !counts.has(key)) continue;
    counts.set(key, counts.get(key) + row.count);
  }

  return counts;
}

async function completedBookingCountForUser(user, options = {}) {
  const counts = await completedBookingCountsForUsers([user], options);
  return counts.get(String(user?._id)) || 0;
}

module.exports = {
  COMPLETED_STATUS,
  completedVisitFilter,
  completedBookingCountsForUsers,
  completedBookingCountForUser,
};
