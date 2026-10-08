/*
 * Admin Overview: every number checked against a small, known world.
 *
 *   node scripts/test_admin_overview.js
 *
 * In-memory Mongo, real routes, real auth middleware. Stripe is replaced by a
 * fixed list of charges so revenue is exact and nothing reaches Stripe.
 */
const assert = require("assert");
const express = require("express");
const fetch = require("node-fetch");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-not-real";
process.env.MAIL_ADMIN = "owner@example.com";

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
const DAY = 24 * 60 * 60 * 1000;

/* ---- Stripe replaced before anything loads the revenue module ---- */
let STRIPE_ROWS = [];
const revenuePath = require.resolve("../utils/analytics/stripeRevenue");
const realRevenue = require("../utils/analytics/stripeRevenue");
require.cache[revenuePath].exports = {
  ...realRevenue,
  collectedRevenue: async ({ from, to }) => ({
    available: true,
    truncated: false,
    rows: STRIPE_ROWS.filter((r) => r.at >= from && r.at < to),
  }),
};

async function main() {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  const User = require("../models/User");
  const Subscription = require("../models/Subscription");
  const GiftMembership = require("../models/GiftMembership");
  const Booking = require("../models/Booking");
  const SiteVisitor = require("../models/SiteVisitor");
  const overview = require("../utils/analytics/overview");
  /*
   * MRR comes from Stripe subscriptions. This fake holds the same two paying
   * memberships the Mongo world below has (Plus monthly, Premium annual).
   */
  const stripeMrr = require("../utils/analytics/stripeMrr");
  const fakeSub = (id, unit, interval, plan) => ({ id, status: "active", metadata: { plan }, items: { data: [{ quantity: 1, price: { id: `price_${id}`, unit_amount: unit, recurring: { interval, interval_count: 1 } } }] }, discounts: [] });
  const MRR_SUBS = [fakeSub("sub_A", 24900, "month", "plus"), fakeSub("sub_B", 349000, "year", "premium")];
  const listOf = (rows) => ({ async *[Symbol.asyncIterator]() { for (const r of rows) yield r; } });
  stripeMrr.setStripeClient({ subscriptions: { list: ({ status }) => listOf(MRR_SUBS.filter((s) => s.status === status)) } });
  const { classifyCharge } = realRevenue;
  const { sanitizeAttribution, classifySource } = require("../utils/analytics/attribution");

  const app = express();
  app.use(express.json());
  app.use("/api/admin/overview", require("../routes/adminOverview"));
  app.use("/api/track", require("../routes/track"));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  const now = Date.now();
  const ago = (days) => new Date(now - days * DAY);
  const oid = () => new mongoose.Types.ObjectId();

  /* ---------------------------- the world ---------------------------- */
  const ids = { owner: oid(), fixter: oid(), A: oid(), B: oid(), C: oid(), D: oid(), E: oid(), F: oid() };
  const addr = { A: oid(), B: oid(), C: oid(), D: oid(), E: oid(), F: oid() };
  const user = (key, extra) => ({
    _id: ids[key],
    userId: `PF-${key}`,
    name: `${key}lice Tester`,
    email: `${key.toLowerCase()}@example.com`,
    role: "customer",
    isActive: true,
    ...extra,
  });
  await User.collection.insertMany([
    user("owner", { email: "owner@example.com", name: "Owner Person", createdAt: ago(400) }),
    user("fixter", { role: "employee", employeePosition: "General Fixter", createdAt: ago(300) }),
    user("A", {
      createdAt: ago(15),
      stripeCustomerId: "cus_A",
      addresses: [{ _id: addr.A, line1: "1 Secret St", city: "Lindenhurst", state: "NY", zip: "11757", lat: 40.6868, lng: -73.3734 }],
      defaultAddressId: addr.A,
      attribution: { utmSource: "facebook", utmMedium: "paid_social", utmCampaign: "Free Handyman LI", utmTerm: "LI 30-55", utmContent: "Video 03", fbclid: "abc", campaignId: "111", adsetId: "222", adId: "333" },
    }),
    user("B", { createdAt: ago(45), addresses: [{ _id: addr.B, line1: "2 Secret St", city: "Babylon", state: "NY", zip: "11702" }], defaultAddressId: addr.B, attribution: { gclid: "g1" } }),
    user("C", { createdAt: ago(70), addresses: [{ _id: addr.C, line1: "3 Secret St", city: "Lindenhurst", state: "NY", zip: "11757" }], defaultAddressId: addr.C }),
    user("D", { createdAt: ago(4), addresses: [{ _id: addr.D, line1: "4 Secret St", city: "Deer Park", state: "NY", zip: "11729" }], defaultAddressId: addr.D, attribution: { refSource: "event" } }),
    user("E", { createdAt: ago(3), addresses: [{ _id: addr.E, line1: "5 Secret St", city: "Babylon", state: "NY", zip: "11702" }], defaultAddressId: addr.E, attribution: { utmSource: "facebook", fbclid: "e1", utmCampaign: "Membership Awareness" } }),
    user("F", { createdAt: ago(90), addresses: [{ _id: addr.F, line1: "6 Secret St", city: "Huntington", state: "NY", zip: "11743" }], defaultAddressId: addr.F }),
  ]);

  const sub = (key, extra) =>
    Subscription.create({
      user: ids[key],
      userId: `PF-${key}`,
      addressId: addr[key],
      addressSnapshot: { line1: "x", city: "x", state: "NY", zip: "11757" },
      billingCycle: "monthly",
      accessStatus: "active",
      status: "active",
      currentPeriodEnd: new Date(now + 20 * DAY),
      nextPaymentDate: new Date(now + 20 * DAY),
      latestPaymentDate: extra.startDate || ago(1),
      ...extra,
    });
  await sub("A", { subscriptionType: "plus", startDate: ago(10), planPrice: 249 });
  await sub("B", { subscriptionType: "premium", billingCycle: "annual", startDate: ago(40), planPrice: 3490, currentPeriodEnd: new Date(now + 300 * DAY) });
  await sub("C", { subscriptionType: "basic", startDate: ago(60), planPrice: 149, status: "canceled", accessStatus: "inactive", cancellationDate: ago(5), currentPeriodEnd: ago(5) });

  await GiftMembership.collection.insertOne({
    _id: oid(),
    giftNumber: "G-1",
    recipient: ids.D,
    addressId: addr.D,
    plan: "elite",
    durationMonths: 6,
    status: "claimed",
    claimedAt: ago(3),
    startAt: ago(3),
    endAt: new Date(now + 170 * DAY),
    addressSnapshot: { line1: "4 Secret St", city: "Deer Park", state: "NY", zip: "11729" },
  });

  let bn = 0;
  const booking = (key, extra) => ({
    _id: oid(),
    bookingNumber: `B${++bn}`,
    user: ids[key],
    userId: `PF-${key}`,
    name: "x",
    email: "x@example.com",
    phone: "x",
    address: "x",
    service: "Labor Only",
    subscription: "none",
    addressId: addr[key],
    ...extra,
  });
  await Booking.collection.insertMany([
    booking("A", { isFreeFirstVisit: true, accessType: "free_first_visit", createdAt: ago(14), date: ago(12), status: "Completed", completedAt: ago(12) }),
    booking("C", { isFreeFirstVisit: true, accessType: "free_first_visit", createdAt: ago(25), date: ago(20), status: "Completed", completedAt: ago(20) }),
    booking("E", { isFreeFirstVisit: true, accessType: "free_first_visit", createdAt: ago(2), date: new Date(now + 3 * DAY), status: "Confirmed" }),
    booking("F", { accessType: "one_time", bookingType: "one_time_handyman_visit", paymentState: "paid", createdAt: ago(5), date: ago(1), status: "Completed", completedAt: ago(1) }),
  ]);

  await SiteVisitor.collection.insertMany([
    { visitorId: "v-aaaaaaaaaaaa1", firstSeenAt: ago(16), source: "meta_ads" },
    { visitorId: "v-aaaaaaaaaaaa2", firstSeenAt: ago(4), source: "meta_ads" },
    { visitorId: "v-aaaaaaaaaaaa3", firstSeenAt: ago(2), source: "direct" },
    { visitorId: "v-aaaaaaaaaaaa4", firstSeenAt: ago(50), source: "direct" },
  ]);

  const row = (extra) => ({ id: `ch_${Math.random()}`, service: true, refundedCents: 0, plan: null, billingCycle: null, stripeCustomerId: null, userRef: null, ...extra, netCents: extra.cents - (extra.refundedCents || 0) });
  STRIPE_ROWS = [
    row({ at: ago(10), kind: "membership", plan: "plus", cents: 24900, stripeCustomerId: "cus_A" }),
    row({ at: ago(5), kind: "one_time", cents: 9900, userRef: String(ids.F) }),
    row({ at: ago(6), kind: "project", service: false, cents: 500000 }),
    row({ at: ago(6), kind: "tip", service: false, cents: 2000 }),
    row({ at: ago(40), kind: "membership", plan: "premium", cents: 349000, userRef: "PF-B" }),
  ];

  const token = (key) => jwt.sign({ id: String(ids[key]) }, process.env.JWT_SECRET);
  const get = (path, key) =>
    fetch(`${base}${path}`, { headers: key ? { Authorization: `Bearer ${token(key)}` } : {} });

  /* ------------------------------ access ------------------------------ */
  section("Only the admin can read the Overview");
  await test("no token -> 401", async () => assert.strictEqual((await get("/api/admin/overview")).status, 401));
  await test("customer -> 403", async () => assert.strictEqual((await get("/api/admin/overview", "A")).status, 403));
  await test("General Fixter -> 403 (not in their permissions)", async () => assert.strictEqual((await get("/api/admin/overview", "fixter")).status, 403));
  await test("customer cannot read the map", async () => assert.strictEqual((await get("/api/admin/overview/map", "A")).status, 403));
  await test("owner -> 200, not cacheable", async () => {
    const res = await get("/api/admin/overview?range=30d", "owner");
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get("cache-control") || "", /no-store/);
  });

  section("Ranges that share a window keep their own label");
  await test("on Oct 7, 'Last 7 days' and 'This month' are the same days but not the same answer", async () => {
    overview.clearOverviewCache();
    const now = new Date("2026-10-07T16:00:00Z");
    const week = await overview.buildOverview({ range: "7d", now });
    const month = await overview.buildOverview({ range: "month", now });
    assert.strictEqual(new Date(week.period.from).getTime(), new Date(month.period.from).getTime());
    assert.strictEqual(week.period.label, "Last 7 days");
    assert.strictEqual(month.period.key, "month");
    assert.strictEqual(month.period.label, "This month");
  });

  overview.clearOverviewCache();
  const body = await (await get("/api/admin/overview?range=30d", "owner")).json();
  const k = body.kpis;

  section("Customers and members");
  await test("staff are not customers", async () => assert.strictEqual(k.totalCustomers.value, 6));
  await test("new customers = accounts created in the period", async () => assert.strictEqual(k.newCustomers.value, 3));
  await test("active members: paid + gift, canceled excluded", async () => {
    assert.strictEqual(k.activeMembers.value, 3);
    assert.strictEqual(k.activeMembers.gifts, 1);
    assert.strictEqual(k.activeMembers.paying, 2);
  });
  await test("active members at period start reconstructed from dates", async () => assert.strictEqual(k.activeMembers.prev, 2));
  await test("new members in period: Plus + gift Elite", async () => assert.strictEqual(k.newMembers.value, 2));
  await test("cancellations: the Basic that ended", async () => assert.strictEqual(k.cancellations.value, 1));
  await test("MRR from Stripe: monthly + annual / 12, gifts excluded", async () => {
    assert.strictEqual(k.mrr.source, "stripe");
    assert.strictEqual(k.mrr.cents, 24900 + Math.round((3490 / 12) * 100));
    assert.strictEqual(k.mrr.fullPriceCents, k.mrr.cents);
  });
  await test("Stripe down: MRR says list price, not a net figure", async () => {
    stripeMrr.setStripeClient({ subscriptions: { list: () => { throw new Error("stripe down"); } } });
    overview.clearOverviewCache();
    const o = await overview.buildOverview({ range: "30d" });
    assert.strictEqual(o.kpis.mrr.source, "list_price");
    assert.strictEqual(o.kpis.mrr.cents, null);
    assert.strictEqual(o.kpis.mrr.fullPriceCents, 24900 + Math.round((3490 / 12) * 100));
    assert.ok(o.kpis.mrr.error);
    stripeMrr.setStripeClient({ subscriptions: { list: ({ status }) => listOf(MRR_SUBS.filter((s) => s.status === status)) } });
    overview.clearOverviewCache();
  });
  await test("plans: counts per plan", async () => {
    const by = Object.fromEntries(body.plans.map((p) => [p.plan, p]));
    assert.deepStrictEqual([by.basic.active, by.plus.active, by.premium.active, by.elite.active], [0, 1, 1, 1]);
    assert.strictEqual(by.basic.canceledInPeriod, 1);
    assert.strictEqual(by.plus.mrrCents, 24900);
  });

  section("Free Visits and One-Time");
  await test("booked / completed / upcoming", async () => {
    assert.strictEqual(k.freeVisits.booked, 3);
    assert.strictEqual(k.freeVisits.completed, 2);
    assert.strictEqual(k.freeVisits.upcoming, 1);
    assert.strictEqual(k.freeVisits.noShowTracked, false);
  });
  await test("conversion: 1 of 2 completed became a member afterwards", async () => {
    assert.strictEqual(k.conversion.converted, 1);
    assert.strictEqual(k.conversion.rate, 50);
  });
  await test("one-time visit counted with its revenue", async () => {
    assert.strictEqual(k.oneTime.booked, 1);
    assert.strictEqual(k.oneTime.completed, 1);
    assert.strictEqual(k.oneTime.revenueCents, 9900);
  });

  section("Revenue");
  await test("membership + one-time; projects and tips excluded", async () => {
    assert.strictEqual(k.revenue.membershipCents, 24900);
    assert.strictEqual(k.revenue.oneTimeCents, 9900);
    assert.strictEqual(k.revenue.totalCents, 34800);
    assert.strictEqual(k.revenue.prevTotalCents, 349000);
  });
  await test("revenue chart sums to the period total", async () => {
    const pts = body.revenueSeries.period.points;
    const sum = pts.reduce((s, p) => s + p.membershipCents + p.visitCents, 0);
    assert.strictEqual(sum, 34800);
  });

  section("Marketing");
  const src = Object.fromEntries(body.sources.map((s) => [s.key, s]));
  await test("sources add up to the totals", async () => {
    assert.strictEqual(body.sources.reduce((s, r) => s + r.registrations, 0), k.newCustomers.value);
    assert.strictEqual(body.sources.reduce((s, r) => s + r.members, 0), k.newMembers.value);
  });
  await test("Meta: 2 registrations, 1 member, its revenue; visitors counted", async () => {
    assert.strictEqual(src.meta_ads.registrations, 2);
    assert.strictEqual(src.meta_ads.members, 1);
    assert.strictEqual(src.meta_ads.revenueCents, 24900);
    assert.strictEqual(src.meta_ads.visitors, 2);
  });
  await test("event QR customer credited to Events / QR", async () => assert.strictEqual(src.events_qr.registrations, 1));
  await test("one-time revenue credited to the customer's own source (direct)", async () => assert.strictEqual(src.direct.revenueCents, 9900));
  await test("no spend data: cost and ROAS are empty, never zero", async () => {
    assert.strictEqual(body.spend.connected, false);
    assert.strictEqual(src.meta_ads.roas, null);
  });
  await test("campaign -> ad set -> ad", async () => {
    const camp = body.campaigns.find((c) => c.name === "Free Handyman LI");
    assert.ok(camp, "campaign present");
    assert.strictEqual(camp.members, 1);
    assert.strictEqual(camp.plans.plus, 1);
    assert.strictEqual(camp.adsets[0].name, "LI 30-55");
    assert.strictEqual(camp.adsets[0].ads[0].name, "Video 03");
  });
  await test("funnel: visitors in period", async () => assert.strictEqual(body.funnel.visitors, 3));

  section("Activity, areas, attention");
  await test("activity has the Plus purchase", async () => assert.ok(body.activity.some((a) => a.text === "Plus membership purchased")));
  await test("top areas by city", async () => {
    const by = Object.fromEntries(body.topAreas.map((a) => [a.city, a]));
    assert.strictEqual(by.Lindenhurst.customers, 2);
    assert.strictEqual(by.Babylon.customers, 2);
  });
  await test("no attribution alarm on a tiny sample", async () => assert.ok(!body.attention.some((a) => a.key === "attribution_gap")));

  section("Drill-down lists");
  await test("new members list, with source", async () => {
    const list = await (await get("/api/admin/overview/list?metric=newMembers&range=30d", "owner")).json();
    assert.strictEqual(list.rows.length, 2);
    assert.ok(list.rows.some((r) => r.source === "Meta Ads" && r.plan === "plus"));
  });
  await test("plan list", async () => {
    const list = await (await get("/api/admin/overview/list?metric=plan&param=premium&range=30d", "owner")).json();
    assert.strictEqual(list.rows.length, 1);
    assert.strictEqual(list.rows[0].email, "b@example.com");
  });
  await test("unknown metric returns nothing", async () => {
    const list = await (await get("/api/admin/overview/list?metric=everything&range=30d", "owner")).json();
    assert.strictEqual(list.rows.length, 0);
  });

  section("Map");
  const map = await (await get("/api/admin/overview/map", "owner")).json();
  await test("customers placed; staff never on the map", async () => {
    assert.strictEqual(map.total, 6);
    assert.ok(map.points.length >= 5, `placed ${map.points.length}`);
    assert.ok(!map.points.some((p) => p.id === String(ids.owner) || p.id === String(ids.fixter)));
  });
  await test("pins carry no street address, email or phone", async () => {
    const json = JSON.stringify(map);
    assert.ok(!/Secret St|@example\.com|phone/.test(json));
  });
  await test("exact coordinates used when stored, ZIP placement otherwise", async () => {
    assert.strictEqual(map.points.find((p) => p.id === String(ids.A)).precise, true);
    assert.strictEqual(map.points.find((p) => p.id === String(ids.D)).precise, false);
  });

  section("Visitor tracking");
  const post = (bodyObj, ua = "Mozilla/5.0") =>
    fetch(`${base}/api/track/visit`, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": ua }, body: JSON.stringify(bodyObj) });
  await test("first visit recorded once, never rewritten", async () => {
    await post({ visitorId: "vis_test_000001", landingPath: "/", utmSource: "facebook", fbclid: "x" });
    const first = await SiteVisitor.findOne({ visitorId: "vis_test_000001" }).lean();
    await post({ visitorId: "vis_test_000001", landingPath: "/other" });
    const again = await SiteVisitor.findOne({ visitorId: "vis_test_000001" }).lean();
    assert.strictEqual(first.source, "meta_ads");
    assert.strictEqual(again.landingPath, "/");
  });
  await test("bots and malformed ids ignored", async () => {
    await post({ visitorId: "vis_test_000002" }, "Googlebot/2.1");
    await post({ visitorId: "x" });
    assert.strictEqual(await SiteVisitor.countDocuments({ visitorId: { $in: ["vis_test_000002", "x"] } }), 0);
  });

  section("Attribution and Stripe classification (units)");
  await test("sanitizer keeps known keys only, clips, rejects future dates", async () => {
    const s = sanitizeAttribution({ utmSource: "x".repeat(500), evil: "drop", firstSeenAt: Date.now() + 10 * DAY });
    assert.strictEqual(s.utmSource.length, 300);
    assert.strictEqual(s.evil, undefined);
    assert.strictEqual(s.firstSeenAt, null);
    assert.strictEqual(sanitizeAttribution({}), null);
  });
  await test("unknown stays Direct / Unknown, never guessed", async () => assert.strictEqual(classifySource({}).label, "Direct / Unknown"));
  await test("charge on a subscription invoice is membership; refunds netted", async () => {
    const r = classifyCharge({ id: "c1", amount: 24900, amount_refunded: 4900, created: 1, invoice: { subscription: "sub_1", subscription_details: { metadata: { plan: "plus" } } } });
    assert.strictEqual(r.kind, "membership");
    assert.strictEqual(r.plan, "plus");
    assert.strictEqual(r.netCents, 20000);
  });
  await test("newer Stripe invoice shape (parent.subscription_details) still membership", async () => {
    const r = classifyCharge({ id: "c2", amount: 100, created: 1, invoice: { parent: { subscription_details: { subscription: "sub_2", metadata: { plan: "elite" } } } } });
    assert.strictEqual(r.kind, "membership");
    assert.strictEqual(r.plan, "elite");
  });
  await test("one-time, gift, tip and project invoices classified", async () => {
    assert.strictEqual(classifyCharge({ id: "c3", amount: 9900, created: 1, payment_intent: { metadata: { productKind: "one_time_handyman_visit" } } }).kind, "one_time");
    assert.strictEqual(classifyCharge({ id: "c4", amount: 1, created: 1, payment_intent: { metadata: { productKind: "gift_membership", plan: "plus" } } }).kind, "gift");
    assert.strictEqual(classifyCharge({ id: "c5", amount: 1, created: 1, payment_intent: { metadata: { productKind: "fixter_tip" } } }).service, false);
    assert.strictEqual(classifyCharge({ id: "c6", amount: 1, created: 1, invoice: { metadata: { source: "profixter_invoice" }, subscription: null } }).kind, "project");
  });

  server.close();
  await mongoose.disconnect();
  await mongod.stop();
  console.log(`\n${passed}/${passed + failures.length} checks passed`);
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
