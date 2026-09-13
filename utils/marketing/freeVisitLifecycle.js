const Booking = require("../../models/Booking");

/**
 * Where somebody stands with the Free First Visit, from durable booking state.
 *
 * WHY THIS EXISTS AT ALL.
 *
 * Marketing used to answer "have they used the free visit?" with a single
 * count: `Booking.countDocuments({ user, isFreeFirstVisit: true })`. That
 * treats a cancelled booking as a consumed offer, so a customer who booked
 * their free visit and called to cancel was told by the product that the offer
 * was still theirs and told by marketing, silently and permanently, that it was
 * gone. At the time this was written eight real customers were in exactly that
 * state - the largest addressable group we had after the never-booked.
 *
 * WHY NOT address.introVisit.
 *
 * That record is the product's own source of truth and it is correct, but it
 * reconciles lazily, on read: an address only learns its booking completed when
 * somebody loads a page that asks. Production had one address marked consumed
 * against ten completed free visits and a hundred and thirty-three that had
 * never been evaluated at all. A background job that trusted it would put most
 * of Track B in Track A.
 *
 * So this reads the bookings themselves. `completedAt` is written by the single
 * completion path and never unset; status is the fallback for rows that predate
 * it. Both are durable, both are already indexed by user.
 *
 * THE THREE STATES, AND WHY THE DISTINCTION IS THE WHOLE POINT.
 *
 *   available  Nothing booked, or everything booked was cancelled. The offer is
 *              theirs. Track A may ask them to use it.
 *   open       A free visit is booked and has not happened yet. The offer is
 *              spoken for. Nobody should be told to book the thing already in
 *              their calendar.
 *   completed  A Fixter has been to the house. The offer is used, Track A must
 *              stop, and - if they are not a member - Track B begins from the
 *              moment the visit finished.
 */

/** Statuses that mean the visit happened. Mirrors introVisitEligibility. */
const COMPLETED_STATUSES = new Set(["completed", "complete", "done"]);
/** Statuses that mean it will not happen and never did, so the offer returns. */
const CANCELLED_STATUSES = new Set(["canceled", "cancelled"]);

const STATE = {
  AVAILABLE: "available",
  OPEN: "open",
  COMPLETED: "completed",
};

function normalizeStatus(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s_]+/g, "-");
}

function isCompleted(booking) {
  if (booking?.completedAt) return true;
  return COMPLETED_STATUSES.has(normalizeStatus(booking?.status));
}

function isCancelled(booking) {
  return CANCELLED_STATUSES.has(normalizeStatus(booking?.status));
}

/**
 * Reduce a person's free-visit bookings to one state and one anchor date.
 *
 * Pure, so the state machine is testable without a database.
 *
 * Completion wins over everything: somebody who used the offer, then booked a
 * second free visit that got cancelled, has still used it. Anything neither
 * completed nor cancelled counts as open, deliberately - a no-show or a status
 * nobody recognised leaves the offer spoken for rather than handing out a
 * second free visit on a guess.
 *
 * @param {Array<{status?: string, completedAt?: Date|null, date?: Date|null}>} bookings
 * @returns {{state: string, completedAt: Date|null, openCount: number, cancelledCount: number}}
 */
function resolveFreeVisitState(bookings = []) {
  let completedAt = null;
  let openCount = 0;
  let cancelledCount = 0;

  for (const booking of bookings) {
    if (isCompleted(booking)) {
      /* The most recent completion is the anchor Track B counts from. */
      const when = booking.completedAt || booking.date || null;
      const stamp = when ? new Date(when) : null;
      if (stamp && !Number.isNaN(stamp.getTime())) {
        if (!completedAt || stamp > completedAt) completedAt = stamp;
      } else if (!completedAt) {
        /*
         * Completed with no usable date. Real rows always have one; this keeps
         * a broken row from being read as "never happened", which would put
         * somebody back into Track A after we had already been to their house.
         */
        completedAt = null;
      }
      continue;
    }
    if (isCancelled(booking)) {
      cancelledCount += 1;
      continue;
    }
    openCount += 1;
  }

  if (completedAt || bookings.some(isCompleted)) {
    return { state: STATE.COMPLETED, completedAt, openCount, cancelledCount };
  }
  if (openCount > 0) {
    return { state: STATE.OPEN, completedAt: null, openCount, cancelledCount };
  }
  return { state: STATE.AVAILABLE, completedAt: null, openCount, cancelledCount };
}

/**
 * The same answer, read from the database for one person.
 *
 * One indexed query. The projection is deliberately tiny: this runs for every
 * candidate on every marketing cycle, and none of the rest of a booking - the
 * address, the customer's name, the notes - has any business being loaded to
 * answer a yes or no question.
 */
async function freeVisitStateFor(userId, { BookingModel = Booking } = {}) {
  const bookings = await BookingModel.find({ user: userId, isFreeFirstVisit: true })
    .select("status completedAt date")
    .lean();
  return resolveFreeVisitState(bookings);
}

module.exports = {
  CANCELLED_STATUSES,
  COMPLETED_STATUSES,
  STATE,
  freeVisitStateFor,
  resolveFreeVisitState,
};
