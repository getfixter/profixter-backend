require("dotenv").config();
const mongoose = require("mongoose");

const { BATCH, BUSINESS, marketingEnabled } = require("../utils/marketing/marketingConfig");
const { ALL_TEMPLATES } = require("../utils/marketing/marketingLibrary");
const {
  annualPricingDetail,
  annualPricingHealthy,
  inSendWindow,
  localClock,
} = require("../utils/marketing/marketingScheduler");
const { runMarketingCycle } = require("../utils/marketing/marketingRunner");

/**
 * What would the marketing engine do right now?
 *
 * Read-only. Sends nothing, writes nothing, claims nothing. This is the gate
 * before activation: if the plan it prints is not one you would be happy to
 * have landed in customers' inboxes, do not set ENABLE_MARKETING_EMAILS.
 *
 *   node scripts/marketing_dry_run.js            planned sends for right now
 *   node scripts/marketing_dry_run.js --limit=50 look deeper into the queue
 *   node scripts/marketing_dry_run.js --window   respect the send window
 */
function arg(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : fallback;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");
  await mongoose.connect(uri);

  const now = new Date();
  const limit = Number(arg("limit", BATCH.maxPerRun));

  console.log("\n=== ProFixter marketing dry run ===");
  console.log(`Time              ${now.toISOString()}`);
  console.log(`New York          ${JSON.stringify(localClock(now))}`);
  console.log(`Send window open  ${inSendWindow(now)}`);
  console.log(`ENABLE_MARKETING  ${marketingEnabled()}`);
  console.log(`Postal address    ${BUSINESS.addressLine || "MISSING (blocks all sends)"}`);
  console.log(`Templates loaded  ${ALL_TEMPLATES.length}`);

  const annual = await annualPricingHealthy(now, { force: true });
  console.log(`Annual pricing    ${annual ? "healthy" : "BROKEN, annual campaigns suppressed"}`);
  if (!annual) console.log(`  detail          ${JSON.stringify(annualPricingDetail())}`);

  const result = await runMarketingCycle({
    now,
    dryRun: true,
    limit,
    force: !hasFlag("window"),
  });

  console.log("\n--- Outcome ---");
  console.log(`Considered        ${result.considered}`);
  console.log(`Would send        ${result.selected}`);
  console.log(`Skipped           ${result.skipped}`);
  if (result.stoppedBecause) console.log(`Stopped because   ${result.stoppedBecause}`);

  if (Object.keys(result.skipReasons).length) {
    console.log("\n--- Why people were skipped ---");
    for (const [reason, count] of Object.entries(result.skipReasons).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(5)}  ${reason}`);
    }
  }

  if (result.plans.length) {
    console.log("\n--- Planned sends ---");
    for (const plan of result.plans) {
      console.log(`  ${plan.email.padEnd(28)} ${plan.audience.padEnd(14)} ${plan.campaignId}`);
      console.log(`  ${" ".repeat(28)} "${plan.subject}"`);
    }
  } else {
    console.log("\nNo sends planned.");
  }

  console.log("\nNothing was sent. Nothing was written.\n");
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error("Dry run failed:", error?.message || error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
