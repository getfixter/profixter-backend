const cron = require("node-cron");
const { takeLease, releaseLease } = require("../utils/analytics/analyticsLease");
const { sweepOpen, sweepRefunds } = require("../utils/extraCharges/sweep");

/**
 * Charge extra reconciliation (utils/extraCharges/sweep.js): every 10 minutes
 * for open payments, nightly for refunds. Reads Stripe and updates our own
 * records only - it never charges, refunds or messages anyone.
 */
const TIMEZONE = "America/New_York";

async function guarded(name, ms, fn) {
  const key = `extra-charges-${name}-lease`;
  if (!(await takeLease(key, ms))) return;
  try {
    const result = await fn();
    if (result.checked) console.log(JSON.stringify({ event: "extra_charge_sweep", pass: name, ...result }));
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "extra_charge_sweep_error", pass: name, message: String(error?.message || error).slice(0, 200) }));
  } finally {
    await releaseLease(key).catch(() => {});
  }
}

function startExtraChargeJobs() {
  cron.schedule("*/10 * * * *", () => guarded("open", 9 * 60 * 1000, () => sweepOpen()), { timezone: TIMEZONE });
  cron.schedule("40 4 * * *", () => guarded("refunds", 50 * 60 * 1000, () => sweepRefunds()), { timezone: TIMEZONE });
}

module.exports = { startExtraChargeJobs };
