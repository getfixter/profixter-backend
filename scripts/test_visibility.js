/**
 * Local-visibility collectors (utils/visibility): query families, AI answer
 * scoring, local-rank matching and averaging, the budget caps, review
 * velocity, Search Console windows, the runner's flag/lease/status handling,
 * summary degradation, and the unchanged /api/google/reviews response.
 *
 * Deterministic: no network (every HTTP call is an injected fake fetch), no
 * database (the in-memory store from utils/visibility/store). In CI.
 *
 *   node scripts/test_visibility.js
 */
process.env.NODE_ENV = "test";

const assert = require("assert");
const path = require("path");

const { memoryStore } = require("../utils/visibility/store");
const { classifyQuery } = require("../utils/visibility/queryFamilies");
const reviews = require("../utils/visibility/googleReviews");
const gsc = require("../utils/visibility/searchConsole");
const rank = require("../utils/visibility/localRank");
const ai = require("../utils/visibility/aiVisibility");
const { runCollector, collectorStatuses } = require("../utils/visibility/collectors");
const { buildVisibilitySummary } = require("../utils/visibility/summary");
const { sanitizeError, nyDate, shiftYmd } = require("../utils/visibility/common");

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const quiet = { log() {}, error() {} };

/** A fake fetch: `routes` is (url, init) => { status, body } or a body. Records calls. */
function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null });
    const out = await handler(String(url), init, calls.length);
    const status = out && out.__status ? out.__status : 200;
    const body = out && out.__status ? out.body : out;
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) };
  };
  fn.calls = calls;
  return fn;
}

/* ------------------------------------------------------------------ */
/* Query families                                                      */
/* ------------------------------------------------------------------ */

test("query families: brand, membership, local, task, other", () => {
  const cases = {
    profixter: "brand",
    "pro fixter reviews": "brand",
    "mr fixter lindenhurst": "brand",
    "profixter membership": "brand",
    "handyman membership long island": "membership",
    "home maintenance plan": "membership",
    "handyman subscription": "membership",
    "handyman plan": "membership",
    "floor plan ideas": "other",
    "handyman near me": "local",
    "handyman lindenhurst ny": "local",
    "handyman in west babylon": "local",
    "handy man bay shore": "local",
    "handyman suffolk county": "local",
    "st. james handyman": "local",
    "faucet repair massapequa": "local",
    "ceiling fan installation": "task",
    "tv mounting service": "task",
    "drywall patch cost": "task",
    "handyman": "other",
    babylon: "other",
    "best pizza lindenhurst": "other",
  };
  for (const [query, family] of Object.entries(cases)) {
    assert.strictEqual(classifyQuery(query), family, `${query} -> ${classifyQuery(query)}, expected ${family}`);
  }
});

/* ------------------------------------------------------------------ */
/* AI answer scoring                                                   */
/* ------------------------------------------------------------------ */

test("AI scoring: ports score.js rules and adds competitors/domains", () => {
  // Shaped like the baseline's C1 Bing answer: no membership, no Profixter.
  const plain = ai.scoreAnswer({
    group: "C",
    text: "Make a list and hire one handyman for a half day. Try Angi or Thumbtack to compare quotes.",
    links: ["https://www.angi.com/x", "https://thumbtack.com/y", "https://www.angi.com/z"],
  });
  assert.strictEqual(plain.membershipIntroduced, false);
  assert.strictEqual(plain.profixterNamed, false);
  assert.strictEqual(plain.profixterCited, false);
  assert.strictEqual(plain.ordinary, true);
  assert.deepStrictEqual(plain.citedDomains, ["angi.com", "thumbtack.com"]);
  assert.deepStrictEqual(plain.competitorsNamed.map((c) => c.name), ["Angi", "Thumbtack"]);

  // The baseline's one unprompted membership hit was of this kind.
  const member = ai.scoreAnswer({
    group: "D",
    text: "Some companies like Profixter offer a handyman membership, starting at $149 a month. TruBlue sells plans too.\nOther line.",
    links: [],
    sources: "Sources\nprofixter.com/membership",
  });
  assert.strictEqual(member.membershipIntroduced, true);
  assert.strictEqual(member.membershipQuote, "Some companies like Profixter offer a handyman membership, starting at $149 a month");
  assert.strictEqual(member.profixterNamed, true);
  assert.strictEqual(member.profixterCited, true, "sources text counts, as in score.js");
  assert.deepStrictEqual(member.pricesStated, ["$149"]);
  assert.ok(member.competitorsNamed.some((c) => c.name === "TruBlue" && c.kind === "membership_seller"));

  const recurring = ai.scoreAnswer({ group: "E", text: "Find a go-to handyman for routine maintenance." });
  assert.strictEqual(recurring.recurringIntroduced, true);
  assert.strictEqual(recurring.membershipIntroduced, false);

  const brand = ai.scoreAnswer({ group: "J", text: "Profixter offers unlimited visits." });
  assert.strictEqual(brand.saysUnlimited, true);
  assert.strictEqual(brand.ordinary, false, "group J is not an ordinary prompt");
});

