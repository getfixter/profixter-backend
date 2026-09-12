const Subscription = require("../../models/Subscription");
const GiftMembership = require("../../models/GiftMembership");
const { subscriptionGrantsAccess } = require("../subscriptionManagement");
const { giftAccessState } = require("../gifts/giftAccess");
const { placeZipCluster, hasGeographyFor } = require("./publicPoint");
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
 * A list of {x, y}. No name, no address, no ZIP, no coordinates, no user, no
 * subscription, no gift, no id of any kind, no count of anything - and, since
 * V3, no membership tier either. The ids and plans that exist in this file are
 * used to decide who belongs on the map and are never emitted.
 *
 * Dropping the tier is data minimisation rather than decoration: the map only
 * ever needed to say that somebody here is a member, and a published plan would
 * have let anyone reading the network tab rank ProFixter customers by spend.
 *
 * WHAT IS NOT PUBLISHED, ON PURPOSE
 *
 * Totals. Not overall, not per plan, not per town. The array has a length, which
 * is unavoidable in any pin-based map, but nothing in the payload or the UI
 * states a number and nothing here computes one for publication.
 */

/**
 * The tiers a membership may hold.
 *
 * INTERNAL ONLY SINCE V3. Nothing here reaches the browser; the list survives
 * because an unrecognised subscriptionType is not a membership this map will
 * publish, which is an eligibility rule rather than a display one.
 */
const PLANS = ["basic", "plus", "premium", "elite"];

/**
 * How long a built map is reused.
 *
 * Ninety seconds, down from five minutes in V1, and it is the whole mechanism -
 * see the note below the cache for why the obvious event-driven version was
 * built and then taken out again.
 *
 * This is also the only thing that can notice the changes nobody writes: a
 * subscription whose period simply elapses, or a gift that reaches its end date.
 * Those records stop granting access because time passed, so no hook anywhere
 * would have fired for them and only a re-read finds them.
 *
 * At most one aggregate query per ninety seconds, regardless of traffic.
 */
const CACHE_TTL_MS = 90 * 1000;

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
 * Memberships are grouped by ZIP before any position is chosen, because the
 * right spread is a property of the group rather than of one member: a lone
 * membership should sit on its town, and only genuine crowding justifies
 * pushing pins apart. Placing one at a time - which is what V1 did - has no way
 * to know the difference, so it scattered everybody to solve a collision most
 * of them did not have.
 *
 * A membership that cannot be placed safely is skipped rather than guessed at.
 * An unknown ZIP has no shape to constrain a pin to, and a pin that is merely
 * somewhere on Long Island would be decoration pretending to be information.
 */
async function buildPayload({ now = new Date() } = {}) {
  const memberships = await activeMemberships({ now });

  /* Group first, place second. */
  const byZip = new Map();
  for (const membership of memberships) {
    if (!hasGeographyFor(membership.zip)) continue;
    if (!byZip.has(membership.zip)) byZip.set(membership.zip, []);
    byZip.get(membership.zip).push(membership);
  }

  const points = [];
  for (const [zip, group] of byZip) {
    const placed = placeZipCluster({ zip, seeds: group.map((m) => m.seed) });
    for (const membership of group) {
      const point = placed.get(membership.seed);
      if (!point) continue;
      const projected = project(point.lat, point.lng);
      if (!projected) continue;
      /*
       * THE PLAN IS READ AND THEN DROPPED, DELIBERATELY.
       *
       * It is still required upstream - an unrecognised tier is not a
       * membership this map will publish - but it stops here. The public map
       * says that somebody in this area is a member; which tier they pay for is
       * their business and nobody else's, and a payload that carried it would
       * let anyone with devtools sort ProFixter's customers by spend.
       */
      points.push({ x: projected.x, y: projected.y });
    }
  }

  /*
   * Ordered by position alone now that every marker looks the same.
   *
   * This used to paint rarer tiers last so they were not hidden under a
   * neighbouring Basic pin. With one universal marker there is no tier to
   * favour, and sorting by position keeps the order stable between builds so
   * the entrance animation does not reshuffle itself.
   */
  points.sort((a, b) => a.y - b.y || a.x - b.x);

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

/*
 * WHY THERE IS NO EVENT-DRIVEN INVALIDATION HERE.
 *
 * The obvious improvement is to clear this cache the moment a membership is
 * written, and it was built and then removed, because it did not work and did
 * not say so.
 *
 * Mongoose compiles middleware into a model when mongoose.model() runs. This
 * module requires the models, so anything it registers with Model.schema.post()
 * afterwards is accepted without complaint and never fires. Measured: after a
 * second membership was saved, the cache still served one pin; after a
 * deleteMany, it still served one pin. A stale map that believes it is fresh is
 * worse than one that admits it is ninety seconds old.
 *
 * Making it genuinely work needs one of three things, none of which a homepage
 * decoration has earned. Declaring the hooks inside models/Subscription.js and
 * models/GiftMembership.js means those models importing this one, which is a
 * circular dependency. Calling clearCache() from every write site means the
 * Stripe webhook, the checkout route, several admin routes and the gift
 * lifecycle all have to remember - and the one added next year will not, and
 * nothing will fail. Change streams mean a second persistent connection to
 * Mongo for a marketing band.
 *
 * So the TTL above is the mechanism, deliberately, at the short end of the
 * range: ninety seconds, one aggregate query per window regardless of traffic.
 */

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
