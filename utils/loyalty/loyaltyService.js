const GiftMembership = require("../../models/GiftMembership");
const LoyaltyGrant = require("../../models/LoyaltyGrant");
const Subscription = require("../../models/Subscription");
const User = require("../../models/User");
const mail = require("../emailService");
const { getFullDayVisitSettings } = require("../fullDayVisitSettings");
const {
  ensureVisitEntitlementIndexesOnce,
} = require("../visitEntitlementIndexSafety");
const { GIFT_SEED_CAP_MONTHS, breakDays, effectiveAt, loyaltyActive } = require("./loyaltyConfig");
const {
  giftMonthsDelivered,
  giftSeedMonths,
  isContinuityBreak,
  isCountableInvoice,
  isEligibleBillingCycle,
  isWithinProgram,
  normalizePlan,
} = require("./loyaltyRules");
const { recordCycle, seedGiftCycles, trackState, reverseCycleByInvoice } = require("./loyaltyLedger");
const { evaluateMilestones, verifyFreeMonth } = require("./loyaltyRewards");
const { describeReward, planLabel } = require("./loyaltyProgress");

/**
 * The one entry point the Stripe webhook calls.
 *
 * Everything Loyalty Benefits does in response to money moving happens here, in
 * order, once. It runs inside the webhook's existing event claim — the unique
 * index on StripeWebhookEvent.eventId — so a Stripe retry does not re-enter it
 * at all; the unique indexes underneath are the second line of defence, for
 * genuine races between different events.
 *
 * IT NEVER THROWS INTO THE WEBHOOK. A loyalty failure must not turn a
 * successfully processed renewal into a 500, because Stripe would then retry a
 * payment that was already recorded correctly. Anything that goes wrong is
 * logged and, where it concerns a reward, written to the grant so it can be
 * found later. The ledger is reconstructable from Stripe invoices, so losing a
 * row is recoverable; corrupting the subscription sync is not.
 */

function log(level, event, details = {}) {
  const payload = JSON.stringify({ level, event, scope: "loyalty", ...details });
  if (level === "error") console.error(payload);
  else if (level === "warn") console.warn(payload);
  else console.log(payload);
}

