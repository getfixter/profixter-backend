const cron = require("node-cron");
const Booking = require("../models/Booking");
const User = require("../models/User");
const { sendTx } = require("../utils/emailService");
const {
  REVIEW_REQUEST_DELAY_MS,
  REVIEW_REQUEST_LOCK_MS,
  REVIEW_REQUEST_MAX_AGE_MS,
  evaluateReviewRequest,
} = require("../utils/bookingReviewRequestPolicy");

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/*
 * At most one automatic review request per customer in any rolling window.
 *
 * 90 days unless REVIEW_REQUEST_CUSTOMER_COOLDOWN_DAYS says otherwise (0 turns
 * the cooldown off). A code default rather than an environment setting: the
 * production environment has no room left for new variables, and the audit of
 * 2026-11-03 found one member asked 17 times in 67 days.
 */
const DEFAULT_CUSTOMER_COOLDOWN_DAYS = 90;

function customerCooldownDays() {
  const raw = process.env.REVIEW_REQUEST_CUSTOMER_COOLDOWN_DAYS;
  if (raw === undefined || String(raw).trim() === "") return DEFAULT_CUSTOMER_COOLDOWN_DAYS;
  const days = Number(raw);
  return Number.isFinite(days) && days >= 0 ? days : DEFAULT_CUSTOMER_COOLDOWN_DAYS;
}

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

/*
 * Skipped is final: the booking is never looked at again. That is what keeps
 * a cooldown or a "Reviewed us" mark from turning into a retry every minute,
 * and what stops anything from catching up on old visits later.
 */
async function markSkipped(BookingModel, bookingId, now, reason) {
  await BookingModel.updateOne(
    { _id: bookingId, ...emptyField("reviewRequestSentAt") },
    {
      $set: { reviewRequestSkippedAt: now, reviewRequestSkipReason: reason },
      $unset: { reviewRequestQueuedAt: 1, reviewRequestLockExpiresAt: 1 },
    }
  );
}

/*
 * The customer behind a booking: its account, or for a booking made without
 * one, the customer account with that email. Staff accounts never count.
 */
