const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const mongoose = require("mongoose");
const User = require("../models/User");
const { CLIENT_URL, CheckoutRefusal, openMembershipCheckout } = require("../utils/membershipCheckout");
const {
  WELCOME_OFFER_PERCENT,
  WELCOME_CHECKOUT_LIFETIME_S,
  WELCOME_OFFER_CYCLES,
  welcomeOfferStatus,
  activateCampaignOffer,
  campaignInfo,
  firstPaymentCents,
  planPriceCents,
  ensureWelcomeCoupon,
} = require("../utils/welcomeOffer");

function getClientIp(req) {
  const forwardedFor = req.headers["x-forwarded-for"];
  if (forwardedFor) return String(forwardedFor).split(",")[0].trim();
  return req.socket?.remoteAddress || "";
}

function getCookie(req, name) {
  const cookie = req.headers.cookie || "";
  const parts = cookie.split(";").map((part) => part.trim());
  const found = parts.find((part) => part.startsWith(name + "="));
  return found ? decodeURIComponent(found.split("=").slice(1).join("=")) : null;
}

function logCheckout(level, event, details = {}) {
  const payload = JSON.stringify({
    level,
    event,
    scope: "stripe_checkout",
    ...details,
  });
  if (level === "error") console.error(payload);
  else if (level === "warn") console.warn(payload);
  else console.log(payload);
}

/* The home the offer is being asked about: one on the account, or one typed in Book a Handyman. */
function offerAddress(user, { addressId, line1, zip }) {
  if (addressId && mongoose.isValidObjectId(addressId)) {
    const home = (user.addresses || []).find((a) => String(a._id) === String(addressId));
    if (home) return { line1: home.line1, zip: home.zip };
  }
  if (line1 && zip) return { line1: String(line1).slice(0, 200), zip: String(zip).slice(0, 10) };
  return null;
}

/*
 * The new-customer welcome offer, as this customer may have it right now. The
 * screen counts down from expiresAt against serverNow, so the browser's own
 * clock never decides anything; checkout asks the same question again.
 */
/*
 * The answer the screen counts down from: eligibility, the window's end and
 * the server clock, and every plan's live price with its first-payment price.
 */
async function offerBody(user, query) {
  const status = await welcomeOfferStatus({ user, address: offerAddress(user, query || {}) });
  const body = { eligible: status.eligible, serverNow: new Date().toISOString(), percentOff: WELCOME_OFFER_PERCENT, reason: status.reason || "" };
  if (!status.eligible) return body;
  const prices = await planPriceCents();
  const plans = {};
  for (const [plan, cents] of Object.entries(prices)) {
    plans[plan] = {
      ...(cents.monthly != null ? { monthlyCents: cents.monthly, firstMonthCents: firstPaymentCents(cents.monthly) } : {}),
      ...(cents.annual != null ? { annualCents: cents.annual, firstYearCents: firstPaymentCents(cents.annual) } : {}),
    };
  }
  if (!Object.keys(plans).length) return { ...body, eligible: false };
  const campaign = campaignInfo(status.source);
  return {
    ...body,
    expiresAt: status.expiresAt.toISOString(),
    source: status.source,
    label: campaign ? campaign.label : "Welcome Offer",
    cycles: WELCOME_OFFER_CYCLES,
    plans,
  };
}

router.get("/welcome-offer", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).lean();
    if (!user) return res.status(404).json({ message: "User not found" });
    return res.json(await offerBody(user, req.query));
  } catch (error) {
    logCheckout("warn", "welcome_offer_status_failed", { message: error?.message || String(error) });
    // No offer is the safe answer: the regular price is always honest.
    return res.json({ eligible: false, serverNow: new Date().toISOString(), percentOff: WELCOME_OFFER_PERCENT });
  }
});

/*
 * A campaign's public facts, for its landing page: is it still running, and
 * until when. Nothing personal, nothing started.
 */
router.get("/welcome-offer/campaign/:id", (req, res) => {
  const campaign = campaignInfo(req.params.id);
  if (!campaign) return res.status(404).json({ active: false });
  return res.json({ id: campaign.id, label: campaign.label, active: campaign.active, endsAt: campaign.endsAt.toISOString(), percentOff: WELCOME_OFFER_PERCENT });
});

/*
 * The signed-in customer opened a campaign offer: their ten minutes start now,
 * once (utils/welcomeOffer.js activateCampaignOffer). Then the same answer as
 * GET /welcome-offer. A preview or a sent message never reaches here - it
 * needs the customer's own session.
 */
