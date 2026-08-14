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

const CLEANUP_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.ONE_TIME_VISIT_HOLD_CLEANUP_MS || 5 * 60_000)
);

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

  let expired = 0;
  for (const booking of bookings) {
    try {
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

  const run = async () => {
    try {
      const expired = await expireOneTimeVisitHolds();
      if (expired) console.log(`Expired ${expired} one-time visit payment hold(s)`);
    } catch (error) {
      console.error("One-time visit hold cleanup cycle failed:", error.message);
    }
  };

  const interval = setInterval(run, CLEANUP_INTERVAL_MS);
  interval.unref?.();
  setTimeout(run, 15_000).unref?.();
  return interval;
}

module.exports = {
  expireOneTimeVisitHolds,
  startOneTimeVisitHoldCleanup,
};
