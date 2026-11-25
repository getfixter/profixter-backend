const cron = require("node-cron");
const { takeLease, releaseLease } = require("../utils/analytics/analyticsLease");

/**
 * Communications background work, each pass under a named lease so one
 * server runs it at a time:
 *   every 30 s   bulk-send worker (rate-limited, inside the send window)
 *   every minute settle "unknown" sends by asking Twilio (never resends)
 *   every minute advance running history imports by one bounded slice
 *   every 10 min resume GoHighLevel sync, only if the owner switched it on
 *   every 10 min health check (stuck bulk sends, stale imports, unknown sends)
 * Nothing here texts anyone except the bulk worker, which only processes
 * bulk sends the owner approved.
 */
const TIMEZONE = "America/New_York";

async function guarded(name, ms, fn) {
  const key = `comms-${name}-lease`;
  if (!(await takeLease(key, ms))) return;
  try {
    const result = await fn();
    if (result && Object.values(result).some((v) => v && v !== 0 && v !== false)) console.log(JSON.stringify({ event: "comms_job", pass: name, result }));
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "comms_job_error", pass: name, message: String(error?.message || error).slice(0, 200) }));
    await require("../utils/comms/core").healthEvent("job_error", `${name}: ${String(error?.message || "").slice(0, 120)}`);
  } finally {
    await releaseLease(key).catch(() => {});
  }
}

const bulkPass = () => require("../utils/comms/bulk").runBulkTick();
const reconcilePass = () => require("../utils/comms/send").reconcileUnknown();
const importsPass = () => require("../utils/comms/imports").runImportsTick();
const ghlPass = () => require("../utils/comms/imports").ghlIncrementalTick();

async function healthPass() {
  const summary = await require("../routes/adminComms").healthSummary();
  if (summary.stuckBulk || summary.staleImports || summary.unknownSends > 5) {
    console.error(JSON.stringify({ level: "error", event: "comms_health_alert", stuckBulk: summary.stuckBulk, staleImports: summary.staleImports, unknownSends: summary.unknownSends }));
  }
  return { stuckBulk: summary.stuckBulk, staleImports: summary.staleImports, unknownSends: summary.unknownSends };
}

function startCommsJobs() {
  setInterval(() => guarded("bulk", 25 * 1000, bulkPass), 30 * 1000).unref?.();
  cron.schedule("* * * * *", () => guarded("reconcile", 55 * 1000, reconcilePass), { timezone: TIMEZONE });
  cron.schedule("* * * * *", () => guarded("imports", 55 * 1000, importsPass), { timezone: TIMEZONE });
  cron.schedule("*/10 * * * *", () => guarded("ghl-sync", 9 * 60 * 1000, ghlPass), { timezone: TIMEZONE });
  cron.schedule("*/10 * * * *", () => guarded("health", 9 * 60 * 1000, healthPass), { timezone: TIMEZONE });
}

module.exports = { startCommsJobs, bulkPass, reconcilePass, importsPass, healthPass };
