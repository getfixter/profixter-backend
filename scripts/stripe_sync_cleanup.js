require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const Subscription = require('../models/Subscription');
const { stripe } = require('../utils/subscriptionManagement');

// -------------------------------------------------------------------
// MODE
// Default: DRY_RUN=true. No writes.
// Apply:   node scripts/stripe_sync_cleanup.js --write
// Legacy/manual subscriptions are skipped unless --include-legacy is explicit.
// -------------------------------------------------------------------
const DRY_RUN = process.env.DRY_RUN !== 'false' && !process.argv.includes('--write');
const INCLUDE_LEGACY = process.argv.includes('--include-legacy');

// Stripe statuses that mean the subscription is still alive and billing
const STRIPE_ALIVE = new Set(['active', 'trialing']);

// Stripe statuses that are definitively over (not just unhealthy)
const STRIPE_TERMINAL = new Set(['canceled', 'incomplete_expired', 'unpaid', 'past_due']);

function ts() { return new Date().toISOString(); }
function log(msg) { console.log(`[${ts()}] ${msg}`); }
function logOp(op, data) {
  console.log(`  [${DRY_RUN ? 'DRY' : 'APPLY'}] ${op}: ${JSON.stringify(data)}`);
}

const summary = {
  dryRun: DRY_RUN,
  subscriptionsChecked: 0,
  usersChecked: 0,
  stripeActiveKept: 0,
  scheduledCancellationsSynced: 0,
  stripeCanceled: 0,
  legacyManualCanceled: 0,
  legacyManualSkipped: 0,
  noChangesNeeded: 0,
  usersLegacySynced: 0,
  errors: [],
  manualReview: [],
};

// Returns the Stripe subscription or null if not found.
// Throws on unexpected errors (rate limits, auth, etc.) so the caller can log them.
async function fetchStripeSub(stripeSubId) {
  try {
    return await stripe.subscriptions.retrieve(String(stripeSubId), {
      expand: ['items.data.price'],
    });
  } catch (err) {
    if (err?.statusCode === 404 || err?.code === 'resource_missing') return null;
    throw err;
  }
}

function toDate(unixTimestamp) {
  if (!unixTimestamp) return null;
  return new Date(Number(unixTimestamp) * 1000);
}

