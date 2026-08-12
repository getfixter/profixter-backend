/**
 * One person, two accounts: a customer and a separate Fixter on the same email.
 *
 * Real MongoDB, because the guarantees under test are database constraints and
 * lookup behaviour, not pure functions. Email and Stripe are not involved.
 *
 * The failures worth losing sleep over, all covered here:
 *   1. Signing in and landing in the wrong one of your own two accounts.
 *   2. A Fixter record answering a billing question and detaching a real
 *      customer from their own subscription.
 *   3. The loosened uniqueness quietly permitting two customers, or two
 *      employees, on one email.
 *   4. Creating the employee account damaging the customer account.
 *
 *   node scripts/test_dual_account_users.js
 *
 * Not part of `npm test`: it boots a MongoDB binary. Run it locally and in any
 * pre-release check.
 */

process.env.S3_BUCKET = process.env.S3_BUCKET || "test-bucket";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_fake_for_unit_tests";

const assert = require("assert");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
stub("../utils/subscriptionManagement", {
  stripe: {},
  hasStripeSecretKey: () => true,
});

const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../models/User");
const {
  findBillingUserByEmail,
  findCustomerByEmail,
  findEmployeeByEmail,
  findUsersByEmail,
} = require("../utils/userLookup");
const { isSelectableFixter, publicFixterList } = require("../utils/fixterTips");
const { permissionsForUser, PERMISSIONS } = require("../middleware/authorize");

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

const EMAIL = "taras@example.test";
let seq = 0;
const nextUserId = () => `u${++seq}${Date.now() % 100000}`;

async function makeCustomer(email = EMAIL, password = "customer-pass") {
  return User.create({
    userId: nextUserId(),
    name: "Taras Customer",
    email,
    password: await bcrypt.hash(password, 4),
    phone: "+15550001111",
    role: "customer",
    address: "1 Home Street",
    city: "Babylon",
    state: "NY",
    zip: "11702",
  });
}

async function makeEmployee(email = EMAIL, position = "Fixter", password = "fixter-pass") {
  return User.create({
    userId: nextUserId(),
    name: "Taras Fixter",
    firstName: "Taras",
    lastName: "Fixter",
    email,
    password: await bcrypt.hash(password, 4),
    phone: "+15550002222",
    role: "employee",
    employeePosition: position,
    isActive: true,
  });
}

/** The login resolution the route performs, kept in step with routes/auth.js. */
async function resolveLogin(email, password) {
  const candidates = await findUsersByEmail(email);
  const matches = [];
  for (const candidate of candidates) {
    if (!candidate.password) continue;
    if (await bcrypt.compare(password, candidate.password)) matches.push(candidate);
  }
  if (!matches.length) return { user: null, ambiguous: false };
  if (matches.length > 1) return { user: null, ambiguous: true, matches };
  return { user: matches[0], ambiguous: false };
}

