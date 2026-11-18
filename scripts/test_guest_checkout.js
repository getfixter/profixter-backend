/*
 * Guest checkout for paid visits (routes/guestBookings.js), end to end against
 * a real database: in-memory replica set, reservation engine ON as in
 * production, the real webhook. Stripe is a fake that records every session
 * and signs webhook events with the test secret; S3 and email are faked; SMS
 * is decided, recorded and never sent.
 *
 *   node scripts/test_guest_checkout.js
 *
 * Pins:
 *  - a guest books and pays a One-Time Visit with no account: the slot is
 *    held, Stripe gets the email and no account ids, the visit waits for the
 *    owner's approval after payment (never auto-confirmed);
 *  - one press is one checkout (a repeat reopens the same page; after payment
 *    it says so instead of opening another); abandon is proved by the press id;
 *  - the status page: awaiting payment -> payment processing (Stripe paid,
 *    webhook not yet) -> pending approval -> confirmed, nothing personal returned;
 *  - every field rule, the service area, the consent line, blocked people;
 *  - an existing account's email is not attached; linking happens only on a
 *    verified contact, never to the wrong account;
 *  - a guest Full Day, through its own availability and price;
 *  - photos are stored as for any booking; a failed upload leaves nothing held.
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-guest-checkout";
process.env.STRIPE_SECRET_KEY = "sk_test_fake_for_unit_tests";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_guest";
process.env.CLIENT_URL = "https://www.profixter.com";
process.env.SMS_ENABLED = "false";
process.env.S3_BUCKET = "test-bucket";
process.env.ENABLE_RESERVATION_ENGINE = "true";
process.env.STRIPE_PRICE_ONE_TIME_HANDYMAN_VISIT = "price_test_one_time";
process.env.STRIPE_PRICE_FULL_DAY_VISIT = "price_test_full_day";
process.env.MAIL_ADMIN = "owner@example.test";

const assert = require("assert");
const express = require("express");
const moment = require("moment-timezone");
const mongoose = require("mongoose");
const sharp = require("sharp");
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
    console.log(`FAIL  ${name}\n      ${error.stack?.split("\n").slice(0, 3).join("\n      ") || error.message}`);
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

async function main() {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(replSet.getUri());

  const s3 = require("../utils/s3");
  const uploads = [];
  let failUpload = false;
  s3.putPublicObject = async ({ Key }) => {
    if (failUpload) throw new Error("S3 down");
    uploads.push(Key);
    return `https://test-bucket.s3.amazonaws.com/${Key}`;
  };
  s3.deletePublicObjects = async () => ({ deleted: 0 });
  const mail = require("../utils/emailService");
  const emails = [];
  mail.sendRaw = async (msg) => (emails.push({ kind: "raw", ...msg }), { ok: true });
  mail.sendTx = async (key, to, data) => (emails.push({ kind: "tx", key, to, data }), { ok: true });
  mail.sendPromo = async (to, msg) => (emails.push({ kind: "promo", to, ...msg }), { ok: true });
  const metaSends = [];
  const passThrough = global.fetch;
  global.fetch = async (url, init) => {
    if (String(url).includes("graph.facebook.com")) {
      metaSends.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
    }
    return passThrough(url, init);
  };
  process.env.META_CAPI_TOKEN = "test-capi-token";

  const stripe = require("../utils/subscriptionManagement").stripe;
  const sessions = new Map();
  stripe.customers.list = async () => ({ data: [] });
  stripe.checkout.sessions.create = async (config) => {
    const id = `cs_test_guest${sessions.size + 1}abc`;
    const s = { id, object: "checkout.session", mode: "payment", status: "open", payment_status: "unpaid", url: `https://checkout.stripe.test/${id}`, metadata: config.metadata, client_reference_id: config.client_reference_id, config, customer: null, amount_total: 9900, currency: "usd" };
    sessions.set(id, s);
    return s;
  };
  stripe.checkout.sessions.retrieve = async (id) => {
    if (!sessions.has(id)) {
      const e = new Error("No such session");
      e.statusCode = 404;
      throw e;
    }
    return { ...sessions.get(id) };
  };
  stripe.checkout.sessions.expire = async (id) => {
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
  const Blacklist = require("../models/Blacklist");
  const StripeWebhookEvent = require("../models/StripeWebhookEvent");
  const { ensureVisitEntitlementIndexes } = require("../utils/visitEntitlementIndexSafety");
  const { _reset: resetRateLimits } = require("../utils/rateLimit");
  for (const M of [Booking, BookingSlotReservation, ReservationTimeBucket, ReservationCapacityBucket, SmsMessage, User, StripeWebhookEvent]) await M.init();
  await ensureVisitEntitlementIndexes({ logger: { log() {}, warn() {} } });

  for (const n of [1, 2]) {
    await User.create({ name: `Fixter ${n}`, email: `f${n}@fixter.local`, password: "x", phone: "+15550002222", userId: `8000000${n}`, role: "employee", employeePosition: "Fixter", isActive: true });
  }
  await CompanyAvailabilityTemplate.create({
    active: true, timezone: TZ, slotMinutes: 30, minLeadMinutes: 0, maxAdvanceDays: 120, defaultCapacity: 2, visitDurationMinutes: 90,
    weeklySchedule: Array.from({ length: 7 }, (_, weekday) => ({ weekday, enabled: weekday !== 0, starts: ["08:00", "10:00", "13:00"].map((time) => ({ time, capacity: null })), intervals: [{ startTime: "08:00", endTime: "17:00", capacity: null }] })),
  });

  const app = express();
  app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), require("../routes/webhook"));
  app.use(express.json());
  app.use("/api/bookings/guest", require("../routes/guestBookings"));
  app.use("/api/admin", require("../routes/adminJobs"));
  app.use("/api/bookings", require("../routes/bookings"));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const jwt = require("jsonwebtoken");
  const crypto = require("crypto");
  const owner = await User.create({ userId: "90000001", name: "Owner", email: "owner@example.test", role: "admin", password: "x" });
  const call = async (method, p, { form, body, as } = {}) => {
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
  const { GUEST_CHECKOUT_CONSENT_TEXT } = require("../routes/guestBookings");
  const photo = await sharp({ create: { width: 900, height: 672, channels: 3, background: "#7799bb" } }).jpeg().toBuffer();
  const formOf = (fields, { photos = 0 } = {}) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) form.append(k, String(v));
    for (let i = 0; i < photos; i++) form.append("images", new Blob([photo], { type: "image/jpeg" }), `p${i}.jpg`);
    return form;
  };
  const day = openDay(2);
  const guest = (extra = {}) => ({
    name: "Rosa Diaz",
    phone: "(516) 555-0177",
    email: "rosa@mailbox.org",
    line1: "40 Oak Ave",
    city: "Massapequa",
    state: "NY",
    zip: "11758",
    note: "Replace the kitchen faucet that leaks",
    selectedTask: "Replace faucet",
    requestedDate: day,
    requestedTime: "10:00",
    consentText: GUEST_CHECKOUT_CONSENT_TEXT,
    clientRequestId: "press-guest-0001",
    fbp: "fb.1.123.456",
    ...extra,
  });
  const hook = async (type, object) => {
    const payload = JSON.stringify({ id: `evt_${Math.random().toString(16).slice(2)}`, object: "event", type, data: { object } });
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
    const res = await fetch(`${base}/api/stripe/webhook`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": header }, body: payload });
    return res.status;
  };
  const pay = async (sessionId) => {
    const s = sessions.get(sessionId);
    s.status = "complete";
    s.payment_status = "paid";
    return s;
  };

  try {
    console.log("\nOne-Time Visit, no account");
    let first;
    await check("a guest opens a real checkout: held slot, no account, owner review pending", async () => {
      first = await call("POST", "/api/bookings/guest/one-time/checkout", { form: formOf(guest(), { photos: 1 }) });
      assert.strictEqual(first.status, 200, JSON.stringify(first.body));
      const b = await Booking.findById(first.body.bookingId).lean();
      assert.strictEqual(b.user, null);
      assert.strictEqual(b.guestCheckout, true);
      assert.strictEqual(b.status, "Pending");
      assert.strictEqual(b.paymentState, "pending");
      assert.strictEqual(b.bookingType, "one_time_handyman_visit");
      assert.strictEqual(b.zip, "11758");
      assert.strictEqual(b.phone, "+15165550177");
      assert.strictEqual(b.guestContactConsent.text, GUEST_CHECKOUT_CONSENT_TEXT);
      assert.strictEqual(b.images.length, 1, "the photo is stored with the booking");
      const reservation = await BookingSlotReservation.findById(b.slotReservationId).lean();
      assert.strictEqual(reservation.status, "held");
    });
    await check("Stripe gets the email, the booking and no account ids; the page expires with the hold", async () => {
      const s = sessions.get(first.body.url.split("/").pop());
      assert.strictEqual(s.config.customer_email, "rosa@mailbox.org");
      assert.strictEqual(s.config.metadata.guestCheckout, "true");
      assert.strictEqual(s.config.metadata.userMongoId, "");
      assert.strictEqual(s.config.metadata.productKind, "one_time_handyman_visit");
      assert.ok(s.config.success_url.includes("{CHECKOUT_SESSION_ID}"));
      assert.ok(s.config.cancel_url.includes("/book/handyman?canceled=1"));
      const b = await Booking.findById(first.body.bookingId).lean();
      assert.strictEqual(b.checkoutSessionId, s.id);
      assert.strictEqual(s.config.expires_at, Math.floor(new Date(b.paymentHoldExpiresAt).getTime() / 1000));
    });
    await check("the same press again reopens the same page - no second booking or hold", async () => {
      const again = await call("POST", "/api/bookings/guest/one-time/checkout", { form: formOf(guest(), { photos: 1 }) });
      assert.strictEqual(again.status, 200);
      assert.strictEqual(again.body.url, first.body.url);
      assert.strictEqual(again.body.reused, true);
      assert.strictEqual(await Booking.countDocuments({ guestCheckout: true }), 1);
    });
    const sessionId = () => first.body.url.split("/").pop();
    await check("status before paying: awaiting payment, nothing personal", async () => {
      const st = await call("GET", `/api/bookings/guest/status?session_id=${sessionId()}`);
      assert.strictEqual(st.status, 200);
      assert.deepStrictEqual(Object.keys(st.body).sort(), ["bookingNumber", "date", "guest", "kind", "status", "time"]);
      assert.deepStrictEqual([st.body.kind, st.body.status, st.body.date, st.body.time, st.body.guest], ["one_time", "awaiting_payment", day, "10:00", true]);
    });
    await check("status after Stripe says paid but before the webhook: payment processing, not success", async () => {
      await pay(sessionId());
      const st = await call("GET", `/api/bookings/guest/status?session_id=${sessionId()}`);
      assert.strictEqual(st.body.status, "payment_processing");
    });
    await check("the webhook records the payment: still Pending for the owner, reservation kept", async () => {
      const status = await hook("checkout.session.completed", sessions.get(sessionId()));
      assert.strictEqual(status, 200);
      const b = await Booking.findById(first.body.bookingId).lean();
      assert.strictEqual(b.paymentState, "paid");
      assert.strictEqual(b.status, "Pending", "a customer's paid visit is reviewed, never auto-confirmed");
      const reservation = await BookingSlotReservation.findById(b.slotReservationId).lean();
      assert.notStrictEqual(reservation.status, "released");
      const st = await call("GET", `/api/bookings/guest/status?session_id=${sessionId()}`);
      assert.strictEqual(st.body.status, "pending_approval");
    });
    await check("the guest is emailed at the booking's own address", async () => {
      for (let i = 0; i < 30 && !emails.some((e) => e.to === "rosa@mailbox.org"); i++) await new Promise((r) => setTimeout(r, 100));
      assert.ok(emails.some((e) => e.to === "rosa@mailbox.org"), JSON.stringify(emails.map((e) => [e.key, e.to])));
    });
    await check("Meta gets the server Purchase with hashed contact and no account id", async () => {
      for (let i = 0; i < 30 && !metaSends.some((m) => m.data?.[0]?.event_name === "Purchase"); i++) await new Promise((r) => setTimeout(r, 100));
      const ev = metaSends.find((m) => m.data?.[0]?.event_name === "Purchase")?.data[0];
      assert.ok(ev, "Purchase sent");
      assert.strictEqual(ev.event_id, `sess_${sessionId()}`);
      assert.ok(ev.user_data.em && ev.user_data.ph);
      assert.ok(!JSON.stringify(ev).includes("rosa@mailbox.org"));
    });
    await check("the same press after payment says it is paid instead of opening another checkout", async () => {
      const again = await call("POST", "/api/bookings/guest/one-time/checkout", { form: formOf(guest()) });
      assert.strictEqual(again.status, 200);
      assert.strictEqual(again.body.alreadyPaid, true);
      assert.strictEqual(again.body.sessionId, sessionId());
      assert.strictEqual(sessions.size, 1);
    });
    await check("the owner confirms it in Admin (the real Confirm): the guest is told, the status page says confirmed", async () => {
      const before = emails.length;
      const r = await call("POST", `/api/admin/jobs/${first.body.bookingId}/transition`, { as: owner, body: { action: "confirm", expectedStatus: "Pending", idempotencyKey: crypto.randomUUID() } });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body).slice(0, 400));
      const b = await Booking.findById(first.body.bookingId).lean();
      assert.strictEqual(b.status, "Confirmed");
      for (let i = 0; i < 30 && !emails.slice(before).some((e) => e.to === "rosa@mailbox.org"); i++) await new Promise((r2) => setTimeout(r2, 100));
      assert.ok(emails.slice(before).some((e) => e.to === "rosa@mailbox.org"), "the confirmation goes to the booking's own email");
      const st = await call("GET", `/api/bookings/guest/status?session_id=${sessionId()}`);
      assert.strictEqual(st.body.status, "confirmed");
    });
    await check("a made-up session is refused; an unknown one is not found", async () => {
      assert.strictEqual((await call("GET", "/api/bookings/guest/status?session_id=nope")).status, 400);
      assert.strictEqual((await call("GET", "/api/bookings/guest/status?session_id=cs_test_unknown123")).status, 404);
    });
    await check("texts about this visit are allowed by the consent it showed; nothing else is", async () => {
      const { checkEligibility } = require("../utils/sms/smsEligibility");
      const b = await Booking.findById(first.body.bookingId).lean();
      // Midday in New York, inside any send window.
      const noon = moment.tz(TZ).hour(12).minute(0).toDate();
      const ask = (notificationType, booking = b) => checkEligibility({ notificationType, booking, phone: booking.phone, now: noon });
      const ok = await ask("ONE_TIME_VISIT_CONFIRMED");
      assert.strictEqual(ok.eligible, true, JSON.stringify(ok));
      assert.strictEqual((await ask("BOOKING_REMINDER_24H")).eligible, true);
      assert.strictEqual((await ask("PAYMENT_LINK")).eligible, false, "a guest checkout never gets payment-link texts");
      const noConsent = { ...b, guestContactConsent: {} };
      assert.strictEqual((await ask("ONE_TIME_VISIT_CONFIRMED", noConsent)).eligible, false);
    });

    console.log("\nThe rules");
    resetRateLimits?.();
    const refused = async (extra, code, field) => {
      const r = await call("POST", "/api/bookings/guest/one-time/checkout", { form: formOf(guest({ clientRequestId: `press-${Math.random().toString(16).slice(2, 12)}`, ...extra })) });
      assert.strictEqual(r.body.code, code, JSON.stringify(r.body));
      if (field) assert.strictEqual(r.body.field, field);
      return r;
    };
    await check("no address: names the address field", async () => refused({ line1: "", city: "", zip: "" }, "INVALID_ADDRESS", "address"));
    await check("outside Nassau / Suffolk: refused by ZIP", async () => refused({ line1: "350 5th Ave", city: "New York", zip: "10118" }, "OUT_OF_SERVICE_AREA", "address"));
    await check("first and last name, a 10-digit phone, a real email", async () => {
      await refused({ name: "Rosa" }, "INVALID_NAME", "name");
      await refused({ phone: "555" }, "INVALID_PHONE", "phone");
      await refused({ email: "rosa@" }, "INVALID_EMAIL", "email");
    });
    await check("the job in a few words; the description itself never refuses a job", async () => {
      await refused({ note: "faucet" }, "TASK_REQUIRED", "task");
    });
    await check("the consent line must be the one the page showed", async () => refused({ consentText: "something else" }, "CONSENT_MISMATCH"));
    await check("nothing is held or stored for a refused request", async () => {
      assert.strictEqual(await Booking.countDocuments({ guestCheckout: true }), 1);
    });
    await check("a person Admin blocked is refused by email or phone", async () => {
      await Blacklist.create({ email: "blocked@mailbox.org", reason: "test", active: true }).catch(async () => Blacklist.create({ type: "email", value: "blocked@mailbox.org", reason: "test" }));
      const r = await call("POST", "/api/bookings/guest/one-time/checkout", { form: formOf(guest({ email: "blocked@mailbox.org", clientRequestId: "press-blocked-01" })) });
      assert.ok([403, 423, 451].includes(r.status) || /block/i.test(JSON.stringify(r.body)), `${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(await Booking.countDocuments({ email: "blocked@mailbox.org" }), 0);
    });
    resetRateLimits?.();
    await check("a time that is full is refused; everything else stays the page's", async () => {
      const t = "13:00";
      const one = await call("POST", "/api/bookings/guest/one-time/checkout", { form: formOf(guest({ requestedTime: t, clientRequestId: "press-full-0001", phone: "5165550101", email: "a1@mailbox.org" })) });
      const two = await call("POST", "/api/bookings/guest/one-time/checkout", { form: formOf(guest({ requestedTime: t, clientRequestId: "press-full-0002", phone: "5165550102", email: "a2@mailbox.org" })) });
      const three = await call("POST", "/api/bookings/guest/one-time/checkout", { form: formOf(guest({ requestedTime: t, clientRequestId: "press-full-0003", phone: "5165550103", email: "a3@mailbox.org" })) });
      assert.deepStrictEqual([one.status, two.status, three.status], [200, 200, 409], JSON.stringify([one.body, two.body, three.body]));
      assert.strictEqual(three.body.code, "SLOT_UNAVAILABLE");
    });
    await check("a photo that cannot be stored refuses the request and holds nothing", async () => {
      failUpload = true;
      const before = await BookingSlotReservation.countDocuments({ status: "held" });
      const r = await call("POST", "/api/bookings/guest/one-time/checkout", { form: formOf(guest({ requestedTime: "08:00", clientRequestId: "press-upload-01", phone: "5165550104", email: "a4@mailbox.org" }), { photos: 1 }) });
      failUpload = false;
      assert.strictEqual(r.status, 502);
      assert.deepStrictEqual([r.body.code, r.body.field], ["PHOTO_UPLOAD_FAILED", "photos"], "the page can offer to go on without photos");
      assert.strictEqual(await BookingSlotReservation.countDocuments({ status: "held" }), before);
      assert.strictEqual(await Booking.countDocuments({ email: "a4@mailbox.org", status: { $nin: ["Canceled"] } }), 0);
    });

    await check("a file that is not an image is refused as a photo problem, before anything is held", async () => {
      const form = formOf(guest({ requestedTime: "08:00", clientRequestId: "press-badphoto-1", phone: "5165550106", email: "a6@mailbox.org" }));
      form.append("images", new Blob([Buffer.from("%PDF-1.4 not an image")], { type: "image/jpeg" }), "fake.jpg");
      const r = await call("POST", "/api/bookings/guest/one-time/checkout", { form });
      assert.strictEqual(r.status, 400);
      assert.deepStrictEqual([r.body.code, r.body.field], ["PHOTO_REJECTED", "photos"]);
      assert.strictEqual(await Booking.countDocuments({ email: "a6@mailbox.org" }), 0);
    });

    console.log("\nAbandon");
    resetRateLimits?.();
    await check("abandon needs the press's own id; with it the page expires and the slot is freed", async () => {
      const open = await call("POST", "/api/bookings/guest/one-time/checkout", { form: formOf(guest({ requestedTime: "08:00", clientRequestId: "press-abandon-1", phone: "5165550105", email: "a5@mailbox.org" })) });
      assert.strictEqual(open.status, 200, JSON.stringify(open.body));
      assert.strictEqual((await call("POST", "/api/bookings/guest/abandon", { body: { bookingId: open.body.bookingId, clientRequestId: "press-someone-else" } })).status, 404);
      const ok = await call("POST", "/api/bookings/guest/abandon", { body: { bookingId: open.body.bookingId, clientRequestId: "press-abandon-1" } });
      assert.strictEqual(ok.body.released, true);
      const sid = open.body.url.split("/").pop();
      assert.strictEqual(sessions.get(sid).status, "expired");
      assert.strictEqual(await hook("checkout.session.expired", sessions.get(sid)), 200);
      const b = await Booking.findById(open.body.bookingId).lean();
      assert.ok(/cancel/i.test(b.status), b.status);
      const reservation = await BookingSlotReservation.findOne({ bookingId: b._id }).sort({ createdAt: -1 }).lean();
      assert.strictEqual(reservation.status, "released");
      const st = await call("GET", `/api/bookings/guest/status?session_id=${sid}`);
      assert.strictEqual(st.body.status, "not_completed");
    });

    console.log("\nAccounts");
    resetRateLimits?.();
    const { linkGuestFreeVisitIds } = require("../utils/freeVisit/guestLink");
    await check("an existing account with the same email is not attached at checkout", async () => {
      await User.create({ userId: "70000010", name: "Existing", email: "existing@mailbox.org", phone: "+15165550190", role: "customer", emailVerifiedAt: new Date() });
      const r = await call("POST", "/api/bookings/guest/one-time/checkout", { form: formOf(guest({ requestedTime: "08:00", requestedDate: openDay(3), clientRequestId: "press-existing-1", email: "existing@mailbox.org", phone: "5165550191" })) });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.deepStrictEqual(Object.keys(r.body).sort(), ["bookingId", "holdExpiresAt", "url"], "nothing says an account exists");
      const b = await Booking.findById(r.body.bookingId).lean();
      assert.strictEqual(b.user, null);
    });
    await check("an account that has NOT verified the phone does not get the visit", async () => {
      const u = await User.create({ userId: "70000011", name: "Rosa Diaz", email: "other@mailbox.org", phone: "+15165550177", role: "customer" });
      assert.deepStrictEqual(await linkGuestFreeVisitIds(u, { via: "sign_in" }), []);
      assert.strictEqual((await Booking.findById(first.body.bookingId).lean()).user, null);
      await User.deleteOne({ _id: u._id });
    });
    await check("signing in with the verified phone links the paid visit, recorded as a checkout link", async () => {
      const u = await User.create({ userId: "70000012", name: "Rosa Diaz", email: "rosa@mailbox.org", phone: "+15165550177", phoneVerifiedAt: new Date(), role: "customer" });
      const linked = await linkGuestFreeVisitIds(u, { via: "sign_in" });
      assert.ok(linked.map(String).includes(String(first.body.bookingId)));
      const b = await Booking.findById(first.body.bookingId).lean();
      assert.strictEqual(String(b.user), String(u._id));
      assert.strictEqual(String(b.guestCheckoutLink.userId), String(u._id));
      assert.strictEqual(b.guestCheckoutLink.linkedVia, "sign_in");
      assert.ok(!b.freeVisitIdentity?.linkedAt, "a paid visit is never marked as a free visit");
      assert.strictEqual(b.guestCheckout, true);
      const mine = await Booking.find({ user: u._id }).lean();
      assert.ok(mine.some((x) => String(x._id) === String(first.body.bookingId)), "it is in My Visits");
    });
    await check("a visit whose email belongs to a different account is not linked on a shared phone", async () => {
      const r = await call("POST", "/api/bookings/guest/one-time/checkout", { form: formOf(guest({ requestedTime: "10:00", requestedDate: openDay(4), clientRequestId: "press-shared-01", email: "existing@mailbox.org", phone: "5165550192" })) });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      const sharedPhoneUser = await User.create({ userId: "70000013", name: "Housemate", email: "housemate@mailbox.org", phone: "+15165550192", phoneVerifiedAt: new Date(), role: "customer" });
      const linked = await linkGuestFreeVisitIds(sharedPhoneUser, { via: "sign_in" });
      assert.ok(!linked.map(String).includes(String(r.body.bookingId)));
    });

    console.log("\nFull Day, no account");
    resetRateLimits?.();
    await check("a guest pays for a Full Day: held day, its own price, owner review after payment", async () => {
      let date = null;
      for (let n = 5; n < 20 && !date; n++) {
        const d = openDay(n);
        const av = await call("GET", `/api/bookings/full-day/availability?from=${d}&to=${d}`);
        if (av.body?.days?.[0]?.available) date = d;
      }
      assert.ok(date, "an available Full Day in the harness");
      const r = await call("POST", "/api/bookings/guest/full-day/checkout", { form: formOf(guest({ date, requestedDate: undefined, requestedTime: undefined, clientRequestId: "press-fullday-1", note: "Hang shelves, fix two doors and patch the hall", phone: "5165550120", email: "fd@mailbox.org" })) });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      const b = await Booking.findById(r.body.bookingId).lean();
      assert.deepStrictEqual([b.bookingType, b.user, b.guestCheckout, b.status], ["full_day_visit", null, true, "Pending"]);
      const s = sessions.get(r.body.url.split("/").pop());
      assert.strictEqual(s.config.line_items[0].price, "price_test_full_day");
      assert.ok(s.config.cancel_url.includes("visit=full-day"));
      await pay(s.id);
      assert.strictEqual(await hook("checkout.session.completed", { ...sessions.get(s.id), amount_total: 49900 }), 200);
      const paid = await Booking.findById(r.body.bookingId).lean();
      assert.strictEqual(paid.paymentState, "paid");
      assert.notStrictEqual(paid.status, "Confirmed");
      const st = await call("GET", `/api/bookings/guest/status?session_id=${s.id}`);
      assert.deepStrictEqual([st.body.kind, st.body.status, st.body.time], ["full_day", "pending_approval", null]);
    });
    await check("a Full Day with no list is refused before anything is held", async () => {
      const r = await call("POST", "/api/bookings/guest/full-day/checkout", { form: formOf(guest({ date: openDay(6), note: "", clientRequestId: "press-fullday-2", phone: "5165550121", email: "fd2@mailbox.org" })) });
      assert.strictEqual(r.body.code, "TASK_REQUIRED", JSON.stringify(r.body));
    });
  } finally {
    server.close();
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
