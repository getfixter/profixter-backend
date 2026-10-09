const cron = require("node-cron");

const { AGENTS } = require("../utils/agents/definitions");
const { agentsEnabled, runAgent } = require("../utils/agents/runtime");
const { adSpendStatus } = require("../utils/analytics/metaAdSpend");

/**
 * When the growth agents run (America/New_York):
 *
 *   Growth Intelligence  daily check 07:40 Tue-Sun; weekly owner report Mon 08:10
 *   Visibility           Mon 09:30, after the Monday rank and AI-answer collectors
 *   Marketing            daily 09:00 once Meta spend is connected; until then
 *                        Mon 09:00 only (there is little to judge without spend)
 *
 * Registered on every instance; runAgent takes a per-agent lease, so one
 * instance runs each slot. With AGENTS_ENABLED unset or no ANTHROPIC_API_KEY,
 * a slot records a "skipped" run and costs nothing.
 */
const TIMEZONE = "America/New_York";

function slot(agent, opts) {
  return () =>
    runAgent(AGENTS[agent], opts).catch((error) =>
      console.error(JSON.stringify({ event: "agent_run_crashed", agent, error: String(error?.message || error).slice(0, 300) }))
    );
}

async function marketingDaily() {
  const status = await adSpendStatus().catch(() => null);
  const connected = Boolean(status?.connected);
  const monday = new Date().toLocaleString("en-US", { timeZone: TIMEZONE, weekday: "short" }) === "Mon";
  if (connected || monday) return slot("marketing", {})();
  return null;
}

function startAgentJobs() {
  if (process.env.NODE_ENV === "test") return;
  cron.schedule("40 7 * * 0,2-6", slot("growth_intelligence", { mode: "daily" }), { timezone: TIMEZONE });
  cron.schedule("10 8 * * 1", slot("growth_intelligence", { mode: "weekly" }), { timezone: TIMEZONE });
  cron.schedule("30 9 * * 1", slot("visibility", {}), { timezone: TIMEZONE });
  cron.schedule("0 9 * * *", () => marketingDaily(), { timezone: TIMEZONE });
  console.log(JSON.stringify({ event: "agent_jobs_started", enabled: agentsEnabled() }));
}

module.exports = { startAgentJobs };
