/**
 * The public tip endpoint.
 *
 * Public by necessity: someone who just had a visit is not going to sign in to
 * leave twenty dollars, and asking them to would cost more tips than it could
 * ever protect. The token in the request is the only credential, and it proves
 * nothing except which booking the link was issued for - every substantive
 * value is looked up here.
 *
 * DEFENSIVENESS IS THE FEATURE
 * This route is allowed to fail to identify a Fixter. It is not allowed to fail
 * to take the money. A missing token, a tampered token, a deleted employee and
 * a booking that no longer exists all resolve to the same thing: a working
 * checkout whose tip lands in the admin's unassigned list.
 */

const express = require("express");
const mongoose = require("mongoose");
const User = require("../models/User");
const Booking = require("../models/Booking");
const { readTipToken } = require("../utils/tipToken");
const { createTipCheckoutSession, isEligibleFixter } = require("../utils/fixterTips");
const { rateLimit } = require("../utils/rateLimit");

const router = express.Router();

function logTip(level, event, details = {}) {
  const payload = JSON.stringify({ level, event, scope: "fixter_tip", ...details });
  if (level === "error") console.error(payload);
  else if (level === "warn") console.warn(payload);
  else console.log(payload);
}

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return String(forwarded).split(",")[0].trim();
  return req.socket?.remoteAddress || "";
}

function requestToken(req) {
  return String(req.body?.token || req.query?.token || "").trim();
}

/*
 * Two limits with different jobs. The token limit is the meaningful one: it
 * scopes attempts to a single tip link. The IP limit is deliberately loose,
 * because customers tip from phones behind carrier NAT and locking out a
 * stranger's tip would be the more expensive mistake.
 */
const perTokenLimit = rateLimit({
  limit: 10,
  windowMs: 10 * 60 * 1000,
  keyResolver: (req) => {
    const token = requestToken(req);
    return token ? `tip-token:${token.slice(0, 64)}` : null;
  },
  message: "Too many attempts for this tip link. Please try again in a few minutes.",
});

const perIpLimit = rateLimit({
  limit: 40,
  windowMs: 10 * 60 * 1000,
  keyResolver: (req) => {
    const ip = clientIp(req);
    return ip ? `tip-ip:${ip}` : null;
  },
  message: "Too many attempts from this connection. Please try again in a few minutes.",
});

function objectIdOrNull(value) {
  const text = String(value || "").trim();
  return mongoose.isValidObjectId(text) ? text : null;
}

/**
 * Turn an opaque token into the people it refers to.
 *
 * The Fixter comes from the token rather than from the booking's current
 * assignment: the token was issued when the visit was completed, so it names
 * whoever actually did the work even if the booking is reassigned afterwards.
 * The current assignment is used only when the token carries no Fixter at all.
 *
 * Never throws. Every failure is reported as missing context.
 */
async function resolveTipContext(token) {
  if (!token) return { fixter: null, booking: null, user: null, reason: "no_token" };

  let claims;
  try {
    claims = readTipToken(token);
  } catch (error) {
    return { fixter: null, booking: null, user: null, reason: "unreadable_token" };
  }

  let booking = null;
  const bookingId = objectIdOrNull(claims.bookingId);
  if (bookingId) {
    booking = await Booking.findById(bookingId)
      .select("_id bookingNumber name email user assignedFixterId")
      .lean();
  }

  const fixterId =
    objectIdOrNull(claims.fixterId) || objectIdOrNull(booking?.assignedFixterId);
  let fixter = null;
  if (fixterId) {
    fixter = await User.findById(fixterId)
      .select("_id name firstName role employeePosition isActive")
      .lean();
  }

  const userId = objectIdOrNull(claims.userId) || objectIdOrNull(booking?.user);
  let user = null;
  if (userId) {
    user = await User.findById(userId).select("_id name email role").lean();
  }

  if (!isEligibleFixter(fixter)) {
    return {
      fixter: null,
      booking,
      user,
      reason: fixterId ? "fixter_not_eligible" : "no_fixter",
    };
  }

  return { fixter, booking, user, reason: "" };
}

/**
 * Open a Stripe Checkout for a tip and hand back the URL.
 *
 * POST rather than GET on purpose: the page redirects with JavaScript, so link
 * scanners and inbox prefetchers never create Checkout Sessions just by
 * following the link in an email.
 */
router.post("/session", perTokenLimit, perIpLimit, async (req, res) => {
  const token = requestToken(req);

  let context = { fixter: null, booking: null, user: null, reason: "no_token" };
  try {
    context = await resolveTipContext(token);
  } catch (error) {
    // A lookup failure must not cost the tip; carry on unattributed.
    logTip("error", "tip_context_lookup_failed", { message: error?.message || "" });
    context = { fixter: null, booking: null, user: null, reason: "lookup_failed" };
  }

  try {
    const result = await createTipCheckoutSession({
      fixter: context.fixter,
      bookingId: context.booking?._id || "",
      userId: context.user?._id || "",
      prefillEmail: context.booking?.email || context.user?.email || "",
    });

    logTip("info", "tip_checkout_session_created", {
      stripeSessionId: result.sessionId,
      attributed: result.attributed,
      hasToken: !!token,
      reason: context.reason || null,
    });

    return res.json({ url: result.url, attributed: result.attributed });
  } catch (error) {
    logTip("error", "tip_checkout_session_failed", {
      hasToken: !!token,
      code: error?.code || null,
      message: error?.message || "Unknown tip checkout error",
    });
    return res.status(503).json({
      message:
        "We could not open the secure tip page just now. Please try again in a moment.",
      code: "TIP_CHECKOUT_UNAVAILABLE",
    });
  }
});

module.exports = router;
module.exports.resolveTipContext = resolveTipContext;
