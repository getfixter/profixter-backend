/**
 * Marketing SMS opens at noon tomorrow, and opening it sends nothing.
 *
 * TWO PROMISES, AND THE SECOND IS THE HARD ONE.
 *
 * The first is that marketing SMS is blocked until 2026-09-14 12:00 America/
 * New_York and then becomes eligible on its own, with nobody awake for it. A
 * flag cannot do that, so a timestamp does.
 *
 * The second is that crossing the instant is not an event. Nothing may be
 * waiting for it. The failure everybody fears here is the one where a system
 * is switched on and immediately discharges everything it was holding - every
 * campaign that "would have been due", every lifecycle step that came up
 * overnight - into a single minute of somebody's afternoon. That is the blast,
 * and the cases at the bottom of this file exist to prove it cannot happen.
 *
 * The proof is structural rather than statistical: while the gate is closed
 * nothing is selected, nothing is queued and nothing is written, so at noon
 * there is no backlog in existence to release. The sweep chooses its audience
 * from current eligibility each time it runs.
 */
const assert = require("assert");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

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

/** The approved instant, and the two sides of it. */
const LAUNCH = new Date("2026-09-14T12:00:00-04:00");
const BEFORE = new Date("2026-09-14T11:59:59-04:00");
const AFTER = new Date("2026-09-14T12:00:01-04:00");

