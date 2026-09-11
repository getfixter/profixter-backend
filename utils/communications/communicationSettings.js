const { SMS_TYPES } = require("../sms/smsTypes");

/**
 * What actually causes each message to be sent.
 *
 * DESCRIPTIVE, NOT AUTHORITATIVE. Nothing here changes behaviour: the triggers
 * live in routes, jobs and webhooks, and this file documents them for the admin
 * screen. That split is deliberate for now - an admin who can retime a reminder
 * from a settings panel can also silently break the reminder, and the trigger
 * logic has invariants (claim-then-send, lock recovery, explicit abandonment)
 * that a form cannot express.
 *
 * The cost of a descriptive file is that it can drift from the code it
 * describes. The test suite pins the parts that are checkable - every type has
 * an entry, the channel class matches the registry, and the reserved types are
 * exactly the ones with no call site - so drift shows up as a failing test
 * rather than as a confident wrong answer on a screen.
 *
 * Timings below are read from utils/bookingReminderPolicy and jobs/smsJobs
 * rather than remembered.
 */

const FLAGS = {
  sms: "SMS_ENABLED",
  marketing: "SMS_MARKETING_ENABLED",
  gift: "GIFT_SMS_ENABLED",
  review: "SMS_REVIEW_LINK_ENABLED",
};

/** Shared wording for the rules that apply to every SMS. */
const SMS_COMMON = {
  consent:
    "A STOP from the handset blocks this message regardless of any account setting. " +
    "Deliverability, opt-out and quiet-hour rules are applied by smsEligibility before any send.",
};

