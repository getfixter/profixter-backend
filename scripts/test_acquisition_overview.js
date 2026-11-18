/*
 * Customer Acquisition: the 2026-11-17 audit fixes, checked against a small
 * world built from what production actually held.
 *
 *   node scripts/test_acquisition_overview.js
 *
 * - Guest free-visit requests (no account) were invisible to the Overview and
 *   their nested { firstTouch, url } attribution read as Direct.
 * - An account staff opened from a request inherits the request's source.
 * - Accounts older than the first recorded visitor are "Before tracking
 *   began"; staff-entered accounts are "Entered by staff"; neither is Direct.
 * - fbclid alone / an organic medium is "Facebook / Instagram, no ad tags".
 * - Audience Network is a Meta Ads placement row of its own name.
 * - Staff pages are not visitors; a period before tracking is null, not 0.
 * - Funnel steps say from when they are measured.
 * - Revenue splits first payments from renewals.
 * - Meta's reported figures, the Profixter Meta event log, agency fees.
 *
 * In-memory Mongo, real routes and auth. Stripe replaced by fixed rows.
 */
const assert = require("assert");
const express = require("express");
const fetch = require("node-fetch");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-not-real";
process.env.MAIL_ADMIN = "owner@example.com";
delete process.env.META_ADS_ACCESS_TOKEN;
delete process.env.META_ADS_SYNC_ENABLED;

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

let STRIPE_ROWS = [];
const revenuePath = require.resolve("../utils/analytics/stripeRevenue");
const realRevenue = require("../utils/analytics/stripeRevenue");
require.cache[revenuePath].exports = {
  ...realRevenue,
  collectedRevenue: async ({ from, to }) => ({ available: true, truncated: false, rows: STRIPE_ROWS.filter((r) => r.at >= from && r.at < to) }),
};

