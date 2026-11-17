/*
 * "Convert to paid visit": a free visit becomes a membership or One-Time
 * visit, paid by the customer through a secure link (owner brief 2026-11-16).
 *
 * THE BOOKING IS CONVERTED IN PLACE. Same id, day and time, reservation,
 * assigned Fixter, address, notes and photos. Nothing is cancelled and
 * rebooked, so there is no moment when the time is free for someone else and
 * no second visit can ever be made.
 *
 * NOTHING CHANGES UNTIL STRIPE SAYS PAID. Making or sending the link, opening
 * the Stripe page, a declined card, an abandoned or expired page: the free
 * visit is exactly as it was. Only the webhook (or the sweep, or Admin's
 * retry, all through runConversion) changes the booking, and only once:
 * paid -> converting is an atomic claim, and the booking update itself is
 * conditional on the booking still being the unconverted free visit at the
 * time the link was made for.
 *
 * NEVER A FALSE "UPGRADED". If the payment succeeds but the visit cannot be
 * converted safely (it was cancelled, moved or completed meanwhile, the
 * member seven-day rule or plan limit now refuses it, the membership never
 * became active), the conversion becomes needs_attention: the booking is
 * left alone, the customer is told their payment arrived and that their visit
 * has not changed yet, and the owner is told what to do. Admin can retry
 * (with an explicit, recorded seven-day override where that is the reason)
 * or close it after settling it by hand.
 *
 * RULES KEPT
 *  - The owner's approval: a visit awaiting approval (Pending Confirmation)
 *    becomes Pending, which is how a paid visit awaits approval; a Confirmed
 *    one stays Confirmed. Nothing is approved or rejected automatically, and
 *    the task description is never used to refuse anything.
 *  - Membership checkouts go through utils/membershipCheckout.js (one
 *    membership per home, Stripe asked, one checkout at a time); One-Time uses
 *    the One-Time price and enabled switch (utils/oneTimeVisitSettings).
 *  - The member seven-day rule: a new membership's first visit is exempt
 *    (the existing rule, utils/membershipFirstVisit); otherwise Admin must
 *    override it explicitly, with a reason that is recorded. The plan's limit
 *    on booked visits is checked when the link is made and again on payment.
 *  - A converted visit still counts as the person's free visit for the
 *    lifetime rule (utils/freeVisit/eligibility): it was booked as one.
 *
 * Guests: a One-Time visit needs no account. A membership belongs to an
 * account, so Admin settles it before the link is made - the account already
 * on the visit, one Admin picks from those matching the visit's email or
 * phone, or a new one created from the visit's details. Nothing is merged and
 * no account is chosen silently.
 *
 * TWO WAYS IN, ONE CONVERSION. Admin makes a link (createConversion, then
 * /pay/<token> -> openConversionCheckout), or the customer, signed in,
 * upgrades their own visit from its card (customerUpgradeOptions,
 * startCustomerUpgrade). Both open their Stripe page through openCheckout,
 * and from the payment on everything is the same code.
 */
const crypto = require("crypto");
const mongoose = require("mongoose");
const moment = require("moment-timezone");

const Booking = require("../../models/Booking");
const User = require("../../models/User");
const Subscription = require("../../models/Subscription");
const AdminPaymentLink = require("../../models/AdminPaymentLink");
const AdminActivityLog = require("../../models/AdminActivityLog");
const VisitEntitlement = require("../../models/VisitEntitlement");
const FreeVisitConversion = require("../../models/FreeVisitConversion");
const mail = require("../emailService");
const { normalizeEmail, normalizePhoneE164, extractUSNationalPhoneDigits } = require("../identity");
const { findActiveBlock, phoneSpellings } = require("../customerBlock");
const { isAddressInServiceArea, outOfServiceAreaMessage } = require("../serviceArea");
const { bookingYMD, earliestMemberVisitYMD, isBeforeEarliestMemberVisit } = require("../bookingLeadTime");
const { addressMatchKey } = require("./eligibility");

const TZ = "America/New_York";
const CLIENT_URL = String(process.env.CLIENT_URL || "https://www.profixter.com").replace(/\/+$/, "");
const SITE = "https://www.profixter.com";
const BUSINESS_PHONE = "631-599-1363";
const PLAN_LABELS = { basic: "Basic", plus: "Plus", premium: "Premium", elite: "Elite" };

/* The link lives at most a week, and closes 90 minutes before the visit starts. */
const LINK_MAX_MS = 7 * 24 * 60 * 60 * 1000;
const LINK_CLOSES_BEFORE_VISIT_MS = 90 * 60 * 1000;
/* Stripe refuses a Checkout expiry under 30 minutes, or over 24 hours. */
const CHECKOUT_MIN_MS = 31 * 60 * 1000;
const CHECKOUT_MAX_MS = 24 * 60 * 60 * 1000 - 60 * 1000;
const OPENING_LOCK_MS = 20 * 1000;
const STALE_CONVERTING_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const TERMS_VERSION = "paid_visit_conversion.v1";

const LIVE_STATUSES = FreeVisitConversion.LIVE_STATUSES;
const FINAL_BOOKING = /^\s*(canceled|cancelled|completed|complete|done)\s*$/i;

/* Loaded on use: these modules load models and services that require this one's neighbours. */
const reservations = () => require("../slotReservationService");
const subscriptions = () => require("../subscriptionManagement");
const membershipCheckout = () => require("../membershipCheckout");
const firstVisit = () => require("../membershipFirstVisit");
const paymentLinks = () => require("../admin/paymentLinks");
const bookingRoutes = () => require("../../routes/bookings");

