const mongoose = require("mongoose");
const User = require("../models/User");
const Subscription = require("../models/Subscription");
const { contactRequiredBody, missingBookingContact } = require("./bookingContact");
const {
  stripe,
  hasStripeSecretKey,
  resolveStripePriceId,
  normalizeBillingCycle,
  resolveUserStripeCustomerId,
  billingStripeSubscriptionsForAddress,
  PAYMENT_RECOVERY_STATUSES,
} = require("./subscriptionManagement");
const { projectedGiftCoverageEnd } = require("./gifts/giftAccess");

/**
 * Open a Stripe Checkout for one membership at one home.
 *
 * THE ONLY WAY A MEMBERSHIP CHECKOUT IS OPENED: the customer's own "Buy"
 * (routes/stripe.js), Admin's "Pay by phone" and an Admin payment link
 * (routes/adminSales.js, routes/pay.js) all come through here, so every one
 * of them is held to the same protections against billing a home twice:
 *
 *  - a local active/trialing membership at the home refuses (409);
 *  - Stripe itself is asked whether it is still billing the home (our records
 *    are what can be wrong); past_due/unpaid sends them to fix that payment;
 *  - one checkout opening at a time per account (short, self-expiring lock);
 *  - any earlier checkout for the home still open at Stripe is closed first;
 *  - billing is deferred over gift coverage, never charged on top of it.
 *
 * Activation is not here and never manual: the Stripe webhook does it from
 * the subscription's metadata, exactly as for any customer purchase.
 *
 * Throws CheckoutRefusal { status, body } for every refusal, so each caller
 * can answer in its own words while the decision stays in one place.
 */

const CLIENT_URL = process.env.CLIENT_URL || "https://www.profixter.com";
const CHECKOUT_LOCK_MS = 20 * 1000;

class CheckoutRefusal extends Error {
  constructor(status, body) {
    super(body?.message || "Checkout refused");
    this.status = status;
    this.body = body;
  }
}

function logCheckout(level, event, details = {}) {
  const payload = JSON.stringify({ level, event, scope: "stripe_checkout", ...details });
  if (level === "error") console.error(payload);
  else if (level === "warn") console.warn(payload);
  else console.log(payload);
}

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

/**
 * Whether a home can be sold a membership right now, without opening
 * anything. Used to refuse early (and to grey out Admin's button) - the
 * real decision is made again inside openMembershipCheckout.
 */
