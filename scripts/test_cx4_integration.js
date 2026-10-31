/*
 * Customer Experience 4.0 (2026-10-30), end to end against a real database
 * (in-memory replica set, reservation engine ON as in production):
 *
 *  - the new Free Visit: account-free, address required and served, description
 *    optional, a real reserved slot, pending the owner, labelled a to-do-list
 *    visit, and messages that never promise labor or call it confirmed;
 *  - an old page's request (no formVersion) keeps the old rules and label;
 *  - Request a Callback: a lead, deduplicated, nothing booked;
 *  - What We Do: Admin before/after pairs, the public pair filter, the seed
 *    script (dry run, idempotent, unpublish with backup, restore);
 *  - One-Time checkout: photos optional, a retried press reopens the same
 *    checkout, abandon releases the slot through the expiry path, cancel
 *    returns to the handyman flow.
 *
 * Stripe, S3 and email are faked; SMS is rendered and recorded, never sent.
 *
 *   node scripts/test_cx4_integration.js
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-cx4";
process.env.STRIPE_SECRET_KEY = "sk_test_fake_for_unit_tests";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_cx4";
process.env.CLIENT_URL = "https://www.profixter.com";
process.env.SMS_ENABLED = "false";
process.env.S3_BUCKET = "test-bucket";
process.env.ENABLE_RESERVATION_ENGINE = "true";
process.env.STRIPE_PRICE_ONE_TIME_HANDYMAN_VISIT = "price_test_one_time";
process.env.MAIL_ADMIN = "owner@example.test";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const express = require("express");
const jwt = require("jsonwebtoken");
const moment = require("moment-timezone");
const mongoose = require("mongoose");
const sharp = require("sharp");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const TZ = "America/New_York";
const CONSENT = "By booking, you agree to be contacted by call or text about your visit. Msg & data rates may apply.";
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
  const uri = replSet.getUri();
  await mongoose.connect(uri);

  const s3 = require("../utils/s3");
  const uploads = [];
  s3.putPublicObject = async ({ Key }) => (uploads.push(Key), `https://test-bucket.s3.amazonaws.com/${Key}`);
  s3.deletePublicObjects = async () => ({ deleted: 0 });
  const mail = require("../utils/emailService");
  const emails = [];
  mail.sendRaw = async (msg) => (emails.push({ kind: "raw", ...msg }), { ok: true });
  mail.sendTx = async (key, to, data) => (emails.push({ kind: "tx", key, to, data }), { ok: true });
  mail.sendPromo = async (to, msg) => (emails.push({ kind: "promo", to, ...msg }), { ok: true });
  const passThrough = global.fetch;
  global.fetch = async (url, init) => (String(url).includes("graph.facebook.com") ? { ok: true, json: async () => ({}), text: async () => "" } : passThrough(url, init));

  const stripe = require("../utils/subscriptionManagement").stripe;
  const sessions = new Map();
  stripe.customers.list = async () => ({ data: [] });
  stripe.checkout.sessions.create = async (config) => {
    const id = `cs_test_${sessions.size + 1}`;
    const s = { id, status: "open", url: `https://checkout.stripe.test/${id}`, metadata: config.metadata, config, customer: null };
    sessions.set(id, s);
    return s;
  };
  stripe.checkout.sessions.retrieve = async (id) => ({ ...sessions.get(id) });
  stripe.checkout.sessions.expire = async (id) => {
    sessions.get(id).status = "expired";
    return sessions.get(id);
  };

  const Booking = require("../models/Booking");
  const BookingSlotReservation = require("../models/BookingSlotReservation");
  const ReservationTimeBucket = require("../models/ReservationTimeBucket");
  const ReservationCapacityBucket = require("../models/ReservationCapacityBucket");
  const CompanyAvailabilityTemplate = require("../models/CompanyAvailabilityTemplate");
  const Request = require("../models/Request");
  const SmsMessage = require("../models/SmsMessage");
  const User = require("../models/User");
  const WorkPhoto = require("../models/WorkPhoto");
  const VisitEntitlement = require("../models/VisitEntitlement");
  const StripeWebhookEvent = require("../models/StripeWebhookEvent");
  const { ensureVisitEntitlementIndexes } = require("../utils/visitEntitlementIndexSafety");
  const { _reset: resetRateLimits } = require("../utils/rateLimit");
  for (const M of [Booking, BookingSlotReservation, ReservationTimeBucket, ReservationCapacityBucket, Request, SmsMessage, User, WorkPhoto, StripeWebhookEvent]) await M.init();
  await ensureVisitEntitlementIndexes({ logger: { log() {}, warn() {} } });

  const fixters = [];
  for (const n of [1, 2]) {
    fixters.push(await User.create({ name: `Fixter ${n}`, email: `f${n}@fixter.local`, password: "x", phone: "+15550002222", userId: `8000000${n}`, role: "employee", employeePosition: "Fixter", isActive: true }));
  }
  await CompanyAvailabilityTemplate.create({
    active: true, timezone: TZ, slotMinutes: 30, minLeadMinutes: 0, maxAdvanceDays: 120, defaultCapacity: 2, visitDurationMinutes: 90,
    weeklySchedule: Array.from({ length: 7 }, (_, weekday) => ({ weekday, enabled: weekday !== 0, starts: ["08:00", "10:00", "13:00"].map((time) => ({ time, capacity: null })), intervals: [{ startTime: "08:00", endTime: "16:00", capacity: null }] })),
  });
  const owner = await User.create({ userId: "90000001", name: "Owner", email: "owner@example.test", role: "admin", password: "x" });

  const app = express();
  app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), require("../routes/webhook"));
  app.use(express.json());
  app.use("/api/free-visit-requests", require("../routes/freeVisitRequests"));
  app.use("/api/requests", require("../routes/requests"));
  app.use("/api/bookings", require("../routes/bookings"));
  app.use("/api/calendar", require("../routes/calendar"));
  app.use("/api/recent-work", require("../routes/recentWork"));
  app.use("/api/admin/recent-work", require("../routes/adminRecentWork"));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = (u) => jwt.sign({ id: String(u._id), tv: 0 }, process.env.JWT_SECRET);
  const call = async (method, p, { body, form, as } = {}) => {
    const headers = as ? { authorization: `Bearer ${token(as)}` } : {};
    let payload;
    if (form) payload = form;
    else if (body) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${base}${p}`, { method, headers, body: payload });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const freeVisitForm = (fields) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) form.append(k, String(v));
    return form;
  };
  const photo = await sharp({ create: { width: 900, height: 672, channels: 3, background: "#7799bb" } }).jpeg().toBuffer();

  try {
    /* ============================ Free Visit ============================ */
    console.log("\nThe new Free Visit");
    const day = openDay(2);
    const good = { formVersion: "cx4", name: "Dana Lopez", phone: "516-555-0123", email: "dana@mailbox.org", line1: "12 Elm St", city: "Farmingdale", state: "NY", zip: "11735", requestedDate: day, requestedTime: "10:00", consentText: CONSENT, eventId: "evt-cx4-1" };
    let fv;
    await check("books without an account, description optional, address required", async () => {
      const res = await call("POST", "/api/free-visit-requests", { form: freeVisitForm(good) });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      fv = await Booking.findOne({ email: "dana@mailbox.org" });
      assert.ok(fv && !fv.user, "a guest booking, no account");
    });
    await check("a real reserved slot, pending the owner, labelled a to-do-list visit", async () => {
      assert.strictEqual(fv.status, "Pending Confirmation");
      assert.ok(fv.slotReservationId);
      const reservation = await BookingSlotReservation.findById(fv.slotReservationId);
      assert.ok(reservation && reservation.status !== "released");
      assert.strictEqual(fv.service, "Free Visit");
      assert.strictEqual(fv.freeVisitPurpose, "consultation");
      assert.strictEqual(fv.accessType, "free_first_visit");
      assert.strictEqual(fv.address, "12 Elm St");
      assert.strictEqual(fv.zip, "11735");
      assert.ok(fv.freeVisitIdentity.addressKey, "the address counts in the lifetime rule");
    });
    await check("the customer is told it is reserved and pending - never confirmed, never labor", async () => {
      for (let i = 0; i < 40 && !emails.find((e) => e.to === "dana@mailbox.org"); i++) await new Promise((r) => setTimeout(r, 100));
      const mailToGuest = emails.find((e) => e.to === "dana@mailbox.org");
      assert.ok(mailToGuest, "request email sent");
      assert.ok(/reserved/.test(mailToGuest.text) && /confirm it with you shortly/.test(mailToGuest.text));
      assert.ok(/aren't part of this visit/.test(mailToGuest.text));
      assert.ok(!/90 minutes|real work|is confirmed/i.test(mailToGuest.text));
      const sms = await SmsMessage.findOne({ notificationType: "FREE_VISIT_REQUEST_RECEIVED", toPhone: "+15165550123" }).lean();
      assert.ok(sms && /reserved your Free Visit/.test(sms.body) && /confirm it shortly/.test(sms.body), sms?.body);
      assert.ok(!/confirmed/i.test(sms.body));
    });
    await check("the owner is told it is a to-do-list visit with no labor, with the address", async () => {
      const ownerMail = emails.find((e) => e.to === "owner@example.test" || /free visit request/i.test(e.subject || ""));
      assert.ok(ownerMail, "owner email");
      const body = `${ownerMail.text || ""}${ownerMail.html || ""}`;
      assert.ok(/no labor/.test(body) && /12 Elm St/.test(body), body.slice(0, 300));
    });
    await check("the same press again is one booking", async () => {
      const res = await call("POST", "/api/free-visit-requests", { form: freeVisitForm(good) });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.duplicate, true);
      assert.strictEqual(await Booking.countDocuments({ email: "dana@mailbox.org" }), 1);
    });
    await check("an address we don't serve is refused before anything is reserved", async () => {
      resetRateLimits?.();
      const before = await Booking.countDocuments();
      const res = await call("POST", "/api/free-visit-requests", { form: freeVisitForm({ ...good, eventId: "evt-cx4-ny", email: "ny@mailbox.org", phone: "516-555-0124", line1: "350 5th Ave", city: "New York", zip: "10118" }) });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, "OUT_OF_SERVICE_AREA");
      assert.strictEqual(await Booking.countDocuments(), before);
    });
    await check("a missing address is refused", async () => {
      const res = await call("POST", "/api/free-visit-requests", { form: freeVisitForm({ ...good, eventId: "evt-cx4-noaddr", line1: "", phone: "516-555-0125", email: "na@mailbox.org" }) });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, "INVALID_ADDRESS");
    });
    await check("the lifetime rule still blocks a second free visit for the same person", async () => {
      const res = await call("POST", "/api/free-visit-requests", { form: freeVisitForm({ ...good, eventId: "evt-cx4-again", requestedDate: openDay(4) }) });
      assert.strictEqual(res.status, 403, JSON.stringify(res.body));
      assert.strictEqual(res.body.code, "FREE_VISIT_ACTIVE");
    });
    await check("a page loaded before the change keeps the old rules and label (no silent change)", async () => {
      const legacy = { name: "Old Page", phone: "516-555-0126", email: "old@mailbox.org", note: "Fix the door please", requestedDate: openDay(3), requestedTime: "13:00", consentText: CONSENT, eventId: "evt-legacy" };
      const res = await call("POST", "/api/free-visit-requests", { form: freeVisitForm(legacy) });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      const b = await Booking.findOne({ email: "old@mailbox.org" });
      assert.strictEqual(b.service, "Labor Only");
      assert.strictEqual(b.freeVisitPurpose, "");
      const noNote = await call("POST", "/api/free-visit-requests", { form: freeVisitForm({ ...legacy, note: "", eventId: "evt-legacy-2", phone: "516-555-0127", email: "old2@mailbox.org" }) });
      assert.strictEqual(noNote.status, 400, "the old form still needs its description");
    });
    await check("texts name the visit by what it is", async () => {
      const t = require("../utils/sms/smsTemplates");
      const consultation = t.renderSms("FREE_VISIT_CONFIRMED", { booking: { accessType: "free_first_visit", freeVisitPurpose: "consultation", date: new Date() } });
      const legacy = t.renderSms("FREE_VISIT_CONFIRMED", { booking: { accessType: "free_first_visit", date: new Date() } });
      assert.ok(/your Free Visit is confirmed/.test(consultation) && /to-do list/.test(consultation));
      assert.ok(/free first visit is confirmed/.test(legacy) && /no charge for this visit/.test(legacy));
      assert.ok(!/labor/i.test(t.renderSms("FREE_VISIT_REMINDER", {})));
    });

    /* ============================ Callback ============================ */
    console.log("\nRequest a Callback");
    await check("creates one lead marked as a callback, books nothing", async () => {
      const bookings = await Booking.countDocuments();
      const res = await call("POST", "/api/requests/callback", { body: { name: "Kim Park", phone: "631-555-0199", email: "kim@mailbox.org", requestedDate: day, requestedTime: "13:00", address: "5 Oak Rd, Babylon, NY 11702", note: "Is drywall something you do?" } });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      const lead = await Request.findOne({ serviceType: "callback_request" }).lean();
      assert.ok(lead && lead.phone === "+16315550199" && lead.status === "new");
      assert.ok(/callback/i.test(lead.message) && /5 Oak Rd/.test(lead.message));
      assert.strictEqual(await Booking.countDocuments(), bookings);
      assert.ok(emails.some((e) => /CALLBACK REQUESTED/.test(e.subject || "")));
    });
    await check("repeated taps make one lead", async () => {
      const again = await call("POST", "/api/requests/callback", { body: { name: "Kim Park", phone: "6315550199" } });
      assert.strictEqual(again.status, 200);
      assert.strictEqual(again.body.duplicate, true);
      assert.strictEqual(await Request.countDocuments({ serviceType: "callback_request" }), 1);
    });
    await check("a callback needs a real phone", async () => {
      const res = await call("POST", "/api/requests/callback", { body: { name: "Kim", phone: "12" } });
      assert.strictEqual(res.status, 400);
    });

    /* ============================ What We Do ============================ */
    console.log("\nWhat We Do");
    await check("Admin uploads a before/after pair; it is public with both images", async () => {
      const form = new FormData();
      form.append("before", new Blob([photo], { type: "image/jpeg" }), "before.jpg");
      form.append("after", new Blob([photo], { type: "image/jpeg" }), "after.jpg");
      form.append("title", "Faucet swap");
      form.append("caption", "Old faucet replaced.");
      form.append("group", "Bathroom");
      form.append("illustrative", "true");
      form.append("publishNow", "true");
      const res = await call("POST", "/api/admin/recent-work/pair", { form, as: owner });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      const list = await call("GET", "/api/recent-work?kind=before_after");
      const item = list.body.photos.find((p) => p.title === "Faucet swap");
      assert.ok(item && item.kind === "before_after" && item.illustrative === true && item.group === "Bathroom");
      assert.ok(item.beforeImageUrl && item.imageUrl && item.beforeImageUrl !== item.imageUrl);
    });
    await check("a pair needs both images", async () => {
      const form = new FormData();
      form.append("after", new Blob([photo], { type: "image/jpeg" }), "after.jpg");
      const res = await call("POST", "/api/admin/recent-work/pair", { form, as: owner });
      assert.strictEqual(res.status, 400);
    });
    await check("the seed script: dry run writes nothing; run creates pairs and unpublishes old photos with a backup; re-run is a no-op; restore puts them back", async () => {
      await WorkPhoto.create({ title: "Old job", status: "published", publishedAt: new Date(), uploaderType: "admin", thumb: { url: "u" }, display: { url: "u" }, full: { url: "u" } });
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wwd-"));
      const manifest = [{ slug: "outlet", title: "Outlet replacement", category: "Electrical", caption: "Old outlet replaced." }, { slug: "tub-caulk", title: "Tub re-caulking", category: "Bathroom", caption: "Fresh caulk." }];
      fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
      const webp = await sharp(photo).webp().toBuffer();
      for (const m of manifest) for (const side of ["before", "after"]) fs.writeFileSync(path.join(dir, `${m.slug}-${side}.webp`), webp);
      const backup = path.join(dir, "backup.json");
      const env = { ...process.env, MONGO_URI: uri, NODE_OPTIONS: `--require ${path.join(__dirname, "fixtures", "fake_s3_preload.js")}` };
      const script = path.join(__dirname, "ops", "seed_what_we_do.js");
      const dry = execFileSync("node", [script, dir], { env }).toString();
      assert.ok(/DRY RUN/.test(dry));
      assert.strictEqual(await WorkPhoto.countDocuments({ internalNote: /^cx4-seed:/ }), 0);
      execFileSync("node", [script, dir, "--backup", backup, "--confirm"], { env });
      const seeded = await WorkPhoto.find({ internalNote: /^cx4-seed:/ }).lean();
      assert.strictEqual(seeded.length, 2);
      assert.ok(seeded.every((p) => p.status === "published" && p.kind === "before_after" && p.illustrative));
      assert.strictEqual((await WorkPhoto.findOne({ title: "Old job" })).status, "library");
      assert.ok(JSON.parse(fs.readFileSync(backup, "utf8")).photos.some((p) => p.title === "Old job"));
      execFileSync("node", [script, dir, "--backup", path.join(dir, "b2.json"), "--confirm"], { env });
      assert.strictEqual(await WorkPhoto.countDocuments({ internalNote: /^cx4-seed:/ }), 2, "idempotent");
      execFileSync("node", [script, "--restore", backup, "--confirm"], { env });
      assert.strictEqual((await WorkPhoto.findOne({ title: "Old job" })).status, "published");
    });

    /* ============================ One-Time ============================ */
    console.log("\nOne-Time checkout");
    const customer = await User.create({ userId: "70000001", name: "Rob Lane", email: "rob@mailbox.org", phone: "+15165550150", role: "customer", addresses: [{ line1: "9 Pine Ct", city: "Farmingdale", state: "NY", zip: "11735" }] });
    const oneTimeForm = (extra = {}) => freeVisitForm({ addressId: String(customer.addresses[0]._id), selectedTask: "Mount TV", note: "Mount a TV on drywall", requestedDate: openDay(5), requestedTime: "10:00", returnTo: "handyman", ...extra });
    let first;
    await check("books without a photo (the owner reviews every request)", async () => {
      first = await call("POST", "/api/bookings/one-time/checkout", { form: oneTimeForm({ clientRequestId: "press-abc12345" }), as: customer });
      assert.strictEqual(first.status, 200, JSON.stringify(first.body));
      assert.ok(first.body.url);
    });
    await check("a retried press reopens the same checkout - no second hold", async () => {
      const again = await call("POST", "/api/bookings/one-time/checkout", { form: oneTimeForm({ clientRequestId: "press-abc12345" }), as: customer });
      assert.strictEqual(again.status, 200);
      assert.strictEqual(again.body.reused, true);
      assert.strictEqual(again.body.url, first.body.url);
      assert.strictEqual(await Booking.countDocuments({ user: customer._id }), 1);
    });
    await check("cancel returns to the handyman flow with the booking id", async () => {
      const session = sessions.get(first.body.url.split("/").pop());
      assert.strictEqual(session.config.cancel_url, `https://www.profixter.com/book/handyman?canceled=1&booking_id=${first.body.bookingId}`);
    });
    await check("abandon expires the Stripe page; the expiry webhook frees the slot", async () => {
      const res = await call("POST", `/api/bookings/one-time/${first.body.bookingId}/abandon`, { as: customer });
      assert.strictEqual(res.status, 200);
      const sessionId = first.body.url.split("/").pop();
      assert.strictEqual(sessions.get(sessionId).status, "expired");
      const payload = JSON.stringify({ id: "evt_exp_1", object: "event", type: "checkout.session.expired", data: { object: { id: sessionId, object: "checkout.session", mode: "payment", status: "expired", metadata: sessions.get(sessionId).metadata, client_reference_id: first.body.bookingId } } });
      const header = stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
      const hook = await fetch(`${base}/api/stripe/webhook`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": header }, body: payload });
      assert.strictEqual(hook.status, 200);
      const b = await Booking.findById(first.body.bookingId);
      assert.ok(/cancel/i.test(b.status) && b.paymentState === "expired", `${b.status}/${b.paymentState}`);
      const reservation = await BookingSlotReservation.findOne({ bookingId: b._id }).sort({ createdAt: -1 });
      assert.strictEqual(reservation.status, "released");
    });
    await check("someone else cannot abandon your booking", async () => {
      const other = await User.create({ userId: "70000002", name: "Eve", email: "eve@mailbox.org", phone: "+15165550151", role: "customer" });
      const res = await call("POST", `/api/bookings/one-time/${first.body.bookingId}/abandon`, { as: other });
      assert.strictEqual(res.status, 404);
    });

    /* ======================= Sign-in hold (Book a Handyman) ======================= */
    console.log("\nSign-in hold");
    const ReservationTimeBucketModel = require("../models/ReservationTimeBucket");
    const holdDay = openDay(7);
    let holdToken;
    await check("a time is held for a customer who is signing in (no account, no booking)", async () => {
      const res = await call("POST", "/api/bookings/hold", { body: { requestedDate: holdDay, requestedTime: "13:00" } });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.ok(res.body.held && /^[a-f0-9]{24}\.[A-Za-z0-9_-]{20,}$/.test(res.body.token));
      holdToken = res.body.token;
      const hold = await BookingSlotReservation.findById(holdToken.split(".")[0]).lean();
      assert.ok(hold.signInHold && hold.status === "held" && hold.holdExpiresAt > new Date());
      assert.ok(!(await Booking.exists({ _id: hold.bookingId })), "no booking exists for it");
      const minutes = (new Date(hold.holdExpiresAt) - Date.now()) / 60000;
      assert.ok(minutes > 19 && minutes <= 20, `${minutes}`);
    });
    const otherA = await User.create({ userId: "70000011", name: "Ana Other", email: "ana@mailbox.org", phone: "+15165550161", role: "customer", addresses: [{ line1: "1 Oak St", city: "Farmingdale", state: "NY", zip: "11735" }] });
    const otherB = await User.create({ userId: "70000012", name: "Ben Other", email: "ben@mailbox.org", phone: "+15165550162", role: "customer", addresses: [{ line1: "2 Oak St", city: "Farmingdale", state: "NY", zip: "11735" }] });
    const holder = await User.create({ userId: "70000013", name: "Hal Holder", email: "hal@mailbox.org", phone: "+15165550163", role: "customer", addresses: [{ line1: "3 Oak St", city: "Farmingdale", state: "NY", zip: "11735" }] });
    const checkoutFor = (u, extra = {}) => freeVisitForm({ addressId: String(u.addresses[0]._id), selectedTask: "Fix door", note: "Fix a sticking door", requestedDate: holdDay, requestedTime: "13:00", ...extra });
    await check("the calendar counts the hold as a taken seat, exactly like a booking", async () => {
      const day = await call("GET", `/api/calendar/slots?date=${holdDay}`);
      assert.strictEqual(day.status, 200, JSON.stringify(day.body).slice(0, 200));
      assert.strictEqual(day.body.taken["13:00"], 1, JSON.stringify(day.body.taken));
      assert.strictEqual(day.body.remaining["13:00"], day.body.remaining["08:00"] - 1, JSON.stringify(day.body.remaining));
    });
    await check("the hold blocks the time for everyone else (one booking per start time here)", async () => {
      const a = await call("POST", "/api/bookings/one-time/checkout", { form: checkoutFor(otherA), as: otherA });
      assert.strictEqual(a.status, 409, JSON.stringify(a.body));
      assert.strictEqual(a.body.code, "SLOT_UNAVAILABLE");
      assert.strictEqual(await Booking.countDocuments({ user: otherA._id, status: { $nin: ["Canceled", "Cancelled"] } }), 0, "nothing left behind");
    });
    await check("the holder's own checkout takes the held time; the hold is gone, nothing double-booked", async () => {
      const own = await call("POST", "/api/bookings/one-time/checkout", { form: checkoutFor(holder, { holdToken }), as: holder });
      assert.strictEqual(own.status, 200, JSON.stringify(own.body));
      const hold = await BookingSlotReservation.findById(holdToken.split(".")[0]).lean();
      assert.strictEqual(hold.status, "released");
      assert.strictEqual(await ReservationTimeBucketModel.countDocuments({ reservationId: hold._id }), 0);
      const active = await BookingSlotReservation.find({ slotStart: hold.slotStart, status: { $in: ["held", "reserved"] }, $or: [{ holdExpiresAt: null }, { holdExpiresAt: { $gt: new Date() } }] }).lean();
      assert.strictEqual(active.length, 1, "only the holder's booking holds the time");
      assert.ok(!active[0].signInHold);
      const after = await call("POST", "/api/bookings/one-time/checkout", { form: checkoutFor(otherB), as: otherB });
      assert.strictEqual(after.status, 409, "still exactly one booking at that time");
    });
    let moving;
    await check("the same token extends; a new time moves the hold and frees the old one", async () => {
      const first = await call("POST", "/api/bookings/hold", { body: { requestedDate: holdDay, requestedTime: "08:00" } });
      moving = first.body.token;
      const again = await call("POST", "/api/bookings/hold", { body: { requestedDate: holdDay, requestedTime: "08:00", token: moving } });
      assert.strictEqual(again.body.token, moving, "same slot, same hold");
      const moved = await call("POST", "/api/bookings/hold", { body: { requestedDate: holdDay, requestedTime: "10:00", token: moving } });
      assert.notStrictEqual(moved.body.token, moving);
      assert.strictEqual((await BookingSlotReservation.findById(moving.split(".")[0]).lean()).status, "released");
      moving = moved.body.token;
    });
    await check("a forged token cannot release someone's hold", async () => {
      const id = moving.split(".")[0];
      const res = await call("POST", "/api/bookings/hold/release", { body: { token: `${id}.AAAAAAAAAAAAAAAAAAAAAAAAAAAA` } });
      assert.strictEqual(res.body.released, false);
      assert.strictEqual((await BookingSlotReservation.findById(id).lean()).status, "held");
    });
    await check("abandoned: an expired hold stops blocking at once and is cleaned up by the next reservation", async () => {
      const id = moving.split(".")[0];
      const blocked = await call("POST", "/api/bookings/one-time/checkout", { form: checkoutFor(otherB, { requestedTime: "10:00" }), as: otherB });
      assert.strictEqual(blocked.status, 409, "held: refused");
      await BookingSlotReservation.updateOne({ _id: id }, { $set: { holdExpiresAt: new Date(Date.now() - 1000) } });
      const freed = await call("POST", "/api/bookings/one-time/checkout", { form: checkoutFor(otherB, { requestedTime: "10:00" }), as: otherB });
      assert.strictEqual(freed.status, 200, "expired: the time is free again " + JSON.stringify(freed.body));
      const expired = await BookingSlotReservation.findById(id).lean();
      assert.strictEqual(expired.status, "released");
      assert.strictEqual(await ReservationTimeBucketModel.countDocuments({ reservationId: expired._id }), 0);
    });
    await check("release endpoint frees a live hold; a past or bad time is refused", async () => {
      const h = await call("POST", "/api/bookings/hold", { body: { requestedDate: openDay(8), requestedTime: "08:00" } });
      const r = await call("POST", "/api/bookings/hold/release", { body: { token: h.body.token } });
      assert.strictEqual(r.body.released, true);
      const bad = await call("POST", "/api/bookings/hold", { body: { requestedDate: "2020-01-01", requestedTime: "08:00" } });
      assert.strictEqual(bad.status, 400);
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
