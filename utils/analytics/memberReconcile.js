/**
 * One membership count that adds up.
 *
 * Members are counted from Mongo (one membership per home: paid or gift).
 * Paying vs comped comes from Stripe (what each subscription actually bills
 * after ongoing coupons). Before this, the Overview showed both lists side by
 * side without matching them - "37 active" next to "36 paying + 2 comped" -
 * and the two never could agree: a Stripe subscription can bill with no
 * member record behind it, a membership can exist with no Stripe
 * subscription (an admin grant, a gift), and a Stripe-linked membership can
 * be one Stripe no longer bills.
 *
 * reconcileMembers matches every ACTIVE member to its Stripe subscription -
 * by subscription id, then (for a member whose stored id is missing or stale,
 * e.g. after a plan change created a new subscription) by the member's Stripe
 * customer id - and puts each in exactly one bucket, so
 *
 *   active = paying + comped + gifts + manual + notBilling        (always)
 *
 * and lists, separately, Stripe subscriptions that bill but match no active
 * member ("stripeOnly"). MRR is Stripe's total, so it includes those; the
 * part that belongs to them is reported so nobody has to guess.
 *
 * Pure. No personal data in the output - counts and cents only.
 */
function reconcileMembers(activeMembers, stripeMrr) {
  const out = {
    active: activeMembers.length,
    paying: 0,
    comped: 0,
    gifts: 0,
    manual: 0, // a paid-type membership with no Stripe subscription (e.g. an admin grant)
    notBilling: 0, // linked to a Stripe subscription that Stripe is not billing (trialing, canceled, unknown)
    stripeOnly: null, // { count, netCents } - billing in Stripe, no active member behind it
    available: Boolean(stripeMrr?.available && Array.isArray(stripeMrr.rows)),
  };
  if (!out.available) {
    // Without Stripe only what Mongo knows can be said.
    for (const m of activeMembers) {
      if (m.kind === "gift") out.gifts += 1;
      else if (!m.stripeSubscriptionId) out.manual += 1;
    }
    out.paying = null;
    out.comped = null;
    out.notBilling = null;
    return out;
  }
  const rowById = new Map(stripeMrr.rows.map((r) => [r.id, r]));
  const matched = new Set();
  const pending = [];
  const count = (row) => {
    matched.add(row.id);
    if (row.netCents > 0) out.paying += 1;
    else out.comped += 1;
  };
  // pass 1: exact subscription id
  for (const m of activeMembers) {
    if (m.kind === "gift") {
      out.gifts += 1;
      continue;
    }
    const row = m.stripeSubscriptionId ? rowById.get(m.stripeSubscriptionId) : null;
    if (row && !matched.has(row.id)) count(row);
    else pending.push(m);
  }
  // pass 2: the same Stripe customer, for ids that are missing or stale
  for (const m of pending) {
    const row = m.stripeCustomerId ? stripeMrr.rows.find((r) => !matched.has(r.id) && r.customer && r.customer === m.stripeCustomerId) : null;
    if (row) count(row);
    else if (!m.stripeSubscriptionId) out.manual += 1; // never linked to Stripe: an admin grant
    else out.notBilling += 1;
  }
  const unmatched = stripeMrr.rows.filter((r) => !matched.has(r.id));
  out.stripeOnly = {
    count: unmatched.length,
    paying: unmatched.filter((r) => r.netCents > 0).length,
    netCents: unmatched.reduce((s, r) => s + r.netCents, 0),
  };
  out.balanced = out.paying + out.comped + out.gifts + out.manual + out.notBilling === out.active;
  return out;
}

module.exports = { reconcileMembers };
