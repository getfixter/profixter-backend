/**
 * The money of a paid free-visit conversion, when the visit did not go ahead
 * as paid (utils/freeVisit/conversion.js):
 *
 *   - the conversion needs attention (paid, but the visit could not be
 *     converted), and Admin closes it; or
 *   - the visit was converted, and Admin later canceled it (declined it).
 *
 * Canceling a visit never touches the payment. A membership conversion also
 * started a SUBSCRIPTION that keeps billing every month or year: refunding
 * its first payment does not stop the next one. So these stay under Needs
 * action until Admin records what was done, and the record is checked with
 * Stripe before it is accepted:
 *
 *   One-Time      refunded              Stripe must show a refund on the payment
 *                 kept                  the payment stays (a note says why)
 *   Membership    membership_canceled   Stripe must show the subscription ended
 *                                       or set to end; Admin also says whether
 *                                       the first payment was refunded
 *                 membership_kept       the customer stays a member (a note says
 *                                       why); refused if it no longer bills
 *
 * Nothing here cancels or refunds anything. That is Admin's own action, on
 * the customer's profile (membership) or in Stripe (refund).
 */
const FreeVisitConversion = require("../../models/FreeVisitConversion");
const Subscription = require("../../models/Subscription");

const conversionModule = () => require("./conversion");
const subscriptions = () => require("../subscriptionManagement");

const STRIPE_CHECK_TIMEOUT_MS = 8000;
const RESOLUTIONS = {
  one_time: ["refunded", "kept"],
  membership: ["membership_canceled", "membership_kept"],
};

function fail(code, message, status = 409) {
  const { ConversionError } = conversionModule();
  return new ConversionError(code, message, status);
}

function dashboardBase() {
  return String(process.env.STRIPE_SECRET_KEY || "").startsWith("sk_test") ? "https://dashboard.stripe.com/test" : "https://dashboard.stripe.com";
}

function withTimeout(promise) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Stripe did not answer in time")), STRIPE_CHECK_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

function toDate(seconds) {
  const n = Number(seconds || 0);
  return n > 0 ? new Date(n * 1000) : null;
}

/** Whether a subscription (Stripe's or our record's fields) will take another payment. */
function billsAgain({ status, cancelAtPeriodEnd, cancelAt }) {
  if (["canceled", "incomplete_expired", "expired"].includes(String(status || ""))) return false;
  return !cancelAtPeriodEnd && !cancelAt;
}

/**
 * What Admin needs to see: the payment, and for a membership the
 * subscription it started and whether it bills again. `live`: ask Stripe
 * (checkedWithStripe says whether that worked); otherwise our own records.
 */
async function paymentFacts(conversion, { live = true } = {}) {
  const c = conversion.toObject ? conversion.toObject() : conversion;
  const { offerLabel } = conversionModule().presentConversion(c) || {};
  const facts = {
    kind: c.kind,
    offerLabel: offerLabel || "",
    amountCents: c.payment?.amountCents ?? null,
    currency: c.payment?.currency || "usd",
    paidAt: c.payment?.paidAt || null,
    checkedWithStripe: false,
    stripeError: "",
  };
  const { stripe } = subscriptions();

  if (c.kind === "one_time") {
    const pi = String(c.payment?.paymentIntentId || "");
    facts.oneTime = {
      paymentIntentId: pi,
      paymentUrl: /^pi_/.test(pi) ? `${dashboardBase()}/payments/${pi}` : null,
      refundedCents: null,
      refund: "unknown",
    };
    if (live && /^pi_/.test(pi)) {
      try {
        const intent = await withTimeout(stripe.paymentIntents.retrieve(pi, { expand: ["latest_charge"] }));
        const charge = intent?.latest_charge && typeof intent.latest_charge === "object" ? intent.latest_charge : null;
        const refunded = Number(charge?.amount_refunded || 0);
        const amount = Number(charge?.amount ?? intent?.amount_received ?? intent?.amount ?? 0);
        facts.oneTime.refundedCents = refunded;
        facts.oneTime.refund = refunded <= 0 ? "none" : refunded >= amount ? "full" : "partial";
        facts.checkedWithStripe = true;
      } catch (error) {
        facts.stripeError = String(error?.message || error).slice(0, 160);
      }
    }
    return facts;
  }

  const local =
    (c.payment?.subscriptionId && (await Subscription.findById(c.payment.subscriptionId).lean())) ||
    (c.payment?.stripeSubscriptionId && (await Subscription.findOne({ stripeSubscriptionId: c.payment.stripeSubscriptionId }).lean())) ||
    null;
  const stripeSubscriptionId = String(c.payment?.stripeSubscriptionId || local?.stripeSubscriptionId || "");
  const membership = {
    stripeSubscriptionId,
    subscriptionUrl: /^sub_/.test(stripeSubscriptionId) ? `${dashboardBase()}/subscriptions/${stripeSubscriptionId}` : null,
    customerProfileHref: c.user ? `/admin/customers/${String(c.user)}` : null,
    plan: c.plan,
    billingCycle: c.billingCycle,
    status: local?.status || "",
    cancelAtPeriodEnd: Boolean(local?.cancelAtPeriodEnd),
    /* Our record keeps a scheduled end as cancelAtPeriodEnd or a future cancellationDate. */
    cancelAt: local?.cancellationDate && new Date(local.cancellationDate) > new Date() ? local.cancellationDate : null,
    nextPaymentAt: local?.nextPaymentDate || local?.currentPeriodEnd || null,
    source: local ? "record" : "none",
  };
  if (live && /^sub_/.test(stripeSubscriptionId)) {
    try {
      const sub = await withTimeout(stripe.subscriptions.retrieve(stripeSubscriptionId));
      const periodEnd = sub?.current_period_end || sub?.items?.data?.[0]?.current_period_end || 0;
      Object.assign(membership, {
        status: String(sub?.status || ""),
        cancelAtPeriodEnd: Boolean(sub?.cancel_at_period_end),
        cancelAt: toDate(sub?.cancel_at),
        endedAt: toDate(sub?.ended_at),
        nextPaymentAt: toDate(periodEnd),
        source: "stripe",
      });
      facts.checkedWithStripe = true;
    } catch (error) {
      facts.stripeError = String(error?.message || error).slice(0, 160);
    }
  }
  membership.billsAgain = membership.status ? billsAgain(membership) : null;
  facts.membership = membership;
  return facts;
}

