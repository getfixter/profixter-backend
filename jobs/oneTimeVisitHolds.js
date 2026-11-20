const Booking = require("../models/Booking");
const CalendarConfig = require("../models/CalendarConfig");
const SlotCounter = require("../models/SlotCounter");
const VisitEntitlement = require("../models/VisitEntitlement");
const {
  cancelBookingWithReservation,
  reservationEngineEnabled,
} = require("../utils/slotReservationService");
const {
  expiredOneTimeHoldBookingUpdate,
} = require("../utils/oneTimeVisitPaymentFlow");
const { releaseFullDayCapacity } = require("../utils/fullDayVisitService");
const { decideExpiredHold } = require("../utils/paidVisitSettlement");

/* The Stripe page a pending paid visit was opened with: on the booking (guest) or its entitlement (signed in). */
async function checkoutSessionIdFor(booking, VisitEntitlementModel) {
  if (booking.checkoutSessionId) return booking.checkoutSessionId;
  const query = booking.entitlementId ? { _id: booking.entitlementId } : { bookingId: booking._id };
  const entitlement = await VisitEntitlementModel.findOne(query).select("stripeCheckoutSessionId").lean();
  return entitlement?.stripeCheckoutSessionId || "";
}

function defaultStripe() {
  return require("../utils/subscriptionManagement").stripe;
}

const CLEANUP_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.ONE_TIME_VISIT_HOLD_CLEANUP_MS || 5 * 60_000)
);
const HEARTBEAT_INTERVAL_MS = 60 * 60_000;

const ymdInTZ = (d, tz) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
const hhmmInTZ = (d, tz) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);

async function releaseLegacySlot(booking) {
  const cfg = await CalendarConfig.findOne().lean();
  const tz = cfg?.timezone || "America/New_York";
  const ymd = ymdInTZ(new Date(booking.date), tz);
  const hh = hhmmInTZ(new Date(booking.date), tz);
  await SlotCounter.updateOne({ ymd, time: hh }, { $inc: { count: -1 } });
}

async function expireOneTimeVisitHolds(now = new Date(), dependencies = {}) {
  const BookingModel = dependencies.BookingModel || Booking;
  const VisitEntitlementModel = dependencies.VisitEntitlementModel || VisitEntitlement;
  const shouldUseReservationEngine =
    dependencies.reservationEngineEnabled || reservationEngineEnabled;
  const cancelReservation =
    dependencies.cancelBookingWithReservation || cancelBookingWithReservation;
  const releaseLegacy =
    dependencies.releaseLegacySlot || releaseLegacySlot;
  const releaseFullDay =
    dependencies.releaseFullDayCapacity || releaseFullDayCapacity;

  // Full Day rides along here rather than getting its own timer. It is the same
  // job: a checkout that was started and abandoned, holding time it never paid
  // for. Only the shape of what has to be handed back differs.
  const bookings = await BookingModel.find({
    bookingType: { $in: ["one_time_handyman_visit", "full_day_visit"] },
    paymentState: "pending",
    paymentHoldExpiresAt: { $lte: now },
  }).limit(100);

  /*
   * Stripe is asked first (utils/paidVisitSettlement, 2026-11-19): a page that
   * was paid is recorded instead of canceled, one still open is closed at
   * Stripe, and a Stripe that cannot be read defers the release.
   */
  const retrieveSession = dependencies.retrieveCheckoutSession || ((id) => defaultStripe().checkout.sessions.retrieve(id));
  const expireSession = dependencies.expireCheckoutSession || ((id) => defaultStripe().checkout.sessions.expire(id));
  const settlePaidSession = dependencies.settlePaidSession || ((session) => require("../routes/webhook").handleCheckoutCompleted(session, null));
  const sessionIdFor = dependencies.checkoutSessionIdFor || ((booking) => checkoutSessionIdFor(booking, VisitEntitlementModel));
  const tally = dependencies.tally || {};

  let expired = 0;
  for (const booking of bookings) {
    try {
      const decision = await decideExpiredHold({
        booking,
        sessionId: await sessionIdFor(booking),
        now,
        retrieveSession,
        expireSession,
      });
      if (decision.action === "settle") {
        await settlePaidSession(decision.session);
        tally.settled = (tally.settled || 0) + 1;
        console.warn(JSON.stringify({ event: "paid_visit_settled_by_sweep", bookingId: String(booking._id), stripeSessionId: decision.session?.id || null }));
        continue;
      }
      if (decision.action === "wait") {
        tally.deferred = (tally.deferred || 0) + 1;
        continue;
      }
      if (booking.bookingType === "full_day_visit") {
        // Releases the whole workday under either engine. The single-slot
        // release below would give back one hour of a day-long hold.
        await releaseFullDay(booking);
        if (shouldUseReservationEngine()) {
          await cancelReservation({
            bookingId: booking._id,
            createdByType: "system",
            reason: "Full Day payment hold expired",
          });
        }
      } else if (shouldUseReservationEngine()) {
        await cancelReservation({
          bookingId: booking._id,
          createdByType: "system",
          reason: "One-time payment hold expired",
        });
      } else {
        await releaseLegacy(booking);
      }

      await BookingModel.updateOne(
        { _id: booking._id, paymentState: "pending" },
        {
          $set: expiredOneTimeHoldBookingUpdate("expired"),
        }
      );
      await VisitEntitlementModel.updateOne(
        { bookingId: booking._id, status: "pending_payment" },
        { $set: { status: "expired" } }
      );
      expired += 1;
    } catch (error) {
      console.error("Expire one-time hold failed:", {
        bookingId: String(booking._id),
        message: error.message,
      });
    }
  }

  return expired;
}