const SMS_SETTINGS = {
  BOOKING_CONFIRMED: {
    trigger: "A membership visit is created or confirmed.",
    event: "notifyBookingConfirmed from routes/bookings.js and routes/admin.js",
    appliesTo: "Membership visits",
    schedule: "Immediately, on the booking event.",
    eligibility:
      "Deduped per booking, so re-saving or re-applying a status cannot produce a second confirmation.",
    ghlOverlap: "GHL workflows may also message on booking creation. Verify before enabling SMS.",
  },
  FREE_VISIT_CONFIRMED: {
    trigger: "A Free First Visit is booked.",
    event: "notifyBookingConfirmed, routed by visit kind",
    appliesTo: "Free first visits only",
    schedule: "Immediately, on the booking event.",
  },
  ONE_TIME_VISIT_CONFIRMED: {
    trigger: "A One-Time Visit is booked and paid.",
    event: "notifyBookingConfirmed, routed by visit kind",
    appliesTo: "One-Time Visits",
    schedule: "Immediately, on the booking event.",
  },
  FULL_DAY_CONFIRMED: {
    trigger: "A Full Day Service is booked and paid.",
    event: "notifyBookingConfirmed, routed by visit kind",
    appliesTo: "Full Day Service",
    schedule: "Immediately, on the booking event.",
  },

  BOOKING_REMINDER_24H: {
    trigger: "The day-before reminder sweep finds a booking due.",
    event: "jobs/bookingReminders.js -> notifyBookingReminder('24h')",
    appliesTo: "All visit kinds",
    schedule: "Becomes due 24 hours before the appointment. Sweep runs every minute (America/New_York).",
    earliest: "24 hours before the appointment.",
    recovery:
      "Stays selectable until 2 hours before the appointment, so an outage is recoverable. " +
      "Below 2 hours it is abandoned deliberately and recorded as skipped with a reason; " +
      "the abandonment sweep reaches back 6 hours past the appointment so nothing sits undecided.",
    eligibility:
      "Dedupe key embeds the appointment instant, so a rescheduled booking earns a genuinely new reminder.",
    ghlOverlap: "GHL reminder_24h tag may duplicate this. Verify before enabling SMS.",
  },
  BOOKING_REMINDER_60M: {
    trigger: "The hour-before reminder sweep finds a booking due.",
    event: "jobs/bookingReminders.js -> notifyBookingReminder('60m')",
    appliesTo: "All visit kinds. Full Day gets a variant with no arrival window.",
    schedule: "Becomes due 1 hour before the appointment. Sweep runs every minute.",
    earliest: "1 hour before the appointment.",
    recovery:
      "Still sent up to 15 minutes after the appointment start, because 'we are on the way' is " +
      "true then. Abandoned after that. A worker that dies mid-send releases its claim after 10 minutes.",
    ghlOverlap: "GHL reminder_60m tag may duplicate this. Verify before enabling SMS.",
  },

  BOOKING_RESCHEDULED: {
    trigger: "A confirmed booking moves to a new date or time.",
    event: "notifyBookingRescheduled from the booking update path",
    appliesTo: "All visit kinds",
    schedule: "Immediately, on the reschedule event.",
  },
  BOOKING_CANCELLED: {
    trigger: "A booking is cancelled.",
    event: "notifyBookingCancelled",
    appliesTo: "All visit kinds",
    schedule: "Immediately, on the cancellation event.",
  },

  BOOKING_COMPLETED: {
    trigger: "An admin marks a membership visit complete.",
    event: "notifyBookingCompleted from routes/admin.js",
    appliesTo: "Membership visits",
    schedule: "Immediately, on the status change.",
    eligibility: "Not time-critical, so the transactional quiet-hour floor (8am-9pm ET) applies.",
    notes: "Carries the tip link. The review link is withheld while SMS_REVIEW_LINK_ENABLED is false.",
  },
  FREE_VISIT_COMPLETED: {
    trigger: "An admin marks a Free First Visit complete.",
    event: "notifyBookingCompleted, routed by visit kind",
    appliesTo: "Free first visits",
    schedule: "Immediately, on the status change.",
    notes: "Carries the tip link only.",
  },
  ONE_TIME_VISIT_COMPLETED: {
    trigger: "An admin marks a One-Time Visit complete.",
    event: "notifyBookingCompleted, routed by visit kind",
    appliesTo: "One-Time Visits",
    schedule: "Immediately, on the status change.",
    notes: "Carries the tip link only.",
  },
  FULL_DAY_COMPLETED: {
    trigger: "An admin marks a Full Day Service complete.",
    event: "notifyBookingCompleted, routed by visit kind",
    appliesTo: "Full Day Service",
    schedule: "Immediately, on the status change.",
    notes: "Carries the tip link only.",
  },

  FIXTER_ASSIGNED: {
    trigger: "A Fixter is assigned to an upcoming visit.",
    event: "notifyFixterAssignment from routes/admin.js",
    appliesTo: "Any booking with an assignee",
    schedule: "Immediately, on assignment.",
    eligibility: "Not time-critical; quiet-hour floor applies.",
  },
  FIXTER_CHANGED: {
    trigger: "The assigned Fixter changes on an upcoming visit.",
    event: "notifyFixterAssignment, change variant",
    appliesTo: "Any booking whose assignee changes",
    schedule: "Immediately, on reassignment.",
  },
  FIXTER_ON_THE_WAY: {
    reserved: true,
    trigger: "No trigger currently exists.",
    event: "Nothing calls this type. There is no dispatch or en-route event in the system.",
    appliesTo: "Reserved",
    schedule: "Not scheduled.",
    notes: "Written so the wording and tests exist if dispatch is ever built.",
  },

  GIFT_INVITATION: {
    trigger: "A gift membership is purchased and the buyer chooses to have us text the recipient.",
    event: "utils/gifts/giftSms.js",
    appliesTo: "Gift recipients, who have no ProFixter account",
    schedule: "Immediately, on gift purchase or re-send.",
    flags: `Requires ${FLAGS.gift}. This is the ONLY type that can send while ${FLAGS.sms} is false.`,
    notes:
      "Recipient phone is typed by the purchaser and verified by nobody, so third-party consent " +
      "applies. Keeps a documented Unicode exception for its gift emoji.",
  },

  ACCOUNT_CREATED: {
    trigger: "A customer completes registration.",
    event: "notifyAccountCreated from routes/auth.js",
    appliesTo: "New customer accounts",
    schedule: "Immediately, on registration.",
    notes: "Carries the opt-out line inside the body, unusually for a transactional message.",
  },
  ACCOUNT_PASSWORD_CHANGED: {
    trigger: "An account password is changed.",
    event: "notifyPasswordChanged from routes/auth.js and routes/passwordReset.js",
    appliesTo: "All accounts",
    schedule: "Immediately, on the change.",
  },

  MEMBERSHIP_STARTED: {
    trigger: "A membership becomes active.",
    event: "notifyMembershipStarted from the Stripe webhook",
    appliesTo: "New members",
    schedule: "Immediately, on the Stripe event.",
  },
  MEMBERSHIP_CHANGED: {
    trigger: "A membership plan or billing cycle changes.",
    event: "notifyMembershipChanged from the Stripe webhook",
    appliesTo: "Existing members",
    schedule: "Immediately, on the Stripe event.",
  },
  MEMBERSHIP_CANCELLATION_SCHEDULED: {
    trigger: "A member cancels and access continues to the period end.",
    event: "notifyMembershipCancellationScheduled",
    appliesTo: "Members who cancel with time remaining",
    schedule: "Immediately, on cancellation.",
    notes: "Distinct from MEMBERSHIP_CANCELLED on purpose; conflating them would be untrue.",
  },
  MEMBERSHIP_CANCELLED: {
    trigger: "A membership actually ends.",
    event: "notifyMembershipCancelled from the Stripe webhook",
    appliesTo: "Former members",
    schedule: "Immediately, on the Stripe event.",
  },
  PAYMENT_FAILED: {
    trigger: "A membership payment fails.",
    event: "notifyPaymentFailed from the Stripe webhook",
    appliesTo: "Members with a failed charge",
    schedule: "Immediately, on the Stripe event.",
    notes:
      "There is deliberately NO upcoming-renewal or successful-renewal type. A failed payment is " +
      "an actionable problem; a routine charge is not something we volunteer a text about.",
  },

  KITCHEN_BATH_MARKETING: {
    trigger: "The hourly marketing campaign sweep selects an audience.",
    event: "jobs/smsJobs.js campaign sweep -> smsCampaignRunner",
    appliesTo: "Consenting customers matching the campaign audience",
    schedule: "Campaign sweep runs hourly at quarter past (America/New_York).",
    eligibility:
      "Requires explicit marketing consent on the account. Send window 11:00-18:00 ET. " +
      "Global cap: at most one marketing text per 30 days. Per campaign: 2 sends max, 180-day cooldown, " +
      "plus the campaign's own per-day and per-run ceilings.",
    flags: `Requires both ${FLAGS.sms} and ${FLAGS.marketing}.`,
  },
  MEMBERSHIP_MARKETING: {
    trigger: "The hourly marketing campaign sweep selects an audience.",
    event: "jobs/smsJobs.js campaign sweep -> smsCampaignRunner",
    appliesTo: "Registered non-members with marketing consent",
    schedule: "Campaign sweep runs hourly at quarter past.",
    eligibility: "Same consent, window and frequency caps as other marketing.",
    flags: `Requires both ${FLAGS.sms} and ${FLAGS.marketing}.`,
  },
  SEASONAL_MARKETING: {
    trigger: "The hourly marketing campaign sweep selects an audience.",
    event: "jobs/smsJobs.js campaign sweep -> smsCampaignRunner",
    appliesTo: "Whatever audience the campaign document defines",
    schedule: "Campaign sweep runs hourly at quarter past.",
    eligibility: "Same consent, window and frequency caps as other marketing.",
    flags: `Requires both ${FLAGS.sms} and ${FLAGS.marketing}.`,
    notes: "Body normally comes from the campaign document; the template is the fallback.",
  },
};