class ConversionError extends Error {
  constructor(code, message, status = 409, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

function log(level, event, fields = {}) {
  const line = JSON.stringify({ event, scope: "free_visit_conversion", ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}

function actorOf(admin) {
  return { by: admin?._id || null, byName: String(admin?.name || admin?.email || "").slice(0, 120) };
}

function historyEntry(event, admin = null, detail = null) {
  return { at: new Date(), event, ...actorOf(admin), detail };
}

function firstNameOf(name) {
  const first = String(name || "").trim().split(/\s+/)[0] || "";
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : "there";
}

function whenLabel(date) {
  return moment(date).tz(TZ).format("dddd, MMMM D [at] h:mm A");
}

function dollars(cents) {
  const n = Number(cents || 0) / 100;
  return `$${Number.isInteger(n) ? n.toFixed(0) : n.toFixed(2)}`;
}

function addressLine(booking) {
  return [[booking.address, booking.unit ? `Unit ${booking.unit}` : ""].filter(Boolean).join(", "), booking.city, booking.state, booking.zip]
    .filter(Boolean)
    .join(", ");
}

function bookingAddressKey(booking) {
  return addressMatchKey({ line1: booking.address, unit: booking.unit, city: booking.city, state: booking.state, zip: booking.zip });
}

function hashIp(ip) {
  return crypto.createHash("sha256").update(String(ip || "")).digest("hex").slice(0, 32);
}

/* ------------------------------------------------------------------ */
/* Which bookings can be converted                                      */
/* ------------------------------------------------------------------ */

function isConverted(booking) {
  return Boolean(booking?.freeVisitConversion?.convertedAt);
}

/** A free visit by any of the ways the system has written one, and not converted already. */
function isUnconvertedFreeVisit(booking) {
  if (!booking || isConverted(booking)) return false;
  if (booking.bookingType === "full_day_visit" || booking.accessType === "admin") return false;
  return Boolean(
    booking.accessType === "free_first_visit" || booking.isFreeFirstVisit || booking.guestRequestId || booking.freeVisitChannel
  );
}

/**
 * Why this booking cannot be converted now, or null. Pure: no queries.
 * Checked when the link is made, when the Stripe page is opened, and again
 * (with the snapshot) when the payment arrives.
 */
function convertProblem(booking, now = new Date(), { email = "" } = {}) {
  if (!booking) return { code: "BOOKING_NOT_FOUND", message: "This visit was not found.", status: 404 };
  if (isConverted(booking)) return { code: "ALREADY_CONVERTED", message: "This visit is already a paid visit." };
  if (!isUnconvertedFreeVisit(booking)) return { code: "NOT_A_FREE_VISIT", message: "Only a free visit can be converted to a paid visit." };
  const status = String(booking.status || "");
  if (FINAL_BOOKING.test(status)) return { code: "VISIT_CLOSED", message: `This visit is ${status}; it cannot be converted.` };
  if (!/^\s*(pending|pending[\s_-]*confirmation|confirmed)\s*$/i.test(status)) {
    return { code: "VISIT_STATUS", message: `A visit that is ${status || "in this state"} cannot be converted.` };
  }
  const start = new Date(booking.date);
  if (Number.isNaN(start.getTime()) || start <= now) return { code: "VISIT_STARTED", message: "This visit has already started or passed." };
  if (reservations().reservationEngineEnabled() && !booking.slotReservationId) {
    return { code: "NO_RESERVATION", message: "This visit has no reserved time. Pick and save a time for it first." };
  }
  if (!String(booking.address || "").trim() || !String(booking.city || "").trim() || !/^\d{5}$/.test(String(booking.zip || "").trim())) {
    return { code: "ADDRESS_REQUIRED", message: "Add and save the full service address on the visit first.", status: 400 };
  }
  if (!isAddressInServiceArea({ zip: booking.zip })) return { code: "OUT_OF_SERVICE_AREA", message: outOfServiceAreaMessage(), status: 400 };
  /* The receipt's address: the visit's own, or (a customer upgrading from their account) the account's. */
  if (!normalizeEmail(booking.email) && !normalizeEmail(email)) {
    return { code: "EMAIL_REQUIRED", message: "Add the customer's email on the visit first: the receipt and confirmation go there.", status: 400 };
  }
  return null;
}

function assertConvertible(booking, now = new Date()) {
  const problem = convertProblem(booking, now);
  if (problem) throw new ConversionError(problem.code, problem.message, problem.status || 409);
}

/** The visit still matches what the link was made for (day, time, address, still live, still free). */
function matchesSnapshot(booking, conversion) {
  if (!booking || !conversion?.snapshot) return false;
  if (new Date(booking.date).getTime() !== new Date(conversion.snapshot.date).getTime()) return false;
  if (conversion.snapshot.addressKey && bookingAddressKey(booking) !== conversion.snapshot.addressKey) return false;
  return true;
}

/* Pending Confirmation (a free visit awaiting approval) -> Pending (a paid visit awaiting approval). */
function convertedStatus(status) {
  return /^\s*confirmed\s*$/i.test(String(status || "")) ? "Confirmed" : "Pending";
}

/* ------------------------------------------------------------------ */
/* Accounts (memberships)                                               */
/* ------------------------------------------------------------------ */

function maskEmail(email) {
  const [local, domain] = String(email || "").split("@");
  if (!domain) return "";
  return `${local.slice(0, 2)}${"*".repeat(Math.max(1, local.length - 2))}@${domain}`;
}

/** Customer accounts matching the visit's email or phone, for Admin to choose from. Never staff. */
async function accountCandidates(booking) {
  const email = normalizeEmail(booking.email);
  const digits = extractUSNationalPhoneDigits(booking.phone || "") || "";
  const or = [];
  if (email) or.push({ email });
  if (digits.length === 10) or.push({ phone: { $in: phoneSpellings(digits) } });
  if (!or.length) return [];
  const users = await User.find({ role: "customer", employeePosition: { $in: [null, ""] }, $or: or })
    .select("_id name email phone addresses")
    .limit(10)
    .lean();
  return users.map((u) => ({
    id: String(u._id),
    name: u.name || "",
    email: maskEmail(u.email),
    phoneLast4: String(u.phone || "").replace(/\D/g, "").slice(-4),
    matchedOn: [
      email && normalizeEmail(u.email) === email ? "email" : "",
      digits.length === 10 && String(u.phone || "").replace(/\D/g, "").slice(-10) === digits ? "phone" : "",
    ].filter(Boolean),
    hasThisHome: (u.addresses || []).some((a) => addressMatchKey(a) === bookingAddressKey(booking)),
  }));
}

/**
 * The account a membership for this visit belongs to, chosen WITHOUT writing
 * anything: every refusal runs before an account is created or a home added.
 *   the visit is already on an account          -> { user, source: "booking" }
 *   account.mode "link"  (one of accountCandidates) -> { user, source: "linked" }
 *   account.mode "create" (from the visit's details) -> { user: null, source: "created" }
 * Linking or creating changes a customer's account, so it needs the
 * Customers section (customers.manage), like every other account change.
 */
async function chooseAccount({ booking, account = {}, canManageAccounts }) {
  if (booking.user) {
    const user = await User.findById(booking.user);
    if (!user) throw new ConversionError("ACCOUNT_NOT_FOUND", "The account on this visit no longer exists.", 409);
    return { user, source: "booking" };
  }
  const mode = String(account.mode || "");
  if (mode === "link" || mode === "create") {
    if (!canManageAccounts) {
      throw new ConversionError(
        mode === "create" ? "FORBIDDEN_ACCOUNT_CREATE" : "FORBIDDEN_ACCOUNT_LINK",
        mode === "create" ? "Creating customer accounts needs the Customers section." : "Putting a visit on a customer's account needs the Customers section.",
        403
      );
    }
  }
  if (mode === "link") {
    const candidates = await accountCandidates(booking);
    const chosen = candidates.find((c) => c.id === String(account.userId || ""));
    if (!chosen) throw new ConversionError("ACCOUNT_NOT_A_MATCH", "Choose one of the accounts that match this visit's email or phone.", 400);
    /* The visit's email belongs to one account only: never put the visit on someone else's. */
    const emailOwner = candidates.find((c) => c.matchedOn.includes("email"));
    if (emailOwner && emailOwner.id !== chosen.id) {
      throw new ConversionError("EMAIL_BELONGS_TO_ANOTHER_ACCOUNT", `The email on this visit belongs to another account (${emailOwner.name || "another customer"}). Choose that one, or correct the email on the visit first.`, 409);
    }
    /* Matched by phone only (a household shares a phone): Admin must say it is the same person. */
    if (!chosen.matchedOn.includes("email") && account.confirmDifferentEmail !== true) {
      throw new ConversionError(
        "ACCOUNT_EMAIL_DIFFERS",
        `${chosen.name || "That account"} matches this visit's phone but has a different email (${chosen.email}). Confirm it is the same person before putting the visit on that account.`,
        409
      );
    }
    return { user: await User.findById(chosen.id), source: "linked" };
  }
  if (mode === "create") return { user: null, source: "created" };
  throw new ConversionError("ACCOUNT_REQUIRED", "A membership belongs to an account. Choose the customer's account, or create one from this visit.", 400);
}

/** Create the account from the visit's details (sends its sign-in details, as creating a customer always does). */
async function createAccountFromVisit({ booking, account = {}, admin, req, deps = {} }) {
  const parts = String(booking.name || "").trim().split(/\s+/);
  const { createCustomerByAdmin } = require("../admin/customerAccess");
  try {
    const created = await createCustomerByAdmin({
      body: {
        firstName: String(account.firstName || parts[0] || "").trim(),
        lastName: String(account.lastName || parts.slice(1).join(" ") || "").trim(),
        email: booking.email,
        phone: booking.phone,
        address: { line1: booking.address, unit: booking.unit || "", city: booking.city, state: booking.state || "NY", zip: booking.zip },
        allowSharedPhone: account.allowSharedPhone === true,
        /* A paid visit is not a marketing sign-up: only the service email the account always has. */
        communication: { "service.email": true, "service.sms": false, "marketing.sms": false, "marketing.email": false },
      },
      admin,
      req,
      deps: deps.customerAccess || {},
    });
    return User.findById(created.user._id);
  } catch (error) {
    if (error?.code && error?.status) throw new ConversionError(error.code, error.message, error.status, error.extra || {});
    throw error;
  }
}

/** Checks a new account would pass, made BEFORE it is created (createCustomerByAdmin refuses them too). */
async function assertAccountCreatable({ booking, account = {} }) {
  const email = normalizeEmail(booking.email);
  if (email && (await User.exists({ email }))) {
    throw new ConversionError("EMAIL_IN_USE", "An account with this visit's email already exists. Choose it instead of creating one.", 409);
  }
  const digits = extractUSNationalPhoneDigits(booking.phone || "") || "";
  if (account.allowSharedPhone !== true && digits.length === 10 && (await User.exists({ phone: { $in: phoneSpellings(digits) }, role: { $nin: ["employee", "admin"] } }))) {
    throw new ConversionError("PHONE_IN_USE", "This phone number is already on another customer's account. Choose that account, or confirm this is a different person who shares the phone.", 409);
  }
  const parts = String(booking.name || "").trim().split(/\s+/);
  if (!String(account.firstName || parts[0] || "").trim() || !String(account.lastName || parts.slice(1).join(" ") || "").trim()) {
    throw new ConversionError("NAME_REQUIRED", "Enter the customer's first and last name for the new account.", 400);
  }
}

/** The account's home for this visit's address, if it already has it. */
function findHome(user, booking) {
  const key = bookingAddressKey(booking);
  return (user?.addresses || []).find((a) => addressMatchKey(a) === key) || null;
}

/** Can the visit's address be added to this account? Checked before anything is written. */
function prepareHome(user, booking) {
  const { buildAddress, MAX_ADDRESSES } = require("../customerProfileEdit");
  if ((user.addresses || []).length >= MAX_ADDRESSES) {
    throw new ConversionError("TOO_MANY_HOMES", `This account already has ${MAX_ADDRESSES} homes. Remove one, or add this address to it, first.`, 409);
  }
  const built = buildAddress({ line1: booking.address, unit: booking.unit || "", city: booking.city, state: booking.state || "NY", zip: booking.zip }, null, (user.addresses || []).length);
  if (built.errors) throw new ConversionError("ADDRESS_INVALID", "The visit's address could not be added to the account. Check it on the visit first.", 400);
  return built.address;
}

async function addHome(user, address) {
  user.addresses.push(address);
  if (!user.defaultAddressId) user.defaultAddressId = user.addresses[user.addresses.length - 1]._id;
  await user.save();
  return user.addresses[user.addresses.length - 1];
}

/* ------------------------------------------------------------------ */
/* Membership rules: limit, seven days                                  */
/* ------------------------------------------------------------------ */

function planLimit(plan) {
  return String(plan || "").toLowerCase() === "basic" ? 1 : 2;
}

/** Other booked visits at this home (this one excluded), against the plan's limit. */
async function otherActiveVisits({ userId, addressId, bookingId }) {
  const { isTerminalBookingStatus } = reservations();
  const rows = await Booking.find({
    user: userId,
    addressId,
    _id: { $ne: bookingId },
    date: { $gte: new Date() },
    accessType: { $ne: "admin" },
  })
    .select("status")
    .lean();
  return rows.filter((b) => !isTerminalBookingStatus(b.status)).length;
}

/**
 * How the member seven-day rule applies to this visit.
 * Returns { rule, earliestMemberDate } or throws LEAD_TIME_OVERRIDE_REQUIRED.
 */
async function leadTimeDecision({ booking, userId, overrideReason = "", admin = null }) {
  const ymd = bookingYMD(booking.date);
  const earliestMemberDate = earliestMemberVisitYMD();
  if (!isBeforeEarliestMemberVisit(ymd)) return { rule: "none", earliestMemberDate };
  if (await firstVisit().firstVisitExemptionEligible(userId)) return { rule: "first_visit_exemption", earliestMemberDate };
  const reason = String(overrideReason || "").trim().slice(0, 300);
  if (reason) {
    return { rule: "admin_override", earliestMemberDate, override: { ...actorOf(admin), at: new Date(), reason } };
  }
  throw new ConversionError(
    "LEAD_TIME_OVERRIDE_REQUIRED",
    `Member visits are booked at least 7 days ahead (from ${earliestMemberDate}), and this customer already has a membership, so the first-visit exception does not apply. Override the rule with a reason to keep this time.`,
    409,
    { earliestMemberDate }
  );
}

/* ------------------------------------------------------------------ */
/* Terms                                                                */
/* ------------------------------------------------------------------ */

function priceCentsFor(conversion) {
  if (conversion.kind === "one_time") return conversion.priceCents;
  const plan = subscriptions().PLAN_CATALOG[conversion.plan];
  const dollarsPrice = plan?.[conversion.billingCycle === "annual" ? "annual" : "monthly"]?.price;
  return dollarsPrice != null ? Math.round(dollarsPrice * 100) : null;
}

function offerLabel(conversion) {
  if (conversion.kind === "one_time") return "One-Time Visit";
  return `${PLAN_LABELS[conversion.plan] || conversion.plan} membership (${conversion.billingCycle === "annual" ? "annual" : "monthly"})`;
}

/** The words the customer agrees to, exactly as the payment page shows them. */
/*
 * variant "welcome": the 20% first-payment offer (utils/welcomeOffer.js) is on
 * the page - a customer-started membership only, never an Admin link.
 */
function termsText(conversion, booking, { variant = "regular" } = {}) {
  const when = whenLabel(booking.date);
  const cents = priceCentsFor(conversion);
  const price = dollars(cents);
  if (conversion.kind === "one_time") {
    return `I agree to the Profixter Terms of Service (${SITE}/terms). This is a single 90-minute One-Time Visit for ${price}, with no membership and no recurring charge. My visit on ${when} becomes this paid visit.`;
  }
  const period = conversion.billingCycle === "annual" ? "year" : "month";
  const plan = PLAN_LABELS[conversion.plan] || conversion.plan;
  if (variant === "welcome") {
    const { firstPaymentCents, WELCOME_OFFER_PERCENT } = require("../welcomeOffer");
    return `I agree to the Profixter Terms of Service (${SITE}/terms). My ${plan} membership's first payment is ${dollars(firstPaymentCents(cents))} (${WELCOME_OFFER_PERCENT}% off), then ${price} per ${period} plus any applicable tax; it renews automatically every ${period} until I cancel, and I can cancel anytime before the next renewal. My visit on ${when} becomes a membership visit.`;
  }
  return `I agree to the Profixter Terms of Service (${SITE}/terms). My ${plan} membership costs ${price} per ${period} plus any applicable tax and renews automatically every ${period} until I cancel; I can cancel anytime before the next renewal. My visit on ${when} becomes a membership visit.`;
}

/* ------------------------------------------------------------------ */
/* Admin: what can be offered                                           */
/* ------------------------------------------------------------------ */

async function loadBooking(bookingId) {
  if (!mongoose.isValidObjectId(bookingId)) throw new ConversionError("INVALID_BOOKING", "Invalid booking id", 400);
  const booking = await Booking.findById(bookingId);
  if (!booking) throw new ConversionError("BOOKING_NOT_FOUND", "This visit was not found.", 404);
  return booking;
}

function presentConversion(conversion) {
  if (!conversion) return null;
  const c = conversion.toObject ? conversion.toObject() : conversion;
  return {
    id: String(c._id),
    status: c.status,
    kind: c.kind,
    plan: c.plan,
    billingCycle: c.billingCycle,
    offerLabel: offerLabel(c),
    priceCents: c.kind === "one_time" ? c.priceCents : priceCentsFor(c),
    task: c.task,
    accountSource: c.accountSource,
    source: c.source || "admin",
    welcomeOfferApplied: Boolean(c.welcomeOfferApplied),
    userId: c.user ? String(c.user) : null,
    contact: c.contact,
    leadTime: {
      rule: c.leadTime?.rule || "",
      earliestMemberDate: c.leadTime?.earliestMemberDate || "",
      override: c.leadTime?.override?.at ? { byName: c.leadTime.override.byName, at: c.leadTime.override.at, reason: c.leadTime.override.reason } : null,
    },
    linkExpiresAt: c.linkExpiresAt,
    checkoutOpen: Boolean(c.checkout?.sessionId),
    checkoutOpenedAt: c.checkout?.sessionId ? c.history?.slice().reverse().find((h) => h.event === "checkout_opened")?.at || null : null,
    termsAcceptedAt: c.terms?.acceptedAt || null,
    sends: (c.sends || []).map((s) => ({ channel: s.channel, to: s.to, result: s.result, at: s.at, byName: s.byName })),
    payment: c.payment?.paidAt ? { paidAt: c.payment.paidAt, amountCents: c.payment.amountCents, currency: c.payment.currency, sessionId: c.payment.sessionId } : null,
    convertedAt: c.convertedAt,
    attention: c.attention?.at ? c.attention : null,
    /* The converted visit was canceled afterwards: its payment waits for Admin's decision (paymentResolution.js). */
    afterCancel: c.afterCancel?.at ? { at: c.afterCancel.at, byName: c.afterCancel.byName, reason: c.afterCancel.reason, resolvedAt: c.afterCancel.resolvedAt || null } : null,
    resolution: c.resolution?.at
      ? { kind: c.resolution.kind, for: c.resolution.for, note: c.resolution.note, at: c.resolution.at, byName: c.resolution.byName, firstPaymentRefunded: c.resolution.firstPaymentRefunded ?? null, verified: c.resolution.verified || null }
      : null,
    followUp: c.status === "needs_attention" ? "attention" : c.afterCancel?.at && !c.afterCancel?.resolvedAt ? "after_cancel" : null,
    history: (c.history || []).map((h) => ({ at: h.at, event: h.event, byName: h.byName, detail: h.detail })),
    createdAt: c.createdAt,
    createdByName: c.createdByName,
  };
}

/**
 * Everything the Convert sheet needs: whether the visit can be converted,
 * the offers and their prices, the account situation, the seven-day rule,
 * and the current and earlier conversions.
 */
async function conversionOptions({ bookingId }) {
  const booking = await loadBooking(bookingId);
  const problem = convertProblem(booking);
  const { getOneTimeVisitSettings } = require("../oneTimeVisitSettings");
  const oneTime = await getOneTimeVisitSettings();
  const user = booking.user ? await User.findById(booking.user).select("_id name email phone addresses").lean() : null;
  const candidates = user ? [] : await accountCandidates(booking);
  const ymd = bookingYMD(booking.date);
  const insideMemberLeadTime = isBeforeEarliestMemberVisit(ymd);
  const exemptionEligible = user ? await firstVisit().firstVisitExemptionEligible(user._id) : true;
  const home = user ? (user.addresses || []).find((a) => addressMatchKey(a) === bookingAddressKey(booking)) : null;
  let membershipBlocker = null;
  if (user && home) {
    try {
      const fullUser = await User.findById(user._id);
      const blocker = await membershipCheckout().membershipSaleBlocker({ user: fullUser, addressId: home._id });
      if (blocker) membershipBlocker = { code: blocker.body?.code || "", message: blocker.body?.message || "" };
    } catch (error) {
      membershipBlocker = { code: "CHECK_FAILED", message: "Could not check this home with Stripe. Try again." };
    }
  }
  const conversions = await FreeVisitConversion.find({ booking: booking._id }).sort({ createdAt: -1 }).limit(10);
  /* The live one; else a converted visit canceled afterwards whose payment still waits for Admin (paymentResolution.js). */
  const current = conversions.find((c) => LIVE_STATUSES.includes(c.status)) || conversions.find((c) => c.afterCancel?.at && !c.afterCancel?.resolvedAt) || null;
  return {
    booking: {
      id: String(booking._id),
      bookingNumber: booking.bookingNumber,
      status: booking.status,
      date: booking.date,
      whenLabel: whenLabel(booking.date),
      address: addressLine(booking),
      name: booking.name,
      email: booking.email,
      phone: booking.phone,
      service: booking.service,
      selectedTask: booking.selectedTask || "",
      note: booking.note || "",
      photos: (booking.images || []).length,
      assignedFixterName: booking.assignedFixterName || "",
      converted: isConverted(booking) ? booking.freeVisitConversion : null,
    },
    convertible: !problem,
    problem,
    /* Before an account is chosen; a membership link on an account can always be offered by text. */
    smsAvailable: linkTextable(current, booking),
    offers: {
      membership: {
        plans: Object.entries(subscriptions().PLAN_CATALOG).map(([key, plan]) => ({ key, label: PLAN_LABELS[key] || key, monthly: plan.monthly.price, annual: plan.annual.price, limit: planLimit(key) })),
        blocker: membershipBlocker,
      },
      oneTime: { enabled: Boolean(oneTime.enabled && oneTime.stripePriceId), priceCents: oneTime.priceCents },
    },
    account: user
      ? { mode: "booking", id: String(user._id), name: user.name || "", email: user.email || "", hasThisHome: Boolean(home) }
      : { mode: "guest", candidates },
    leadTime: {
      visitDate: ymd,
      earliestMemberDate: earliestMemberVisitYMD(),
      insideMemberLeadTime,
      exemptionEligible,
      overrideRequired: insideMemberLeadTime && !exemptionEligible,
    },
    current: presentConversion(current),
    earlier: conversions.filter((c) => c !== current).map(presentConversion),
  };
}

/* ------------------------------------------------------------------ */
/* Admin: make the link (nothing is sent)                               */
/* ------------------------------------------------------------------ */

async function expireStripeSession(sessionId) {
  if (!sessionId) return;
  const { stripe } = subscriptions();
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session?.status === "open") await stripe.checkout.sessions.expire(sessionId);
  } catch (error) {
    log("warn", "conversion_session_expire_failed", { sessionId, message: String(error?.message || error).slice(0, 160) });
  }
}

/** Withdraw an unpaid conversion: its Stripe page is closed and its link stops working. */
async function withdraw(conversion, { admin = null, event = "canceled", reason = "" } = {}) {
  const updated = await FreeVisitConversion.findOneAndUpdate(
    { _id: conversion._id, status: "open" },
    {
      $set: { status: event === "expired" ? "expired" : "canceled", "checkout.sessionId": "", "checkout.url": "" },
      $push: { history: historyEntry(event, admin, reason ? { reason } : null) },
    },
    { new: true }
  );
  if (!updated) return null;
  await expireStripeSession(conversion.checkout?.sessionId);
  if (conversion.link) await AdminPaymentLink.updateOne({ _id: conversion.link, status: "open" }, { $set: { status: event === "expired" ? "expired" : "canceled" } });
  return updated;
}

/**
 * Before a live conversion is replaced or withdrawn by a person: ask Stripe,
 * not our own record, whether any of its pages was paid. A payment whose
 * webhook has not arrived yet leaves the record "open"; replacing it then
 * would put a second payable page in front of somebody who already paid.
 * Stripe unreachable: refuse too, never replace blind.
 */
async function assertNoPaidPage(conversion, { message = "We've received a payment for this visit and are updating it now." } = {}) {
  const ids = [...new Set([...(conversion?.sessionIds || []), conversion?.checkout?.sessionId].filter(Boolean))].slice(-5);
  if (!ids.length) return;
  const { stripe } = subscriptions();
  for (const id of ids) {
    let session;
    try {
      session = await stripe.checkout.sessions.retrieve(id);
    } catch (error) {
      log("warn", "conversion_paid_page_check_failed", { conversionId: String(conversion._id), sessionId: id, message: String(error?.message || error).slice(0, 160) });
      throw new ConversionError("CHECKOUT_CHECK_FAILED", "We couldn't check this payment with Stripe just now. Please try again in a minute.", 503);
    }
    if (session?.status === "complete") {
      log("warn", "conversion_paid_page_unrecorded", { conversionId: String(conversion._id), sessionId: id });
      throw new ConversionError("CONVERSION_IN_PROGRESS", message, 409);
    }
  }
}

/**
 * Make a conversion and its payment link. Nothing is sent: the link is
 * returned for Admin to copy, and sendConversionLink sends it on request.
 *
 * @param {object} args
 * @param {string} args.bookingId
 * @param {"membership"|"one_time"} args.kind
 * @param {string} [args.plan]           membership: basic | plus | premium | elite
 * @param {string} [args.billingCycle]   membership: monthly | annual
 * @param {string} [args.task]           what the paid visit is for (defaults to the visit's own task)
 * @param {object} [args.account]        membership on a guest visit: { mode: "link", userId } | { mode: "create", ... }
 * @param {string} [args.overrideLeadTimeReason]  membership inside the seven days without the first-visit exception
 * @returns {{ conversion, token, payUrl }}
 */
async function createConversion({ bookingId, kind, plan = "", billingCycle = "", task = "", account = {}, overrideLeadTimeReason = "", admin = null, canManageAccounts = false, canCreateAccounts = false, req = null, deps = {} }) {
  canManageAccounts = canManageAccounts || canCreateAccounts;
  if (!["membership", "one_time"].includes(kind)) throw new ConversionError("KIND_REQUIRED", "Choose Membership or One-Time Visit.", 400);
  const booking = await loadBooking(bookingId);
  assertConvertible(booking);

  const block = await findActiveBlock({ userId: booking.user || null, email: booking.email, phone: booking.phone });
  if (block) throw new ConversionError("CUSTOMER_BLOCKED", "This customer is blocked. Unblock them on their profile first.", 409);

  /* One live conversion per visit: an unpaid one is replaced; a paid one must be settled first. */
  const live = await FreeVisitConversion.findOne({ booking: booking._id, status: { $in: LIVE_STATUSES } });
  if (live && live.status !== "open") {
    throw new ConversionError("CONVERSION_IN_PROGRESS", "A payment for this visit has already been received. Settle it before making another link.", 409);
  }
  /* "Open" in our record is not proof: its page may be paid with the webhook still on its way. */
  if (live) await assertNoPaidPage(live, { message: "Stripe shows this visit's payment page was paid. The payment is being recorded; refresh in a minute instead of making another link." });

  const now = new Date();
  const linkExpiresAt = new Date(Math.min(now.getTime() + LINK_MAX_MS, new Date(booking.date).getTime() - LINK_CLOSES_BEFORE_VISIT_MS));
  if (linkExpiresAt.getTime() - now.getTime() < CHECKOUT_MIN_MS) {
    throw new ConversionError("VISIT_TOO_SOON", "This visit starts too soon for a payment link (it must be paid at least 90 minutes before the visit).", 409);
  }

  const cleanTask = String(task || "").trim().slice(0, 120) || (/^free\s*(first\s*)?visit/i.test(String(booking.selectedTask || "")) ? "" : String(booking.selectedTask || "").trim()) || "Handyman visit";
  const doc = {
    booking: booking._id,
    bookingNumber: booking.bookingNumber || "",
    kind,
    task: cleanTask,
    contact: { name: booking.name || "", email: normalizeEmail(booking.email) || "", phone: normalizePhoneE164(booking.phone) || booking.phone || "" },
    snapshot: {
      date: booking.date,
      status: booking.status,
      slotReservationId: booking.slotReservationId || null,
      assignedFixterId: booking.assignedFixterId || null,
      freeVisitChannel: booking.freeVisitChannel || (booking.guestRequestId ? "callback" : ""),
      addressKey: bookingAddressKey(booking),
      user: booking.user || null,
    },
    linkExpiresAt,
    createdBy: admin?._id || null,
    createdByName: actorOf(admin).byName,
  };
  const history = [];

  if (kind === "one_time") {
    const { getOneTimeVisitSettings } = require("../oneTimeVisitSettings");
    const settings = await getOneTimeVisitSettings();
    if (!settings.enabled || !settings.stripePriceId) throw new ConversionError("ONE_TIME_DISABLED", "One-Time Visits are switched off, or have no Stripe price.", 503);
    doc.priceCents = settings.priceCents;
    if (booking.user) {
      doc.user = booking.user;
      doc.addressId = booking.addressId || null;
      doc.accountSource = "booking";
    }
  } else {
    const planKey = String(plan || "").toLowerCase();
    if (!subscriptions().PLAN_CATALOG[planKey]) throw new ConversionError("PLAN_REQUIRED", "Choose a plan.", 400);
    const cycle = subscriptions().normalizeBillingCycle(billingCycle, "monthly");
    doc.plan = planKey;
    doc.billingCycle = cycle;

    /* Every refusal first; the account and its home are written only once all of them pass. */
    const { user, source } = await chooseAccount({ booking, account, canManageAccounts });
    let home = null;
    let newHome = null;
    let decision;
    if (source === "created") {
      if (!normalizePhoneE164(booking.phone)) throw new ConversionError("PHONE_REQUIRED", "Add the customer's phone on the visit first: a new account needs it.", 400);
      await assertAccountCreatable({ booking, account });
      /* A brand-new account has no membership: the first-visit exception applies inside the seven days. */
      decision = { rule: isBeforeEarliestMemberVisit(bookingYMD(booking.date)) ? "first_visit_exemption" : "none", earliestMemberDate: earliestMemberVisitYMD() };
    } else {
      const { missingBookingContact } = require("../bookingContact");
      const missing = missingBookingContact(user);
      if (missing.length) {
        throw new ConversionError("ACCOUNT_CONTACT_REQUIRED", `The customer's account is missing their ${missing.join(" and ")}. Add it on their profile first.`, 400);
      }
      const ublock = await findActiveBlock({ userId: user._id, email: user.email, phone: user.phone });
      if (ublock) throw new ConversionError("CUSTOMER_BLOCKED", "This customer is blocked. Unblock them on their profile first.", 409);
      home = findHome(user, booking);
      if (!home) {
        if (!canManageAccounts) throw new ConversionError("FORBIDDEN_ACCOUNT_LINK", "Adding this address to the customer's account needs the Customers section.", 403);
        newHome = prepareHome(user, booking);
      } else {
        const blocker = await membershipCheckout().membershipSaleBlocker({ user, addressId: home._id });
        if (blocker) throw new ConversionError(blocker.body?.code || "MEMBERSHIP_NOT_AVAILABLE", blocker.body?.message || "This home cannot be sold a membership right now.", blocker.status || 409);
        const others = await otherActiveVisits({ userId: user._id, addressId: home._id, bookingId: booking._id });
        if (others >= planLimit(planKey)) {
          throw new ConversionError(
            "MEMBERSHIP_LIMIT_REACHED",
            planLimit(planKey) === 1
              ? "This home already has another visit booked, and Basic allows one at a time. Choose a larger plan, or finish that visit first."
              : `This home already has ${others} other visits booked (${PLAN_LABELS[planKey]} allows ${planLimit(planKey)} at a time).`,
            409
          );
        }
      }
      decision = await leadTimeDecision({ booking, userId: user._id, overrideReason: overrideLeadTimeReason, admin });
    }
    doc.leadTime = { rule: decision.rule, earliestMemberDate: decision.earliestMemberDate, ...(decision.override ? { override: decision.override } : {}) };
    if (decision.rule === "admin_override") history.push(historyEntry("lead_time_overridden", admin, { reason: decision.override.reason, earliestMemberDate: decision.earliestMemberDate }));

    /* All checks passed: now the writes. */
    let payer = user;
    if (source === "created") {
      payer = await createAccountFromVisit({ booking, account, admin, req, deps });
      home = findHome(payer, booking);
      if (!home) home = await addHome(payer, prepareHome(payer, booking));
      history.push(historyEntry("account_created", admin, { userId: String(payer._id) }));
    } else if (newHome) {
      home = await addHome(user, newHome);
      history.push(historyEntry("home_added_to_account", admin, { addressId: String(home._id) }));
    }
    if (source === "linked") history.push(historyEntry("account_linked", admin, { userId: String(user._id), confirmedDifferentEmail: account.confirmDifferentEmail === true }));
    doc.user = payer._id;
    doc.addressId = home._id;
    doc.accountSource = source;
  }

  if (live) await withdraw(live, { admin, event: "replaced" });

  doc.history = [historyEntry("link_created", admin, { kind, plan: doc.plan, billingCycle: doc.billingCycle, task: doc.task }), ...history];
  let conversion;
  try {
    conversion = await FreeVisitConversion.create(doc);
  } catch (error) {
    if (error?.code === 11000) throw new ConversionError("CONVERSION_IN_PROGRESS", "Another link for this visit was just made. Refresh and try again.", 409);
    throw error;
  }

  const { link, token, payUrl } = await paymentLinks().createLink({
    kind: "visit_conversion",
    contact: { name: booking.name, email: doc.contact.email, phone: doc.contact.phone, user: doc.user ? { _id: doc.user } : null, booking },
    itemLabel: kind === "one_time" ? "your One-Time Visit" : `your ${offerLabel(doc)}`,
    channels: [],
    expiresAt: linkExpiresAt,
    plan: doc.plan,
    billingCycle: doc.billingCycle,
    addressId: doc.addressId || null,
    admin,
  });
  await AdminPaymentLink.updateOne({ _id: link._id }, { $set: { conversion: conversion._id } });
  conversion.link = link._id;
  await conversion.save();
  log("info", "conversion_link_created", { conversionId: String(conversion._id), bookingId: String(booking._id), kind });
  return { conversion, token, payUrl };
}

/*
 * Can the link be texted? A guest from the homepage form agreed to texts
 * about their visit only (utils/sms/smsEligibility GUEST_VISIT_TYPES), which
 * does not cover a payment link, so it is refused here rather than claimed
 * and then silently not sent. An account (its own consent decides) or a
 * guest Admin booked by phone (ADMIN_GUEST_VISIT_TYPES) can be texted.
 */
const SMS_NOT_AVAILABLE = "This guest agreed to texts about their visit only, which does not cover a payment link. Send it by email, or copy the link into a message they asked for.";
function linkTextable(conversion, booking) {
  return Boolean(conversion?.user || booking?.user || booking?.adminGuest);
}

/* ------------------------------------------------------------------ */
/* Admin: send, withdraw, retry, close                                  */
/* ------------------------------------------------------------------ */

async function loadConversion(conversionId, bookingId = null) {
  if (!mongoose.isValidObjectId(conversionId)) throw new ConversionError("INVALID_CONVERSION", "Invalid conversion id", 400);
  const conversion = await FreeVisitConversion.findById(conversionId);
  if (!conversion || (bookingId && String(conversion.booking) !== String(bookingId))) throw new ConversionError("CONVERSION_NOT_FOUND", "This payment link was not found.", 404);
  return conversion;
}

/**
 * Send the link, on Admin's explicit request, by email and/or text. Each
 * channel at most once per link. `token` is the link Admin was shown when it
 * was made (only its hash is stored); a link whose token is gone is replaced
 * by making a new one.
 */
async function sendConversionLink({ conversionId, bookingId = null, token, channels = [], admin = null, deps = {} }) {
  const conversion = await loadConversion(conversionId, bookingId);
  if (conversion.status !== "open") throw new ConversionError("NOT_OPEN", "This link is no longer open.", 409);
  const link = await AdminPaymentLink.findById(conversion.link);
  const { hashToken, linkIsLive, payUrlFor, sendLink } = paymentLinks();
  if (!link || !linkIsLive(link)) throw new ConversionError("LINK_EXPIRED", "This link has expired. Make a new one.", 409);
  if (!token || hashToken(token) !== link.tokenHash) throw new ConversionError("LINK_TOKEN_MISMATCH", "This is not the link for this visit. Make a new link to send it.", 400);
  const wanted = [...new Set((Array.isArray(channels) ? channels : []).filter((c) => c === "email" || c === "sms"))];
  if (!wanted.length) throw new ConversionError("CHANNEL_REQUIRED", "Choose email, text, or both.", 400);
  const already = new Set((conversion.sends || []).map((s) => s.channel));
  const fresh = wanted.filter((c) => !already.has(c));
  if (!fresh.length) throw new ConversionError("ALREADY_SENT", "This link was already sent that way. To send it again, make a new link.", 409);
  const contact = conversion.contact;
  if (fresh.includes("email") && !contact.email) throw new ConversionError("NO_EMAIL", "This visit has no email address.", 400);
  if (fresh.includes("sms") && !contact.phone) throw new ConversionError("NO_PHONE", "This visit has no phone number.", 400);
  if (fresh.includes("sms") && !linkTextable(conversion, await Booking.findById(conversion.booking).select("user adminGuest").lean())) {
    throw new ConversionError("SMS_NOT_AVAILABLE", SMS_NOT_AVAILABLE, 409);
  }

  /* Claim the channels first, so two presses cannot both send. */
  const claimAt = new Date();
  const claimed = await FreeVisitConversion.findOneAndUpdate(
    { _id: conversion._id, status: "open", "sends.channel": { $nin: fresh } },
    { $push: { sends: { $each: fresh.map((channel) => ({ channel, to: channel === "email" ? contact.email : contact.phone, result: "sending", at: claimAt, ...actorOf(admin) })) } } },
    { new: true }
  );
  if (!claimed) throw new ConversionError("ALREADY_SENT", "This link is being sent, or was already sent that way.", 409);

  link.sentVia = fresh;
  link.sentTo = { email: fresh.includes("email") ? contact.email : "", phone: fresh.includes("sms") ? contact.phone : "" };
  const booking = await Booking.findById(conversion.booking).lean();
  const delivery = await sendLink({
    link,
    payUrl: payUrlFor(token),
    contact: { name: contact.name, email: contact.email, phone: contact.phone, user: conversion.user ? await User.findById(conversion.user) : null, booking },
    deps: deps.paymentLinks || {},
  });
  const results = { email: delivery.email, sms: delivery.sms };
  await FreeVisitConversion.updateOne(
    { _id: conversion._id },
    {
      $set: Object.fromEntries(
        (claimed.sends || []).map((s, i) => [s, i]).filter(([s]) => fresh.includes(s.channel) && s.result === "sending").map(([s, i]) => [`sends.${i}.result`, results[s.channel] || "unknown"])
      ),
      $push: { history: historyEntry("link_sent", admin, { channels: fresh, delivery: results }) },
    }
  );
  return { conversion: await FreeVisitConversion.findById(conversion._id), delivery: results };
}

async function cancelConversion({ conversionId, bookingId = null, admin = null, reason = "" }) {
  const conversion = await loadConversion(conversionId, bookingId);
  if (conversion.status !== "open") throw new ConversionError("NOT_OPEN", conversion.status === "paid" || conversion.status === "converting" ? "This link has been paid; it can no longer be withdrawn." : "This link is no longer open.", 409);
  await assertNoPaidPage(conversion, { message: "Stripe shows this link was paid. The payment is being recorded; it can no longer be withdrawn. Refresh in a minute." });
  const updated = await withdraw(conversion, { admin, event: "canceled", reason: String(reason || "").slice(0, 300) });
  if (!updated) throw new ConversionError("NOT_OPEN", "This link changed while you were withdrawing it. Refresh.", 409);
  return updated;
}

/**
 * A paid conversion that needs attention, tried again by Admin (after fixing
 * what stopped it). A seven-day refusal can be overridden here, explicitly,
 * with a reason that is recorded.
 */
async function retryConversion({ conversionId, bookingId = null, admin = null, overrideLeadTimeReason = "", acceptCurrentVisit = false }) {
  const conversion = await loadConversion(conversionId, bookingId);
  if (conversion.status !== "needs_attention") throw new ConversionError("NOT_NEEDS_ATTENTION", "Only a payment that needs attention can be retried.", 409);
  const set = { status: "paid", attempts: 0 };
  const push = [historyEntry("retry_requested", admin, overrideLeadTimeReason ? { overrideLeadTimeReason } : null)];
  /*
   * The visit was moved (or its address edited) while the customer paid:
   * Admin may convert it as it is now. Explicit and recorded, never assumed,
   * and only for a visit that is otherwise still convertible and still on no
   * account or this one.
   */
  if (acceptCurrentVisit === true) {
    const booking = await Booking.findById(conversion.booking);
    const problem = convertProblem(booking);
    if (problem) throw new ConversionError(problem.code, problem.message, problem.status || 409);
    if (booking.user && conversion.user && String(booking.user) !== String(conversion.user)) {
      throw new ConversionError("ACCOUNT_CHANGED", "This visit is now on a different customer account. Settle the payment by hand.", 409);
    }
    set["snapshot.date"] = booking.date;
    set["snapshot.addressKey"] = bookingAddressKey(booking);
    set["snapshot.status"] = booking.status;
    set["snapshot.user"] = booking.user || null;
    push.push(historyEntry("visit_accepted_as_is", admin, { from: { date: conversion.snapshot?.date }, to: { date: booking.date, status: booking.status } }));
  }
  const reason = String(overrideLeadTimeReason || "").trim().slice(0, 300);
  if (reason && conversion.kind === "membership") {
    set["leadTime.rule"] = "admin_override";
    set["leadTime.override"] = { ...actorOf(admin), at: new Date(), reason };
    push.push(historyEntry("lead_time_overridden", admin, { reason, earliestMemberDate: earliestMemberVisitYMD() }));
  }
  const claimed = await FreeVisitConversion.findOneAndUpdate({ _id: conversion._id, status: "needs_attention" }, { $set: set, $push: { history: { $each: push } } }, { new: true });
  if (!claimed) throw new ConversionError("NOT_NEEDS_ATTENTION", "This changed while you were retrying it. Refresh.", 409);
  return runConversion(conversion._id);
}

/**
 * A paid conversion that needs attention, settled by hand. Admin says what
 * was done with the money (utils/freeVisit/paymentResolution.js) and it is
 * checked with Stripe: a refund must show there; for a membership, refunding
 * the first payment does not stop the subscription, so "canceled" needs a
 * subscription that will not bill again. `reason` is the note.
 */
async function closeConversion({ conversionId, bookingId = null, admin = null, reason = "", resolution = "", firstPaymentRefunded = null }) {
  const conversion = await loadConversion(conversionId, bookingId);
  if (conversion.status !== "needs_attention") throw new ConversionError("NOT_NEEDS_ATTENTION", "Only a payment that needs attention can be closed.", 409);
  const { conversion: closed } = await require("./paymentResolution").resolvePayment({ conversionId, bookingId, admin, resolution, note: reason, firstPaymentRefunded });
  return closed;
}

/* ------------------------------------------------------------------ */
/* The customer: the payment page                                       */
/* ------------------------------------------------------------------ */

function publicStatus(conversion, link, now = new Date()) {
  /* A payment recorded on a link that cannot convert (withdrawn, or the visit was already converted): say it arrived. */
  if (conversion.payment?.extraSessionIds?.length && conversion.status !== "converted") return "paid_attention";
  switch (conversion.status) {
    case "open":
      return new Date(link?.expiresAt || conversion.linkExpiresAt).getTime() > now.getTime() ? "open" : "expired";
    case "paid":
    case "converting":
      return "processing";
    case "converted":
      return "converted";
    case "needs_attention":
    case "closed":
      return "paid_attention";
    case "canceled":
      return "canceled";
    default:
      return "expired";
  }
}

/** What /pay/<token> shows: only this visit's day, time, street and the offer. */
async function describeConversionLink(link) {
  const conversion = link.conversion ? await FreeVisitConversion.findById(link.conversion) : null;
  if (!conversion) return { status: "not_found", kind: link.kind };
  const booking = await Booking.findById(conversion.booking).lean();
  let status = publicStatus(conversion, link);
  if (status === "open" && (!booking || convertProblem(booking, new Date(), { email: conversion.contact?.email }) || !matchesSnapshot(booking, conversion))) status = "unavailable";
  const base = { status, kind: link.kind, itemLabel: link.itemLabel, expiresAt: link.expiresAt };
  if (!booking || status === "not_found") return base;
  return {
    ...base,
    conversion: {
      kind: conversion.kind,
      offerLabel: offerLabel(conversion),
      priceCents: priceCentsFor(conversion),
      billingCycle: conversion.kind === "membership" ? conversion.billingCycle : "",
      firstName: firstNameOf(booking.name),
      whenLabel: whenLabel(booking.date),
      street: [booking.address, booking.city].filter(Boolean).join(", "),
      task: conversion.task,
      ...(status === "open" ? { terms: { version: TERMS_VERSION, text: termsText(conversion, booking) } } : {}),
      convertedStatus: status === "converted" ? convertedStatus(conversion.snapshot?.status) : "",
    },
  };
}

/**
 * The customer pressed Pay on an Admin link, having ticked the terms.
 * Re-checks everything, then reuses the Stripe page already open for this
 * link or opens a new one. Returns { url }.
 */
async function openConversionCheckout({ link, token, acceptTerms, termsVersion, req = null, now = new Date() }) {
  const conversion = link.conversion ? await FreeVisitConversion.findById(link.conversion) : null;
  if (!conversion) throw new ConversionError("NOT_FOUND", "This payment link isn't valid.", 404);
  if (publicStatus(conversion, link, now) !== "open") throw new ConversionError("NOT_OPEN", "This payment link is no longer open. Please call us at " + BUSINESS_PHONE + ".", 410);
  if (acceptTerms !== true || termsVersion !== TERMS_VERSION) throw new ConversionError("TERMS_REQUIRED", "Please read and accept the terms to continue.", 400);

  /* Blocked since the link was made (a copied link has no "sent to" for the route's own check). */
  const block = await findActiveBlock({ userId: conversion.user || null, email: conversion.contact.email, phone: conversion.contact.phone });
  if (block) throw new ConversionError("CUSTOMER_BLOCKED", `This payment can't be opened. Please call us at ${BUSINESS_PHONE}.`, 403);

  const booking = await Booking.findById(conversion.booking);
  const problem = convertProblem(booking, now, { email: conversion.contact?.email });
  if (problem || !matchesSnapshot(booking, conversion)) {
    log("info", "conversion_checkout_refused_visit_changed", { conversionId: String(conversion._id), code: problem?.code || "SNAPSHOT_CHANGED" });
    throw new ConversionError("VISIT_CHANGED", `Your visit has changed since this link was sent, so it can't be paid here. Please call us at ${BUSINESS_PHONE}.`, 409);
  }
  return openCheckout(conversion, {
    booking,
    now,
    req,
    closesAt: link.expiresAt,
    successUrl: `${CLIENT_URL}/pay/${token}?paid=1`,
    cancelUrl: `${CLIENT_URL}/pay/${token}`,
    metadata: { adminInitiated: "link", adminPaymentLinkId: String(link._id) },
    linkId: link._id,
  });
}

/*
 * The Stripe page for a conversion its entry point (an Admin link, or the
 * customer's own visit card) has already checked: the visit's membership
 * rules once more, then the open page reused or a new one opened.
 *
 * welcomeOffer: { couponId, lifetimeSeconds, required } - the 20% first
 * payment, found eligible by utils/welcomeOffer.js; customer-started
 * memberships only. termsVariant: the price wording the customer accepted.
 */
async function openCheckout(conversion, { booking, now = new Date(), req = null, closesAt, successUrl, cancelUrl, metadata: extra = {}, linkId = null, welcomeOffer = null, tracking = null, termsVariant = "regular" }) {
  /*
   * The visit's own rules, again: something may have changed since the link
   * was made. The seven-day rule above all - a link lives up to a week, so a
   * visit 8 days out when the link was made can be 5 days out when it is
   * paid. Decided here, before Stripe, never after the payment: nobody pays
   * for a conversion the rule would then refuse.
   */
  let firstVisitExempt = false;
  let memberDeadline = null;
  if (conversion.kind === "membership") {
    const user = await User.findById(conversion.user);
    if (!user || !user.addresses.id(conversion.addressId)) throw new ConversionError("ACCOUNT_CHANGED", `This payment can't be opened right now. Please call us at ${BUSINESS_PHONE}.`, 409);
    const inside = isBeforeEarliestMemberVisit(bookingYMD(booking.date));
    const rule = conversion.leadTime?.rule || "none";
    /*
     * The exception is carried whenever this buyer qualifies for it, as the
     * customer's own membership checkout does: the Stripe page lives up to a
     * day, so a visit outside the seven days now can be inside them when the
     * page is paid, after midnight.
     */
    firstVisitExempt = await firstVisit().firstVisitExemptionEligible(user._id);
    if (!firstVisitExempt && rule !== "admin_override" && !inside) {
      /* No exception to fall back on: the page must close before the visit enters the seven days. */
      /* A visit on day V is inside the rule from the start of day V - leadDays + 1 (New York). */
      const leadDays = moment.tz(earliestMemberVisitYMD(now), TZ).diff(moment(now).tz(TZ).startOf("day"), "days");
      memberDeadline = moment.tz(bookingYMD(booking.date), TZ).startOf("day").subtract(leadDays - 1, "days").toDate();
    }
    if (inside && rule !== "admin_override") {
      if (!firstVisitExempt) {
        await FreeVisitConversion.updateOne({ _id: conversion._id }, { $push: { history: historyEntry("checkout_refused", null, { reason: "lead_time", earliestMemberDate: earliestMemberVisitYMD() }) } });
        throw new ConversionError("LEAD_TIME_CHANGED", `This payment can't be opened right now. Please call us at ${BUSINESS_PHONE} and we'll sort it out.`, 409);
      }
      if (rule !== "first_visit_exemption") {
        await FreeVisitConversion.updateOne(
          { _id: conversion._id },
          { $set: { "leadTime.rule": "first_visit_exemption" }, $push: { history: historyEntry("lead_time_rule_changed", null, { from: rule, to: "first_visit_exemption" }) } }
        );
        conversion.leadTime.rule = "first_visit_exemption";
      }
    }
    const others = await otherActiveVisits({ userId: user._id, addressId: conversion.addressId, bookingId: booking._id });
    if (others >= planLimit(conversion.plan)) throw new ConversionError("MEMBERSHIP_LIMIT_REACHED", `This payment can't be opened right now. Please call us at ${BUSINESS_PHONE}.`, 409);
  }

  /*
   * A second press while the first page is still open: the same page - unless
   * it was opened at another price (the welcome offer has since opened or
   * ended), when a new page at the price now on screen replaces it.
   */
  const { stripe } = subscriptions();
  const samePrice = () => Boolean(conversion.welcomeOfferApplied) === Boolean(welcomeOffer);
  if (conversion.checkout?.sessionId) {
    try {
      const existing = await stripe.checkout.sessions.retrieve(conversion.checkout.sessionId);
      if (existing?.status === "open" && existing.url && samePrice()) {
        await recordTerms(conversion, { booking, req, reused: true, variant: termsVariant });
        return { url: existing.url, reused: true, welcomeOfferApplied: Boolean(conversion.welcomeOfferApplied) };
      }
      if (existing?.status === "complete") throw new ConversionError("ALREADY_PAID", "This has already been paid. Thank you!", 410);
    } catch (error) {
      if (error instanceof ConversionError) throw error;
      log("warn", "conversion_session_lookup_failed", { conversionId: String(conversion._id), message: String(error?.message || error).slice(0, 160) });
      throw new ConversionError("CHECKOUT_CHECK_FAILED", "We couldn't open the secure checkout just now. Please try again in a minute.", 503);
    }
  }

  /* One page being made at a time (two taps, two tabs). Short and self-expiring. */
  const locked = await FreeVisitConversion.findOneAndUpdate(
    { _id: conversion._id, status: "open", $or: [{ "checkout.openingUntil": null }, { "checkout.openingUntil": { $lt: now } }] },
    { $set: { "checkout.openingUntil": new Date(now.getTime() + OPENING_LOCK_MS) } },
    { new: true }
  );
  if (!locked) throw new ConversionError("CHECKOUT_ALREADY_OPENING", "Your secure checkout is already opening. Please wait a moment.", 409);

  try {
    /*
     * Read again under the lock: another press may have opened a page between
     * the check above and taking the lock. Never a second payable page: if
     * Stripe cannot say whether the open one is still open, stop here.
     */
    if (locked.checkout?.sessionId) {
      let existing = null;
      try {
        existing = await stripe.checkout.sessions.retrieve(locked.checkout.sessionId);
      } catch (error) {
        log("warn", "conversion_session_recheck_failed", { conversionId: String(conversion._id), message: String(error?.message || error).slice(0, 160) });
        throw new ConversionError("CHECKOUT_CHECK_FAILED", "We couldn't open the secure checkout just now. Please try again in a minute.", 503);
      }
      if (existing?.status === "open" && existing.url && Boolean(locked.welcomeOfferApplied) === Boolean(welcomeOffer)) {
        await recordTerms(conversion, { booking, req, reused: true, variant: termsVariant });
        return { url: existing.url, reused: true, welcomeOfferApplied: Boolean(locked.welcomeOfferApplied) };
      }
      if (existing?.status === "complete") throw new ConversionError("ALREADY_PAID", "This has already been paid. Thank you!", 410);
    }
    let expiresAtMs = Math.min(now.getTime() + CHECKOUT_MAX_MS, new Date(closesAt).getTime());
    if (memberDeadline) expiresAtMs = Math.min(expiresAtMs, memberDeadline.getTime());
    if (expiresAtMs - now.getTime() < CHECKOUT_MIN_MS) throw new ConversionError("NOT_OPEN", `This payment link has expired. Please call us at ${BUSINESS_PHONE}.`, 410);
    const expiresAt = Math.floor(expiresAtMs / 1000);
    const metadata = {
      freeVisitConversionId: String(conversion._id),
      convertsBookingId: String(booking._id),
      ...extra,
    };
    /* Closing a page opened at another price (the welcome-priced one closes itself in openMembershipCheckout). */
    await expireStripeSession(locked.checkout?.sessionId);

    let session;
    let welcomeApplied = false;
    if (conversion.kind === "membership") {
      try {
        ({ session, welcomeOfferApplied: welcomeApplied } = await membershipCheckout().openMembershipCheckout({
          userId: conversion.user,
          plan: conversion.plan,
          billingCycle: conversion.billingCycle,
          addressId: String(conversion.addressId),
          successUrl,
          cancelUrl,
          metadata: { ...metadata, firstVisitExempt: firstVisitExempt ? "1" : "0" },
          expiresAt,
          welcomeOffer,
          tracking,
        }));
      } catch (error) {
        const { CheckoutRefusal } = membershipCheckout();
        if (error instanceof CheckoutRefusal) throw new ConversionError(error.body?.code || "CHECKOUT_REFUSED", error.body?.message || "This payment can't be opened right now.", error.status || 409);
        throw error;
      }
    } else {
      const { getOneTimeVisitSettings } = require("../oneTimeVisitSettings");
      const settings = await getOneTimeVisitSettings();
      if (!settings.enabled || !settings.stripePriceId) throw new ConversionError("ONE_TIME_DISABLED", `This payment can't be opened right now. Please call us at ${BUSINESS_PHONE}.`, 503);
      const user = conversion.user ? await User.findById(conversion.user) : null;
      const stripeCustomerId = user ? await subscriptions().resolveUserStripeCustomerId(user) : null;
      const md = {
        ...metadata,
        productKind: "free_visit_conversion",
        conversionKind: "one_time",
        /* The customer's own purchase is reported to Meta like any paid visit (routes/webhook.js); a staff sale never is. */
        ...(tracking ? { fbp: String(tracking.fbp || ""), fbc: String(tracking.fbc || ""), source_url: String(tracking.sourceUrl || "").slice(0, 400) } : {}),
      };
      session = await stripe.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        line_items: [{ price: settings.stripePriceId, quantity: 1 }],
        client_reference_id: `conversion_${conversion._id}`,
        metadata: md,
        payment_intent_data: { metadata: md },
        success_url: successUrl,
        cancel_url: cancelUrl,
        expires_at: expiresAt,
        ...(stripeCustomerId ? { customer: stripeCustomerId } : { customer_email: conversion.contact.email }),
      });
      if (!session?.url) throw new Error("Stripe checkout did not return a redirect URL");
    }

    /* A welcome-priced page closes sooner (31 minutes): record Stripe's own expiry. */
    const pageExpiresAt = session.expires_at ? new Date(Number(session.expires_at) * 1000) : new Date(expiresAt * 1000);
    await FreeVisitConversion.updateOne(
      { _id: conversion._id },
      {
        $set: {
          "checkout.sessionId": session.id,
          "checkout.url": session.url,
          "checkout.expiresAt": pageExpiresAt,
          "checkout.openingUntil": null,
          welcomeOfferApplied: Boolean(welcomeApplied),
        },
        $addToSet: { sessionIds: session.id },
        $push: { history: historyEntry("checkout_opened", null, { sessionId: session.id, ...(welcomeApplied ? { welcomeOffer: true } : {}) }) },
      }
    );
    conversion.welcomeOfferApplied = Boolean(welcomeApplied);
    if (linkId) await AdminPaymentLink.updateOne({ _id: linkId }, { $set: { lastSessionId: session.id, lastOpenedAt: new Date() }, $inc: { openedCount: 1 } });
    await recordTerms(conversion, { booking, req, variant: termsVariant });
    return { url: session.url, reused: false, welcomeOfferApplied: Boolean(welcomeApplied) };
  } finally {
    await FreeVisitConversion.updateOne({ _id: conversion._id }, { $set: { "checkout.openingUntil": null } }).catch(() => {});
  }
}

