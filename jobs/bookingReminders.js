// backend/jobs/bookingReminders.js
const cron = require("node-cron");
const Booking = require("../models/Booking");
const User = require("../models/User");
const { sendTx } = require("../utils/emailService");

const {
  createOrUpdateContact,
  updateContactFields,
  formatBookingDateTime,
  addTag,
} = require("../utils/ghlContact");

function buildAddress(b) {
  return [b.address, b.city, b.state, b.zip]
    .map((v) => String(v || "").trim())
    .filter(Boolean)
    .join(", ");
}

function safeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function bookingLogShape(b) {
  return {
    bookingId: String(b._id || ""),
    bookingNumber: b.bookingNumber || "",
    userId: b.userId || "",
    name: b.name || "",
    email: b.email || "",
    phone: b.phone || "",
    service: b.service || "",
    date: b.date || null,
    address: buildAddress(b),
  };
}

function errorDetails(err) {
  return {
    message: err?.message || "Unknown error",
    stack: err?.stack || "",
    name: err?.name || "",
    code: err?.code || "",
    response: err?.response || "",
    responseCode: err?.responseCode || "",
    command: err?.command || "",
  };
}

function isConfirmedStatus(status) {
  return String(status || "").trim().toLowerCase() === "confirmed";
}

function isTerminalStatus(status) {
  return [
    "canceled",
    "cancelled",
    "completed",
    "complete",
    "done",
    "no-show",
    "noshow",
    "failed",
  ].includes(String(status || "").trim().toLowerCase());
}

