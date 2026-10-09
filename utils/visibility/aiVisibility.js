/**
 * AI-answer visibility: when a Long Island homeowner asks an assistant an
 * ordinary handyman question, does the answer name Profixter, cite
 * profixter.com, or bring up the membership model on its own?
 *
 * This is the automated, weekly sibling of the manual benchmark in the
 * FrontEnd repo (scripts/ai-benchmark). It asks the SAME prompts
 * (data/ai-visibility-prompts.json is a verbatim copy of its prompts.json;
 * keep the two identical, and add prompts with new ids rather than editing
 * one) and scores answers with the SAME keyword rules (scoreAnswer below is a
 * faithful port of score.js `classify`), so the numbers sit next to the
 * October 8, 2026 baseline.
 *
 * READ THIS BEFORE QUOTING A NUMBER. These answers come from the OpenAI
 * Responses API with the web_search tool, not from the ChatGPT app. The app
 * uses different models, system prompts, memory, personalisation, location
 * signals and search plumbing, so its answers differ, sometimes a lot. Treat
 * this as a consistent, cheap weekly proxy whose TREND is meaningful; the
 * monthly manual benchmark (real ChatGPT/Bing from a real Long Island IP)
 * remains the reference. A keyword mention is also not a recommendation:
 * read the stored answers before acting on a change.
 *
 * LOCATION. The web_search tool takes an approximate user location; it is
 * set to Lindenhurst, NY, matching the baseline (the most favourable place
 * for Profixter, which the baseline notes too).
 *
 * COST, per run, at list price (https://developers.openai.com/api/docs/pricing):
 *   web search tool calls $10 per 1,000 calls = $0.01 per search, plus the
 *   model's tokens (search results are fed back in as input tokens). With the
 *   default model, 19 prompts x (~1-2 searches + ~10-20k tokens) comes to
 *   roughly $0.30-$0.60 per weekly run, ~$1.50-$2.50 a month. The run logs a
 *   pre-run estimate and the cost computed from the usage OpenAI reports.
 *   AI_VISIBILITY_MAX_PROMPTS_PER_RUN (default 25, hard ceiling 60) caps it.
 *
 * OWNER SETUP: none beyond the OPENAI_API_KEY the chatbot already uses; set
 * AI_VISIBILITY_ENABLED=true. Optionally AI_VISIBILITY_MODEL (must support
 * the web_search tool).
 */
const PROMPT_FILE = require("../../data/ai-visibility-prompts.json");
const { nyDate, round, fetchJson, domainOf, defaultFetch } = require("./common");
const { getDefaultStore } = require("./store");

const SOURCE = "ai_visibility";
const RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-5-mini";
const DEFAULT_MAX_PROMPTS = 25;
const HARD_MAX_PROMPTS = 60;
const TEXT_LIMIT = 4000;
const LAST_RUN_KEY = "visibility:ai:last_run";
const USER_LOCATION = { type: "approximate", country: "US", region: "New York", city: "Lindenhurst", timezone: "America/New_York" };

/*
 * List prices per 1M tokens, USD (https://developers.openai.com/api/docs/pricing,
 * checked October 2026). A model not listed is costed at the default
 * model's rates and the cost is marked as an estimate either way.
 */