async function recordTerms(conversion, { booking, req, reused = false, variant = "regular" }) {
  const text = termsText(conversion, booking, { variant });
  const { clientIp } = require("../auth/clientIp");
  await FreeVisitConversion.updateOne(
    { _id: conversion._id },
    {
      $set: {
        terms: {
          acceptedAt: new Date(),
          version: TERMS_VERSION,
          text,
          variant,
          ipHash: req ? hashIp(clientIp(req)) : "",
          userAgent: String(req?.headers?.["user-agent"] || "").slice(0, 300),
        },
      },
      $push: { history: historyEntry("terms_accepted", null, { version: TERMS_VERSION, reused, ...(variant !== "regular" ? { variant } : {}) }) },
    }
  );
}

/* ------------------------------------------------------------------ */
/* The customer: "Upgrade to a handyman visit" on their own visit card  */
/* ------------------------------------------------------------------ */

/*
 * The same conversion, started by the customer, signed in, from the visit in
 * My Visits. Secure access is the account itself: a guest gets their visit
 * there by signing in with a code to the phone or email they booked with
 * (utils/freeVisit/guestLink.js links it, refusing anything ambiguous), so
 * nobody can upgrade a visit that is not provably theirs.
 *
 * Differences from an Admin link, on purpose:
 *  - no link and nothing sent: the customer goes straight to Stripe;
 *  - no seven-day override (Admin only): inside the seven days a membership
 *    needs the first-visit exception, otherwise One-Time keeps the time;
 *  - the account is the signed-in one; the visit's address is added to it as
 *    a home if it is not there yet (their own visit, their own account);
 *  - the 20% first-payment offer applies exactly as on the customer's own
 *    membership checkout (routes/stripe.js create-checkout-session), when the
 *    server finds them eligible. An Admin link never carries it.
 */
