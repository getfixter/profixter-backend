/*
 * What Profixter emails to an address nobody has proved yet (2026-11-20).
 *
 * One code to buy: a customer who verified their phone types their email at
 * checkout and it is saved without a second code (User.emailUnconfirmedAt,
 * utils/auth/accounts attachTypedEmail). A typo there means a stranger's inbox.
 * That inbox must never receive the customer's home address, job, visit times,
 * private links or anything that signs in - but it is still where receipts and
 * billing notices go, because the customer needs those and gave no other address.
 *
 * Every email passes sendRaw (utils/emailService), which asks this module once
 * per send. The recipient is "unconfirmed" when a customer account holds that
 * address with emailUnconfirmedAt set and emailVerifiedAt empty. Guests have no
 * account and are unaffected (their own address is all a guest checkout has).
 *
 * The decision, by template key:
 *  send     - sign-in and security messages the customer started (the code that
 *             confirms this very address must arrive), and billing notices with
 *             nothing private in them.
 *  redact   - billing notices that also print a home address or the job: sent,
 *             with those fields left out (sendTx renders them without).
 *  notice   - visit updates: replaced by a short note that something changed and
 *             how to see it (sign in with the mobile number). No details, no link
 *             that carries a token.
 *  hold     - everything else: reminders, review and tip links, loyalty news,
 *             payment and access links, consent links and all marketing. Logged,
 *             not sent. An unknown key is held too: new emails are private until
 *             someone decides otherwise here.
 * Confirming the email (Account, or the offer after purchase) ends all of this.
 */

const SEND = new Set([
  "login_code",
  "password_otp",
  "password_changed",
  "account_contact_changed",
  "welcome",
  "payment_failed",
  "membership_restored",
  "gift_purchase_confirmation",
  "gift_claimed_purchaser",
]);

/* Billing notices that print private fields: sent without them. */
const REDACT = {
  subscription_started: ["address"],
  subscription_cancellation_scheduled: ["address"],
  subscription_canceled: ["address"],
  one_time_visit_payment_received: ["address", "selectedTask", "service"],
  full_day_visit_booked: ["address", "startTime", "endTime"],
};

/* Visit updates: the customer hears that something changed, not what. */
const NOTICE = new Set([
  "booking_created",
  "booking_confirmed",
  "booking_rescheduled",
  "booking_canceled",
  "first_visit_pick_another_time",
  "visit_converted",
]);
/* Of those, the ones that are also a payment confirmation. */
const PAYMENT_NOTICE = new Set(["visit_converted"]);

function policyFor(templateKey) {
  const key = String(templateKey || "");
  if (SEND.has(key)) return { action: "send" };
  if (REDACT[key]) return { action: "redact", fields: REDACT[key] };
  if (NOTICE.has(key)) return { action: "notice", payment: PAYMENT_NOTICE.has(key) };
  return { action: "hold" };
}

async function recipientIsUnconfirmed(to) {
  const email = String(to || "").trim().toLowerCase();
  if (!email) return false;
  // No database (a script or test without one): nobody can be unconfirmed, and a buffered query would only stall the send.
  if (require("mongoose").connection.readyState !== 1) return false;
  const User = require("../../models/User");
  return Boolean(
    await User.exists({
      email,
      role: { $ne: "employee" },
      emailUnconfirmedAt: { $ne: null },
      $or: [{ emailVerifiedAt: null }, { emailVerifiedAt: { $exists: false } }],
    })
  );
}

function redactVars(vars, fields) {
  const out = { ...(vars || {}) };
  for (const f of fields || []) out[f] = "";
  return out;
}

/* The short note that stands in for a visit update (and, for a payment, says it was received). */
function noticeEmail({ payment = false, accountUrl }) {
  const subject = payment ? "Your Profixter payment was received" : "An update on your Profixter visit";
  const lead = payment
    ? "We received your payment for a Profixter visit."
    : "There is an update on your Profixter visit request.";
  const why =
    "To keep your details private, we only email visit details once this email address is confirmed on your account.";
  const how = `To see it, sign in at ${accountUrl} with your mobile number. You can confirm this email there in a few seconds.`;
  const stranger = "If you have not booked with Profixter, someone may have typed your address by mistake, and you can ignore this email.";
  const text = `Hi,\n\n${lead}\n\n${why}\n\n${how}\n\n${stranger}`;
  const html = `<p>Hi,</p><p>${lead}</p><p>${why}</p><p>To see it, <a href="${accountUrl}">sign in to Profixter</a> with your mobile number. You can confirm this email there in a few seconds.</p><p style="color:#64748b;font-size:14px;">${stranger}</p>`;
  return { subject, text, html };
}

module.exports = { policyFor, recipientIsUnconfirmed, redactVars, noticeEmail, SEND, REDACT, NOTICE };
