/**
 * Charge extra reconciliation that does not wait for anybody to open a job.
 *
 * Webhooks are the fast path; this is the guarantee. Every pass asks Stripe
 * about the records whose truth may have moved, through the same idempotent
 * reconcile() the webhook and the job sheet use, so running it twice, or
 * beside a webhook, changes nothing twice.
 *
 *   frequent (every 10 min): charging/processing (an answer we never got),
 *     awaiting_payment with a Checkout page made (paid on a link), failed with
 *     a card cancel Stripe did not confirm.
 *   daily: paid / partly refunded in the last 180 days, for refunds made in
 *     Stripe while charge.refunded was not delivered.
 *
 * One writer across instances (utils/analytics/analyticsLease). Stripe being
 * down only postpones the work to the next pass.
 */
const AdditionalCharge = require("../../models/AdditionalCharge");
const extras = require("./index");

const FREQUENT_LIMIT = 100;
const REFUND_LIMIT = 300;
const REFUND_WINDOW_MS = 180 * 24 * 60 * 60 * 1000;
const SETTLE_AFTER_MS = 60 * 1000; // leave a live request a minute to answer itself

async function reconcileEach(records, { force = true } = {}) {
  let checked = 0;
  let changed = 0;
  let errors = 0;
  for (const r of records) {
    checked += 1;
    try {
      const before = `${r.status}:${r.refundedCents}`;
      let after = await extras.reconcile(r, { force });
      if (r.status === "failed" && r.attempts.some((a) => a.cancelPending)) {
        try {
          await extras.settleCardAttempts(after || r);
        } catch (error) {
          /* recorded on the attempt; retried next pass */
        }
        after = await AdditionalCharge.findById(r._id);
      }
      if (after && `${after.status}:${after.refundedCents}` !== before) changed += 1;
    } catch (error) {
      errors += 1;
      console.error(JSON.stringify({ level: "warn", event: "extra_charge_sweep_failed", additionalChargeId: String(r._id), message: String(error?.message || error).slice(0, 200) }));
    }
  }
  return { checked, changed, errors };
}

async function sweepOpen({ now = new Date() } = {}) {
  const settled = new Date(now.getTime() - SETTLE_AFTER_MS);
  const records = await AdditionalCharge.find({
    $or: [
      { status: { $in: ["charging", "processing"] }, statusChangedAt: { $lte: settled } },
      { status: "awaiting_payment", "attempts.kind": "checkout" },
      { status: "failed", "attempts.cancelPending": true },
    ],
  })
    .sort({ statusChangedAt: 1 })
    .limit(FREQUENT_LIMIT);
  return reconcileEach(records);
}

async function sweepRefunds({ now = new Date() } = {}) {
  const records = await AdditionalCharge.find({ status: { $in: ["paid", "partially_refunded"] }, paidAt: { $gte: new Date(now.getTime() - REFUND_WINDOW_MS) } })
    .sort({ paidAt: -1 })
    .limit(REFUND_LIMIT);
  return reconcileEach(records);
}

module.exports = { sweepOpen, sweepRefunds, SETTLE_AFTER_MS };