function customerProblem(problem) {
  if (!problem) return null;
  const messages = {
    ALREADY_CONVERTED: "This visit is already a paid visit.",
    VISIT_STARTED: "This visit has already started, so it can't be upgraded.",
    VISIT_CLOSED: "This visit is closed, so it can't be upgraded.",
    VISIT_TOO_SOON: `Your visit is less than two hours away, so it can't be upgraded online. Call us at ${BUSINESS_PHONE} and we'll help.`,
    OUT_OF_SERVICE_AREA: outOfServiceAreaMessage(),
    CONVERSION_IN_PROGRESS: "We've received a payment for this visit and are updating it now.",
  };
  return { code: problem.code, message: messages[problem.code] || `This visit can't be upgraded online. Call us at ${BUSINESS_PHONE} and we'll help.` };
}

async function loadCustomerBooking(bookingId, user) {
  const booking = await loadBooking(bookingId);
  /* Only the account the visit is on. Someone else's visit is "not found", never "not yours". */
  if (!user?._id || String(booking.user || "") !== String(user._id)) throw new ConversionError("BOOKING_NOT_FOUND", "This visit was not found.", 404);
  return booking;
}

function linkClosesAt(booking, now = new Date()) {
  return new Date(Math.min(now.getTime() + LINK_MAX_MS, new Date(booking.date).getTime() - LINK_CLOSES_BEFORE_VISIT_MS));
}

