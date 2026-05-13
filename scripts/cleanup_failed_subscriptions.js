require("dotenv").config();
const mongoose = require("mongoose");

const User = require("../models/User");
const Subscription = require("../models/Subscription");
const {
  stripe,
  resolveStripeSubscriptionForRecord,
  syncLegacyUserSubscription,
} = require("../utils/subscriptionManagement");

const FAILED_LOCAL_STATUSES = new Set(["past_due", "unpaid", "incomplete_expired"]);
const FAILED_STRIPE_STATUSES = new Set(["past_due", "unpaid", "incomplete_expired"]);
const SAFE_FINAL_STRIPE_STATUSES = new Set(["canceled", "incomplete_expired"]);
const DRY_RUN = !process.argv.includes("--write");

function nowIso() {
  return new Date().toISOString();
}

function formatErr(error) {
  return error?.message || String(error);
}

function serializeForReview(subscription, reason, extra = {}) {
  return {
    subscriptionId: String(subscription._id),
    userId: String(subscription.userId || ""),
    stripeSubscriptionId: subscription.stripeSubscriptionId || null,
    stripeCustomerId: subscription.stripeCustomerId || null,
    addressId: subscription.addressId ? String(subscription.addressId) : null,
    localStatus: subscription.status,
    cancellationReason: subscription.cancellationReason || null,
    reason,
    ...extra,
  };
}

async function getMongoUri() {
  return process.env.MONGO_URI || process.env.MONGODB_URI || null;
}

async function resolveStripeState(subscription, user) {
  if (subscription.stripeSubscriptionId) {
    try {
      const stripeSubscription = await stripe.subscriptions.retrieve(
        String(subscription.stripeSubscriptionId),
        { expand: ["items.data.price"] }
      );
      return { stripeSubscription, resolution: "direct" };
    } catch (error) {
      if (error?.statusCode === 404 || error?.code === "resource_missing") {
        return { stripeSubscription: null, resolution: "missing_in_stripe" };
      }
      throw error;
    }
  }

  const stripeSubscription = await resolveStripeSubscriptionForRecord({ subscription, user });
  if (!stripeSubscription) {
    return { stripeSubscription: null, resolution: "ambiguous_or_missing" };
  }

  return { stripeSubscription, resolution: "resolved" };
}

async function markLocalCanceled(subscription, when = new Date()) {
  subscription.status = "canceled";
  subscription.cancelAtPeriodEnd = false;
  subscription.cancellationDate = subscription.cancellationDate || when;
  subscription.cancellationReason = "payment_failed";

  if (!DRY_RUN) {
    await subscription.save();
    await syncLegacyUserSubscription(subscription.user);
  }
}

async function cancelStripeIfFailed(stripeSubscription) {
  const stripeStatus = String(stripeSubscription?.status || "").toLowerCase();

  if (SAFE_FINAL_STRIPE_STATUSES.has(stripeStatus)) {
    return { stripeSubscription, action: "already_terminal" };
  }

  if (!FAILED_STRIPE_STATUSES.has(stripeStatus)) {
    return { stripeSubscription, action: "manual_review_required" };
  }

  if (DRY_RUN) {
    return { stripeSubscription, action: "would_cancel" };
  }

  await stripe.subscriptions.cancel(String(stripeSubscription.id), { prorate: false });
  const canceled = await stripe.subscriptions.retrieve(String(stripeSubscription.id), {
    expand: ["items.data.price"],
  });
  return { stripeSubscription: canceled, action: "canceled" };
}

async function main() {
  const mongoUri = await getMongoUri();
  if (!mongoUri) {
    throw new Error("MONGO_URI missing");
  }

  await mongoose.connect(mongoUri);
  console.log(`[${nowIso()}] Connected to MongoDB`);

  const failedSubs = await Subscription.find({
    status: { $in: Array.from(FAILED_LOCAL_STATUSES) },
  }).sort({ updatedAt: -1 });

  const summary = {
    totalFound: failedSubs.length,
    autoCleanable: 0,
    skippedHealthy: 0,
    manualReview: 0,
    cleaned: 0,
    dryRun: DRY_RUN,
    cleanedItems: [],
    skippedHealthyItems: [],
    manualReviewItems: [],
  };

  for (const subscription of failedSubs) {
    const user = await User.findById(subscription.user);
    if (!user) {
      summary.manualReview += 1;
      summary.manualReviewItems.push(
        serializeForReview(subscription, "missing_user")
      );
      continue;
    }

    let stripeState;
    try {
      stripeState = await resolveStripeState(subscription, user);
    } catch (error) {
      summary.manualReview += 1;
      summary.manualReviewItems.push(
        serializeForReview(subscription, "stripe_lookup_error", {
          error: formatErr(error),
        })
      );
      continue;
    }

    if (stripeState.resolution === "ambiguous_or_missing") {
      summary.manualReview += 1;
      summary.manualReviewItems.push(
        serializeForReview(subscription, "ambiguous_stripe_match")
      );
      continue;
    }

    if (!stripeState.stripeSubscription && stripeState.resolution === "missing_in_stripe") {
      summary.autoCleanable += 1;
      summary.cleanedItems.push({
        subscriptionId: String(subscription._id),
        action: DRY_RUN ? "would_mark_local_canceled" : "marked_local_canceled",
      });
      await markLocalCanceled(subscription);
      summary.cleaned += 1;
      continue;
    }

    const stripeSubscription = stripeState.stripeSubscription;
    const stripeStatus = String(stripeSubscription?.status || "").toLowerCase();

    if (!FAILED_STRIPE_STATUSES.has(stripeStatus) && !SAFE_FINAL_STRIPE_STATUSES.has(stripeStatus)) {
      summary.skippedHealthy += 1;
      summary.skippedHealthyItems.push(
        serializeForReview(subscription, "stripe_status_not_failed", {
          stripeStatus,
          stripeSubscriptionId: stripeSubscription?.id || null,
        })
      );
      continue;
    }

    const stripeAction = await cancelStripeIfFailed(stripeSubscription);
    if (stripeAction.action === "manual_review_required") {
      summary.manualReview += 1;
      summary.manualReviewItems.push(
        serializeForReview(subscription, "stripe_status_not_failed", {
          stripeStatus,
          stripeSubscriptionId: stripeSubscription?.id || null,
        })
      );
      continue;
    }

    summary.autoCleanable += 1;
    summary.cleanedItems.push({
      subscriptionId: String(subscription._id),
      stripeSubscriptionId: stripeSubscription?.id || null,
      action: stripeAction.action,
    });
    await markLocalCanceled(subscription);
    summary.cleaned += 1;
  }

  console.log(JSON.stringify(summary, null, 2));
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(`[${nowIso()}] cleanup_failed_subscriptions error:`, error);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
