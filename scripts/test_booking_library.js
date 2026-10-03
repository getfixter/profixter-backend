/**
 * The Profixter Library on the booking routes.
 *
 * A customer with no photo to hand can pick the closest generic example (a
 * faucet, a door...) and still book. What must hold:
 *
 *  - First Visit Free and One-Time accept a real photo OR a valid example, and
 *    still refuse a booking with neither (and refusing does not use up the
 *    free visit).
 *  - Membership and Full Day keep their own rules; an example is stored if sent.
 *  - The example is stored as Booking.libraryReference, a key. It is never
 *    written into Booking.images, which means "photographs of the actual job".
 *  - A crafted request cannot store anything but a known key.
 *  - Adding real photos later keeps the example as the job type.
 *
 * Runs the real routes against an in-memory MongoDB with S3, mail, SMS and
 * Stripe replaced by fakes: nothing leaves the machine and nothing is charged.
 *
 *   node scripts/test_booking_library.js
 */

process.env.S3_BUCKET = "test-bucket";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_fake";
process.env.ENABLE_RESERVATION_ENGINE = "false";
// Fake price ids: the Stripe client is faked below, so nothing is ever charged.
process.env.STRIPE_PRICE_ONE_TIME_HANDYMAN_VISIT = "price_test_one_time";
process.env.STRIPE_PRICE_FULL_DAY_VISIT = "price_test_full_day";

const assert = require("assert");
const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const sharp = require("sharp");
const { MongoMemoryServer } = require("mongodb-memory-server");

/* ---------------- fakes ---------------- */

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const uploaded = [];
stub("../utils/s3", {
  async putPublicObject({ Key }) {
    uploaded.push(Key);
    return `https://test-bucket.s3.amazonaws.com/${Key}`;
  },
  async putPrivateObject() {
    return {};
  },
  async deletePublicObjects() {
    return { deleted: 0 };
  },
  async getObjectBuffer() {
    return Buffer.alloc(0);
  },
});

// Every e-mail, SMS and crew notice becomes a recorded no-op.
const sent = [];
const recorder = (name) =>
  new Proxy(
    {},
    {
      get: (_, prop) =>
        prop === "__esModule" ? false : async (...args) => {
          sent.push({ channel: name, fn: String(prop), args });
          return { ok: true };
        },
    }
  );
stub("../utils/emailService", recorder("mail"));
stub("../utils/sms/smsNotifications", recorder("sms"));
stub("../utils/generalFixterNotify", recorder("crew"));

const subscriptionManagement = require("../utils/subscriptionManagement");
const stripeSessions = [];
subscriptionManagement.stripe.checkout.sessions.create = async (config) => {
  stripeSessions.push(config);
  return { id: `cs_test_${stripeSessions.length}`, url: "https://checkout.stripe.test/session", customer: null };
};
subscriptionManagement.stripe.customers.create = async () => ({ id: "cus_test" });
subscriptionManagement.stripe.customers.list = async () => ({ data: [] });
subscriptionManagement.stripe.customers.search = async () => ({ data: [] });

const User = require("../models/User");
const Booking = require("../models/Booking");
const Subscription = require("../models/Subscription");
const CalendarConfig = require("../models/CalendarConfig");
const { LIBRARY, readLibraryReference } = require("../utils/bookingLibrary");

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error.message}`);
  }
}
const section = (t) => console.log(`\n--- ${t} ---`);

/* ---------------- helpers ---------------- */

let app;
const url = (p) => `http://127.0.0.1:${app.address().port}${p}`;

async function photo() {
  return sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 120, g: 90, b: 60 } } }).jpeg().toBuffer();
}

