const adminSubjects = require("../utils/adminSubjects");
const metaCapi = require("../utils/metaCapi");
const crypto = require("crypto");
const mongoose = require("mongoose");
const User = require("../models/User");
const Booking = require("../models/Booking");
const Subscription = require("../models/Subscription");
const VisitEntitlement = require("../models/VisitEntitlement");
const StripeWebhookEvent = require("../models/StripeWebhookEvent");
const BookingSlotReservation = require("../models/BookingSlotReservation");
const ReservationTimeBucket = require("../models/ReservationTimeBucket");
const ReservationCapacityBucket = require("../models/ReservationCapacityBucket");
const Tip = require("../models/Tip");
const {
  handleGiftCheckoutCompleted,
  handleGiftRefund,
  isGiftSession,
} = require("../utils/gifts/giftWebhook");
const { markLinkPaidFromSession: markAdminPaymentLinkPaid } = require("../utils/admin/paymentLinks");
const extraCharges = require("../utils/extraCharges");
const {
  recordRenewal: recordLoyaltyRenewal,
  reverseFromCharge: reverseLoyaltyFromCharge,
} = require("../utils/loyalty/loyaltyService");
const {
  sendGiftPurchaseEmails,
  sendGiftPurchasedAdminNotice,
} = require("../utils/gifts/giftEmails");
/*
 * Money is always the customer's. An email can now also carry a Fixter
 * account, and letting one answer a billing lookup would attach a real
 * subscription or invoice to a staff record that has neither.
 */
const { findBillingUserByEmail } = require("../utils/userLookup");
const {
  applyRefundToTip,
  isEligibleFixter,
  isFixterTipCheckoutSession,
  tipRecordFromCheckoutSession,
} = require("../utils/fixterTips");
const mail = require("../utils/emailService");
const smsNotify = require("../utils/sms/smsNotifications");
const {
  cancelBookingWithReservation,
  promoteHeldReservationForBooking,
  reservationEngineEnabled,
  releaseCheckoutHold,
} = require("../utils/slotReservationService");
const { markFirstVisitPaid, markFirstVisitExpired, fulfillFirstVisitDraft } = require("../utils/membershipFirstVisitFulfillment");
const freeVisitConversion = require("../utils/freeVisit/conversion");
const salesStripe = require("../utils/sales/stripeEvents");
const CalendarConfig = require("../models/CalendarConfig");
const SlotCounter = require("../models/SlotCounter");
const {
  stripe,
  getPlanPrice,
  retrieveStripeSubscription,
  upsertSubscriptionFromStripe,
  syncCustomerFromStripe,
  handlePaymentFailure,
  ENDED_STRIPE_STATUSES,
  REPLACED_BY_METADATA_KEY,
  HOME_ALREADY_ACTIVE,
  billingStripeSubscriptionsForAddress,
} = require("../utils/subscriptionManagement");
const {
  applyOneTimePaymentSuccessToBooking,
  applyOneTimePaymentSuccessToEntitlement,
  oneTimeReservationProtectionExpiresAt,
  reservationIssueFromPromotionError,
} = require("../utils/oneTimeVisitPaymentFlow");
const {
  claimPaidVisitSettlement,
  recordPaidVisitDecline,
  releasePaidVisitClaim,
  sessionIsPaid,
} = require("../utils/paidVisitSettlement");
const {
  sendAdminEventNotification,
} = require("../utils/adminLeadNotification");
const { adminLink } = require("../utils/operationalEmail");
const {
  FULL_DAY_PRODUCT_KIND,
  releaseFullDayCapacity,
} = require("../utils/fullDayVisitService");
const { getFullDayVisitSettings } = require("../utils/fullDayVisitSettings");
const { proposeCheckoutRecovery } = require("../utils/growth/checkoutRecovery");

const ONE_TIME_PRODUCT_KIND = "one_time_handyman_visit";

function logWebhook(level, event, details = {}) {
  const payload = JSON.stringify({
    level,
    event,
    scope: "stripe_webhook",
    ...details,
  });
  if (level === "error") console.error(payload);
  else if (level === "warn") console.warn(payload);
  else console.log(payload);
}

function sha256(value) {
  if (!value) return undefined;
  return crypto
    .createHash("sha256")
    .update(String(value).trim().toLowerCase())
    .digest("hex");
}

function normPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return "1" + digits;
  return digits;
}

function cleanObject(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      const filtered = value.filter(
        (entry) => entry !== undefined && entry !== null && String(entry).trim() !== ""
      );
      if (!filtered.length) continue;
      out[key] = filtered;
      continue;
    }
    if (typeof value === "string" && value.trim() === "") continue;
    out[key] = value;
  }
  return out;
}

/*
 * The webhook's own Meta sender used to live here, with its own copy of the
 * pixel id read from FB_PIXEL_ID - which is how this file kept writing to the
 * old dataset after the pixel was replaced. It is gone; utils/metaCapi.js is
 * the only way out to Meta now, and it names the dataset in code.
 */

/* findBestLeadMatch / markLeadSubscribed: retired 2026-11 (see the note in handleCheckoutCompleted). */

async function findUserForStripeObject(stripeObject) {
  const metadata = stripeObject?.metadata || {};

  if (stripeObject?.customer) {
    const byCustomer = await User.findOne({ stripeCustomerId: String(stripeObject.customer) });
    if (byCustomer) return byCustomer;
  }

  const metadataUserId = String(metadata.userId || "").trim();
  if (metadataUserId) {
    const byPublicId = await User.findOne({ userId: metadataUserId });
    if (byPublicId) return byPublicId;
  }

  const metadataEmail = String(metadata.email || "").trim().toLowerCase();
  if (metadataEmail) {
    const byEmail = await findBillingUserByEmail(metadataEmail);
    if (byEmail) return byEmail;
  }

  if (stripeObject?.customer) {
    try {
      const customer = await stripe.customers.retrieve(stripeObject.customer);
      const customerEmail = String(customer?.email || "").trim().toLowerCase();
      if (customerEmail) {
        const byCustomerEmail = await findBillingUserByEmail(customerEmail);
        if (byCustomerEmail) return byCustomerEmail;
      }
    } catch (error) {
      console.warn("Unable to retrieve Stripe customer during webhook:", error.message);
    }
  }

  return null;
}

async function releaseLegacyBookingCapacity(booking) {
  if (!booking?.date) return;
  const cfg = await CalendarConfig.findOne().lean();
  const tz = cfg?.timezone || "America/New_York";
  const ymd = ymdInTZ(new Date(booking.date), tz);
  const hh = hhmmInTZ(new Date(booking.date), tz);
  await SlotCounter.updateOne({ ymd, time: hh }, { $inc: { count: -1 } });
}

/**
 * "Plus - $249/month", the one line that says what was actually bought.
 *
 * Built here rather than in the template so the plan name and the money stay
 * together; separately they are two rows a reader has to reassemble.
 */
function newMemberHighlight(subscription) {
  const plan = String(subscription?.subscriptionType || "").trim();
  const label = plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : "Membership";
  const price = getPlanPrice
    ? getPlanPrice(subscription?.subscriptionType, subscription?.billingCycle)
    : null;
  const period = subscription?.billingCycle === "annual" ? "year" : "month";
  return Number.isFinite(Number(price))
    ? `${label} - $${Number(price)}/${period}`
    : label;
}

function formatAdminMoney(amount, currency = "usd") {
  if (amount === undefined || amount === null || amount === "") return "Not available";
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return String(amount);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: String(currency || "usd").toUpperCase(),
  }).format(numeric / 100);
}

function formatAddressParts(parts = {}) {
  return [
    parts.line1 || parts.address,
    parts.city,
    parts.state,
    parts.zip,
    parts.county,
  ]
    .filter(Boolean)
    .join(", ");
}

const ADMIN_NOT_AVAILABLE = "Not Available";
const NO_PROMOTION_USED = "No Promotion Used";

function adminDate(value) {
  if (!value) return ADMIN_NOT_AVAILABLE;
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? mail.formatNYCTime(date)
    : ADMIN_NOT_AVAILABLE;
}

