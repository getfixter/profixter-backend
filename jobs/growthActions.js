const cron = require("node-cron");

require("../utils/growth/actions");
const { runSweeps, engineEnabled } = require("../utils/growth/actionEngine");

/**
 * The growth engine's heartbeat: every minute, run what is approved, verify
 * what has run, expire approvals nobody made, and surface interrupted runs.
 *
 * Registered on every instance. Duplicate work is impossible rather than
 * merely unlikely, because each step claims its action with a conditional
 * update in Mongo (see utils/growth/actionEngine). The guard below only stops
 * a slow cycle overlapping the next tick on the same instance.
 *
 * Runs even while GROWTH_ACTIONS_ENABLED is off: nothing executes then, but
 * stale approvals still expire, so the queue the owner sees stays honest.
 */
const TIMEZONE = "America/New_York";
let running = false;

async function runGrowthCycle(now = new Date()) {
  if (running) return null;
  running = true;
  try {
    const stats = await runSweeps({ now });
    if (stats.executed || stats.checked || stats.expired || stats.surfaced) {
      console.log(JSON.stringify({ event: "growth_cycle", at: now.toISOString(), ...stats }));
    }
    return stats;
  } catch (error) {
    console.error(
      JSON.stringify({ event: "growth_cycle_failed", error: String(error?.message || error).slice(0, 300) })
    );
    return null;
  } finally {
    running = false;
  }
}

function startGrowthJobs() {
  cron.schedule("* * * * *", () => runGrowthCycle(new Date()), { timezone: TIMEZONE });
  console.log(
    JSON.stringify({ event: "growth_jobs_started", schedule: "* * * * *", enabled: engineEnabled() })
  );
}

module.exports = { runGrowthCycle, startGrowthJobs };
