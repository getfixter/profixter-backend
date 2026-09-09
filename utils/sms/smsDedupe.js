/**
 * Idempotency keys.
 *
 * THE PROBLEM THIS SOLVES
 * A customer must never receive the same text twice, and the ways that can
 * happen are all outside our control: a worker running on four instances at
 * once, a Lambda retried after a timeout, a webhook Stripe or Twilio delivers
 * three times, a deploy landing mid-sweep, a cron cycle overlapping the last
 * one. Checking "did we already send this?" and then sending has a window
 * between the two, and every one of those scenarios lives in that window.
 *
 * THE SHAPE OF THE ANSWER
 * Each key names an OCCURRENCE, not a message. Every path that could produce a
 * given text computes the same key, inserts it under a unique index, and only
 * the insert that wins is allowed to send. The database arbitrates, so no
 * amount of concurrency changes the outcome and no caller has to be trusted.
 *
 * THE HARD PART IS RESCHEDULING
 * "One 24-hour reminder per booking" is wrong: a booking moved from Monday to
 * Thursday needs a reminder about Thursday, and the customer has been told
 * nothing about it. So reminder keys embed the appointment instant. Moving the
 * booking produces a genuinely different occurrence and therefore a genuinely
 * new reminder, while a replayed worker on the unchanged booking produces the
 * same key and is refused. Suppressing Thursday because Monday was announced is
 * the bug that looks most like correct deduplication, and this is what prevents
 * it.
 */

/** Keep keys short, printable and stable. */
function part(value) {
  return String(value === undefined || value === null ? "" : value)
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9_.:+-]/g, "")
    .slice(0, 80);
}

/**
 * The appointment instant, as a stable string.
 *
 * Epoch milliseconds, from the absolute instant: no timezone, no formatting, no
 * DST. Two servers in different regions computing a key for the same booking
 * must agree exactly, and any human-readable rendering of a date is a way for
 * them not to.
 */
function occurrenceOf(date) {
  /*
   * The emptiness check comes first because `new Date(null)` is the epoch
   * rather than an invalid date. Without it every booking with a missing date
   * would produce the occurrence "0" and they would all share one key, so the
   * first such booking to be reminded would silently suppress the reminder for
   * every other one.
   */
  if (date === null || date === undefined || date === "") return "no_date";
  const ms = new Date(date).getTime();
  return Number.isFinite(ms) ? String(ms) : "no_date";
}

function bookingId(booking) {
  return part(booking?._id || booking?.id || booking?.bookingNumber || "unknown");
}

/**
 * The key for a booking notification.
 *
 * Reminders and reschedule notices are scoped to the appointment instant, so
 * they recur correctly when a booking moves. Confirmation, cancellation and
 * completion are scoped to the booking alone: those happen once in a booking's
 * life regardless of how many times it is moved, and a customer who is told
 * twice that their visit is complete has been told something odd.
 */
const OCCURRENCE_SCOPED = new Set([
  "BOOKING_REMINDER_24H",
  "BOOKING_REMINDER_60M",
  "BOOKING_RESCHEDULED",
  "FIXTER_ASSIGNED",
  "FIXTER_CHANGED",
  "FIXTER_ON_THE_WAY",
]);

function bookingKey(notificationType, booking) {
  const base = `${part(notificationType)}:booking_${bookingId(booking)}`;
  if (!OCCURRENCE_SCOPED.has(notificationType)) return base;
  return `${base}:${occurrenceOf(booking?.date)}`;
}

/**
 * The key for a Fixter assignment notice.
 *
 * Scoped to the appointment AND the Fixter, because a booking legitimately
 * reassigned twice should produce two notices — the customer needs to know the
 * current answer — while the same reassignment processed twice should produce
 * one.
 */
function assignmentKey(notificationType, booking, fixterId) {
  return `${part(notificationType)}:booking_${bookingId(booking)}:${occurrenceOf(
    booking?.date
  )}:fixter_${part(fixterId || "none")}`;
}

/**
 * The key for a membership notification.
 *
 * Plan changes are scoped to the resulting plan and cycle, so a customer who
 * upgrades and later downgrades hears about both, while a webhook replayed for
 * one change stays silent the second time.
 */
function subscriptionKey(notificationType, subscription, extra = "") {
  const id = part(subscription?._id || subscription?.id || subscription?.stripeSubscriptionId || "unknown");
  const suffix = extra ? `:${part(extra)}` : "";
  return `${part(notificationType)}:sub_${id}${suffix}`;
}

/**
 * The key for a payment failure.
 *
 * Scoped to the Stripe invoice, which is the unit that actually failed. Stripe
 * retries a failed invoice several times over a dunning cycle and sends an
 * event each time; the customer needs telling once, not four times about the
 * same unpaid invoice.
 */
function invoiceKey(notificationType, invoiceId) {
  return `${part(notificationType)}:invoice_${part(invoiceId || "unknown")}`;
}

/** The key for an account-level notification. One per account, per event. */
function userKey(notificationType, user, extra = "") {
  const id = part(user?._id || user?.id || user?.userId || "unknown");
  const suffix = extra ? `:${part(extra)}` : "";
  return `${part(notificationType)}:user_${id}${suffix}`;
}

/**
 * The key for a marketing send.
 *
 * Cycle-scoped, exactly as the marketing email system does it. "Do not send
 * this twice by accident" is this key; "do not send this again for six months"
 * is a cooldown in the eligibility check. Conflating the two is what made the
 * email system's first version run every customer permanently out of marketing,
 * so the same separation is kept here deliberately.
 */
function campaignKey(campaignId, user, cycle = 0) {
  const id = part(user?._id || user?.id || user?.userId || "unknown");
  return `campaign:${part(campaignId)}:user_${id}:cycle${Number(cycle) || 0}`;
}

module.exports = {
  OCCURRENCE_SCOPED,
  assignmentKey,
  bookingKey,
  campaignKey,
  invoiceKey,
  occurrenceOf,
  subscriptionKey,
  userKey,
};
