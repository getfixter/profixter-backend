const cron = require("node-cron");
const { takeLease, releaseLease } = require("../utils/analytics/analyticsLease");

/**
 * Referral rewards (utils/referrals): the annual rule's clock. Hourly, under a lease so one EB instance runs it, every
 * pending ANNUAL referral whose 60 days of membership are over is read from Stripe again and becomes ready (or void, or
 * keeps waiting). Monthly referrals need no clock: their second paid invoice arrives as a webhook.
 * Read-only on Stripe; nothing here moves money.
 */
const TIMEZONE = "America/New_York";
const LEASE = "referral-annual-sweep-lease";

async function annualPass({ now = new Date() } = {}) {
  if (!(await takeLease(LEASE, 50 * 60 * 1000))) return null;
  try {
    const result = await require("../utils/referrals/engine").sweepAnnual({ now });
    console.log(JSON.stringify({ event: "referral_annual_sweep", ...result }));
    return result;
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "referral_annual_sweep_error", message: String(error?.message || error).slice(0, 200) }));
    return null;
  } finally {
    await releaseLease(LEASE).catch(() => {});
  }
}

function startReferralRewardJobs() {
  cron.schedule("25 * * * *", () => void annualPass(), { timezone: TIMEZONE });
}

module.exports = { startReferralRewardJobs, annualPass };