/* The conversion the customer's card speaks for: the live one, else the latest paid one. */
async function latestForCustomer(bookingId) {
  return FreeVisitConversion.findOne({
    booking: bookingId,
    $or: [{ status: { $in: [...LIVE_STATUSES, "converted", "closed"] } }, { "payment.extraSessionIds.0": { $exists: true } }],
  }).sort({ createdAt: -1 });
}

/** What the customer's card says about a conversion, in their terms. Nothing internal. */
function customerConversionView(conversion, booking) {
  if (!conversion) return null;
  let status = { open: "open", paid: "processing", converting: "processing", converted: "converted", needs_attention: "paid_attention", closed: "paid_attention" }[conversion.status] || "";
  if (conversion.payment?.extraSessionIds?.length && conversion.status !== "converted") status = "paid_attention";
  if (!status) return null;
  return {
    status,
    kind: conversion.kind,
    offerLabel: offerLabel(conversion),
    startedBy: conversion.source || "admin",
    checkoutOpen: Boolean(conversion.checkout?.sessionId),
    convertedStatus: status === "converted" ? String(booking?.status || "") : "",
  };
}

/**
 * After the customer comes back from Stripe (either button, or the back
 * arrow): what really happened, verified, never assumed from the return URL.
 *
 *   converted   the booking itself was converted (approvalPending: it waits for the owner)
 *   processing  paid - in our record, or Stripe says a page completed - and the
 *               visit is being updated; the webhook (Stripe retries it) or the
 *               sweep finishes it. Never offered a second payment.
 *   pending     Stripe has the order but the payment has not cleared
 *   attention   paid, but the visit could not be converted automatically
 *   settled     a paid conversion our team closed by hand
 *   unpaid      every page is still open or has expired: nothing was charged.
 *               openPage: a page is still open (Continue reuses it)
 *   unknown     Stripe could not be asked. Never treated as unpaid.
 *
 * Only the account the visit is on, like the sheet. It never fulfils: one
 * path does that (routes/webhook.js), so a status poll cannot convert twice.
 */
async function customerPaymentStatus({ bookingId, user, now = new Date() }) {
  const booking = await loadCustomerBooking(bookingId, user);
  const rows = await FreeVisitConversion.find({ booking: booking._id }).sort({ createdAt: -1 }).limit(8);
  const describe = (c) => (c ? { kind: c.kind, offerLabel: offerLabel(c), startedBy: c.source || "admin" } : {});
  const extraPayment = rows.some((r) => r.payment?.extraSessionIds?.length);
  const base = { bookingId: String(booking._id), checkedAt: now.toISOString(), extraPayment };

  if (isConverted(booking)) {
    const by = rows.find((r) => String(r._id) === String(booking.freeVisitConversion?.conversionId || "")) || rows.find((r) => r.status === "converted");
    return { ...base, state: "converted", ...describe(by), bookingStatus: String(booking.status || ""), approvalPending: /^\s*pending\s*$/i.test(String(booking.status || "")) };
  }
  const paid = rows.find((r) => ["paid", "converting"].includes(r.status));
  if (paid) return { ...base, state: "processing", ...describe(paid) };
  const attention = rows.find((r) => r.status === "needs_attention");
  if (attention) return { ...base, state: "attention", ...describe(attention) };

  /* Our record says unpaid. Stripe decides: a page may be paid with its webhook on the way. */
  const recent = rows.filter((r) => ["open", "expired", "canceled"].includes(r.status) && now.getTime() - new Date(r.createdAt).getTime() < LINK_MAX_MS + 24 * 60 * 60 * 1000);
  const pages = [];
  for (const r of recent) for (const id of [...(r.sessionIds || []), r.checkout?.sessionId].filter(Boolean)) if (!pages.some((p) => p.id === id)) pages.push({ id, conversion: r });
  const { stripe } = subscriptions();
  let openPage = null;
  let failed = false;
  for (const page of pages.slice(0, 8)) {
    let session;
    try {
      session = await stripe.checkout.sessions.retrieve(page.id);
    } catch (error) {
      failed = true;
      log("warn", "conversion_status_check_failed", { bookingId: String(booking._id), sessionId: page.id, message: String(error?.message || error).slice(0, 160) });
      continue;
    }
    if (session?.status === "complete") {
      const cleared = ["paid", "no_payment_required"].includes(String(session.payment_status || ""));
      return { ...base, state: cleared ? "processing" : "pending", ...describe(page.conversion), stripeConfirmed: true };
    }
    if (session?.status === "open" && !openPage && page.conversion.status === "open") openPage = page.conversion;
  }
  if (failed) return { ...base, state: "unknown" };
  const newest = rows[0];
  if (newest?.status === "closed" && newest.payment?.sessionId) return { ...base, state: "settled", ...describe(newest) };
  return { ...base, state: "unpaid", openPage: Boolean(openPage), ...describe(openPage || recent[0] || null) };
}

/**
 * The upgrade sheet: whether this visit can be upgraded, the offers and their
 * prices, what each would be agreed to, and any upgrade already under way.
 */
