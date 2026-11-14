const cron = require("node-cron");
const { takeLease, releaseLease } = require("../utils/analytics/analyticsLease");

/**
 * Sales desk background work, each pass under a named lease so only one EB
 * instance runs it:
 *   every 10 min  retry failed GoHighLevel webhook events whose backoff passed
 *   nightly       reconcile first payments and refunds with Stripe (read-only
 *                 on Stripe; writes our sales records through the same
 *                 idempotent functions the webhook uses)
 * Nothing here sends messages, moves money or talks to GoHighLevel.
 */
const TIMEZONE = "America/New_York";

async function guarded(name, ms, fn) {
  const key = `sales-desk-${name}-lease`;
  if (!(await takeLease(key, ms))) return;
  try {
    const result = await fn();
    console.log(JSON.stringify({ event: "sales_desk_job", pass: name, result }));
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "sales_desk_job_error", pass: name, message: String(error?.message || error).slice(0, 200) }));
  } finally {
    await releaseLease(key).catch(() => {});
  }
}

/** The nightly pass (exported for tests). The ledger check runs first and is stored: a failure pauses payouts on the server. */
async function nightlyPass() {
  const r = require("../utils/sales/reconcile");
  const integrity = await require("../utils/sales/ledger").runLedgerCheck("nightly");
  if (!integrity.ok) console.error(JSON.stringify({ level: "error", event: "sales_ledger_integrity", payoutsPaused: true, problems: integrity.problems.slice(0, 20) }));
  return { firstPayments: await r.firstPayments(), refunds: await r.refunds(), ledgerOk: integrity.ok, payoutsPaused: !integrity.ok };
}

/** GHL retries: a no-op while GHL_SALES_SYNC_ENABLED is not "true" (utils/sales/ghl.js). */
const ghlRetryPass = () => require("../utils/sales/ghl").retryFailed();

/**
 * Once per boot: Telemarketer accounts still on the old shared first password
 * are moved to invitation-link setup (utils/auth/staffSetup.js). Idempotent;
 * accounts whose owner already chose a password are never matched. Login and
 * the auth middleware refuse those accounts even before this runs.
 */
async function staffSetupConversionPass() {
  const converted = await require("../utils/auth/staffSetup").convertLegacyTelemarketers();
  return { converted };
}

function startSalesDeskJobs() {
  setTimeout(() => guarded("staff-setup-conversion", 5 * 60 * 1000, staffSetupConversionPass), 20 * 1000).unref?.();
  cron.schedule("*/10 * * * *", () => guarded("ghl-retry", 9 * 60 * 1000, ghlRetryPass), { timezone: TIMEZONE });
  cron.schedule("10 5 * * *", () => guarded("reconcile", 50 * 60 * 1000, nightlyPass), { timezone: TIMEZONE });
}

module.exports = { startSalesDeskJobs, nightlyPass, ghlRetryPass, staffSetupConversionPass };