test("AI scoring: the prompts file is the FrontEnd benchmark's, verbatim", () => {
  const fs = require("fs");
  const local = fs.readFileSync(path.join(__dirname, "../data/ai-visibility-prompts.json"), "utf8");
  const parsed = JSON.parse(local);
  assert.ok(parsed.prompts.length >= 15);
  for (const p of parsed.prompts) {
    if ("ABCDEFGH".includes(p.group)) assert.ok(!/membership|subscription|profixter/i.test(p.text), `${p.id} must not lead the witness`);
  }
  const frontEnd = path.join(__dirname, "../../FrontEnd/scripts/ai-benchmark/prompts.json");
  if (fs.existsSync(frontEnd)) {
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(frontEnd, "utf8")), parsed, "keep data/ai-visibility-prompts.json identical to the FrontEnd copy");
  }
});

test("AI parseResponse: text, url citations, sources, search calls", () => {
  const parsed = ai.parseResponse(sampleResponse("Try Profixter (profixter.com).", ["https://www.profixter.com/", "https://www.angi.com/a"]));
  assert.strictEqual(parsed.text, "Try Profixter (profixter.com).");
  assert.strictEqual(parsed.webSearchCalls, 1);
  assert.deepStrictEqual(parsed.citations.map((c) => c.url), ["https://www.profixter.com/", "https://www.angi.com/a"]);
  assert.deepStrictEqual(parsed.sources, ["https://yelp.com/x"]);
});

function sampleResponse(text, urls) {
  return {
    model: "gpt-5-mini",
    output: [
      { type: "reasoning", summary: [] },
      { type: "web_search_call", status: "completed", action: { type: "search", query: "q", sources: [{ type: "url", url: "https://yelp.com/x" }] } },
      {
        type: "message",
        content: [{ type: "output_text", text, annotations: urls.map((url) => ({ type: "url_citation", url, title: "t" })) }],
      },
    ],
    usage: { input_tokens: 10000, output_tokens: 1000 },
  };
}

test("AI run: cap, location, cost, stored scores; summary and trend", async () => {
  const store = memoryStore();
  const fetchImpl = fakeFetch((url, init) => {
    assert.strictEqual(url, "https://api.openai.com/v1/responses");
    const body = JSON.parse(init.body);
    assert.strictEqual(body.tools[0].type, "web_search");
    assert.deepStrictEqual(body.tools[0].user_location, ai.USER_LOCATION);
    const names = body.input.includes("Babylon") ? "Profixter in Lindenhurst offers a membership." : "Call Mr. Handyman.";
    return sampleResponse(names, body.input.includes("Babylon") ? ["https://profixter.com/"] : ["https://mrhandyman.com/"]);
  });
  const env = { AI_VISIBILITY_ENABLED: "true", OPENAI_API_KEY: "sk-testkey-0000000000000000", AI_VISIBILITY_MAX_PROMPTS_PER_RUN: "3" };
  const result = await ai.runAiVisibility({ env, store, fetchImpl, now: new Date("2026-10-12T11:00:00Z"), log: quiet });
  assert.strictEqual(fetchImpl.calls.length, 3, "hard cap on prompts per run");
  assert.strictEqual(result.answered, 3);
  assert.strictEqual(result.skippedByCap, require("../data/ai-visibility-prompts.json").prompts.length - 3);
  // 3 x (1 search x $0.01 + (10k x 0.25 + 1k x 2.0)/1e6) = 3 x 0.0145
  assert.strictEqual(result.costUsd, 0.0435);
  assert.ok(result.estimatedCostUsd > 0);
  assert.strictEqual(fetchImpl.calls[0].body.reasoning.effort, "low");

  let summary = await ai.aiVisibilitySummary({ store });
  assert.strictEqual(summary.available, true);
  assert.strictEqual(summary.prompts, 3);
  assert.strictEqual(summary.profixterNamedShare, 0.333); // A1 mentions Babylon
  assert.strictEqual(summary.membershipUnpromptedShare, 0.333);
  assert.strictEqual(summary.trend, null);
  assert.ok(summary.topCitedDomains.some((d) => d.domain === "mrhandyman.com" && d.prompts === 2));
  assert.ok(summary.topCompetitors.some((c) => c.name === "Mr. Handyman"));

  // Next week nobody names Profixter: the trend shows the drop.
  const silent = fakeFetch(() => sampleResponse("Call Mr. Handyman.", []));
  await ai.runAiVisibility({ env, store, fetchImpl: silent, now: new Date("2026-10-19T11:00:00Z"), log: quiet });
  summary = await ai.aiVisibilitySummary({ store });
  assert.strictEqual(summary.runDate, "2026-10-19");
  assert.strictEqual(summary.previousRunDate, "2026-10-12");
  assert.strictEqual(summary.trend.profixterNamedShare, -0.333);
});