function toDate(value) {
  if (!value) return null;
  if (typeof value === "number") return new Date(value * 1000);
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The months a converting gift recipient brings with them.
 *
 * Only on their FIRST counted month, and only from gifts at this same property
 * that have actually finished delivering. A gift is coverage somebody else paid
 * for at this address, so carrying it forward is honest; carrying forward a gift
 * that was bought but never claimed, or one still running, would not be.
 *
 * Deliberately NOT a parallel clock. Gifts have no renewal event and nothing to
 * count against, so inventing a monthly gift ledger would have meant a second
 * state machine to keep in step with the first. This is one write, at one
 * moment, guarded by one unique index on the gift.
 */
async function seedFromGiftsIfFirstCycle({ user, subscription, periodStart, env }) {
  const gifts = await GiftMembership.find({
    recipient: user._id,
    addressId: subscription.addressId,
    status: "claimed",
  })
    .sort({ startAt: 1 })
    .lean();

  if (!gifts.length) return null;

  const delivered = gifts.reduce(
    (total, gift) => total + giftMonthsDelivered(gift, periodStart),
    0
  );
  const months = giftSeedMonths({ deliveredMonths: delivered, cap: GIFT_SEED_CAP_MONTHS });
  if (months <= 0) return null;

  /*
   * The gift must be recent enough to be the same run of membership. Somebody
   * whose gift ended two years ago is starting fresh, not continuing.
   */
  const lastEnd = gifts
    .map((gift) => toDate(gift.endAt))
    .filter(Boolean)
    .sort((a, b) => b - a)[0];

  if (
    lastEnd &&
    isContinuityBreak({
      previousPeriodEnd: lastEnd,
      nextPeriodStart: periodStart,
      breakDays: breakDays(env),
    })
  ) {
    return null;
  }

  // The most recently delivered gift decides the plan those months count as.
  const source = gifts[gifts.length - 1];
  const seeded = await seedGiftCycles({
    user: user._id,
    userId: user.userId,
    addressId: subscription.addressId,
    plan: normalizePlan(source.plan) || normalizePlan(subscription.subscriptionType),
    months,
    giftMembershipId: source._id,
    anchorDate: periodStart,
    env,
  });

  if (seeded.created) {
    log("info", "loyalty_gift_months_seeded", {
      userId: String(user.userId || ""),
      addressId: String(subscription.addressId || ""),
      giftNumber: source.giftNumber || null,
      deliveredMonths: delivered,
      seededMonths: seeded.created,
    });
  }
  return seeded;
}

/** Tell the customer, once per grant, and never at the cost of the webhook. */
async function notifyGrant({ user, subscription, grant }) {
  if (!grant || grant.notifiedAt) return;
  if (["failed"].includes(grant.status)) return;

  const described = describeReward({
    kind: grant.rewardKind,
    rewardPlan: grant.rewardPlan,
    cycles: grant.cycles,
  });

  try {
    await mail.sendTx(
      "loyalty_benefit_unlocked",
      user.email,
      {
        name: user.name || String(user.email || "").split("@")[0],
        rewardHeadline: described?.headline || "Your Loyalty Benefit",
        rewardDetail: described?.detail || "",
        plan: planLabel(subscription.subscriptionType),
        address: subscription.addressSnapshot
          ? `${subscription.addressSnapshot.line1}, ${subscription.addressSnapshot.city}, ${subscription.addressSnapshot.state}`
          : null,
        throughDate: grant.effectiveUntil
          ? mail.formatNYCTime(new Date(grant.effectiveUntil).toISOString())
          : null,
        milestone: grant.milestone,
      },
      {
        bccAdmin: false,
        logContext: {
          userId: user._id,
          customerName: user.name || "",
          customerEmail: user.email,
          recipientName: user.name || "",
          recipientEmail: user.email,
          emailType: "billing",
          source: "loyaltyBenefits",
        },
      }
    );
    grant.notifiedAt = new Date();
    await grant.save();
  } catch (error) {
    // A mail failure must not cost the customer the benefit they earned.
    log("warn", "loyalty_benefit_email_failed", {
      loyaltyGrantId: String(grant._id),
      message: error?.message,
    });
  }
}

/**
 * A membership renewal was paid. Count it, and see what it earned.
 *
 * The gate at the top is the whole no-retroactive-credit and no-gaming story,
 * and every clause of it matters:
 *
 *  - the program has to be switched on and have a start date;
 *  - the invoice has to be a genuine `subscription_cycle` renewal, so signups
 *    and upgrade prorations — which a customer can raise at will from the
 *    billing portal — cannot manufacture months;
 *  - the membership has to be monthly, because annual has no monthly boundary;
 *  - the invoice has to be dated inside the program's life, which is why no
 *    member can arrive on launch day already holding months.
 */
async function recordRenewal({ invoice, stripeSubscription, env = process.env }) {
  try {
    if (!loyaltyActive(env)) return null;
    if (!isCountableInvoice(invoice)) return null;

    const startedAt = effectiveAt(env);
    const invoiceDate = toDate(invoice.created) || new Date();
    if (!isWithinProgram(invoiceDate, startedAt)) {
      log("info", "loyalty_cycle_before_program_start", {
        stripeInvoiceId: invoice.id,
        invoiceCreated: invoiceDate.toISOString(),
        programStartedAt: startedAt.toISOString(),
      });
      return null;
    }

    const subscription = await Subscription.findOne({
      stripeSubscriptionId: String(invoice.subscription),
    });
    if (!subscription) return null;
    if (!isEligibleBillingCycle(subscription.billingCycle)) return null;

    const plan = normalizePlan(subscription.subscriptionType);
    if (!plan) return null;

    const user = await User.findById(subscription.user);
    if (!user) return null;

    const periodStart =
      toDate(invoice.period_start) || toDate(subscription.currentPeriodStart) || invoiceDate;
    const periodEnd =
      toDate(invoice.period_end) || toDate(subscription.currentPeriodEnd) || null;

    /*
     * Gift months are seeded before the first paid month is written, so they
     * sit ahead of it in the ledger and the windows read in the right order.
     */
    const before = await trackState(user._id, subscription.addressId);
    if (before.countedMonths === 0) {
      await seedFromGiftsIfFirstCycle({ user, subscription, periodStart, env }).catch((error) =>
        log("warn", "loyalty_gift_seed_failed", { message: error?.message })
      );
    }

    const { cycle, created } = await recordCycle({
      user: user._id,
      userId: user.userId,
      addressId: subscription.addressId,
      plan,
      periodStart,
      periodEnd: periodEnd || periodStart,
      source: "subscription_cycle",
      stripeInvoiceId: invoice.id,
      stripeSubscriptionId: subscription.stripeSubscriptionId,
      amountPaidCents: Number(invoice.amount_paid || 0),
      env,
    });

    // A free month's own invoice proves the previous reward before earning more.
    await verifyFreeMonth({ invoice, stripeSubscription }).catch((error) =>
      log("warn", "loyalty_free_month_verification_failed", { message: error?.message })
    );

    if (!created) {
      log("info", "loyalty_cycle_duplicate_ignored", { stripeInvoiceId: invoice.id });
      return cycle;
    }

    const after = await trackState(user._id, subscription.addressId);
    log("info", "loyalty_cycle_counted", {
      userId: String(user.userId || ""),
      addressId: String(subscription.addressId || ""),
      plan,
      generation: after.generation,
      countedMonths: after.countedMonths,
      stripeInvoiceId: invoice.id,
    });

    let settings = null;
    try {
      settings = await getFullDayVisitSettings();
    } catch (_error) {
      settings = null;
    }

    await ensureVisitEntitlementIndexesOnce().catch(() => {});

    /*
     * More than one milestone can legitimately settle on one renewal — a
     * converting gift recipient can go from nothing to four months in a single
     * event — so this returns a list and every one of them is told to the
     * customer separately.
     */
    const grants = await evaluateMilestones({
      user,
      subscription,
      cycles: after.cycles,
      generation: after.generation,
      triggeringInvoiceId: invoice.id,
      stripeSubscription,
      fullDayMinutes: (settings?.approximateHours || 8) * 60,
    });

    for (const grant of grants) {
      await notifyGrant({ user, subscription, grant });
    }

    return cycle;
  } catch (error) {
    log("error", "loyalty_record_renewal_failed", {
      stripeInvoiceId: invoice?.id || null,
      message: error?.message || "unknown loyalty failure",
      stack: error?.stack || null,
    });
    return null;
  }
}

/**
 * Money came back, so a month stops counting.
 *
 * Deliberately narrow. It reverses the ledger row and nothing else: a reward
 * already given is not clawed back, because taking a Full Day off somebody
 * weeks after they were told it was theirs is worse than the month of credit is
 * worth, and the grant record still shows exactly which months earned it.
 */
async function reverseRenewal({ stripeInvoiceId, reason, env = process.env }) {
  if (!loyaltyActive(env)) return null;
  try {
    return await reverseCycleByInvoice(stripeInvoiceId, reason);
  } catch (error) {
    log("error", "loyalty_reverse_failed", {
      stripeInvoiceId: stripeInvoiceId || null,
      message: error?.message,
    });
    return null;
  }
}

/**
 * A charge was refunded or disputed. Find the membership month behind it.
 *
 * Stripe hands us a charge, not an invoice, so the invoice is read off the
 * charge. Anything that is not a membership renewal simply finds no ledger row
 * and does nothing, which is how tips, gifts and project invoices stay out of
 * this entirely.
 */
async function reverseFromCharge({ charge, reason, env = process.env }) {
  const invoiceId = typeof charge?.invoice === "string" ? charge.invoice : charge?.invoice?.id;
  if (!invoiceId) return null;
  return reverseRenewal({ stripeInvoiceId: invoiceId, reason, env });
}

/** Grants that need a person: rare, and worth being able to list. */
async function grantsNeedingReview() {
  return LoyaltyGrant.find({ needsReview: true }).sort({ grantedAt: -1 }).lean();
}

module.exports = {
  grantsNeedingReview,
  notifyGrant,
  recordRenewal,
  reverseFromCharge,
  reverseRenewal,
  seedFromGiftsIfFirstCycle,
};
