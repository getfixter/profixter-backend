require("dotenv").config();
const mongoose = require("mongoose");
const Subscription = require("../models/Subscription");
const User = require("../models/User");
const {
  retrieveStripeSubscription,
  upsertSubscriptionFromStripe,
} = require("../utils/subscriptionManagement");

const DRY_RUN = process.env.DRY_RUN !== "false";

function log(event, details = {}) {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      dryRun: DRY_RUN,
      event,
      ...details,
    })
  );
}

async function main() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) throw new Error("MONGO_URI is required");

  await mongoose.connect(mongoUri);
  log("reconcile_start");

  const subscriptions = await Subscription.find({
    stripeSubscriptionId: { $nin: [null, ""] },
  }).sort({ updatedAt: 1 });

  const summary = {
    scanned: 0,
    foundInStripe: 0,
    missingInStripe: 0,
    synced: 0,
    errors: 0,
  };

  for (const subscription of subscriptions) {
    summary.scanned++;
    try {
      const stripeSubscription = await retrieveStripeSubscription(
        subscription.stripeSubscriptionId
      ).catch((error) => {
        if (error?.statusCode === 404 || error?.code === "resource_missing") return null;
        throw error;
      });

      if (!stripeSubscription) {
        summary.missingInStripe++;
        log("stripe_subscription_missing", {
          subscriptionId: String(subscription._id),
          stripeSubscriptionId: subscription.stripeSubscriptionId,
        });
        continue;
      }

      summary.foundInStripe++;
      log("stripe_subscription_found", {
        subscriptionId: String(subscription._id),
        stripeSubscriptionId: subscription.stripeSubscriptionId,
        stripeStatus: stripeSubscription.status || null,
      });

      if (DRY_RUN) continue;

      const user = await User.findById(subscription.user);
      if (!user) {
        summary.errors++;
        log("local_user_missing", {
          subscriptionId: String(subscription._id),
          stripeSubscriptionId: subscription.stripeSubscriptionId,
        });
        continue;
      }

      const updated = await upsertSubscriptionFromStripe({
        stripeSubscription,
        user,
        addressIdHint: subscription.addressId ? String(subscription.addressId) : null,
      });

      if (updated) {
        summary.synced++;
        log("stripe_subscription_synced", {
          subscriptionId: String(updated._id),
          stripeSubscriptionId: updated.stripeSubscriptionId,
          status: updated.status,
          accessStatus: updated.accessStatus,
        });
      }
    } catch (error) {
      summary.errors++;
      log("stripe_subscription_reconcile_failed", {
        subscriptionId: String(subscription._id),
        stripeSubscriptionId: subscription.stripeSubscriptionId,
        message: error?.message || "Unknown reconciliation error",
      });
    }
  }

  log("reconcile_complete", summary);
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: "reconcile_fatal",
      message: error?.message || "Unknown reconciliation fatal error",
    })
  );
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
