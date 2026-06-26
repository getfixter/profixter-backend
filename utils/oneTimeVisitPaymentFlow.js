const RESERVATION_PROMOTION_FAILED = "reservation_promotion_failed";
const RESERVATION_PROTECTION_FALLBACK_MS = 24 * 60 * 60 * 1000;

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
  RESERVATION_PROMOTION_FAILED,
  applyOneTimePaymentSuccessToBooking,
  applyOneTimePaymentSuccessToEntitlement,
  expiredOneTimeHoldBookingUpdate,
  oneTimeReservationProtectionExpiresAt,
  reservationIssueFromPromotionError,
};
