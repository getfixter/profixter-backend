/*
 * Book first, then buy the membership (2026-11-03), end to end against a real
 * database (in-memory replica set, reservation engine ON as in production).
 *
 *  - Holds: a sign-in hold lasts 30 minutes; the membership checkout extends it
 *    over the Stripe page (31 minutes, Stripe's minimum is 30) plus grace, opens
 *    the page with that expiry and tags the hold with it.
 *  - A time that is gone (taken, or passed) refuses the checkout: nobody pays
 *    for a visit we cannot keep. Re-pressing reuses the hold, never a second one.
 *  - checkout.session.expired frees only the hold of the page that expired;
 *    an older page's expiry leaves the hold a newer page owns.
 *  - The exemption: granted only when the buyer had no live membership, stamped
 *    once by the subscription sync (replays do not re-grant), lets the first
 *    booking take a time inside the member seven days, is spent by it, cannot
 *    be spent twice at once, is handed back when the booking fails, and lapses
 *    after 30 days. An existing member's normal booking keeps the seven days.
 *  - /api/auth/me: firstVisitExempt per home; phoneRequired for new
 *    email/Google/Apple accounts without a verified phone, never for older ones.
 *
 * Stripe, S3 and email are faked; SMS is rendered and recorded, never sent.
 *
 *   node scripts/test_membership_first_visit.js
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-first-visit";
process.env.STRIPE_SECRET_KEY = "sk_test_fake_for_unit_tests";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_first_visit";
process.env.CLIENT_URL = "https://www.profixter.com";
process.env.SMS_ENABLED = "false";
process.env.S3_BUCKET = "test-bucket";
process.env.ENABLE_RESERVATION_ENGINE = "true";
process.env.MAIL_ADMIN = "owner@example.test";

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
    console.log(`FAIL  ${name}\n      ${error.stack?.split("\n").slice(0, 3).join("\n      ") || error.message}`);
  }
}
/* The n-th open day (Sundays are closed in the template below), counted from tomorrow. */
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

