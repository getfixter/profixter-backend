/**
 * The redesigned Admin customer list, search, profile, billing proxy, notes,
 * archive, delete confirmation and communication history.
 *
 *   node scripts/test_admin_customer_directory.js
 *
 * In-memory Mongo and the real admin router. Stripe is a fake injected into
 * utils/admin/customerBilling (setStripeClient); nothing reaches Stripe.
 */
Object.assign(process.env, {
  NODE_ENV: "test",
  S3_BUCKET: "test-bucket",
  AWS_REGION: "us-east-1",
  JWT_SECRET: "test-secret-admin-directory",
  STRIPE_SECRET_KEY: "sk_live_fake_never_called",
  MAIL_ADMIN: "owner@example.com",
  CLIENT_URL: "https://www.profixter.com",
});

const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const User = require("../models/User");
const Booking = require("../models/Booking");
const Subscription = require("../models/Subscription");
const AdminActivityLog = require("../models/AdminActivityLog");
const EmailLog = require("../models/EmailLog");
const { SECTIONS_VERSION } = require("../utils/adminAccess");
const billing = require("../utils/admin/customerBilling");
const { formatAddressLine, formatPhone } = require("../utils/formatAddress");

const app = express();
app.use(express.json());
app.use("/api/admin/communications", require("../routes/adminCommunications"));
app.use("/api/admin", require("../routes/admin"));

