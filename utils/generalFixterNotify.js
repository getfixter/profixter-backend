const User = require("../models/User");
const adminSubjects = require("./adminSubjects");
const { ADMIN_BASE_URL, adminLink, renderOperationalEmail } = require("./operationalEmail");

/**
 * Booking notifications for General Fixters.
 *
 * They run the day, so they need to know when a booking appears and when one
 * disappears. Nothing else: no invoices, no memberships, no leads, no payment
 * internals. Two events, both operational, both readable from the subject line
 * without opening the email.
 *
 * This is additive. The Admin copy is sent exactly as it was before and is not
 * routed through here.
 */

/**
 * Addresses that must never receive the General Fixter copy.
 *
 * The owner holds a General Fixter account so they can work in the dashboard,
 * but they already receive the Admin notification for every one of these events
 * and a second copy would just be noise. Compared lowercase, because an address
 * typed with different capitalisation is the same mailbox.
 */
const NEVER_NOTIFY = new Set(["bandurataras1596@gmail.com"]);

const normalize = (email) => String(email || "").trim().toLowerCase();

/** Where the Admin copy goes, so a General Fixter at that address is not sent two. */
function adminDestination() {
  return normalize(process.env.MAIL_ADMIN || "getfixter@gmail.com");
}

/**
 * Every active General Fixter who should receive operational booking mail.
 *
 * Read from the database on every send rather than from a list, so a General
 * Fixter hired next year starts receiving these the moment their account
 * exists, and somebody deactivated stops immediately. No code change, no
 * redeploy, and nobody's name is written down anywhere.
 */
async function generalFixterRecipients() {
  const staff = await User.find({
    role: "employee",
    employeePosition: "General Fixter",
    isActive: { $ne: false },
  })
    .select("name firstName email")
    .lean();

  const blocked = new Set([...NEVER_NOTIFY, adminDestination()]);
  const seen = new Set();
  const recipients = [];

  for (const person of staff) {
    const email = normalize(person.email);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
    if (blocked.has(email)) continue;
    if (seen.has(email)) continue;
    seen.add(email);
    recipients.push({ email, name: person.firstName || person.name || "" });
  }

  return recipients;
}

/** Time in New York, which is the only timezone the crew works in. */
function whenLabel(date, withTime = true) {
  if (!date) return "";
  const value = new Date(date);
  if (Number.isNaN(value.getTime())) return "";
  const parts = { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" };
  const day = new Intl.DateTimeFormat("en-US", parts).format(value);
  if (!withTime) return day;
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "numeric", minute: "2-digit",
  }).format(value);
  return `${day}, ${time}`;
}

/** Customer notes are only worth carrying when they say something. */
function usefulNote(raw) {
  const note = String(raw || "").trim();
  if (!note || note.length < 3) return "";
  return note.length > 400 ? `${note.slice(0, 397)}...` : note;
}

/**
 * Send one operational notification to every General Fixter.
 *
 * Failures are logged and swallowed: a booking must never fail because a crew
 * notification could not be delivered. Each recipient is sent separately so one
 * bad address cannot suppress the others, and so nobody sees a colleague's
 * address in a To header.
 */
async function notifyGeneralFixters(mail, { subject, html, text, logContext = {} }) {
  const recipients = await generalFixterRecipients();
  if (!recipients.length) return { sent: 0, recipients: [] };

  let sent = 0;
  for (const person of recipients) {
    try {
      await mail.sendRaw({
        to: person.email,
        subject,
        html,
        text,
        logContext: {
          ...logContext,
          recipientEmail: person.email,
          recipientName: person.name,
          emailType: "general_fixter",
        },
      });
      sent += 1;
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "general_fixter_notify_failed",
          templateKey: logContext.templateKey || "",
          message: error?.message || "",
        })
      );
    }
  }
  return { sent, recipients: recipients.map((r) => r.email) };
}

/**
 * A booking was made.
 *
 * Everything a General Fixter needs to plan the day and nothing they cannot act
 * on: who, when, where, what, and any note that changes how they turn up.
 */
async function bookingCreated(mail, booking) {
  const when = whenLabel(booking.date);
  const subject = adminSubjects.booking("New Booking", {
    name: booking.customerName,
    date: booking.date,
  });

  const { html, text } = renderOperationalEmail({
    subject,
    event: "New booking",
    who: booking.customerName || "",
    highlight: when,
    rows: [
      ["Service", booking.service],
      ["Type", booking.bookingType],
      ["Address", booking.address],
      ["Phone", booking.phone],
      ["Assigned", booking.assignedTo],
      ["Booking", booking.bookingNumber ? `#${booking.bookingNumber}` : ""],
    ],
    note: usefulNote(booking.note),
    action: booking.bookingId
      ? { label: "View booking", url: `${ADMIN_BASE_URL}${adminLink.booking(booking.bookingId)}` }
      : null,
    footer: "You are receiving this because you are a ProFixter General Fixter.",
  });

  return notifyGeneralFixters(mail, {
    subject, html, text,
    logContext: {
      templateKey: "general_fixter_booking_created",
      bookingId: booking.bookingId,
      bookingNumber: booking.bookingNumber,
      customerName: booking.customerName || "",
      customerEmail: booking.customerEmail || "",
      source: booking.source || "bookingCreate",
    },
  });
}

/** A booking was cancelled. Same shape, so the crew reads both the same way. */
async function bookingCanceled(mail, booking) {
  const subject = adminSubjects.booking("Booking Canceled", {
    name: booking.customerName,
    date: booking.date,
    withTime: false,
  });

  const { html, text } = renderOperationalEmail({
    subject,
    event: "Booking canceled",
    who: booking.customerName || "",
    highlight: whenLabel(booking.date),
    rows: [
      ["Service", booking.service],
      ["Type", booking.bookingType],
      ["Address", booking.address],
      ["Booking", booking.bookingNumber ? `#${booking.bookingNumber}` : ""],
    ],
    note: usefulNote(booking.reason),
    action: null,
    footer: "You are receiving this because you are a ProFixter General Fixter.",
  });

  return notifyGeneralFixters(mail, {
    subject, html, text,
    logContext: {
      templateKey: "general_fixter_booking_canceled",
      bookingId: booking.bookingId,
      bookingNumber: booking.bookingNumber,
      customerName: booking.customerName || "",
      customerEmail: booking.customerEmail || "",
      source: booking.source || "bookingCancel",
    },
  });
}

module.exports = {
  NEVER_NOTIFY,
  adminDestination,
  bookingCanceled,
  bookingCreated,
  generalFixterRecipients,
  notifyGeneralFixters,
  whenLabel,
};
