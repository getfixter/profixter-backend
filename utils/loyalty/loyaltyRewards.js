const LoyaltyGrant = require("../../models/LoyaltyGrant");
const VisitEntitlement = require("../../models/VisitEntitlement");
const { stripe } = require("../subscriptionManagement");
const { addMonths } = require("../gifts/giftPricing");
const { LOYALTY_FULL_DAY_VALID_DAYS } = require("./loyaltyConfig");
const { milestonesEarnedBy, rewardForMilestone } = require("./loyaltyRules");
const { windowFacts } = require("./loyaltyLedger");

/**
 * Issuing Loyalty Benefits.
 *
 * Every function here is safe to call twice. The guarantee is not a check —
 * it is the unique index on (user, addressId, generation, milestone), which two
 * concurrent webhook deliveries both collide with and only one survives. Reading
 * first and then writing would leave a window between them, and on the other
 * side of that window is a second Full Day or a second free month.
 *
 * NOTHING HERE THROWS INTO THE WEBHOOK. A reward that cannot be issued is
 * recorded as failed with a reason and the renewal is allowed to finish
 * processing, because the alternative — a 500 back to Stripe — makes Stripe
 * retry a payment that was already recorded correctly.
 */

function log(level, event, details = {}) {
  const payload = JSON.stringify({ level, event, scope: "loyalty", ...details });
  if (level === "error") console.error(payload);
  else if (level === "warn") console.warn(payload);
  else console.log(payload);
}

function idOf(value) {
  if (!value) return null;
  return typeof value === "string" ? value : value.id || null;
}

/* -------------------------------------------------------------------------- */
/* The free month                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Every discount already on this subscription, as arguments that would put it
 * back exactly as it is.
 *
 * Stripe exposes discounts in two shapes depending on age — a single `discount`
 * and a `discounts` array — and both have to be read, because a member's
 * promotion code is their money and losing it silently would be the worst kind
 * of bug: invisible, and ours.
 */
function existingDiscountArgs(stripeSubscription) {
  const raw = [];
  if (Array.isArray(stripeSubscription?.discounts)) raw.push(...stripeSubscription.discounts);
  if (stripeSubscription?.discount) raw.push(stripeSubscription.discount);

  const seen = new Set();
  const args = [];
  const ids = [];
  const repeating = [];

  for (const entry of raw) {
    if (!entry) continue;
    const discount = entry.discount || entry;
    const promotionCodeId = idOf(discount.promotion_code);
    const couponId = idOf(discount.coupon);
    const key = promotionCodeId || couponId;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    ids.push(key);

    if (String(discount.coupon?.duration || "") === "repeating") repeating.push(key);
    args.push(promotionCodeId ? { promotion_code: promotionCodeId } : { coupon: couponId });
  }

  const fullyDiscounted = raw.some(
    (entry) => Number((entry?.discount || entry)?.coupon?.percent_off) === 100
  );

  return { args, ids, repeating, fullyDiscounted };
}

/**
 * Put a 100%-off coupon on one subscription, so its next renewal is free.
 *
 * SUBSCRIPTION-SCOPED, WHICH IS THE ENTIRE POINT. A coupon attached to a
 * subscription applies to that subscription's invoices and nothing else. The
 * obvious-looking alternative, a customer balance credit, would have been spent
 * by whichever invoice arrived first — and ProFixter raises real Stripe invoices
 * against the same customer for project work, so a member's free month could
 * have quietly paid for part of somebody's kitchen.
 *
 * A fresh coupon per grant, created under an idempotency key derived from the
 * grant, so a retry reuses the same coupon rather than minting a second one.
 */