async function sendReminderEmail({ templateKey, booking, vars }) {
  const to = safeEmail(booking.email);

  if (!to) {
    throw new Error(`Missing customer email for booking ${booking._id}`);
  }

  console.log(`📧 Sending ${templateKey} email`, {
    to,
    ...bookingLogShape(booking),
  });

  const info = await sendTx(templateKey, to, vars);

  console.log(`✅ ${templateKey} email sent`, {
    to,
    messageId: info?.messageId || "",
    ...bookingLogShape(booking),
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
    throw new Error(
      `Could not create/update GHL contact for booking ${booking._id}`
    );
  }

  const pretty = formatBookingDateTime(booking.date);

  const updated = await updateContactFields(contactId, [
    {
      key: "booking_datetime_pretty",
      value: pretty,
    },
  ]);

  if (!updated) {
    throw new Error(
      `Failed updating GHL custom fields for contact ${contactId} booking ${booking._id}`
    );
  }

  const tagAdded = await addTag(contactId, tag);

  if (!tagAdded) {
    throw new Error(
      `Failed adding GHL tag ${tag} for contact ${contactId} booking ${booking._id}`
    );
  }

  console.log(`✅ GHL reminder tag added`, {
    tag,
    contactId,
    pretty,
    ...bookingLogShape(booking),
  });
}

function startBookingReminders() {
  let running = false;

  cron.schedule(
    "* * * * *",
    async () => {
      if (running) return;
      running = true;

      const now = new Date();
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

      const WINDOW_MS = 15 * 60 * 1000;
      const STALE_LOCK_MS = 10 * 60 * 1000;
      const HOUR_MS = 60 * 60 * 1000;
      const REMINDER_24H_MS = 24 * HOUR_MS;
      const REMINDER_60M_MS = 1 * HOUR_MS;

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

      try {
        // ===================== 24h reminders =====================
        // Robust window:
        // - never send before the booking crosses the 24h threshold
        // - keep trying if that threshold was missed (restart/deploy/downtime)
        // - stop once the booking is too close to the 60m reminder window
        const earliest24Booking = new Date(now.getTime() + REMINDER_60M_MS + WINDOW_MS);
        const latest24Booking = new Date(now.getTime() + REMINDER_24H_MS + WINDOW_MS);

        const candidates24 = await Booking.find({
          status: /^confirmed$/i,
          date: { $gt: earliest24Booking, $lte: latest24Booking },
          reminder24hSentAt: { $exists: false },
          $or: [
            { reminder24hQueuedAt: { $exists: false } },
            {
              reminder24hQueuedAt: {
                $lte: new Date(now.getTime() - STALE_LOCK_MS),
              },
            },
          ],
        })
          .select(
            "status userId name email phone bookingNumber date service address city state zip reminder24hQueuedAt reminder24hSentAt"
          )
          .limit(50)
          .lean();

        stats.scanned24 = candidates24.length;

        for (const b of candidates24) {
          if (!isConfirmedStatus(b.status) || isTerminalStatus(b.status)) {
            stats.notDue24++;
            continue;
          }

          const msUntilBooking = new Date(b.date).getTime() - now.getTime();
          const hasCrossed24hThreshold = msUntilBooking <= REMINDER_24H_MS + WINDOW_MS;
          const stillBefore60mWindow = msUntilBooking > REMINDER_60M_MS + WINDOW_MS;

          if (!hasCrossed24hThreshold || !stillBefore60mWindow) {
            stats.notDue24++;
            continue;
          }

          stats.matched24++;

          const claim = await Booking.updateOne(
            {
              _id: b._id,
              status: /^confirmed$/i,
              reminder24hSentAt: { $exists: false },
              $or: [
                { reminder24hQueuedAt: { $exists: false } },
                {
                  reminder24hQueuedAt: {
                    $lte: new Date(now.getTime() - STALE_LOCK_MS),
                  },
                },
              ],
            },
            { $set: { reminder24hQueuedAt: new Date() } }
          );

          if (claim.modifiedCount !== 1) {
            stats.locked24++;
            continue;
          }

          try {
            console.log("⏳ Processing 24h reminder", bookingLogShape(b));

            await sendReminderEmail({
              templateKey: "booking_reminder_24h",
              booking: b,
              vars: {
                name: b.name || "there",
                bookingNumber: b.bookingNumber,
                date: b.date,
                service: b.service,
                address: buildAddress(b),
              },
            });

            // Mark sent immediately after email succeeds.
            // This prevents duplicate emails if the GHL step below throws.
            await Booking.updateOne(
              { _id: b._id },
              {
                $set: { reminder24hSentAt: new Date() },
                $unset: { reminder24hQueuedAt: 1 },
              }
            );

            // GHL tag is secondary — log failures but do not retry the whole reminder.
            try {
              await sendReminderSmsTag({ booking: b, tag: "reminder_24h" });
            } catch (ghlErr) {
              console.warn("⚠️ 24h GHL tag failed (email already sent, will not retry)", {
                booking: bookingLogShape(b),
                error: errorDetails(ghlErr),
              });
            }

            console.log("✅ 24h reminder finished", bookingLogShape(b));
            stats.sent24++;
            await sleep(80);
          } catch (e) {
            await Booking.updateOne(
              { _id: b._id },
              { $unset: { reminder24hQueuedAt: 1 } }
            );

            console.warn("❌ 24h reminder send failed", {
              booking: bookingLogShape(b),
              error: errorDetails(e),
            });
            stats.failed24++;
          }
        }

        // ===================== 60m reminders =====================
        const from60 = new Date(now.getTime() - WINDOW_MS);
        const to60 = new Date(now.getTime() + REMINDER_60M_MS + WINDOW_MS);

        const candidates60 = await Booking.find({
          status: /^confirmed$/i,
          date: { $gte: from60, $lte: to60 },
          reminder60mSentAt: { $exists: false },
          $or: [
            { reminder60mQueuedAt: { $exists: false } },
            {
              reminder60mQueuedAt: {
                $lte: new Date(now.getTime() - STALE_LOCK_MS),
              },
            },
          ],
        })
          .select(
            "status userId name email phone bookingNumber date service address city state zip reminder60mQueuedAt reminder60mSentAt"
          )
          .limit(50)
          .lean();

        stats.scanned60 = candidates60.length;

        for (const b of candidates60) {
          if (!isConfirmedStatus(b.status) || isTerminalStatus(b.status)) {
            stats.notDue60++;
            continue;
          }

          const msUntilBooking = new Date(b.date).getTime() - now.getTime();
          const hasCrossed60mThreshold = msUntilBooking <= REMINDER_60M_MS + WINDOW_MS;
          const notTooLate = msUntilBooking >= -WINDOW_MS;

          if (!hasCrossed60mThreshold || !notTooLate) {
            stats.notDue60++;
            continue;
          }

          stats.matched60++;

          const claim = await Booking.updateOne(
            {
              _id: b._id,
              status: /^confirmed$/i,
              reminder60mSentAt: { $exists: false },
              $or: [
                { reminder60mQueuedAt: { $exists: false } },
                {
                  reminder60mQueuedAt: {
                    $lte: new Date(now.getTime() - STALE_LOCK_MS),
                  },
                },
              ],
            },
            { $set: { reminder60mQueuedAt: new Date() } }
          );

          if (claim.modifiedCount !== 1) {
            stats.locked60++;
            continue;
          }

          try {
            console.log("⏳ Processing 60m reminder", bookingLogShape(b));

            await sendReminderEmail({
              templateKey: "booking_reminder_60m",
              booking: b,
              vars: {
                name: b.name || "there",
                date: b.date,
              },
            });

            // Mark sent immediately after email succeeds.
            // This prevents duplicate emails if the GHL step below throws.
            await Booking.updateOne(
              { _id: b._id },
              {
                $set: { reminder60mSentAt: new Date() },
                $unset: { reminder60mQueuedAt: 1 },
              }
            );

            // GHL tag is secondary — log failures but do not retry the whole reminder.
            try {
              await sendReminderSmsTag({ booking: b, tag: "reminder_60m" });
            } catch (ghlErr) {
              console.warn("⚠️ 60m GHL tag failed (email already sent, will not retry)", {
                booking: bookingLogShape(b),
                error: errorDetails(ghlErr),
              });
            }

            console.log("✅ 60m reminder finished", bookingLogShape(b));
            stats.sent60++;
            await sleep(80);
          } catch (e) {
            await Booking.updateOne(
              { _id: b._id },
              { $unset: { reminder60mQueuedAt: 1 } }
            );

            console.warn("❌ 60m reminder send failed", {
              booking: bookingLogShape(b),
              error: errorDetails(e),
            });
            stats.failed60++;
          }
        }

        if (
          stats.scanned24 ||
          stats.scanned60 ||
          stats.sent24 ||
          stats.sent60 ||
          stats.failed24 ||
          stats.failed60
        ) {
          console.log("📨 Booking reminder cycle summary", {
            nowIso: now.toISOString(),
            nowNY: now.toLocaleString("en-US", {
              timeZone: "America/New_York",
            }),
            twentyFourHour: {
              scanned: stats.scanned24,
              matchedWindow: stats.matched24,
              skippedNotDue: stats.notDue24,
              skippedLocked: stats.locked24,
              sent: stats.sent24,
              failed: stats.failed24,
            },
            sixtyMinute: {
              scanned: stats.scanned60,
              matchedWindow: stats.matched60,
              skippedNotDue: stats.notDue60,
              skippedLocked: stats.locked60,
              sent: stats.sent60,
              failed: stats.failed60,
            },
          });
        }
      } catch (e) {
        console.error("Booking reminders cron failed:", {
          error: errorDetails(e),
        });
      } finally {
        running = false;
      }
    },
    { timezone: "America/New_York" }
  );

  console.log("⏰ Booking reminder cron started");
}

module.exports = { startBookingReminders };
