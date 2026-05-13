require('dotenv').config();
const { stripe } = require('../utils/subscriptionManagement');

// Counts active Stripe subscriptions missing userId or addressId in metadata.
// Run: node scripts/check_stripe_metadata.js

async function main() {
  const STRIPE_STATUSES = ['active', 'trialing'];
  const counts = { total: 0, missingUserId: 0, missingAddressId: 0, missingBoth: 0, complete: 0 };
  const flagged = [];

  for (const status of STRIPE_STATUSES) {
    for await (const sub of stripe.subscriptions.list({ status, limit: 100 })) {
      counts.total++;
      const m = sub.metadata || {};
      const noUser = !m.userId;
      const noAddr = !m.addressId;

      if (noUser) counts.missingUserId++;
      if (noAddr) counts.missingAddressId++;
      if (noUser && noAddr) counts.missingBoth++;
      if (!noUser && !noAddr) counts.complete++;

      if (noUser || noAddr) {
        flagged.push({
          stripeSubId: sub.id,
          customerId: sub.customer,
          status: sub.status,
          missingUserId: noUser,
          missingAddressId: noAddr,
          metadataEmail: m.email || null,
        });
      }
    }
  }

  console.log('\n=== STRIPE METADATA CHECK ===');
  console.log(JSON.stringify(counts, null, 2));

  if (flagged.length) {
    console.log(`\n=== FLAGGED (${flagged.length}) ===`);
    flagged.forEach(f => console.log(JSON.stringify(f)));
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
