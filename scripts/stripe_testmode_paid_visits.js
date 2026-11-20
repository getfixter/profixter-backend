/**
 * REAL Stripe test-mode verification of paid-visit settlement and first
 * membership counting (2026-11-20). Not a unit test and not in CI: it talks to
 * Stripe's TEST mode, pays hosted Checkout pages with Stripe's test cards in a
 * real browser, and receives Stripe's real webhooks through the Stripe CLI.
 * The same harness as stripe_testmode_conversion.js.
 *
 * Nothing real can happen:
 *   - It refuses to start unless the key is a TEST key and Stripe itself says
 *     livemode is false.
 *   - Its database is a throwaway in-memory MongoDB (no production data).
 *   - Email, SMS, S3 and Meta are replaced in-process; every outbound request
 *     other than this server and api.stripe.com is refused.
 *
 * RUN (two terminals, from BackEnd):
 *   1. stripe listen --forward-to http://localhost:5078/api/stripe/webhook \
 *        --events checkout.session.completed,checkout.session.expired,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,payment_intent.payment_failed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,invoice.paid,invoice.payment_failed
 *      (log in to the Profixter TEST account first; copy the whsec_... it prints)
 *   2. STRIPE_SECRET_KEY=sk_test_... STRIPE_WEBHOOK_SECRET=whsec_... \
 *        node scripts/stripe_testmode_paid_visits.js [--headed]
 *
 * Scenarios (PASS/FAIL with Stripe ids; JSON report in reports/stripe-testmode):
 *   A  guest One-Time: card 4000 0000 0000 0002 declined, then 4242 on the SAME
 *      page -> one paid booking, the same booking id, the slot never released
 *   B  abandoned: back from Stripe with "cancel" -> page expired at Stripe,
 *      booking canceled, slot released
 *   C  expiry: the page expired at Stripe (sessions.expire, which is what Stripe
 *      does at expires_at) -> canceled and released; and the hold sweep closes
 *      a page still open past its hold
 *   D  delayed webhook: paid while checkout.session.completed is held back ->
 *      the hold sweep reads Stripe and records it; the late webhook then
 *      records nothing twice
 *   E  repeated webhook: the same paid event delivered three times -> one
 *      booking paid, one owner notice
 *   F  first membership (book-first) paid with 4242 on a Stripe TEST CLOCK
 *      customer, then the clock advanced a month -> the renewal invoice.paid
 *      arrives; the Overview counts ONE first paid membership, and the renewal
 *      is not a new one
 */
"use strict";

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const KEY = String(process.env.STRIPE_SECRET_KEY || "");
const WHSEC = String(process.env.STRIPE_WEBHOOK_SECRET || "");
if (!/^(sk|rk)_test_/.test(KEY)) {
  console.error("Refusing to run: STRIPE_SECRET_KEY must be a Stripe TEST key (sk_test_... or rk_test_...).");
  process.exit(2);
}
if (!/^whsec_/.test(WHSEC)) {
  console.error("Refusing to run: STRIPE_WEBHOOK_SECRET must be the whsec_... printed by `stripe listen`.");
  process.exit(2);
}

const PORT = Number(process.env.TESTMODE_PORT || 5078);
const BASE = `http://localhost:${PORT}`;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET_TESTMODE || "testmode-paid-visits-secret";
process.env.CLIENT_URL = BASE;
process.env.SMS_ENABLED = "false";
process.env.S3_BUCKET = "testmode-bucket";
process.env.ENABLE_RESERVATION_ENGINE = "true";
process.env.MAIL_ADMIN = "owner@testmode.invalid";
process.env.ONE_TIME_VISIT_HOLD_CLEANUP_ENABLED = "false"; /* the sweep is run by hand below */

const HEADED = process.argv.includes("--headed");
const OUT_DIR = path.join(__dirname, "..", "..", "reports", "stripe-testmode");
fs.mkdirSync(OUT_DIR, { recursive: true });

