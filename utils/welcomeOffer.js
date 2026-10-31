const mongoose = require("mongoose");
const User = require("../models/User");
const Subscription = require("../models/Subscription");
const { stripe, resolveStripePriceId } = require("./subscriptionManagement");

/**
 * The new-customer welcome offer (Customer Experience 4.2, 2026-10-31):
 * 20% off the FIRST MONTH of a MONTHLY membership, for ten minutes after the
 * account is created.
 *
 * THE CLOCK. The window starts at the account's own createdAt - written by the
 * server when the account was saved, never by the browser - so a reload, a
 * second tab, another device or a repeated request cannot restart or stretch
 * it. Accounts created before this shipped are hours old and simply outside it.
 *
 * WHO. A customer who created their own account (not one Admin made for them)
 * and has never had a membership: no Subscription record on the account, no
 * subscription of any status at Stripe for their email, and - so a second
 * account cannot claim it again for the same house - no membership ever on the
 * same street address under any account. One redemption per account: once a
 * welcome-priced checkout has been paid, the offer is gone.
 *
 * HOW IT IS CHARGED. A Stripe coupon (percent_off 20, duration "once") that
 * only this server attaches to a checkout. It is not a promotion code, so it
 * cannot be typed in, shared or reused; Stripe applies a "once" coupon to the
 * first invoice and renewals are full price. A welcome-priced checkout carries
 * no promotion-code field (Stripe refuses both together), so it cannot stack.
 *
 * CHECKOUTS STARTED IN TIME. The offer governs OPENING a checkout. A checkout
 * opened inside the window keeps the welcome price, because that is the price
 * Stripe's own page shows the customer and charges; it is opened to expire in
 * 31 minutes (Stripe's shortest allowed lifetime is 30) instead of the usual
 * 24 hours. Any checkout opened after the window is full price, and opening a
 * new one closes the old one first (utils/membershipCheckout.js).
 */

const WELCOME_OFFER_PERCENT = 20;
const WELCOME_OFFER_WINDOW_MS = 10 * 60 * 1000;
const WELCOME_CHECKOUT_LIFETIME_S = 31 * 60;
const WELCOME_COUPON_ID = String(process.env.WELCOME_OFFER_COUPON_ID || "pfx-welcome-20-first-month").trim();
const PLANS = ["basic", "plus", "premium", "elite"];
const PRICE_CACHE_MS = 10 * 60 * 1000;

function log(level, event, details = {}) {
  const payload = JSON.stringify({ level, event, scope: "welcome_offer", ...details });
  if (level === "error") console.error(payload);
  else if (level === "warn") console.warn(payload);
  else console.log(payload);
}

/** The window for this account, or null if the account could never have one. */
function welcomeOfferWindow(user) {
  if (!user || user.role !== "customer") return null;
  if (user.signupMethod === "admin" || user.adminCreated?.at) return null;
  const created = user.createdAt ? new Date(user.createdAt) : null;
  if (!created || Number.isNaN(created.getTime())) return null;
  return { startedAt: created, expiresAt: new Date(created.getTime() + WELCOME_OFFER_WINDOW_MS) };
}

/** First-month price in cents, rounded to the cent the way Stripe rounds a percent-off. */
function firstMonthCents(monthlyCents) {
  return Math.round(Number(monthlyCents) * (100 - WELCOME_OFFER_PERCENT) / 100);
}

function normalizeStreet(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\b(street)\b/g, "st")
    .replace(/\b(avenue)\b/g, "ave")
    .replace(/\b(road)\b/g, "rd")
    .replace(/\b(drive)\b/g, "dr")
    .replace(/\b(lane)\b/g, "ln")
    .replace(/\b(court)\b/g, "ct")
    .replace(/\b(place)\b/g, "pl")
    .replace(/\b(boulevard)\b/g, "blvd")
    .replace(/[^a-z0-9]/g, "");
}
function normalizeZip(value) {
  return String(value || "").replace(/[^0-9]/g, "").slice(0, 5);
}

/**
 * Has this street address had a membership under ANY account (including this
 * one)? A second account cannot take the welcome offer again for the same house.
 */
async function homeHadMembership({ line1, zip }) {
  const street = normalizeStreet(line1);
  const zip5 = normalizeZip(zip);
  if (!street || !zip5) return false;
  const candidates = await User.find({ "addresses.zip": { $regex: `^${zip5}` } })
    .select("_id addresses._id addresses.line1 addresses.zip")
    .lean();
  const pairs = [];
  for (const candidate of candidates) {
    for (const address of candidate.addresses || []) {
      if (normalizeZip(address.zip) === zip5 && normalizeStreet(address.line1) === street) {
        pairs.push({ user: candidate._id, addressId: address._id });
      }
    }
  }
  if (!pairs.length) return false;
  return Boolean(await Subscription.exists({ $or: pairs }));
}

/** Any subscription, of any status, at Stripe for this account's customer or email. */
async function stripeHasSubscriptionHistory(user, stripeClient = stripe) {
  const customerIds = new Set();
  if (user.stripeCustomerId) customerIds.add(String(user.stripeCustomerId));
  if (user.email) {
    const found = await stripeClient.customers.list({ email: String(user.email).toLowerCase(), limit: 10 });
    for (const customer of found?.data || []) customerIds.add(customer.id);
  }
  for (const customer of customerIds) {
    const subs = await stripeClient.subscriptions.list({ customer, status: "all", limit: 1 });
    if ((subs?.data || []).length) return true;
  }
  return false;
}

