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

  const bookings = await BookingModel.find({
    bookingType: "one_time_handyman_visit",
    paymentState: "pending",
    paymentHoldExpiresAt: { $lte: now },
  }).limit(100);

  let expired = 0;
  for (const booking of bookings) {
    try {
      if (shouldUseReservationEngine()) {
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
