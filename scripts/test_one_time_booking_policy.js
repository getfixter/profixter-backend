const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const mongoose = require("mongoose");

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_policy";
process.env.STRIPE_PRICE_ONE_TIME_HANDYMAN_VISIT =
  process.env.STRIPE_PRICE_ONE_TIME_HANDYMAN_VISIT || "price_one_time_policy";
process.env.CLIENT_URL = process.env.CLIENT_URL || "https://example.test";
process.env.ENABLE_RESERVATION_ENGINE = "false";
process.env.S3_BUCKET = "";

const bookingHistoryPath = require.resolve("../utils/bookingHistory");
require.cache[bookingHistoryPath] = {
  id: bookingHistoryPath,
  filename: bookingHistoryPath,
  loaded: true,
  exports: {
    snapshot: () => ({}),
    logBookingChanges: async () => {},
    logBookingCreated: async () => {},
  },
};

const entitlementIndexPath = require.resolve("../utils/visitEntitlementIndexSafety");
require.cache[entitlementIndexPath] = {
  id: entitlementIndexPath,
  filename: entitlementIndexPath,
  loaded: true,
  exports: {
    ensureVisitEntitlementIndexesOnce: async () => ({ ready: true }),
  },
};

const s3Path = require.resolve("../utils/s3");
require.cache[s3Path] = {
  id: s3Path,
  filename: s3Path,
  loaded: true,
  exports: {
    deletePublicObjects: async () => {},
    putPublicObject: async ({ Key }) => `s3://test/${Key}`,
  },
};

const User = require("../models/User");
const Booking = require("../models/Booking");
const VisitEntitlement = require("../models/VisitEntitlement");
const CalendarConfig = require("../models/CalendarConfig");
const SlotCounter = require("../models/SlotCounter");
const OneTimeVisitSettings = require("../models/OneTimeVisitSettings");
const subscriptionManagement = require("../utils/subscriptionManagement");

const userId = new mongoose.Types.ObjectId();
const addressId = new mongoose.Types.ObjectId();
const savedBookings = [];
const entitlements = [];
const sessions = [];
const slotCounts = new Map();

function leanResult(value) {
  return {
    lean: async () => value,
  };
}

function makeUser() {
  const subdoc = {
    _id: addressId,
    line1: "100 Main Street",
    city: "Babylon",
    state: "NY",
    zip: "11702",
    county: "Suffolk",
  };
  const addresses = [subdoc];
  addresses.id = (id) => (String(id) === String(addressId) ? subdoc : null);

  return {
    _id: userId,
    userId: "PF-ONE-TIME",
    name: "Policy Tester",
    email: "policy@example.com",
    phone: "6315991363",
    stripeCustomerId: "cus_policy",
    addresses,
  };
}

User.findById = async () => makeUser();
OneTimeVisitSettings.findOne = () => leanResult(null);
CalendarConfig.findOne = () =>
  leanResult({ timezone: "America/New_York", maxConcurrent: 1 });

Booking.find = () => {
  throw new Error("One-Time Visit checkout must not query active bookings");
};

Booking.prototype.save = async function saveMock() {
  savedBookings.push(this);
  return this;
};

VisitEntitlement.create = async (data) => {
  const doc = {
    ...data,
    _id: new mongoose.Types.ObjectId(),
    saveCalls: 0,
    async save() {
      this.saveCalls += 1;
      return this;
    },
  };
  entitlements.push(doc);
  return doc;
};

SlotCounter.findOneAndUpdate = async (query) => {
  const key = `${query.ymd}:${query.time}`;
  const current = slotCounts.get(key) || 0;
  if (current >= 1) return null;
  const next = current + 1;
  slotCounts.set(key, next);
  return { ymd: query.ymd, time: query.time, count: next };
};

SlotCounter.updateOne = async () => ({ modifiedCount: 1 });

