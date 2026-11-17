/**
 * REAL Stripe test-mode verification of free-visit conversion (customer
 * upgrade and Admin link). Not a unit test and not in CI: it talks to Stripe's
 * test mode, pays hosted Checkout pages with Stripe's test cards in a real
 * browser, and receives Stripe's real webhooks through the Stripe CLI.
 *
 * Nothing real can happen:
 *   - It refuses to start unless the key is a TEST key and Stripe itself says
 *     livemode is false (balance.retrieve).
 *   - Its database is a throwaway in-memory MongoDB (no production data).
 *   - Email, SMS and Meta are replaced in-process: nothing is sent to anyone.
 *     Every would-be message is recorded and checked instead.
 *
 * RUN (two terminals, from BackEnd):
 *   1. stripe listen --forward-to http://localhost:5077/api/stripe/webhook
 *      (copy the whsec_... it prints; log in to the Profixter TEST account first)
 *   2. STRIPE_SECRET_KEY=sk_test_... STRIPE_WEBHOOK_SECRET=whsec_... \
 *        node scripts/stripe_testmode_conversion.js [--headed]
 *
 * It creates (once, reused afterwards) test-mode Products/Prices tagged
 * metadata.profixter_testmode=conversion, the 20% welcome coupon if missing,
 * and test customers. Subscriptions it starts are canceled at the end.
 *
 * Scenarios (each prints PASS/FAIL with the Stripe ids):
 *   A  customer membership, eligible 20% welcome offer: paid, webhook, converted in place
 *   B  customer One-Time: paid, webhook, converted in place, Meta purchase recorded (not sent)
 *   C  Admin payment link (One-Time, guest): /pay page, paid, converted, never Meta
 *   D  abandoned checkout: page expired in Stripe, visit unchanged, no recovery email
 *   E  the same webhook event delivered again (replays): converted once, one confirmation
 *   F  paid after leaving Stripe, webhook held back: "processing" (never "unpaid"), then converted
 *   G  decline after payment: One-Time refund recorded only once Stripe shows it;
 *      membership "canceled" refused while it still bills, accepted once it is set to end
 */
"use strict";

const path = require("path");
const fs = require("fs");

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

const PORT = Number(process.env.TESTMODE_PORT || 5077);
const BASE = `http://localhost:${PORT}`;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET_TESTMODE || "testmode-conversion-secret";
process.env.CLIENT_URL = BASE; /* Stripe's success/cancel pages come back here */
process.env.SMS_ENABLED = "false";
process.env.S3_BUCKET = "testmode-bucket";
process.env.ENABLE_RESERVATION_ENGINE = "true";
process.env.MAIL_ADMIN = "owner@testmode.invalid";

const HEADED = process.argv.includes("--headed");
const OUT_DIR = path.join(__dirname, "..", "..", "reports", "stripe-testmode");
fs.mkdirSync(OUT_DIR, { recursive: true });

