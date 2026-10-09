/**
 * Google Maps local-pack rank, from the towns Profixter actually serves.
 *
 * WHY A GRID. "Where do we rank for handyman?" has no single answer: Google
 * ranks map results by distance from the searcher first. So each check is a
 * keyword searched from one town centre (data/long-island-towns.json,
 * rankGrid), and the summary reports the average across towns, the share of
 * towns where Profixter is in the top 3 (the visible local pack), and a
 * per-town table. Coordinates are the town's main-ZIP Census internal point
 * unless the data file says otherwise.
 *
 * SOURCE: DataForSEO's Google Maps SERP API, STANDARD QUEUE. A run POSTs every
 * check as a task (task_post), stores the task ids in AnalyticsState, and a
 * light collector (every 10 minutes, a no-op when nothing is pending) fetches
 * each finished task by id (task_get/advanced). Chosen over the live endpoint
 * because it is a third of the price AND restart-safe: a deploy mid-run loses
 * nothing, since the ids are in Mongo and results stay retrievable for days.
 * Tasks unfinished after PENDING_MAX_HOURS are given up and reported.
 *
 * MATCHING PROFIXTER in a result list, strongest evidence first: the Maps CID
 * 17232690381782599634, the Place ID ChIJjZtSCtd1XogR0kdxepnQJu8 (or
 * GOOGLE_PLACE_ID), the profixter.com domain, then the business name
 * ("Profixter", "Pro Fixter", "Premium Island Homes"). `matchedBy` is stored
 * so a name-only match can be told apart: a separate "Premium Island" listing
 * shares the address on other directories.
 *
 * RANK is rank_group among map results, checked to depth 20; not found is
 * recorded as null and AVERAGED AS 21 ("21+"), so dropping out of the list
 * counts as worse than position 20 instead of vanishing from the average.
 *
 * BUDGET. A run never posts more than LOCAL_RANK_MAX_CHECKS_PER_RUN tasks
 * (default 60, hard ceiling 400). Checks are ordered keyword by keyword in
 * priority order, so the cap drops the least important keyword in the
 * farthest towns first. The estimated cost is logged and stored with the run,
 * next to the cost DataForSEO itself reports.
 *   Default: 5 keywords x 15 towns = 75 checks, capped to 60
 *   => 60 x $0.0006 = $0.036 per weekly run, about $0.16/month.
 *
 * OWNER SETUP: create a DataForSEO account (https://app.dataforseo.com/),
 * add funds (minimum top-up applies), copy the API login and API password
 * from the dashboard's API Access page into DATAFORSEO_LOGIN /
 * DATAFORSEO_PASSWORD, then set LOCAL_RANK_ENABLED=true.
 */
const TOWN_DATA = require("../../data/long-island-towns.json");
const { nyDate, round, fetchJson, defaultFetch } = require("./common");
const { getDefaultStore } = require("./store");

const SOURCE = "local_rank";
const API = "https://api.dataforseo.com/v3/serp/google/maps";

/*
 * DataForSEO list prices for the Google Maps SERP API, per task (one keyword,
 * one location, up to 100 results), checked October 2026:
 * https://dataforseo.com/apis/serp-api/google-maps-serp-api  (Pricing tab)
 * Standard queue ~$0.0006, live ~$0.002. Re-check before raising the cap;
 * every run also records the cost DataForSEO reports for the POST.
 */
const COST_PER_TASK_USD = { standard: 0.0006, live: 0.002 };

const DEFAULT_KEYWORDS = ["handyman", "handyman near me", "handyman services", "home repair", "handyman membership"];
const DEPTH = 20;
const UNRANKED = 21;
const ZOOM = "14z";
const DEFAULT_MAX_CHECKS = 60;
const HARD_MAX_CHECKS = 400;
const POST_BATCH = 100; // DataForSEO accepts up to 100 tasks per POST
const PENDING_MAX_HOURS = 26;
const PENDING_KEY = "visibility:local_rank:pending";
const LAST_RUN_KEY = "visibility:local_rank:last_run";