async function applyFreeMonthCoupon({ grant, stripeSubscription, stripeClient = stripe }) {
  const existing = existingDiscountArgs(stripeSubscription);

  if (existing.fullyDiscounted) {
    return { ok: false, reason: "already_fully_discounted", priorDiscountIds: existing.ids };
  }

  const coupon = await stripeClient.coupons.create(
    {
      percent_off: 100,
      duration: "once",
      max_redemptions: 1,
      name: "ProFixter Loyalty — 12 month reward",
      metadata: {
        loyaltyGrantId: String(grant._id),
        userId: String(grant.userId || ""),
        addressId: String(grant.addressId || ""),
      },
    },
    { idempotencyKey: `loyalty-free-month-${grant._id}-${grant.reapplyCount || 0}` }
  );

  /*
   * The existing discounts are listed back alongside ours rather than replaced.
   * Stripe's update sets the whole array, so omitting what was there would
   * delete it — which is exactly what the retention offer does today and
   * exactly what must not happen here.
   */
  await stripeClient.subscriptions.update(stripeSubscription.id, {
    discounts: [...existing.args, { coupon: coupon.id }],
    proration_behavior: "none",
  });

  if (existing.repeating.length) {
    log("warn", "loyalty_free_month_relisted_repeating_discount", {
      loyaltyGrantId: String(grant._id),
      stripeSubscriptionId: stripeSubscription.id,
      repeatingDiscountIds: existing.repeating,
      note: "A repeating coupon was re-listed and its duration may have restarted.",
    });
  }

  return { ok: true, couponId: coupon.id, priorDiscountIds: existing.ids, repeating: existing.repeating };
}

/**
 * Whether anything other than a renewal has been invoiced since the grant.
 *
 * THIS IS WHAT STOPS THE FREE MONTH BEING FARMED.
 *
 * A `duration: once` coupon lands on the next invoice for the subscription,
 * whatever that turns out to be — and the customer can raise one on demand,
 * because the Stripe billing portal offers plan changes with
 * proration_behavior "always_invoice". So a member could take the free month,
 * immediately upgrade, let the 100%-off coupon zero a large proration, downgrade
 * again, and then be handed a fresh coupon by the very code meant to protect
 * them from that accident. One benefit in, two benefits out, repeatable.
 *
 * Re-issuing is therefore only automatic when nothing but renewals has happened.
 * Anything else is a case for a person: the money already moved somewhere we did
 * not choose, and guessing wrong in that situation is how the mitigation becomes
 * the exploit.
 *
 * Fails CLOSED. If Stripe cannot be asked, the answer is "something might have",
 * because refusing to re-issue costs a flagged record and re-issuing wrongly
 * costs a month's revenue.
 */
async function nonRenewalInvoiceSince({ grant, stripeSubscriptionId, stripeClient = stripe }) {
  const grantedAt = new Date(grant.grantedAt || Date.now()).getTime();
  try {
    const invoices = await stripeClient.invoices.list({
      subscription: String(stripeSubscriptionId),
      created: { gte: Math.floor(grantedAt / 1000) - 60 },
      limit: 25,
    });
    /*
     * Any invoice that is not a renewal. Deliberately not narrowed to ones
     * carrying our coupon: a list response returns discounts as ids rather than
     * objects, so matching precisely would mean a request per invoice to answer
     * a question whose safe default is already "do not re-issue automatically".
     */
    return (
      (invoices.data || []).find(
        (candidate) => String(candidate.billing_reason || "") !== "subscription_cycle"
      ) || null
    );
  } catch (error) {
    log("warn", "loyalty_free_month_burn_check_failed", {
      loyaltyGrantId: String(grant._id),
      message: error?.message || "could not list invoices",
    });
    return { id: null, billing_reason: "unknown", unchecked: true };
  }
}

/**
 * Prove the free month actually happened, on the invoice it was meant for.
 *
 * Necessary because a `duration: once` coupon lands on the NEXT invoice,
 * whatever that turns out to be. So the renewal is checked rather than assumed —
 * and when it was not free, the reason matters: an ordinary Stripe hiccup is
 * worth retrying, a customer-raised proration is not.
 */
