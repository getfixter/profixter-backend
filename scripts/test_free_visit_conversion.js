/*
 * "Convert to paid visit" (utils/freeVisit/conversion.js), end to end against
 * a real database (in-memory replica set, reservation engine ON as in
 * production), through the real routes and the signed Stripe webhook.
 *
 *  - Admin makes a link (Membership plan + billing, or One-Time); nothing is
 *    sent until Send, each channel once; the free visit is untouched by
 *    making, opening, abandoning or expiring a checkout.
 *  - The customer's page shows only their visit and the offer, needs the
 *    terms ticked, reuses an open Stripe page, never opens two.
 *  - Paid: the SAME booking (id, time, reservation, Fixter, notes, photos)
 *    becomes the paid visit, once, whatever the webhook replays; Pending
 *    Confirmation -> Pending (still awaiting approval), Confirmed stays; one
 *    confirmation email; history kept; still counts as the free visit.
 *  - Membership: guest accounts linked or created by Admin explicitly (never
 *    to the account the email does not belong to), the first-visit exception,
 *    an explicit recorded seven-day override, the plan limit.
 *  - Changed during checkout: refused before paying; paid anyway ->
 *    needs_attention, the visit unchanged, the customer and owner told once,
 *    retry and close.
 *  - Concurrency: one live conversion per visit; parallel payments convert once.
 *  - The customer's own "Upgrade to a handyman visit", signed in: only their
 *    own visit (a guest's after signing in with its phone), terms first, the
 *    same in-place conversion, the 20% welcome offer exactly as on their own
 *    membership checkout, no seven-day override, Admin links replaced.
 *
 * Stripe, S3 and email are faked; SMS is rendered and recorded, never sent.
 *
 *   node scripts/test_free_visit_conversion.js
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-conversion";
process.env.STRIPE_SECRET_KEY = "sk_test_fake_for_unit_tests";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_conversion";
process.env.CLIENT_URL = "https://www.profixter.com";
process.env.SMS_ENABLED = "false";
process.env.S3_BUCKET = "test-bucket";
process.env.ENABLE_RESERVATION_ENGINE = "true";
process.env.MAIL_ADMIN = "owner@example.test";
process.env.STRIPE_PRICE_ONE_TIME_HANDYMAN_VISIT = "price_one_time_test";
process.env.ONE_TIME_VISIT_PRICE_CENTS = "9900";

const assert = require("assert");
const express = require("express");
const jwt = require("jsonwebtoken");
const moment = require("moment-timezone");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const TZ = "America/New_York";
const PRICE = "price_1RUdq2Bw0RtvSZjMnnI6uRgn"; // Basic monthly
let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name}\n      ${error.stack?.split("\n").slice(0, 4).join("\n      ") || error.message}`);
  }
}
/* The n-th open day (Sundays are closed), counted from tomorrow. */
function openDay(n) {
  const d = moment.tz(TZ).startOf("day").add(1, "day");
  let found = 0;
  for (;;) {
    if (d.day() !== 0) found += 1;
    if (found === n) return d.format("YYYY-MM-DD");
    d.add(1, "day");
  }
}
const daysFromToday = (ymd) => moment.tz(ymd, TZ).diff(moment.tz(TZ).startOf("day"), "days");
const at = (date, time) => moment.tz(`${date} ${time}`, "YYYY-MM-DD HH:mm", TZ).toDate();

