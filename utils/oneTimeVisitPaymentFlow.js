const RESERVATION_PROMOTION_FAILED = "reservation_promotion_failed";
const RESERVATION_PROTECTION_FALLBACK_MS = 24 * 60 * 60 * 1000;

/*
 * A paid visit's hold outlives its Stripe page (2026-11-19), as a membership
 * first visit's already did (utils/membershipFirstVisit). Before, the page and
 * the hold ended at the same second: a card confirmed in the page's last
 * moment reached our webhook after the time had stopped being held, and the
 * five-minute sweep could cancel it first. The page keeps the configured
 * length (Stripe's minimum is 30 minutes); the hold adds this grace.
 */
const PAYMENT_HOLD_GRACE_MINUTES = 10;

function paidVisitCheckoutTimes(holdMinutes, now = new Date()) {
  const pageExpiresAt = new Date(now.getTime() + Math.max(30, Number(holdMinutes) || 30) * 60 * 1000);
  return {
    pageExpiresAt,
    holdExpiresAt: new Date(pageExpiresAt.getTime() + PAYMENT_HOLD_GRACE_MINUTES * 60 * 1000),
  };
}

function oneTimeReservationProtectionExpiresAt(bookingDate, now = new Date()) {
  const nowMs = now.getTime();
  const dateMs = new Date(bookingDate || now).getTime();
  const anchor = Number.isFinite(dateMs) ? Math.max(nowMs, dateMs) : nowMs;
  return new Date(anchor + RESERVATION_PROTECTION_FALLBACK_MS);
}

function reservationIssueFromPromotionError(error, session, holdExpiresAt) {
  return {
    status: RESERVATION_PROMOTION_FAILED,
    message:
      error?.message ||
      "Stripe payment succeeded, but the reservation hold could not be promoted automatically.",
    code: error?.code || "",
    stripeCheckoutSessionId: session?.id || "",
    holdExpiresAt: holdExpiresAt || null,
    occurredAt: new Date(),
  };
}

function appendAdminReservationIssueNote(note, issue) {
  const marker = "[ADMIN REVIEW: One-time payment received; reservation promotion failed.";
  const current = String(note || "");
  if (current.includes(marker)) return current;

  const details = [
    marker,
    issue?.message ? `Reason: ${issue.message}.` : "",
    issue?.holdExpiresAt ? `Hold protected until ${new Date(issue.holdExpiresAt).toISOString()}.` : "",
    "]",
  ]
    .filter(Boolean)
    .join(" ");

  return current ? `${current}\n\n${details}` : details;
}

function applyOneTimePaymentSuccessToBooking(
  booking,
  { session = null, reservationIssue = null } = {}
) {
  booking.paymentState = "paid";
  booking.paymentStatus = reservationIssue
    ? "Paid - Reservation Review Needed"
    : "Paid";
  booking.paymentHoldExpiresAt = reservationIssue?.holdExpiresAt || null;
  booking.status = "Pending";
  booking.accessType = "one_time";
  booking.bookingType = "one_time_handyman_visit";

  if (reservationIssue) {
    booking.reservationIssue = reservationIssue;
    booking.note = appendAdminReservationIssueNote(booking.note, reservationIssue);
  } else {
    booking.reservationIssue = undefined;
  }

  return booking;
}

function applyOneTimePaymentSuccessToEntitlement(entitlement, session, bookingId) {
  if (!entitlement) return null;

  entitlement.status = "paid";
  entitlement.stripeCheckoutSessionId =
    session?.id || entitlement.stripeCheckoutSessionId;
  entitlement.stripeCustomerId = session?.customer
    ? String(session.customer)
    : entitlement.stripeCustomerId;
  entitlement.stripePaymentIntentId = session?.payment_intent
    ? String(session.payment_intent)
    : entitlement.stripePaymentIntentId;
  entitlement.purchasedAt = entitlement.purchasedAt || new Date();
  entitlement.bookingId = bookingId;
  entitlement.holdExpiresAt = null;
  return entitlement;
}

function expiredOneTimeHoldBookingUpdate(status = "expired") {
  return {
    status: "Canceled",
    paymentState: status,
    paymentStatus: status === "expired" ? "Expired" : "Failed",
  };
}

module.exports = {
  PAYMENT_HOLD_GRACE_MINUTES,
  RESERVATION_PROMOTION_FAILED,
  paidVisitCheckoutTimes,
  applyOneTimePaymentSuccessToBooking,
  applyOneTimePaymentSuccessToEntitlement,
  expiredOneTimeHoldBookingUpdate,
  oneTimeReservationProtectionExpiresAt,
  reservationIssueFromPromotionError,
};
