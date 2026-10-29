/**
 * From "Continue with phone" to a booked visit, through the real routes.
 *
 * A brand-new customer signs up with only a phone, is asked for an email the
 * moment a booking needs one, adds their home when a visit needs a place, and
 * books their free first visit on the real reservation engine. Along the way
 * the existing rules must still hold: one free visit per customer, the
 * service area at the free visit, and contact details before any paid
 * checkout.
 *
 * Mail, S3, Meta and Stripe are stubbed; codes are captured. Nothing leaves
 * the process.
 *
 *   node scripts/test_signup_to_booking_journey.js
 *
 * Not in `npm test`: it boots a MongoDB replica set.
 */

Object.assign(process.env, {
  NODE_ENV: "test",
  S3_BUCKET: "test-bucket",
  JWT_SECRET: "journey-secret",
  STRIPE_SECRET_KEY: "sk_test_fake",
  CLIENT_URL: "https://www.profixter.com",
  ENABLE_RESERVATION_ENGINE: "true",
  MAIL_ADMIN: "owner@example.com",
  OWNER_ALERT_PHONE: "6315991363",
});
delete process.env.SMS_ENABLED;

const assert = require("node:assert/strict");
const express = require("express");
const moment = require("moment-timezone");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const TZ = "America/New_York";
const STARTS = ["08:00", "10:30", "13:00", "15:30"];

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

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error.stack?.split("\n").slice(0, 4).join("\n        ")}`);
  }
}

async function main() {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(replSet.getUri());

  /* Stubs, before any route captures them. */
  const s3 = require("../utils/s3");
  s3.putPublicObject = async ({ Key }) => `https://test-bucket.s3.amazonaws.com/${Key}`;
  s3.deletePublicObjects = async () => {};
  const mail = require("../utils/emailService");
  const emails = [];
  mail.sendRaw = async (msg) => (emails.push(msg), { ok: true });
  mail.sendTx = async (key, to, data) => (emails.push({ key, to, data }), { ok: true });
  const passThrough = global.fetch;
  global.fetch = async (url, init) =>
    String(url).includes("graph.facebook.com") ? { ok: true, json: async () => ({}), text: async () => "" } : passThrough(url, init);
  const subs = require("../utils/subscriptionManagement");
  let stripeSessions = 0;
  subs.stripe.checkout.sessions.create = async () => {
    stripeSessions += 1;
    return { id: "cs_test_journey", url: "https://checkout.stripe.com/c/pay/cs_test_journey" };
  };

  const User = require("../models/User");
  const Booking = require("../models/Booking");
  const CompanyAvailabilityTemplate = require("../models/CompanyAvailabilityTemplate");
  for (const M of [User, Booking, require("../models/BookingSlotReservation"), require("../models/ReservationTimeBucket"), require("../models/ReservationCapacityBucket")]) {
    await M.init();
  }
  await User.syncIndexes();

  const authV2 = require("../routes/authV2");
  const codes = {};
  authV2.deps.deliver = async ({ target, code }) => {
    codes[target] = code;
  };

  const app = express();
  app.use(express.json());
  app.use("/api/auth", require("../routes/auth"));
  app.use("/api/auth", authV2);
  app.use("/api/users", require("../routes/users"));
  app.use("/api/bookings", require("../routes/bookings"));
  app.use("/api/stripe/checkout", require("../routes/stripe"));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  async function api(path, { method = "GET", token, body } = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  // A working week: Tuesday to Saturday, four starts a day, one Fixter.
  await CompanyAvailabilityTemplate.create({
    active: true,
    timezone: TZ,
    slotMinutes: 90,
    minLeadMinutes: 0,
    maxAdvanceDays: 120,
    defaultCapacity: 1,
    visitDurationMinutes: 90,
    weeklySchedule: Array.from({ length: 7 }, (_, weekday) => ({
      weekday,
      enabled: weekday !== 0 && weekday !== 1,
      starts: STARTS.map((time) => ({ time, capacity: null })),
      intervals: [{ startTime: "08:00", endTime: "17:00", capacity: null }],
    })),
  });
  await User.create({
    name: "Fixter One", email: "fixter1@fixter.local", password: "x", phone: "+15550002222",
    userId: "20000001", role: "employee", employeePosition: "Fixter", isActive: true,
  });

  const book = (token, addressId, date, time = "10:30") =>
    api("/api/bookings", {
      method: "POST",
      token,
      body: {
        service: "Labor Only", date: at(date, time).toISOString(), note: "Hang two shelves in the den",
        addressId: addressId ? String(addressId) : undefined, libraryReference: "faucet", requestedDate: date, requestedTime: time,
      },
    });

  let token;
  let homeId;

  console.log("\n--- a new customer, from phone to booked visit");

  await test("1. signs up with only a phone", async () => {
    const start = await api("/api/auth/otp/phone/start", { method: "POST", body: { phone: "6315550301", smsTransactionalConsent: true } });
    assert.equal(start.status, 200);
    const res = await api("/api/auth/otp/phone/verify", { method: "POST", body: { phone: "6315550301", code: codes["+16315550301"] } });
    assert.equal(res.body.created, true);
    token = res.body.token;
    assert.deepEqual(res.body.user.addresses, []);
    assert.equal(await Booking.countDocuments({ user: { $ne: null } }), 0, "signing up books nothing");
  });

  await test("2. trying to book asks for what is missing - name and email - and nothing else", async () => {
    const res = await book(token, null, openDay(0));
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "CONTACT_REQUIRED");
    assert.deepEqual(res.body.missing, ["name", "email"]);
  });

  await test("2b. gives their name", async () => {
    const res = await api("/api/users/me/profile", { method: "PATCH", token, body: { name: "Jordan Ray" } });
    assert.equal(res.body.user.name, "Jordan Ray");
  });

  await test("3. adds a verified email with a code", async () => {
    await api("/api/auth/otp/email/start", { method: "POST", body: { email: "journey@example.com" } });
    const res = await api("/api/auth/otp/email/verify", {
      method: "POST",
      token,
      body: { email: "journey@example.com", code: codes["journey@example.com"], mode: "attach" },
    });
    assert.equal(res.body.status, "attached");
  });

  await test("4. a visit still needs a home, and says so", async () => {
    const res = await book(token, null, openDay(0));
    assert.equal(res.status, 400);
    assert.notEqual(res.body.code, "CONTACT_REQUIRED");
  });

  await test("5. adds their home (in the service area)", async () => {
    const res = await api("/api/users/me/addresses", {
      method: "POST",
      token,
      body: { line1: "12 Main St", city: "Babylon", state: "NY", zip: "11702" },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.serviceArea.inArea, true);
    homeId = res.body.address._id;
  });

  await test("6. books the free first visit on the real calendar", async () => {
    const res = await book(token, homeId, openDay(0));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.message, "Booking created");
    const booking = await Booking.findOne({ user: { $ne: null } }).lean();
    assert.ok(booking, "a booking exists");
    assert.equal(String(booking.addressId), String(homeId));
    assert.equal(booking.phone.replace(/\D/g, "").slice(-10), "6315550301");
    assert.equal(booking.email, "journey@example.com");
    assert.ok(booking.slotReservationId, "the time is really reserved");
  });

  await test("7. the one-free-visit rule still holds", async () => {
    const res = await book(token, homeId, openDay(1), "13:00");
    assert.notEqual(res.status, 200, "a second free visit is refused");
    assert.ok(res.status >= 400);
    assert.equal(await Booking.countDocuments({ user: { $ne: null } }), 1);
  });

  console.log("\n--- existing rules at the booking step");

  await test("the free visit still enforces the service area", async () => {
    const start = await api("/api/auth/otp/email/start", { method: "POST", body: { email: "far.away@example.com" } });
    assert.equal(start.status, 200);
    const signup = await api("/api/auth/otp/email/verify", { method: "POST", body: { email: "far.away@example.com", code: codes["far.away@example.com"] } });
    const t = signup.body.token;
    await api("/api/auth/otp/phone/start", { method: "POST", body: { phone: "6315550302", smsTransactionalConsent: true } });
    await api("/api/auth/otp/phone/verify", { method: "POST", token: t, body: { phone: "6315550302", code: codes["+16315550302"], mode: "attach" } });
    await api("/api/users/me/profile", { method: "PATCH", token: t, body: { name: "Far Away" } });
    const home = await api("/api/users/me/addresses", { method: "POST", token: t, body: { line1: "5 Broadway", city: "New York", state: "NY", zip: "10004" } });
    assert.equal(home.body.serviceArea.inArea, false);
    const res = await book(t, home.body.address._id, openDay(2), "08:00");
    assert.ok(res.status >= 400, "out-of-area free visit refused");
    assert.equal(await Booking.countDocuments({ email: "far.away@example.com" }), 0);
  });

  await test("membership checkout asks for a missing phone before Stripe is ever called", async () => {
    await api("/api/auth/otp/email/start", { method: "POST", body: { email: "member.soon@example.com" } });
    const signup = await api("/api/auth/otp/email/verify", { method: "POST", body: { email: "member.soon@example.com", code: codes["member.soon@example.com"] } });
    const t = signup.body.token;
    const home = await api("/api/users/me/addresses", { method: "POST", token: t, body: { line1: "9 Ocean Ave", city: "Babylon", state: "NY", zip: "11702" } });
    const before = stripeSessions;
    const res = await api("/api/stripe/checkout/create-checkout-session", {
      method: "POST",
      token: t,
      body: { plan: "basic", addressId: home.body.address._id, billingCycle: "monthly" },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "CONTACT_REQUIRED");
    assert.deepEqual(res.body.missing, ["name", "phone"]);
    assert.equal(stripeSessions, before, "no Stripe session was opened");
  });

  server.close();
  await mongoose.disconnect();
  await replSet.stop();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