subscriptionManagement.stripe.customers.list = async () => ({ data: [] });
subscriptionManagement.stripe.checkout.sessions.create = async (config) => {
  const id = `cs_policy_${sessions.length + 1}`;
  const session = {
    id,
    url: `https://checkout.stripe.test/${id}`,
    customer: config.customer || "cus_policy",
    config,
  };
  sessions.push(session);
  return session;
};

const router = require("../routes/bookings");

function oneTimeCheckoutHandler() {
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/one-time/checkout"
  );
  assert(layer, "One-Time Visit checkout route is missing");
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function mockReq({ requestedDate, requestedTime }) {
  return {
    user: { id: String(userId) },
    authUser: { _id: userId, name: "Policy Tester", email: "policy@example.com" },
    body: {
      addressId: String(addressId),
      selectedTask: "Replace faucet",
      requestedDate,
      requestedTime,
      date: `${requestedDate}T${requestedTime}:00.000Z`,
      note: "Replace faucet in bathroom",
    },
    files: [
      {
        originalname: "faucet.jpg",
        mimetype: "image/jpeg",
        buffer: Buffer.from("fake image"),
      },
    ],
  };
}

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

async function callOneTimeCheckout(slot) {
  const req = mockReq(slot);
  const res = mockRes();
  await oneTimeCheckoutHandler()(req, res);
  return res;
}

function assertSourcePolicy() {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "routes", "bookings.js"),
    "utf8"
  );
  const oneTimeStart = source.indexOf('"/one-time/checkout"');
  const membershipStart = source.indexOf('router.post(\n  "/"');
  assert(oneTimeStart > 0, "one-time checkout source not found");
  assert(membershipStart > oneTimeStart, "membership booking source not found");

  const oneTimeSection = source.slice(oneTimeStart, membershipStart);
  const membershipSection = source.slice(membershipStart);

  assert.doesNotMatch(
    oneTimeSection,
    /already has an active booking|activeAddressBookings|activeCount >= 1/,
    "One-Time Visit checkout must not use subscription-style active booking limits"
  );
  assert.match(
    oneTimeSection,
    /SlotCounter\.findOneAndUpdate|createBookingWithReservation/,
    "One-Time Visit checkout must still reserve real slot capacity"
  );
  assert.match(
    membershipSection,
    /if \(bookingLimit > 0 && activeCount >= bookingLimit\)/,
    "Subscription active-booking limit guard was changed or removed"
  );
  assert.match(
    membershipSection,
    /This address allows 1 active booking at a time/,
    "Subscription active-booking limit copy was changed or removed"
  );
}

async function run() {
  assertSourcePolicy();

  const first = await callOneTimeCheckout({
    requestedDate: "2026-07-01",
    requestedTime: "10:00",
  });
  assert.equal(first.statusCode, 200);
  assert.match(first.body.url, /checkout\.stripe\.test/);

  const second = await callOneTimeCheckout({
    requestedDate: "2026-07-02",
    requestedTime: "10:00",
  });
  assert.equal(second.statusCode, 200);
  assert.match(second.body.url, /checkout\.stripe\.test/);

  assert.equal(
    savedBookings.length,
    2,
    "non-member should be able to create multiple future one-time checkout bookings for different slots"
  );
  assert.equal(entitlements.length, 2);
  assert.equal(sessions.length, 2);

  const memberWithActiveMembershipBooking = await callOneTimeCheckout({
    requestedDate: "2026-07-03",
    requestedTime: "10:00",
  });
  assert.equal(memberWithActiveMembershipBooking.statusCode, 200);
  assert.equal(
    savedBookings.length,
    3,
    "members should be able to buy a one-time visit even when membership bookings exist"
  );

  const duplicateSlot = await callOneTimeCheckout({
    requestedDate: "2026-07-01",
    requestedTime: "10:00",
  });
  assert.equal(duplicateSlot.statusCode, 409);
  assert.equal(duplicateSlot.body.code, "SLOT_UNAVAILABLE");
  assert.match(duplicateSlot.body.message, /fully booked|choose another time/i);

  console.log("One-Time Visit booking policy tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