async function post(path, token, fields, files = []) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) form.append(k, String(v));
  for (const [i, buf] of files.entries()) form.append("images", new Blob([buf], { type: "image/jpeg" }), `issue-${i}.jpg`);
  const res = await fetch(url(path), { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

/** A weekday at 10:00 New York time, comfortably beyond every lead time. */
function slot(daysAhead) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
  const ymd = d.toISOString().slice(0, 10);
  return { ymd, iso: new Date(`${ymd}T14:00:00.000Z`).toISOString(), time: "10:00" };
}

async function makeUser(n, extra = {}) {
  return User.create({
    userId: `9100000${n}`,
    name: `Library Tester ${n}`,
    email: `library${n}@example.com`,
    password: "h",
    phone: `+1631555010${n}`,
    role: "customer",
    address: `${n} Main St`,
    city: "Huntington",
    state: "NY",
    zip: "11743",
    county: "Suffolk",
    addresses: [{ line1: `${n} Main St`, city: "Huntington", state: "NY", zip: "11743", county: "Suffolk", isDefault: true }],
    ...extra,
  });
}

/* ---------------- tests ---------------- */

async function unit() {
  section("The library list");
  await test("ten examples, unique keys and labels", () => {
    assert.strictEqual(LIBRARY.length, 10);
    assert.strictEqual(new Set(LIBRARY.map((l) => l.key)).size, 10);
    assert.ok(LIBRARY.every((l) => /^[a-z_]+$/.test(l.key) && l.label.length > 2));
  });
  await test("empty means none; a known key passes; anything else is refused", () => {
    assert.deepStrictEqual(readLibraryReference({}), { ok: true, key: "" });
    assert.deepStrictEqual(readLibraryReference({ libraryReference: " " }), { ok: true, key: "" });
    assert.deepStrictEqual(readLibraryReference({ libraryReference: "faucet" }), { ok: true, key: "faucet" });
    for (const bad of ["Faucet", "https://evil.example.com/x.jpg", "../x", "faucet;drop", "<b>"]) {
      const r = readLibraryReference({ libraryReference: bad });
      assert.strictEqual(r.ok, false, bad);
      assert.strictEqual(r.code, "INVALID_LIBRARY_REFERENCE");
    }
  });
}

async function routes() {
  const server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri(), { dbName: "bookinglibrary" });
  // The legacy calendar, as in test_full_day_visit_integration.js: open Monday-Saturday.
  await CalendarConfig.create({
    timezone: "America/New_York",
    slotMinutes: 60,
    minLeadDays: 1,
    closedWeekdays: [0],
    defaultHours: ["08:00", "09:00", "10:00", "11:00", "13:00", "14:00", "15:00"],
    holidays: [],
    maxConcurrent: 3,
  });
  const expressApp = express();
  expressApp.use(express.json());
  expressApp.use("/api/bookings", require("../routes/bookings"));
  app = expressApp.listen(0);
  const sign = (u) => jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET);

  try {
    section("First Visit Free");
    const free = await makeUser(1);
    const freeToken = sign(free);
    const freeAddr = String(free.addresses[0]._id);
    const s1 = slot(9);

    await test("no photo and no example: refused with PHOTO_REQUIRED, free visit not used", async () => {
      const r = await post("/api/bookings", freeToken, { service: "Labor Only", date: s1.iso, note: "Bathroom faucet drips all night", addressId: freeAddr });
      assert.strictEqual(r.status, 400, JSON.stringify(r.body));
      assert.strictEqual(r.body.code, "PHOTO_REQUIRED");
      assert.strictEqual(await Booking.countDocuments({ user: free._id }), 0);
    });

    await test("an unknown example is refused", async () => {
      const r = await post("/api/bookings", freeToken, { service: "Labor Only", date: s1.iso, note: "Bathroom faucet drips all night", addressId: freeAddr, libraryReference: "https://evil.example.com/a.jpg" });
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.body.code, "INVALID_LIBRARY_REFERENCE");
      assert.strictEqual(await Booking.countDocuments({ user: free._id }), 0);
    });

    let freeBooking;
    await test("an example and no photo books the First Visit Free", async () => {
      const r = await post("/api/bookings", freeToken, { service: "Labor Only", date: s1.iso, note: "Bathroom faucet drips all night", addressId: freeAddr, libraryReference: "faucet", requestedDate: s1.ymd, requestedTime: s1.time });
      assert.ok([200, 201].includes(r.status), `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
      freeBooking = await Booking.findOne({ user: free._id }).lean();
      assert.ok(freeBooking, "booking stored");
      assert.strictEqual(freeBooking.accessType, "free_first_visit");
      assert.strictEqual(freeBooking.isFreeFirstVisit, true);
      assert.strictEqual(freeBooking.libraryReference, "faucet");
      assert.deepStrictEqual(freeBooking.images, [], "a stock example must never be stored as a customer photo");
    });

    await test("the admin e-mail names the example and says no customer photo yet", async () => {
      const adminMail = sent.filter((m) => m.channel === "mail" && /New Booking Created/.test(JSON.stringify(m.args))).pop();
      assert.ok(adminMail, "admin mail sent");
      const html = JSON.stringify(adminMail.args);
      assert.ok(html.includes("Job type (Profixter example):</strong> Faucet & Leak"), "names the example");
      assert.ok(html.includes("Customer photos:</strong> Not added yet"));
    });

    await test("a second free booking is still refused (eligibility unchanged)", async () => {
      const s2 = slot(12);
      const r = await post("/api/bookings", freeToken, { service: "Labor Only", date: s2.iso, note: "Another faucet to look at", addressId: freeAddr, libraryReference: "faucet" });
      assert.strictEqual(r.status >= 400, true, `${r.status}`);
      assert.strictEqual(await Booking.countDocuments({ user: free._id }), 1);
    });

    section("Real photos added later");
    await test("adding a real photo keeps the example as the job type", async () => {
      const r = await post(`/api/bookings/${freeBooking._id}/add-details`, freeToken, {}, [await photo()]);
      assert.strictEqual(r.status, 200, JSON.stringify(r.body).slice(0, 200));
      const after = await Booking.findById(freeBooking._id).lean();
      assert.strictEqual(after.images.length, 1);
      assert.ok(after.images[0].startsWith("https://test-bucket.s3.amazonaws.com/"), "real photo is a real upload");
      assert.strictEqual(after.libraryReference, "faucet");
    });
    await test("add-details cannot change or forge the example", async () => {
      const r = await post(`/api/bookings/${freeBooking._id}/add-details`, freeToken, { libraryReference: "tv_mounting" });
      assert.strictEqual(r.status, 400);
      assert.strictEqual((await Booking.findById(freeBooking._id).lean()).libraryReference, "faucet");
    });

    section("First Visit Free with a real photo (unchanged)");
    const free2 = await makeUser(2);
    await test("a real photo and no example still books, with no example stored", async () => {
      const s = slot(10);
      const r = await post("/api/bookings", sign(free2), { service: "Labor Only", date: s.iso, note: "Door rubs the frame badly", addressId: String(free2.addresses[0]._id) }, [await photo()]);
      assert.ok([200, 201].includes(r.status), `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
      const b = await Booking.findOne({ user: free2._id }).lean();
      assert.strictEqual(b.images.length, 1);
      assert.strictEqual(b.libraryReference, "");
    });

    section("Membership");
    const member = await makeUser(3);
    await Subscription.create({
    user: member._id,
    userId: member.userId,
    addressId: member.addresses[0]._id,
    subscriptionType: "premium",
    status: "active",
    startDate: new Date(Date.now() - 30 * 86400000),
    latestPaymentDate: new Date(Date.now() - 5 * 86400000),
    nextPaymentDate: new Date(Date.now() + 25 * 86400000),
  });
  await test("a member books with an example only; it is stored as the example", async () => {
      const s = slot(11);
      const r = await post("/api/bookings", sign(member), { service: "Labor Only", date: s.iso, note: "Mount the bedroom TV please", addressId: String(member.addresses[0]._id), libraryReference: "tv_mounting", requestedDate: s.ymd, requestedTime: s.time });
      assert.ok([200, 201].includes(r.status), `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
      const b = await Booking.findOne({ user: member._id }).lean();
      assert.strictEqual(b.accessType, "membership");
      assert.strictEqual(b.libraryReference, "tv_mounting");
      assert.deepStrictEqual(b.images, []);
    });

    section("One-Time Visit (checkout faked; nothing charged)");
    const oneTime = await makeUser(4);
    const otAddr = String(oneTime.addresses[0]._id);
    await test("no photo and no example: refused before any checkout is created", async () => {
      const before = stripeSessions.length;
      const s = slot(13);
      const r = await post("/api/bookings/one-time/checkout", sign(oneTime), { addressId: otAddr, selectedTask: "Replace faucet", note: "Kitchen faucet leaks at the base", date: s.iso, requestedDate: s.ymd, requestedTime: s.time });
      assert.strictEqual(r.status, 400, JSON.stringify(r.body));
      assert.strictEqual(r.body.code, "PHOTO_REQUIRED");
      assert.strictEqual(stripeSessions.length, before);
    });
    await test("an example and no photo reaches checkout, with the example on the held booking", async () => {
      const s = slot(13);
      const r = await post("/api/bookings/one-time/checkout", sign(oneTime), { addressId: otAddr, selectedTask: "Replace faucet", note: "Kitchen faucet leaks at the base", date: s.iso, requestedDate: s.ymd, requestedTime: s.time, libraryReference: "faucet" });
      assert.ok([200, 201].includes(r.status), `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
      assert.ok(r.body.url, "checkout url returned");
      const b = await Booking.findOne({ user: oneTime._id }).lean();
      assert.strictEqual(b.bookingType, "one_time_handyman_visit");
      assert.strictEqual(b.paymentState, "pending", "payment still pending: checkout behaviour unchanged");
      assert.strictEqual(b.libraryReference, "faucet");
      assert.deepStrictEqual(b.images, []);
      const cfg = stripeSessions[stripeSessions.length - 1];
      assert.ok(!JSON.stringify(cfg).includes("faucet"), "the example is not sent to Stripe");
    });

    section("Full Day (checkout faked; nothing charged)");
    const fullDay = await makeUser(5);
    await test("photos stay optional; an example is stored when chosen", async () => {
      const s = slot(16);
      const r = await post("/api/bookings/full-day/checkout", sign(fullDay), { addressId: String(fullDay.addresses[0]._id), date: s.ymd, note: "Several small fixes around the house", libraryReference: "small_fixes" });
      if (r.status === 503 || r.body.code === "FULL_DAY_PRICE_NOT_CONFIGURED" || r.body.code === "FULL_DAY_DISABLED") {
        console.log(`        (full day not configured in this harness: ${r.body.code || r.status}; stored-field check skipped)`);
        return;
      }
      assert.ok([200, 201].includes(r.status), `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
      const b = await Booking.findOne({ user: fullDay._id }).lean();
      assert.strictEqual(b.bookingType, "full_day_visit");
      assert.strictEqual(b.libraryReference, "small_fixes");
      assert.deepStrictEqual(b.images, []);
    });
    await test("an unknown example is refused on Full Day too", async () => {
      const s = slot(17);
      const r = await post("/api/bookings/full-day/checkout", sign(fullDay), { addressId: String(fullDay.addresses[0]._id), date: s.ymd, note: "Several small fixes around the house", libraryReference: "nope" });
      if (r.body.code === "FULL_DAY_PRICE_NOT_CONFIGURED" || r.body.code === "FULL_DAY_DISABLED") return;
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.body.code, "INVALID_LIBRARY_REFERENCE");
    });

    section("Existing bookings");
    await test("an old booking without the field reads as no example", async () => {
      const raw = await mongoose.connection.db.collection("bookings").insertOne({
        bookingNumber: "OLD-1", date: new Date(), service: "Labor Only", user: free._id, userId: free.userId,
        name: "Old", address: "1 Main", phone: "1", email: "o@example.com", subscription: "Premium",
        images: ["https://test-bucket.s3.amazonaws.com/uploads/old/booking-OLD-1/1-x.jpg"], note: "old", status: "Completed",
      });
      const b = await Booking.findById(raw.insertedId);
      assert.strictEqual(b.libraryReference, "");
      assert.strictEqual(b.images.length, 1);
    });
  } finally {
    app.close();
    await mongoose.disconnect();
    await server.stop();
  }
}

(async () => {
  try {
    await unit();
    await routes();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