/** Has a welcome-priced checkout already been paid? (the record is written when one is opened) */
async function alreadyRedeemed(raw, stripeClient = stripe) {
  if (raw?.redeemedAt) return true;
  if (!raw?.sessionId) return false;
  try {
    const session = await stripeClient.checkout.sessions.retrieve(String(raw.sessionId));
    return session?.status === "complete";
  } catch (error) {
    // Unknown is not "unused": refuse rather than risk a second redemption.
    log("warn", "welcome_offer_session_lookup_failed", { message: error?.message || String(error) });
    return true;
  }
}

/**
 * Whether this customer can have the welcome price right now.
 *
 * @param {object} args
 * @param {object} args.user      a User document or lean object
 * @param {object} [args.address] { line1, zip } of the home, when known
 * @param {Date}   [args.now]
 * @returns {{ eligible: boolean, reason: string, expiresAt: Date|null }}
 */
async function welcomeOfferStatus({ user, address = null, now = new Date(), stripeClient = stripe }) {
  const window = welcomeOfferWindow(user);
  if (!window) return { eligible: false, reason: "not_eligible", expiresAt: null };
  if (now.getTime() >= window.expiresAt.getTime()) return { eligible: false, reason: "expired", expiresAt: window.expiresAt };
  const no = (reason) => ({ eligible: false, reason, expiresAt: window.expiresAt });

  if (await Subscription.exists({ user: user._id })) return no("has_membership");
  const raw = (await User.collection.findOne({ _id: new mongoose.Types.ObjectId(String(user._id)) }, { projection: { welcomeOffer: 1 } }))?.welcomeOffer;
  if (await alreadyRedeemed(raw, stripeClient)) return no("redeemed");
  if (address && (await homeHadMembership(address))) return no("home_had_membership");
  try {
    if (await stripeHasSubscriptionHistory(user, stripeClient)) return no("has_membership");
  } catch (error) {
    log("warn", "welcome_offer_stripe_history_failed", { message: error?.message || String(error) });
    return no("unavailable");
  }
  return { eligible: true, reason: "", expiresAt: window.expiresAt };
}

/* -------------------------------- prices -------------------------------- */

let priceCache = null;

/** The live monthly price of each plan, in cents, from Stripe (cached ten minutes). */
async function monthlyPlanCents(stripeClient = stripe) {
  if (priceCache && priceCache.until > Date.now()) return priceCache.value;
  const value = {};
  for (const plan of PLANS) {
    const { priceId } = await resolveStripePriceId({ plan, billingCycle: "monthly" });
    if (!priceId) continue;
    const price = await stripeClient.prices.retrieve(priceId);
    if (Number.isFinite(Number(price?.unit_amount))) value[plan] = Number(price.unit_amount);
  }
  priceCache = { value, until: Date.now() + PRICE_CACHE_MS };
  return value;
}

/* -------------------------------- coupon -------------------------------- */

let couponChecked = 0;

/**
 * The coupon, created once if missing. Anything other than exactly 20% off,
 * once, still valid, is refused - the price the customer was shown is the
 * price Stripe must charge.
 */
async function ensureWelcomeCoupon(stripeClient = stripe) {
  const ok = (c) => c && c.valid !== false && Number(c.percent_off) === WELCOME_OFFER_PERCENT && c.duration === "once" && !c.amount_off;
  if (couponChecked > Date.now()) return WELCOME_COUPON_ID;
  let coupon = null;
  try {
    coupon = await stripeClient.coupons.retrieve(WELCOME_COUPON_ID);
  } catch (error) {
    if (error?.code !== "resource_missing" && error?.statusCode !== 404) throw error;
  }
  if (!coupon) {
    coupon = await stripeClient.coupons.create({
      id: WELCOME_COUPON_ID,
      percent_off: WELCOME_OFFER_PERCENT,
      duration: "once",
      name: "Welcome offer - 20% off first month",
      metadata: { purpose: "new_customer_welcome_offer", appliedBy: "server_only" },
    });
    log("info", "welcome_offer_coupon_created", { couponId: coupon.id });
  }
  if (!ok(coupon)) {
    log("error", "welcome_offer_coupon_mismatch", { couponId: WELCOME_COUPON_ID, percentOff: coupon?.percent_off, duration: coupon?.duration, valid: coupon?.valid });
    throw new Error("Welcome offer coupon is not 20% off once");
  }
  couponChecked = Date.now() + PRICE_CACHE_MS;
  return WELCOME_COUPON_ID;
}

function resetWelcomeOfferCaches() {
  priceCache = null;
  couponChecked = 0;
}

module.exports = {
  WELCOME_OFFER_PERCENT,
  WELCOME_OFFER_WINDOW_MS,
  WELCOME_CHECKOUT_LIFETIME_S,
  WELCOME_COUPON_ID,
  welcomeOfferWindow,
  welcomeOfferStatus,
  firstMonthCents,
  homeHadMembership,
  monthlyPlanCents,
  ensureWelcomeCoupon,
  resetWelcomeOfferCaches,
  normalizeStreet,
};