let base;
let passed = 0;
const failures = [];
async function test(name, fn) {
  await Promise.all([User.deleteMany({}), Booking.deleteMany({}), Subscription.deleteMany({}), AdminActivityLog.deleteMany({}), EmailLog.deleteMany({})]);
  billing.setStripeClient(null);
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
async function mk(over = {}) {
  seq += 1;
  const user = await User.create({ userId: String(50000000 + seq), name: `User ${seq}`, email: `u${seq}@example.com`, role: "customer", ...over });
  if (user.addresses.length && !user.defaultAddressId) {
    user.defaultAddressId = user.addresses[0]._id;
    await user.save();
  }
  return user;
}
const owner = () => mk({ name: "Owner", email: "owner@example.com" });
const staff = (sections, over = {}) => mk({ name: "Staff", role: "employee", adminSections: sections, adminSectionsVersion: SECTIONS_VERSION, ...over });
const search = (user, body) => call("POST", "/api/admin/customers/search", user, body);
const ids = (res) => res.body.items.map((i) => i.id);

async function people() {
  const smith = await mk({
    name: "John Smith",
    firstName: "John",
    lastName: "Smith",
    email: "john.smith@example.com",
    phone: "+15165551234",
    addresses: [{ label: "Home", line1: "44 Elm Street Apt 2", unit: "Apt 2", city: "Massapequa", state: "NY", zip: "11756" }],
    stripeCustomerId: "cus_secret_like",
    googleId: "google-123",
    tokenVersion: 3,
    lastPurchase: { token: "purchase-token-secret", plan: "basic" },
    temporaryPassword: { issuedAt: new Date(), expiresAt: new Date(Date.now() + 1e6) },
  });
  const other = await mk({
    name: "Mary Smith",
    email: "mary@example.com",
    phone: "+16315550000",
    addresses: [{ label: "Home", line1: "9 Pine Road", city: "Babylon", state: "NY", zip: "11702" }],
  });
  const jones = await mk({ name: "Ann Jones", email: "ann@example.com", phone: "+16315559999", addresses: [{ line1: "1 Bay Ave", city: "Massapequa", state: "NY", zip: "11756" }] });
  return { smith, other, jones };
}

async function run() {
  console.log("\nAddress and phone formatting");

  await test("formatAddressLine never prints the unit twice; formatPhone is (xxx) xxx-xxxx", async () => {
    assert.equal(formatAddressLine({ line1: "44 Elm Street Apt 2", unit: "Apt 2", city: "Massapequa", state: "NY", zip: "11756" }), "44 Elm Street, Apt 2, Massapequa, NY 11756");
    assert.equal(formatAddressLine({ line1: "9 Pine Road", unit: "3", city: "Babylon", state: "NY", zip: "11702" }), "9 Pine Road, Unit 3, Babylon, NY 11702");
    assert.equal(formatAddressLine({ line1: "9 Pine Road", city: "Babylon", state: "NY" }), "9 Pine Road, Babylon, NY");
    assert.equal(formatPhone("+15165551234"), "(516) 555-1234");
  });

  console.log("\nSearch");

  await test("phone in any format, and a partial of 4+ digits", async () => {
    const boss = await owner();
    const { smith } = await people();
    for (const q of ["(516) 555-1234", "5165551234", "+1 516 555 1234", "516.555.1234", "1234", "555-1234"]) {
      const res = await search(boss, { q });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(ids(res), [String(smith._id)], q);
    }
  });

  await test("multiple words are ANDed across fields: name + ZIP, name + town, street", async () => {
    const boss = await owner();
    const { smith, other, jones } = await people();
    assert.deepEqual(ids(await search(boss, { q: "smith 11756" })), [String(smith._id)]);
    assert.deepEqual(ids(await search(boss, { q: "Smith Babylon" })), [String(other._id)]);
    assert.equal((await search(boss, { q: "smith" })).body.items.length, 2);
    assert.deepEqual(ids(await search(boss, { q: "elm street" })), [String(smith._id)]);
    assert.deepEqual(ids(await search(boss, { q: "ann@example.com" })), [String(jones._id)]);
    assert.deepEqual(ids(await search(boss, { q: "massapequa jones" })), [String(jones._id)]);
  });

  await test("a booking number finds its customer", async () => {
    const boss = await owner();
    const { jones } = await people();
    await Booking.create({ bookingNumber: "778812", date: new Date(), service: "Handyman", user: jones._id, userId: jones.userId, name: jones.name, address: "1 Bay Ave", phone: jones.phone, email: jones.email, subscription: "none" });
    assert.deepEqual(ids(await search(boss, { q: "778812" })), [String(jones._id)]);
  });

  await test("search and list rows are lean: no secrets, tokens, provider ids or Stripe ids", async () => {
    const boss = await owner();
    await people();
    const list = await call("GET", "/api/admin/customers", boss);
    const found = await search(boss, { q: "john" });
    for (const body of [list.body, found.body]) {
      const text = JSON.stringify(body);
      for (const secret of ["purchase-token-secret", "google-123", "cus_secret_like", "tokenVersion", "temporaryPassword", "lastPurchase", "password", "googleId", "stripeCustomerId"]) {
        assert.ok(!text.includes(secret), `${secret} leaked`);
      }
    }
    const row = found.body.items[0];
    assert.deepEqual(Object.keys(row).sort(), ["addresses", "archived", "blocked", "email", "id", "name", "phone", "town", "userId", "visitsCompleted"].sort());
    assert.equal(row.phone, "(516) 555-1234");
    assert.equal(row.addresses[0].line1, "44 Elm Street");
    assert.equal(row.addresses[0].unit, "Apt 2");
    assert.equal(row.addresses[0].planStatus, "none");
  });

  await test("list paginates by cursor and never shows staff or the owner", async () => {
    const boss = await owner();
    await staff(["customers"]);
    for (let i = 0; i < 5; i += 1) await mk({ name: `Page ${i}` });
    const first = await call("GET", "/api/admin/customers?limit=3", boss);
    assert.equal(first.body.items.length, 3);
    assert.ok(first.body.nextCursor);
    const second = await call("GET", `/api/admin/customers?limit=3&cursor=${first.body.nextCursor}`, boss);
    assert.equal(second.body.items.length, 2);
    assert.equal(second.body.nextCursor, null);
    const all = [...ids(first), ...ids(second)];
    assert.equal(new Set(all).size, 5);
    assert.equal((await call("GET", "/api/admin/customers?filter=nope", boss)).body.code, "INVALID_FILTER");
  });

  await test("global search: a field Fixter gets only their own jobs and no customers; a customer is refused", async () => {
    const { smith } = await people();
    const fixter = await mk({ name: "Field Fixter", role: "employee", employeePosition: "Fixter" });
    const general = await mk({ name: "Gen Fixter", role: "employee", employeePosition: "General Fixter" });
    const base = { date: new Date(), service: "Handyman", user: smith._id, userId: smith.userId, name: "John Smith", address: "44 Elm Street", phone: smith.phone, email: smith.email, subscription: "none" };
    await Booking.create({ ...base, bookingNumber: "900001", assignedFixterId: fixter._id, assignedFixterName: "Field Fixter" });
    await Booking.create({ ...base, bookingNumber: "900002", assignedFixterId: general._id });
    const mine = await call("POST", "/api/admin/search", fixter, { q: "smith" });
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    assert.deepEqual(mine.body.jobs.map((j) => j.bookingNumber), ["900001"]);
    assert.deepEqual(mine.body.customers, []);
    assert.equal(mine.body.scopes.jobs, "assigned");
    const wide = await call("POST", "/api/admin/search", general, { q: "smith" });
    assert.equal(wide.body.jobs.length, 2);
    assert.ok(wide.body.customers.length >= 1);
    const plainCustomer = await mk({ name: "Plain Customer" });
    assert.equal((await call("POST", "/api/admin/search", plainCustomer, { q: "smith" })).status, 403);
  });

  console.log("\nProfile");

  await test("profile summary: identity, address with unit and plan status, visits, flags, allowedActions", async () => {
    const boss = await owner();
    const { smith } = await people();
    const now = Date.now();
    const common = { service: "Handyman", user: smith._id, userId: smith.userId, name: smith.name, address: "44 Elm Street Apt 2", phone: smith.phone, email: smith.email, subscription: "basic" };
    await Booking.create({ ...common, bookingNumber: "1", date: new Date(now - 864e5 * 10), status: "Completed" });
    await Booking.create({ ...common, bookingNumber: "2", date: new Date(now + 864e5 * 3), status: "Confirmed" });
    await Subscription.create({ user: smith._id, userId: smith.userId, subscriptionType: "basic", addressId: smith.addresses[0]._id, startDate: new Date(), latestPaymentDate: new Date(), nextPaymentDate: new Date(now + 864e5 * 20), currentPeriodEnd: new Date(now + 864e5 * 20), status: "active", accessStatus: "active" });
    const res = await call("GET", `/api/admin/customers/${smith._id}`, boss);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.customer.phoneFormatted, "(516) 555-1234");
    assert.equal(res.body.addresses[0].unit, "Apt 2");
    assert.equal(res.body.addresses[0].planStatus, "active");
    assert.equal(res.body.visits.completed, 1);
    assert.equal(res.body.visits.next.bookingNumber, "2");
    assert.equal(res.body.visits.last.bookingNumber, "1");
    assert.equal(res.body.flags.blocked, false);
    assert.equal(res.body.allowedActions.grantComplimentary, true);
    assert.equal(res.body.allowedActions.archive, true);
    const text = JSON.stringify(res.body);
    for (const secret of ["purchase-token-secret", "google-123", "cus_secret_like"]) assert.ok(!text.includes(secret), secret);

    const clerk = await staff(["customers"]);
    const asClerk = await call("GET", `/api/admin/customers/${smith._id}`, clerk);
    assert.equal(asClerk.body.allowedActions.grantComplimentary, false);
    assert.equal(asClerk.body.allowedActions.block, false);
    assert.equal(asClerk.body.allowedActions.changePlan, true);
    const visits = await call("GET", `/api/admin/customers/${smith._id}/visits?limit=1`, clerk);
    assert.equal(visits.body.items.length, 1);
    assert.ok(visits.body.nextCursor);
    assert.equal((await call("GET", `/api/admin/customers/${clerk._id}`, boss)).body.code, "FORBIDDEN_RECORD");
  });

  await test("notes: staff-only, audited, newest first", async () => {
    const clerk = await staff(["customers"]);
    const viewer = await staff(["members"]);
    const { smith } = await people();
    assert.equal((await call("POST", `/api/admin/customers/${smith._id}/notes`, viewer, { text: "x" })).status, 403);
    assert.equal((await call("POST", `/api/admin/customers/${smith._id}/notes`, clerk, { text: "  " })).body.code, "NOTE_REQUIRED");
    await call("POST", `/api/admin/customers/${smith._id}/notes`, clerk, { text: "Gate code 1234" });
    await new Promise((r) => setTimeout(r, 5));
    const second = await call("POST", `/api/admin/customers/${smith._id}/notes`, clerk, { text: "Prefers mornings" });
    assert.equal(second.status, 201);
    const list = await call("GET", `/api/admin/customers/${smith._id}/notes`, viewer);
    assert.deepEqual(list.body.items.map((n) => n.text), ["Prefers mornings", "Gate code 1234"]);
    assert.equal(list.body.items[0].authorName, "Staff");
    assert.equal(await AdminActivityLog.countDocuments({ action: "Customer Note Added", entityId: String(smith._id) }), 2);
  });

  await test("archive is owner-only, hides from default lists and search, and is reversible", async () => {
    const boss = await owner();
    const clerk = await staff(["customers"]);
    const { smith } = await people();
    assert.equal((await call("POST", `/api/admin/customers/${smith._id}/archive`, clerk, {})).status, 403);
    assert.equal((await call("POST", `/api/admin/customers/${smith._id}/archive`, boss, { reason: "Moved away" })).status, 200);
    assert.ok(!ids(await call("GET", "/api/admin/customers", boss)).includes(String(smith._id)));
    assert.ok(!ids(await search(boss, { q: "john smith" })).includes(String(smith._id)));
    assert.deepEqual(ids(await call("GET", "/api/admin/customers?filter=archived", boss)), [String(smith._id)]);
    assert.ok(await User.exists({ _id: smith._id }), "nothing is deleted");
    assert.equal((await call("POST", `/api/admin/customers/${smith._id}/unarchive`, boss)).status, 200);
    assert.ok(ids(await call("GET", "/api/admin/customers", boss)).includes(String(smith._id)));
    assert.ok(await AdminActivityLog.exists({ action: "Customer Archived" }));
    assert.ok(await AdminActivityLog.exists({ action: "Customer Unarchived" }));
  });

  await test("DELETE /users/:id accepts DELETE <userId> for a phone-only account", async () => {
    const boss = await owner();
    const phoneOnly = await User.create({ userId: "61234567", name: "Phone Only", role: "customer", phone: "+16315550123" });
    const wrong = await call("DELETE", `/api/admin/users/${phoneOnly._id}`, boss, { confirmation: "DELETE " });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.code, "CONFIRMATION_MISMATCH");
    const ok = await call("DELETE", `/api/admin/users/${phoneOnly._id}`, boss, { confirmation: "DELETE 61234567" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const withEmail = await mk({ email: "keep@example.com" });
    assert.equal((await call("DELETE", `/api/admin/users/${withEmail._id}`, boss, { confirmation: `DELETE ${withEmail.userId}` })).status, 400, "an account with an email still needs the email");
  });

  console.log("\nBilling proxy");

  function fakeStripe({ down = false } = {}) {
    const calls = [];
    const wrap = (name, value) => async (...args) => {
      calls.push(name);
      if (down) throw Object.assign(new Error("Stripe is down"), { type: "StripeConnectionError" });
      return typeof value === "function" ? value(...args) : value;
    };
    return {
      calls,
      customers: { retrieve: wrap("customers.retrieve", { id: "cus_bill", invoice_settings: { default_payment_method: { card: { brand: "visa", last4: "4242", exp_month: 4, exp_year: 2029, fingerprint: "fp_secret" } } } }) },
      subscriptions: { list: wrap("subscriptions.list", { data: [{ id: "sub_1", status: "past_due", cancel_at_period_end: false, current_period_end: 1893456000, created: 1700000000, metadata: { addressId: "a1" }, items: { data: [{ price: { id: "price_1RUdq2Bw0RtvSZjMnnI6uRgn", unit_amount: 14900 } }] } }] }) },
      invoices: {
        list: wrap("invoices.list", { data: [{ id: "in_1", number: "PFX-1", status: "open", total: 14900, amount_due: 14900, amount_paid: 0, amount_remaining: 14900, created: 1700000500, hosted_invoice_url: "https://invoice.stripe.com/i/secret_capability", subscription: "sub_1" }] }),
        createPreview: wrap("invoices.createPreview", { amount_due: 14900, currency: "usd", next_payment_attempt: 1893456000, subscription: "sub_1" }),
      },
      charges: { list: wrap("charges.list", { data: [{ id: "ch_1", payment_intent: "pi_1", amount: 14900, amount_refunded: 4900, refunded: false, status: "succeeded", paid: true, created: 1690000000, receipt_url: "https://pay.stripe.com/receipts/secret", payment_method_details: { card: { brand: "visa", last4: "4242" } } }] }) },
    };
  }

  await test("billing: invoices, payments with refunds, upcoming, card, dashboard links; no capability URLs; cached 60s", async () => {
    const boss = await owner();
    const user = await mk({ name: "Bill Payer", stripeCustomerId: "cus_bill" });
    const stripe = fakeStripe();
    billing.setStripeClient(stripe);
    const res = await call("GET", `/api/admin/customers/${user._id}/billing`, boss);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.available, true);
    assert.equal(res.body.customers[0].dashboardUrl, "https://dashboard.stripe.com/customers/cus_bill");
    assert.deepEqual(res.body.customers[0].defaultPaymentMethod, { brand: "visa", last4: "4242", expMonth: 4, expYear: 2029 });
    assert.equal(res.body.invoices[0].dashboardUrl, "https://dashboard.stripe.com/invoices/in_1");
    assert.equal(res.body.payments[0].dashboardUrl, "https://dashboard.stripe.com/payments/pi_1");
    assert.equal(res.body.payments[0].amountRefundedCents, 4900);
    assert.equal(res.body.subscriptions[0].status, "past_due");
    assert.equal(res.body.subscriptions[0].plan, "basic");
    assert.equal(res.body.upcoming[0].amountDueCents, 14900);
    const text = JSON.stringify(res.body);
    for (const leak of ["secret_capability", "receipts/secret", "fp_secret"]) assert.ok(!text.includes(leak), leak);
    const callsBefore = stripe.calls.length;
    const again = await call("GET", `/api/admin/customers/${user._id}/billing`, boss);
    assert.equal(again.body.cached, true);
    assert.equal(stripe.calls.length, callsBefore, "served from the 60s cache");
  });

  await test("billing: Stripe unavailable is { available:false, reason } and the profile still loads", async () => {
    const boss = await owner();
    const user = await mk({ name: "Bill Payer", stripeCustomerId: "cus_bill" });
    billing.setStripeClient(fakeStripe({ down: true }));
    const res = await call("GET", `/api/admin/customers/${user._id}/billing`, boss);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { available: false, reason: "stripe_unavailable" });
    assert.equal((await call("GET", `/api/admin/customers/${user._id}`, boss)).status, 200);
  });

  console.log("\nCommunications and consent");

  await test("communication history includes mail sent to a previous email address and by userId", async () => {
    const boss = await owner();
    const user = await mk({ name: "Moved Mail", email: "new@example.com" });
    await AdminActivityLog.create({
      action: "Customer Profile Updated", entityType: "User", entityId: String(user._id), actorName: "Owner",
      details: { changes: [{ field: "email", sensitive: true }], ownerOnly: { changes: [{ field: "email", from: "old@example.com", to: "new@example.com" }] } },
    });
    const mail = { templateKey: "t", subject: "s", status: "sent", sentAt: new Date() };
    await EmailLog.create({ ...mail, recipientEmail: "old@example.com" });
    await EmailLog.create({ ...mail, recipientEmail: "new@example.com" });
    await EmailLog.create({ ...mail, recipientEmail: "", userId: String(user._id) });
    await EmailLog.create({ ...mail, recipientEmail: "stranger@example.com" });
    const res = await call("GET", `/api/admin/communications/customers/${user._id}/history`, boss);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.counts.email, 3);
  });

  await test("consent is read only evidence: switches, STOP state, ledger history", async () => {
    const boss = await owner();
    const user = await mk({ phone: "+16315550101", smsPreferences: { transactionalEnabled: true, transactionalConsentAt: new Date("2026-01-01"), transactionalConsentSource: "signup_web_form" } });
    const res = await call("GET", `/api/admin/customers/${user._id}/consent`, boss);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.evidence.serviceSms.enabled, true);
    assert.equal(res.body.evidence.serviceSms.source, "signup_web_form");
    assert.equal(res.body.stop.phoneOptedOut, false);
    assert.ok(Array.isArray(res.body.history));
    assert.ok(res.body.switches.service.sms);
  });
}

(async () => {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await User.syncIndexes();
  await Subscription.syncIndexes();
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
