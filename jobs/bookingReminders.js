const cron = require("node-cron");
const Booking = require("../models/Booking");
const User = require("../models/User");
const { sendTx } = require("../utils/emailService");
const {
  REMINDER_24H_CATCHUP_MIN_MS,
  REMINDER_24H_MS,
  REMINDER_60M_MS,
  REMINDER_LOCK_STALE_MS,
  REMINDER_WINDOW_MS,
  evaluate24HourReminder,
  evaluate60MinuteReminder,
} = require("../utils/bookingReminderPolicy");
const {
  createOrUpdateContact,
  updateContactFields,
  formatBookingDateTime,
  addTag,
} = require("../utils/ghlContact");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function buildAddress(booking) {
  return [booking.address, booking.city, booking.state, booking.zip]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(", ");
}

function safeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function bookingLogShape(booking) {
  const email = safeEmail(booking.email);
  return {
    bookingId: String(booking._id || ""),
    bookingNumber: booking.bookingNumber || "",
    status: booking.status || "",
    date: booking.date || null,
    emailDomain: email.includes("@") ? email.split("@").pop() : "",
  };
}

function errorDetails(error) {
  return {
    message: error?.message || "Unknown error",
    name: error?.name || "",
    code: error?.code || "",
    responseCode: error?.responseCode || "",
    command: error?.command || "",
  };
}

function emptyField(field) {
  return {
    $or: [{ [field]: { $exists: false } }, { [field]: null }],
  };
}

function availableLock(field, staleBefore) {
  return {
    $or: [
      { [field]: { $exists: false } },
      { [field]: null },
      { [field]: { $lte: staleBefore } },
    ],
  };
}

async function sendReminderEmail({ templateKey, booking, vars }) {
  const to = safeEmail(booking.email);
  if (!to) {
    throw new Error(`Missing customer email for booking ${booking._id}`);
  }

  console.log(`Sending ${templateKey} email`, bookingLogShape(booking));
  const info = await sendTx(templateKey, to, vars, {
    logContext: {
      bookingId: booking._id,
      bookingNumber: booking.bookingNumber,
      customerName: booking.name || "",
      customerEmail: to,
      recipientName: booking.name || "",
      recipientEmail: to,
      emailType: "reminder",
      source: "bookingReminders",
    },
  });
  console.log(`${templateKey} email sent`, {
    ...bookingLogShape(booking),
    messageId: info?.messageId || "",
  });
  return info;
}

async function sendReminderSmsTag({ booking, tag }) {
  const user = await User.findOne({ userId: booking.userId }).lean();
  const contactId = await createOrUpdateContact({
    name: booking.name || user?.name,
    email: booking.email || user?.email,
    phone: booking.phone || user?.phone,
  });
  if (!contactId) {
    throw new Error(`Could not sync GHL contact for booking ${booking._id}`);
  }

  const pretty = formatBookingDateTime(booking.date);
  const updated = await updateContactFields(contactId, [
    { key: "booking_datetime_pretty", value: pretty },
  ]);
  if (!updated) {
    throw new Error(`Failed updating GHL fields for booking ${booking._id}`);
  }
  if (!(await addTag(contactId, tag))) {
    throw new Error(`Failed adding GHL tag ${tag} for booking ${booking._id}`);
  }

  console.log("GHL reminder tag added", {
    ...bookingLogShape(booking),
    tag,
  });
}