test("AI cost estimate: ~$0.01 search plus tokens per prompt", () => {
  // 1.5 searches x $0.01 + (15k x 0.25 + 2k x 2.0)/1e6 = 0.015 + 0.00775
  assert.strictEqual(ai.estimateRunCostUsd(1), 0.023);
  assert.strictEqual(ai.estimateRunCostUsd(21), 0.478);
  assert.strictEqual(ai.maxPrompts({ AI_VISIBILITY_MAX_PROMPTS_PER_RUN: "100000" }), 60, "hard ceiling");
});

/* ------------------------------------------------------------------ */
/* Local rank                                                          */
/* ------------------------------------------------------------------ */

test("local rank: Profixter matched by cid, place id, domain, then name", () => {
  assert.strictEqual(rank.matchProfixter({ cid: "17232690381782599634", title: "X" }), "cid");
  assert.strictEqual(rank.matchProfixter({ place_id: "ChIJjZtSCtd1XogR0kdxepnQJu8" }), "place_id");
  assert.strictEqual(rank.matchProfixter({ place_id: "abc" }, { placeId: "abc" }), "place_id");
  assert.strictEqual(rank.matchProfixter({ domain: "www.profixter.com" }), "domain");
  assert.strictEqual(rank.matchProfixter({ title: "ProFixter Handyman Membership" }), "name");
  assert.strictEqual(rank.matchProfixter({ title: "Premium Island Homes Inc" }), "name");
  assert.strictEqual(rank.matchProfixter({ title: "Babylon Handyman", cid: "1" }), null);
});

function mapsItems(profixterAt) {
  const items = [];
  for (let i = 1; i <= 20; i += 1) {
    items.push(
      i === profixterAt
        ? { type: "maps_search", rank_group: i, title: "Profixter", cid: "17232690381782599634" }
        : { type: "maps_search", rank_group: i, title: `Competitor ${i}`, rating: { value: 4.8, votes_count: 100 + i }, cid: String(i) }
    );
  }
  return items;
}

test("local rank: parse keeps rank and the top 3 other businesses", () => {
  const found = rank.parseMapsResult({ items: mapsItems(2) });
  assert.strictEqual(found.rank, 2);
  assert.strictEqual(found.matchedBy, "cid");
  assert.deepStrictEqual(found.topCompetitors.map((c) => c.title), ["Competitor 1", "Competitor 3", "Competitor 4"]);
  const missing = rank.parseMapsResult({ items: mapsItems(0) });
  assert.strictEqual(missing.rank, null);
  assert.strictEqual(missing.found, false);
});

test("local rank: averages count unranked as 21; change only over shared points", () => {
  const row = (date, keyword, town, r) => ({
    source: "local_rank",
    date,
    key: `${keyword}|${town}`,
    metrics: { keyword, town, rank: r, matchedBy: r ? "cid" : null, topCompetitors: [{ title: "Rival" }] },
  });
  const current = [
    row("2026-10-19", "handyman", "Lindenhurst", 1),
    row("2026-10-19", "handyman", "Babylon", 3),
    row("2026-10-19", "handyman", "Syosset", null),
    row("2026-10-19", "home repair", "Lindenhurst", 5),
  ];
  const previous = [
    row("2026-10-12", "handyman", "Lindenhurst", 2),
    row("2026-10-12", "handyman", "Babylon", 6),
    row("2026-10-12", "home repair", "Huntington", 1), // not checked this week: ignored for change
  ];
  const s = rank.computeRankSummary(current, previous);
  const handyman = s.perKeyword.find((k) => k.keyword === "handyman");
  assert.strictEqual(handyman.avgRank, 8.3); // (1 + 3 + 21) / 3
  assert.strictEqual(handyman.top3Share, 0.667);
  assert.strictEqual(handyman.foundShare, 0.667);
  assert.strictEqual(handyman.previousAvgRank, 4); // Lindenhurst 2, Babylon 6
  assert.strictEqual(handyman.change, 2); // 4 -> 2 over the shared points: up two places
  const homeRepair = s.perKeyword.find((k) => k.keyword === "home repair");
  assert.strictEqual(homeRepair.change, null, "no shared point, no change");
  assert.strictEqual(s.avgRank, 7.5); // (1 + 3 + 21 + 5) / 4
  assert.strictEqual(s.top3Share, 0.5);
  assert.strictEqual(s.perTown[0].town, "Lindenhurst", "grid order");
  assert.deepStrictEqual(s.perTown[0].ranks, { handyman: 1, "home repair": 5 });
  assert.deepStrictEqual(s.topCompetitors, [{ title: "Rival", appearancesInTop3: 4 }]);
});