/* -------------------------------------------------------------------------- */
/* Email                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Friendly names and triggers for the email registry.
 *
 * Thinner than the SMS list on purpose. Email bodies are not editable in this
 * phase, so this exists to make the Emails tab a useful inventory rather than a
 * control surface, and it does not claim timings it cannot substantiate.
 */
const EMAIL_SETTINGS = {
  welcome: { label: "Welcome", trigger: "A customer completes registration.", appliesTo: "New accounts" },
  booking_created: { label: "Booking received", trigger: "A booking is created.", appliesTo: "All visit kinds" },
  booking_confirmed: { label: "Booking confirmed", trigger: "A booking is confirmed.", appliesTo: "All visit kinds" },
  booking_canceled: { label: "Booking cancelled", trigger: "A booking is cancelled.", appliesTo: "All visit kinds" },
  booking_completed: { label: "Visit completed", trigger: "An admin marks a visit complete.", appliesTo: "All visit kinds" },
  booking_reminder_24h: {
    label: "24-hour reminder",
    trigger: "The day-before reminder sweep.",
    appliesTo: "All visit kinds",
    schedule: "Due 24 hours before; catch-up down to 2 hours before; sweep runs every minute.",
  },
  booking_reminder_60m: {
    label: "60-minute reminder",
    trigger: "The hour-before reminder sweep.",
    appliesTo: "All visit kinds",
    schedule: "Due 1 hour before; still sent up to 15 minutes after start; sweep runs every minute.",
  },
  booking_review_request: { label: "Review request", trigger: "Post-visit review ask.", appliesTo: "Completed visits" },
  full_day_visit_booked: { label: "Full Day booked", trigger: "A Full Day Service is booked.", appliesTo: "Full Day Service" },
  one_time_visit_payment_received: {
    label: "One-Time Visit payment received",
    trigger: "A One-Time Visit is paid.",
    appliesTo: "One-Time Visits",
  },
  fixter_tip_received: { label: "Tip received", trigger: "A customer tips their Fixter.", appliesTo: "Fixters" },
  subscription_started: { label: "Membership started", trigger: "A membership becomes active.", appliesTo: "New members" },
  subscription_canceled: { label: "Membership ended", trigger: "A membership ends.", appliesTo: "Former members" },
  subscription_cancellation_scheduled: {
    label: "Membership cancellation scheduled",
    trigger: "A member cancels with time remaining.",
    appliesTo: "Members who cancel",
  },
  payment_failed: { label: "Payment failed", trigger: "A membership payment fails.", appliesTo: "Members" },
  password_otp: { label: "Password reset code", trigger: "A password reset is requested.", appliesTo: "All accounts" },
  password_changed: { label: "Password changed", trigger: "An account password changes.", appliesTo: "All accounts" },
  nudge_subscribe: { label: "Membership nudge", trigger: "Non-subscriber nurture.", appliesTo: "Non-members", channelClass: "marketing" },
  nurture_1: { label: "Nurture 1", trigger: "Non-subscriber nurture sequence, first email.", appliesTo: "Non-members", channelClass: "marketing" },
  nurture_2: { label: "Nurture 2", trigger: "Non-subscriber nurture sequence, second email.", appliesTo: "Non-members", channelClass: "marketing" },
  nurture_3: { label: "Nurture 3", trigger: "Non-subscriber nurture sequence, third email.", appliesTo: "Non-members", channelClass: "marketing" },
  admin_booking_canceled: { label: "Admin: booking cancelled", trigger: "A booking is cancelled.", appliesTo: "Internal" },
  admin_full_day_booked: { label: "Admin: Full Day booked", trigger: "A Full Day is booked.", appliesTo: "Internal" },
  gift_invitation: { label: "Gift invitation", trigger: "A gift membership is purchased.", appliesTo: "Gift recipients" },
  gift_purchase_confirmation: { label: "Gift purchase confirmation", trigger: "A gift is purchased.", appliesTo: "Gift buyers" },
  gift_claimed: { label: "Gift claimed", trigger: "A recipient claims a gift.", appliesTo: "Gift recipients" },
  gift_claimed_purchaser: { label: "Gift claimed (buyer copy)", trigger: "A recipient claims a gift.", appliesTo: "Gift buyers" },
  gift_claim_reminder: { label: "Gift claim reminder", trigger: "An unclaimed gift is nearing expiry.", appliesTo: "Gift recipients" },
  gift_ending_soon: { label: "Gift ending soon", trigger: "A gift membership nears its end.", appliesTo: "Gift recipients" },
  gift_expired: { label: "Gift expired", trigger: "A gift claim link expires.", appliesTo: "Gift recipients" },
  gift_claimed_admin: { label: "Admin: gift claimed", trigger: "A gift is claimed.", appliesTo: "Internal" },
  gift_purchased_admin: { label: "Admin: gift purchased", trigger: "A gift is purchased.", appliesTo: "Internal" },
  gift_refunded_admin: { label: "Admin: gift refunded", trigger: "A gift is refunded.", appliesTo: "Internal" },
  gift_unclaimed_admin: { label: "Admin: gift unclaimed", trigger: "A gift goes unclaimed.", appliesTo: "Internal" },
};