// -------------------------------------------------------------------
// STRIPE-LINKED subscriptions
// -------------------------------------------------------------------
async function processStripeLinked(sub) {
  let stripeSub;
  try {
    stripeSub = await fetchStripeSub(sub.stripeSubscriptionId);
  } catch (err) {
    // Unexpected Stripe error (rate limit, network, etc.) — flag for manual review
    const msg = `Stripe API error for sub ${sub._id} (${sub.stripeSubscriptionId}): ${err.message}`;
    log(`  ERROR: ${msg}`);
    summary.errors.push(msg);
    summary.manualReview.push({
      reason: 'stripe_api_error',
      subId: String(sub._id),
      stripeSubId: sub.stripeSubscriptionId,
      localStatus: sub.status,
      error: err.message,
    });
    return;
  }

  const stripeStatus = stripeSub ? String(stripeSub.status || '').toLowerCase() : 'missing';

  // ── Not alive in Stripe → cancel locally ──────────────────────────
  if (!stripeSub || !STRIPE_ALIVE.has(stripeStatus)) {
    const alreadyCorrect =
      sub.status === 'canceled' &&
      sub.cancellationReason === 'stripe_subscription_not_active';

    if (alreadyCorrect) {
      summary.noChangesNeeded++;
      return;
    }

    const canceledAt = stripeSub?.canceled_at
      ? toDate(stripeSub.canceled_at)
      : sub.cancellationDate || new Date();

    logOp('CANCEL_STRIPE_INACTIVE', {
      subId: String(sub._id),
      stripeSubId: sub.stripeSubscriptionId,
      stripeStatus,
      prevLocalStatus: sub.status,
      canceledAt: canceledAt?.toISOString(),
    });

    if (!DRY_RUN) {
      await Subscription.collection.updateOne(
        { _id: sub._id },
        {
          $set: {
            status: 'canceled',
            accessStatus: 'inactive',
            cancelAtPeriodEnd: false,
            cancellationDate: canceledAt,
            cancellationReason: 'stripe_subscription_not_active',
            pendingPlan: null,
            pendingBillingCycle: null,
            pendingStripePriceId: null,
            pendingChangeEffectiveDate: null,
          },
        }
      );
    }
    summary.stripeCanceled++;
    return;
  }

  // ── Alive in Stripe → sync fields ─────────────────────────────────
  const cancelAtPeriodEnd = !!stripeSub.cancel_at_period_end;
  const currentPeriodEnd = toDate(stripeSub.current_period_end);

  // cancellationDate meaning:
  //   cancel_at_period_end=true → user keeps access until period end
  //   cancel_at set directly   → exact cancellation timestamp
  //   otherwise                → null (not scheduled for cancellation)
  let cancellationDate = null;
  if (stripeSub.cancel_at_period_end && stripeSub.current_period_end) {
    cancellationDate = toDate(stripeSub.current_period_end);
  } else if (stripeSub.cancel_at) {
    cancellationDate = toDate(stripeSub.cancel_at);
  }

  const $set = {
    status: stripeStatus,
    accessStatus: 'active',
    currentPeriodEnd,
    cancelAtPeriodEnd,
    cancellationDate,
  };

  // Only write if something actually changed
  const noChange =
    sub.status === stripeStatus &&
    sub.accessStatus === 'active' &&
    sub.cancelAtPeriodEnd === cancelAtPeriodEnd &&
    String(sub.currentPeriodEnd || '') === String(currentPeriodEnd || '') &&
    String(sub.cancellationDate || '') === String(cancellationDate || '');

  if (noChange) {
    summary.noChangesNeeded++;
    return;
  }

  if (cancelAtPeriodEnd) {
    logOp('SYNC_SCHEDULED_CANCELLATION', {
      subId: String(sub._id),
      stripeSubId: sub.stripeSubscriptionId,
      currentPeriodEnd: currentPeriodEnd?.toISOString(),
      cancellationDate: cancellationDate?.toISOString(),
    });
    summary.scheduledCancellationsSynced++;
  } else {
    logOp('SYNC_STRIPE_ACTIVE', {
      subId: String(sub._id),
      stripeSubId: sub.stripeSubscriptionId,
      stripeStatus,
      currentPeriodEnd: currentPeriodEnd?.toISOString(),
    });
    summary.stripeActiveKept++;
  }

  if (!DRY_RUN) {
    await Subscription.collection.updateOne({ _id: sub._id }, { $set });
  }
}

// -------------------------------------------------------------------
// LEGACY subscriptions (no stripeSubscriptionId)
// -------------------------------------------------------------------
async function processLegacy(sub) {
  if (!STRIPE_ALIVE.has(String(sub.status || '').toLowerCase())) {
    summary.noChangesNeeded++;
    return;
  }

  if (!INCLUDE_LEGACY) {
    summary.legacyManualSkipped++;
    summary.manualReview.push({
      reason: 'legacy_subscription_skipped',
      subId: String(sub._id),
      userId: String(sub.userId || sub.user || ''),
      addressId: sub.addressId ? String(sub.addressId) : null,
      localStatus: sub.status,
    });
    return;
  }

  const alreadyCorrect =
    sub.status === 'canceled' &&
    sub.cancellationReason === 'legacy_manual_removed';

  if (alreadyCorrect) {
    summary.noChangesNeeded++;
    return;
  }

  logOp('CANCEL_LEGACY', {
    subId: String(sub._id),
    prevStatus: sub.status,
    userId: String(sub.userId || sub.user || ''),
    addressId: sub.addressId ? String(sub.addressId) : null,
  });

  if (!DRY_RUN) {
    await Subscription.collection.updateOne(
      { _id: sub._id },
      {
        $set: {
          status: 'canceled',
          accessStatus: 'inactive',
          cancelAtPeriodEnd: false,
          cancellationDate: sub.cancellationDate || new Date(),
          cancellationReason: 'legacy_manual_removed',
          pendingPlan: null,
          pendingBillingCycle: null,
          pendingStripePriceId: null,
          pendingChangeEffectiveDate: null,
        },
      }
    );
  }
  summary.legacyManualCanceled++;
}

