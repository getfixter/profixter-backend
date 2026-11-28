/**
 * Tip reconciliation: Stripe's tip payments against Profixter's Tip records.
 *
 * WHAT IS A TIP HERE
 * A paid Checkout Session from one of the two tip flows, identified by the
 * flow itself (utils/fixterTips isTipCheckoutSession): our tip checkout
 * (metadata productKind "fixter_tip") or the old static tip Payment Link (by
 * its Payment Link id). Never by amount.
 *
 * WHAT IT CHECKS, keyed on the Stripe PaymentIntent id
 *   matched         a Tip exists with the same amount
 *   missing         Stripe has a paid tip, Profixter has no Tip
 *   amountMismatch  the Tip's amount differs from the charge (flagged, never rewritten)
 *   refundBehind    Stripe refunded more than the Tip shows (the existing refund
 *                   rule is applied: refunds reduce, records are never deleted)
 *   disputed        the charge is disputed and the Tip is not yet flagged
 *   unexplained     a Tip in the window whose payment is not a Stripe tip
 *
 * WRITES ONLY WHEN ASKED (apply: true), and only Tip rows, through the same
 * idempotent recorder the webhook uses (utils/tipRecording). Never writes to
 * Stripe, never emails a customer or a Fixter, never triggers a payout.
 */

const Tip = require("../models/Tip");
const { stripe } = require("./subscriptionManagement");
const { applyRefundToTip, isTipCheckoutSession, TIP_LEDGER_STARTED_AT } = require("./fixterTips");
const { planTipRecord, recordTipFromSession } = require("./tipRecording");

/** Stripe sessions can be paid up to a day after they open; list from earlier so none is missed. */
const SESSION_LEAD_MS = 25 * 60 * 60 * 1000;

const seconds = (date) => Math.floor(new Date(date).getTime() / 1000);

function chargeOf(paymentIntent) {
  const charge = paymentIntent?.latest_charge;
  return charge && typeof charge === "object" ? charge : null;
}

/**
 * Every paid tip in Stripe whose payment falls in [since, until].
 * Returns [{ session, paymentIntentId, charge, paidAt }].
 */
async function listStripeTips({ since, until = new Date(), stripeClient = stripe } = {}) {
  const from = new Date(since);
  const to = new Date(until);
  const out = [];
  const seen = new Set();
  const params = { created: { gte: seconds(from.getTime() - SESSION_LEAD_MS), lte: seconds(to) }, status: "complete", limit: 100 };
  for await (const session of stripeClient.checkout.sessions.list(params)) {
    if (!isTipCheckoutSession(session)) continue;
    if (String(session.payment_status || "").toLowerCase() !== "paid") continue;
    const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
    if (!paymentIntentId || seen.has(paymentIntentId)) continue;
    seen.add(paymentIntentId);
    const paymentIntent = await stripeClient.paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge"] });
    const charge = chargeOf(paymentIntent);
    const paidAt = new Date((charge?.created || paymentIntent?.created || session.created) * 1000);
    if (paidAt < from || paidAt > to) continue;
    out.push({ session, paymentIntentId, charge, paidAt });
  }
  return out;
}

/**
 * Compare, and with apply: true repair through the normal recorder.
 *
 * options:
 *   since, until   payment-time window (defaults: ledger start .. now)
 *   apply          write missing Tips / refund state / review flags
 *   recordFrom     only tips paid at or after this are recorded when applying
 *                  (older missing ones are reported, left for the reviewed repair)
 *   graceMs        a tip younger than this is "pending" (the webhook may still be on it)
 *   only           optional Set of PaymentIntent ids to limit the run to
 *   recordedBy     "reconcile" | "repair"
 *   plan           attach the exact record that would be written to each missing tip (dry run)
 */
