/**
 * The legacy service-SMS migration, and everything it must refuse to do.
 *
 * The migration says that 156 accounts which registered under the previous
 * process carry service-SMS permission on a legacy basis. That is a defensible
 * business position and a dangerous piece of code: it writes consent, in bulk,
 * to people who are not present to object. So most of this file is about the
 * cases where it must decline.
 *
 * The ones that matter most, in order: a handset STOP is never overridden, a
 * customer who switched service texts off is never switched back on, marketing
 * is never granted as a side effect of service, and running the thing twice
 * changes nothing.
 *
 * It also proves the two provenance properties that keep the record honest -
 * the consent date is not back-dated to a sign-up on which no consent
 * happened, and the source never claims to be today's web form.
 */
const assert = require("assert");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { spawnSync } = require("child_process");
const path = require("path");

const VERSION = "legacy_service_sms_v1";
const CONSENT_SOURCE = "legacy_registration_migration";
const BASIS = "historical_legacy_migration";

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error?.message || error}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

async function main() {
  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  await mongoose.connect(uri);

  const User = require("../models/User");
  const SmsOptOut = require("../models/SmsOptOut");
  const SmsMessage = require("../models/SmsMessage");
  const { accountAllows } = require("../utils/sms/smsEligibility");

  await SmsOptOut.init();
  await SmsMessage.init();

  const REGISTERED_ON = new Date("2025-11-04T15:22:00Z");
  let seq = 0;

  async function makeUser(overrides = {}) {
    seq += 1;
    return User.create({
      userId: `L${seq}${Date.now()}`,
      name: "Dana Whitfield",
      email: `legacy${seq}.${Date.now()}@example.com`,
      password: "hashed",
      phone: overrides.phone || `+1631555${String(7000 + seq).slice(-4)}`,
      role: "customer",
      address: "14 Bayview Ave",
      city: "Babylon",
      state: "NY",
      zip: "11702",
      county: "Suffolk",
      createdAt: REGISTERED_ON,
      legacyRegisteredUser: true,
      legacyCommunicationStateSource: "pre_current_consent_registration",
      legacyRegisteredAt: REGISTERED_ON,
      ...overrides,
    });
  }

  /** Run the real script against this database, exactly as production would. */
  function runMigration(execute = true) {
    const args = [path.join(__dirname, "migrate_legacy_service_sms_consent.js")];
    if (execute) args.push("--execute");
    const result = spawnSync(process.execPath, args, {
      env: { ...process.env, MONGO_URI: uri, NODE_ENV: "test" },
      encoding: "utf8",
    });
    return result.stdout + result.stderr;
  }

  const reload = (u) => User.findById(u._id).lean();

  /* ==================================================================== */
  section("Who receives it");

  const plain = await makeUser();
  const employee = await makeUser({ role: "employee", legacyRegisteredUser: undefined });
  const stopped = await makeUser({ phone: "+16315557501" });
  await SmsOptOut.create({
    phone: "+16315557501",
    scope: "all",
    source: "carrier_keyword",
    optedOutAt: new Date(),
  });
  const optedOutOnAccount = await makeUser({
    smsPreferences: { optedOutAt: new Date(), optOutSource: "sms_stop_keyword" },
  });
  const switchedOff = await makeUser({ smsPreferences: { transactionalEnabled: false } });
  const currentWebConsent = await makeUser({
    smsPreferences: {
      transactionalEnabled: true,
      transactionalConsentAt: new Date("2026-09-01"),
      transactionalConsentSource: "signup_web_form",
    },
  });
  const notLegacy = await makeUser({ legacyRegisteredUser: undefined });

  const output = runMigration(true);

  await test("an eligible legacy account receives service consent", async () => {
    const row = await reload(plain);
    assert.strictEqual(row.smsPreferences.transactionalEnabled, true);
  });

  await test("the consent date is the migration, NOT back-dated to registration", async () => {
    /*
     * The field means "when they consented". These customers did not consent
     * when they registered - the old checkbox covered Terms and Privacy only -
     * so back-dating it would put a consent date on a day no consent happened.
     * The registration date is preserved separately instead.
     */
    const row = await reload(plain);
    assert.notStrictEqual(
      new Date(row.smsPreferences.transactionalConsentAt).toISOString(),
      REGISTERED_ON.toISOString(),
      "a consent date must not be invented for the day they signed up"
    );
    assert.strictEqual(
      new Date(row.smsPreferences.transactionalConsentAt).toISOString(),
      new Date(row.legacyConsentMigration.migratedAt).toISOString(),
      "it is the moment this permission actually came into being"
    );
    assert.strictEqual(
      new Date(row.legacyRegisteredAt).toISOString(),
      REGISTERED_ON.toISOString(),
      "and the registration date survives, described as what it is"
    );
  });

  await test("the source never claims to be today's web form", async () => {
    const row = await reload(plain);
    assert.strictEqual(row.smsPreferences.transactionalConsentSource, CONSENT_SOURCE);
    assert.notStrictEqual(row.smsPreferences.transactionalConsentSource, "signup_web_form");
  });

  await test("the migration records when IT ran, separately", async () => {
    const row = await reload(plain);
    assert.strictEqual(row.legacyConsentMigration.version, VERSION);
    assert.ok(row.legacyConsentMigration.migratedAt, "the run time is kept");
    assert.notStrictEqual(
      new Date(row.legacyConsentMigration.migratedAt).toISOString(),
      REGISTERED_ON.toISOString(),
      "the run time and the registration date are different facts"
    );
    assert.strictEqual(
      new Date(row.legacyConsentMigration.historicalRegisteredAt).toISOString(),
      REGISTERED_ON.toISOString()
    );
  });

  await test("Admin can tell this apart from current web consent", async () => {
    assert.strictEqual((await reload(plain)).communicationStateBasis, BASIS);
    const web = await reload(currentWebConsent);
    assert.notStrictEqual(web.communicationStateBasis, BASIS, "a current consent was relabelled");
    assert.strictEqual(web.smsPreferences.transactionalConsentSource, "signup_web_form");
  });

  /* ==================================================================== */
  section("Who it must refuse");

  await test("a handset STOP is never overridden", async () => {
    const row = await reload(stopped);
    assert.notStrictEqual(
      row.smsPreferences?.transactionalEnabled,
      true,
      "a STOP is absolute and outranks any migration"
    );
  });

  await test("an opt-out recorded on the account is never overridden", async () => {
    const row = await reload(optedOutOnAccount);
    assert.notStrictEqual(row.smsPreferences?.transactionalEnabled, true);
  });

  await test("a customer who switched service texts off stays off", async () => {
    const row = await reload(switchedOff);
    assert.strictEqual(
      row.smsPreferences.transactionalEnabled,
      false,
      "a later explicit choice always beats an earlier registration"
    );
  });

  await test("current web consent is left exactly as it was", async () => {
    const row = await reload(currentWebConsent);
    assert.strictEqual(row.smsPreferences.transactionalConsentSource, "signup_web_form");
    assert.strictEqual(
      new Date(row.smsPreferences.transactionalConsentAt).toISOString(),
      new Date("2026-09-01").toISOString(),
      "a real consent date must not be rewritten to a registration date"
    );
  });

  await test("employees and non-legacy accounts are untouched", async () => {
    for (const u of [employee, notLegacy]) {
      const row = await reload(u);
      assert.notStrictEqual(row.smsPreferences?.transactionalEnabled, true);
      assert.ok(!row.legacyConsentMigration?.version, "no migration stamp may be written");
    }
  });

  /* ==================================================================== */
  section("Marketing is never granted");

  await test("no account gains marketing consent", async () => {
    const withMarketing = await User.countDocuments({ "smsPreferences.marketingEnabled": true });
    assert.strictEqual(withMarketing, 0, "marketing must never follow from service");
  });

  await test("a migrated account is still refused marketing at send time", async () => {
    const row = await reload(plain);
    const verdict = accountAllows(row, "SEASONAL_MARKETING");
    assert.strictEqual(verdict.eligible, false);
    assert.strictEqual(verdict.reason, "marketing_not_opted_in");
  });

  await test("the script never writes a marketing field", () => {
    const src = require("fs").readFileSync(
      path.join(__dirname, "migrate_legacy_service_sms_consent.js"),
      "utf8"
    );
    const write = src.slice(src.indexOf("$set: {"), src.indexOf("written += 1"));
    for (const field of ["marketingEnabled", "marketingConsentAt", "marketingConsentSource"]) {
      assert.ok(!write.includes(field), `the migration writes ${field}`);
    }
  });

  /* ==================================================================== */
  section("It sends nothing");

  await test("no SMS row of any kind was created", async () => {
    assert.strictEqual(await SmsMessage.countDocuments(), 0);
  });

  await test("nothing was queued for later delivery", async () => {
    const queued = await SmsMessage.countDocuments({
      status: { $in: ["pending", "sending", "retry_scheduled"] },
    });
    assert.strictEqual(queued, 0, "a queued row is a message waiting to happen");
  });

  await test("no provider send was recorded", async () => {
    assert.strictEqual(
      await SmsMessage.countDocuments({ providerMessageSid: { $nin: [null, ""] } }),
      0
    );
  });

  await test("the script imports no sending machinery at all", () => {
    const src = require("fs").readFileSync(
      path.join(__dirname, "migrate_legacy_service_sms_consent.js"),
      "utf8"
    );
    for (const forbidden of ["smsService", "smsNotifications", "emailService", "twilioProvider", "sendTransactionalSms"]) {
      assert.ok(!src.includes(forbidden), `the migration can reach ${forbidden}`);
    }
  });

  await test("its own report confirms zero movement", () => {
    assert.match(output, /ZERO messages, zero queued sends, zero marketing consent granted/);
  });

  /* ==================================================================== */
  section("Running it twice changes nothing");

  await test("a second run migrates nobody and moves no timestamp", async () => {
    const beforeRow = await reload(plain);
    const second = runMigration(true);
    const afterRow = await reload(plain);

    assert.strictEqual(
      new Date(afterRow.legacyConsentMigration.migratedAt).toISOString(),
      new Date(beforeRow.legacyConsentMigration.migratedAt).toISOString(),
      "a re-run must not move the migration timestamp"
    );
    assert.strictEqual(
      new Date(afterRow.smsPreferences.transactionalConsentAt).toISOString(),
      new Date(beforeRow.smsPreferences.transactionalConsentAt).toISOString()
    );
    assert.match(second, /migrated : 0/, "the second run should find nobody eligible");
  });

  await test("the dry run writes nothing", async () => {
    const fresh = await makeUser();
    runMigration(false);
    const row = await reload(fresh);
    assert.notStrictEqual(row.smsPreferences?.transactionalEnabled, true);
  });

  /* ==================================================================== */
  section("Eligibility still behaves");

  await test("a migrated account is now eligible for service SMS", async () => {
    const row = await reload(plain);
    const verdict = accountAllows(row, "BOOKING_CONFIRMED");
    assert.strictEqual(verdict.eligible, true, "that is the point of the migration");
  });

  await test("eligibility reads the boolean, not the basis label", () => {
    const src = require("fs").readFileSync(
      path.join(__dirname, "..", "utils", "sms", "smsEligibility.js"),
      "utf8"
    );
    for (const field of ["communicationStateBasis", "legacyConsentMigration", "legacyRegisteredUser"]) {
      assert.ok(!src.includes(field), `smsEligibility reads ${field}; it must not`);
    }
  });

  /* ==================================================================== */
  await mongoose.disconnect();
  await mongod.stop();

  console.log("");
  if (failures.length) {
    console.log(`${passed} passed, ${failures.length} failed`);
    process.exit(1);
  }
  console.log(`${passed} passed, 0 failed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
