/*
 * Paid-visit checkout settlement (utils/paidVisitSettlement, 2026-11-19),
 * end to end against a real database: in-memory replica set, reservation
 * engine ON as in production, the real routes and the real webhook. Stripe is
 * a fake that records sessions; webhook events are signed with the test
 * secret, so the real signature check, event claim and dispatch all run.
 * Nothing here reaches Stripe, S3, email, SMS or Meta.
 *
 *   node scripts/test_paid_visit_settlement.js
 *
 * Pins:
 *  - a declined card keeps the booking and its held time while the page is
 *    open, and a second card pays for that same booking (One-Time and Full Day);
 *  - the page ends before the hold (a short grace for a last-second payment);
 *  - the same payment delivered twice, at once or as its async twin, is
 *    recorded once and announced once;
 *  - a delayed payment waits for async_payment_succeeded; async failure ends it;
 *  - abandon and page expiry release the time;
 *  - the hold sweep asks Stripe: paid -> recorded (not canceled), open ->
 *    closed then released, unreachable -> deferred, expired -> released;
 *  - a paid page with no booking tells the owner instead of only logging.
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-paid-visit-settlement";
process.env.STRIPE_SECRET_KEY = "sk_test_fake_for_unit_tests";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_settlement";
process.env.CLIENT_URL = "https://www.profixter.com";
process.env.SMS_ENABLED = "false";
process.env.S3_BUCKET = "test-bucket";
process.env.ENABLE_RESERVATION_ENGINE = "true";
process.env.STRIPE_PRICE_ONE_TIME_HANDYMAN_VISIT = "price_test_one_time";
process.env.STRIPE_PRICE_FULL_DAY_VISIT = "price_test_full_day";
process.env.MAIL_ADMIN = "owner@example.test";
delete process.env.META_CAPI_TOKEN;

const assert = require("assert");
const express = require("express");
const moment = require("moment-timezone");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const TZ = "America/New_York";
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
function openDay(n) {
  const d = moment.tz(TZ).startOf("day").add(3, "days");
  let found = -1;
  for (;;) {
    if (d.day() !== 0) found += 1;
    if (found === n) return d.format("YYYY-MM-DD");
    d.add(1, "day");
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(replSet.getUri());

  const s3 = require("../utils/s3");
  s3.putPublicObject = async ({ Key }) => `https://test-bucket.s3.amazonaws.com/${Key}`;
  s3.deletePublicObjects = async () => ({ deleted: 0 });
  const mail = require("../utils/emailService");
  const emails = [];
  mail.sendRaw = async (msg) => (emails.push({ kind: "raw", ...msg }), { ok: true });
  mail.sendTx = async (key, to, data) => (emails.push({ kind: "tx", key, to, data }), { ok: true });
  mail.sendPromo = async (to, msg) => (emails.push({ kind: "promo", to, ...msg }), { ok: true });
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    const u = String(url);
    if (!u.startsWith("http://127.0.0.1")) throw new Error(`blocked outside request: ${u}`);
    return realFetch(url, init);
  };

  const stripe = require("../utils/subscriptionManagement").stripe;
  const sessions = new Map();
  let retrieveFails = false;
  const expireCalls = [];
  stripe.customers.list = async () => ({ data: [] });
  stripe.checkout.sessions.create = async (config) => {
    const id = `cs_test_settle${sessions.size + 1}abc`;
    const s = { id, object: "checkout.session", mode: "payment", status: "open", payment_status: "unpaid", url: `https://checkout.stripe.test/${id}`, metadata: config.metadata, client_reference_id: config.client_reference_id, config, customer: null, amount_total: config.line_items[0].price === "price_test_full_day" ? 49900 : 9900, currency: "usd", payment_intent: `pi_${id}` };
    sessions.set(id, s);
    return s;
  };
  stripe.checkout.sessions.retrieve = async (id) => {
    if (retrieveFails) throw new Error("Stripe unreachable (test)");
    if (!sessions.has(id)) throw Object.assign(new Error("No such session"), { statusCode: 404 });
    return { ...sessions.get(id) };
  };
  stripe.checkout.sessions.expire = async (id) => {
    expireCalls.push(id);
    sessions.get(id).status = "expired";
    return sessions.get(id);
  };

  const Booking = require("../models/Booking");
  const BookingSlotReservation = require("../models/BookingSlotReservation");
  const ReservationTimeBucket = require("../models/ReservationTimeBucket");
  const ReservationCapacityBucket = require("../models/ReservationCapacityBucket");
  const CompanyAvailabilityTemplate = require("../models/CompanyAvailabilityTemplate");
  const SmsMessage = require("../models/SmsMessage");
  const User = require("../models/User");
  const StripeWebhookEvent = require("../models/StripeWebhookEvent");
  const { ensureVisitEntitlementIndexes } = require("../utils/visitEntitlementIndexSafety");
  const { _reset: resetRateLimits } = require("../utils/rateLimit");
  for (const M of [Booking, BookingSlotReservation, ReservationTimeBucket, ReservationCapacityBucket, SmsMessage, User, StripeWebhookEvent]) await M.init();
  await ensureVisitEntitlementIndexes({ logger: { log() {}, warn() {} } });

  for (const n of [1, 2]) {
    await User.create({ name: `Fixter ${n}`, email: `f${n}@fixter.local`, password: "x", phone: "+15550002222", userId: `8100000${n}`, role: "employee", employeePosition: "Fixter", isActive: true });
  }
  await CompanyAvailabilityTemplate.create({
    active: true, timezone: TZ, slotMinutes: 30, minLeadMinutes: 0, maxAdvanceDays: 120, defaultCapacity: 1, visitDurationMinutes: 90,
    weeklySchedule: Array.from({ length: 7 }, (_, weekday) => ({ weekday, enabled: weekday !== 0, starts: ["08:00", "10:00", "13:00", "15:00"].map((time) => ({ time, capacity: null })), intervals: [{ startTime: "08:00", endTime: "17:00", capacity: null }] })),
  });

  const app = express();
  app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), require("../routes/webhook"));
  app.use(express.json());
  app.use("/api/bookings/guest", require("../routes/guestBookings"));
  app.use("/api/bookings", require("../routes/bookings"));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, { form, body } = {}) => {
    const headers = {};
    let payload;
    if (form) payload = form;
    else if (body) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${base}${p}`, { method, headers, body: payload });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const { GUEST_CHECKOUT_CONSENT_TEXT } = require("../routes/guestBookings");
  const formOf = (fields) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) form.append(k, String(v));
    return form;
  };
  let press = 0;
  const guest = (extra = {}) => {
    press += 1;
    return {
      name: "Sam Rivera",
      phone: `(516) 555-${String(1000 + press).slice(-4)}`,
      email: `sam${press}@mailbox.org`,
      line1: "12 Elm St",
      city: "Massapequa",
      state: "NY",
      zip: "11758",
      note: "Fix the sticking back door",
      selectedTask: "Door repair",
      consentText: GUEST_CHECKOUT_CONSENT_TEXT,
      clientRequestId: `press-settle-${String(press).padStart(4, "0")}`,
      ...extra,
    };
  };
  const hook = async (type, object) => {
    const payload = JSON.stringify({ id: `evt_${Math.random().toString(16).slice(2)}`, object: "event", type, data: { object } });
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
    const res = await fetch(`${base}/api/stripe/webhook`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": header }, body: payload });
    return res.status;
  };
  const sessionOf = (r) => sessions.get(r.body.url.split("/").pop());
  const pay = (s) => Object.assign(s, { status: "complete", payment_status: "paid" });
  const declineEvent = (s) => ({ id: `pi_${s.id}`, object: "payment_intent", status: "requires_payment_method", metadata: { ...s.config.payment_intent_data.metadata }, last_payment_error: { code: "card_declined" } });
  const paidAdminMails = (bookingNumber) => emails.filter((e) => e.kind === "raw" && /paid/i.test(e.subject || "") && (e.text || "").includes(bookingNumber));
  const slots = { n: 0 };
  const oneTime = async (extra = {}) => {
    resetRateLimits?.();
    const day = openDay(1 + Math.floor(slots.n / 4));
    const time = ["08:00", "10:00", "13:00", "15:00"][slots.n % 4];
    slots.n += 1;
    const r = await call("POST", "/api/bookings/guest/one-time/checkout", { form: formOf(guest({ requestedDate: day, requestedTime: time, ...extra })) });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    return { r, day, time, s: sessionOf(r) };
  };
  const reservationOf = (bookingId) => BookingSlotReservation.findOne({ bookingId }).sort({ createdAt: -1 }).lean();
  const { expireOneTimeVisitHolds } = require("../jobs/oneTimeVisitHolds");
  const lapse = async (bookingId) => {
    const past = new Date(Date.now() - 60 * 1000);
    await Booking.updateOne({ _id: bookingId }, { $set: { paymentHoldExpiresAt: past } });
  };

  try {
    console.log("\nThe page ends before the hold");
    await check("Stripe's page expires 10 minutes before the held time does", async () => {
      const { r, s } = await oneTime();
      const b = await Booking.findById(r.body.bookingId).lean();
      const holdSec = Math.floor(new Date(b.paymentHoldExpiresAt).getTime() / 1000);
      assert.strictEqual(holdSec - s.config.expires_at, 600);
      assert.ok(s.config.expires_at - Date.now() / 1000 >= 29.9 * 60, "Stripe's 30-minute minimum is kept");
      const reservation = await reservationOf(r.body.bookingId);
      assert.strictEqual(Math.floor(new Date(reservation.holdExpiresAt).getTime() / 1000), holdSec, "the reservation is held as long as the booking");
    });

    await check("the welcome entry's guest checkout returns to /start if canceled and keeps its browser id", async () => {
      const { r, s } = await oneTime({ returnTo: "welcome", visitorId: "v_welcomebrowser0001" });
      assert.ok(s.config.cancel_url.startsWith("https://www.profixter.com/start?canceled=1&booking_id="), s.config.cancel_url);
      assert.ok(s.config.success_url.includes("/book/confirmation"), "the same confirmation page");
      const b = await Booking.findById(r.body.bookingId).lean();
      assert.strictEqual(b.siteVisitorId, "v_welcomebrowser0001");
    });
    await check("everyone else still returns to Book a Handyman", async () => {
      const { s } = await oneTime();
      assert.ok(s.config.cancel_url.includes("/book/handyman?canceled=1"), s.config.cancel_url);
    });

    console.log("\nA declined card, then a good one (One-Time)");
    let retry;
    await check("a decline keeps the booking Pending and the time held", async () => {
      retry = await oneTime();
      assert.strictEqual(await hook("payment_intent.payment_failed", declineEvent(retry.s)), 200);
      const b = await Booking.findById(retry.r.body.bookingId).lean();
      assert.deepStrictEqual([b.status, b.paymentState, b.paymentStatus], ["Pending", "pending", "Pending"]);
      assert.strictEqual(b.paymentSettlement.declinedCount, 1);
      assert.strictEqual((await reservationOf(retry.r.body.bookingId)).status, "held");
    });
    await check("a second decline is counted too, still nothing released", async () => {
      assert.strictEqual(await hook("payment_intent.payment_failed", declineEvent(retry.s)), 200);
      const b = await Booking.findById(retry.r.body.bookingId).lean();
      assert.strictEqual(b.paymentSettlement.declinedCount, 2);
      assert.strictEqual((await reservationOf(retry.r.body.bookingId)).status, "held");
    });
    await check("nobody else can take the held time meanwhile", async () => {
      resetRateLimits?.();
      const other = await call("POST", "/api/bookings/guest/one-time/checkout", { form: formOf(guest({ requestedDate: retry.day, requestedTime: retry.time })) });
      assert.strictEqual(other.status, 409, JSON.stringify(other.body));
    });
    await check("the good card pays for that same booking: paid, owner review, reservation kept", async () => {
      pay(retry.s);
      assert.strictEqual(await hook("checkout.session.completed", retry.s), 200);
      const b = await Booking.findById(retry.r.body.bookingId).lean();
      assert.deepStrictEqual([b.status, b.paymentState, b.paymentStatus], ["Pending", "paid", "Paid"]);
      assert.strictEqual((await reservationOf(retry.r.body.bookingId)).status, "reserved");
    });

    console.log("\nThe same payment, more than once");
    await check("a replay (new event id) and the async twin record nothing twice", async () => {
      const b = await Booking.findById(retry.r.body.bookingId).lean();
      await wait(300);
      const before = paidAdminMails(b.bookingNumber).length;
      assert.strictEqual(before, 1, `one paid notice so far (${before})`);
      assert.strictEqual(await hook("checkout.session.completed", retry.s), 200);
      assert.strictEqual(await hook("checkout.session.async_payment_succeeded", retry.s), 200);
      await wait(300);
      assert.strictEqual(paidAdminMails(b.bookingNumber).length, 1, "still one paid notice");
    });
    await check("two deliveries at the same moment: one records it, the other is retried and finds it done", async () => {
      const { r, s } = await oneTime();
      pay(s);
      const statuses = await Promise.all([hook("checkout.session.completed", s), hook("checkout.session.completed", s)]);
      assert.ok(statuses.includes(200), statuses.join(","));
      assert.ok(statuses.every((x) => x === 200 || x === 500), statuses.join(","));
      if (statuses.includes(500)) assert.strictEqual(await hook("checkout.session.completed", s), 200, "Stripe's retry succeeds");
      const b = await Booking.findById(r.body.bookingId).lean();
      assert.strictEqual(b.paymentState, "paid");
      await wait(300);
      assert.strictEqual(paidAdminMails(b.bookingNumber).length, 1);
    });

    console.log("\nDelayed confirmation");
    await check("complete but unpaid waits; async success then records it", async () => {
      const { r, s } = await oneTime();
      Object.assign(s, { status: "complete", payment_status: "unpaid" });
      assert.strictEqual(await hook("checkout.session.completed", s), 200);
      let b = await Booking.findById(r.body.bookingId).lean();
      assert.deepStrictEqual([b.status, b.paymentState], ["Pending", "pending"]);
      assert.strictEqual((await reservationOf(r.body.bookingId)).status, "held");
      s.payment_status = "paid";
      assert.strictEqual(await hook("checkout.session.async_payment_succeeded", s), 200);
      b = await Booking.findById(r.body.bookingId).lean();
      assert.strictEqual(b.paymentState, "paid");
    });
    await check("async failure ends it and gives the time back", async () => {
      const { r, s } = await oneTime();
      Object.assign(s, { status: "complete", payment_status: "unpaid" });
      assert.strictEqual(await hook("checkout.session.async_payment_failed", s), 200);
      const b = await Booking.findById(r.body.bookingId).lean();
      assert.deepStrictEqual([b.status, b.paymentState, b.paymentStatus], ["Canceled", "failed", "Failed"]);
      assert.strictEqual((await reservationOf(r.body.bookingId)).status, "released");
    });

    console.log("\nAbandoned and expired");
    await check("back from Stripe with cancel: the page is closed and the time released", async () => {
      const { r, s } = await oneTime();
      const clientRequestId = s.config.metadata ? (await Booking.findById(r.body.bookingId).lean()).checkoutClientKey : "";
      const a = await call("POST", "/api/bookings/guest/abandon", { body: { bookingId: r.body.bookingId, clientRequestId } });
      assert.strictEqual(a.status, 200, JSON.stringify(a.body));
      assert.strictEqual(sessions.get(s.id).status, "expired");
      assert.strictEqual(await hook("checkout.session.expired", sessions.get(s.id)), 200);
      const b = await Booking.findById(r.body.bookingId).lean();
      assert.deepStrictEqual([b.status, b.paymentState], ["Canceled", "expired"]);
      assert.strictEqual((await reservationOf(r.body.bookingId)).status, "released");
    });
    await check("a page that simply expires releases the time", async () => {
      const { r, s } = await oneTime();
      s.status = "expired";
      assert.strictEqual(await hook("checkout.session.expired", s), 200);
      const b = await Booking.findById(r.body.bookingId).lean();
      assert.deepStrictEqual([b.status, b.paymentStatus], ["Canceled", "Expired"]);
    });

    console.log("\nThe hold sweep asks Stripe first");
    await check("paid at Stripe, webhook never arrived: the sweep records the payment instead of canceling", async () => {
      const { r, s } = await oneTime();
      pay(s);
      await lapse(r.body.bookingId);
      await expireOneTimeVisitHolds(new Date());
      const b = await Booking.findById(r.body.bookingId).lean();
      assert.deepStrictEqual([b.status, b.paymentState], ["Pending", "paid"]);
      await wait(300);
      assert.strictEqual(paidAdminMails(b.bookingNumber).length, 1, "announced once");
      assert.strictEqual(await hook("checkout.session.completed", s), 200, "the late webhook finds it done");
      await wait(300);
      assert.strictEqual(paidAdminMails(b.bookingNumber).length, 1, "still once");
    });
    await check("still open past the hold: closed at Stripe, then released", async () => {
      const { r, s } = await oneTime();
      await lapse(r.body.bookingId);
      await expireOneTimeVisitHolds(new Date());
      assert.ok(expireCalls.includes(s.id));
      const b = await Booking.findById(r.body.bookingId).lean();
      assert.deepStrictEqual([b.status, b.paymentState], ["Canceled", "expired"]);
    });
    await check("Stripe unreachable: the release waits for the next run", async () => {
      const { r } = await oneTime();
      await lapse(r.body.bookingId);
      retrieveFails = true;
      try {
        await expireOneTimeVisitHolds(new Date());
      } finally {
        retrieveFails = false;
      }
      const b = await Booking.findById(r.body.bookingId).lean();
      assert.deepStrictEqual([b.status, b.paymentState], ["Pending", "pending"]);
      await expireOneTimeVisitHolds(new Date());
      const after = await Booking.findById(r.body.bookingId).lean();
      assert.strictEqual(after.paymentState, "expired", "released once Stripe answers");
    });
    await check("expired at Stripe: released as before", async () => {
      const { r, s } = await oneTime();
      s.status = "expired";
      await lapse(r.body.bookingId);
      await expireOneTimeVisitHolds(new Date());
      const b = await Booking.findById(r.body.bookingId).lean();
      assert.deepStrictEqual([b.status, b.paymentState], ["Canceled", "expired"]);
      assert.strictEqual((await reservationOf(r.body.bookingId)).status, "released");
    });

    console.log("\nPaid with no booking");
    await check("a paid page whose booking is gone tells the owner", async () => {
      const ghostId = String(new mongoose.Types.ObjectId());
      const s = { id: "cs_test_ghost1abc", object: "checkout.session", mode: "payment", status: "complete", payment_status: "paid", amount_total: 9900, currency: "usd", customer_email: "ghost@mailbox.org", client_reference_id: ghostId, metadata: { productKind: "one_time_handyman_visit", bookingId: ghostId, guestCheckout: "true" } };
      assert.strictEqual(await hook("checkout.session.completed", s), 200);
      await wait(200);
      const alert = emails.find((e) => e.kind === "raw" && /no booking/i.test(e.subject || ""));
      assert.ok(alert, JSON.stringify(emails.map((e) => e.subject)));
      assert.ok((alert.text || "").includes("cs_test_ghost1abc"));
    });
    await check("a paid page with no booking id at all tells the owner too", async () => {
      const before = emails.filter((e) => /no booking/i.test(e.subject || "")).length;
      const s = { id: "cs_test_ghost2abc", object: "checkout.session", mode: "payment", status: "complete", payment_status: "paid", amount_total: 49900, currency: "usd", metadata: { productKind: "full_day_visit" } };
      assert.strictEqual(await hook("checkout.session.completed", s), 200);
      await wait(200);
      assert.strictEqual(emails.filter((e) => /no booking/i.test(e.subject || "")).length, before + 1);
    });

    console.log("\nFull Day: a declined card, then a good one");
    await check("the day stays held through a decline and the second card pays for it", async () => {
      resetRateLimits?.();
      let date = null;
      for (let n = 8; n < 30 && !date; n++) {
        const d = openDay(n);
        const av = await call("GET", `/api/bookings/full-day/availability?from=${d}&to=${d}`);
        if (av.body?.days?.[0]?.available) date = d;
      }
      assert.ok(date, "an available Full Day in the harness");
      const r = await call("POST", "/api/bookings/guest/full-day/checkout", { form: formOf(guest({ date, note: "Hang shelves, fix two doors and patch the hall" })) });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      const s = sessionOf(r);
      assert.strictEqual(await hook("payment_intent.payment_failed", declineEvent(s)), 200);
      let b = await Booking.findById(r.body.bookingId).lean();
      assert.deepStrictEqual([b.status, b.paymentState, b.paymentSettlement.declinedCount], ["Pending", "pending", 1]);
      const held = await BookingSlotReservation.find({ bookingId: r.body.bookingId }).lean();
      assert.ok(held.length && held.every((x) => x.status === "held"), `the day stays held (${held.map((x) => x.status)})`);
      pay(s);
      assert.strictEqual(await hook("checkout.session.completed", s), 200);
      b = await Booking.findById(r.body.bookingId).lean();
      assert.deepStrictEqual([b.status, b.paymentState, b.bookingType], ["Pending", "paid", "full_day_visit"]);
    });
  } finally {
    server.close();
    global.fetch = realFetch;
    await mongoose.disconnect();
    await replSet.stop();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
