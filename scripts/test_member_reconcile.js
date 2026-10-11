/**
 * The membership count adds up: every active member is matched to what Stripe
 * bills and lands in exactly one bucket; Stripe subscriptions with no member
 * behind them are reported apart. Reproduces the Oct 2026 mismatch
 * ("37 active" next to "36 paying + 2 comped").
 *   node scripts/test_member_reconcile.js
 */
const assert = require("assert");
const { reconcileMembers } = require("../utils/analytics/memberReconcile");
const { computeMrr } = require("../utils/analytics/stripeMrr");

const price = (cents) => ({ id: "price_x", unit_amount: cents, recurring: { interval: "month", interval_count: 1 }, product: "prod_x" });
const sub = (id, cents, extra = {}) => ({ id, status: "active", items: { data: [{ price: price(cents), quantity: 1 }] }, ...extra });
const comp = (id) => sub(id, 14900, { discounts: [{ coupon: { duration: "forever", percent_off: 100 } }] });

// Stripe: 36 paying + 2 comped = 38 billing subscriptions.
const stripeSubs = [...Array.from({ length: 36 }, (_, i) => sub(`sub_p${i}`, 14900)), comp("sub_c0"), comp("sub_c1")];
const mrr = computeMrr(stripeSubs, new Date("2026-10-10T12:00:00Z"));
assert.strictEqual(mrr.payingMembers, 36);
assert.strictEqual(mrr.compedMembers, 2);
assert.strictEqual(mrr.rows.length, 38);
assert.ok(mrr.rows.every((r) => Object.keys(r).sort().join() === "customer,id,listCents,netCents,status"), "rows carry ids and cents only");

// Mongo: 37 active homes = 34 linked paying + 2 linked comped + 1 admin grant (no Stripe).
// Two Stripe paying subscriptions have no active member behind them.
const members = [
  ...Array.from({ length: 34 }, (_, i) => ({ kind: "paid", stripeSubscriptionId: `sub_p${i}` })),
  { kind: "paid", stripeSubscriptionId: "sub_c0" },
  { kind: "paid", stripeSubscriptionId: "sub_c1" },
  { kind: "paid", stripeSubscriptionId: null },
];
const r = reconcileMembers(members, mrr);
assert.strictEqual(r.active, 37);
assert.strictEqual(r.paying, 34);
assert.strictEqual(r.comped, 2);
assert.strictEqual(r.manual, 1);
assert.strictEqual(r.gifts, 0);
assert.strictEqual(r.notBilling, 0);
assert.deepStrictEqual(r.stripeOnly, { count: 2, paying: 2, netCents: 2 * 14900 });
assert.strictEqual(r.balanced, true);
assert.strictEqual(r.paying + r.comped + r.gifts + r.manual + r.notBilling, r.active);

// Gifts and memberships Stripe no longer bills land in their own buckets.
const r2 = reconcileMembers([{ kind: "gift" }, { kind: "paid", stripeSubscriptionId: "sub_gone" }, { kind: "paid", stripeSubscriptionId: "sub_p0" }], mrr);
assert.deepStrictEqual([r2.gifts, r2.notBilling, r2.paying, r2.balanced], [1, 1, 1, true]);

// Without Stripe: no paying/comped claims, only what Mongo knows.
const r3 = reconcileMembers(members, { available: false });
assert.strictEqual(r3.paying, null);
assert.strictEqual(r3.manual, 1);

console.log("member reconcile: ok");

// A stale subscription id (plan change -> new Stripe subscription) still matches by Stripe customer.
const mrr2 = computeMrr([sub("sub_new", 14900, { customer: "cus_1" })], new Date("2026-10-10T12:00:00Z"));
const r4 = reconcileMembers([{ kind: "paid", stripeSubscriptionId: "sub_old", stripeCustomerId: "cus_1" }], mrr2);
assert.deepStrictEqual([r4.paying, r4.notBilling, r4.stripeOnly.count, r4.balanced], [1, 0, 0, true]);
console.log("member reconcile: stale ids ok");