async function customerUpgradeOptions({ bookingId, user, now = new Date() }) {
  const booking = await loadCustomerBooking(bookingId, user);
  const latest = await latestForCustomer(booking._id);
  let problem = convertProblem(booking, now, { email: user.email });
  if (!problem && linkClosesAt(booking, now).getTime() - now.getTime() < CHECKOUT_MIN_MS) problem = { code: "VISIT_TOO_SOON" };
  if (!problem && latest && ["paid", "converting", "needs_attention"].includes(latest.status)) problem = { code: "CONVERSION_IN_PROGRESS" };
  if (!problem && (await findActiveBlock({ userId: user._id, email: user.email, phone: user.phone }))) problem = { code: "CUSTOMER_BLOCKED" };

  const { getOneTimeVisitSettings } = require("../oneTimeVisitSettings");
  const oneTime = await getOneTimeVisitSettings();
  const home = findHome(user, booking);
  const inside = isBeforeEarliestMemberVisit(bookingYMD(booking.date));
  const exemptionEligible = await firstVisit().firstVisitExemptionEligible(user._id);
  let blocker = null;
  if (inside && !exemptionEligible) {
    blocker = {
      code: "LEAD_TIME",
      message: "Membership visits are booked at least 7 days ahead, and your account has already used its one exception for a first visit. A One-Time Visit keeps this time.",
    };
  } else if (home) {
    try {
      const sale = await membershipCheckout().membershipSaleBlocker({ user, addressId: home._id });
      if (sale) blocker = { code: sale.body?.code || "MEMBERSHIP_NOT_AVAILABLE", message: sale.body?.message || "A membership can't be started for this home right now." };
    } catch (error) {
      blocker = { code: "CHECK_FAILED", message: "We couldn't check memberships for this home just now. Please try again." };
    }
  } else {
    const { MAX_ADDRESSES } = require("../customerProfileEdit");
    if ((user.addresses || []).length >= MAX_ADDRESSES) blocker = { code: "TOO_MANY_HOMES", message: `Your account already has ${MAX_ADDRESSES} homes. Remove one in My Account to add this address.` };
  }
  const others = home ? await otherActiveVisits({ userId: user._id, addressId: home._id, bookingId: booking._id }) : 0;

  const catalog = subscriptions().PLAN_CATALOG;
  const shape = (kind, plan = "", billingCycle = "") => ({ kind, plan, billingCycle, priceCents: kind === "one_time" ? oneTime.priceCents : null });
  const membershipTerms = {};
  for (const key of Object.keys(catalog)) {
    membershipTerms[key] = {};
    for (const cycle of ["monthly", "annual"]) {
      const c = shape("membership", key, cycle);
      membershipTerms[key][cycle] = { regular: termsText(c, booking), welcome: termsText(c, booking, { variant: "welcome" }) };
    }
  }
  return {
    booking: {
      id: String(booking._id),
      bookingNumber: booking.bookingNumber || "",
      status: booking.status,
      whenLabel: whenLabel(booking.date),
      address: addressLine(booking),
      line1: booking.address || "",
      zip: booking.zip || "",
      addressId: home ? String(home._id) : null,
      task: /^free\s*(first\s*)?visit/i.test(String(booking.selectedTask || "")) ? "" : String(booking.selectedTask || ""),
    },
    upgradable: !problem,
    problem: customerProblem(problem),
    termsVersion: TERMS_VERSION,
    offers: {
      membership: {
        plans: Object.entries(catalog).map(([key, plan]) => ({
          key,
          label: PLAN_LABELS[key] || key,
          monthly: plan.monthly.price,
          annual: plan.annual.price,
          limit: planLimit(key),
          available: others < planLimit(key),
        })),
        blocker,
        /* Inside the seven days, a brand-new membership's first visit keeps its time (the existing exception). */
        firstVisitException: inside && exemptionEligible,
      },
      oneTime: { enabled: Boolean(oneTime.enabled && oneTime.stripePriceId), priceCents: oneTime.priceCents },
    },
    terms: {
      one_time: termsText(shape("one_time"), booking),
      membership: membershipTerms,
    },
    current: customerConversionView(latest, booking),
  };
}

/**
 * The customer chose an offer and ticked its terms: every check, then their
 * own Stripe page. Returns { url, welcomeOfferApplied }.
 *
 * Nothing about the visit changes here. The only write before Stripe is the
 * visit's address added to the customer's own account as a home, when a
 * membership needs one and it is not there yet.
 */
async function startCustomerUpgrade({ bookingId, user, kind, plan = "", billingCycle = "", acceptTerms, termsVersion, expectsWelcome = false, tracking = null, req = null, now = new Date() }) {
  if (!["membership", "one_time"].includes(kind)) throw new ConversionError("KIND_REQUIRED", "Choose a membership or a One-Time Visit.", 400);
  if (acceptTerms !== true || termsVersion !== TERMS_VERSION) throw new ConversionError("TERMS_REQUIRED", "Please read and accept the terms to continue.", 400);
  const booking = await loadCustomerBooking(bookingId, user);

  const problem = convertProblem(booking, now, { email: user.email });
  if (problem) {
    const view = customerProblem(problem);
    throw new ConversionError(view.code, view.message, 409);
  }
  const { missingBookingContact, contactRequiredBody } = require("../bookingContact");
  const missing = missingBookingContact(user);
  if (missing.length) {
    const body = contactRequiredBody(missing);
    throw new ConversionError(body.code, body.message, 400, { missing });
  }
  if (await findActiveBlock({ userId: user._id, email: user.email, phone: user.phone })) {
    throw new ConversionError("CUSTOMER_BLOCKED", `This visit can't be upgraded online. Please call us at ${BUSINESS_PHONE}.`, 403);
  }
  const closesAt = linkClosesAt(booking, now);
  if (closesAt.getTime() - now.getTime() < CHECKOUT_MIN_MS) {
    const view = customerProblem({ code: "VISIT_TOO_SOON" });
    throw new ConversionError(view.code, view.message, 409);
  }

  const live = await FreeVisitConversion.findOne({ booking: booking._id, status: { $in: LIVE_STATUSES } });
  if (live && live.status !== "open") {
    throw new ConversionError("CONVERSION_IN_PROGRESS", "We've already received a payment for this visit and are updating it now.", 409);
  }
  if (live) await assertNoPaidPage(live);

  /* Every refusal before anything is written. */
  let planKey = "";
  let cycle = "";
  let home = null;
  let newHome = null;
  let decision = null;
  let priceCents = null;
  let welcomeOffer = null;
  if (kind === "one_time") {
    const { getOneTimeVisitSettings } = require("../oneTimeVisitSettings");
    const settings = await getOneTimeVisitSettings();
    if (!settings.enabled || !settings.stripePriceId) throw new ConversionError("ONE_TIME_DISABLED", `One-Time Visits aren't available online right now. Please call us at ${BUSINESS_PHONE}.`, 503);
    priceCents = settings.priceCents;
    home = findHome(user, booking);
  } else {
    planKey = String(plan || "").toLowerCase();
    if (!subscriptions().PLAN_CATALOG[planKey]) throw new ConversionError("PLAN_REQUIRED", "Choose a plan.", 400);
    cycle = subscriptions().normalizeBillingCycle(billingCycle, "monthly");
    home = findHome(user, booking);
    if (home) {
      const sale = await membershipCheckout().membershipSaleBlocker({ user, addressId: home._id });
      if (sale) throw new ConversionError(sale.body?.code || "MEMBERSHIP_NOT_AVAILABLE", sale.body?.message || "A membership can't be started for this home right now.", sale.status || 409);
      const others = await otherActiveVisits({ userId: user._id, addressId: home._id, bookingId: booking._id });
      if (others >= planLimit(planKey)) {
        throw new ConversionError(
          "MEMBERSHIP_LIMIT_REACHED",
          planLimit(planKey) === 1
            ? "This home already has another visit booked, and Basic allows one at a time. Choose a larger plan, or a One-Time Visit."
            : `This home already has ${others} other visits booked, the most ${PLAN_LABELS[planKey]} allows at a time.`,
          409
        );
      }
    } else {
      newHome = prepareHome(user, booking);
    }
    try {
      decision = await leadTimeDecision({ booking, userId: user._id });
    } catch (error) {
      if (error?.code !== "LEAD_TIME_OVERRIDE_REQUIRED") throw error;
      throw new ConversionError(
        "LEAD_TIME",
        "Membership visits are booked at least 7 days ahead, and your account has already used its one exception for a first visit. A One-Time Visit keeps this time.",
        409
      );
    }

    /* The 20% offer, decided exactly as the customer's own membership checkout decides it. */
    const welcome = require("../welcomeOffer");
    if (welcome.WELCOME_OFFER_CYCLES.includes(cycle)) {
      const status = await welcome.welcomeOfferStatus({ user, address: { line1: booking.address, zip: booking.zip } });
      if (status.eligible) {
        try {
          welcomeOffer = { couponId: await welcome.ensureWelcomeCoupon(), lifetimeSeconds: welcome.WELCOME_CHECKOUT_LIFETIME_S, required: expectsWelcome === true };
        } catch (error) {
          log("error", "conversion_welcome_coupon_unavailable", { message: String(error?.message || error).slice(0, 160) });
        }
      }
      if (expectsWelcome === true && !welcomeOffer) {
        throw new ConversionError(
          status.reason === "expired" ? "WELCOME_OFFER_ENDED" : "WELCOME_OFFER_UNAVAILABLE",
          status.reason === "expired"
            ? "The 20% offer has ended. The prices shown now are the regular prices."
            : "The 20% offer isn't available for this account. The prices shown now are the regular prices.",
          409
        );
      }
    }
  }

  /* The customer's own page for the same choice, still open: kept (one conversion, one page). */
  const reusable =
    live &&
    live.status === "open" &&
    live.source === "customer" &&
    live.kind === kind &&
    live.plan === planKey &&
    live.billingCycle === cycle &&
    String(live.user || "") === String(user._id) &&
    matchesSnapshot(booking, live) &&
    new Date(live.linkExpiresAt).getTime() - now.getTime() >= CHECKOUT_MIN_MS;

  let conversion = reusable ? live : null;
  if (!conversion) {
    if (newHome) home = await addHome(user, newHome);
    const actor = { _id: user._id, name: user.name || user.email || "Customer" };
    const history = [historyEntry("customer_started", actor, { kind, plan: planKey, billingCycle: cycle })];
    if (newHome) history.push(historyEntry("home_added_to_account", actor, { addressId: String(home._id), byCustomer: true }));
    if (live) await withdraw(live, { event: "replaced", reason: "The customer chose an upgrade from their account" });
    try {
      conversion = await FreeVisitConversion.create({
        booking: booking._id,
        bookingNumber: booking.bookingNumber || "",
        kind,
        plan: planKey,
        billingCycle: cycle,
        task: (/^free\s*(first\s*)?visit/i.test(String(booking.selectedTask || "")) ? "" : String(booking.selectedTask || "").trim()) || "Handyman visit",
        priceCents,
        user: user._id,
        addressId: home ? home._id : null,
        accountSource: "customer",
        source: "customer",
        /* The account's own details: the receipt and confirmation go to what the customer signed in with. */
        contact: { name: user.name || booking.name || "", email: normalizeEmail(user.email) || normalizeEmail(booking.email) || "", phone: normalizePhoneE164(user.phone) || user.phone || "" },
        snapshot: {
          date: booking.date,
          status: booking.status,
          slotReservationId: booking.slotReservationId || null,
          assignedFixterId: booking.assignedFixterId || null,
          freeVisitChannel: booking.freeVisitChannel || (booking.guestRequestId ? "callback" : ""),
          addressKey: bookingAddressKey(booking),
          user: booking.user || null,
        },
        ...(decision ? { leadTime: { rule: decision.rule, earliestMemberDate: decision.earliestMemberDate } } : {}),
        linkExpiresAt: closesAt,
        history,
        createdBy: user._id,
        createdByName: `${String(user.name || "Customer").slice(0, 100)} (customer)`,
      });
    } catch (error) {
      if (error?.code === 11000) throw new ConversionError("CHECKOUT_ALREADY_OPENING", "Your secure checkout is already opening. Please wait a moment.", 409);
      throw error;
    }
    log("info", "conversion_customer_started", { conversionId: String(conversion._id), bookingId: String(booking._id), kind });
  }

  return openCheckout(conversion, {
    booking,
    now,
    req,
    closesAt: conversion.linkExpiresAt,
    successUrl: `${CLIENT_URL}/book?upgraded=${booking._id}#your-visits`,
    cancelUrl: `${CLIENT_URL}/book?upgrade=${booking._id}#your-visits`,
    metadata: { initiatedBy: "customer" },
    welcomeOffer,
    tracking,
    termsVariant: welcomeOffer && expectsWelcome === true ? "welcome" : "regular",
  });
}

/* ------------------------------------------------------------------ */
/* Stripe: paid, expired                                                */
/* ------------------------------------------------------------------ */

function isConversionSession(session) {
  return Boolean(session?.metadata?.freeVisitConversionId && mongoose.isValidObjectId(session.metadata.freeVisitConversionId));
}

/**
 * checkout.session.completed for a conversion (membership: after the
 * subscription was synced by the normal webhook path; One-Time: instead of
 * any other handler). Records the payment once and converts. Safe to call any
 * number of times. `duplicateMembership`: the home was already covered and
 * this payment made a second subscription - never converted automatically.
 */
async function handleConversionPaid(session, { subscription = null, duplicateMembership = false } = {}) {
  if (!isConversionSession(session)) return null;
  if (!["paid", "no_payment_required"].includes(String(session.payment_status || "paid"))) {
    log("info", "conversion_session_not_paid", { sessionId: session.id, paymentStatus: session.payment_status });
    return null;
  }
  const conversion = await FreeVisitConversion.findById(session.metadata.freeVisitConversionId);
  if (!conversion) {
    log("error", "conversion_paid_unknown", { sessionId: session.id, conversionId: session.metadata.freeVisitConversionId });
    return null;
  }
  const payment = {
    "payment.sessionId": session.id,
    "payment.paidAt": new Date(),
    "payment.amountCents": session.amount_total ?? null,
    "payment.currency": String(session.currency || "usd"),
    "payment.paymentIntentId": session.payment_intent ? String(session.payment_intent) : "",
    "payment.stripeSubscriptionId": session.subscription ? String(session.subscription) : "",
    ...(subscription?._id ? { "payment.subscriptionId": subscription._id } : {}),
    "checkout.sessionId": "",
    "checkout.url": "",
  };
  /*
   * Late payments count too: a page paid in its last second, after the link
   * was withdrawn, replaced or expired. Only one conversion per visit may be
   * live, so a newer link for the same visit gives way if it is unpaid (it
   * cost nobody anything); if it is paid too, this is a second payment for
   * one visit and goes to the owner. Never an error Stripe would retry for
   * days, and never a payment left unrecorded.
   */
  /* The visit was already converted by another link of its own: this is a second payment for it. */
  const visit = await Booking.findById(conversion.booking).select("freeVisitConversion").lean();
  const convertedBy = visit?.freeVisitConversion?.conversionId;
  if (convertedBy && String(convertedBy) !== String(conversion._id)) {
    return recordSecondPayment(conversion, session, await FreeVisitConversion.findById(convertedBy));
  }
  const markPaid = () =>
    FreeVisitConversion.findOneAndUpdate(
      { _id: conversion._id, status: { $in: ["open", "expired", "canceled"] } },
      { $set: { status: "paid", ...payment }, $push: { history: historyEntry("paid", null, { sessionId: session.id, amountCents: session.amount_total ?? null }) } },
      { new: true }
    );
  let marked = null;
  for (let attempt = 0; attempt < 3 && !marked; attempt += 1) {
    if (["expired", "canceled"].includes((await FreeVisitConversion.findById(conversion._id).select("status").lean())?.status)) {
      const other = await FreeVisitConversion.findOne({ booking: conversion.booking, _id: { $ne: conversion._id }, status: { $in: LIVE_STATUSES } });
      if (other && other.status !== "open") return recordSecondPayment(conversion, session, other);
      if (other) await withdraw(other, { event: "replaced", reason: "An earlier link for this visit was paid" });
    }
    try {
      marked = await markPaid();
      if (!marked) break;
    } catch (error) {
      if (error?.code !== 11000) throw error;
      log("warn", "conversion_paid_live_conflict", { conversionId: String(conversion._id), sessionId: session.id, attempt });
    }
  }
  if (!marked) {
    const fresh = await FreeVisitConversion.findById(conversion._id);
    if (["expired", "canceled"].includes(fresh?.status)) {
      const other = await FreeVisitConversion.findOne({ booking: conversion.booking, _id: { $ne: conversion._id }, status: { $in: LIVE_STATUSES } });
      return recordSecondPayment(fresh, session, other);
    }
    Object.assign(conversion, { status: fresh?.status, payment: fresh?.payment });
    /* Already recorded. A second, different paid page for the same conversion is a double payment: flag it, never convert twice. */
    if (conversion.payment?.sessionId && conversion.payment.sessionId !== session.id) {
      return recordSecondPayment(conversion, session, null);
    }
    if (conversion.status === "paid" || conversion.status === "converting") return runConversion(conversion._id);
    return conversion;
  }
  if (marked.link) await AdminPaymentLink.updateOne({ _id: marked.link }, { $set: { status: "paid", paidAt: new Date(), lastSessionId: session.id } });
  if (duplicateMembership) {
    await claimConverting(marked._id);
    return needsAttention(marked._id, "duplicate_membership");
  }
  return runConversion(marked._id);
}

