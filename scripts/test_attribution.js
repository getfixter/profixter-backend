/*
 * Acquisition attribution: every source, ids vs names, internal links, and
 * what the Overview shows.
 *
 *   node scripts/test_attribution.js
 *
 * The browser half (true first touch, internal links never a touch) is pinned
 * in FrontEnd scripts/test_attribution_ui.js, which sends the registration
 * payloads this file classifies. Fixed in October 2026 after a production
 * audit found Google Organic -> Meta credited to Meta, our own "?source=home"
 * buttons blocking a later ad, Meta ids shown as campaign names, and no way to
 * see Facebook vs Instagram although every Meta ad already said which.
 */
const assert = require("assert");
const express = require("express");
const fetch = require("node-fetch");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error?.message || error}`);
  }
}
const section = (t) => console.log(`\n${t}`);

/* The URL parameters the live Meta ads use (October 2026). */
const LIVE_META = { utmMedium: "paid", utmCampaign: "52606450943827", utmTerm: "52606450943627", utmContent: "52606954471427", fbclid: "IwQAbc" };

async function main() {
  const { classifySource, sanitizeAttribution, campaignOf, originOf, displayName } = require("../utils/analytics/attribution");
  const src = (a) => classifySource(sanitizeAttribution(a) || {}).key;

  section("Every acquisition source (as registration sends it)");
  const CASES = [
    ["Facebook ad (live URL template)", { ...LIVE_META, utmSource: "fb", landingPath: "/", referrer: "https://m.facebook.com/" }, "meta_facebook"],
    ["Instagram ad (live URL template)", { ...LIVE_META, utmSource: "ig", landingPath: "/", referrer: "https://l.instagram.com/" }, "meta_instagram"],
    ["Other Meta placement: Audience Network", { ...LIVE_META, utmSource: "an" }, "meta_other"],
    ["Other Meta placement: Messenger", { ...LIVE_META, utmSource: "msg" }, "meta_other"],
    ["fbclid alone is Meta, not Facebook", { fbclid: "IwQ", referrer: "https://www.facebook.com/" }, "meta_other"],
    ["fbclid on an Instagram referrer is still not assumed Instagram", { fbclid: "IwQ", referrer: "https://l.instagram.com/" }, "meta_other"],
    ["Meta ids without utm_source", { campaignId: "120201234567890" }, "meta_other"],
    ["Google Ads: gclid (live ads, no UTMs)", { gclid: "Cj0K", landingPath: "/kitchen-bathroom", referrer: "https://www.google.com/" }, "google_ads"],
    ["Google Ads: gclid with no referrer", { gclid: "Cj0K" }, "google_ads"],
    ["Google Ads: gbraid (iOS)", { gbraid: "0AAAA" }, "google_ads"],
    ["Google Ads: utm google/cpc without a click id", { utmSource: "google", utmMedium: "cpc" }, "google_ads"],
    ["Google Organic: search referrer", { landingPath: "/", referrer: "https://www.google.com/" }, "google_organic"],
    ["Google Organic: utm google, not paid", { utmSource: "google", utmMedium: "organic" }, "google_organic"],
    ["Direct: nothing", { landingPath: "/" }, "direct"],
    ["Direct: our own site as referrer", { landingPath: "/projects", referrer: "https://www.profixter.com/" }, "direct"],
    ["Event: kiosk link", { refSource: "event", landingPath: "/signup" }, "events_qr"],
    ["QR: printed code, no referrer", { refSource: "qr", landingPath: "/" }, "events_qr"],
    ["QR: utm_medium=qr", { utmSource: "flyer", utmMedium: "qr" }, "events_qr"],
    ["Referral: program link ?ref=<customer>", { refCode: "12345678", landingPath: "/" }, "referral"],
    ["Referral: ?source=referral", { refSource: "referral" }, "referral"],
    ["Referral: utm_medium=referral", { utmSource: "partner", utmMedium: "referral" }, "referral"],
    ["Other: Yelp link (not our referral program)", { referrer: "https://www.yelp.com/biz/x" }, "other"],
    ["Other: organic Facebook post (no click id)", { referrer: "https://l.facebook.com/" }, "other"],
    ["Other: ChatGPT (utm_source)", { utmSource: "chatgpt.com" }, "other"],
    ["Internal ?source=home is ignored -> Direct", { refSource: "home", landingPath: "/signup" }, "direct"],
    ["Internal ?source=about is ignored -> Direct", { refSource: "about" }, "direct"],
    ["Internal ?source=start-screen is ignored -> Direct", { refSource: "start-screen" }, "direct"],
  ];
  for (const [label, attr, want] of CASES) await test(`${label} -> ${want}`, async () => assert.strictEqual(src(attr), want));

  await test("labels: Facebook, Instagram, Other Meta share the Meta group", async () => {
    assert.deepStrictEqual(
      ["fb", "ig", "an"].map((s) => classifySource({ fbclid: "x", utmSource: s })).map((c) => [c.label, c.group]),
      [["Facebook", "meta"], ["Instagram", "meta"], ["Other Meta", "meta"]]
    );
    assert.strictEqual(classifySource({ gclid: "g" }).group, null);
  });
  await test("sanitizer drops an internal ?source= stored by an older browser", async () => {
    assert.strictEqual(sanitizeAttribution({ refSource: "home", landingPath: "/signup" }).refSource, null);
    assert.strictEqual(sanitizeAttribution({ refSource: "event" }).refSource, "event");
  });
  await test("Other keeps where it came from", async () => {
    assert.strictEqual(originOf({ referrer: "https://l.facebook.com/x" }), "facebook.com");
    assert.strictEqual(originOf({ referrer: "https://www.yelp.com/biz/x" }), "yelp.com");
    assert.strictEqual(originOf({ utmSource: "chatgpt.com" }), "chatgpt.com");
    assert.strictEqual(originOf({ referrer: "https://www.profixter.com/" }), null);
  });

  section("Meta campaign / ad set / ad: ids and names apart");
  await test("live ads (ids in utm_campaign/term/content): ids, no names", async () => {
    const c = campaignOf({ ...LIVE_META, utmSource: "fb" });
    assert.deepStrictEqual(
      [c.campaignId, c.campaignName, c.adsetId, c.adsetName, c.adId, c.adName],
      ["52606450943827", null, "52606450943627", null, "52606954471427", null]
    );
    assert.strictEqual(displayName(c.campaignName, c.campaignId, "-"), "ID 52606450943827");
  });
  await test("recommended template (names in utm_*, ids in *_id): both", async () => {
    const c = campaignOf({ utmSource: "ig", utmCampaign: "Fall Membership", utmTerm: "LI 30-55", utmContent: "Video 03", campaignId: "526064509438", adsetId: "526064509436", adId: "526069544714" });
    assert.deepStrictEqual(
      [c.campaignId, c.campaignName, c.adsetId, c.adsetName, c.adId, c.adName],
      ["526064509438", "Fall Membership", "526064509436", "LI 30-55", "526069544714", "Video 03"]
    );
  });
  await test("explicit name parameters win over utm values", async () => {
    const c = campaignOf({ campaignName: "Spring", utmCampaign: "52606450943827" });
    assert.strictEqual(c.campaignName, "Spring");
    assert.strictEqual(c.campaignId, "52606450943827");
  });
  await test("a short number is not mistaken for a Meta id", async () => {
    assert.strictEqual(campaignOf({ utmCampaign: "2026" }).campaignName, "2026");
  });

  section("The beacon and the Overview (in-memory Mongo, real routes)");
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  process.env.JWT_SECRET = "attribution-test";
  const SiteVisitor = require("../models/SiteVisitor");
  const app = express();
  app.use(express.json());
  app.use("/api/track", require("../routes/track"));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(`${base}/api/track/visit`, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 Safari" }, body: JSON.stringify(body) });

  await test("beacon stores Meta ids and names in their own fields", async () => {
    await post({ visitorId: "v_test_meta_names1", ...LIVE_META, utmSource: "ig", campaignName: "Fall", adsetName: "LI", adName: "Video", landingPath: "/", referrer: "https://l.instagram.com/" });
    const r = await SiteVisitor.findOne({ visitorId: "v_test_meta_names1" }).lean();
    assert.deepStrictEqual([r.source, r.utmCampaign, r.campaignName, r.adsetName, r.adName], ["meta_instagram", "52606450943827", "Fall", "LI", "Video"]);
  });
  await test("beacon drops an internal ?source= and keeps an acquisition one", async () => {
    await post({ visitorId: "v_test_internal_1", refSource: "home", landingPath: "/signup" });
    await post({ visitorId: "v_test_qr_00001", refSource: "qr", landingPath: "/" });
    const [a, b] = await Promise.all([SiteVisitor.findOne({ visitorId: "v_test_internal_1" }).lean(), SiteVisitor.findOne({ visitorId: "v_test_qr_00001" }).lean()]);
    assert.deepStrictEqual([a.refSource, a.source, b.refSource, b.source], [null, "direct", "qr", "events_qr"]);
  });
  await test("beacon: referral-program ?ref= and Google gbraid", async () => {
    await post({ visitorId: "v_test_refcode001", refCode: "12345678", landingPath: "/" });
    await post({ visitorId: "v_test_gbraid0001", gbraid: "0AAA", landingPath: "/" });
    const [a, b] = await Promise.all([SiteVisitor.findOne({ visitorId: "v_test_refcode001" }).lean(), SiteVisitor.findOne({ visitorId: "v_test_gbraid0001" }).lean()]);
    assert.deepStrictEqual([a.source, a.refCode, b.source, b.hasGclid], ["referral", "12345678", "google_ads", true]);
  });
  await test("first visit is never rewritten by a later beacon", async () => {
    await post({ visitorId: "v_test_meta_names1", landingPath: "/other" });
    assert.strictEqual((await SiteVisitor.findOne({ visitorId: "v_test_meta_names1" }).lean()).landingPath, "/");
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
