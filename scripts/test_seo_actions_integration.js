/**
 * Autonomous SEO changes: every guardrail, the live verification, rollback,
 * and the public overrides endpoint the site reads. In-memory MongoDB; the
 * live site, Search Console data and IndexNow are faked.
 *
 *   node scripts/test_seo_actions_integration.js
 */
process.env.NODE_ENV = "test";
const assert = require("assert");
const http = require("http");
const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const GrowthAction = require("../models/GrowthAction");
const SeoOverride = require("../models/SeoOverride");
const VisibilitySnapshot = require("../models/VisibilitySnapshot");
require("../utils/growth/actions");
const engine = require("../utils/growth/actionEngine");
const { getDefinition } = require("../utils/growth/actionRegistry");

/* Fake the live site + IndexNow. */
const live = { title: "TV Mounting on Long Island | Profixter $99 Visit", description: "Old description", h1: "TV Mounting", noindex: false };
const pings = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes("indexnow")) {
    pings.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => "" };
  }
  if (u.startsWith("https://www.profixter.com/")) {
    const html = `<html><head><title>${live.title}</title><meta name="description" content="${live.description}">${live.noindex ? '<meta name="robots" content="noindex">' : ""}</head><body><h1>${live.h1}</h1></body></html>`;
    return { ok: true, status: 200, text: async () => html };
  }
  return realFetch(url, init);
};

let passed = 0;
async function test(name, fn) {
  await Promise.all([GrowthAction.deleteMany({}), SeoOverride.deleteMany({}), VisibilitySnapshot.deleteMany({})]);
  pings.length = 0;
  live.noindex = false;
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}`);
    throw e;
  }
}

const PATH = "/services/tv-mounting";
async function seedSearch({ days = 20, position = 8, ctr = 1, impressions = 40 } = {}) {
  const rows = [];
  for (let i = 1; i <= days; i += 1) {
    const date = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    rows.push({
      source: "search_console",
      date,
      key: "pages",
      metrics: { rows: [{ page: `https://www.profixter.com${PATH}`, clicks: Math.round((impressions * ctr) / 100), impressions, ctr: ctr / 100, position }] },
      fetchedAt: new Date(),
    });
  }
  await VisibilitySnapshot.insertMany(rows);
}

const good = {
  path: PATH,
  changes: { metaTitle: "TV Mounting in Babylon & Suffolk | Profixter", metaDescription: "Get your TV mounted level and secure by Profixter's in-house Fixters. Book your free first visit online - labor included, no card needed." },
  targetQueries: ["tv mounting babylon"],
  reason: "ranks ~8 with 1% CTR",
};

async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all([GrowthAction.init(), SeoOverride.init(), VisibilitySnapshot.init()]);
  const def = getDefinition("seo_page_update");
  console.log("seo actions");

  await test("validation: brand in title, length bounds, copy rules, our pages only", async () => {
    assert.throws(() => def.validate({ ...good, changes: { metaTitle: "TV Mounting in Babylon and Suffolk County NY" } }), /Profixter/);
    assert.throws(() => def.validate({ ...good, changes: { metaTitle: "Profixter" } }), /30-70/);
    assert.throws(() => def.validate({ ...good, changes: { metaDescription: "TV mounting from $99 with Profixter - the fastest mounting service on all of Long Island, booked online." } }), /No prices/);
    assert.throws(() => def.validate({ ...good, path: "/admin" }), /Not a page/);
    assert.throws(() => def.validate({ ...good, path: "https://evil.example/" }), /Not a page/);
    assert.throws(() => getDefinition("seo_page_update").validate({ path: PATH, changes: { h1: "x".repeat(20) } }), /No change/);
  });

  await test("needs search data; leaves performing and noindex pages alone; one change per 28 days", async () => {
    process.env.GROWTH_ACTIONS_ENABLED = "true";
    const run = async (key) => {
      const { action } = await engine.propose("seo_page_update", good, { idempotencyKey: key, proposedBy: { kind: "agent", name: "Visibility" } });
      return engine.approve(action._id, { kind: "owner", name: "Owner" });
    };
    assert.strictEqual((await run("a1")).result.reason, "not_enough_search_data");
    await seedSearch({ position: 2.1, ctr: 9 });
    assert.strictEqual((await run("a2")).result.reason, "page_already_performs");
    await VisibilitySnapshot.deleteMany({});
    await seedSearch({ position: 8, ctr: 1 });
    live.noindex = true;
    assert.strictEqual((await run("a3")).result.reason, "page_not_indexable");
    live.noindex = false;
    const ok = await run("a4");
    assert.strictEqual(ok.status, "succeeded", JSON.stringify(ok.result));
    assert.strictEqual((await run("a5")).result.reason, "changed_within_28_days");
  });

  await test("applies through the override layer, pings IndexNow, verifies on the live page, rolls back exactly", async () => {
    await seedSearch();
    const { action } = await engine.propose("seo_page_update", good, { idempotencyKey: "b1" });
    const done = await engine.approve(action._id, { kind: "owner", name: "Owner" });
    assert.strictEqual(done.status, "succeeded");
    const o = await SeoOverride.findOne({ path: PATH }).lean();
    assert.strictEqual(o.fields.metaTitle, good.changes.metaTitle);
    assert.strictEqual(o.history.length, 1);
    assert.strictEqual(pings.length, 1);
    assert.ok(pings[0].urlList[0].endsWith(PATH));

    // Not regenerated yet: inconclusive, not failed.
    await engine.verificationSweep({ now: new Date(Date.now() + 20 * 60 * 1000) });
    assert.strictEqual((await GrowthAction.findById(action._id)).verification.status, "pending");
    // Live page now serves it: verified.
    live.title = good.changes.metaTitle;
    live.description = good.changes.metaDescription;
    await engine.verificationSweep({ now: new Date(Date.now() + 60 * 60 * 1000) });
    assert.strictEqual((await GrowthAction.findById(action._id)).verification.status, "passed");

    const rolled = await engine.rollback(action._id, { kind: "owner", name: "Owner" });
    assert.strictEqual(rolled.status, "rolled_back");
    const after = await SeoOverride.findOne({ path: PATH }).lean();
    assert.strictEqual(after.active, false, "back to the code default");
  });

  await test("the public endpoint serves only active, non-empty overrides", async () => {
    await SeoOverride.create({ path: PATH, fields: { metaTitle: good.changes.metaTitle }, active: true });
    await SeoOverride.create({ path: "/locations/babylon", fields: { metaTitle: "Old" }, active: false });
    const app = express();
    app.use("/api/seo", require("../routes/seo"));
    const server = http.createServer(app).listen(0);
    try {
      const res = await realFetch(`http://127.0.0.1:${server.address().port}/api/seo/overrides`);
      const body = await res.json();
      assert.deepStrictEqual(Object.keys(body.overrides), [PATH]);
      assert.deepStrictEqual(body.overrides[PATH], { metaTitle: good.changes.metaTitle });
    } finally {
      server.close();
    }
  });

  await test("title updates can earn autonomy; they start needing approval", async () => {
    assert.strictEqual(def.defaultMode, "supervised");
    assert.strictEqual(def.maxMode, "autonomous");
    assert.strictEqual(def.riskTier, "low");
    assert.strictEqual(getDefinition("seo_content_update").promoteAfter, 5);
  });

  delete process.env.GROWTH_ACTIONS_ENABLED;
  await mongoose.disconnect();
  await mongo.stop();
  console.log(`\n${passed} passed`);
}

main().catch(async (e) => {
  console.error(e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
