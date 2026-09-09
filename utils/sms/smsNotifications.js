const dedupe = require("./smsDedupe");
const { resolveBookingPhone } = require("./smsPhone");
const { sendTransactionalSms } = require("./smsService");
const { visitVocabulary } = require("./smsTemplates");

/**
 * The domain-level triggers.
 *
 * A route handler or a cron job says what happened — "this booking was
 * cancelled" — and this layer works out which notification type that is, which
 * idempotency key it belongs to, and which phone number to use. Callers never
 * touch types, keys or the provider.
 *
 * EVERY FUNCTION HERE IS BEST-EFFORT AND NEVER THROWS.
 *
 * This is the single most important property of this file. A booking
 * confirmation, a cancellation and a Stripe webhook all have real work to do,
 * and none of them may fail because a text message could not be sent. The
 * existing email calls in this codebase are wrapped in try/catch at every call
 * site for exactly this reason; doing it once, here, means a future caller
 * cannot forget to.
 *
 * The return value says what happened for anyone who wants to log it. Nobody
 * has to check it.
 */

function safeResult(error) {
  return { ok: false, status: "error", reason: String(error?.message || "sms_failed") };
}

/** Wrap a trigger so a failure inside it can never reach the caller. */
async function attempt(label, fn) {
  try {
    return await fn();
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "sms_notification_failed",
        trigger: label,
        error: String(error?.message || "unknown").slice(0, 200),
      })
    );
    return safeResult(error);
  }
}

/**
 * Which confirmation and which completion message a booking gets.
 *
 * Driven by the same vocabulary function the templates use, so the type chosen
 * and the words rendered can never disagree about what kind of visit this is.
 */
const CONFIRMATION_TYPE = {
  full_day: "FULL_DAY_CONFIRMED",
  free_first: "FREE_VISIT_CONFIRMED",
  one_time: "ONE_TIME_VISIT_CONFIRMED",
  membership: "BOOKING_CONFIRMED",
};

const COMPLETION_TYPE = {
  full_day: "FULL_DAY_COMPLETED",
  free_first: "FREE_VISIT_COMPLETED",
  one_time: "ONE_TIME_VISIT_COMPLETED",
  membership: "BOOKING_COMPLETED",
};

function typeForBooking(map, booking) {
  return map[visitVocabulary(booking).kind] || map.membership;
}

/* -------------------------------------------------------------------------- */
/* Bookings                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A booking was created or confirmed.
 *
 * The notification type varies by visit kind but the dedupe key does not: it is
 * scoped to the booking, so a customer is told once that this booking exists no
 * matter how many times the record is saved or the status is re-applied.
 */
async function notifyBookingConfirmed(booking, user = null, source = "booking") {
  return attempt("booking_confirmed", async () => {
    const notificationType = typeForBooking(CONFIRMATION_TYPE, booking);
    const { phone } = resolveBookingPhone(booking, user);
    return sendTransactionalSms({
      notificationType,
      // Keyed on the shared name, not the per-type name, so a booking that
      // somehow changes kind cannot produce two confirmations.
      dedupeKey: dedupe.bookingKey("BOOKING_CONFIRMED", booking),
      user,
      phone,
      booking,
      vars: { booking },
      source,
    });
  });
}

/**
 * A reminder is due.
 *
 * The key embeds the appointment instant, which is what makes rescheduling
 * work: move the booking and this becomes a different occurrence that has never
 * been reminded, while a re-run of the sweep on an unmoved booking collides and
 * stops.
 */
async function notifyBookingReminder(booking, user = null, kind = "24h", source = "bookingReminders") {
  return attempt(`booking_reminder_${kind}`, async () => {
    const notificationType =
      kind === "60m" ? "BOOKING_REMINDER_60M" : "BOOKING_REMINDER_24H";
    const { phone } = resolveBookingPhone(booking, user);
    return sendTransactionalSms({
      notificationType,
      dedupeKey: dedupe.bookingKey(notificationType, booking),
      user,
      phone,
      booking,
      vars: { booking },
      source,
    });
  });
}

/**
 * A confirmed booking moved.
 *
 * `booking` must already carry the NEW date. The key is scoped to that new
 * instant, so moving a booking twice produces two notices and reprocessing one
 * move produces one.
 */
