/**
 * One writer across all instances, for background analytics jobs.
 *
 * The backend is load-balanced (one to four instances, and a rolling deploy
 * runs old and new side by side), so a job first takes a named lease in
 * Mongo (AnalyticsState, one document per key). A run that cannot get it
 * skips: another instance is already running that job. A process that dies
 * mid-run leaves a lease that simply expires.
 *
 * Extracted unchanged from the Stripe revenue ledger sync so that every job
 * shares the same mechanism; the document shape ({ owner, until }) and the
 * revenue lease key are exactly what that sync always wrote.
 */
const OWNER = `${require("os").hostname()}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;

/** True when this process now holds `key` for `ms` milliseconds. */
async function takeLease(key, ms) {
  const AnalyticsState = require("../../models/AnalyticsState");
  await AnalyticsState.init(); // the unique key that lets exactly one instance win
  const now = Date.now();
  try {
    const doc = await AnalyticsState.findOneAndUpdate(
      { key, $or: [{ "value.until": { $lt: now } }, { "value.owner": OWNER }, { "value.until": { $exists: false } }] },
      { $set: { value: { owner: OWNER, until: now + ms } } },
      { upsert: true, new: true }
    ).lean();
    return doc?.value?.owner === OWNER;
  } catch (error) {
    // Two instances upserting the lease at once: the unique key lets exactly one win.
    if (error?.code === 11000) return false;
    throw error;
  }
}

/** Give the lease back early (a no-op if another instance holds it). */
async function releaseLease(key) {
  const AnalyticsState = require("../../models/AnalyticsState");
  await AnalyticsState.updateOne({ key, "value.owner": OWNER }, { $set: { "value.until": 0 } });
}

module.exports = { takeLease, releaseLease, OWNER };