async function customerFor(booking, UserModel) {
  const fields = "_id email reviewRequestLastAt reviewedUs role";
  if (booking.user) {
    const user = await UserModel.findById(booking.user).select(fields).lean();
    if (user) return user;
  }
  const email = safeEmail(booking.email);
  if (!email) return null;
  return UserModel.findOne({ email, role: { $ne: "employee" } }).select(fields).lean();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/*
 * Every way this customer's bookings can be found: the account, and their
 * email in any capitals (older bookings kept whatever was typed).
 */
function sameCustomer(booking, user) {
  const emails = [...new Set([safeEmail(booking.email), safeEmail(user?.email)].filter(Boolean))];
  const or = [];
  if (user?._id) or.push({ user: user._id });
  for (const email of emails) or.push({ email: { $regex: `^${escapeRegExp(email)}$`, $options: "i" } });
  return or;
}

async function runBookingReviewRequestCycle(
  now = new Date(),
  dependencies = {}
) {
  const BookingModel = dependencies.BookingModel || Booking;
  const UserModel = dependencies.UserModel || (dependencies.BookingModel ? null : User);
  const sendEmail = dependencies.sendEmail || sendTx;
  const cooldownDays = dependencies.cooldownDays ?? customerCooldownDays();
  const cutoff = new Date(now.getTime() - cooldownDays * DAY_MS);
  const dueBefore = new Date(now.getTime() - REVIEW_REQUEST_DELAY_MS);
  const notSent = emptyField("reviewRequestSentAt");
  const notSkipped = emptyField("reviewRequestSkippedAt");

  const candidates = await BookingModel.find({
    status: /^completed$/i,
    completedAt: { $lte: dueBefore },
    $and: [notSent, notSkipped, availableLock(now)],
  })
    .select(
      "_id bookingNumber status name email user service bookingType accessType isFreeFirstVisit freeVisitPurpose completedAt reviewRequestQueuedAt reviewRequestSentAt reviewRequestLockExpiresAt reviewRequestSkippedAt"
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
    cooldownSkipped: 0,
    reviewedSkipped: 0,
    tooOldSkipped: 0,
  };
  const recoveredLocks = candidates.filter(
    (booking) =>
      booking.reviewRequestLockExpiresAt &&
      new Date(booking.reviewRequestLockExpiresAt) <= now
  );

  if (candidates.length) {
    console.log("Booking review request job started", {
      serverTime: now.toISOString(),
      dueBefore: dueBefore.toISOString(),
      candidates: candidates.length,
      cooldownDays,
    });
  }
  if (recoveredLocks.length) {
    console.warn("Booking review request lock recovery", {
      bookings: recoveredLocks.map(logShape),
    });
  }

  for (const booking of candidates) {
    const eligibility = evaluateReviewRequest(booking, now);
    if (!eligibility.eligible) {
      /*
       * A visit completed more than a week ago is never asked about: no
       * catch-up emails after an outage or for a booking marked completed
       * long after the fact.
       */
      if (eligibility.reason === "too_old") {
        await markSkipped(BookingModel, booking._id, now, "too_old");
        stats.tooOldSkipped++;
      }
      console.log("Booking review request skipped", {
        ...logShape(booking),
        reason: eligibility.reason,
      });
      continue;
    }

    /*
     * One ask per customer, not one per booking.
     *
     * A member who books every week was being asked "How did we do?" after
     * every visit, which is how a review request turns into noise and gets
     * ignored. Nobody is screened by satisfaction: the only tests are whether
     * the owner marked them as having reviewed us, and when they were last
     * asked - across every booking and home on the account, and every booking
     * made with their email, including requests sent before this rule.
     */
    const customer = UserModel ? await customerFor(booking, UserModel) : null;
    if (customer?.reviewedUs?.at) {
      await markSkipped(BookingModel, booking._id, now, "reviewed_us");
      stats.reviewedSkipped++;
      console.log("Booking review request skipped", { ...logShape(booking), reason: "reviewed_us" });
      continue;
    }
    const customerQuery = sameCustomer(booking, customer);
    if (cooldownDays > 0) {
      const askedOnAccount = customer?.reviewRequestLastAt && new Date(customer.reviewRequestLastAt) >= cutoff;
      const askedRecently =
        askedOnAccount ||
        (customerQuery.length &&
          (await BookingModel.exists({
            _id: { $ne: booking._id },
            $or: customerQuery,
            reviewRequestSentAt: { $gte: cutoff },
          })));
      if (askedRecently) {
        await markSkipped(BookingModel, booking._id, now, "customer_cooldown");
        stats.cooldownSkipped++;
        console.log("Booking review request skipped", { ...logShape(booking), reason: "customer_cooldown", cooldownDays });
        continue;
      }
    }

    const claim = await claimReviewRequest(booking._id, now, BookingModel);
    if (!claim.claimed) {
      stats.claimLost++;
      continue;
    }
    stats.claimed++;

    const releaseClaim = () =>
      BookingModel.updateOne(
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

    /*
     * Two of the customer's bookings due at once (two homes, or two servers
     * each running the job): exactly one may ask. Another booking already
     * being sent wins if its id sorts first, so the two can never both yield
     * or both send; the account reservation below settles the rest.
     */
    if (cooldownDays > 0 && customerQuery.length) {
      const rival = await BookingModel.exists({
        _id: { $ne: booking._id, $lt: booking._id },
        $or: customerQuery,
        reviewRequestQueuedAt: { $ne: null },
        reviewRequestLockExpiresAt: { $gt: now },
      });
      if (rival) {
        await markSkipped(BookingModel, booking._id, now, "customer_cooldown");
        stats.cooldownSkipped++;
        console.log("Booking review request skipped", { ...logShape(booking), reason: "customer_cooldown_concurrent" });
        continue;
      }
    }

    /*
     * The account's own reservation, taken atomically: whichever booking sets
     * reviewRequestLastAt first is the one that asks, on any server.
     */
    let reserved = null;
    if (customer?._id && UserModel) {
      const notReviewed = { $or: [{ "reviewedUs.at": { $exists: false } }, { "reviewedUs.at": null }] };
      const free =
        cooldownDays > 0
          ? { $or: [{ reviewRequestLastAt: { $exists: false } }, { reviewRequestLastAt: null }, { reviewRequestLastAt: { $lt: cutoff } }] }
          : {};
      const result = await UserModel.updateOne(
        { _id: customer._id, $and: [notReviewed, free] },
        { $set: { reviewRequestLastAt: now } }
      );
      if (result.modifiedCount !== 1) {
        const fresh = await UserModel.findById(customer._id).select("reviewedUs").lean();
        const reason = fresh?.reviewedUs?.at ? "reviewed_us" : "customer_cooldown";
        await markSkipped(BookingModel, booking._id, now, reason);
        if (reason === "reviewed_us") stats.reviewedSkipped++;
        else stats.cooldownSkipped++;
        console.log("Booking review request skipped", { ...logShape(booking), reason: `${reason}_reserved` });
        continue;
      }
      reserved = { userId: customer._id, previous: customer.reviewRequestLastAt || null };
    }
    const releaseReservation = () =>
      reserved
        ? UserModel.updateOne({ _id: reserved.userId, reviewRequestLastAt: now }, { $set: { reviewRequestLastAt: reserved.previous } })
        : null;

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
        await releaseClaim();
        await releaseReservation();
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
          isFreeFirstVisit: Boolean(booking.isFreeFirstVisit),
          freeVisitPurpose: booking.freeVisitPurpose || "",
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
            userId: customer?._id || booking.user || null,
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
      await releaseClaim();
      await releaseReservation();
      stats.failed++;
      console.warn("Booking review request failed", {
        booking: logShape(booking),
        error: errorDetails(error),
      });
    }
  }

  if (candidates.length) console.log("Booking review request cycle summary", stats);
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
    cooldownDays: customerCooldownDays(),
    maxAgeDays: REVIEW_REQUEST_MAX_AGE_MS / DAY_MS,
  });
}

module.exports = {
  DEFAULT_CUSTOMER_COOLDOWN_DAYS,
  claimReviewRequest,
  customerCooldownDays,
  runBookingReviewRequestCycle,
  startBookingReviewRequests,
};