/** checkout.session.expired: the page closed unpaid. The visit is untouched; the link still works until it expires. */
async function handleConversionExpired(session) {
  if (!isConversionSession(session)) return null;
  return FreeVisitConversion.findOneAndUpdate(
    { _id: session.metadata.freeVisitConversionId, "checkout.sessionId": session.id, status: "open" },
    { $set: { "checkout.sessionId": "", "checkout.url": "" }, $push: { history: historyEntry("checkout_expired", null, { sessionId: session.id }) } },
    { new: true }
  );
}

/* ------------------------------------------------------------------ */
/* The conversion itself                                                */
/* ------------------------------------------------------------------ */

async function claimConverting(conversionId, now = new Date()) {
  return FreeVisitConversion.findOneAndUpdate(
    {
      _id: conversionId,
      $or: [{ status: "paid" }, { status: "converting", convertingAt: { $lt: new Date(now.getTime() - STALE_CONVERTING_MS) } }],
    },
    { $set: { status: "converting", convertingAt: now }, $inc: { attempts: 1 } },
    { new: true }
  );
}

const ATTENTION_REASONS = {
  visit_changed: "the visit was cancelled, completed, moved or edited while the customer was paying",
  reservation_lost: "the visit's reserved time is no longer held",
  lead_time: "the member seven-day rule refuses this time (the first-visit exception is not available)",
  membership_limit: "the home already has the most visits the plan allows",
  no_active_membership: "the membership was paid but did not become active",
  duplicate_membership: "the home already had a membership, so this payment started a second one",
  conversion_failed: "updating the visit failed repeatedly",
  visit_started: "the visit had already started when the conversion was tried",
  account_changed: "the visit was put on a different customer account while the customer was paying",
};

/**
 * Convert the booking from a paid conversion. Exactly once: the claim, then
 * a booking update that only matches the unconverted free visit at the
 * snapshot time. Returns the conversion as it stands afterwards.
 */
async function runConversion(conversionId, { now = new Date() } = {}) {
  const claimed = await claimConverting(conversionId, now);
  if (!claimed) return FreeVisitConversion.findById(conversionId);
  const conversion = claimed;
  let exemptionClaimedFor = null;
  try {
    const booking = await Booking.findById(conversion.booking);
    /* Converted already (a crash after the booking update, before the record was marked): finish the record. */
    if (booking?.freeVisitConversion?.conversionId && String(booking.freeVisitConversion.conversionId) === String(conversion._id)) {
      await afterConverted(conversion, booking);
      return finishConverted(conversion, booking);
    }
    /*
     * The whole rule again, not only the status: a visit that has started
     * (an Admin retry after the day, say) is not converted after the fact.
     */
    const problem = booking ? convertProblem(booking, now, { email: conversion.contact?.email }) : { code: "BOOKING_NOT_FOUND" };
    if (problem) return needsAttention(conversion._id, problem.code === "VISIT_STARTED" ? "visit_started" : "visit_changed");
    if (!matchesSnapshot(booking, conversion)) return needsAttention(conversion._id, "visit_changed");
    /* Linked to another account meanwhile (the owner's Confirm links a guest visit): never moved off it. */
    const allowedOwners = [conversion.snapshot?.user || null, conversion.user || null];
    if (!allowedOwners.some((u) => String(u || "") === String(booking.user || ""))) return needsAttention(conversion._id, "account_changed");
    if (reservations().reservationEngineEnabled()) {
      const reservation = await reservations().activeReservationForBooking(booking._id);
      if (!reservation) return needsAttention(conversion._id, "reservation_lost");
    }

    const set = {};
    let subscription = null;
    let leadTimeRule = conversion.leadTime?.rule || "";
    if (conversion.kind === "membership") {
      subscription =
        (conversion.payment?.subscriptionId && (await Subscription.findById(conversion.payment.subscriptionId))) ||
        (conversion.payment?.stripeSubscriptionId && (await Subscription.findOne({ stripeSubscriptionId: conversion.payment.stripeSubscriptionId }))) ||
        (await Subscription.findOne({ user: conversion.user, addressId: conversion.addressId, status: { $in: ["active", "trialing"] } }).sort({ updatedAt: -1 }));
      if (!subscription || !subscriptions().subscriptionGrantsAccess(subscription)) {
        /* The subscription sync may still be on its way: back to paid for the sweep, then Admin. */
        if (conversion.attempts >= MAX_ATTEMPTS) return needsAttention(conversion._id, "no_active_membership");
        return FreeVisitConversion.findOneAndUpdate({ _id: conversion._id, status: "converting" }, { $set: { status: "paid" } }, { new: true });
      }
      const capacity = await bookingRoutes().resolvePlanCapacity(subscription);
      const others = await otherActiveVisits({ userId: conversion.user, addressId: conversion.addressId, bookingId: booking._id });
      if (capacity.bookingLimit > 0 && others >= capacity.bookingLimit) return needsAttention(conversion._id, "membership_limit");

      const inside = isBeforeEarliestMemberVisit(bookingYMD(booking.date));
      if (inside && leadTimeRule !== "admin_override") {
        const fv = firstVisit();
        if (fv.firstVisitExemptionActive(subscription, now) && (await fv.claimFirstVisitExemption(subscription._id, now))) {
          exemptionClaimedFor = subscription._id;
          leadTimeRule = "first_visit_exemption";
        } else {
          return needsAttention(conversion._id, "lead_time");
        }
      } else if (!inside) {
        leadTimeRule = leadTimeRule === "admin_override" ? "admin_override" : "none";
      }
      const user = await User.findById(conversion.user).select("_id userId").lean();
      Object.assign(set, {
        accessType: "membership",
        bookingType: "membership_visit",
        subscription: subscription.subscriptionType,
        paymentState: "not_required",
        user: conversion.user,
        userId: user?.userId || "",
        addressId: conversion.addressId,
      });
    } else {
      Object.assign(set, {
        accessType: "one_time",
        bookingType: "one_time_handyman_visit",
        subscription: "One-Time Visit",
        paymentState: "paid",
        paymentStatus: "Paid",
      });
      if (conversion.user && !booking.user) set.user = conversion.user;
    }

    const status = convertedStatus(booking.status);
    const from = {
      accessType: booking.accessType || "",
      bookingType: booking.bookingType || "",
      subscription: booking.subscription || "",
      service: booking.service || "",
      selectedTask: booking.selectedTask || "",
      status: booking.status || "",
      paymentState: booking.paymentState || "",
      isFreeFirstVisit: Boolean(booking.isFreeFirstVisit),
      freeVisitChannel: booking.freeVisitChannel || (booking.guestRequestId ? "callback" : ""),
      freeVisitPurpose: booking.freeVisitPurpose || "",
    };
    Object.assign(set, {
      service: conversion.task || booking.service,
      selectedTask: conversion.task || booking.selectedTask || "",
      isFreeFirstVisit: false,
      freeVisitChannel: "",
      freeVisitPurpose: "",
      status,
      freeVisitConversion: {
        conversionId: conversion._id,
        kind: conversion.kind,
        convertedAt: now,
        plan: conversion.plan || "",
        billingCycle: conversion.billingCycle || "",
        leadTimeRule,
        stripeCheckoutSessionId: conversion.payment?.sessionId || "",
        from,
      },
    });
    const update = { $set: set };
    if (status !== booking.status) update.$push = { statusHistory: { status: booking.status, date: now } };

    const before = require("../bookingHistory").snapshot(booking);
    const converted = await Booking.findOneAndUpdate(
      {
        _id: booking._id,
        date: conversion.snapshot.date,
        status: booking.status,
        user: { $in: allowedOwners },
        $and: [{ $or: [{ freeVisitConversion: { $exists: false } }, { freeVisitConversion: null }] }],
      },
      update,
      { new: true }
    );
    if (!converted) {
      if (exemptionClaimedFor) await firstVisit().releaseFirstVisitExemption(exemptionClaimedFor).catch(() => null);
      exemptionClaimedFor = null;
      /* Someone changed it in the same instant: look again on the next attempt, then Admin. */
      if (conversion.attempts >= MAX_ATTEMPTS) return needsAttention(conversion._id, "visit_changed");
      return FreeVisitConversion.findOneAndUpdate({ _id: conversion._id, status: "converting" }, { $set: { status: "paid" } }, { new: true });
    }
    if (exemptionClaimedFor) {
      await FreeVisitConversion.updateOne({ _id: conversion._id }, { $set: { "payment.subscriptionId": exemptionClaimedFor } }).catch(() => null);
      conversion.payment.subscriptionId = exemptionClaimedFor;
    }
    exemptionClaimedFor = null;
    await afterConverted(conversion, converted);

    await require("../bookingHistory")
      .logBookingChanges({
        bookingId: converted._id,
        before,
        after: require("../bookingHistory").snapshot(converted),
        actor: { actorUserId: null, actorName: "System (Stripe payment)", actorEmail: "", actorRole: "system", actorPosition: "" },
      })
      .catch((error) => log("error", "conversion_history_failed", { message: String(error?.message || error).slice(0, 160) }));
    return finishConverted(conversion, converted);
  } catch (error) {
    if (exemptionClaimedFor) await firstVisit().releaseFirstVisitExemption(exemptionClaimedFor).catch(() => null);
    log("error", "conversion_failed", { conversionId: String(conversion._id), attempt: conversion.attempts, message: String(error?.message || error).slice(0, 200) });
    if (conversion.attempts >= MAX_ATTEMPTS) return needsAttention(conversion._id, "conversion_failed");
    return FreeVisitConversion.findOneAndUpdate({ _id: conversion._id, status: "converting" }, { $set: { status: "paid" } }, { new: true });
  }
}

/*
 * What follows a conversion, each step safe to repeat: run after the booking
 * update and again by the recovery of a conversion interrupted after it.
 */
async function afterConverted(conversion, booking) {
  const fail = (step) => (error) => log("error", "conversion_after_step_failed", { step, conversionId: String(conversion._id), message: String(error?.message || error).slice(0, 160) });
  /* The first-visit exception names the visit it was spent on (only if it was spent and is not yet attached). */
  if (booking.freeVisitConversion?.leadTimeRule === "first_visit_exemption") {
    const subId =
      conversion.payment?.subscriptionId ||
      (await Subscription.findOne({ user: conversion.user, addressId: conversion.addressId, status: { $in: ["active", "trialing"] } }).select("_id").lean())?._id;
    if (subId) {
      await Subscription.updateOne(
        { _id: subId, "firstVisitExemption.usedAt": { $ne: null }, "firstVisitExemption.bookingId": null },
        { $set: { "firstVisitExemption.bookingId": booking._id } }
      ).catch(fail("exemption"));
    }
  }
  /* One-Time with an account: the purchase record a One-Time Visit always has (unique per Stripe page). */
  if (conversion.kind === "one_time" && booking.user && booking.addressId && !booking.entitlementId) {
    await recordOneTimeEntitlement(conversion, booking).catch(fail("entitlement"));
  }
  if (booking.guestRequestId) {
    await require("./guestVisit").syncLeadFromBooking(booking.toObject ? booking.toObject() : booking).catch(fail("lead"));
  }
}

async function recordOneTimeEntitlement(conversion, booking) {
  const { ensureVisitEntitlementIndexesOnce } = require("../visitEntitlementIndexSafety");
  await ensureVisitEntitlementIndexesOnce();
  const user = await User.findById(booking.user).select("_id userId addresses").lean();
  const home = (user?.addresses || []).find((a) => String(a._id) === String(booking.addressId));
  if (!user) return null;
  try {
    const entitlement = await VisitEntitlement.create({
      user: user._id,
      userId: user.userId || String(user._id),
      addressId: booking.addressId,
      addressSnapshot: { line1: home?.line1 || booking.address || "", city: home?.city || booking.city || "", state: home?.state || booking.state || "", zip: home?.zip || booking.zip || "", county: home?.county || "" },
      bookingId: booking._id,
      status: "paid",
      priceCents: conversion.payment?.amountCents ?? conversion.priceCents ?? 0,
      currency: conversion.payment?.currency || "usd",
      stripeCheckoutSessionId: conversion.payment?.sessionId || null,
      stripePaymentIntentId: conversion.payment?.paymentIntentId || null,
      purchasedAt: conversion.payment?.paidAt || new Date(),
      source: "purchase",
    });
    await Booking.updateOne({ _id: booking._id }, { $set: { entitlementId: entitlement._id } });
    await FreeVisitConversion.updateOne({ _id: conversion._id }, { $set: { "payment.entitlementId": entitlement._id } });
    return entitlement;
  } catch (error) {
    if (error?.code === 11000) return VisitEntitlement.findOne({ stripeCheckoutSessionId: conversion.payment?.sessionId });
    throw error;
  }
}