function titleCaseWords(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function stripeId(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  return value.id ? String(value.id) : "";
}

function firstNumber(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function subscriptionItem(stripeSubscription) {
  return stripeSubscription?.items?.data?.[0] || null;
}

function subscriptionPrice(stripeSubscription) {
  const item = subscriptionItem(stripeSubscription);
  return item?.price || item?.plan || null;
}

function subscriptionPriceCents(stripeSubscription, fallbackPlan, fallbackBillingCycle) {
  const price = subscriptionPrice(stripeSubscription);
  // Stripe's own amount first. The plan table is only reached when the price did
  // not expand, and it has to follow the cycle or an annual sale falls back to
  // the monthly figure.
  const planDollars = getPlanPrice(fallbackPlan, fallbackBillingCycle);
  return firstNumber(
    price?.unit_amount,
    price?.amount,
    price?.unit_amount_decimal,
    planDollars ? planDollars * 100 : null
  );
}

function subscriptionCurrency(stripeSubscription, session, fallback = "usd") {
  const price = subscriptionPrice(stripeSubscription);
  return String(
    session?.currency ||
      price?.currency ||
      stripeSubscription?.currency ||
      fallback ||
      "usd"
  ).toUpperCase();
}

function subscriptionInterval(stripeSubscription, billingCycle) {
  const price = subscriptionPrice(stripeSubscription);
  const interval = price?.recurring?.interval || price?.interval || "";
  if (interval) return interval === "year" ? "year" : "month";
  return String(billingCycle || "").toLowerCase() === "annual" ? "year" : "month";
}

function intervalLabel(interval) {
  return interval === "year" ? "year" : "month";
}

function formatAdminMoneyValue(amount, currency = "usd") {
  const value = formatAdminMoney(amount, currency);
  return value === "Not available" ? ADMIN_NOT_AVAILABLE : value;
}

function formatRecurringAmount(cents, currency, interval) {
  if (cents === undefined || cents === null) return ADMIN_NOT_AVAILABLE;
  return `${formatAdminMoneyValue(cents, currency)}/${intervalLabel(interval)}`;
}

function formatDiscountApplied(cents, currency) {
  if (cents === undefined || cents === null) return ADMIN_NOT_AVAILABLE;
  const numeric = Number(cents);
  if (!Number.isFinite(numeric)) return ADMIN_NOT_AVAILABLE;
  if (numeric === 0) return formatAdminMoneyValue(0, currency);
  return `-${formatAdminMoneyValue(Math.abs(numeric), currency)}`;
}

function expandedInvoice(stripeSubscription) {
  return stripeSubscription?.latest_invoice &&
    typeof stripeSubscription.latest_invoice !== "string"
    ? stripeSubscription.latest_invoice
    : null;
}

function expandedPaymentIntent(invoice) {
  return invoice?.payment_intent && typeof invoice.payment_intent !== "string"
    ? invoice.payment_intent
    : null;
}

async function retrieveCheckoutLineItemsForAdmin(sessionId) {
  if (!sessionId) return [];
  try {
    const result = await stripe.checkout.sessions.listLineItems(String(sessionId), {
      limit: 10,
      expand: [
        "data.discounts.discount.coupon",
        "data.discounts.discount.promotion_code",
      ],
    });
    return result?.data || [];
  } catch (error) {
    logWebhook("warn", "admin_member_line_items_expand_failed", {
      stripeSessionId: sessionId,
      message: error?.message || "Unable to expand checkout line item discounts",
    });
    try {
      const result = await stripe.checkout.sessions.listLineItems(String(sessionId), {
        limit: 10,
      });
      return result?.data || [];
    } catch (fallbackError) {
      logWebhook("warn", "admin_member_line_items_failed", {
        stripeSessionId: sessionId,
        message: fallbackError?.message || "Unable to retrieve checkout line items",
      });
      return [];
    }
  }
}

function pushDiscountEntry(entries, value, amount = null) {
  if (!value) return;
  if (Array.isArray(value)) {
    value.forEach((entry) => pushDiscountEntry(entries, entry, amount));
    return;
  }
  const discount = value.discount || value;
  entries.push({
    raw: value,
    discount,
    amount: firstNumber(value.amount, value.amount_discount, amount),
  });
}

function collectDiscountEntries({ session, stripeSubscription, invoice, lineItems }) {
  const entries = [];
  pushDiscountEntry(entries, session?.discounts);
  pushDiscountEntry(entries, session?.total_details?.breakdown?.discounts);
  pushDiscountEntry(entries, stripeSubscription?.discount);
  pushDiscountEntry(entries, stripeSubscription?.discounts);
  pushDiscountEntry(entries, invoice?.discount);
  pushDiscountEntry(entries, invoice?.discounts);
  for (const amount of invoice?.total_discount_amounts || []) {
    pushDiscountEntry(entries, amount.discount, amount.amount);
  }
  for (const lineItem of lineItems || []) {
    pushDiscountEntry(entries, lineItem.discounts);
  }
  return entries;
}

function discountObjectValue(value, fallbackKey) {
  if (!value) return null;
  if (typeof value === "string") return { id: value };
  if (typeof value === "object") return value[fallbackKey] || value;
  return null;
}

function discountDetailsFromEntry(entry) {
  const discount = entry?.discount || {};
  const promotionCode = discountObjectValue(
    discount.promotion_code || entry?.raw?.promotion_code,
    "promotion_code"
  );
  const coupon = discountObjectValue(
    discount.coupon || entry?.raw?.coupon,
    "coupon"
  );
  return { promotionCode, coupon };
}

function discountTypeAndValue(coupon, amountDiscount, currency) {
  if (coupon?.percent_off !== undefined && coupon?.percent_off !== null) {
    return {
      type: "Percentage",
      value: `${coupon.percent_off}%`,
    };
  }
  if (coupon?.amount_off !== undefined && coupon?.amount_off !== null) {
    return {
      type: "Fixed Amount",
      value: formatAdminMoneyValue(coupon.amount_off, coupon.currency || currency),
    };
  }
  if (amountDiscount > 0) {
    return {
      type: "Fixed Amount",
      value: formatAdminMoneyValue(amountDiscount, currency),
    };
  }
  return {
    type: ADMIN_NOT_AVAILABLE,
    value: ADMIN_NOT_AVAILABLE,
  };
}

function promotionDetails({ session, stripeSubscription, invoice, lineItems, currency }) {
  const entries = collectDiscountEntries({
    session,
    stripeSubscription,
    invoice,
    lineItems,
  });
  const lineItemDiscountTotal = (lineItems || []).reduce((sum, item) => {
    const itemDiscount = (item.discounts || []).reduce(
      (inner, discount) => inner + Number(discount.amount || 0),
      0
    );
    return sum + itemDiscount;
  }, 0);
  const invoiceDiscountTotal = (invoice?.total_discount_amounts || []).reduce(
    (sum, item) => sum + Number(item.amount || 0),
    0
  );
  const amountDiscount = firstNumber(
    session?.total_details?.amount_discount,
    invoiceDiscountTotal || null,
    lineItemDiscountTotal || null,
    0
  );
  const firstDetailedEntry = entries.find((entry) => {
    const details = discountDetailsFromEntry(entry);
    return stripeId(details.promotionCode) || stripeId(details.coupon);
  }) || entries[0] || null;
  const { promotionCode, coupon } = discountDetailsFromEntry(firstDetailedEntry);
  const metadataCode =
    session?.metadata?.promoCode ||
    session?.metadata?.promotionCode ||
    session?.metadata?.discountCode ||
    "";
  const used =
    Number(amountDiscount || 0) > 0 ||
    !!stripeId(promotionCode) ||
    !!stripeId(coupon) ||
    !!metadataCode;
  const typeValue = used
    ? discountTypeAndValue(coupon, amountDiscount, currency)
    : { type: NO_PROMOTION_USED, value: NO_PROMOTION_USED };

  return {
    used,
    status: used ? "Promotion Applied" : NO_PROMOTION_USED,
    promotionCodeUsed:
      promotionCode?.code || metadataCode || (used ? ADMIN_NOT_AVAILABLE : NO_PROMOTION_USED),
    stripePromotionCode:
      stripeId(promotionCode) || (used ? ADMIN_NOT_AVAILABLE : NO_PROMOTION_USED),
    stripeCouponId: stripeId(coupon) || (used ? ADMIN_NOT_AVAILABLE : NO_PROMOTION_USED),
    discountType: typeValue.type,
    discountValue: typeValue.value,
    amountDiscount: amountDiscount ?? null,
    /*
     * The coupon object itself, so the notification can read percent_off and
     * duration without re-deriving them from the formatted strings above.
     * Never rendered directly; only its human-readable parts are used.
     */
    couponObject: coupon || null,
  };
}

/**
 * The human-readable name for whatever discount was applied.
 *
 * Preference order is what the customer would recognise: the promotion code
 * they typed, then the coupon's display name, then nothing. A Stripe id is
 * never shown, because "promo_1Twp..." tells the person reading the email
 * less than "a discount was applied" does.
 */
function promotionDisplayName(promotion, coupon) {
  const typed = String(promotion?.promotionCodeUsed || "").trim();
  if (typed && typed !== ADMIN_NOT_AVAILABLE && typed !== NO_PROMOTION_USED) return typed;
  const couponName = String(coupon?.name || "").trim();
  if (couponName) return couponName;
  return "Applied at checkout";
}

/**
 * How long the discount lasts, when Stripe says it outlives this payment.
 *
 * Silence means once. Saying nothing about duration is safer than implying
 * permanence, so this only speaks up when Stripe explicitly says repeating or
 * forever.
 */
function promotionDurationNote(coupon) {
  const duration = String(coupon?.duration || "").toLowerCase();
  if (duration === "forever") return "Applies to every payment";
  if (duration === "repeating") {
    const months = Number(coupon?.duration_in_months);
    return Number.isFinite(months) && months > 0
      ? `Applies to the first ${months} months`
      : "Applies to more than one payment";
  }
  return "";
}

/**
 * Discount rows for the membership-started notification, or nothing at all.
 *
 * Returns an empty array when no promotion was used, so the ordinary email
 * stays exactly as compact as it was. When one was used, the dollars come
 * first: a 30% coupon on an annual Premium plan is only useful to somebody
 * reconciling payments if they can see it was $447.
 *
 * Every figure comes from Stripe. The discount is Stripe's own computed
 * total_details.amount_discount rather than a percentage multiplied out here,
 * so proration, multiple discounts and rounding are Stripe's answer and not a
 * guess of ours.
 */
function promotionAdminRows({ promotion, coupon, currency, amountPaid }) {
  if (!promotion?.used) return [];

  const rows = [["Promotion", promotionDisplayName(promotion, coupon)]];

  const discountCents = Number(promotion.amountDiscount);
  if (Number.isFinite(discountCents) && discountCents > 0) {
    const percent =
      coupon?.percent_off !== undefined && coupon?.percent_off !== null
        ? ` (${coupon.percent_off}% off)`
        : "";
    rows.push(["Discount", `${formatAdminMoneyValue(discountCents, currency)}${percent}`]);
  } else if (promotion.discountValue && promotion.discountValue !== ADMIN_NOT_AVAILABLE) {
    // Stripe gave a coupon but no computed amount, which happens on a fully
    // discounted first payment. Show what it does rather than a false zero.
    rows.push(["Discount", String(promotion.discountValue)]);
  }

  /*
   * Null and zero are different answers. Zero is a real, reportable amount on a
   * fully discounted first payment; null means Stripe did not tell us and the
   * row is left out rather than filled with a placeholder. Number(null) is 0,
   * so the emptiness has to be checked before the number is.
   */
  const paidKnown = amountPaid !== null && amountPaid !== undefined && amountPaid !== "";
  if (paidKnown && Number.isFinite(Number(amountPaid))) {
    rows.push(["Paid", formatAdminMoneyValue(amountPaid, currency)]);
  }

  const duration = promotionDurationNote(coupon);
  if (duration) rows.push(["Duration", duration]);

  return rows;
}

async function buildNewMemberAdminSections({
  session,
  stripeSubscription,
  subscription,
  user,
  plan,
  billingCycle,
  prevPurchase,
  now,
}) {
  const invoice = expandedInvoice(stripeSubscription);
  const paymentIntent = expandedPaymentIntent(invoice);
  const lineItems = await retrieveCheckoutLineItemsForAdmin(session.id);
  const currency = subscriptionCurrency(stripeSubscription, session, subscription?.currency || "usd");
  const priceCents = subscriptionPriceCents(stripeSubscription, plan, billingCycle);
  const interval = subscriptionInterval(stripeSubscription, billingCycle);
  const promotion = promotionDetails({
    session,
    stripeSubscription,
    invoice,
    lineItems,
    currency,
  });
  const amountChargedToday = firstNumber(
    session.amount_total,
    invoice?.amount_paid,
    invoice?.amount_due
  );
  const paymentStatus = [
    session.payment_status,
    invoice?.status ? `invoice ${invoice.status}` : "",
    paymentIntent?.status ? `payment ${paymentIntent.status}` : "",
  ]
    .filter(Boolean)
    .join(" / ");
  const address = subscription.addressSnapshot || {};

  return [
    {
      title: "CUSTOMER",
      fields: [
        ["Full Name", user.name],
        ["Phone", user.phone],
        ["Email", user.email],
      ],
    },
    {
      title: "SERVICE PROPERTY",
      fields: [
        ["Street Address", address.line1],
        ["City", address.city],
        ["State", address.state],
        ["ZIP", address.zip],
        ["County", address.county],
      ],
    },
    {
      title: "MEMBERSHIP",
      fields: [
        ["Plan Name", plan ? `${titleCaseWords(plan)} Membership` : subscription.subscriptionType],
        ["Membership Price", formatRecurringAmount(priceCents, currency, interval)],
        ["Membership Started", adminDate(subscription.startDate || now)],
        ["Renewal Date", adminDate(subscription.currentPeriodEnd || subscription.nextPaymentDate)],
        ["Current Status", subscription.status || stripeSubscription.status],
      ],
    },
    {
      title: "PAYMENT",
      fields: [
        ["Original Plan Price", formatAdminMoneyValue(priceCents, currency)],
        ["Discount Applied", formatDiscountApplied(promotion.amountDiscount, currency)],
        ["Amount Charged Today", formatAdminMoneyValue(amountChargedToday, currency)],
        ["Recurring Renewal Amount", formatRecurringAmount(priceCents, currency, interval)],
        ["Currency", currency],
        ["Payment Status", paymentStatus],
      ],
    },
    {
      title: "PROMOTION",
      fields: [
        ["Promotion", promotion.status],
        ["Promotion Code Used", promotion.promotionCodeUsed],
        ["Stripe Promotion Code", promotion.stripePromotionCode],
        ["Stripe Coupon ID", promotion.stripeCouponId],
        ["Discount Type", promotion.discountType],
        ["Discount Value", promotion.discountValue],
      ],
    },
    {
      title: "STRIPE",
      fields: [
        ["Stripe Customer ID", session.customer || subscription.stripeCustomerId],
        ["Stripe Subscription ID", stripeSubscription.id || subscription.stripeSubscriptionId],
        ["Stripe Checkout Session ID", session.id],
        ["Stripe Payment Intent ID (if available)", stripeId(paymentIntent) || session.payment_intent],
        ["Invoice ID (if available)", invoice?.id || session.invoice || subscription.latestInvoiceId],
      ],
    },
    {
      title: "SYSTEM",
      fields: [
        ["Customer ID", user.userId],
        ["Registration Date", adminDate(user.createdAt)],
        ["IP Address (if already available)", prevPurchase?.clientIp],
        ["Referral / Source (if already tracked)", prevPurchase?.sourceUrl || session.metadata?.source_url],
        ["User Mongo ID", user._id],
        ["Subscription Mongo ID", subscription._id],
        ["Address ID", subscription.addressId],
      ],
    },
  ];
}

/* The contact a no-account Admin booking carries, shaped like the User fields the senders read. */
function guestContactFromBooking(booking) {
  return { _id: null, userId: "", name: booking.name || "", email: booking.email || "", phone: booking.phone || "", addresses: [], isGuest: true };
}

/*
 * Owner decision Q-2 (2026-11-12): a paid visit the owner booked in Admin
 * (createdByAdmin) waits in its payment-pending state until Stripe confirms
 * the payment - this handler - and is then Confirmed, provided the reservation
 * was promoted cleanly and a technician is assigned. A visit the customer
 * booked themselves keeps owner review (Pending), exactly as before. Status,
 * the customer's email and text, and the reminders (which select Confirmed
 * bookings) therefore agree.
 */
function confirmAdminPaidVisit(booking, reservationIssue) {
  if (!booking?.createdByAdmin?.at || reservationIssue) return false;
  if (!reservationEngineEnabled() || !booking.slotReservationId || !booking.assignedFixterId) return false;
  booking.status = "Confirmed";
  for (const field of ["reminder24hQueuedAt", "reminder24hSentAt", "reminder24hSkippedAt", "reminder60mQueuedAt", "reminder60mSentAt"]) {
    booking[field] = undefined;
  }
  booking.reminder24hSkipReason = "";
  return true;
}

/* "$99": the payment-received template prints this verbatim ("We received your $99 payment"). */
function oneTimePaymentPriceLabel(entitlement) {
  return `$${((entitlement?.priceCents || 9900) / 100).toFixed(0)}`;
}

async function sendOneTimePaymentEmails({ booking, user, entitlement, session }) {
  const confirmedNow = /^confirmed$/i.test(String(booking.status || ""));
  const address = [booking.address, booking.city, booking.state, booking.zip]
    .filter(Boolean)
    .join(", ");

  try {
    await mail.sendTx(
      // An Admin-booked visit confirmed on payment gets the confirmation, not "awaiting review".
      confirmedNow ? "booking_confirmed" : "one_time_visit_payment_received",
      booking.email || user.email,
      {
        name: booking.name || user.name || "there",
        bookingNumber: booking.bookingNumber,
        date: booking.date,
        service: booking.service,
        selectedTask: booking.selectedTask,
        address,
        bookingType: booking.bookingType,
        accessType: booking.accessType,
        price: oneTimePaymentPriceLabel(entitlement),
        durationMinutes: entitlement?.durationMinutes || 90,
      },
      {
        bccAdmin: false,
        logContext: {
          bookingId: booking._id,
          bookingNumber: booking.bookingNumber,
          customerName: booking.name || user.name || "",
          customerEmail: booking.email || user.email || "",
          recipientName: booking.name || user.name || "",
          recipientEmail: booking.email || user.email || "",
          emailType: "billing",
          source: "stripeWebhookOneTime",
        },
      }
    );
  } catch (error) {
    console.error("one_time_visit_payment_received email failed:", error.message);
  }

  /*
   * The One-Time Visit confirmation.
   *
   * Sent here, from the payment webhook, rather than when the booking row
   * was created: a one-time visit is not confirmed until it is paid for,
   * and telling somebody their visit is booked while the hold could still
   * expire would be a promise we might not keep.
   *
   * The template says 90 minutes and calls it a One-Time Visit, which is
   * right for this product and wrong for the other three. The visit
   * vocabulary in the templates picks the wording from the booking itself.
   */
  await smsNotify.notifyBookingConfirmed(booking, user?.isGuest ? null : user, "stripeWebhookOneTime");

  try {
    /*
     * Seventeen rows became six.
     *
     * The Stripe session id, payment intent id, entitlement id, booking id,
     * payment state and payment status were all in here. None of them answer
     * "what happened, who, how much, do I need to act", and every one of them
     * is a click away in Admin. The reservation issue survives because it is
     * the only row that ever demands action.
     */
    await sendAdminEventNotification({
      subject: adminSubjects.payment("One-Time Visit Paid", { amount: formatAdminMoney(session?.amount_total ?? entitlement?.priceCents, session?.currency || entitlement?.currency || "usd"), name: booking.name || user.name }),
      heading: "One-time visit paid",
      templateKey: "admin_one_time_visit_paid",
      replyToEmail: booking.email || user.email || "",
      customerName: booking.name || user.name || "",
      customerEmail: booking.email || user.email || "",
      source: "stripeWebhookOneTime",
      who: booking.name || user.name || "Customer",
      highlight: formatAdminMoney(
        session?.amount_total ?? entitlement?.priceCents,
        session?.currency || entitlement?.currency || "usd"
      ),
      fields: [
        ["When", booking.date ? mail.formatNYCTime(booking.date) : ""],
        ["Task", booking.selectedTask || booking.service],
        ["Address", formatAddressParts({
          address: booking.address,
          city: booking.city,
          state: booking.state,
          zip: booking.zip,
          county: booking.county,
        })],
        ["Phone", booking.phone || user.phone],
        ["Booking", booking.bookingNumber ? `#${booking.bookingNumber}` : ""],
        ["Needs attention", booking.reservationIssue?.message || ""],
      ],
      note: booking.note || "",
      action: { label: "View Booking", url: adminLink.booking(booking._id) },
    }, {
      logContext: {
        bookingId: booking._id,
        bookingNumber: booking.bookingNumber,
      },
    });
  } catch (error) {
    console.error("admin one-time payment email failed:", error.message);
  }
}

async function preserveHeldReservationAfterPromotionFailure({ booking, error, session }) {
  const holdExpiresAt = oneTimeReservationProtectionExpiresAt(booking?.date);
  const issueMessage =
    error?.message ||
    "Stripe payment succeeded, but reservation promotion failed.";

  const reservation = await BookingSlotReservation.findOneAndUpdate(
    { bookingId: booking._id, status: "held" },
    {
      $set: {
        holdExpiresAt,
        releaseReason: `Payment received; admin reservation review required. ${issueMessage}`.slice(0, 500),
      },
    },
    { new: true }
  );

  if (!reservation) {
    logWebhook("error", "one_time_reservation_hold_missing_after_payment", {
      stripeSessionId: session?.id || null,
      bookingId: String(booking._id),
      message: issueMessage,
    });
    return { holdExpiresAt: null, reservationId: null };
  }

  await Promise.all([
    ReservationTimeBucket.updateMany(
      { reservationId: reservation._id, status: "held" },
      { $set: { expiresAt: holdExpiresAt } }
    ),
    ReservationCapacityBucket.updateMany(
      { reservationId: reservation._id, status: "held" },
      { $set: { expiresAt: holdExpiresAt } }
    ),
  ]);

  logWebhook("error", "one_time_reservation_hold_preserved_for_admin_review", {
    stripeSessionId: session?.id || null,
    bookingId: String(booking._id),
    reservationId: String(reservation._id),
    holdExpiresAt,
    message: issueMessage,
    code: error?.code || null,
  });

  return { holdExpiresAt, reservationId: String(reservation._id) };
}

/*
 * A sale made by staff - Admin pay-by-phone, an Admin payment link, an Admin
 * visit checkout or an Admin gift (2026-11-03). Not a website conversion: Meta
 * would match the customer by email or phone and credit some earlier ad, and
 * the membership path used to reuse the customer's previous checkout event id,
 * which Meta could drop as a duplicate. Reported to nobody.
 */
function soldByStaff(session) {
  const m = session?.metadata || {};
  return Boolean(m.adminInitiated || m.adminGiftRecipientId);
}
function logStaffSaleSkipped(session, eventName) {
  logWebhook("info", "meta_staff_sale_not_reported", { stripeSessionId: session.id, eventName });
}

/*
 * What the customer was actually charged for the product, before tax: Stripe's
 * subtotal less discounts (a welcome offer, a promotion code). A gift-covered
 * trial charges nothing now, and says so. Falls back to `fallback` only for a
 * session object that carries no amounts.
 */
function chargedBeforeTax(session, fallback) {
  if (!Number.isFinite(Number(session?.amount_subtotal)) || session.amount_subtotal === null) return fallback;
  const discount = Number(session.total_details?.amount_discount || 0);
  return Math.max(0, Number(session.amount_subtotal) - discount) / 100;
}

/**
 * Server half of Purchase for a single paid visit (One-Time or Full Day).
 *
 * The event id is derived from the Stripe session, so the browser's copy on
 * /book/confirmation (sess_<session id>) deduplicates against this one. The
 * value is Stripe's amount_total - what was actually charged - never a price
 * looked up elsewhere. Detached: a Meta outage must never leave a paid
 * booking unconfirmed.
 */
function reportPaidVisitPurchase({ session, user, booking, contentName }) {
  if (soldByStaff(session)) return logStaffSaleSkipped(session, "Purchase");
  const primaryAddress =
    (user.addresses || []).find((a) => String(a._id) === String(booking.addressId)) ||
    (user.addresses || [])[0] ||
    null;

  metaCapi.sendDetached({
    eventName: "Purchase",
    eventId: `sess_${session.id}`,
    eventSourceUrl: `${process.env.CLIENT_URL || "https://www.profixter.com"}/book/confirmation`,
    customData: {
      currency: String(session.currency || "usd").toUpperCase(),
      value: Number(session.amount_total || 0) / 100,
      content_name: contentName,
      content_type: "product",
    },
    user: {
      email: user.email,
      phone: user.phone,
      firstName: user.firstName,
      lastName: user.lastName,
      name: user.name,
    },
    address: {
      city: primaryAddress?.city || user.city,
      state: primaryAddress?.state || user.state,
      zip: primaryAddress?.zip || user.zip,
    },
    // A guest has no account id; the booking number identifies the purchase instead.
    externalId: user.userId || (user._id ? String(user._id) : `booking:${booking.bookingNumber}`),
    fbp: session.metadata?.fbp,
    fbc: session.metadata?.fbc,
    fbclid: user.attribution?.fbclid,
  });
}

/*
 * A paid gift membership was never reported to Meta (2026-11-03). Purchase,
 * from the purchaser, once per gift (only a newly created gift reaches here),
 * id sess_<session id> like the visit purchases, value before tax. Detached and
 * never thrown: tracking must not fail the gift.
 */
async function reportGiftPurchase(session, gift) {
  try {
    if (soldByStaff(session)) return logStaffSaleSkipped(session, "Purchase");
    const purchaser = await User.findById(gift.purchaser).lean();
    if (!purchaser) return;
    metaCapi.sendDetached({
      eventName: "Purchase",
      eventId: `sess_${session.id}`,
      eventSourceUrl: session.metadata?.source_url || `${process.env.CLIENT_URL || "https://www.profixter.com"}/gift`,
      customData: {
        currency: String(session.currency || "usd").toUpperCase(),
        value: chargedBeforeTax(session, Number(session.amount_total || 0) / 100),
        content_name: "gift_membership",
        content_type: "product",
        plan: String(gift.plan || session.metadata?.plan || ""),
      },
      user: {
        email: purchaser.email,
        phone: purchaser.phone,
        firstName: purchaser.firstName,
        lastName: purchaser.lastName,
        name: purchaser.name,
      },
      address: { city: purchaser.city, state: purchaser.state, zip: purchaser.zip },
      externalId: purchaser.userId || String(purchaser._id),
      fbp: session.metadata?.fbp,
      fbc: session.metadata?.fbc,
      fbclid: purchaser.attribution?.fbclid,
    });
  } catch (error) {
    logWebhook("warn", "meta_gift_purchase_failed", { stripeSessionId: session.id, message: String(error?.message || error).slice(0, 200) });
  }
}

/*
 * Stripe says a visit page was paid and there is no booking to record it on
 * (2026-11-19). Before, this was a log line only. The owner is told, once per
 * delivery that reaches here, with what Stripe knows; nothing is refunded or
 * booked automatically.
 */
async function alertPaidVisitWithoutBooking(session, productLabel) {
  if (!sessionIsPaid(session)) return;
  try {
    await sendAdminEventNotification({
      subject: `Paid ${productLabel} with no booking - needs attention`,
      heading: "Payment received, booking not found",
      templateKey: "admin_paid_visit_without_booking",
      source: "stripeWebhookPaidVisit",
      who: session.customer_details?.name || session.customer_email || "Customer",
      highlight: formatAdminMoney(session.amount_total, session.currency || "usd"),
      customerEmail: session.customer_details?.email || session.customer_email || "",
      replyToEmail: session.customer_details?.email || session.customer_email || "",
      fields: [
        ["Product", productLabel],
        ["Stripe checkout", session.id || ""],
        ["Booking id in Stripe", session.metadata?.bookingId || session.client_reference_id || "(none)"],
        ["Needs attention", "Stripe charged the customer but no booking matches. Find or create the visit, or refund in Stripe."],
      ],
    }, { logContext: { stripeSessionId: session.id } });
  } catch (error) {
    logWebhook("error", "paid_visit_without_booking_alert_failed", { stripeSessionId: session.id, message: error.message });
  }
}

async function handleOneTimeCheckoutCompleted(session) {
  const metadata = session.metadata || {};
  const bookingId = metadata.bookingId || session.client_reference_id || null;
  if (!bookingId || !mongoose.isValidObjectId(String(bookingId))) {
    logWebhook("error", "one_time_checkout_missing_booking_id", { stripeSessionId: session.id });
    await alertPaidVisitWithoutBooking(session, "One-Time Visit");
    return null;
  }
  /* Complete but not yet paid (a delayed payment method): async_payment_succeeded settles it, the hold stays. */
  if (!sessionIsPaid(session)) {
    logWebhook("info", "one_time_checkout_payment_processing", { stripeSessionId: session.id, bookingId: String(bookingId) });
    return { bookingId: String(bookingId), awaitingPayment: true };
  }
  const claim = await claimPaidVisitSettlement(Booking, bookingId, session.id);
  if (claim.state === "already_paid") return { bookingId: String(bookingId), duplicate: true };
  if (claim.state === "busy") throw new Error("This paid visit is being recorded by another delivery; Stripe will retry.");
  if (claim.state === "missing") {
    logWebhook("error", "one_time_checkout_booking_not_found", { stripeSessionId: session.id, bookingId });
    await alertPaidVisitWithoutBooking(session, "One-Time Visit");
    return null;
  }
  try {
    return await recordOneTimeCheckoutPaid(session, claim.booking);
  } catch (error) {
    await releasePaidVisitClaim(Booking, claim.booking._id);
    throw error;
  }
}

async function recordOneTimeCheckoutPaid(session, booking) {
  const metadata = session.metadata || {};
  const bookingId = String(booking._id);
  const entitlementId = metadata.entitlementId || null;

  /*
   * A visit Admin booked for somebody with no account (booking.adminGuest)
   * has no User: its own contact fields stand in for one, so it is confirmed
   * and announced exactly like any other paid visit.
   */
  const user = booking.user ? await User.findById(booking.user) : null;
  const contact = user || (booking.adminGuest || booking.guestCheckout ? guestContactFromBooking(booking) : null);
  if (!contact) {
    logWebhook("error", "one_time_checkout_user_not_found", {
      stripeSessionId: session.id,
      bookingId,
    });
    await releasePaidVisitClaim(Booking, booking._id);
    await alertPaidVisitWithoutBooking(session, "One-Time Visit");
    return null;
  }

  if (user && session.customer && !user.stripeCustomerId) {
    user.stripeCustomerId = String(session.customer);
    await user.save();
  }

  const entitlement =
    (entitlementId && (await VisitEntitlement.findById(entitlementId))) ||
    (await VisitEntitlement.findOne({ bookingId: booking._id }).sort({
      updatedAt: -1,
    }));

  let reservationIssue = null;
  if (reservationEngineEnabled()) {
    try {
      await promoteHeldReservationForBooking({
        bookingId: booking._id,
        actorUser: user,
        createdByType: "system",
      });
    } catch (error) {
      let protection = { holdExpiresAt: null, reservationId: null };
      try {
        protection = await preserveHeldReservationAfterPromotionFailure({
          booking,
          error,
          session,
        });
      } catch (preserveError) {
        logWebhook("error", "one_time_reservation_preserve_failed", {
          stripeSessionId: session.id,
          bookingId: String(booking._id),
          promotionMessage: error.message,
          preserveMessage: preserveError.message,
        });
      }
      reservationIssue = reservationIssueFromPromotionError(
        error,
        session,
        protection.holdExpiresAt
      );
      logWebhook("warn", "one_time_reservation_promote_failed", {
        stripeSessionId: session.id,
        bookingId: String(booking._id),
        reservationId: protection.reservationId,
        protectedUntil: protection.holdExpiresAt,
        message: error.message,
        code: error.code || null,
      });
    }
  }

  applyOneTimePaymentSuccessToBooking(booking, { session, reservationIssue });
  confirmAdminPaidVisit(booking, reservationIssue);
  await booking.save();

  if (entitlement) {
    applyOneTimePaymentSuccessToEntitlement(entitlement, session, booking._id);
    await entitlement.save();
  }

  await sendOneTimePaymentEmails({ booking, user: contact, entitlement, session });
  // A guest's own checkout: the private link to check or change it (once; a replay sends nothing).
  if (booking.guestCheckout && booking.paymentState === "paid") {
    // A guest checkout has no entitlement: what Stripe charged is kept on the booking for Admin (amount, payment, time).
    await Booking.updateOne(
      { _id: booking._id, "guestPayment.paidAt": null },
      { $set: { guestPayment: { amountCents: Number(session.amount_total || 0), currency: String(session.currency || "usd"), paymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id || "", paidAt: new Date() } } }
    ).catch(() => {});
    await require("../utils/guestVisitLink").issueAndSendGuestVisitLink(booking._id).catch((error) => logWebhook("warn", "guest_visit_link_failed", { bookingId: String(booking._id), message: error.message }));
  }

  /*
   * Purchase - a single paid visit, which is the only thing this event means.
   *
   * The event id is derived from the Stripe session rather than stored,
   * because both halves of this conversion can compute it independently: the
   * webhook has session.id, and the browser lands on /book/confirmation with
   * the same id in the query string. No round trip, nothing to persist, and no
   * way for the two sides to disagree.
   *
   * The value is amount_total from Stripe - what the customer was actually
   * charged after any promotion - not a price the page looked up.
   *
   * Detached: a Meta outage must never leave a paid booking unconfirmed.
   */
  // A guest's own checkout is a website purchase too (an Admin guest's is skipped as a staff sale inside).
  if (user || booking.guestCheckout) reportPaidVisitPurchase({ session, user: user || contact, booking, contentName: "one_time_visit" });

  return { bookingId: String(booking._id), entitlementId: entitlement ? String(entitlement._id) : null };
}

async function handleOneTimeCheckoutExpired(session, status = "expired") {
  const metadata = session.metadata || {};
  const bookingId = metadata.bookingId || session.client_reference_id || null;
  const entitlementId = metadata.entitlementId || null;
  if (!bookingId) return null;

  const booking = await Booking.findById(bookingId);
  if (!booking || booking.paymentState === "paid") return null;

  if (reservationEngineEnabled()) {
    try {
      await cancelBookingWithReservation({
        bookingId: booking._id,
        createdByType: "system",
        reason: "One-time payment not completed",
      });
    } catch (error) {
      console.warn("Unable to release one-time reservation hold:", error.message);
    }
  } else {
    try {
      await releaseLegacyBookingCapacity(booking);
    } catch (error) {
      console.warn("Unable to release one-time legacy slot hold:", error.message);
    }
  }

  booking.status = "Canceled";
  booking.paymentState = status;
  booking.paymentStatus = status === "expired" ? "Expired" : "Failed";
  await booking.save();

  const entitlement =
    (entitlementId && (await VisitEntitlement.findById(entitlementId))) ||
    (await VisitEntitlement.findOne({ bookingId: booking._id }).sort({
      updatedAt: -1,
    }));
  if (entitlement && entitlement.status === "pending_payment") {
    entitlement.status = status === "expired" ? "expired" : "payment_failed";
    entitlement.stripeCheckoutSessionId =
      session.id || entitlement.stripeCheckoutSessionId;
    await entitlement.save();
  }

  return { bookingId: String(booking._id), status };
}

/* ------------------------------------------------------------------ */
/* Full Day Fixter                                                     */
/* ------------------------------------------------------------------ */

async function sendFullDayPaidEmails({ booking, user, entitlement, session }) {
  const settings = await getFullDayVisitSettings().catch(() => ({
    approximateHours: 8,
    priceCents: entitlement?.priceCents || 49900,
  }));
  const address = [booking.address, booking.city, booking.state, booking.zip]
    .filter(Boolean)
    .join(", ");
  const startTime = booking.scheduledStart
    ? mail.formatNYCTime(booking.scheduledStart)
    : "";
  const endTime = booking.scheduledEnd
    ? mail.formatNYCTime(booking.scheduledEnd)
    : "";
  const price = `$${Math.round(
    (session?.amount_total ?? entitlement?.priceCents ?? 49900) / 100
  )}`;

  try {
    await mail.sendTx(
      "full_day_visit_booked",
      booking.email || user.email,
      {
        name: booking.name || user.name || "there",
        bookingNumber: booking.bookingNumber,
        date: booking.date,
        address,
        approximateHours: settings.approximateHours || 8,
        included: false,
        price,
        startTime,
        endTime,
      },
      {
        bccAdmin: false,
        logContext: {
          bookingId: booking._id,
          bookingNumber: booking.bookingNumber,
          customerName: booking.name || user.name || "",
          customerEmail: booking.email || user.email || "",
          recipientEmail: booking.email || user.email || "",
          emailType: "billing",
          source: "stripeWebhookFullDay",
        },
      }
    );
  } catch (error) {
    console.error("full_day_visit_booked email failed:", error.message);
  }

  try {
    await sendAdminEventNotification(
      {
        subject: adminSubjects.payment("Full Day Paid", { amount: formatAdminMoney(session?.amount_total ?? entitlement?.priceCents, session?.currency || entitlement?.currency || "usd"), name: booking.name || user.name }),
        heading: "Full Day paid",
        templateKey: "admin_full_day_visit_paid",
        replyToEmail: booking.email || user.email || "",
        customerName: booking.name || user.name || "",
        customerEmail: booking.email || user.email || "",
        source: "stripeWebhookFullDay",
        who: booking.name || user.name || "Customer",
        highlight: formatAdminMoney(
          session?.amount_total ?? entitlement?.priceCents,
          session?.currency || entitlement?.currency || "usd"
        ),
        fields: [
          ["Day", booking.date ? mail.formatNYCTime(booking.date) : ""],
          ["Hours", startTime && endTime ? `${startTime} to ${endTime}` : ""],
          ["Fixter", booking.assignedFixterName || "Not yet assigned"],
          [
            "Address",
            formatAddressParts({
              address: booking.address,
              city: booking.city,
              state: booking.state,
              zip: booking.zip,
              county: booking.county,
            }),
          ],
          ["Phone", booking.phone || user.phone],
          ["Booking", booking.bookingNumber ? `#${booking.bookingNumber}` : ""],
          ["Needs attention", booking.reservationIssue?.message || ""],
        ],
        // The customer's job list is the one long field worth carrying: it is
        // what the Fixter has to plan the day around.
        note: booking.note || "",
        action: { label: "View Booking", url: adminLink.booking(booking._id) },
      },
      {
        logContext: {
          bookingId: booking._id,
          bookingNumber: booking.bookingNumber,
        },
      }
    );
  } catch (error) {
    console.error("admin Full Day payment email failed:", error.message);
  }
}

/**
 * Payment landed for a paid Full Day.
 *
 * Deliberately the same shape as the one-time handler, including the part where
 * a failed reservation promotion does not fail the webhook: the customer has
 * paid, so the booking becomes paid and the reservation problem becomes an
 * admin's problem, flagged rather than swallowed.
 */
async function handleFullDayCheckoutCompleted(session) {
  const metadata = session.metadata || {};
  const bookingId = metadata.bookingId || session.client_reference_id || null;
  if (!bookingId || !mongoose.isValidObjectId(String(bookingId))) {
    logWebhook("error", "full_day_checkout_missing_booking_id", { stripeSessionId: session.id });
    await alertPaidVisitWithoutBooking(session, "Full Day Fixter");
    return null;
  }
  /* Complete but not yet paid (a delayed payment method): async_payment_succeeded settles it, the hold stays. */
  if (!sessionIsPaid(session)) {
    logWebhook("info", "full_day_checkout_payment_processing", { stripeSessionId: session.id, bookingId: String(bookingId) });
    return { bookingId: String(bookingId), awaitingPayment: true };
  }
  const claim = await claimPaidVisitSettlement(Booking, bookingId, session.id);
  if (claim.state === "already_paid") return { bookingId: String(bookingId), duplicate: true };
  if (claim.state === "busy") throw new Error("This paid visit is being recorded by another delivery; Stripe will retry.");
  if (claim.state === "missing") {
    logWebhook("error", "full_day_checkout_booking_not_found", { stripeSessionId: session.id, bookingId });
    await alertPaidVisitWithoutBooking(session, "Full Day Fixter");
    return null;
  }
  try {
    return await recordFullDayCheckoutPaid(session, claim.booking);
  } catch (error) {
    await releasePaidVisitClaim(Booking, claim.booking._id);
    throw error;
  }
}

async function recordFullDayCheckoutPaid(session, booking) {
  const metadata = session.metadata || {};
  const bookingId = String(booking._id);
  const entitlementId = metadata.entitlementId || null;

  /*
   * A visit Admin booked for somebody with no account (booking.adminGuest)
   * has no User: its own contact fields stand in for one, so it is confirmed
   * and announced exactly like any other paid visit.
   */
  const user = booking.user ? await User.findById(booking.user) : null;
  const contact = user || (booking.adminGuest || booking.guestCheckout ? guestContactFromBooking(booking) : null);
  if (!contact) {
    logWebhook("error", "full_day_checkout_user_not_found", {
      stripeSessionId: session.id,
      bookingId,
    });
    await releasePaidVisitClaim(Booking, booking._id);
    await alertPaidVisitWithoutBooking(session, "Full Day Fixter");
    return null;
  }

  if (user && session.customer && !user.stripeCustomerId) {
    user.stripeCustomerId = String(session.customer);
    await user.save();
  }

  const entitlement =
    (entitlementId && (await VisitEntitlement.findById(entitlementId))) ||
    (await VisitEntitlement.findOne({ bookingId: booking._id }).sort({
      updatedAt: -1,
    }));

  let reservationIssue = null;
  if (booking.slotReservationId) {
    try {
      await promoteHeldReservationForBooking({
        bookingId: booking._id,
        actorUser: user,
        createdByType: "system",
      });
    } catch (error) {
      let protection = { holdExpiresAt: null, reservationId: null };
      try {
        protection = await preserveHeldReservationAfterPromotionFailure({
          booking,
          error,
          session,
        });
      } catch (preserveError) {
        logWebhook("error", "full_day_reservation_preserve_failed", {
          stripeSessionId: session.id,
          bookingId: String(booking._id),
          promotionMessage: error.message,
          preserveMessage: preserveError.message,
        });
      }
      reservationIssue = reservationIssueFromPromotionError(
        error,
        session,
        protection.holdExpiresAt
      );
      logWebhook("warn", "full_day_reservation_promote_failed", {
        stripeSessionId: session.id,
        bookingId: String(booking._id),
        reservationId: protection.reservationId,
        message: error.message,
        code: error.code || null,
      });
    }
  }

  applyOneTimePaymentSuccessToBooking(booking, { session, reservationIssue });
  // The shared helper stamps the one-time product onto the booking, which is
  // right for its own caller and wrong here. Put the Full Day back.
  booking.bookingType = "full_day_visit";
  booking.accessType = "one_time";
  confirmAdminPaidVisit(booking, reservationIssue);
  await booking.save();

  if (entitlement) {
    applyOneTimePaymentSuccessToEntitlement(entitlement, session, booking._id);
    await entitlement.save();
  }

  // Sales desk: a separately PAID Full Day (never an included or loyalty day). Never throws.
  await salesStripe.onFullDayPaid({ session, booking, entitlement, user, stripe });

  await sendFullDayPaidEmails({ booking, user: contact, entitlement, session });
  if (booking.guestCheckout && booking.paymentState === "paid") {
    // A guest checkout has no entitlement: what Stripe charged is kept on the booking for Admin (amount, payment, time).
    await Booking.updateOne(
      { _id: booking._id, "guestPayment.paidAt": null },
      { $set: { guestPayment: { amountCents: Number(session.amount_total || 0), currency: String(session.currency || "usd"), paymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id || "", paidAt: new Date() } } }
    ).catch(() => {});
    await require("../utils/guestVisitLink").issueAndSendGuestVisitLink(booking._id).catch((error) => logWebhook("warn", "guest_visit_link_failed", { bookingId: String(booking._id), message: error.message }));
  }
  // Previously no server Purchase at all for the most valuable single sale.
  if (user || booking.guestCheckout) reportPaidVisitPurchase({ session, user: user || contact, booking, contentName: "full_day_visit" });
  return {
    bookingId: String(booking._id),
    entitlementId: entitlement ? String(entitlement._id) : null,
  };
}

async function handleFullDayCheckoutExpired(session, status = "expired") {
  const metadata = session.metadata || {};
  const bookingId = metadata.bookingId || session.client_reference_id || null;
  if (!bookingId) return null;

  const booking = await Booking.findById(bookingId);
  if (!booking || booking.paymentState === "paid") return null;

  try {
    await releaseFullDayCapacity(booking);
  } catch (error) {
    console.warn("Unable to release Full Day hold:", error.message);
  }

  booking.status = "Canceled";
  booking.paymentState = status;
  booking.paymentStatus = status === "expired" ? "Expired" : "Failed";
  await booking.save();

  const entitlement =
    (metadata.entitlementId &&
      (await VisitEntitlement.findById(metadata.entitlementId))) ||
    (await VisitEntitlement.findOne({ bookingId: booking._id }).sort({
      updatedAt: -1,
    }));
  if (entitlement && entitlement.status === "pending_payment") {
    entitlement.status = status === "expired" ? "expired" : "payment_failed";
    entitlement.stripeCheckoutSessionId =
      session.id || entitlement.stripeCheckoutSessionId;
    await entitlement.save();
  }

  return { bookingId: String(booking._id), status };
}

/* ------------------------------------------------------------------ */
/* Fixter tips                                                         */
/* ------------------------------------------------------------------ */

function objectIdOrNull(value) {
  const text = String(value || "").trim();
  return mongoose.isValidObjectId(text) ? text : null;
}

/**
 * The Fixter this tip claims to be for, re-validated here.
 *
 * The session was created minutes ago and metadata is not evidence: the
 * employee could have been edited or removed since. Anything that is not
 * currently a Fixter or General Fixter resolves to null and the tip is recorded
 * unassigned rather than credited to a record that no longer means what it did.
 */
async function loadTipFixter(fixterId) {
  const id = objectIdOrNull(fixterId);
  if (!id) return null;
  const fixter = await User.findById(id)
    .select("_id name email role employeePosition isActive")
    .lean();
  return isEligibleFixter(fixter) ? fixter : null;
}

/**
 * The person who tipped, where we can say so honestly.
 *
 * The account from our own token is the strong answer. Failing that, an exact
 * match on the email Stripe collected is an identity link, not a guess about
 * who earned the money, so it is safe to record - it never affects attribution.
 */
async function loadTipUser(userId, booking, session) {
  const fromToken = objectIdOrNull(userId) || objectIdOrNull(booking?.user);
  if (fromToken) {
    const user = await User.findById(fromToken).select("_id name email role").lean();
    if (user) return user;
  }

  const email = String(
    session?.customer_details?.email || session?.customer_email || ""
  )
    .trim()
    .toLowerCase();
  if (!email) return null;

  // Never an account whose email was only typed at checkout (utils/communications/unconfirmedEmailPolicy).
  return User.findOne({ email, role: "customer", $or: [{ emailUnconfirmedAt: null }, { emailVerifiedAt: { $ne: null } }] })
    .select("_id name email role")
    .lean();
}

/** Tell the Fixter. Uses their own account email; no address is written here. */
async function notifyFixterOfTip(tip, fixter) {
  if (!fixter?.email) return;
  try {
    await mail.sendTx(
      "fixter_tip_received",
      fixter.email,
      {
        name: String(fixter.name || "").split(/\s+/)[0] || "there",
        amount: formatAdminMoney(tip.amountCents, tip.currency),
        tipperName: tip.tipperName || "",
        bookingNumber: tip.bookingNumberSnapshot || "",
        receivedAt: tip.receivedAt,
      },
      {
        bccAdmin: false,
        logContext: {
          userId: fixter._id,
          recipientName: fixter.name || "",
          recipientEmail: fixter.email,
          customerName: tip.tipperName || "",
          customerEmail: tip.tipperEmail || "",
          emailType: "transactional",
          source: "stripeWebhookFixterTip",
        },
      }
    );
    await Tip.updateOne({ _id: tip._id }, { $set: { notificationSentAt: new Date() } });
  } catch (error) {
    console.error("fixter_tip_received email failed:", error.message);
  }
}

/**
 * Record a tip.
 *
 * Idempotent on the PaymentIntent in two layers: a read first so the common
 * redelivery is cheap, and the unique index behind it so two deliveries racing
 * each other still produce one Tip.
 */
async function handleFixterTipCheckoutCompleted(session, eventId) {
  const metadata = session.metadata || {};
  const paymentIntentId = stripeId(session.payment_intent);

  if (!paymentIntentId) {
    logWebhook("error", "fixter_tip_missing_payment_intent", {
      stripeSessionId: session.id,
    });
    return null;
  }

  if (String(session.payment_status || "").toLowerCase() !== "paid") {
    logWebhook("warn", "fixter_tip_not_paid", {
      stripeSessionId: session.id,
      paymentStatus: session.payment_status || null,
    });
    return null;
  }

  const existing = await Tip.findOne({ stripePaymentIntentId: paymentIntentId }).lean();
  if (existing) {
    logWebhook("info", "fixter_tip_duplicate_event", {
      stripeSessionId: session.id,
      tipId: String(existing._id),
    });
    return { tipId: String(existing._id), duplicate: true };
  }

  const fixter = await loadTipFixter(metadata.fixterId);
  const bookingId = objectIdOrNull(metadata.bookingId);
  const booking = bookingId
    ? await Booking.findById(bookingId).select("_id bookingNumber name email user").lean()
    : null;
  const user = await loadTipUser(metadata.userId, booking, session);

  const record = tipRecordFromCheckoutSession(session, {
    fixter,
    booking,
    user,
    eventId,
  });

  let tip;
  try {
    tip = await Tip.create(record);
  } catch (error) {
    if (error?.code === 11000) {
      const winner = await Tip.findOne({ stripePaymentIntentId: paymentIntentId }).lean();
      logWebhook("info", "fixter_tip_concurrent_duplicate", {
        stripeSessionId: session.id,
        tipId: winner ? String(winner._id) : null,
      });
      return winner ? { tipId: String(winner._id), duplicate: true } : null;
    }
    throw error;
  }

  logWebhook("info", "fixter_tip_recorded", {
    stripeSessionId: session.id,
    tipId: String(tip._id),
    amountCents: tip.amountCents,
    attributed: !!tip.fixter,
    assignmentStatus: tip.assignmentStatus,
  });

  await notifyFixterOfTip(tip, fixter);

  return { tipId: String(tip._id), attributed: !!tip.fixter };
}

/**
 * A refunded tip.
 *
 * charge.refunded is a broad event: it fires for memberships, one-time visits
 * and project invoices too. The guard is the Tip collection itself - only tips
 * live there, so a refund for anything else finds no record and this handler
 * does nothing at all. That keeps the new handling strictly tip-specific, which
 * is the whole reason charge.refunded can be added safely now.
 */
async function handleTipChargeRefunded(charge) {
  const paymentIntentId = stripeId(charge?.payment_intent);
  if (!paymentIntentId) return null;

  const tip = await Tip.findOne({ stripePaymentIntentId: paymentIntentId });
  if (!tip) return null;

  const result = applyRefundToTip(tip, charge);
  if (!result.changed) {
    return { tipId: String(tip._id), changed: false };
  }

  await tip.save();
  logWebhook("info", "fixter_tip_refund_applied", {
    tipId: String(tip._id),
    amountCents: tip.amountCents,
    refundedCents: result.refundedCents,
    retainedCents: result.retainedCents,
    status: tip.status,
  });
  return { tipId: String(tip._id), ...result };
}

/**
 * Tell Admin, once, when a home is now billed by two Stripe subscriptions.
 *
 * Checkout refuses a second membership for a home Stripe is still billing, so
 * this should never fire. It exists because "should never" is how the
 * 2026-10-30 duplicate happened: if it does fire, money is being collected
 * twice, and that needs a person the same day, not a customer finding it on a
 * statement. Nothing is canceled or refunded automatically - which of the two
 * to keep, and whether to refund, is a decision.
 *
 * Never throws: an alert failing must not stop the membership being recorded.
 */
async function alertIfHomeBilledTwice({ user, subscription, stripeSubscription }) {
  try {
    if (!subscription?.addressId || subscription.duplicateBillingAlertedAt) return;
    const customerId = String(stripeSubscription?.customer || subscription.stripeCustomerId || "");
    const billing = await billingStripeSubscriptionsForAddress({
      stripeCustomerId: customerId,
      addressId: subscription.addressId,
    });
    const others = billing.filter((s) => s.id !== subscription.stripeSubscriptionId);
    if (!others.length) return;

    const claimed = await Subscription.updateOne(
      { _id: subscription._id, duplicateBillingAlertedAt: null },
      { $set: { duplicateBillingAlertedAt: new Date() } }
    );
    if (!claimed.modifiedCount) return;

    logWebhook("error", "home_billed_by_two_subscriptions", {
      userId: String(user._id),
      addressId: String(subscription.addressId),
      newStripeSubscriptionId: subscription.stripeSubscriptionId,
      otherStripeSubscriptionIds: others.map((s) => `${s.id}:${s.status}`),
    });
    await sendAdminEventNotification({
      subject: `Action needed: two memberships billing one home - ${user.name || user.email}`,
      heading: "Two memberships are billing the same home",
      templateKey: "admin_duplicate_membership_billing",
      replyToEmail: user.email,
      customerName: user.name || "",
      customerEmail: user.email,
      source: "stripeWebhook",
      who: user.name || user.email,
      highlight: "A new membership was bought for a home that already has one Stripe is billing. Decide which to keep; nothing was canceled automatically.",
      fields: [
        ["Email", user.email],
        ["Phone", user.phone],
        ["Address", formatAddressParts(subscription.addressSnapshot || {})],
        ["Subscription on record", subscription.stripeSubscriptionId],
        ...others.map((s) => ["Also billing", `${s.id} (${s.status})`]),
      ],
      action: { label: "View Customer", url: adminLink.customer(user._id) },
    }, { logContext: { userId: user._id } });
  } catch (error) {
    logWebhook("warn", "duplicate_billing_check_failed", {
      userId: String(user?._id || ""),
      message: error?.message || String(error),
    });
  }
}

async function handleCheckoutCompleted(session, eventId) {
  /*
   * A Charge extra payment page (utils/extraCharges). First, and returns: it
   * is a one-time payment for one AdditionalCharge record and must never reach
   * the visit, gift or subscription paths below.
   */
  if (extraCharges.isExtraChargeObject(session)) {
    return extraCharges.handleCheckoutSession(session);
  }

  /*
   * A free visit paid for as a One-Time Visit (utils/freeVisit/conversion.js).
   * Before the One-Time handler on purpose: that one rewrites and, on expiry,
   * cancels the booking it is given; a conversion changes the free visit in
   * place, once, only if it is still the visit the link was made for. A
   * membership conversion takes the normal subscription path below first.
   */
  if (freeVisitConversion.isConversionSession(session) && String(session.mode || "") === "payment") {
    /* Reported once: a payment this conversion already recorded is a replay. */
    const FreeVisitConversion = require("../models/FreeVisitConversion");
    const recordedBefore = await FreeVisitConversion.exists({ _id: session.metadata.freeVisitConversionId, "payment.sessionId": session.id });
    const result = await freeVisitConversion.handleConversionPaid(session);
    /*
     * The customer's own upgrade is a website purchase, reported as any paid
     * visit is (server only: the page returns to My Visits, not the
     * confirmation page). An Admin link is a staff sale and never reported.
     */
    if (!recordedBefore && session.metadata?.initiatedBy === "customer" && !soldByStaff(session)) {
      try {
        const [buyer, visit] = await Promise.all([
          User.findById(result?.user || null).lean(),
          Booking.findById(session.metadata.convertsBookingId).lean(),
        ]);
        if (buyer && visit) reportPaidVisitPurchase({ session, user: buyer, booking: visit, contentName: "One-Time Visit (upgraded free visit)" });
      } catch (error) {
        logWebhook("warn", "conversion_purchase_report_failed", { stripeSessionId: session.id, message: String(error?.message || error).slice(0, 160) });
      }
    }
    return result;
  }

  if (isFixterTipCheckoutSession(session)) {
    return handleFixterTipCheckoutCompleted(session, eventId);
  }

  if (isOneTimeCheckoutSession(session)) {
    return handleOneTimeCheckoutCompleted(session);
  }

  if (isFullDayCheckoutSession(session)) {
    return handleFullDayCheckoutCompleted(session);
  }

  /*
   * A gift membership.
   *
   * Returns before the subscription path below, which is the point: a gift
   * is a one-time payment and must never fall through to code that creates
   * or updates a Subscription. The emails are sent only when the gift was
   * newly created, so a replayed webhook does not invite anybody twice.
   */
  if (isGiftSession(session)) {
    const result = await handleGiftCheckoutCompleted(session);
    if (result.created && result.gift) {
      await sendGiftPurchaseEmails(result.gift, result.invitation);
      /*
       * And tell Admin a sale happened.
       *
       * Reached only from checkout.session.completed for a session the gift
       * handler accepted as settled — paid, or no_payment_required when a
       * 100% promotion code covered it. A session that was merely created,
       * or abandoned, never gets here.
       *
       * Stamped once per gift, so a replayed webhook cannot email twice.
       */
      await sendGiftPurchasedAdminNotice(result.gift);
      await reportGiftPurchase(session, result.gift);
    }
    return result;
  }

  /*
   * WHO PAID: the account that opened this checkout, first.
   *
   * Membership checkout stamps the account on the session (metadata.userId:
   * the public id, or the Mongo id for older accounts). Matching on that is
   * exact. The email the customer typed at Stripe is only a fallback, for
   * sessions opened before the stamp existed - and an account that signed up
   * by phone may have no email at all, or Stripe may hold a different one.
   */
  let user = null;
  const stampedUserId = String(session.metadata?.userId || "").trim();
  if (stampedUserId) {
    const byId = /^[a-f0-9]{24}$/i.test(stampedUserId) ? { _id: stampedUserId } : { userId: stampedUserId };
    user = await User.findOne(byId);
  }

  let email = session.customer_email || session?.customer_details?.email || null;
  if (!user) {
    if (!email && session.customer) {
      const customer = await stripe.customers.retrieve(session.customer);
      email = customer?.email || null;
    }

    if (!email) {
      logWebhook("warn", "checkout_completed_missing_email", {
        stripeSessionId: session.id,
      });
      return;
    }

    user = await findBillingUserByEmail(email);
  }
  if (!user) {
    logWebhook("warn", "checkout_completed_user_not_found", {
      stripeSessionId: session.id,
      hasEmail: !!email,
    });
    return;
  }

  if (session.customer && !user.stripeCustomerId) {
    user.stripeCustomerId = String(session.customer);
    await user.save();
  }

  const stripeSubscriptionId = session.subscription ? String(session.subscription) : null;
  if (!stripeSubscriptionId) {
    logWebhook("error", "checkout_completed_missing_subscription_id", {
      stripeSessionId: session.id,
      userId: String(user._id),
    });
    return;
  }

  const stripeSubscription = await retrieveStripeSubscription(stripeSubscriptionId);

  let subscription;
  try {
    subscription = await upsertSubscriptionFromStripe({
      stripeSubscription,
      user,
      addressIdHint: session.metadata?.addressId || session.client_reference_id || null,
      stripeCheckoutSessionId: session.id,
    });
  } catch (error) {
    if (error?.code !== HOME_ALREADY_ACTIVE) throw error;
    // Covered already; the new subscription is a second bill for the same home.
    await alertIfHomeBilledTwice({ user, subscription: error.existing, stripeSubscription });
    // A free-visit conversion paid this way is never converted on a second bill: the owner is told.
    if (freeVisitConversion.isConversionSession(session)) {
      await freeVisitConversion.handleConversionPaid(session, { duplicateMembership: true }).catch((e) =>
        logWebhook("error", "free_visit_conversion_failed", { stripeSessionId: session.id, message: String(e?.message || e).slice(0, 200) })
      );
    }
    return error.existing;
  }

  await alertIfHomeBilledTwice({ user, subscription, stripeSubscription });

  /*
   * The first visit they booked before paying (utils/membershipFirstVisitFulfillment):
   * booked now, exactly once, whether or not they come back to the website.
   * Never fails this event - a draft that could not be finished stays "paid"
   * and the sweep (jobs/oneTimeVisitHolds.js) retries it, then hands it to Admin.
   */
  try {
    const draft = await markFirstVisitPaid(session, subscription);
    if (draft) await fulfillFirstVisitDraft(draft._id);
  } catch (error) {
    logWebhook("error", "first_visit_fulfillment_deferred", { stripeSessionId: session.id, message: String(error?.message || error).slice(0, 200) });
  }

  /*
   * A free visit paid for as a membership (utils/freeVisit/conversion.js):
   * the visit is converted in place now that the membership exists. Never
   * fails this event - a conversion that cannot finish stays "paid" for the
   * sweep (jobs/oneTimeVisitHolds.js), then goes to Admin.
   */
  if (freeVisitConversion.isConversionSession(session)) {
    try {
      await freeVisitConversion.handleConversionPaid(session, { subscription });
    } catch (error) {
      logWebhook("error", "free_visit_conversion_deferred", { stripeSessionId: session.id, message: String(error?.message || error).slice(0, 200) });
    }
  }

  const plan = String(subscription.subscriptionType || "").toLowerCase();
  const billingCycle = subscription.billingCycle || "monthly";
  const value = subscription.planPrice || getPlanPrice(plan, billingCycle);
  const currency = "USD";
  const now = new Date();

  /*
   * The obsolete cold-call commission (markLeadSubscribed) used to run here:
   * it matched a lead by phone or EMAIL and wrote 50% of the catalog price
   * (Annual Basic: $745), overwriting amounts even after they were paid.
   * Retired 2026-11: sales credit now comes only from the verified first
   * payment (invoice.paid above, utils/sales). Its historical rows are kept,
   * read-only, in RepAttribution; see scripts/ops/legacy_rep_attribution_report.js.
   */

  const prevLP = user.lastPurchase || {};
  const confirmationToken = crypto.randomUUID();
  // Meta gets what was charged (the 20% welcome offer, promotion codes and
  // gift-covered trials included), not the catalogue price `value` above.
  const chargedValue = chargedBeforeTax(session, value);
  // This checkout's own event id (stamped at creation), never the previous one.
  const metaEventId = session.metadata?.eventId || `sess_${session.id}`;

  await User.updateOne(
    { _id: user._id },
    {
      $set: {
        stripeCustomerId: session.customer ? String(session.customer) : user.stripeCustomerId || null,
        lastPurchase: {
          ...prevLP,
          token: confirmationToken,
          stripeSessionId: session.id,
          eventId: metaEventId,
          plan,
          value: chargedValue,
          currency,
          createdAt: now,
          addressId: subscription.addressId || null,
          billingCycle,
        },
      },
    }
  );

  /*
   * ANNOUNCED ONCE PER CHECKOUT. Everything below tells somebody: Meta, the
   * customer (text and email) and the owner. The record above is idempotent;
   * these are not. A checkout.session.completed processed a second time - a
   * retry after a later step failed, or the same session under a new event id -
   * used to send all of it again (2026-11-18). Claimed atomically here, after
   * the confirmation page's data is written and before the first message.
   */
  const announced = await Subscription.findOneAndUpdate(
    { _id: subscription._id, "startAnnounced.sessionId": { $ne: session.id } },
    { $set: { startAnnounced: { sessionId: session.id, at: now } } },
    { new: true }
  );
  if (!announced) {
    logWebhook("info", "membership_start_already_announced", { stripeSessionId: session.id, subscriptionId: String(subscription._id) });
    return subscription;
  }

  /*
   * Subscribe, not Purchase.
   *
   * This reported a started membership as "Purchase" for as long as it has
   * existed, which put recurring subscriptions in the same bucket as one-off
   * visit payments and left the ad account optimising against a blend of two
   * different things. Purchase still exists and still means what it says - a
   * single paid visit, sent from the one-time checkout.
   *
   * It also went to whatever FB_PIXEL_ID happened to hold, which is how events
   * reached the old dataset. metaCapi names the pixel in code, so the browser
   * and the server cannot disagree about where this is going.
   *
   * The event id comes from lastPurchase, which routes/stripe.js has always
   * written and the schema has always silently discarded; now that it persists,
   * the confirmation page can read it back and fire the browser half of this
   * conversion under the same id. The session fallback stays for checkouts that
   * were already in flight when this deployed.
   *
   * 2026-11-03: the id, fbp and fbc come from this session's metadata first.
   * lastPurchase can belong to an earlier checkout (a sale Admin made later
   * reused it), and a staff sale is not reported at all.
   */
  if (soldByStaff(session)) logStaffSaleSkipped(session, "Subscribe");
  else await metaCapi.send({
    eventName: "Subscribe",
    eventId: metaEventId,
    eventSourceUrl:
      session.metadata?.source_url ||
      prevLP.sourceUrl ||
      process.env.CLIENT_URL ||
      "https://www.profixter.com",
    customData: {
      currency,
      value: chargedValue,
      content_name: plan,
      plan,
      billingCycle,
    },
    user: {
      // Never hash "null"/"undefined": an account may have no email at all.
      email: (user.email || email) ? String(user.email || email).toLowerCase() : undefined,
      phone: prevLP.phone || user.phone || "",
      firstName: user.firstName,
      lastName: user.lastName,
      name: user.name,
    },
    address: {
      city: subscription.addressSnapshot?.city || user.city,
      state: subscription.addressSnapshot?.state || user.state,
      zip: subscription.addressSnapshot?.zip || user.zip,
    },
    externalId: user.userId || String(user._id),
    fbp: session.metadata?.fbp || prevLP.fbp,
    fbc: session.metadata?.fbc || prevLP.fbc,
    fbclid: user.attribution?.fbclid,
    clientIp: prevLP.clientIp,
    userAgent: prevLP.userAgent,
  });

  // The welcome text for a new membership. Placed before the email rather
  // than after only so a mail failure cannot skip it; neither can throw.
  await smsNotify.notifyMembershipStarted(subscription, user, "stripeWebhook");

  /*
   * The account's email, else the one they typed at Stripe checkout. A
   * phone-only account that left no email anywhere simply gets the text above.
   */
  const confirmationTo = user.email || email || null;
  if (confirmationTo) await mail.sendTx(
    "subscription_started",
    confirmationTo,
    {
      name: user.name || String(confirmationTo).split("@")[0],
      plan: (plan || "").replace(/^./, (char) => char.toUpperCase()),
      billingCycle,
      address: subscription.addressSnapshot
        ? `${subscription.addressSnapshot.line1}, ${subscription.addressSnapshot.city}, ${subscription.addressSnapshot.state}`
        : null,
    },
    {
      bccAdmin: false,
      logContext: {
        userId: user._id,
        customerName: user.name || "",
        customerEmail: confirmationTo,
        recipientName: user.name || "",
        recipientEmail: confirmationTo,
        emailType: "billing",
        source: "stripeWebhook",
      },
    }
  );

  const newMemberSections = await buildNewMemberAdminSections({
    session,
    stripeSubscription,
    subscription,
    user,
    plan,
    billingCycle,
    prevPurchase: prevLP,
    now,
  });

  /*
   * Discount detail, only when there was one.
   *
   * The authoritative objects, in the order Stripe fills them in: the Checkout
   * Session carries what the customer typed and the computed discount total,
   * the expanded latest invoice carries what was actually charged, and the
   * coupon carries the percentage and duration. Nothing is calculated here.
   */
  let promotionRows = [];
  try {
    const promoInvoice = expandedInvoice(stripeSubscription);
    const promoCurrency = subscriptionCurrency(
      stripeSubscription, session, subscription?.currency || "usd"
    );
    const promotion = promotionDetails({
      session,
      stripeSubscription,
      invoice: promoInvoice,
      lineItems: await retrieveCheckoutLineItemsForAdmin(session.id),
      currency: promoCurrency,
    });
    promotionRows = promotionAdminRows({
      promotion,
      coupon: promotion.couponObject,
      currency: promoCurrency,
      amountPaid: firstNumber(
        session.amount_total,
        promoInvoice?.amount_paid,
        promoInvoice?.amount_due
      ),
    });
  } catch (promoError) {
    // A discount lookup must never stop a membership from being recorded or
    // the notification from going out.
    console.warn("membership promotion lookup failed:", promoError?.message || promoError);
  }

  /*
   * Was seven sections of Stripe and Mongo identifiers. A new member is four
   * facts: who, which plan, how much, where. The identifiers still exist and
   * are still on the customer record in Admin, which is where someone
   * reconciling a payment would look for them anyway.
   */
  await sendAdminEventNotification({
    subject: adminSubjects.membership("Membership Started", { name: user.name || user.email, plan: subscription?.subscriptionType }),
    heading: "Membership started",
    templateKey: "admin_subscription_started",
    replyToEmail: user.email,
    customerName: user.name || "",
    customerEmail: user.email,
    source: "stripeWebhook",
    who: user.name || user.email,
    highlight: newMemberHighlight(subscription),
    fields: [
      ["Email", user.email],
      ["Phone", user.phone],
      ["Address", formatAddressParts(subscription?.addressSnapshot || {})],
      ["Billing", subscription?.billingCycle === "annual" ? "Annual" : "Monthly"],
      ["Member ID", user.userId],
      // Empty when no promotion was used, so the ordinary email is unchanged.
      ...promotionRows,
    ],
    action: { label: "View Customer", url: adminLink.customer(user._id) },
  }, {
    logContext: {
      userId: user._id,
    },
  });
}

async function syncStripeSubscriptionRecord(stripeSubscription) {
  let canonicalStripeSubscription = stripeSubscription;

  if (
    stripeSubscription?.id &&
    String(stripeSubscription?.status || "").toLowerCase() !== "canceled"
  ) {
    canonicalStripeSubscription = await retrieveStripeSubscription(String(stripeSubscription.id));
  }

  const metadata = canonicalStripeSubscription?.metadata || {};
  if (!metadata.userId || !metadata.addressId) {
    logWebhook("warn", "subscription_sync_missing_metadata", {
      stripeSubscriptionId: canonicalStripeSubscription.id,
      customerId: canonicalStripeSubscription.customer,
      hasUserId: !!metadata.userId,
      hasAddressId: !!metadata.addressId,
      status: canonicalStripeSubscription.status,
    });
  }

  const user = await findUserForStripeObject(canonicalStripeSubscription);
  if (!user) {
    logWebhook("error", "subscription_sync_user_not_found", {
      stripeSubscriptionId: canonicalStripeSubscription.id,
      customerId: canonicalStripeSubscription.customer,
      metadataUserId: metadata.userId || null,
      metadataEmail: metadata.email || null,
    });
    return null;
  }

  // Capture pre-upsert state for email transition detection.
  // This prevents duplicate emails: the self-serve cancel route sends
  // subscription_cancellation_scheduled immediately and sets cancelAtPeriodEnd=true locally,
  // so when this webhook fires the transition is no longer detected here.
  const existingSub = await Subscription.findOne({
    stripeSubscriptionId: canonicalStripeSubscription.id,
  });
  const wasScheduledForCancellation = existingSub?.cancelAtPeriodEnd === true;
  /*
   * Replaced, not ended: another subscription for the same home took over.
   * From the customer's side their membership carries straight on, so the
   * "your membership has ended" email and text would be false.
   */
  const replacedByNewSubscription = !!canonicalStripeSubscription?.metadata?.[REPLACED_BY_METADATA_KEY];
  const wasAlreadyCanceled = existingSub?.status === "canceled";
  const hadPaymentFailureCancellation = existingSub?.cancellationReason === "payment_failed";

  const incomingStatus = String(canonicalStripeSubscription?.status || "").toLowerCase();
  const incomingCancelAtPeriodEnd = !!canonicalStripeSubscription.cancel_at_period_end;

  let subscription;
  try {
    subscription = await upsertSubscriptionFromStripe({
      stripeSubscription: canonicalStripeSubscription,
      user,
      addressIdHint: canonicalStripeSubscription.metadata?.addressId || null,
    });
  } catch (error) {
    if (error?.code !== HOME_ALREADY_ACTIVE) throw error;
    await alertIfHomeBilledTwice({ user, subscription: error.existing, stripeSubscription: canonicalStripeSubscription });
    return null;
  }

  if (!subscription) return null;

  const addrStr = subscription.addressSnapshot
    ? `${subscription.addressSnapshot.line1}, ${subscription.addressSnapshot.city}, ${subscription.addressSnapshot.state}`
    : null;
  const planStr = (subscription.subscriptionType || "").replace(/^./, (c) => c.toUpperCase());

  // Send cancellation_scheduled email only on the transition false → true.
  if (incomingCancelAtPeriodEnd && !wasScheduledForCancellation) {
    try {
      await mail.sendTx("subscription_cancellation_scheduled", user.email, {
        name: user.name || user.email.split("@")[0],
        plan: planStr,
        address: addrStr,
        accessEndDate: subscription.cancellationDate
          ? mail.formatNYCTime(subscription.cancellationDate.toISOString())
          : null,
      }, {
        bccAdmin: false,
        logContext: {
          userId: user._id,
          customerName: user.name || "",
          customerEmail: user.email,
          recipientName: user.name || "",
          recipientEmail: user.email,
          emailType: "billing",
          source: "stripeWebhook",
        },
      });
    } catch (emailErr) {
      console.error("subscription_cancellation_scheduled email failed:", emailErr.message);
    }

    /*
     * Scheduled, NOT ended. Stripe keeps the subscription active until the
     * period closes, and the text says so. Telling somebody their
     * membership has ended while they still have paid visits left would
     * cost them those visits and cost us the relationship.
     */
    await smsNotify.notifyMembershipCancellationScheduled(
      subscription,
      user,
      "stripeWebhook"
    );
  }

  // Send subscription_canceled email only on the transition → canceled,
  // and only when not caused by payment failure (payment_failed email covers that case).
  if (incomingStatus === "canceled" && !wasAlreadyCanceled && !hadPaymentFailureCancellation && !replacedByNewSubscription) {
    try {
      const endedDate = subscription.cancellationDate || subscription.currentPeriodEnd;
      await mail.sendTx("subscription_canceled", user.email, {
        name: user.name || user.email.split("@")[0],
        plan: planStr,
        address: addrStr,
        canceledDate: endedDate ? mail.formatNYCTime(endedDate.toISOString()) : null,
      }, {
        bccAdmin: false,
        logContext: {
          userId: user._id,
          customerName: user.name || "",
          customerEmail: user.email,
          recipientName: user.name || "",
          recipientEmail: user.email,
          emailType: "billing",
          source: "stripeWebhook",
        },
      });
    } catch (emailErr) {
      console.error("subscription_canceled email failed:", emailErr.message);
    }

    // The real ending, on the genuine transition to canceled only.
    await smsNotify.notifyMembershipCancelled(subscription, user, "stripeWebhook");
  }

  return subscription;
}

/**
 * A disputed charge, traced back to the membership month it paid for.
 *
 * A Dispute carries a charge id, not an invoice, so the charge has to be read
 * to find out what it settled. Anything that was not a membership renewal finds
 * no loyalty row and does nothing — which is how tips, gift purchases and
 * project invoices stay out of this entirely.
 */
async function handleLoyaltyDispute(dispute) {
  const chargeId = typeof dispute?.charge === "string" ? dispute.charge : dispute?.charge?.id;
  if (!chargeId) return null;

  try {
    const charge = await stripe.charges.retrieve(String(chargeId));
    return await reverseLoyaltyFromCharge({ charge, reason: "charge_disputed" });
  } catch (error) {
    logWebhook("warn", "loyalty_dispute_lookup_failed", {
      chargeId: String(chargeId),
      message: error?.message || "charge lookup failed",
    });
    return null;
  }
}

async function handleInvoicePaid(invoice) {
  if (!invoice?.subscription) return;

  const stripeSubscription = await retrieveStripeSubscription(String(invoice.subscription));

  const subscription = await syncStripeSubscriptionRecord(stripeSubscription);
  if (!subscription) return;

  subscription.latestPaymentDate = invoice.status_transitions?.paid_at
    ? new Date(invoice.status_transitions.paid_at * 1000)
    : new Date(invoice.created * 1000);
  subscription.latestInvoiceId = invoice.id || subscription.latestInvoiceId || null;
  subscription.latestInvoiceStatus = invoice.status || subscription.latestInvoiceStatus || null;
  await subscription.save();

  /*
   * Loyalty Benefits, after the subscription is in step with Stripe.
   *
   * Ordered last on purpose. The plan, period and status this renewal is
   * counted against all come from the record we have just synced, so counting
   * before the sync would stamp the month with whatever the plan used to be.
   *
   * recordRenewal decides for itself whether this invoice is a renewal at all —
   * it ignores signups, upgrade prorations and annual memberships — and it never
   * throws, so a loyalty problem can never turn a processed payment into a 500
   * that makes Stripe retry it.
   */
  await recordLoyaltyRenewal({ invoice, stripeSubscription });

  /*
   * Sales desk: a FIRST membership payment (billing_reason subscription_create,
   * money actually paid) becomes a verified sale; a paid plan change is
   * recorded for credit requests only; renewals are ignored. Never throws.
   */
  await salesStripe.onInvoicePaid({ invoice, stripeSubscription, subscription });

  return subscription;
}

/**
 * Money collected online for a ProFixter project invoice.
 *
 * Deliberately separate from handleInvoicePaid, which serves subscriptions.
 * This one only acts on invoices carrying our own metadata, so the two can
 * never process each other's objects even though they observe the same event.
 *
 * All the safety lives in recordStripePayment: it re-reads nothing it should
 * not trust, applies at most the outstanding balance in integer cents, and is
 * idempotent on the PaymentIntent so retries and duplicate deliveries record
 * one payment.
 */
async function handleProjectInvoicePaid(stripeInvoice, eventId) {
  if (!stripeInvoice) return null;
  // Subscriptions are the other handler's business.
  if (stripeInvoice.subscription) return null;

  const invoiceId = stripeInvoice.metadata?.profixterInvoiceId;
  if (!invoiceId || stripeInvoice.metadata?.source !== "profixter_invoice") return null;

  const Invoice = require("../models/Invoice");
  const {
    recordStripePayment,
    classifyInvoicePayment,
    flagOutOfBandSettlement,
    resolvePaymentMethodType,
  } = require("../utils/invoiceOnlinePayments");
  const {
    sendInvoicePaymentNotification,
  } = require("../utils/invoicePaymentNotification");

  // Always read the current invoice: the balance may have moved since the
  // Stripe invoice was issued.
  const invoice = await Invoice.findById(invoiceId);
  if (!invoice) return null;

  /*
   * invoice.paid also fires when an invoice is marked paid out of band in the
   * Stripe Dashboard, where no money moved through Stripe. Recording that as a
   * customer online payment would invent revenue, so a payment is only recorded
   * when a real PaymentIntent backs it.
   */
  const classification = classifyInvoicePayment(stripeInvoice);
  if (!classification.online) {
    const flagged = flagOutOfBandSettlement(invoice, {
      reason: classification.reason,
      amountCents: stripeInvoice.amount_paid,
      stripeInvoiceId: stripeInvoice.id,
    });
    await invoice.save();
    return flagged;
  }

  /*
   * The method comes from the PaymentIntent, not from the invoice payload.
   * `payments.data[0].payment.type` is the kind of object the payment points
   * at, not the payment method, so reading it filed every card payment as
   * "Other". Resolving it cannot fail the payment: it returns "" on any
   * problem and the mapping falls back to "Other" exactly as before.
   */
  const paidAt = stripeInvoice.status_transitions?.paid_at
    ? new Date(stripeInvoice.status_transitions.paid_at * 1000)
    : new Date();
  const paymentMethodType = await resolvePaymentMethodType(classification.paymentIntentId);

  const result = recordStripePayment(invoice, {
    paymentIntentId: classification.paymentIntentId,
    stripeInvoiceId: stripeInvoice.id,
    eventId,
    amountCents: stripeInvoice.amount_paid,
    paidAt,
    paymentMethodType,
  });

  invoice.onlinePayment.stripeStatus = stripeInvoice.status || invoice.onlinePayment.stripeStatus;
  // A paid invoice is no longer a place to send someone to pay.
  if (stripeInvoice.status === "paid") invoice.onlinePayment.hostedInvoiceUrl = "";
  invoice.markModified("onlinePayment");
  await invoice.save();

  /*
   * Only on applied: true. One payment record equals one email, which is the
   * idempotency the PaymentIntent already provides, and an invoice settled out
   * of band never gets here at all. The send is wrapped because a mail failure
   * must never fail the webhook - Stripe would retry a payment that is already
   * recorded correctly.
   */
  if (result.applied) {
    try {
      await sendInvoicePaymentNotification(invoice, {
        appliedCents: result.appliedCents,
        unappliedCents: result.unappliedCents,
        method: invoice.payments.at(-1)?.method || "",
        paidAt,
      });
    } catch (error) {
      console.error("admin invoice paid email failed:", error.message);
    }
  }

  return result;
}

const ymdInTZ = (d, tz) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
const hhmmInTZ = (d, tz) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);

function isOneTimeCheckoutSession(session) {
  return (
    String(session?.mode || "").toLowerCase() === "payment" &&
    session?.metadata?.productKind === ONE_TIME_PRODUCT_KIND
  );
}

function isFullDayCheckoutSession(session) {
  return (
    String(session?.mode || "").toLowerCase() === "payment" &&
    session?.metadata?.productKind === FULL_DAY_PRODUCT_KIND
  );
}

async function handleInvoicePaymentFailed(invoice) {
  if (!invoice?.subscription) return;

  const stripeSubscription = await retrieveStripeSubscription(String(invoice.subscription));
  const billingReason = String(invoice.billing_reason || "").toLowerCase();

  const user = await findUserForStripeObject(stripeSubscription);

  // Send payment_failed email — fires once per invoice failure event (Stripe deduplicates).
  // Guard: only send to a real customer email, never to the admin address.
  const adminEmail = (process.env.MAIL_ADMIN || "getfixter@gmail.com").toLowerCase();
  const isRealCustomer = user && user.email && user.email.toLowerCase() !== adminEmail;

  if (isRealCustomer) {
    try {
      const sub = await Subscription.findOne({ stripeSubscriptionId: stripeSubscription.id });
      const plan = sub?.subscriptionType
        ? sub.subscriptionType.replace(/^./, (c) => c.toUpperCase())
        : null;
      const amount = invoice.amount_due ? `$${(invoice.amount_due / 100).toFixed(2)}` : null;
      const billingDate = invoice.created
        ? mail.formatNYCTime(new Date(invoice.created * 1000).toISOString())
        : null;

      await mail.sendTx("payment_failed", user.email, {
        name: user.name || user.email.split("@")[0],
        plan,
        amount,
        billingDate,
      }, {
        bccAdmin: false,
        logContext: {
          userId: user._id,
          customerName: user.name || "",
          customerEmail: user.email,
          recipientName: user.name || "",
          recipientEmail: user.email,
          emailType: "billing",
          source: "stripeWebhook",
        },
      });
    } catch (emailErr) {
      console.error("payment_failed email failed:", emailErr.message);
    }

    /*
     * The only payment text there is.
     *
     * Keyed on the invoice, because Stripe retries a failed invoice several
     * times across a dunning cycle and emits an event each time. The
     * customer needs telling once that this invoice needs attention, not
     * once per retry.
     *
     * There is deliberately no counterpart for a SUCCESSFUL renewal, an
     * upcoming charge or a card about to be billed. See utils/sms/smsTypes.
     */
    await smsNotify.notifyPaymentFailed({
      invoiceId: invoice.id,
      user,
      source: "stripeWebhook",
    });
  }

  if (billingReason === "subscription_cycle") {
    if (!user) {
      console.warn("No local user found for failed recurring invoice:", invoice.id);
      return;
    }
    await handlePaymentFailure(invoice, stripeSubscription, user);
    return;
  }

  await handlePaymentFailure(invoice, stripeSubscription, user);
}

async function handleCustomerUpdated(customer) {
  const user = await syncCustomerFromStripe(customer?.id || null);
  return user ? { userId: String(user._id) } : null;
}

/*
 * A card was attached to a customer.
 *
 * Refreshes the records of the customer's subscriptions so payment details
 * stay current. Two rules, both learned the hard way (2026-10-30):
 *
 *   - Each subscription only ever updates ITS OWN record (matched by Stripe
 *     id inside upsertSubscriptionFromStripe), so an old past-due subscription
 *     cannot overwrite the membership that replaced it.
 *   - One subscription that cannot be synced - an ended one from before
 *     checkout stamped the address - is logged and skipped. It used to fail
 *     the whole event, and Stripe's retries re-ran the sync for days.
 *
 * Ended subscriptions with no record of their own are skipped outright: there
 * is nothing to refresh, and nothing a card can change about them.
 */
async function handlePaymentMethodAttached(paymentMethod) {
  const customerId = paymentMethod?.customer ? String(paymentMethod.customer) : null;
  if (!customerId) return null;
  const user = await syncCustomerFromStripe(customerId);
  if (!user) return null;

  const subscriptions = await stripe.subscriptions.list({
    customer: customerId,
    status: "all",
    limit: 100,
    expand: ["data.items.data.price", "data.schedule", "data.latest_invoice.payment_intent"],
  });

  let synced = 0;
  let skipped = 0;
  for (const stripeSubscription of subscriptions.data || []) {
    try {
      if (ENDED_STRIPE_STATUSES.has(String(stripeSubscription.status || "").toLowerCase())) {
        const known = await Subscription.exists({ stripeSubscriptionId: stripeSubscription.id });
        if (!known) {
          skipped++;
          continue;
        }
      }
      const updated = await upsertSubscriptionFromStripe({
        stripeSubscription,
        user,
        addressIdHint: stripeSubscription.metadata?.addressId || null,
      });
      if (updated) synced++;
    } catch (error) {
      skipped++;
      logWebhook("warn", "payment_method_attached_subscription_skipped", {
        stripeSubscriptionId: stripeSubscription.id,
        status: stripeSubscription.status,
        message: error?.message || String(error),
      });
    }
  }
  return { userId: String(user._id), synced, skipped };
}

function eventStripeIds(event) {
  const object = event?.data?.object || {};
  return {
    stripeCustomerId: object.customer ? String(object.customer) : object.id?.startsWith?.("cus_") ? object.id : null,
    stripeSubscriptionId:
      object.subscription
        ? String(object.subscription)
        : object.id?.startsWith?.("sub_")
          ? object.id
          : null,
  };
}

const WEBHOOK_PROCESSING_TIMEOUT_MS = 5 * 60 * 1000;

async function beginWebhookEvent(event) {
  const ids = eventStripeIds(event);
  const existing = await StripeWebhookEvent.findOne({ eventId: event.id });

  if (existing?.status === "completed") {
    return { duplicate: true, retryLater: false, record: existing, ...ids };
  }

  if (existing) {
    const staleBefore = new Date(Date.now() - WEBHOOK_PROCESSING_TIMEOUT_MS);
    const claimed = await StripeWebhookEvent.findOneAndUpdate(
      {
        _id: existing._id,
        status: { $ne: "completed" },
        $or: [
          { status: "failed" },
          { status: "processing", updatedAt: { $lte: staleBefore } },
        ],
      },
      {
        $set: {
          status: "processing",
          lastError: null,
          eventType: event.type,
          stripeCustomerId: ids.stripeCustomerId,
          stripeSubscriptionId: ids.stripeSubscriptionId,
        },
      },
      { new: true }
    );

    return {
      duplicate: !claimed,
      retryLater: !claimed,
      record: claimed || existing,
      ...ids,
    };
  }

  try {
    const record = await StripeWebhookEvent.create({
      eventId: event.id,
      eventType: event.type,
      stripeCustomerId: ids.stripeCustomerId,
      stripeSubscriptionId: ids.stripeSubscriptionId,
      status: "processing",
    });
    return { duplicate: false, record, ...ids };
  } catch (error) {
    if (error?.code === 11000) {
      const concurrent = await StripeWebhookEvent.findOne({ eventId: event.id });
      return {
        duplicate: true,
        retryLater: concurrent?.status !== "completed",
        record: concurrent,
        ...ids,
      };
    }
    throw error;
  }
}

module.exports = async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    logWebhook("error", "webhook_config_missing", {
      missing: ["STRIPE_WEBHOOK_SECRET"],
    });
    return res.status(503).send("Webhook configuration missing");
  }

  try {
    const rawBody = req.rawBody ? req.rawBody : req.body;
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    logWebhook("error", "webhook_signature_failed", {
      message: err.message,
    });
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    const eventState = await beginWebhookEvent(event);
    logWebhook("info", "webhook_event_received", {
      stripeEventId: event.id,
      stripeEventType: event.type,
      stripeCustomerId: eventState.stripeCustomerId,
      stripeSubscriptionId: eventState.stripeSubscriptionId,
      duplicate: eventState.duplicate,
    });

    if (eventState.duplicate) {
      if (eventState.retryLater) {
        return res.status(409).send("Webhook event is already processing");
      }
      return res.sendStatus(200);
    }

    let syncResult = null;
    switch (event.type) {
      case "checkout.session.completed":
        syncResult = await handleCheckoutCompleted(event.data.object, event.id);
        // An Admin payment link this checkout came from is now paid (no-op for everything else).
        await markAdminPaymentLinkPaid(event.data.object).catch((error) =>
          logWebhook("warn", "admin_payment_link_mark_paid_failed", { stripeSessionId: event.data.object?.id, message: error?.message })
        );
        break;

      case "charge.refunded":
        // Tip-specific and nothing else: the handler returns immediately unless
        // the charge belongs to a Tip record we already hold.
        syncResult = await handleTipChargeRefunded(event.data.object);
        // Charge extra: keeps the AdditionalCharge refund total and status in step (refunds are made in Stripe).
        await extraCharges.handleChargeRefunded(event.data.object);
        /*
         * Then gifts, which keep their refund totals in step with Stripe.
         * This records money only and never revokes an entitlement somebody
         * is using; see utils/gifts/giftWebhook for why that is deliberate.
         */
        await handleGiftRefund(event.data.object);
        /*
         * Then Loyalty, which stops counting a membership month whose money
         * came back. Finds nothing unless the charge settled a membership
         * renewal invoice, so tips, gifts and project invoices pass straight
         * through. The reward already given is deliberately left alone.
         */
        await reverseLoyaltyFromCharge({
          charge: event.data.object,
          reason: "charge_refunded",
        });
        // Sales desk: a refund on a credited sale opens an owner review. Nothing is deducted automatically.
        await salesStripe.onChargeRefunded(event.data.object);
        break;

      /*
       * A chargeback. Previously unhandled, and Loyalty is the reason it has to
       * be: a member who disputes their eleventh month and wins has not paid for
       * it, and a month nobody paid for must not carry them to a reward.
       *
       * Deliberately narrow — it reverses the loyalty month and nothing else.
       * Revoking access on a dispute we may intend to contest is a decision for
       * a person, exactly as it is for gift refunds.
       */
      case "charge.dispute.created":
        await handleLoyaltyDispute(event.data.object);
        await salesStripe.onDispute(event.data.object, "opened");
        break;

      // Sales desk only: the outcome of a chargeback, for the owner's review. (Subscribe the endpoint to it to receive it.)
      case "charge.dispute.closed":
        await salesStripe.onDispute(event.data.object, "closed");
        break;

      case "checkout.session.expired":
        if (extraCharges.isExtraChargeObject(event.data.object)) {
          syncResult = await extraCharges.handleCheckoutSession(event.data.object);
        } else if (freeVisitConversion.isConversionSession(event.data.object)) {
          /*
           * A free-visit conversion page closed unpaid: the free visit is
           * untouched and its link still works. No abandoned-checkout email:
           * the customer still has their visit, and Admin sees the link.
           */
          syncResult = await freeVisitConversion.handleConversionExpired(event.data.object);
        } else if (isOneTimeCheckoutSession(event.data.object)) {
          syncResult = await handleOneTimeCheckoutExpired(event.data.object, "expired");
        } else if (isFullDayCheckoutSession(event.data.object)) {
          syncResult = await handleFullDayCheckoutExpired(event.data.object, "expired");
        } else if (event.data.object?.mode === "subscription") {
          /*
           * An abandoned membership checkout. Only a proposal for the growth
           * engine, which decides whether a recovery email goes out; it never
           * throws, so it cannot fail this event.
           */
          await proposeCheckoutRecovery(event.data.object, findUserForStripeObject);
          // Booked before paying (utils/membershipFirstVisit): the visit time held for this page goes back on the calendar.
          const holdId = event.data.object?.metadata?.firstVisitHoldId;
          if (holdId) await releaseCheckoutHold({ holdId, checkoutSessionId: event.data.object.id });
          await markFirstVisitExpired(event.data.object);
        }
        break;

      /*
       * Charge extra: the PaymentIntent is the truth for an extra (the API
       * answer, a retry, this webhook and a pull from Stripe all reconcile
       * through the same idempotent function). Ignored for everything else.
       */
      case "payment_intent.succeeded":
      case "payment_intent.processing":
      case "payment_intent.canceled":
        syncResult = await extraCharges.handlePaymentIntentEvent(event.data.object);
        break;

      case "checkout.session.async_payment_succeeded":
      case "checkout.session.async_payment_failed":
        // A delayed payment on a paid visit's page: paid settles it once; failed ends it (the page is closed by then).
        if (isOneTimeCheckoutSession(event.data.object) || isFullDayCheckoutSession(event.data.object)) {
          if (event.type === "checkout.session.async_payment_succeeded") syncResult = await handleCheckoutCompleted(event.data.object, event.id);
          else if (isOneTimeCheckoutSession(event.data.object)) syncResult = await handleOneTimeCheckoutExpired(event.data.object, "failed");
          else syncResult = await handleFullDayCheckoutExpired(event.data.object, "failed");
          break;
        }
        syncResult = await extraCharges.handleCheckoutSession(event.data.object);
        break;

      case "payment_intent.payment_failed": {
        if (extraCharges.isExtraChargeObject(event.data.object)) {
          syncResult = await extraCharges.handlePaymentIntentEvent(event.data.object);
          break;
        }
        const failedKind = event.data.object?.metadata?.productKind;
        const failedSession = {
          id: event.data.object?.metadata?.stripeCheckoutSessionId || null,
          metadata: event.data.object?.metadata,
          client_reference_id: event.data.object?.metadata?.bookingId || null,
        };
        /*
         * A declined card on a One-Time or Full Day page. Stripe keeps the page
         * open for another card, so the booking and its held time stay
         * (utils/paidVisitSettlement). The page's own expiry releases them.
         */
        if (failedKind === ONE_TIME_PRODUCT_KIND || failedKind === FULL_DAY_PRODUCT_KIND) {
          syncResult = await recordPaidVisitDecline(Booking, failedSession.client_reference_id);
        }
        break;
      }

      case "customer.subscription.created":
        syncResult = await syncStripeSubscriptionRecord(event.data.object);
        break;

      case "customer.subscription.updated":
        syncResult = await syncStripeSubscriptionRecord(event.data.object);
        break;

      case "customer.subscription.deleted":
        syncResult = await syncStripeSubscriptionRecord(event.data.object);
        break;

      case "invoice.paid":
        // Two independent consumers of the same event. The subscription handler
        // guards on invoice.subscription and ignores everything else; the
        // project handler guards on our own metadata. Neither can process the
        // other's invoices, and the subscription path sees exactly the events it
        // saw before.
        syncResult = await handleInvoicePaid(event.data.object);
        await handleProjectInvoicePaid(event.data.object, event.id);
        break;

      case "invoice.payment_failed":
        syncResult = await handleInvoicePaymentFailed(event.data.object);
        break;

      case "invoice.payment_action_required":
        // 3DS authentication required for a renewal invoice.
        // Stripe retries automatically; sync state without cutting access.
        if (event.data.object?.subscription) {
          try {
            const sub = await retrieveStripeSubscription(
              String(event.data.object.subscription)
            );
            syncResult = await syncStripeSubscriptionRecord(sub);
          } catch (syncErr) {
            console.warn(
              "invoice.payment_action_required sync failed:",
              syncErr.message
            );
          }
        }
        break;

      case "customer.updated":
        syncResult = await handleCustomerUpdated(event.data.object);
        break;

      case "payment_method.attached":
        syncResult = await handlePaymentMethodAttached(event.data.object);
        break;

      default:
        break;
    }

    await StripeWebhookEvent.updateOne(
      { eventId: event.id },
      {
        $set: {
          status: "completed",
          processedAt: new Date(),
          lastError: null,
        },
      }
    );
    logWebhook("info", "webhook_event_synced", {
      stripeEventId: event.id,
      stripeEventType: event.type,
      stripeCustomerId: eventState.stripeCustomerId,
      stripeSubscriptionId: eventState.stripeSubscriptionId,
      syncResult: syncResult?._id ? String(syncResult._id) : syncResult || null,
    });
    return res.sendStatus(200);
  } catch (err) {
    if (event?.id) {
      await StripeWebhookEvent.updateOne(
        { eventId: event.id },
        {
          $set: {
            status: "failed",
            lastError: err?.message || "Unknown webhook error",
          },
        }
      ).catch(() => {});
    }
    logWebhook("error", "webhook_handler_failed", {
      stripeEventId: event?.id || null,
      stripeEventType: event?.type || null,
      message: err?.message || "Unknown webhook error",
    });
    return res.status(500).send("Server error");
  }
};