const PROFIXTER = {
  cid: "17232690381782599634",
  placeId: "ChIJjZtSCtd1XogR0kdxepnQJu8",
  domain: "profixter.com",
  name: /\bpro\s?-?fixter\b|\bpremium island homes\b/i,
};

function localRankEnabled(env = process.env) {
  return String(env.LOCAL_RANK_ENABLED || "").toLowerCase() === "true";
}

function localRankConfig(env = process.env) {
  const login = env.DATAFORSEO_LOGIN || "";
  const password = env.DATAFORSEO_PASSWORD || "";
  if (!login || !password) {
    return { configured: false, reason: !login ? "missing DATAFORSEO_LOGIN" : "missing DATAFORSEO_PASSWORD" };
  }
  const auth = `Basic ${Buffer.from(`${login}:${password}`).toString("base64")}`;
  return { configured: true, auth, secrets: [password, auth.slice(6)] };
}

function maxChecks(env = process.env) {
  const n = Number(env.LOCAL_RANK_MAX_CHECKS_PER_RUN);
  const value = Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_MAX_CHECKS;
  return Math.min(value, HARD_MAX_CHECKS);
}

function keywords(env = process.env) {
  const custom = String(env.LOCAL_RANK_KEYWORDS || "")
    .split(",")
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
  return custom.length ? [...new Set(custom)] : DEFAULT_KEYWORDS;
}

const pointKey = (keyword, lat, lng) => `${keyword}|${lat},${lng}`;

/**
 * Pure: the checks for one run, capped. Keyword-major order means the cap
 * removes whole tail keywords town by town, farthest towns first.
 */
function planChecks({ keywordList = DEFAULT_KEYWORDS, grid = TOWN_DATA.rankGrid, limit = DEFAULT_MAX_CHECKS } = {}) {
  const all = [];
  for (const keyword of keywordList) {
    for (const town of grid) {
      all.push({ keyword, town: town.name, lat: town.lat, lng: town.lng, key: pointKey(keyword, town.lat, town.lng) });
    }
  }
  const checks = all.slice(0, Math.max(0, limit));
  return { checks, skipped: all.length - checks.length, planned: all.length };
}

function estimateCostUsd(checks, mode = "standard") {
  return round(checks * COST_PER_TASK_USD[mode], 4);
}

/** Pure: is this Maps result Profixter, and by what evidence. */
function matchProfixter(item, { placeId } = {}) {
  if (!item) return null;
  if (item.cid && String(item.cid) === PROFIXTER.cid) return "cid";
  const pid = String(item.place_id || "");
  if (pid && (pid === PROFIXTER.placeId || (placeId && pid === placeId))) return "place_id";
  const domain = String(item.domain || item.url || "").toLowerCase();
  if (domain.includes(PROFIXTER.domain)) return "domain";
  if (PROFIXTER.name.test(String(item.title || ""))) return "name";
  return null;
}

/** Pure: one task result -> the snapshot metrics for that point. */
function parseMapsResult(result, { placeId } = {}) {
  const items = (result?.items || [])
    .filter((i) => i && (i.type === "maps_search" || i.type === undefined))
    .sort((a, b) => Number(a.rank_group || 0) - Number(b.rank_group || 0));
  let rank = null;
  let matchedBy = null;
  const competitors = [];
  for (const item of items) {
    const by = matchProfixter(item, { placeId });
    if (by && rank === null) {
      rank = Number(item.rank_group) || null;
      matchedBy = by;
      continue;
    }
    if (!by && competitors.length < 3) {
      competitors.push({
        rank: Number(item.rank_group) || null,
        title: String(item.title || "").slice(0, 120),
        rating: item.rating?.value ?? null,
        reviews: item.rating?.votes_count ?? null,
        placeId: item.place_id || null,
        cid: item.cid ? String(item.cid) : null,
        domain: item.domain || null,
      });
    }
  }
  if (rank !== null && rank > DEPTH) rank = null;
  return { rank, found: rank !== null, matchedBy, topCompetitors: competitors, resultsCount: items.length };
}

/* ------------------------------------------------------------------ */
/* Run: post tasks                                                     */
/* ------------------------------------------------------------------ */

