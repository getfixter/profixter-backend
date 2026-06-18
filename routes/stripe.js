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
  const { plan, addressId, code, billingCycle } = req.body;
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
    hasPromoCode: !!code,
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

    let promoCodeId = null;
    if (code) {
      const promo = await stripe.promotionCodes.list({
        code,
        active: true,
        limit: 1,
      });
      if (promo.data[0]) {
        promoCodeId = promo.data[0].id;
      }
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

    const stripeCustomerId = await resolveUserStripeCustomerId(user);
    const sessionConfig = {
      mode: "subscription",
      payment_method_types: ["card"],
      client_reference_id: String(addressId),
      line_items: [{ price: priceId, quantity: 1 }],
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
        },
      },
      automatic_tax: { enabled: true },
      success_url: `${CLIENT_URL}/confirmationpage?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${CLIENT_URL}/?canceled=true&plan=${plan}&billingCycle=${cycle}`,
    };

    if (promoCodeId) {
      sessionConfig.discounts = [{ promotion_code: promoCodeId }];
    }

    if (stripeCustomerId) {
      sessionConfig.customer = stripeCustomerId;
    } else {
      sessionConfig.customer_email = email;
    }

    console.log('STRIPE_SESSION_CONFIG', JSON.stringify(sessionConfig, null, 2));
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
    });
    return res.status(200).json({ url: session.url, eventId, sessionId: session.id });
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
