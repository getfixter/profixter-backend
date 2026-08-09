/**
 * First Visit Free — server-side photo requirement, against a LOCAL backend.
 *
 * Proves a crafted API request cannot skip the photo requirement, and that a
 * request WITH a valid photo succeeds.
 *
 *   API_BASE=http://127.0.0.1:5000 \
 *   MONGO_URI="mongodb://127.0.0.1:27018/profixter_test?directConnection=true" \
 *   node scripts/test_intro_visit_photo_live.js
 */

const mongoose = require("mongoose");
const zlib = require("zlib");

const API = process.env.API_BASE || "http://127.0.0.1:5000";
const uri = process.env.MONGO_URI || "";

if (!/127\.0\.0\.1|localhost/.test(uri) || !uri.includes("test")) {
  throw new Error("REFUSING TO RUN: MONGO_URI must be a local disposable test database.");
}
if (!/127\.0\.0\.1|localhost/.test(API)) {
  throw new Error("REFUSING TO RUN: API_BASE must be local.");
}

const User = require("../models/User");
const Booking = require("../models/Booking");

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

/** Smallest valid PNG (1x1, opaque) built without touching the filesystem. */
function tinyPngBuffer() {
  const crc = (buf) => {
    let c = ~0;
    for (const byte of buf) {
      c ^= byte;
      for (let i = 0; i < 8; i += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, crcBuf]);
  };
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // truecolor
  const raw = Buffer.from([0, 255, 255, 255]); // filter byte + one RGB pixel
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function login(email) {
  const res = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "TestPass123!" }),
  });
  const json = await res.json();
  if (!json.token) throw new Error(`login failed: ${JSON.stringify(json)}`);
  return json.token;
}

async function openSlot(token, date) {
  const res = await fetch(`${API}/api/calendar/slots?date=${date}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  return (json.slots || []).find((s) => (json.remaining || {})[s] > 0) || null;
}

function nextOpenDate(minDays = 5) {
  for (let i = minDays; i < minDays + 10; i += 1) {
    const d = new Date(Date.now() + 86400000 * i);
    if (d.getUTCDay() !== 0) return d.toISOString().slice(0, 10);
  }
  throw new Error("no open date");
}

async function book({ token, addressId, date, time, withPhoto }) {
  const form = new FormData();
  form.append("service", "Labor Only");
  form.append("date", `${date}T12:00:00.000Z`);
  form.append("requestedDate", date);
  form.append("requestedTime", time);
  form.append("addressId", addressId);
  form.append("note", "Bedroom door does not close correctly");
  if (withPhoto) {
    form.append(
      "images",
      new Blob([tinyPngBuffer()], { type: "image/png" }),
      "job.png"
    );
  }
  const res = await fetch(`${API}/api/bookings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  let body;
  try { body = await res.json(); } catch { body = {}; }
  return { status: res.status, body };
}

async function resetEligibility(email) {
  const user = await User.findOne({ email });
  await Booking.deleteMany({ user: user._id });
  user.addresses[0].introVisit = undefined;
  await user.save();
  return String(user.addresses[0]._id);
}

async function main() {
  await mongoose.connect(uri);

  // Clear reservation state so slots are genuinely free.
  const cols = await mongoose.connection.db.listCollections().toArray();
  for (const n of ["bookingslotreservations", "reservationtimebuckets", "reservationcapacitybuckets", "slotcounters"]) {
    if (cols.some((c) => c.name === n)) await mongoose.connection.db.collection(n).deleteMany({});
  }

  const token = await login("new@fvftest.local");
  const date = nextOpenDate(5);

  console.log("\nPHOTO REQUIREMENT — free first visit");

  /* --- 1. no photo must be rejected --- */
  let addressId = await resetEligibility("new@fvftest.local");
  let slot = await openSlot(token, date);
  const noPhoto = await book({ token, addressId, date, time: slot, withPhoto: false });
  check(
    "API rejects a free booking with NO photo",
    noPhoto.status === 400 && noPhoto.body.code === "PHOTO_REQUIRED",
    `got ${noPhoto.status} ${JSON.stringify(noPhoto.body).slice(0, 120)}`
  );

  const createdAfterReject = await Booking.countDocuments({ email: "new@fvftest.local" });
  check("no booking row was created on rejection", createdAfterReject === 0, `found ${createdAfterReject}`);

  const userAfterReject = await User.findOne({ email: "new@fvftest.local" });
  check(
    "eligibility was NOT consumed by the rejected attempt",
    !userAfterReject.addresses[0].introVisit?.status ||
      userAfterReject.addresses[0].introVisit.status === "available",
    `state=${userAfterReject.addresses[0].introVisit?.status}`
  );

  /* --- 2. with photo must succeed --- */
  slot = await openSlot(token, date);
  const withPhoto = await book({ token, addressId, date, time: slot, withPhoto: true });
  check(
    "API accepts a free booking WITH a photo",
    withPhoto.status === 200,
    `got ${withPhoto.status} ${JSON.stringify(withPhoto.body).slice(0, 160)}`
  );

  const booking = await Booking.findOne({ email: "new@fvftest.local" }).lean();
  check("booking was created", !!booking);
  if (booking) {
    check("booking is free (paymentState not_required)", booking.paymentState === "not_required");
    check("booking is flagged as the free first visit", booking.isFreeFirstVisit === true);
    check("booking stored the uploaded image", (booking.images || []).length >= 1,
      `images=${JSON.stringify(booking.images)}`);
  }

  const userAfter = await User.findOne({ email: "new@fvftest.local" });
  check("eligibility is now claimed", userAfter.addresses[0].introVisit?.status === "claimed");

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  await mongoose.disconnect();
  if (failures.length) {
    failures.forEach((f) => console.error(`FAILED: ${f}`));
    process.exit(1);
  }
  process.exit(0);
}

main().catch(async (err) => {
  console.error("PHOTO TEST CRASHED:", err.stack);
  try { await mongoose.disconnect(); } catch {}
  process.exit(2);
});