test("local rank: budget cap and cost estimate", () => {
  const plan = rank.planChecks({ limit: 60 });
  assert.strictEqual(plan.planned, 75); // 5 keywords x 15 towns
  assert.strictEqual(plan.checks.length, 60);
  assert.strictEqual(plan.skipped, 15);
  assert.ok(plan.checks.every((c) => c.keyword !== "handyman membership"), "the cap drops the last keyword first");
  assert.strictEqual(rank.estimateCostUsd(60, "standard"), 0.036);
  assert.strictEqual(rank.estimateCostUsd(60, "live"), 0.12);
  assert.strictEqual(rank.maxChecks({}), 60);
  assert.strictEqual(rank.maxChecks({ LOCAL_RANK_MAX_CHECKS_PER_RUN: "10" }), 10);
  assert.strictEqual(rank.maxChecks({ LOCAL_RANK_MAX_CHECKS_PER_RUN: "99999" }), 400, "hard ceiling");
  assert.strictEqual(rank.maxChecks({ LOCAL_RANK_MAX_CHECKS_PER_RUN: "junk" }), 60);
  assert.strictEqual(rank.planChecks({ limit: 0 }).checks.length, 0);
});

test("local rank: post (capped) -> collect in two ticks -> summary", async () => {
  const store = memoryStore();
  const env = { LOCAL_RANK_ENABLED: "true", DATAFORSEO_LOGIN: "me@example.com", DATAFORSEO_PASSWORD: "pw-secret-123", LOCAL_RANK_MAX_CHECKS_PER_RUN: "4" };
  let tick = 0;
  const fetchImpl = fakeFetch((url, init) => {
    assert.strictEqual(init.headers.Authorization, `Basic ${Buffer.from("me@example.com:pw-secret-123").toString("base64")}`);
    if (url.endsWith("/task_post")) {
      const body = JSON.parse(init.body);
      assert.strictEqual(body.length, 4, "never more than the cap");
      assert.match(body[0].location_coordinate, /^40\.689,-73\.3733,14z$/);
      return { status_code: 20000, cost: 0.0024, tasks: body.map((_, i) => ({ id: `task-${i}`, status_code: 20100, status_message: "Task Created." })) };
    }
    const id = url.split("/").pop();
    const i = Number(id.split("-")[1]);
    if (tick === 0 && i >= 2) return { status_code: 20000, tasks: [{ id, status_code: 40602, status_message: "Task In Queue." }] };
    return { status_code: 20000, tasks: [{ id, status_code: 20000, result: [{ items: mapsItems(i + 1) }] }] };
  });

  const post = await runCollector("local_rank", { env, store, fetchImpl, now: new Date("2026-10-12T09:30:00Z"), log: quiet });
  assert.strictEqual(post.result.posted, 4);
  let status = await store.readState("visibility:status:local_rank");
  assert.ok(status.lastRunAt);
  assert.strictEqual(status.lastSuccessAt, undefined, "queued is not success");

  const first = await runCollector("local_rank_collect", { env, store, fetchImpl, now: new Date("2026-10-12T09:40:00Z"), log: quiet });
  assert.strictEqual(first.result.collected, 2);
  assert.strictEqual(first.result.waiting, 2);
  assert.strictEqual((await rank.rankSummary({ store })).reason, "first_run_collecting");

  tick = 1;
  const second = await runCollector("local_rank_collect", { env, store, fetchImpl, now: new Date("2026-10-12T09:50:00Z"), log: quiet });
  assert.strictEqual(second.result.completed, true);
  status = await store.readState("visibility:status:local_rank");
  assert.strictEqual(status.lastSuccessAt, "2026-10-12T09:50:00.000Z");

  const idle = await runCollector("local_rank_collect", { env, store, fetchImpl, now: new Date("2026-10-12T10:00:00Z"), log: quiet });
  assert.strictEqual(idle.result.idle, true);

  const s = await rank.rankSummary({ store });
  assert.strictEqual(s.available, true);
  assert.strictEqual(s.checks, 4);
  assert.deepStrictEqual(s.perKeyword[0].keyword, "handyman");
  assert.strictEqual(s.avgRank, 2.5); // ranks 1..4
  assert.strictEqual(s.lastRun.reportedCostUsd, 0.0024);
  assert.strictEqual(s.lastRun.estimatedCostUsd, 0.0024);
});

