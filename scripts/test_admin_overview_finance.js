/*
 * Admin Overview money: MRR, revenue, tax, refunds, and the Stripe ledger.
 *
 *   node scripts/test_admin_overview_finance.js
 *
 * Found on production, Oct 7 2026: MRR was summed from list prices, so seven
 * members on a 25% coupon and two on 100% off counted at full price ($6,713
 * shown, $5,953 billed), and revenue included $503 of sales tax. Opening the
 * Overview also paged a year of Stripe charges (~30s). Every rule below is a
 * line of that fix. Fake Stripe, in-memory Mongo: nothing leaves this process.
 */
const assert = require("assert");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error?.message || error}`);
  }
}
const section = (t) => console.log(`\n${t}`);

const NOW = new Date("2026-10-07T16:00:00Z");
const nowSec = Math.floor(NOW.getTime() / 1000);
const DAY_S = 86400;

const price = (unit, interval = "month", extra = {}) => ({ id: `price_${unit}_${interval}`, unit_amount: unit, recurring: { interval, interval_count: 1 }, product: "prod_membership", ...extra });
const sub = (over = {}) => ({ id: `sub_${Math.random().toString(36).slice(2)}`, status: "active", metadata: { plan: "basic" }, discounts: [], items: { data: [{ quantity: 1, price: price(14900) }] }, ...over });
const coupon = (c) => ({ id: "co", duration: "forever", ...c });
const discount = (c, d = {}) => ({ coupon: coupon(c), start: nowSec - 30 * DAY_S, end: null, ...d });

async function main() {
  const { computeMrr } = require("../utils/analytics/stripeMrr");
  const revenue = require("../utils/analytics/stripeRevenue");
  const { summarizeRevenue } = require("../utils/analytics/overview")._internal;
  const mrrOf = (subs) => computeMrr(subs, NOW);

  /* ------------------------------ MRR ------------------------------ */
  section("MRR: net of the discounts that still apply");
  await test("no discount: list price", async () => {
    const m = mrrOf([sub()]);
    assert.strictEqual(m.netCents, 14900);
    assert.strictEqual(m.fullPriceCents, 14900);
    assert.strictEqual(m.discountCents, 0);
  });
  await test("25% for 2 months, still running: 75%", async () => {
    const m = mrrOf([sub({ discounts: [discount({ percent_off: 25, duration: "repeating", duration_in_months: 2 }, { end: nowSec + 20 * DAY_S })] })]);
    assert.strictEqual(m.netCents, 11175);
    assert.strictEqual(m.discountedMembers, 1);
  });
  await test("a repeating coupon that has ended no longer counts", async () => {
    const m = mrrOf([sub({ discounts: [discount({ percent_off: 25, duration: "repeating" }, { end: nowSec - DAY_S })] })]);
    assert.strictEqual(m.netCents, 14900);
  });
  await test("a `once` coupon was spent on the first invoice", async () => {
    assert.strictEqual(mrrOf([sub({ discounts: [discount({ percent_off: 50, duration: "once" })] })]).netCents, 14900);
  });
  await test("a discount that has not started yet does not count", async () => {
    assert.strictEqual(mrrOf([sub({ discounts: [discount({ percent_off: 50 }, { start: nowSec + DAY_S })] })]).netCents, 14900);
  });
  await test("100% forever: comped - a member, 0 MRR, not paying", async () => {
    const m = mrrOf([sub({ discounts: [discount({ percent_off: 100 })] }), sub()]);
    assert.strictEqual(m.netCents, 14900);
    assert.strictEqual(m.fullPriceCents, 29800);
    assert.strictEqual(m.members, 2);
    assert.strictEqual(m.payingMembers, 1);
    assert.strictEqual(m.compedMembers, 1);
  });
  await test("amount off a monthly invoice", async () => {
    assert.strictEqual(mrrOf([sub({ discounts: [discount({ amount_off: 5000 })] })]).netCents, 9900);
  });
  await test("amount off more than the price: zero, never negative", async () => {
    assert.strictEqual(mrrOf([sub({ discounts: [discount({ amount_off: 99999 })] })]).netCents, 0);
  });
  await test("annual price: one twelfth per month", async () => {
    const m = mrrOf([sub({ items: { data: [{ quantity: 1, price: price(349000, "year") }] } })]);
    assert.strictEqual(m.netCents, Math.round(349000 / 12));
    assert.strictEqual(m.annualMembers, 1);
  });
  await test("amount off an annual invoice is spread over its 12 months", async () => {
    const m = mrrOf([sub({ items: { data: [{ quantity: 1, price: price(149000, "year") }] }, discounts: [discount({ amount_off: 12000 })] })]);
    assert.strictEqual(m.netCents, Math.round((149000 - 12000) / 12));
  });
  await test("percent off an annual plan", async () => {
    const m = mrrOf([sub({ items: { data: [{ quantity: 1, price: price(149000, "year") }] }, discounts: [discount({ percent_off: 20 })] })]);
    assert.strictEqual(m.netCents, Math.round((149000 * 0.8) / 12));
  });
  await test("quantity multiplies", async () => {
    assert.strictEqual(mrrOf([sub({ items: { data: [{ quantity: 2, price: price(14900) }] } })]).netCents, 29800);
  });
  await test("a coupon limited to other products does not apply", async () => {
    assert.strictEqual(mrrOf([sub({ discounts: [discount({ percent_off: 50, applies_to: { products: ["prod_other"] } })] })]).netCents, 14900);
  });
  await test("the older single `discount` field is read too", async () => {
    assert.strictEqual(mrrOf([sub({ discounts: undefined, discount: discount({ percent_off: 10 }) })]).netCents, 13410);
  });
  await test("canceled, incomplete and unpaid are not recurring revenue", async () => {
    const m = mrrOf([sub({ status: "canceled" }), sub({ status: "incomplete" }), sub({ status: "unpaid" }), sub({ status: "incomplete_expired" })]);
    assert.strictEqual(m.netCents, 0);
    assert.strictEqual(m.members, 0);
  });
  await test("trialing is counted apart, not in MRR", async () => {
    const m = mrrOf([sub({ status: "trialing" })]);
    assert.strictEqual(m.netCents, 0);
    assert.strictEqual(m.trialingMembers, 1);
  });
  await test("past due still bills: in MRR, and flagged", async () => {
    const m = mrrOf([sub({ status: "past_due" })]);
    assert.strictEqual(m.netCents, 14900);
    assert.strictEqual(m.pastDueMembers, 1);
  });
  await test("scheduled to cancel: still in MRR until it ends, shown as ending", async () => {
    const m = mrrOf([sub({ cancel_at_period_end: true, discounts: [discount({ percent_off: 25, duration: "repeating" }, { end: nowSec + 5 * DAY_S })] }), sub()]);
    assert.strictEqual(m.netCents, 11175 + 14900);
    assert.strictEqual(m.endingMembers, 1);
    assert.strictEqual(m.endingCents, 11175);
  });
  await test("per plan: net and full price", async () => {
    const m = mrrOf([sub({ metadata: { plan: "elite" }, items: { data: [{ quantity: 1, price: price(49900) }] }, discounts: [discount({ percent_off: 100 })] }), sub()]);
    assert.deepStrictEqual(m.byPlan.elite, { netCents: 0, fullPriceCents: 49900, members: 1, paying: 0, comped: 1 });
    assert.strictEqual(m.byPlan.basic.netCents, 14900);
  });

  /* ------------------------------ tax ------------------------------ */
  section("Sales tax is found on every kind of charge");
  await test("invoice tax: `tax`, `total_taxes` or `total_tax_amounts`", async () => {
    assert.strictEqual(revenue.invoiceTaxCents({ tax: 1304 }), 1304);
    assert.strictEqual(revenue.invoiceTaxCents({ total_taxes: [{ amount: 1000 }, { amount: 304 }] }), 1304);
    assert.strictEqual(revenue.invoiceTaxCents({ total_tax_amounts: [{ amount: 978 }] }), 978);
    assert.strictEqual(revenue.invoiceTaxCents(null), 0);
  });
  await test("an invoice paid in two charges splits its tax by amount", async () => {
    assert.strictEqual(revenue.chargeTaxFromInvoice({ amount: 8102, invoice: { tax: 1304, amount_paid: 16204 } }), 652);
    assert.strictEqual(revenue.chargeTaxFromInvoice({ amount: 16204, invoice: { tax: 1304, amount_paid: 16204 } }), 1304);
  });

  /* ------------------------------ revenue ------------------------------ */
  section("Revenue: kept money, without tax; projects and tips never");
  const row = (o) => ({ id: Math.random().toString(36), service: ["membership", "one_time", "full_day", "gift"].includes(o.kind), refundedCents: 0, taxCents: 0, ...o, netCents: o.cents - (o.refundedCents || 0) });
  const s = summarizeRevenue([
    row({ kind: "membership", cents: 16204, taxCents: 1304 }), // $149 + tax
    row({ kind: "membership", cents: 12148, taxCents: 978 }), // $111.75 after a 25% coupon + tax
    row({ kind: "one_time", cents: 9900 }),
    row({ kind: "gift", cents: 26862, taxCents: 2162, refundedCents: 13431 }), // half refunded
    row({ kind: "project", cents: 300000 }),
    row({ kind: "tip", cents: 2000 }),
  ]);
  await test("membership revenue is after coupons and without tax", async () => assert.strictEqual(s.membershipCents, 14900 + 11170));
  await test("one-time revenue stays separate from membership", async () => assert.strictEqual(s.oneTimeCents, 9900));
  await test("a half refund keeps half the revenue and half the tax", async () => assert.strictEqual(s.giftCents, 13431 - 1081));
  await test("projects and tips are in no bucket and no total", async () => {
    assert.strictEqual(s.totalCents, 14900 + 11170 + 9900 + (13431 - 1081));
    assert.strictEqual(s.otherCents, 0);
  });
  await test("collected = revenue + the tax on it (what reached the bank)", async () => {
    assert.strictEqual(s.taxCents, 1304 + 978 + 1081);
    assert.strictEqual(s.collectedCents, s.totalCents + s.taxCents);
    assert.strictEqual(s.refundedCents, 13431);
  });

  /* ------------------------------ ledger ------------------------------ */
  section("The Stripe ledger: backfill once, then only what is new");
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  const RevenueCharge = require("../models/RevenueCharge");

  const iter = (rows) => ({ async *[Symbol.asyncIterator]() { for (const r of rows) yield r; } });
  const charge = (o) => ({ id: `ch_${Math.random().toString(36).slice(2)}`, status: "succeeded", paid: true, amount_refunded: 0, metadata: {}, customer: "cus_1", ...o });
  const CHARGES = [
    charge({ id: "ch_member", created: nowSec - 10 * DAY_S, amount: 16204, invoice: { subscription: "sub_1", tax: 1304, amount_paid: 16204, metadata: {} } }),
    charge({ id: "ch_gift", created: nowSec - 9 * DAY_S, amount: 26862, invoice: null, payment_intent: { id: "pi_gift", metadata: { productKind: "gift_membership", plan: "plus" } } }),
    charge({ id: "ch_project", created: nowSec - 8 * DAY_S, amount: 300000, payment_intent: { id: "pi_proj", metadata: { source: "profixter_invoice" } } }),
    charge({ id: "ch_failed", created: nowSec - 7 * DAY_S, amount: 16204, status: "failed", paid: false, invoice: { subscription: "sub_2", tax: 1304 } }),
  ];
  const calls = { charges: [], sessions: 0, refunds: 0 };
  let slow = 0;
  let REFUNDS = [];
  revenue.setStripeClient({
    charges: {
      list: (params) => {
        calls.charges.push(params);
        const gte = params.created?.gte ?? 0;
        const rows = CHARGES.filter((c) => c.created >= gte);
        return slow ? { async *[Symbol.asyncIterator]() { await new Promise((r) => setTimeout(r, slow)); for (const r of rows) yield r; } } : iter(rows);
      },
    },
    checkout: { sessions: { list: async ({ payment_intent }) => { calls.sessions += 1; return { data: payment_intent === "pi_gift" ? [{ total_details: { amount_tax: 2162 } }] : [] }; } } },
    refunds: { list: () => { calls.refunds += 1; return iter(REFUNDS); } },
  });

  await test("before the first sync the Overview says revenue is loading, not $0", async () => {
    const r = await revenue.collectedRevenue({ from: new Date(0), to: NOW });
    assert.strictEqual(r.available, false);
    assert.strictEqual(r.syncing, true);
    await revenue.syncRevenueLedger(); // the background run it started
  });
  await test("first sync reads the whole history, once", async () => {
    assert.strictEqual(calls.charges[0].created, undefined);
  });
  await test("only succeeded charges are kept; failed ones never count", async () => {
    const ids = (await RevenueCharge.find({}).lean()).map((d) => d.chargeId).sort();
    assert.deepStrictEqual(ids, ["ch_gift", "ch_member", "ch_project"]);
  });
  await test("membership tax from its invoice, gift tax from its Checkout session", async () => {
    const byId = Object.fromEntries((await RevenueCharge.find({}).lean()).map((d) => [d.chargeId, d]));
    assert.strictEqual(byId.ch_member.kind, "membership");
    assert.strictEqual(byId.ch_member.taxCents, 1304);
    assert.strictEqual(byId.ch_gift.kind, "gift");
    assert.strictEqual(byId.ch_gift.taxCents, 2162);
    assert.strictEqual(byId.ch_project.kind, "project");
    assert.strictEqual(byId.ch_project.taxCents, 0);
  });
  await test("a project never costs a Checkout lookup", async () => assert.strictEqual(calls.sessions, 1));

  await test("next sync reads only recent charges, and adds the new one without duplicates", async () => {
    CHARGES.push(charge({ id: "ch_onetime", created: nowSec + 60, amount: 9900, payment_intent: { id: "pi_ot", metadata: { productKind: "one_time_handyman_visit" } } }));
    await revenue.syncRevenueLedger({ now: new Date(NOW.getTime() + 120000) });
    const last = calls.charges[calls.charges.length - 1];
    // From two days before the newest charge already seen (the failed one, 7 days ago).
    assert.strictEqual(last.created.gte, nowSec - 7 * DAY_S - 2 * DAY_S);
    assert.strictEqual(await RevenueCharge.countDocuments({}), 4);
  });
  await test("a later refund lowers the charge it belongs to", async () => {
    REFUNDS = [{ id: "re_1", charge: { id: "ch_gift", amount_refunded: 13431 } }];
    await revenue.syncRevenueLedger({ now: new Date(NOW.getTime() + 240000) });
    assert.strictEqual((await RevenueCharge.findOne({ chargeId: "ch_gift" }).lean()).refundedCents, 13431);
  });
  await test("the Overview reads the ledger: rows carry tax and refunds", async () => {
    const r = await revenue.collectedRevenue({ from: new Date((nowSec - 30 * DAY_S) * 1000), to: new Date(NOW.getTime() + DAY_S * 1000) });
    assert.strictEqual(r.available, true);
    const gift = r.rows.find((x) => x.id === "ch_gift");
    assert.strictEqual(gift.netCents, 26862 - 13431);
    assert.strictEqual(gift.taxCents, 2162);
  });
  await test("a slow Stripe never slows the Overview: the refresh runs behind the answer", async () => {
    const AnalyticsState = require("../models/AnalyticsState");
    await AnalyticsState.updateOne({ key: "revenue-ledger" }, { $set: { "value.lastSyncAt": new Date(0) } });
    slow = 3000;
    const t0 = Date.now();
    const r = await revenue.collectedRevenue({ from: new Date(0), to: new Date(NOW.getTime() + DAY_S * 1000) });
    const took = Date.now() - t0;
    assert.strictEqual(r.available, true);
    assert.ok(took < 1000, `took ${took}ms`);
    await revenue.syncRevenueLedger(); // let the background run finish before shutdown
    slow = 0;
  });

  await mongoose.disconnect();
  await mongod.stop();

  console.log(`\n${passed}/${passed + failures.length} checks passed`);
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