async function main() {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(replSet.getUri());

  const s3 = require("../utils/s3");
  s3.putPublicObject = async ({ Key }) => `https://test-bucket.s3.amazonaws.com/${Key}`;
  s3.deletePublicObjects = async ({ Keys }) => ({ deleted: Keys.length });
  const mail = require("../utils/emailService");
  const sent = [];
  mail.sendRaw = async (m) => (sent.push({ kind: "raw", to: m.to, subject: m.subject, text: m.text || "", key: m.logContext?.templateKey || "" }), { ok: true });
  mail.sendTx = async (key, to, data) => (sent.push({ kind: "tx", key, to, data }), { ok: true });
  mail.sendPromo = async (to, m) => (sent.push({ kind: "promo", to, subject: m.subject, html: m.html, key: m.logContext?.templateKey || "" }), { ok: true });
  const keyed = (key) => sent.filter((m) => m.key === key);
  const passThrough = global.fetch;
  global.fetch = async (url, init) => (String(url).includes("graph.facebook.com") ? { ok: true, json: async () => ({}), text: async () => "" } : passThrough(url, init));

  /* ------------------------------ fake Stripe ------------------------------ */
  const stripe = require("../utils/subscriptionManagement").stripe;
  const fake = { sessions: new Map(), subs: new Map(), created: [] };
  const listResult = (items) => {
    const promise = Promise.resolve({ object: "list", data: items, has_more: false });
    promise[Symbol.asyncIterator] = async function* iterate() {
      for (const item of items) yield item;
    };
    return promise;
  };
  stripe.customers.list = async () => ({ data: [] });
  stripe.customers.retrieve = async (id) => ({ id, object: "customer", email: null });
  stripe.subscriptions.list = (params = {}) => listResult([...fake.subs.values()].filter((s) => !params.customer || s.customer === params.customer));
  stripe.subscriptions.retrieve = async (id) => {
    const sub = fake.subs.get(id);
    if (!sub) throw Object.assign(new Error(`No such subscription: ${id}`), { code: "resource_missing" });
    return JSON.parse(JSON.stringify(sub));
  };
  stripe.checkout.sessions.list = async ({ customer }) => ({ data: [...fake.sessions.values()].filter((s) => s.customer === customer && s.status === "open") });
  stripe.checkout.sessions.retrieve = async (id) => ({ ...fake.sessions.get(id) });
  stripe.checkout.sessions.expire = async (id) => {
    fake.sessions.get(id).status = "expired";
    return fake.sessions.get(id);
  };
  stripe.checkout.sessions.create = async (config) => {
    const id = `cs_test_${fake.created.length + 1}`;
    const session = { id, status: "open", mode: config.mode, customer: config.customer || null, metadata: config.metadata, url: `https://checkout.stripe.test/${id}`, config };
    fake.sessions.set(id, session);
    fake.created.push(session);
    return session;
  };
  /* Payment intents, with whatever refund Admin made "in Stripe" (fake.refunds). */
  fake.refunds = new Map();
  stripe.paymentIntents.retrieve = async (id) => ({ id, object: "payment_intent", amount: 9900, amount_received: 9900, latest_charge: { id: `ch_${id}`, amount: 9900, amount_refunded: fake.refunds.get(id) || 0 } });
  /* Never called by this code: a decline must not refund or cancel anything by itself. */
  fake.forbidden = [];
  stripe.refunds.create = async (...args) => (fake.forbidden.push(["refunds.create", args]), { id: "re_forbidden" });
  stripe.subscriptions.cancel = async (...args) => (fake.forbidden.push(["subscriptions.cancel", args]), {});
  const realSubUpdate = stripe.subscriptions.update?.bind(stripe.subscriptions);
  stripe.subscriptions.update = async (id, params) => {
    if (params && ("cancel_at_period_end" in params || "cancel_at" in params)) fake.forbidden.push(["subscriptions.update", [id, params]]);
    return realSubUpdate ? fake.subs.get(id) || {} : {};
  };
  /* The 20% welcome coupon, as utils/welcomeOffer.js ensureWelcomeCoupon expects it. */
  stripe.coupons.retrieve = async (id) => ({ id, object: "coupon", percent_off: 20, duration: "once", valid: true, amount_off: null });
  /* Meta: recorded, never sent. */
  const metaEvents = [];
  require("../utils/metaCapi").sendDetached = (event) => metaEvents.push(event);
  const T = (d) => Math.floor(new Date(d).getTime() / 1000);
  function makeStripeSub({ id, customer, user, addressId, metadata = {} }) {
    const now = new Date();
    const sub = {
      id,
      object: "subscription",
      customer,
      status: "active",
      created: T(now),
      start_date: T(now),
      current_period_start: T(now),
      current_period_end: T(new Date(now.getTime() + 30 * 86400000)),
      cancel_at_period_end: false,
      canceled_at: null,
      ended_at: null,
      latest_invoice: null,
      schedule: null,
      metadata: { addressId: String(addressId), userId: String(user.userId), plan: "basic", billingCycle: "monthly", ...metadata },
      items: { data: [{ id: `si_${id}`, price: { id: PRICE, unit_amount: 14900, recurring: { interval: "month" } }, current_period_start: T(now), current_period_end: T(new Date(now.getTime() + 30 * 86400000)) }] },
    };
    fake.subs.set(id, sub);
    return sub;
  }

  const Booking = require("../models/Booking");
  const AdminActivityLog = require("../models/AdminActivityLog");
  const AdminPaymentLink = require("../models/AdminPaymentLink");
  const BookingSlotReservation = require("../models/BookingSlotReservation");
  const BookingHistory = require("../models/BookingHistory");
  const ReservationTimeBucket = require("../models/ReservationTimeBucket");
  const ReservationCapacityBucket = require("../models/ReservationCapacityBucket");
  const CompanyAvailabilityTemplate = require("../models/CompanyAvailabilityTemplate");
  const FreeVisitConversion = require("../models/FreeVisitConversion");
  const Request = require("../models/Request");
  const SmsMessage = require("../models/SmsMessage");
  const StripeWebhookEvent = require("../models/StripeWebhookEvent");
  const Subscription = require("../models/Subscription");
  const User = require("../models/User");
  const VisitEntitlement = require("../models/VisitEntitlement");
  const { ensureVisitEntitlementIndexes } = require("../utils/visitEntitlementIndexSafety");
  for (const M of [Booking, BookingSlotReservation, ReservationTimeBucket, ReservationCapacityBucket, SmsMessage, StripeWebhookEvent, Subscription, User, FreeVisitConversion, AdminPaymentLink, Request]) await M.init();
  await ensureVisitEntitlementIndexes({ logger: { log() {}, warn() {} } });
  const { reserveGuestFreeVisit } = require("../utils/freeVisit/guestVisit");
  const { checkFreeVisitEligibility } = require("../utils/freeVisit/eligibility");
  const conversionLib = require("../utils/freeVisit/conversion");

  const fixter = await User.create({ name: "Fixter 1", email: "f1@fixter.local", password: "x", phone: "+15550002222", userId: "80000001", role: "employee", employeePosition: "Fixter", isActive: true });
  const owner = await User.create({ userId: "90000001", name: "Owner", email: "owner@example.test", role: "admin", password: "x" });
  const generalFixter = await User.create({ userId: "80000002", name: "Gina General", email: "gf@fixter.local", password: "x", phone: "+15550003333", role: "employee", employeePosition: "General Fixter", isActive: true });
  await CompanyAvailabilityTemplate.create({
    active: true, timezone: TZ, slotMinutes: 30, minLeadMinutes: 0, maxAdvanceDays: 120, defaultCapacity: 1, visitDurationMinutes: 90,
    weeklySchedule: Array.from({ length: 7 }, (_, weekday) => ({ weekday, enabled: weekday !== 0, starts: ["08:00", "10:00", "13:00"].map((time) => ({ time, capacity: null })), intervals: [{ startTime: "08:00", endTime: "16:00", capacity: null }] })),
  });

  const app = express();
  app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), require("../routes/webhook"));
  app.use(express.json());
  app.use("/api/bookings", require("../routes/bookings"));
  app.use("/api/pay", require("../routes/pay"));
  app.use("/api/admin/free-visits", require("../routes/adminFreeVisits"));
  app.use("/api/admin/free-visit-conversions", require("../routes/adminFreeVisitConversions"));
  app.use("/api/visit-upgrade", require("../routes/visitUpgrade"));
  app.use("/api/admin", require("../routes/adminJobs"));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const tokenFor = (u) => jwt.sign({ id: String(u._id), tv: 0 }, process.env.JWT_SECRET);
  const call = async (method, p, { body, as } = {}) => {
    const headers = as ? { authorization: `Bearer ${tokenFor(as)}` } : {};
    let payload;
    if (body) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${base}${p}`, { method, headers, body: payload });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  let eventSeq = 0;
  const deliverWithId = async (id, type, object) => {
    const payload = JSON.stringify({ id, object: "event", type, data: { object } });
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
    const res = await fetch(`${base}/api/stripe/webhook`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": header }, body: payload });
    return res.status;
  };
  const deliver = (type, object) => deliverWithId(`evt_conv_${++eventSeq}`, type, object);

  let seq = 0;
  const phoneFor = (n) => `+1631555${String(2000 + n)}`;
  /* A guest callback free visit, made by the same function the public form uses. */
  async function guestVisit({ date, time, name = "Jane Doe", email, phone, line1, zip = "11735", city = "Farmingdale" } = {}) {
    seq += 1;
    const slotStart = at(date, time);
    const request = new Request({
      name, email: email || `jane${seq}@mailbox.test`, phone: phone || phoneFor(seq), message: "Dripping faucet, a loose towel bar.",
      serviceType: "free_visit_request", sourcePage: "/book/free", status: "pending_confirmation",
      requestedDate: date, requestedTime: time, requestedAt: slotStart,
      contactConsent: { text: "By booking, you agree to be contacted.", at: new Date(), ip: "", userAgent: "", pageUrl: "" },
      dedupeKey: `test-${seq}-${Date.now()}`,
    });
    const { booking } = await reserveGuestFreeVisit({
      request,
      slotStart,
      bookingData: {
        name, phone: phone || phoneFor(seq), email: email || `jane${seq}@mailbox.test`, note: "Dripping faucet, a loose towel bar.",
        images: ["https://test-bucket.s3.amazonaws.com/free-visit-requests/job.jpg"], libraryReference: "",
        service: "Free Visit", freeVisitPurpose: "consultation",
        address: line1 || `${100 + seq} Oak Ave`, unit: "", city, state: "NY", zip, county: "Nassau",
      },
    });
    return Booking.findById(booking._id);
  }
  const customer = (over = {}) => {
    seq += 1;
    return User.create({
      userId: `4200${String(seq).padStart(4, "0")}`,
      name: `Dana Lopez ${seq}`,
      email: `dana${seq}@mailbox.test`,
      phone: phoneFor(seq),
      phoneVerifiedAt: new Date(),
      role: "customer",
      stripeCustomerId: `cus_conv_${seq}`,
      addresses: [{ label: "Primary", line1: `${10 + seq} Elm St`, city: "Farmingdale", state: "NY", zip: "11735", county: "Nassau" }],
      smsPreferences: { transactionalEnabled: true, transactionalConsentAt: new Date() },
      ...over,
    });
  };
  /* An online free visit booked by a signed-in customer, through the real route. */
  async function onlineVisit(user, date, time) {
    const res = await call("POST", "/api/bookings", {
      as: user,
      body: { service: "Labor Only", date: at(date, time).toISOString(), note: "Hang two shelves in the den", addressId: String(user.addresses[0]._id), libraryReference: "faucet", requestedDate: date, requestedTime: time },
    });
    assert.strictEqual(res.status, 200, `online free visit: ${JSON.stringify(res.body)}`);
    return Booking.findOne({ bookingNumber: res.body.booking.bookingNumber });
  }
  const makeLink = (booking, body, as = owner) => call("POST", `/api/admin/free-visit-conversions/bookings/${booking._id}`, { as, body });
  const payPage = (token) => call("GET", `/api/pay/${token}`);
  const press = (token, body = {}) => call("POST", `/api/pay/${token}/checkout`, { body });
  const pressAccept = async (token) => {
    const page = await payPage(token);
    return press(token, { acceptTerms: true, termsVersion: page.body.conversion?.terms?.version });
  };
  const lastSession = () => fake.created[fake.created.length - 1];
  const paidOneTime = (session, extra = {}) => ({
    id: session.id, object: "checkout.session", mode: "payment", status: "complete", payment_status: "paid",
    amount_total: 9900, currency: "usd", payment_intent: `pi_${session.id}`, customer: session.customer, metadata: session.metadata,
    client_reference_id: session.config.client_reference_id, ...extra,
  });
  const paidMembership = (session, user) => {
    const sub = fake.subs.get(`sub_${session.id}`) || makeStripeSub({ id: `sub_${session.id}`, customer: user.stripeCustomerId, user, addressId: session.metadata.addressId, metadata: session.config.subscription_data.metadata });
    return { id: session.id, object: "checkout.session", mode: "subscription", status: "complete", payment_status: "paid", amount_total: 14900, currency: "usd", customer: user.stripeCustomerId, subscription: sub.id, metadata: session.metadata, client_reference_id: session.config.client_reference_id };
  };
  const reservationsFor = (bookingId) => BookingSlotReservation.countDocuments({ bookingId, status: { $in: ["held", "reserved"] } });

  const soon = openDay(3); // inside the member seven days
  const later = openDay(14); // well outside
  assert.ok(daysFromToday(soon) < 7 && daysFromToday(later) >= 9);

  try {
    /* ================================================================== */
    console.log("\nOne-Time Visit for a guest: link, page, checkout, payment");
    let g1;
    let g1Token;
    let g1Conv;
    let g1Before;
    await check("the options say a guest free visit can be converted, and list both offers", async () => {
      g1 = await guestVisit({ date: soon, time: "08:00" });
      g1Before = g1.toObject();
      assert.strictEqual(g1.status, "Pending Confirmation");
      const res = await call("GET", `/api/admin/free-visit-conversions/bookings/${g1._id}`, { as: owner });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.convertible, true);
      assert.strictEqual(res.body.offers.oneTime.enabled, true);
      assert.strictEqual(res.body.offers.oneTime.priceCents, 9900);
      assert.ok(res.body.offers.membership.plans.some((p) => p.key === "basic" && p.monthly === 149));
      assert.strictEqual(res.body.account.mode, "guest");
      assert.strictEqual(res.body.leadTime.insideMemberLeadTime, true);
      assert.strictEqual(res.body.leadTime.exemptionEligible, true);
    });
    await check("a field Fixter cannot convert visits", async () => {
      const res = await makeLink(g1, { kind: "one_time" }, fixter);
      assert.strictEqual(res.status, 403, JSON.stringify(res.body));
      assert.strictEqual(await FreeVisitConversion.countDocuments({}), 0);
    });
    await check("making the link sends nothing and changes nothing on the visit", async () => {
      const before = sent.length;
      const smsBefore = await SmsMessage.countDocuments({});
      const res = await makeLink(g1, { kind: "one_time", task: "Fix the faucet and towel bar" });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.match(res.body.payUrl, /^https:\/\/www\.profixter\.com\/pay\/[A-Za-z0-9_-]{16,}$/);
      g1Token = res.body.token;
      g1Conv = res.body.conversion;
      assert.strictEqual(g1Conv.status, "open");
      assert.strictEqual(g1Conv.kind, "one_time");
      assert.strictEqual(sent.length, before, "no email");
      assert.strictEqual(await SmsMessage.countDocuments({}), smsBefore, "no text");
      const now = (await Booking.findById(g1._id)).toObject();
      for (const f of ["accessType", "status", "service", "freeVisitChannel", "isFreeFirstVisit", "date"]) assert.deepStrictEqual(now[f], g1Before[f], f);
      const link = await AdminPaymentLink.findOne({ conversion: g1Conv.id });
      assert.strictEqual(link.kind, "visit_conversion");
      assert.ok(link.expiresAt <= new Date(at(soon, "08:00").getTime() - 90 * 60 * 1000), "the link closes 90 minutes before the visit");
      assert.ok(!JSON.stringify(link.toObject()).includes(g1Token), "only the token's hash is stored");
    });
    await check("the payment page shows this visit and the offer, nothing else about the customer", async () => {
      const res = await payPage(g1Token);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.status, "open");
      const c = res.body.conversion;
      assert.strictEqual(c.kind, "one_time");
      assert.strictEqual(c.priceCents, 9900);
      assert.strictEqual(c.firstName, "Jane");
      assert.match(c.whenLabel, /at 8:00 AM$/);
      assert.match(c.terms.text, /Terms of Service/);
      assert.match(c.terms.text, /\$99/);
      assert.match(c.terms.text, /no membership and no recurring charge/);
      const raw = JSON.stringify(res.body);
      assert.ok(!raw.includes(g1.email) && !raw.includes(g1.phone), "no email or phone on the public page");
    });
    await check("Pay is refused until the terms are accepted; no Stripe page is opened", async () => {
      const before = fake.created.length;
      const res = await press(g1Token, {});
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, "TERMS_REQUIRED");
      const wrong = await press(g1Token, { acceptTerms: true, termsVersion: "old" });
      assert.strictEqual(wrong.status, 400);
      assert.strictEqual(fake.created.length, before);
    });
    let g1Session;
    await check("accepting opens a One-Time Stripe page that cannot reach the One-Time booking handlers", async () => {
      const res = await pressAccept(g1Token);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      g1Session = lastSession();
      assert.strictEqual(res.body.url, g1Session.url);
      assert.strictEqual(g1Session.config.mode, "payment");
      assert.deepStrictEqual(g1Session.config.line_items, [{ price: "price_one_time_test", quantity: 1 }]);
      assert.strictEqual(g1Session.metadata.productKind, "free_visit_conversion");
      assert.strictEqual(g1Session.metadata.freeVisitConversionId, g1Conv.id);
      assert.strictEqual(g1Session.metadata.bookingId, undefined, "no bookingId: the One-Time handlers never see it");
      assert.ok(g1Session.config.expires_at * 1000 <= at(soon, "08:00").getTime() - 90 * 60 * 1000 + 1000);
      assert.strictEqual(g1Session.config.customer_email, g1.email);
      const conv = await FreeVisitConversion.findById(g1Conv.id);
      assert.ok(conv.terms.acceptedAt);
      assert.strictEqual(conv.terms.version, conversionLib.TERMS_VERSION);
      assert.match(conv.terms.text, /\$99/);
      assert.strictEqual((await Booking.findById(g1._id)).accessType, "free_first_visit", "still free until paid");
    });
    await check("pressing Pay again reuses the open page (no second page)", async () => {
      const before = fake.created.length;
      const res = await pressAccept(g1Token);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.url, g1Session.url);
      assert.strictEqual(fake.created.length, before);
    });
    await check("two presses at once open one page", async () => {
      fake.sessions.get(g1Session.id).status = "expired";
      const before = fake.created.length;
      const version = (await payPage(g1Token)).body.conversion.terms.version;
      const results = await Promise.all([press(g1Token, { acceptTerms: true, termsVersion: version }), press(g1Token, { acceptTerms: true, termsVersion: version })]);
      const opened = fake.created.length - before;
      assert.strictEqual(opened, 1, `pages opened: ${opened}`);
      assert.ok(results.some((r) => r.status === 200));
      assert.ok(results.every((r) => r.status === 200 || r.body.code === "CHECKOUT_ALREADY_OPENING"), JSON.stringify(results.map((r) => r.body)));
      g1Session = lastSession();
    });
    await check("the page expiring unpaid leaves the free visit exactly as it was, and the link still works", async () => {
      assert.strictEqual(await deliver("checkout.session.expired", { ...fake.sessions.get(g1Session.id), status: "expired", object: "checkout.session" }), 200);
      const b = await Booking.findById(g1._id);
      assert.strictEqual(b.status, "Pending Confirmation");
      assert.strictEqual(b.accessType, "free_first_visit");
      assert.strictEqual(await reservationsFor(g1._id), 1);
      const conv = await FreeVisitConversion.findById(g1Conv.id);
      assert.strictEqual(conv.status, "open");
      assert.strictEqual(conv.checkout.sessionId, "");
      assert.strictEqual(keyed("visit_converted").length, 0);
      const res = await pressAccept(g1Token);
      assert.strictEqual(res.status, 200);
      g1Session = lastSession();
    });
    await check("a declined card (payment_intent.payment_failed) changes nothing", async () => {
      assert.strictEqual(await deliver("payment_intent.payment_failed", { id: `pi_${g1Session.id}`, object: "payment_intent", metadata: g1Session.metadata }), 200);
      const b = await Booking.findById(g1._id);
      assert.strictEqual(b.status, "Pending Confirmation");
      assert.strictEqual(b.accessType, "free_first_visit");
    });
    await check("paid: the same booking becomes a paid One-Time Visit, in place", async () => {
      assert.strictEqual(await deliverWithId("evt_paid_g1", "checkout.session.completed", paidOneTime(g1Session)), 200);
      const b = await Booking.findById(g1._id);
      assert.strictEqual(String(b._id), String(g1._id));
      assert.strictEqual(b.accessType, "one_time");
      assert.strictEqual(b.bookingType, "one_time_handyman_visit");
      assert.strictEqual(b.paymentState, "paid");
      assert.strictEqual(b.status, "Pending", "awaiting approval, as a paid visit");
      assert.strictEqual(b.selectedTask, "Fix the faucet and towel bar");
      assert.strictEqual(b.isFreeFirstVisit, false);
      assert.strictEqual(b.freeVisitChannel, "");
      for (const f of ["date", "slotReservationId", "assignedFixterId", "note", "images", "address", "zip", "guestRequestId", "bookingNumber"]) {
        assert.deepStrictEqual(b.toObject()[f], g1Before[f], `${f} kept`);
      }
      assert.strictEqual(await reservationsFor(g1._id), 1, "the same single reservation");
      assert.strictEqual(b.freeVisitConversion.from.status, "Pending Confirmation");
      assert.strictEqual(b.freeVisitConversion.from.accessType, "free_first_visit");
      assert.strictEqual(b.freeVisitConversion.from.freeVisitChannel, "callback");
      assert.strictEqual(b.freeVisitConversion.kind, "one_time");
      const conv = await FreeVisitConversion.findById(g1Conv.id);
      assert.strictEqual(conv.status, "converted");
      assert.strictEqual(conv.payment.amountCents, 9900);
      assert.strictEqual((await AdminPaymentLink.findOne({ conversion: conv._id })).status, "paid");
      assert.strictEqual((await Request.findById(b.guestRequestId)).status, "won");
      assert.ok(await BookingHistory.exists({ bookingId: b._id }), "the change is in the visit's history");
    });
    await check("one confirmation to the customer, one notice to the owner", async () => {
      const toCustomer = keyed("visit_converted");
      assert.strictEqual(toCustomer.length, 1);
      assert.strictEqual(toCustomer[0].to, g1.email);
      assert.match(toCustomer[0].text, /now a paid One-Time Visit/);
      assert.match(toCustomer[0].text, /same day, time and address/);
      assert.strictEqual(keyed("admin_visit_converted").length, 1);
      assert.ok(await AdminActivityLog.exists({ action: "Free Visit Converted to Paid", entityId: String(g1._id) }));
    });
    await check("replayed and duplicate webhooks change nothing and send nothing", async () => {
      const before = sent.length;
      assert.strictEqual(await deliverWithId("evt_paid_g1", "checkout.session.completed", paidOneTime(g1Session)), 200);
      assert.strictEqual(await deliver("checkout.session.completed", paidOneTime(g1Session)), 200);
      await conversionLib.runConversion(g1Conv.id);
      assert.strictEqual(sent.length, before);
      assert.strictEqual(await Booking.countDocuments({ guestRequestId: g1.guestRequestId }), 1);
    });
    await check("the page now says it is done; the Jobs sheet shows a One-Time Visit converted from a free visit", async () => {
      assert.strictEqual((await payPage(g1Token)).body.status, "converted");
      const job = await call("GET", `/api/admin/jobs/${g1._id}`, { as: owner });
      assert.strictEqual(job.status, 200, JSON.stringify(job.body));
      assert.strictEqual(job.body.job.type, "one_time");
      assert.strictEqual(job.body.job.freeVisit, null);
      assert.strictEqual(job.body.job.conversion.converted.kind, "one_time");
      assert.strictEqual(job.body.job.conversion.converted.fromStatus, "Pending Confirmation");
      assert.ok(!job.body.job.allowedActions.includes("convertToPaid"));
      assert.ok(!job.body.job.allowedActions.includes("reviewFreeVisit"));
      assert.ok(job.body.job.allowedActions.includes("confirm"), "the owner approves it as usual");
      const review = await call("GET", `/api/admin/free-visits/${g1._id}`, { as: owner });
      assert.strictEqual(review.status, 404, "no longer a free visit to review");
    });
    await check("it still counts as this person's free visit", async () => {
      const result = await checkFreeVisitEligibility({ phone: g1.phone, email: g1.email });
      assert.strictEqual(result.decision, "blocked");
    });
    await check("a converted visit cannot be converted again", async () => {
      const res = await makeLink(g1, { kind: "one_time" });
      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.code, "ALREADY_CONVERTED");
    });

    /* ================================================================== */
    console.log("\nSending the link: explicit, each channel once");
    await check("Send emails and texts the link only when asked, once per channel, and only with the right link", async () => {
      const g = await guestVisit({ date: later, time: "08:00" });
      const made = await makeLink(g, { kind: "one_time" });
      assert.strictEqual(made.status, 200, JSON.stringify(made.body));
      const id = made.body.conversion.id;
      const wrong = await call("POST", `/api/admin/free-visit-conversions/bookings/${g._id}/${id}/send`, { as: owner, body: { token: "A".repeat(22), channels: ["email"] } });
      assert.strictEqual(wrong.status, 400);
      assert.strictEqual(keyed("payment_link").length, 0);
      const first = await call("POST", `/api/admin/free-visit-conversions/bookings/${g._id}/${id}/send`, { as: owner, body: { token: made.body.token, channels: ["email"] } });
      assert.strictEqual(first.status, 200, JSON.stringify(first.body));
      assert.strictEqual(first.body.delivery.email, "sent");
      const linkEmails = keyed("payment_link");
      assert.strictEqual(linkEmails.length, 1);
      assert.strictEqual(linkEmails[0].to, g.email);
      assert.ok(linkEmails[0].text.includes(made.body.payUrl));
      const again = await call("POST", `/api/admin/free-visit-conversions/bookings/${g._id}/${id}/send`, { as: owner, body: { token: made.body.token, channels: ["email"] } });
      assert.strictEqual(again.status, 409);
      assert.strictEqual(again.body.code, "ALREADY_SENT");
      assert.strictEqual(keyed("payment_link").length, 1);
      /* A homepage guest agreed to texts about the visit only: refused up front, and the text channel is not used up. */
      const sms = await call("POST", `/api/admin/free-visit-conversions/bookings/${g._id}/${id}/send`, { as: owner, body: { token: made.body.token, channels: ["sms"] } });
      assert.strictEqual(sms.status, 409, JSON.stringify(sms.body));
      assert.strictEqual(sms.body.code, "SMS_NOT_AVAILABLE");
      const opts = await call("GET", `/api/admin/free-visit-conversions/bookings/${g._id}`, { as: owner });
      assert.strictEqual(opts.body.smsAvailable, false);
      const conv = await FreeVisitConversion.findById(id);
      assert.deepStrictEqual(conv.sends.map((s) => s.channel), ["email"]);
      assert.ok(conv.sends.every((s) => s.byName === "Owner" && s.result && s.result !== "sending"));
      assert.strictEqual(keyed("payment_link").length, 1, "email not sent twice");
    });
    await check("a visit on an account can have its link texted, once", async () => {
      const u = await customer();
      const g = await onlineVisit(u, openDay(29), "08:00");
      const made = await makeLink(g, { kind: "one_time" });
      assert.strictEqual(made.status, 200, JSON.stringify(made.body));
      const res = await call("POST", `/api/admin/free-visit-conversions/bookings/${g._id}/${made.body.conversion.id}/send`, { as: owner, body: { token: made.body.token, channels: ["sms"] } });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.ok(res.body.delivery.sms && res.body.delivery.sms !== "not_requested");
      const again = await call("POST", `/api/admin/free-visit-conversions/bookings/${g._id}/${made.body.conversion.id}/send`, { as: owner, body: { token: made.body.token, channels: ["sms"] } });
      assert.strictEqual(again.body.code, "ALREADY_SENT");
    });
    await check("withdrawing a link closes its Stripe page; the page then says so", async () => {
      const g = await guestVisit({ date: later, time: "10:00" });
      const made = await makeLink(g, { kind: "one_time" });
      await pressAccept(made.body.token);
      const page = lastSession();
      const res = await call("POST", `/api/admin/free-visit-conversions/bookings/${g._id}/${made.body.conversion.id}/cancel`, { as: owner, body: { reason: "Customer changed their mind" } });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(fake.sessions.get(page.id).status, "expired");
      assert.strictEqual((await payPage(made.body.token)).body.status, "canceled");
      assert.strictEqual((await press(made.body.token, { acceptTerms: true, termsVersion: conversionLib.TERMS_VERSION })).status, 410);
      assert.strictEqual((await Booking.findById(g._id)).accessType, "free_first_visit");
    });
    await check("a new link replaces an open one: one live conversion per visit", async () => {
      const g = await guestVisit({ date: later, time: "13:00" });
      const a = await makeLink(g, { kind: "one_time" });
      const b = await makeLink(g, { kind: "one_time" });
      assert.strictEqual(b.status, 200);
      assert.strictEqual((await FreeVisitConversion.findById(a.body.conversion.id)).status, "canceled");
      assert.strictEqual((await payPage(a.body.token)).body.status, "canceled");
      assert.strictEqual(await FreeVisitConversion.countDocuments({ booking: g._id, status: { $in: FreeVisitConversion.LIVE_STATUSES } }), 1);
      const both = await Promise.all([makeLink(g, { kind: "one_time" }), makeLink(g, { kind: "one_time" })]);
      assert.ok(both.some((r) => r.status === 200));
      assert.strictEqual(await FreeVisitConversion.countDocuments({ booking: g._id, status: { $in: FreeVisitConversion.LIVE_STATUSES } }), 1, "never two live links");
    });

    /* ================================================================== */
    console.log("\nMembership for a signed-in customer's confirmed free visit (first-visit exception)");
    let ana;
    let anaVisit;
    let anaConv;
    let anaToken;
    await check("an online free visit the owner confirmed, converted to Basic monthly inside the seven days", async () => {
      ana = await customer();
      anaVisit = await onlineVisit(ana, soon, "10:00");
      assert.strictEqual(anaVisit.status, "Pending Confirmation");
      const ok = await call("POST", `/api/admin/free-visits/${anaVisit._id}/confirm`, { as: owner, body: {} });
      assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
      assert.strictEqual((await Booking.findById(anaVisit._id)).status, "Confirmed");
      const res = await makeLink(anaVisit, { kind: "membership", plan: "basic", billingCycle: "monthly" });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      anaConv = res.body.conversion;
      anaToken = res.body.token;
      assert.strictEqual(anaConv.leadTime.rule, "first_visit_exemption");
      assert.strictEqual(anaConv.accountSource, "booking");
      const page = await payPage(anaToken);
      assert.match(page.body.conversion.terms.text, /\$149 per month plus any applicable tax and renews automatically every month until I cancel/);
    });
    let anaSession;
    await check("its checkout is a normal membership checkout carrying the conversion and the exception", async () => {
      const res = await pressAccept(anaToken);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      anaSession = lastSession();
      assert.strictEqual(anaSession.config.mode, "subscription");
      for (const md of [anaSession.metadata, anaSession.config.subscription_data.metadata]) {
        assert.strictEqual(md.freeVisitConversionId, anaConv.id);
        assert.strictEqual(md.firstVisitExempt, "1");
        assert.strictEqual(md.adminInitiated, "link", "a staff sale: not reported to Meta");
      }
      assert.strictEqual(anaSession.config.success_url, `https://www.profixter.com/pay/${anaToken}?paid=1`);
      assert.strictEqual((await Booking.findById(anaVisit._id)).accessType, "free_first_visit");
    });
    await check("paid: the confirmed visit becomes a Basic membership visit, still Confirmed, exception spent on it", async () => {
      const before = (await Booking.findById(anaVisit._id)).toObject();
      assert.strictEqual(await deliverWithId("evt_paid_ana", "checkout.session.completed", paidMembership(anaSession, ana)), 200);
      const b = await Booking.findById(anaVisit._id);
      assert.strictEqual(b.accessType, "membership");
      assert.strictEqual(b.bookingType, "membership_visit");
      assert.strictEqual(b.status, "Confirmed");
      assert.strictEqual(String(b.addressId), String(ana.addresses[0]._id));
      for (const f of ["date", "slotReservationId", "assignedFixterId", "note"]) assert.deepStrictEqual(b.toObject()[f], before[f], f);
      const sub = await Subscription.findOne({ user: ana._id, addressId: ana.addresses[0]._id });
      assert.ok(sub && ["active", "trialing"].includes(sub.status));
      assert.strictEqual(String(b.subscription).toLowerCase(), "basic");
      assert.ok(sub.firstVisitExemption.usedAt);
      assert.strictEqual(String(sub.firstVisitExemption.bookingId), String(b._id));
      assert.strictEqual(b.freeVisitConversion.leadTimeRule, "first_visit_exemption");
      assert.strictEqual(b.freeVisitConversion.from.status, "Confirmed");
      assert.strictEqual((await FreeVisitConversion.findById(anaConv.id)).status, "converted");
      const confirmations = keyed("visit_converted").filter((m) => m.to === ana.email);
      assert.strictEqual(confirmations.length, 1);
      assert.match(confirmations[0].text, /now a Basic membership visit/);
      assert.match(confirmations[0].text, /confirmed/);
      assert.strictEqual(await deliverWithId("evt_paid_ana", "checkout.session.completed", paidMembership(anaSession, ana)), 200);
      assert.strictEqual(keyed("visit_converted").filter((m) => m.to === ana.email).length, 1, "a replay sends nothing");
    });

    /* ================================================================== */
    console.log("\nMembership for a guest: the account is settled explicitly");
    await check("a guest visit needs an account for a membership; none is chosen silently", async () => {
      const g = await guestVisit({ date: openDay(15), time: "08:00", line1: "7 Birch Ln" });
      const res = await makeLink(g, { kind: "membership", plan: "basic", billingCycle: "monthly" });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, "ACCOUNT_REQUIRED");
    });
    await check("a General Fixter may convert, but may not create accounts", async () => {
      const g = await guestVisit({ date: openDay(16), time: "08:00" });
      const res = await makeLink(g, { kind: "membership", plan: "basic", billingCycle: "monthly", account: { mode: "create" } }, generalFixter);
      assert.strictEqual(res.status, 403, JSON.stringify(res.body));
      assert.strictEqual(res.body.code, "FORBIDDEN_ACCOUNT_CREATE");
      assert.strictEqual(await User.countDocuments({ email: g.email }), 0);
      const ok = await makeLink(g, { kind: "one_time" }, generalFixter);
      assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    });
    await check("the visit is never put on the account its email does not belong to", async () => {
      const byEmail = await customer({ email: "kim.shared@mailbox.test" });
      const byPhone = await customer({ phone: "+16315559876" });
      const g = await guestVisit({ date: openDay(17), time: "08:00", email: "kim.shared@mailbox.test", phone: "+16315559876" });
      const opts = await call("GET", `/api/admin/free-visit-conversions/bookings/${g._id}`, { as: owner });
      const ids = opts.body.account.candidates.map((c) => c.id).sort();
      assert.deepStrictEqual(ids, [String(byEmail._id), String(byPhone._id)].sort());
      assert.ok(opts.body.account.candidates.every((c) => !c.email.includes("kim.shared")), "emails are masked");
      const wrong = await makeLink(g, { kind: "membership", plan: "basic", billingCycle: "monthly", account: { mode: "link", userId: String(byPhone._id) } });
      assert.strictEqual(wrong.status, 409);
      assert.strictEqual(wrong.body.code, "EMAIL_BELONGS_TO_ANOTHER_ACCOUNT");
      const stranger = await customer();
      const notAMatch = await makeLink(g, { kind: "membership", plan: "basic", billingCycle: "monthly", account: { mode: "link", userId: String(stranger._id) } });
      assert.strictEqual(notAMatch.status, 400);
      assert.strictEqual(notAMatch.body.code, "ACCOUNT_NOT_A_MATCH");
      assert.strictEqual(await FreeVisitConversion.countDocuments({ booking: g._id }), 0);
    });
    await check("linked to the matching account: the home is added, and payment puts the visit on that account", async () => {
      const lee = await customer({ email: "lee.match@mailbox.test" });
      const g = await guestVisit({ date: openDay(18), time: "08:00", email: "lee.match@mailbox.test", line1: "55 Cedar Rd" });
      const res = await makeLink(g, { kind: "membership", plan: "plus", billingCycle: "annual", account: { mode: "link", userId: String(lee._id) } });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      const fresh = await User.findById(lee._id);
      const home = fresh.addresses.find((a) => a.line1 === "55 Cedar Rd");
      assert.ok(home, "the visit's address is now one of the account's homes");
      assert.strictEqual((await Booking.findById(g._id)).user, null, "the visit itself is unchanged until paid");
      assert.ok(res.body.conversion.history.some((h) => h.event === "account_linked"));
      assert.match((await payPage(res.body.token)).body.conversion.terms.text, /\$2490 per year/);
      await pressAccept(res.body.token);
      const page = lastSession();
      assert.strictEqual(page.metadata.addressId, String(home._id));
      assert.strictEqual(await deliver("checkout.session.completed", paidMembership(page, fresh)), 200);
      const b = await Booking.findById(g._id);
      assert.strictEqual(String(b.user), String(lee._id));
      assert.strictEqual(String(b.addressId), String(home._id));
      assert.strictEqual(b.accessType, "membership");
      assert.strictEqual(b.status, "Pending");
    });
    await check("created from the visit's details (owner): one new account, marketing left off", async () => {
      const g = await guestVisit({ date: openDay(19), time: "08:00", name: "Pat Rivera", email: "pat.rivera@mailbox.test", line1: "9 Spruce Ct" });
      const res = await makeLink(g, { kind: "membership", plan: "basic", billingCycle: "monthly", account: { mode: "create" } });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      const users = await User.find({ email: "pat.rivera@mailbox.test" });
      assert.strictEqual(users.length, 1);
      assert.strictEqual(users[0].addresses[0].line1, "9 Spruce Ct");
      assert.strictEqual(res.body.conversion.accountSource, "created");
      const again = await makeLink(g, { kind: "membership", plan: "basic", billingCycle: "monthly", account: { mode: "create" } });
      assert.notStrictEqual(again.status, 200, "never a second account for the same email");
      assert.strictEqual(await User.countDocuments({ email: "pat.rivera@mailbox.test" }), 1);
    });

    /* ================================================================== */
    console.log("\nThe member seven-day rule and the plan limit");
    let member;
    await check("an existing member's free visit inside the seven days needs an explicit override", async () => {
      member = await customer();
      makeStripeSub({ id: "sub_existing_member", customer: member.stripeCustomerId, user: member, addressId: member.addresses[0]._id });
      assert.strictEqual(await deliver("customer.subscription.created", fake.subs.get("sub_existing_member")), 200);
      const g = await guestVisit({ date: soon, time: "13:00", email: member.email, line1: "300 Second Home Rd" });
      const res = await makeLink(g, { kind: "membership", plan: "basic", billingCycle: "monthly", account: { mode: "link", userId: String(member._id) } });
      assert.strictEqual(res.status, 409, JSON.stringify(res.body));
      assert.strictEqual(res.body.code, "LEAD_TIME_OVERRIDE_REQUIRED");
      assert.ok(res.body.earliestMemberDate);
      const ok = await makeLink(g, { kind: "membership", plan: "basic", billingCycle: "monthly", account: { mode: "link", userId: String(member._id) }, overrideLeadTimeReason: "Agreed on the call; Fixter already scheduled" });
      assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
      assert.strictEqual(ok.body.conversion.leadTime.rule, "admin_override");
      assert.strictEqual(ok.body.conversion.leadTime.override.byName, "Owner");
      assert.match(ok.body.conversion.leadTime.override.reason, /Agreed on the call/);
      assert.ok(await AdminActivityLog.exists({ action: "Free Visit Conversion Link Created", "details.leadTimeOverrideReason": /Agreed on the call/ }));
      await pressAccept(ok.body.token);
      const page = lastSession();
      assert.strictEqual(page.metadata.firstVisitExempt, "0", "no exception for an existing member");
      assert.strictEqual(await deliver("checkout.session.completed", paidMembership(page, await User.findById(member._id))), 200);
      const b = await Booking.findById(g._id);
      assert.strictEqual(b.accessType, "membership");
      assert.strictEqual(b.freeVisitConversion.leadTimeRule, "admin_override");
    });
    await check("Basic is refused when the home already has another visit booked; Plus is allowed", async () => {
      const u = await customer();
      const g = await onlineVisit(u, openDay(15), "10:00");
      await Booking.create({ bookingNumber: "55500001", date: at(openDay(20), "10:00"), service: "One-Time Visit", user: u._id, userId: u.userId, name: u.name, phone: u.phone, email: u.email, addressId: u.addresses[0]._id, address: u.addresses[0].line1, city: "Farmingdale", state: "NY", zip: "11735", accessType: "one_time", bookingType: "one_time_handyman_visit", subscription: "One-Time Visit", paymentState: "paid", status: "Confirmed" });
      const basic = await makeLink(g, { kind: "membership", plan: "basic", billingCycle: "monthly" });
      assert.strictEqual(basic.status, 409, JSON.stringify(basic.body));
      assert.strictEqual(basic.body.code, "MEMBERSHIP_LIMIT_REACHED");
      const plus = await makeLink(g, { kind: "membership", plan: "plus", billingCycle: "monthly" });
      assert.strictEqual(plus.status, 200, JSON.stringify(plus.body));
    });

    /* ================================================================== */
    console.log("\nThe visit changed while the customer was paying");
    await check("moved after the link was made: the page refuses to open a checkout", async () => {
      const g = await guestVisit({ date: openDay(21), time: "08:00" });
      const made = await makeLink(g, { kind: "one_time" });
      const moved = await call("PUT", `/api/admin/free-visits/${g._id}`, { as: owner, body: { date: openDay(21), time: "13:00" } });
      assert.strictEqual(moved.status, 200, JSON.stringify(moved.body));
      assert.strictEqual((await payPage(made.body.token)).body.status, "unavailable");
      const before = fake.created.length;
      const res = await press(made.body.token, { acceptTerms: true, termsVersion: conversionLib.TERMS_VERSION });
      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.code, "VISIT_CHANGED");
      assert.strictEqual(fake.created.length, before);
    });
    let cancelledConv;
    let cancelledVisit;
    await check("cancelled while the Stripe page was open, then paid: nothing is changed, nobody is told it was upgraded", async () => {
      cancelledVisit = await guestVisit({ date: openDay(22), time: "08:00", email: "sam.cancel@mailbox.test" });
      const made = await makeLink(cancelledVisit, { kind: "one_time" });
      cancelledConv = made.body.conversion.id;
      await pressAccept(made.body.token);
      const page = lastSession();
      const declined = await call("POST", `/api/admin/free-visits/${cancelledVisit._id}/decline`, { as: owner, body: { kind: "canceled", reason: "Customer asked" } });
      assert.strictEqual(declined.status, 200, JSON.stringify(declined.body));
      assert.strictEqual(await deliverWithId("evt_paid_cancelled", "checkout.session.completed", paidOneTime(page)), 200);
      const b = await Booking.findById(cancelledVisit._id);
      assert.strictEqual(b.status, "Canceled");
      assert.strictEqual(b.accessType, "free_first_visit", "never converted");
      assert.strictEqual(b.freeVisitConversion, undefined);
      const conv = await FreeVisitConversion.findById(cancelledConv);
      assert.strictEqual(conv.status, "needs_attention");
      assert.strictEqual(conv.attention.reason, "visit_changed");
      assert.strictEqual(keyed("visit_converted").filter((m) => m.to === "sam.cancel@mailbox.test").length, 0);
      const toCustomer = keyed("visit_conversion_attention").filter((m) => m.to === "sam.cancel@mailbox.test");
      assert.strictEqual(toCustomer.length, 1);
      assert.match(toCustomer[0].text, /received your \$99 payment/);
      assert.match(toCustomer[0].text, /nothing about that visit has changed yet/);
      assert.doesNotMatch(toCustomer[0].text, /is now/);
      assert.strictEqual(keyed("admin_visit_conversion_attention").length, 1);
      assert.ok(await AdminActivityLog.exists({ action: "free_visit_conversion_needs_attention", entityId: String(cancelledVisit._id) }));
      assert.strictEqual((await payPage(made.body.token)).body.status, "paid_attention");
    });
    await check("replays and retries tell nobody twice; Admin can still reach it from the job", async () => {
      const before = sent.length;
      assert.strictEqual(await deliverWithId("evt_paid_cancelled", "checkout.session.completed", { id: "x" }), 200);
      const retry = await call("POST", `/api/admin/free-visit-conversions/bookings/${cancelledVisit._id}/${cancelledConv}/retry`, { as: owner, body: {} });
      assert.strictEqual(retry.status, 200, JSON.stringify(retry.body));
      assert.strictEqual(retry.body.conversion.status, "needs_attention");
      assert.strictEqual(sent.length, before, "no second notice");
      const job = await call("GET", `/api/admin/jobs/${cancelledVisit._id}`, { as: owner });
      assert.ok(job.body.job.allowedActions.includes("convertToPaid"), "the sheet is reachable on a cancelled visit");
      assert.strictEqual(job.body.job.conversion.live.status, "needs_attention");
    });
    await check("it is in the owner's Needs action list, linked to the job, until it is settled", async () => {
      const { collectNeedsAction } = require("../utils/needsAction");
      const result = await collectNeedsAction({ accessUser: await User.findById(owner._id) });
      const section = result.sections.find((s) => s.key === "visit_conversions");
      assert.ok(section, JSON.stringify(result.sections.map((s) => s.key)));
      const item = section.items.find((i) => i.href === `/admin/jobs/${cancelledVisit._id}`);
      assert.ok(item, "the paid, unconverted visit is listed");
      assert.strictEqual(item.kind, "conversion_needs_attention");
      assert.strictEqual(item.severity, "problem");
      const field = await collectNeedsAction({ accessUser: await User.findById(fixter._id) });
      assert.ok(!field.sections.some((s) => s.key === "visit_conversions"), "not for a field Fixter");
    });
    await check("closing needs a resolution and a note, and a refund must show in Stripe first", async () => {
      const closeUrl = `/api/admin/free-visit-conversions/bookings/${cancelledVisit._id}/${cancelledConv}/close`;
      const noReason = await call("POST", closeUrl, { as: owner, body: {} });
      assert.strictEqual(noReason.status, 400);
      const noResolution = await call("POST", closeUrl, { as: owner, body: { reason: "Refunded in Stripe" } });
      assert.strictEqual(noResolution.status, 400);
      assert.strictEqual(noResolution.body.code, "RESOLUTION_REQUIRED");
      const claimed = await call("POST", closeUrl, { as: owner, body: { resolution: "refunded", reason: "Refunded in Stripe" } });
      assert.strictEqual(claimed.status, 409, JSON.stringify(claimed.body));
      assert.strictEqual(claimed.body.code, "NOT_REFUNDED", "Stripe shows no refund yet: not recorded");
      assert.strictEqual((await FreeVisitConversion.findById(cancelledConv)).status, "needs_attention");
      const pi = (await FreeVisitConversion.findById(cancelledConv)).payment.paymentIntentId;
      fake.refunds.set(pi, 9900);
      const closed = await call("POST", closeUrl, { as: owner, body: { resolution: "refunded", reason: "Refunded in Stripe" } });
      assert.strictEqual(closed.status, 200, JSON.stringify(closed.body));
      assert.strictEqual(closed.body.conversion.status, "closed");
      assert.strictEqual(closed.body.conversion.resolution.kind, "refunded");
      assert.strictEqual(closed.body.conversion.resolution.verified.refund, "full");
      assert.ok(closed.body.conversion.history.some((h) => h.event === "closed" && h.detail.reason === "Refunded in Stripe"));
      assert.deepStrictEqual(fake.forbidden, [], "nothing was refunded by the code");
    });
    await check("a paid conversion blocks another link until it is settled", async () => {
      const g = await guestVisit({ date: openDay(23), time: "08:00" });
      const made = await makeLink(g, { kind: "one_time" });
      await FreeVisitConversion.updateOne({ _id: made.body.conversion.id }, { $set: { status: "needs_attention" } });
      const res = await makeLink(g, { kind: "one_time" });
      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.code, "CONVERSION_IN_PROGRESS");
    });
    await check("a seven-day refusal after payment is retried with an explicit, recorded override", async () => {
      const u = await customer();
      const g = await onlineVisit(u, openDay(4), "08:00");
      const made = await makeLink(g, { kind: "membership", plan: "basic", billingCycle: "monthly" });
      assert.strictEqual(made.status, 200, JSON.stringify(made.body));
      await pressAccept(made.body.token);
      const page = lastSession();
      /* The exception is gone by the time Stripe reports the payment (spent elsewhere meanwhile). */
      const paid = paidMembership(page, u);
      fake.subs.get(paid.subscription).metadata.firstVisitExempt = "0";
      assert.strictEqual(await deliver("checkout.session.completed", paid), 200);
      let conv = await FreeVisitConversion.findById(made.body.conversion.id);
      assert.strictEqual(conv.status, "needs_attention");
      assert.strictEqual(conv.attention.reason, "lead_time");
      assert.strictEqual((await Booking.findById(g._id)).accessType, "free_first_visit");
      const res = await call("POST", `/api/admin/free-visit-conversions/bookings/${g._id}/${conv._id}/retry`, { as: owner, body: { overrideLeadTimeReason: "Owner approved the time on the call" } });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.conversion.status, "converted");
      conv = await FreeVisitConversion.findById(conv._id);
      assert.strictEqual(conv.leadTime.rule, "admin_override");
      assert.strictEqual(conv.leadTime.override.reason, "Owner approved the time on the call");
      const b = await Booking.findById(g._id);
      assert.strictEqual(b.accessType, "membership");
      assert.strictEqual(b.freeVisitConversion.leadTimeRule, "admin_override");
      assert.strictEqual(keyed("visit_converted").filter((m) => m.to === u.email).length, 1, "the confirmation goes once, after it really converted");
    });

    /* ================================================================== */
    console.log("\nConcurrency and the sweep");
    await check("two payment notices at once convert once and confirm once", async () => {
      const g = await guestVisit({ date: openDay(24), time: "08:00", email: "two.at.once@mailbox.test" });
      const made = await makeLink(g, { kind: "one_time" });
      await pressAccept(made.body.token);
      const page = lastSession();
      const results = await Promise.all([
        conversionLib.handleConversionPaid(paidOneTime(page)),
        conversionLib.handleConversionPaid(paidOneTime(page)),
        deliver("checkout.session.completed", paidOneTime(page)),
      ]);
      assert.ok(results);
      await conversionLib.sweepConversions(new Date(Date.now() + 15 * 60 * 1000));
      assert.strictEqual((await Booking.findById(g._id)).accessType, "one_time");
      assert.strictEqual((await FreeVisitConversion.findById(made.body.conversion.id)).status, "converted");
      assert.strictEqual(keyed("visit_converted").filter((m) => m.to === "two.at.once@mailbox.test").length, 1);
      assert.strictEqual(await reservationsFor(g._id), 1);
    });
    await check("a second, different paid page for the same visit converts nothing more and alerts the owner", async () => {
      const g = await guestVisit({ date: openDay(25), time: "08:00", email: "paid.twice@mailbox.test" });
      const made = await makeLink(g, { kind: "one_time" });
      await pressAccept(made.body.token);
      const first = lastSession();
      fake.sessions.get(first.id).status = "expired";
      await FreeVisitConversion.updateOne({ _id: made.body.conversion.id }, { $set: { "checkout.sessionId": "" } });
      await pressAccept(made.body.token);
      const second = lastSession();
      assert.notStrictEqual(first.id, second.id);
      assert.strictEqual(await deliver("checkout.session.completed", paidOneTime(first)), 200);
      assert.strictEqual(await deliver("checkout.session.completed", paidOneTime(second)), 200);
      assert.strictEqual(keyed("visit_converted").filter((m) => m.to === "paid.twice@mailbox.test").length, 1);
      assert.ok(await AdminActivityLog.exists({ action: "free_visit_conversion_second_payment", entityId: String(g._id) }));
    });
    await check("a link past its time is expired by the sweep; the visit is untouched", async () => {
      const g = await guestVisit({ date: openDay(26), time: "08:00" });
      const made = await makeLink(g, { kind: "one_time" });
      await FreeVisitConversion.updateOne({ _id: made.body.conversion.id }, { $set: { linkExpiresAt: new Date(Date.now() - 1000) } });
      await AdminPaymentLink.updateOne({ conversion: made.body.conversion.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
      const tally = await conversionLib.sweepConversions();
      assert.ok(tally.expired >= 1);
      assert.strictEqual((await FreeVisitConversion.findById(made.body.conversion.id)).status, "expired");
      assert.strictEqual((await payPage(made.body.token)).body.status, "expired");
      assert.strictEqual((await Booking.findById(g._id)).accessType, "free_first_visit");
    });
    await check("a One-Time conversion on an account records its paid entitlement once", async () => {
      const u = await customer();
      const g = await onlineVisit(u, openDay(27), "08:00");
      const made = await makeLink(g, { kind: "one_time" });
      await pressAccept(made.body.token);
      const page = lastSession();
      assert.strictEqual(page.config.customer, u.stripeCustomerId);
      assert.strictEqual(await deliver("checkout.session.completed", paidOneTime(page)), 200);
      assert.strictEqual(await deliver("checkout.session.completed", paidOneTime(page)), 200);
      const ents = await VisitEntitlement.find({ bookingId: g._id });
      assert.strictEqual(ents.length, 1);
      assert.strictEqual(ents[0].status, "paid");
      assert.strictEqual(String((await Booking.findById(g._id)).entitlementId), String(ents[0]._id));
    });

    /* ================================================================== */
    console.log("\nIndependent review fixes");
    /* The public /pay route allows 60 requests per 15 minutes per address; this suite is one address. */
    await require("../models/AuthRateCounter").deleteMany({});
    await check("a late payment on a replaced link converts the visit and withdraws the newer unpaid link (no lost payment)", async () => {
      const g = await guestVisit({ date: openDay(30), time: "08:00", email: "late.payer@mailbox.test" });
      const a = await makeLink(g, { kind: "one_time" });
      await pressAccept(a.body.token);
      const pageA = lastSession();
      const b = await makeLink(g, { kind: "one_time" });
      assert.strictEqual(b.status, 200);
      assert.strictEqual((await FreeVisitConversion.findById(a.body.conversion.id)).status, "canceled");
      assert.strictEqual(await deliver("checkout.session.completed", paidOneTime(pageA)), 200, "never a failure Stripe would retry");
      assert.strictEqual((await FreeVisitConversion.findById(a.body.conversion.id)).status, "converted");
      assert.strictEqual((await FreeVisitConversion.findById(b.body.conversion.id)).status, "canceled");
      assert.strictEqual((await Booking.findById(g._id)).accessType, "one_time");
      assert.strictEqual(keyed("visit_converted").filter((m) => m.to === "late.payer@mailbox.test").length, 1);
    });
    await check("a late payment after another link already converted the visit is recorded as a second payment, never 'nothing changed'", async () => {
      const g = await guestVisit({ date: openDay(31), time: "08:00", email: "second.link@mailbox.test" });
      const a = await makeLink(g, { kind: "one_time" });
      await pressAccept(a.body.token);
      const pageA = lastSession();
      const b = await makeLink(g, { kind: "one_time" });
      await pressAccept(b.body.token);
      assert.strictEqual(await deliver("checkout.session.completed", paidOneTime(lastSession())), 200);
      assert.strictEqual((await FreeVisitConversion.findById(b.body.conversion.id)).status, "converted");
      assert.strictEqual(await deliver("checkout.session.completed", paidOneTime(pageA)), 200);
      const ca = await FreeVisitConversion.findById(a.body.conversion.id);
      assert.deepStrictEqual(ca.payment.extraSessionIds, [pageA.id], "the payment is recorded");
      assert.ok(await AdminActivityLog.exists({ action: "free_visit_conversion_second_payment", entityId: String(g._id) }));
      assert.strictEqual(keyed("visit_conversion_attention").filter((m) => m.to === "second.link@mailbox.test").length, 0, "no false 'nothing changed' email");
      assert.strictEqual((await payPage(a.body.token)).body.status, "paid_attention", "the old page says the payment arrived");
      const before = sent.length;
      assert.strictEqual(await deliver("checkout.session.completed", paidOneTime(pageA)), 200);
      assert.strictEqual(sent.length, before, "the owner is told once per payment");
    });
    await check("a new member's checkout carries the first-visit exception even when the visit is outside the seven days", async () => {
      const u = await customer();
      const g = await onlineVisit(u, openDay(32), "08:00");
      const made = await makeLink(g, { kind: "membership", plan: "basic", billingCycle: "monthly" });
      assert.strictEqual(made.status, 200, JSON.stringify(made.body));
      assert.strictEqual(made.body.conversion.leadTime.rule, "none");
      await pressAccept(made.body.token);
      assert.strictEqual(lastSession().metadata.firstVisitExempt, "1");
    });
    await check("without the exception, the Stripe page closes before the visit enters the seven days", async () => {
      const m = await customer();
      makeStripeSub({ id: `sub_boundary_${m._id}`, customer: m.stripeCustomerId, user: m, addressId: m.addresses[0]._id });
      assert.strictEqual(await deliver("customer.subscription.created", fake.subs.get(`sub_boundary_${m._id}`)), 200);
      let v = moment.tz(TZ).startOf("day").add(7, "days");
      if (v.day() === 0) v = v.add(1, "day");
      const day = v.format("YYYY-MM-DD");
      const g = await guestVisit({ date: day, time: "13:00", email: m.email, line1: "77 Boundary Rd" });
      const made = await makeLink(g, { kind: "membership", plan: "basic", billingCycle: "monthly", account: { mode: "link", userId: String(m._id) } });
      assert.strictEqual(made.status, 200, JSON.stringify(made.body));
      const res = await pressAccept(made.body.token);
      const deadline = moment.tz(day, TZ).startOf("day").subtract(6, "days").valueOf();
      if (deadline - Date.now() < 31 * 60 * 1000) {
        assert.notStrictEqual(res.status, 200, "too close to the boundary: refused rather than risked");
      } else {
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(lastSession().metadata.firstVisitExempt, "0");
        assert.ok(lastSession().config.expires_at * 1000 <= deadline, "closes before the visit is inside the seven days");
      }
    });
    await check("a phone-only match with a different email needs Admin's explicit confirmation", async () => {
      const x = await customer({ email: "household.other@mailbox.test", phone: "+16315557777" });
      const g = await guestVisit({ date: openDay(33), time: "08:00", email: "household.me@mailbox.test", phone: "+16315557777" });
      const res = await makeLink(g, { kind: "membership", plan: "basic", billingCycle: "monthly", account: { mode: "link", userId: String(x._id) } });
      assert.strictEqual(res.status, 409, JSON.stringify(res.body));
      assert.strictEqual(res.body.code, "ACCOUNT_EMAIL_DIFFERS");
      assert.strictEqual((await User.findById(x._id)).addresses.length, 1, "nothing written");
      const ok = await makeLink(g, { kind: "membership", plan: "basic", billingCycle: "monthly", account: { mode: "link", userId: String(x._id), confirmDifferentEmail: true } });
      assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
      assert.ok(ok.body.conversion.history.some((h) => h.event === "account_linked" && h.detail.confirmedDifferentEmail === true));
    });
    await check("a General Fixter cannot put a visit on a customer's account (Customers section)", async () => {
      const x = await customer({ email: "gf.link@mailbox.test" });
      const g = await guestVisit({ date: openDay(34), time: "08:00", email: "gf.link@mailbox.test" });
      const res = await makeLink(g, { kind: "membership", plan: "basic", billingCycle: "monthly", account: { mode: "link", userId: String(x._id) } }, generalFixter);
      assert.strictEqual(res.status, 403, JSON.stringify(res.body));
      assert.strictEqual(res.body.code, "FORBIDDEN_ACCOUNT_LINK");
      assert.strictEqual((await User.findById(x._id)).addresses.length, 1);
    });
    await check("account creation is the last step: a refusal before it creates no account and sends nothing", async () => {
      const g = await guestVisit({ date: openDay(35), time: "08:00", name: "Cher", email: "cher.single@mailbox.test" });
      const before = sent.length;
      const res = await makeLink(g, { kind: "membership", plan: "basic", billingCycle: "monthly", account: { mode: "create" } });
      assert.strictEqual(res.status, 400, JSON.stringify(res.body));
      assert.strictEqual(res.body.code, "NAME_REQUIRED");
      assert.strictEqual(await User.countDocuments({ email: "cher.single@mailbox.test" }), 0);
      assert.strictEqual(sent.length, before, "no sign-in details sent");
    });
    await check("a visit moved during checkout can be converted at its new time, only by an explicit, recorded retry", async () => {
      const g = await guestVisit({ date: openDay(36), time: "08:00", email: "moved.visit@mailbox.test" });
      const made = await makeLink(g, { kind: "one_time" });
      await pressAccept(made.body.token);
      const page = lastSession();
      const moved = await call("PUT", `/api/admin/free-visits/${g._id}`, { as: owner, body: { date: openDay(36), time: "13:00" } });
      assert.strictEqual(moved.status, 200, JSON.stringify(moved.body));
      assert.strictEqual(await deliver("checkout.session.completed", paidOneTime(page)), 200);
      assert.strictEqual((await FreeVisitConversion.findById(made.body.conversion.id)).attention.reason, "visit_changed");
      const plain = await call("POST", `/api/admin/free-visit-conversions/bookings/${g._id}/${made.body.conversion.id}/retry`, { as: owner, body: {} });
      assert.strictEqual(plain.body.conversion.status, "needs_attention", "a plain retry never converts the moved visit");
      const res = await call("POST", `/api/admin/free-visit-conversions/bookings/${g._id}/${made.body.conversion.id}/retry`, { as: owner, body: { acceptCurrentVisit: true } });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.conversion.status, "converted");
      assert.ok(res.body.conversion.history.some((h) => h.event === "visit_accepted_as_is" && h.byName === "Owner"));
      const b = await Booking.findById(g._id);
      assert.strictEqual(b.accessType, "one_time");
      assert.strictEqual(moment(b.date).tz(TZ).format("HH:mm"), "13:00");
    });
    await check("a visit that has started is not converted after the fact", async () => {
      const g = await guestVisit({ date: openDay(37), time: "08:00", email: "started.visit@mailbox.test" });
      const made = await makeLink(g, { kind: "one_time" });
      await pressAccept(made.body.token);
      const page = lastSession();
      const past = new Date(Date.now() - 60 * 1000);
      await Booking.updateOne({ _id: g._id }, { $set: { date: past } });
      await FreeVisitConversion.updateOne({ _id: made.body.conversion.id }, { $set: { "snapshot.date": past } });
      assert.strictEqual(await deliver("checkout.session.completed", paidOneTime(page)), 200);
      const conv = await FreeVisitConversion.findById(made.body.conversion.id);
      assert.strictEqual(conv.status, "needs_attention");
      assert.strictEqual(conv.attention.reason, "visit_started");
      assert.strictEqual((await Booking.findById(g._id)).accessType, "free_first_visit");
    });
    await check("a visit put on another account while the customer paid is not moved off it", async () => {
      const other = await customer();
      const g = await guestVisit({ date: openDay(38), time: "08:00", email: "account.moved@mailbox.test" });
      const made = await makeLink(g, { kind: "one_time" });
      await pressAccept(made.body.token);
      const page = lastSession();
      await Booking.updateOne({ _id: g._id }, { $set: { user: other._id } });
      assert.strictEqual(await deliver("checkout.session.completed", paidOneTime(page)), 200);
      const conv = await FreeVisitConversion.findById(made.body.conversion.id);
      assert.strictEqual(conv.attention.reason, "account_changed");
      const b = await Booking.findById(g._id);
      assert.strictEqual(String(b.user), String(other._id));
      assert.strictEqual(b.accessType, "free_first_visit");
    });
    await check("a conversion interrupted after the booking changed is finished, with its entitlement, and confirmed once", async () => {
      const u = await customer();
      const g = await onlineVisit(u, openDay(39), "08:00");
      const made = await makeLink(g, { kind: "one_time" });
      await pressAccept(made.body.token);
      assert.strictEqual(await deliver("checkout.session.completed", paidOneTime(lastSession())), 200);
      /* As if the process died right after the booking update: */
      await VisitEntitlement.deleteMany({ bookingId: g._id });
      await Booking.updateOne({ _id: g._id }, { $unset: { entitlementId: 1 } });
      await FreeVisitConversion.updateOne({ _id: made.body.conversion.id }, { $set: { status: "converting", convertingAt: new Date(Date.now() - 11 * 60 * 1000) } });
      const before = sent.length;
      await conversionLib.sweepConversions();
      assert.strictEqual((await FreeVisitConversion.findById(made.body.conversion.id)).status, "converted");
      assert.strictEqual(await VisitEntitlement.countDocuments({ bookingId: g._id }), 1, "the entitlement is recreated");
      assert.strictEqual(sent.length, before, "no second confirmation");
    });
    await check("if Stripe cannot say whether the open page is still open, no second page is opened", async () => {
      const g = await guestVisit({ date: openDay(40), time: "08:00" });
      const made = await makeLink(g, { kind: "one_time" });
      await pressAccept(made.body.token);
      const before = fake.created.length;
      const realRetrieve = stripe.checkout.sessions.retrieve;
      stripe.checkout.sessions.retrieve = async () => {
        throw new Error("Stripe is unreachable");
      };
      try {
        const res = await pressAccept(made.body.token);
        assert.strictEqual(res.status, 503, JSON.stringify(res.body));
        assert.strictEqual(fake.created.length, before);
      } finally {
        stripe.checkout.sessions.retrieve = realRetrieve;
      }
    });
    await check("a duplicate-membership payment never tells the customer their membership is active", async () => {
      const u = await customer({ email: "dup.member@mailbox.test" });
      const g = await onlineVisit(u, openDay(41), "08:00");
      const made = await makeLink(g, { kind: "membership", plan: "basic", billingCycle: "monthly" });
      await pressAccept(made.body.token);
      const page = lastSession();
      await conversionLib.handleConversionPaid(paidMembership(page, u), { duplicateMembership: true });
      const conv = await FreeVisitConversion.findById(made.body.conversion.id);
      assert.strictEqual(conv.attention.reason, "duplicate_membership");
      const mail1 = keyed("visit_conversion_attention").filter((m) => m.to === "dup.member@mailbox.test");
      assert.strictEqual(mail1.length, 1);
      assert.doesNotMatch(mail1[0].text, /membership is active/);
    });

    /* ================================================================== */
    console.log("\nRefusals before anything is made");
    await check("a visit too close to its start, or without a reservation, or already cancelled, cannot get a link", async () => {
      const g = await guestVisit({ date: openDay(28), time: "08:00" });
      await Booking.updateOne({ _id: g._id }, { $set: { date: new Date(Date.now() + 60 * 60 * 1000) } });
      const tooSoon = await makeLink(g, { kind: "one_time" });
      assert.strictEqual(tooSoon.status, 409);
      assert.strictEqual(tooSoon.body.code, "VISIT_TOO_SOON");
      const g2 = await guestVisit({ date: openDay(28), time: "10:00" });
      await Booking.updateOne({ _id: g2._id }, { $set: { status: "Canceled" } });
      assert.strictEqual((await makeLink(g2, { kind: "one_time" })).body.code, "VISIT_CLOSED");
      const g3 = await guestVisit({ date: openDay(28), time: "13:00" });
      await Booking.updateOne({ _id: g3._id }, { $set: { email: "" } });
      assert.strictEqual((await makeLink(g3, { kind: "one_time" })).body.code, "EMAIL_REQUIRED");
    });
    await check("status mapping: awaiting approval stays awaiting approval; confirmed stays confirmed", async () => {
      assert.strictEqual(conversionLib.convertedStatus("Pending Confirmation"), "Pending");
      assert.strictEqual(conversionLib.convertedStatus("Pending"), "Pending");
      assert.strictEqual(conversionLib.convertedStatus("Confirmed"), "Confirmed");
    });

    /* ================================================================== */
    console.log("\nThe customer upgrades their own free visit (signed in)");
    const upgradeOptions = (booking, as) => call("GET", `/api/visit-upgrade/${booking._id}`, { as });
    const upgrade = (booking, as, body) => call("POST", `/api/visit-upgrade/${booking._id}/checkout`, { as, body });
    const accepted = (opts, extra) => ({ acceptTerms: true, termsVersion: opts.termsVersion, ...extra });
    let cg;
    let cgUser;
    let cgBefore;
    let cgOpts;
    await check("a guest's visit is upgradable only once they sign in with the phone they booked with", async () => {
      cg = await guestVisit({ date: openDay(60), time: "08:00", email: "carla.guest@mailbox.test" });
      cgBefore = cg.toObject();
      const stranger = await customer({ email: "stranger@mailbox.test" });
      const notTheirs = await upgradeOptions(cg, stranger);
      assert.strictEqual(notTheirs.status, 404, "someone else's visit is not found");
      assert.strictEqual((await upgrade(cg, stranger, { kind: "one_time", acceptTerms: true, termsVersion: conversionLib.TERMS_VERSION })).status, 404);
      /* Signing in with a code to the visit's phone joins the visit to the account (utils/freeVisit/guestLink). */
      cgUser = await customer({ name: "Carla Guest", email: "carla.guest@mailbox.test", phone: cg.phone, emailVerifiedAt: new Date(), addresses: [] });
      const { linkGuestFreeVisits } = require("../utils/freeVisit/guestLink");
      assert.strictEqual(await linkGuestFreeVisits(cgUser), 1);
      const res = await upgradeOptions(cg, cgUser);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      cgOpts = res.body;
      assert.strictEqual(cgOpts.upgradable, true);
      assert.strictEqual(cgOpts.offers.oneTime.enabled, true);
      assert.strictEqual(cgOpts.offers.oneTime.priceCents, 9900);
      assert.strictEqual(cgOpts.booking.addressId, null, "the visit's address is not on the new account yet");
      assert.match(cgOpts.terms.one_time, /One-Time Visit for \$99/);
      assert.match(cgOpts.terms.membership.basic.monthly.welcome, /first payment is \$119\.20 \(20% off\), then \$149 per month/);
      assert.ok(!JSON.stringify(cgOpts).includes(String(cg.phone)), "no contact details in the sheet");
    });
    await check("My Visits marks the free visit as upgradable and sends nothing internal", async () => {
      const list = await call("GET", "/api/bookings", { as: cgUser });
      const row = list.body.find((b) => b._id === String(cg._id));
      assert.ok(row, "the linked visit is listed");
      assert.strictEqual(row.upgrade.freeVisit, true);
      assert.strictEqual(row.upgrade.current, null);
      assert.ok(!("freeVisitConversion" in row));
    });
    let cgSession;
    await check("One-Time: no Stripe page without the terms; then the customer's own page, nothing sent, visit untouched", async () => {
      const before = fake.created.length;
      const mails = sent.length;
      const noTerms = await upgrade(cg, cgUser, { kind: "one_time" });
      assert.strictEqual(noTerms.status, 400);
      assert.strictEqual(noTerms.body.code, "TERMS_REQUIRED");
      assert.strictEqual(fake.created.length, before);
      const res = await upgrade(cg, cgUser, accepted(cgOpts, { kind: "one_time", fbp: "fb.1.1700000000000.123456789" }));
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      cgSession = lastSession();
      assert.strictEqual(res.body.url, cgSession.url);
      assert.strictEqual(cgSession.mode, "payment");
      assert.strictEqual(cgSession.metadata.initiatedBy, "customer");
      assert.strictEqual(cgSession.metadata.productKind, "free_visit_conversion");
      assert.ok(!cgSession.metadata.adminInitiated && !cgSession.metadata.bookingId, "not a staff sale, never the One-Time handler's booking");
      assert.strictEqual(cgSession.metadata.fbp, "fb.1.1700000000000.123456789");
      assert.strictEqual(cgSession.config.success_url, `https://www.profixter.com/book?upgraded=${cg._id}#your-visits`);
      const conv = await FreeVisitConversion.findOne({ booking: cg._id, status: "open" });
      assert.strictEqual(conv.source, "customer");
      assert.strictEqual(String(conv.user), String(cgUser._id));
      assert.strictEqual(conv.contact.email, "carla.guest@mailbox.test");
      assert.strictEqual(conv.link, null, "no payment link: the customer is already signed in");
      assert.strictEqual(conv.terms.variant, "regular");
      assert.match(conv.terms.text, /One-Time Visit for \$99/);
      assert.ok(conv.history.some((h) => h.event === "customer_started"));
      assert.strictEqual(await AdminPaymentLink.countDocuments({ conversion: conv._id }), 0);
      assert.strictEqual(sent.length, mails, "nothing sent");
      const now = (await Booking.findById(cg._id)).toObject();
      for (const f of ["accessType", "status", "service", "isFreeFirstVisit", "date"]) assert.deepStrictEqual(now[f], cgBefore[f], f);
    });
    await check("pressing Continue again reuses the open page", async () => {
      const before = fake.created.length;
      const res = await upgrade(cg, cgUser, accepted(cgOpts, { kind: "one_time" }));
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.url, cgSession.url);
      assert.strictEqual(fake.created.length, before);
      assert.strictEqual(await FreeVisitConversion.countDocuments({ booking: cg._id }), 1);
    });
    await check("Admin sees the customer's upgrade on the job, marked as started by the customer", async () => {
      const res = await call("GET", `/api/admin/free-visit-conversions/bookings/${cg._id}`, { as: owner });
      assert.strictEqual(res.body.current.source, "customer");
      assert.strictEqual(res.body.current.checkoutOpen, true);
      assert.match(res.body.current.createdByName, /\(customer\)$/);
    });
    await check("paid: the same visit becomes a One-Time Visit once, one confirmation, reported to Meta as the customer's purchase", async () => {
      metaEvents.length = 0;
      assert.strictEqual(await deliver("checkout.session.completed", paidOneTime(cgSession)), 200);
      assert.strictEqual(await deliver("checkout.session.completed", paidOneTime(cgSession)), 200);
      const b = await Booking.findById(cg._id);
      assert.strictEqual(String(b._id), String(cg._id));
      assert.strictEqual(b.accessType, "one_time");
      assert.strictEqual(b.status, "Pending", "still awaiting the owner's approval");
      assert.strictEqual(b.date.getTime(), cgBefore.date.getTime());
      assert.strictEqual(String(b.slotReservationId), String(cgBefore.slotReservationId));
      assert.deepStrictEqual(b.images, cgBefore.images);
      assert.strictEqual(String(b.guestRequestId), String(cgBefore.guestRequestId), "still the person's free visit");
      assert.strictEqual(await reservationsFor(cg._id), 1);
      assert.strictEqual(keyed("visit_converted").filter((m) => m.to === "carla.guest@mailbox.test").length, 1);
      const purchases = metaEvents.filter((e) => e.eventName === "Purchase" && e.eventId === `sess_${cgSession.id}`);
      assert.ok(purchases.length >= 1, "the customer's own purchase is reported");
      const list = await call("GET", "/api/bookings", { as: cgUser });
      const row = list.body.find((x) => x._id === String(cg._id));
      assert.strictEqual(row.upgrade.converted, true);
      assert.strictEqual(row.upgrade.current.status, "converted");
      const again = await upgradeOptions(cg, cgUser);
      assert.strictEqual(again.body.upgradable, false);
      assert.strictEqual(again.body.problem.code, "ALREADY_CONVERTED");
    });
    await check("an Admin-link payment is still never reported to Meta", async () => {
      const g = await guestVisit({ date: openDay(61), time: "08:00" });
      const made = await makeLink(g, { kind: "one_time" });
      await pressAccept(made.body.token);
      const page = lastSession();
      metaEvents.length = 0;
      assert.strictEqual(await deliver("checkout.session.completed", paidOneTime(page)), 200);
      assert.strictEqual((await Booking.findById(g._id)).accessType, "one_time");
      assert.strictEqual(metaEvents.length, 0);
    });

    console.log("\nCustomer membership upgrade and the 20% welcome offer");
    let wu;
    let wv;
    let wOpts;
    let wSession;
    await check("a brand-new account inside its ten minutes gets the welcome offer on its upgrade, as on its own membership checkout", async () => {
      wu = await customer({ email: "wendy.new@mailbox.test" });
      wv = await onlineVisit(wu, openDay(62), "08:00");
      wOpts = (await upgradeOptions(wv, wu)).body;
      assert.strictEqual(wOpts.upgradable, true, JSON.stringify(wOpts.problem));
      assert.strictEqual(wOpts.booking.addressId, String(wu.addresses[0]._id));
      const res = await upgrade(wv, wu, accepted(wOpts, { kind: "membership", plan: "basic", billingCycle: "monthly", welcomeOffer: true }));
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.welcomeOfferApplied, true);
      wSession = lastSession();
      assert.strictEqual(wSession.mode, "subscription");
      assert.deepStrictEqual(wSession.config.discounts, [{ coupon: "pfx-welcome-20-first-month" }]);
      assert.ok(!wSession.config.allow_promotion_codes, "the offer never stacks with a code");
      assert.strictEqual(wSession.metadata.welcomeOffer, "first_month_20");
      assert.strictEqual(wSession.metadata.initiatedBy, "customer");
      assert.ok(!wSession.metadata.adminInitiated);
      assert.ok(wSession.config.expires_at - Math.floor(Date.now() / 1000) <= 31 * 60 + 5, "a welcome-priced page lasts 31 minutes");
      const conv = await FreeVisitConversion.findOne({ booking: wv._id, status: "open" });
      assert.strictEqual(conv.welcomeOfferApplied, true);
      assert.strictEqual(conv.terms.variant, "welcome");
      assert.match(conv.terms.text, /\$119\.20 \(20% off\)/);
      const raw = await User.collection.findOne({ _id: wu._id }, { projection: { welcomeOffer: 1 } });
      assert.strictEqual(raw.welcomeOffer.sessionId, wSession.id, "redeemed only when this page completes, as always");
    });
    await check("paid: the membership visit is the same booking, with the 7-day rule not needed (14+ days out)", async () => {
      assert.strictEqual(await deliver("checkout.session.completed", paidMembership(wSession, wu)), 200);
      const b = await Booking.findById(wv._id);
      assert.strictEqual(b.accessType, "membership");
      assert.strictEqual(b.freeVisitConversion.leadTimeRule, "none");
      assert.strictEqual((await FreeVisitConversion.findOne({ booking: wv._id })).status, "converted");
      /* The offer is now used: this account and home cannot have it again. */
      const { welcomeOfferStatus } = require("../utils/welcomeOffer");
      assert.strictEqual((await welcomeOfferStatus({ user: await User.findById(wu._id).lean() })).eligible, false);
    });
    await check("shown the offer after it ended: refused with the regular price, nothing made", async () => {
      const u = await customer({ email: "olga.older@mailbox.test" });
      await User.collection.updateOne({ _id: u._id }, { $set: { createdAt: new Date(Date.now() - 60 * 60 * 1000) } });
      const v = await onlineVisit(u, openDay(63), "08:00");
      const opts = (await upgradeOptions(v, u)).body;
      const before = fake.created.length;
      const res = await upgrade(v, u, accepted(opts, { kind: "membership", plan: "basic", billingCycle: "monthly", welcomeOffer: true }));
      assert.strictEqual(res.status, 409, JSON.stringify(res.body));
      assert.strictEqual(res.body.code, "WELCOME_OFFER_ENDED");
      assert.strictEqual(fake.created.length, before);
      assert.strictEqual(await FreeVisitConversion.countDocuments({ booking: v._id }), 0);
      const regular = await upgrade(v, u, accepted(opts, { kind: "membership", plan: "basic", billingCycle: "annual" }));
      assert.strictEqual(regular.status, 200, JSON.stringify(regular.body));
      assert.strictEqual(regular.body.welcomeOfferApplied, false);
      assert.ok(!lastSession().config.discounts);
      assert.strictEqual(lastSession().config.allow_promotion_codes, true, "the regular page keeps the promotion-code field, as the customer's own checkout does");
    });
    await check("changing the choice replaces the customer's own unpaid page", async () => {
      const u = await customer({ email: "chooser@mailbox.test" });
      await User.collection.updateOne({ _id: u._id }, { $set: { createdAt: new Date(Date.now() - 60 * 60 * 1000) } });
      const v = await onlineVisit(u, openDay(64), "08:00");
      const opts = (await upgradeOptions(v, u)).body;
      await upgrade(v, u, accepted(opts, { kind: "one_time" }));
      const first = lastSession();
      const res = await upgrade(v, u, accepted(opts, { kind: "membership", plan: "plus", billingCycle: "monthly" }));
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(fake.sessions.get(first.id).status, "expired", "the One-Time page was closed");
      assert.strictEqual(await FreeVisitConversion.countDocuments({ booking: v._id, status: "open" }), 1);
      assert.strictEqual((await FreeVisitConversion.findOne({ booking: v._id, status: "open" })).plan, "plus");
    });

    console.log("\nCustomer upgrade: the visit's rules, guests' homes, Admin links");
    await check("inside the seven days a new membership keeps the time (first-visit exception); the guest's address becomes a home only then", async () => {
      const g = await guestVisit({ date: openDay(2), time: "13:00", email: "ivy.inside@mailbox.test" });
      const u = await customer({ name: "Ivy Inside", email: "ivy.inside@mailbox.test", phone: g.phone, emailVerifiedAt: new Date(), addresses: [] });
      await require("../utils/freeVisit/guestLink").linkGuestFreeVisits(u);
      const opts = (await upgradeOptions(g, u)).body;
      assert.strictEqual(opts.offers.membership.firstVisitException, true);
      assert.strictEqual(opts.offers.membership.blocker, null);
      const res = await upgrade(g, u, accepted(opts, { kind: "membership", plan: "basic", billingCycle: "monthly" }));
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      const fresh = await User.findById(u._id);
      assert.strictEqual(fresh.addresses.length, 1, "the visit's address was added as the account's home");
      assert.strictEqual(fresh.addresses[0].line1, g.address);
      assert.strictEqual(lastSession().metadata.firstVisitExempt, "1");
      const conv = await FreeVisitConversion.findOne({ booking: g._id, status: "open" });
      assert.strictEqual(conv.leadTime.rule, "first_visit_exemption");
      assert.ok(conv.history.some((h) => h.event === "home_added_to_account"));
    });
    await check("inside the seven days an existing member is refused a membership (no customer override) and nothing is written; One-Time still works", async () => {
      const g = await guestVisit({ date: openDay(2), time: "10:00", email: "mia.member@mailbox.test" });
      const u = await customer({ name: "Mia Member", email: "mia.member@mailbox.test", phone: g.phone, emailVerifiedAt: new Date() });
      await Subscription.create({ user: u._id, userId: u.userId, subscriptionType: "basic", addressId: u.addresses[0]._id, startDate: new Date(), latestPaymentDate: new Date(), nextPaymentDate: new Date(Date.now() + 30 * 86400000), status: "active", accessStatus: "active", planPrice: 149, stripeSubscriptionId: "sub_mia_existing" });
      await require("../utils/freeVisit/guestLink").linkGuestFreeVisits(u);
      const opts = (await upgradeOptions(g, u)).body;
      assert.strictEqual(opts.offers.membership.blocker.code, "LEAD_TIME");
      const homes = (await User.findById(u._id)).addresses.length;
      const res = await upgrade(g, u, accepted(opts, { kind: "membership", plan: "plus", billingCycle: "monthly" }));
      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.code, "LEAD_TIME");
      assert.match(res.body.message, /One-Time Visit keeps this time/);
      assert.strictEqual((await User.findById(u._id)).addresses.length, homes, "no home added for a refused membership");
      assert.strictEqual(await FreeVisitConversion.countDocuments({ booking: g._id }), 0);
      assert.strictEqual((await upgrade(g, u, accepted(opts, { kind: "one_time" }))).status, 200);
    });
    await check("missing contact details are asked for, nothing else", async () => {
      const u = await customer({ email: "noname@mailbox.test" });
      const v = await onlineVisit(u, openDay(65), "08:00");
      await User.collection.updateOne({ _id: u._id }, { $set: { name: "" } });
      const opts = (await upgradeOptions(v, u)).body;
      const res = await upgrade(v, u, accepted(opts, { kind: "one_time" }));
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, "CONTACT_REQUIRED");
      assert.deepStrictEqual(res.body.missing, ["name"]);
    });
    await check("the customer's own upgrade replaces Admin's unpaid link (recorded); a paid one blocks it", async () => {
      const u = await customer({ email: "both.paths@mailbox.test" });
      const v = await onlineVisit(u, openDay(66), "08:00");
      const made = await makeLink(v, { kind: "one_time" });
      assert.strictEqual(made.status, 200, JSON.stringify(made.body));
      const opts = (await upgradeOptions(v, u)).body;
      assert.strictEqual(opts.current.status, "open");
      assert.strictEqual(opts.current.startedBy, "admin");
      const res = await upgrade(v, u, accepted(opts, { kind: "one_time" }));
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      const adminConv = await FreeVisitConversion.findById(made.body.conversion.id);
      assert.strictEqual(adminConv.status, "canceled");
      assert.ok(adminConv.history.some((h) => h.event === "replaced"));
      assert.strictEqual((await payPage(made.body.token)).body.status, "canceled");
      /* Paid: neither path can start another. */
      await deliver("checkout.session.completed", paidOneTime(lastSession()));
      const after = await upgradeOptions(v, u);
      assert.strictEqual(after.body.upgradable, false);
      assert.strictEqual((await makeLink(v, { kind: "one_time" })).body.code, "ALREADY_CONVERTED");
    });
    await check("a payment that cannot convert tells the customer's card the truth, never 'upgraded'", async () => {
      const u = await customer({ email: "customer.moved@mailbox.test" });
      const v = await onlineVisit(u, openDay(67), "08:00");
      const opts = (await upgradeOptions(v, u)).body;
      await upgrade(v, u, accepted(opts, { kind: "one_time" }));
      const page = lastSession();
      await Booking.updateOne({ _id: v._id }, { $set: { date: at(openDay(67), "13:00") } });
      await deliver("checkout.session.completed", paidOneTime(page));
      assert.strictEqual((await Booking.findById(v._id)).accessType, "free_first_visit");
      const list = await call("GET", "/api/bookings", { as: u });
      const row = list.body.find((x) => x._id === String(v._id));
      assert.strictEqual(row.upgrade.current.status, "paid_attention");
      assert.strictEqual(keyed("visit_conversion_attention").filter((m) => m.to === "customer.moved@mailbox.test").length, 1);
      assert.strictEqual(keyed("visit_converted").filter((m) => m.to === "customer.moved@mailbox.test").length, 0);
      assert.strictEqual((await upgradeOptions(v, u)).body.problem.code, "CONVERSION_IN_PROGRESS");
    });

    /* ================================================================== */
    console.log("\nMy Visits links a guest visit for a customer who is already signed in");
    await check("a guest visit booked while signed in appears in My Visits, linked on the account's proved phone", async () => {
      const u = await customer({ email: "lina.signedin@mailbox.test" });
      const v = await guestVisit({ date: openDay(68), time: "08:00", phone: u.phone, email: "lina.other.address@mailbox.test" });
      assert.strictEqual((await Booking.findById(v._id)).user, null);
      const list = await call("GET", "/api/bookings", { as: u });
      assert.strictEqual(list.status, 200, JSON.stringify(list.body));
      const row = list.body.find((x) => x._id === String(v._id));
      assert.ok(row, "the visit is listed");
      assert.strictEqual(row.linkedJustNow, true);
      assert.strictEqual(row.upgrade.freeVisit, true);
      const b = await Booking.findById(v._id);
      assert.strictEqual(String(b.user), String(u._id));
      assert.strictEqual(b.freeVisitIdentity.linkedVia, "my_visits");
      assert.ok(b.freeVisitIdentity.linkedAt);
      const again = await call("GET", "/api/bookings", { as: u });
      assert.strictEqual(again.body.find((x) => x._id === String(v._id)).linkedJustNow, undefined, "said once");
      assert.strictEqual((await call("GET", `/api/visit-upgrade/${v._id}`, { as: u })).status, 200, "and it can be upgraded");
    });
    await check("My Visits never links past another account's email, a shared handset, or an unproved contact", async () => {
      await customer({ email: "email.owner@mailbox.test" });
      const byPhone = await customer({ email: "phone.holder@mailbox.test" });
      const theirs = await guestVisit({ date: openDay(69), time: "08:00", phone: byPhone.phone, email: "email.owner@mailbox.test" });
      const shared = await customer({ email: "shared.one@mailbox.test" });
      await customer({ email: "shared.two@mailbox.test", phone: shared.phone });
      const household = await guestVisit({ date: openDay(69), time: "10:00", phone: shared.phone, email: "nobody.yet@mailbox.test" });
      const unproved = await customer({ email: "not.proved@mailbox.test", phoneVerifiedAt: null });
      const unprovedVisit = await guestVisit({ date: openDay(69), time: "13:00", phone: unproved.phone, email: "other.mail@mailbox.test" });
      for (const [u, v] of [[byPhone, theirs], [shared, household], [unproved, unprovedVisit]]) {
        const list = await call("GET", "/api/bookings", { as: u });
        assert.strictEqual(list.status, 200);
        assert.ok(!list.body.some((x) => x._id === String(v._id)), `${u.email} does not see it`);
        assert.strictEqual((await Booking.findById(v._id)).user, null, "left for Admin");
        assert.strictEqual((await call("GET", `/api/visit-upgrade/${v._id}`, { as: u })).status, 404);
      }
    });

    /* ================================================================== */
    console.log("\nComing back from Stripe: the payment's state is verified, never assumed");
    const paymentState = (v, u) => call("GET", `/api/visit-upgrade/${v._id}/payment`, { as: u });
    await check("back without paying: 'unpaid', and the page still open is offered again (the same page)", async () => {
      const u = await customer({ email: "una.unpaid@mailbox.test" });
      const v = await onlineVisit(u, openDay(70), "08:00");
      const opts = (await upgradeOptions(v, u)).body;
      assert.strictEqual((await upgrade(v, u, accepted(opts, { kind: "one_time" }))).status, 200);
      const page = lastSession();
      let st = await paymentState(v, u);
      assert.strictEqual(st.status, 200, JSON.stringify(st.body));
      assert.strictEqual(st.body.state, "unpaid");
      assert.strictEqual(st.body.openPage, true);
      const before = fake.created.length;
      const again = await upgrade(v, u, accepted(opts, { kind: "one_time" }));
      assert.strictEqual(again.body.url, page.url, "Continue reuses the open page");
      assert.strictEqual(fake.created.length, before);
      fake.sessions.get(page.id).status = "expired";
      st = await paymentState(v, u);
      assert.strictEqual(st.body.state, "unpaid");
      assert.strictEqual(st.body.openPage, false);
    });
    await check("paid, webhook not here yet: 'processing', and no second page can be opened by anyone", async () => {
      const u = await customer({ email: "pat.paid@mailbox.test" });
      const v = await onlineVisit(u, openDay(70), "10:00");
      const opts = (await upgradeOptions(v, u)).body;
      await upgrade(v, u, accepted(opts, { kind: "one_time" }));
      const page = lastSession();
      Object.assign(fake.sessions.get(page.id), { status: "complete", payment_status: "paid" });
      const st = await paymentState(v, u);
      assert.strictEqual(st.body.state, "processing", JSON.stringify(st.body));
      assert.strictEqual(st.body.stripeConfirmed, true);
      const before = fake.created.length;
      const same = await upgrade(v, u, accepted(opts, { kind: "one_time" }));
      assert.ok([409, 410].includes(same.status), JSON.stringify(same.body));
      const other = await upgrade(v, u, accepted(opts, { kind: "membership", plan: "basic", billingCycle: "monthly" }));
      assert.strictEqual(other.status, 409, JSON.stringify(other.body));
      assert.strictEqual(other.body.code, "CONVERSION_IN_PROGRESS");
      const link = await makeLink(v, { kind: "one_time" });
      assert.strictEqual(link.status, 409, JSON.stringify(link.body));
      assert.strictEqual(link.body.code, "CONVERSION_IN_PROGRESS");
      const live = await FreeVisitConversion.findOne({ booking: v._id, status: "open" });
      const withdraw = await call("POST", `/api/admin/free-visit-conversions/bookings/${v._id}/${live._id}/cancel`, { as: owner, body: { reason: "test" } });
      assert.strictEqual(withdraw.status, 409, JSON.stringify(withdraw.body));
      assert.strictEqual(fake.created.length, before, "no second Stripe page");
      assert.strictEqual((await FreeVisitConversion.findById(live._id)).status, "open", "nothing withdrawn");
      /* The webhook arrives late, twice: converted once. */
      const evt = `evt_late_${page.id}`;
      assert.strictEqual(await deliverWithId(evt, "checkout.session.completed", paidOneTime(fake.sessions.get(page.id))), 200);
      assert.strictEqual(await deliverWithId(evt, "checkout.session.completed", paidOneTime(fake.sessions.get(page.id))), 200);
      assert.strictEqual(await deliver("checkout.session.completed", paidOneTime(fake.sessions.get(page.id))), 200);
      const done = await paymentState(v, u);
      assert.strictEqual(done.body.state, "converted");
      assert.strictEqual(done.body.approvalPending, true, "an online free visit waits for the owner's approval");
      assert.strictEqual(keyed("visit_converted").filter((m) => m.to === "pat.paid@mailbox.test").length, 1, "one confirmation");
      assert.strictEqual((await Booking.findById(v._id)).bookingNumber, v.bookingNumber);
    });
    await check("Stripe unreachable: 'unknown', never 'unpaid'; a payment not cleared yet: 'pending'", async () => {
      const u = await customer({ email: "ursula.unknown@mailbox.test" });
      const v = await onlineVisit(u, openDay(71), "08:00");
      const opts = (await upgradeOptions(v, u)).body;
      await upgrade(v, u, accepted(opts, { kind: "one_time" }));
      const page = lastSession();
      const realRetrieve = stripe.checkout.sessions.retrieve;
      stripe.checkout.sessions.retrieve = async () => {
        throw new Error("Stripe is unreachable");
      };
      try {
        assert.strictEqual((await paymentState(v, u)).body.state, "unknown");
      } finally {
        stripe.checkout.sessions.retrieve = realRetrieve;
      }
      Object.assign(fake.sessions.get(page.id), { status: "complete", payment_status: "unpaid" });
      assert.strictEqual((await paymentState(v, u)).body.state, "pending");
    });
    await check("a payment that needs attention says so; another account's visit is not found", async () => {
      const u = await customer({ email: "ada.attention@mailbox.test" });
      const v = await onlineVisit(u, openDay(71), "10:00");
      const opts = (await upgradeOptions(v, u)).body;
      await upgrade(v, u, accepted(opts, { kind: "one_time" }));
      await FreeVisitConversion.updateOne({ booking: v._id, status: "open" }, { $set: { status: "needs_attention" } });
      assert.strictEqual((await paymentState(v, u)).body.state, "attention");
      const stranger = await customer({ email: "nosy.neighbour@mailbox.test" });
      assert.strictEqual((await paymentState(v, stranger)).status, 404);
    });

    /* ================================================================== */
    console.log("\nDeclining a visit after it was paid: nothing is refunded or canceled by itself");
    const cancelJob = async (v) => {
      const b = await Booking.findById(v._id);
      return call("POST", `/api/admin/jobs/${v._id}/transition`, {
        as: owner,
        body: { action: "cancel", expectedStatus: b.status, reason: "Declined: outside what we do", idempotencyKey: require("crypto").randomUUID() },
      });
    };
    const resolve = (v, convId, body) => call("POST", `/api/admin/free-visit-conversions/bookings/${v._id}/${convId}/resolve`, { as: owner, body });
    await check("One-Time: the cancel says it was paid and not refunded; it waits in Needs action until a Stripe refund is recorded", async () => {
      const u = await customer({ email: "oscar.onetime@mailbox.test" });
      const v = await onlineVisit(u, openDay(72), "08:00");
      const opts = (await upgradeOptions(v, u)).body;
      await upgrade(v, u, accepted(opts, { kind: "one_time" }));
      await deliver("checkout.session.completed", paidOneTime(lastSession()));
      const conv = await FreeVisitConversion.findOne({ booking: v._id, status: "converted" });
      assert.ok(conv);
      const canceled = await cancelJob(v);
      assert.strictEqual(canceled.status, 200, JSON.stringify(canceled.body));
      assert.strictEqual(canceled.body.conversionPayment.kind, "one_time");
      assert.strictEqual(canceled.body.conversionPayment.amountCents, 9900);
      assert.match(canceled.body.conversionPayment.message, /did not refund/);
      assert.strictEqual((await Booking.findById(v._id)).status, "Canceled");
      assert.ok((await FreeVisitConversion.findById(conv._id)).afterCancel.at);
      const { collectNeedsAction } = require("../utils/needsAction");
      const listed = async () =>
        (await collectNeedsAction({ accessUser: await User.findById(owner._id) })).sections.find((x) => x.key === "visit_conversions")?.items.find((i) => i.href === `/admin/jobs/${v._id}`);
      assert.strictEqual((await listed())?.kind, "conversion_canceled_after_payment");
      const job = await call("GET", `/api/admin/free-visit-conversions/bookings/${v._id}/${conv._id}/payment`, { as: owner });
      assert.strictEqual(job.status, 200, JSON.stringify(job.body));
      assert.strictEqual(job.body.followUp, "after_cancel");
      assert.strictEqual(job.body.facts.oneTime.refund, "none");
      assert.match(job.body.facts.oneTime.paymentUrl, /dashboard\.stripe\.com\/(test\/)?payments\/pi_/);
      assert.strictEqual((await resolve(v, conv._id, { resolution: "refunded", reason: "Refunded" })).body.code, "NOT_REFUNDED");
      assert.strictEqual((await resolve(v, conv._id, { resolution: "membership_canceled", reason: "x y z" })).body.code, "RESOLUTION_REQUIRED");
      const realPi = stripe.paymentIntents.retrieve;
      stripe.paymentIntents.retrieve = async () => {
        throw new Error("Stripe is unreachable");
      };
      try {
        const down = await resolve(v, conv._id, { resolution: "kept", reason: "Customer will rebook with us" });
        assert.strictEqual(down.status, 503, "Stripe could not be asked: nothing recorded");
      } finally {
        stripe.paymentIntents.retrieve = realPi;
      }
      assert.ok(await listed(), "still waiting");
      fake.refunds.set(conv.payment.paymentIntentId, 9900);
      const ok = await resolve(v, conv._id, { resolution: "refunded", reason: "Refunded in full" });
      assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
      assert.strictEqual(ok.body.conversion.resolution.kind, "refunded");
      assert.strictEqual(ok.body.conversion.followUp, null);
      assert.ok(!(await listed()), "off Needs action");
      assert.deepStrictEqual(fake.forbidden, []);
    });
    await check("Membership: the cancel says the subscription still bills; 'canceled' is refused until Stripe shows it ends", async () => {
      const u = await customer({ email: "mona.member@mailbox.test" });
      const v = await onlineVisit(u, openDay(73), "08:00");
      const opts = (await upgradeOptions(v, u)).body;
      const started = await upgrade(v, u, accepted(opts, { kind: "membership", plan: "basic", billingCycle: "monthly" }));
      assert.strictEqual(started.status, 200, JSON.stringify(started.body));
      const page = lastSession();
      assert.strictEqual(await deliver("checkout.session.completed", paidMembership(page, u)), 200);
      const conv = await FreeVisitConversion.findOne({ booking: v._id, status: "converted" });
      assert.ok(conv, "converted");
      const canceled = await cancelJob(v);
      assert.strictEqual(canceled.status, 200, JSON.stringify(canceled.body));
      const cp = canceled.body.conversionPayment;
      assert.strictEqual(cp.kind, "membership");
      assert.strictEqual(cp.membership.billsAgain, true);
      assert.strictEqual(cp.membership.status, "active");
      assert.match(cp.message, /did not cancel the membership/);
      assert.match(cp.message, /refund in Stripe alone does not stop future payments/i);
      assert.strictEqual(fake.subs.get(`sub_${page.id}`).status, "active", "the subscription is untouched");
      const stillBilling = await resolve(v, conv._id, { resolution: "membership_canceled", firstPaymentRefunded: true, reason: "Refunded the first month" });
      assert.strictEqual(stillBilling.status, 409, JSON.stringify(stillBilling.body));
      assert.strictEqual(stillBilling.body.code, "MEMBERSHIP_STILL_BILLING");
      assert.match(stillBilling.body.message, /A refund alone does not stop the next payment/);
      fake.subs.get(`sub_${page.id}`).cancel_at_period_end = true;
      const noAnswer = await resolve(v, conv._id, { resolution: "membership_canceled", reason: "Canceled on the profile" });
      assert.strictEqual(noAnswer.body.code, "REFUND_ANSWER_REQUIRED");
      const kept = await resolve(v, conv._id, { resolution: "membership_kept", reason: "They stay a member" });
      assert.strictEqual(kept.body.code, "MEMBERSHIP_NOT_ACTIVE", "an ending membership is not 'kept'");
      const ok = await resolve(v, conv._id, { resolution: "membership_canceled", firstPaymentRefunded: false, reason: "Canceled at period end, no refund" });
      assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
      assert.strictEqual(ok.body.conversion.resolution.firstPaymentRefunded, false);
      assert.strictEqual(ok.body.conversion.resolution.verified.billsAgain, false);
      assert.deepStrictEqual(fake.forbidden, [], "nothing canceled or refunded by the code");
    });
    await check("a converted visit canceled and then reinstated needs no payment decision", async () => {
      const u = await customer({ email: "rita.reinstated@mailbox.test" });
      const v = await onlineVisit(u, openDay(74), "08:00");
      const opts = (await upgradeOptions(v, u)).body;
      await upgrade(v, u, accepted(opts, { kind: "one_time" }));
      await deliver("checkout.session.completed", paidOneTime(lastSession()));
      assert.strictEqual((await cancelJob(v)).status, 200);
      const back = await call("POST", `/api/admin/jobs/${v._id}/transition`, {
        as: owner,
        body: { action: "reinstate", expectedStatus: "Canceled", targetStatus: "Pending", idempotencyKey: require("crypto").randomUUID() },
      });
      assert.strictEqual(back.status, 200, JSON.stringify(back.body));
      const conv = await FreeVisitConversion.findOne({ booking: v._id, status: "converted" });
      assert.ok(conv.afterCancel.resolvedAt);
      assert.strictEqual(conv.resolution.kind, "visit_reinstated");
    });
  } finally {
    server.close();
    await mongoose.disconnect();
    await replSet.stop();
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
