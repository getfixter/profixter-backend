const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();

const auth = require("../middleware/auth");
const GiftMembership = require("../models/GiftMembership");
const User = require("../models/User");
const { normalizeEmail } = require("../utils/identity");
const {
  giftsEnabled,
  isOfferedDuration,
  offeredDurations,
} = require("../utils/gifts/giftConfig");
const { findGiftTimeline, giftAccessState } = require("../utils/gifts/giftAccess");
const { readClaimToken, verifyClaimToken } = require("../utils/gifts/giftClaimToken");
const {
  claimGift,
  claimantMatches,
  validateGiftPurchase,
} = require("../utils/gifts/giftService");
const { PLAN_NAMES, formatTermDate, quoteGift, stripeLineItem } = require("../utils/gifts/giftPricing");
const {
  giftProductId,
  giftProductStatus,
  giftProductStatusReason,
  giftTaxCode,
} = require("../utils/gifts/giftProducts");
const {
  stripe,
  hasStripeSecretKey,
  resolveUserStripeCustomerId,
} = require("../utils/subscriptionManagement");

const CLIENT_URL = process.env.CLIENT_URL || "https://www.profixter.com";

/**
 * Buying and claiming gift memberships.
 *
 * Two things are true of every handler here and are worth stating once rather
 * than at each one:
 *
 *   - Nothing becomes customer-visible while GIFTS_ENABLED is not "true". The
 *     gate is at the top of each route, not in the UI, so an unreleased
 *     feature cannot be reached by anybody who guesses the URL.
 *   - No handler writes to a Subscription, and no handler puts a Stripe
 *     customer id on a gift. That is what keeps the purchaser's card out of
 *     the recipient's reach; see models/GiftMembership.
 */

/**
 * Refuse the purchase flow unless the four gift Products are configured.
 *
 * FAIL CLOSED, ON THE SELLING PATH ONLY.
 *
 * Selling against a missing, malformed or wrong Product is worse than not
 * selling: a gift billed under the recurring membership product would fold
 * into membership reporting and inherit every coupon restricted to it. So the
 * two routes that lead to money — the options screen and checkout — stop here
 * rather than quietly falling back to a throwaway product.
 *
 * Claiming, listing and reading a gift are deliberately NOT gated. They touch
 * no Stripe Product, and a configuration mistake must never strand somebody
 * who already holds a gift that was paid for.
 *
 * Returns true when it has answered the request.
 */
function refuseUnlessProductsConfigured(res, where) {
  const status = giftProductStatus();
  if (status.ok) return false;

  console.error(
    JSON.stringify({
      event: "gift_products_not_configured",
      where,
      reason: giftProductStatusReason(status),
      missing: status.missing,
      invalid: status.invalid,
      reused: status.reused,
      duplicated: status.duplicated,
    })
  );

  res.status(503).json({
    message: "Gift memberships are temporarily unavailable.",
    code: "GIFT_PRODUCTS_NOT_CONFIGURED",
  });
  return true;
}

function featureGate(req, res, next) {
  if (!giftsEnabled()) {
    return res.status(404).json({ message: "Not found" });
  }
  return next();
}

router.use(featureGate);

/*
 * The selling routes, refused before anything else happens.
 *
 * Mounted ahead of `auth` on purpose. A server that cannot sell correctly
 * should say so without first opening a database connection to find out who is
 * asking — and it makes the guarantee checkable on its own, rather than only
 * for a request that already has a valid session behind it.
 *
 * Order matters: featureGate above answers first, so "switched off" reads as
 * 404 and "switched on but misconfigured" reads as 503. Those are genuinely
 * different states and operators need to tell them apart.
 */
