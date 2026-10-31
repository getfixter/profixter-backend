const mongoose = require("mongoose");
const User = require("../models/User");
const Subscription = require("../models/Subscription");
const { stripe, resolveStripePriceId } = require("./subscriptionManagement");

/**
 * The 20% first-payment offer.
 *
 * Customer Experience 4.2 (2026-10-31) gave a brand-new customer 20% off the
 * first month of a monthly membership for ten minutes after signing up. The
 * Halloween promotion (same day) widened it: 20% off the FIRST PAYMENT of any
 * plan, monthly or annual, for anyone without a live membership - new
 * customers, customers who never bought one, and former members - once per
 * customer and once per home. Renewals are always the regular price.
 *
 * TWO WAYS A TEN-MINUTE WINDOW OPENS, both measured by the server:
 *  - a new account: from its own createdAt (written by the server on save);
 *  - an existing account: from the moment the signed-in customer first opens
 *    a live campaign offer (activateCampaignOffer). Never from a message being
 *    sent or a link being previewed - activation needs the customer's own
 *    session. It is written once per campaign and never restarted.
 * A campaign has its own end date, independent of the ten minutes: a message
 * read days later still works until the campaign ends.
 *
 * WHO CANNOT HAVE IT: an account with a live membership (active, trialing,
 * past due or unpaid - buying would bill twice), an account or home that has
 * already redeemed this offer, gift coverage (the first invoice is the trial's).
 * A canceled or expired membership does not disqualify anyone.
 *
 * HOW IT IS CHARGED. A Stripe coupon (percent_off 20, duration "once") that
 * only this server attaches to a checkout. It is not a promotion code, so it
 * cannot be typed in, shared or reused; Stripe applies a "once" coupon to the
 * first invoice and renewals are full price. A welcome-priced checkout carries
 * no promotion-code field (Stripe refuses both together), so it cannot stack.
 * It is "redeemed" only by a COMPLETED checkout: an abandoned, canceled or
 * failed one leaves the offer as it was.
 *
 * CHECKOUTS STARTED IN TIME. A checkout opened inside the window keeps the
 * offer price, because that is what Stripe's own page shows and charges; it is
 * opened to expire in 31 minutes (Stripe's shortest allowed lifetime is 30).
 */

const WELCOME_OFFER_PERCENT = 20;
const WELCOME_OFFER_WINDOW_MS = 10 * 60 * 1000;
const WELCOME_CHECKOUT_LIFETIME_S = 31 * 60;
const WELCOME_OFFER_CYCLES = ["monthly", "annual"];
const WELCOME_COUPON_ID = String(process.env.WELCOME_OFFER_COUPON_ID || "pfx-welcome-20-first-month").trim();
const PLANS = ["basic", "plus", "premium", "elite"];
const PRICE_CACHE_MS = 10 * 60 * 1000;
const LIVE_MEMBERSHIP_STATUSES = ["active", "trialing", "past_due", "unpaid", "incomplete"];

/*
 * Campaigns an existing customer can open. endsAt is when the offer can no
 * longer be STARTED; a window opened before it still runs its ten minutes.
 */
const CAMPAIGNS = {
  "halloween-2026": {
    label: "Halloween Offer",
    // Through Monday, November 2, 2026, 11:59 PM New York time.
    endsAt: new Date("2026-11-03T04:59:59Z"),
  },
};

function log(level, event, details = {}) {
  const payload = JSON.stringify({ level, event, scope: "welcome_offer", ...details });
  if (level === "error") console.error(payload);
  else if (level === "warn") console.warn(payload);
  else console.log(payload);
}

/*
 * A customer, as the rest of the app counts one: a missing role is the schema
 * default, "customer". Most of the customer base was imported before the field
 * existed (utils/marketing/marketingEligibility.js says the same), and lean
 * reads do not apply defaults - so "role === customer" alone would refuse the
 * offer to almost every long-standing customer.
 */
function isCustomer(user) {
  return Boolean(user) && String(user.role || "customer") === "customer" && !user.employeePosition;
}

function campaignInfo(id, now = new Date()) {
  const campaign = CAMPAIGNS[String(id || "")];
  if (!campaign) return null;
  return { id: String(id), label: campaign.label, endsAt: campaign.endsAt, active: now.getTime() < campaign.endsAt.getTime() };
}

/** The new-account window, or null if this account could never have one. */
function welcomeOfferWindow(user) {
  if (!isCustomer(user)) return null;
  if (user.signupMethod === "admin" || user.adminCreated?.at) return null;
  const created = user.createdAt ? new Date(user.createdAt) : null;
  if (!created || Number.isNaN(created.getTime())) return null;
  return { source: "new_account", startedAt: created, expiresAt: new Date(created.getTime() + WELCOME_OFFER_WINDOW_MS) };
}