async function process24HourReminders(now, stats) {
  const catchupFloor = new Date(
    now.getTime() + REMINDER_24H_CATCHUP_MIN_MS
  );
  const windowCeiling = new Date(
    now.getTime() + REMINDER_24H_MS + REMINDER_WINDOW_MS
  );
  const staleBefore = new Date(now.getTime() - REMINDER_LOCK_STALE_MS);
  const notSent = emptyField("reminder24hSentAt");
  const lockAvailable = availableLock("reminder24hQueuedAt", staleBefore);

  const candidates = await Booking.find({
    status: /^confirmed$/i,
    date: { $gt: catchupFloor, $lte: windowCeiling },
    $and: [notSent, lockAvailable],
  })
    .select(
      "status userId name email phone bookingNumber date service address city state zip reminder24hQueuedAt reminder24hSentAt reminder24hSkippedAt reminder24hSkipReason"
    )
    .sort({ date: 1 })
    .limit(100)
    .lean();

  stats.scanned24 = candidates.length;
  const staleLocks = candidates.filter(
    (booking) =>
      booking.reminder24hQueuedAt &&
      new Date(booking.reminder24hQueuedAt) <= staleBefore
  );
  console.log("24h reminder candidates found", {
    catchupFloor: catchupFloor.toISOString(),
    windowCeiling: windowCeiling.toISOString(),
    candidates: candidates.length,
    staleLocksRecoverable: staleLocks.length,
  });
  if (staleLocks.length) {
    console.warn("24h reminder lock recovery", {
      bookings: staleLocks.map(bookingLogShape),
    });
  }

  for (const booking of candidates) {
    const eligibility = evaluate24HourReminder(booking, now);
    if (!eligibility.eligible) {
      stats.notDue24++;
      console.log("24h reminder skipped", {
        ...bookingLogShape(booking),
        reason: eligibility.reason,
      });
      continue;
    }

    const lockTime = new Date();
    const claim = await Booking.updateOne(
      {
        _id: booking._id,
        status: /^confirmed$/i,
        date: { $gt: catchupFloor, $lte: windowCeiling },
        $and: [notSent, lockAvailable],
      },
      { $set: { reminder24hQueuedAt: lockTime } }
    );
    if (claim.modifiedCount !== 1) {
      stats.locked24++;
      console.log("24h reminder skipped", {
        ...bookingLogShape(booking),
        reason: "claim_lost_or_booking_changed",
      });
      continue;
    }

    stats.matched24++;
    try {
      const stillConfirmed = await Booking.exists({
        _id: booking._id,
        status: /^confirmed$/i,
        date: booking.date,
        reminder24hQueuedAt: lockTime,
        $and: [notSent],
      });
      if (!stillConfirmed) {
        await Booking.updateOne(
          { _id: booking._id, reminder24hQueuedAt: lockTime },
          { $unset: { reminder24hQueuedAt: 1 } }
        );
        stats.notDue24++;
        console.log("24h reminder skipped", {
          ...bookingLogShape(booking),
          reason: "booking_changed_after_claim",
        });
        continue;
      }

      console.log("Processing 24h reminder", {
        ...bookingLogShape(booking),
        mode: eligibility.mode,
      });
      await sendReminderEmail({
        templateKey: "booking_reminder_24h",
        booking,
        vars: {
          name: booking.name || "there",
          bookingNumber: booking.bookingNumber,
          date: booking.date,
          service: booking.service,
          address: buildAddress(booking),
        },
      });

      await Booking.updateOne(
        { _id: booking._id, reminder24hQueuedAt: lockTime },
        {
          $set: { reminder24hSentAt: new Date() },
          $unset: { reminder24hQueuedAt: 1 },
        }
      );

      try {
        await sendReminderSmsTag({ booking, tag: "reminder_24h" });
      } catch (error) {
        console.warn("24h GHL tag failed after email sent", {
          booking: bookingLogShape(booking),
          error: errorDetails(error),
        });
      }

      stats.sent24++;
      console.log("24h reminder sent success", {
        ...bookingLogShape(booking),
        mode: eligibility.mode,
      });
      await sleep(80);
    } catch (error) {
      await Booking.updateOne(
        { _id: booking._id, reminder24hQueuedAt: lockTime },
        { $unset: { reminder24hQueuedAt: 1 } }
      );
      stats.failed24++;
      console.warn("24h reminder send failed", {
        booking: bookingLogShape(booking),
        error: errorDetails(error),
      });
    }
  }

  const notSkipped = emptyField("reminder24hSkippedAt");
  const tooLate = await Booking.find({
    status: /^confirmed$/i,
    date: { $gt: now, $lte: catchupFloor },
    $and: [notSent, notSkipped],
  })
    .select("_id bookingNumber status date email")
    .limit(100)
    .lean();

  for (const booking of tooLate) {
    const eligibility = evaluate24HourReminder(booking, now);
    if (!eligibility.shouldMarkSkipped) continue;
    const result = await Booking.updateOne(
      {
        _id: booking._id,
        status: /^confirmed$/i,
        $and: [notSent, notSkipped],
      },
      {
        $set: {
          reminder24hSkippedAt: new Date(),
          reminder24hSkipReason: eligibility.reason,
        },
        $unset: { reminder24hQueuedAt: 1 },
      }
    );
    if (result.modifiedCount === 1) {
      console.log("24h reminder skipped", {
        ...bookingLogShape(booking),
        reason: eligibility.reason,
      });
    }
  }
}

