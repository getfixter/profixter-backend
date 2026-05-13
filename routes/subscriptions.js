const express = require("express");
const mongoose = require("mongoose");
const auth = require("../middleware/auth");
const mail = require("../utils/emailService");
const User = require("../models/User");
const Subscription = require("../models/Subscription");
const {
  stripe,
  normalizePlanType,
  normalizeBillingCycle,
  getPriceId,
  classifyPlanChange,
  serializeSubscription,
  resolveStripeSubscriptionForRecord,
  applyStripeSubscriptionUpgrade,
  scheduleStripeSubscriptionDowngrade,
  upsertSubscriptionFromStripe,
  getOwnedSubscriptionForAddress,
  getStripeSubscriptionItemForRecord,
  clearStripeSubscriptionSchedule,
} = require("../utils/subscriptionManagement");

const router = express.Router();

async function getOwnedAddress(userId, addressId) {
  const user = await User.findById(userId);
  if (!user) return { user: null, address: null };
  const address = user.addresses?.id(addressId) || null;
  return { user, address };
}

router.get("/my", auth, async (req, res) => {
  try {
    const me = await User.findById(req.user.id);
    if (!me) return res.status(404).json({ message: "User not found" });

    const subs = await Subscription.find({ user: me._id }).sort({
      status: 1,
      currentPeriodEnd: 1,
      updatedAt: -1,
    });

    const addrMap = new Map();
    for (const address of me.addresses || []) {
      addrMap.set(String(address._id), address);
    }

    return res.json({
      subscriptions: subs.map((subscription) =>
        serializeSubscription(
          subscription,
          subscription.addressId ? addrMap.get(String(subscription.addressId)) || null : null
        )
      ),
    });
  } catch (err) {
    console.error("GET /subscriptions/my error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

router.get("/check/address/:addressId", auth, async (req, res) => {
  try {
    const { addressId } = req.params;
    if (!mongoose.isValidObjectId(addressId)) {
      return res.status(400).json({ message: "Invalid addressId" });
    }

    const { user, address } = await getOwnedAddress(req.user.id, addressId);
    if (!user) return res.status(404).json({ message: "User not found" });
    if (!address) return res.status(404).json({ message: "Address not found" });

    const activeSub = await getOwnedSubscriptionForAddress({
      userId: user._id,
      addressId: address._id,
      statuses: ["active", "trialing"],
    });

    if (!activeSub) return res.json({ active: false });

    return res.json({
      active: true,
      subscription: serializeSubscription(activeSub, address),
    });
  } catch (err) {
    console.error("GET /subscriptions/check/address error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

router.get("/manage/address/:addressId", auth, async (req, res) => {
  try {
    const { addressId } = req.params;
    if (!mongoose.isValidObjectId(addressId)) {
      return res.status(400).json({ message: "Invalid addressId" });
    }

    const { user, address } = await getOwnedAddress(req.user.id, addressId);
    if (!user) return res.status(404).json({ message: "User not found" });
    if (!address) return res.status(404).json({ message: "Address not found" });

    let subscription = await getOwnedSubscriptionForAddress({
      userId: user._id,
      addressId: address._id,
      statuses: ["active", "trialing"],
    });

    if (!subscription) {
      subscription = await getOwnedSubscriptionForAddress({
        userId: user._id,
        addressId: address._id,
        statuses: [
          "past_due",
          "unpaid",
          "incomplete",
          "canceled",
          "expired",
          "incomplete_expired",
        ],
      });
    }

    return res.json({
      subscription: subscription ? serializeSubscription(subscription, address) : null,
    });
  } catch (err) {
    console.error("GET /subscriptions/manage/address error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

router.patch("/manage/address/:addressId", auth, async (req, res) => {
  try {
    const { addressId } = req.params;
    const targetPlan = normalizePlanType(req.body?.plan);
    const requestedCycle = normalizeBillingCycle(req.body?.billingCycle, "monthly");

    if (!mongoose.isValidObjectId(addressId)) {
      return res.status(400).json({ message: "Invalid addressId" });
    }
    if (!targetPlan) {
      return res.status(400).json({ message: "Invalid target plan" });
    }

    const { user, address } = await getOwnedAddress(req.user.id, addressId);
    if (!user) return res.status(404).json({ message: "User not found" });
    if (!address) return res.status(404).json({ message: "Address not found" });

    const subscription = await getOwnedSubscriptionForAddress({
      userId: user._id,
      addressId: address._id,
      statuses: ["active", "trialing"],
    });

    if (!subscription) {
      return res.status(404).json({ message: "No active subscription found for this address" });
    }

    if (subscription.cancelAtPeriodEnd) {
      return res.status(409).json({
        message:
          "Cancellation is already scheduled for this subscription. Please keep the current plan or start a new subscription later.",
      });
    }

    if (
      String(subscription.subscriptionType || "").toLowerCase() === targetPlan &&
      normalizeBillingCycle(subscription.billingCycle, "monthly") === requestedCycle
    ) {
      return res.status(400).json({ message: "You are already on this plan" });
    }

    const stripeSubscription = await resolveStripeSubscriptionForRecord({ subscription, user });
    if (!stripeSubscription) {
      return res.status(409).json({
        message:
          "We could not safely link this older subscription to Stripe yet. This subscription is not ready for self-serve changes yet.",
      });
    }

    const item = getStripeSubscriptionItemForRecord({
      subscription,
      stripeSubscription,
    });
    if (!item?.id) {
      return res.status(409).json({ message: "Stripe subscription item not found" });
    }

    const nextPriceId = getPriceId(targetPlan, requestedCycle);
    if (!nextPriceId) {
      return res.status(400).json({ message: "Unable to map the requested plan" });
    }

    const changeType = classifyPlanChange({
      currentPlan: subscription.subscriptionType,
      currentBillingCycle: subscription.billingCycle,
      targetPlan,
      targetBillingCycle: requestedCycle,
    });

    let updatedStripeSubscription;
    if (changeType === "upgrade") {
      updatedStripeSubscription = await applyStripeSubscriptionUpgrade({
        stripeSubscription,
        subscription,
        user,
        addressId: String(address._id),
        nextPriceId,
      });
    } else {
      updatedStripeSubscription = await scheduleStripeSubscriptionDowngrade({
        stripeSubscription,
        subscription,
        user,
        addressId: String(address._id),
        nextPriceId,
      });
    }

    const updatedSubscription = await upsertSubscriptionFromStripe({
      stripeSubscription: updatedStripeSubscription,
      user,
      addressIdHint: String(address._id),
    });

    return res.json({
      message:
        changeType === "upgrade"
          ? "Plan updated successfully"
          : "Plan change scheduled for your next billing cycle",
      subscription: serializeSubscription(updatedSubscription, address),
    });
  } catch (err) {
    console.error("PATCH /subscriptions/manage/address error:", err);
    return res.status(err?.statusCode || 500).json({
      message: err?.message || "Unable to update plan right now",
    });
  }
});

router.post("/manage/address/:addressId/cancel", auth, async (req, res) => {
  try {
    const { addressId } = req.params;
    if (!mongoose.isValidObjectId(addressId)) {
      return res.status(400).json({ message: "Invalid addressId" });
    }

    const { user, address } = await getOwnedAddress(req.user.id, addressId);
    if (!user) return res.status(404).json({ message: "User not found" });
    if (!address) return res.status(404).json({ message: "Address not found" });

    const subscription = await getOwnedSubscriptionForAddress({
      userId: user._id,
      addressId: address._id,
      statuses: ["active", "trialing"],
    });

    if (!subscription) {
      return res.status(404).json({ message: "No active subscription found for this address" });
    }

    const stripeSubscription = await resolveStripeSubscriptionForRecord({ subscription, user });
    if (!stripeSubscription) {
      return res.status(409).json({
        message:
          "We could not safely link this older subscription to Stripe yet. This subscription is not ready for self-serve changes yet.",
      });
    }

    const activeStripeSubscription = await clearStripeSubscriptionSchedule(stripeSubscription);
    const cancellationTarget = activeStripeSubscription || stripeSubscription;

    const canceledStripeSubscription = await stripe.subscriptions.update(cancellationTarget.id, {
      cancel_at_period_end: true,
      metadata: {
        ...(cancellationTarget.metadata || {}),
        addressId: String(address._id),
        userId: String(user.userId || user._id),
        localSubscriptionId: String(subscription._id),
      },
      expand: ["items.data.price", "schedule"],
    });

    const updatedSubscription = await upsertSubscriptionFromStripe({
      stripeSubscription: canceledStripeSubscription,
      user,
      addressIdHint: String(address._id),
    });

    // Send cancellation scheduled email — self-serve path.
    // The webhook will skip this email because cancelAtPeriodEnd is already true locally.
    if (updatedSubscription?.cancelAtPeriodEnd) {
      try {
        const addrStr = updatedSubscription.addressSnapshot
          ? `${updatedSubscription.addressSnapshot.line1}, ${updatedSubscription.addressSnapshot.city}, ${updatedSubscription.addressSnapshot.state}`
          : null;
        await mail.sendTx("subscription_cancellation_scheduled", user.email, {
          name: user.name || user.email.split("@")[0],
          plan: (updatedSubscription.subscriptionType || "").replace(/^./, (c) => c.toUpperCase()),
          address: addrStr,
          accessEndDate: updatedSubscription.cancellationDate
            ? mail.formatNYCTime(updatedSubscription.cancellationDate.toISOString())
            : null,
        }, { bccAdmin: false });
      } catch (emailErr) {
        console.error("subscription_cancellation_scheduled email failed:", emailErr.message);
      }
    }

    return res.json({
      message: "Cancellation scheduled successfully",
      subscription: serializeSubscription(updatedSubscription, address),
    });
  } catch (err) {
    console.error("POST /subscriptions/manage/address/:addressId/cancel error:", err);
    return res.status(500).json({
      message: err?.message || "Unable to cancel subscription right now",
    });
  }
});

router.post("/manage/address/:addressId/reactivate", auth, async (req, res) => {
  try {
    const { addressId } = req.params;
    if (!mongoose.isValidObjectId(addressId)) {
      return res.status(400).json({ message: "Invalid addressId" });
    }

    const { user, address } = await getOwnedAddress(req.user.id, addressId);
    if (!user) return res.status(404).json({ message: "User not found" });
    if (!address) return res.status(404).json({ message: "Address not found" });

    const subscription = await getOwnedSubscriptionForAddress({
      userId: user._id,
      addressId: address._id,
      statuses: ["active", "trialing"],
    });

    if (!subscription) {
      return res.status(404).json({ message: "No active subscription found for this address" });
    }

    if (!subscription.cancelAtPeriodEnd) {
      return res.status(400).json({ message: "Subscription is not scheduled for cancellation" });
    }

    const stripeSubscription = await resolveStripeSubscriptionForRecord({ subscription, user });
    if (!stripeSubscription) {
      return res.status(409).json({
        message:
          "We could not safely link this subscription to Stripe. Please contact support.",
      });
    }

    const reactivatedStripeSubscription = await stripe.subscriptions.update(
      stripeSubscription.id,
      {
        cancel_at_period_end: false,
        cancel_at: "",
        expand: ["items.data.price", "schedule"],
      }
    );

    const updatedSubscription = await upsertSubscriptionFromStripe({
      stripeSubscription: reactivatedStripeSubscription,
      user,
      addressIdHint: String(address._id),
    });

    return res.json({
      message: "Subscription reactivated successfully",
      subscription: serializeSubscription(updatedSubscription, address),
    });
  } catch (err) {
    console.error("POST /subscriptions/manage/address/:addressId/reactivate error:", err);
    return res.status(500).json({
      message: err?.message || "Unable to reactivate subscription right now",
    });
  }
});

router.post("/create-billing-portal-session", auth, async (req, res) => {
  try {
    const { addressId } = req.body;

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    // Prefer stripeCustomerId on the User record; fall back to any linked subscription.
    let stripeCustomerId = user.stripeCustomerId || null;

    if (!stripeCustomerId) {
      const query = {
        user: user._id,
        stripeCustomerId: { $ne: null },
        ...(addressId && mongoose.isValidObjectId(addressId)
          ? { addressId: new mongoose.Types.ObjectId(addressId) }
          : {}),
      };
      const sub = await Subscription.findOne(query).sort({ updatedAt: -1 });
      if (sub) stripeCustomerId = sub.stripeCustomerId;
    }

    if (!stripeCustomerId) {
      return res.status(400).json({
        message: "No billing account found for this subscription. Please contact support.",
        code: "NO_STRIPE_CUSTOMER",
      });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: `${process.env.CLIENT_URL || "https://www.profixter.com"}/account?tab=plan`,
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error("POST /subscriptions/create-billing-portal-session error:", err);
    return res.status(500).json({ message: "Unable to open billing portal right now" });
  }
});

router.delete("/:id", auth, async (_req, res) => {
  return res.status(405).json({
    message:
      "Direct subscription deletion is disabled. Please use the managed cancellation flow instead.",
  });
});

router.post("/", auth, async (_req, res) => {
  return res.status(403).json({
    message: "Direct subscription creation is disabled. Please use the Stripe checkout process.",
  });
});

module.exports = router;
