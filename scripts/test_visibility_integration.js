/**
 * Visibility collectors against a real MongoDB (in-memory): the Mongo store's
 * idempotent upserts on the (source, date, key) unique index, leases through
 * the shared analyticsLease, collector status in AnalyticsState, and the
 * Command Center summary reading it all back. Fake fetch throughout.
 *
 * Integration suite (boots an in-memory MongoDB binary), so it is NOT in
 * run_ci_tests.js:
 *
 *   node scripts/test_visibility_integration.js
 */
process.env.NODE_ENV = "test";

const assert = require("assert");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const VisibilitySnapshot = require("../models/VisibilitySnapshot");
const AnalyticsState = require("../models/AnalyticsState");
const { mongoStore } = require("../utils/visibility/store");
const { runCollector } = require("../utils/visibility/collectors");
const { buildVisibilitySummary } = require("../utils/visibility/summary");
const rank = require("../utils/visibility/localRank");

const quiet = { log() {}, error() {} };
const json = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body });

(async () => {
  const server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
  await VisibilitySnapshot.init();
  const store = mongoStore();
  let passed = 0;
  try {
    // Reviews: two runs on one day are one row; the next day adds a second.
    const env = { GOOGLE_PLACES_API_KEY: "AIzaFAKEFAKEFAKEFAKEFAKEFAKE", GOOGLE_PLACE_ID: "ChIJtest" };
    let total = 40;
    const fetchImpl = async () => json({ status: "OK", result: { rating: 4.9, user_ratings_total: total } });
    await runCollector("google_reviews", { env, store, fetchImpl, now: new Date("2026-09-10T10:10:00Z"), log: quiet });
    total = 41;
    await runCollector("google_reviews", { env, store, fetchImpl, now: new Date("2026-09-10T22:10:00Z"), log: quiet });
    assert.strictEqual(await VisibilitySnapshot.countDocuments({ source: "google_reviews" }), 1);
    assert.strictEqual((await VisibilitySnapshot.findOne({ source: "google_reviews" }).lean()).metrics.total, 41);
    total = 47;
    await runCollector("google_reviews", { env, store, fetchImpl, now: new Date("2026-10-10T10:10:00Z"), log: quiet });
    assert.strictEqual(await VisibilitySnapshot.countDocuments({ source: "google_reviews" }), 2);
    passed += 1;
    console.log("  ok  reviews upsert is idempotent per day");

    // Status lands in AnalyticsState with no secret in it.
    const status = await AnalyticsState.findOne({ key: "visibility:status:google_reviews" }).lean();
    assert.strictEqual(status.value.lastSuccessAt, "2026-10-10T10:10:00.000Z");
    assert.ok(!JSON.stringify(status).includes("AIzaFAKE"));
    passed += 1;
    console.log("  ok  status recorded");

    // A lease held by "another instance" (unexpired, different owner) blocks the run.
    await AnalyticsState.updateOne(
      { key: "visibility:lease:google_reviews" },
      { $set: { value: { owner: "other-instance", until: Date.now() + 60000 } } },
      { upsert: true }
    );
    const blocked = await runCollector("google_reviews", { env, store, fetchImpl, log: quiet });
    assert.deepStrictEqual(blocked, { ran: false, skipped: true, reason: "lease_held" });
    passed += 1;
    console.log("  ok  lease held elsewhere skips the run");

    // Local rank rows for two runs; latestDates/findSnapshots work on Mongo.
    const row = (date, town, r) => ({
      source: "local_rank",
      date,
      key: `handyman|${town}`,
      metrics: { keyword: "handyman", town, rank: r, topCompetitors: [] },
      fetchedAt: new Date(),
    });
    await store.upsertSnapshots([row("2026-10-05", "Lindenhurst", 4), row("2026-10-12", "Lindenhurst", 2), row("2026-10-12", "Babylon", null)]);
    const s = await rank.rankSummary({ store });
    assert.strictEqual(s.runDate, "2026-10-12");
    assert.strictEqual(s.previousRunDate, "2026-10-05");
    assert.strictEqual(s.avgRank, 11.5);
    assert.strictEqual(s.change, 2);
    passed += 1;
    console.log("  ok  rank summary reads Mongo");

    const summary = await buildVisibilitySummary({ store, env, now: new Date("2026-10-10T15:00:00Z") });
    assert.strictEqual(summary.reviews.available, true);
    assert.strictEqual(summary.reviews.totalNow, 47);
    assert.strictEqual(summary.reviews.velocityPer30Days, 6);
    assert.strictEqual(summary.search.reason, "disabled");
    assert.strictEqual(summary.localRank.available, true, "history is shown even while the collector is off");
    passed += 1;
    console.log("  ok  Command Center summary");

    await mongoose.disconnect();
    const down = await buildVisibilitySummary({ store, env });
    assert.strictEqual(down.reviews.reason, "db_unavailable");
    passed += 1;
    console.log("  ok  disconnected database degrades at once");
  } finally {
    if (mongoose.connection.readyState) await mongoose.disconnect();
    await server.stop();
  }
  console.log(`\nvisibility integration: ${passed}/6 passed`);
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