async function finishConverted(conversion, booking) {
  const done = await FreeVisitConversion.findOneAndUpdate(
    { _id: conversion._id, status: "converting" },
    { $set: { status: "converted", convertedAt: booking.freeVisitConversion?.convertedAt || new Date() }, $push: { history: historyEntry("converted", null, { status: booking.status }) } },
    { new: true }
  );
  log("info", "conversion_converted", { conversionId: String(conversion._id), bookingId: String(booking._id), kind: conversion.kind });
  await sendConvertedNotices(done || conversion, booking);
  return done || FreeVisitConversion.findById(conversion._id);
}

async function needsAttention(conversionId, reason) {
  const fresh = await FreeVisitConversion.findOneAndUpdate(
    { _id: conversionId, status: "converting" },
    {
      $set: { status: "needs_attention", attention: { reason, message: ATTENTION_REASONS[reason] || reason, at: new Date() } },
      $push: { history: historyEntry("needs_attention", null, { reason }) },
    },
    { new: true }
  );
  if (!fresh) return FreeVisitConversion.findById(conversionId);
  log("info", "conversion_needs_attention", { conversionId: String(conversionId), reason });
  await sendAttentionNotices(fresh);
  return fresh;
}

/* ------------------------------------------------------------------ */
/* Notices: each once                                                   */
/* ------------------------------------------------------------------ */

async function claimNotice(conversionId, key) {
  const claimed = await FreeVisitConversion.findOneAndUpdate({ _id: conversionId, [`notices.${key}`]: null }, { $set: { [`notices.${key}`]: new Date() } }, { new: true });
  return Boolean(claimed);
}

function ownerEmail() {
  return process.env.MAIL_ADMIN || "getfixter@gmail.com";
}

async function activity(conversion, booking, action, details) {
  await AdminActivityLog.create({
    action,
    entityType: "Booking",
    entityId: String(conversion.booking),
    entityName: booking ? `${booking.name || ""} #${booking.bookingNumber || ""}` : String(conversion.bookingNumber || ""),
    actorName: "System (Stripe payment)",
    actorRole: "system",
    details: { conversionId: String(conversion._id), kind: conversion.kind, plan: conversion.plan, billingCycle: conversion.billingCycle, ...details },
  }).catch((error) => log("error", "conversion_activity_failed", { message: String(error?.message || error).slice(0, 160) }));
}

async function sendConvertedNotices(conversion, booking) {
  const e = mail.escapeHtml;
  const when = whenLabel(booking.date);
  const what = conversion.kind === "one_time" ? "a paid One-Time Visit" : `a ${PLAN_LABELS[conversion.plan] || conversion.plan} membership visit`;
  const confirmed = /^\s*confirmed\s*$/i.test(String(booking.status || ""));
  if (await claimNotice(conversion._id, "customerConvertedAt")) {
    const to = normalizeEmail(booking.email) || conversion.contact.email;
    if (to) {
      const lines = [
        `Thank you - your payment went through. Your visit on ${when} at ${addressLine(booking)} is now ${what}.`,
        "It's the same day, time and address, and your notes and photos are kept with it.",
        confirmed ? "Your visit is confirmed. See you then!" : "We'll confirm the visit with you before the day.",
        conversion.kind === "membership" ? `You can see it, and manage your membership, in your Profixter account: ${SITE}/account` : "",
        `Questions? Call or text us at ${BUSINESS_PHONE}.`,
      ].filter(Boolean);
      try {
        await mail.sendRaw({
          to,
          subject: conversion.kind === "one_time" ? "Your visit is now a One-Time Visit" : "Your visit is now a membership visit",
          html: mail.frame(`<p style="margin:0 0 16px;">Hi ${e(firstNameOf(booking.name))},</p>${lines.map((l) => `<p style="margin:0 0 16px;">${e(l)}</p>`).join("")}<p style="margin:20px 0 0;">The Profixter Team</p>`, { preheader: `Your visit on ${when} is now ${what}.` }),
          text: [`Hi ${firstNameOf(booking.name)},`, ...lines, "The Profixter Team"].join("\n\n"),
          bccAdmin: false,
          logContext: { templateKey: "visit_converted", bookingId: booking._id, bookingNumber: booking.bookingNumber, customerName: booking.name || "", customerEmail: to, recipientName: booking.name || "", recipientEmail: to, emailType: "transactional", source: "freeVisitConversion" },
        });
      } catch (error) {
        log("error", "conversion_customer_mail_failed", { conversionId: String(conversion._id), message: String(error?.message || error).slice(0, 160) });
      }
    }
  }
  if (await claimNotice(conversion._id, "adminConvertedAt")) {
    await activity(conversion, booking, "Free Visit Converted to Paid", { bookingNumber: booking.bookingNumber, date: booking.date, status: booking.status, leadTimeRule: booking.freeVisitConversion?.leadTimeRule || "", amountCents: conversion.payment?.amountCents ?? null });
    try {
      await mail.sendPromo(ownerEmail(), {
        subject: `Free visit converted: ${booking.name || "customer"} - ${offerLabel(conversion)}`,
        html: `
          <h2>A free visit was converted to a paid visit</h2>
          <ul>
            <li><strong>Customer:</strong> ${e(booking.name || "")} (${e(booking.email || "")}, ${e(booking.phone || "-")})</li>
            <li><strong>Visit:</strong> #${e(booking.bookingNumber || "")}, ${e(when)}, ${e(addressLine(booking))}</li>
            <li><strong>Now:</strong> ${e(offerLabel(conversion))}, ${e(booking.status)}${confirmed ? "" : " (awaiting your approval)"}</li>
            <li><strong>Paid:</strong> ${conversion.payment?.amountCents != null ? e(dollars(conversion.payment.amountCents)) : "-"}</li>
            ${booking.freeVisitConversion?.leadTimeRule === "admin_override" ? `<li><strong>Seven-day rule overridden by</strong> ${e(conversion.leadTime?.override?.byName || "")}: ${e(conversion.leadTime?.override?.reason || "")}</li>` : ""}
          </ul>
          <p>The assigned Fixter, time, notes and photos are unchanged. The visit now includes labor: check the job before the day.</p>`,
        logContext: { templateKey: "admin_visit_converted", bookingId: booking._id, bookingNumber: booking.bookingNumber, customerName: booking.name || "", customerEmail: booking.email || "", recipientEmail: ownerEmail(), emailType: "admin", source: "freeVisitConversion" },
      });
    } catch (error) {
      log("error", "conversion_admin_mail_failed", { conversionId: String(conversion._id), message: String(error?.message || error).slice(0, 160) });
    }
  }
}

async function sendAttentionNotices(conversion) {
  const e = mail.escapeHtml;
  const booking = await Booking.findById(conversion.booking).lean();
  const when = booking ? whenLabel(booking.date) : whenLabel(conversion.snapshot?.date);
  const why = ATTENTION_REASONS[conversion.attention?.reason] || conversion.attention?.reason || "";
  if (await claimNotice(conversion._id, "adminAttentionAt")) {
    await activity(conversion, booking, "free_visit_conversion_needs_attention", { reason: conversion.attention?.reason, bookingNumber: conversion.bookingNumber, action: "Open the job, then Retry the conversion or close it after settling the payment in Stripe." });
    try {
      await mail.sendPromo(ownerEmail(), {
        subject: `Action needed: paid visit not converted - ${conversion.contact.name || "customer"}`,
        html: `
          <h2>A customer paid, but their free visit could not be converted</h2>
          <p>The payment went through (${conversion.payment?.amountCents != null ? e(dollars(conversion.payment.amountCents)) : "amount in Stripe"}, ${e(offerLabel(conversion))}). The visit was <strong>not</strong> changed because ${e(why)}.</p>
          <ul>
            <li><strong>Customer:</strong> ${e(conversion.contact.name || "")} (${e(conversion.contact.email || "")}, ${e(conversion.contact.phone || "-")})</li>
            <li><strong>Visit:</strong> #${e(conversion.bookingNumber || "")}, ${e(when)}${booking ? `, now ${e(booking.status)}` : ""}</li>
            <li><strong>Stripe:</strong> ${e(conversion.payment?.sessionId || "")}</li>
          </ul>
          <p>Please call them. In Admin, open the job: Retry the conversion once the reason is fixed (if the visit was moved, Retry can convert it at its new time), or settle the payment in Stripe and close it.</p>`,
        logContext: { templateKey: "admin_visit_conversion_attention", bookingId: conversion.booking, bookingNumber: conversion.bookingNumber, customerName: conversion.contact.name || "", customerEmail: conversion.contact.email || "", recipientEmail: ownerEmail(), emailType: "admin", source: "freeVisitConversion" },
      });
    } catch (error) {
      log("error", "conversion_admin_attention_mail_failed", { conversionId: String(conversion._id), message: String(error?.message || error).slice(0, 160) });
    }
  }
  if (conversion.contact.email && (await claimNotice(conversion._id, "customerAttentionAt"))) {
    /* Only what is known to be true: the membership is active unless that is exactly what went wrong. */
    const membershipActive = conversion.kind === "membership" && !["no_active_membership", "duplicate_membership"].includes(conversion.attention?.reason);
    const paidLine = membershipActive
      ? `Thank you - your payment went through and your ${PLAN_LABELS[conversion.plan] || conversion.plan} membership is active.`
      : `Thank you - we received your ${conversion.payment?.amountCents != null ? dollars(conversion.payment.amountCents) + " " : ""}payment.`;
    const lines = [
      paidLine,
      `We couldn't update your visit on ${when} automatically, so nothing about that visit has changed yet.`,
      `We'll call you at ${conversion.contact.phone || "the number we have"} to sort it out - there's nothing you need to do. You're also welcome to call or text us at ${BUSINESS_PHONE}.`,
    ];
    try {
      await mail.sendRaw({
        to: conversion.contact.email,
        subject: "We received your payment - we'll call you about your visit",
        html: mail.frame(`<p style="margin:0 0 16px;">Hi ${e(firstNameOf(conversion.contact.name))},</p>${lines.map((l) => `<p style="margin:0 0 16px;">${e(l)}</p>`).join("")}<p style="margin:20px 0 0;">The Profixter Team</p>`, { preheader: "We received your payment." }),
        text: [`Hi ${firstNameOf(conversion.contact.name)},`, ...lines, "The Profixter Team"].join("\n\n"),
        bccAdmin: false,
        logContext: { templateKey: "visit_conversion_attention", bookingId: conversion.booking, bookingNumber: conversion.bookingNumber, customerName: conversion.contact.name || "", customerEmail: conversion.contact.email, recipientName: conversion.contact.name || "", recipientEmail: conversion.contact.email, emailType: "transactional", source: "freeVisitConversion" },
      });
    } catch (error) {
      log("error", "conversion_customer_attention_mail_failed", { conversionId: String(conversion._id), message: String(error?.message || error).slice(0, 160) });
    }
  }
}

/**
 * A payment that cannot convert anything because the visit already has a paid
 * conversion (or this one was paid before). Recorded on this conversion,
 * the owner told once per Stripe page, never converted.
 */
async function recordSecondPayment(conversion, session, other) {
  const added = await FreeVisitConversion.findOneAndUpdate(
    { _id: conversion._id, "payment.extraSessionIds": { $ne: session.id } },
    {
      $addToSet: { "payment.extraSessionIds": session.id },
      $push: { history: historyEntry("second_payment", null, { sessionId: session.id, amountCents: session.amount_total ?? null, otherConversionId: other ? String(other._id) : "" }) },
    },
    { new: true }
  );
  if (!added) return conversion;
  log("error", "conversion_second_payment", { conversionId: String(conversion._id), first: conversion.payment?.sessionId || (other ? `other:${other._id}` : ""), second: session.id });
  await notifyOwnerSecondPayment(conversion, session);
  return added;
}

async function notifyOwnerSecondPayment(conversion, session) {
  await AdminActivityLog.create({
    action: "free_visit_conversion_second_payment",
    entityType: "Booking",
    entityId: String(conversion.booking),
    entityName: String(conversion.bookingNumber || ""),
    actorName: "System (Stripe payment)",
    actorRole: "system",
    details: { conversionId: String(conversion._id), firstSessionId: conversion.payment?.sessionId, secondSessionId: session.id, action: "Refund the second payment in Stripe." },
  }).catch(() => null);
  try {
    await mail.sendPromo(ownerEmail(), {
      subject: `Action needed: second payment for one visit - ${conversion.contact.name || "customer"}`,
      html: `<p>${mail.escapeHtml(conversion.contact?.name || "A customer")} paid a second time for the same visit (#${mail.escapeHtml(conversion.bookingNumber || "")}, Stripe ${mail.escapeHtml(session.id)}). The visit is converted at most once. Please refund this payment in Stripe${conversion.kind === "membership" ? ", and cancel the membership it started if it is a duplicate" : ""}.</p>`,
      logContext: { templateKey: "admin_visit_conversion_attention", bookingId: conversion.booking, recipientEmail: ownerEmail(), emailType: "admin", source: "freeVisitConversion" },
    });
  } catch (error) {
    log("error", "conversion_second_payment_mail_failed", { message: String(error?.message || error).slice(0, 160) });
  }
}

/* ------------------------------------------------------------------ */
/* Sweep                                                                */
/* ------------------------------------------------------------------ */

/** Every few minutes (jobs/oneTimeVisitHolds.js): finish paid conversions, expire dead links. */
async function sweepConversions(now = new Date()) {
  const due = await FreeVisitConversion.find({
    $or: [
      { status: "paid", updatedAt: { $lt: new Date(now.getTime() - 60 * 1000) } },
      { status: "converting", convertingAt: { $lt: new Date(now.getTime() - STALE_CONVERTING_MS) } },
    ],
  })
    .select("_id")
    .limit(20)
    .lean();
  let finished = 0;
  for (const c of due) {
    const after = await runConversion(c._id, { now });
    if (after?.status === "converted" || after?.status === "needs_attention") finished += 1;
  }
  const stale = await FreeVisitConversion.find({
    status: "open",
    linkExpiresAt: { $lte: now },
    $or: [{ "checkout.sessionId": "" }, { "checkout.expiresAt": { $lte: now } }],
  }).limit(50);
  let expired = 0;
  for (const c of stale) if (await withdraw(c, { event: "expired" })) expired += 1;
  return { finished, expired };
}

module.exports = {
  ConversionError,
  historyEntry,
  loadConversion,
  TERMS_VERSION,
  ATTENTION_REASONS,
  isConverted,
  isUnconvertedFreeVisit,
  convertProblem,
  convertedStatus,
  accountCandidates,
  conversionOptions,
  createConversion,
  sendConversionLink,
  cancelConversion,
  retryConversion,
  closeConversion,
  presentConversion,
  describeConversionLink,
  openConversionCheckout,
  customerUpgradeOptions,
  startCustomerUpgrade,
  customerConversionView,
  customerPaymentStatus,
  isConversionSession,
  handleConversionPaid,
  handleConversionExpired,
  runConversion,
  sweepConversions,
  termsText,
};
