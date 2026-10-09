/*
 * Meta ad spend: the Insights client, the AdSpendDaily mirror, and the spend /
 * CAC / ROAS figures it adds to the Admin Overview.
 *
 *   node scripts/test_meta_ad_spend.js
 *
 * Deterministic and offline: Meta is a fake fetch (nothing leaves this
 * process, no token is real), Mongo is in-memory, Stripe is a fixed list.
 */
const assert = require("assert");
const express = require("express");
const nodeFetch = require("node-fetch");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-not-real";
process.env.MAIL_ADMIN = "owner@example.com";
delete process.env.FB_ACCESS_TOKEN;
delete process.env.META_CAPI_TOKEN;
delete process.env.META_ADS_ACCESS_TOKEN;
delete process.env.META_ADS_ACCOUNT_ID;
delete process.env.META_ADS_SYNC_ENABLED;
// Belt and braces: nothing in this file may reach the network through the global fetch.
globalThis.fetch = async () => {
  throw new Error("network disabled in tests");
};

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error?.stack?.split("\n").slice(0, 3).join("\n        ") || error}`);
  }
}
const section = (t) => console.log(`\n${t}`);
const DAY = 24 * 60 * 60 * 1000;

/* ---- Stripe replaced before anything loads the revenue module ---- */
let STRIPE_ROWS = [];
const revenuePath = require.resolve("../utils/analytics/stripeRevenue");
const realRevenue = require("../utils/analytics/stripeRevenue");
require.cache[revenuePath].exports = {
  ...realRevenue,
  collectedRevenue: async ({ from, to }) => ({ available: true, truncated: false, rows: STRIPE_ROWS.filter((r) => r.at >= from && r.at < to) }),
};

const spendMod = require("../utils/analytics/metaAdSpend");
const overview = require("../utils/analytics/overview");

/* ------------------------------------------------------------------ */
/* A fake Graph API                                                    */
/* ------------------------------------------------------------------ */

const ACCOUNT = "1234567890";
const TOKEN = "EAAtestTOKENnotREAL0123456789abcdefXYZ";
const nyYmd = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const shift = (ymd, n) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

/*
 * Holds ad rows and platform rows by date and answers insights queries for
 * the requested time_range, two ad rows per page so pagination is exercised.
 */
function fakeGraph({ ads, platforms, before = [] }) {
  const calls = [];
  const queue = [...before];
  const fn = async (url) => {
    const u = new URL(url);
    calls.push(u);
    if (queue.length) {
      const next = queue.shift();
      if (next) return next(u);
    }
    if (u.hostname !== "graph.facebook.com") throw new Error(`unexpected host ${u.hostname}`);
    if (u.pathname === `/v21.0/act_${ACCOUNT}`) return reply(200, { id: `act_${ACCOUNT}`, name: "Profixter", currency: "USD", timezone_name: "America/New_York", account_status: 1 });
    if (u.pathname !== `/v21.0/act_${ACCOUNT}/insights`) return reply(404, { error: { code: 803, message: "unknown path" } });
    const range = JSON.parse(u.searchParams.get("time_range"));
    const inRange = (r) => r.date_start >= range.since && r.date_start <= range.until;
    if (u.searchParams.get("level") === "account") {
      return reply(200, { data: platforms.filter(inRange) });
    }
    const all = ads.filter(inRange);
    const after = Number(u.searchParams.get("after") || 0);
    const page = all.slice(after, after + 2);
    const body = { data: page };
    if (after + 2 < all.length) {
      const next = new URL(u.toString());
      next.searchParams.set("after", String(after + 2));
      body.paging = { cursors: { after: String(after + 2) }, next: next.toString() };
    }
    return reply(200, body);
  };
  fn.calls = calls;
  return fn;
}

const adRow = (date, campaign, adset, ad, spend, extra = {}) => ({
  date_start: date,
  date_stop: date,
  account_currency: "USD",
  campaign_id: campaign[0],
  campaign_name: campaign[1],
  adset_id: adset[0],
  adset_name: adset[1],
  ad_id: ad[0],
  ad_name: ad[1],
  spend,
  impressions: "1000",
  clicks: "40",
  reach: "800",
  actions: [
    { action_type: "link_click", value: "25" },
    { action_type: "offsite_conversion.fb_pixel_lead", value: "2" },
    { action_type: "video_view", value: "300" },
  ],
  ...extra,
});
const platRow = (date, platform, spend) => ({ date_start: date, date_stop: date, publisher_platform: platform, spend, impressions: "10", clicks: "1", reach: "9", account_currency: "USD" });

async function main() {
  /* ------------------------------ pure ------------------------------ */
  section("Spend strings -> integer cents, without floats");
  const { toMinorUnits } = spendMod;
  await test("ordinary amounts", () => {
    assert.strictEqual(toMinorUnits("12.34"), 1234);
    assert.strictEqual(toMinorUnits("0.29"), 29); // 0.29 * 100 is 28.999999999999996 in floating point
    assert.strictEqual(toMinorUnits("0.5"), 50);
    assert.strictEqual(toMinorUnits("1234"), 123400);
    assert.strictEqual(toMinorUnits("0"), 0);
    assert.strictEqual(toMinorUnits("19.99"), 1999);
  });
  await test("a third decimal rounds half up", () => {
    assert.strictEqual(toMinorUnits("0.015"), 2);
    assert.strictEqual(toMinorUnits("0.014"), 1);
    assert.strictEqual(toMinorUnits("50.255"), 5026);
  });
  await test("unreadable or negative is null, never NaN", () => {
    for (const bad of ["abc", "-1", "", null, undefined, "1e3", "1,000.00"]) assert.strictEqual(toMinorUnits(bad), null, String(bad));
  });
  await test("numbers and zero-decimal currencies", () => {
    assert.strictEqual(toMinorUnits(12.3), 1230);
    assert.strictEqual(toMinorUnits("1000", "JPY"), 1000);
  });

  section("Configuration");
  await test("account id with or without act_, junk rejected", () => {
    assert.strictEqual(spendMod.configuredAccountId({ META_ADS_ACCOUNT_ID: "act_1234567890" }), "1234567890");
    assert.strictEqual(spendMod.configuredAccountId({ META_ADS_ACCOUNT_ID: " 1234567890 " }), "1234567890");
    assert.strictEqual(spendMod.configuredAccountId({ META_ADS_ACCOUNT_ID: "act_abc" }), null);
    assert.strictEqual(spendMod.configuredAccountId({}), null);
  });
  await test("token precedence: META_ADS_ACCESS_TOKEN, then META_CAPI_TOKEN, then FB_ACCESS_TOKEN", () => {
    assert.deepStrictEqual(spendMod.resolveToken({ META_ADS_ACCESS_TOKEN: "a", META_CAPI_TOKEN: "b", FB_ACCESS_TOKEN: "c" }), { token: "a", source: "META_ADS_ACCESS_TOKEN" });
    assert.deepStrictEqual(spendMod.resolveToken({ META_CAPI_TOKEN: "b", FB_ACCESS_TOKEN: "c" }), { token: "b", source: "META_CAPI_TOKEN" });
    assert.deepStrictEqual(spendMod.resolveToken({ FB_ACCESS_TOKEN: "c" }), { token: "c", source: "FB_ACCESS_TOKEN" });
    assert.deepStrictEqual(spendMod.resolveToken({}), { token: "", source: null });
  });
  await test("the schedule is a no-op unless enabled AND an account is set", () => {
    assert.strictEqual(spendMod.startMetaAdSpendSync(), false);
  });

  section("Sync window");
  await test("first run: 90 days back to today, in 30-day chunks", () => {
    const w = spendMod.syncWindow({}, "2026-10-09");
    assert.deepStrictEqual(w, { since: "2026-07-12", until: "2026-10-09", backfill: true });
    const chunks = spendMod.chunkWindow(w.since, w.until);
    assert.strictEqual(chunks.length, 3);
    assert.strictEqual(chunks[0].since, "2026-07-12");
    assert.strictEqual(chunks[2].until, "2026-10-09");
    for (let i = 1; i < chunks.length; i += 1) assert.strictEqual(chunks[i].since, shift(chunks[i - 1].until, 1));
  });
  await test("later runs re-read the last 3 days", () => {
    assert.deepStrictEqual(spendMod.syncWindow({ lastSuccessAt: new Date(), syncedThroughYmd: "2026-10-09" }, "2026-10-09"), { since: "2026-10-07", until: "2026-10-09", backfill: false });
  });
  await test("after days of failures it catches up from the last synced day, never past the horizon", () => {
    assert.strictEqual(spendMod.syncWindow({ lastSuccessAt: new Date(), syncedThroughYmd: "2026-10-01" }, "2026-10-09").since, "2026-09-29");
    assert.strictEqual(spendMod.syncWindow({ lastSuccessAt: new Date(), syncedThroughYmd: "2025-01-01" }, "2026-10-09").since, "2026-07-12");
  });

  section("Graph error classification");
  const cls = (error, httpStatus = 400) => spendMod.classifyGraphError({ httpStatus, error });
  await test("190 = token invalid or expired (permanent)", () => assert.deepStrictEqual(cls({ code: 190, error_subcode: 463 }), { reason: "token_invalid", transient: false }));
  await test("10 / 200 / 100 subcode 33 / ads_read message = missing ads_read (permanent)", () => {
    for (const e of [{ code: 10 }, { code: 200 }, { code: 272 }, { code: 100, error_subcode: 33 }, { code: 100, message: "(#100) Missing permissions: ads_read" }]) {
      assert.deepStrictEqual(cls(e), { reason: "token_missing_ads_read", transient: false }, JSON.stringify(e));
    }
  });
  await test("other code 100 = bad request (permanent)", () => assert.deepStrictEqual(cls({ code: 100, message: "Invalid parameter" }), { reason: "bad_request", transient: false }));
  await test("rate limits are transient", () => {
    for (const code of [4, 17, 32, 613, 80000, 80004]) assert.deepStrictEqual(cls({ code }), { reason: "rate_limited", transient: true }, String(code));
    assert.deepStrictEqual(cls(null, 429), { reason: "rate_limited", transient: true });
  });
  await test("Meta outages and network failures are transient", () => {
    assert.deepStrictEqual(cls({ code: 2 }), { reason: "meta_unavailable", transient: true });
    assert.deepStrictEqual(cls({ code: 1, is_transient: true }), { reason: "meta_unavailable", transient: true });
    assert.deepStrictEqual(cls(null, 503), { reason: "meta_unavailable", transient: true });
    assert.deepStrictEqual(spendMod.classifyGraphError({ network: true }), { reason: "network_error", transient: true });
  });
  await test("retired API version is permanent", () => assert.strictEqual(cls({ code: 2635 }).reason, "api_version_deprecated"));
  await test("errors are scrubbed of the token, however it appears", () => {
    const s = spendMod.sanitize(`bad https://graph.facebook.com/x?access_token=${TOKEN}&a=1 header Bearer ${TOKEN} raw ${TOKEN}`, TOKEN);
    assert.ok(!s.includes(TOKEN), s);
    assert.ok(!/EAA/.test(s), s);
  });
  await test("a pagination URL that is not graph.facebook.com is refused (the token never leaves Meta)", async () => {
    const seen = [];
    await assert.rejects(
      spendMod.graphGet("https://evil.example.com/x", { token: TOKEN, fetchImpl: async (u) => (seen.push(u), reply(200, {})) }),
      /non-Graph/
    );
    assert.strictEqual(seen.length, 0);
  });

  section("CAC / ROAS math");
  const { costPer, roasOf } = overview._internal;
  await test("cost per: rounded cents; null for zero or unknown", () => {
    assert.strictEqual(costPer(10000, 3), 3333);
    assert.strictEqual(costPer(10000, 0), null);
    assert.strictEqual(costPer(null, 3), null);
    assert.strictEqual(costPer(0, 2), 0);
  });
  await test("ROAS: revenue / spend to two decimals; null when spend is 0 or unknown", () => {
    assert.strictEqual(roasOf(49700, 17026), 2.92);
    assert.strictEqual(roasOf(0, 2000), 0);
    assert.strictEqual(roasOf(5000, 0), null);
    assert.strictEqual(roasOf(5000, null), null);
  });

  /* ------------------------- with Mongo ------------------------- */
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  const AdSpendDaily = require("../models/AdSpendDaily");
  const AnalyticsState = require("../models/AnalyticsState");
  const AdminActivityLog = require("../models/AdminActivityLog");
  const User = require("../models/User");
  const Subscription = require("../models/Subscription");
  const Booking = require("../models/Booking");
  const stripeMrr = require("../utils/analytics/stripeMrr");
  stripeMrr.setStripeClient({ subscriptions: { list: () => ({ async *[Symbol.asyncIterator]() {} }) } });

  const env = { META_ADS_ACCOUNT_ID: `act_${ACCOUNT}`, META_ADS_ACCESS_TOKEN: TOKEN, META_ADS_SYNC_ENABLED: "true" };
  const now = new Date();
  const today = nyYmd(now);
  const d = (n) => shift(today, -n);
  const C1 = ["111111111", "LI Free Visit"];
  const S1 = ["222222222", "LI 30-55"];
  const A1 = ["333333333", "Video 03"];
  const C2 = ["444444444", "Spend Only Campaign"];
  const S2 = ["555555555", "Broad"];
  const A2 = ["666666666", "Static 01"];
  const ADS = [
    adRow(d(1), C1, S1, A1, "100.00"),
    adRow(d(2), C1, S1, A1, "50.255"),
    adRow(d(3), C2, S2, A2, "20.00"),
    adRow(d(40), C1, S1, A1, "10.00"),
    adRow(d(41), C1, S1, A1, "10.00"),
  ];
  const PLATFORMS = [platRow(d(1), "facebook", "80.00"), platRow(d(1), "instagram", "20.00"), platRow(d(2), "facebook", "50.255"), platRow(d(3), "audience_network", "20.00"), platRow(d(40), "facebook", "20.00")];
  const sleeps = [];
  const sleep = async (ms) => sleeps.push(ms);
  const run = (fetchImpl, extra = {}) => spendMod.syncMetaAdSpend({ now, env, fetchImpl, sleep, ...extra });
  const state = async () => (await AnalyticsState.findOne({ key: spendMod.STATE_KEY }).lean())?.value || {};

  section("Sync: not configured");
  await test("no account id: status not_configured, nothing fetched", async () => {
    const fake = fakeGraph({ ads: ADS, platforms: PLATFORMS });
    const r = await spendMod.syncMetaAdSpend({ now, env: { META_ADS_ACCESS_TOKEN: TOKEN }, fetchImpl: fake, sleep });
    assert.strictEqual(r.reason, "not_configured");
    assert.strictEqual(r.connected, false);
    assert.strictEqual(fake.calls.length, 0);
  });
  await test("account but no token: token_missing", async () => {
    const r = await spendMod.syncMetaAdSpend({ now, env: { META_ADS_ACCOUNT_ID: ACCOUNT }, fetchImpl: fakeGraph({ ads: [], platforms: [] }), sleep });
    assert.strictEqual(r.reason, "token_missing");
  });

  section("Sync: first run backfills 90 days");
  let first;
  await test("pages through every ad row and stores integer cents", async () => {
    const fake = fakeGraph({ ads: ADS, platforms: PLATFORMS });
    first = await run(fake);
    assert.strictEqual(first.reason, "ok", first.lastError);
    assert.strictEqual(first.connected, true);
    assert.strictEqual(await AdSpendDaily.countDocuments({ level: "ad" }), 5);
    assert.strictEqual(await AdSpendDaily.countDocuments({ level: "platform" }), 5);
    const restated = await AdSpendDaily.findOne({ level: "ad", date: d(2) }).lean();
    assert.strictEqual(restated.spendCents, 5026);
    assert.strictEqual(restated.campaignId, C1[0]);
    assert.strictEqual(restated.adsetName, S1[1]);
    assert.strictEqual(restated.accountId, ACCOUNT);
    assert.strictEqual(restated.currency, "USD");
    assert.deepStrictEqual(restated.actions, { link_click: 25, pixel_lead: 2 });
    assert.strictEqual(restated.impressions, 1000);
    // Ad-level insights: 3 chunks; the 30-day chunk holding 3 rows took 2 pages.
    const adCalls = fake.calls.filter((u) => u.searchParams.get("level") === "ad");
    assert.ok(adCalls.length >= 4, `ad calls: ${adCalls.length}`);
    assert.ok(adCalls.some((u) => u.searchParams.get("after")), "followed paging.next");
  });
  await test("asks Meta for exactly the documented query", async () => {
    const fake = fakeGraph({ ads: [], platforms: [] });
    await AnalyticsState.deleteOne({ key: spendMod.STATE_KEY });
    await run(fake);
    const ad = fake.calls.find((u) => u.searchParams.get("level") === "ad");
    assert.strictEqual(ad.pathname, `/v21.0/act_${ACCOUNT}/insights`);
    assert.strictEqual(ad.searchParams.get("time_increment"), "1");
    const fields = ad.searchParams.get("fields").split(",");
    for (const f of ["campaign_id", "campaign_name", "adset_id", "adset_name", "ad_id", "ad_name", "spend", "impressions", "clicks", "reach", "actions", "account_currency"]) assert.ok(fields.includes(f), f);
    const plat = fake.calls.find((u) => u.searchParams.get("level") === "account");
    assert.strictEqual(plat.searchParams.get("breakdowns"), "publisher_platform");
    const first90 = JSON.parse(ad.searchParams.get("time_range"));
    assert.strictEqual(first90.since, d(89));
    assert.ok(fake.calls.every((u) => u.hostname === "graph.facebook.com"));
    // That run saw nothing: its 90-day window was emptied, as Meta now reports it.
    assert.strictEqual(await AdSpendDaily.countDocuments({}), 0);
    // Put the real data back for the rest of the suite.
    await AnalyticsState.deleteOne({ key: spendMod.STATE_KEY });
    first = await run(fakeGraph({ ads: ADS, platforms: PLATFORMS }));
    assert.strictEqual(await AdSpendDaily.countDocuments({}), 10);
  });
  await test("status record: success, currency, coverage; no token anywhere", async () => {
    const s = await state();
    assert.strictEqual(s.reason, "ok");
    assert.strictEqual(s.accountCurrency, "USD");
    assert.strictEqual(s.accountTimezone, "America/New_York");
    assert.strictEqual(s.coverageFromYmd, d(89));
    assert.strictEqual(s.syncedThroughYmd, today);
    assert.strictEqual(s.rowsUpserted, 10);
    assert.ok(s.lastSuccessAt && s.lastRunAt);
    assert.ok(!JSON.stringify(s).includes(TOKEN));
  });

  section("Sync: later runs re-read 3 days, idempotently");
  await test("same data again: same rows, no duplicates", async () => {
    const fake = fakeGraph({ ads: ADS, platforms: PLATFORMS });
    const r = await run(fake);
    assert.strictEqual(r.reason, "ok");
    assert.deepStrictEqual(r.lastWindow, { since: d(2), until: today });
    assert.strictEqual(await AdSpendDaily.countDocuments({}), 10);
    const ad = fake.calls.find((u) => u.searchParams.get("level") === "ad");
    assert.deepStrictEqual(JSON.parse(ad.searchParams.get("time_range")), { since: d(2), until: today });
  });
  await test("Meta restates a day: updated in place; a row Meta no longer reports is removed; older days untouched", async () => {
    const restatedAds = ADS.filter((r) => r.date_start !== d(2)).map((r) => (r.date_start === d(1) ? { ...r, spend: "120.00" } : r));
    const restatedPlatforms = PLATFORMS.filter((r) => r.date_start !== d(2));
    const r = await run(fakeGraph({ ads: restatedAds, platforms: restatedPlatforms }));
    assert.strictEqual(r.reason, "ok");
    assert.strictEqual((await AdSpendDaily.findOne({ level: "ad", date: d(1) }).lean()).spendCents, 12000);
    assert.strictEqual(await AdSpendDaily.countDocuments({ date: d(2) }), 0);
    assert.strictEqual(await AdSpendDaily.countDocuments({ date: d(40) }), 2);
    assert.strictEqual(r.rowsRemoved, 2);
    // Back to the original world for the Overview checks.
    await run(fakeGraph({ ads: ADS, platforms: PLATFORMS }));
    assert.strictEqual(await AdSpendDaily.countDocuments({}), 10);
    assert.strictEqual((await AdSpendDaily.findOne({ level: "ad", date: d(1) }).lean()).spendCents, 10000);
  });
  await test("two upserts racing on the unique key never duplicate", async () => {
    const row = { platform: "meta", accountId: ACCOUNT, date: "2020-01-01", level: "ad", entityId: "x1", spendCents: 1, fetchedAt: new Date() };
    const op = () => AdSpendDaily.updateOne({ platform: "meta", accountId: ACCOUNT, date: "2020-01-01", level: "ad", entityId: "x1" }, { $set: row }, { upsert: true }).catch((e) => (e.code === 11000 ? null : Promise.reject(e)));
    await Promise.all([op(), op(), op()]);
    assert.strictEqual(await AdSpendDaily.countDocuments({ date: "2020-01-01" }), 1);
    await AdSpendDaily.deleteMany({ date: "2020-01-01" });
  });

  section("Sync: retries and failures");
  await test("a transient Meta error is retried with backoff, then succeeds", async () => {
    sleeps.length = 0;
    const fake = fakeGraph({ ads: ADS, platforms: PLATFORMS, before: [null, () => reply(500, { error: { code: 2, is_transient: true, message: "Service temporarily unavailable" } })] });
    const r = await run(fake);
    assert.strictEqual(r.reason, "ok", r.lastError);
    assert.deepStrictEqual(sleeps, [2000]);
  });
  await test("a network failure is retried too", async () => {
    sleeps.length = 0;
    const fake = fakeGraph({ ads: ADS, platforms: PLATFORMS, before: [() => Promise.reject(new Error(`socket hang up ?access_token=${TOKEN}`))] });
    const r = await run(fake);
    assert.strictEqual(r.reason, "ok", r.lastError);
    assert.strictEqual(sleeps.length, 1);
  });
  await test("rate limited every time: bounded retries, reason rate_limited, data kept and still connected", async () => {
    sleeps.length = 0;
    const limited = () => reply(400, { error: { code: 17, message: "User request limit reached" } });
    const r = await run(fakeGraph({ ads: ADS, platforms: PLATFORMS, before: [limited, limited, limited, limited] }));
    assert.strictEqual(r.reason, "rate_limited");
    assert.strictEqual(r.connected, true);
    assert.deepStrictEqual(sleeps, [15000, 30000, 60000]);
    assert.strictEqual(await AdSpendDaily.countDocuments({}), 10);
  });
  await test("expired token (190): one attempt, token_invalid, disconnected, error scrubbed", async () => {
    sleeps.length = 0;
    const r = await run(fakeGraph({ ads: ADS, platforms: PLATFORMS, before: [() => reply(400, { error: { code: 190, error_subcode: 463, message: `Session has expired access_token=${TOKEN}` } })] }));
    assert.strictEqual(r.reason, "token_invalid");
    assert.strictEqual(r.connected, false);
    assert.strictEqual(sleeps.length, 0);
    assert.ok(!r.lastError.includes(TOKEN));
    assert.ok(!JSON.stringify(await state()).includes(TOKEN));
  });
  await test("token without ads_read (100/33): token_missing_ads_read", async () => {
    const r = await run(fakeGraph({ ads: ADS, platforms: PLATFORMS, before: [() => reply(400, { error: { code: 100, error_subcode: 33, message: "Unsupported get request. Object with ID 'act_1234567890' does not exist, cannot be loaded due to missing permissions" } })] }));
    assert.strictEqual(r.reason, "token_missing_ads_read");
    assert.strictEqual(r.connected, false);
    const st = await spendMod.adSpendStatus({ env });
    assert.strictEqual(st.reason, "token_missing_ads_read");
    assert.strictEqual(st.connected, false);
    assert.strictEqual(st.tokenPresent, true);
    assert.strictEqual(st.tokenSource, "META_ADS_ACCESS_TOKEN");
    assert.ok(!JSON.stringify(st).includes(TOKEN));
  });
  await test("another instance holds the lease: this one skips and fetches nothing", async () => {
    await AnalyticsState.updateOne({ key: spendMod.LEASE_KEY }, { $set: { value: { owner: "other-instance", until: Date.now() + 60000 } } }, { upsert: true });
    const fake = fakeGraph({ ads: ADS, platforms: PLATFORMS });
    const r = await run(fake);
    assert.deepStrictEqual(r, { skipped: true });
    assert.strictEqual(fake.calls.length, 0);
    await AnalyticsState.deleteOne({ key: spendMod.LEASE_KEY });
  });
  await test("reconnected: a good run restores connected", async () => {
    const r = await run(fakeGraph({ ads: ADS, platforms: PLATFORMS }));
    assert.strictEqual(r.reason, "ok");
    assert.strictEqual(r.connected, true);
  });

  /* ------------------------- Overview ------------------------- */
  const oid = () => new mongoose.Types.ObjectId();
  const ago = (days) => new Date(now.getTime() - days * DAY);
  const ids = { owner: oid(), customer: oid(), U1: oid(), U2: oid(), U4: oid(), U5: oid() };
  const addr = { U1: oid(), U4: oid(), U5: oid() };
  const user = (key, extra) => ({ _id: ids[key], userId: `PF-${key}`, name: `${key} Tester`, email: `${key.toLowerCase()}@example.com`, role: "customer", isActive: true, ...extra });
  await User.collection.insertMany([
    user("owner", { email: "owner@example.com", createdAt: ago(400) }),
    user("customer", { createdAt: ago(300) }),
    // Facebook ad, ids only in the URL (as the live ads send them); paid Plus 4 days ago.
    user("U1", { createdAt: ago(5), stripeCustomerId: "cus_U1", attribution: { utmSource: "fb", utmMedium: "paid", utmCampaign: C1[0], utmTerm: S1[0], utmContent: A1[0], fbclid: "x" } }),
    // Instagram, same campaign, registered, has not paid.
    user("U2", { createdAt: ago(3), attribution: { utmSource: "ig", utmMedium: "paid", utmCampaign: C1[0], fbclid: "y" } }),
    // Facebook, but a member since long before the period: revenue counts for ROAS, not a NEW paying customer.
    user("U4", { createdAt: ago(70), attribution: { utmSource: "fb", fbclid: "z" } }),
    // Facebook, first payment is a One-Time Visit in the period.
    user("U5", { createdAt: ago(2), attribution: { utmSource: "fb", campaignId: C1[0], fbclid: "w" } }),
  ]);
  const sub = (key, extra) =>
    Subscription.create({
      user: ids[key],
      userId: `PF-${key}`,
      addressId: addr[key],
      addressSnapshot: { line1: "x", city: "x", state: "NY", zip: "11757" },
      billingCycle: "monthly",
      accessStatus: "active",
      status: "active",
      currentPeriodEnd: new Date(now.getTime() + 20 * DAY),
      nextPaymentDate: new Date(now.getTime() + 20 * DAY),
      latestPaymentDate: ago(1),
      ...extra,
    });
  await sub("U1", { subscriptionType: "plus", startDate: ago(4), planPrice: 249 });
  await sub("U4", { subscriptionType: "basic", startDate: ago(60), planPrice: 149 });
  await Booking.collection.insertOne({
    _id: oid(),
    bookingNumber: "B1",
    user: ids.U5,
    userId: "PF-U5",
    name: "x",
    email: "x@example.com",
    phone: "x",
    address: "x",
    service: "Labor Only",
    subscription: "none",
    addressId: addr.U5,
    accessType: "one_time",
    bookingType: "one_time_handyman_visit",
    paymentState: "paid",
    createdAt: ago(2),
    date: ago(1),
    status: "Confirmed",
  });
  const charge = (extra) => ({ id: `ch_${Math.random()}`, service: true, refundedCents: 0, plan: null, billingCycle: null, stripeCustomerId: null, userRef: null, taxCents: 0, ...extra, netCents: extra.cents });
  STRIPE_ROWS = [
    charge({ at: ago(4), kind: "membership", plan: "plus", cents: 24900, stripeCustomerId: "cus_U1" }),
    charge({ at: ago(10), kind: "membership", plan: "basic", cents: 14900, userRef: String(ids.U4) }),
    charge({ at: ago(2), kind: "one_time", cents: 9900, userRef: String(ids.U5) }),
  ];

  // From here on the app is configured the way production would be.
  Object.assign(process.env, env);
  const SPEND_TOTAL = 10000 + 5026 + 2000; // the three ad days inside the last 30 days
  section("Overview: backward compatible when not connected");
  let before;
  await test("not connected: every field the frontend reads is present, spend fields null", async () => {
    await AnalyticsState.updateOne({ key: spendMod.STATE_KEY }, { $set: { "value.connected": false } });
    overview.clearOverviewCache();
    before = await overview.buildOverview({ range: "30d", now });
    assert.strictEqual(before.spend.connected, false);
    assert.strictEqual(before.spend.totalCents, null);
    for (const r of before.sources) {
      for (const f of ["key", "label", "group", "visitors", "registrations", "freeVisits", "members", "revenueCents", "spendCents", "conversion", "share", "costPerRegistrationCents", "costPerMemberCents", "roas"]) assert.ok(f in r, `source.${f}`);
      assert.strictEqual(r.spendCents, null);
      assert.strictEqual(r.roas, null);
      assert.strictEqual(r.cacCents, null);
    }
    for (const c of before.campaigns) {
      for (const f of ["key", "id", "name", "label", "visitors", "registrations", "freeVisits", "members", "revenueCents", "conversion", "spendCents", "roas", "costPerMemberCents"]) assert.ok(f in c, `campaign.${f}`);
      assert.strictEqual(c.spendCents, null);
    }
    // Ids only, not connected: shown as an id, never named.
    assert.strictEqual(before.campaigns.find((c) => c.id === C1[0]).label, `ID ${C1[0]}`);
    assert.ok(!before.campaigns.some((c) => c.id === C2[0]), "no spend-only rows without spend");
  });

  section("Overview: connected");
  let after;
  await test("spend block: total for the period's days, currency, status", async () => {
    await AnalyticsState.updateOne({ key: spendMod.STATE_KEY }, { $set: { "value.connected": true } });
    overview.clearOverviewCache();
    after = await overview.buildOverview({ range: "30d", now });
    assert.strictEqual(after.spend.connected, true);
    assert.strictEqual(after.spend.status, "ok");
    assert.strictEqual(after.spend.totalCents, SPEND_TOTAL);
    assert.strictEqual(after.spend.currency, "USD");
    assert.strictEqual(after.spend.platformSplit, true);
    assert.strictEqual(after.spend.partial, false);
    assert.ok(after.spend.lastSuccessAt);
  });
  await test("revenue, MRR, plans and counts are exactly what they were", async () => {
    assert.deepStrictEqual(after.kpis, before.kpis);
    assert.deepStrictEqual(after.plans, before.plans);
    assert.deepStrictEqual(after.funnel, before.funnel);
  });
  const src = () => Object.fromEntries(after.sources.map((s) => [s.key, s]));
  await test("Meta Ads group: spend, CAC over NEW paying customers, ROAS over attributed revenue", async () => {
    const meta = after.sourceGroups.find((g) => g.key === "meta");
    assert.strictEqual(meta.spendCents, SPEND_TOTAL);
    assert.strictEqual(meta.newPayingCustomers, 2); // U1 (membership) + U5 (one-time); U4 paid before the period
    assert.strictEqual(meta.cacCents, Math.round(SPEND_TOTAL / 2));
    assert.strictEqual(meta.revenueCents, 24900 + 14900 + 9900);
    assert.strictEqual(meta.roas, Math.round(((24900 + 14900 + 9900) / SPEND_TOTAL) * 100) / 100);
    assert.strictEqual(meta.costPerRegistrationCents, Math.round(SPEND_TOTAL / 3));
  });
  await test("Facebook / Instagram / Other Meta carry Meta's placement spend", async () => {
    const s = src();
    assert.strictEqual(s.meta_facebook.spendCents, 8000 + 5026);
    assert.strictEqual(s.meta_instagram.spendCents, 2000);
    assert.strictEqual(s.meta_other.spendCents, 2000);
    assert.strictEqual(s.meta_facebook.spendCents + s.meta_instagram.spendCents + s.meta_other.spendCents, SPEND_TOTAL);
    assert.strictEqual(s.meta_facebook.cacCents, Math.round(13026 / 2));
    assert.strictEqual(s.meta_facebook.roas, Math.round((49700 / 13026) * 100) / 100);
  });
  await test("zero denominators stay null; zero revenue on real spend is ROAS 0", async () => {
    const s = src();
    assert.strictEqual(s.meta_instagram.newPayingCustomers, 0);
    assert.strictEqual(s.meta_instagram.cacCents, null);
    assert.strictEqual(s.meta_instagram.costPerMemberCents, null);
    assert.strictEqual(s.meta_instagram.costPerRegistrationCents, 2000);
    assert.strictEqual(s.meta_instagram.roas, 0);
    assert.strictEqual(s.meta_other.costPerRegistrationCents, null);
  });
  await test("non-Meta sources: spend unknown (null), not zero", async () => {
    const s = src();
    for (const key of ["google_ads", "google_organic", "direct", "referral", "other", "events_qr"]) {
      assert.strictEqual(s[key].spendCents, null, key);
      assert.strictEqual(s[key].roas, null, key);
    }
  });
  await test("campaign matched by Meta id: spend, name from Meta, CAC, cost per member, ROAS", async () => {
    const c1 = after.campaigns.find((c) => c.id === C1[0]);
    assert.strictEqual(c1.spendCents, 15026);
    assert.strictEqual(c1.name, C1[1]);
    assert.strictEqual(c1.label, C1[1]);
    assert.strictEqual(c1.registrations, 3);
    assert.strictEqual(c1.members, 1);
    assert.strictEqual(c1.newPayingCustomers, 2);
    assert.strictEqual(c1.costPerMemberCents, 15026);
    assert.strictEqual(c1.cacCents, 7513);
    assert.strictEqual(c1.revenueCents, 24900 + 9900);
    assert.strictEqual(c1.roas, Math.round((34800 / 15026) * 100) / 100);
    const adset = c1.adsets.find((s) => s.id === S1[0]);
    assert.strictEqual(adset.spendCents, 15026);
    assert.strictEqual(adset.ads.find((a) => a.id === A1[0]).spendCents, 15026);
  });
  await test("a campaign that spent but brought nobody still shows, with null cost per member", async () => {
    const c2 = after.campaigns.find((c) => c.id === C2[0]);
    assert.ok(c2, "spend-only campaign present");
    assert.strictEqual(c2.label, C2[1]);
    assert.strictEqual(c2.spendCents, 2000);
    assert.strictEqual(c2.members, 0);
    assert.strictEqual(c2.costPerMemberCents, null);
    assert.strictEqual(c2.cacCents, null);
    assert.strictEqual(c2.roas, 0);
    assert.strictEqual(c2.adsets[0].ads[0].label, A2[1]);
  });
  await test("Meta customers with no campaign tag: spend unknown, not zero", async () => {
    const none = after.campaigns.find((c) => c.key === "(no campaign tag)");
    assert.ok(none);
    assert.strictEqual(none.spendCents, null);
  });
  await test("a period before the first synced day is flagged partial", async () => {
    overview.clearOverviewCache();
    const o = await overview.buildOverview({ range: "custom", from: d(120), to: d(100), now });
    assert.strictEqual(o.spend.partial, true);
    assert.strictEqual(o.spend.totalCents, 0);
  });

  /* ------------------------- routes ------------------------- */
  section("Admin endpoints");
  spendMod.setFetch(fakeGraph({ ads: ADS, platforms: PLATFORMS }));
  const app = express();
  app.use(express.json());
  app.use("/api/admin/overview", require("../routes/adminOverview"));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = (key) => jwt.sign({ id: String(ids[key]) }, process.env.JWT_SECRET);
  const call = (method, path, key) => nodeFetch(`${base}${path}`, { method, headers: key ? { Authorization: `Bearer ${token(key)}` } : {} });

  await test("status: customer 403, no token 401", async () => {
    assert.strictEqual((await call("GET", "/api/admin/overview/ad-spend/status", "customer")).status, 403);
    assert.strictEqual((await call("GET", "/api/admin/overview/ad-spend/status")).status, 401);
    assert.strictEqual((await call("POST", "/api/admin/overview/ad-spend/sync", "customer")).status, 403);
  });
  await test("status for the owner: configuration and last run, never the token", async () => {
    const res = await call("GET", "/api/admin/overview/ad-spend/status", "owner");
    assert.strictEqual(res.status, 200);
    const text = await res.text();
    assert.ok(!text.includes(TOKEN));
    const body = JSON.parse(text);
    assert.strictEqual(body.enabled, true);
    assert.strictEqual(body.accountId, ACCOUNT);
    assert.strictEqual(body.connected, true);
    assert.strictEqual(body.reason, "ok");
    assert.strictEqual(body.graphVersion, "v21.0");
  });
  await test("sync now: runs, answers with the status, and is logged in admin activity", async () => {
    const res = await call("POST", "/api/admin/overview/ad-spend/sync", "owner");
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.running, false);
    assert.strictEqual(body.status.reason, "ok");
    const log = await AdminActivityLog.findOne({ entityType: "analytics", entityId: "meta-ad-spend" }).lean();
    assert.ok(log, "activity logged");
    assert.strictEqual(log.action, "Meta Ad Spend Sync Requested");
  });
  await test("sync now while another instance syncs: 202, nothing fetched", async () => {
    await AnalyticsState.updateOne({ key: spendMod.LEASE_KEY }, { $set: { value: { owner: "other-instance", until: Date.now() + 60000 } } }, { upsert: true });
    const fake = fakeGraph({ ads: ADS, platforms: PLATFORMS });
    spendMod.setFetch(fake);
    const res = await call("POST", "/api/admin/overview/ad-spend/sync", "owner");
    assert.strictEqual(res.status, 202);
    assert.strictEqual(fake.calls.length, 0);
  });

  server.close();
  await mongoose.disconnect();
  await mongod.stop();
  console.log(`\n${passed}/${passed + failures.length} checks passed`);
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
