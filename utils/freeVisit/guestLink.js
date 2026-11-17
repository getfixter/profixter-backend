/**
 * A homepage callback request, joined to the account its person creates later.
 *
 * Somebody asks for a free visit without an account, then signs up (or signs
 * in) with the same phone or email. Their visit should be in "My Home" from
 * then on, and it already counts against their one free visit through the
 * lifetime rule (utils/freeVisit/eligibility), which matches on phone and email
 * whether or not the booking is linked. This only makes the ownership visible.
 *
 * WHEN IT RUNS
 *  - At every sign-in (routes/auth.js, routes/authV2.js).
 *  - When a signed-in customer opens My Visits (GET /api/bookings), so a visit
 *    booked as a guest while already signed in appears without signing in again.
 *    That trusts nothing sign-in does not: the account's own proved contacts.
 *  - When the owner completes a guest visit (linkCompletedGuestVisit).
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

/**
 * Links what it safely can and returns the ids it linked. `via` is recorded on
 * the visit: "sign_in", "my_visits" (an already signed-in customer opening My
 * Visits, routes/bookings.js) or "completion". Every path applies the same checks.
 */
async function linkGuestFreeVisitIds(user, { via = "sign_in" } = {}) {
  if (!user?._id || (user.role && user.role !== "customer")) return [];
  const phone = user.phoneVerifiedAt ? normalizePhoneE164(user.phone) || "" : "";
  const email = user.emailVerifiedAt ? String(user.email || "").trim().toLowerCase() : "";
  if (!phone && !email) return [];
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

  const linked = [];
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
      {
        $set: {
          user: user._id,
          userId: user.userId || "",
          "freeVisitIdentity.userId": user._id,
          "freeVisitIdentity.linkedAt": new Date(),
          "freeVisitIdentity.linkedVia": String(via || "sign_in"),
        },
      }
    );
    if (result.modifiedCount === 1) linked.push(booking._id);
  }
  if (linked.length) console.log("free_visit_guest_linked", JSON.stringify({ userId: String(user._id), linked: linked.length, via }));
  return linked;
}

async function linkGuestFreeVisits(user, options) {
  return (await linkGuestFreeVisitIds(user, options)).length;
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

/**
 * The same join, from the visit's side, when the owner marks it Completed.
 *
 * The after-visit follow-ups (Track B) start only from a visit on an account.
 * A guest visit nobody linked - the person proved this phone or email on an
 * account after the owner confirmed it, but has not signed in since - would
 * otherwise never reach them. Only accounts that PROVED the contact are
 * candidates, exactly one must remain, and linkGuestFreeVisits then applies
 * every check above (a different account owning the email, a shared handset).
 * No match, or more than one: nothing happens; the owner can still link it.
 */
async function linkCompletedGuestVisit(booking) {
  if (!booking?.guestRequestId || booking.user) return 0;
  const or = [];
  const phone = normalizePhoneE164(booking.phone) || "";
  const email = String(booking.email || "").trim().toLowerCase();
  if (phone) or.push({ phone, phoneVerifiedAt: { $ne: null } });
  if (email) or.push({ email, emailVerifiedAt: { $ne: null } });
  if (!or.length) return 0;
  const users = await User.find({ role: "customer", $or: or }).limit(3);
  if (users.length !== 1) return 0;
  return linkGuestFreeVisits(users[0], { via: "completion" });
}

async function linkCompletedGuestVisitQuietly(booking) {
  try {
    return await linkCompletedGuestVisit(booking);
  } catch (error) {
    console.error("free visit completion link failed", { bookingId: String(booking?._id || ""), message: error?.message });
    return 0;
  }
}

module.exports = {
  linkCompletedGuestVisit,
  linkCompletedGuestVisitQuietly,
  linkGuestFreeVisitIds,
  linkGuestFreeVisits,
  linkGuestFreeVisitsQuietly,
};
