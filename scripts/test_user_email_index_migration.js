/**
 * The email-uniqueness index changes shape without ever lapsing.
 *
 * Starts from the production state (the old full unique index, real-looking
 * customers), runs the migration one step at a time, and tries to insert a
 * duplicate email between every step. Then checks that phone-only customers
 * are possible afterwards, that a rerun does nothing, and that syncIndexes on
 * the new schema keeps the new index rather than dropping it.
 *
 *   node scripts/test_user_email_index_migration.js
 *
 * Not in `npm test`: it boots a MongoDB binary.
 */

Object.assign(process.env, { S3_BUCKET: "x", JWT_SECRET: "x", STRIPE_SECRET_KEY: "sk_test_x" });
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { NEW_NAME, OLD_NAME, migrateUserEmailIndex } = require("../utils/migrations/userEmailIndex");

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures.push(error);
    console.log(`  FAIL  ${name}\n        ${error.stack}`);
  }
}

async function rejectsDuplicate(collection, email) {
  await assert.rejects(
    collection.insertOne({ userId: `dup-${Math.random()}`, email, role: "customer" }),
    (error) => error.code === 11000,
    `a second customer with ${email} must be refused`
  );
}

(async () => {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  const collection = mongoose.connection.db.collection("users");

  // Production today: the old index, and customers that all have emails.
  await collection.createIndex({ email: 1, role: 1 }, { unique: true, name: OLD_NAME });
  await collection.insertMany([
    { userId: "1", email: "a@example.com", role: "customer" },
    { userId: "2", email: "b@example.com", role: "customer" },
    { userId: "3", email: "a@example.com", role: "employee" },
    { userId: "4", email: "c@example.com", role: null },
  ]);

  await test("before: duplicates refused by the old index", async () => {
    await rejectsDuplicate(collection, "a@example.com");
  });

  await test("step 1 builds the new index BESIDE the old one; duplicates still refused", async () => {
    // Run only step 1 by giving the drop nothing to find yet: call the real
    // migration against a proxy whose dropIndex records instead of acting.
    let dropped = null;
    const stepOne = new Proxy(collection, {
      get(target, prop) {
        if (prop === "dropIndex") return async (name) => { dropped = name; };
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await migrateUserEmailIndex(stepOne);
    const names = (await collection.indexes()).map((index) => index.name);
    assert.ok(names.includes(OLD_NAME) && names.includes(NEW_NAME), `both indexes exist: ${names}`);
    assert.equal(dropped, OLD_NAME, "the drop is only attempted after the new index exists");
    await rejectsDuplicate(collection, "b@example.com");
  });

  await test("step 2 drops the old index; duplicates STILL refused, by the new one", async () => {
    const { steps } = await migrateUserEmailIndex(collection);
    assert.deepEqual(steps, ["dropped_full"]);
    const names = (await collection.indexes()).map((index) => index.name);
    assert.ok(!names.includes(OLD_NAME) && names.includes(NEW_NAME));
    await rejectsDuplicate(collection, "a@example.com");
    await rejectsDuplicate(collection, "c@example.com".replace("c@", "b@"));
  });

  await test("after: several customers with no email can exist", async () => {
    await collection.insertOne({ userId: "p1", role: "customer", phone: "+16315550001" });
    await collection.insertOne({ userId: "p2", role: "customer", phone: "+16315550002" });
    assert.equal(await collection.countDocuments({ email: { $exists: false } }), 2);
  });

  await test("a customer and an employee may still share an email (unchanged rule)", async () => {
    assert.equal(await collection.countDocuments({ email: "a@example.com" }), 2);
  });

  await test("rerunning does nothing", async () => {
    const { steps } = await migrateUserEmailIndex(collection);
    assert.deepEqual(steps, []);
  });

  await test("syncIndexes on the new schema keeps the new index and never re-adds the old", async () => {
    const User = require("../models/User");
    await User.syncIndexes();
    const names = (await collection.indexes()).map((index) => index.name);
    assert.ok(names.includes(NEW_NAME));
    assert.ok(!names.includes(OLD_NAME));
    await rejectsDuplicate(collection, "a@example.com");
  });

  await mongoose.disconnect();
  await mongod.stop();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