/* -------------------------------------------------------------------------- */
/* Protected content                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The parts an admin cannot remove by editing a body.
 *
 * Each of these is enforced by the renderer rather than by the template, which
 * is the only arrangement that survives somebody deleting a sentence they
 * thought was redundant.
 */
const PROTECTED_CONTENT = [
  {
    id: "marketing_opt_out",
    applies: "Every marketing SMS",
    text: "Reply STOP to opt out.",
    enforcement:
      "Appended by renderSms after the body is produced, whether that body came from the code " +
      "template or from an admin override. Deleting it from the editor changes nothing.",
  },
  {
    id: "review_link_gate",
    applies: "Completion messages",
    text: "The review link",
    enforcement:
      "Supplied through the {{completionLinks}} variable, which reads SMS_REVIEW_LINK_ENABLED. " +
      "A review URL typed directly into a body is rejected at save.",
  },
  {
    id: "brand_and_support",
    applies: "All SMS",
    text: "ProFixter / 631-599-1363 / profixter.com",
    enforcement:
      "Available only as the {{brand}}, {{supportPhone}} and {{site}} variables, which cannot be " +
      "shadowed by caller data.",
  },
  {
    id: "length_ceiling",
    applies: "All SMS",
    text: "320 characters",
    enforcement:
      "Rejected at save with an explicit error rather than silently truncated, so an admin never " +
      "discovers the cut by reading a customer's phone.",
  },
];

