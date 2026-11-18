/**
 * The private link a guest uses to check and manage a paid visit booked with
 * no account (routes/guestBookings.js). 2026-11-17.
 *
 * THE TOKEN. 32 random bytes, sent once by email when the payment is recorded
 * (the Stripe webhook). Only its SHA-256 is stored, so the database alone
 * cannot open anyone's visit. Whoever holds the link sees that one visit - the
 * same thing its email shows - and can ask for it to be cancelled. Nothing
 * else: no account, no other visits, no payment details.
 *
 * CANCELLING FOLLOWS THE EXISTING RULES. A paid One-Time Visit or Full Day is
 * not cancelled online by any customer, account or not (My Visits shows "call
 * to change" for them); staff cancel it, which frees the slot, and refunds are
 * made in Stripe by staff ("Canceling does not refund", utils/jobs/jobMoney).
 * So the link records a cancellation REQUEST, tells the owner at once, and
 * puts the job in Admin's Needs action. It never cancels, never frees the
 * slot and never refunds by itself.
 */
const crypto = require("crypto");
const moment = require("moment-timezone");
const Booking = require("../models/Booking");
const mail = require("./emailService");

const TZ = "America/New_York";
const CLIENT_URL = () => String(process.env.CLIENT_URL || "https://www.profixter.com").replace(/\/+$/, "");
const BUSINESS_PHONE = "631-599-1363";
const TOKEN_RE = /^[A-Za-z0-9_-]{40,60}$/;
/* The link stops working 30 days after the visit's day. */
const VALID_AFTER_VISIT_MS = 30 * 24 * 60 * 60 * 1000;

const hashOf = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");
const escapeHtml = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function kindLabel(booking) {
  return booking.bookingType === "full_day_visit" ? "Full Day Fixter" : "One-Time Visit";
}
function whenLabel(booking) {
  const m = moment.tz(booking.date, TZ);
  return booking.bookingType === "full_day_visit" ? m.format("dddd, MMMM D") : m.format("dddd, MMMM D [at] h:mm A");
}

/**
 * Issue the link for a paid guest checkout and email it - once. A replayed
 * webhook finds the link already issued and sends nothing. Returns the raw
 * token only to the caller that issued it (tests read it from the email).
 */
async function issueAndSendGuestVisitLink(bookingId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const claimed = await Booking.findOneAndUpdate(
    { _id: bookingId, guestCheckout: true, "guestManage.tokenHash": { $in: [null, ""] } },
    { $set: { "guestManage.tokenHash": hashOf(token), "guestManage.issuedAt": new Date() } },
    { new: true }
  ).lean();
  if (!claimed) return null;
  const url = `${CLIENT_URL()}/visit/${token}`;
  const kind = kindLabel(claimed);
  const when = whenLabel(claimed);
  try {
    await mail.sendRaw({
      to: claimed.email,
      subject: `Your Profixter ${kind}: check or change it here`,
      text: [
        `Hi ${claimed.name || "there"},`,
        "",
        `Your payment for the ${kind} on ${when} is recorded. Profixter reviews every paid request and confirms it with you.`,
        "",
        `Check its status, or ask us to cancel it, at your private link (no account needed):`,
        url,
        "",
        "Keep this link to yourself - anyone with it can see this visit.",
        `Questions: call or text ${BUSINESS_PHONE}.`,
      ].join("\n"),
      html: `<p>Hi ${escapeHtml(claimed.name || "there")},</p>
<p>Your payment for the <b>${escapeHtml(kind)}</b> on <b>${escapeHtml(when)}</b> is recorded. Profixter reviews every paid request and confirms it with you.</p>
<p><a href="${escapeHtml(url)}">Check your visit or ask to cancel it</a> - your private link, no account needed.</p>
<p style="color:#667">Keep this link to yourself: anyone with it can see this visit. Questions: call or text ${BUSINESS_PHONE}.</p>`,
      logContext: {
        bookingId: claimed._id,
        bookingNumber: claimed.bookingNumber,
        customerName: claimed.name || "",
        customerEmail: claimed.email || "",
        recipientName: claimed.name || "",
        recipientEmail: claimed.email || "",
        emailType: "transactional",
        source: "guestVisitLink",
      },
    });
    await Booking.updateOne({ _id: claimed._id }, { $set: { "guestManage.sentAt": new Date() } });
  } catch (error) {
    console.error("guest visit link email failed:", error.message);
  }
  return token;
}

