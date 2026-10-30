const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const auth = require("../middleware/auth");
const User = require("../models/User");
const { contactRequiredBody, missingBookingContact } = require("../utils/bookingContact");
const Subscription = require("../models/Subscription");
const {
  stripe,
  hasStripeSecretKey,
  resolveStripePriceId,
  normalizeBillingCycle,
  resolveUserStripeCustomerId,
  billingStripeSubscriptionsForAddress,
  PAYMENT_RECOVERY_STATUSES,
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

const CHECKOUT_LOCK_MS = 20 * 1000;

/**
 * Close any membership checkout for this home still open at Stripe.
 *
 * Found two ways: the session this account last opened (which also covers a
 * first purchase, before Stripe has a customer to search by), and the
 * customer's open sessions. An expired session can no longer be paid. A
 * failure is logged, not fatal - the webhook's duplicate alert is the backstop.
 */
async function expireOpenMembershipCheckouts({ user, stripeCustomerId, addressId, requestId }) {
  const ids = new Set();
  const raw = (await User.collection.findOne({ _id: user._id }, { projection: { pendingMembershipCheckout: 1 } }))
    ?.pendingMembershipCheckout;
  if (raw?.sessionId && String(raw.addressId) === addressId) ids.add(String(raw.sessionId));
  try {
    if (stripeCustomerId) {
      const open = await stripe.checkout.sessions.list({ customer: String(stripeCustomerId), status: "open", limit: 20 });
      for (const session of open.data || []) {
        if (session.mode === "subscription" && String(session.metadata?.addressId || "") === addressId) ids.add(session.id);
      }
    }
    for (const id of ids) {
      const session = await stripe.checkout.sessions.retrieve(id);
      if (session?.status === "open") await stripe.checkout.sessions.expire(id);
    }
  } catch (error) {
    logCheckout("warn", "subscription_checkout_expire_previous_failed", {
      requestId,
      userId: String(user._id),
      message: error?.message || String(error),
    });
  }
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

  let lockHeld = false;
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "User not found" });
    /*
     * A membership needs a way to reach the member: the receipt and renewal
     * emails, and the Fixter's call. Asked for at this step if missing, rather
     * than taken from whatever is typed at Stripe - an unverified email saved
     * onto the account could later be used to open it.
     */
    const missingContact = missingBookingContact(user);
    if (missingContact.length) return res.status(400).json(contactRequiredBody(missingContact));

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

    /*
     * ONE MEMBERSHIP PER HOME THAT STRIPE IS STILL BILLING.
     *
     * Asked of Stripe, not of our records - our records are what can be wrong,
     * and a past-due membership is still a live subscription Stripe will keep
     * trying to charge. On 2026-10-30 a customer whose renewal had failed was
     * let through here, bought a second membership for the same home, and
     * Stripe was set to charge the first again two days later. A failed
     * renewal is fixed by paying it, so that is where they are sent.
     * Canceled and expired memberships are over and never block a fresh start.
     */
    const stripeCustomerId = await resolveUserStripeCustomerId(user);
    const billing = await billingStripeSubscriptionsForAddress({
      stripeCustomerId,
      addressId: address._id,
    });
    if (billing.some((s) => !PAYMENT_RECOVERY_STATUSES.has(s.status))) {
      return res.status(409).json({
        message: "This address already has an active plan.",
        code: "ADDRESS_ALREADY_SUBSCRIBED",
      });
    }
    if (billing.length) {
      return res.status(409).json({
        message: "This home's membership payment needs attention. Update your payment to keep your membership; there is no need to buy a new one.",
        code: "MEMBERSHIP_PAYMENT_RECOVERY_REQUIRED",
        addressId: String(address._id),
      });
    }

    /*
     * One checkout opening at a time per account (two taps, two tabs), and
     * any earlier membership checkout for this home still open at Stripe is
     * closed first. Otherwise both pages could be paid and the home billed
     * twice. The lock is short and self-expiring, so a crashed request can
     * never stop somebody buying.
     */
    const lockNow = new Date();
    const lock = await User.collection.updateOne(
      { _id: user._id, "membershipCheckoutLock.until": { $not: { $gt: lockNow } } },
      { $set: { membershipCheckoutLock: { until: new Date(lockNow.getTime() + CHECKOUT_LOCK_MS) } } }
    );
    if (!lock.modifiedCount) {
      return res.status(409).json({
        message: "Your secure checkout is already opening. Please wait a moment.",
        code: "CHECKOUT_ALREADY_OPENING",
      });
    }
    lockHeld = true;
    await expireOpenMembershipCheckouts({ user, stripeCustomerId, addressId: String(address._id), requestId });

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
      /*
       * Back to the comparison, not to the homepage.
       *
       * Backing out of Stripe used to land on "/" carrying plan and
       * billingCycle in the query string - which nothing on the homepage read.
       * The customer was silently returned to the top of the funnel with their
       * choice discarded. The plans page restores the cycle and address from
       * these params and says plainly that nothing was charged.
       */
      cancel_url: `${CLIENT_URL}/membership/plans?canceled=true&plan=${plan}&billingCycle=${cycle}`,
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

    await User.collection.updateOne(
      { _id: user._id },
      { $set: { pendingMembershipCheckout: { sessionId: session.id, addressId: String(addressId), createdAt: new Date() } } }
    );

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
  } finally {
    if (lockHeld) {
      await User.collection
        .updateOne({ _id: new mongoose.Types.ObjectId(String(req.user.id)) }, { $unset: { membershipCheckoutLock: "" } })
        .catch(() => {});
    }
  }
});

module.exports = router;
