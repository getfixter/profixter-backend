const LoyaltyCycle = require("../../models/LoyaltyCycle");
const { breakDays } = require("./loyaltyConfig");
const {
  isContinuityBreak,
  normalizePlan,
  windowForMilestone,
  windowMinimumPlan,
} = require("./loyaltyRules");

/**
 * Reading and writing the ledger.
 *
 * Everything here is idempotent, because everything here is reached from a
 * Stripe webhook and Stripe delivers more than once. The idempotency is not
 * implemented with checks — it is the unique indexes on LoyaltyCycle, and this
 * module's job is to let a duplicate key collide quietly rather than throw.
 */

function trackFilter(user, addressId) {
  return { user, addressId };
}

/** Every counted month at this property, oldest first, reversals removed. */
async function trackCycles(user, addressId, generation) {
  const filter = { ...trackFilter(user, addressId), reversed: false };
  if (generation) filter.generation = generation;
  return LoyaltyCycle.find(filter).sort({ periodStart: 1, createdAt: 1 }).lean();
}

/** The most recent row of any kind, reversed or not. Used to place the next. */
async function latestCycle(user, addressId) {
  return LoyaltyCycle.findOne(trackFilter(user, addressId))
    .sort({ generation: -1, sequence: -1 })
    .lean();
}

/**
 * How far along this property is, and in which run of membership.
 *
 * Counted months are always derived, never stored. A reversed month stops
 * counting the moment it is reversed, with no counter to correct.
 */
async function trackState(user, addressId) {
  const latest = await latestCycle(user, addressId);
  const generation = latest?.generation || 1;
  const cycles = await trackCycles(user, addressId, generation);
  return {
    generation,
    cycles,
    countedMonths: cycles.length,
    latestPeriodEnd: latest?.periodEnd || null,
  };
}

/**
 * Which generation a new month belongs to, and its position in it.
 *
 * A gap longer than the break window starts a new generation. Nothing is
 * deleted when that happens: the old months stay exactly where they are, they
 * simply stop being part of the run that is currently earning.
 */
async function placeCycle({ user, addressId, periodStart, env = process.env }) {
  const latest = await latestCycle(user, addressId);
  if (!latest) return { generation: 1, sequence: 1 };

  const broke = isContinuityBreak({
    previousPeriodEnd: latest.periodEnd,
    nextPeriodStart: periodStart,
    breakDays: breakDays(env),
  });

  if (broke) return { generation: (latest.generation || 1) + 1, sequence: 1 };
  return { generation: latest.generation || 1, sequence: (latest.sequence || 0) + 1 };
}

/**
 * Write one counted month.
 *
 * Returns the row and whether it was new. A duplicate invoice — a replayed
 * event, a retry after a timeout, two deliveries at once — collides on the
 * unique index and comes back as `created: false` with the row that already
 * exists, which is exactly what a second caller should see.
 */
async function recordCycle({
  user,
  userId,
  addressId,
  plan,
  periodStart,
  periodEnd,
  source = "subscription_cycle",
  stripeInvoiceId = null,
  stripeSubscriptionId = null,
  giftMembershipId = null,
  amountPaidCents = 0,
  env = process.env,
}) {
  const normalizedPlan = normalizePlan(plan);
  if (!normalizedPlan) {
    throw new Error(`LoyaltyCycle requires a known plan, received: ${plan}`);
  }

  const { generation, sequence } = await placeCycle({
    user,
    addressId,
    periodStart,
    env,
  });

  try {
    const cycle = await LoyaltyCycle.create({
      user,
      userId,
      addressId,
      plan: normalizedPlan,
      generation,
      sequence,
      periodStart,
      periodEnd,
      source,
      stripeInvoiceId,
      stripeSubscriptionId,
      giftMembershipId,
      amountPaidCents,
      countedAt: new Date(),
    });
    return { cycle: cycle.toObject(), created: true };
  } catch (error) {
    if (error?.code !== 11000) throw error;

    const existing = stripeInvoiceId
      ? await LoyaltyCycle.findOne({ stripeInvoiceId }).lean()
      : await LoyaltyCycle.findOne({ giftMembershipId }).lean();
    return { cycle: existing, created: false };
  }
}

/**
 * Write several seeded gift months at once.
 *
 * They share one gift id, so only the first can be inserted — the unique index
 * is on the gift, not on each month. Position is therefore assigned by shifting
 * the period backwards a month at a time from the conversion, which gives the
 * seeded months real dates that sit before the paid ones and sort correctly.
 */
async function seedGiftCycles({
  user,
  userId,
  addressId,
  plan,
  months,
  giftMembershipId,
  anchorDate,
  env = process.env,
}) {
  if (months <= 0) return { created: 0, cycles: [] };

  const existing = await LoyaltyCycle.findOne({ giftMembershipId }).lean();
  if (existing) return { created: 0, cycles: [], alreadySeeded: true };

  const anchor = new Date(anchorDate);
  const created = [];

  for (let index = months; index >= 1; index -= 1) {
    const periodStart = new Date(anchor);
    periodStart.setMonth(periodStart.getMonth() - index);
    const periodEnd = new Date(anchor);
    periodEnd.setMonth(periodEnd.getMonth() - (index - 1));

    const { generation, sequence } = await placeCycle({
      user,
      addressId,
      periodStart,
      env,
    });

    try {
      const cycle = await LoyaltyCycle.create({
        user,
        userId,
        addressId,
        plan: normalizePlan(plan),
        generation,
        sequence,
        periodStart,
        periodEnd,
        source: "gift_seed",
        /*
         * Only the FIRST seeded month carries the gift id. The unique index on
         * it is what makes seeding happen once; putting the id on every month
         * would make it impossible to write more than one.
         */
        giftMembershipId: index === months ? giftMembershipId : null,
        amountPaidCents: 0,
        countedAt: new Date(),
      });
      created.push(cycle.toObject());
    } catch (error) {
      if (error?.code !== 11000) throw error;
      // Another delivery got there first; the whole seed belongs to it.
      return { created: created.length, cycles: created, alreadySeeded: true };
    }
  }

  return { created: created.length, cycles: created };
}

/**
 * Stop a month counting, because the money came back.
 *
 * The row survives. Anyone asking why a member's progress moved backwards can
 * see which month was reversed, when and why, which is not a question logs
 * could answer six months later.
 */
async function reverseCycleByInvoice(stripeInvoiceId, reason) {
  if (!stripeInvoiceId) return null;
  const result = await LoyaltyCycle.findOneAndUpdate(
    { stripeInvoiceId: String(stripeInvoiceId), reversed: false },
    { $set: { reversed: true, reversedAt: new Date(), reversedReason: reason } },
    { new: true }
  );
  if (result) {
    console.log(
      JSON.stringify({
        level: "info",
        event: "loyalty_cycle_reversed",
        scope: "loyalty",
        stripeInvoiceId: String(stripeInvoiceId),
        reason,
        userId: String(result.userId || ""),
      })
    );
  }
  return result;
}

/** The plans actually paid for across one milestone's window. */
function windowFacts(cycles, milestone) {
  const window = windowForMilestone(milestone, cycles);
  return {
    window,
    plans: window.map((cycle) => cycle.plan),
    minimumPlan: windowMinimumPlan(window),
    startSequence: window[0]?.sequence ?? null,
    endSequence: window[window.length - 1]?.sequence ?? null,
  };
}

module.exports = {
  latestCycle,
  placeCycle,
  recordCycle,
  reverseCycleByInvoice,
  seedGiftCycles,
  trackCycles,
  trackState,
  windowFacts,
};
