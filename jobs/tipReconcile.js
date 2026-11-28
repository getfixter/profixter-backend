const crypto = require("crypto");
const cron = require("node-cron");
const { takeLease, releaseLease } = require("../utils/analytics/analyticsLease");

/**
 * Tip reconciliation (utils/tipReconcile.js), hourly at :23 New York time.
 *
 * Looks at the last 7 days of Stripe tip payments (both tip flows) and checks
 * each has its Tip record. A tip the webhook missed that was paid after
 * AUTO_RECORD_FROM is recorded through the normal recorder, without emailing
 * anyone; anything older, any amount difference, dispute or ledger row with no
 * Stripe tip behind it is reported. Reads Stripe, writes Tip rows only. Never
 * charges, refunds, pays out or messages a customer or a Fixter.
 *
 * Alerts: an error-level "tip_reconcile_alert" log line and one Admin email,
 * not repeated for the same findings within 24 hours.
 */
const TIMEZONE = "America/New_York";
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Give the live webhook this long before a tip counts as missing. */
const GRACE_MS = 30 * 60 * 1000;
/**
 * Gaps from before this release are repaired by the reviewed, dry-run-first
 * script (scripts/repair_missing_tips.js), not silently by the job.
 */
const AUTO_RECORD_FROM = new Date("2026-11-28T00:00:00Z");
const ALERT_KEY = "tip-reconcile-last-alert";
const ALERT_REPEAT_MS = 24 * 60 * 60 * 1000;

function fingerprint(result) {
  const parts = [
    ...result.missing.filter((m) => !result.recorded.some((r) => r.paymentIntentId === m.paymentIntentId)).map((m) => `m:${m.paymentIntentId}`),
    ...result.recorded.map((r) => `r:${r.paymentIntentId}`),
    ...result.amountMismatch.map((r) => `a:${r.paymentIntentId}`),
    ...result.disputed.map((r) => `d:${r.paymentIntentId}`),
    ...result.unexplained.map((r) => `u:${r.paymentIntentId}`),
  ].sort();
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);
}

async function alertOnce(result, counts) {
  const AnalyticsState = require("../models/AnalyticsState");
  const print = fingerprint(result);
  const last = await AnalyticsState.findOne({ key: ALERT_KEY }).lean();
  if (last?.value?.fingerprint === print && Date.now() - Number(last.value.at || 0) < ALERT_REPEAT_MS) return false;
  await AnalyticsState.updateOne({ key: ALERT_KEY }, { $set: { value: { fingerprint: print, at: Date.now() } } }, { upsert: true });

  const { sendAdminEventNotification } = require("../utils/adminLeadNotification");
  const { adminLink } = require("../utils/operationalEmail");
  const unrepaired = counts.missing - counts.recorded;
  await sendAdminEventNotification({
    subject: "Tips: the Stripe check found something to look at",
    heading: "Tip reconciliation",
    templateKey: "admin_tip_reconcile_alert",
    source: "tipReconcileJob",
    who: "Stripe tips vs Profixter",
    highlight: unrepaired
      ? `${unrepaired} tip${unrepaired === 1 ? "" : "s"} paid in Stripe with no Profixter record. Run the tip repair (dry run first).`
      : "Tips were recorded or flagged by the hourly Stripe check. Review them in Tips.",
    fields: [
      ["Window", `${counts.window.since.slice(0, 10)} to ${counts.window.until.slice(0, 10)}`],
      ["Stripe tips checked", String(counts.stripeTips)],
      ["Recorded by the check", String(counts.recorded)],
      ["Missing, needs repair", String(unrepaired)],
      ["Amount differs", String(counts.amountMismatch)],
      ["Disputed", String(counts.disputed)],
      ["Record with no Stripe tip", String(counts.unexplained)],
    ],
    action: { label: "Open Tips", url: adminLink.tips() },
  }).catch((error) => console.error(JSON.stringify({ level: "error", event: "tip_reconcile_alert_email_failed", message: String(error?.message || error).slice(0, 160) })));
  return true;
}

async function reconcilePass({ now = new Date() } = {}) {
  const { reconcileTips, summarize, needsAttention } = require("../utils/tipReconcile");
  const result = await reconcileTips({
    since: new Date(now.getTime() - WINDOW_MS),
    until: now,
    apply: true,
    recordFrom: AUTO_RECORD_FROM,
    graceMs: GRACE_MS,
    recordedBy: "reconcile",
    now,
  });
  const counts = summarize(result);
  console.log(JSON.stringify({ event: "tip_reconcile", ...counts }));
  if (needsAttention(result)) {
    console.error(JSON.stringify({ level: "error", event: "tip_reconcile_alert", ...counts }));
    await alertOnce(result, counts);
  }
  return counts;
}

async function guarded() {
  const key = "tip-reconcile-lease";
  if (!(await takeLease(key, 50 * 60 * 1000))) return;
  try {
    await reconcilePass();
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "tip_reconcile_error", message: String(error?.message || error).slice(0, 200) }));
  } finally {
    await releaseLease(key).catch(() => {});
  }
}

function startTipReconcileJobs() {
  cron.schedule("23 * * * *", () => guarded(), { timezone: TIMEZONE });
}

module.exports = { startTipReconcileJobs, reconcilePass, AUTO_RECORD_FROM };
