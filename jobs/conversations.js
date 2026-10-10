const cron = require("node-cron");
const AnalyticsState = require("../models/AnalyticsState");
const { takeLease, releaseLease } = require("../utils/analytics/analyticsLease");

/**
 * The Conversation agent's safety net and backfill: every 10 minutes, ask
 * GoHighLevel for conversations whose last message is from a homeowner,
 * mirror new messages into threads, and work a few waiting threads.
 *
 * The webhook is the fast path; this catches anything it missed and, on its
 * first run, picks up homeowners who wrote in the last
 * CONVERSATION_BACKFILL_DAYS (default 45) and were never answered.
 *
 * Inert unless CONVERSATIONS_ENABLED is "true" and a GHL token exists. One
 * instance at a time (lease). Replies are only ever proposed, never sent here.
 */
const CURSOR = "conversation:poll-cursor";
const LEASE = "conversation:poll-lease";
const TIMEZONE = "America/New_York";

async function pollOnce({ now = new Date(), env = process.env } = {}) {
  const { ghl } = require("../utils/ghl/client");
  if (env.CONVERSATIONS_ENABLED !== "true" || !ghl.config(env).configured) return { skipped: true };
  if (!(await takeLease(LEASE, 9 * 60 * 1000))) return { skipped: "lease" };
  try {
    const { ingestInbound, ingestOutbound, processWaiting } = require("../utils/conversation/service");
    const state = (await AnalyticsState.findOne({ key: CURSOR }).lean())?.value || {};
    const backfillDays = Number(env.CONVERSATION_BACKFILL_DAYS) || 45;
    const since = state.since ? new Date(state.since) : new Date(now - backfillDays * 864e5);
    const found = await ghl.searchInbound({ startAfterDate: since.getTime(), limit: 50 });
    let ingested = 0;
    let newest = since;
    for (const c of found?.conversations || []) {
      const lastAt = new Date(c.lastMessageDate || c.dateUpdated || 0);
      if (lastAt <= since) continue;
      if (lastAt > newest) newest = lastAt;
      const msgs = await ghl.getMessages(c.id, { limit: 15 });
      const list = (msgs?.messages?.messages || msgs?.messages || []).slice().reverse();
      const tags = (c.tags || []).map((t) => String(t).toLowerCase());
      for (const m of list) {
        if (String(m.direction).toLowerCase() === "inbound") {
          await ingestInbound({
            conversationId: c.id,
            contactId: c.contactId,
            channel: m.messageType || m.type || c.lastMessageType,
            body: m.body,
            at: m.dateAdded,
            messageId: m.id,
            firstName: c.contactName ? String(c.contactName).split(" ")[0] : "",
            origin: tags.includes("cold_prospects_2026") ? "cold_outreach_reply" : "inbound",
          });
          ingested += 1;
        } else {
          await ingestOutbound({ conversationId: c.id, body: m.body, at: m.dateAdded, messageId: m.id, by: m.userId ? "staff" : "automation" });
        }
      }
    }
    await AnalyticsState.updateOne({ key: CURSOR }, { $set: { value: { since: newest.toISOString(), lastRunAt: now } } }, { upsert: true });
    const worked = await processWaiting({ now, limit: Number(env.CONVERSATION_DECISIONS_PER_RUN) || 5 });
    const summary = { conversations: (found?.conversations || []).length, ingested, decided: worked.length };
    if (ingested || worked.length) console.log(JSON.stringify({ event: "conversation_poll", ...summary }));
    return summary;
  } finally {
    await releaseLease(LEASE).catch(() => {});
  }
}

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
  cron.schedule("*/10 * * * *", () => pollOnce().catch((e) => console.warn("conversation_poll failed:", e.message)), { timezone: TIMEZONE });
  cron.schedule("20 3 * * *", () => syncOutreachOnce().catch((e) => console.warn("outreach_audience_sync failed:", e.message)), { timezone: TIMEZONE });
}

module.exports = { pollOnce, startConversationJobs, syncOutreachOnce };