async function reconcileTips({
  since = TIP_LEDGER_STARTED_AT,
  until = new Date(),
  apply = false,
  recordFrom = null,
  graceMs = 0,
  only = null,
  recordedBy = "reconcile",
  plan = false,
  stripeClient = stripe,
  now = new Date(),
} = {}) {
  const windowStart = new Date(Math.max(new Date(since).getTime(), TIP_LEDGER_STARTED_AT.getTime()));
  const stripeTips = (await listStripeTips({ since: windowStart, until, stripeClient })).filter(
    (row) => !only || only.has(row.paymentIntentId)
  );

  const result = {
    window: { since: windowStart.toISOString(), until: new Date(until).toISOString() },
    apply,
    stripeTips: stripeTips.length,
    matched: 0,
    missing: [],
    recorded: [],
    pending: [],
    amountMismatch: [],
    refundBehind: [],
    disputed: [],
    unexplained: [],
  };

  const ids = stripeTips.map((row) => row.paymentIntentId);
  const existing = new Map(
    (await Tip.find({ stripePaymentIntentId: { $in: ids } }).lean()).map((tip) => [tip.stripePaymentIntentId, tip])
  );

  for (const row of stripeTips) {
    const brief = {
      paymentIntentId: row.paymentIntentId,
      paidAt: row.paidAt.toISOString(),
      amountCents: row.charge?.amount ?? row.session.amount_total,
      source: isTipCheckoutSession(row.session) && row.session.metadata?.productKind === "fixter_tip" ? "tip_checkout" : "legacy_payment_link",
    };
    const tip = existing.get(row.paymentIntentId);

    if (!tip) {
      if (graceMs && now.getTime() - row.paidAt.getTime() < graceMs) {
        result.pending.push(brief);
        continue;
      }
      if (plan) {
        const { record } = await planTipRecord(row.session, { paidAt: row.paidAt, recordedBy, charge: row.charge });
        brief.plan = {
          receivedAt: record.receivedAt.toISOString(),
          amountCents: record.amountCents,
          refundedCents: record.refundedCents,
          status: record.status,
          fixter: record.fixter ? String(record.fixter) : "",
          fixterName: record.fixterNameSnapshot,
          booking: record.booking ? String(record.booking) : "",
          bookingNumber: record.bookingNumberSnapshot,
          user: record.user ? String(record.user) : "",
          tipperName: record.tipperName,
          assignmentStatus: record.assignmentStatus,
          attributionBasis: record.attributionBasis,
          needsReview: record.needsReview,
          reviewReason: record.reviewReason,
          source: record.source,
        };
      }
      result.missing.push(brief);
      if (apply && (!recordFrom || row.paidAt >= new Date(recordFrom))) {
        const written = await recordTipFromSession(row.session, { paidAt: row.paidAt, recordedBy, notify: false, charge: row.charge });
        if (written?.created) result.recorded.push({ ...brief, tipId: written.tipId, attributed: written.attributed });
      }
      continue;
    }

    result.matched += 1;
    const chargeAmount = Number(row.charge?.amount ?? row.session.amount_total);
    if (Number(tip.amountCents) !== chargeAmount) {
      result.amountMismatch.push({ ...brief, tipAmountCents: tip.amountCents });
      if (apply) {
        await Tip.updateOne(
          { _id: tip._id },
          { $set: { needsReview: true, reviewReason: `Amount differs from Stripe (${chargeAmount} cents in Stripe).` } }
        );
      }
    }
    if (row.charge && Number(row.charge.amount_refunded || 0) > Number(tip.refundedCents || 0)) {
      result.refundBehind.push({ ...brief, tipRefundedCents: tip.refundedCents || 0, stripeRefundedCents: row.charge.amount_refunded });
      if (apply) {
        const doc = await Tip.findById(tip._id);
        if (doc && applyRefundToTip(doc, row.charge).changed) await doc.save();
      }
    }
    if (row.charge?.disputed && !tip.disputeStatus) {
      result.disputed.push(brief);
      if (apply) {
        await Tip.updateOne(
          { _id: tip._id },
          { $set: { disputeStatus: "open", needsReview: true, reviewReason: "Card dispute in Stripe." } }
        );
      }
    }
  }

  if (!only) {
    const known = new Set(ids);
    const inWindow = await Tip.find({ receivedAt: { $gte: windowStart, $lte: new Date(until) } })
      .select("_id stripePaymentIntentId amountCents receivedAt")
      .lean();
    for (const tip of inWindow) {
      if (!known.has(tip.stripePaymentIntentId)) {
        result.unexplained.push({ tipId: String(tip._id), paymentIntentId: tip.stripePaymentIntentId, amountCents: tip.amountCents });
      }
    }
  }

  return result;
}

/** Short counts for logs and the alert. */
function summarize(result) {
  return {
    window: result.window,
    stripeTips: result.stripeTips,
    matched: result.matched,
    missing: result.missing.length,
    recorded: result.recorded.length,
    pending: result.pending.length,
    amountMismatch: result.amountMismatch.length,
    refundBehind: result.refundBehind.length,
    disputed: result.disputed.length,
    unexplained: result.unexplained.length,
  };
}

/** Anything a person should know about (pending is not: the webhook usually lands it). */
function needsAttention(result) {
  const unrepaired = result.missing.length - result.recorded.length;
  return (
    unrepaired > 0 ||
    result.recorded.length > 0 ||
    result.amountMismatch.length > 0 ||
    result.disputed.length > 0 ||
    result.unexplained.length > 0
  );
}

module.exports = { listStripeTips, reconcileTips, summarize, needsAttention };
