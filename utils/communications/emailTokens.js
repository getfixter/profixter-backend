const { formatNYCTime, URLS } = require("../emailService");
const { actionButton } = require("./emailMarkup");

/**
 * What each email may say, and what it may never stop saying.
 *
 * Two jobs. First, the variables: every template exposes only the values that
 * are actually meaningful for it, so the editor cannot offer {{bookingDate}} on
 * a password reset and then render an empty space where a date should be.
 * Second, and more important, the PROTECTED elements.
 *
 * THE PROTECTED ELEMENT IDEA, WHICH IS THE WHOLE POINT FOR EMAIL.
 *
 * Several of these messages exist to deliver exactly one thing: a verification
 * code, a gift claim link, a signature request. Their wording is fair game -
 * that is the entire reason this feature exists - but the thing they carry is
 * not. So the secure part is never text: it arrives as a token whose value the
 * system builds, marked as pre-rendered so the markup renderer emits it
 * verbatim, and `required` says it may not be deleted from the body. An admin
 * can rewrite every sentence around a password code and cannot change, retarget
 * or remove the code itself.
 *
 * That is a stronger guarantee than "we validate the URL", because there is no
 * URL in the editable content to validate.
 */

const BRAND_NAME = "Profixter";

/** Values every email gets, and which a projection may not shadow. */
function commonTokens(vars = {}) {
  return {
    brand: BRAND_NAME,
    site: URLS.site,
    firstName: firstNameOf(vars.name || vars.firstName),
    name: String(vars.name || vars.firstName || "there"),
  };
}

function firstNameOf(value) {
  const first = String(value || "").trim().split(/\s+/)[0];
  return first || "there";
}

function money(value) {
  if (value === undefined || value === null || value === "") return "";
  const n = Number(String(value).replace(/[^0-9.-]/g, ""));
  if (!Number.isFinite(n)) return String(value);
  return `$${n.toFixed(2)}`;
}

function when(value) {
  return value ? formatNYCTime(value) : "";
}

/* Booking-shaped emails share a projection; there are a lot of them. */
function bookingTokens(vars = {}) {
  const b = vars.booking || vars;
  return {
    bookingNumber: String(b.bookingNumber || vars.bookingNumber || ""),
    bookingWhen: when(b.date || vars.date),
    service: String(b.service || vars.service || vars.selectedTask || ""),
    address: String(b.address || vars.address || ""),
    fixterFirstName: firstNameOf(vars.fixterName || vars.technicianName),
    bookingButton: actionButton(URLS.schedule, "View your visit", "primary"),
  };
}

function membershipTokens(vars = {}) {
  return {
    planName: String(vars.plan || vars.planLabel || ""),
    billingCycle: String(vars.billingCycle || ""),
    amount: money(vars.amount),
    accessUntil: when(vars.accessUntil),
    accountButton: actionButton(`${URLS.site}/account`, "Open your account", "primary"),
  };
}

/**
 * One entry per registered template.
 *
 * `protectedTokens` lists tokens the body must still contain after an edit.
 * `tokens` may not return a key that collides with a common token; commonTokens
 * is merged last for that reason.
 */
