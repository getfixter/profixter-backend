/**
 * A homepage callback request, joined to the account its person creates later.
 *
 * Somebody asks for a free visit without an account, then signs up (or signs
 * in) with the same phone or email. Their visit should be in "My Home" from
 * then on, and it already counts against their one free visit through the
 * lifetime rule (utils/freeVisit/eligibility), which matches on phone and email
 * whether or not the booking is linked. This only makes the ownership visible.
 *
 * WHAT IT WILL NOT DO
 *  - Link on a contact the account has not proved. A phone counts only with
 *    phoneVerifiedAt, an email only with emailVerifiedAt (OTP, Google, Apple).
 *  - Link a visit whose email belongs to a different account, or one matched by
 *    phone alone when another customer has proved the same phone (a household
 *    handset). Those stay for the owner, who links on Confirm as before.
 *  - Touch a canceled visit, or one already on an account.
 *  - Merge accounts, change a visit's status, or fail a sign-in: callers ignore
 *    its errors.
 */
const Booking = require("../../models/Booking");
const User = require("../../models/User");
const { normalizePhoneE164 } = require("../identity");
const { canonicalEmail } = require("./eligibility");

const CLOSED = ["Canceled", "Cancelled", "canceled", "cancelled"];

async function linkGuestFreeVisits(user) {
  if (!user?._id || (user.role && user.role !== "customer")) return 0;
  const phone = user.phoneVerifiedAt ? normalizePhoneE164(user.phone) || "" : "";
  const email = user.emailVerifiedAt ? String(user.email || "").trim().toLowerCase() : "";
  if (!phone && !email) return 0;
  const canonical = email ? canonicalEmail(email) : "";

  const or = [];
  if (phone) or.push({ phone }, { "freeVisitIdentity.phone": phone });
  if (email) or.push({ email }, { "freeVisitIdentity.email": canonical });
  const candidates = await Booking.find({
    guestRequestId: { $ne: null },
    user: null,
    status: { $nin: CLOSED },
    $or: or,
  })
    .select("_id phone email freeVisitIdentity")
    .limit(10)
    .lean();

  let linked = 0;
  for (const booking of candidates) {
    const bookingEmail = String(booking.email || "").toLowerCase();
    const emailMatch =
      Boolean(email) && (bookingEmail === email || (canonical && booking.freeVisitIdentity?.email === canonical));

    const others = [];
    if (bookingEmail) others.push({ email: bookingEmail });
    if (!emailMatch && booking.phone) others.push({ phone: booking.phone, phoneVerifiedAt: { $ne: null } });
    if (others.length) {
      const someoneElse = await User.exists({ _id: { $ne: user._id }, role: "customer", $or: others });
      if (someoneElse) continue;
    }

    const result = await Booking.updateOne(
      { _id: booking._id, user: null },
      { $set: { user: user._id, userId: user.userId || "", "freeVisitIdentity.userId": user._id } }
    );
    if (result.modifiedCount === 1) linked += 1;
  }
  if (linked) console.log("free_visit_guest_linked", JSON.stringify({ userId: String(user._id), linked }));
  return linked;
}

/** For sign-in paths: never throws, never delays the response by more than the lookup. */
async function linkGuestFreeVisitsQuietly(user) {
  try {
    return await linkGuestFreeVisits(user);
  } catch (error) {
    console.error("free visit guest link failed", { userId: String(user?._id || ""), message: error?.message });
    return 0;
  }
}

module.exports = { linkGuestFreeVisits, linkGuestFreeVisitsQuietly };