/** The window that is open now (the later-ending one if both are), else the latest that existed. */
function currentWindow(user, activation, now) {
  const windows = [];
  const fresh = welcomeOfferWindow(user);
  if (fresh) windows.push(fresh);
  if (activation?.activatedAt && activation?.expiresAt && isCustomer(user)) {
    windows.push({ source: String(activation.campaign || "campaign"), startedAt: new Date(activation.activatedAt), expiresAt: new Date(activation.expiresAt) });
  }
  if (!windows.length) return null;
  const open = windows.filter((w) => now.getTime() < w.expiresAt.getTime()).sort((a, b) => b.expiresAt - a.expiresAt);
  return open[0] || windows.sort((a, b) => b.expiresAt - a.expiresAt)[0];
}

/** First-payment price in cents, rounded to the cent the way Stripe rounds a percent-off. */
function firstMonthCents(cents) {
  return Math.round(Number(cents) * (100 - WELCOME_OFFER_PERCENT) / 100);
}
const firstPaymentCents = firstMonthCents;

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

async function sessionComplete(sessionId, stripeClient) {
  try {
    const session = await stripeClient.checkout.sessions.retrieve(String(sessionId));
    return session?.status === "complete";
  } catch (error) {
    // Unknown is not "unused": treat as redeemed rather than risk a second redemption.
    log("warn", "welcome_offer_session_lookup_failed", { message: error?.message || String(error) });
    return true;
  }
}

/**
 * Has this street address already redeemed the offer, under ANY account?
 * Once per home: a second account cannot take it again for the same house.
 */
async function homeRedeemed({ line1, zip }, stripeClient = stripe) {
  const street = normalizeStreet(line1);
  const zip5 = normalizeZip(zip);
  if (!street || !zip5) return false;
  const candidates = await User.collection
    .find({ "welcomeOffer.sessionId": { $exists: true }, "addresses.zip": { $regex: `^${zip5}` } }, { projection: { addresses: 1, welcomeOffer: 1 } })
    .toArray();
  for (const candidate of candidates) {
    const offer = candidate.welcomeOffer || {};
    const home = (candidate.addresses || []).find((a) => String(a._id) === String(offer.addressId));
    if (!home || normalizeZip(home.zip) !== zip5 || normalizeStreet(home.line1) !== street) continue;
    if (offer.redeemedAt || (await sessionComplete(offer.sessionId, stripeClient))) return true;
  }
  return false;
}

/* Kept for callers and tests from CX 4.2: a home "had a membership" now matters only if it redeemed the offer. */
const homeHadMembership = homeRedeemed;

/**
 * What Stripe knows: a live (billing) membership for this customer or email,
 * and whether any subscription was ever bought with this offer.
 */
async function stripeMembershipFacts(user, stripeClient = stripe) {
  const customerIds = new Set();
  if (user.stripeCustomerId) customerIds.add(String(user.stripeCustomerId));
  if (user.email) {
    const found = await stripeClient.customers.list({ email: String(user.email).toLowerCase(), limit: 10 });
    for (const customer of found?.data || []) customerIds.add(customer.id);
  }
  let live = false;
  let redeemed = false;
  for (const customer of customerIds) {
    const subs = await stripeClient.subscriptions.list({ customer, status: "all", limit: 100 });
    for (const sub of subs?.data || []) {
      if (LIVE_MEMBERSHIP_STATUSES.includes(String(sub.status))) live = true;
      if (sub.metadata?.welcomeOffer) redeemed = true;
    }
  }
  return { live, redeemed };
}

/**
 * Everything except the clock: can this customer have the offer at all?
 * Used before a campaign window is opened (so it is never opened for nothing)
 * and on every status check.
 */
async function offerBlocker({ user, address = null, stripeClient = stripe }) {
  if (!isCustomer(user)) return "not_eligible";
  if (await Subscription.exists({ user: user._id, status: { $in: LIVE_MEMBERSHIP_STATUSES } })) return "has_membership";
  const raw = await User.collection.findOne({ _id: new mongoose.Types.ObjectId(String(user._id)) }, { projection: { welcomeOffer: 1 } });
  const offer = raw?.welcomeOffer;
  if (offer?.redeemedAt || (offer?.sessionId && (await sessionComplete(offer.sessionId, stripeClient)))) return "redeemed";
  // The home being bought for, or - when none is named yet - every home on the account.
  const homes = address ? [address] : (user.addresses || []).map((h) => ({ line1: h.line1, zip: h.zip }));
  for (const home of homes) {
    if (await homeRedeemed(home, stripeClient)) return "home_redeemed";
  }
  try {
    const facts = await stripeMembershipFacts(user, stripeClient);
    if (facts.live) return "has_membership";
    if (facts.redeemed) return "redeemed";
  } catch (error) {
    log("warn", "welcome_offer_stripe_lookup_failed", { message: error?.message || String(error) });
    return "unavailable";
  }
  return "";
}