router.post("/welcome-offer/activate", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).lean();
    if (!user) return res.status(404).json({ message: "User not found" });
    const result = await activateCampaignOffer({ user, campaignId: req.body?.campaign, address: offerAddress(user, req.body || {}) });
    const body = await offerBody(user, req.body);
    return res.json({ ...body, activation: result.reason || "activated", campaign: result.campaign ? { id: result.campaign.id, active: result.campaign.active, endsAt: result.campaign.endsAt.toISOString() } : null });
  } catch (error) {
    logCheckout("warn", "welcome_offer_activate_failed", { message: error?.message || String(error) });
    return res.json({ eligible: false, serverNow: new Date().toISOString(), percentOff: WELCOME_OFFER_PERCENT });
  }
});

/*
 * The customer's own "Buy". Every protection against billing a home twice
 * lives in utils/membershipCheckout.js, which Admin's phone sales and payment
 * links use too; this route only supplies who is buying and their tracking.
 */
router.post("/create-checkout-session", auth, async (req, res) => {
  const { plan, addressId, billingCycle } = req.body;
  // The customer was shown the welcome price: never open a checkout at another price without telling them.
  const expectsWelcome = req.body?.welcomeOffer === true;
  try {
    let welcomeOffer = null;
    if (WELCOME_OFFER_CYCLES.includes(String(billingCycle || "monthly").toLowerCase())) {
      const user = await User.findById(req.user.id).lean();
      const status = user ? await welcomeOfferStatus({ user, address: offerAddress(user, { addressId }) }) : { eligible: false };
      if (status.eligible) {
        try {
          welcomeOffer = { couponId: await ensureWelcomeCoupon(), lifetimeSeconds: WELCOME_CHECKOUT_LIFETIME_S, required: expectsWelcome };
        } catch (error) {
          logCheckout("error", "welcome_offer_coupon_unavailable", { message: error?.message || String(error) });
        }
      }
      if (expectsWelcome && !welcomeOffer) {
        const ended = status.reason === "expired";
        return res.status(409).json({
          code: ended ? "WELCOME_OFFER_ENDED" : "WELCOME_OFFER_UNAVAILABLE",
          message: ended
            ? "The 20% offer has ended. The prices shown now are the regular prices."
            : status.reason === "home_redeemed"
              ? "This home has already used the 20% offer, so it doesn't apply again. The prices shown now are the regular prices."
              : status.reason === "redeemed"
                ? "This account has already used the 20% offer. The prices shown now are the regular prices."
                : "The 20% offer isn't available for this account. The prices shown now are the regular prices.",
        });
      }
    }
    const { session, eventId, trialEndUnix, welcomeOfferApplied } = await openMembershipCheckout({
      userId: req.user.id,
      plan,
      billingCycle,
      addressId,
      welcomeOffer,
      /*
       * Started from Book a Handyman: the confirmation page still runs (it
       * fires the Subscribe the ad accounts count) and then hands the
       * customer back to finish booking the visit they already described.
       */
      ...(String(req.body?.returnTo || "") === "handyman"
        ? {
            successUrl: `${CLIENT_URL}/confirmationpage?session_id={CHECKOUT_SESSION_ID}&next=handyman`,
            cancelUrl: `${CLIENT_URL}/book/handyman?canceled=membership`,
          }
        : {}),
      tracking: {
        fbp: getCookie(req, "_fbp"),
        fbc: getCookie(req, "_fbc"),
        sourceUrl: req.headers.referer || `${CLIENT_URL}/`,
        clientIp: getClientIp(req),
        userAgent: req.headers["user-agent"] || "",
      },
    });
    return res.status(200).json({
      url: session.url,
      eventId,
      sessionId: session.id,
      // So the screen can say when the first charge happens instead of
      // leaving the customer to discover it on a statement.
      billingStartsAt: trialEndUnix ? new Date(trialEndUnix * 1000).toISOString() : null,
      welcomeOfferApplied: !!welcomeOfferApplied,
    });
  } catch (error) {
    if (error instanceof CheckoutRefusal) return res.status(error.status).json(error.body);
    logCheckout("error", "subscription_checkout_route_failed", { message: error?.message || String(error) });
    return res.status(500).json({
      message: "Unable to start secure checkout right now. Please try again.",
      code: "CHECKOUT_SESSION_CREATE_FAILED",
    });
  }
});

module.exports = router;
