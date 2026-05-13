require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const Subscription = require('../models/Subscription');
const { stripe } = require('../utils/subscriptionManagement');

// -------------------------------------------------------------------
// MODE
// Default: DRY_RUN. No writes.
// Apply:   DRY_RUN=false node scripts/repair_subscriptions.js
// -------------------------------------------------------------------
const DRY_RUN = process.env.DRY_RUN !== 'false';
const ACTIVE_STATUSES = new Set(['active', 'trialing']);

function ts() { return new Date().toISOString(); }
function log(msg) { console.log(`[${ts()}] ${msg}`); }
function logOp(op, data) {
  console.log(`  [${DRY_RUN ? 'DRY' : 'APPLY'}] ${op}: ${JSON.stringify(data)}`);
}

const summary = {
  dryRun: DRY_RUN,
  usersChecked: 0,
  usersKeptActive: 0,
  usersDeactivated: 0,
  duplicateSubsFixed: 0,
  staleSubsFixed: 0,
  cancellationFieldsFixed: 0,
  legacyUserFieldsSynced: 0,
  manualReview: [],
  errors: [],
};

// Syncs legacy user-level subscription fields (user.subscription, subscriptionStart,
// subscriptionExpiry, stripeCustomerId) using a raw collection update so that incomplete
// User documents missing required fields like `name` or `userId` don't fail Mongoose
// validation and block the repair.
async function syncLegacyFieldsRaw(userDoc, allSubs) {
  const activeSubs = allSubs
    .filter(s => ACTIVE_STATUSES.has(s.status))
    .sort((a, b) => {
      const aEnd = (a.currentPeriodEnd || a.nextPaymentDate || 0);
      const bEnd = (b.currentPeriodEnd || b.nextPaymentDate || 0);
      if (aEnd && bEnd) return new Date(aEnd) - new Date(bEnd);
      return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
    });

  let chosen = null;
  if (userDoc.defaultAddressId) {
    chosen = activeSubs.find(s => String(s.addressId) === String(userDoc.defaultAddressId)) || null;
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
    $set.subscriptionExpiry = chosen.currentPeriodEnd || chosen.nextPaymentDate || chosen.cancellationDate || null;
    if (chosen.stripeCustomerId && !userDoc.stripeCustomerId) {
      $set.stripeCustomerId = chosen.stripeCustomerId;
    }
  }

  await User.collection.updateOne({ _id: userDoc._id }, { $set });
  return $set.subscription || null;
}

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

async function markCanceled(sub, reason, overrideDate = null) {
  logOp('MARK_CANCELED', {
    subId: String(sub._id),
    stripeSubId: sub.stripeSubscriptionId || null,
    prevStatus: sub.status,
    reason,
  });
  if (DRY_RUN) return;
  sub.status = 'canceled';
  sub.cancelAtPeriodEnd = false;
  sub.cancellationDate = sub.cancellationDate || overrideDate || new Date();
  sub.cancellationReason = reason;
  await sub.save();
}

// Returns true if the address still has a confirmed-active subscription after processing.
async function processAddress(addrIdStr, activeSubs) {
  // Stripe-backed subs first, then most recently created
  const sorted = [...activeSubs].sort((a, b) => {
    if (!!a.stripeSubscriptionId !== !!b.stripeSubscriptionId)
      return a.stripeSubscriptionId ? -1 : 1;
    return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
  });

  const primary = sorted[0];
  const duplicates = sorted.slice(1);

  let addressIsActive = false;

  if (primary.stripeSubscriptionId) {
    const stripeSub = await fetchStripeSub(primary.stripeSubscriptionId);

    if (!stripeSub) {
      log(`  [ADDR ${addrIdStr}] stripeSubId=${primary.stripeSubscriptionId} not found in Stripe`);
      for (const s of activeSubs) {
        await markCanceled(s, 'not_found_in_stripe');
        summary.staleSubsFixed++;
      }
      return false;
    }

    const stripeStatus = String(stripeSub.status || '').toLowerCase();

    if (!ACTIVE_STATUSES.has(stripeStatus)) {
      log(`  [ADDR ${addrIdStr}] Stripe status=${stripeStatus} — marking local active subs stale`);
      const canceledAt =
        stripeSub.canceled_at ? new Date(stripeSub.canceled_at * 1000) :
        stripeSub.cancel_at   ? new Date(stripeSub.cancel_at * 1000)   :
        new Date();
      for (const s of activeSubs) {
        await markCanceled(s, 'stripe_subscription_not_active', canceledAt);
        summary.staleSubsFixed++;
      }
      return false;
    }

    // Stripe confirms active
    addressIsActive = true;

    // Fix: cancelAtPeriodEnd=true but currentPeriodEnd not stored locally
    if (primary.cancelAtPeriodEnd && !primary.currentPeriodEnd && stripeSub.current_period_end) {
      const periodEnd = new Date(stripeSub.current_period_end * 1000);
      logOp('FIX_CURRENT_PERIOD_END', {
        subId: String(primary._id),
        currentPeriodEnd: periodEnd.toISOString(),
      });
      if (!DRY_RUN) {
        primary.currentPeriodEnd = periodEnd;
        await primary.save();
      }
      summary.cancellationFieldsFixed++;
    }

    // Fix: cancelAtPeriodEnd=true + stale cancellationDate in the past while Stripe still active.
    // This is the inconsistency found on sub 69e98cce5953899b50e5f93b.
    if (primary.cancelAtPeriodEnd && primary.cancellationDate && primary.cancellationDate < new Date()) {
      logOp('CLEAR_STALE_CANCELLATION_DATE', {
        subId: String(primary._id),
        staleCancellationDate: primary.cancellationDate.toISOString(),
        reason: 'stripe_still_active',
      });
      if (!DRY_RUN) {
        primary.cancellationDate = null;
        await primary.save();
      }
      summary.cancellationFieldsFixed++;
    }

  } else {
    // Legacy/manual subscription (no Stripe ID) — cannot verify, treat as active
    addressIsActive = true;
    if (duplicates.length > 0) {
      log(`  [ADDR ${addrIdStr}] legacy sub, ${duplicates.length} duplicates to dedup`);
    }
  }

  // Deactivate duplicate active subscriptions for this address
  for (const dup of duplicates) {
    await markCanceled(dup, 'duplicate_deactivated');
    summary.duplicateSubsFixed++;
  }

  return addressIsActive;
}

