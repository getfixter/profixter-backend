/**
 * Create or update the ProFixter Customer Portal configuration.
 *
 * Dry by default: prints exactly what would be sent and changes nothing.
 *
 *   node scripts/configure_billing_portal.js                  # show the plan
 *   node scripts/configure_billing_portal.js --write          # create a new configuration
 *   node scripts/configure_billing_portal.js --write --id bpc_xxx   # update that configuration
 *
 * After --write, set STRIPE_BILLING_PORTAL_CONFIGURATION_ID to the printed id.
 * Until that variable is set, portal sessions keep using Stripe's account
 * default and nothing about the member experience changes, so applying this and
 * switching it on are two separate, independently reversible steps.
 */

const path = require("path");
const {
  buildPortalConfigurationParams,
} = require(path.join(__dirname, "..", "utils", "billingPortalConfiguration.js"));
const {
  stripe,
  hasStripeSecretKey,
  PLAN_CATALOG,
} = require(path.join(__dirname, "..", "utils", "subscriptionManagement.js"));

const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const idFlagIndex = args.indexOf("--id");
const TARGET_ID = idFlagIndex >= 0 ? args[idFlagIndex + 1] : null;

const money = (cents) => `$${(cents / 100).toFixed(2)}`;

async function describePrice(priceId) {
  try {
    const price = await stripe.prices.retrieve(priceId);
    const interval = price.recurring
      ? `${price.recurring.interval} x${price.recurring.interval_count}`
      : "ONE-TIME";
    return `${money(price.unit_amount)} ${interval} active=${price.active}`;
  } catch (error) {
    return `<UNREADABLE: ${error.message}>`;
  }
}

(async () => {
  if (!hasStripeSecretKey()) {
    console.error("STRIPE_SECRET_KEY is not set.");
    process.exit(1);
  }

  const params = buildPortalConfigurationParams();
  const planByProduct = Object.fromEntries(
    Object.entries(PLAN_CATALOG).map(([name, plan]) => [plan.stripeProductId, name])
  );

  console.log("Portal configuration the member would be offered:\n");
  for (const product of params.features.subscription_update.products) {
    console.log(`  ${(planByProduct[product.product] || product.product).padEnd(9)} ${product.product}`);
    for (const priceId of product.prices) {
      console.log(`      ${priceId}  ${await describePrice(priceId)}`);
    }
    console.log(`      adjustable_quantity: ${product.adjustable_quantity.enabled}`);
  }

  const su = params.features.subscription_update;
  console.log("\n  proration_behavior:", su.proration_behavior);
  console.log("  default_allowed_updates:", JSON.stringify(su.default_allowed_updates));
  console.log("  schedule_at_period_end:", JSON.stringify(su.schedule_at_period_end));
  console.log("  subscription_cancel:", JSON.stringify(params.features.subscription_cancel));

  // Refuse to publish a configuration that points at a price Stripe would reject
  // anyway. A dead price here would take the whole update page down, not just
  // one row of it.
  const allPrices = su.products.flatMap((p) => p.prices);
  const bad = [];
  for (const priceId of allPrices) {
    try {
      const price = await stripe.prices.retrieve(priceId);
      if (!price.active) bad.push(`${priceId} is INACTIVE`);
      if (!price.recurring) bad.push(`${priceId} is not recurring`);
    } catch (error) {
      bad.push(`${priceId} ${error.message}`);
    }
  }
  if (bad.length) {
    console.error("\nRefusing to continue, these prices are not usable:");
    for (const b of bad) console.error("  " + b);
    process.exit(1);
  }
  console.log(`\n  all ${allPrices.length} prices verified active and recurring`);

  if (!WRITE) {
    console.log("\nDry run. Nothing was sent to Stripe. Re-run with --write to apply.");
    process.exit(0);
  }

  const result = TARGET_ID
    ? await stripe.billingPortal.configurations.update(TARGET_ID, params)
    : await stripe.billingPortal.configurations.create(params);

  console.log(`\n${TARGET_ID ? "Updated" : "Created"} configuration: ${result.id}`);
  console.log(`  active: ${result.active}   is_default: ${result.is_default}`);
  console.log("\nNothing uses it yet. To switch it on:");
  console.log(`  STRIPE_BILLING_PORTAL_CONFIGURATION_ID=${result.id}`);
  console.log("To revert, clear that variable; Stripe's account default takes over again.");
  process.exit(0);
})().catch((error) => {
  console.error("FAILED:", error?.message || error);
  process.exit(1);
});