/**
 * Post this week's checks. Returns { posted, estimatedCostUsd, ... }.
 * `completed: false` tells the runner the data has not landed yet; the
 * collect step marks success when it finalises the run.
 */
async function postLocalRankRun({ env = process.env, now = new Date(), store = getDefaultStore(), fetchImpl, log = console } = {}) {
  const config = localRankConfig(env);
  if (!config.configured) throw new Error(config.reason);
  const doFetch = fetchImpl || defaultFetch();

  const pending = await store.readState(PENDING_KEY);
  if (pending && pending.tasks?.some((t) => !t.done)) {
    const ageHours = (now.getTime() - new Date(pending.postedAt).getTime()) / 3600000;
    if (ageHours < PENDING_MAX_HOURS) {
      return { completed: false, posted: 0, reason: "previous run still collecting", pendingRunId: pending.runId };
    }
    await finalizeRun({ store, pending, now, log, expired: true });
  }

  const limit = maxChecks(env);
  const { checks, skipped, planned } = planChecks({ keywordList: keywords(env), limit });
  const estimatedCostUsd = estimateCostUsd(checks.length, "standard");
  log.log?.(
    JSON.stringify({ event: "local_rank_run_planned", planned, checks: checks.length, skippedByCap: skipped, cap: limit, estimatedCostUsd })
  );
  if (!checks.length) return { completed: true, posted: 0, skippedByCap: skipped, estimatedCostUsd: 0 };

  const runDate = nyDate(now);
  const runId = `${runDate}-${now.getTime().toString(36)}`;
  const tasks = [];
  let reportedCostUsd = 0;
  for (let i = 0; i < checks.length; i += POST_BATCH) {
    const batch = checks.slice(i, i + POST_BATCH);
    const json = await fetchJson(doFetch, `${API}/task_post`, {
      method: "POST",
      headers: { Authorization: config.auth, "Content-Type": "application/json" },
      body: batch.map((c, j) => ({
        keyword: c.keyword,
        location_coordinate: `${c.lat},${c.lng},${ZOOM}`,
        language_code: "en",
        device: "desktop",
        depth: DEPTH,
        tag: `${runId}#${i + j}`,
      })),
    });
    if (json.status_code !== 20000) throw new Error(`DataForSEO task_post ${json.status_code}: ${json.status_message}`);
    reportedCostUsd += Number(json.cost || 0);
    (json.tasks || []).forEach((task, j) => {
      const check = batch[j];
      if (!check) return;
      const created = task.status_code === 20100 && task.id;
      tasks.push({ ...check, id: created ? task.id : null, done: !created, error: created ? null : `${task.status_code}: ${task.status_message}`.slice(0, 120) });
    });
  }

  await store.writeState(PENDING_KEY, {
    runId,
    runDate,
    postedAt: now.toISOString(),
    mode: "standard",
    estimatedCostUsd,
    reportedCostUsd: round(reportedCostUsd, 4),
    skippedByCap: skipped,
    tasks,
  });
  const posted = tasks.filter((t) => t.id).length;
  log.log?.(JSON.stringify({ event: "local_rank_run_posted", runId, posted, failed: tasks.length - posted, estimatedCostUsd, reportedCostUsd: round(reportedCostUsd, 4) }));
  return { completed: false, runId, posted, failed: tasks.length - posted, skippedByCap: skipped, estimatedCostUsd, reportedCostUsd: round(reportedCostUsd, 4) };
}

/* ------------------------------------------------------------------ */
/* Run: collect results                                                */
/* ------------------------------------------------------------------ */

const IN_PROGRESS = new Set([40601, 40602]); // "Task Handed", "Task In Queue"

async function finalizeRun({ store, pending, now, log, expired = false }) {
  const tasks = pending.tasks || [];
  const summary = {
    runId: pending.runId,
    runDate: pending.runDate,
    postedAt: pending.postedAt,
    finishedAt: now.toISOString(),
    checks: tasks.length,
    collected: tasks.filter((t) => t.done && !t.error).length,
    failed: tasks.filter((t) => t.error).length,
    expired: expired ? tasks.filter((t) => !t.done).length : 0,
    estimatedCostUsd: pending.estimatedCostUsd,
    reportedCostUsd: pending.reportedCostUsd,
    skippedByCap: pending.skippedByCap || 0,
  };
  await store.writeState(LAST_RUN_KEY, summary);
  await store.writeState(PENDING_KEY, null);
  log.log?.(JSON.stringify({ event: "local_rank_run_finished", ...summary }));
  return summary;
}

