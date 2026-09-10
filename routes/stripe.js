const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const auth = require("../middleware/auth");
const User = require("../models/User");
const Subscription = require("../models/Subscription");
const {
  stripe,
  hasStripeSecretKey,
  resolveStripePriceId,
  normalizeBillingCycle,
  resolveUserStripeCustomerId,
} = require("../utils/subscriptionManagement");
const { projectedGiftCoverageEnd } = require("../utils/gifts/giftAccess");

const CLIENT_URL = process.env.CLIENT_URL || "https://www.profixter.com";

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

router.post("/create-checkout-session", auth, async (req, res) => {
  const { plan, addressId, billingCycle } = req.body;
  const cycle = normalizeBillingCycle(billingCycle, "monthly");
  const priceResolution = await resolveStripePriceId({ plan, billingCycle: cycle });
  const priceId = priceResolution.priceId;
  const requestId = `checkout_${Date.now()}_${Math.random().toString(16).slice(2)}`;

  logCheckout("info", "subscription_checkout_start", {
    requestId,
    userId: req.user?.id || null,
    plan: plan || null,
    billingCycle: cycle,
    priceResolutionSource: priceResolution.source || null,
    priceFound: !!priceId,
    hasAddressId: !!addressId,
  });

  if (!hasStripeSecretKey()) {
    logCheckout("error", "subscription_checkout_config_missing", {
      requestId,
      missing: ["STRIPE_SECRET_KEY"],
    });
    return res.status(503).json({
      message: "Secure checkout is temporarily unavailable. Please try again shortly.",
      code: "STRIPE_NOT_CONFIGURED",
    });
  }

  if (!plan || !priceId) {
    logCheckout("error", "subscription_checkout_price_mapping_missing", {
      requestId,
      plan: plan || null,
      billingCycle: cycle,
      priceResolutionSource: priceResolution.source || null,
      found: !!priceId,
    });
    return res.status(400).json({
      message: "Unable to map the requested plan",
      code: "PRICE_MAPPING_NOT_FOUND",
    });
  }

  if (!addressId || !mongoose.isValidObjectId(addressId)) {
    return res.status(400).json({ message: "Missing or invalid addressId" });
  }

  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    const email = user.email;

    const address = user.addresses.id(addressId);
    if (!address) return res.status(400).json({ message: "Address not found for this account" });

    const activeSub = await Subscription.findOne({
      user: user._id,
      addressId: new mongoose.Types.ObjectId(addressId),
      status: { $in: ["active", "trialing"] },
    });

    if (activeSub) {
      return res.status(409).json({
        message: "This address already has an active plan.",
        code: "ADDRESS_ALREADY_SUBSCRIBED",
      });
    }

    const fbp = getCookie(req, "_fbp");
    const fbc = getCookie(req, "_fbc");
    const sourceUrl = req.headers.referer || `${CLIENT_URL}/`;
    const clientIp = getClientIp(req);
    const userAgent = req.headers["user-agent"] || "";
    const eventId = `px_${Date.now()}_${Math.random().toString(16).slice(2)}`;

    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          lastPurchase: {
            eventId,
            fbp: fbp || null,
            fbc: fbc || null,
            sourceUrl,
            clientIp,
            userAgent,
            phone: user.phone || null,
            updatedAt: new Date(),
          },
        },
      }
    );

    /*
     * NEVER BILL OVER GIFT COVERAGE.
     *
     * A recipient with prepaid gift time who starts their own membership used
     * to be charged immediately, so they paid for days a gift already covered
     * and the remaining gift time was simply lost. Continue Membership sits
     * on the account screen for the last two weeks of a gift, which made that
     * the likely path rather than an edge case.
     *
     * So billing is deferred to the end of ALL gift coverage for this
     * property — the running gift, anything queued behind it, and any pending
     * gift still waiting for a date. Stripe's own trial does the work: the
     * card is collected now, the subscription exists immediately, and the
     * first invoice is raised when the trial ends.
     *
     * The customer here is the RECIPIENT's own, resolved from their own
     * account exactly as for any other subscriber. Nothing about the
     * purchaser is read, reachable or involved.
     *
     * Stripe requires a trial to end far enough out to be meaningful, so a
     * gift ending within the floor below is rounded up rather than rejected.
     * That direction is deliberate: it can only ever delay the first charge
     * by hours, never bring it forward over covered days.
     */
    let giftCoverageEndsAt = null;
    try {
      giftCoverageEndsAt = await projectedGiftCoverageEnd(user._id, address._id, {
        now: new Date(),
      });
    } catch (error) {
      /*
       * Gift lookup must never stop somebody buying a membership. Failing
       * here means we bill immediately, which is the pre-existing behaviour;
       * it is logged loudly because it silently costs a customer gift days.
       */
      logCheckout("error", "subscription_checkout_gift_coverage_lookup_failed", {
        requestId,
        userId: String(user._id),
        error: error?.message || String(error),
      });
    }

    const MIN_TRIAL_SECONDS = 48 * 60 * 60;
    let trialEndUnix = null;
    if (giftCoverageEndsAt) {
      const earliest = Math.floor(Date.now() / 1000) + MIN_TRIAL_SECONDS;
      trialEndUnix = Math.max(Math.floor(giftCoverageEndsAt.getTime() / 1000), earliest);
    }

    const stripeCustomerId = await resolveUserStripeCustomerId(user);
    const sessionConfig = {
      mode: "subscription",
      payment_method_types: ["card"],
      client_reference_id: String(addressId),
      line_items: [{ price: priceId, quantity: 1 }],
      allow_promotion_codes: true,
      metadata: {
        plan,
        billingCycle: cycle,
        email,
        userId: String(user.userId || user._id),
        addressId: String(addressId),
        fbp: fbp || "",
        fbc: fbc || "",
        source_url: sourceUrl || "",
        eventId: eventId || "",
      },
      subscription_data: {
        metadata: {
          plan,
          billingCycle: cycle,
          email,
          userId: String(user.userId || user._id),
          addressId: String(addressId),
          ...(trialEndUnix ? { giftCoverageUntil: String(trialEndUnix) } : {}),
        },
        ...(trialEndUnix ? { trial_end: trialEndUnix } : {}),
      },
      automatic_tax: { enabled: true },
      success_url: `${CLIENT_URL}/confirmationpage?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${CLIENT_URL}/?canceled=true&plan=${plan}&billingCycle=${cycle}`,
    };

    if (stripeCustomerId) {
      sessionConfig.customer = stripeCustomerId;
    } else {
      sessionConfig.customer_email = email;
    }

    const session = await stripe.checkout.sessions.create(sessionConfig);
    if (!session?.url) {
      logCheckout("error", "subscription_checkout_missing_redirect_url", {
        requestId,
        stripeSessionId: session?.id || null,
        userId: String(user._id),
      });
      return res.status(502).json({
        message: "Secure checkout could not be opened. Please try again.",
        code: "CHECKOUT_URL_MISSING",
      });
    }

    logCheckout("info", "subscription_checkout_session_created", {
      requestId,
      stripeSessionId: session.id,
      userId: String(user._id),
      addressId: String(addressId),
      plan,
      billingCycle: cycle,
      billingStartsAt: trialEndUnix ? new Date(trialEndUnix * 1000).toISOString() : null,
      deferredForGiftCoverage: !!trialEndUnix,
    });
    return res.status(200).json({
      url: session.url,
      eventId,
      sessionId: session.id,
      // So the screen can say when the first charge happens instead of
      // leaving the customer to discover it on a statement.
      billingStartsAt: trialEndUnix ? new Date(trialEndUnix * 1000).toISOString() : null,
    });
  } catch (error) {
    logCheckout("error", "subscription_checkout_session_failed", {
      requestId,
      userId: req.user?.id || null,
      plan: plan || null,
      billingCycle: cycle,
      addressId: addressId || null,
      stripeErrorType: error?.type || null,
      stripeErrorCode: error?.code || null,
      message: error?.message || "Unknown Stripe checkout error",
    });
    return res.status(500).json({
      message: "Unable to start secure checkout right now. Please try again.",
      code: "CHECKOUT_SESSION_CREATE_FAILED",
    });
  }
});

module.exports = router;