async function main() {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(replSet.getUri());

  const s3 = require("../utils/s3");
  s3.putPublicObject = async ({ Key }) => `https://test-bucket.s3.amazonaws.com/${Key}`;
  s3.deletePublicObjects = async () => ({ deleted: 0 });
  const mail = require("../utils/emailService");
  mail.sendRaw = async () => ({ ok: true });
  mail.sendTx = async () => ({ ok: true });
  mail.sendPromo = async () => ({ ok: true });
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
    const session = { id, status: "open", mode: "subscription", customer: config.customer || null, metadata: config.metadata, url: `https://checkout.stripe.test/${id}`, config };
    fake.sessions.set(id, session);
    fake.created.push(session);
    return session;
  };
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
  const BookingSlotReservation = require("../models/BookingSlotReservation");
  const ReservationTimeBucket = require("../models/ReservationTimeBucket");
  const ReservationCapacityBucket = require("../models/ReservationCapacityBucket");
  const CompanyAvailabilityTemplate = require("../models/CompanyAvailabilityTemplate");
  const SmsMessage = require("../models/SmsMessage");
  const StripeWebhookEvent = require("../models/StripeWebhookEvent");
  const Subscription = require("../models/Subscription");
  const User = require("../models/User");
  const { ensureVisitEntitlementIndexes } = require("../utils/visitEntitlementIndexSafety");
  for (const M of [Booking, BookingSlotReservation, ReservationTimeBucket, ReservationCapacityBucket, SmsMessage, StripeWebhookEvent, Subscription, User]) await M.init();
  await ensureVisitEntitlementIndexes({ logger: { log() {}, warn() {} } });

  // One Fixter, one seat per start: a taken time is really taken.
  await User.create({ name: "Fixter 1", email: "f1@fixter.local", password: "x", phone: "+15550002222", userId: "80000001", role: "employee", employeePosition: "Fixter", isActive: true });
  await CompanyAvailabilityTemplate.create({
    active: true, timezone: TZ, slotMinutes: 30, minLeadMinutes: 0, maxAdvanceDays: 120, defaultCapacity: 1, visitDurationMinutes: 90,
    weeklySchedule: Array.from({ length: 7 }, (_, weekday) => ({ weekday, enabled: weekday !== 0, starts: ["08:00", "10:00", "13:00"].map((time) => ({ time, capacity: null })), intervals: [{ startTime: "08:00", endTime: "16:00", capacity: null }] })),
  });

  const app = express();
  app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), require("../routes/webhook"));
  app.use(express.json());
  app.use("/api/auth", require("../routes/auth"));
  app.use("/api/stripe/checkout", require("../routes/stripe"));
  app.use("/api/bookings", require("../routes/bookings"));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, { body, form, as } = {}) => {
    const headers = as ? { authorization: `Bearer ${jwt.sign({ id: String(as._id), tv: 0 }, process.env.JWT_SECRET)}` } : {};
    let payload;
    if (form) payload = form;
    else if (body) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${base}${p}`, { method, headers, body: payload });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  let eventSeq = 0;
  const deliver = async (type, object) => {
    const payload = JSON.stringify({ id: `evt_fv_${++eventSeq}`, object: "event", type, data: { object } });
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
    const res = await fetch(`${base}/api/stripe/webhook`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": header }, body: payload });
    return res.status;
  };
  let seq = 0;
  const customer = (over = {}) => {
    seq += 1;
    return User.create({
      userId: `4100${String(seq).padStart(4, "0")}`,
      name: `Dana Lopez ${seq}`,
      email: `dana${seq}@mailbox.test`,
      phone: `+1516555${String(1000 + seq)}`,
      phoneVerifiedAt: new Date(),
      role: "customer",
      stripeCustomerId: `cus_fv_${seq}`,
      addresses: [{ label: "Primary", line1: `${10 + seq} Elm St`, city: "Farmingdale", state: "NY", zip: "11735", county: "Nassau" }],
      smsPreferences: { transactionalEnabled: true, transactionalConsentAt: new Date() },
      ...over,
    });
  };
  const memberBooking = (as, date, time, extra = {}) => {
    const form = new FormData();
    const fields = { service: "Replace an existing faucet.", note: "Replace an existing faucet.", addressId: String(as.addresses[0]._id), requestedDate: date, requestedTime: time, date: moment.tz(`${date} ${time}`, TZ).toISOString(), ...extra };
    for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
    return call("POST", "/api/bookings", { form, as });
  };
  /* Buy: the subscription Stripe would create from this checkout, synced by its webhook. */
  const buy = async (user, session) => {
    const sub = makeStripeSub({ id: `sub_${session.id}`, customer: user.stripeCustomerId, user, addressId: user.addresses[0]._id, metadata: session.config.subscription_data.metadata });
    assert.strictEqual(await deliver("customer.subscription.created", sub), 200);
    return Subscription.findOne({ stripeSubscriptionId: sub.id });
  };

  const soon = openDay(2); // inside the member seven days
  assert.ok(daysFromToday(soon) < 7);

  try {
    console.log("\nHolds");
    let dana;
    let holdToken;
    await check("a sign-in hold lasts 30 minutes", async () => {
      const res = await call("POST", "/api/bookings/hold", { body: { requestedDate: soon, requestedTime: "10:00" } });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.minutes, 30);
      const mins = (new Date(res.body.holdExpiresAt) - Date.now()) / 60000;
      assert.ok(mins > 29 && mins <= 30.1, `${mins}`);
      holdToken = res.body.token;
    });

    console.log("\nMembership checkout carries the held visit");
    let session1;
    await check("the checkout extends the hold over the Stripe page and opens the page with that expiry", async () => {
      dana = await customer();
      const res = await call("POST", "/api/stripe/checkout/create-checkout-session", {
        as: dana,
        body: { plan: "basic", billingCycle: "monthly", addressId: String(dana.addresses[0]._id), returnTo: "handyman", firstVisit: { holdToken, requestedDate: soon, requestedTime: "10:00" } },
      });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      session1 = fake.created[fake.created.length - 1];
      const pageMins = (session1.config.expires_at * 1000 - Date.now()) / 60000;
      assert.ok(pageMins > 30 && pageMins <= 31.1, `page expires in ${pageMins} min`);
      const hold = await BookingSlotReservation.findById(holdToken.split(".")[0]);
      const holdMins = (hold.holdExpiresAt - Date.now()) / 60000;
      assert.ok(holdMins > 40 && holdMins <= 41.1, `hold for ${holdMins} min`);
      assert.strictEqual(hold.checkoutSessionId, session1.id);
      assert.strictEqual(res.body.holdToken, holdToken, "the same hold, extended");
      assert.strictEqual(res.body.firstVisitExempt, true);
    });
    await check("the session and the subscription carry the first visit (exempt: no live membership)", async () => {
      for (const md of [session1.metadata, session1.config.subscription_data.metadata]) {
        assert.strictEqual(md.firstVisitExempt, "1");
        assert.strictEqual(md.firstVisitDate, soon);
        assert.strictEqual(md.firstVisitTime, "10:00");
        assert.strictEqual(md.firstVisitHoldId, holdToken.split(".")[0]);
      }
      assert.strictEqual(session1.config.success_url, "https://www.profixter.com/confirmationpage?session_id={CHECKOUT_SESSION_ID}&next=handyman");
    });
    let session2;
    await check("pressing again reuses the hold (no second hold) and re-tags it to the new page", async () => {
      const before = await BookingSlotReservation.countDocuments({ signInHold: true, status: "held" });
      const res = await call("POST", "/api/stripe/checkout/create-checkout-session", {
        as: dana,
        body: { plan: "basic", billingCycle: "monthly", addressId: String(dana.addresses[0]._id), returnTo: "handyman", firstVisit: { holdToken, requestedDate: soon, requestedTime: "10:00" } },
      });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      session2 = fake.created[fake.created.length - 1];
      assert.notStrictEqual(session2.id, session1.id);
      assert.strictEqual(await BookingSlotReservation.countDocuments({ signInHold: true, status: "held" }), before);
      assert.strictEqual((await BookingSlotReservation.findById(holdToken.split(".")[0])).checkoutSessionId, session2.id);
      assert.strictEqual(fake.sessions.get(session1.id).status, "expired", "the older page was closed");
    });
    await check("the older page's expiry does not free the hold the newer page owns", async () => {
      assert.strictEqual(await deliver("checkout.session.expired", { ...fake.sessions.get(session1.id), object: "checkout.session" }), 200);
      assert.strictEqual((await BookingSlotReservation.findById(holdToken.split(".")[0])).status, "held");
    });
    await check("another customer cannot take the held time, and their checkout for it is refused", async () => {
      const lee = await customer();
      const hold = await call("POST", "/api/bookings/hold", { body: { requestedDate: soon, requestedTime: "10:00" } });
      assert.strictEqual(hold.status, 409, "the time is held");
      const createdBefore = fake.created.length;
      const res = await call("POST", "/api/stripe/checkout/create-checkout-session", {
        as: lee,
        body: { plan: "basic", billingCycle: "monthly", addressId: String(lee.addresses[0]._id), returnTo: "handyman", firstVisit: { holdToken: "", requestedDate: soon, requestedTime: "10:00" } },
      });
      assert.strictEqual(res.status, 409, JSON.stringify(res.body));
      assert.strictEqual(res.body.code, "SLOT_UNAVAILABLE");
      assert.strictEqual(fake.created.length, createdBefore, "no Stripe page was opened");
    });
    await check("a time that has passed refuses the checkout", async () => {
      const res = await call("POST", "/api/stripe/checkout/create-checkout-session", {
        as: dana,
        body: { plan: "basic", billingCycle: "monthly", addressId: String(dana.addresses[0]._id), firstVisit: { holdToken, requestedDate: moment.tz(TZ).subtract(1, "day").format("YYYY-MM-DD"), requestedTime: "10:00" } },
      });
      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.code, "SLOT_UNAVAILABLE");
    });
    await check("a plain checkout (no first visit) is unchanged: no expiry, no first-visit metadata", async () => {
      const kim = await customer();
      const res = await call("POST", "/api/stripe/checkout/create-checkout-session", { as: kim, body: { plan: "basic", billingCycle: "monthly", addressId: String(kim.addresses[0]._id) } });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      const s = fake.created[fake.created.length - 1];
      assert.strictEqual(s.config.expires_at, undefined);
      assert.strictEqual(s.metadata.firstVisitExempt, undefined);
    });

    console.log("\nAfter payment: the first visit");
    let danaSub;
    await check("the subscription sync stamps the exemption once (a replay does not re-grant)", async () => {
      danaSub = await buy(dana, session2);
      assert.ok(danaSub?.firstVisitExemption?.grantedAt, "granted");
      const granted = danaSub.firstVisitExemption.grantedAt.getTime();
      assert.strictEqual(await deliver("customer.subscription.updated", fake.subs.get(danaSub.stripeSubscriptionId)), 200);
      const again = await Subscription.findById(danaSub._id);
      assert.strictEqual(again.firstVisitExemption.grantedAt.getTime(), granted);
    });
    await check("/api/auth/me shows the home's first visit as exempt", async () => {
      const me = await call("GET", "/api/auth/me", { as: dana });
      assert.strictEqual(me.status, 200, JSON.stringify(me.body));
      const home = me.body.addresses.find((a) => a._id === String(dana.addresses[0]._id));
      assert.strictEqual(home.hasActiveSubscription, true);
      assert.strictEqual(home.firstVisitExempt, true);
    });
    let firstBooking;
    await check("the first visit books the held time inside the seven days, consuming the hold", async () => {
      const res = await memberBooking(dana, soon, "10:00", { holdToken, clientRequestId: "fv-dana-1" });
      assert.ok([200, 201].includes(res.status), JSON.stringify(res.body));
      firstBooking = await Booking.findOne({ user: dana._id }).sort({ createdAt: -1 });
      assert.ok(firstBooking, "booked");
      assert.ok(/Pending/i.test(firstBooking.status), `awaits the owner: ${firstBooking.status}`);
      assert.strictEqual((await BookingSlotReservation.findById(holdToken.split(".")[0])).status, "released", "the hold gave way to the booking");
    });
    await check("the exemption is spent and points at that booking", async () => {
      const sub = await Subscription.findById(danaSub._id);
      assert.ok(sub.firstVisitExemption.usedAt);
      assert.strictEqual(String(sub.firstVisitExemption.bookingId), String(firstBooking._id));
      const me = await call("GET", "/api/auth/me", { as: dana });
      assert.strictEqual(me.body.addresses[0].firstVisitExempt, false);
    });
    await check("the same press again returns the same booking, not a second one", async () => {
      const res = await memberBooking(dana, soon, "10:00", { holdToken, clientRequestId: "fv-dana-1" });
      assert.ok([200, 201].includes(res.status), JSON.stringify(res.body));
      assert.strictEqual(await Booking.countDocuments({ user: dana._id }), 1);
    });
    await check("the next visit keeps the member seven days", async () => {
      const res = await memberBooking(dana, soon, "13:00");
      assert.strictEqual(res.status, 400, JSON.stringify(res.body));
      assert.strictEqual(res.body.code, "DATE_UNAVAILABLE");
    });

    console.log("\nOnly a new membership, only once");
    await check("an existing member buying for another home gets no exemption", async () => {
      dana.addresses.push({ label: "Rental", line1: "99 Oak Ct", city: "Farmingdale", state: "NY", zip: "11735", county: "Nassau" });
      await dana.save();
      const res = await call("POST", "/api/stripe/checkout/create-checkout-session", {
        as: dana,
        body: { plan: "basic", billingCycle: "monthly", addressId: String(dana.addresses[1]._id), firstVisit: { holdToken: "", requestedDate: openDay(3), requestedTime: "08:00" } },
      });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(fake.created[fake.created.length - 1].metadata.firstVisitExempt, "0");
      assert.strictEqual(res.body.firstVisitExempt, false);
    });
    await check("a former member buying again is exempt", async () => {
      const sam = await customer();
      await Subscription.create({ user: sam._id, userId: sam.userId, subscriptionType: "basic", addressId: sam.addresses[0]._id, startDate: new Date(Date.now() - 90 * 86400000), latestPaymentDate: new Date(Date.now() - 60 * 86400000), nextPaymentDate: new Date(Date.now() - 30 * 86400000), status: "canceled", accessStatus: "inactive", planPrice: 149 });
      const res = await call("POST", "/api/stripe/checkout/create-checkout-session", {
        as: sam,
        body: { plan: "basic", billingCycle: "monthly", addressId: String(sam.addresses[0]._id), firstVisit: { holdToken: "", requestedDate: openDay(4), requestedTime: "08:00" } },
      });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.firstVisitExempt, true);
    });
    await check("two first bookings at once: exactly one gets the exemption", async () => {
      const pat = await customer();
      const s = { id: "cs_race", config: { subscription_data: { metadata: { firstVisitExempt: "1" } } } };
      await buy(pat, s);
      const results = await Promise.all([memberBooking(pat, openDay(1), "08:00"), memberBooking(pat, openDay(1), "13:00")]);
      const ok = results.filter((r) => [200, 201].includes(r.status));
      assert.strictEqual(ok.length, 1, results.map((r) => `${r.status} ${r.body.code || r.body.message || ""}`).join(" | "));
    });
    await check("a booking that fails hands the exemption back", async () => {
      const ria = await customer();
      const sub = await buy(ria, { id: "cs_fail", config: { subscription_data: { metadata: { firstVisitExempt: "1" } } } });
      // Somebody else already has 13:00 on that day (one seat).
      const other = await call("POST", "/api/bookings/hold", { body: { requestedDate: openDay(3), requestedTime: "13:00" } });
      assert.strictEqual(other.status, 200);
      const res = await memberBooking(ria, openDay(3), "13:00");
      assert.ok(res.status >= 400, `refused: ${res.status} ${JSON.stringify(res.body)}`);
      const fresh = await Subscription.findById(sub._id);
      assert.strictEqual(fresh.firstVisitExemption.usedAt, null, "still unspent");
    });
    await check("an exemption older than 30 days has lapsed", async () => {
      const ola = await customer();
      const sub = await buy(ola, { id: "cs_old", config: { subscription_data: { metadata: { firstVisitExempt: "1" } } } });
      await Subscription.updateOne({ _id: sub._id }, { $set: { "firstVisitExemption.grantedAt": new Date(Date.now() - 31 * 86400000) } });
      const res = await memberBooking(ola, openDay(2), "08:00");
      assert.strictEqual(res.status, 400, JSON.stringify(res.body));
      assert.strictEqual(res.body.code, "DATE_UNAVAILABLE");
    });

    console.log("\nAn expired checkout page frees the visit");
    await check("checkout.session.expired releases the hold that page was opened with", async () => {
      const max = await customer();
      const day = openDay(5);
      const hold = await call("POST", "/api/bookings/hold", { body: { requestedDate: day, requestedTime: "08:00" } });
      const res = await call("POST", "/api/stripe/checkout/create-checkout-session", {
        as: max,
        body: { plan: "basic", billingCycle: "monthly", addressId: String(max.addresses[0]._id), firstVisit: { holdToken: hold.body.token, requestedDate: day, requestedTime: "08:00" } },
      });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      const page = fake.created[fake.created.length - 1];
      assert.strictEqual(await deliver("checkout.session.expired", { ...page, status: "expired", object: "checkout.session" }), 200);
      assert.strictEqual((await BookingSlotReservation.findById(hold.body.token.split(".")[0])).status, "released");
      const again = await call("POST", "/api/bookings/hold", { body: { requestedDate: day, requestedTime: "08:00" } });
      assert.strictEqual(again.status, 200, "the time is open again");
    });

    console.log("\nA verified mobile number for new accounts");
    await check("phoneRequired: a new Google/Apple/email account without a verified phone", async () => {
      for (const signupMethod of ["google", "apple", "email_code"]) {
        const u = await User.create({ userId: `4200000${signupMethod.length}${seq++}`, name: "New", email: `new-${signupMethod}@mailbox.test`, role: "customer", signupMethod });
        const me = await call("GET", "/api/auth/me", { as: u });
        assert.strictEqual(me.body.phoneRequired, true, signupMethod);
      }
    });
    await check("phoneRequired: never for a verified phone, an older account, Admin-made customers or staff", async () => {
      const verified = await User.create({ userId: "42100001", email: "v@mailbox.test", role: "customer", signupMethod: "google", phone: "+15165550999", phoneVerifiedAt: new Date() });
      const older = await User.create({ userId: "42100002", email: "o@mailbox.test", role: "customer", signupMethod: "google" });
      await User.collection.updateOne({ _id: older._id }, { $set: { createdAt: new Date("2026-10-01T12:00:00Z") } });
      const admin = await User.create({ userId: "42100003", email: "a@mailbox.test", role: "customer", signupMethod: "admin", phone: "+15165550998" });
      const staff = await User.create({ userId: "42100004", email: "s@fixter.local", role: "employee", employeePosition: "Fixter", signupMethod: "google", password: "x" });
      for (const u of [verified, older, admin, staff]) {
        const me = await call("GET", "/api/auth/me", { as: u });
        assert.strictEqual(me.body.phoneRequired, false, `${u.email} ${JSON.stringify(me.body).slice(0, 120)}`);
      }
    });

  } finally {
    server.close();
    await mongoose.disconnect();
    await replSet.stop();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