async function notifyBookingRescheduled(booking, user = null, source = "booking") {
  return attempt("booking_rescheduled", async () => {
    const { phone } = resolveBookingPhone(booking, user);
    return sendTransactionalSms({
      notificationType: "BOOKING_RESCHEDULED",
      dedupeKey: dedupe.bookingKey("BOOKING_RESCHEDULED", booking),
      user,
      phone,
      booking,
      vars: { booking },
      source,
    });
  });
}

/**
 * A booking was cancelled.
 *
 * Nothing here has to cancel pending reminders. The reminder sweep selects only
 * bookings whose status is Confirmed, so a cancelled booking stops being
 * selected the moment its status changes and no reminder is ever enqueued for
 * it. That is a stronger guarantee than deleting queued jobs, because there is
 * no queue to get out of step with the booking.
 */
async function notifyBookingCancelled(booking, user = null, source = "booking") {
  return attempt("booking_cancelled", async () => {
    const { phone } = resolveBookingPhone(booking, user);
    return sendTransactionalSms({
      notificationType: "BOOKING_CANCELLED",
      dedupeKey: dedupe.bookingKey("BOOKING_CANCELLED", booking),
      user,
      phone,
      booking,
      vars: { booking },
      source,
    });
  });
}

/**
 * A visit was completed. This is the message that carries the tip link.
 *
 * Keyed to the booking alone, so a status toggled to Completed twice produces
 * one text. The four visit kinds get four different types so the audit record
 * says which product was completed without a join.
 */
async function notifyBookingCompleted(booking, user = null, source = "adminBookingStatus") {
  return attempt("booking_completed", async () => {
    const notificationType = typeForBooking(COMPLETION_TYPE, booking);
    const { phone } = resolveBookingPhone(booking, user);
    return sendTransactionalSms({
      notificationType,
      dedupeKey: dedupe.bookingKey("BOOKING_COMPLETED", booking),
      user,
      phone,
      booking,
      vars: { booking },
      source,
    });
  });
}

/**
 * A Fixter was assigned, or the assignment changed.
 *
 * Keyed to booking, appointment instant and Fixter together, so a genuine
 * reassignment is a new occurrence the customer hears about, while the same
 * assignment saved twice is not.
 */
