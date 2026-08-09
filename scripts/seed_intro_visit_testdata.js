/**
 * First Visit Free — synthetic test data for LOCAL verification only.
 *
 * Refuses to run against anything that is not an explicitly local MongoDB.
 * No production data is read, copied or written.
 *
 *   MONGO_URI="mongodb://127.0.0.1:27018/profixter_test" node scripts/seed_intro_visit_testdata.js
 */

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const uri = process.env.MONGO_URI || "";

/* ----------------------- safety gate ----------------------- */
function assertLocalUri(value) {
  const lowered = String(value || "").toLowerCase();
  if (!lowered) {
    throw new Error("MONGO_URI is required.");
  }
  const isLocal =
    lowered.includes("://127.0.0.1") ||
    lowered.includes("://localhost") ||
    lowered.includes("@127.0.0.1") ||
    lowered.includes("@localhost");
  if (!isLocal) {
    throw new Error(
      "REFUSING TO RUN: MONGO_URI is not a local host. This script is for disposable local databases only."
    );
  }
  if (lowered.includes("mongodb+srv")) {
    throw new Error("REFUSING TO RUN: mongodb+srv indicates a hosted cluster.");
  }
  const dbName = lowered.split("/").pop().split("?")[0];
  if (!dbName.includes("test")) {
    throw new Error(
      `REFUSING TO RUN: database name "${dbName}" must contain "test" to confirm it is disposable.`
    );
  }
}

assertLocalUri(uri);

const User = require("../models/User");
const Subscription = require("../models/Subscription");
const Booking = require("../models/Booking");
const CalendarConfig = require("../models/CalendarConfig");
const CompanyAvailabilityTemplate = require("../models/CompanyAvailabilityTemplate");
const TechnicianAvailabilityTemplate = require("../models/TechnicianAvailabilityTemplate");

function userId() {
  return String(Math.floor(10000000 + Math.random() * 89999999));
}