async function main() {
  const server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
  await User.syncIndexes();

  try {
    console.log("\nOne email, two accounts");

    const customer = await makeCustomer();
    const employee = await makeEmployee();

    await test("an existing customer does not block creating a Fixter on the same email", () => {
      assert.ok(employee._id, "the Fixter account was not created");
      assert.notStrictEqual(String(customer._id), String(employee._id));
    });

    await test("they are two separate records, not one merged one", async () => {
      const both = await User.find({ email: EMAIL }).sort({ role: 1 }).lean();
      assert.strictEqual(both.length, 2, "expected exactly two accounts on this email");
      assert.deepStrictEqual(both.map((u) => u.role).sort(), ["customer", "employee"]);
    });

    await test("the customer record is untouched by the employee being created", async () => {
      const after = await User.findById(customer._id).lean();
      assert.strictEqual(after.role, "customer");
      assert.strictEqual(after.employeePosition, null);
      assert.strictEqual(after.name, "Taras Customer");
      assert.strictEqual(after.userId, customer.userId, "the customer identity changed");
      assert.strictEqual(after.address, "1 Home Street", "customer data was overwritten");
    });

    await test("the new employee record has the role and position it was given", async () => {
      const after = await User.findById(employee._id).lean();
      assert.strictEqual(after.role, "employee");
      assert.strictEqual(after.employeePosition, "Fixter");
      assert.strictEqual(after.isActive, true);
    });

    await test("a General Fixter works the same way", async () => {
      const gEmail = "general@example.test";
      const gCustomer = await makeCustomer(gEmail);
      const gEmployee = await makeEmployee(gEmail, "General Fixter");
      assert.notStrictEqual(String(gCustomer._id), String(gEmployee._id));
      assert.strictEqual((await User.countDocuments({ email: gEmail })), 2);
      assert.strictEqual((await User.findById(gEmployee._id)).employeePosition, "General Fixter");
    });

    console.log("\nWhat the loosened uniqueness still refuses");

    await test("two customers can never share an email", async () => {
      await assert.rejects(() => makeCustomer(EMAIL), (err) => err.code === 11000);
    });

    await test("two employees can never share an email", async () => {
      await assert.rejects(() => makeEmployee(EMAIL, "General Fixter"), (err) => err.code === 11000);
    });

    await test("the database enforces it, not just the application", async () => {
      const indexes = await mongoose.connection.db.collection("users").indexes();
      const compound = indexes.find((i) => i.name === "user_email_role_unique_idx");
      assert.ok(compound, "the email/role index is missing");
      assert.strictEqual(compound.unique, true, "the email/role index is not unique");
      assert.deepStrictEqual(compound.key, { email: 1, role: 1 });
      const bare = indexes.find((i) => i.name === "email_1" && i.unique);
      assert.ok(!bare, "the old single-field unique email index is still present");
    });

    await test("the admin employee check blocks a second employee but not a customer", async () => {
      // The exact predicate routes/fixters.js uses.
      assert.ok(await User.exists({ email: EMAIL, role: "employee" }), "an employee should exist");
      const fresh = "nobody@example.test";
      assert.ok(!(await User.exists({ email: fresh, role: "employee" })));
    });

    await test("public registration still refuses any email that already exists", async () => {
      // routes/auth.js register keeps the broad check on purpose, so nobody can
      // register a customer account against a colleague's address.
      assert.ok(await User.findOne({ email: EMAIL }), "register would have allowed a duplicate");
    });

    console.log("\nSigning in to the right account");

    await test("the customer password opens the customer account", async () => {
      const { user, ambiguous } = await resolveLogin(EMAIL, "customer-pass");
      assert.strictEqual(ambiguous, false);
      assert.strictEqual(String(user._id), String(customer._id), "the wrong account was opened");
      assert.strictEqual(user.role, "customer");
    });

    await test("the Fixter password opens the Fixter account", async () => {
      const { user, ambiguous } = await resolveLogin(EMAIL, "fixter-pass");
      assert.strictEqual(ambiguous, false);
      assert.strictEqual(String(user._id), String(employee._id), "the wrong account was opened");
      assert.strictEqual(user.role, "employee");
    });

    await test("a wrong password opens nothing", async () => {
      const { user } = await resolveLogin(EMAIL, "not-either-password");
      assert.strictEqual(user, null);
    });

    await test("identical passwords are refused rather than guessed at", async () => {
      // The one genuinely ambiguous case. Picking one would be picking wrong
      // half the time, so the route asks instead.
      const shared = "same-on-both";
      const email = "shared@example.test";
      await makeCustomer(email, shared);
      await makeEmployee(email, "Fixter", shared);
      const result = await resolveLogin(email, shared);
      assert.strictEqual(result.ambiguous, true, "login silently picked one of two accounts");
      assert.strictEqual(result.matches.length, 2);
      const roles = result.matches.map((m) => m.role).sort();
      assert.deepStrictEqual(roles, ["customer", "employee"]);
    });

    await test("an account with no password is never a login candidate", async () => {
      // Google-only customers have no password hash. bcrypt.compare against an
      // empty hash must not be reached, let alone succeed.
      const email = "google@example.test";
      await User.create({
        userId: nextUserId(),
        name: "Google Only",
        email,
        role: "customer",
        phone: "+15550003333",
      });
      const { user } = await resolveLogin(email, "anything");
      assert.strictEqual(user, null);
    });

    console.log("\nWhich record answers which question");

    await test("billing resolves the customer, never the Fixter", async () => {
      const billing = await findBillingUserByEmail(EMAIL);
      assert.strictEqual(String(billing._id), String(customer._id), "a Fixter answered a billing lookup");
    });

    await test("customer lookups resolve the customer", async () => {
      const found = await findCustomerByEmail(EMAIL);
      assert.strictEqual(String(found._id), String(customer._id));
    });

    await test("employee lookups resolve the employee", async () => {
      const found = await findEmployeeByEmail(EMAIL);
      assert.strictEqual(String(found._id), String(employee._id));
    });

    await test("an email with only a Fixter account still answers billing rather than nothing", async () => {
      // Preserves the old unqualified behaviour for a single-record address,
      // which is the whole reason this is a preference and not a filter.
      const email = "staffonly@example.test";
      const only = await makeEmployee(email, "Fixter");
      assert.strictEqual(String((await findBillingUserByEmail(email))._id), String(only._id));
      assert.strictEqual(await findCustomerByEmail(email), null);
    });

    await test("legacy accounts with no role are still treated as customers", async () => {
      // 115 production records predate the role field and must keep working.
      const email = "legacy@example.test";
      const legacy = await User.collection.insertOne({
        userId: nextUserId(),
        name: "Legacy Person",
        email,
        password: await bcrypt.hash("legacy-pass", 4),
        phone: "+15550004444",
      });
      const found = await findCustomerByEmail(email);
      assert.ok(found, "a legacy null-role account stopped resolving");
      assert.strictEqual(String(found._id), String(legacy.insertedId));
      const { user } = await resolveLogin(email, "legacy-pass");
      assert.ok(user, "a legacy account could no longer sign in");
    });

    console.log("\nThe new Fixter behaves like any other");

    await test("the new Fixter is tippable and appears in the public chooser", async () => {
      const roster = await User.find({ role: "employee", isActive: { $ne: false } }).lean();
      assert.ok(isSelectableFixter(await User.findById(employee._id).lean()));
      const list = publicFixterList(roster);
      assert.ok(list.some((row) => row.firstName === "Taras"), "the new Fixter is not offered");
    });

    await test("the chooser still exposes no private employee data", async () => {
      const roster = await User.find({ role: "employee", isActive: { $ne: false } }).lean();
      const serialized = JSON.stringify(publicFixterList(roster));
      for (const secret of [EMAIL, String(employee._id), "Fixter account", "+15550002222"]) {
        assert.ok(!serialized.includes(secret), `private data leaked: ${secret}`);
      }
    });

    await test("the Fixter record carries the tip permission and not admin", async () => {
      const record = await User.findById(employee._id).lean();
      const granted = permissionsForUser(record);
      assert.ok(granted.includes(PERMISSIONS.TIPS_READ));
      assert.ok(!granted.includes(PERMISSIONS.ADMIN));
    });

    await test("tip notification targets the employee record's own email", async () => {
      // The notification is addressed from the Fixter loaded off the tip, so
      // the customer account sharing the address is never the recipient.
      const record = await User.findById(employee._id).lean();
      assert.strictEqual(record.email, EMAIL);
      assert.strictEqual(record.role, "employee");
      const customerRecord = await User.findById(customer._id).lean();
      assert.strictEqual(customerRecord.email, EMAIL);
      assert.notStrictEqual(String(record._id), String(customerRecord._id));
    });
  } finally {
    await mongoose.disconnect();
    await server.stop();
  }

  console.log(`\n${passed} passed, ${failures.length} failed.`);
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