/** What Admin has to settle on this conversion now, if anything. */
function openFollowUp(conversion) {
  if (conversion.status === "needs_attention") return "attention";
  if (conversion.afterCancel?.at && !conversion.afterCancel?.resolvedAt) return "after_cancel";
  return null;
}

/**
 * Admin canceled a converted visit (utils/bookingTransitions doCancel). The
 * payment and any subscription are left exactly as they are; this records
 * that they now need a decision, and returns what to show in the result.
 */
async function recordCanceledAfterPayment({ booking, admin = null, reason = "", statusBefore = "" }) {
  const conversionId = booking?.freeVisitConversion?.convertedAt ? booking.freeVisitConversion.conversionId : null;
  if (!conversionId) return null;
  const { historyEntry } = conversionModule();
  const updated = await FreeVisitConversion.findOneAndUpdate(
    { _id: conversionId, status: "converted" },
    {
      $set: {
        afterCancel: {
          at: new Date(),
          by: admin?._id || null,
          byName: admin?.name || admin?.email || "",
          reason: String(reason || "").slice(0, 300),
          bookingStatusBefore: String(statusBefore || ""),
          resolvedAt: null,
        },
        resolution: { kind: "", for: "", note: "", at: null, by: null, byName: "", firstPaymentRefunded: null, verified: null },
      },
      $push: { history: historyEntry("visit_canceled_after_payment", admin, { reason: String(reason || "").slice(0, 300), statusBefore }) },
    },
    { new: true }
  );
  if (!updated) return null;
  const facts = await paymentFacts(updated).catch(() => paymentFacts(updated, { live: false }));
  return { conversionId: String(updated._id), followUp: "after_cancel", ...facts };
}

/** The canceled converted visit was reinstated: nothing to settle any more. */
async function reinstatedAfterCancel({ booking, admin = null }) {
  const conversionId = booking?.freeVisitConversion?.conversionId;
  if (!conversionId) return null;
  const { historyEntry } = conversionModule();
  return FreeVisitConversion.findOneAndUpdate(
    { _id: conversionId, "afterCancel.at": { $ne: null }, "afterCancel.resolvedAt": null },
    {
      $set: {
        "afterCancel.resolvedAt": new Date(),
        resolution: { kind: "visit_reinstated", for: "after_cancel", note: "The visit was reinstated.", at: new Date(), by: admin?._id || null, byName: admin?.name || admin?.email || "", firstPaymentRefunded: null, verified: null },
      },
      $push: { history: historyEntry("payment_resolved", admin, { resolution: "visit_reinstated" }) },
    },
    { new: true }
  );
}