async function main() {
  await mongoose.connect(uri);
  console.log(`Connected to ${uri}\n`);

  // Clear only synthetic records (all of them - this is a scratch DB).
  await Promise.all([
    User.deleteMany({ email: /@fvftest\.local$/ }),
    Booking.deleteMany({ email: /@fvftest\.local$/ }),
  ]);

  const password = await bcrypt.hash("TestPass123!", 10);

  /* --- Calendar config so availability can load --- */
  const existingCfg = await CalendarConfig.findOne();
  if (!existingCfg) {
    await CalendarConfig.create({
      timezone: "America/New_York",
      maxConcurrent: 2,
    });
    console.log("Created CalendarConfig (timezone America/New_York, maxConcurrent 2)");
  } else {
    console.log("CalendarConfig already present - left untouched");
  }

  /* --- Reservation-engine foundation so customer availability can load --- */
  const existingTemplate = await CompanyAvailabilityTemplate.findOne({ active: true });
  if (!existingTemplate) {
    // Mon-Sat, 8:00-16:00 appointment starts, capacity 2 per slot.
    const starts = ["08:00", "10:00", "12:00", "14:00", "16:00"].map((time) => ({
      time,
      capacity: 2,
    }));
    await CompanyAvailabilityTemplate.create({
      name: "Local Test Schedule",
      timezone: "America/New_York",
      slotMinutes: 120,
      visitDurationMinutes: 90,
      minLeadMinutes: 2880,
      maxAdvanceDays: 120,
      defaultCapacity: 2,
      active: true,
      version: 1,
      weeklySchedule: [1, 2, 3, 4, 5, 6].map((weekday) => ({
        weekday,
        enabled: true,
        starts,
        intervals: [],
      })),
    });
    console.log("Created CompanyAvailabilityTemplate (Mon-Sat, 5 starts/day, capacity 2)");
  } else {
    console.log("CompanyAvailabilityTemplate already present - left untouched");
  }

  /* --- A technician, so the reservation engine has real capacity --- */
  let tech = await User.findOne({ email: "tech@fvftest.local" });
  if (!tech) {
    tech = await User.create({
      userId: userId(),
      name: "Tomas Tester",
      email: "tech@fvftest.local",
      password,
      phone: "+16315550199",
      role: "employee",
      employeePosition: "Fixter",
      isActive: true,
    });
    await TechnicianAvailabilityTemplate.create({
      technicianId: tech._id,
      inheritCompanyHours: true,
      weeklySchedule: [],
      active: true,
    });
    console.log("Created technician Tomas Tester (inherits company hours)");
  } else {
    console.log("Technician already present - left untouched");
  }

  /* --- A. brand new non-member, eligible for the free visit --- */
  const newCustomer = await User.create({
    userId: userId(),
    name: "Ava Newcomer",
    email: "new@fvftest.local",
    password,
    phone: "+16315550101",
    role: "customer",
    isActive: true,
    address: "123 Main St",
    city: "Babylon",
    state: "NY",
    zip: "11702",
    county: "Suffolk",
    addresses: [
      { label: "Primary", line1: "123 Main St", city: "Babylon", state: "NY", zip: "11702", county: "Suffolk" },
    ],
  });
  newCustomer.defaultAddressId = newCustomer.addresses[0]._id;
  await newCustomer.save();

  /* --- B. non-member whose free visit is already CONSUMED --- */
  const consumedCustomer = await User.create({
    userId: userId(),
    name: "Cal Consumed",
    email: "consumed@fvftest.local",
    password,
    phone: "+16315550102",
    role: "customer",
    isActive: true,
    address: "9 Oak Ln",
    city: "Bay Shore",
    state: "NY",
    zip: "11706",
    county: "Suffolk",
    addresses: [
      { label: "Primary", line1: "9 Oak Ln", city: "Bay Shore", state: "NY", zip: "11706", county: "Suffolk" },
    ],
  });
  consumedCustomer.defaultAddressId = consumedCustomer.addresses[0]._id;
  consumedCustomer.addresses[0].introVisit = {
    status: "consumed",
    bookingId: null,
    claimedAt: new Date(Date.now() - 86400000 * 7),
    consumedAt: new Date(Date.now() - 86400000 * 6),
  };
  await consumedCustomer.save();

  /* --- C. active member (regression baseline) --- */
  const member = await User.create({
    userId: userId(),
    name: "Mia Member",
    email: "member@fvftest.local",
    password,
    phone: "+16315550103",
    role: "customer",
    isActive: true,
    address: "77 Shore Rd",
    city: "Massapequa",
    state: "NY",
    zip: "11758",
    county: "Nassau",
    addresses: [
      { label: "Primary", line1: "77 Shore Rd", city: "Massapequa", state: "NY", zip: "11758", county: "Nassau" },
    ],
  });
  member.defaultAddressId = member.addresses[0]._id;
  await member.save();

  const now = new Date();
  await Subscription.create({
    user: member._id,
    userId: member.userId,
    subscriptionType: "plus",
    addressId: member.addresses[0]._id,
    addressSnapshot: {
      line1: "77 Shore Rd", city: "Massapequa", state: "NY", zip: "11758", county: "Nassau",
    },
    billingCycle: "monthly",
    startDate: now,
    latestPaymentDate: now,
    nextPaymentDate: new Date(now.getTime() + 86400000 * 30),
    currentPeriodStart: now,
    currentPeriodEnd: new Date(now.getTime() + 86400000 * 30),
    accessStatus: "active",
    status: "active",
    planPrice: 249,
    // No stripeSubscriptionId: resolveBookingSubscription then trusts local
    // access state and never calls Stripe. Keeps this test offline.
  });

  /* --- D. legacy non-member with a pre-feature free booking (migration check) --- */
  const legacy = await User.create({
    userId: userId(),
    name: "Leo Legacy",
    email: "legacy@fvftest.local",
    password,
    phone: "+16315550104",
    role: "customer",
    isActive: true,
    address: "5 Elm Ct",
    city: "Lindenhurst",
    state: "NY",
    zip: "11757",
    county: "Suffolk",
    addresses: [
      { label: "Primary", line1: "5 Elm Ct", city: "Lindenhurst", state: "NY", zip: "11757", county: "Suffolk" },
    ],
  });
  legacy.defaultAddressId = legacy.addresses[0]._id;
  await legacy.save();

  // A completed free visit that predates the introVisit field entirely.
  await Booking.create({
    bookingNumber: 900001,
    date: new Date(Date.now() - 86400000 * 10),
    service: "Labor Only",
    user: legacy._id,
    userId: legacy.userId,
    name: legacy.name,
    phone: legacy.phone,
    email: legacy.email,
    addressId: legacy.addresses[0]._id,
    address: "5 Elm Ct",
    city: "Lindenhurst",
    state: "NY",
    zip: "11757",
    county: "Suffolk",
    subscription: "Free visit",
    accessType: "free_first_visit",
    bookingType: "membership_visit",
    paymentState: "not_required",
    isFreeFirstVisit: true,
    freeFirstVisitClaimedAt: new Date(Date.now() - 86400000 * 12),
    status: "Completed",
    completedAt: new Date(Date.now() - 86400000 * 10),
    note: "Legacy completed free visit",
  });

  console.log("Synthetic accounts (password: TestPass123!)\n");
  console.log("  new@fvftest.local        eligible non-member    123 Main St, Babylon 11702");
  console.log("  consumed@fvftest.local   free visit consumed    9 Oak Ln, Bay Shore 11706");
  console.log("  member@fvftest.local     ACTIVE MEMBER (plus)   77 Shore Rd, Massapequa 11758");
  console.log("  legacy@fvftest.local     pre-feature completed  5 Elm Ct, Lindenhurst 11757");
  console.log("\nSeed complete.");

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("\nSEED FAILED:", err.message);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
