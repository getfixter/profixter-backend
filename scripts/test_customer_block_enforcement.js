/**
 * A blocked customer is refused at every booking, request and checkout entry
 * point: by account, by email and by phone in any format - never by address.
 * Unblocking keeps the history.
 *
 *   node scripts/test_customer_block_enforcement.js
 *
 * In-memory Mongo and the real routers. Stripe is faked on the shared client;
 * every refusal under test happens before anything would reach it.
 */
Object.assign(process.env, {
  NODE_ENV: "test",
  S3_BUCKET: "test-bucket",
  AWS_REGION: "us-east-1",
  JWT_SECRET: "test-secret-block-enforcement",
  STRIPE_SECRET_KEY: "sk_test_fake_never_called",
  MAIL_ADMIN: "owner@example.com",
  CLIENT_URL: "https://www.profixter.com",
  GIFTS_ENABLED: "true",
  STRIPE_PRODUCT_GIFT_BASIC: "prod_TestGiftBasic1",
  STRIPE_PRODUCT_GIFT_PLUS: "prod_TestGiftPlus1",
  STRIPE_PRODUCT_GIFT_PREMIUM: "prod_TestGiftPremium1",
  STRIPE_PRODUCT_GIFT_ELITE: "prod_TestGiftElite1",
});

const assert = require("node:assert/strict");
const crypto = require("crypto");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const User = require("../models/User");
const Blacklist = require("../models/Blacklist");
const AdminActivityLog = require("../models/AdminActivityLog");
const AdminPaymentLink = require("../models/AdminPaymentLink");
const sm = require("../utils/subscriptionManagement");
const { findActiveBlock, BLOCKED_CODE } = require("../utils/customerBlock");
const { openMembershipCheckout, CheckoutRefusal } = require("../utils/membershipCheckout");

const stripeCalls = [];
for (const [resource, methods] of Object.entries({ prices: ["list", "retrieve"], customers: ["list", "create"], subscriptions: ["list"], checkout: [] })) {
  for (const m of methods) {
    sm.stripe[resource][m] = async (...args) => {
      stripeCalls.push(`${resource}.${m}`);
      return { data: [] };
    };
  }
}
sm.stripe.checkout.sessions.create = async () => {
  stripeCalls.push("checkout.sessions.create");
  throw new Error("must not open a checkout for a blocked person");
};

const app = express();
app.use(express.json());
app.use("/api/admin", require("../routes/admin"));
app.use("/api/bookings", require("../routes/bookings"));
app.use("/api/free-visit-requests", require("../routes/freeVisitRequests"));
app.use("/api/gifts", require("../routes/gifts"));
app.use("/api/pay", require("../routes/pay"));

let base;
let passed = 0;
const failures = [];
async function test(name, fn) {
  await Promise.all([User.deleteMany({}), Blacklist.collection.deleteMany({}), AdminActivityLog.deleteMany({}), AdminPaymentLink.deleteMany({})]);
  stripeCalls.length = 0;
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error.stack}`);
  }
}

const token = (user) => jwt.sign({ id: String(user._id), tv: 0 }, process.env.JWT_SECRET);
async function call(method, path, user, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(user ? { Authorization: `Bearer ${token(user)}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = {};
  try {
    json = await response.json();
  } catch {
    json = {};
  }
  return { status: response.status, body: json };
}

let seq = 0;
const HOME = { label: "Home", line1: "12 Oak Street", city: "Massapequa", state: "NY", zip: "11758" };
async function mk(over = {}) {
  seq += 1;
  const user = await User.create({ userId: String(40000000 + seq), name: `Pat Person${seq}`, email: `p${seq}@example.com`, role: "customer", addresses: [HOME], ...over });
  user.defaultAddressId = user.addresses[0]?._id || null;
  await user.save();
  return user;
}
const owner = () => mk({ name: "Owner Person", email: "owner@example.com", addresses: [] });

const isBlockedResponse = (res) => res.status === 403 && res.body.code === BLOCKED_CODE;
const BOOKING_PATHS = ["/api/bookings", "/api/bookings/one-time/checkout", "/api/bookings/full-day/book", "/api/bookings/full-day/checkout", "/api/bookings/first-visit-draft"];

async function block(boss, user, reason = "Repeated no-shows") {
  const res = await call("POST", `/api/admin/customers/${user._id}/block`, boss, { reason });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res;
}

