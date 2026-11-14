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

function startSalesDeskJobs() {
  cron.schedule("*/10 * * * *", () => guarded("ghl-retry", 9 * 60 * 1000, () => require("../utils/sales/ghl").retryFailed()), { timezone: TIMEZONE });
  cron.schedule("10 5 * * *", () =>
    guarded("reconcile", 50 * 60 * 1000, async () => {
      const r = require("../utils/sales/reconcile");
      return { firstPayments: await r.firstPayments(), refunds: await r.refunds() };
    }), { timezone: TIMEZONE });
}

module.exports = { startSalesDeskJobs };