const results = [];
function record(scenario, name, pass, detail = {}) {
  results.push({ scenario, name, pass: Boolean(pass), detail });
  console.log(`${pass ? "PASS" : "FAIL"}  [${scenario}] ${name}${Object.keys(detail).length ? `  ${JSON.stringify(detail)}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, { timeout = 90000, every = 1000, what = "condition" } = {}) {
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
  const account = await stripe.accounts.retrieve().catch(() => null);
  console.log(`Stripe TEST mode confirmed${account ? ` (account ${account.id}${account.settings?.dashboard?.display_name ? `, ${account.settings.dashboard.display_name}` : ""})` : ""}.`);

  /* ---------------- test-mode prices (created once, reused) ---------------- */
  async function ensurePrice({ lookupKey, name, unitAmount, recurring, metadata }) {
    const found = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
    if (found.data[0]) return found.data[0].id;
    const product = await stripe.products.create({ name: `${name} (TEST)`, metadata: { profixter_testmode: "conversion" } });
    const price = await stripe.prices.create({
      product: product.id,
      currency: "usd",
      unit_amount: unitAmount,
      lookup_key: lookupKey,
      ...(recurring ? { recurring } : {}),
      metadata: { profixter_testmode: "conversion", ...metadata },
    });
    return price.id;
  }
  const { PLAN_CATALOG } = require("../utils/subscriptionManagement");
  for (const plan of Object.keys(PLAN_CATALOG)) {
    for (const cycle of ["monthly", "annual"]) {
      const dollars = PLAN_CATALOG[plan][cycle].price;
      process.env[`STRIPE_PRICE_${plan.toUpperCase()}_${cycle.toUpperCase()}`] = await ensurePrice({
        lookupKey: `pfx_testmode_${plan}_${cycle}`,
        name: `Profixter ${plan} ${cycle}`,
        unitAmount: Math.round(dollars * 100),
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
  mail.sendRaw = async (m) => (sent.push({ to: m.to, subject: m.subject, key: m.logContext?.templateKey || "" }), { ok: true });
  mail.sendTx = async (key, to) => (sent.push({ key, to }), { ok: true });
  mail.sendPromo = async (to, m) => (sent.push({ to, subject: m.subject, key: m.logContext?.templateKey || "promo" }), { ok: true });
  const metaEvents = [];
  require("../utils/metaCapi").sendDetached = (event) => metaEvents.push(event);
  const recoveries = [];
  const checkoutRecovery = require("../utils/growth/checkoutRecovery");
  const realRecovery = checkoutRecovery.proposeCheckoutRecovery;
  checkoutRecovery.proposeCheckoutRecovery = async (session, ...rest) => (recoveries.push(session.id), realRecovery(session, ...rest));
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
  const User = require("../models/User");
  const FreeVisitConversion = require("../models/FreeVisitConversion");
  const CompanyAvailabilityTemplate = require("../models/CompanyAvailabilityTemplate");
  const Request = require("../models/Request");
  const moment = require("moment-timezone");
  const jwt = require("jsonwebtoken");
  const express = require("express");
  const TZ = "America/New_York";
  for (const M of [Booking, User, FreeVisitConversion, Request]) await M.init();
  await require("../utils/visitEntitlementIndexSafety").ensureVisitEntitlementIndexes({ logger: { log() {}, warn() {} } });

  await CompanyAvailabilityTemplate.create({
    active: true, timezone: TZ, slotMinutes: 30, minLeadMinutes: 0, maxAdvanceDays: 120, defaultCapacity: 2, visitDurationMinutes: 90,
    weeklySchedule: Array.from({ length: 7 }, (_, weekday) => ({ weekday, enabled: weekday !== 0, starts: ["08:00", "10:00", "13:00"].map((time) => ({ time, capacity: null })), intervals: [{ startTime: "08:00", endTime: "16:00", capacity: null }] })),
  });
  const owner = await User.create({ userId: "90000001", name: "Owner (test mode)", email: "owner@testmode.invalid", role: "admin", password: "x" });

  /* ---------------- the real app routes, with a webhook gate ---------------- */
  const delivered = [];
  const gate = { hold: false, held: [] };
  const app = express();
  app.post(
    "/api/stripe/webhook",
    express.raw({ type: "application/json" }),
    (req, res, next) => {
      const event = JSON.parse(req.body.toString("utf8"));
      if (gate.hold && event.type === "checkout.session.completed") {
        gate.held.push({ body: req.body, event });
        return res.status(503).json({ held: true });
      }
      delivered.push(event);
      return next();
    },
    require("../routes/webhook")
  );
  app.use(express.json());
  app.use("/api/bookings", require("../routes/bookings"));
  app.use("/api/pay", require("../routes/pay"));
  app.use("/api/admin/free-visit-conversions", require("../routes/adminFreeVisitConversions"));
  app.use("/api/visit-upgrade", require("../routes/visitUpgrade"));
  app.use("/api/admin", require("../routes/adminJobs"));
  app.get(["/book", "/pay/:token"], (req, res) => res.type("html").send(`<!doctype html><title>Returned</title><p data-returned>${req.originalUrl}</p>`));
  const server = await new Promise((resolve) => {
    const s = app.listen(PORT, () => resolve(s));
  });
  const replay = async (event) => {
    const payload = JSON.stringify(event);
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret: WHSEC });
    return (await passThrough(`${BASE}/api/stripe/webhook`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": header }, body: payload })).status;
  };
  const tokenFor = (u) => jwt.sign({ id: String(u._id), tv: 0 }, process.env.JWT_SECRET);
  const call = async (method, p, { body, as } = {}) => {
    const headers = as ? { authorization: `Bearer ${tokenFor(as)}` } : {};
    if (body) headers["content-type"] = "application/json";
    const res = await passThrough(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  /* ---------------- people and visits ---------------- */
  let seq = 0;
  const day = (n) => {
    const d = moment.tz(TZ).startOf("day").add(1, "day");
    let found = 0;
    for (;;) {
      if (d.day() !== 0) found += 1;
      if (found === n) return d.format("YYYY-MM-DD");
      d.add(1, "day");
    }
  };
  const at = (date, time) => moment.tz(`${date} ${time}`, "YYYY-MM-DD HH:mm", TZ).toDate();
  const customer = async (label) => {
    seq += 1;
    return User.create({
      userId: `4300${String(seq).padStart(4, "0")}`,
      name: `Test ${label}`,
      email: `testmode.${label.toLowerCase().replace(/\W+/g, ".")}.${Date.now()}@example.com`,
      phone: `+1631555${String(3000 + seq)}`,
      phoneVerifiedAt: new Date(),
      role: "customer",
      signupMethod: "phone",
      addresses: [{ label: "Home", line1: `${20 + seq} Test Lane`, city: "Farmingdale", state: "NY", zip: "11735", county: "Nassau" }],
    });
  };
  const onlineVisit = async (user, date, time) => {
    const res = await call("POST", "/api/bookings", {
      as: user,
      body: { service: "Labor Only", date: at(date, time).toISOString(), note: "Test-mode visit", addressId: String(user.addresses[0]._id), requestedDate: date, requestedTime: time },
    });
    if (res.status !== 200) throw new Error(`online free visit: ${JSON.stringify(res.body)}`);
    return Booking.findOne({ bookingNumber: res.body.booking.bookingNumber });
  };
  const guestVisit = async (date, time) => {
    seq += 1;
    const { reserveGuestFreeVisit } = require("../utils/freeVisit/guestVisit");
    const email = `testmode.guest.${seq}.${Date.now()}@example.com`;
    const phone = `+1631555${String(3000 + seq)}`;
    const slotStart = at(date, time);
    const request = new Request({
      name: "Test Guest", email, phone, message: "Test-mode guest visit", serviceType: "free_visit_request", sourcePage: "/book/free",
      status: "pending_confirmation", requestedDate: date, requestedTime: time, requestedAt: slotStart,
      contactConsent: { text: "test", at: new Date(), ip: "", userAgent: "", pageUrl: "" }, dedupeKey: `testmode-${seq}-${Date.now()}`,
    });
    const { booking } = await reserveGuestFreeVisit({
      request, slotStart,
      bookingData: { name: "Test Guest", phone, email, note: "Test-mode guest visit", images: [], libraryReference: "", service: "Free Visit", freeVisitPurpose: "consultation", address: `${200 + seq} Guest Rd`, unit: "", city: "Farmingdale", state: "NY", zip: "11735", county: "Nassau" },
    });
    return Booking.findById(booking._id);
  };
  const snapshot = (b) => ({ id: String(b._id), number: b.bookingNumber, date: new Date(b.date).toISOString(), address: b.address, note: b.note, fixter: String(b.assignedFixterId || ""), images: (b.images || []).length });
  const sameVisit = (before, after) => JSON.stringify({ ...before }) === JSON.stringify({ ...snapshot(after) });
  const conversionOf = (bookingId) => FreeVisitConversion.findOne({ booking: bookingId }).sort({ createdAt: -1 });
  const convertedIn = (bookingId) => until(async () => (await conversionOf(bookingId))?.status === "converted" && conversionOf(bookingId), { what: "the webhook to convert the visit" });

  /* ---------------- paying a hosted Checkout page with a test card ---------------- */
  const { chromium } = require("playwright");
  const browser = await chromium.launch({ headless: !HEADED });
  async function payHosted(url, label) {
    const page = await browser.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      const fillIf = async (sel, value) => {
        const el = page.locator(sel).first();
        if (await el.count()) await el.fill(value);
      };
      const card = page.locator("[data-testid=card-accordion-item-button], #payment-method-accordion-item-title-card").first();
      if (await card.count()) await card.click().catch(() => {});
      await page.locator("#cardNumber").waitFor({ timeout: 30000 });
      await fillIf("#email", `testmode.payer.${Date.now()}@example.com`);
      await fillIf("#cardNumber", "4242424242424242");
      await fillIf("#cardExpiry", "12 / 34");
      await fillIf("#cardCvc", "123");
      await fillIf("#billingName", "Test Payer");
      await fillIf("#billingAddressLine1", "1 Test Lane");
      await fillIf("#billingLocality", "Farmingdale");
      await fillIf("#billingPostalCode", "11735");
      const stateSel = page.locator("#billingAdministrativeArea");
      if (await stateSel.count()) await stateSel.selectOption("NY").catch(() => {});
      await page.locator("button[type=submit], .SubmitButton").first().click();
      await page.waitForURL((u) => String(u).startsWith(BASE), { timeout: 90000 });
      return page.url();
    } catch (error) {
      await page.screenshot({ path: path.join(OUT_DIR, `checkout-failed-${label}.png`), fullPage: true }).catch(() => {});
      throw new Error(`paying the hosted Checkout page (${label}) failed: ${error.message}. Screenshot in reports/stripe-testmode.`);
    } finally {
      await page.close();
    }
  }
  const sessionIdFromUrl = (url) => (/\/(cs_test_[A-Za-z0-9]+)/.exec(url) || [])[1];
  const startedSubs = [];
  const scenario = async (id, fn) => {
    try {
      await fn();
    } catch (error) {
      record(id, `scenario failed: ${error.message}`, false);
    }
  };

  /* A ------------------------------------------------------------------ */
  await scenario("A", async () => {
    const u = await customer("Welcome Member");
    const v = await onlineVisit(u, day(20), "08:00");
    const before = snapshot(v);
    const opts = await call("GET", `/api/visit-upgrade/${v._id}`, { as: u });
    const start = await call("POST", `/api/visit-upgrade/${v._id}/checkout`, { as: u, body: { kind: "membership", plan: "basic", billingCycle: "monthly", acceptTerms: true, termsVersion: opts.body.termsVersion, welcomeOffer: true } });
    record("A", "the customer's own upgrade opens a Stripe page with the welcome offer", start.status === 200 && start.body.welcomeOfferApplied === true, { status: start.status, code: start.body.code });
    const sessionId = sessionIdFromUrl(start.body.url) || (await conversionOf(v._id)).checkout.sessionId;
    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ["discounts"] });
    record("A", "Stripe's page carries the 20% coupon", (session.discounts || []).some((d) => (d.coupon?.id || d.coupon) === "pfx-welcome-20-first-month"), { sessionId });
    await payHosted(start.body.url, "A");
    const conv = await convertedIn(v._id);
    const paid = await stripe.checkout.sessions.retrieve(sessionId);
    startedSubs.push(paid.subscription);
    const after = await Booking.findById(v._id);
    record("A", "paid at 80% of the first month (Stripe amount_total)", paid.amount_total === Math.round(PLAN_CATALOG.basic.monthly.price * 100 * 0.8), { amount_total: paid.amount_total, subscription: paid.subscription });
    record("A", "the same booking became a membership visit (id, time, address, notes kept)", after.accessType === "membership" && sameVisit(before, after), { status: after.status });
    record("A", "the conversion recorded the payment and subscription", conv.payment.sessionId === sessionId && conv.payment.stripeSubscriptionId === paid.subscription);
    const st = await call("GET", `/api/visit-upgrade/${v._id}/payment`, { as: u });
    record("A", "the return screen's status says converted (waiting for approval)", st.body.state === "converted" && st.body.approvalPending === true, st.body);
    const raw = await User.collection.findOne({ _id: u._id }, { projection: { welcomeOffer: 1 } });
    record("A", "the welcome offer is used up on this account", raw?.welcomeOffer?.sessionId === sessionId);
  });

  /* B ------------------------------------------------------------------ */
  await scenario("B", async () => {
    const u = await customer("One Time");
    const v = await onlineVisit(u, day(21), "08:00");
    const before = snapshot(v);
    const opts = await call("GET", `/api/visit-upgrade/${v._id}`, { as: u });
    const start = await call("POST", `/api/visit-upgrade/${v._id}/checkout`, { as: u, body: { kind: "one_time", acceptTerms: true, termsVersion: opts.body.termsVersion } });
    const sessionId = (await conversionOf(v._id)).checkout.sessionId;
    const metaBefore = metaEvents.length;
    await payHosted(start.body.url, "B");
    const conv = await convertedIn(v._id);
    const paid = await stripe.checkout.sessions.retrieve(sessionId);
    const after = await Booking.findById(v._id);
    record("B", "paid $99 in Stripe", paid.payment_status === "paid" && paid.amount_total === 9900, { sessionId, payment_intent: paid.payment_intent });
    record("B", "the same booking became a One-Time Visit", conv.kind === "one_time" && Boolean(after.freeVisitConversion?.convertedAt) && sameVisit(before, after), { accessType: after.accessType, status: after.status });
    record("B", "one confirmation email to the customer", sent.filter((m) => m.key === "visit_converted" && m.to === u.email).length === 1);
    record("B", "the customer's purchase is reported to Meta once (recorded, not sent)", metaEvents.length - metaBefore === 1);
  });

  /* C ------------------------------------------------------------------ */
  await scenario("C", async () => {
    const g = await guestVisit(day(22), "10:00");
    const before = snapshot(g);
    const made = await call("POST", `/api/admin/free-visit-conversions/bookings/${g._id}`, { as: owner, body: { kind: "one_time", task: "Test-mode Admin link" } });
    record("C", "Admin makes a link (nothing sent)", made.status === 200 && !sent.some((m) => m.key === "visit_conversion_link"), { status: made.status, code: made.body.code });
    const page = await call("GET", `/api/pay/${made.body.token}`);
    const press = await call("POST", `/api/pay/${made.body.token}/checkout`, { body: { acceptTerms: true, termsVersion: page.body.conversion?.terms?.version } });
    const metaBefore = metaEvents.length;
    await payHosted(press.body.url, "C");
    const conv = await convertedIn(g._id);
    const session = await stripe.checkout.sessions.retrieve(conv.payment.sessionId);
    record("C", "paid through the Admin link and converted in place", session.payment_status === "paid" && sameVisit(before, await Booking.findById(g._id)), { sessionId: session.id });
    record("C", "an Admin link (staff sale) is never reported to Meta", metaEvents.length === metaBefore);
    record("C", "the /pay page now says converted", (await call("GET", `/api/pay/${made.body.token}`)).body.status === "converted");
  });

  /* D ------------------------------------------------------------------ */
  await scenario("D", async () => {
    const u = await customer("Abandoned");
    const v = await onlineVisit(u, day(23), "08:00");
    const before = snapshot(v);
    const opts = await call("GET", `/api/visit-upgrade/${v._id}`, { as: u });
    await call("POST", `/api/visit-upgrade/${v._id}/checkout`, { as: u, body: { kind: "one_time", acceptTerms: true, termsVersion: opts.body.termsVersion } });
    const sessionId = (await conversionOf(v._id)).checkout.sessionId;
    const st1 = await call("GET", `/api/visit-upgrade/${v._id}/payment`, { as: u });
    record("D", "backed out with the page still open: verified unpaid, page reusable", st1.body.state === "unpaid" && st1.body.openPage === true, st1.body);
    await stripe.checkout.sessions.expire(sessionId);
    await until(() => delivered.some((e) => e.type === "checkout.session.expired" && e.data.object.id === sessionId), { what: "checkout.session.expired webhook" });
    await sleep(1500);
    const conv = await conversionOf(v._id);
    record("D", "the expired page leaves the conversion open and the visit unchanged", conv.status === "open" && !conv.checkout.sessionId && sameVisit(before, await Booking.findById(v._id)) && (await Booking.findById(v._id)).accessType === "free_first_visit");
    record("D", "no abandoned-checkout recovery for a conversion page", !recoveries.includes(sessionId));
    const st2 = await call("GET", `/api/visit-upgrade/${v._id}/payment`, { as: u });
    record("D", "status: unpaid, no open page", st2.body.state === "unpaid" && st2.body.openPage === false, st2.body);
  });

  /* E ------------------------------------------------------------------ */
  await scenario("E", async () => {
    const completed = delivered.filter((e) => e.type === "checkout.session.completed" && e.data.object.metadata?.freeVisitConversionId);
    const event = completed[completed.length - 1];
    if (!event) throw new Error("no conversion checkout.session.completed event was delivered");
    const bookingId = event.data.object.metadata.convertsBookingId;
    const confirmations = () => sent.filter((m) => m.key === "visit_converted").length;
    const before = confirmations();
    const statuses = [await replay(event), await replay(event), await replay({ ...event, id: `${event.id}_redelivered` })];
    await sleep(1500);
    const rows = await FreeVisitConversion.find({ booking: bookingId });
    record("E", "Stripe's own event, delivered three more times: accepted, converted once, no second confirmation", statuses.every((s) => s === 200) && rows.filter((r) => r.status === "converted").length === 1 && confirmations() === before, { eventId: event.id, statuses });
  });

  /* F ------------------------------------------------------------------ */
  await scenario("F", async () => {
    const u = await customer("Late Webhook");
    const v = await onlineVisit(u, day(24), "08:00");
    const opts = await call("GET", `/api/visit-upgrade/${v._id}`, { as: u });
    const start = await call("POST", `/api/visit-upgrade/${v._id}/checkout`, { as: u, body: { kind: "one_time", acceptTerms: true, termsVersion: opts.body.termsVersion } });
    /* The customer leaves Stripe first (cancel URL), then comes back to the same page and pays. */
    const left = await call("GET", `/api/visit-upgrade/${v._id}/payment`, { as: u });
    record("F", "after leaving Stripe unpaid: verified unpaid with the page still open", left.body.state === "unpaid" && left.body.openPage === true);
    const again = await call("POST", `/api/visit-upgrade/${v._id}/checkout`, { as: u, body: { kind: "one_time", acceptTerms: true, termsVersion: opts.body.termsVersion } });
    record("F", "Continue again reuses the same Stripe page", again.body.url === start.body.url);
    gate.hold = true;
    await payHosted(start.body.url, "F");
    await until(() => gate.held.some((h) => h.event.data.object.metadata?.convertsBookingId === String(v._id)), { what: "the held webhook" });
    const during = await call("GET", `/api/visit-upgrade/${v._id}/payment`, { as: u });
    record("F", "paid, webhook not processed: status 'processing' from Stripe, never 'unpaid'", during.body.state === "processing" && during.body.stripeConfirmed === true, during.body);
    const second = await call("POST", `/api/visit-upgrade/${v._id}/checkout`, { as: u, body: { kind: "membership", plan: "basic", billingCycle: "monthly", acceptTerms: true, termsVersion: opts.body.termsVersion } });
    record("F", "no second payment can be started meanwhile", second.status === 409 && second.body.code === "CONVERSION_IN_PROGRESS", { status: second.status, code: second.body.code });
    gate.hold = false;
    for (const h of gate.held.splice(0)) await replay(h.event);
    await convertedIn(v._id);
    const st = await call("GET", `/api/visit-upgrade/${v._id}/payment`, { as: u });
    record("F", "once the webhook lands: converted", st.body.state === "converted");
  });

  /* G ------------------------------------------------------------------ */
  await scenario("G", async () => {
    const crypto = require("crypto");
    const cancelJob = async (bookingId) => {
      const b = await Booking.findById(bookingId);
      return call("POST", `/api/admin/jobs/${bookingId}/transition`, { as: owner, body: { action: "cancel", expectedStatus: b.status, reason: "Test-mode decline", idempotencyKey: crypto.randomUUID() } });
    };
    /* One-Time (scenario B's visit). */
    const oneTimeConv = await FreeVisitConversion.findOne({ kind: "one_time", status: "converted", source: "customer" }).sort({ createdAt: 1 });
    const c1 = await cancelJob(oneTimeConv.booking);
    record("G", "One-Time: the cancel says it was paid and not refunded", c1.status === 200 && /did not refund/.test(c1.body.conversionPayment?.message || ""), { status: c1.status });
    const pi = oneTimeConv.payment.paymentIntentId;
    const refundsBefore = (await stripe.refunds.list({ payment_intent: pi })).data.length;
    record("G", "One-Time: canceling refunded nothing in Stripe", refundsBefore === 0, { payment_intent: pi });
    const early = await call("POST", `/api/admin/free-visit-conversions/bookings/${oneTimeConv.booking}/${oneTimeConv._id}/resolve`, { as: owner, body: { resolution: "refunded", reason: "Refunded" } });
    record("G", "One-Time: 'refunded' is refused before Stripe shows a refund", early.status === 409 && early.body.code === "NOT_REFUNDED");
    const refund = await stripe.refunds.create({ payment_intent: pi }); /* Admin refunding in Stripe, by hand */
    const ok = await call("POST", `/api/admin/free-visit-conversions/bookings/${oneTimeConv.booking}/${oneTimeConv._id}/resolve`, { as: owner, body: { resolution: "refunded", reason: "Refunded in Stripe" } });
    record("G", "One-Time: recorded once Stripe shows the refund", ok.status === 200 && ok.body.conversion?.resolution?.verified?.refund === "full", { refund: refund.id });

    /* Membership (scenario A's visit). */
    const memberConv = await FreeVisitConversion.findOne({ kind: "membership", status: "converted" }).sort({ createdAt: 1 });
    const c2 = await cancelJob(memberConv.booking);
    const subId = memberConv.payment.stripeSubscriptionId;
    const subAfterCancel = await stripe.subscriptions.retrieve(subId);
    record("G", "Membership: canceling the visit left the subscription billing in Stripe", subAfterCancel.status === "active" && !subAfterCancel.cancel_at_period_end && c2.body.conversionPayment?.membership?.billsAgain === true, { subscription: subId });
    const refused = await call("POST", `/api/admin/free-visit-conversions/bookings/${memberConv.booking}/${memberConv._id}/resolve`, { as: owner, body: { resolution: "membership_canceled", firstPaymentRefunded: false, reason: "Canceled" } });
    record("G", "Membership: 'canceled' refused while Stripe still bills it", refused.status === 409 && refused.body.code === "MEMBERSHIP_STILL_BILLING");
    await stripe.subscriptions.update(subId, { cancel_at_period_end: true }); /* Admin canceling, by hand */
    const accepted = await call("POST", `/api/admin/free-visit-conversions/bookings/${memberConv.booking}/${memberConv._id}/resolve`, { as: owner, body: { resolution: "membership_canceled", firstPaymentRefunded: false, reason: "Canceled at period end, no refund" } });
    record("G", "Membership: recorded once Stripe shows it will not bill again", accepted.status === 200 && accepted.body.conversion?.resolution?.verified?.billsAgain === false);
  });

  /* ---------------- report and tidy up (test mode only) ---------------- */
  for (const sub of startedSubs.filter(Boolean)) await stripe.subscriptions.cancel(sub).catch(() => {});
  await browser.close();
  server.close();
  await mongoose.disconnect();
  await replSet.stop();
  const failed = results.filter((r) => !r.pass);
  const file = path.join(OUT_DIR, `run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), account: account?.id || null, results, outbox: sent, metaEvents: metaEvents.length }, null, 2));
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed. Report: ${file}`);
  process.exit(failed.length ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