function freeVisitBody(over = {}) {
  const day = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return { name: "Jamie Guest", phone: "516.555.0199", email: "jamie@example.com", requestedDate: day, requestedTime: "10:00", note: "fix the door please", ...over };
}

async function run() {
  console.log("\nAdmin block");

  await test("blocking needs a reason and blacklist.manage; the entry stores normalized email and phone digits", async () => {
    const boss = await owner();
    const user = await mk({ phone: "+16315550101", email: "Casey@Example.com" });
    const clerk = await mk({ role: "employee", name: "Clerk Person", adminSections: ["customers"], addresses: [] });
    assert.equal((await call("POST", `/api/admin/customers/${user._id}/block`, clerk, { reason: "x y z" })).status, 403);
    assert.equal((await call("POST", `/api/admin/customers/${user._id}/block`, boss, {})).body.code, "REASON_REQUIRED");
    await block(boss, user);
    const entry = await Blacklist.findOne({ user: user._id }).lean();
    assert.equal(entry.email, "casey@example.com");
    assert.equal(entry.phoneDigits, "6315550101");
    assert.equal(entry.reason, "Repeated no-shows");
    assert.ok(await AdminActivityLog.exists({ action: "Customer Blocked", entityId: String(user._id) }));
    assert.equal((await call("POST", `/api/admin/customers/${user._id}/block`, boss, { reason: "again" })).body.code, "ALREADY_BLOCKED");
  });

  console.log("\nEnforced at every entry point");

  await test("every signed-in booking route refuses the blocked account (by account id)", async () => {
    const boss = await owner();
    const user = await mk({ phone: "+16315550101" });
    await block(boss, user);
    for (const path of BOOKING_PATHS) {
      const res = await call("POST", path, user, {});
      assert.ok(isBlockedResponse(res), `${path}: ${res.status} ${JSON.stringify(res.body)}`);
      assert.ok(!/block/i.test(res.body.message), "the message does not say 'blocked'");
    }
  });

  await test("a second account with the same phone written differently is refused (by normalized phone)", async () => {
    const boss = await owner();
    const user = await mk({ phone: "+16315550101" });
    await block(boss, user);
    const twin = await mk({ phone: "(631) 555-0101", email: "twin@example.com" });
    assert.ok(isBlockedResponse(await call("POST", "/api/bookings", twin, {})));
  });

  await test("an entry written before phoneDigits existed still matches any spelling", async () => {
    await Blacklist.collection.insertOne({ email: "old@example.com", phone: "631-555-0177", reason: "legacy", createdAt: new Date() });
    assert.ok(await findActiveBlock({ phone: "+1 (631) 555 0177" }));
    assert.ok(await findActiveBlock({ phone: "6315550177" }));
    assert.ok(await findActiveBlock({ email: "OLD@example.com" }));
    const user = await mk({ phone: "+16315550177", email: "fresh@example.com" });
    assert.ok(isBlockedResponse(await call("POST", "/api/bookings/one-time/checkout", user, {})));
  });

  await test("someone else at the same address is NOT blocked", async () => {
    const boss = await owner();
    const user = await mk({ phone: "+16315550101" });
    await block(boss, user);
    const neighbour = await mk({ phone: "+16315550999", email: "spouse@example.com" });
    for (const path of BOOKING_PATHS) {
      const res = await call("POST", path, neighbour, {});
      assert.ok(!isBlockedResponse(res), `${path} refused the neighbour`);
    }
    const fv = await call("POST", "/api/free-visit-requests", null, freeVisitBody({ phone: "6315550888", email: "other@example.com", formVersion: "cx4", line1: HOME.line1, city: HOME.city, zip: HOME.zip }));
    assert.ok(!isBlockedResponse(fv), JSON.stringify(fv.body));
  });

  await test("the guest free-visit request refuses the blocked email (any case) and phone (any format)", async () => {
    const boss = await owner();
    const user = await mk({ phone: "+15165550199", email: "jamie@example.com" });
    await block(boss, user);
    assert.ok(isBlockedResponse(await call("POST", "/api/free-visit-requests", null, freeVisitBody({ email: "JAMIE@example.com", phone: "631-555-0000" }))));
    assert.ok(isBlockedResponse(await call("POST", "/api/free-visit-requests", null, freeVisitBody({ email: "new@example.com", phone: "+1 (516) 555-0199" }))));
  });

  await test("membership checkout refuses before anything is opened at Stripe", async () => {
    const boss = await owner();
    const user = await mk({ phone: "+16315550101" });
    await block(boss, user);
    await assert.rejects(
      openMembershipCheckout({ userId: user._id, plan: "basic", billingCycle: "monthly", addressId: String(user.addresses[0]._id) }),
      (error) => error instanceof CheckoutRefusal && error.status === 403 && error.body.code === BLOCKED_CODE
    );
    assert.ok(!stripeCalls.includes("checkout.sessions.create"));
    const sale = await call("POST", `/api/admin/customers/${user._id}/membership-sale`, boss, { plan: "basic", addressId: String(user.addresses[0]._id) });
    assert.equal(sale.status, 409);
    assert.equal(sale.body.code, "CUSTOMER_BLOCKED");
  });

  await test("gift checkout and gift claim refuse the blocked account", async () => {
    const boss = await owner();
    const user = await mk({ phone: "+16315550101" });
    await block(boss, user);
    assert.ok(isBlockedResponse(await call("POST", "/api/gifts/checkout-session", user, { plan: "basic", durationMonths: 3 })));
    assert.ok(isBlockedResponse(await call("POST", "/api/gifts/claim/sometoken", user, {})));
  });

  await test("a payment link sent before the block opens nothing", async () => {
    const boss = await owner();
    const user = await mk({ phone: "+16315550101" });
    const tokenValue = crypto.randomBytes(24).toString("base64url");
    await AdminPaymentLink.create({
      tokenHash: crypto.createHash("sha256").update(tokenValue).digest("hex"),
      kind: "membership",
      user: user._id,
      addressId: user.addresses[0]._id,
      plan: "basic",
      billingCycle: "monthly",
      expiresAt: new Date(Date.now() + 86400000),
      sentTo: { email: user.email, phone: user.phone },
    });
    await block(boss, user);
    const res = await call("POST", `/api/pay/${tokenValue}/checkout`, null, {});
    assert.ok(isBlockedResponse(res), JSON.stringify(res.body));
  });

  console.log("\nUnblock keeps history");

  await test("unblocking lifts the entry, keeps it, and the customer can book again", async () => {
    const boss = await owner();
    const user = await mk({ phone: "+16315550101" });
    await block(boss, user);
    const res = await call("DELETE", `/api/admin/customers/${user._id}/block`, boss, { reason: "Paid the bill" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.history.length, 1);
    assert.equal(res.body.history[0].active, false);
    assert.equal(res.body.history[0].liftReason, "Paid the bill");
    assert.equal(await Blacklist.collection.countDocuments({}), 1, "the entry is kept");
    assert.equal(await Blacklist.countDocuments({}), 0, "and ignored by every reader");
    assert.ok(!isBlockedResponse(await call("POST", "/api/bookings", user, {})));
    assert.ok(await AdminActivityLog.exists({ action: "Customer Unblocked" }));
    assert.equal((await call("DELETE", `/api/admin/customers/${user._id}/block`, boss, {})).body.code, "NOT_BLOCKED");
  });

  await test("the old blacklist endpoints still work, and their unblock keeps history too", async () => {
    const boss = await owner();
    const user = await mk({ phone: "+16315550101" });
    const add = await call("POST", `/api/admin/blacklist/${user._id}`, boss, { reason: "Admin action" });
    assert.equal(add.status, 200);
    assert.ok(isBlockedResponse(await call("POST", "/api/bookings", user, {})));
    const list = await call("GET", "/api/admin/blacklist", boss);
    assert.equal(list.body.length, 1);
    const removed = await call("DELETE", `/api/admin/blacklist/${add.body.id}`, boss);
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.equal((await call("GET", "/api/admin/blacklist", boss)).body.length, 0);
    const kept = await Blacklist.collection.findOne({ _id: new mongoose.Types.ObjectId(add.body.id) });
    assert.ok(kept.liftedAt, "kept with liftedAt");
    const activity = await call("GET", `/api/admin/users/${user._id}/activity?limit=all`, boss);
    const types = activity.body.items.map((i) => i.type);
    assert.ok(types.includes("blacklist_added") && types.includes("blacklist_lifted"), JSON.stringify(types));
  });
}

(async () => {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await User.syncIndexes();
  const server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run();
  } finally {
    server.close();
    await mongoose.disconnect();
    await mongod.stop();
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