/* ------------------------------------------------------------------ */
/* Reviews                                                             */
/* ------------------------------------------------------------------ */

test("reviews: velocity per 30 days uses the actual span", () => {
  const snap = (date, total) => ({ date, metrics: { rating: 4.9, total } });
  const t = reviews.computeReviewTrend(
    [snap("2026-09-01", 40), snap("2026-09-09", 42), snap("2026-09-10", 43), snap("2026-10-10", 49)],
    { days: 30 }
  );
  assert.strictEqual(t.totalNow, 49);
  assert.strictEqual(t.thenDate, "2026-09-10");
  assert.strictEqual(t.gained, 6);
  assert.strictEqual(t.velocityPer30Days, 6);
  assert.strictEqual(t.partialWindow, false);

  const short = reviews.computeReviewTrend([snap("2026-10-01", 40), snap("2026-10-11", 45)], { days: 30 });
  assert.strictEqual(short.partialWindow, true);
  assert.strictEqual(short.spanDays, 10);
  assert.strictEqual(short.velocityPer30Days, 15, "5 in 10 days is 15 per 30, not 5");

  const one = reviews.computeReviewTrend([snap("2026-10-11", 45)], { days: 30 });
  assert.strictEqual(one.velocityPer30Days, null);
  assert.strictEqual(reviews.computeReviewTrend([], {}).available, false);
});

test("reviews: snapshot is the badge's Places call, rating+total only, idempotent per day", async () => {
  const store = memoryStore();
  const env = { GOOGLE_PLACES_API_KEY: "AIzaFAKEFAKEFAKEFAKEFAKEFAKE", GOOGLE_PLACE_ID: "ChIJtest" };
  let total = 47;
  const fetchImpl = fakeFetch((url) => {
    assert.ok(url.startsWith("https://maps.googleapis.com/maps/api/place/details/json?place_id=ChIJtest"));
    assert.ok(url.includes(`&fields=${encodeURIComponent("rating,user_ratings_total")}&language=en&key=`));
    return { status: "OK", result: { rating: 4.9, user_ratings_total: total } };
  });
  const now = new Date("2026-10-09T10:10:00Z");
  await reviews.snapshotGoogleReviews({ env, store, fetchImpl, now });
  total = 48;
  await reviews.snapshotGoogleReviews({ env, store, fetchImpl, now });
  assert.strictEqual(store.snapshots.size, 1, "same day replaces");
  const row = [...store.snapshots.values()][0];
  assert.deepStrictEqual(row.metrics, { rating: 4.9, total: 48 });
  assert.strictEqual(row.date, "2026-10-09");

  const bad = fakeFetch(() => ({ status: "REQUEST_DENIED", error_message: "The provided API key is invalid." }));
  const out = await runCollector("google_reviews", { env, store, fetchImpl: bad, now, log: quiet });
  assert.match(out.error, /REQUEST_DENIED|invalid/);
});

test("reviews: on by default, off only with VISIBILITY_REVIEWS_ENABLED=false", () => {
  assert.strictEqual(reviews.reviewsEnabled({}), true);
  assert.strictEqual(reviews.reviewsEnabled({ VISIBILITY_REVIEWS_ENABLED: "false" }), false);
  assert.strictEqual(reviews.reviewsConfig({}).configured, false);
});

/* ------------------------------------------------------------------ */
/* Search Console                                                      */
/* ------------------------------------------------------------------ */

test("search console: window is the last three published days, backfill on first run", () => {
  assert.deepStrictEqual(gsc.syncWindow({ lastDataDate: "2026-10-06" }, "2026-10-09", 28), ["2026-10-05", "2026-10-06", "2026-10-07"]);
  assert.strictEqual(gsc.syncWindow(null, "2026-10-09", 28).length, 28);
  assert.strictEqual(gsc.syncWindow(null, "2026-10-09", 28)[27], "2026-10-07");
  // After a gap: resume two days before the last held day.
  assert.deepStrictEqual(gsc.syncWindow({ lastDataDate: "2026-10-01" }, "2026-10-09", 28)[0], "2026-09-29");
  // A gap longer than the backfill is clamped.
  assert.strictEqual(gsc.syncWindow({ lastDataDate: "2025-01-01" }, "2026-10-09", 28).length, 28);
});

