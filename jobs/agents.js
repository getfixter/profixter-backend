const cron = require("node-cron");
const AgentRun = require("../models/AgentRun");

const { AGENTS } = require("../utils/agents/definitions");
const { agentsEnabled, runAgent } = require("../utils/agents/runtime");

/**
 * Unattended agent schedules (America/New_York), taken from each agent's
 * `schedules` in utils/agents/definitions.js:
 *
 *   Odysseus (visibility)   Mon and Thu 09:30, after the Monday rank and AI-answer collectors
 *   Leonidas (outreach)     Tue 10:00
 *   Marcus (conversion)     Mon and Thu 09:00
 *   King Arthur          council review daily 08:15 (Mondays: weekly planning), and after shifts
 *
 * Registered on every instance; runAgent takes a per-agent lease, so one
 * instance runs each slot. A slot with agents switched off records a skipped
 * run and costs nothing.
 *
 * RECOVERY. A run that fails for a transient reason (rate limit, overload,
 * network, 5xx - see runtime.isTransient) is retried once, 20 minutes later,
 * by the instance that ran it. A second failure is left for the next slot and
 * shows in the office; King Arthur sees it in his review.
 */
const TIMEZONE = "America/New_York";
const RETRY_AFTER_MS = 20 * 60 * 1000;

/**
 * KING ARTHUR'S COUNCIL REVIEW. Daily at 08:15, and ~10 minutes after a
 * specialist finishes a shift (at most once per 4 hours). review() first
 * compares a fingerprint of everything it would read with the last review's
 * and does nothing - no AI call - when nothing changed.
 */
const REVIEW_AFTER_SHIFT_MS = 10 * 60 * 1000;
const REVIEW_MIN_GAP_MS = 4 * 60 * 60 * 1000;
let reviewTimer = null;

async function councilReview(reason = "daily") {
  try {
    // Mondays (New York) are his weekly planning review: it runs even when nothing new came in.
    const monday = new Date().toLocaleString("en-US", { weekday: "long", timeZone: TIMEZONE }) === "Monday";
    const result = await require("../utils/council/arthur").review({ planning: reason === "daily" && monday });
    console.log(JSON.stringify({ event: "council_review", reason, ...result, run: result.run ? String(result.run) : undefined }));
    return result;
  } catch (error) {
    console.error(JSON.stringify({ event: "council_review_crashed", error: String(error?.message || error).slice(0, 300) }));
    return null;
  }
}

async function reviewAfterShift() {
  if (reviewTimer) return;
  const lastReview = await AgentRun.findOne({ agent: "arthur", trigger: "schedule", status: { $ne: "skipped" } }).sort({ startedAt: -1 }).select("startedAt").lean();
  if (lastReview && Date.now() - new Date(lastReview.startedAt) < REVIEW_MIN_GAP_MS) return;
  reviewTimer = setTimeout(() => {
    reviewTimer = null;
    councilReview("after_shift");
  }, REVIEW_AFTER_SHIFT_MS);
  reviewTimer.unref?.();
}

async function runSlot(name, mode, trigger = "schedule") {
  try {
    const run = await runAgent(AGENTS[name], { trigger, mode });
    if (run?.status === "succeeded") reviewAfterShift().catch(() => {});
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
 * 6 hours, so a failing setup cannot loop or burn budget.
 */
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
      const mode = def.schedules?.[0]?.mode || null;
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
  cron.schedule("15 8 * * *", () => councilReview("daily"), { timezone: TIMEZONE });
  // The 2026-10-11 marketing refocus: Arthur's mission as a new version, then one review of open work (both idempotent).
  setTimeout(async () => {
    try {
      await require("../utils/council/mission").ensureMission();
      await require("../utils/council/refocus").reviewForRefocus();
      await require("../utils/council/refocus").retireBusinessRecords();
      await require("../utils/council/inbox").classifyExisting();
      await require("../utils/council/inbox").sweep();
      // Self-check on real data (counts only): do the marketing numbers add up?
      const m = await require("../utils/agents/marketingData").marketingResults();
      const sourcesTotal = (m.bySource30 || []).reduce((n, x) => n + (x.firstFreeVisits || 0), 0);
      console.log(JSON.stringify({ event: "marketing_report_check", firstFreeVisits30: m.firstFreeVisitBookings.last30, sourcesTotal30: sourcesTotal, adds_up: sourcesTotal === m.firstFreeVisitBookings.last30, funnelWindow: m.bookingFunnel?.window || null, funnelFirstFreeVisits: m.bookingFunnel?.firstFreeVisits ?? null, ratesShown: Boolean(m.bookingFunnel?.stepRatesPct) }));
    } catch (e) {
      console.error("refocus start-up failed:", e.message);
    }
  }, 90 * 1000).unref?.();
  // Old postcard/mail notes from before the mail tools were removed: retire them (idempotent).
  setTimeout(() => require("../utils/agents/retirePostal").retirePostalRecords().catch((e) => console.error("retirePostalRecords failed:", e.message)), 60 * 1000).unref?.();
  // Check 5 minutes after boot (after the secret store's first load), then every 30 minutes.
  setTimeout(() => firstActivation().catch(() => {}), 5 * 60 * 1000).unref?.();
  cron.schedule("*/30 * * * *", () => firstActivation().catch(() => {}), { timezone: TIMEZONE });
  console.log(JSON.stringify({ event: "agent_jobs_started", enabled: agentsEnabled(), agents: Object.keys(AGENTS) }));
}

module.exports = { councilReview, firstActivation, runSlot, startAgentJobs };