const EMAIL_DEFINITIONS = {
  /* ----------------------------- Account ----------------------------- */
  welcome: {
    label: "Welcome",
    preheader: "Welcome to Profixter.",
    tokens: (v) => ({ bookButton: actionButton(`${URLS.site}/book`, "Book your first visit") }),
  },
  password_otp: {
    label: "Password reset code",
    preheader: "Use this code to reset your password. Expires in 5 minutes.",
    /*
     * The code is the email. It is rendered by the system as a styled block and
     * must survive any rewording, which is what protectedTokens enforces.
     */
    protectedTokens: ["verificationCode"],
    tokens: (v) => ({
      verificationCode: {
        __html:
          `<div style="font-size:32px;letter-spacing:4px;font-weight:800;background:#f3f4f6;` +
          `padding:14px 18px;border-radius:10px;display:inline-block;margin:10px 0;">` +
          `${String(v.otp || "").replace(/[^0-9A-Za-z]/g, "")}</div>`,
      },
    }),
  },
  password_changed: {
    label: "Password changed",
    preheader: "Your Profixter password has been updated.",
    tokens: () => ({}),
  },

  /* ----------------------------- Bookings ---------------------------- */
  booking_created: { label: "Booking received", preheader: "We received your request.", tokens: bookingTokens },
  booking_confirmed: { label: "Booking confirmed", preheader: "Your visit is confirmed.", tokens: bookingTokens },
  booking_canceled: { label: "Booking cancelled", preheader: "Your visit was cancelled.", tokens: bookingTokens },
  booking_completed: {
    label: "Visit completed",
    preheader: "Your visit is complete.",
    tokens: (v) => ({
      ...bookingTokens(v),
      tipButton: actionButton(URLS.tip, "Tip your Fixter", "green"),
    }),
  },
  booking_reminder_24h: { label: "24-hour reminder", preheader: "Your visit is tomorrow.", tokens: bookingTokens },
  booking_reminder_60m: { label: "60-minute reminder", preheader: "Your visit is coming up.", tokens: bookingTokens },
  booking_review_request: {
    label: "Review request",
    preheader: "How did we do?",
    tokens: (v) => ({
      ...bookingTokens(v),
      reviewButton: actionButton(URLS.review, "Leave a review", "primary"),
    }),
  },
  full_day_visit_booked: { label: "Full Day booked", preheader: "Your Full Day Service is booked.", tokens: bookingTokens },
  one_time_visit_payment_received: {
    label: "One-Time Visit payment received",
    preheader: "We received your payment.",
    tokens: (v) => ({ ...bookingTokens(v), amount: money(v.amount) }),
  },
  fixter_tip_received: {
    label: "Tip received",
    preheader: "You received a tip.",
    tokens: (v) => ({ ...bookingTokens(v), amount: money(v.amount) }),
  },

  /* ---------------------------- Membership --------------------------- */
  subscription_started: { label: "Membership started", preheader: "Your membership is active.", tokens: membershipTokens },
  subscription_canceled: { label: "Membership ended", preheader: "Your membership has ended.", tokens: membershipTokens },
  subscription_cancellation_scheduled: {
    label: "Membership cancellation scheduled",
    preheader: "Your cancellation is confirmed.",
    tokens: membershipTokens,
  },
  payment_failed: {
    label: "Payment failed",
    preheader: "We could not process your payment.",
    protectedTokens: ["accountButton"],
    tokens: membershipTokens,
  },

  /* ----------------------------- Nurture ----------------------------- */
  nudge_subscribe: { label: "Membership nudge", channelClass: "marketing", preheader: "Home help, handled.", tokens: membershipTokens },
  nurture_1: { label: "Nurture 1", channelClass: "marketing", preheader: "We are here when you need us.", tokens: () => ({}) },
  nurture_2: { label: "Nurture 2", channelClass: "marketing", preheader: "A little help goes a long way.", tokens: () => ({}) },
  nurture_3: { label: "Nurture 3", channelClass: "marketing", preheader: "No pressure, just here.", tokens: () => ({}) },

  /* ------------------------------ Gifts ------------------------------ */
  gift_invitation: {
    label: "Gift invitation",
    preheader: "Somebody sent you a gift.",
    /* The claim link is the email; it carries a single-use expiring token. */
    protectedTokens: ["giftClaimButton"],
    tokens: (v) => ({
      fromName: String(v.from || v.fromName || "Someone"),
      planName: String(v.plan || ""),
      durationMonths: String(v.durationMonths || ""),
      occasion: String(v.occasion || ""),
      giftClaimButton: actionButton(v.claimUrl, "Open your gift", "primary"),
    }),
  },
  gift_claim_reminder: {
    label: "Gift claim reminder",
    preheader: "Your gift is waiting.",
    protectedTokens: ["giftClaimButton"],
    tokens: (v) => ({
      fromName: String(v.from || v.fromName || "Someone"),
      giftClaimButton: actionButton(v.claimUrl, "Open your gift", "primary"),
    }),
  },
  gift_purchase_confirmation: {
    label: "Gift purchase confirmation",
    preheader: "Your gift is on its way.",
    tokens: (v) => ({
      recipientName: String(v.recipientName || ""),
      planName: String(v.plan || ""),
      durationMonths: String(v.durationMonths || ""),
      amount: money(v.amount),
    }),
  },
  gift_claimed: { label: "Gift claimed", preheader: "Your gift membership is active.", tokens: membershipTokens },
  gift_claimed_purchaser: {
    label: "Gift claimed (buyer copy)",
    preheader: "Your gift was opened.",
    tokens: (v) => ({ recipientName: String(v.recipientName || "") }),
  },
  gift_ending_soon: { label: "Gift ending soon", preheader: "Your gift membership ends soon.", tokens: membershipTokens },
  gift_expired: { label: "Gift expired", preheader: "Your gift claim link expired.", tokens: () => ({}) },

  /* ------------------------- Internal / admin ------------------------ */
  admin_booking_canceled: { label: "Admin: booking cancelled", channelClass: "internal", preheader: "", tokens: bookingTokens },
  admin_full_day_booked: { label: "Admin: Full Day booked", channelClass: "internal", preheader: "", tokens: bookingTokens },
  gift_claimed_admin: { label: "Admin: gift claimed", channelClass: "internal", preheader: "", tokens: (v) => ({ recipientName: String(v.recipientName || "") }) },
  gift_purchased_admin: { label: "Admin: gift purchased", channelClass: "internal", preheader: "", tokens: (v) => ({ amount: money(v.amount) }) },
  gift_refunded_admin: { label: "Admin: gift refunded", channelClass: "internal", preheader: "", tokens: (v) => ({ amount: money(v.amount) }) },
  gift_unclaimed_admin: { label: "Admin: gift unclaimed", channelClass: "internal", preheader: "", tokens: () => ({}) },
};

