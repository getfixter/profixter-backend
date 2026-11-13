/*
 * The Jobs API and the record scope (Admin redesign, 2026-11-12).
 *
 * Real routes and middleware, in-memory MongoDB replica set, reservation
 * engine ON as in production. Outgoing email is recorded, not sent; SMS is
 * rendered and recorded but never sent (SMS_ENABLED=false); S3 is faked;
 * Stripe is never called (refunds would throw). Nothing leaves the machine.
 *
 * What it pins (audit IDs):
 *  U-3/J-01  a field Fixter reads and changes only their own jobs, on every
 *            endpoint; cannot review free visits or create visits; a General
 *            Fixter and the owner still can
 *  U-7/J-04  stale confirm -> 409 STALE; two simultaneous confirms -> one wins,
 *            one confirmation email; idempotent replay sends nothing again
 *  J-03/J-05 legacy route keeps the allow-list (Canceled -> Confirmed refused),
 *            completion side effects once, reinstate re-reserves and is silent
 *            by default
 *  J-06/J-07 note-only edits never reassign or text; the old form's default
 *            Fixter pre-fill is ignored; a stale draft cannot drop the
 *            customer's added text
 *  J-09      reschedule returns per-channel results, including a failure
 *  J-10/Q-9  admin cancel restores an included Full Day, reports payment,
 *            never refunds
 *  J-11/Q-2  an owner-created free visit starts Confirmed and is reminder-eligible
 *  needs action counts = the list's needs_action view = jobs counts
 *  J-21      disabling reports future jobs; one-step reassignment
 *
 *   node scripts/test_admin_jobs_integration.js
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-admin-jobs";
process.env.STRIPE_SECRET_KEY = "sk_test_fake_for_unit_tests";
process.env.CLIENT_URL = "https://www.profixter.com";
process.env.SMS_ENABLED = "false";
process.env.S3_BUCKET = "test-bucket";
process.env.AWS_REGION = "us-east-1";
process.env.ENABLE_RESERVATION_ENGINE = "true";
process.env.MAIL_ADMIN = "owner@example.test";

const assert = require("assert");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const moment = require("moment-timezone");

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
stub("../utils/s3", {
  async putPublicObject({ Key }) {
    return `https://test-bucket.s3.amazonaws.com/${Key}`;
  },
  async deletePublicObjects() {
    return { deleted: 0 };
  },
});
const sentEmails = [];
const failTemplates = new Set();
const realMail = require("../utils/emailService");
stub("../utils/emailService", {
  ...realMail,
  async sendTx(templateKey, to, vars) {
    if (failTemplates.has(templateKey)) throw new Error("SES is down (test)");
    sentEmails.push({ templateKey, to, vars });
    return { messageId: `fake-${sentEmails.length}` };
  },
  async sendRaw({ to, subject, logContext = {} }) {
    sentEmails.push({ templateKey: logContext.templateKey || "raw", to, subject });
    return { messageId: `fake-${sentEmails.length}` };
  },
  async sendPromo(to, { subject, logContext = {} }) {
    sentEmails.push({ templateKey: logContext.templateKey || "promo", to, subject });
    return { messageId: `fake-${sentEmails.length}` };
  },
});

const { MongoMemoryReplSet } = require("mongodb-memory-server");
const subsModule = require("../utils/subscriptionManagement");
const User = require("../models/User");
const Booking = require("../models/Booking");
const SmsMessage = require("../models/SmsMessage");
const AdminActivityLog = require("../models/AdminActivityLog");
const VisitEntitlement = require("../models/VisitEntitlement");
const BookingSlotReservation = require("../models/BookingSlotReservation");
const ReservationTimeBucket = require("../models/ReservationTimeBucket");
const ReservationCapacityBucket = require("../models/ReservationCapacityBucket");
const AdminIdempotencyRecord = require("../models/AdminIdempotencyRecord");
const CompanyAvailabilityTemplate = require("../models/CompanyAvailabilityTemplate");
const { createBookingWithReservation } = require("../utils/slotReservationService");
const { evaluate24HourReminder } = require("../utils/bookingReminderPolicy");

// Refunds stay in Stripe (Q-9): any attempt to refund fails the suite.
subsModule.stripe.refunds = { create: async () => { throw new Error("refunds must never be created from Admin"); } };

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

let server;
let baseUrl;
const tokenFor = (user) => jwt.sign({ id: String(user._id), tv: Number(user.tokenVersion || 0) }, process.env.JWT_SECRET);
async function call(user, method, path, body, { form } = {}) {
  const headers = user ? { authorization: `Bearer ${tokenFor(user)}` } : {};
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: payload });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
let keySeq = 0;
const key = () => `test-key-${Date.now()}-${++keySeq}`;

function openDay(daysAhead) {
  const d = moment.tz(TZ).add(daysAhead, "days");
  while (d.day() === 0) d.add(1, "day");
  return d.format("YYYY-MM-DD");
}
const at = (day, time) => moment.tz(`${day} ${time}`, "YYYY-MM-DD HH:mm", TZ).toDate();

let seq = 0;
async function makeStaff(name, extra = {}) {
  return User.create({
    name,
    email: `${name.toLowerCase().replace(/\s+/g, ".")}@fixter.local`,
    password: "hashed",
    phone: `+1555000${String(1000 + ++seq)}`,
    userId: String(20000000 + seq),
    role: "employee",
    employeePosition: "Fixter",
    isActive: true,
    ...extra,
  });
}

async function main() {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { dbName: "adminjobs" });
  await Promise.all([User.init(), Booking.init(), SmsMessage.init(), BookingSlotReservation.init(), ReservationTimeBucket.init(), ReservationCapacityBucket.init(), AdminIdempotencyRecord.init()]);

  const owner = await User.create({ userId: "90000001", name: "Owner", email: "owner@example.test", role: "admin", password: "x" });
  const fixA = await makeStaff("Andy Field");
  const fixB = await makeStaff("Bea Field");
  const general = await makeStaff("Gil General", { employeePosition: "General Fixter" });
  const customer = await User.create({
    userId: "30000001",
    name: "Casey Customer",
    email: "casey@example.test",
    phone: "+15165550142",
    password: "x",
    role: "customer",
    addresses: [{ line1: "12 Elm St", city: "Farmingdale", state: "NY", zip: "11735" }],
  });
  const other = await User.create({
    userId: "30000002",
    name: "Olga Other",
    email: "olga@example.test",
    phone: "+16315550199",
    password: "x",
    role: "customer",
    addresses: [{ line1: "9 Oak Ave", city: "Huntington", state: "NY", zip: "11743" }],
  });
  await CompanyAvailabilityTemplate.create({
    active: true,
    timezone: TZ,
    slotMinutes: 30,
    minLeadMinutes: 0,
    maxAdvanceDays: 120,
    defaultCapacity: 3,
    visitDurationMinutes: 90,
    weeklySchedule: Array.from({ length: 7 }, (_, weekday) => ({
      weekday,
      enabled: weekday !== 0,
      starts: ["08:00", "10:00", "13:00"].map((time) => ({ time, capacity: null })),
      intervals: [{ startTime: "08:00", endTime: "16:00", capacity: null }],
    })),
  });

  const app = express();
  app.use(express.json());
  app.use("/api/admin/free-visits", require("../routes/adminFreeVisits"));
  app.use("/api/admin", require("../routes/adminBookingReservations"));
  app.use("/api/admin", require("../routes/adminJobs"));
  app.use("/api/admin/needs-action", require("../routes/adminNeedsAction"));
  app.use("/api/admin/fixters", require("../routes/fixters"));
  app.use("/api/admin", require("../routes/admin"));
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  let n = 0;
  const bookingData = (user, extra = {}) => ({
    bookingNumber: String(40000000 + ++n),
    date: new Date(),
    service: "Fix a door",
    user: user._id,
    userId: user.userId,
    name: user.name,
    phone: user.phone,
    email: user.email,
    addressId: user.addresses[0]._id,
    address: user.addresses[0].line1,
    city: user.addresses[0].city,
    state: "NY",
    zip: user.addresses[0].zip,
    subscription: "Basic",
    status: "Pending",
    ...extra,
  });
  async function reserved(user, fixter, day, time, extra = {}) {
    const { booking } = await createBookingWithReservation({
      bookingData: bookingData(user, extra),
      slotStart: at(day, time),
      technicianId: fixter._id,
      createdByType: "admin",
      actorUser: owner,
    });
    return Booking.findById(booking._id);
  }
  const emailsFor = (booking, templateKey) => sentEmails.filter((m) => m.templateKey === templateKey && String(m.vars?.bookingNumber) === String(booking.bookingNumber)).length;

  const day = openDay(6);
  const day2 = openDay(8);

  try {
    /* ============================== scope ============================== */
    console.log("\nRecord scope (Q-1)");
    const aPending = await reserved(customer, fixA, day, "08:00");
    const bPending = await reserved(other, fixB, day, "10:00");
    const aConfirmed = await reserved(customer, fixA, day, "13:00", { status: "Confirmed" });

    await check("a Fixter's legacy list holds only their own jobs, whatever ?assigned says", async () => {
      for (const q of ["", "?assigned=all", "?assigned=me"]) {
        const res = await call(fixA, "GET", `/api/admin/bookings${q}`);
        assert.strictEqual(res.status, 200);
        const ids = res.body.map((b) => String(b._id));
        assert.ok(ids.includes(String(aPending._id)));
        assert.ok(!ids.includes(String(bPending._id)), `saw another Fixter's job with ${q || "no flag"}`);
        assert.ok(res.body.every((b) => b.freeVisitIdentity === undefined && b.checkoutClientKey === undefined));
      }
    });
    await check("the owner and a General Fixter still list every job", async () => {
      for (const who of [owner, general]) {
        const ids = (await call(who, "GET", "/api/admin/bookings")).body.map((b) => String(b._id));
        assert.ok(ids.includes(String(aPending._id)) && ids.includes(String(bPending._id)));
      }
    });
    await check("another Fixter's history, detail, status and edit answer 403 FORBIDDEN_RECORD", async () => {
      const results = [
        await call(fixA, "GET", `/api/admin/bookings/${bPending._id}/history`),
        await call(fixA, "GET", `/api/admin/jobs/${bPending._id}`),
        await call(fixA, "PUT", `/api/admin/bookings/${bPending._id}/status`, { status: "Canceled" }),
        await call(fixA, "PUT", `/api/admin/bookings/${bPending._id}`, { adminNote: "x" }),
        await call(fixA, "PATCH", `/api/admin/jobs/${bPending._id}`, { adminNote: "x", expectedUpdatedAt: bPending.updatedAt }),
        await call(fixA, "POST", `/api/admin/jobs/${bPending._id}/notes`, { text: "x" }),
        await call(fixA, "POST", `/api/admin/jobs/${bPending._id}/transition`, { action: "cancel", expectedStatus: "Pending", idempotencyKey: key() }),
      ];
      for (const r of results) {
        assert.strictEqual(r.status, 403, JSON.stringify(r.body));
        assert.strictEqual(r.body.code, "FORBIDDEN_RECORD");
      }
      assert.strictEqual((await Booking.findById(bPending._id)).status, "Pending", "nothing changed");
    });
    await check("a Fixter's job list, search, schedule and my-day hold only their jobs", async () => {
      const list = await call(fixA, "GET", `/api/admin/jobs?view=range&from=${day}&to=${day}`);
      assert.strictEqual(list.status, 200, JSON.stringify(list.body));
      assert.deepStrictEqual(list.body.rows.map((r) => r.id).sort(), [String(aPending._id), String(aConfirmed._id)].sort());
      const search = await call(fixA, "POST", "/api/admin/jobs/search", { q: "Olga" });
      assert.strictEqual(search.body.total, 0);
      const sched = await call(fixA, "GET", `/api/admin/schedule?from=${day}&to=${day}&tech=${fixB._id}`);
      assert.strictEqual(sched.status, 200);
      assert.ok(sched.body.lanes.every((l) => l.technician?.id === String(fixA._id)));
      assert.strictEqual(sched.body.capacity, null, "no capacity for a field Fixter");
      const owners = await call(owner, "GET", `/api/admin/schedule?from=${day}&to=${day}`);
      assert.ok(owners.body.capacity?.days?.length === 1, JSON.stringify(owners.body.capacityError));
      assert.ok(owners.body.lanes.length >= 2);
    });
    await check("a Fixter cannot confirm, cancel or review requests, or create visits", async () => {
      const confirm = await call(fixA, "POST", `/api/admin/jobs/${aPending._id}/transition`, { action: "confirm", expectedStatus: "Pending", idempotencyKey: key() });
      assert.strictEqual(confirm.status, 403);
      assert.strictEqual(confirm.body.code, "FORBIDDEN_ACTION");
      const legacy = await call(fixA, "PUT", `/api/admin/bookings/${aPending._id}/status`, { status: "Confirmed" });
      assert.strictEqual(legacy.status, 403);
      for (const path of [`/api/admin/free-visits/${aPending._id}/confirm`, `/api/admin/free-visits/${aPending._id}/decline`]) {
        assert.strictEqual((await call(fixA, "POST", path, {})).status, 403, path);
      }
      assert.strictEqual((await call(fixA, "GET", `/api/admin/free-visits/${aPending._id}`)).status, 403);
      const form = new FormData();
      form.append("mode", "guest");
      form.append("type", "admin_free");
      assert.strictEqual((await call(fixA, "POST", "/api/admin/visits", undefined, { form })).status, 403);
      assert.strictEqual((await call(fixA, "POST", `/api/admin/jobs/${aPending._id}/reschedule`, { date: day2, time: "08:00", expectedUpdatedAt: aPending.updatedAt, idempotencyKey: key() })).status, 403);
      // A General Fixter may open the free-visit review (404 = not a free visit, but allowed through).
      assert.strictEqual((await call(general, "GET", `/api/admin/free-visits/${aPending._id}`)).status, 404);
    });
    await check("on their own job a Fixter sees the detail, adds a note and completes it", async () => {
      const detail = await call(fixA, "GET", `/api/admin/jobs/${aConfirmed._id}`);
      assert.strictEqual(detail.status, 200);
      assert.deepStrictEqual(detail.body.job.allowedActions.sort(), ["addInternalNote", "addPhotos", "complete"].sort());
      assert.strictEqual(detail.body.job.customer.plan, undefined, "no membership details for a field Fixter");
      const note = await call(fixA, "POST", `/api/admin/jobs/${aConfirmed._id}/notes`, { text: "Gate code 4411" });
      assert.strictEqual(note.status, 201, JSON.stringify(note.body));
      assert.strictEqual(note.body.booking.staffNotes.length, 1);
      assert.ok(await AdminActivityLog.exists({ action: "Job Note Added", entityId: String(aConfirmed._id) }));
      const before = emailsFor(aConfirmed, "booking_completed");
      const done = await call(fixA, "POST", `/api/admin/jobs/${aConfirmed._id}/transition`, { action: "complete", expectedStatus: "Confirmed", idempotencyKey: key() });
      assert.strictEqual(done.status, 200, JSON.stringify(done.body));
      assert.strictEqual(done.body.booking.status, "Completed");
      assert.strictEqual(emailsFor(aConfirmed, "booking_completed"), before + 1);
      const sent = sentEmails.filter((m) => m.templateKey === "booking_completed").pop();
      assert.ok(/\/tip/.test(String(sent.vars.tipUrl || "")), "the completion email carries the tip link");
      const fresh = await Booking.findById(aConfirmed._id);
      assert.ok(fresh.completedAt, "completedAt starts the review clock");
      const live = await BookingSlotReservation.findOne({ bookingId: aConfirmed._id, status: { $in: ["held", "reserved"] } });
      assert.strictEqual(live, null, "the reservation was released");
      assert.strictEqual(String(fresh.assignedFixterId), String(fixA._id), "who did the job is kept");
    });
    await check("staff notes never reach a customer query", async () => {
      const plain = await Booking.findById(aConfirmed._id).lean();
      assert.strictEqual(plain.staffNotes, undefined);
    });

    /* ============================ transitions =========================== */
    console.log("\nTransitions (allow-list, stale, concurrency, idempotency)");
    const p1 = await reserved(customer, fixB, day2, "08:00");
    await check("stale confirm: wrong expectedStatus or old expectedUpdatedAt -> 409 STALE, nothing sent", async () => {
      const before = sentEmails.length;
      const wrong = await call(owner, "POST", `/api/admin/jobs/${p1._id}/transition`, { action: "confirm", expectedStatus: "Confirmed", idempotencyKey: key() });
      assert.strictEqual(wrong.status, 409);
      assert.strictEqual(wrong.body.code, "STALE");
      const old = await call(owner, "POST", `/api/admin/jobs/${p1._id}/transition`, { action: "confirm", expectedStatus: "Pending", expectedUpdatedAt: new Date(p1.updatedAt.getTime() - 1000).toISOString(), idempotencyKey: key() });
      assert.strictEqual(old.status, 409);
      assert.strictEqual(old.body.code, "STALE");
      assert.strictEqual(sentEmails.length, before);
    });
    await check("expectedStatus and idempotencyKey are required on the new endpoint", async () => {
      assert.strictEqual((await call(owner, "POST", `/api/admin/jobs/${p1._id}/transition`, { action: "confirm", idempotencyKey: key() })).body.code, "PRECONDITION_REQUIRED");
      assert.strictEqual((await call(owner, "POST", `/api/admin/jobs/${p1._id}/transition`, { action: "confirm", expectedStatus: "Pending" })).body.code, "IDEMPOTENCY_KEY_REQUIRED");
    });
    await check("two simultaneous confirms: exactly one wins and one confirmation email goes", async () => {
      const body = () => ({ action: "confirm", expectedStatus: "Pending", expectedUpdatedAt: p1.updatedAt.toISOString(), idempotencyKey: key() });
      const [r1, r2] = await Promise.all([
        call(owner, "POST", `/api/admin/jobs/${p1._id}/transition`, body()),
        call(general, "POST", `/api/admin/jobs/${p1._id}/transition`, body()),
      ]);
      const statuses = [r1.status, r2.status].sort();
      assert.deepStrictEqual(statuses, [200, 409], JSON.stringify([r1.body, r2.body]));
      assert.strictEqual([r1, r2].find((r) => r.status === 409).body.code, "STALE");
      assert.strictEqual(emailsFor(p1, "booking_confirmed"), 1);
      assert.strictEqual(await SmsMessage.countDocuments({ booking: p1._id, notificationType: /CONFIRMED/ }), 1);
      assert.strictEqual((await Booking.findById(p1._id)).status, "Confirmed");
    });
    await check("replaying an idempotencyKey returns the first answer and repeats nothing", async () => {
      const p2 = await reserved(other, fixA, day2, "10:00");
      const k = key();
      const first = await call(owner, "POST", `/api/admin/jobs/${p2._id}/transition`, { action: "confirm", expectedStatus: "Pending", idempotencyKey: k });
      assert.strictEqual(first.status, 200, JSON.stringify(first.body));
      const again = await call(owner, "POST", `/api/admin/jobs/${p2._id}/transition`, { action: "confirm", expectedStatus: "Pending", idempotencyKey: k });
      assert.strictEqual(again.status, 200);
      assert.strictEqual(again.body.replayed, true);
      assert.strictEqual(emailsFor(p2, "booking_confirmed"), 1);
    });
    await check("legacy status route: the allow-list holds (Canceled -> Confirmed refused, use Reinstate)", async () => {
      const c = await reserved(other, fixA, day2, "13:00");
      const cancel = await call(owner, "PUT", `/api/admin/bookings/${c._id}/status`, { status: "Canceled" });
      assert.strictEqual(cancel.status, 200, JSON.stringify(cancel.body));
      assert.strictEqual(cancel.body.booking.status, "Canceled");
      const revive = await call(owner, "PUT", `/api/admin/bookings/${c._id}/status`, { status: "Confirmed" });
      assert.strictEqual(revive.status, 409);
      assert.strictEqual(revive.body.code, "INVALID_TRANSITION");
      assert.ok(/Reinstate/.test(revive.body.message));
      assert.strictEqual(emailsFor(c, "booking_confirmed"), 0, "nobody was told it is confirmed");
      const pend = await reserved(other, fixB, day2, "13:00");
      const skip = await call(owner, "PUT", `/api/admin/bookings/${pend._id}/status`, { status: "Completed" });
      assert.strictEqual(skip.status, 409);
      assert.strictEqual(skip.body.code, "INVALID_TRANSITION");
    });
    let legacyDone;
    await check("legacy complete still works from Confirmed, and a repeat is a no-op (one completion email)", async () => {
      legacyDone = await Booking.findById(p1._id);
      const done = await call(owner, "PUT", `/api/admin/bookings/${p1._id}/status`, { status: "Completed" });
      assert.strictEqual(done.status, 200, JSON.stringify(done.body));
      const repeat = await call(owner, "PUT", `/api/admin/bookings/${p1._id}/status`, { status: "Completed" });
      assert.strictEqual(repeat.status, 200);
      assert.strictEqual(repeat.body.message, "Status unchanged");
      assert.strictEqual(emailsFor(p1, "booking_completed"), 1);
    });
    await check("reinstate a mis-tapped Done: Confirmed again, reservation active again, no customer message by default (J-05)", async () => {
      const done = await Booking.findById(p1._id);
      const emailsBefore = sentEmails.length;
      const smsBefore = await SmsMessage.countDocuments({ booking: p1._id });
      const res = await call(owner, "POST", `/api/admin/jobs/${p1._id}/transition`, { action: "reinstate", expectedStatus: "Completed", expectedUpdatedAt: done.updatedAt.toISOString(), idempotencyKey: key() });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.booking.status, "Confirmed");
      assert.ok(res.body.notifications.every((x) => x.status === "skipped" && x.reason === "not_requested"));
      assert.strictEqual(sentEmails.length, emailsBefore);
      assert.strictEqual(await SmsMessage.countDocuments({ booking: p1._id }), smsBefore);
      const fresh = await Booking.findById(p1._id);
      assert.strictEqual(fresh.completedAt, null);
      const live = await BookingSlotReservation.findOne({ bookingId: p1._id, status: "reserved" });
      assert.ok(live, "re-reserved although slotReservationId was still set on the completed job");
      assert.strictEqual(String(fresh.slotReservationId), String(live._id));
      assert.ok(await AdminActivityLog.exists({ action: "Booking Reinstated", entityId: String(p1._id) }));
      // Reinstate is never available through the plain transitions.
      const bad = await call(owner, "POST", `/api/admin/jobs/${p1._id}/transition`, { action: "reinstate", expectedStatus: "Confirmed", idempotencyKey: key() });
      assert.strictEqual(bad.body.code, "INVALID_TRANSITION");
    });
    void legacyDone;
    await check("reinstate with notifyCustomer: the confirmation goes", async () => {
      const c = await reserved(customer, fixB, openDay(9), "08:00", { status: "Confirmed" });
      await call(owner, "POST", `/api/admin/jobs/${c._id}/transition`, { action: "cancel", expectedStatus: "Confirmed", idempotencyKey: key() });
      const res = await call(owner, "POST", `/api/admin/jobs/${c._id}/transition`, { action: "reinstate", expectedStatus: "Canceled", notifyCustomer: true, idempotencyKey: key() });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.notifications.find((x) => x.channel === "email").status, "sent");
      assert.strictEqual(emailsFor(c, "booking_confirmed"), 1);
    });

    /* ============================== cancel ============================== */
    console.log("\nCancel: Full Day benefit and payment info (J-10, Q-9)");
    await check("admin cancel gives back an included Full Day, like the customer's own cancel", async () => {
      const ent = await VisitEntitlement.create({
        user: customer._id,
        userId: customer.userId,
        addressId: customer.addresses[0]._id,
        kind: "full_day_visit",
        source: "membership_benefit",
        status: "consumed",
        consumedAt: new Date(),
        priceCents: 0,
        periodStart: new Date(Date.now() - 5 * 86400000),
        periodEnd: new Date(Date.now() + 25 * 86400000),
      });
      const fd = await Booking.create({
        ...bookingData(customer, { status: "Confirmed", bookingType: "full_day_visit", service: "Full Day Fixter", entitlementId: ent._id }),
        date: at(openDay(10), "08:00"),
      });
      const res = await call(owner, "POST", `/api/admin/jobs/${fd._id}/transition`, { action: "cancel", expectedStatus: "Confirmed", reason: "Customer called", idempotencyKey: key() });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.fullDayRestore.restored, true);
      assert.strictEqual((await VisitEntitlement.findById(ent._id)).status, "canceled", "the included day is free to book again");
      assert.strictEqual(res.body.payment.paid, false);
      assert.strictEqual((await Booking.findById(fd._id)).cancellationReason, "Customer called");
      // Reinstating it would re-use a day that was given back: refused.
      const back = await call(owner, "POST", `/api/admin/jobs/${fd._id}/transition`, { action: "reinstate", expectedStatus: "Canceled", idempotencyKey: key() });
      assert.strictEqual(back.status, 409);
      assert.strictEqual(back.body.code, "BENEFIT_RETURNED");
    });
    await check("cancelling a paid visit reports what was paid and where, and refunds nothing", async () => {
      const ent = await VisitEntitlement.create({
        user: other._id,
        userId: other.userId,
        addressId: other.addresses[0]._id,
        status: "paid",
        priceCents: 9900,
        stripePaymentIntentId: "pi_test_paid_123",
        purchasedAt: new Date(),
      });
      const paid = await reserved(other, fixB, openDay(9), "10:00", { status: "Confirmed", accessType: "one_time", bookingType: "one_time_handyman_visit", paymentState: "paid", entitlementId: ent._id });
      const res = await call(owner, "POST", `/api/admin/jobs/${paid._id}/transition`, { action: "cancel", expectedStatus: "Confirmed", idempotencyKey: key() });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.payment.paidCents, 9900);
      assert.strictEqual(res.body.payment.stripePaymentIntentId, "pi_test_paid_123");
      assert.strictEqual(res.body.payment.stripeDashboardUrl, "https://dashboard.stripe.com/test/payments/pi_test_paid_123");
      assert.ok(/does not refund/i.test(res.body.payment.refundNote));
      assert.strictEqual((await Booking.findById(paid._id)).paymentState, "paid", "money untouched");
    });

    /* ======================= gap fixes (FE-JOBS) ======================== */
    console.log("\nGap fixes: field Fixter money, reschedule options, schedule conflicts");
    await check("a field Fixter's job detail carries no amounts, tips, dates or Stripe references", async () => {
      const ent = await VisitEntitlement.create({
        user: customer._id,
        userId: customer.userId,
        addressId: customer.addresses[0]._id,
        status: "paid",
        priceCents: 12345,
        stripePaymentIntentId: "pi_test_fixter_hidden_1",
        purchasedAt: new Date(),
      });
      const job = await reserved(customer, fixA, openDay(30), "13:00", { status: "Confirmed", accessType: "one_time", bookingType: "one_time_handyman_visit", paymentState: "paid", entitlementId: ent._id });
      const asOwner = await call(owner, "GET", `/api/admin/jobs/${job._id}`);
      assert.strictEqual(asOwner.status, 200, JSON.stringify(asOwner.body));
      assert.strictEqual(asOwner.body.job.money.amountCents, 12345);
      assert.ok(/pi_test_fixter_hidden_1/.test(asOwner.body.job.money.stripeUrl));
      const asFixter = await call(fixA, "GET", `/api/admin/jobs/${job._id}`);
      assert.strictEqual(asFixter.status, 200, JSON.stringify(asFixter.body));
      assert.deepStrictEqual(asFixter.body.job.money, { kind: "paid", label: "Paid online" });
      const text = JSON.stringify(asFixter.body);
      for (const leak of ["12345", "123.45", "pi_test_fixter_hidden_1", "dashboard.stripe.com", "stripeUrl", "amountCents", "tipCents", "paidAt", "paidCents", "checkout"]) {
        assert.ok(!text.includes(leak), `${leak} leaked to a field Fixter`);
      }
    });

    await check("reschedule options: Admin rules skip the customer lead time, but keep past, capacity and Fixter overlap", async () => {
      const dayA = openDay(30);
      const dayB = openDay(33);
      const job = await reserved(customer, fixA, dayA, "08:00", { status: "Confirmed" });
      const blocker = await reserved(other, fixB, dayB, "13:00", { status: "Confirmed" });
      // A customer may book no sooner than 60 days out from now.
      await CompanyAvailabilityTemplate.updateOne({ active: true }, { $set: { minLeadMinutes: 60 * 24 * 60 } });
      try {
        const { calculateDayAvailability } = require("../utils/availabilityService");
        const customerView = await calculateDayAvailability({ date: dayB });
        assert.ok(customerView.slots.length && customerView.slots.every((s) => !s.open), "customers cannot book inside the lead time");

        const options = await call(owner, "GET", `/api/admin/jobs/${job._id}/reschedule-options?date=${dayB}`);
        assert.strictEqual(options.status, 200, JSON.stringify(options.body));
        assert.strictEqual(options.body.leadTimeApplied, false);
        assert.deepStrictEqual(options.body.slots.map((s) => s.time), ["08:00", "10:00", "13:00"]);
        assert.ok(options.body.slots.every((s) => s.available), JSON.stringify(options.body.slots));
        const one = options.body.slots.find((s) => s.time === "13:00");
        const bea = one.technicians.find((t) => t.id === String(fixB._id));
        assert.strictEqual(bea.available, false, "Bea already has a visit at 13:00");
        assert.ok(/overlapping|Conflicts/i.test(bea.reason), bea.reason);
        assert.strictEqual(one.technicians.find((t) => t.id === String(fixA._id)).available, true);
        assert.ok(one.remainingCapacity >= 1);

        const own = await call(owner, "GET", `/api/admin/jobs/${job._id}/reschedule-options?date=${dayA}`);
        const current = own.body.slots.find((s) => s.time === "08:00");
        assert.strictEqual(current.current, true);
        assert.strictEqual(current.available, true, "its own seat does not block it");
        assert.strictEqual(current.technicians.find((t) => t.id === String(fixA._id)).available, true, "its own reservation does not block Andy");

        // The reschedule endpoint accepts a time inside the customer lead time.
        const moved = await call(owner, "POST", `/api/admin/jobs/${job._id}/reschedule`, {
          date: dayB,
          time: "10:00",
          expectedUpdatedAt: job.updatedAt.toISOString(),
          idempotencyKey: key(),
          notifyCustomer: false,
        });
        assert.strictEqual(moved.status, 200, JSON.stringify(moved.body));
        assert.strictEqual(new Date((await Booking.findById(job._id)).date).getTime(), at(dayB, "10:00").getTime());
        // Bea is taken at 13:00, so moving Andy's job there with Bea is refused.
        const fresh = await Booking.findById(job._id);
        const clash = await call(owner, "POST", `/api/admin/jobs/${job._id}/reschedule`, {
          date: dayB,
          time: "13:00",
          assignedFixterId: String(fixB._id),
          expectedUpdatedAt: fresh.updatedAt.toISOString(),
          idempotencyKey: key(),
          notifyCustomer: false,
        });
        assert.notStrictEqual(clash.status, 200, JSON.stringify(clash.body));
        assert.strictEqual(String((await Booking.findById(blocker._id)).assignedFixterId), String(fixB._id));
      } finally {
        await CompanyAvailabilityTemplate.updateOne({ active: true }, { $set: { minLeadMinutes: 0 } });
      }

      const past = await call(owner, "GET", `/api/admin/jobs/${job._id}/reschedule-options?date=${moment.tz(TZ).subtract(3, "days").format("YYYY-MM-DD")}`);
      assert.strictEqual(past.status, 200, JSON.stringify(past.body));
      assert.ok(past.body.slots.every((s) => !s.available && (s.reason === "past" || s.reason === "closed")), JSON.stringify(past.body.slots));
      assert.strictEqual((await call(owner, "GET", `/api/admin/jobs/${job._id}/reschedule-options?date=tomorrow`)).body.code, "INVALID_DATE");
      assert.strictEqual((await call(fixA, "GET", `/api/admin/jobs/${job._id}/reschedule-options?date=${dayB}`)).status, 403);
    });

    await check("schedule rows mark a Fixter's overlapping reservations as a conflict", async () => {
      const dayC = openDay(36);
      const job = await reserved(customer, fixA, dayC, "08:00", { status: "Confirmed" });
      const calm = await reserved(other, fixB, dayC, "08:00", { status: "Confirmed" });
      // A reservation the engine would never write (legacy data): overlaps Andy's 08:00.
      await BookingSlotReservation.collection.insertOne({
        bookingId: new mongoose.Types.ObjectId(),
        technicianId: fixA._id,
        slotStart: at(dayC, "08:30"),
        slotEnd: at(dayC, "10:00"),
        status: "reserved",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const res = await call(owner, "GET", `/api/admin/schedule?from=${dayC}&to=${dayC}`);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      const rows = res.body.lanes.flatMap((lane) => lane.rows);
      const mine = rows.find((r) => r.id === String(job._id));
      assert.strictEqual(mine.conflict, true);
      assert.ok(/Overlaps/.test(mine.conflictReason));
      const theirs = rows.find((r) => r.id === String(calm._id));
      assert.strictEqual(theirs.conflict, false);
      assert.strictEqual(theirs.conflictReason, undefined);
    });

    /* =============================== edits ============================== */
    console.log("\nEdits (J-06, J-07)");
    await check("a note-only PATCH changes the note, never the Fixter, and texts nobody", async () => {
      const job = await reserved(customer, fixA, openDay(11), "08:00", { status: "Confirmed" });
      const sms = await SmsMessage.countDocuments({ booking: job._id });
      const res = await call(owner, "PATCH", `/api/admin/jobs/${job._id}`, { adminNote: "Bring the long ladder", assignedFixterId: String(fixA._id), expectedUpdatedAt: job.updatedAt.toISOString() });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.deepStrictEqual(res.body.changed, ["adminNote"]);
      assert.deepStrictEqual(res.body.notifications, []);
      const fresh = await Booking.findById(job._id);
      assert.strictEqual(String(fresh.assignedFixterId), String(fixA._id));
      assert.strictEqual(String(fresh.slotReservationId), String(job.slotReservationId));
      assert.strictEqual(await SmsMessage.countDocuments({ booking: job._id }), sms);
      const stale = await call(owner, "PATCH", `/api/admin/jobs/${job._id}`, { adminNote: "again", expectedUpdatedAt: job.updatedAt.toISOString() });
      assert.strictEqual(stale.status, 409);
      assert.strictEqual(stale.body.code, "STALE");
      assert.strictEqual((await call(owner, "PATCH", `/api/admin/jobs/${job._id}`, { adminNote: "x" })).body.code, "PRECONDITION_REQUIRED");
    });
    await check("the old Edit form's default-Fixter pre-fill does not assign an unassigned job", async () => {
      await User.updateOne({ _id: fixA._id }, { $set: { isDefaultFixter: true } });
      const job = await Booking.create({ ...bookingData(other), date: at(openDay(12), "10:00") });
      const res = await call(owner, "PUT", `/api/admin/bookings/${job._id}`, { note: "", adminNote: "call first", date: job.date.toISOString(), assignedFixterId: String(fixA._id) });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      const fresh = await Booking.findById(job._id);
      assert.strictEqual(fresh.assignedFixterId, null);
      assert.strictEqual(fresh.adminNote, "call first");
      assert.strictEqual(await SmsMessage.countDocuments({ booking: job._id }), 0);
      await User.updateOne({ _id: fixA._id }, { $set: { isDefaultFixter: false } });
    });
    await check("a stale draft cannot drop text the customer added to the description", async () => {
      const job = await Booking.create({
        ...bookingData(other, { note: "Leaky tap\n\nCustomer added on Nov 1:\nAlso the shower" }),
        date: at(openDay(12), "13:00"),
        contentUpdates: [{ source: "customer", actorRole: "customer", noteAdded: "Also the shower" }],
      });
      const res = await call(owner, "PUT", `/api/admin/bookings/${job._id}`, { note: "Leaky tap - bring washers" });
      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.code, "STALE");
      assert.ok(/Also the shower/.test((await Booking.findById(job._id)).note));
    });
    await check("a Fixter cannot re-date or re-assign their own job through the old edit route", async () => {
      const job = await reserved(customer, fixA, openDay(13), "08:00", { status: "Confirmed" });
      const res = await call(fixA, "PUT", `/api/admin/bookings/${job._id}`, { date: at(openDay(13), "10:00").toISOString() });
      assert.strictEqual(res.status, 403);
      const ok = await call(fixA, "PUT", `/api/admin/bookings/${job._id}`, { adminNote: "left a card", date: job.date.toISOString(), note: job.note });
      assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    });

    /* ============================ reschedule ============================ */
    console.log("\nReschedule (J-09)");
    await check("reschedule moves the reservation and reports each channel", async () => {
      const job = await reserved(customer, fixB, openDay(14), "08:00", { status: "Confirmed" });
      const res = await call(owner, "POST", `/api/admin/jobs/${job._id}/reschedule`, { date: openDay(14), time: "13:00", expectedUpdatedAt: job.updatedAt.toISOString(), idempotencyKey: key() });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(new Date(res.body.booking.date).getTime(), at(openDay(14), "13:00").getTime());
      const email = res.body.notifications.find((x) => x.channel === "email" && x.purpose === "reschedule");
      const sms = res.body.notifications.find((x) => x.channel === "sms" && x.purpose === "reschedule");
      assert.strictEqual(email.status, "sent");
      assert.ok(["sent", "skipped", "failed"].includes(sms.status) && sms.reason !== undefined);
      assert.strictEqual(emailsFor(job, "booking_rescheduled"), 1);
      const mail = sentEmails.filter((m) => m.templateKey === "booking_rescheduled").pop();
      assert.strictEqual(new Date(mail.vars.previousDate).getTime(), at(openDay(14), "08:00").getTime());
      const live = await BookingSlotReservation.findOne({ bookingId: job._id, status: "reserved" });
      assert.strictEqual(live.slotStart.getTime(), at(openDay(14), "13:00").getTime());
      const stale = await call(owner, "POST", `/api/admin/jobs/${job._id}/reschedule`, { date: openDay(14), time: "10:00", expectedUpdatedAt: job.updatedAt.toISOString(), idempotencyKey: key() });
      assert.strictEqual(stale.status, 409);
      assert.strictEqual(stale.body.code, "STALE");
    });
    await check("a failing email is reported as failed, not as sent", async () => {
      const job = await reserved(other, fixA, openDay(15), "08:00", { status: "Confirmed" });
      failTemplates.add("booking_rescheduled");
      const res = await call(owner, "POST", `/api/admin/jobs/${job._id}/reschedule`, { date: openDay(15), time: "10:00", expectedUpdatedAt: job.updatedAt.toISOString(), idempotencyKey: key() });
      failTemplates.delete("booking_rescheduled");
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      const email = res.body.notifications.find((x) => x.channel === "email");
      assert.strictEqual(email.status, "failed");
      assert.ok(email.reason);
    });
    /* ====================== owner-created appointment ==================== */
    console.log("\nOwner-created appointment (J-11, Q-2)");
    await check("an owner-created free visit starts Confirmed, assigned, and reminder-eligible", async () => {
      const form = new FormData();
      for (const [k, v] of Object.entries({ mode: "existing", userId: customer._id, addressId: customer.addresses[0]._id, type: "admin_free", date: openDay(17), time: "10:00", task: "Look at leak" })) form.append(k, String(v));
      const res = await call(owner, "POST", "/api/admin/visits", undefined, { form });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      assert.strictEqual(res.body.booking.status, "Confirmed");
      const b = await Booking.findById(res.body.booking._id);
      assert.ok(b.assignedFixterId && b.slotReservationId);
      assert.notStrictEqual(evaluate24HourReminder(b.toObject(), new Date(b.date.getTime() - 24 * 3600000)).reason, "status_not_confirmed");
      assert.ok(sentEmails.some((m) => m.templateKey === "booking_confirmed" && String(m.vars.bookingNumber) === b.bookingNumber));
    });

    /* ============================ needs action ========================== */
    console.log("\nNeeds action");
    const yesterday = moment.tz(TZ).subtract(1, "day").format("YYYY-MM-DD");
    const notClosedA = await Booking.create({ ...bookingData(customer, { status: "Confirmed", assignedFixterId: fixA._id, assignedFixterName: fixA.name }), date: at(yesterday, "10:00") });
    const unassigned = await Booking.create({ ...bookingData(other, { status: "Confirmed" }), date: at(openDay(18), "10:00") });
    await check("the counts equal the needs_action list and the Needs-action section, for the owner and for a Fixter", async () => {
      for (const who of [owner, fixA]) {
        const na = await call(who, "GET", "/api/admin/needs-action");
        assert.strictEqual(na.status, 200, JSON.stringify(na.body));
        const section = na.body.sections.find((s) => s.key === "bookings");
        const list = await call(who, "GET", "/api/admin/jobs?view=needs_action");
        assert.strictEqual(section.count, list.body.total);
        assert.strictEqual(list.body.counts.needsAction, list.body.total);
        const ids = new Set(section.items.map((i) => i.id));
        assert.strictEqual(ids.size, section.items.length, "one item per job");
        if (who === fixA) {
          assert.ok(ids.has(String(notClosedA._id)));
          assert.ok(!ids.has(String(unassigned._id)), "no other jobs for a Fixter");
          assert.ok(section.items.every((i) => i.href.startsWith("/admin/jobs/")));
        } else {
          assert.ok(ids.has(String(unassigned._id)) && ids.has(String(notClosedA._id)));
          assert.strictEqual(section.items.find((i) => i.id === String(notClosedA._id)).kind, "job_not_closed");
        }
      }
      assert.strictEqual((await call(customer, "GET", "/api/admin/needs-action")).status, 403);
    });
    await check("my-day lists the caller's own jobs today and tomorrow", async () => {
      const today = moment.tz(TZ).format("YYYY-MM-DD");
      const mine = await Booking.create({ ...bookingData(customer, { status: "Confirmed", assignedFixterId: fixA._id, assignedFixterName: fixA.name }), date: at(today, "23:30") });
      const res = await call(fixA, "GET", "/api/admin/my-day");
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.today.rows.some((r) => r.id === String(mine._id)));
      assert.strictEqual(res.body.today.date, today);
    });
    await check("all-dates search finds a job by phone digits with or without the 1", async () => {
      for (const q of ["16315550199", "(631) 555-0199", "631555"]) {
        const res = await call(owner, "POST", "/api/admin/jobs/search", { q });
        assert.ok(res.body.total > 0, q);
        assert.ok(res.body.groups.every((g) => /^\d{4}-\d{2}-\d{2}$/.test(g.date)));
      }
    });

    /* ========================= disable a Fixter ========================= */
    console.log("\nDisable a Fixter (J-21)");
    await check("disabling reports their future jobs, and they move in one step", async () => {
      const leaving = await makeStaff("Lee Leaving");
      const job = await reserved(other, leaving, openDay(19), "08:00", { status: "Confirmed" });
      const off = await call(owner, "PATCH", `/api/admin/fixters/${leaving._id}/status`, { isActive: false });
      assert.strictEqual(off.status, 200, JSON.stringify(off.body));
      assert.strictEqual(off.body.futureAssignedJobs, 1);
      const moved = await call(owner, "POST", `/api/admin/fixters/${leaving._id}/reassign-future-jobs`, { toFixterId: String(fixB._id) });
      assert.strictEqual(moved.status, 200, JSON.stringify(moved.body));
      assert.strictEqual(moved.body.moved.length, 1, JSON.stringify(moved.body.failed));
      assert.strictEqual(String((await Booking.findById(job._id)).assignedFixterId), String(fixB._id));
      assert.strictEqual((await call(general, "POST", `/api/admin/fixters/${leaving._id}/reassign-future-jobs`, { toFixterId: "auto" })).status, 403, "owner only");
    });
  } finally {
    server?.close();
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