async function verifyFreeMonth({ invoice, stripeSubscription, stripeClient = stripe }) {
  // Oldest first, so if a returning member ever holds two across generations
  // the one that has been waiting longest is settled first rather than an
  // arbitrary one.
  const pending = await LoyaltyGrant.findOne({
    stripeSubscriptionId: String(stripeSubscription?.id || invoice?.subscription || ""),
    rewardKind: "free_month",
    status: "applied",
  }).sort({ grantedAt: 1 });
  if (!pending) return null;

  const amountPaid = Number(invoice?.amount_paid ?? invoice?.amount_due ?? null);

  if (amountPaid === 0) {
    pending.status = "consumed";
    pending.appliedInvoiceId = invoice?.id || null;
    pending.verifiedAmountPaidCents = 0;
    await pending.save();
    log("info", "loyalty_free_month_verified", {
      loyaltyGrantId: String(pending._id),
      invoiceId: invoice?.id || null,
      userId: String(pending.userId || ""),
    });
    return pending;
  }

  /*
   * The renewal was not free. Before anything is re-issued, find out WHY.
   *
   * If a non-renewal invoice has been raised on this subscription since the
   * grant — and a customer can raise one whenever they like, by changing plan in
   * the billing portal — then the coupon most likely paid for that instead. Its
   * value went to the member either way, so handing them a second one would turn
   * one earned benefit into two, on demand, repeatably.
   *
   * That case stops here and asks for a person. Only a renewal-only history
   * gets an automatic retry.
   */
  const burner = await nonRenewalInvoiceSince({
    grant: pending,
    stripeSubscriptionId: stripeSubscription?.id || invoice?.subscription,
    stripeClient,
  });

  if (burner) {
    pending.status = "failed";
    pending.appliedInvoiceId = burner.id || null;
    pending.verifiedAmountPaidCents = amountPaid;
    pending.failureReason = burner.unchecked
      ? "not_reissued_unverified_invoice_history"
      : `not_reissued_coupon_likely_spent_on_${burner.billing_reason} (${burner.id})`;
    pending.needsReview = true;
    await pending.save();
    log("warn", "loyalty_free_month_not_reissued", {
      loyaltyGrantId: String(pending._id),
      renewalInvoiceId: invoice?.id || null,
      amountPaid,
      interveningInvoiceId: burner.id || null,
      interveningBillingReason: burner.billing_reason || null,
    });
    return pending;
  }

  /*
   * Nothing but renewals, so the coupon genuinely failed to apply. Two
   * attempts, then it stops and asks for a person — an automatic retry loop
   * against Stripe money is worse than a flag.
   */
  if ((pending.reapplyCount || 0) >= 2) {
    pending.status = "failed";
    pending.failureReason = `coupon_not_applied_after_retries (invoice ${invoice?.id}, paid ${amountPaid})`;
    pending.needsReview = true;
    await pending.save();
    log("error", "loyalty_free_month_unresolved", {
      loyaltyGrantId: String(pending._id),
      invoiceId: invoice?.id || null,
      amountPaid,
    });
    return pending;
  }

  pending.reapplyCount = (pending.reapplyCount || 0) + 1;
  try {
    const reapplied = await applyFreeMonthCoupon({
      grant: pending,
      stripeSubscription,
      stripeClient,
    });
    if (reapplied.ok) {
      pending.stripeCouponId = reapplied.couponId;
      log("warn", "loyalty_free_month_reapplied", {
        loyaltyGrantId: String(pending._id),
        reason: `previous coupon consumed by invoice ${invoice?.id} (paid ${amountPaid})`,
        attempt: pending.reapplyCount,
      });
    } else {
      /*
       * Refused rather than failed — most likely the subscription already
       * carries a full discount, which means the renewal will be free anyway.
       * Flagged regardless: money that behaved unexpectedly deserves a person,
       * and this is rare enough that a flag costs nothing.
       */
      pending.failureReason = reapplied.reason;
      pending.needsReview = true;
    }
  } catch (error) {
    pending.failureReason = error?.message || "reapply_failed";
    pending.needsReview = true;
    log("error", "loyalty_free_month_reapply_failed", {
      loyaltyGrantId: String(pending._id),
      message: error?.message,
    });
  }
  await pending.save();
  return pending;
}

