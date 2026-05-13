require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const Subscription = require('../models/Subscription');
const {
  stripe,
  upsertSubscriptionFromStripe,
  getPlanAndBillingFromPrice,
} = require('../utils/subscriptionManagement');

// -------------------------------------------------------------------
// MODE
// Default: DRY_RUN=true. No writes.
// Apply:   DRY_RUN=false node scripts/stripe_import_sync.js
// -------------------------------------------------------------------
const DRY_RUN = process.env.DRY_RUN !== 'false';

function ts() { return new Date().toISOString(); }
function log(msg) { console.log(`[${ts()}] ${msg}`); }
function logOp(op, data) {
  console.log(`  [${DRY_RUN ? 'DRY' : 'APPLY'}] ${op}: ${JSON.stringify(data)}`);
}

const summary = {
  dryRun: DRY_RUN,
  stripeActiveFound: 0,
  syncedToMongo: 0,
  alreadyExisted: 0,
  manualReview: [],
  errors: [],
};

// Cache Stripe customer email lookups to avoid redundant API calls
const customerEmailCache = new Map();

async function getCustomerEmail(customerId) {
  if (customerEmailCache.has(customerId)) return customerEmailCache.get(customerId);
  try {
    const customer = await stripe.customers.retrieve(customerId);
    const email = typeof customer?.email === 'string' ? customer.email.toLowerCase() : null;
    customerEmailCache.set(customerId, email);
    return email;
  } catch {
    customerEmailCache.set(customerId, null);
    return null;
  }
}

async function findUser(customerId) {
  if (!customerId) return null;

  // 1. Match by stripeCustomerId stored on User
  const byCustomer = await User.findOne({ stripeCustomerId: customerId });
  if (byCustomer) return byCustomer;

  // 2. Fall back: retrieve email from Stripe customer, match by email
  const email = await getCustomerEmail(customerId);
  if (!email) return null;

  return User.findOne({ email }) || null;
}

async function processStripeSub(stripeSub) {
  summary.stripeActiveFound++;

  const stripeSubId = stripeSub.id;
  const customerId = String(stripeSub.customer || '');
  const metadata = stripeSub.metadata || {};
  const addressId = metadata.addressId || null;

  const item = stripeSub.items?.data?.[0] || null;
  const priceId = item?.price?.id || null;
  const { plan } = getPlanAndBillingFromPrice(priceId);

  // ── Resolve user ──────────────────────────────────────────────────
  const user = await findUser(customerId);
  if (!user) {
    const email = await getCustomerEmail(customerId);
    summary.manualReview.push({
      reason: 'no_matching_user',
      stripeSubId,
      customerId,
      email: email || null,
      plan: plan || null,
      status: stripeSub.status,
    });
    log(`  MANUAL [no_matching_user] ${stripeSubId} | customer=${customerId} | email=${email || 'unknown'}`);
    return;
  }

  // ── Resolve addressId ─────────────────────────────────────────────
  let resolvedAddressId = addressId;
  if (!resolvedAddressId) {
    const userAddresses = user.addresses || [];
    if (userAddresses.length === 1) {
      resolvedAddressId = String(userAddresses[0]._id);
      log(`  INFO inferred addressId from single address | ${stripeSubId} | user=${user.email} | addressId=${resolvedAddressId}`);
    } else {
      const reason = userAddresses.length === 0 ? 'no_addresses' : 'multiple_addresses_no_metadata';
      summary.manualReview.push({
        reason,
        stripeSubId,
        customerId,
        userId: String(user._id),
        email: user.email,
        addressCount: userAddresses.length,
        plan: plan || null,
        status: stripeSub.status,
      });
      log(`  MANUAL [${reason}] ${stripeSubId} | user=${user.email} | addresses=${userAddresses.length}`);
      return;
    }
  }

  // ── Verify address exists on user ─────────────────────────────────
  const address = user.addresses?.id(resolvedAddressId) || null;
  if (!address) {
    summary.manualReview.push({
      reason: 'address_not_found_on_user',
      stripeSubId,
      customerId,
      userId: String(user._id),
      email: user.email,
      addressId: resolvedAddressId,
      plan: plan || null,
      status: stripeSub.status,
    });
    log(`  MANUAL [address_not_found_on_user] ${stripeSubId} | user=${user.email} | addressId=${resolvedAddressId}`);
    return;
  }

  // ── Check if already active in Mongo ─────────────────────────────
  const existing = await Subscription.findOne({ stripeSubscriptionId: stripeSubId });
  const alreadyActive = existing && ['active', 'trialing'].includes(existing.status);

  if (alreadyActive) {
    logOp('ALREADY_EXISTS', {
      stripeSubId,
      mongoSubId: String(existing._id),
      status: existing.status,
      plan: existing.subscriptionType,
      userId: String(user._id),
    });
    summary.alreadyExisted++;
    return;
  }

  logOp('SYNC', {
    stripeSubId,
    existingMongoSubId: existing ? String(existing._id) : null,
    existingStatus: existing?.status || null,
    plan: plan || null,
    status: stripeSub.status,
    userId: String(user._id),
    email: user.email,
    addressId: resolvedAddressId,
  });

  if (DRY_RUN) {
    summary.syncedToMongo++;
    return;
  }

  // If user was found by email (no stripeCustomerId set), write it now to avoid
  // user.save() inside upsertSubscriptionFromStripe failing on legacy documents.
  if (!user.stripeCustomerId && customerId) {
    await User.collection.updateOne({ _id: user._id }, { $set: { stripeCustomerId: customerId } });
    user.stripeCustomerId = customerId;
  }

  try {
    await upsertSubscriptionFromStripe({
      stripeSubscription: stripeSub,
      user,
      addressIdHint: resolvedAddressId,
    });
    summary.syncedToMongo++;
  } catch (err) {
    const msg = `upsertSubscriptionFromStripe failed for ${stripeSubId}: ${err.message}`;
    log(`  ERROR: ${msg}`);
    summary.errors.push({ stripeSubId, userId: String(user._id), email: user.email, error: err.message });
  }
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

  if (DRY_RUN) {
    log('*** DRY-RUN MODE — logging proposed changes, nothing written ***');
  } else {
    log('*** APPLY MODE — writing changes to the database ***');
  }

  const STRIPE_STATUSES = ['active', 'trialing'];

  for (const status of STRIPE_STATUSES) {
    log(`\nFetching Stripe subscriptions with status=${status}...`);
    for await (const stripeSub of stripe.subscriptions.list({
      status,
      limit: 100,
      expand: ['data.items.data.price', 'data.schedule'],
    })) {
      try {
        await processStripeSub(stripeSub);
      } catch (err) {
        const msg = `Unhandled error for ${stripeSub.id}: ${err.message}`;
        log(`  ERROR: ${msg}`);
        summary.errors.push({ stripeSubId: stripeSub.id, error: err.message });
      }
    }
  }

  log('\n=== SYNC SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));

  await mongoose.disconnect();
  log('Done.');
}

main().catch(async (err) => {
  console.error(`[${ts()}] Fatal error:`, err.message, err.stack);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