const WEB_SEARCH_USD_PER_CALL = 10 / 1000;
const TOKEN_PRICES = {
  "gpt-5-mini": { input: 0.25, output: 2.0 },
  "gpt-5": { input: 1.25, output: 10.0 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
};
// For the pre-run estimate only: assumed tokens per prompt with search results.
const ASSUMED = { searches: 1.5, inputTokens: 15000, outputTokens: 2000 };

/* ------------------------------------------------------------------ */
/* Scoring (port of FrontEnd/scripts/ai-benchmark/score.js classify)   */
/* ------------------------------------------------------------------ */

// Verbatim from score.js. Do not edit without editing score.js: runs are
// only comparable while both use the same rules.
const MEMBERSHIP = /[^.\n]*\b(membership|memberships|subscription|subscriptions|subscribe|monthly plan|maintenance plan|annual plan|monthly fee|retainer)\b[^.\n]*/i;
const RECURRING = /[^.\n]*\b(recurring|ongoing|regular(ly)? (scheduled )?(maintenance|visits|checkups?)|seasonal maintenance|preventive maintenance|preventative maintenance|same handyman|go-to handyman|long-term|on retainer|routine maintenance|regular handyman|home maintenance (service|company|plan)|maintenance (service|company|visits))\b[^.\n]*/i;
const PRICES = ["$149", "$249", "$349", "$499"];
const ORDINARY_GROUPS = "ABCDEFGH"; // homeowner never mentions membership or Profixter

/*
 * ADDED here, not in score.js: who else gets named. The names are the
 * Long Island membership sellers the search-foundation work identified
 * (TruBlue, Perry's, DwellWell), the national handyman franchises, and the
 * marketplaces that dominated the baseline's cited domains. `kind` keeps
 * "a competitor was recommended" apart from "a directory was suggested".
 */
const COMPETITORS = [
  { name: "TruBlue", kind: "membership_seller", pattern: /\btru\s?blue\b/i },
  { name: "Perry's", kind: "membership_seller", pattern: /\bperry['’]?s\b/i },
  { name: "DwellWell", kind: "membership_seller", pattern: /\bdwell\s?well\b/i },
  { name: "Mr. Handyman", kind: "franchise", pattern: /\bmr\.?\s?handyman\b/i },
  { name: "Ace Handyman Services", kind: "franchise", pattern: /\bace handyman\b/i },
  { name: "Handyman Connection", kind: "franchise", pattern: /\bhandyman connection\b/i },
  { name: "House Doctors", kind: "franchise", pattern: /\bhouse doctors\b/i },
  { name: "TaskRabbit", kind: "marketplace", pattern: /\btask\s?rabbit\b/i },
  { name: "Angi", kind: "marketplace", pattern: /\bangi\b|\bangie'?s list\b/i },
  { name: "Thumbtack", kind: "marketplace", pattern: /\bthumbtack\b/i },
  { name: "HomeAdvisor", kind: "marketplace", pattern: /\bhome\s?advisor\b/i },
  { name: "Handy", kind: "marketplace", pattern: /\bhandy\.com\b|\bhandy app\b/i },
  { name: "Nextdoor", kind: "marketplace", pattern: /\bnextdoor\b/i },
  { name: "Yelp", kind: "marketplace", pattern: /\byelp\b/i },
];

/**
 * Pure: score one answer. The first seven fields are score.js `classify`
 * exactly (profixterCited checks links AND the sources text, as there);
 * competitorsNamed and citedDomains are additions. `domains` follows the
 * baseline file's field of the same name: unique hosts of the links, without
 * "www.".
 */
function scoreAnswer({ text = "", links = [], sources = "", group = "" } = {}) {
  const m = text.match(MEMBERSHIP);
  const r = text.match(RECURRING);
  const allLinks = [...(links || [])];
  return {
    membershipIntroduced: !!m,
    membershipQuote: m ? m[0].trim().slice(0, 200) : "",
    recurringIntroduced: !!r,
    profixterNamed: /profixter/i.test(text),
    profixterCited: [...allLinks, sources || ""].some((l) => /profixter\.com/i.test(l)),
    saysUnlimited: /profixter[\s\S]{0,300}unlimited|unlimited[\s\S]{0,300}profixter/i.test(text),
    pricesStated: PRICES.filter((p) => text.includes(p)),
    ordinary: ORDINARY_GROUPS.includes(String(group || "?")) && String(group || "").length === 1,
    competitorsNamed: COMPETITORS.filter((c) => c.pattern.test(text)).map((c) => ({ name: c.name, kind: c.kind })),
    citedDomains: [...new Set(allLinks.map(domainOf).filter(Boolean))].sort(),
  };
}

/* ------------------------------------------------------------------ */
/* Collection                                                          */
/* ------------------------------------------------------------------ */

function aiVisibilityEnabled(env = process.env) {
  return String(env.AI_VISIBILITY_ENABLED || "").toLowerCase() === "true";
}

function aiVisibilityConfig(env = process.env) {
  const key = env.OPENAI_API_KEY || "";
  if (!key) return { configured: false, reason: "missing OPENAI_API_KEY" };
  return { configured: true, key, model: env.AI_VISIBILITY_MODEL || DEFAULT_MODEL, secrets: [key] };
}

function maxPrompts(env = process.env) {
  const n = Number(env.AI_VISIBILITY_MAX_PROMPTS_PER_RUN);
  const value = Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_MAX_PROMPTS;
  return Math.min(value, HARD_MAX_PROMPTS);
}

function pricesFor(model) {
  const known = Object.keys(TOKEN_PRICES)
    .sort((a, b) => b.length - a.length)
    .find((name) => model === name || model.startsWith(`${name}-`));
  return TOKEN_PRICES[known || DEFAULT_MODEL];
}

function estimateRunCostUsd(promptCount, model = DEFAULT_MODEL) {
  const p = pricesFor(model);
  const perPrompt =
    ASSUMED.searches * WEB_SEARCH_USD_PER_CALL + (ASSUMED.inputTokens * p.input + ASSUMED.outputTokens * p.output) / 1e6;
  return round(promptCount * perPrompt, 3);
}

function costFromUsage({ usage, webSearchCalls, model }) {
  const p = pricesFor(model);
  const input = Number(usage?.input_tokens || 0);
  const output = Number(usage?.output_tokens || 0);
  return round(webSearchCalls * WEB_SEARCH_USD_PER_CALL + (input * p.input + output * p.output) / 1e6, 4);
}

function isReasoningModel(model) {
  return /^(gpt-5|o\d)/.test(model);
}

/** Pure: answer text, cited links, consulted sources and search count from a Responses API body. */
function parseResponse(data) {
  const texts = [];
  const citations = [];
  const sources = [];
  let webSearchCalls = 0;
  for (const item of data?.output || []) {
    if (item?.type === "web_search_call") {
      webSearchCalls += 1;
      for (const s of item.action?.sources || []) if (s?.url) sources.push(String(s.url));
    }
    if (item?.type === "message") {
      for (const c of item.content || []) {
        if (c?.type === "output_text" && c.text) texts.push(c.text);
        for (const a of c?.annotations || []) {
          if (a?.type === "url_citation" && a.url) citations.push({ url: String(a.url), title: String(a.title || "").slice(0, 160) });
        }
      }
    }
  }
  const text = texts.join("\n").trim() || String(data?.output_text || "");
  const unique = [];
  const seen = new Set();
  for (const c of citations) {
    if (!seen.has(c.url)) {
      seen.add(c.url);
      unique.push(c);
    }
  }
  return { text, citations: unique, sources: [...new Set(sources)], webSearchCalls };
}

async function askOne({ prompt, config, fetchImpl }) {
  const body = {
    model: config.model,
    input: prompt.text,
    tools: [{ type: "web_search", user_location: USER_LOCATION }],
    include: ["web_search_call.action.sources"],
    max_output_tokens: 4000,
    store: false,
  };
  if (isReasoningModel(config.model)) body.reasoning = { effort: "low" };
  const data = await fetchJson(fetchImpl, RESPONSES_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.key}`, "Content-Type": "application/json" },
    body,
    timeoutMs: 150000,
  });
  return { data, ...parseResponse(data) };
}

/** Ask every prompt (capped), score, store. */
async function runAiVisibility({ env = process.env, now = new Date(), store = getDefaultStore(), fetchImpl, log = console, prompts } = {}) {
  const config = aiVisibilityConfig(env);
  if (!config.configured) throw new Error(config.reason);
  const doFetch = fetchImpl || defaultFetch();
  const all = prompts || PROMPT_FILE.prompts;
  const cap = maxPrompts(env);
  const selected = all.slice(0, cap);
  const estimatedCostUsd = estimateRunCostUsd(selected.length, config.model);
  log.log?.(
    JSON.stringify({ event: "ai_visibility_run_planned", model: config.model, prompts: selected.length, skippedByCap: all.length - selected.length, estimatedCostUsd })
  );

  const date = nyDate(now);
  const engine = `openai:${config.model}`;
  const rows = [];
  const failures = [];
  let webSearchCalls = 0;
  let costUsd = 0;
  for (const prompt of selected) {
    try {
      const answer = await askOne({ prompt, config, fetchImpl: doFetch });
      const links = answer.citations.map((c) => c.url);
      const scores = scoreAnswer({ text: answer.text, links, sources: answer.sources.join("\n"), group: prompt.group });
      const cost = costFromUsage({ usage: answer.data?.usage, webSearchCalls: answer.webSearchCalls, model: config.model });
      webSearchCalls += answer.webSearchCalls;
      costUsd += cost;
      rows.push({
        source: SOURCE,
        date,
        key: `${prompt.id}|${engine}`,
        metrics: {
          promptId: prompt.id,
          group: prompt.group,
          prompt: prompt.text,
          engine,
          model: answer.data?.model || config.model,
          location: `${USER_LOCATION.city}, ${USER_LOCATION.region}`,
          text: answer.text.slice(0, TEXT_LIMIT),
          truncated: answer.text.length > TEXT_LIMIT,
          citations: answer.citations.slice(0, 40),
          sourcesConsulted: answer.sources.slice(0, 40),
          webSearchCalls: answer.webSearchCalls,
          usage: { input: answer.data?.usage?.input_tokens || 0, output: answer.data?.usage?.output_tokens || 0 },
          costUsd: cost,
          scores,
        },
        fetchedAt: now,
      });
    } catch (error) {
      failures.push({ promptId: prompt.id, error: String(error?.message || error).slice(0, 200) });
    }
  }

  if (rows.length) await store.upsertSnapshots(rows);
  const run = {
    runDate: date,
    model: config.model,
    prompts: selected.length,
    answered: rows.length,
    failed: failures.length,
    skippedByCap: all.length - selected.length,
    webSearchCalls,
    estimatedCostUsd,
    costUsd: round(costUsd, 4),
  };
  await store.writeState(LAST_RUN_KEY, run);
  log.log?.(JSON.stringify({ event: "ai_visibility_run_finished", ...run }));
  if (!rows.length && failures.length) {
    // Every prompt failed: surface the first reason (the runner sanitises it).
    throw new Error(`all ${failures.length} prompts failed; first: ${failures[0].error}`);
  }
  return { completed: true, ...run, failures: failures.slice(0, 5) };
}

/* ------------------------------------------------------------------ */
/* Summary                                                             */
/* ------------------------------------------------------------------ */

function shares(rows) {
  const n = rows.length;
  const ordinary = rows.filter((r) => r.metrics.scores?.ordinary);
  const brand = rows.filter((r) => "IJ".includes(r.metrics.group || "?"));
  const share = (list, field) => (list.length ? round(list.filter((r) => r.metrics.scores?.[field]).length / list.length, 3) : null);
  return {
    prompts: n,
    ordinaryPrompts: ordinary.length,
    profixterNamedShare: share(rows, "profixterNamed"),
    profixterCitedShare: share(rows, "profixterCited"),
    // The benchmark's headline: membership introduced where the homeowner never asked (groups A-H).
    membershipUnpromptedShare: share(ordinary, "membershipIntroduced"),
    membershipUnprompted: ordinary.filter((r) => r.metrics.scores?.membershipIntroduced).length,
    recurringUnpromptedShare: share(ordinary, "recurringIntroduced"),
    brandPromptsNamingProfixterShare: share(brand, "profixterNamed"),
    saysUnlimited: rows.filter((r) => r.metrics.scores?.saysUnlimited).length,
  };
}

/** Pure: the AI visibility summary for one run against the previous one. */
function computeAiSummary(current, previous = []) {
  if (!current.length) return { available: false, reason: "no_data" };
  const now = shares(current);
  const before = previous.length ? shares(previous) : null;
  const delta = (field) => (before && now[field] !== null && before[field] !== null ? round(now[field] - before[field], 3) : null);

  const competitorCounts = new Map();
  const domainCounts = new Map();
  for (const r of current) {
    for (const c of r.metrics.scores?.competitorsNamed || []) {
      const k = `${c.name}\u0000${c.kind}`;
      competitorCounts.set(k, (competitorCounts.get(k) || 0) + 1);
    }
    for (const d of r.metrics.scores?.citedDomains || []) domainCounts.set(d, (domainCounts.get(d) || 0) + 1);
  }
  const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);

  return {
    available: true,
    runDate: current[0].date,
    previousRunDate: previous[0]?.date || null,
    engine: current[0].metrics.engine,
    ...now,
    trend: before
      ? {
          profixterNamedShare: delta("profixterNamedShare"),
          profixterCitedShare: delta("profixterCitedShare"),
          membershipUnpromptedShare: delta("membershipUnpromptedShare"),
          recurringUnpromptedShare: delta("recurringUnpromptedShare"),
        }
      : null,
    topCompetitors: top(competitorCounts, 8).map(([k, prompts]) => {
      const [name, kind] = k.split("\u0000");
      return { name, kind, prompts };
    }),
    topCitedDomains: top(domainCounts, 10).map(([domain, prompts]) => ({ domain, prompts })),
    caveat: "OpenAI API with web search from an approximate Lindenhurst location; not the same answers as the ChatGPT app. Watch the trend, read the answers.",
  };
}

/** Share of prompts naming Profixter / citing profixter.com / raising membership unprompted, vs the previous run. */
async function aiVisibilitySummary({ store = getDefaultStore() } = {}) {
  const [latest, prior] = await store.latestDates(SOURCE, 2);
  if (!latest) return { available: false, reason: "no_data" };
  const current = await store.findSnapshots({ source: SOURCE, date: latest });
  const previous = prior ? await store.findSnapshots({ source: SOURCE, date: prior }) : [];
  const summary = computeAiSummary(current, previous);
  const lastRun = await store.readState(LAST_RUN_KEY);
  if (summary.available && lastRun) summary.lastRun = lastRun;
  return summary;
}

module.exports = {
  SOURCE,
  DEFAULT_MODEL,
  LAST_RUN_KEY,
  USER_LOCATION,
  WEB_SEARCH_USD_PER_CALL,
  COMPETITORS,
  scoreAnswer,
  parseResponse,
  aiVisibilityEnabled,
  aiVisibilityConfig,
  maxPrompts,
  estimateRunCostUsd,
  costFromUsage,
  runAiVisibility,
  computeAiSummary,
  aiVisibilitySummary,
};
