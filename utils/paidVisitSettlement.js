/*
 * Settling a paid visit's Stripe page (One-Time and Full Day), 2026-11-19.
 *
 * Three rules, each the fix for something that went wrong before:
 *
 * 1. A DECLINED CARD IS NOT THE END OF THE PAGE. Stripe Checkout keeps the
 *    page open after a decline and the customer can try another card. Before,
 *    payment_intent.payment_failed canceled the booking and released its time
 *    while the page was still open, so a good second card paid for a canceled
 *    booking with its time gone. Now a decline is only counted. The page's own
 *    end (checkout.session.expired, or the hold sweep after it) is what
 *    releases the time.
 *
 * 2. PAID ONCE. checkout.session.completed, its async twin, a Stripe retry and
 *    the hold sweep's reconciliation can all reach one paid page. Only the
 *    caller that wins claimPaidVisitSettlement records it and sends the
 *    emails; the others see "already_paid" (done) or "busy" (try later).
 *
 * 3. ASK STRIPE BEFORE LETTING GO. The sweep used to cancel any hold past its
 *    time without asking whether the page had been paid. Now it reads the
 *    page first: paid means the payment is recorded, as the webhook would
 *    have; open means it is closed at Stripe first; only an expired or
 *    unknown page releases the time.
 */

const CLAIM_LEASE_MS = 5 * 60 * 1000;
/* A Stripe outage defers the release; after this long the time is released anyway (a late payment still lands, flagged for review). */
const STRIPE_UNREACHABLE_RELEASE_AFTER_MS = 24 * 60 * 60 * 1000;

function sessionIsPaid(session) {
  const status = String(session?.payment_status || "").toLowerCase();
  return status === "paid" || status === "no_payment_required";
}

/**
 * Take the right to record this paid page. Returns:
 *   { state: "claimed", booking }   the caller records it
 *   { state: "already_paid" }       recorded before (a replay): do nothing
 *   { state: "busy" }               another caller is recording it now
 *   { state: "missing" }            no such booking
 */
async function claimPaidVisitSettlement(BookingModel, bookingId, sessionId, now = new Date()) {
  const staleBefore = new Date(now.getTime() - CLAIM_LEASE_MS);
  const booking = await BookingModel.findOneAndUpdate(
    {
      _id: bookingId,
      paymentState: { $ne: "paid" },
      $or: [
        { "paymentSettlement.claimedAt": null },
        { "paymentSettlement.claimedAt": { $exists: false } },
        { "paymentSettlement.claimedAt": { $lte: staleBefore } },
      ],
    },
    { $set: { "paymentSettlement.claimedAt": now, "paymentSettlement.sessionId": String(sessionId || "") } },
    { new: true }
  );
  if (booking) return { state: "claimed", booking };
  const current = await BookingModel.findById(bookingId).select("paymentState").lean();
  if (!current) return { state: "missing" };
  if (current.paymentState === "paid") return { state: "already_paid" };
  return { state: "busy" };
}

/* A claim whose recording failed is let go at once, so Stripe's retry does not wait out the lease. */
async function releasePaidVisitClaim(BookingModel, bookingId) {
  await BookingModel.updateOne(
    { _id: bookingId, paymentState: { $ne: "paid" } },
    { $set: { "paymentSettlement.claimedAt": null } }
  ).catch(() => {});
}

/* A declined card on an open page: counted, nothing released. */
async function recordPaidVisitDecline(BookingModel, bookingId, now = new Date()) {
  if (!bookingId) return null;
  const result = await BookingModel.updateOne(
    { _id: bookingId, paymentState: "pending" },
    { $inc: { "paymentSettlement.declinedCount": 1 }, $set: { "paymentSettlement.lastDeclinedAt": now } }
  );
  return { bookingId: String(bookingId), declined: true, recorded: Boolean(result?.modifiedCount) };
}

/**
 * What the hold sweep should do with one booking whose hold has run out.
 * Returns { action, session? }:
 *   "release"  the page expired, never existed, or Stripe has been unreachable too long
 *   "settle"   the page was paid and the webhook never recorded it: record it now
 *   "wait"     the page is complete but its payment is still processing, or Stripe could not be read
 */
async function decideExpiredHold({ booking, sessionId, now = new Date(), retrieveSession, expireSession }) {
  if (!sessionId) return { action: "release", reason: "no_session" };
  let session;
  try {
    session = await retrieveSession(sessionId);
  } catch (error) {
    const heldUntil = new Date(booking?.paymentHoldExpiresAt || now).getTime();
    if (now.getTime() - heldUntil >= STRIPE_UNREACHABLE_RELEASE_AFTER_MS) return { action: "release", reason: "stripe_unreachable_too_long" };
    return { action: "wait", reason: "stripe_unreachable", message: error?.message };
  }
  if (session?.status === "open") {
    // Past our hold yet still open (should not happen: the page ends first). Close it at Stripe, then read it again.
    try {
      await expireSession(sessionId);
      return { action: "release", reason: "closed_open_page", session };
    } catch (error) {
      const again = await retrieveSession(sessionId).catch(() => null);
      if (again?.status === "complete") session = again;
      else return { action: "wait", reason: "could_not_close_page", message: error?.message };
    }
  }
  if (session?.status === "complete") {
    if (sessionIsPaid(session)) return { action: "settle", reason: "paid_unrecorded", session };
    return { action: "wait", reason: "payment_processing", session };
  }
  return { action: "release", reason: "page_expired", session };
}

module.exports = {
  CLAIM_LEASE_MS,
  STRIPE_UNREACHABLE_RELEASE_AFTER_MS,
  claimPaidVisitSettlement,
  decideExpiredHold,
  recordPaidVisitDecline,
  releasePaidVisitClaim,
  sessionIsPaid,
};
