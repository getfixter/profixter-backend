/**
 * Admin edits a customer's details: names, phone, email, saved addresses.
 *
 *   node scripts/test_admin_customer_edit.js
 *
 * In-memory Mongo, the real routers (admin, auth, auth 2.0) and the real auth
 * middleware. Phone codes are captured by an injected sender, and nothing
 * calls Stripe: the routes under test never reach it.
 *
 * What it pins:
 * - who may edit: the owner everything; an "All Users" employee names and
 *   addresses only; other staff, customers and anonymous callers nothing
 * - only customer accounts are editable, never the owner or staff
 * - no mass assignment: role, password, tokenVersion, subscription... refused
 * - a changed phone loses its verification and cannot open the account by
 *   text code; its SMS consent does not move to the new number
 * - a changed email loses its verification; Google/Apple links, sessions and
 *   tokenVersion are untouched; a duplicate is a 409, never a 500; "" unsets
 * - an account can never be left with no way to sign in
 * - addresses: edit in place (ids, free-visit state and plans stay attached),
 *   add, remove (only without history), default, validation, duplicates
 * - bookings, memberships and free-visit eligibility survive every edit
 * - every edit is in the audit log with previous and new values; phone and
 *   email are masked for everyone but the owner
 */
Object.assign(process.env, {
  NODE_ENV: "test",
  S3_BUCKET: "test-bucket",
  AWS_REGION: "us-east-1",
  JWT_SECRET: "test-secret-admin-customer-edit",
  STRIPE_SECRET_KEY: "sk_test_fake_never_called",
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
const ConsentEvent = require("../models/ConsentEvent");
const EmailSuppression = require("../models/EmailSuppression");
const AuthChallenge = require("../models/AuthChallenge");
const AuthRateCounter = require("../models/AuthRateCounter");
const { SECTIONS_VERSION } = require("../utils/adminAccess");
const { checkFreeVisitEligibility } = require("../utils/freeVisit/eligibility");

const authV2 = require("../routes/authV2");
const sent = [];
authV2.deps.deliver = async ({ channel, target, code }) => {
  sent.push({ channel, target, code });
};

const app = express();
app.use(express.json());
app.use("/api/auth", require("../routes/auth"));
app.use("/api/auth", authV2);
app.use("/api/admin", require("../routes/admin"));

let base;
let passed = 0;
const failures = [];
async function test(name, fn) {
  await Promise.all([
    User.deleteMany({}),
    Booking.deleteMany({}),
    Subscription.deleteMany({}),
    AdminActivityLog.deleteMany({}),
    ConsentEvent.collection.deleteMany({}),
    EmailSuppression.deleteMany({}),
    AuthChallenge.deleteMany({}),
    AuthRateCounter.deleteMany({}),
  ]);
  sent.length = 0;
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error.stack}`);
  }
}
const section = (title) => console.log(`\n${title}`);

const token = (user) => jwt.sign({ id: String(user._id), tv: Number(user.tokenVersion || 0) }, process.env.JWT_SECRET);
async function call(method, path, user, body, rawToken) {
  const auth = rawToken || (user ? token(user) : null);
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
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
const patch = (user, target, body) => call("PATCH", `/api/admin/users/${target._id}/profile`, user, body);

let seq = 0;
async function mk(over = {}) {
  seq += 1;
  return User.create({
    userId: String(20000000 + seq),
    name: `User ${seq}`,
    email: `user${seq}@example.com`,
    role: "customer",
    ...over,
  });
}
const owner = () => mk({ name: "Owner", email: "owner@example.com" });
const employee = (sections, over = {}) =>
  mk({ name: "Staff", role: "employee", employeePosition: null, adminSections: sections, adminSectionsVersion: SECTIONS_VERSION, ...over });
const fresh = (user) => User.findById(user._id).lean();

const HOME = { label: "Primary", line1: "12 Oak Street", city: "Massapequa", state: "NY", zip: "11758", county: "Nassau" };

async function customer(over = {}) {
  return mk({
    name: "Casey Customer",
    firstName: "Casey",
    lastName: "Customer",
    email: "casey@example.com",
    emailVerifiedAt: new Date("2026-01-01"),
    phone: "+16315550101",
    phoneVerifiedAt: new Date("2026-01-01"),
    password: "hash-not-real",
    authProviders: ["password", "phone"],
    addresses: [HOME],
    ...over,
  }).then(async (user) => {
    if (user.addresses.length && !user.defaultAddressId) {
      user.defaultAddressId = user.addresses[0]._id;
      await user.save();
    }
    return user;
  });
}

const lastCode = (target) => [...sent].reverse().find((entry) => entry.target === target)?.code;
async function phoneSignIn(e164) {
  const start = await call("POST", "/api/auth/otp/phone/start", null, { phone: e164 });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  return call("POST", "/api/auth/otp/phone/verify", null, { phone: e164, code: lastCode(e164) });
}

async function run() {
  section("Who may edit");

  await test("no session: 401 on read, write and history", async () => {
    const target = await customer();
    assert.equal((await call("GET", `/api/admin/users/${target._id}/profile`)).status, 401);
    assert.equal((await patch(null, target, { firstName: "X" })).status, 401);
    assert.equal((await call("GET", `/api/admin/users/${target._id}/profile-history`)).status, 401);
  });

  await test("a customer gets 403, even on their own record", async () => {
    const target = await customer();
    const other = await mk({ name: "Other Customer" });
    assert.equal((await patch(other, target, { firstName: "Hacked" })).status, 403);
    assert.equal((await patch(target, target, { email: "mine@example.com" })).status, 403);
    assert.equal((await fresh(target)).firstName, "Casey");
  });

  await test("an employee without All Users gets 403 (Fixter, General Fixter, other sections)", async () => {
    const target = await customer();
    for (const staff of [
      await mk({ role: "employee", employeePosition: "Fixter" }),
      await mk({ role: "employee", employeePosition: "General Fixter" }),
      await employee(["overview", "members", "activity"]),
    ]) {
      assert.equal((await patch(staff, target, { firstName: "Nope" })).status, 403);
      assert.equal((await call("GET", `/api/admin/users/${target._id}/profile`, staff)).status, 403);
    }
    assert.equal((await fresh(target)).firstName, "Casey");
  });

  await test("an All Users employee edits names and addresses, but not phone or email", async () => {
    const target = await customer();
    const staff = await employee(["customers"]);
    const ok = await patch(staff, target, { firstName: "Cassie" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const phone = await patch(staff, target, { phone: "631-555-0199" });
    assert.equal(phone.status, 403);
    assert.equal(phone.body.code, "OWNER_ONLY_FIELDS");
    const email = await patch(staff, target, { email: "new@example.com", firstName: "Sneaky" });
    assert.equal(email.status, 403);
    const after = await fresh(target);
    assert.equal(after.firstName, "Cassie", "a refused request writes nothing at all");
    assert.equal(after.email, "casey@example.com");
    assert.equal(after.phone, "+16315550101");
    // Sending the unchanged values (a whole form) is not a change, so it is allowed.
    const same = await patch(staff, target, { phone: "(631) 555-0101", email: "CASEY@example.com", lastName: "C" });
    assert.equal(same.status, 200, JSON.stringify(same.body));
    const profile = await call("GET", `/api/admin/users/${target._id}/profile`, staff);
    assert.equal(profile.body.access.canEditContact, false);
  });

  await test("the legacy PUT /users/:id no longer lets staff move the phone, and clears verification for the owner", async () => {
    const target = await customer();
    const staff = await employee(["customers"]);
    const denied = await call("PUT", `/api/admin/users/${target._id}`, staff, { phone: "6315550188" });
    assert.equal(denied.status, 403);
    assert.equal((await call("PUT", `/api/admin/users/${target._id}`, staff, { name: "Casey Q" })).status, 200);
    const boss = await owner();
    assert.equal((await call("PUT", `/api/admin/users/${target._id}`, boss, { phone: "6315550188" })).status, 200);
    const after = await fresh(target);
    assert.equal(after.phone, "+16315550188");
    assert.equal(after.phoneVerifiedAt, null);
    assert.ok(await AdminActivityLog.exists({ entityId: String(target._id), action: "Customer Profile Updated" }));
  });

  await test("only customer accounts: the owner and staff records are refused for everyone", async () => {
    const boss = await owner();
    const staff = await employee(["customers"]);
    const fixter = await mk({ role: "employee", employeePosition: "Fixter" });
    for (const actor of [boss, staff]) {
      assert.equal((await patch(actor, boss, { firstName: "X" })).status, 403);
      assert.equal((await patch(actor, fixter, { firstName: "X" })).status, 403);
    }
    assert.equal((await patch(boss, { _id: new mongoose.Types.ObjectId() }, { firstName: "X" })).status, 404);
  });

  await test("protected fields are refused by name and nothing is written", async () => {
    const boss = await owner();
    const target = await customer();
    for (const field of ["role", "password", "tokenVersion", "subscription", "adminSections", "googleId", "phoneVerifiedAt", "emailVerifiedAt", "stripeCustomerId", "isActive"]) {
      const res = await patch(boss, target, { firstName: "Changed", [field]: field === "role" ? "admin" : "x" });
      assert.equal(res.status, 400, field);
      assert.equal(res.body.code, "FIELDS_NOT_EDITABLE");
    }
    const after = await fresh(target);
    assert.equal(after.firstName, "Casey");
    assert.equal(after.role, "customer");
    assert.equal(after.password, "hash-not-real");
    assert.equal(after.tokenVersion, 0);
  });

  section("Names");

  await test("owner edits first and last name; name follows; audit has before and after", async () => {
    const boss = await owner();
    const target = await customer();
    const res = await patch(boss, target, { firstName: "  Cassandra ", lastName: "Customer-Smith" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const after = await fresh(target);
    assert.equal(after.firstName, "Cassandra");
    assert.equal(after.lastName, "Customer-Smith");
    assert.equal(after.name, "Cassandra Customer-Smith");
    assert.ok(after.search.names.some((n) => n.includes("cassandra")), "search fields follow the new name");
    assert.equal(res.body.user._id, String(target._id), "the response is the list row, ready to swap in");
    assert.ok(Array.isArray(res.body.user.addressesDetailed));
    const log = await AdminActivityLog.findOne({ entityId: String(target._id), action: "Customer Profile Updated" }).lean();
    assert.equal(String(log.actorUserId), String(boss._id));
    const first = log.details.changes.find((c) => c.field === "firstName");
    assert.deepEqual([first.from, first.to], ["Casey", "Cassandra"]);
  });

  await test("an account with only `name` is split into first and last for editing", async () => {
    const boss = await owner();
    const target = await customer({ name: "Mary Ann Smith", firstName: "", lastName: "" });
    const profile = await call("GET", `/api/admin/users/${target._id}/profile`, boss);
    assert.equal(profile.body.profile.firstName, "Mary");
    assert.equal(profile.body.profile.lastName, "Ann Smith");
    const res = await patch(boss, target, { firstName: "Mary Ann", lastName: "Smith" });
    assert.equal(res.status, 200);
    assert.equal((await fresh(target)).name, "Mary Ann Smith");
  });

  section("Phone");

  await test("a changed phone is unverified and cannot open the account by text code", async () => {
    const boss = await owner();
    const target = await customer({
      smsPreferences: {
        transactionalEnabled: true,
        transactionalConsentAt: new Date("2026-02-01"),
        transactionalConsentSource: "signup",
        marketingEnabled: true,
        marketingConsentAt: new Date("2026-02-01"),
        marketingConsentSource: "signup",
      },
    });
    const res = await patch(boss, target, { phone: "(516) 555-0142" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.phoneVerificationCleared, true);
    assert.equal(res.body.smsConsentReset, true);
    const after = await fresh(target);
    assert.equal(after.phone, "+15165550142", "stored in E.164");
    assert.equal(after.phoneVerifiedAt, null);
    assert.deepEqual(after.authProviders, ["password", "phone"], "sign-in history is not rewritten");

    // The new number reaches only the linking step, never a session.
    const signIn = await phoneSignIn("+15165550142");
    assert.equal(signIn.status, 200, JSON.stringify(signIn.body));
    assert.equal(signIn.body.status, "link_required");
    assert.equal(signIn.body.token, undefined);
    // The old number no longer opens it either (asked directly, so no account is created and no welcome mail is attempted).
    const { findCustomersByVerifiedPhone } = require("../utils/auth/accounts");
    assert.equal((await findCustomersByVerifiedPhone("+16315550101")).length, 0);
    assert.equal((await findCustomersByVerifiedPhone("+15165550142")).length, 0);

    // SMS consent belonged to the old number: flags unset, evidence kept, ledger written.
    assert.equal(after.smsPreferences.transactionalEnabled, undefined);
    assert.equal(after.smsPreferences.marketingEnabled, undefined);
    assert.ok(after.smsPreferences.transactionalConsentAt, "the historical evidence survives");
    const resets = await ConsentEvent.find({ user: target._id, action: "reset", source: "admin_phone_change" }).lean();
    assert.deepEqual(resets.map((r) => r.purpose).sort(), ["marketing", "service"]);
    assert.ok(resets.every((r) => r.phone === "+16315550101"));
  });

  await test("formatting the same number is not a change: verification and consent stay", async () => {
    const boss = await owner();
    const target = await customer({ smsPreferences: { transactionalEnabled: true } });
    const res = await patch(boss, target, { phone: "631.555.0101" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.changes, []);
    const after = await fresh(target);
    assert.ok(after.phoneVerifiedAt);
    assert.equal(after.smsPreferences.transactionalEnabled, true);
  });

  await test("invalid and non-US phones are rejected with a field error", async () => {
    const boss = await owner();
    const target = await customer();
    for (const phone of ["12345", "+44 20 7946 0958", "(111) 555-0101"]) {
      const res = await patch(boss, target, { phone });
      assert.equal(res.status, 400, phone);
      assert.ok(res.body.errors.phone);
    }
  });

  await test("another account that verified the same phone is a warning, then allowed; accounts stay separate", async () => {
    const boss = await owner();
    const target = await customer();
    const household = await customer({ email: "partner@example.com", phone: "+15165550177", phoneVerifiedAt: new Date() });
    const first = await patch(boss, target, { phone: "5165550177" });
    assert.equal(first.status, 409);
    assert.equal(first.body.code, "CONFIRM_WARNINGS");
    assert.equal(first.body.warnings[0].code, "PHONE_SHARED_VERIFIED");
    assert.equal((await fresh(target)).phone, "+16315550101", "nothing saved before confirmation");
    const second = await patch(boss, target, { phone: "5165550177", acknowledgeWarnings: true });
    assert.equal(second.status, 200);
    assert.equal(await User.countDocuments({ _id: { $in: [target._id, household._id] } }), 2);
    assert.ok((await fresh(household)).phoneVerifiedAt, "the other account is untouched");
    const log = await AdminActivityLog.findOne({ action: "Customer Profile Updated" }).lean();
    assert.deepEqual(log.details.warningsAcknowledged, ["PHONE_SHARED_VERIFIED"]);
  });

  section("Email");

  await test("a changed email is unverified; Google, Apple, sessions and tokenVersion are untouched", async () => {
    const boss = await owner();
    const target = await customer({ googleId: "google-sub-1", appleId: "apple-sub-1", emailIsAppleRelay: true, stripeCustomerId: "cus_test_1", tokenVersion: 3 });
    const session = token(target);
    const res = await patch(boss, target, { email: "  Casey.New@Example.com " });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.emailVerificationCleared, true);
    assert.ok(res.body.notices.some((n) => n.includes("Stripe")), "says receipts still go to the Stripe email");
    const after = await fresh(target);
    assert.equal(after.email, "casey.new@example.com");
    assert.equal(after.emailVerifiedAt, null);
    assert.equal(after.emailIsAppleRelay, false);
    assert.equal(after.googleId, "google-sub-1");
    assert.equal(after.appleId, "apple-sub-1");
    assert.equal(after.tokenVersion, 3);
    assert.equal(after.stripeCustomerId, "cus_test_1");
    const me = await call("GET", "/api/auth/me", null, null, session);
    assert.equal(me.status, 200, "the customer's existing session still works");
  });

  await test("an email used by another customer is a 409, never a 500, and nothing is written", async () => {
    const boss = await owner();
    const target = await customer();
    await customer({ email: "taken@example.com", phone: "+15165550111" });
    const res = await patch(boss, target, { email: "Taken@Example.com", firstName: "Should Not Save" });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "EMAIL_IN_USE");
    const after = await fresh(target);
    assert.equal(after.email, "casey@example.com");
    assert.equal(after.firstName, "Casey");
  });

  await test("an email on a staff account is allowed after a warning (separate accounts, never merged)", async () => {
    const boss = await owner();
    const target = await customer();
    const staff = await mk({ role: "employee", employeePosition: "Fixter", email: "worker@example.com" });
    const first = await patch(boss, target, { email: "worker@example.com" });
    assert.equal(first.status, 409);
    assert.equal(first.body.warnings[0].code, "EMAIL_ON_STAFF_ACCOUNT");
    const second = await patch(boss, target, { email: "worker@example.com", acknowledgeWarnings: true });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal((await fresh(staff)).role, "employee");
    assert.equal(await User.countDocuments({ email: "worker@example.com" }), 2);
  });

  await test("the owner's address can never be given to a customer", async () => {
    const target = await customer();
    const res = await patch(await owner(), target, { email: "OWNER@example.com" });
    assert.equal(res.status, 400);
    assert.ok(res.body.errors.email);
  });

  await test("removing the email unsets the field (never \"\") while a verified phone remains", async () => {
    const boss = await owner();
    const target = await customer();
    const res = await patch(boss, target, { email: "" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const raw = await User.collection.findOne({ _id: target._id });
    assert.equal("email" in raw, false, "the field is absent, so the {email, role} index cannot collide on it");
    assert.equal(raw.emailVerifiedAt, null);
    // A second phone-only customer can also lose an email without colliding.
    const other = await customer({ email: "second@example.com", phone: "+15165550123" });
    assert.equal((await patch(boss, other, { email: "" })).status, 200);
  });

  await test("an unsubscribe follows the person to the new email; a bounce stays with the old mailbox", async () => {
    const boss = await owner();
    const a = await customer();
    const b = await customer({ email: "bouncy@example.com", phone: "+15165550124" });
    await EmailSuppression.create({ email: "casey@example.com", reason: "unsubscribe", source: "link" });
    await EmailSuppression.create({ email: "bouncy@example.com", reason: "bounce", source: "ses" });
    assert.equal((await patch(boss, a, { email: "casey2@example.com" })).status, 200);
    assert.equal((await patch(boss, b, { email: "bouncy2@example.com" })).status, 200);
    assert.equal((await EmailSuppression.findOne({ email: "casey2@example.com" }).lean())?.reason, "unsubscribe");
    assert.equal(await EmailSuppression.exists({ email: "bouncy2@example.com" }), null);
  });

  section("Never without a way to sign in");

  await test("an email-only account cannot lose its email", async () => {
    const boss = await owner();
    const target = await customer({ phone: undefined, phoneVerifiedAt: null });
    const res = await patch(boss, target, { email: "" });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "NO_SIGN_IN_METHOD");
    assert.equal((await fresh(target)).email, "casey@example.com");
  });

  await test("a phone-only account cannot have its phone moved unless an email is added with it", async () => {
    const boss = await owner();
    const target = await customer({ email: undefined, emailVerifiedAt: null, password: undefined, authProviders: ["phone"] });
    const res = await patch(boss, target, { phone: "5165550150" });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "NO_SIGN_IN_METHOD");
    assert.equal((await fresh(target)).phone, "+16315550101");
    const withEmail = await patch(boss, target, { phone: "5165550150", email: "phoneonly@example.com" });
    assert.equal(withEmail.status, 200, JSON.stringify(withEmail.body));
  });

  await test("an unverified phone does not count; Google or Apple does", async () => {
    const boss = await owner();
    const typedPhone = await customer({ phoneVerifiedAt: null });
    assert.equal((await patch(boss, typedPhone, { email: "" })).status, 409);
    const google = await customer({ email: "g@example.com", phone: undefined, phoneVerifiedAt: null, googleId: "g-2" });
    assert.equal((await patch(boss, google, { email: "" })).status, 200);
  });

  section("Addresses");

  await test("edit in place: id, free-visit state and the membership stay attached", async () => {
    const boss = await owner();
    const target = await customer();
    const home = target.addresses[0];
    await User.updateOne({ _id: target._id }, { $set: { "addresses.0.introVisit": { status: "consumed", consumedAt: new Date() } } });
    await Subscription.collection.insertOne({ user: target._id, addressId: home._id, subscriptionType: "plus", status: "active", createdAt: new Date() });
    await Booking.collection.insertOne({ user: target._id, addressId: home._id, status: "Completed", date: new Date("2026-03-01"), isFreeFirstVisit: true, completedAt: new Date("2026-03-01") });

    const first = await patch(boss, target, { addresses: [{ _id: String(home._id), line1: "14 Oak St", unit: "Apt 2", city: "Massapequa", state: "ny", zip: "11758-1234", isDefault: true }] });
    assert.equal(first.status, 409, "moving a property with an active plan asks first");
    assert.equal(first.body.warnings[0].code, "ADDRESS_HAS_ACTIVE_PLAN");
    const res = await patch(boss, target, { acknowledgeWarnings: true, addresses: [{ _id: String(home._id), line1: "14 Oak St", unit: "Apt 2", city: "Massapequa", state: "ny", zip: "11758-1234", isDefault: true }] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const after = await fresh(target);
    assert.equal(after.addresses.length, 1);
    assert.equal(String(after.addresses[0]._id), String(home._id));
    assert.equal(after.addresses[0].line1, "14 Oak St Apt 2", "the unit rides inside line1, as at sign-up");
    assert.equal(after.addresses[0].state, "NY");
    assert.equal(after.addresses[0].zip, "11758");
    assert.equal(after.addresses[0].county, "Nassau", "county derived from the ZIP");
    assert.equal(after.addresses[0].introVisit.status, "consumed", "a used free visit is not reset by an edit");
    assert.equal(res.body.user.addressesDetailed[0].plan, "plus", "the membership still shows on the corrected address");
    assert.ok(await Booking.exists({ user: target._id, addressId: home._id }), "the booking still points at it");
  });

  await test("add a second address, make it the default, then remove it again", async () => {
    const boss = await owner();
    const target = await customer();
    const home = target.addresses[0];
    const add = await patch(boss, target, {
      addresses: [
        { _id: String(home._id), ...HOME },
        { label: "Beach house", line1: "5 Ocean Ave", city: "Babylon", state: "NY", zip: "11701", placeId: "place-1", lat: 40.69, lng: -73.32, isDefault: true },
      ],
    });
    assert.equal(add.status, 200, JSON.stringify(add.body));
    let after = await fresh(target);
    assert.equal(after.addresses.length, 2);
    const beach = after.addresses[1];
    assert.equal(beach.label, "Beach house");
    assert.equal(beach.county, "Suffolk");
    assert.equal(String(after.defaultAddressId), String(beach._id));
    assert.ok(add.body.changes.some((c) => c.label === "Default address"));

    const remove = await patch(boss, target, { addresses: [{ _id: String(home._id), ...HOME, isDefault: true }] });
    assert.equal(remove.status, 200, JSON.stringify(remove.body));
    after = await fresh(target);
    assert.equal(after.addresses.length, 1);
    assert.equal(String(after.defaultAddressId), String(home._id));
  });

  await test("an address with bookings, a plan or a free visit cannot be removed", async () => {
    const boss = await owner();
    const target = await customer();
    const second = { label: "Rental", line1: "9 Elm Rd", city: "Babylon", state: "NY", zip: "11701" };
    await patch(boss, target, { addresses: [{ _id: String(target.addresses[0]._id), ...HOME }, second] });
    const withTwo = await fresh(target);
    const rental = withTwo.addresses[1];
    await Booking.collection.insertOne({ user: target._id, addressId: rental._id, status: "Canceled", date: new Date("2025-01-01") });
    const res = await patch(boss, target, { addresses: [{ _id: String(target.addresses[0]._id), ...HOME }] });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "ADDRESS_HAS_HISTORY");
    assert.equal((await fresh(target)).addresses.length, 2);
  });

  await test("address validation: missing parts, bad ZIP, non-US state, duplicates, unknown ids", async () => {
    const boss = await owner();
    const target = await customer();
    const id = String(target.addresses[0]._id);
    const bad = await patch(boss, target, { addresses: [{ _id: id, line1: "", city: "", state: "Ontario", zip: "1234" }] });
    assert.equal(bad.status, 400);
    for (const field of ["line1", "city", "state", "zip"]) assert.ok(bad.body.errors[`addresses.0.${field}`], field);
    const dup = await patch(boss, target, { addresses: [{ _id: id, ...HOME }, { ...HOME, line1: "12 oak st." }] });
    assert.equal(dup.status, 400);
    assert.ok(dup.body.errors["addresses.1.line1"]);
    const ghost = await patch(boss, target, { addresses: [{ _id: String(new mongoose.Types.ObjectId()), ...HOME }] });
    assert.equal(ghost.status, 400);
    const twoDefaults = await patch(boss, target, { addresses: [{ _id: id, ...HOME, isDefault: true }, { line1: "1 Main St", city: "Babylon", state: "NY", zip: "11701", isDefault: true }] });
    assert.equal(twoDefaults.status, 400);
    assert.equal((await fresh(target)).addresses[0].line1, HOME.line1);
  });

  await test("an address outside the service area is allowed after a warning", async () => {
    const boss = await owner();
    const target = await customer();
    const next = [{ _id: String(target.addresses[0]._id), ...HOME }, { line1: "350 5th Ave", city: "New York", state: "NY", zip: "10118" }];
    const first = await patch(boss, target, { addresses: next });
    assert.equal(first.status, 409);
    assert.equal(first.body.warnings[0].code, "ADDRESS_OUTSIDE_SERVICE_AREA");
    const second = await patch(boss, target, { addresses: next, acknowledgeWarnings: true });
    assert.equal(second.status, 200);
    assert.equal((await fresh(target)).addresses[1].county, "");
  });

  await test("an All Users employee can correct an address", async () => {
    const target = await customer();
    const res = await patch(await employee(["customers"]), target, { addresses: [{ _id: String(target.addresses[0]._id), ...HOME, line1: "12 Oak St" }] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await fresh(target)).addresses[0].line1, "12 Oak St");
  });

  section("Relationships survive");

  await test("bookings, memberships and a used free visit stay linked through every kind of edit", async () => {
    const boss = await owner();
    const target = await customer();
    const home = target.addresses[0];
    await Subscription.collection.insertOne({ user: target._id, addressId: home._id, subscriptionType: "basic", status: "active", createdAt: new Date() });
    await Booking.collection.insertOne({
      user: target._id,
      addressId: home._id,
      phone: "+16315550101",
      email: "casey@example.com",
      address: HOME.line1,
      zip: HOME.zip,
      status: "Completed",
      isFreeFirstVisit: true,
      completedAt: new Date("2026-04-01"),
      date: new Date("2026-04-01"),
    });
    const res = await patch(boss, target, {
      firstName: "Cee",
      phone: "5165550160",
      email: "cee@example.com",
      acknowledgeWarnings: true,
      addresses: [
        { _id: String(home._id), ...HOME, line1: "12 Oak Street Unit B" },
        { line1: "77 Bay Dr", city: "Babylon", state: "NY", zip: "11701", isDefault: true },
      ],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(await Booking.countDocuments({ user: target._id }), 1);
    assert.equal(await Subscription.countDocuments({ user: target._id, addressId: home._id }), 1);
    const row = res.body.user.addressesDetailed.find((a) => a._id === String(home._id));
    assert.equal(row.plan, "basic");
    const after = await fresh(target);
    // New phone, new email, a brand-new address: the account itself still has its free visit used.
    const eligibility = await checkFreeVisitEligibility({ userId: target._id, phone: after.phone, email: after.email, address: after.addresses[1] });
    assert.equal(eligibility.decision, "blocked");
    assert.equal(eligibility.code, "FREE_VISIT_USED");
  });

  section("Audit and history");

  await test("phone and email are masked in the log; full values only for the owner", async () => {
    const boss = await owner();
    const target = await customer();
    const staff = await employee(["customers", "activity"]);
    assert.equal((await patch(boss, target, { phone: "5165550170", email: "audit@example.com", reason: "customer called" })).status, 200);

    const log = await AdminActivityLog.findOne({ entityId: String(target._id), action: "Customer Profile Updated" }).lean();
    const phone = log.details.changes.find((c) => c.field === "phone");
    assert.equal(phone.from, "(•••) •••-0101");
    assert.equal(phone.to, "(•••) •••-0170");
    assert.equal(log.details.ownerOnly.changes.find((c) => c.field === "phone").to, "+15165550170");
    assert.equal(log.details.adminOverride.phoneVerificationCleared, true);
    assert.equal(log.details.adminOverride.emailVerificationCleared, true);
    assert.equal(log.details.reason, "customer called");
    assert.equal(await AdminActivityLog.countDocuments({ action: "Customer Profile Update Started" }), 0, "started entries become done");

    const ownerView = await call("GET", `/api/admin/users/${target._id}/profile-history`, boss);
    assert.equal(ownerView.status, 200);
    const ownerEmail = ownerView.body.items[0].changes.find((c) => c.field === "email");
    assert.deepEqual([ownerEmail.from, ownerEmail.to], ["casey@example.com", "audit@example.com"]);

    const staffView = await call("GET", `/api/admin/users/${target._id}/profile-history`, staff);
    assert.equal(staffView.body.masked, true);
    assert.equal(staffView.body.items[0].changes.find((c) => c.field === "email").to, "au•••@example.com");

    const global = await call("GET", "/api/admin/activity-log?entityType=User", staff);
    assert.equal(global.status, 200);
    assert.ok(global.body.items.every((item) => !item.details?.ownerOnly), "the global log strips full values for staff");
    const ownerGlobal = await call("GET", "/api/admin/activity-log?entityType=User", boss);
    assert.ok(ownerGlobal.body.items.some((item) => item.details?.ownerOnly));
  });

  await test("a stale editor is refused instead of overwriting a newer change", async () => {
    const boss = await owner();
    const target = await customer();
    const res = await patch(boss, target, { firstName: "Late", expectedUpdatedAt: new Date("2020-01-01").toISOString() });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "STALE");
    const current = await call("GET", `/api/admin/users/${target._id}/profile`, boss);
    const ok = await patch(boss, target, { firstName: "OnTime", expectedUpdatedAt: current.body.profile.updatedAt });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });
}

(async () => {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await User.syncIndexes();
  await AuthChallenge.syncIndexes();
  await AuthRateCounter.syncIndexes();
  await EmailSuppression.syncIndexes();
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
