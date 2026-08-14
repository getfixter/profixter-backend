const cron = require("node-cron");
const Booking = require("../models/Booking");
const User = require("../models/User");
const { sendTx } = require("../utils/emailService");
const {
  REMINDER_24H_LEAD_MS,
  REMINDER_24H_MIN_LEAD_MS,
  REMINDER_60M_GRACE_AFTER_START_MS,
  REMINDER_60M_LEAD_MS,
  REMINDER_LOCK_STALE_MS,
  REMINDER_MAX_ATTEMPTS,
  evaluate24HourReminder,
  evaluate60MinuteReminder,
  evaluateTagRetry,
} = require("../utils/bookingReminderPolicy");
const {
  createOrUpdateContact,
  updateContactFields,
  formatBookingDateTime,
  addTag,
} = require("../utils/ghlContact");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The two reminder sweeps.
 *
 * Each sweep asks one question: which bookings are due a reminder they have not
 * successfully received? Not "which bookings fall inside the slice of time this
 * particular cron tick happens to be looking at", which is what the previous
 * implementation asked and why a deploy or a crash could destroy a reminder
 * permanently and silently.
 *
 * The two sweeps are independent. They were previously awaited in sequence in
 * one try block, so a throw in the 24-hour sweep skipped the 60-minute sweep
 * for that cycle without either being logged as a failure.
 */

const SELECT_FIELDS = [
  "status userId name email phone bookingNumber date service selectedTask",
  "bookingType accessType address city state zip",
  "reminder24hQueuedAt reminder24hSentAt reminder24hSkippedAt reminder24hAttempts",
  "reminder60mQueuedAt reminder60mSentAt reminder60mSkippedAt reminder60mAttempts",
].join(" ");

const REMINDERS = {
  "24h": {
    label: "24h",
    templateKey: "booking_reminder_24h",
    ghlTag: "reminder_24h",
    leadMs: REMINDER_24H_LEAD_MS,
    queuedField: "reminder24hQueuedAt",
    sentField: "reminder24hSentAt",
    skippedField: "reminder24hSkippedAt",
    skipReasonField: "reminder24hSkipReason",
    attemptsField: "reminder24hAttempts",
    lastErrorField: "reminder24hLastError",
    messageIdField: "reminder24hMessageId",
    tagField: "reminder24hTagAt",
    tagAttemptsField: "reminder24hTagAttempts",
    tagErrorField: "reminder24hTagError",
    evaluate: evaluate24HourReminder,
    /*
     * Selection bounds. The upper bound is "due", the lower bound is "still
     * worth sending". Between them the reminder stays selectable on every
     * cycle, which is what makes an outage recoverable rather than fatal.
     */
    dateRange: (now) => ({
      $gt: new Date(now.getTime() + REMINDER_24H_MIN_LEAD_MS),
      $lte: new Date(now.getTime() + REMINDER_24H_LEAD_MS),
    }),
    /*
     * Past the point of usefulness and never sent: give it a terminal reason.
     * Reaches back six hours so an appointment that has already happened also
     * gets one, rather than sitting undecided forever with no record of why it
     * was never reminded.
     */
    abandonRange: (now) => ({
      $gt: new Date(now.getTime() - 6 * 60 * 60 * 1000),
      $lte: new Date(now.getTime() + REMINDER_24H_MIN_LEAD_MS),
    }),
  },
  "60m": {
    label: "60m",
    templateKey: "booking_reminder_60m",
    ghlTag: "reminder_60m",
    leadMs: REMINDER_60M_LEAD_MS,
    queuedField: "reminder60mQueuedAt",
    sentField: "reminder60mSentAt",
    skippedField: "reminder60mSkippedAt",
    skipReasonField: "reminder60mSkipReason",
    attemptsField: "reminder60mAttempts",
    lastErrorField: "reminder60mLastError",
    messageIdField: "reminder60mMessageId",
    tagField: "reminder60mTagAt",
    tagAttemptsField: "reminder60mTagAttempts",
    tagErrorField: "reminder60mTagError",
    evaluate: evaluate60MinuteReminder,
    dateRange: (now) => ({
      $gte: new Date(now.getTime() - REMINDER_60M_GRACE_AFTER_START_MS),
      $lte: new Date(now.getTime() + REMINDER_60M_LEAD_MS),
    }),
    abandonRange: (now) => ({
      $gt: new Date(now.getTime() - 6 * 60 * 60 * 1000),
      $lt: new Date(now.getTime() - REMINDER_60M_GRACE_AFTER_START_MS),
    }),
  },
};

function buildAddress(booking) {
  return [booking.address, booking.city, booking.state, booking.zip]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(", ");
}

function safeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

/**
 * What a reminder attempt is allowed to write to the log.
 *
 * The domain, never the address: enough to tell an SES suppression from a typo
 * without putting a customer's email in a log aggregator.
 */
function bookingLogShape(booking) {
  const email = safeEmail(booking.email);
  return {
    bookingId: String(booking._id || ""),
    bookingNumber: booking.bookingNumber || "",
    status: booking.status || "",
    appointmentAt: booking.date ? new Date(booking.date).toISOString() : null,
    emailDomain: email.includes("@") ? email.split("@").pop() : "",
  };
}

function errorDetails(error) {
  return {
    message: String(error?.message || "Unknown error").slice(0, 300),
    name: error?.name || "",
    code: error?.code || "",
    responseCode: error?.responseCode || "",
  };
}

function emptyField(field) {
  return { $or: [{ [field]: { $exists: false } }, { [field]: null }] };
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
  return sendTx(templateKey, to, vars, {
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
}

/**
 * Apply the CRM tag that triggers the SMS, and record that channel separately.
 *
 * Returns rather than throws: the email has already been delivered by the time
 * this runs, and an exception here would roll the caller into a retry that
 * resends it. A failure is recorded and left for the tag-only sweep.
 */
async function applyReminderTag(config, booking, stats) {
  /*
   * Claim by writing the completion field up front, then undo it if the call
   * fails. Only one worker can win that conditional update, so four EB
   * instances racing the same booking produce one tag and therefore one SMS.
   * Incrementing a counter first and then calling out would let every worker
   * through, which is exactly what the concurrency test caught.
   *
   * The residual risk is a crash between the claim and the CRM call, which
   * leaves the tag recorded but unsent. The email has already gone by then, and
   * an unsent text is a smaller harm than a duplicated one, so this errs that
   * way deliberately.
   */
  const claim = await Booking.updateOne(
    { _id: booking._id, [config.tagField]: null },
    {
      $set: { [config.tagField]: new Date() },
      $inc: { [config.tagAttemptsField]: 1 },
    }
  );
  if (claim.modifiedCount !== 1) return false;

  try {
    await sendReminderSmsTag({ booking, tag: config.ghlTag });
    await Booking.updateOne(
      { _id: booking._id },
      { $set: { [config.tagErrorField]: "" } }
    );
    stats.tagged += 1;
    console.log(
      JSON.stringify({
        event: "reminder_tag_applied",
        reminder: config.label,
        tag: config.ghlTag,
        ...bookingLogShape(booking),
      })
    );
    return true;
  } catch (error) {
    // Release the claim so a later cycle retries the tag, without touching the
    // email, which has already been delivered.
    await Booking.updateOne(
      { _id: booking._id },
      {
        $set: {
          [config.tagField]: null,
          [config.tagErrorField]: String(error?.message || "").slice(0, 300),
        },
      }
    );
    stats.tagFailed += 1;
    console.warn(
      JSON.stringify({
        event: "reminder_tag_failed",
        reminder: config.label,
        tag: config.ghlTag,
        ...bookingLogShape(booking),
        error: errorDetails(error),
      })
    );
    return false;
  }
}

/**
 * Retry the SMS tag for reminders whose email already went out.
 *
 * This is the pass that makes the two channels genuinely independent. Without
 * it, a CRM outage would mean the customer got the email and never the text,
 * with nothing in the system that could put that right.
 */
async function retryPendingTags(config, now, stats) {
  const candidates = await Booking.find({
    [config.sentField]: { $ne: null },
    [config.tagField]: null,
    date: { $gt: new Date(now.getTime() - REMINDER_60M_GRACE_AFTER_START_MS) },
    [config.tagAttemptsField]: { $lt: REMINDER_MAX_ATTEMPTS },
  })
    .select(SELECT_FIELDS + ` ${config.tagField} ${config.tagAttemptsField}`)
    .limit(50)
    .lean();

  for (const booking of candidates) {
    const verdict = evaluateTagRetry(booking, config.label, now);
    if (!verdict.eligible) continue;
    await applyReminderTag(config, booking, stats);
    await sleep(80);
  }
}

/** Give one booking's reminder a terminal reason, once. */
async function abandonOne(config, booking, reason, stats) {
  const result = await Booking.updateOne(
    {
      _id: booking._id,
      $and: [emptyField(config.sentField), emptyField(config.skippedField)],
    },
    {
      $set: {
        [config.skippedField]: new Date(),
        [config.skipReasonField]: reason,
      },
      $unset: { [config.queuedField]: 1 },
    }
  );
  if (result.modifiedCount !== 1) return false;
  stats.abandoned += 1;
  console.log(
    JSON.stringify({
      event: "reminder_abandoned",
      reminder: config.label,
      reason,
      ...bookingLogShape(booking),
    })
  );
  return true;
}

/**
 * Abandon reminders that can no longer be delivered usefully.
 *
 * Recording the reason is the point. A reminder that was never sent because the
 * booking was confirmed ninety minutes beforehand is a decision; one that
 * vanished because a cron tick did not happen is a defect, and previously both
 * looked identical from the outside.
 *
 * This pass catches bookings the send sweep does not select at all, because
 * they sit outside its range. Ones it does select are settled inline.
 */
async function markAbandoned(config, now, stats) {
  const candidates = await Booking.find({
    status: /^confirmed$/i,
    date: config.abandonRange(now),
    $and: [emptyField(config.sentField), emptyField(config.skippedField)],
  })
    .select(`_id bookingNumber status date email ${config.attemptsField}`)
    .limit(200)
    .lean();

  for (const booking of candidates) {
    const verdict = config.evaluate(booking, now);
    if (!verdict.shouldMarkSkipped) continue;
    await abandonOne(config, booking, verdict.reason, stats);
  }
}

async function processReminder(kind, now, stats) {
  const config = REMINDERS[kind];
  const staleBefore = new Date(now.getTime() - REMINDER_LOCK_STALE_MS);
  const notSent = emptyField(config.sentField);
  const notSkipped = emptyField(config.skippedField);
  const lockAvailable = availableLock(config.queuedField, staleBefore);

  const selector = {
    status: /^confirmed$/i,
    date: config.dateRange(now),
    $and: [notSent, notSkipped, lockAvailable],
  };

  const candidates = await Booking.find(selector)
    .select(SELECT_FIELDS)
    .sort({ date: 1 })
    .limit(200)
    .lean();

  stats.scanned = candidates.length;

  for (const booking of candidates) {
    const verdict = config.evaluate(booking, now);
    if (!verdict.eligible) {
      // Settle it here if it is finished, rather than leaving it to be
      // re-examined every minute for the rest of its life. This is what stops a
      // booking that has exhausted its retries from being reconsidered forever.
      if (verdict.shouldMarkSkipped) {
        await abandonOne(config, booking, verdict.reason, stats);
      } else {
        stats.notDue += 1;
      }
      continue;
    }

    // Claim it. The same conditions as the selector, so two workers racing the
    // same booking produce one winner and one no-op rather than two emails.
    const lockTime = new Date();
    const claim = await Booking.updateOne(
      {
        _id: booking._id,
        status: /^confirmed$/i,
        $and: [notSent, notSkipped, lockAvailable],
      },
      {
        $set: { [config.queuedField]: lockTime },
        $inc: { [config.attemptsField]: 1 },
      }
    );
    if (claim.modifiedCount !== 1) {
      stats.locked += 1;
      continue;
    }

    stats.claimed += 1;
    const startedAt = Date.now();
    try {
      const info = await sendReminderEmail({
        templateKey: config.templateKey,
        booking,
        vars: {
          name: booking.name || "there",
          bookingNumber: booking.bookingNumber,
          date: booking.date,
          service: booking.service,
          selectedTask: booking.selectedTask,
          bookingType: booking.bookingType,
          accessType: booking.accessType,
          address: buildAddress(booking),
        },
      });

      /*
       * Recorded only after the provider accepted it. The old order marked the
       * reminder sent and then tried to send, so a provider outage consumed the
       * reminder without delivering it and nothing ever retried.
       */
      await Booking.updateOne(
        { _id: booking._id, [config.queuedField]: lockTime },
        {
          $set: {
            [config.sentField]: new Date(),
            [config.messageIdField]: String(info?.messageId || "").slice(0, 200),
            [config.lastErrorField]: "",
          },
          $unset: { [config.queuedField]: 1 },
        }
      );

      stats.sent += 1;
      console.log(
        JSON.stringify({
          event: "reminder_sent",
          reminder: config.label,
          mode: verdict.mode,
          minutesBefore: Math.round(verdict.msUntilBooking / 60000),
          durationMs: Date.now() - startedAt,
          messageId: info?.messageId || "",
          ...bookingLogShape(booking),
        })
      );

      // The tag is what makes the SMS go out, so it is tracked in its own
      // fields. Failing it must never undo or repeat the email; the tag-only
      // sweep below retries it on the next cycle.
      await applyReminderTag(config, booking, stats);
      await sleep(80);
    } catch (error) {
      // Release the lock so the next cycle retries, and keep the incremented
      // attempt count so a permanently failing address eventually stops.
      await Booking.updateOne(
        { _id: booking._id, [config.queuedField]: lockTime },
        {
          $set: {
            [config.lastErrorField]: String(error?.message || "").slice(0, 300),
          },
          $unset: { [config.queuedField]: 1 },
        }
      );
      stats.failed += 1;
      console.warn(
        JSON.stringify({
          event: "reminder_send_failed",
          reminder: config.label,
          attempt: Number(booking[config.attemptsField] || 0) + 1,
          ...bookingLogShape(booking),
          error: errorDetails(error),
        })
      );
    }
  }

  await markAbandoned(config, now, stats);
  await retryPendingTags(config, now, stats);
}

function emptyStats() {
  return {
    scanned: 0,
    claimed: 0,
    notDue: 0,
    locked: 0,
    sent: 0,
    failed: 0,
    abandoned: 0,
    tagged: 0,
    tagFailed: 0,
  };
}

/**
 * One cycle.
 *
 * Each sweep is isolated, so one failing cannot silence the other, and a sweep
 * that throws is reported as a failed sweep rather than disappearing into a
 * shared catch.
 */
async function runBookingReminderCycle(now = new Date()) {
  const stats = { "24h": emptyStats(), "60m": emptyStats(), sweepErrors: [] };

  for (const kind of ["24h", "60m"]) {
    try {
      await processReminder(kind, now, stats[kind]);
    } catch (error) {
      stats.sweepErrors.push(kind);
      console.error(
        JSON.stringify({
          event: "reminder_sweep_failed",
          reminder: kind,
          error: errorDetails(error),
        })
      );
    }
  }

  const noteworthy =
    stats.sweepErrors.length ||
    ["24h", "60m"].some(
      (k) => stats[k].sent || stats[k].failed || stats[k].abandoned || stats[k].tagged || stats[k].tagFailed
    );
  // A line a minute forever buries the lines that matter. Quiet cycles are
  // summarized on the heartbeat below instead.
  if (noteworthy) {
    console.log(
      JSON.stringify({
        event: "reminder_cycle",
        at: now.toISOString(),
        "24h": stats["24h"],
        "60m": stats["60m"],
        sweepErrors: stats.sweepErrors,
      })
    );
  }
  return stats;
}

/**
 * Proof the scheduler is alive.
 *
 * The failure this whole rewrite exists to survive is the process not running,
 * and the one thing a stopped process cannot do is complain. A periodic
 * heartbeat carrying the current backlog means silence itself becomes the
 * signal: no heartbeat for an hour means reminders are not being processed.
 */
async function logReminderHeartbeat(now = new Date()) {
  const [due24, due60] = await Promise.all([
    Booking.countDocuments({
      status: /^confirmed$/i,
      date: REMINDERS["24h"].dateRange(now),
      $and: [
        emptyField("reminder24hSentAt"),
        emptyField("reminder24hSkippedAt"),
      ],
    }),
    Booking.countDocuments({
      status: /^confirmed$/i,
      date: REMINDERS["60m"].dateRange(now),
      $and: [
        emptyField("reminder60mSentAt"),
        emptyField("reminder60mSkippedAt"),
      ],
    }),
  ]);
  console.log(
    JSON.stringify({
      event: "reminder_heartbeat",
      at: now.toISOString(),
      newYork: now.toLocaleString("en-US", { timeZone: "America/New_York" }),
      pending24h: due24,
      pending60m: due60,
    })
  );
  return { pending24h: due24, pending60m: due60 };
}

function startBookingReminders() {
  let running = false;

  cron.schedule(
    "* * * * *",
    async () => {
      if (running) {
        console.warn(
          JSON.stringify({ event: "reminder_cycle_overlapped" })
        );
        return;
      }
      running = true;
      try {
        await runBookingReminderCycle(new Date());
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "reminder_cron_failed",
            error: errorDetails(error),
          })
        );
      } finally {
        running = false;
      }
    },
    { timezone: "America/New_York" }
  );

  cron.schedule(
    "*/15 * * * *",
    async () => {
      try {
        await logReminderHeartbeat(new Date());
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "reminder_heartbeat_failed",
            error: errorDetails(error),
          })
        );
      }
    },
    { timezone: "America/New_York" }
  );

  console.log(
    JSON.stringify({
      event: "reminder_cron_started",
      cycle: "* * * * *",
      heartbeat: "*/15 * * * *",
      timezone: "America/New_York",
    })
  );
}

module.exports = {
  REMINDERS,
  logReminderHeartbeat,
  processReminder,
  runBookingReminderCycle,
  startBookingReminders,
};
