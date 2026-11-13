const cron = require("node-cron");
const AnalyticsState = require("../models/AnalyticsState");
const { takeLease, releaseLease } = require("../utils/analytics/analyticsLease");

/*
 * The GoHighLevel conversation poller (every 10 minutes, mirrored homeowner
 * messages into threads and asked the reply agent to decide) was REMOVED on
 * 2026-11-12 together with the GHL reply path (owner decision Q-6). Threads
 * already stored stay readable in Admin. What remains here is the read-only
 * postal-mail audience sync.
 */
const TIMEZONE = "America/New_York";

/**
 * Builds the postal-mail audience from the GoHighLevel list: read-only on GHL,
 * resumable (a cursor in AnalyticsState), at most OUTREACH_SYNC_PAGES pages of
 * 100 per night, then a full refresh every 30 days. Inert unless
 * OUTREACH_SYNC_ENABLED is "true" and a GHL token exists.
 */
const OUTREACH_CURSOR = "outreach:sync-cursor";
const OUTREACH_LEASE = "outreach:sync-lease";

async function syncOutreachOnce({ now = new Date(), env = process.env, fetchImpl } = {}) {
  const { ghl } = require("../utils/ghl/client");
  if (env.OUTREACH_SYNC_ENABLED !== "true" || !ghl.config(env).configured) return { skipped: true };
  if (!(await takeLease(OUTREACH_LEASE, 55 * 60 * 1000))) return { skipped: "lease" };
  try {
    const { syncAudience } = require("../utils/outreach/audience");
    const state = (await AnalyticsState.findOne({ key: OUTREACH_CURSOR }).lean())?.value || {};
    if (state.completedAt && now - new Date(state.completedAt) < 30 * 864e5) return { skipped: "fresh" };
    const result = await syncAudience({ maxPages: Number(env.OUTREACH_SYNC_PAGES) || 100, searchAfter: state.searchAfter || undefined, env, fetchImpl, now });
    const value = result.done ? { completedAt: now.toISOString(), searchAfter: null } : { searchAfter: result.searchAfter, completedAt: state.completedAt || null };
    await AnalyticsState.updateOne({ key: OUTREACH_CURSOR }, { $set: { value } }, { upsert: true });
    console.log(JSON.stringify({ event: "outreach_audience_sync", pages: result.pages, seen: result.seen, done: result.done }));
    return result;
  } finally {
    await releaseLease(OUTREACH_LEASE).catch(() => {});
  }
}

function startConversationJobs() {
  if (process.env.NODE_ENV === "test") return;
  cron.schedule("20 3 * * *", () => syncOutreachOnce().catch((e) => console.warn("outreach_audience_sync failed:", e.message)), { timezone: TIMEZONE });
}

module.exports = { startConversationJobs, syncOutreachOnce };