async function main() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) throw new Error('MONGO_URI is not set — add it to .env');

  log('Connecting to MongoDB...');
  await mongoose.connect(mongoUri);
  log(`Connected. DRY_RUN=${DRY_RUN}`);

  if (DRY_RUN) {
    log('*** DRY-RUN MODE — logging proposed changes only, nothing written ***');
  } else {
    log('*** APPLY MODE — writing changes to the database ***');
  }

  const allUsers = await User.find({}).lean();
  log(`Found ${allUsers.length} users`);

  for (const userDoc of allUsers) {
    summary.usersChecked++;
    const userId = userDoc._id;

    try {
      const allSubs = await Subscription.find({ user: userId });

      // Group active subs by addressId
      const activeByAddr = new Map();
      for (const sub of allSubs) {
        if (!ACTIVE_STATUSES.has(sub.status)) continue;
        if (!sub.addressId) continue;
        const key = String(sub.addressId);
        if (!activeByAddr.has(key)) activeByAddr.set(key, []);
        activeByAddr.get(key).push(sub);
      }

      let userHasActive = false;
      const hadActiveBefore = activeByAddr.size > 0;

      for (const [addrIdStr, activeSubs] of activeByAddr) {
        try {
          const isActive = await processAddress(addrIdStr, activeSubs);
          if (isActive) userHasActive = true;
        } catch (err) {
          const msg = `processAddress userId=${userDoc.userId} addrId=${addrIdStr}: ${err.message}`;
          log(`  ERROR: ${msg}`);
          summary.errors.push(msg);
          userHasActive = true; // safest: assume active on error, never remove access
        }
      }

      // Active subs with no addressId — cannot auto-fix, flag for manual review
      const noAddrActive = allSubs.filter(s => ACTIVE_STATUSES.has(s.status) && !s.addressId);
      if (noAddrActive.length > 0) {
        summary.manualReview.push({
          reason: 'active_subs_missing_addressId',
          userId: String(userId),
          userEmail: userDoc.email,
          subIds: noAddrActive.map(s => String(s._id)),
        });
      }

      // Sync legacy user-level fields (user.subscription, subscriptionStart, subscriptionExpiry).
      // Uses a raw collection update to bypass Mongoose validation on incomplete documents.
      if (!DRY_RUN) {
        const before = userDoc.subscription || null;
        const syncedSub = await syncLegacyFieldsRaw(userDoc, allSubs);
        if (before !== syncedSub) {
          summary.legacyUserFieldsSynced++;
        }
      }

      if (userHasActive) {
        summary.usersKeptActive++;
      } else if (hadActiveBefore) {
        summary.usersDeactivated++;
      }

    } catch (err) {
      const msg = `userId=${userDoc.userId || String(userId)}: ${err.message}`;
      log(`ERROR: ${msg}`);
      summary.errors.push(msg);
    }
  }

  log('\n=== REPAIR SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));

  await mongoose.disconnect();
  log('Done.');
}

main().catch(async (err) => {
  console.error(`[${ts()}] Fatal error:`, err.message, err.stack);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
