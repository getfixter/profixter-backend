const cron = require("node-cron");

const { TIMEZONE, configSnapshot } = require("../utils/sms/smsConfig");
const { runSmsRetrySweep } = require("../utils/sms/smsService");
const { runSmsCampaignSweep } = require("../utils/sms/smsCampaignRunner");

/**
 * The two SMS sweeps.
 *
 * NEITHER OF THESE SENDS A REMINDER. That is deliberate and is the single most
 * important thing about this file. Booking reminders are produced by the
 * existing scheduler in jobs/bookingReminders, which already solves the hard
 * parts — due-state selection that survives a deploy, claim-then-send, stale
 * lock recovery, explicit abandonment with reasons. A second scheduler racing
 * it for the same bookings is exactly how a customer ends up with two texts,
 * so there isn't one.
 *
 * What is left for a sweep of our own is the work the reminder job cannot do:
 *
 *   RETRY   messages whose provider call failed transiently, and messages
 *           stranded by a worker that died mid-send.
 *   CAMPAIGN  the marketing runs, which are not tied to any booking.
 *
 * Both are no-ops while the relevant switch is off, which is their state on
 * deployment. The crons register anyway, so switching SMS on later is a
 * configuration change and not a deploy.
 */

const sleepless = { running: { retry: false, campaign: false } };

function errorDetails(error) {
  return {
    message: String(error?.message || "Unknown error").slice(0, 300),
    name: error?.name || "",
  };
}

/**
 * Run a sweep with an overlap guard.
 *
 * The guard is per-process, which is enough for the reason it exists: stopping
 * one slow cycle from being started again by the next tick on the same
 * instance. It is NOT what prevents duplicate sends across instances — that is
 * the unique dedupe key in the database, which does not care how many servers
 * are running.
 */
async function guarded(name, fn) {
  if (sleepless.running[name]) {
    console.warn(JSON.stringify({ event: "sms_cycle_overlapped", sweep: name }));
    return null;
  }
  sleepless.running[name] = true;
  try {
    return await fn();
  } catch (error) {
    console.error(
      JSON.stringify({ event: "sms_cycle_failed", sweep: name, error: errorDetails(error) })
    );
    return null;
  } finally {
    sleepless.running[name] = false;
  }
}

/**
 * Retry sweep. Every minute, matching the reminder cadence.
 *
 * Only rows already claimed and already failed transiently are touched, so a
 * minute is cheap: with nothing to retry it is one indexed query returning
 * nothing.
 */
async function runRetryCycle(now = new Date()) {
  const stats = await runSmsRetrySweep({ now });
  if (stats.retried || stats.failed || stats.abandoned || stats.reclaimed) {
    console.log(JSON.stringify({ event: "sms_retry_cycle", at: now.toISOString(), ...stats }));
  }
  return stats;
}

/**
 * Campaign sweep. Hourly, at a quarter past.
 *
 * Hourly rather than by-the-minute because a marketing campaign has no deadline
 * and a slower loop makes an accidental over-send smaller. The campaign's own
 * send window and per-run ceiling do the rest of the pacing.
 */
async function runCampaignCycle(now = new Date()) {
  const result = await runSmsCampaignSweep({ now });
  if (result.ran && result.campaigns.some((c) => c.claimed)) {
    console.log(
      JSON.stringify({ event: "sms_campaign_cycle", at: now.toISOString(), ...result })
    );
  }
  return result;
}

/**
 * A heartbeat that states the configuration out loud.
 *
 * The one question anybody will ask this system while Twilio approval is
 * pending is "are we certain nothing is being sent?". A periodic line carrying
 * the actual flag values answers it from the logs, without anybody having to
 * read the environment of a running instance.
 */
function logSmsHeartbeat(now = new Date()) {
  console.log(
    JSON.stringify({ event: "sms_heartbeat", at: now.toISOString(), ...configSnapshot() })
  );
}

function startSmsJobs() {
  cron.schedule("* * * * *", () => guarded("retry", () => runRetryCycle(new Date())), {
    timezone: TIMEZONE,
  });

  cron.schedule("15 * * * *", () => guarded("campaign", () => runCampaignCycle(new Date())), {
    timezone: TIMEZONE,
  });

  cron.schedule("*/30 * * * *", () => logSmsHeartbeat(new Date()), { timezone: TIMEZONE });

  console.log(
    JSON.stringify({
      event: "sms_jobs_started",
      retry: "* * * * *",
      campaigns: "15 * * * *",
      heartbeat: "*/30 * * * *",
      timezone: TIMEZONE,
      ...configSnapshot(),
    })
  );
}

module.exports = {
  logSmsHeartbeat,
  runCampaignCycle,
  runRetryCycle,
  startSmsJobs,
};