// -------------------------------------------------------------------
// USER LEGACY FIELD SYNC
// Only considers active Stripe-linked subscriptions as the source of truth.
// Uses raw collection update — never user.save() — to avoid Mongoose
// validation errors on legacy documents with missing required fields.
// -------------------------------------------------------------------
async function syncUserLegacyFields(userId) {
  const user = await User.findById(userId).lean();
  if (!user) return;

  const activeSubs = await Subscription.find({
    user: userId,
    stripeSubscriptionId: { $ne: null },
    status: { $in: ['active', 'trialing'] },
  }).sort({ currentPeriodEnd: 1, nextPaymentDate: 1, updatedAt: -1 });

  let chosen = null;
  if (user.defaultAddressId) {
    chosen = activeSubs.find(s => String(s.addressId) === String(user.defaultAddressId)) || null;
  }
  if (!chosen) chosen = activeSubs[0] || null;

  const $set = {};
  if (!chosen) {
    $set.subscription = null;
    $set.subscriptionStart = null;
    $set.subscriptionExpiry = null;
  } else {
    $set.subscription = String(chosen.subscriptionType || '').toLowerCase() || null;
    $set.subscriptionStart = chosen.startDate || null;
    $set.subscriptionExpiry = chosen.currentPeriodEnd || chosen.nextPaymentDate || null;
    if (chosen.stripeCustomerId && !user.stripeCustomerId) {
      $set.stripeCustomerId = chosen.stripeCustomerId;
    }
  }

  const noChange =
    (user.subscription || null) === ($set.subscription || null) &&
    String(user.subscriptionStart || '') === String($set.subscriptionStart || '') &&
    String(user.subscriptionExpiry || '') === String($set.subscriptionExpiry || '');

  if (noChange) return;

  logOp('SYNC_USER_LEGACY_FIELDS', {
    userId: String(userId),
    email: user.email,
    from: { subscription: user.subscription || null },
    to: { subscription: $set.subscription || null },
  });

  if (!DRY_RUN) {
    await User.collection.updateOne({ _id: userId }, { $set });
  }
  summary.usersLegacySynced++;
}

// -------------------------------------------------------------------
// MAIN
// -------------------------------------------------------------------
async function main() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) throw new Error('MONGO_URI is not set — add it to .env');

  log('Connecting to MongoDB...');
  await mongoose.connect(mongoUri);
  log(`Connected. DRY_RUN=${DRY_RUN}`);
  log(`INCLUDE_LEGACY=${INCLUDE_LEGACY}`);

  if (DRY_RUN) {
    log('*** DRY-RUN MODE — logging proposed changes, nothing written ***');
  } else {
    log('*** APPLY MODE — writing changes to the database ***');
  }

  const allSubs = await Subscription.find({}).sort({ createdAt: 1 }).lean();
  log(`Found ${allSubs.length} subscriptions`);

  // Track unique users for the legacy sync pass
  const uniqueUserIds = new Set();

  for (const sub of allSubs) {
    summary.subscriptionsChecked++;
    if (sub.user) uniqueUserIds.add(String(sub.user));

    try {
      if (sub.stripeSubscriptionId) {
        await processStripeLinked(sub);
      } else {
        await processLegacy(sub);
      }
    } catch (err) {
      const msg = `Unhandled error on sub ${sub._id}: ${err.message}`;
      log(`  ERROR: ${msg}`);
      summary.errors.push(msg);
    }
  }

  // ── User legacy field sync ────────────────────────────────────────
  summary.usersChecked = uniqueUserIds.size;
  log(`\nSyncing legacy fields for ${uniqueUserIds.size} users...`);

  for (const userIdStr of uniqueUserIds) {
    try {
      await syncUserLegacyFields(new mongoose.Types.ObjectId(userIdStr));
    } catch (err) {
      const msg = `syncUserLegacyFields userId=${userIdStr}: ${err.message}`;
      log(`  ERROR: ${msg}`);
      summary.errors.push(msg);
    }
  }

  log('\n=== CLEANUP SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));

  await mongoose.disconnect();
  log('Done.');
}

main().catch(async (err) => {
  console.error(`[${ts()}] Fatal error:`, err.message, err.stack);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