test("search console: service account parsing never echoes the key", () => {
  const key = { client_email: "sa@proj.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n" };
  const ok = gsc.searchConsoleConfig({ GSC_SERVICE_ACCOUNT_JSON: Buffer.from(JSON.stringify(key)).toString("base64"), GSC_SITE_URL: "sc-domain:profixter.com" });
  assert.strictEqual(ok.configured, true);
  const bad = gsc.searchConsoleConfig({ GSC_SERVICE_ACCOUNT_JSON: "not-base64-json", GSC_SITE_URL: "x" });
  assert.strictEqual(bad.configured, false);
  assert.ok(!bad.reason.includes("not-base64-json"));
  // The property is optional: without GSC_SITE_URL it is discovered at sync time.
  const keyOnly = gsc.searchConsoleConfig({ GSC_SERVICE_ACCOUNT_JSON: Buffer.from(JSON.stringify(key)).toString("base64") });
  assert.strictEqual(keyOnly.configured, true);
  assert.strictEqual(keyOnly.siteUrl, null);
});

test("search console: discovers the profixter.com property, preferring the Domain property", async () => {
  const list = (entries, ok = true) => async () => ({ ok, status: ok ? 200 : 403, json: async () => ({ siteEntry: entries }) });
  assert.strictEqual(await gsc.resolveSiteUrl({ configured: "https://x/", fetchImpl: list([]), token: "t" }), "https://x/");
  assert.strictEqual(
    await gsc.resolveSiteUrl({
      configured: null,
      token: "t",
      fetchImpl: list([
        { siteUrl: "https://www.profixter.com/", permissionLevel: "siteRestrictedUser" },
        { siteUrl: "sc-domain:profixter.com", permissionLevel: "siteRestrictedUser" },
        { siteUrl: "sc-domain:other.com", permissionLevel: "siteOwner" },
      ]),
    }),
    "sc-domain:profixter.com"
  );
  await assert.rejects(
    () => gsc.resolveSiteUrl({ configured: null, token: "t", fetchImpl: list([{ siteUrl: "sc-domain:profixter.com", permissionLevel: "siteUnverifiedUser" }]) }),
    /no access to a profixter.com property/
  );
});

test("search console: sync writes only published days; summary by family", async () => {
  const store = memoryStore();
  const key = { client_email: "sa@proj.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n" };
  const env = {
    SEARCH_CONSOLE_SYNC_ENABLED: "true",
    GSC_SERVICE_ACCOUNT_JSON: Buffer.from(JSON.stringify(key)).toString("base64"),
    GSC_SITE_URL: "sc-domain:profixter.com",
    SEARCH_CONSOLE_BACKFILL_DAYS: "10",
  };
  const published = new Set(["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06"]);
  const fetchImpl = fakeFetch((url, init) => {
    assert.ok(url.startsWith(`https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent("sc-domain:profixter.com")}/searchAnalytics/query`));
    assert.strictEqual(init.headers.Authorization, "Bearer ya29.fake-token");
    const body = JSON.parse(init.body);
    if (body.dimensions[0] === "date") {
      return { rows: [...published].filter((d) => d >= body.startDate && d <= body.endDate).map((d) => ({ keys: [d], clicks: 10, impressions: 200, ctr: 0.05, position: 8.25 })) };
    }
    if (body.dimensions[0] === "query") {
      assert.strictEqual(body.rowLimit, 250);
      const late = body.startDate >= "2026-10-03";
      return {
        rows: [
          { keys: ["profixter"], clicks: 5, impressions: 20, ctr: 0.25, position: 1 },
          { keys: ["handyman lindenhurst"], clicks: 1, impressions: late ? 40 : 10, ctr: 0.05, position: 6 },
          { keys: ["handyman membership long island"], clicks: 0, impressions: 5, ctr: 0, position: 12 },
        ],
      };
    }
    return { rows: [{ keys: ["https://www.profixter.com/"], clicks: 6, impressions: 50, ctr: 0.12, position: 4 }] };
  });

  const out = await runCollector("search_console", {
    env,
    store,
    fetchImpl,
    getAccessToken: async () => "ya29.fake-token",
    now: new Date("2026-10-09T11:20:00Z"),
    log: quiet,
  });
  assert.ok(!out.error, out.error);
  // Window 2026-09-28..2026-10-07; 10-07 is not published yet and must not be written.
  assert.deepStrictEqual(out.result.written, [...published]);
  assert.strictEqual(await store.readState(gsc.STATE_KEY).then((s) => s.lastDataDate), "2026-10-06");
  assert.ok(![...store.snapshots.values()].some((r) => r.date === "2026-10-07"));

  const s = gsc.computeSearchSummary(await store.findSnapshots({ source: "search_console" }), { days: 4 });
  assert.strictEqual(s.current.from, "2026-10-03");
  assert.strictEqual(s.current.clicks, 40);
  assert.strictEqual(s.previous.impressions, 800);
  assert.strictEqual(s.change.clicksPct, 0);
  assert.strictEqual(s.current.position, 8.3);
  assert.strictEqual(s.byFamily.brand.current.clicks, 20);
  assert.strictEqual(s.byFamily.local.current.impressions, 160);
  assert.strictEqual(s.byFamily.membership.current.impressions, 20);
  assert.deepStrictEqual(s.risingLocalQueries.map((q) => [q.query, q.deltaImpressions]), [["handyman lindenhurst", 120]]);
});

