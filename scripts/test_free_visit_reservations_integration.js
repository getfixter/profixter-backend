/**
 * Free visits: guest requests reserve slots, the owner confirms, and one
 * lifetime free visit per person across guest requests and accounts.
 *
 * Real routes over HTTP, real reservation engine, MongoDB in memory as a
 * single-node replica set so its transactions run for real. S3, email and the
 * Meta Conversions API are stubbed; SMS is off, so a text that passes every
 * consent check is recorded "simulated" and a refused one "suppressed".
 *
 *   node scripts/test_free_visit_reservations_integration.js
 */
process.env.S3_BUCKET = "test-bucket";
process.env.JWT_SECRET = "test-secret";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_fake";
process.env.CLIENT_URL = "https://www.profixter.com";
process.env.ENABLE_RESERVATION_ENGINE = "true";
process.env.META_CAPI_TOKEN = "test-token";
process.env.OWNER_ALERT_PHONE = "6315991363";
process.env.MAIL_ADMIN = "owner@example.com";
delete process.env.SMS_ENABLED;
delete process.env.META_TEST_EVENT_CODE;
delete process.env.FB_TEST_CODE;

const assert = require("assert");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const moment = require("moment-timezone");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error.stack?.split("\n").slice(0, 3).join("\n        ") || error}`);
  }
}
const section = (t) => console.log(`\n${t}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await check();
    if (v) return v;
    await wait(50);
  }
  return check();
}

const TZ = "America/New_York";
const STARTS = ["08:00", "10:30", "13:00", "15:30"];
const CONSENT = "By booking, you agree to be contacted by call or text about your visit. Msg & data rates may apply.";

/* Open days are Tuesday to Saturday. The nth open day from 3 days out. */
function openDay(n) {
  const d = moment.tz(TZ).startOf("day").add(3, "days");
  let found = -1;
  for (;;) {
    if (d.day() !== 0 && d.day() !== 1) found += 1;
    if (found === n) return d.format("YYYY-MM-DD");
    d.add(1, "day");
  }
}
const at = (date, time) => moment.tz(`${date} ${time}`, "YYYY-MM-DD HH:mm", TZ).toDate();

