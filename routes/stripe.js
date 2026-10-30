const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const { CLIENT_URL, CheckoutRefusal, openMembershipCheckout } = require("../utils/membershipCheckout");

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

/*
 * The customer's own "Buy". Every protection against billing a home twice
 * lives in utils/membershipCheckout.js, which Admin's phone sales and payment
 * links use too; this route only supplies who is buying and their tracking.
 */
router.post("/create-checkout-session", auth, async (req, res) => {
  const { plan, addressId, billingCycle } = req.body;
  try {
    const { session, eventId, trialEndUnix } = await openMembershipCheckout({
      userId: req.user.id,
      plan,
      billingCycle,
      addressId,
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