async function main() {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  const User = require("../models/User");
  const Subscription = require("../models/Subscription");
  const Booking = require("../models/Booking");
  const Request = require("../models/Request");
  const SiteVisitor = require("../models/SiteVisitor");
  const { FunnelStep } = require("../models/FunnelStep");
  const AdSpendDaily = require("../models/AdSpendDaily");
  const AnalyticsState = require("../models/AnalyticsState");
  const MetaEventLog = require("../models/MetaEventLog");
  const overview = require("../utils/analytics/overview");
  const stripeMrr = require("../utils/analytics/stripeMrr");
  const listOf = (rows) => ({ async *[Symbol.asyncIterator]() { for (const r of rows) yield r; } });
  stripeMrr.setStripeClient({ subscriptions: { list: () => listOf([]) } });

  const app = express();
  app.use(express.json());
  app.use("/api/admin/overview", require("../routes/adminOverview"));
  app.use("/api/track", require("../routes/track"));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  const now = Date.now();
  const ago = (days) => new Date(now - days * DAY);
  const oid = () => new mongoose.Types.ObjectId();
  const nyYmd = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);

  /* ------------------------------- the world ------------------------------- */
  const IG_TOUCH = { utmSource: "ig", utmMedium: "paid", utmCampaign: "52606450943827", utmTerm: "52606450943627", utmContent: "52606954471427", fbclid: "x", landingPath: "/" };
  const FB_TOUCH = { ...IG_TOUCH, utmSource: "fb" };
  const ids = { owner: oid(), office: oid(), A: oid(), B: oid(), OLD: oid(), STAFF: oid(), E: oid() };
  const u = (key, extra) => ({ _id: ids[key], userId: `PF-${key}`, name: `${key} Tester`, email: `${key.toLowerCase()}@example.com`, phone: "", role: "customer", isActive: true, ...extra });
  await User.collection.insertMany([
    u("owner", { email: "owner@example.com", role: "admin", createdAt: ago(400) }),
    u("office", { role: "employee", employeePosition: null, adminSections: ["overview"], createdAt: ago(300) }),
    // Facebook ad registrations: one free visit completed, one cancelled before confirmation.
    u("A", { createdAt: ago(20), attribution: FB_TOUCH }),
    u("B", { createdAt: ago(18), attribution: FB_TOUCH }),
    // A member from before tracking, renewing in the period.
    // adminCreated present as schema defaults (byName "") on every account: never read as staff-made.
    u("OLD", { createdAt: ago(200), stripeCustomerId: "cus_OLD", adminCreated: { at: null, by: null, byName: "" } }),
    // A phone sale entered by staff, no request behind it.
    u("STAFF", { createdAt: ago(5), signupMethod: "admin", adminCreated: { at: ago(5), by: ids.owner, byName: "Owner" }, stripeCustomerId: "cus_STAFF" }),
    // Staff opened this account from an Instagram ad request the same day.
    u("E", { createdAt: ago(6), email: "e@example.com", phone: "6315550101", signupMethod: "admin", adminCreated: { at: ago(6), by: ids.owner, byName: "Owner" }, stripeCustomerId: "cus_E" }),
  ]);
  await Subscription.collection.insertMany([
    { _id: oid(), user: ids.OLD, subscriptionType: "basic", billingCycle: "monthly", status: "active", startDate: ago(180), planPrice: 149, stripeSubscriptionId: "sub_OLD" },
    { _id: oid(), user: ids.STAFF, subscriptionType: "basic", billingCycle: "monthly", status: "active", startDate: ago(5), planPrice: 149, stripeSubscriptionId: "sub_STAFF" },
    { _id: oid(), user: ids.E, subscriptionType: "basic", billingCycle: "monthly", status: "active", startDate: ago(6), planPrice: 149, stripeSubscriptionId: "sub_E" },
  ]);
  const guestBooking = (status, history = []) => ({ _id: oid(), user: null, date: ago(1), status, createdAt: ago(9), isFreeFirstVisit: true, accessType: "free_first_visit", statusHistory: history.map((s) => ({ status: s, date: ago(8) })) });
  const R1b = guestBooking("Completed", ["Pending Confirmation", "Confirmed"]);
  const R2b = guestBooking("Canceled", ["Pending Confirmation"]);
  const R3b = guestBooking("Canceled", ["Pending Confirmation"]);
  await Booking.collection.insertMany([
    { _id: oid(), user: ids.A, date: ago(10), status: "Completed", completedAt: ago(10), createdAt: ago(19), isFreeFirstVisit: true, accessType: "free_first_visit", statusHistory: [{ status: "Pending" }, { status: "Confirmed" }] },
    { _id: oid(), user: ids.B, date: ago(12), status: "Canceled", createdAt: ago(18), isFreeFirstVisit: true, accessType: "free_first_visit", statusHistory: [{ status: "Pending" }] },
    R1b,
    R2b,
    R3b,
  ]);
  await Request.collection.insertMany([
    { _id: oid(), serviceType: "free_visit_request", status: "completed", email: "r1@example.com", phone: "6315550001", createdAt: ago(9), bookingId: R1b._id, attribution: { url: { utm_source: "ig", utm_medium: "paid", fbclid: "x" }, firstTouch: IG_TOUCH } },
    { _id: oid(), serviceType: "free_visit_request", status: "declined", email: "r2@example.com", phone: "6315550002", createdAt: ago(8), bookingId: R2b._id, attribution: { url: { utm_source: "ig", utm_medium: "paid", fbclid: "x" }, firstTouch: IG_TOUCH } },
    // E's request: declined as a free visit, then staff sold a membership the same day.
    { _id: oid(), serviceType: "free_visit_request", status: "declined", email: "e@example.com", phone: "6315550101", createdAt: new Date(ago(6).getTime() - 8 * 60 * 60 * 1000), bookingId: R3b._id, attribution: { url: { utm_source: "ig", utm_medium: "paid", fbclid: "x" }, firstTouch: IG_TOUCH } },
    // Google first touch; a later ad click on the submitting page must not replace it.
    { _id: oid(), serviceType: "free_visit_request", status: "pending_confirmation", email: "r4@example.com", phone: "6315550004", createdAt: ago(3), attribution: { url: { utm_source: "ig", utm_medium: "paid" }, firstTouch: { landingPath: "/", referrer: "https://www.google.com/" } } },
  ]);
  STRIPE_ROWS = [
    { id: "ch_old", at: ago(10), kind: "membership", service: true, cents: 14900, refundedCents: 0, netCents: 14900, taxCents: 0, stripeCustomerId: "cus_OLD" },
    { id: "ch_staff", at: ago(5), kind: "membership", service: true, cents: 12963, refundedCents: 0, netCents: 12963, taxCents: 1043, stripeCustomerId: "cus_STAFF" },
    { id: "ch_e", at: ago(6), kind: "membership", service: true, cents: 12963, refundedCents: 0, netCents: 12963, taxCents: 1043, stripeCustomerId: "cus_E" },
  ];
  // Tracking begins 40 days ago: the first SiteVisitor row.
  const V = (id, days, extra) => ({ visitorId: `v-acq-${id}-0000000`, firstSeenAt: ago(days), landingPath: "/", ...extra });
  await SiteVisitor.collection.insertMany([
    V("first", 40, {}),
    V("fb", 20, { utmSource: "fb", utmMedium: "paid", utmCampaign: "52606450943827", hasFbclid: true }),
    V("ig", 9, { utmSource: "ig", utmMedium: "paid", utmCampaign: "52606450943827", hasFbclid: true }),
    V("an1", 7, { utmSource: "an", utmMedium: "paid", utmCampaign: "52606450943827", hasFbclid: true }),
    V("an2", 7, { utmSource: "an", utmMedium: "paid", utmCampaign: "52606450943827", hasFbclid: false }),
    V("igbio", 7, { utmSource: "ig", utmMedium: "social", hasFbclid: true, source: "meta_instagram" }),
    V("fbclid", 6, { hasFbclid: true, source: "meta_other" }),
    V("admin", 6, { landingPath: "/admin/bookings" }),
    V("direct", 5, {}),
  ]);
  // The booker funnel was measured from 25 days ago; request_submitted not at all yet.
  const day = (d) => nyYmd(ago(d));
  await FunnelStep.collection.insertMany([
    { date: day(25), step: "booking_page_view", source: "direct", count: 1 },
    { date: day(7), step: "booking_page_view", source: "meta_other", count: 2 },
    { date: day(7), step: "booker_started", source: "meta_other", count: 1 },
    { date: day(9), step: "booking_page_view", source: "meta_instagram", count: 1 },
  ]);

  const token = (key) => jwt.sign({ id: String(ids[key]) }, process.env.JWT_SECRET);
  const call = (method, path, key, body) =>
    fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${token(key)}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const from = nyYmd(ago(30));
  const to = nyYmd(new Date(now));
  const q = `?range=custom&from=${from}&to=${to}`;
  const load = async () => {
    overview.clearOverviewCache();
    const r = await call("GET", `/api/admin/overview${q}`, "owner");
    assert.strictEqual(r.status, 200);
    return r.json();
  };
  let body = await load();
  const src = () => Object.fromEntries(body.sources.map((s) => [s.key, s]));

  section("Who brought each account");
  await test("an account staff opened from an Instagram ad request is credited to Instagram, with its first payment", async () => {
    const s = src();
    assert.strictEqual(s.meta_instagram.members, 1);
    assert.strictEqual(s.meta_instagram.newPayingCustomers, 1);
    assert.strictEqual(s.meta_instagram.firstPaymentRevenueCents, 11920);
  });
  await test("a staff phone sale with no request is 'Entered by staff', not Direct", async () => {
    const s = src();
    assert.strictEqual(s.staff_entered.members, 1);
    assert.strictEqual(s.staff_entered.revenueCents, 11920);
    assert.strictEqual(s.direct.members, 0);
  });
  await test("a renewal from a pre-tracking member is 'Before tracking began' and counted as repeat revenue", async () => {
    const s = src();
    assert.strictEqual(s.before_tracking.revenueCents, 14900);
    assert.strictEqual(s.before_tracking.firstPaymentRevenueCents, 0);
    assert.strictEqual(s.before_tracking.repeatRevenueCents, 14900);
    assert.strictEqual(s.direct.revenueCents, 0);
  });

  section("Free-visit requests (no account)");
  await test("guest requests are counted, by their own first touch", async () => {
    const s = src();
    assert.strictEqual(body.funnel.freeVisitRequests, 4);
    assert.strictEqual(s.meta_instagram.freeVisitRequests, 3);
    assert.strictEqual(s.google_organic.freeVisitRequests, 1, "a later ad click on the submitting page never replaces the first touch");
    assert.strictEqual(s.direct.freeVisitRequests, 0);
  });
  await test("outcomes come from the Request and its Booking", async () => {
    assert.deepStrictEqual(body.funnel.requestOutcomes, { completed: 1, declined: 2, pending: 1 });
  });
  await test("Meta inquiries = account first free visits + guest requests; confirmed and completed as of now", async () => {
    const meta = body.sourceGroups.find((g) => g.key === "meta");
    assert.strictEqual(meta.inquiries, 5); // A, B (accounts) + 3 Instagram requests
    assert.strictEqual(meta.confirmed, 2); // A, R1
    assert.strictEqual(meta.completedVisits, 2); // A, R1
    assert.strictEqual(meta.registrations, 3); // A, B and E (the account staff opened from her Instagram request)
    assert.strictEqual(meta.newPayingCustomers, 1); // E
  });
  await test("the campaign tree counts requests under the ad's campaign id", async () => {
    const camp = body.campaigns.find((c) => c.id === "52606450943827");
    assert.strictEqual(camp.freeVisitRequests, 3);
  });
  await test("the drill-down lists the requests", async () => {
    const r = await call("GET", `/api/admin/overview/list${q}&metric=freeVisitRequests`, "owner");
    const list = await r.json();
    assert.strictEqual(list.rows.length, 4);
    assert.ok(list.rows.every((row) => row.status && row.source));
  });

  section("Visitors");
  await test("Audience Network is a Meta Ads placement; fbclid alone and an Instagram bio link are not ads", async () => {
    const s = src();
    assert.strictEqual(s.meta_other.label, "Audience Network & other placements");
    assert.strictEqual(s.meta_other.visitors, 2);
    assert.strictEqual(s.meta_untagged.visitors, 2);
    assert.strictEqual(s.meta_untagged.group, null);
    assert.strictEqual(body.sourceGroups.find((g) => g.key === "meta").visitors, 4); // fb, ig, an x2
  });
  await test("staff pages are not visitors", async () => {
    assert.strictEqual(body.funnel.staffPagesExcluded, 1);
    assert.strictEqual(body.funnel.visitors, 7); // 9 rows - the 40-day-old one (outside) - /admin
  });
  await test("a previous period that began before tracking is flagged partial; one wholly before it is null, not zero", async () => {
    assert.strictEqual(body.funnel.prevVisitors, 1); // tracking began 40 days ago, inside the previous 30 days
    assert.strictEqual(body.funnel.prevVisitorsPartial, true);
    overview.clearOverviewCache();
    // Two days that end before the first recorded visitor (40 days ago), and the two before them.
    const r = await call("GET", `/api/admin/overview?range=custom&from=${nyYmd(ago(43))}&to=${nyYmd(ago(42))}`, "owner");
    const before = await r.json();
    assert.strictEqual(before.funnel.visitors, null, "a period wholly before tracking: visitors not measured");
    assert.strictEqual(before.funnel.prevVisitors, null);
  });
  await test("/api/track/visit refuses staff pages", async () => {
    await call("POST", "/api/track/visit", null, { visitorId: "v-acq-staffpage-01", landingPath: "/admin" });
    await call("POST", "/api/track/visit", null, { visitorId: "v-acq-homepage-01", landingPath: "/", utmSource: "ig", utmMedium: "social", fbclid: "x" });
    assert.strictEqual(await SiteVisitor.countDocuments({ visitorId: "v-acq-staffpage-01" }), 0);
    const home = await SiteVisitor.findOne({ visitorId: "v-acq-homepage-01" }).lean();
    assert.strictEqual(home.source, "meta_untagged");
  });

  section("Funnel steps");
  await test("each step says from when it is measured; an unmeasured step is null, not zero", async () => {
    const st = body.funnel.steps;
    assert.strictEqual(st.booking_page_view.all, 4);
    assert.strictEqual(st.booking_page_view.meta, 3);
    assert.strictEqual(st.booking_page_view.measuredFromYmd, day(25));
    assert.strictEqual(st.booking_page_view.partial, true);
    assert.strictEqual(st.booker_started.meta, 1);
    assert.strictEqual(st.request_submitted.all, null);
    assert.strictEqual(st.request_submitted.measured, false);
  });
  await test("/api/track/step files a step under today's source rules, not the source stored at insert", async () => {
    await call("POST", "/api/track/step", null, { visitorId: "v-acq-igbio-0000000", step: "request_failed" });
    const row = await FunnelStep.findOne({ step: "request_failed" }).lean();
    assert.strictEqual(row.source, "meta_untagged");
    assert.strictEqual(row.count, 1);
  });

  section("Membership path (organic Google -> plans -> plan chosen -> first paid membership)");
  await test("the three membership steps are counted once per browser per day, under the Google Organic first touch", async () => {
    const gid = "v-acq-google-member-01";
    await SiteVisitor.collection.insertOne(V("google-member", 2, { visitorId: gid, referrerHost: "www.google.com", landingPath: "/" }));
    for (const step of ["home_plans_click", "home_plans_click", "plans_view", "plans_view", "plans_view", "plan_selected", "plan_selected"]) {
      assert.strictEqual((await call("POST", "/api/track/step", null, { visitorId: gid, step })).status, 204);
    }
    // A step name the site does not send is ignored.
    await call("POST", "/api/track/step", null, { visitorId: gid, step: "membership_paid" });
    const rows = await FunnelStep.find({ step: { $in: ["home_plans_click", "plans_view", "plan_selected"] } }).lean();
    assert.deepStrictEqual(rows.map((r) => [r.step, r.source, r.count]).sort(), [["home_plans_click", "google_organic", 1], ["plan_selected", "google_organic", 1], ["plans_view", "google_organic", 1]]);
    assert.strictEqual(await FunnelStep.countDocuments({ step: "membership_paid" }), 0);
  });
  await test("the Overview splits each step by Google Organic and counts first paid memberships by source", async () => {
    const G = oid();
    await User.collection.insertOne({ _id: G, userId: "PF-G", name: "G Tester", email: "g@example.com", phone: "", role: "customer", isActive: true, createdAt: ago(1), attribution: { landingPath: "/", referrer: "https://www.google.com/" }, stripeCustomerId: "cus_G" });
    await Subscription.collection.insertOne({ _id: oid(), user: G, subscriptionType: "basic", billingCycle: "monthly", status: "active", startDate: ago(1), planPrice: 149, stripeSubscriptionId: "sub_G" });
    body = await load();
    const st = body.funnel.steps;
    assert.deepStrictEqual([st.home_plans_click.all, st.home_plans_click.googleOrganic, st.plans_view.googleOrganic, st.plan_selected.googleOrganic], [1, 1, 1, 1]);
    assert.strictEqual(st.booking_page_view.googleOrganic, 0, "Meta and direct steps are not Google's");
    assert.strictEqual(st.request_submitted.googleOrganic, null, "an unmeasured step stays null");
    const s = src();
    assert.strictEqual(s.google_organic.firstPaidMemberships, 1);
    assert.strictEqual(s.meta_instagram.firstPaidMemberships, 1, "E's first payment was a membership");
    assert.strictEqual(s.before_tracking.firstPaidMemberships, 0, "a renewal is not a first payment");
    assert.strictEqual(body.funnel.firstPaidMemberships, 3); // E, STAFF, G
  });
  await test("a customer who paid for a One-Time Visit before still counts when they first pay for a membership", async () => {
    const H = oid();
    await User.collection.insertOne({ _id: H, userId: "PF-H", name: "H Tester", email: "h@example.com", phone: "", role: "customer", isActive: true, createdAt: ago(60), attribution: { landingPath: "/", referrer: "https://www.google.com/" } });
    // A paid One-Time Visit two months ago (outside the period), then a first membership this week.
    await Booking.collection.insertOne({ _id: oid(), user: H, date: ago(55), status: "Completed", createdAt: ago(58), bookingType: "one_time_handyman_visit", paymentState: "paid" });
    await Subscription.collection.insertOne({ _id: oid(), user: H, subscriptionType: "plus", billingCycle: "monthly", status: "active", startDate: ago(2), planPrice: 249, stripeSubscriptionId: "sub_H" });
    // Its second home's membership is not a second first membership.
    await Subscription.collection.insertOne({ _id: oid(), user: H, subscriptionType: "basic", billingCycle: "monthly", status: "active", startDate: ago(1), planPrice: 149, stripeSubscriptionId: "sub_H2" });
    body = await load();
    const s = src();
    assert.strictEqual(s.google_organic.firstPaidMemberships, 2, "G and H");
    assert.strictEqual(s.google_organic.newPayingCustomers, 1, "H already paid before the period: not a new paying customer");
    assert.strictEqual(body.funnel.firstPaidMemberships, 4); // E, STAFF, G, H
  });

  section("Meta reporting and cost");
  await test("Meta not connected: spend, reported figures and every cost are null, never zero", async () => {
    assert.strictEqual(body.spend.connected, false);
    assert.strictEqual(body.spend.reported, null);
    assert.strictEqual(body.metaEfficiency.spendCents, null);
    assert.strictEqual(body.metaEfficiency.costPerInquiryCents, null);
    assert.strictEqual(body.metaEfficiency.costPerNewPayingCustomerCents, null);
    assert.strictEqual(body.metaEfficiency.firstPaymentRoas, null);
    assert.strictEqual(body.metaEfficiency.allInCostCents, null);
  });
  await test("Meta connected: Meta's own spend, outbound clicks, landing page views and website leads", async () => {
    await AnalyticsState.updateOne(
      { key: "meta-ad-spend" },
      { $set: { value: { connected: true, reason: "ok", accountId: "123456", lastSuccessAt: new Date(), coverageFromYmd: from, accountTimezone: "America/Los_Angeles", accountCurrency: "USD" } } },
      { upsert: true }
    );
    process.env.META_ADS_ACCOUNT_ID = "123456";
    const row = (date, adId, extra) => ({ platform: "meta", accountId: "123456", date, level: "ad", entityId: adId, campaignId: "52606450943827", adsetId: "52606450943627", adId, spendCents: 0, impressions: 0, clicks: 0, fetchedAt: new Date(), actions: {}, ...extra });
    await AdSpendDaily.collection.insertMany([
      row(day(9), "52606954471427", { spendCents: 40000, impressions: 9000, clicks: 300, outboundClicks: 250, attributionSetting: "7-day click or 1-day view", actions: { landing_page_view: 120, pixel_lead: 4, lead: 4 } }),
      row(day(5), "52606954471427", { spendCents: 36300, impressions: 8000, clicks: 280, outboundClicks: 200, attributionSetting: "7-day click or 1-day view", actions: { landing_page_view: 90, pixel_lead: 3, lead: 3 } }),
    ]);
    body = await load();
    assert.strictEqual(body.spend.connected, true);
    assert.deepStrictEqual(body.spend.reported, { impressions: 17000, clicks: 580, outboundClicks: 450, landingPageViews: 210, websiteLeads: 7, leads: 7, websitePurchases: 0, websiteSubscribes: 0, websiteSchedules: 0 });
    assert.deepStrictEqual(body.spend.attributionSettings, ["7-day click or 1-day view"]);
    assert.strictEqual(body.spend.accountTimezone, "America/Los_Angeles");
    const e = body.metaEfficiency;
    assert.strictEqual(e.spendCents, 76300);
    assert.strictEqual(e.costPerInquiryCents, Math.round(76300 / 5));
    assert.strictEqual(e.costPerConfirmedBookingCents, Math.round(76300 / 2));
    assert.strictEqual(e.costPerNewPayingCustomerCents, 76300);
    assert.strictEqual(e.firstPaymentRoas, Math.round((11920 / 76300) * 100) / 100);
  });
  await test("rows synced before outbound clicks existed: outbound clicks unknown (null), not zero", async () => {
    await AdSpendDaily.updateMany({}, { $set: { outboundClicks: null } });
    body = await load();
    assert.strictEqual(body.spend.reported.outboundClicks, null);
    assert.strictEqual(body.spend.reported.landingPageViews, 210);
  });

  section("Agency fees");
  const months = [...new Set([from.slice(0, 7), to.slice(0, 7)])];
  await test("only the owner may set a fee; a malformed month or amount is refused", async () => {
    assert.strictEqual((await call("PUT", `/api/admin/overview/agency-fees/${months[0]}`, "office", { cents: 50000 })).status, 403);
    assert.strictEqual((await call("PUT", "/api/admin/overview/agency-fees/2026-13", "owner", { cents: 50000 })).status, 400);
    assert.strictEqual((await call("PUT", `/api/admin/overview/agency-fees/${months[0]}`, "owner", { cents: -1 })).status, 400);
    assert.strictEqual((await call("GET", "/api/admin/overview/agency-fees", "office")).status, 200);
  });
  await test("all-in cost stays empty until EVERY month of the period has a fee", async () => {
    assert.strictEqual((await call("PUT", `/api/admin/overview/agency-fees/${months[0]}`, "owner", { cents: 50000, note: "retainer" })).status, 200);
    body = await load();
    if (months.length > 1) {
      assert.strictEqual(body.metaEfficiency.agencyFee.known, false);
      assert.deepStrictEqual(body.metaEfficiency.agencyFee.missingMonths, [months[1]]);
      assert.strictEqual(body.metaEfficiency.allInCostCents, null);
      assert.strictEqual((await call("PUT", `/api/admin/overview/agency-fees/${months[1]}`, "owner", { cents: 50000 })).status, 200);
      body = await load();
    }
    const fee = body.metaEfficiency.agencyFee;
    assert.strictEqual(fee.known, true);
    assert.strictEqual(fee.cents, fee.breakdown.reduce((s, b) => s + b.cents, 0));
    assert.strictEqual(body.metaEfficiency.allInCostCents, 76300 + fee.cents);
    assert.strictEqual(body.metaEfficiency.allInCostPerNewPayingCustomerCents, 76300 + fee.cents);
  });
  await test("a fee is prorated by the period's days in its month", async () => {
    const { agencyFeeForPeriod } = overview._internal;
    const oct = agencyFeeForPeriod({ "2026-10": { cents: 31000 } }, { fromYmd: "2026-10-01", toYmd: "2026-10-31" });
    assert.deepStrictEqual([oct.known, oct.cents], [true, 31000]);
    const half = agencyFeeForPeriod({ "2026-10": { cents: 31000 } }, { fromYmd: "2026-10-17", toYmd: "2026-10-31" });
    assert.strictEqual(half.cents, 15000);
    const span = agencyFeeForPeriod({ "2026-10": { cents: 31000 } }, { fromYmd: "2026-09-01", toYmd: "2026-11-17" });
    assert.deepStrictEqual([span.known, span.missingMonths], [false, ["2026-09", "2026-11"]]);
  });

  section("Meta event log (what Profixter sent)");
  await test("every Conversions API send is recorded without personal data", async () => {
    const metaCapi = require("../utils/metaCapi");
    process.env.META_CAPI_TOKEN = "test-token-not-real";
    const realFetch = global.fetch;
    global.fetch = async (url) => {
      if (String(url).includes("graph.facebook.com")) return { ok: true, status: 200, json: async () => ({ events_received: 1 }) };
      return realFetch(url);
    };
    try {
      const r1 = await metaCapi.send({ eventName: "Lead", eventId: "evt-1", customData: { lead_type: "account", content_name: "account_created" }, user: { email: "person@example.com", phone: "6315550000" } });
      const r2 = await metaCapi.send({ eventName: "Lead", eventId: "evt-2", customData: { lead_type: "free_visit_legacy" }, fbp: "fb.1.1.1", origin: "browser_relay" });
      const r3 = await metaCapi.send({ eventName: "Lead", eventId: "evt-3", customData: { lead_type: "account" } }); // no identifiers
      assert.deepStrictEqual([r1.sent, r2.sent, r3.sent], [true, true, false]);
    } finally {
      global.fetch = realFetch;
      delete process.env.META_CAPI_TOKEN;
    }
    await new Promise((r) => setTimeout(r, 200));
    const rows = await MetaEventLog.find({}).lean();
    assert.strictEqual(rows.length, 3);
    const flat = JSON.stringify(rows);
    for (const secret of ["person@example.com", "6315550000", "fb.1.1.1", "test-token"]) assert.ok(!flat.includes(secret), `log must not hold ${secret}`);
    assert.deepStrictEqual(rows.map((r) => [r.leadType, r.origin, r.outcome]).sort(), [["account", "server", "no_identifiers"], ["account", "server", "sent"], ["free_visit_legacy", "browser_relay", "sent"]].sort());
  });
  await test("the Overview counts sent events by kind, with where they came from", async () => {
    body = await load();
    const ev = body.metaEvents;
    assert.strictEqual(ev.measured, true);
    const acc = ev.events.find((e) => e.leadType === "account");
    assert.deepStrictEqual([acc.sent, acc.failed, acc.fromServer, acc.distinctEventIds], [1, 1, 1, 1]);
    const legacy = ev.events.find((e) => e.leadType === "free_visit_legacy");
    assert.deepStrictEqual([legacy.sent, legacy.fromBrowserRelay], [1, 1]);
  });
  await test("definitions travel with the numbers", async () => {
    for (const k of ["visitors", "inquiries", "websiteLeads", "landingPageViews", "outboundClicks", "newPayingCustomers", "firstPaymentRevenue", "source"]) assert.ok(body.definitions[k], k);
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