async function notifyFixterAssignment(
  booking,
  { user = null, fixterId, fixterName, isChange = false, source = "adminBooking" } = {}
) {
  return attempt("fixter_assignment", async () => {
    const notificationType = isChange ? "FIXTER_CHANGED" : "FIXTER_ASSIGNED";
    const { phone } = resolveBookingPhone(booking, user);
    return sendTransactionalSms({
      notificationType,
      dedupeKey: dedupe.assignmentKey(notificationType, booking, fixterId),
      user,
      phone,
      booking,
      vars: { booking, fixterName },
      source,
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Account                                                                     */
/* -------------------------------------------------------------------------- */

async function notifyAccountCreated(user, source = "auth") {
  return attempt("account_created", async () =>
    sendTransactionalSms({
      notificationType: "ACCOUNT_CREATED",
      dedupeKey: dedupe.userKey("ACCOUNT_CREATED", user),
      user,
      phone: user?.phone,
      vars: { name: user?.name },
      source,
    })
  );
}

/**
 * The account password changed.
 *
 * Keyed with the timestamp, because unlike registration this genuinely recurs:
 * somebody who changes their password twice should be told twice, and somebody
 * whose password was changed without their knowledge should be told every time
 * it happens.
 */
async function notifyPasswordChanged(user, { changedAt = new Date(), source = "auth" } = {}) {
  return attempt("password_changed", async () =>
    sendTransactionalSms({
      notificationType: "ACCOUNT_PASSWORD_CHANGED",
      dedupeKey: dedupe.userKey(
        "ACCOUNT_PASSWORD_CHANGED",
        user,
        String(new Date(changedAt).getTime())
      ),
      user,
      phone: user?.phone,
      vars: {},
      source,
    })
  );
}

/* -------------------------------------------------------------------------- */
/* Membership                                                                  */
/* -------------------------------------------------------------------------- */

async function notifyMembershipStarted(subscription, user = null, source = "stripeWebhook") {
  return attempt("membership_started", async () =>
    sendTransactionalSms({
      notificationType: "MEMBERSHIP_STARTED",
      dedupeKey: dedupe.subscriptionKey("MEMBERSHIP_STARTED", subscription),
      user,
      phone: user?.phone,
      subscription,
      vars: { name: user?.name, planLabel: subscription?.subscriptionType },
      source,
    })
  );
}

/**
 * The plan or billing cycle changed.
 *
 * Keyed to the resulting plan and cycle, so a customer who upgrades and later
 * downgrades hears about both changes while a replayed webhook for one of them
 * stays silent the second time.
 */
async function notifyMembershipChanged(subscription, user = null, source = "stripeWebhook") {
  return attempt("membership_changed", async () =>
    sendTransactionalSms({
      notificationType: "MEMBERSHIP_CHANGED",
      dedupeKey: dedupe.subscriptionKey(
        "MEMBERSHIP_CHANGED",
        subscription,
        `${subscription?.subscriptionType || ""}_${subscription?.billingCycle || ""}`
      ),
      user,
      phone: user?.phone,
      subscription,
      vars: {
        planLabel: subscription?.subscriptionType,
        billingCycle: subscription?.billingCycle,
      },
      source,
    })
  );
}

/**
 * Cancellation was requested, but access continues to the period end.
 *
 * A DIFFERENT MESSAGE FROM "your membership has ended", AND THAT MATTERS.
 *
 * Stripe keeps a cancelled subscription active until the current period closes.
 * Telling somebody their membership has ended while they still have three weeks
 * of paid visits available would cost them visits they have already bought and
 * cost us the relationship. The two states get two types and two templates.
 */
async function notifyMembershipCancellationScheduled(
  subscription,
  user = null,
  source = "subscriptions"
) {
  return attempt("membership_cancellation_scheduled", async () =>
    sendTransactionalSms({
      notificationType: "MEMBERSHIP_CANCELLATION_SCHEDULED",
      dedupeKey: dedupe.subscriptionKey("MEMBERSHIP_CANCELLATION_SCHEDULED", subscription),
      user,
      phone: user?.phone,
      subscription,
      vars: {
        accessUntil:
          subscription?.currentPeriodEnd ||
          subscription?.cancellationDate ||
          subscription?.nextPaymentDate ||
          null,
      },
      source,
    })
  );
}

/** The membership actually ended. Only on the real transition to canceled. */
async function notifyMembershipCancelled(subscription, user = null, source = "stripeWebhook") {
  return attempt("membership_cancelled", async () =>
    sendTransactionalSms({
      notificationType: "MEMBERSHIP_CANCELLED",
      dedupeKey: dedupe.subscriptionKey("MEMBERSHIP_CANCELLED", subscription),
      user,
      phone: user?.phone,
      subscription,
      vars: {},
      source,
    })
  );
}

/**
 * A payment failed and needs the customer to act.
 *
 * Keyed to the Stripe invoice, because that is the thing that failed. Stripe
 * retries a failed invoice several times across a dunning cycle and emits an
 * event each time; the customer needs telling once about the unpaid invoice,
 * not once per retry.
 *
 * This is the ONLY payment-related text. There is deliberately no notice of a
 * successful renewal, an upcoming charge or a card about to be billed.
 */
async function notifyPaymentFailed(
  { invoiceId, subscription = null, user = null, source = "stripeWebhook" } = {}
) {
  return attempt("payment_failed", async () =>
    sendTransactionalSms({
      notificationType: "PAYMENT_FAILED",
      dedupeKey: dedupe.invoiceKey("PAYMENT_FAILED", invoiceId),
      user,
      phone: user?.phone,
      subscription,
      vars: {},
      source,
    })
  );
}

module.exports = {
  COMPLETION_TYPE,
  CONFIRMATION_TYPE,
  notifyAccountCreated,
  notifyBookingCancelled,
  notifyBookingCompleted,
  notifyBookingConfirmed,
  notifyBookingReminder,
  notifyBookingRescheduled,
  notifyFixterAssignment,
  notifyMembershipCancellationScheduled,
  notifyMembershipCancelled,
  notifyMembershipChanged,
  notifyMembershipStarted,
  notifyPasswordChanged,
  notifyPaymentFailed,
  typeForBooking,
};
