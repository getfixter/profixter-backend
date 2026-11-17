/*
 * "Upgrade to a handyman visit": the customer's own free visit, from its card
 * in My Visits, becomes a membership or One-Time visit once they pay
 * (utils/freeVisit/conversion.js customerUpgradeOptions, startCustomerUpgrade).
 *
 * Signed in only, and only the account the visit is on. A guest's visit gets
 * to their account when they sign in with a code to the phone or email they
 * booked with (utils/freeVisit/guestLink.js).
 *
 *   GET  /api/visit-upgrade/:bookingId           the sheet: offers, terms, status
 *   GET  /api/visit-upgrade/:bookingId/payment   after Stripe: the payment's verified state (customerPaymentStatus)
 *   POST /api/visit-upgrade/:bookingId/checkout  { kind, plan?, billingCycle?, acceptTerms, termsVersion, welcomeOffer?, fbp?, fbc?, sourceUrl? } -> { url }
 */
const express = require("express");
const auth = require("../middleware/auth");
const User = require("../models/User");
const conversion = require("../utils/freeVisit/conversion");
const { browserIdsFrom } = require("../utils/metaBrowserIds");
const { rateLimit } = require("../utils/rateLimit");

const router = express.Router();

function clientIp(req) {
  const forwardedFor = req.headers["x-forwarded-for"];
  if (forwardedFor) return String(forwardedFor).split(",")[0].trim();
  return req.socket?.remoteAddress || "";
}

/* Per account: a person pressing Continue a few times is fine; a script is not. */
const checkoutLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, keyResolver: (req) => `visit_upgrade:${req.user?.id || clientIp(req)}` });

function fail(res, error, fallback) {
  if (error instanceof conversion.ConversionError) {
    return res.status(error.status || 409).json({ code: error.code, message: error.message, ...(error.extra || {}) });
  }
  console.error("visit upgrade error:", error);
  return res.status(500).json({ code: "UPGRADE_ERROR", message: fallback });
}

async function customer(req, res) {
  const user = await User.findById(req.user.id);
  if (!user || (user.role && user.role !== "customer")) {
    res.status(404).json({ code: "BOOKING_NOT_FOUND", message: "This visit was not found." });
    return null;
  }
  return user;
}

router.get("/:bookingId", auth, async (req, res) => {
  try {
    const user = await customer(req, res);
    if (!user) return;
    return res.json(await conversion.customerUpgradeOptions({ bookingId: req.params.bookingId, user }));
  } catch (error) {
    return fail(res, error, "We couldn't load the upgrade options. Please try again.");
  }
});

/* Polled for a short while after Stripe; each poll may ask Stripe, so it is limited too. */
const statusLimit = rateLimit({ windowMs: 5 * 60 * 1000, limit: 60, keyResolver: (req) => `visit_upgrade_status:${req.user?.id || clientIp(req)}` });

router.get("/:bookingId/payment", auth, statusLimit, async (req, res) => {
  try {
    const user = await customer(req, res);
    if (!user) return;
    res.set("Cache-Control", "no-store");
    return res.json(await conversion.customerPaymentStatus({ bookingId: req.params.bookingId, user }));
  } catch (error) {
    return fail(res, error, "We couldn't check the payment just now.");
  }
});

router.post("/:bookingId/checkout", auth, checkoutLimit, async (req, res) => {
  try {
    const user = await customer(req, res);
    if (!user) return;
    const body = req.body || {};
    const ids = browserIdsFrom(body);
    const result = await conversion.startCustomerUpgrade({
      bookingId: req.params.bookingId,
      user,
      kind: String(body.kind || ""),
      plan: String(body.plan || ""),
      billingCycle: String(body.billingCycle || ""),
      acceptTerms: body.acceptTerms === true,
      termsVersion: String(body.termsVersion || ""),
      expectsWelcome: body.welcomeOffer === true,
      tracking: {
        fbp: ids.fbp,
        fbc: ids.fbc,
        sourceUrl: ids.sourceUrl || req.headers.referer || "",
        clientIp: clientIp(req),
        userAgent: req.headers["user-agent"] || "",
      },
      req,
    });
    return res.json({ url: result.url, welcomeOfferApplied: Boolean(result.welcomeOfferApplied) });
  } catch (error) {
    return fail(res, error, "We couldn't open the secure checkout. Please try again.");
  }
});

module.exports = router;