/*
 * Exposed for the tip integration suite. Reaching them through the exported
 * handler would mean forging a Stripe signature, which would test the fake
 * rather than the behaviour that matters.
 */
module.exports.handleFixterTipCheckoutCompleted = handleFixterTipCheckoutCompleted;
/* The local preview stack's "simulate payment" (scripts/preview/start.js) runs the real completion path. */
module.exports.handleCheckoutCompleted = handleCheckoutCompleted;
/* A simulated membership payment delivers what Stripe sends after one: the subscription, its first invoice, the checkout. */
module.exports.syncStripeSubscriptionRecord = syncStripeSubscriptionRecord;
module.exports.handleInvoicePaid = handleInvoicePaid;
/* ...and its fake "expire" the real paid-visit expiry path (the preview has no webhooks). */
module.exports.handlePaidVisitCheckoutExpired = async (session) =>
  isOneTimeCheckoutSession(session) ? handleOneTimeCheckoutExpired(session, "expired") : isFullDayCheckoutSession(session) ? handleFullDayCheckoutExpired(session, "expired") : null;
module.exports.handleTipChargeRefunded = handleTipChargeRefunded;

/*
 * The discount helpers, exposed for testing.
 *
 * They are pure: given Stripe objects they return rows. Testing them directly
 * is worth more than driving the whole webhook, which would need a forged
 * Stripe signature and would end up testing the fake rather than the rule that
 * a percentage must be reported to Admin in dollars.
 */
module.exports.__testables = {
  promotionAdminRows,
  promotionDetails,
  promotionDisplayName,
  promotionDurationNote,
  // Meta conversions (2026-11-03): what was charged, staff sales, gifts.
  chargedBeforeTax,
  soldByStaff,
  reportPaidVisitPurchase,
  reportGiftPurchase,
  oneTimePaymentPriceLabel,
};