const results = [];
function record(scenario, name, pass, detail = {}) {
  results.push({ scenario, name, pass: Boolean(pass), detail });
  console.log(`${pass ? "PASS" : "FAIL"}  [${scenario}] ${name}${Object.keys(detail).length ? `  ${JSON.stringify(detail)}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, { timeout = 120000, every = 1000, what = "condition" } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(every);
  }
}

(async () => {
  const stripe = require("stripe")(KEY);
  const balance = await stripe.balance.retrieve();
  if (balance.livemode !== false) {
    console.error("Refusing to run: Stripe reports livemode for this key.");
    process.exit(2);
  }
  console.log("Stripe TEST mode confirmed.");

  /* ---------------- test-mode prices (created once, reused) ---------------- */
  async function ensurePrice({ lookupKey, name, unitAmount, recurring, metadata }) {
    const found = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
    if (found.data[0]) return found.data[0].id;
    const product = await stripe.products.create({ name: `${name} (TEST)`, metadata: { profixter_testmode: "paid_visits" } });
    const price = await stripe.prices.create({ product: product.id, currency: "usd", unit_amount: unitAmount, lookup_key: lookupKey, ...(recurring ? { recurring } : {}), metadata: { profixter_testmode: "paid_visits", ...metadata } });
    return price.id;
  }
  const { PLAN_CATALOG } = require("../utils/subscriptionManagement");
  for (const plan of Object.keys(PLAN_CATALOG)) {
    for (const cycle of ["monthly", "annual"]) {
      process.env[`STRIPE_PRICE_${plan.toUpperCase()}_${cycle.toUpperCase()}`] = await ensurePrice({
        lookupKey: `pfx_testmode_${plan}_${cycle}`,
        name: `Profixter ${plan} ${cycle}`,
        unitAmount: Math.round(PLAN_CATALOG[plan][cycle].price * 100),
        recurring: { interval: cycle === "annual" ? "year" : "month" },
        metadata: { profixter_plan: plan, billing_cycle: cycle },
      });
    }
  }
  process.env.STRIPE_PRICE_ONE_TIME_HANDYMAN_VISIT = await ensurePrice({ lookupKey: "pfx_testmode_one_time", name: "Profixter One-Time Visit", unitAmount: 9900 });

  /* ---------------- throwaway database ---------------- */
  const { MongoMemoryReplSet } = require("mongodb-memory-server");
  const mongoose = require("mongoose");
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(replSet.getUri());

  /* ---------------- nothing leaves: mail, SMS, Meta, S3 ---------------- */
  const sent = [];
  const mail = require("../utils/emailService");
  mail.sendRaw = async (m) => (sent.push({ to: m.to, subject: m.subject, text: m.text || "", key: m.logContext?.templateKey || "" }), { ok: true });
  mail.sendTx = async (key, to) => (sent.push({ key, to }), { ok: true });
  mail.sendPromo = async (to, m) => (sent.push({ to, subject: m.subject, key: "promo" }), { ok: true });
  require("../utils/metaCapi").sendDetached = () => {};
  const s3 = require("../utils/s3");
  s3.putPublicObject = async ({ Key }) => `https://testmode-bucket.invalid/${Key}`;
  s3.deletePublicObjects = async ({ Keys }) => ({ deleted: Keys.length });
  const passThrough = global.fetch;
  global.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith(BASE) || u.startsWith("https://api.stripe.com")) return passThrough(url, init);
    throw new Error(`Blocked outbound request in test-mode run: ${u}`);
  };

  const Booking = require("../models/Booking");
  const BookingSlotReservation = require("../models/BookingSlotReservation");
  const User = require("../models/User");
  const Subscription = require("../models/Subscription");
  const SiteVisitor = require("../models/SiteVisitor");
  const CompanyAvailabilityTemplate = require("../models/CompanyAvailabilityTemplate");
  const moment = require("moment-timezone");
  const jwt = require("jsonwebtoken");
  const express = require("express");
  const TZ = "America/New_York";
  for (const M of [Booking, BookingSlotReservation, User, Subscription]) await M.init();
  await require("../utils/visitEntitlementIndexSafety").ensureVisitEntitlementIndexes({ logger: { log() {}, warn() {} } });
  for (const n of [1, 2]) {
    await User.create({ name: `Fixter ${n}`, email: `f${n}@testmode.invalid`, password: "x", phone: "+15550002222", userId: `8200000${n}`, role: "employee", employeePosition: "Fixter", isActive: true });
  }
  await CompanyAvailabilityTemplate.create({
    active: true, timezone: TZ, slotMinutes: 30, minLeadMinutes: 0, maxAdvanceDays: 120, defaultCapacity: 1, visitDurationMinutes: 90,
    weeklySchedule: Array.from({ length: 7 }, (_, weekday) => ({ weekday, enabled: weekday !== 0, starts: ["08:00", "10:30", "13:00", "15:30"].map((time) => ({ time, capacity: null })), intervals: [{ startTime: "08:00", endTime: "17:00", capacity: null }] })),
  });

  /* ---------------- the real routes, with a webhook gate ---------------- */
  const delivered = [];
  const gate = { holdCompleted: false, held: [] };
  const app = express();
  app.post(
    "/api/stripe/webhook",
    express.raw({ type: "application/json" }),
    (req, res, next) => {
      const event = JSON.parse(req.body.toString("utf8"));
      if (gate.holdCompleted && event.type === "checkout.session.completed") {
        gate.held.push(event);
        return res.status(503).json({ held: true }); /* Stripe retries later; this run replays it by hand */
      }
      delivered.push(event);
      return next();
    },
    require("../routes/webhook")
  );
  app.use(express.json());
  app.use("/api/bookings/guest", require("../routes/guestBookings"));
  app.use("/api/bookings", require("../routes/bookings"));
  app.use("/api/stripe/checkout", require("../routes/stripe"));
  app.get(["/book/*", "/start", "/confirmationpage"], (req, res) => res.type("html").send(`<!doctype html><title>Returned</title><p data-returned>${req.originalUrl}</p>`));
  const server = await new Promise((resolve) => {
    const s = app.listen(PORT, () => resolve(s));
  });
  const replay = async (event) => {
    const payload = JSON.stringify({ ...event, id: `${event.id}_replay_${crypto.randomUUID().slice(0, 8)}` });
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret: WHSEC });
    return (await passThrough(`${BASE}/api/stripe/webhook`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": header }, body: payload })).status;
  };
  const tokenFor = (u) => jwt.sign({ id: String(u._id), tv: 0 }, process.env.JWT_SECRET);
  const call = async (method, p, { body, form, as } = {}) => {
    const headers = as ? { authorization: `Bearer ${tokenFor(as)}` } : {};
    let payload;
    if (form) payload = form;
    else if (body) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await passThrough(`${BASE}${p}`, { method, headers, body: payload });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const { GUEST_CHECKOUT_CONSENT_TEXT } = require("../routes/guestBookings");
  const day = (n) => {
    const d = moment.tz(TZ).startOf("day").add(3, "day");
    let found = 0;
    for (;;) {
      if (d.day() !== 0) found += 1;
      if (found === n) return d.format("YYYY-MM-DD");
      d.add(1, "day");
    }
  };
  let seq = 0;
  const guestCheckout = async (date, time) => {
    seq += 1;
    const form = new FormData();
    const fields = {
      name: "Test Guest", phone: `(631) 555-${String(4000 + seq)}`, email: `testmode.guest.${seq}.${Date.now()}@example.com`,
      line1: `${10 + seq} Test Lane`, city: "Farmingdale", state: "NY", zip: "11735",
      note: "Fix the sticking back door", selectedTask: "Door", requestedDate: date, requestedTime: time,
      consentText: GUEST_CHECKOUT_CONSENT_TEXT, clientRequestId: `testmode-${seq}-${Date.now()}`, returnTo: "welcome", visitorId: `v_testmode${seq}abcdefgh`,
    };
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    const r = await call("POST", "/api/bookings/guest/one-time/checkout", { form });
    if (r.status !== 200) throw new Error(`guest checkout: ${JSON.stringify(r.body)}`);
    return { ...r.body, clientRequestId: fields.clientRequestId, sessionId: (await Booking.findById(r.body.bookingId)).checkoutSessionId };
  };
  const reservationOf = (bookingId) => BookingSlotReservation.findOne({ bookingId }).sort({ createdAt: -1 }).lean();
  const ownerNotices = (bookingNumber) => sent.filter((m) => /paid/i.test(m.subject || "") && (m.text || "").includes(bookingNumber)).length;

  /* ---------------- paying a hosted Checkout page with test cards ---------------- */
  const { chromium } = require("playwright");
  const browser = await chromium.launch({ headless: !HEADED });
  async function fillCard(page, number) {
    const fillIf = async (sel, value) => {
      const el = page.locator(sel).first();
      if (await el.count()) await el.fill(value);
    };
    const card = page.locator("[data-testid=card-accordion-item-button], #payment-method-accordion-item-title-card").first();
    if (await card.count()) await card.click().catch(() => {});
    await page.locator("#cardNumber").waitFor({ timeout: 30000 });
    await fillIf("#email", `testmode.payer.${Date.now()}@example.com`);
    await page.locator("#cardNumber").fill(number);
    await fillIf("#cardExpiry", "12 / 34");
    await fillIf("#cardCvc", "123");
    await fillIf("#billingName", "Test Payer");
    await fillIf("#billingAddressLine1", "1 Test Lane");
    await fillIf("#billingLocality", "Farmingdale");
    await fillIf("#billingPostalCode", "11735");
    const stateSel = page.locator("#billingAdministrativeArea");
    if (await stateSel.count()) await stateSel.selectOption("NY").catch(() => {});
    await page.locator("button[type=submit], .SubmitButton").first().click();
  }
  async function payHosted(url, label, { declineFirst = false, afterDecline = null } = {}) {
    const page = await browser.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      if (declineFirst) {
        await fillCard(page, "4000000000000002");
        await page.getByText(/declined/i).first().waitFor({ timeout: 60000 });
        if (afterDecline) await afterDecline();
      }
      await fillCard(page, "4242424242424242");
      await page.waitForURL((u) => String(u).startsWith(BASE), { timeout: 90000 });
      return page.url();
    } catch (error) {
      await page.screenshot({ path: path.join(OUT_DIR, `checkout-failed-${label}.png`), fullPage: true }).catch(() => {});
      throw new Error(`paying the hosted Checkout page (${label}) failed: ${error.message}`);
    } finally {
      await page.close();
    }
  }
  const scenario = async (id, fn) => {
    try {
      await fn();
    } catch (error) {
      record(id, `scenario failed: ${error.message}`, false);
    }
  };
  const { expireOneTimeVisitHolds } = require("../jobs/oneTimeVisitHolds");

  /* A ------------------------------------------------------------------ */
  await scenario("A", async () => {
    const c = await guestCheckout(day(2), "08:00");
    await payHosted(c.url, "A", {
      declineFirst: true,
      afterDecline: async () => {
        await until(() => delivered.some((e) => e.type === "payment_intent.payment_failed" && e.data.object.metadata?.bookingId === c.bookingId), { what: "payment_intent.payment_failed" });
        const b = await Booking.findById(c.bookingId).lean();
        record("A", "after the decline: booking still pending, the time still held", b.status === "Pending" && b.paymentState === "pending" && (await reservationOf(c.bookingId)).status === "held", { booking: c.bookingId, declined: b.paymentSettlement?.declinedCount });
      },
    });
    const b = await until(async () => {
      const x = await Booking.findById(c.bookingId).lean();
      return x.paymentState === "paid" && x;
    }, { what: "the paid booking" });
    record("A", "the second card paid for the same booking", b.paymentState === "paid" && b.status === "Pending" && (await reservationOf(c.bookingId)).status === "reserved", { session: c.sessionId });
    record("A", "one paid booking for this press", (await Booking.countDocuments({ checkoutClientKey: c.clientRequestId, paymentState: "paid" })) === 1);
  });

  /* B ------------------------------------------------------------------ */
  await scenario("B", async () => {
    const c = await guestCheckout(day(3), "10:30");
    const a = await call("POST", "/api/bookings/guest/abandon", { body: { bookingId: c.bookingId, clientRequestId: c.clientRequestId } });
    record("B", "abandon accepted", a.status === 200 && a.body.released === true);
    await until(() => delivered.some((e) => e.type === "checkout.session.expired" && e.data.object.id === c.sessionId), { what: "checkout.session.expired" });
    const b = await until(async () => {
      const x = await Booking.findById(c.bookingId).lean();
      return x.status === "Canceled" && x;
    }, { what: "the canceled booking" });
    record("B", "page expired at Stripe, booking canceled, time released", (await stripe.checkout.sessions.retrieve(c.sessionId)).status === "expired" && b.paymentState === "expired" && (await reservationOf(c.bookingId)).status === "released");
  });

  /* C ------------------------------------------------------------------ */
  await scenario("C", async () => {
    const c = await guestCheckout(day(3), "13:00");
    await stripe.checkout.sessions.expire(c.sessionId);
    await until(() => delivered.some((e) => e.type === "checkout.session.expired" && e.data.object.id === c.sessionId), { what: "checkout.session.expired" });
    const b = await until(async () => {
      const x = await Booking.findById(c.bookingId).lean();
      return x.status === "Canceled" && x;
    }, { what: "the canceled booking" });
    record("C", "an expired page cancels the unpaid booking and frees the time", b.paymentStatus === "Expired" && (await reservationOf(c.bookingId)).status === "released");
    const open = await guestCheckout(day(3), "15:30");
    await Booking.updateOne({ _id: open.bookingId }, { $set: { paymentHoldExpiresAt: new Date(Date.now() - 60000) } });
    await expireOneTimeVisitHolds(new Date());
    record("C", "the sweep closes a page still open past its hold, then releases", (await stripe.checkout.sessions.retrieve(open.sessionId)).status === "expired" && (await Booking.findById(open.bookingId)).paymentState === "expired");
  });

  /* D ------------------------------------------------------------------ */
  await scenario("D", async () => {
    gate.holdCompleted = true;
    const c = await guestCheckout(day(4), "08:00");
    await payHosted(c.url, "D");
    await until(() => gate.held.some((e) => e.data.object.id === c.sessionId), { what: "the held-back checkout.session.completed" });
    record("D", "Stripe says paid; our record is still pending (webhook held back)", (await stripe.checkout.sessions.retrieve(c.sessionId)).payment_status === "paid" && (await Booking.findById(c.bookingId)).paymentState === "pending");
    await Booking.updateOne({ _id: c.bookingId }, { $set: { paymentHoldExpiresAt: new Date(Date.now() - 60000) } });
    await expireOneTimeVisitHolds(new Date());
    const b = await Booking.findById(c.bookingId).lean();
    record("D", "the sweep read Stripe and recorded the payment (not canceled)", b.paymentState === "paid" && b.status === "Pending");
    gate.holdCompleted = false;
    for (const e of gate.held.filter((x) => x.data.object.id === c.sessionId)) await replay(e);
    await sleep(1500);
    record("D", "the late webhook records nothing twice: one owner notice", ownerNotices(b.bookingNumber) === 1, { notices: ownerNotices(b.bookingNumber) });
  });

  /* E ------------------------------------------------------------------ */
  await scenario("E", async () => {
    const c = await guestCheckout(day(4), "10:30");
    await payHosted(c.url, "E");
    const completed = await until(() => delivered.find((e) => e.type === "checkout.session.completed" && e.data.object.id === c.sessionId), { what: "checkout.session.completed" });
    const b = await until(async () => {
      const x = await Booking.findById(c.bookingId).lean();
      return x.paymentState === "paid" && x;
    }, { what: "paid" });
    const statuses = await Promise.all([replay(completed), replay(completed), replay(completed)]);
    await sleep(1500);
    record("E", "three more deliveries: accepted or retried, never a second record", statuses.every((s) => s === 200 || s === 500) && ownerNotices(b.bookingNumber) === 1, { statuses, notices: ownerNotices(b.bookingNumber) });
  });

  /* F ------------------------------------------------------------------ */
  await scenario("F", async () => {
    const clock = await stripe.testHelpers.testClocks.create({ frozen_time: Math.floor(Date.now() / 1000), name: "profixter welcome renewal" });
    const customer = await stripe.customers.create({ email: `testmode.member.${Date.now()}@example.com`, test_clock: clock.id });
    const u = await User.create({
      userId: "43009001", name: "Test Member", email: customer.email, emailVerifiedAt: new Date(), phone: "+16315559001", phoneVerifiedAt: new Date(),
      role: "customer", signupMethod: "phone", stripeCustomerId: customer.id, createdAt: new Date(),
      addresses: [{ label: "Home", line1: "9 Test Lane", city: "Farmingdale", state: "NY", zip: "11735", county: "Nassau" }],
      attribution: { visitorId: "v_testmode_member0001" },
    });
    await SiteVisitor.create({ visitorId: "v_testmode_member0001", firstSeenAt: new Date(), landingPath: "/", source: "direct", user: u._id, welcome: { shownAt: new Date(), firstTap: "membership", firstTapAt: new Date() } });
    const date = day(6);
    const hold = await call("POST", "/api/bookings/hold", { body: { requestedDate: date, requestedTime: "13:00" } });
    const form = new FormData();
    form.append("addressId", String(u.addresses[0]._id));
    form.append("note", "Mount a TV and patch two holes");
    form.append("requestedDate", date);
    form.append("requestedTime", "13:00");
    form.append("holdToken", hold.body.token || "");
    const d = await call("POST", "/api/bookings/first-visit-draft", { form, as: u });
    const co = await call("POST", "/api/stripe/checkout/create-checkout-session", { as: u, body: { plan: "basic", billingCycle: "monthly", addressId: String(u.addresses[0]._id), returnTo: "welcome", firstVisit: { draftId: d.body.draftId, holdToken: hold.body.token, requestedDate: date, requestedTime: "13:00" } } });
    if (co.status !== 200) throw new Error(`membership checkout: ${JSON.stringify(co.body)}`);
    await payHosted(co.body.url, "F");
    const sub = await until(() => Subscription.findOne({ user: u._id, status: { $in: ["active", "trialing"] } }), { what: "the membership" });
    const booked = await until(() => Booking.findOne({ user: u._id }), { what: "the first visit booked by the webhook" });
    record("F", "first membership paid; its first visit booked by the webhook", Boolean(sub && booked), { subscription: sub.stripeSubscriptionId });
    const paidBefore = delivered.filter((e) => e.type === "invoice.paid" && e.data.object.customer === customer.id).length;
    await stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: Math.floor(Date.now() / 1000) + 33 * 86400 });
    await until(() => delivered.filter((e) => e.type === "invoice.paid" && e.data.object.customer === customer.id).length > paidBefore, { timeout: 240000, what: "the renewal invoice.paid" });
    await sleep(3000);
    const overview = require("../utils/analytics/overview");
    const body = await overview.buildOverview({ range: "custom", from: new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10), to: new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10) });
    record("F", "the Overview counts ONE first paid membership after the renewal", body.funnel.firstPaidMemberships === 1, { firstPaidMemberships: body.funnel.firstPaidMemberships });
    record("F", "the welcome block counts it once for the welcome browser", body.funnel.welcome?.firstPaidMemberships === 1, { welcome: body.funnel.welcome });
    record("F", "one Subscription record for the home (the renewal is not a new membership)", (await Subscription.countDocuments({ user: u._id })) === 1);
    await stripe.subscriptions.cancel(sub.stripeSubscriptionId).catch(() => {});
    await stripe.testHelpers.testClocks.del(clock.id).catch(() => {});
  });

  /* ---------------- report and tidy up (test mode only) ---------------- */
  await browser.close();
  server.close();
  await mongoose.disconnect();
  await replSet.stop();
  const failed = results.filter((r) => !r.pass);
  const file = path.join(OUT_DIR, `paid-visits-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), results, outbox: sent.map((m) => ({ to: m.to, subject: m.subject, key: m.key })) }, null, 2));
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed. Report: ${file}`);
  process.exit(failed.length ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