async function process60MinuteReminders(now, stats) {
  const from = new Date(now.getTime() - REMINDER_WINDOW_MS);
  const to = new Date(
    now.getTime() + REMINDER_60M_MS + REMINDER_WINDOW_MS
  );
  const staleBefore = new Date(now.getTime() - REMINDER_LOCK_STALE_MS);
  const notSent = emptyField("reminder60mSentAt");
  const lockAvailable = availableLock("reminder60mQueuedAt", staleBefore);

  const candidates = await Booking.find({
    status: /^confirmed$/i,
    date: { $gte: from, $lte: to },
    $and: [notSent, lockAvailable],
  })
    .select(
      "status userId name email phone bookingNumber date service address city state zip reminder60mQueuedAt reminder60mSentAt"
    )
    .limit(50)
    .lean();

  stats.scanned60 = candidates.length;
  const staleLocks = candidates.filter(
    (booking) =>
      booking.reminder60mQueuedAt &&
      new Date(booking.reminder60mQueuedAt) <= staleBefore
  );
  console.log("60m reminder candidates found", {
    from: from.toISOString(),
    to: to.toISOString(),
    candidates: candidates.length,
    staleLocksRecoverable: staleLocks.length,
  });
  if (staleLocks.length) {
    console.warn("60m reminder lock recovery", {
      bookings: staleLocks.map(bookingLogShape),
    });
  }

  for (const booking of candidates) {
    const eligibility = evaluate60MinuteReminder(booking, now);
    if (!eligibility.eligible) {
      stats.notDue60++;
      console.log("60m reminder skipped", {
        ...bookingLogShape(booking),
        reason: eligibility.reason,
      });
      continue;
    }

    const lockTime = new Date();
    const claim = await Booking.updateOne(
      {
        _id: booking._id,
        status: /^confirmed$/i,
        date: { $gte: from, $lte: to },
        $and: [notSent, lockAvailable],
      },
      { $set: { reminder60mQueuedAt: lockTime } }
    );
    if (claim.modifiedCount !== 1) {
      stats.locked60++;
      continue;
    }

    stats.matched60++;
    try {
      const stillConfirmed = await Booking.exists({
        _id: booking._id,
        status: /^confirmed$/i,
        reminder60mQueuedAt: lockTime,
        $and: [notSent],
      });
      if (!stillConfirmed) {
        await Booking.updateOne(
          { _id: booking._id, reminder60mQueuedAt: lockTime },
          { $unset: { reminder60mQueuedAt: 1 } }
        );
        stats.notDue60++;
        continue;
      }

      console.log("Processing 60m reminder", bookingLogShape(booking));
      await sendReminderEmail({
        templateKey: "booking_reminder_60m",
        booking,
        vars: {
          name: booking.name || "there",
          date: booking.date,
        },
      });

      await Booking.updateOne(
        { _id: booking._id, reminder60mQueuedAt: lockTime },
        {
          $set: { reminder60mSentAt: new Date() },
          $unset: { reminder60mQueuedAt: 1 },
        }
      );

      try {
        await sendReminderSmsTag({ booking, tag: "reminder_60m" });
      } catch (error) {
        console.warn("60m GHL tag failed after email sent", {
          booking: bookingLogShape(booking),
          error: errorDetails(error),
        });
      }

      stats.sent60++;
      console.log("60m reminder sent success", bookingLogShape(booking));
      await sleep(80);
    } catch (error) {
      await Booking.updateOne(
        { _id: booking._id, reminder60mQueuedAt: lockTime },
        { $unset: { reminder60mQueuedAt: 1 } }
      );
      stats.failed60++;
      console.warn("60m reminder send failed", {
        booking: bookingLogShape(booking),
        error: errorDetails(error),
      });
    }
  }
}

async function runBookingReminderCycle(now = new Date()) {
  const stats = {
    scanned24: 0,
    matched24: 0,
    notDue24: 0,
    locked24: 0,
    sent24: 0,
    failed24: 0,
    scanned60: 0,
    matched60: 0,
    notDue60: 0,
    locked60: 0,
    sent60: 0,
    failed60: 0,
  };

  console.log("Booking reminder job cycle started", {
    serverTime: now.toISOString(),
    newYorkTime: now.toLocaleString("en-US", {
      timeZone: "America/New_York",
    }),
  });

  await process24HourReminders(now, stats);
  await process60MinuteReminders(now, stats);

  console.log("Booking reminder cycle summary", stats);
  return stats;
}

function startBookingReminders() {
  let running = false;

  cron.schedule(
    "* * * * *",
    async () => {
      if (running) {
        console.log("Booking reminder cycle skipped: prior local cycle still running");
        return;
      }
      running = true;
      try {
        await runBookingReminderCycle(new Date());
      } catch (error) {
        console.error("Booking reminders cron failed", errorDetails(error));
      } finally {
        running = false;
      }
    },
    { timezone: "America/New_York" }
  );

  console.log("Booking reminder cron started", {
    schedule: "* * * * *",
    timezone: "America/New_York",
  });
}

module.exports = {
  runBookingReminderCycle,
  startBookingReminders,
};
