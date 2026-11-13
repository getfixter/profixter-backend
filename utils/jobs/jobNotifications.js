/**
 * Customer notices for Admin job actions, with an honest per-channel result.
 *
 * Every function returns { channel, status, reason } where status is
 *   "sent"    - handed to the provider,
 *   "skipped" - deliberately not sent (no address, switched off, suppressed by
 *               consent rules, already sent, texting disabled on this server),
 *   "failed"  - we tried and the provider or the template failed.
 * so the Jobs screen can say "no usable channel" instead of implying the
 * customer was told. Nothing here throws.
 *
 * The templates and senders are the existing ones (utils/emailService sendTx,
 * utils/sms/smsNotifications), so logging, suppression, the customer's
 * service-email switch and consent rules are exactly those of every other
 * booking notice.
 */
const User = require("../../models/User");
const mail = require("../emailService");
const smsNotify = require("../sms/smsNotifications");
const { tipUrlForBooking } = require("../fixterTips");

function addressLine(booking) {
  return [booking.address, booking.city, booking.state, booking.zip].filter(Boolean).join(", ");
}

/** The account behind a booking, by its id; never by the empty userId a guest booking has. */
async function bookingAccount(booking) {
  if (booking?.user) {
    const id = booking.user._id || booking.user;
    return User.findById(id).lean();
  }
  if (booking?.userId) return User.findOne({ userId: booking.userId }).lean();
  return null;
}

function smsOutcome(result) {
  const status = String(result?.status || "");
  if (status === "sent") return { channel: "sms", status: "sent", reason: "" };
  if (status === "simulated") return { channel: "sms", status: "skipped", reason: "sms_disabled_on_server" };
  if (status === "suppressed") return { channel: "sms", status: "skipped", reason: String(result.reason || "suppressed") };
  if (status === "duplicate") return { channel: "sms", status: "skipped", reason: "already_sent" };
  if (status === "retry_scheduled") return { channel: "sms", status: "failed", reason: "provider_error_retrying" };
  return { channel: "sms", status: "failed", reason: String(result?.reason || result?.error || "sms_failed").slice(0, 200) };
}

function skipped(channel, reason) {
  return { channel, status: "skipped", reason };
}

/** One transactional booking email. `extraVars` are merged over the booking's own. */
async function sendBookingEmail(templateKey, booking, { account = null, source, extraVars = {} } = {}) {
  const to = booking.email || account?.email || "";
  if (!to) return skipped("email", "no_email_on_file");
  try {
    const result = await mail.sendTx(
      templateKey,
      to,
      {
        name: booking.name || account?.name || String(to).split("@")[0],
        bookingNumber: booking.bookingNumber,
        date: booking.date,
        service: booking.service,
        selectedTask: booking.selectedTask,
        bookingType: booking.bookingType,
        accessType: booking.accessType,
        freeVisitPurpose: booking.freeVisitPurpose || "",
        status: booking.status,
        address: addressLine(booking),
        ...extraVars,
      },
      {
        bccAdmin: false,
        logContext: {
          bookingId: booking._id,
          bookingNumber: booking.bookingNumber,
          customerName: booking.name || account?.name || "",
          customerEmail: to,
          recipientName: booking.name || account?.name || "",
          recipientEmail: to,
          emailType: "transactional",
          source,
        },
      }
    );
    if (result?.suppressed) return skipped("email", String(result.reason || "suppressed"));
    return { channel: "email", status: "sent", reason: "" };
  } catch (error) {
    console.error(`${templateKey} email failed:`, error.message);
    return { channel: "email", status: "failed", reason: String(error?.message || "email_failed").slice(0, 200) };
  }
}

const STATUS_TEMPLATE = {
  confirmed: "booking_confirmed",
  completed: "booking_completed",
  canceled: "booking_canceled",
};

/** The email + text for a status the job just reached. */
async function notifyStatus(booking, status, { source }) {
  const key = String(status || "").toLowerCase();
  const account = await bookingAccount(booking).catch(() => null);
  const templateKey = STATUS_TEMPLATE[key];
  const out = [];
  out.push(
    templateKey
      ? await sendBookingEmail(templateKey, booking, {
          account,
          source,
          // Only the completion email carries the tip link that attributes a tip to this visit's Fixter.
          extraVars: key === "completed" ? { tipUrl: tipUrlForBooking(booking) } : {},
        })
      : skipped("email", "no_template_for_status")
  );
  let sms;
  if (key === "confirmed") sms = await smsNotify.notifyBookingConfirmed(booking, account, source);
  else if (key === "completed") sms = await smsNotify.notifyBookingCompleted(booking, account, source);
  else if (key === "canceled") sms = await smsNotify.notifyBookingCancelled(booking, account, source);
  out.push(sms ? smsOutcome(sms) : skipped("sms", "no_template_for_status"));
  return out;
}

/**
 * The reschedule notice (J-09). The email goes for a Pending or Confirmed job;
 * the text keeps its existing rule - Confirmed only - because a customer who
 * was never told a confirmed time has no confirmed time to be told about.
 */
async function notifyRescheduled(booking, { previousDate = null, source }) {
  const account = await bookingAccount(booking).catch(() => null);
  const email = await sendBookingEmail("booking_rescheduled", booking, {
    account,
    source,
    extraVars: { previousDate },
  });
  const sms = /^confirmed$/i.test(String(booking.status || ""))
    ? smsOutcome(await smsNotify.notifyBookingRescheduled(booking, account, source))
    : skipped("sms", "not_confirmed");
  return [email, sms];
}

/** The "your Fixter is ..." text, for a Confirmed job whose Fixter changed. */
async function notifyAssignment(booking, { previousFixterId, source }) {
  if (!/^confirmed$/i.test(String(booking.status || ""))) return skipped("sms", "not_confirmed");
  if (!booking.assignedFixterId) return skipped("sms", "unassigned");
  const account = await bookingAccount(booking).catch(() => null);
  const result = await smsNotify.notifyFixterAssignment(booking, {
    user: account,
    fixterId: booking.assignedFixterId,
    fixterName: booking.assignedFixterName,
    isChange: Boolean(previousFixterId),
    source,
  });
  return smsOutcome(result);
}

function notRequested() {
  return [skipped("email", "not_requested"), skipped("sms", "not_requested")];
}

module.exports = {
  addressLine,
  bookingAccount,
  notRequested,
  notifyAssignment,
  notifyRescheduled,
  notifyStatus,
  sendBookingEmail,
  smsOutcome,
};
