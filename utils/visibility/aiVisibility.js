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
 *
 * ENGINE (2026-11-03). The OpenAI account ran out of credit and every run
 * since 2026-11-02 failed (HTTP 429). The default engine is now Claude
 * (claude-haiku-5-5 with Anthropic's web search tool), on the ANTHROPIC_API_KEY
 * the support chat already uses; AI_VISIBILITY_PROVIDER=openai switches back.
 * Claude's answers are not ChatGPT's, so every row carries its engine and a
 * run's trend is only ever computed against the previous run of the SAME
 * engine - an engine change starts a new series rather than a fake jump.
 * (The last OpenAI runs also show webSearchCalls 0 on every prompt: gpt-5-mini
 * was answering from training data, not searching.)
 *
 * Claude cost, list price (platform.claude.com, checked 2026-11-03): web
 * search $10 per 1,000 searches plus tokens (search results count as input);
 * Haiku 5.5 $0.10 / $0.50 per MTok. Searches are capped at 3 per prompt and a
 * run stops asking once it has spent AI_VISIBILITY_MAX_RUN_USD (default $2).
 */
const PROMPT_FILE = require("../../data/ai-visibility-prompts.json");
const { nyDate, round, fetchJson, domainOf, defaultFetch } = require("./common");
const { getDefaultStore } = require("./store");

const SOURCE = "ai_visibility";
const RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-5-mini";
const ANTHROPIC_DEFAULT_MODEL = "claude-haiku-5-5";
const DEFAULT_PROVIDER = "anthropic";
const MAX_SEARCHES_PER_PROMPT = 3;
const DEFAULT_MAX_RUN_USD = 2;
const CLAUDE_TIMEOUT_MS = 150000;
// A paused server-side search loop is resumed at most this many times per prompt.
const MAX_CONTINUATIONS = 2;
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
  // Prompts here stay far under 100K tokens, where Haiku 5.5's lower rate applies.
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
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

function aiVisibilityProvider(env = process.env) {
  const p = String(env.AI_VISIBILITY_PROVIDER || DEFAULT_PROVIDER).trim().toLowerCase();
  return p === "openai" ? "openai" : "anthropic";
}

function aiVisibilityConfig(env = process.env) {
  const provider = aiVisibilityProvider(env);
  if (provider === "anthropic") {
    const key = env.ANTHROPIC_API_KEY || "";
    if (!key) return { configured: false, reason: "missing ANTHROPIC_API_KEY" };
    return { configured: true, provider, key, model: env.AI_VISIBILITY_MODEL || ANTHROPIC_DEFAULT_MODEL, secrets: [key] };
  }
  const key = env.OPENAI_API_KEY || "";
  if (!key) return { configured: false, reason: "missing OPENAI_API_KEY" };
  return { configured: true, provider, key, model: env.AI_VISIBILITY_MODEL || DEFAULT_MODEL, secrets: [key] };
}

function maxRunUsd(env = process.env) {
  const n = Number(env.AI_VISIBILITY_MAX_RUN_USD);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_RUN_USD;
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

/**
 * Pure: answer text, cited links, consulted sources and search count from the
 * content blocks of one or more Messages API responses (a paused search loop
 * is continued, so one answer can span several).
 */
function parseClaudeResponse(messages) {
  const texts = [];
  const citations = [];
  const sources = [];
  let webSearchCalls = 0;
  const usage = { input_tokens: 0, output_tokens: 0 };
  for (const data of messages) {
    webSearchCalls += Number(data?.usage?.server_tool_use?.web_search_requests || 0);
    usage.input_tokens += Number(data?.usage?.input_tokens || 0);
    usage.output_tokens += Number(data?.usage?.output_tokens || 0);
    for (const block of data?.content || []) {
      if (block?.type === "web_search_tool_result" && Array.isArray(block.content)) {
        for (const r of block.content) if (r?.url) sources.push(String(r.url));
      }
      if (block?.type === "text" && block.text) {
        texts.push(block.text);
        for (const c of block.citations || []) {
          if (c?.url) citations.push({ url: String(c.url), title: String(c.title || "").slice(0, 160) });
        }
      }
    }
  }
  const unique = [];
  const seen = new Set();
  for (const c of citations) {
    if (!seen.has(c.url)) {
      seen.add(c.url);
      unique.push(c);
    }
  }
  return { text: texts.join("").trim(), citations: unique, sources: [...new Set(sources)], webSearchCalls, usage };
}

function anthropicClient(config) {
  const { Anthropic } = require("@anthropic-ai/sdk");
  return new Anthropic({ apiKey: config.key, timeout: CLAUDE_TIMEOUT_MS, maxRetries: 1 });
}

/*
 * One question to Claude, as a homeowner would ask it: no system prompt (the
 * OpenAI path has none either), web search from the same approximate
 * Lindenhurst location. The basic web_search_20250305 tool: Haiku 5.5 is not
 * one of the models with dynamic filtering.
 */
async function askOneClaude({ prompt, config, client }) {
  const api = client || anthropicClient(config);
  const tools = [
    {
      type: "web_search_20250305",
      name: "web_search",
      max_uses: MAX_SEARCHES_PER_PROMPT,
      user_location: {
        type: "approximate",
        city: USER_LOCATION.city,
        region: USER_LOCATION.region,
        country: USER_LOCATION.country,
        timezone: USER_LOCATION.timezone,
      },
    },
  ];
  const messages = [{ role: "user", content: prompt.text }];
  const responses = [];
  for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
    const data = await api.messages.create({ model: config.model, max_tokens: 4000, output_config: { effort: "low" }, tools, messages });
    responses.push(data);
    if (data?.stop_reason === "refusal") throw new Error("model declined to answer");
    if (data?.stop_reason !== "pause_turn") break;
    // Resume the server-side search loop: send the paused turn back unchanged.
    messages.push({ role: "assistant", content: data.content });
  }
  const parsed = parseClaudeResponse(responses);
  if (!parsed.text) throw new Error("empty answer");
  return { data: { model: responses[responses.length - 1]?.model, usage: parsed.usage }, ...parsed };
}

/** Ask every prompt (capped), score, store. */
async function runAiVisibility({ env = process.env, now = new Date(), store = getDefaultStore(), fetchImpl, anthropic, log = console, prompts } = {}) {
  const config = aiVisibilityConfig(env);
  if (!config.configured) throw new Error(config.reason);
  const budgetUsd = maxRunUsd(env);
  const doFetch = fetchImpl || defaultFetch();
  const all = prompts || PROMPT_FILE.prompts;
  const cap = maxPrompts(env);
  const selected = all.slice(0, cap);
  const estimatedCostUsd = estimateRunCostUsd(selected.length, config.model);
  log.log?.(
    JSON.stringify({ event: "ai_visibility_run_planned", provider: config.provider, model: config.model, prompts: selected.length, skippedByCap: all.length - selected.length, estimatedCostUsd, budgetUsd })
  );

  const date = nyDate(now);
  const engine = `${config.provider}:${config.model}`;
  const rows = [];
  const failures = [];
  let webSearchCalls = 0;
  let costUsd = 0;
  let stoppedByBudget = 0;
  for (const prompt of selected) {
    // Cost protection: never start a prompt once the run has spent its budget.
    if (costUsd >= budgetUsd) {
      stoppedByBudget += 1;
      continue;
    }
    try {
      const answer =
        config.provider === "anthropic"
          ? await askOneClaude({ prompt, config, client: anthropic })
          : await askOne({ prompt, config, fetchImpl: doFetch });
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
      const message = error?.status ? `HTTP ${error.status}: ${error.message}` : error?.message || error;
      failures.push({ promptId: prompt.id, error: String(message).slice(0, 200) });
    }
  }

  if (rows.length) await store.upsertSnapshots(rows);
  const run = {
    runDate: date,
    provider: config.provider,
    model: config.model,
    prompts: selected.length,
    answered: rows.length,
    failed: failures.length,
    skippedByCap: all.length - selected.length,
    stoppedByBudget,
    budgetUsd,
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
  const engine = current[0].metrics.engine;
  // A run from another engine is a different series: no trend across it.
  const previousEngine = previous[0]?.metrics?.engine || null;
  if (previous.length && previousEngine !== engine) previous = [];
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
    caveat: String(engine || "").startsWith("anthropic:")
      ? "Claude API with web search from an approximate Lindenhurst location; not ChatGPT and not the Claude app. Trends compare Claude runs only. Watch the trend, read the answers."
      : "OpenAI API with web search from an approximate Lindenhurst location; not the same answers as the ChatGPT app. Watch the trend, read the answers.",
  };
}

/** Share of prompts naming Profixter / citing profixter.com / raising membership unprompted, vs the previous run. */
async function aiVisibilitySummary({ store = getDefaultStore() } = {}) {
  // Several dates back, so the previous run of the same engine is found across an engine change.
  const [latest, ...older] = await store.latestDates(SOURCE, 6);
  if (!latest) return { available: false, reason: "no_data" };
  const current = await store.findSnapshots({ source: SOURCE, date: latest });
  const engine = current[0]?.metrics?.engine;
  let previous = [];
  for (const date of older) {
    const rows = await store.findSnapshots({ source: SOURCE, date });
    if (rows[0]?.metrics?.engine === engine) {
      previous = rows;
      break;
    }
  }
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
  parseClaudeResponse,
  aiVisibilityProvider,
  maxRunUsd,
  aiVisibilityEnabled,
  aiVisibilityConfig,
  maxPrompts,
  estimateRunCostUsd,
  costFromUsage,
  runAiVisibility,
  computeAiSummary,
  aiVisibilitySummary,
};