async function main() {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(replSet.getUri());

  /* Stubs, before any route captures them. */
  const s3 = require("../utils/s3");
  const uploads = [];
  const deletions = [];
  s3.putPublicObject = async ({ Key }) => {
    uploads.push(Key);
    return `https://test-bucket.s3.amazonaws.com/${Key}`;
  };
  s3.deletePublicObjects = async ({ Keys }) => {
    deletions.push(...Keys);
  };
  const mail = require("../utils/emailService");
  const emails = [];
  mail.sendRaw = async (msg) => (emails.push({ kind: "raw", ...msg }), { ok: true });
  mail.sendTx = async (key, to, data) => (emails.push({ kind: "tx", key, to, data }), { ok: true });
  mail.sendPromo = async (to, msg) => (emails.push({ kind: "promo", to, ...msg }), { ok: true });
  const capi = [];
  const passThrough = global.fetch;
  global.fetch = async (url, init) => {
    if (!String(url).includes("graph.facebook.com")) return passThrough(url, init);
    capi.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ events_received: 1 }), text: async () => "" };
  };

  const Booking = require("../models/Booking");
  const BookingSlotReservation = require("../models/BookingSlotReservation");
  const CompanyAvailabilityTemplate = require("../models/CompanyAvailabilityTemplate");
  const ReservationCapacityBucket = require("../models/ReservationCapacityBucket");
  const ReservationTimeBucket = require("../models/ReservationTimeBucket");
  const Request = require("../models/Request");
  const SmsMessage = require("../models/SmsMessage");
  const User = require("../models/User");
  const { customerDayAvailability } = require("../utils/customerCalendarService");
  const { fullDayAvailabilityForRange } = require("../utils/fullDayVisitService");
  const { createBookingWithReservation } = require("../utils/slotReservationService");
  const { evaluateFreeVisitEligibility, identityOf, canonicalEmail, addressMatchKey } = require("../utils/freeVisit/eligibility");
  const { backfillUnlinkedGuestRequests } = require("../utils/freeVisit/guestVisit");
  const { _reset: resetRateLimits } = require("../utils/rateLimit");

  for (const M of [Booking, BookingSlotReservation, ReservationTimeBucket, ReservationCapacityBucket, Request, SmsMessage, User]) {
    await M.init();
  }

  const app = express();
  app.set("trust proxy", true);
  app.use(express.json());
  app.use("/api/free-visit-requests", require("../routes/freeVisitRequests"));
  app.use("/api/bookings", require("../routes/bookings"));
  app.use("/api/admin/free-visits", require("../routes/adminFreeVisits"));
  app.use("/api/admin", require("../routes/admin"));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  let counter = 30000000;
  const uid = () => String((counter += 1));

  async function reset({ fixters = 1 } = {}) {
    await Promise.all([Booking, BookingSlotReservation, ReservationTimeBucket, ReservationCapacityBucket, Request, SmsMessage, User].map((M) => M.deleteMany({})));
    await require("../models/FreeVisitLock").deleteMany({});
    await CompanyAvailabilityTemplate.deleteMany({});
    await CompanyAvailabilityTemplate.create({
      active: true,
      timezone: TZ,
      slotMinutes: 90,
      minLeadMinutes: 0,
      maxAdvanceDays: 120,
      defaultCapacity: fixters,
      visitDurationMinutes: 90,
      weeklySchedule: Array.from({ length: 7 }, (_, weekday) => ({
        weekday,
        enabled: weekday !== 0 && weekday !== 1,
        starts: STARTS.map((time) => ({ time, capacity: null })),
        intervals: [{ startTime: "08:00", endTime: "17:00", capacity: null }],
      })),
    });
    for (let i = 0; i < fixters; i += 1) {
      await User.create({
        name: `Fixter ${i + 1}`, email: `fixter${i + 1}@fixter.local`, password: "x", phone: "+15550002222",
        userId: uid(), role: "employee", employeePosition: "Fixter", isActive: true,
      });
    }
    const admin = await User.create({
      name: "Owner", email: "owner@example.com", password: "x", phone: "+16315550001", userId: uid(), role: "admin",
    });
    emails.length = 0;
    capi.length = 0;
    uploads.length = 0;
    deletions.length = 0;
    resetRateLimits();
    return { admin, adminToken: jwt.sign({ id: String(admin._id) }, process.env.JWT_SECRET) };
  }

  async function customer({ phone = "+16315550111", email = `c${uid()}@example.com`, line1 = "1 Test Street", zip = "11702", smsOn = true } = {}) {
    const addressId = new mongoose.Types.ObjectId();
    const user = await User.create({
      name: "Reg Customer", email, password: "x", phone, userId: uid(), role: "customer",
      addresses: [{ _id: addressId, label: "Home", line1, city: "Babylon", state: "NY", zip, county: "Suffolk" }],
      defaultAddressId: addressId,
      ...(smsOn ? { smsPreferences: { transactionalEnabled: true, transactionalConsentAt: new Date(), transactionalConsentSource: "signup" } } : {}),
    });
    return { user, addressId, token: jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET) };
  }

  async function guest(fields = {}, photos = 0) {
    const form = new FormData();
    const date = fields.date || openDay(0);
    const all = {
      name: "Jane Doe", phone: "(631) 555-0142", email: "jane.doe@example.com",
      note: "The bathroom faucet drips and a towel bar fell off",
      requestedDate: date, requestedTime: fields.time || "10:30", consentText: CONSENT,
      eventId: fields.eventId || `evt-${uid()}`, pageUrl: "https://www.profixter.com/?utm_source=fb",
      urlParams: JSON.stringify({ utm_source: "fb", utm_medium: "paid" }),
      ...fields,
    };
    delete all.date;
    delete all.time;
    for (const [k, v] of Object.entries(all)) form.append(k, v);
    for (let i = 0; i < photos; i += 1) {
      const sharp = require("sharp");
      const png = await sharp({ create: { width: 30, height: 20, channels: 3, background: "#336699" } }).png().toBuffer();
      form.append("images", new Blob([png], { type: "image/png" }), "job.png");
    }
    const res = await fetch(`${base}/api/free-visit-requests`, { method: "POST", body: form });
    return { status: res.status, body: await res.json().catch(() => ({})), eventId: all.eventId };
  }

  async function api(path, { method = "GET", token, body } = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  const registeredBook = (c, date, time) =>
    api("/api/bookings", {
      method: "POST",
      token: c.token,
      body: {
        service: "Labor Only", date: at(date, time).toISOString(), note: "Hang two shelves in the den",
        addressId: String(c.addressId), libraryReference: "faucet", requestedDate: date, requestedTime: time,
      },
    });

  const ADDRESS = { line1: "12 Main St", city: "Babylon", state: "NY", zip: "11702" };
  const bookable = async (date, time) => (await customerDayAvailability({ date })).slots.includes(time);
  const activeReservations = (bookingId) =>
    BookingSlotReservation.countDocuments({ bookingId, status: { $in: ["held", "reserved"] } });
  const confirmedTx = () => emails.filter((e) => e.kind === "tx" && e.key === "booking_confirmed");

  /* ================================================================ */
  section("1. A guest request reserves its slot at once");
  let ctx = await reset();
  const day = openDay(0);
  let first;
  await test("exactly one lead, one Pending Confirmation booking, one reservation", async () => {
    first = await guest({}, 1);
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    assert.strictEqual(await Request.countDocuments({}), 1);
    assert.strictEqual(await Booking.countDocuments({}), 1);
    const lead = await Request.findOne({}).lean();
    const booking = await Booking.findOne({}).lean();
    assert.strictEqual(lead.status, "pending_confirmation");
    assert.strictEqual(String(lead.bookingId), String(booking._id));
    assert.strictEqual(String(booking.guestRequestId), String(lead._id));
    assert.strictEqual(booking.status, "Pending Confirmation");
    assert.strictEqual(booking.isFreeFirstVisit, false, "not a counted free visit until confirmed");
    assert.strictEqual(booking.user, null);
    assert.strictEqual(await activeReservations(booking._id), 1);
    assert.ok(booking.slotReservationId);
    assert.strictEqual(booking.images.length, 1);
  });
  await test("the time is gone for everyone else immediately", async () => {
    assert.strictEqual(await bookable(day, "10:30"), false);
    assert.strictEqual(await bookable(day, "13:00"), true);
  });
  await test("the owner's alert says the slot is reserved; the guest's acknowledgment is not a confirmation", async () => {
    await waitFor(() => emails.some((e) => e.logContext?.templateKey === "admin_free_visit_request"));
    const owner = emails.find((e) => e.logContext?.templateKey === "admin_free_visit_request");
    assert.ok(owner.text.includes("slot is reserved"), owner.text);
    assert.strictEqual(confirmedTx().length, 0, "no confirmed-appointment email yet");
    assert.strictEqual(capi.length, 1);
    assert.strictEqual(capi[0].data[0].event_name, "Lead");
  });

  section("2. Every entry point sees the pending reservation");
  await test("a registered customer cannot book the same time", async () => {
    const c = await customer({ phone: "+16315550222" });
    const res = await registeredBook(c, day, "10:30");
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, "SLOT_UNAVAILABLE");
  });
  await test("another guest cannot request the same time (existing-style error)", async () => {
    const res = await guest({ name: "Bob Smith", phone: "6315550333", email: "bob@example.com" });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.code, "SLOT_UNAVAILABLE");
    assert.ok(/just taken/.test(res.body.message));
  });
  await test("a member visit and a One-Time visit cannot take it either", async () => {
    const c = await customer({ phone: "+16315550444" });
    for (const accessType of ["membership", "one_time"]) {
      await assert.rejects(
        createBookingWithReservation({
          bookingData: {
            bookingNumber: uid(), user: c.user._id, userId: c.user.userId, name: "M", phone: c.user.phone, email: c.user.email,
            addressId: c.addressId, address: "1 Test Street", city: "Babylon", state: "NY", zip: "11702",
            service: "Handyman visit", subscription: "Elite", accessType,
            bookingType: accessType === "one_time" ? "one_time_handyman_visit" : "membership_visit", note: "x", status: "Pending",
          },
          slotStart: at(day, "10:30"),
        }),
        (e) => e.code === "SLOT_UNAVAILABLE"
      );
    }
  });
  await test("a Full Day cannot take that day", async () => {
    const range = await fullDayAvailabilityForRange({ from: day, to: day });
    assert.strictEqual(range.days[0].available, false);
  });

  section("3. Concurrency, retries and failures");
  await test("two guests racing for one slot: exactly one wins", async () => {
    ctx = await reset();
    const d = openDay(1);
    const [a, b] = await Promise.all([
      guest({ date: d, time: "08:00", name: "Ann Lee", phone: "6315551001", email: "ann@example.com" }),
      guest({ date: d, time: "08:00", name: "Ben Ray", phone: "6315551002", email: "ben@example.com" }),
    ]);
    assert.deepStrictEqual([a.status, b.status].sort(), [201, 409]);
    assert.strictEqual(await Booking.countDocuments({}), 1);
    assert.strictEqual(await Request.countDocuments({}), 1);
    assert.strictEqual(await BookingSlotReservation.countDocuments({ status: "reserved" }), 1);
  });
  await test("one person pressing twice at once: one lead, one visit", async () => {
    const d = openDay(2);
    const eventId = "evt-double";
    const [a, b] = await Promise.all([
      guest({ date: d, time: "13:00", eventId, phone: "6315551003", email: "cat@example.com" }),
      guest({ date: d, time: "13:00", eventId, phone: "6315551003", email: "cat@example.com" }),
    ]);
    assert.ok([a.status, b.status].includes(201));
    assert.ok([a.status, b.status].every((s) => s === 201 || s === 200), `${a.status} ${b.status}`);
    assert.strictEqual(await Request.countDocuments({ phone: "+16315551003" }), 1);
    assert.strictEqual(await Booking.countDocuments({ phone: "+16315551003" }), 1);
  });
  await test("a retry of a saved press returns the same answer and changes nothing", async () => {
    const again = await guest({ date: openDay(2), time: "13:00", eventId: "evt-double", phone: "6315551003", email: "cat@example.com" });
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.body.duplicate, true);
    assert.strictEqual(await Booking.countDocuments({ phone: "+16315551003" }), 1);
  });
  await test("a failed submission leaves no lead, no booking, no reservation, no photos", async () => {
    const d = openDay(1);
    const before = { r: await Request.countDocuments({}), b: await Booking.countDocuments({}), s: await BookingSlotReservation.countDocuments({}) };
    const res = await guest({ date: d, time: "08:00", phone: "6315551004", email: "dan@example.com" }, 1);
    assert.strictEqual(res.status, 409);
    assert.strictEqual(await Request.countDocuments({}), before.r);
    assert.strictEqual(await Booking.countDocuments({}), before.b);
    assert.strictEqual(await BookingSlotReservation.countDocuments({}), before.s);
    await wait(200);
    assert.ok(uploads.every((key) => deletions.includes(key) || key.includes("/free-visit-requests/")), "no stray uploads");
    const leftovers = uploads.filter((key) => !deletions.includes(key));
    const owned = await Request.find({}).select("images").lean();
    const referenced = owned.flatMap((r) => r.images || []).join(" ");
    assert.ok(leftovers.every((key) => referenced.includes(key)), "every stored photo belongs to a saved lead");
  });

  section("4. The owner confirms");
  ctx = await reset();
  const d4 = openDay(3);
  const g4 = await guest({ date: d4, time: "08:00", phone: "6315552001", email: "erin@example.com", name: "Erin West" }, 1);
  const b4 = await Booking.findOne({}).lean();
  await test("the review shows everything that was submitted", async () => {
    const res = await api(`/api/admin/free-visits/${b4._id}`, { token: ctx.adminToken });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.booking.name, "Erin West");
    assert.strictEqual(res.body.booking.phone, "+16315552001");
    assert.strictEqual(res.body.booking.email, "erin@example.com");
    assert.strictEqual(res.body.booking.requestedTime, "08:00");
    assert.strictEqual(res.body.booking.images.length, 1);
    assert.strictEqual(res.body.lead.attribution.url.utm_source, "fb");
    assert.strictEqual(res.body.eligibility.decision, "eligible");
    void g4;
  });
  await test("Confirm Visit needs a service address", async () => {
    const res = await api(`/api/admin/free-visits/${b4._id}/confirm`, { method: "POST", token: ctx.adminToken, body: {} });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.code, "ADDRESS_REQUIRED");
  });
  await test("the generic status buttons cannot confirm a guest request", async () => {
    const res = await api(`/api/admin/bookings/${b4._id}/status`, { method: "PUT", token: ctx.adminToken, body: { status: "Confirmed" } });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.code, "USE_FREE_VISIT_REVIEW");
  });
  await test("a linked lead's status cannot be changed by hand", async () => {
    const lead = await Request.findOne({}).lean();
    const res = await api(`/api/admin/requests/${lead._id}/status`, { method: "PUT", token: ctx.adminToken, body: { status: "won" } });
    assert.strictEqual(res.status, 409);
  });
  await test("the owner saves the address and edits the job", async () => {
    const res = await api(`/api/admin/free-visits/${b4._id}`, {
      method: "PUT", token: ctx.adminToken,
      body: { address: { ...ADDRESS, unit: "2" }, note: "Faucet drips, towel bar, and a loose cabinet door" },
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.booking.hasAddress, true);
    assert.strictEqual(res.body.booking.address, "12 Main St, Unit 2");
    const lead = await Request.findOne({}).lean();
    assert.ok(lead.message.includes("cabinet"), "the lead follows the visit");
  });
  let reservationBefore;
  await test("confirming keeps the same booking and reservation, and notifies once", async () => {
    reservationBefore = String((await Booking.findById(b4._id).lean()).slotReservationId);
    const leadsBefore = capi.length;
    const res = await api(`/api/admin/free-visits/${b4._id}/confirm`, { method: "POST", token: ctx.adminToken, body: {} });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.notified, true);
    const after = await Booking.findById(b4._id).lean();
    assert.strictEqual(after.status, "Confirmed");
    assert.strictEqual(after.isFreeFirstVisit, true);
    assert.strictEqual(String(after.slotReservationId), reservationBefore);
    assert.strictEqual(await Booking.countDocuments({}), 1, "no second calendar entry");
    assert.strictEqual(await activeReservations(after._id), 1);
    assert.strictEqual((await Request.findOne({}).lean()).status, "confirmed");
    assert.strictEqual(confirmedTx().length, 1);
    assert.ok(confirmedTx()[0].data.address.includes("12 Main St"));
    const sms = await waitFor(() => SmsMessage.findOne({ notificationType: "FREE_VISIT_CONFIRMED" }).lean());
    assert.strictEqual(sms.status, "simulated", `the guest's consent covers this visit's texts (${sms.suppressionReason})`);
    assert.strictEqual(sms.toPhone, "+16315552001");
    assert.strictEqual(capi.length, leadsBefore, "no second advertising Lead on confirmation");
  });
  await test("confirming again sends nothing new", async () => {
    const res = await api(`/api/admin/free-visits/${b4._id}/confirm`, { method: "POST", token: ctx.adminToken, body: {} });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.alreadyConfirmed, true);
    assert.strictEqual(confirmedTx().length, 1);
    assert.strictEqual(await SmsMessage.countDocuments({ notificationType: "FREE_VISIT_CONFIRMED" }), 1);
  });
  await test("the confirmed visit is in the reminder workflow (Confirmed status) with its address", async () => {
    const policy = require("../utils/bookingReminderPolicy");
    const b = await Booking.findById(b4._id).lean();
    assert.ok(policy.isConfirmedStatus ? policy.isConfirmedStatus(b.status) : /^confirmed$/i.test(b.status));
    assert.ok(b.assignedFixterId, "assigned to a Fixter");
    assert.strictEqual(b.zip, "11702");
  });

  section("5. Changing the time, with conflict protection");
  ctx = await reset();
  const d5 = openDay(4);
  await guest({ date: d5, time: "08:00", phone: "6315553001", email: "fay@example.com", name: "Fay Moss" });
  const b5 = await Booking.findOne({}).lean();
  const other = await customer({ phone: "+16315553999", email: "other@example.com" });
  const taken = await registeredBook(other, d5, "13:00");
  await test("a time someone else holds is refused, and nothing moves", async () => {
    assert.strictEqual(taken.status, 200, JSON.stringify(taken.body));
    const res = await api(`/api/admin/free-visits/${b5._id}`, { method: "PUT", token: ctx.adminToken, body: { date: d5, time: "13:00" } });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.code, "SLOT_UNAVAILABLE");
    assert.strictEqual(moment.tz((await Booking.findById(b5._id).lean()).date, TZ).format("HH:mm"), "08:00");
  });
  await test("a free time moves the same reservation, and the lead follows", async () => {
    const res = await api(`/api/admin/free-visits/${b5._id}`, { method: "PUT", token: ctx.adminToken, body: { date: d5, time: "15:30" } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(await bookable(d5, "08:00"), true, "the old time is free again");
    assert.strictEqual(await bookable(d5, "15:30"), false);
    assert.strictEqual(await activeReservations(b5._id), 1);
    assert.strictEqual((await Request.findOne({ bookingId: b5._id }).lean()).requestedTime, "15:30");
  });

  section("6. Declining releases the slot and keeps the free visit");
  await test("decline frees the time, closes the lead, sends no confirmation", async () => {
    const res = await api(`/api/admin/free-visits/${b5._id}/decline`, { method: "POST", token: ctx.adminToken, body: { reason: "Out of area" } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(await activeReservations(b5._id), 0);
    assert.strictEqual(await bookable(d5, "15:30"), true);
    assert.strictEqual((await Request.findOne({ bookingId: b5._id }).lean()).status, "declined");
    assert.strictEqual(confirmedTx().length, 0);
  });
  await test("the same person can ask again: a declined request does not use the free visit", async () => {
    const res = await guest({ date: d5, time: "10:30", phone: "6315553001", email: "fay@example.com", name: "Fay Moss" });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  });
  await test("Cancel on the Jobs card declines the same way", async () => {
    const b = await Booking.findOne({ phone: "+16315553001", status: "Pending Confirmation" }).lean();
    const res = await api(`/api/admin/bookings/${b._id}/status`, { method: "PUT", token: ctx.adminToken, body: { status: "Canceled" } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(await activeReservations(b._id), 0);
    assert.strictEqual((await Request.findOne({ bookingId: b._id }).lean()).status, "declined");
  });

  section("7. Online bookings are reserved, then wait for the owner's approval");
  ctx = await reset();
  const d7 = openDay(5);
  const reg = await customer({ phone: "+16315554001", email: "gil@example.com" });
  let regBooking;
  await test("an eligible account books online: reserved, Pending Confirmation, no confirmation sent yet", async () => {
    const res = await registeredBook(reg, d7, "10:30");
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.booking.status, "Pending Confirmation");
    regBooking = await Booking.findOne({ user: reg.user._id }).lean();
    assert.strictEqual(regBooking.status, "Pending Confirmation");
    assert.strictEqual(regBooking.freeVisitChannel, "online");
    assert.strictEqual(regBooking.isFreeFirstVisit, true);
    assert.strictEqual(await activeReservations(regBooking._id), 1);
    assert.ok(emails.some((e) => e.kind === "tx" && e.key === "booking_created"), "the 'booking received' email");
    assert.ok(emails.some((e) => e.kind === "promo" && /awaiting your approval/.test(e.html || "")), "the owner is asked to approve");
    assert.strictEqual(confirmedTx().length, 0, "no confirmed-appointment email before approval");
    await wait(300);
    assert.strictEqual(await SmsMessage.countDocuments({}), 0, "no text before approval");
    assert.strictEqual(regBooking.freeVisitIdentity.phone, "+16315554001");
  });
  await test("the plain status control cannot approve an online free visit", async () => {
    const res = await api(`/api/admin/bookings/${regBooking._id}/status`, { method: "PUT", token: ctx.adminToken, body: { status: "Confirmed" } });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.code, "USE_FREE_VISIT_REVIEW");
  });
  await test("the review screen opens an online visit with its channel and nothing missing", async () => {
    const res = await api(`/api/admin/free-visits/${regBooking._id}`, { token: ctx.adminToken });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.booking.channel, "online");
    assert.deepStrictEqual(res.body.booking.missing, []);
    assert.strictEqual(res.body.eligibility.decision, "eligible");
  });
  await test("the owner cannot rewrite an online customer's contact details from the review", async () => {
    const res = await api(`/api/admin/free-visits/${regBooking._id}`, { method: "PUT", token: ctx.adminToken, body: { phone: "6315550000" } });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.code, "EDIT_ON_ACCOUNT");
    const note = await api(`/api/admin/free-visits/${regBooking._id}`, { method: "PUT", token: ctx.adminToken, body: { adminNote: "Called, all good" } });
    assert.strictEqual(note.status, 200, JSON.stringify(note.body));
  });
  await test("approving confirms it and sends the confirmation once, however often it is pressed", async () => {
    const [a, b] = await Promise.all([
      api(`/api/admin/free-visits/${regBooking._id}/confirm`, { method: "POST", token: ctx.adminToken, body: {} }),
      api(`/api/admin/free-visits/${regBooking._id}/confirm`, { method: "POST", token: ctx.adminToken, body: {} }),
    ]);
    assert.ok([a.status, b.status].includes(200), JSON.stringify([a.body, b.body]));
    const again = await api(`/api/admin/free-visits/${regBooking._id}/confirm`, { method: "POST", token: ctx.adminToken, body: {} });
    assert.strictEqual(again.status, 200);
    regBooking = await Booking.findById(regBooking._id).lean();
    assert.strictEqual(regBooking.status, "Confirmed");
    assert.strictEqual(confirmedTx().length, 1);
    const sms = await waitFor(() => SmsMessage.findOne({ notificationType: "FREE_VISIT_CONFIRMED" }).lean());
    assert.strictEqual(sms.status, "simulated");
    await wait(300);
    assert.strictEqual(await SmsMessage.countDocuments({ notificationType: "FREE_VISIT_CONFIRMED" }), 1);
    assert.strictEqual(await activeReservations(regBooking._id), 1, "the same reservation, not a second one");
  });

  section("8. One free visit per person, across both systems");
  await test("registered -> guest: the same email cannot request another", async () => {
    const res = await guest({ date: d7, time: "13:00", phone: "6315554999", email: "Gil@Example.com", name: "Gil Other" });
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, "FREE_VISIT_ACTIVE");
  });
  await test("registered -> guest: the same phone cannot either", async () => {
    const res = await guest({ date: d7, time: "13:00", phone: "631-555-4001", email: "someone.else@example.com", name: "Gil Phone" });
    // Same phone, different email, no address yet: a reused number is possible, so it is flagged, not refused...
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const b = await Booking.findOne({ phone: "+16315554001", guestRequestId: { $ne: null } }).lean();
    assert.strictEqual(b.freeVisitReview.required, true);
    assert.deepStrictEqual(b.freeVisitReview.reasons, ["same_phone_different_email"]);
    // ...and at confirmation, with the address now known, it is the same household: refused.
    await api(`/api/admin/free-visits/${b._id}`, { method: "PUT", token: ctx.adminToken, body: { address: { line1: "1 Test Street", city: "Babylon", state: "NY", zip: "11702" } } });
    const conf = await api(`/api/admin/free-visits/${b._id}/confirm`, { method: "POST", token: ctx.adminToken, body: { acknowledgeReview: true } });
    assert.strictEqual(conf.status, 409);
    assert.strictEqual(conf.body.code, "FREE_VISIT_ACTIVE");
    await api(`/api/admin/free-visits/${b._id}/decline`, { method: "POST", token: ctx.adminToken, body: {} });
  });
  await test("guest -> registered: a pending guest request blocks the account's free booking", async () => {
    await guest({ date: d7, time: "15:30", phone: "6315554100", email: "hal@example.com", name: "Hal Pine" });
    const hal = await customer({ phone: "+16315554100", email: "HAL@example.com" });
    const next = await api(`/api/bookings/next?addressId=${hal.addressId}`, { token: hal.token });
    assert.strictEqual(next.body.freeFirstVisitAvailable, false, "the booker shows it as taken up front");
    const res = await registeredBook(hal, openDay(6), "08:00");
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, "INTRO_VISIT_CLAIMED");
  });
  await test("guest -> registered, same phone but a different email: held Pending and flagged, not refused", async () => {
    const jo = await customer({ phone: "+16315554100", email: "jo.someone@example.com", line1: "77 Far Rd", zip: "11795" });
    const res = await registeredBook(jo, openDay(6), "15:30");
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const b = await Booking.findOne({ user: jo.user._id }).lean();
    assert.strictEqual(b.status, "Pending Confirmation");
    assert.deepStrictEqual(b.freeVisitReview.reasons, ["same_phone_different_email"]);
    const ownerMail = emails.find((e) => e.kind === "promo" && /Verify this free visit/.test(e.html || ""));
    assert.ok(ownerMail, "the owner's booking email says to verify it");
  });
  await test("completed: lifetime eligibility is consumed for every identity it touched", async () => {
    const done = await api(`/api/admin/bookings/${regBooking._id}/status`, { method: "PUT", token: ctx.adminToken, body: { status: "Completed" } });
    assert.strictEqual(done.status, 200, JSON.stringify(done.body));
    // Even after the customer changes their phone and email on the account.
    await User.updateOne({ _id: reg.user._id }, { $set: { phone: "+16315554777", email: "gil.new@example.com" } });
    const byOldEmail = await guest({ date: openDay(6), time: "10:30", phone: "6315554888", email: "gil@example.com", name: "Gil Again" });
    assert.strictEqual(byOldEmail.status, 403);
    assert.strictEqual(byOldEmail.body.code, "FREE_VISIT_USED");
    const byOldPhone = await registeredBook(await customer({ phone: "+16315554001", email: "gil.second@example.com" }), openDay(6), "13:00");
    assert.strictEqual(byOldPhone.status, 403, JSON.stringify(byOldPhone.body));
    assert.strictEqual(byOldPhone.body.code, "INTRO_VISIT_CONSUMED");
  });
  await test("a completed guest visit updates its lead", async () => {
    ctx = await reset();
    await guest({ date: openDay(7), time: "08:00", phone: "6315555001", email: "ivy@example.com", name: "Ivy Lane" });
    const b = await Booking.findOne({}).lean();
    await api(`/api/admin/free-visits/${b._id}`, { method: "PUT", token: ctx.adminToken, body: { address: ADDRESS } });
    await api(`/api/admin/free-visits/${b._id}/confirm`, { method: "POST", token: ctx.adminToken, body: {} });
    await api(`/api/admin/bookings/${b._id}/status`, { method: "PUT", token: ctx.adminToken, body: { status: "Completed" } });
    assert.strictEqual((await Request.findOne({ bookingId: b._id }).lean()).status, "completed");
    const again = await guest({ date: openDay(7), time: "10:30", phone: "(631) 555-5001", email: "ivy.new@example.com", name: "Ivy Lane" });
    // Same phone, different email, no address: flagged for review (could be a reused number)...
    assert.strictEqual(again.status, 201);
    const pending = await Booking.findOne({ status: "Pending Confirmation" }).lean();
    assert.strictEqual(pending.freeVisitReview.required, true);
    // ...and the owner adding the SAME address makes it a clear repeat.
    await api(`/api/admin/free-visits/${pending._id}`, { method: "PUT", token: ctx.adminToken, body: { address: ADDRESS } });
    const conf = await api(`/api/admin/free-visits/${pending._id}/confirm`, { method: "POST", token: ctx.adminToken, body: { acknowledgeReview: true } });
    assert.strictEqual(conf.status, 409);
    assert.strictEqual(conf.body.code, "FREE_VISIT_USED");
  });
  await test("shared address, different person: flagged for the owner, never silently refused", async () => {
    const neighbor = await customer({ phone: "+16315555999", email: "new.owner@example.com", line1: "12 Main St" });
    const res = await registeredBook(neighbor, openDay(8), "08:00");
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const b = await Booking.findOne({ user: neighbor.user._id }).lean();
    assert.strictEqual(b.status, "Pending Confirmation", "held for the owner to verify, not auto-confirmed");
    const blind = await api(`/api/admin/free-visits/${b._id}/confirm`, { method: "POST", token: ctx.adminToken, body: {} });
    assert.strictEqual(blind.status, 409);
    assert.strictEqual(blind.body.code, "REVIEW_REQUIRED");
    assert.deepStrictEqual(b.freeVisitReview.reasons, ["same_address_different_person"]);
  });
  await test("an ambiguous guest needs the owner to acknowledge before confirming", async () => {
    ctx = await reset();
    await Booking.create({
      bookingNumber: uid(), date: at(openDay(0), "08:00"), service: "Labor Only", user: new mongoose.Types.ObjectId(), userId: "1",
      name: "Old Owner", phone: "+16315556001", email: "old.owner@example.com", address: "40 Elm St", city: "Babylon", state: "NY", zip: "11702",
      subscription: "Free visit", accessType: "free_first_visit", isFreeFirstVisit: true, status: "Completed", completedAt: new Date(),
    });
    const res = await guest({ date: openDay(9), time: "08:00", phone: "6315556002", email: "new.family@example.com", name: "New Family" });
    assert.strictEqual(res.status, 201);
    const b = await Booking.findOne({ status: "Pending Confirmation" }).lean();
    await api(`/api/admin/free-visits/${b._id}`, { method: "PUT", token: ctx.adminToken, body: { address: { line1: "40 Elm Street", city: "Babylon", state: "NY", zip: "11702" } } });
    const blind = await api(`/api/admin/free-visits/${b._id}/confirm`, { method: "POST", token: ctx.adminToken, body: {} });
    assert.strictEqual(blind.status, 409);
    assert.strictEqual(blind.body.code, "REVIEW_REQUIRED");
    assert.deepStrictEqual(blind.body.eligibility.reasons, ["same_address_different_person"]);
    const ok = await api(`/api/admin/free-visits/${b._id}/confirm`, { method: "POST", token: ctx.adminToken, body: { acknowledgeReview: true } });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.ok((await Booking.findById(b._id).lean()).freeVisitReview.acknowledgedAt);
  });

  section("9. The rules, without a database");
  const row = (over) => ({ source: "booking", bookingId: "b", bookingNumber: "1", requestId: "", state: "consumed", status: "Completed", date: null, userId: "", phones: [], emails: [], addressKeys: [], ...over });
  await test("no-show stays claimed (existing policy): it blocks", () => {
    const r = evaluateFreeVisitEligibility(identityOf({ phone: "6315557000" }), [row({ state: "active", status: "No-Show", phones: ["+16315557000"] })]);
    assert.strictEqual(r.decision, "blocked");
    assert.strictEqual(r.code, "FREE_VISIT_ACTIVE");
  });
  await test("canceled or declined before service does not count", () => {
    const r = evaluateFreeVisitEligibility(identityOf({ phone: "6315557000" }), [row({ state: "released", phones: ["+16315557000"] })]);
    assert.strictEqual(r.decision, "eligible");
  });
  await test("emails match case-, dot- and plus-insensitively for Gmail; plus-tags everywhere", () => {
    assert.strictEqual(canonicalEmail("J.Doe+ads@GMail.com"), "jdoe@gmail.com");
    assert.strictEqual(canonicalEmail("j.doe+x@example.com"), "j.doe@example.com");
  });
  await test("apartment units are different homes; street suffixes are not", () => {
    assert.notStrictEqual(addressMatchKey({ line1: "5 Oak Ave Apt 1", zip: "11702" }), addressMatchKey({ line1: "5 Oak Ave Apt 2", zip: "11702" }));
    assert.strictEqual(addressMatchKey({ line1: "5 Oak Avenue", city: "Massapequa", zip: "11758" }), addressMatchKey({ line1: "5 Oak Ave", city: "Massapequa Park", zip: "11758" }));
  });
  await test("a name alone never matches", () => {
    const r = evaluateFreeVisitEligibility(identityOf({ phone: "6315557111", email: "a@example.com" }), [row({ phones: ["+16315557222"], emails: ["b@example.com"] })]);
    assert.strictEqual(r.decision, "eligible");
  });

  section("10. Requests made before slots were reserved");
  await test("an older pending request gets its reservation, once", async () => {
    ctx = await reset();
    const d = openDay(10);
    await Request.create({
      name: "Old Request", email: "old.req@example.com", phone: "+16315558001", message: "Fix the screen door please",
      serviceType: "free_visit_request", status: "pending_confirmation", requestedDate: d, requestedTime: "10:30",
      requestedAt: at(d, "10:30"), contactConsent: { text: CONSENT, at: new Date(), ip: "1.2.3.4" }, dedupeKey: "old-1",
    });
    const first = await backfillUnlinkedGuestRequests({ logger: { log() {} } });
    const second = await backfillUnlinkedGuestRequests({ logger: { log() {} } });
    assert.strictEqual(first.reserved, 1);
    assert.strictEqual(second.checked, 0);
    assert.strictEqual(await Booking.countDocuments({}), 1);
    const lead = await Request.findOne({ dedupeKey: "old-1" }).lean();
    assert.ok(lead.bookingId);
    assert.strictEqual(await bookable(d, "10:30"), false);
  });
  await test("an older request whose time is gone is flagged for the owner, not double-booked", async () => {
    const d = openDay(10);
    await Request.create({
      name: "Late Request", email: "late.req@example.com", phone: "+16315558002", message: "Patch drywall in hallway",
      serviceType: "free_visit_request", status: "pending_confirmation", requestedDate: d, requestedTime: "10:30",
      requestedAt: at(d, "10:30"), contactConsent: { text: CONSENT, at: new Date() }, dedupeKey: "old-2",
    });
    const result = await backfillUnlinkedGuestRequests({ logger: { log() {} } });
    assert.strictEqual(result.flagged, 1);
    const lead = await Request.findOne({ dedupeKey: "old-2" }).lean();
    assert.strictEqual(lead.reservationIssue.code, "SLOT_UNAVAILABLE");
    assert.strictEqual(await Booking.countDocuments({}), 1);
  });

  /* ================================================================ */
  section("11. Free Visit 2.0: one submission, one booking; both channels share one free visit");
  const { linkGuestFreeVisits } = require("../utils/freeVisit/guestLink");
  const onlineBook = (c, date, time, extra = {}) =>
    api("/api/bookings", {
      method: "POST",
      token: c.token,
      body: {
        service: "Labor Only", date: at(date, time).toISOString(), note: "Patch a hole in the hallway wall",
        addressId: String(c.addressId), libraryReference: "faucet", requestedDate: date, requestedTime: time, ...extra,
      },
    });

  await test("a refreshed or retried submit returns the booking it already made", async () => {
    ctx = await reset();
    const kim = await customer({ phone: "+16315557001", email: "kim@example.com" });
    const first = await onlineBook(kim, openDay(1), "08:00", { clientRequestId: "fv_draft_abc12345" });
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));
    const again = await onlineBook(kim, openDay(1), "08:00", { clientRequestId: "fv_draft_abc12345" });
    assert.strictEqual(again.status, 200, JSON.stringify(again.body));
    assert.strictEqual(again.body.duplicate, true);
    assert.strictEqual(again.body.booking.bookingNumber, first.body.booking.bookingNumber);
    assert.strictEqual(await Booking.countDocuments({ user: kim.user._id }), 1);
    assert.strictEqual(emails.filter((e) => e.kind === "tx" && e.key === "booking_created").length, 1, "one 'received' email");
  });
  await test("a double tap sends two submits at once: one booking, one reservation", async () => {
    ctx = await reset();
    const lee = await customer({ phone: "+16315557002", email: "lee@example.com" });
    const results = await Promise.all([
      onlineBook(lee, openDay(1), "10:30", { clientRequestId: "fv_draft_tap00001" }),
      onlineBook(lee, openDay(1), "10:30", { clientRequestId: "fv_draft_tap00001" }),
    ]);
    const bookings = await Booking.find({ user: lee.user._id }).lean();
    assert.strictEqual(bookings.length, 1, JSON.stringify(results.map((r) => r.body)));
    assert.strictEqual(await activeReservations(bookings[0]._id), 1);
    assert.ok(results.some((r) => r.status === 200));
  });
  await test("a different submission by the same customer is refused: one free visit", async () => {
    ctx = await reset();
    const max = await customer({ phone: "+16315557003", email: "max@example.com" });
    assert.strictEqual((await onlineBook(max, openDay(1), "13:00", { clientRequestId: "fv_draft_one00001" })).status, 200);
    const second = await onlineBook(max, openDay(2), "13:00", { clientRequestId: "fv_draft_two00002" });
    assert.strictEqual(second.status, 403, JSON.stringify(second.body));
    assert.strictEqual(second.body.code, "INTRO_VISIT_CLAIMED");
  });
  await test("a second home on the same account cannot get a second free visit", async () => {
    ctx = await reset();
    const ned = await customer({ phone: "+16315557004", email: "ned@example.com" });
    assert.strictEqual((await onlineBook(ned, openDay(1), "08:00")).status, 200);
    const otherHome = new mongoose.Types.ObjectId();
    await User.updateOne(
      { _id: ned.user._id },
      { $push: { addresses: { _id: otherHome, label: "Beach", line1: "9 Ocean Ave", city: "Babylon", state: "NY", zip: "11702", county: "Suffolk" } } }
    );
    const res = await onlineBook({ ...ned, addressId: otherHome }, openDay(2), "08:00");
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
  });
  await test("callback first, then online with the same phone: refused as already requested", async () => {
    ctx = await reset();
    assert.strictEqual((await guest({ date: openDay(1), time: "08:00", phone: "6315557005", email: "ora@example.com", name: "Ora Bell" })).status, 201);
    const ora = await customer({ phone: "+16315557005", email: "ora@example.com" });
    const next = await api(`/api/bookings/next?addressId=${ora.addressId}`, { token: ora.token });
    assert.strictEqual(next.body.freeFirstVisitAvailable, false);
    assert.strictEqual(next.body.introVisitStatus, "claimed", "shown as already requested, not as used up");
    const res = await onlineBook(ora, openDay(2), "08:00");
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.code, "INTRO_VISIT_CLAIMED");
  });
  await test("online first, then a callback with the same email: refused", async () => {
    ctx = await reset();
    const pat = await customer({ phone: "+16315557006", email: "pat@example.com" });
    assert.strictEqual((await onlineBook(pat, openDay(1), "08:00")).status, 200);
    const res = await guest({ date: openDay(2), time: "10:30", phone: "6315557999", email: "pat@example.com", name: "Pat Other" });
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, "FREE_VISIT_ACTIVE");
  });
  await test("concurrent callback and online claims by one person: only one wins", async () => {
    ctx = await reset();
    const quinn = await customer({ phone: "+16315557007", email: "quinn@example.com" });
    const [g, o] = await Promise.all([
      guest({ date: openDay(1), time: "08:00", phone: "6315557007", email: "quinn@example.com", name: "Quinn Ash" }),
      onlineBook(quinn, openDay(1), "10:30"),
    ]);
    const live = await Booking.countDocuments({ status: "Pending Confirmation" });
    assert.strictEqual(live, 1, JSON.stringify([g.body, o.body]));
  });
  await test("a time taken while the customer was signing up is refused, and nothing is held", async () => {
    ctx = await reset();
    const rae = await customer({ phone: "+16315557008", email: "rae@example.com" });
    assert.strictEqual((await guest({ date: openDay(1), time: "13:00", phone: "6315557900", email: "someone@example.com", name: "Some One" })).status, 201);
    const res = await onlineBook(rae, openDay(1), "13:00", { clientRequestId: "fv_draft_taken001" });
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, "SLOT_UNAVAILABLE");
    assert.strictEqual(await Booking.countDocuments({ user: rae.user._id }), 0);
    const fresh = await api(`/api/bookings/next?addressId=${rae.addressId}`, { token: rae.token });
    assert.strictEqual(fresh.body.freeFirstVisitAvailable, true, "the free visit is still theirs");
  });
  await test("declining an online visit frees the time, gives the free visit back, and emails the customer once", async () => {
    ctx = await reset();
    const sam = await customer({ phone: "+16315557009", email: "sam@example.com" });
    assert.strictEqual((await onlineBook(sam, openDay(1), "15:30")).status, 200);
    const b = await Booking.findOne({ user: sam.user._id }).lean();
    const res = await api(`/api/admin/free-visits/${b._id}/decline`, { method: "POST", token: ctx.adminToken, body: { reason: "Out of scope" } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    await api(`/api/admin/free-visits/${b._id}/decline`, { method: "POST", token: ctx.adminToken, body: {} });
    assert.strictEqual((await Booking.findById(b._id).lean()).status, "Canceled");
    assert.strictEqual(await activeReservations(b._id), 0);
    assert.strictEqual(emails.filter((e) => e.kind === "tx" && e.key === "booking_canceled").length, 1);
    const next = await api(`/api/bookings/next?addressId=${sam.addressId}`, { token: sam.token });
    assert.strictEqual(next.body.freeFirstVisitAvailable, true);
  });
  await test("a callback request joins the account that later proves the same phone", async () => {
    ctx = await reset();
    await guest({ date: openDay(1), time: "08:00", phone: "6315557010", email: "tia@example.com", name: "Tia Moss" });
    const tia = await customer({ phone: "+16315557010", email: "tia.new@example.com" });
    assert.strictEqual(await linkGuestFreeVisits(await User.findById(tia.user._id)), 0, "an unproved phone links nothing");
    await User.updateOne({ _id: tia.user._id }, { $set: { phoneVerifiedAt: new Date() } });
    assert.strictEqual(await linkGuestFreeVisits(await User.findById(tia.user._id)), 1);
    const b = await Booking.findOne({ guestRequestId: { $ne: null } }).lean();
    assert.strictEqual(String(b.user), String(tia.user._id));
    assert.strictEqual(b.status, "Pending Confirmation", "linking never changes the visit");
    const mine = await api("/api/bookings", { token: tia.token });
    assert.ok((Array.isArray(mine.body) ? mine.body : mine.body.bookings || []).some((x) => String(x._id) === String(b._id)), "it shows in My Home");
    assert.strictEqual(await linkGuestFreeVisits(await User.findById(tia.user._id)), 0, "idempotent");
    const conf = await api(`/api/admin/free-visits/${b._id}`, { method: "PUT", token: ctx.adminToken, body: { address: ADDRESS } });
    assert.strictEqual(conf.status, 200);
    const ok = await api(`/api/admin/free-visits/${b._id}/confirm`, { method: "POST", token: ctx.adminToken, body: { acknowledgeReview: true } });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  });
  await test("a callback whose email belongs to another account is never linked by phone", async () => {
    ctx = await reset();
    await guest({ date: openDay(1), time: "10:30", phone: "6315557011", email: "uma@example.com", name: "Uma Reed" });
    await customer({ phone: "+16315550999", email: "uma@example.com" });
    const other = await customer({ phone: "+16315557011", email: "uma.partner@example.com" });
    await User.updateOne({ _id: other.user._id }, { $set: { phoneVerifiedAt: new Date() } });
    assert.strictEqual(await linkGuestFreeVisits(await User.findById(other.user._id)), 0);
  });

  server.close();
  await mongoose.disconnect();
  await replSet.stop();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