/* -------------------------------------------------------------------------- */
/* Granting                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Claim the milestone before doing any work.
 *
 * The row is written first, in `granted`, and the unique index decides who won.
 * Whoever loses stops immediately and does nothing — no Stripe call, no
 * entitlement, no email. That ordering is what makes two simultaneous webhook
 * deliveries produce one reward instead of two, and it is why the claim carries
 * the reasoning: by the time anything else runs, the record of why already
 * exists.
 */
async function claimMilestone({ subscription, user, milestone, facts, triggeringInvoiceId, reward }) {
  try {
    return await LoyaltyGrant.create({
      user: user._id,
      userId: user.userId,
      addressId: subscription.addressId,
      generation: facts.generation,
      milestone,
      rewardKind: reward.kind,
      windowMinimumPlan: facts.minimumPlan || null,
      windowPlans: facts.plans || [],
      windowStartSequence: facts.startSequence,
      windowEndSequence: facts.endSequence,
      triggeringInvoiceId: triggeringInvoiceId || null,
      rewardPlan: reward.rewardPlan || null,
      cycles: reward.cycles || null,
      stripeSubscriptionId: subscription.stripeSubscriptionId || null,
      status: "granted",
      grantedAt: new Date(),
    });
  } catch (error) {
    if (error?.code === 11000) return null;
    throw error;
  }
}

/**
 * A temporary plan upgrade: two dates, and nothing written to the subscription.
 *
 * The member keeps paying for the plan they bought. What changes is what
 * `effectivePlan` answers while these dates contain today — which is read by the
 * booking gate, the Full Day gate and the account screen alike, so the benefit is
 * real everywhere the plan is real.
 *
 * The window is measured in months from the period that has just begun, because
 * the reward is expressed in membership cycles and a monthly subscription's
 * periods are exactly a month apart. That also means expiry needs no job: the
 * date arrives whether or not anything is running.
 */
function applyTierUpgradeWindow({ grant, subscription }) {
  const from =
    subscription.currentPeriodStart ||
    subscription.latestPaymentDate ||
    new Date();
  const until = addMonths(from, grant.cycles || 1);

  grant.effectiveFrom = new Date(from);
  grant.effectiveUntil = until;
  return grant;
}

/**
 * An extra Full Day, genuinely extra.
 *
 * Written as a VisitEntitlement so it lands where every other Full Day lands and
 * nothing downstream has to learn a new shape. What separates it from the one
 * Elite already includes is the source: the included benefit is
 * `membership_benefit` and is recognised by its ABSENCE — no record means one is
 * available — while this one is recognised by its presence. The two can never be
 * confused because `findIncludedEntitlement` filters on the included source and
 * will not see this row.
 *
 * The existing per-period unique index does not cover this row, so it carries
 * its own: one entitlement per grant, which is the only duplicate that matters.
 */
async function issueLoyaltyFullDay({ grant, subscription, user, durationMinutes }) {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + LOYALTY_FULL_DAY_VALID_DAYS);

  try {
    return await VisitEntitlement.create({
      user: user._id,
      userId: user.userId,
      addressId: subscription.addressId,
      addressSnapshot: subscription.addressSnapshot || {},
      kind: "full_day_visit",
      source: "loyalty_benefit",
      status: "paid",
      priceCents: 0,
      currency: "usd",
      durationMinutes: durationMinutes || 480,
      loyaltyGrantId: grant._id,
      expiresAt,
      purchasedAt: new Date(),
      holdExpiresAt: null,
    });
  } catch (error) {
    if (error?.code === 11000) {
      return VisitEntitlement.findOne({ loyaltyGrantId: grant._id });
    }
    throw error;
  }
}