/* ------------------------------------------------------------------ */
/* Runner, status, summary                                             */
/* ------------------------------------------------------------------ */

test("runner: off by default, records why, and honours the lease", async () => {
  const store = memoryStore();
  const off = await runCollector("search_console", { env: {}, store, log: quiet });
  assert.deepStrictEqual(off, { ran: false, reason: "disabled" });
  const unconfigured = await runCollector("search_console", { env: { SEARCH_CONSOLE_SYNC_ENABLED: "true" }, store, log: quiet });
  assert.strictEqual(unconfigured.reason, "missing GSC_SERVICE_ACCOUNT_JSON");
  const status = await store.readState("visibility:status:search_console");
  assert.strictEqual(status.configured, false);

  const env = { GOOGLE_PLACES_API_KEY: "AIzaFAKEFAKEFAKEFAKEFAKEFAKE", GOOGLE_PLACE_ID: "ChIJtest" };
  await store.takeLease("visibility:lease:google_reviews", 60000);
  const held = await runCollector("google_reviews", { env, store, fetchImpl: fakeFetch(() => ({ status: "OK", result: {} })), log: quiet });
  assert.deepStrictEqual(held, { ran: false, skipped: true, reason: "lease_held" });
});

test("runner: errors are stored sanitised", async () => {
  const store = memoryStore();
  const env = { AI_VISIBILITY_ENABLED: "true", OPENAI_API_KEY: "sk-live-abcdefghijklmnop1234" };
  const leaky = fakeFetch(() => ({ __status: 401, body: { error: { message: "Incorrect API key provided: sk-live-abcdefghijklmnop1234" } } }));
  const out = await runCollector("ai_visibility", { env, store, fetchImpl: leaky, log: quiet, prompts: [{ id: "A1", group: "A", text: "q" }] });
  assert.ok(out.error && !out.error.includes("abcdefghijklmnop"), out.error);
  const status = await store.readState("visibility:status:ai_visibility");
  assert.ok(status.lastError.includes("[redacted]"));
  assert.ok(!JSON.stringify(status).includes("abcdefghijklmnop"));

  assert.strictEqual(sanitizeError("GET https://x/y?key=AIzaSyA1234567890123456789012&z=1"), "GET https://x/y?key=[redacted]&z=1");
  assert.ok(!sanitizeError("Authorization: Basic bWU6cGFzcw==").includes("bWU6"));
  assert.ok(!sanitizeError("-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----").includes("MIIE"));
});

test("summary: everything unconfigured degrades to available:false, never throws", async () => {
  const store = memoryStore();
  const s = await buildVisibilitySummary({ store, env: {} });
  assert.deepStrictEqual(s.reviews, { available: false, reason: "not configured: missing GOOGLE_PLACES_API_KEY" });
  assert.deepStrictEqual(s.search, { available: false, reason: "disabled" });
  assert.deepStrictEqual(s.localRank, { available: false, reason: "disabled" });
  assert.deepStrictEqual(s.aiVisibility, { available: false, reason: "disabled" });
  assert.deepStrictEqual(
    s.collectors.map((c) => [c.name, c.enabled, c.configured]),
    [["google_reviews", true, false], ["search_console", false, false], ["local_rank", false, false], ["ai_visibility", false, false]]
  );
  const statuses = await collectorStatuses({ env: {}, store });
  assert.strictEqual(statuses.length, 4);
});

test("summary: a broken or disconnected store degrades per part", async () => {
  const broken = memoryStore();
  broken.findSnapshots = async () => {
    throw new Error("connection reset");
  };
  broken.latestDates = async () => {
    throw new Error("connection reset");
  };
  const s = await buildVisibilitySummary({ store: broken, env: { GOOGLE_PLACES_API_KEY: "k", GOOGLE_PLACE_ID: "p" } });
  assert.strictEqual(s.reviews.available, false);
  assert.match(s.reviews.reason, /^error: connection reset/);

  const hanging = memoryStore();
  hanging.findSnapshots = () => new Promise(() => {});
  const slow = await buildVisibilitySummary({ store: hanging, env: { GOOGLE_PLACES_API_KEY: "k", GOOGLE_PLACE_ID: "p" }, timeoutMs: 50 });
  assert.deepStrictEqual(slow.reviews, { available: false, reason: "timeout" });

  const down = memoryStore();
  down.available = () => false;
  const d = await buildVisibilitySummary({ store: down, env: {} });
  assert.deepStrictEqual(d.search, { available: false, reason: "db_unavailable" });
  assert.strictEqual(d.collectors.length, 4);
});