function money(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(2).replace(/\.00$/, "")}`;
}

function dateText(date) {
  return date ? new Date(date).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }) : "";
}

/**
 * Admin records how a paid conversion was settled. Checked with Stripe; if
 * Stripe cannot be asked, nothing is recorded.
 */
async function resolvePayment({ conversionId, bookingId = null, admin = null, resolution, note = "", firstPaymentRefunded = null }) {
  const { loadConversion, historyEntry } = conversionModule();
  const conversion = await loadConversion(conversionId, bookingId);
  const target = openFollowUp(conversion);
  if (!target) throw fail("NOTHING_TO_RESOLVE", "There is no payment waiting for a decision on this visit.");
  const kind = String(resolution || "");
  if (!(RESOLUTIONS[conversion.kind] || []).includes(kind)) {
    throw fail(
      "RESOLUTION_REQUIRED",
      conversion.kind === "membership"
        ? "Choose what happened to the membership: canceled, or kept by the customer."
        : "Choose what happened to the payment: refunded in Stripe, or kept.",
      400
    );
  }
  const text = String(note || "").trim().slice(0, 300);
  if (text.length < 3) throw fail("REASON_REQUIRED", "Add a short note on what was agreed with the customer.", 400);
  if (kind === "membership_canceled" && typeof firstPaymentRefunded !== "boolean") {
    throw fail("REFUND_ANSWER_REQUIRED", "Say whether the first payment was refunded in Stripe. Canceling the membership does not refund it.", 400);
  }

  const facts = await paymentFacts(conversion);
  if (!facts.checkedWithStripe) {
    throw fail("STRIPE_CHECK_FAILED", "We couldn't check this payment with Stripe, so nothing was recorded. Try again in a minute.", 503);
  }
  if (kind === "refunded" && !["full", "partial"].includes(facts.oneTime?.refund)) {
    throw fail("NOT_REFUNDED", "Stripe shows no refund on this payment yet. Refund it in Stripe first, then record it here.");
  }
  if (kind === "membership_canceled" && facts.membership?.billsAgain !== false) {
    const next = facts.membership?.nextPaymentAt ? ` and will bill again on ${dateText(facts.membership.nextPaymentAt)}` : "";
    throw fail(
      "MEMBERSHIP_STILL_BILLING",
      `The membership is still active in Stripe${next}. Cancel it on the customer's profile first. A refund alone does not stop the next payment.`
    );
  }
  if (kind === "membership_kept" && facts.membership?.billsAgain === false) {
    throw fail("MEMBERSHIP_NOT_ACTIVE", "This membership has already ended or is set to end in Stripe, so it is not being kept. Choose canceled instead.");
  }

  const verified =
    conversion.kind === "one_time"
      ? { refund: facts.oneTime.refund, refundedCents: facts.oneTime.refundedCents, amountCents: facts.amountCents }
      : {
          status: facts.membership.status,
          cancelAtPeriodEnd: facts.membership.cancelAtPeriodEnd,
          cancelAt: facts.membership.cancelAt,
          nextPaymentAt: facts.membership.nextPaymentAt,
          billsAgain: facts.membership.billsAgain,
        };
  const record = {
    kind,
    for: target,
    note: text,
    at: new Date(),
    by: admin?._id || null,
    byName: admin?.name || admin?.email || "",
    firstPaymentRefunded: kind === "membership_canceled" ? firstPaymentRefunded : null,
    verified,
  };
  const set = target === "attention" ? { status: "closed", resolution: record } : { "afterCancel.resolvedAt": new Date(), resolution: record };
  const filter = target === "attention" ? { _id: conversion._id, status: "needs_attention" } : { _id: conversion._id, "afterCancel.resolvedAt": null };
  const events = [historyEntry("payment_resolved", admin, { resolution: kind, note: text, verified, ...(record.firstPaymentRefunded !== null ? { firstPaymentRefunded } : {}) })];
  if (target === "attention") events.push(historyEntry("closed", admin, { reason: text, resolution: kind }));
  const updated = await FreeVisitConversion.findOneAndUpdate(filter, { $set: set, $push: { history: { $each: events } } }, { new: true });
  if (!updated) throw fail("STALE", "This payment changed while you were recording it. Refresh.");
  return { conversion: updated, facts };
}

/** Wording for the cancel result and the job, in one place. */
function followUpText(facts) {
  if (!facts) return "";
  if (facts.kind === "one_time") {
    return `Paid ${facts.amountCents != null ? money(facts.amountCents) : "(amount in Stripe)"} for the One-Time upgrade. Canceling did not refund it. Refund it in Stripe if needed, then record what you did.`;
  }
  const m = facts.membership || {};
  const bills = m.billsAgain === false ? "It no longer bills." : `It keeps billing${m.nextPaymentAt ? ` (next payment ${dateText(m.nextPaymentAt)})` : ""} until it is canceled on the customer's profile.`;
  return `This visit started a ${facts.offerLabel || "membership"}. Canceling the visit did not cancel the membership or refund its first payment. ${bills} A refund in Stripe alone does not stop future payments.`;
}

module.exports = {
  RESOLUTIONS,
  billsAgain,
  followUpText,
  openFollowUp,
  paymentFacts,
  recordCanceledAfterPayment,
  reinstatedAfterCancel,
  resolvePayment,
};