router.use(["/options", "/checkout-session"], (req, res, next) => {
  if (refuseUnlessProductsConfigured(res, req.path.replace(/^\//, "") || "selling")) return;
  return next();
});

/** Why a purchase was refused, in words a purchase screen can show. */
const PURCHASE_ERRORS = {
  unknown_plan: "Choose a membership plan.",
  unsupported_duration: "That gift length is not available.",
  plan_has_no_price: "That plan is not available for gifting right now.",
  invalid_recipient_email: "Enter a valid email address for the recipient.",
  self_gift_not_allowed:
    "A gift has to be for someone else. To start your own membership, choose a plan from your account.",
};

/* -------------------------------------------------------------------------- */
/* Options and quoting                                                         */
/* -------------------------------------------------------------------------- */

/**
 * What can be gifted, and what it costs.
 *
 * Prices come from the live plan catalogue every time rather than being baked
 * into the client, so a price change is picked up without a frontend deploy
 * and the quote on screen cannot disagree with the amount charged.
 */
router.get("/options", auth, async (_req, res) => {
  try {
    const durations = offeredDurations();
    const plans = PLAN_NAMES.map((plan) => {
      const quotes = durations
        .map((months) => quoteGift({ plan, durationMonths: months }))
        .filter((quote) => quote.ok)
        .map((quote) => ({
          durationMonths: quote.durationMonths,
          totalCents: quote.totalCents,
          perMonthCents: quote.perMonthCents,
        }));
      return { plan, label: plan.charAt(0).toUpperCase() + plan.slice(1), quotes };
    });

    return res.json({ plans, durations, currency: "usd" });
  } catch (error) {
    console.error("GET /gifts/options failed:", error);
    return res.status(500).json({ message: "Unable to load gift options" });
  }
});

/* -------------------------------------------------------------------------- */
/* Purchase                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Open Stripe Checkout for a gift.
 *
 * mode: "payment" — a single charge that creates no subscription, no schedule
 * and no billing relationship. This is the load-bearing choice: a subscription
 * here would put the purchaser on a renewing charge and give the recipient
 * something to resume.
 *
 * NOTHING IS WRITTEN TO THE DATABASE HERE. The gift is created by the webhook
 * once Stripe confirms payment, so an abandoned checkout leaves no record and
 * a browser that lies about success gets nothing.
 */
router.post("/checkout-session", auth, async (req, res) => {
  try {
    if (!hasStripeSecretKey()) {
      return res.status(503).json({ message: "Payments are unavailable right now" });
    }

    const purchaser = await User.findById(req.user.id);
    if (!purchaser) return res.status(404).json({ message: "User not found" });

    const { plan, durationMonths, recipient = {}, address = {} } = req.body || {};

    if (!isOfferedDuration(durationMonths)) {
      return res.status(400).json({
        message: PURCHASE_ERRORS.unsupported_duration,
        code: "UNSUPPORTED_DURATION",
      });
    }

    const validation = await validateGiftPurchase({
      purchaser,
      plan,
      durationMonths,
      recipientEmail: recipient.email,
    });
    if (!validation.ok) {
      return res.status(400).json({
        message: PURCHASE_ERRORS[validation.reason] || "That gift cannot be purchased.",
        code: validation.reason.toUpperCase(),
      });
    }

    const lineItem = stripeLineItem({
      plan: validation.plan,
      durationMonths: Number(durationMonths),
      productId: giftProductId(validation.plan),
      taxCode: giftTaxCode(),
    });
    if (!lineItem) {
      return res.status(400).json({ message: PURCHASE_ERRORS.unknown_plan });
    }

    /*
     * The purchaser's own Stripe customer, used once to take one payment —
     * exactly as the One-Time Visit and Full Day purchases already do. It is
     * carried on the SESSION so the charge lands on the right customer, and it
     * is never written onto the gift.
     */
    const stripeCustomerId = await resolveUserStripeCustomerId(purchaser);

    const metadata = {
      productKind: "gift_membership",
      plan: validation.plan,
      durationMonths: String(durationMonths),
      purchaserMongoId: String(purchaser._id),
      purchaserUserId: String(purchaser.userId || purchaser._id),
      recipientEmail: validation.recipientEmail,
      recipientFirstName: String(recipient.firstName || "").slice(0, 80),
      recipientLastName: String(recipient.lastName || "").slice(0, 80),
      addressLine1: String(address.line1 || "").slice(0, 200),
      addressCity: String(address.city || "").slice(0, 100),
      addressState: String(address.state || "").slice(0, 40),
      addressZip: String(address.zip || "").slice(0, 20),
    };

    const sessionConfig = {
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [lineItem],
      // Stripe validates eligibility, expiry, redemption limits and any
      // product restrictions itself. Nothing about codes is reimplemented here.
      allow_promotion_codes: true,
      /*
       * Every ProFixter service charges tax the same way, so a gift does too.
       *
       * Stripe computes it from the purchaser's billing address at checkout
       * and reports the authoritative figures back on the completed session;
       * we never calculate tax ourselves and never accept a total from the
       * browser. Discount-before-tax ordering is Stripe's to decide, which is
       * the correct place for it to be decided.
       *
       * This does NOT make the gift recurring. Automatic tax is orthogonal to
       * mode: the charge is still a single payment against an inline amount
       * with no `recurring` block anywhere in it.
       */
      automatic_tax: { enabled: true },
      metadata,
      payment_intent_data: { metadata },
      success_url: `${CLIENT_URL}/gift/confirmation?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${CLIENT_URL}/gift?canceled=true`,
    };

    if (stripeCustomerId) {
      sessionConfig.customer = stripeCustomerId;
      /*
       * Automatic tax needs an address on the customer. Without this, a
       * purchaser whose Stripe customer has none is refused by Stripe at
       * session creation rather than being asked for one at checkout.
       */
      sessionConfig.customer_update = { address: "auto" };
    } else {
      sessionConfig.customer_email = purchaser.email;
    }

    const session = await stripe.checkout.sessions.create(sessionConfig);
    if (!session?.url) {
      return res.status(502).json({ message: "Checkout could not be opened. Please try again." });
    }

    console.log(
      JSON.stringify({
        event: "gift_checkout_created",
        stripeSessionId: session.id,
        plan: validation.plan,
        durationMonths: Number(durationMonths),
        totalCents: validation.quote.totalCents,
      })
    );

    return res.json({ url: session.url, sessionId: session.id });
  } catch (error) {
    console.error("POST /gifts/checkout-session failed:", error);
    return res.status(500).json({ message: "Unable to start gift checkout" });
  }
});

/** Gifts this person has bought, and where each one has got to. */
router.get("/purchased", auth, async (req, res) => {
  try {
    const gifts = await GiftMembership.find({ purchaser: req.user.id })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    return res.json({
      gifts: gifts.map((gift) => ({
        giftNumber: gift.giftNumber,
        plan: gift.plan,
        durationMonths: gift.durationMonths,
        recipientEmail: gift.recipientEmail,
        recipientName: `${gift.recipientFirstName} ${gift.recipientLastName}`.trim(),
        status: gift.status,
        state: giftAccessState(gift).state,
        amountPaidCents: gift.amountPaidCents,
        refundStatus: gift.refundStatus,
        purchasedAt: gift.purchasedAt,
        claimedAt: gift.claimedAt,
        startAt: gift.startAt,
        endAt: gift.endAt,
      })),
    });
  } catch (error) {
    console.error("GET /gifts/purchased failed:", error);
    return res.status(500).json({ message: "Unable to load your gifts" });
  }
});

/* -------------------------------------------------------------------------- */
/* Claim                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * What a claim link points at, before anybody signs in.
 *
 * Public, because the recipient may not have an account yet and being asked to
 * register before being told what they are registering for is a bad trade.
 *
 * Returns only what the invitation email already said: who it is from, which
 * plan, how long. No identifiers, no purchaser email, no amounts.
 */
router.get("/claim/:token", async (req, res) => {
  try {
    const read = readClaimToken(req.params.token);

    if (!read.ok && read.reason !== "expired") {
      return res.status(404).json({ message: "This gift link is not valid.", code: "INVALID" });
    }

    const gift = await GiftMembership.findById(read.giftId).lean();
    if (!gift) {
      return res.status(404).json({ message: "This gift link is not valid.", code: "INVALID" });
    }

    /*
     * An expired link is NOT a lost gift, and the wording has to make that
     * unmistakable. The money was paid, the gift is intact, and Admin can send
     * a fresh link — so this says so rather than showing a dead end.
     */
    if (!read.ok && read.reason === "expired") {
      return res.status(410).json({
        code: "LINK_EXPIRED",
        message:
          "This invitation link has expired for security, but the gift is still yours. " +
          "Contact ProFixter and we will send you a fresh link.",
        gift: { plan: gift.plan, durationMonths: gift.durationMonths, from: gift.purchaserSnapshot?.name || "" },
      });
    }

    const verdict = verifyClaimToken(req.params.token, gift);
    if (!verdict.ok) {
      const superseded = verdict.reason === "superseded";
      return res.status(superseded ? 410 : 404).json({
        code: superseded ? "LINK_SUPERSEDED" : "INVALID",
        message: superseded
          ? "A newer invitation was sent for this gift. Please use the most recent email."
          : "This gift link is not valid.",
      });
    }

    if (gift.status === "claimed") {
      return res.status(409).json({ code: "ALREADY_CLAIMED", message: "This gift has already been claimed." });
    }
    if (gift.status === "cancelled") {
      return res.status(409).json({ code: "CANCELLED", message: "This gift is no longer available." });
    }

    const existingAccount = await User.exists({
      email: gift.recipientEmail,
      role: { $ne: "employee" },
    });

    return res.json({
      gift: {
        plan: gift.plan,
        durationMonths: gift.durationMonths,
        from: gift.purchaserSnapshot?.name || "",
        recipientEmail: gift.recipientEmail,
        recipientFirstName: gift.recipientFirstName,
        addressSnapshot: gift.addressSnapshot,
      },
      // Lets the claim screen send them to sign-in or registration without
      // making them find out by failing.
      hasAccount: Boolean(existingAccount),
    });
  } catch (error) {
    console.error("GET /gifts/claim/:token failed:", error);
    return res.status(500).json({ message: "Unable to load this gift" });
  }
});

/**
 * Claim a gift onto the signed-in account.
 *
 * The email guard is the whole security of this endpoint. A claim link travels
 * — forwarded, screenshotted, sitting in a shared inbox — so holding one is
 * not evidence of being the intended recipient. Checked server-side, always.
 */
router.post("/claim/:token", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    const read = readClaimToken(req.params.token);
    if (!read.ok) {
      return res.status(read.reason === "expired" ? 410 : 404).json({
        code: read.reason === "expired" ? "LINK_EXPIRED" : "INVALID",
        message:
          read.reason === "expired"
            ? "This invitation link has expired, but the gift is still yours. Contact ProFixter for a fresh link."
            : "This gift link is not valid.",
      });
    }

    const gift = await GiftMembership.findById(read.giftId);
    if (!gift) return res.status(404).json({ message: "This gift link is not valid." });

    const verdict = verifyClaimToken(req.params.token, gift);
    if (!verdict.ok) {
      return res.status(410).json({
        code: verdict.reason === "superseded" ? "LINK_SUPERSEDED" : "INVALID",
        message:
          verdict.reason === "superseded"
            ? "A newer invitation was sent for this gift. Please use the most recent email."
            : "This gift link is not valid.",
      });
    }

    if (!claimantMatches(gift, user)) {
      console.warn(
        JSON.stringify({
          event: "gift_claim_recipient_mismatch",
          giftNumber: gift.giftNumber,
          attemptedBy: String(user._id),
        })
      );
      return res.status(403).json({
        code: "RECIPIENT_MISMATCH",
        message:
          "This gift was sent to a different email address. Sign in with the address the invitation was sent to.",
      });
    }

    /*
     * The recipient confirms the property on their OWN account. The address the
     * purchaser typed is a suggestion the claim screen shows; it is never
     * written into somebody else's record, because addresses live inside the
     * User document and writing there would mean editing another person's
     * account.
     */
    const { addressId } = req.body || {};
    if (!addressId || !mongoose.isValidObjectId(addressId)) {
      return res.status(400).json({
        code: "ADDRESS_REQUIRED",
        message: "Choose which property this membership is for.",
      });
    }
    const address = (user.addresses || []).find((a) => String(a._id) === String(addressId));
    if (!address) {
      return res.status(400).json({ code: "ADDRESS_NOT_FOUND", message: "That property is not on your account." });
    }

    const result = await claimGift({ gift, user, addressId: address._id });
    if (!result.ok) {
      const statuses = { already_claimed: 409, gift_cancelled: 409, recipient_mismatch: 403 };
      return res.status(statuses[result.reason] || 400).json({
        code: result.reason.toUpperCase(),
        message:
          result.reason === "already_claimed"
            ? "This gift has already been claimed."
            : "This gift could not be claimed.",
      });
    }

    console.log(
      JSON.stringify({
        event: "gift_claimed",
        giftNumber: gift.giftNumber,
        queued: result.queued,
        startAt: result.gift.startAt,
        endAt: result.gift.endAt,
      })
    );

    return res.json({
      message: result.queued
        ? "Your gift is saved and will begin when your current membership ends."
        : "Your gift membership is active.",
      gift: {
        plan: result.gift.plan,
        durationMonths: result.gift.durationMonths,
        from: result.gift.purchaserSnapshot?.name || "",
        startAt: result.gift.startAt,
        endAt: result.gift.endAt,
        activeThrough: formatTermDate(result.gift.endAt),
        queued: result.queued,
      },
    });
  } catch (error) {
    console.error("POST /gifts/claim/:token failed:", error);
    return res.status(500).json({ message: "Unable to claim this gift" });
  }
});

/** What this person holds: running now, queued behind it, and finished. */
router.get("/mine", auth, async (req, res) => {
  try {
    const { addressId } = req.query;
    const timeline = await findGiftTimeline(
      req.user.id,
      addressId && mongoose.isValidObjectId(addressId) ? addressId : null
    );

    const shape = (gift) =>
      gift && {
        giftNumber: gift.giftNumber,
        plan: gift.plan,
        durationMonths: gift.durationMonths,
        from: gift.purchaserSnapshot?.name || "",
        startAt: gift.startAt,
        endAt: gift.endAt,
        activeThrough: formatTermDate(gift.endAt),
        state: gift.state,
      };

    return res.json({
      active: shape(timeline.active),
      queued: timeline.queued.map(shape),
      expired: timeline.expired.map(shape),
      /*
       * Stated explicitly so the account screen never has to infer it. A gift
       * membership has no billing to manage, so none of those controls should
       * be drawn — and the endpoints behind them refuse independently.
       */
      billingActionsAvailable: false,
    });
  } catch (error) {
    console.error("GET /gifts/mine failed:", error);
    return res.status(500).json({ message: "Unable to load your gift membership" });
  }
});

module.exports = router;
