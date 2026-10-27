const cron = require("node-cron");

require("../utils/growth/actions");
const { runSweeps, engineEnabled, propose } = require("../utils/growth/actionEngine");
const { proposePostFreeVisitTexts } = require("../utils/growth/actions/postFreeVisitSms");
const { proposePlaybookEmails } = require("../utils/growth/actions/playbookEmail");

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

/**
 * Proposers: find the situations an automation applies to and propose it.
 * Hourly is plenty - each proposal waits for the send window anyway - and the
 * idempotency key per booking makes repeated scans harmless on any instance.
 */
let proposing = false;
async function runGrowthProposers(now = new Date()) {
  if (proposing) return null;
  proposing = true;
  try {
    const postFreeVisit = await proposePostFreeVisitTexts({ propose, now });
    const playbooks = await proposePlaybookEmails({ propose, now });
    if (postFreeVisit.proposed || playbooks.proposed) {
      console.log(JSON.stringify({ event: "growth_proposed", at: now.toISOString(), postFreeVisit, playbooks }));
    }
    return { postFreeVisit, playbooks };
  } catch (error) {
    console.error(
      JSON.stringify({ event: "growth_proposers_failed", error: String(error?.message || error).slice(0, 300) })
    );
    return null;
  } finally {
    proposing = false;
  }
}

/*
 * The consent audit, once per boot: counts only (no names, emails or phones),
 * read-only, so the owner's questions - how many customers, who may be sent
 * what - can be answered from the server log. It sends nothing.
 */
async function logConsentAudit() {
  try {
    const a = await require("../utils/consent/audit").consentAudit();
    const { enabledTypes } = require("../utils/growth/actionEngine");
    const { marketingEnabled: marketingEmailsEnabled } = require("../utils/marketing/marketingConfig");
    const { smsMarketingEnabled } = require("../utils/sms/smsConfig");
    console.log(
      JSON.stringify({
        event: "consent_audit",
        ...a.summary,
        byMembership: a.byMembership,
        nonMembers: a.nonMembers,
        smsService: a.smsService,
        checks: a.checks,
        switches: {
          marketingEmails: marketingEmailsEnabled(),
          smsMarketing: smsMarketingEnabled(),
          growthActions: process.env.GROWTH_ACTIONS_ENABLED === "true",
          growthTypes: enabledTypes(),
        },
      })
    );
  } catch (error) {
    console.error(JSON.stringify({ event: "consent_audit_failed", error: String(error?.message || error).slice(0, 200) }));
  }
}

async function logAutomationAudit() {
  try {
    // corrected drafts first (still drafts - nothing sends until the owner approves them)
    await require("../utils/growth/playbookRevisions").applyPlaybookRevisions();
    console.log(JSON.stringify({ event: "automation_audit", ...(await require("../utils/growth/automationAudit").automationAudit()) }));
  } catch (error) {
    console.error(JSON.stringify({ event: "automation_audit_failed", error: String(error?.message || error).slice(0, 200) }));
  }
}

function startGrowthJobs() {
  setTimeout(logConsentAudit, 2 * 60 * 1000).unref?.();
  setTimeout(logAutomationAudit, 2.5 * 60 * 1000).unref?.();
  cron.schedule("* * * * *", () => runGrowthCycle(new Date()), { timezone: TIMEZONE });
  cron.schedule("20 * * * *", () => runGrowthProposers(new Date()), { timezone: TIMEZONE });
  console.log(
    JSON.stringify({ event: "growth_jobs_started", schedule: "* * * * *", enabled: engineEnabled() })
  );
}

module.exports = { logAutomationAudit, logConsentAudit, runGrowthCycle, runGrowthProposers, startGrowthJobs };