/** The full token map for one render. Common values win. */
function buildEmailTokens(templateKey, vars = {}) {
  const def = EMAIL_DEFINITIONS[templateKey];
  let specific = {};
  if (def) {
    try {
      specific = def.tokens(vars) || {};
    } catch {
      specific = {};
    }
  }
  return { ...specific, ...commonTokens(vars) };
}

/** Token names the editor may offer for this template. */
function emailTokenNames(templateKey) {
  return [...new Set(Object.keys(buildEmailTokens(templateKey, SAMPLE_EMAIL_VARS)))].sort();
}

function protectedTokensFor(templateKey) {
  return EMAIL_DEFINITIONS[templateKey]?.protectedTokens || [];
}

/** Sample values for Preview. Never a real customer record. */
const SAMPLE_EMAIL_VARS = {
  name: "Sam Rivera",
  firstName: "Sam",
  email: "sam@example.com",
  otp: "123456",
  plan: "Premium",
  planLabel: "Premium",
  billingCycle: "monthly",
  amount: 99,
  accessUntil: "2026-04-01T12:00:00.000Z",
  bookingNumber: "10000001",
  date: "2026-03-03T19:00:00.000Z",
  service: "Handyman visit",
  address: "1 Main St, Huntington, NY 11743",
  fixterName: "Alex Morgan",
  technicianName: "Alex Morgan",
  claimUrl: "https://www.profixter.com/gift/claim/sample-token",
  from: "Sam Rivera",
  recipientName: "Jordan Lee",
  durationMonths: 2,
  occasion: "Birthday",
  userId: "10000001",
};

module.exports = {
  EMAIL_DEFINITIONS,
  SAMPLE_EMAIL_VARS,
  buildEmailTokens,
  emailTokenNames,
  protectedTokensFor,
};