function smsSettingsFor(notificationType) {
  const spec = SMS_TYPES[notificationType] || {};
  const info = SMS_SETTINGS[notificationType] || {};
  return {
    trigger: info.trigger || "Not documented.",
    event: info.event || "",
    appliesTo: info.appliesTo || "",
    schedule: info.schedule || "Immediately, on the triggering event.",
    earliest: info.earliest || "",
    recovery: info.recovery || "",
    eligibility: info.eligibility || "",
    channelClass: spec.channelClass || "transactional",
    timeCritical: Boolean(spec.timeCritical),
    consent: SMS_COMMON.consent,
    flags: info.flags || `Requires ${FLAGS.sms}.`,
    ghlOverlap: info.ghlOverlap || "None known.",
    reserved: Boolean(info.reserved),
    notes: info.notes || "",
    description: spec.description || "",
  };
}

function emailSettingsFor(templateKey) {
  const info = EMAIL_SETTINGS[templateKey] || {};
  return {
    label: info.label || templateKey,
    trigger: info.trigger || "Not documented.",
    appliesTo: info.appliesTo || "",
    schedule: info.schedule || "Immediately, on the triggering event.",
    channelClass: info.channelClass || "transactional",
    editable: false,
    editableNote:
      "Email bodies are not editable yet. The defaults are JavaScript rendering functions that " +
      "produce styled HTML through shared helpers, and making them editable means authoring a safe " +
      "token form for each one. Storing executable code or raw HTML template logic would be the " +
      "wrong way to solve that, so it is deferred rather than bodged.",
  };
}

module.exports = {
  EMAIL_SETTINGS,
  FLAGS,
  PROTECTED_CONTENT,
  SMS_SETTINGS,
  emailSettingsFor,
  smsSettingsFor,
};
