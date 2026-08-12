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
const { readTipToken, readFixterChoiceToken } = require("../utils/tipToken");
const {
  createTipCheckoutSession,
  isEligibleFixter,
  isSelectableFixter,
  publicFixterList,
} = require("../utils/fixterTips");
const { rateLimit } = require("../utils/rateLimit");

/** Everything the chooser and the choice check need, and nothing more. */
const FIXTER_SELECT = "_id name firstName role employeePosition isActive";

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

function requestChoice(req) {
  return String(req.body?.choice || "").trim();
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
    fixter = await User.findById(fixterId).select(FIXTER_SELECT).lean();
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

/** Every Fixter a customer may currently choose to tip. */
async function loadSelectableFixters() {
  const employees = await User.find({ role: "employee", isActive: { $ne: false } })
    .select(FIXTER_SELECT)
    .lean();
  return publicFixterList(employees);
}

/**
 * Turn a choice token back into an employee.
 *
 * The token is a claim, not an authorisation. It proves only that this server
 * offered the name; the employee is loaded and revalidated here, so a Fixter
 * deactivated since the page was rendered cannot still be selected.
 *
 * Never throws.
 */
async function resolveChoice(choice) {
  if (!choice) return { fixter: null, reason: "no_choice" };

  let claims;
  try {
    claims = readFixterChoiceToken(choice);
  } catch {
    return { fixter: null, reason: "unreadable_choice" };
  }

  const fixterId = objectIdOrNull(claims.fixterId);
  if (!fixterId) return { fixter: null, reason: "no_fixter" };

  const fixter = await User.findById(fixterId).select(FIXTER_SELECT).lean();
  if (!isSelectableFixter(fixter)) {
    return { fixter: null, reason: "fixter_not_selectable" };
  }
  return { fixter, reason: "" };
}

/**
 * Who a customer can tip from the public page.
 *
 * Public and unauthenticated, like the page itself. It returns first names and
 * opaque handles: see publicFixterDTO for exactly what is and is not exposed.
 */
router.get("/fixters", perIpLimit, async (_req, res) => {
  try {
    return res.json({ fixters: await loadSelectableFixters() });
  } catch (error) {
    logTip("error", "tip_fixter_list_failed", { message: error?.message || "" });
    // An empty list is not an error to the customer: the page falls back to an
    // unattributed tip rather than refusing to take their money.
    return res.json({ fixters: [] });
  }
});

/**
 * Open a Stripe Checkout for a tip and hand back the URL.
 *
 * POST rather than GET on purpose: the page redirects with JavaScript, so link
 * scanners and inbox prefetchers never create Checkout Sessions just by
 * following the link in an email.
 *
 * Three ways in, and only the first two attribute:
 *   - a choice the customer made on the public page
 *   - a completion-email token, which already knows the Fixter
 *   - neither, which asks the page to show the chooser instead
 *
 * Falling back to the chooser is what a failed token now does. Attribution can
 * fail; the ability to tip must not. Only when there is nobody to choose from
 * does this open an unattributed checkout, because a customer with their card
 * out and nowhere to go is the one outcome worth avoiding at any cost.
 */
router.post("/session", perTokenLimit, perIpLimit, async (req, res) => {
  const token = requestToken(req);
  const choice = requestChoice(req);

  let context = { fixter: null, booking: null, user: null, reason: "no_token" };
  try {
    if (choice) {
      const chosen = await resolveChoice(choice);
      context = { fixter: chosen.fixter, booking: null, user: null, reason: chosen.reason };
    } else {
      context = await resolveTipContext(token);
    }
  } catch (error) {
    // A lookup failure must not cost the tip; carry on without attribution.
    logTip("error", "tip_context_lookup_failed", { message: error?.message || "" });
    context = { fixter: null, booking: null, user: null, reason: "lookup_failed" };
  }

  if (!context.fixter) {
    let choosable = [];
    try {
      choosable = await loadSelectableFixters();
    } catch (error) {
      logTip("error", "tip_fixter_list_failed", { message: error?.message || "" });
    }

    if (choosable.length) {
      logTip("info", "tip_chooser_required", {
        hasToken: !!token,
        hadChoice: !!choice,
        reason: context.reason || null,
        options: choosable.length,
      });
      return res.json({ needsChoice: true, fixters: choosable });
    }
    // Nobody to choose from. Take the tip unattributed rather than lose it.
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
      hadChoice: !!choice,
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
module.exports.resolveChoice = resolveChoice;
module.exports.loadSelectableFixters = loadSelectableFixters;
