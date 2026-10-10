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

/**
 * FIRST ACTIVATION. When agents become enabled (or the API key arrives through
 * the secret store), an agent that has never completed a run runs once within
 * ~30 minutes instead of waiting up to a week for its slot - which is also the
 * moment its setup is verified end to end. At most one attempt per agent per
 * 6 hours, so a failing setup cannot loop or burn budget; Growth Intelligence
 * runs in weekly mode so its first owner report is produced.
 */
const AgentRun = require("../models/AgentRun");
const FIRST_RUN_COOLDOWN_MS = 6 * 60 * 60 * 1000;
let bootstrapping = false;

async function firstActivation(now = new Date()) {
  if (bootstrapping || !agentsEnabled()) return;
  bootstrapping = true;
  try {
    for (const def of Object.values(AGENTS)) {
      const succeeded = await AgentRun.exists({ agent: def.name, status: "succeeded" });
      if (succeeded) continue;
      const recent = await AgentRun.exists({
        agent: def.name,
        status: { $ne: "skipped" },
        startedAt: { $gte: new Date(now - FIRST_RUN_COOLDOWN_MS) },
      });
      if (recent) continue;
      const mode = def.name === "growth_intelligence" ? "weekly" : (def.schedules?.[0]?.mode || null);
      await runSlot(def.name, mode, "schedule");
    }
  } finally {
    bootstrapping = false;
  }
}

function startAgentJobs() {
  if (process.env.NODE_ENV === "test") return;
  for (const def of Object.values(AGENTS)) {
    for (const s of def.schedules || []) {
      cron.schedule(s.cron, () => runSlot(def.name, s.mode), { timezone: TIMEZONE });
    }
  }
  // Check 5 minutes after boot (after the secret store's first load), then every 30 minutes.
  setTimeout(() => firstActivation().catch(() => {}), 5 * 60 * 1000).unref?.();
  cron.schedule("*/30 * * * *", () => firstActivation().catch(() => {}), { timezone: TIMEZONE });
  console.log(JSON.stringify({ event: "agent_jobs_started", enabled: agentsEnabled(), agents: Object.keys(AGENTS) }));
}

module.exports = { firstActivation, runSlot, startAgentJobs };