/**
 * Fetch finished tasks of the pending run. Cheap and quiet when nothing is
 * pending. Returns { idle: true } then; { completed: true, run } when the run
 * was finalised; otherwise { completed: false, collected, waiting }.
 */
async function collectLocalRankResults({ env = process.env, now = new Date(), store = getDefaultStore(), fetchImpl, log = console } = {}) {
  const pending = await store.readState(PENDING_KEY);
  if (!pending || !pending.tasks) return { idle: true };
  const config = localRankConfig(env);
  if (!config.configured) throw new Error(config.reason);
  const doFetch = fetchImpl || defaultFetch();
  const placeId = env.GOOGLE_PLACE_ID || null;

  let collected = 0;
  let failure = null;
  const rows = [];
  for (const task of pending.tasks) {
    if (task.done) continue;
    let json;
    try {
      json = await fetchJson(doFetch, `${API}/task_get/advanced/${encodeURIComponent(task.id)}`, {
        headers: { Authorization: config.auth },
      });
    } catch (error) {
      // Keep what this pass already collected; the rest is retried next tick.
      failure = error;
      break;
    }
    const t = json.tasks?.[0];
    if (!t || IN_PROGRESS.has(t.status_code)) continue;
    task.done = true;
    if (t.status_code !== 20000) {
      task.error = `${t.status_code}: ${t.status_message}`.slice(0, 120);
      continue;
    }
    const parsed = parseMapsResult(t.result?.[0], { placeId });
    rows.push({
      source: SOURCE,
      date: pending.runDate,
      key: task.key,
      metrics: { keyword: task.keyword, town: task.town, lat: task.lat, lng: task.lng, depth: DEPTH, runId: pending.runId, ...parsed },
      fetchedAt: now,
    });
    collected += 1;
  }
  if (rows.length) await store.upsertSnapshots(rows);
  if (failure) {
    await store.writeState(PENDING_KEY, pending);
    throw failure;
  }

  const waiting = pending.tasks.filter((t) => !t.done).length;
  const ageHours = (now.getTime() - new Date(pending.postedAt).getTime()) / 3600000;
  if (!waiting || ageHours >= PENDING_MAX_HOURS) {
    const run = await finalizeRun({ store, pending, now, log, expired: waiting > 0 });
    return { completed: true, collected, run };
  }
  await store.writeState(PENDING_KEY, pending);
  return { completed: false, collected, waiting };
}

/* ------------------------------------------------------------------ */
/* Summary                                                             */
/* ------------------------------------------------------------------ */

const effectiveRank = (rank) => (rank === null || rank === undefined ? UNRANKED : Number(rank));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * Pure: the rank summary for one run against the previous one.
 * `change` is previous avg minus current avg over the points both runs
 * checked, so a positive number means Profixter moved UP, and adding or
 * dropping a town cannot fake a movement.
 */