function startOneTimeVisitHoldCleanup() {
  if (String(process.env.ONE_TIME_VISIT_HOLD_CLEANUP_ENABLED || "true").toLowerCase() === "false") {
    console.log("One-time visit hold cleanup disabled");
    return null;
  }

  // Totals since the last heartbeat. The job is silent while there is nothing
  // to do, so the hourly line is what proves it is still running.
  let totals = emptyTotals();
  const run = async () => {
    totals.cycles += 1;
    try {
      const expired = await expireOneTimeVisitHolds();
      totals.holdsExpired += expired || 0;
      if (expired) console.log(`Expired ${expired} one-time visit payment hold(s)`);
    } catch (error) {
      totals.failures += 1;
      console.error("One-time visit hold cleanup cycle failed:", error.message);
    }
    // Paid membership first visits the webhook could not finish (utils/membershipFirstVisitFulfillment).
    try {
      const finished = await require("../utils/membershipFirstVisitFulfillment").sweepFirstVisitDrafts();
      totals.firstVisitsFinished += finished || 0;
      if (finished) console.log(`Finished ${finished} membership first visit(s)`);
    } catch (error) {
      totals.failures += 1;
      console.error("Membership first visit sweep failed:", error.message);
    }
    // Paid free-visit conversions the webhook could not finish, and links that ran out (utils/freeVisit/conversion.js).
    try {
      const tally = await require("../utils/freeVisit/conversion").sweepConversions();
      totals.conversionsFinished += tally?.finished || 0;
      totals.conversionLinksExpired += tally?.expired || 0;
      if (tally?.finished) console.log(`Finished ${tally.finished} free visit conversion(s)`);
    } catch (error) {
      totals.failures += 1;
      console.error("Free visit conversion sweep failed:", error.message);
    }
    // Then drafts nobody paid for, and their photos (retention: utils/membershipFirstVisitCleanup.js).
    try {
      const tally = await require("../utils/membershipFirstVisitCleanup").cleanupFirstVisitDrafts();
      totals.draftsAbandoned += tally?.abandoned || 0;
      totals.draftsDeleted += tally?.recordsDeleted || 0;
      totals.failures += tally?.errors || 0;
    } catch (error) {
      totals.failures += 1;
      console.error("Membership first visit draft cleanup failed:", error.message);
    }
  };
  const heartbeat = () => {
    console.log(JSON.stringify({ event: "cleanup_heartbeat", at: new Date().toISOString(), ...totals }));
    totals = emptyTotals();
  };

  const interval = setInterval(run, CLEANUP_INTERVAL_MS);
  interval.unref?.();
  setTimeout(run, 15_000).unref?.();
  setInterval(heartbeat, HEARTBEAT_INTERVAL_MS).unref?.();
  console.log(JSON.stringify({ event: "cleanup_started", everyMs: CLEANUP_INTERVAL_MS, heartbeatMs: HEARTBEAT_INTERVAL_MS }));
  return interval;
}

function emptyTotals() {
  return { cycles: 0, failures: 0, holdsExpired: 0, firstVisitsFinished: 0, conversionsFinished: 0, conversionLinksExpired: 0, draftsAbandoned: 0, draftsDeleted: 0 };
}

module.exports = {
  expireOneTimeVisitHolds,
  startOneTimeVisitHoldCleanup,
};