/**
 * Whether this customer can have the offer price right now.
 * @returns {{ eligible, reason, expiresAt, source }}
 */
async function welcomeOfferStatus({ user, address = null, now = new Date(), stripeClient = stripe }) {
  if (!isCustomer(user)) return { eligible: false, reason: "not_eligible", expiresAt: null, source: null };
  const raw = await User.collection.findOne({ _id: new mongoose.Types.ObjectId(String(user._id)) }, { projection: { welcomeOfferActivation: 1 } });
  const window = currentWindow(user, raw?.welcomeOfferActivation || user.welcomeOfferActivation, now);
  if (!window) return { eligible: false, reason: "not_eligible", expiresAt: null, source: null };
  if (now.getTime() >= window.expiresAt.getTime()) return { eligible: false, reason: "expired", expiresAt: window.expiresAt, source: window.source };
  const reason = await offerBlocker({ user, address, stripeClient });
  if (reason) return { eligible: false, reason, expiresAt: window.expiresAt, source: window.source };
  return { eligible: true, reason: "", expiresAt: window.expiresAt, source: window.source };
}

/**
 * The signed-in customer opened a live campaign's offer: open their ten
 * minutes, once. Asking again returns the same window; it never restarts.
 * Nothing is opened for someone who could not use it, or after the campaign.
 * @returns {{ activated: boolean, reason: string, campaign }}
 */
async function activateCampaignOffer({ user, campaignId, address = null, now = new Date(), stripeClient = stripe }) {
  const campaign = campaignInfo(campaignId, now);
  if (!campaign) return { activated: false, reason: "unknown_campaign", campaign: null };
  const raw = await User.collection.findOne({ _id: new mongoose.Types.ObjectId(String(user._id)) }, { projection: { welcomeOfferActivation: 1 } });
  const existing = raw?.welcomeOfferActivation;
  if (existing?.campaign === campaign.id) return { activated: false, reason: "already_activated", campaign };
  if (!campaign.active) return { activated: false, reason: "campaign_ended", campaign };
  // A new account still inside its own ten minutes keeps that window; the campaign is not needed.
  const fresh = welcomeOfferWindow(user);
  if (fresh && now.getTime() < fresh.expiresAt.getTime()) return { activated: false, reason: "new_account_window", campaign };
  const reason = await offerBlocker({ user, address, stripeClient });
  if (reason) return { activated: false, reason, campaign };
  const activation = { campaign: campaign.id, activatedAt: now, expiresAt: new Date(now.getTime() + WELCOME_OFFER_WINDOW_MS) };
  // Written only if no activation for this campaign exists: two tabs at once still open one window.
  const result = await User.collection.updateOne(
    { _id: new mongoose.Types.ObjectId(String(user._id)), "welcomeOfferActivation.campaign": { $ne: campaign.id } },
    { $set: { welcomeOfferActivation: activation } }
  );
  if (result.modifiedCount) log("info", "welcome_offer_campaign_activated", { campaign: campaign.id, userId: String(user._id) });
  return { activated: Boolean(result.modifiedCount), reason: result.modifiedCount ? "" : "already_activated", campaign };
}

/* -------------------------------- prices -------------------------------- */

let priceCache = null;

/** The live price of each plan on each cycle, in cents, from Stripe (cached ten minutes). */
async function planPriceCents(stripeClient = stripe) {
  if (priceCache && priceCache.until > Date.now()) return priceCache.value;
  const value = {};
  for (const plan of PLANS) {
    for (const billingCycle of WELCOME_OFFER_CYCLES) {
      const { priceId } = await resolveStripePriceId({ plan, billingCycle });
      if (!priceId) continue;
      const price = await stripeClient.prices.retrieve(priceId);
      if (!Number.isFinite(Number(price?.unit_amount))) continue;
      value[plan] = value[plan] || {};
      value[plan][billingCycle] = Number(price.unit_amount);
    }
  }
  priceCache = { value, until: Date.now() + PRICE_CACHE_MS };
  return value;
}

/** CX 4.2 shape, kept: { basic: 14900, ... } monthly cents. */
async function monthlyPlanCents(stripeClient = stripe) {
  const all = await planPriceCents(stripeClient);
  return Object.fromEntries(Object.entries(all).filter(([, v]) => v.monthly != null).map(([plan, v]) => [plan, v.monthly]));
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
  WELCOME_OFFER_CYCLES,
  WELCOME_COUPON_ID,
  CAMPAIGNS,
  LIVE_MEMBERSHIP_STATUSES,
  campaignInfo,
  isCustomer,
  welcomeOfferWindow,
  welcomeOfferStatus,
  activateCampaignOffer,
  offerBlocker,
  firstMonthCents,
  firstPaymentCents,
  homeRedeemed,
  homeHadMembership,
  planPriceCents,
  monthlyPlanCents,
  ensureWelcomeCoupon,
  resetWelcomeOfferCaches,
  normalizeStreet,
};
