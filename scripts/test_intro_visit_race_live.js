/**
 * First Visit Free — concurrency probe against a LOCAL running backend.
 *
 * Answers one question: can a user race two requests and obtain TWO free
 * introductory bookings, given that claimIntroVisit runs after booking commit?
 *
 *   API_BASE=http://127.0.0.1:5000 \
 *   MONGO_URI="mongodb://127.0.0.1:27018/profixter_test?directConnection=true" \
 *   node scripts/test_intro_visit_race_live.js
 */

const mongoose = require("mongoose");

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

async function login(email, password) {
  const res = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json();
  if (!json.token) throw new Error(`login failed: ${JSON.stringify(json)}`);
  return json.token;
}

async function bookFree(token, addressId, date, time, note) {
  const form = new FormData();
  form.append("service", "Labor Only");
  form.append("date", `${date}T12:00:00.000Z`);
  form.append("requestedDate", date);
  form.append("requestedTime", time);
  form.append("addressId", addressId);
  form.append("note", note);

  const res = await fetch(`${API}/api/bookings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  let json;
  try { json = await res.json(); } catch { json = { parseError: true }; }
  return { status: res.status, body: json };
}

/** Next weekday (Mon-Sat) at least `minDays` out, in America/New_York terms. */
function nextOpenDate(minDays = 5) {
  for (let i = minDays; i < minDays + 10; i += 1) {
    const d = new Date(Date.now() + 86400000 * i);
    if (d.getUTCDay() !== 0) return d.toISOString().slice(0, 10);
  }
  throw new Error("no open date found");
}

async function openSlots(token, date) {
  const res = await fetch(`${API}/api/calendar/slots?date=${date}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  return (json.slots || []).filter((s) => (json.remaining || {})[s] > 0);
}

async function main() {
  await mongoose.connect(uri);

  // Clear reservation state so slots are genuinely free for this probe.
  const collections = await mongoose.connection.db.listCollections().toArray();
  for (const name of ["bookingslotreservations", "reservationtimebuckets", "reservationcapacitybuckets", "slotcounters"]) {
    if (collections.some((c) => c.name === name)) {
      await mongoose.connection.db.collection(name).deleteMany({});
    }
  }
  await Booking.deleteMany({ email: /@fvftest\.local$/ });

  const user = await User.findOne({ email: "new@fvftest.local" });
  user.addresses[0].introVisit = undefined;
  await user.save();

  const addressId = String(user.addresses[0]._id);
  const token = await login("new@fvftest.local", "TestPass123!");

  const date = nextOpenDate(5);
  const slots = await openSlots(token, date);
  console.log(`\nProbe date ${date} — open slots: ${slots.join(", ") || "(none)"}`);
  if (slots.length < 2) {
    console.log("Not enough open slots to probe a two-slot race.");
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log(`Firing two simultaneous free-visit bookings at ${slots[0]} and ${slots[1]}...\n`);

  const [a, b] = await Promise.all([
    bookFree(token, addressId, date, slots[0], "race A"),
    bookFree(token, addressId, date, slots[1], "race B"),
  ]);

  console.log(`  A -> ${a.status} ${a.body.message || a.body.code || ""}`);
  console.log(`  B -> ${b.status} ${b.body.message || b.body.code || ""}`);

  const freeBookings = await Booking.find({
    user: user._id,
    isFreeFirstVisit: true,
    status: { $nin: ["Canceled", "Cancelled"] },
  }).lean();

  const reloaded = await User.findOne({ email: "new@fvftest.local" });
  const state = reloaded.addresses[0].introVisit;

  console.log(`\n  free bookings created: ${freeBookings.length}`);
  console.log(`  introVisit state: ${state?.status} (bookingId ${state?.bookingId})`);

  const exploited = freeBookings.length > 1;
  console.log(
    `\n  VERDICT: ${exploited
      ? "EXPLOITABLE — two free visits obtained from one eligibility"
      : "NOT EXPLOITABLE — only one free visit granted"}\n`
  );

  await mongoose.disconnect();
  process.exit(exploited ? 1 : 0);
}

main().catch(async (err) => {
  console.error("RACE PROBE FAILED:", err.message);
  try { await mongoose.disconnect(); } catch {}
  process.exit(2);
});
