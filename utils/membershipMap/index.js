const Subscription = require("../../models/Subscription");
const GiftMembership = require("../../models/GiftMembership");
const { subscriptionGrantsAccess } = require("../subscriptionManagement");
const { giftAccessState } = require("../gifts/giftAccess");
const { publicPointFor, hasGeographyFor } = require("./publicPoint");
const { MAP_BOUNDS, VIEWBOX, project } = require("./projection");

/**
 * The public membership map: what is published, and what is deliberately not.
 *
 * ONE DEFINITION OF ACTIVE, BORROWED RATHER THAN REBUILT.
 *
 * A pin exists if and only if the same authority the rest of the application
 * uses says the membership grants access right now - subscriptionGrantsAccess
 * for paid cover, giftAccessState for a claimed gift. Nothing here re-implements
 * "active", so cancellation, expiry, cancel-at-period-end, the Stripe access
 * latch and trialing are all inherited. A pin disappears for exactly the same
 * reason a member loses their booking button, which is the only way these two
 * can be guaranteed to agree.
 *
 * WHAT LEAVES THIS MODULE
 *
 * A list of {x, y, plan}. No name, no address, no ZIP, no coordinates, no user,
 * no subscription, no gift, no id of any kind, and no count of anything. The
 * ids that exist in this file are used as hash input and never emitted.
 *
 * WHAT IS NOT PUBLISHED, ON PURPOSE
 *
 * Totals. Not overall, not per plan, not per town. The array has a length, which
 * is unavoidable in any pin-based map, but nothing in the payload or the UI
 * states a number and nothing here computes one for publication.
 */

/** Plan tiers, in the order the legend presents them. */
const PLANS = ["basic", "plus", "premium", "elite"];

/**
 * How long a built map is reused.
 *
 * Membership changes do not need to reach the homepage in under a second, and
 * the homepage should not put a query on the database per visitor. Five minutes
 * means one aggregate read per five minutes no matter the traffic, and a
 * cancellation is off the map within one window.
 */
const CACHE_TTL_MS = 5 * 60 * 1000;

let cache = { at: 0, payload: null };

function normalizePlan(value) {
  const plan = String(value || "").trim().toLowerCase();
  return PLANS.includes(plan) ? plan : null;
}

function zipOf(snapshot) {
  const zip = String(snapshot?.zip || "").trim();
  return /^\d{5}$/.test(zip) ? zip : null;
}

/**
 * Every currently-active membership, as {zip, plan, seed}.
 *
 * Paid cover is resolved first and gifts only fill addresses it has not already
 * claimed - the same ordering buildPerAddressCoverage and the booking API use.
 * Without it a member holding both would produce two pins for one home.
 */
async function activeMemberships({ now = new Date() } = {}) {
  const claimed = new Map();
  const out = [];

  /*
   * Narrowed in the query to the only two statuses that can possibly grant
   * access, then confirmed one by one by the authority. The query is an index
   * hint, not the rule - subscriptionGrantsAccess still decides.
   */
  const subs = await Subscription.find({ status: { $in: ["active", "trialing"] } })
    .select("_id user addressId subscriptionType status accessStatus stripeSubscriptionId currentPeriodEnd cancelAtPeriodEnd cancellationDate addressSnapshot")
    .lean();

  for (const sub of subs) {
    if (!subscriptionGrantsAccess(sub, { now })) continue;
    const plan = normalizePlan(sub.subscriptionType);
    const zip = zipOf(sub.addressSnapshot);
    if (!plan || !zip) continue;

    const key = sub.addressId ? `addr:${sub.addressId}` : `user:${sub.user}:${zip}`;
    if (claimed.has(key)) continue;
    claimed.set(key, true);
    out.push({ zip, plan, seed: `sub:${sub._id}` });
  }

  /*
   * A claimed gift is a real active membership - it is what the coverage map,
   * the booking API and the member UI all treat it as - so it belongs on a map
   * of where ProFixter members are. Same authority, no second definition.
   */
  const gifts = await GiftMembership.find({ status: "claimed" })
    .select("_id recipient addressId plan status startAt endAt cancelledReason addressSnapshot")
    .lean();

  for (const gift of gifts) {
    if (!giftAccessState(gift, now).active) continue;
    const plan = normalizePlan(gift.plan);
    const zip = zipOf(gift.addressSnapshot);
    if (!plan || !zip) continue;

    const key = gift.addressId ? `addr:${gift.addressId}` : `user:${gift.recipient}:${zip}`;
    if (claimed.has(key)) continue;
    claimed.set(key, true);
    out.push({ zip, plan, seed: `gift:${gift._id}` });
  }

  return out;
}

/**
 * Build the published payload.
 *
 * A membership that cannot be placed safely is skipped rather than guessed at.
 * An unknown ZIP has no shape to constrain a pin to, and a pin that is merely
 * somewhere on Long Island would be a decoration pretending to be information.
 */
async function buildPayload({ now = new Date() } = {}) {
  const memberships = await activeMemberships({ now });
  const points = [];

  for (const membership of memberships) {
    if (!hasGeographyFor(membership.zip)) continue;
    const point = publicPointFor({ zip: membership.zip, seed: membership.seed });
    if (!point) continue;

    const projected = project(point.lat, point.lng);
    if (!projected) continue;

    points.push({ x: projected.x, y: projected.y, plan: membership.plan });
  }

  /*
   * Ordered by plan so the rarer tiers paint last and are not hidden under a
   * neighbouring Basic pin. Within a tier, by position, so the render order is
   * stable between builds and the entrance animation does not reshuffle.
   */
  points.sort((a, b) => {
    const tier = PLANS.indexOf(a.plan) - PLANS.indexOf(b.plan);
    if (tier !== 0) return tier;
    return a.y - b.y || a.x - b.x;
  });

  return { viewBox: VIEWBOX, points };
}

/** The cached payload, rebuilt at most once per TTL. */
async function getPayload({ now = new Date(), force = false } = {}) {
  const age = Date.now() - cache.at;
  if (!force && cache.payload && age < CACHE_TTL_MS) return cache.payload;

  const payload = await buildPayload({ now });
  cache = { at: Date.now(), payload };
  return payload;
}

function clearCache() {
  cache = { at: 0, payload: null };
}

module.exports = {
  CACHE_TTL_MS,
  MAP_BOUNDS,
  PLANS,
  VIEWBOX,
  activeMemberships,
  buildPayload,
  clearCache,
  getPayload,
};