/**
 * Decide and issue whatever this renewal has earned.
 *
 * Called once per counted month, straight after the ledger row is written. Does
 * nothing at all in the ordinary case, which is most months.
 *
 * Returns every grant it issued, because one renewal can legitimately settle
 * more than one milestone — a converting gift recipient whose seeded months
 * take them from nothing to four in a single event has earned the three-month
 * reward, and would otherwise skip it.
 */
async function evaluateMilestones(options) {
  const { cycles } = options;
  const outstanding = milestonesEarnedBy(cycles.length);
  const granted = [];

  for (const milestone of outstanding) {
    const grant = await issueMilestone({ ...options, milestone });
    if (grant) granted.push(grant);
  }
  return granted;
}

/** One milestone, claimed and delivered, or nothing if it was already taken. */
async function issueMilestone({
  user,
  subscription,
  cycles,
  generation,
  milestone,
  triggeringInvoiceId,
  stripeSubscription,
  fullDayMinutes,
}) {
  const facts = { ...windowFacts(cycles, milestone), generation };
  const reward = rewardForMilestone(milestone, facts.minimumPlan);
  if (!reward) {
    log("warn", "loyalty_milestone_no_reward", {
      milestone,
      windowMinimumPlan: facts.minimumPlan,
      userId: String(user.userId || ""),
    });
    return null;
  }

  const grant = await claimMilestone({
    subscription,
    user,
    milestone,
    facts,
    triggeringInvoiceId,
    reward,
  });
  // Already granted — by an earlier renewal, or by a racing delivery of this
  // one. Either way the correct outcome is to do nothing at all.
  if (!grant) return null;

  try {
    if (reward.kind === "tier_upgrade") {
      applyTierUpgradeWindow({ grant, subscription });
      await grant.save();
    } else if (reward.kind === "loyalty_full_day") {
      const entitlement = await issueLoyaltyFullDay({
        grant,
        subscription,
        user,
        durationMinutes: fullDayMinutes,
      });
      grant.visitEntitlementId = entitlement?._id || null;
      await grant.save();
    } else if (reward.kind === "free_month") {
      const applied = await applyFreeMonthCoupon({ grant, stripeSubscription });
      grant.priorDiscountIds = applied.priorDiscountIds || [];
      if (applied.ok) {
        grant.stripeCouponId = applied.couponId;
        grant.status = "applied";
      } else {
        grant.status = "failed";
        grant.failureReason = applied.reason;
        grant.needsReview = true;
      }
      await grant.save();
    }
  } catch (error) {
    grant.status = "failed";
    grant.failureReason = error?.message || "grant_failed";
    grant.needsReview = true;
    await grant.save().catch(() => {});
    log("error", "loyalty_grant_failed", {
      loyaltyGrantId: String(grant._id),
      milestone,
      rewardKind: reward.kind,
      message: error?.message,
    });
    return grant;
  }

  log("info", "loyalty_reward_granted", {
    loyaltyGrantId: String(grant._id),
    userId: String(user.userId || ""),
    addressId: String(subscription.addressId || ""),
    milestone,
    rewardKind: reward.kind,
    rewardPlan: grant.rewardPlan || null,
    windowMinimumPlan: facts.minimumPlan || null,
    triggeringInvoiceId: triggeringInvoiceId || null,
  });

  return grant;
}

/** Live tier upgrades at one property. Read by the effective-plan seam. */
async function activeGrantsFor(user, addressId) {
  return LoyaltyGrant.find({
    user,
    addressId,
    rewardKind: "tier_upgrade",
    status: "granted",
    effectiveUntil: { $gt: new Date() },
  }).lean();
}

module.exports = {
  activeGrantsFor,
  applyFreeMonthCoupon,
  applyTierUpgradeWindow,
  claimMilestone,
  evaluateMilestones,
  existingDiscountArgs,
  issueLoyaltyFullDay,
  issueMilestone,
  nonRenewalInvoiceSince,
  verifyFreeMonth,
};
