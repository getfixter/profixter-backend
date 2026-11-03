/*
 * The first visit of a new membership, booked before paying (2026-11-03).
 *
 * A customer without a membership describes the job, picks a real open time
 * and only then buys a plan. Three rules make that safe:
 *
 * 1. THE HOLD COVERS THE CHECKOUT. Their sign-in hold (slotReservationService
 *    createSignInHold, 30 minutes) is extended when the membership checkout
 *    opens, to the Stripe page's own expiry plus a short grace, and the page is
 *    opened with that expiry (Stripe's minimum is 30 minutes). Payment cannot
 *    complete after the page expires, and a payment completed in its last
 *    second still finds the time held while the customer is sent back to book
 *    it. A page that expires unpaid releases the hold (webhook,
 *    releaseFirstVisitCheckoutHold) - only the hold that page was opened with.
 *
 * 2. ONE EXEMPTION, FROM THE SEVEN-DAY RULE, FOR THAT MEMBERSHIP'S FIRST VISIT.
 *    A checkout opened by somebody with no live membership carries
 *    firstVisitExempt=1 in the Stripe subscription's metadata; every sync of
 *    that subscription (utils/subscriptionManagement upsertSubscriptionFromStripe)
 *    stamps Subscription.firstVisitExemption.grantedAt once. The member booking
 *    route then lets that subscription's first booking take any open time the
 *    non-member calendar offers, claiming the exemption atomically right before
 *    the booking is written (and handing it back if the booking fails). It is
 *    spent by the first booking whatever its date, and lapses after
 *    FIRST_VISIT_VALID_DAYS. An existing member buying again gets no exemption.
 *
 * 3. NOTHING IS PROMISED THAT CANNOT BE KEPT. A time that is taken before the
 *    checkout opens refuses the checkout (SLOT_UNAVAILABLE) so the customer
 *    picks another; a time lost after payment leaves the membership active and
 *    the exemption unspent, and the customer picks another time.
 */
const mongoose = require("mongoose");
const moment = require("moment-timezone");
const Subscription = require("../models/Subscription");
const BookingSlotReservation = require("../models/BookingSlotReservation");

/** Stripe refuses a Checkout expiry under 30 minutes from now. */
const FIRST_VISIT_CHECKOUT_MINUTES = 31;
/** The hold outlives the Stripe page by this much, for a payment made at the last moment. */
const FIRST_VISIT_HOLD_GRACE_MINUTES = 10;
const FIRST_VISIT_VALID_DAYS = 30;
const TZ = "America/New_York";

function readFirstVisit(body) {
  const fv = body && typeof body === "object" ? body : null;
  if (!fv) return null;
  const requestedDate = String(fv.requestedDate || "");
  const requestedTime = String(fv.requestedTime || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate) || !/^\d{2}:\d{2}$/.test(requestedTime)) return null;
  const start = moment.tz(`${requestedDate} ${requestedTime}`, "YYYY-MM-DD HH:mm", true, TZ);
  if (!start.isValid()) return null;
  return { requestedDate, requestedTime, slotStart: start.toDate(), holdToken: String(fv.holdToken || "") };
}

/** No live membership on any home: this purchase is a new membership, and its first visit may be soon. */
async function firstVisitExemptionEligible(userId) {
  // Loaded here: welcomeOffer requires subscriptionManagement, which requires this module.
  const { LIVE_MEMBERSHIP_STATUSES } = require("./welcomeOffer");
  return !(await Subscription.exists({ user: userId, status: { $in: LIVE_MEMBERSHIP_STATUSES } }));
}

function checkoutExpiry(now = new Date()) {
  return Math.floor(now.getTime() / 1000) + FIRST_VISIT_CHECKOUT_MINUTES * 60;
}

function holdMinutesForCheckout() {
  return FIRST_VISIT_CHECKOUT_MINUTES + FIRST_VISIT_HOLD_GRACE_MINUTES;
}

function holdIdFromToken(token) {
  const id = String(token || "").split(".")[0];
  return mongoose.isValidObjectId(id) ? id : "";
}

function firstVisitCheckoutMetadata({ exempt, requestedDate, requestedTime, holdToken }) {
  return {
    firstVisitExempt: exempt ? "1" : "0",
    firstVisitDate: requestedDate,
    firstVisitTime: requestedTime,
    firstVisitHoldId: holdIdFromToken(holdToken),
  };
}

/** Remember which Stripe page the hold now belongs to (null: none yet), so only that page's expiry releases it. */
async function tagHoldWithCheckout(holdToken, checkoutSessionId) {
  const id = holdIdFromToken(holdToken);
  if (!id) return;
  await BookingSlotReservation.updateOne({ _id: id, signInHold: true, status: "held" }, { $set: { checkoutSessionId: checkoutSessionId || null } });
}

/** Stamp the exemption on a subscription synced from Stripe (once; never re-granted). */
function stampFirstVisitExemption(subscription, stripeMetadata, now = new Date()) {
  if (!subscription || String(stripeMetadata?.firstVisitExempt || "") !== "1") return false;
  if (subscription.firstVisitExemption?.grantedAt) return false;
  subscription.firstVisitExemption = { grantedAt: now, usedAt: null, bookingId: null };
  return true;
}

function firstVisitExemptionActive(subscription, now = new Date()) {
  const grantedAt = subscription?.firstVisitExemption?.grantedAt;
  if (!grantedAt || subscription.firstVisitExemption.usedAt) return false;
  return now.getTime() - new Date(grantedAt).getTime() < FIRST_VISIT_VALID_DAYS * 86400000;
}

/** Spend the exemption (atomically: two first bookings at once cannot both have it). */
async function claimFirstVisitExemption(subscriptionId, now = new Date()) {
  const since = new Date(now.getTime() - FIRST_VISIT_VALID_DAYS * 86400000);
  const claimed = await Subscription.findOneAndUpdate(
    { _id: subscriptionId, "firstVisitExemption.grantedAt": { $gt: since }, "firstVisitExemption.usedAt": null },
    { $set: { "firstVisitExemption.usedAt": now } },
    { new: true }
  ).lean();
  return Boolean(claimed);
}

async function releaseFirstVisitExemption(subscriptionId) {
  await Subscription.updateOne(
    { _id: subscriptionId, "firstVisitExemption.bookingId": null },
    { $set: { "firstVisitExemption.usedAt": null } }
  );
}

async function attachFirstVisitBooking(subscriptionId, bookingId) {
  await Subscription.updateOne({ _id: subscriptionId }, { $set: { "firstVisitExemption.bookingId": bookingId } });
}

module.exports = {
  FIRST_VISIT_CHECKOUT_MINUTES,
  FIRST_VISIT_HOLD_GRACE_MINUTES,
  FIRST_VISIT_VALID_DAYS,
  readFirstVisit,
  firstVisitExemptionEligible,
  checkoutExpiry,
  holdMinutesForCheckout,
  holdIdFromToken,
  firstVisitCheckoutMetadata,
  tagHoldWithCheckout,
  stampFirstVisitExemption,
  firstVisitExemptionActive,
  claimFirstVisitExemption,
  releaseFirstVisitExemption,
  attachFirstVisitBooking,
};
