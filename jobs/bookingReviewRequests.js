const cron = require("node-cron");
const Booking = require("../models/Booking");
const { sendTx } = require("../utils/emailService");
const {
  REVIEW_REQUEST_DELAY_MS,
  REVIEW_REQUEST_LOCK_MS,
  evaluateReviewRequest,
} = require("../utils/bookingReviewRequestPolicy");

function emptyField(field) {
  return {
    $or: [{ [field]: { $exists: false } }, { [field]: null }],
  };
}

function availableLock(now) {
  return {
    $or: [
      { reviewRequestLockExpiresAt: { $exists: false } },
      { reviewRequestLockExpiresAt: null },
      { reviewRequestLockExpiresAt: { $lte: now } },
    ],
  };
}

function safeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function logShape(booking) {
  const email = safeEmail(booking?.email);
  return {
    bookingId: String(booking?._id || ""),
    bookingNumber: booking?.bookingNumber || "",
    status: booking?.status || "",
    completedAt: booking?.completedAt || null,
    emailDomain: email.includes("@") ? email.split("@").pop() : "",
  };
}

function errorDetails(error) {
  return {
    message: error?.message || "Unknown error",
    name: error?.name || "",
    code: error?.code || "",
    responseCode: error?.responseCode || "",
  };
}

async function claimReviewRequest(
  bookingId,
  now = new Date(),
  BookingModel = Booking
) {
  const dueBefore = new Date(now.getTime() - REVIEW_REQUEST_DELAY_MS);
  const lockExpiresAt = new Date(now.getTime() + REVIEW_REQUEST_LOCK_MS);
  const result = await BookingModel.updateOne(
    {
      _id: bookingId,
      status: /^completed$/i,
      completedAt: { $lte: dueBefore },
      $and: [
        emptyField("reviewRequestSentAt"),
        emptyField("reviewRequestSkippedAt"),
        availableLock(now),
      ],
    },
    {
      $set: {
        reviewRequestQueuedAt: now,
        reviewRequestLockExpiresAt: lockExpiresAt,
      },
    }
  );

  return {
    claimed: result.modifiedCount === 1,
    queuedAt: now,
    lockExpiresAt,
  };
}

async function runBookingReviewRequestCycle(
  now = new Date(),
  dependencies = {}
) {
  const BookingModel = dependencies.BookingModel || Booking;
  const sendEmail = dependencies.sendEmail || sendTx;
  const dueBefore = new Date(now.getTime() - REVIEW_REQUEST_DELAY_MS);
  const notSent = emptyField("reviewRequestSentAt");
  const notSkipped = emptyField("reviewRequestSkippedAt");

  const candidates = await BookingModel.find({
    status: /^completed$/i,
    completedAt: { $lte: dueBefore },
    $and: [notSent, notSkipped, availableLock(now)],
  })
    .select(
      "_id bookingNumber status name email service bookingType accessType completedAt reviewRequestQueuedAt reviewRequestSentAt reviewRequestLockExpiresAt reviewRequestSkippedAt"
    )
    .sort({ completedAt: 1 })
    .limit(100)
    .lean();

  const stats = {
    candidates: candidates.length,
    claimed: 0,
    sent: 0,
    failed: 0,
    claimLost: 0,
    changedAfterClaim: 0,
  };
  const recoveredLocks = candidates.filter(
    (booking) =>
      booking.reviewRequestLockExpiresAt &&
      new Date(booking.reviewRequestLockExpiresAt) <= now
  );

  console.log("Booking review request job started", {
    serverTime: now.toISOString(),
    dueBefore: dueBefore.toISOString(),
    candidates: candidates.length,
  });
  if (recoveredLocks.length) {
    console.warn("Booking review request lock recovery", {
      bookings: recoveredLocks.map(logShape),
    });
  }

  for (const booking of candidates) {
    const eligibility = evaluateReviewRequest(booking, now);
    if (!eligibility.eligible) {
      console.log("Booking review request skipped", {
        ...logShape(booking),
        reason: eligibility.reason,
      });
      continue;
    }

    const claim = await claimReviewRequest(booking._id, now, BookingModel);
    if (!claim.claimed) {
      stats.claimLost++;
      continue;
    }
    stats.claimed++;

    try {
      const stillEligible = await BookingModel.exists({
        _id: booking._id,
        status: /^completed$/i,
        completedAt: { $lte: dueBefore },
        reviewRequestQueuedAt: claim.queuedAt,
        reviewRequestLockExpiresAt: claim.lockExpiresAt,
        $and: [notSent, notSkipped],
      });

      if (!stillEligible) {
        await BookingModel.updateOne(
          {
            _id: booking._id,
            reviewRequestQueuedAt: claim.queuedAt,
            reviewRequestLockExpiresAt: claim.lockExpiresAt,
          },
          {
            $unset: {
              reviewRequestQueuedAt: 1,
              reviewRequestLockExpiresAt: 1,
            },
          }
        );
        stats.changedAfterClaim++;
        console.log("Booking review request skipped", {
          ...logShape(booking),
          reason: "booking_changed_after_claim",
        });
        continue;
      }

      console.log("Sending booking review request", logShape(booking));
      await sendEmail(
        "booking_review_request",
        safeEmail(booking.email),
        {
          name: booking.name || "there",
          bookingNumber: booking.bookingNumber,
          service: booking.service,
          bookingType: booking.bookingType,
          accessType: booking.accessType,
        },
        {
          bccAdmin: false,
          logContext: {
            bookingId: booking._id,
            bookingNumber: booking.bookingNumber,
            customerName: booking.name || "",
            customerEmail: safeEmail(booking.email),
            recipientName: booking.name || "",
            recipientEmail: safeEmail(booking.email),
            emailType: "review",
            source: "bookingReviewRequests",
          },
        }
      );

      const markedSent = await BookingModel.updateOne(
        {
          _id: booking._id,
          $and: [notSent],
        },
        {
          $set: { reviewRequestSentAt: new Date() },
          $unset: {
            reviewRequestQueuedAt: 1,
            reviewRequestLockExpiresAt: 1,
          },
        }
      );

      if (markedSent.modifiedCount !== 1) {
        console.error("Booking review request sent but state changed before marking", {
          ...logShape(booking),
        });
      }
      stats.sent++;
      console.log("Booking review request sent", logShape(booking));
    } catch (error) {
      await BookingModel.updateOne(
        {
          _id: booking._id,
          reviewRequestQueuedAt: claim.queuedAt,
          reviewRequestLockExpiresAt: claim.lockExpiresAt,
        },
        {
          $unset: {
            reviewRequestQueuedAt: 1,
            reviewRequestLockExpiresAt: 1,
          },
        }
      );
      stats.failed++;
      console.warn("Booking review request failed", {
        booking: logShape(booking),
        error: errorDetails(error),
      });
    }
  }

  console.log("Booking review request cycle summary", stats);
  return stats;
}

function startBookingReviewRequests() {
  let running = false;

  cron.schedule(
    "* * * * *",
    async () => {
      if (running) {
        console.log(
          "Booking review request cycle skipped: prior local cycle still running"
        );
        return;
      }
      running = true;
      try {
        await runBookingReviewRequestCycle(new Date());
      } catch (error) {
        console.error("Booking review request cron failed", errorDetails(error));
      } finally {
        running = false;
      }
    },
    { timezone: "America/New_York" }
  );

  console.log("Booking review request cron started", {
    schedule: "* * * * *",
    timezone: "America/New_York",
  });
}

module.exports = {
  claimReviewRequest,
  runBookingReviewRequestCycle,
  startBookingReviewRequests,
};