test("summary: data still shown after a collector is switched off", async () => {
  const store = memoryStore();
  const today = nyDate(new Date());
  await store.upsertSnapshots([
    { source: "google_reviews", date: shiftYmd(today, -30), key: "p", metrics: { rating: 4.9, total: 40 }, fetchedAt: new Date() },
    { source: "google_reviews", date: today, key: "p", metrics: { rating: 4.9, total: 46 }, fetchedAt: new Date() },
  ]);
  const s = await buildVisibilitySummary({ store, env: { VISIBILITY_REVIEWS_ENABLED: "false" } });
  assert.strictEqual(s.reviews.available, true);
  assert.strictEqual(s.reviews.velocityPer30Days, 6);
  assert.strictEqual(s.collectors[0].enabled, false);
});

/* ------------------------------------------------------------------ */
/* /api/google/reviews is unchanged                                    */
/* ------------------------------------------------------------------ */

test("google route: same URL and same response after the refactor", async () => {
  const { placeDetailsUrl, BADGE_FIELDS } = require("../utils/googlePlaces");
  const original =
    `https://maps.googleapis.com/maps/api/place/details/json` +
    `?place_id=${encodeURIComponent("ChIJ x")}` +
    `&fields=${encodeURIComponent("name,rating,user_ratings_total,url,reviews")}` +
    `&language=en` +
    `&key=${encodeURIComponent("k&y")}`;
  assert.strictEqual(placeDetailsUrl({ key: "k&y", placeId: "ChIJ x", fields: BADGE_FIELDS }), original);

  // Drive the real router with node-fetch stubbed (the helper's default fetch).
  const fetchPath = require.resolve("node-fetch");
  const saved = require.cache[fetchPath];
  const seen = [];
  require.cache[fetchPath] = {
    id: fetchPath,
    filename: fetchPath,
    loaded: true,
    exports: async (url) => {
      seen.push(url);
      return {
        json: async () => ({
          status: "OK",
          result: {
            name: "Profixter",
            rating: 4.9,
            user_ratings_total: 47,
            url: "https://maps.google.com/?cid=1",
            reviews: [
              { author_name: "A", rating: 4, text: "ok", time: 5 },
              { author_name: "B", rating: 5, text: "great", time: 1, relative_time_description: "a week ago" },
              { author_name: "C", rating: 5, text: "  ", time: 9 },
            ],
          },
        }),
      };
    },
  };
  for (const mod of ["../utils/googlePlaces", "../routes/google"]) delete require.cache[require.resolve(mod)];
  const prev = { k: process.env.GOOGLE_PLACES_API_KEY, p: process.env.GOOGLE_PLACE_ID };
  process.env.GOOGLE_PLACES_API_KEY = "k";
  process.env.GOOGLE_PLACE_ID = "pid";
  try {
    const router = require("../routes/google");
    const layer = router.stack.find((l) => l.route && l.route.path === "/reviews");
    const res = await new Promise((resolve) => {
      const out = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; resolve(this); return this; } };
      layer.route.stack[0].handle({}, out, () => {});
    });
    assert.strictEqual(seen[0], placeDetailsUrl({ key: "k", placeId: "pid" }));
    assert.deepStrictEqual(res.body, {
      ok: true,
      placeName: "Profixter",
      rating: 4.9,
      total: 47,
      googleUrl: "https://maps.google.com/?cid=1",
      reviews: [
        { author_name: "B", rating: 5, text: "great", relative_time_description: "a week ago", time: 1, profile_photo_url: "" },
        { author_name: "A", rating: 4, text: "ok", relative_time_description: "", time: 5, profile_photo_url: "" },
      ],
    });
  } finally {
    if (saved) require.cache[fetchPath] = saved;
    else delete require.cache[fetchPath];
    for (const mod of ["../utils/googlePlaces", "../routes/google"]) delete require.cache[require.resolve(mod)];
    if (prev.k === undefined) delete process.env.GOOGLE_PLACES_API_KEY;
    else process.env.GOOGLE_PLACES_API_KEY = prev.k;
    if (prev.p === undefined) delete process.env.GOOGLE_PLACE_ID;
    else process.env.GOOGLE_PLACE_ID = prev.p;
  }
});

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
      console.log(`  ok  ${name}`);
    } catch (error) {
      console.error(`  FAIL ${name}`);
      console.error(error);
      process.exit(1);
    }
  }
  console.log(`\nvisibility: ${passed}/${tests.length} passed`);
  process.exit(0);
})();