async function membershipSaleCheck({ user, addressId }) {
  const address = user.addresses?.id ? user.addresses.id(addressId) : (user.addresses || []).find((a) => String(a._id) === String(addressId));
  if (!address) return { refusal: { status: 400, body: { message: "Address not found for this account", code: "ADDRESS_NOT_FOUND" } } };
  const activeSub = await Subscription.findOne({
    user: user._id,
    addressId: new mongoose.Types.ObjectId(String(addressId)),
    status: { $in: ["active", "trialing"] },
  }).lean();
  if (activeSub) {
    return { refusal: { status: 409, body: { message: "This address already has an active plan.", code: "ADDRESS_ALREADY_SUBSCRIBED" } } };
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
  const billing = await billingStripeSubscriptionsForAddress({ stripeCustomerId, addressId: address._id });
  if (billing.some((s) => !PAYMENT_RECOVERY_STATUSES.has(s.status))) {
    return { stripeCustomerId, refusal: { status: 409, body: { message: "This address already has an active plan.", code: "ADDRESS_ALREADY_SUBSCRIBED" } } };
  }
  if (billing.length) {
    return {
      stripeCustomerId,
      refusal: {
        status: 409,
        body: {
          message:
            "This home's membership payment needs attention. Update your payment to keep your membership; there is no need to buy a new one.",
          code: "MEMBERSHIP_PAYMENT_RECOVERY_REQUIRED",
          addressId: String(address._id),
        },
      },
    };
  }
  return { stripeCustomerId, refusal: null };
}

/** Just the refusal, or null: for screens that grey out a button. */
async function membershipSaleBlocker({ user, addressId }) {
  return (await membershipSaleCheck({ user, addressId })).refusal;
}

/**
 * @param {object} args
 * @param {string} args.userId        Mongo _id of the customer
 * @param {string} args.plan
 * @param {string} args.billingCycle
 * @param {string} args.addressId
 * @param {object} [args.tracking]    { fbp, fbc, sourceUrl, clientIp, userAgent } for Meta, customer purchases only
 * @param {string} [args.successUrl]  defaults to the customer confirmation page
 * @param {string} [args.cancelUrl]   defaults to the plans page
 * @param {object} [args.metadata]    extra session metadata (e.g. adminInitiated)
 * @param {number} [args.expiresAt]   unix seconds; Stripe allows 30 min - 24 h
 * @returns {{ session, eventId, trialEndUnix }}
 */
async function openMembershipCheckout({
  userId,
  plan,
  billingCycle,
  addressId,
  tracking = null,
  successUrl = null,
  cancelUrl = null,
  metadata: extraMetadata = {},
  expiresAt = null,
  requestId = `checkout_${Date.now()}_${Math.random().toString(16).slice(2)}`,
}) {
  const cycle = normalizeBillingCycle(billingCycle, "monthly");
  const priceResolution = await resolveStripePriceId({ plan, billingCycle: cycle });
  const priceId = priceResolution.priceId;

  logCheckout("info", "subscription_checkout_start", {
    requestId,
    userId: userId || null,
    plan: plan || null,
    billingCycle: cycle,
    priceResolutionSource: priceResolution.source || null,
    priceFound: !!priceId,
    hasAddressId: !!addressId,
    adminInitiated: !!extraMetadata.adminInitiated,
  });

  if (!hasStripeSecretKey()) {
    logCheckout("error", "subscription_checkout_config_missing", { requestId, missing: ["STRIPE_SECRET_KEY"] });
    throw new CheckoutRefusal(503, {
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
    throw new CheckoutRefusal(400, { message: "Unable to map the requested plan", code: "PRICE_MAPPING_NOT_FOUND" });
  }

  if (!addressId || !mongoose.isValidObjectId(addressId)) {
    throw new CheckoutRefusal(400, { message: "Missing or invalid addressId" });
  }

  let lockHeld = false;
  let lockedUserId = null;
  try {
    const user = await User.findById(userId);
    if (!user) throw new CheckoutRefusal(404, { message: "User not found" });
    /*
     * A membership needs a way to reach the member: the receipt and renewal
     * emails, and the Fixter's call. Asked for at this step if missing, rather
     * than taken from whatever is typed at Stripe - an unverified email saved
     * onto the account could later be used to open it.
     */
    const missingContact = missingBookingContact(user);
    if (missingContact.length) throw new CheckoutRefusal(400, contactRequiredBody(missingContact));

    const email = user.email;
    const address = user.addresses.id(addressId);
    if (!address) throw new CheckoutRefusal(400, { message: "Address not found for this account" });

    const { refusal, stripeCustomerId } = await membershipSaleCheck({ user, addressId });
    if (refusal) throw new CheckoutRefusal(refusal.status, refusal.body);

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
      throw new CheckoutRefusal(409, {
        message: "Your secure checkout is already opening. Please wait a moment.",
        code: "CHECKOUT_ALREADY_OPENING",
      });
    }
    lockHeld = true;
    lockedUserId = user._id;
    await expireOpenMembershipCheckouts({ user, stripeCustomerId, addressId: String(address._id), requestId });

    const fbp = tracking?.fbp || null;
    const fbc = tracking?.fbc || null;
    const sourceUrl = tracking?.sourceUrl || `${CLIENT_URL}/`;
    const eventId = `px_${Date.now()}_${Math.random().toString(16).slice(2)}`;

    if (tracking) {
      await User.updateOne(
        { _id: user._id },
        {
          $set: {
            lastPurchase: {
              eventId,
              fbp,
              fbc,
              sourceUrl,
              clientIp: tracking.clientIp || "",
              userAgent: tracking.userAgent || "",
              phone: user.phone || null,
              updatedAt: new Date(),
            },
          },
        }
      );
    }

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
     * Stripe requires a trial to end far enough out to be meaningful, so a
     * gift ending within the floor below is rounded up rather than rejected.
     * That direction is deliberate: it can only ever delay the first charge
     * by hours, never bring it forward over covered days.
     */
    let giftCoverageEndsAt = null;
    try {
      giftCoverageEndsAt = await projectedGiftCoverageEnd(user._id, address._id, { now: new Date() });
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

    const extra = Object.fromEntries(Object.entries(extraMetadata || {}).map(([k, v]) => [k, String(v ?? "")]));
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
        ...extra,
      },
      subscription_data: {
        metadata: {
          plan,
          billingCycle: cycle,
          email,
          userId: String(user.userId || user._id),
          addressId: String(addressId),
          ...(trialEndUnix ? { giftCoverageUntil: String(trialEndUnix) } : {}),
          ...extra,
        },
        ...(trialEndUnix ? { trial_end: trialEndUnix } : {}),
      },
      automatic_tax: { enabled: true },
      success_url: successUrl || `${CLIENT_URL}/confirmationpage?session_id={CHECKOUT_SESSION_ID}`,
      /*
       * Back to the comparison, not to the homepage.
       *
       * Backing out of Stripe used to land on "/" carrying plan and
       * billingCycle in the query string - which nothing on the homepage read.
       * The customer was silently returned to the top of the funnel with their
       * choice discarded. The plans page restores the cycle and address from
       * these params and says plainly that nothing was charged.
       */
      cancel_url: cancelUrl || `${CLIENT_URL}/membership/plans?canceled=true&plan=${plan}&billingCycle=${cycle}`,
      ...(expiresAt ? { expires_at: expiresAt } : {}),
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
      throw new CheckoutRefusal(502, { message: "Secure checkout could not be opened. Please try again.", code: "CHECKOUT_URL_MISSING" });
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
      adminInitiated: !!extraMetadata.adminInitiated,
    });
    return { session, eventId, trialEndUnix };
  } catch (error) {
    if (error instanceof CheckoutRefusal) throw error;
    logCheckout("error", "subscription_checkout_session_failed", {
      requestId,
      userId: userId || null,
      plan: plan || null,
      billingCycle: cycle,
      addressId: addressId || null,
      stripeErrorType: error?.type || null,
      stripeErrorCode: error?.code || null,
      message: error?.message || "Unknown Stripe checkout error",
    });
    throw new CheckoutRefusal(500, {
      message: "Unable to start secure checkout right now. Please try again.",
      code: "CHECKOUT_SESSION_CREATE_FAILED",
    });
  } finally {
    if (lockHeld && lockedUserId) {
      await User.collection.updateOne({ _id: lockedUserId }, { $unset: { membershipCheckoutLock: "" } }).catch(() => {});
    }
  }
}

module.exports = {
  CLIENT_URL,
  CheckoutRefusal,
  expireOpenMembershipCheckouts,
  membershipSaleBlocker,
  openMembershipCheckout,
};