/* The booking a link opens, or null (malformed, unknown, or past its life). */
async function bookingForToken(token, { now = new Date() } = {}) {
  if (!TOKEN_RE.test(String(token || ""))) return null;
  const booking = await Booking.findOne({ guestCheckout: true, "guestManage.tokenHash": hashOf(token) }).lean();
  if (!booking) return null;
  if (booking.date && new Date(booking.date).getTime() + VALID_AFTER_VISIT_MS < now.getTime()) return null;
  return booking;
}

const CLOSED = /^(cancel+ed|completed|done|no.?show)$/i;

/* What the link shows: this one visit, nothing about any account or payment method. */
function visitView(booking) {
  const status = String(booking.status || "");
  const paid = booking.paymentState === "paid";
  const canceled = /^cancel+ed$/i.test(status);
  let state;
  if (canceled) state = "canceled";
  else if (/^(completed|done)$/i.test(status)) state = "completed";
  else if (!paid) state = "payment_not_recorded";
  else if (/^confirmed$/i.test(status)) state = "confirmed";
  else state = "pending_approval";
  const start = moment.tz(booking.date, TZ);
  return {
    kind: booking.bookingType === "full_day_visit" ? "full_day" : "one_time",
    state,
    bookingNumber: booking.bookingNumber,
    date: start.format("YYYY-MM-DD"),
    time: booking.bookingType === "full_day_visit" ? null : start.format("HH:mm"),
    name: booking.name || "",
    address: [booking.address, booking.unit, booking.city, booking.state, booking.zip].filter(Boolean).join(", "),
    job: booking.note || "",
    paid,
    cancellationRequestedAt: booking.cancellationRequest?.at || null,
    canRequestCancellation: !CLOSED.test(status) && !booking.cancellationRequest?.at,
    phone: BUSINESS_PHONE,
  };
}

/**
 * Ask for this visit to be cancelled. Once: a second ask returns the first.
 * Tells the owner by email; the job shows in Needs action. Changes nothing else.
 */
async function requestCancellation(booking, { reason = "" } = {}) {
  if (CLOSED.test(String(booking.status || ""))) {
    const error = new Error("This visit can no longer be changed online. Please call or text 631-599-1363.");
    error.statusCode = 409;
    error.code = "VISIT_CLOSED";
    throw error;
  }
  const at = new Date();
  const updated = await Booking.findOneAndUpdate(
    { _id: booking._id, "cancellationRequest.at": null },
    { $set: { "cancellationRequest.at": at, "cancellationRequest.reason": String(reason || "").trim().slice(0, 500), "cancellationRequest.via": "guest_link" } },
    { new: true }
  ).lean();
  if (!updated) return { already: true, booking: await Booking.findById(booking._id).lean() };
  const kind = kindLabel(updated);
  const when = whenLabel(updated);
  try {
    await mail.sendRaw({
      to: process.env.MAIL_ADMIN || "getfixter@gmail.com",
      subject: `Cancellation requested: ${kind} #${updated.bookingNumber} (${when})`,
      text: [
        `${updated.name} asked to cancel their paid ${kind} on ${when} (booking #${updated.bookingNumber}), from their guest visit link.`,
        updated.cancellationRequest?.reason ? `Reason: ${updated.cancellationRequest.reason}` : "No reason given.",
        "",
        "Nothing has changed yet: the visit is still booked and the payment is still held.",
        "In Admin: cancel the job (frees the slot), then refund in Stripe if a refund is due.",
        `Phone: ${updated.phone} · Email: ${updated.email}`,
      ].join("\n"),
      logContext: { bookingId: updated._id, bookingNumber: updated.bookingNumber, emailType: "admin", source: "guestCancellationRequest" },
    });
    await mail.sendRaw({
      to: updated.email,
      subject: `We received your cancellation request (#${updated.bookingNumber})`,
      text: [
        `Hi ${updated.name || "there"},`,
        "",
        `We received your request to cancel the ${kind} on ${when}. Our team will contact you to confirm the cancellation and any refund.`,
        "Until then, the visit is still booked.",
        `Questions: call or text ${BUSINESS_PHONE}.`,
      ].join("\n"),
      logContext: { bookingId: updated._id, bookingNumber: updated.bookingNumber, recipientEmail: updated.email, emailType: "transactional", source: "guestCancellationRequest" },
    });
  } catch (error) {
    console.error("cancellation request emails failed:", error.message);
  }
  return { already: false, booking: updated };
}

module.exports = { issueAndSendGuestVisitLink, bookingForToken, visitView, requestCancellation, hashOf };