function computeRankSummary(current, previous = []) {
  if (!current.length) return { available: false, reason: "no_data" };
  const prevByKey = new Map(previous.map((r) => [r.key, r.metrics]));
  const keywordsSeen = [...new Set(current.map((r) => r.metrics.keyword))];
  const gridOrder = TOWN_DATA.rankGrid.map((t) => t.name);

  const perKeyword = keywordsSeen.map((keyword) => {
    const rows = current.filter((r) => r.metrics.keyword === keyword);
    const ranks = rows.map((r) => effectiveRank(r.metrics.rank));
    const paired = rows.filter((r) => prevByKey.has(r.key));
    const prevAvg = mean(paired.map((r) => effectiveRank(prevByKey.get(r.key).rank)));
    const curPairedAvg = mean(paired.map((r) => effectiveRank(r.metrics.rank)));
    return {
      keyword,
      points: rows.length,
      avgRank: round(mean(ranks), 1),
      top3Share: round(rows.filter((r) => r.metrics.rank !== null && r.metrics.rank <= 3).length / rows.length, 3),
      foundShare: round(rows.filter((r) => r.metrics.rank !== null).length / rows.length, 3),
      previousAvgRank: paired.length ? round(prevAvg, 1) : null,
      change: paired.length ? round(prevAvg - curPairedAvg, 1) : null,
    };
  });

  const towns = [...new Set(current.map((r) => r.metrics.town))].sort(
    (a, b) => (gridOrder.indexOf(a) + 1 || 999) - (gridOrder.indexOf(b) + 1 || 999)
  );
  const perTown = towns.map((town) => {
    const rows = current.filter((r) => r.metrics.town === town);
    return {
      town,
      ranks: Object.fromEntries(rows.map((r) => [r.metrics.keyword, r.metrics.rank ?? null])),
      avgRank: round(mean(rows.map((r) => effectiveRank(r.metrics.rank))), 1),
    };
  });

  const competitorCounts = new Map();
  for (const r of current) {
    for (const c of r.metrics.topCompetitors || []) {
      const name = c.title || "?";
      competitorCounts.set(name, (competitorCounts.get(name) || 0) + 1);
    }
  }
  const topCompetitors = [...competitorCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([title, appearancesInTop3]) => ({ title, appearancesInTop3 }));

  const all = current.map((r) => effectiveRank(r.metrics.rank));
  const pairedAll = current.filter((r) => prevByKey.has(r.key));
  return {
    available: true,
    runDate: current[0].date,
    previousRunDate: previous[0]?.date || null,
    checks: current.length,
    unrankedCountsAs: UNRANKED,
    avgRank: round(mean(all), 1),
    top3Share: round(current.filter((r) => r.metrics.rank !== null && r.metrics.rank <= 3).length / current.length, 3),
    change: pairedAll.length
      ? round(
          mean(pairedAll.map((r) => effectiveRank(prevByKey.get(r.key).rank))) - mean(pairedAll.map((r) => effectiveRank(r.metrics.rank))),
          1
        )
      : null,
    nameOnlyMatches: current.filter((r) => r.metrics.matchedBy === "name").length,
    perKeyword,
    perTown,
    topCompetitors,
  };
}

/** Average rank per keyword, top-3 share, change vs the previous run, per-town table. */
async function rankSummary({ store = getDefaultStore() } = {}) {
  // A run still being collected has a partial day; summarise the last
  // complete run instead of comparing half a run with a whole one.
  const pending = await store.readState(PENDING_KEY);
  let dates = await store.latestDates(SOURCE, 3);
  if (pending?.runDate && dates[0] === pending.runDate) dates = dates.slice(1);
  const [latest, prior] = dates;
  if (!latest) return { available: false, reason: pending ? "first_run_collecting" : "no_data" };
  const current = await store.findSnapshots({ source: SOURCE, date: latest });
  const previous = prior ? await store.findSnapshots({ source: SOURCE, date: prior }) : [];
  const summary = computeRankSummary(current, previous);
  const lastRun = await store.readState(LAST_RUN_KEY);
  if (summary.available && lastRun) {
    summary.lastRun = {
      runDate: lastRun.runDate,
      collected: lastRun.collected,
      failed: lastRun.failed,
      expired: lastRun.expired,
      skippedByCap: lastRun.skippedByCap,
      estimatedCostUsd: lastRun.estimatedCostUsd,
      reportedCostUsd: lastRun.reportedCostUsd,
    };
  }
  return summary;
}

module.exports = {
  SOURCE,
  COST_PER_TASK_USD,
  DEFAULT_KEYWORDS,
  UNRANKED,
  PENDING_KEY,
  LAST_RUN_KEY,
  localRankEnabled,
  localRankConfig,
  maxChecks,
  keywords,
  planChecks,
  estimateCostUsd,
  matchProfixter,
  parseMapsResult,
  postLocalRankRun,
  collectLocalRankResults,
  computeRankSummary,
  rankSummary,
};