async function main() {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  const User = require("../models/User");
  const SmsMessage = require("../models/SmsMessage");
  const SmsCampaign = require("../models/SmsCampaign");
  const launch = require("../utils/marketing/smsMarketingLaunch");
  const { checkEligibility } = require("../utils/sms/smsEligibility");
  const { runSmsCampaignSweep } = require("../utils/sms/smsCampaignRunner");

  await SmsMessage.init();

  /* ==================================================================== */
  section("The instant itself");

  await test("the launch instant is noon New York on 14 September 2026", () => {
    assert.strictEqual(launch.marketingSmsLaunchAt().toISOString(), LAUNCH.toISOString());
    /* September in New York is EDT, so noon local is 16:00 UTC. */
    assert.strictEqual(launch.marketingSmsLaunchAt().toISOString(), "2026-09-14T16:00:00.000Z");
  });

  await test("it carries an explicit offset, so no machine's timezone can move it", () => {
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "..", "utils", "marketing", "smsMarketingLaunch.js"),
      "utf8"
    );
    assert.match(src, /2026-09-14T12:00:00-04:00/, "the constant must state its own offset");
    assert.ok(
      !/new Date\(\s*["']2026-09-14T12:00:00["']\s*\)/.test(src),
      "a naive local string would depend on the server's timezone"
    );
  });

  await test("one second before launch it is closed; one second after, open", () => {
    assert.strictEqual(launch.marketingSmsLaunched(BEFORE), false);
    assert.strictEqual(launch.marketingSmsLaunched(AFTER), true);
  });

  await test("exactly at the instant it is open", () => {
    assert.strictEqual(launch.marketingSmsLaunched(LAUNCH), true);
  });

  await test("an unparseable override falls back to the approved instant, not to open", () => {
    const prev = process.env.SMS_MARKETING_LAUNCH_AT;
    process.env.SMS_MARKETING_LAUNCH_AT = "not a date";
    try {
      assert.strictEqual(launch.marketingSmsLaunchAt().toISOString(), LAUNCH.toISOString());
      assert.strictEqual(launch.marketingSmsLaunched(BEFORE), false, "garbage must never mean open");
    } finally {
      if (prev === undefined) delete process.env.SMS_MARKETING_LAUNCH_AT;
      else process.env.SMS_MARKETING_LAUNCH_AT = prev;
    }
  });

  await test("the state object explains itself for the log", () => {
    const before = launch.marketingSmsLaunchState(BEFORE);
    assert.strictEqual(before.launched, false);
    assert.strictEqual(before.reason, "before_marketing_launch");
    assert.ok(before.msUntilLaunch > 0);
    const after = launch.marketingSmsLaunchState(AFTER);
    assert.strictEqual(after.launched, true);
    assert.strictEqual(after.msUntilLaunch, 0);
  });

  /* ==================================================================== */
  section("Eligibility honours the gate");

  process.env.SMS_ENABLED = "true";
  process.env.SMS_MARKETING_ENABLED = "true";

  const consented = await User.create({
    userId: `M1${Date.now()}`,
    name: "Dana Whitfield",
    email: `mk1.${Date.now()}@example.com`,
    password: "hashed",
    phone: "+16315558801",
    role: "customer",
    address: "14 Bayview Ave",
    city: "Babylon",
    state: "NY",
    zip: "11702",
    county: "Suffolk",
    smsPreferences: { marketingEnabled: true, transactionalEnabled: true },
  });

  await test("marketing is refused before the launch instant", async () => {
    const verdict = await checkEligibility({
      notificationType: "SEASONAL_MARKETING",
      user: consented,
      phone: consented.phone,
      now: BEFORE,
    });
    assert.strictEqual(verdict.eligible, false);
    assert.strictEqual(verdict.reason, "before_marketing_launch");
  });

  await test("transactional is NOT affected by the marketing gate", async () => {
    const verdict = await checkEligibility({
      notificationType: "BOOKING_CONFIRMED",
      user: consented,
      phone: consented.phone,
      now: BEFORE,
    });
    assert.strictEqual(verdict.eligible, true, "service SMS must launch today, not tomorrow");
  });

  await test("after the instant, marketing passes the gate", async () => {
    const verdict = await checkEligibility({
      notificationType: "SEASONAL_MARKETING",
      user: consented,
      phone: consented.phone,
      /* Inside the marketing window (11:00-18:00 ET) as well as after launch. */
      now: new Date("2026-09-14T13:00:00-04:00"),
    });
    assert.strictEqual(verdict.eligible, true, verdict.reason);
  });

  await test("the gate never substitutes for consent", async () => {
    const noConsent = await User.create({
      userId: `M2${Date.now()}`,
      name: "Dana Whitfield",
      email: `mk2.${Date.now()}@example.com`,
      password: "hashed",
      phone: "+16315558802",
      role: "customer",
      address: "14 Bayview Ave",
      city: "Babylon",
      state: "NY",
      zip: "11702",
      county: "Suffolk",
    });
    const verdict = await checkEligibility({
      notificationType: "SEASONAL_MARKETING",
      user: noConsent,
      phone: noConsent.phone,
      now: new Date("2026-09-14T13:00:00-04:00"),
    });
    assert.strictEqual(verdict.eligible, false);
    assert.strictEqual(verdict.reason, "marketing_not_opted_in");
  });

  await test("service consent alone still never authorises marketing", async () => {
    const serviceOnly = await User.create({
      userId: `M3${Date.now()}`,
      name: "Dana Whitfield",
      email: `mk3.${Date.now()}@example.com`,
      password: "hashed",
      phone: "+16315558803",
      role: "customer",
      address: "14 Bayview Ave",
      city: "Babylon",
      state: "NY",
      zip: "11702",
      county: "Suffolk",
      smsPreferences: { transactionalEnabled: true },
    });
    const verdict = await checkEligibility({
      notificationType: "MEMBERSHIP_MARKETING",
      user: serviceOnly,
      phone: serviceOnly.phone,
      now: new Date("2026-09-14T13:00:00-04:00"),
    });
    assert.strictEqual(verdict.eligible, false);
    assert.strictEqual(verdict.reason, "marketing_not_opted_in");
  });

  /* ==================================================================== */
  section("Crossing the instant sends nothing");

  await test("the sweep writes nothing at all while the gate is closed", async () => {
    const before = await SmsMessage.countDocuments();
    const stats = await runSmsCampaignSweep({ now: BEFORE });
    assert.strictEqual(stats.reason, "before_marketing_launch");
    assert.strictEqual(
      await SmsMessage.countDocuments(),
      before,
      "a closed gate must not create a single row - a row is a backlog"
    );
  });

  await test("running the sweep repeatedly before launch builds no queue", async () => {
    const before = await SmsMessage.countDocuments();
    for (let i = 0; i < 25; i += 1) {
      await runSmsCampaignSweep({ now: new Date(BEFORE.getTime() - i * 3600_000) });
    }
    assert.strictEqual(
      await SmsMessage.countDocuments(),
      before,
      "twenty-five closed sweeps must leave exactly nothing behind"
    );
  });

  await test("the first sweep after launch sends nothing by itself", async () => {
    /*
     * THE BLAST TEST. Everything above has already run the sweep repeatedly
     * while closed; this is the moment the gate opens. With no campaign
     * records there is nothing legitimately due, and crossing the instant must
     * therefore produce zero messages - not a catch-up of the twenty-five
     * sweeps that were refused.
     */
    const before = await SmsMessage.countDocuments();
    await runSmsCampaignSweep({ now: AFTER });
    assert.strictEqual(
      await SmsMessage.countDocuments(),
      before,
      "crossing the launch instant generated messages"
    );
  });

  await test("a campaign that was due before launch is not owed a catch-up", async () => {
    /*
     * A real campaign, enabled, whose daily window opened hours before noon.
     * Nothing may treat that as a debt: the sweep picks an audience from
     * eligibility as it stands when it runs, and there is no "missed sends"
     * query anywhere in the marketing path.
     */
    await SmsCampaign.create({
      campaignId: "audit_pre_launch_due",
      name: "Audit: due before launch",
      category: "seasonal",
      enabled: true,
      limits: { maxPerDay: 100, maxPerRun: 10 },
    });
    const before = await SmsMessage.countDocuments();

    /* Refused all morning... */
    for (const hour of [6, 8, 10, 11]) {
      await runSmsCampaignSweep({ now: new Date(`2026-09-14T${String(hour).padStart(2, "0")}:00:00-04:00`) });
    }
    assert.strictEqual(await SmsMessage.countDocuments(), before, "morning sweeps wrote rows");

    /* ...and at noon it does not make up for the morning. */
    await runSmsCampaignSweep({ now: LAUNCH });
    const after = await SmsMessage.countDocuments();
    assert.ok(
      after - before <= 1,
      `crossing launch produced ${after - before} messages; a catch-up of four refused sweeps would be more`
    );
  });

  await test("no code anywhere looks for marketing that became due earlier", () => {
    const fs = require("fs");
    const path = require("path");
    for (const file of [
      "utils/sms/smsCampaignRunner.js",
      "jobs/smsJobs.js",
      "utils/marketing/smsMarketingLaunch.js",
    ]) {
      const src = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
      for (const smell of ["catchUp", "catch_up", "missedSends", "backfill", "replay"]) {
        assert.ok(!src.includes(smell), `${file} contains ${smell}`);
      }
    }
  });

  await test("nobody has to do anything tomorrow", () => {
    /*
     * The point of the whole file. The gate reads a constant and the clock; it
     * takes no argument from an operator, reads no database row somebody has
     * to set, and has no admin endpoint. If this ever grows one, the promise
     * that noon happens without a human is quietly broken.
     */
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "..", "utils", "marketing", "smsMarketingLaunch.js"),
      "utf8"
    );
    assert.ok(!/router\.|req\.|res\./.test(src), "the gate must not be operable over HTTP");
    assert.ok(!/findOne|updateOne|mongoose/.test(src), "the gate must not depend on a database row");
  });

  delete process.env.SMS_ENABLED;
  delete process.env.SMS_MARKETING_ENABLED;

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
