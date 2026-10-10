const cron = require("node-cron");

const { AGENTS } = require("../utils/agents/definitions");
const { agentsEnabled, runAgent } = require("../utils/agents/runtime");

/**
 * Unattended agent schedules (America/New_York), taken from each agent's
 * `schedules` in utils/agents/definitions.js:
 *
 *   Growth Intelligence  daily check 07:40 Tue-Sun; owner report Mon 08:10
 *   Visibility           Mon 09:30, after the Monday rank and AI-answer collectors
 *   Conversion           Mon and Thu 09:00
 *
 * Registered on every instance; runAgent takes a per-agent lease, so one
 * instance runs each slot. A slot with agents switched off records a skipped
 * run and costs nothing.
 *
 * RECOVERY. A run that fails for a transient reason (rate limit, overload,
 * network, 5xx - see runtime.isTransient) is retried once, 20 minutes later,
 * by the instance that ran it. A second failure is left for the next slot and
 * shows in the Command Center; Growth Intelligence sees it in recent runs.
 */
const TIMEZONE = "America/New_York";
const RETRY_AFTER_MS = 20 * 60 * 1000;

async function runSlot(name, mode, trigger = "schedule") {
  try {
    const run = await runAgent(AGENTS[name], { trigger, mode });
    if (trigger !== "retry" && run?.status === "failed" && String(run.error || "").startsWith("transient")) {
      setTimeout(() => runSlot(name, mode, "retry"), RETRY_AFTER_MS).unref?.();
    }
    return run;
  } catch (error) {
    console.error(JSON.stringify({ event: "agent_run_crashed", agent: name, error: String(error?.message || error).slice(0, 300) }));
    return null;
  }
}

function startAgentJobs() {
  if (process.env.NODE_ENV === "test") return;
  for (const def of Object.values(AGENTS)) {
    for (const s of def.schedules || []) {
      cron.schedule(s.cron, () => runSlot(def.name, s.mode), { timezone: TIMEZONE });
    }
  }
  console.log(JSON.stringify({ event: "agent_jobs_started", enabled: agentsEnabled(), agents: Object.keys(AGENTS) }));
}

module.exports = { runSlot, startAgentJobs };
