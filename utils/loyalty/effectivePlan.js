const LoyaltyGrant = require("../../models/LoyaltyGrant");
const { loyaltyActive } = require("./loyaltyConfig");
const { resolveEffectivePlan, normalizePlan } = require("./loyaltyRules");

/**
 * What plan to treat a member as having, right now.
 *
 * THE ONE SEAM. A loyalty upgrade never touches Stripe and never writes
 * `subscription.subscriptionType` — the member goes on paying for the plan they
 * bought, and their Stripe subscription stays exactly what it was. What changes
 * is the answer this module gives, and everything that cares about a plan asks
 * here instead of reading the field directly: the booking gate, the Full Day
 * gate and the coverage map the whole customer UI is built from.
 *
 * That is what makes the reward survive the plans changing. When Premium gains
 * new benefits, "complimentary Premium benefits" gains them too, because the
 * loyalty program never enumerated what Premium meant — it only ever said which
 * plan to treat the member as being on.
 *
 * ONLY EVER UPWARD. A grant that no longer beats the paid plan is ignored
 * rather than applied, so this can never take something away from somebody.
 */

const EMPTY = Object.freeze({ plan: null, paidPlan: null, source: "paid", until: null, grant: null });

function inertResult(paidPlan) {
  const plan = normalizePlan(paidPlan);
  return { plan, paidPlan: plan, source: "paid", until: null, grant: null };
}

/**
 * Live tier upgrades, for one property or for every property at once.
 *
 * The batch form exists because the coverage map is built on every sign-in and
 * every /me, for every address a customer has. One query for the customer beats
 * one query per address, and a customer who has never earned anything — which
 * on launch day is all of them — costs a single empty lookup on that path.
 */
async function findActiveTierGrants({ user, addressId = null, now = new Date() }) {
  const filter = {
    user,
    rewardKind: "tier_upgrade",
    status: "granted",
    effectiveUntil: { $gt: now },
  };
  if (addressId) filter.addressId = addressId;
  return LoyaltyGrant.find(filter).lean();
}

/** The effective plan at one property. */
async function effectivePlan({ user, addressId, paidPlan, now = new Date(), env = process.env }) {
  if (!loyaltyActive(env) || !user || !addressId) return inertResult(paidPlan);

  const grants = await findActiveTierGrants({ user, addressId, now });
  if (!grants.length) return inertResult(paidPlan);

  return resolveEffectivePlan({ paidPlan, grants, now });
}

/**
 * Effective plans for every address a customer holds, in one query.
 *
 * Takes the paid plan per address and returns the same map with loyalty applied,
 * so the caller never has to know which addresses have grants.
 */
async function effectivePlansForUser({
  user,
  paidPlanByAddress = new Map(),
  now = new Date(),
  env = process.env,
}) {
  const result = new Map();
  for (const [addressId, paidPlan] of paidPlanByAddress) {
    result.set(String(addressId), inertResult(paidPlan));
  }

  if (!loyaltyActive(env) || !user || !paidPlanByAddress.size) return result;

  const grants = await findActiveTierGrants({ user, now });
  if (!grants.length) return result;

  const byAddress = new Map();
  for (const grant of grants) {
    const key = String(grant.addressId);
    if (!byAddress.has(key)) byAddress.set(key, []);
    byAddress.get(key).push(grant);
  }

  for (const [addressId, paidPlan] of paidPlanByAddress) {
    const key = String(addressId);
    const forAddress = byAddress.get(key);
    if (!forAddress?.length) continue;
    result.set(key, resolveEffectivePlan({ paidPlan, grants: forAddress, now }));
  }

  return result;
}

/**
 * The effective plan for a subscription record, resolved defensively.
 *
 * A loyalty lookup must never be able to stop somebody booking or signing in, so
 * a failure here degrades to the paid plan — which is the behaviour that existed
 * before this feature — rather than propagating. It is logged because silently
 * withholding a benefit somebody earned is not acceptable either.
 */
async function effectivePlanForSubscription(subscription, options = {}) {
  const paidPlan = normalizePlan(subscription?.subscriptionType);
  if (!subscription?.user || !subscription?.addressId) return inertResult(paidPlan);

  try {
    return await effectivePlan({
      user: subscription.user,
      addressId: subscription.addressId,
      paidPlan,
      now: options.now,
      env: options.env,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "loyalty_effective_plan_lookup_failed",
        scope: "loyalty",
        subscriptionId: String(subscription._id || ""),
        message: error?.message || "effective plan lookup failed",
      })
    );
    return inertResult(paidPlan);
  }
}

module.exports = {
  EMPTY,
  effectivePlan,
  effectivePlanForSubscription,
  effectivePlansForUser,
  findActiveTierGrants,
};
