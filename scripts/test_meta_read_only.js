/**
 * META ADVERTISING IS READ-ONLY. PERMANENTLY.
 *
 * Profixter's Meta ads are run by an external agency. The growth system may
 * read ad performance and send conversion measurement (Pixel / Conversions
 * API), and nothing else. This suite fails the build if anything in the
 * codebase could change an ad account:
 *
 *   - no growth action may target an advertising platform (registry guard)
 *   - only three files may talk to the Graph API, and each is pinned:
 *       utils/metaCapi.js                    POST <pixel>/events only (measurement)
 *       utils/analytics/metaAdSpend.js       GET only (insights)
 *       utils/analytics/metaCampaignAudit.js GET only (campaign settings)
 *   - no ads_management token or configuration exists
 *   - no agent can propose an advertising action or call an advertising write tool
 *
 *   node scripts/test_meta_read_only.js
 */
process.env.NODE_ENV = "test";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith(".js")) out.push(full);
  }
  return out;
}
const rel = (f) => path.relative(ROOT, f).split(path.sep).join("/");
const SOURCES = ["routes", "utils", "jobs", "models", "controllers", "middleware", "config"]
  .map((d) => path.join(ROOT, d))
  .filter((d) => fs.existsSync(d))
  .flatMap((d) => walk(d))
  .concat([path.join(ROOT, "server.js")]);
const code = Object.fromEntries(SOURCES.map((f) => [rel(f), fs.readFileSync(f, "utf8")]));

console.log("meta read-only");

test("the action registry refuses any advertising action, by name or by description", () => {
  const { defineAction, _unregister } = require("../utils/growth/actionRegistry");
  const base = { label: "x", description: "x", riskTier: "low", defaultMode: "shadow", maxMode: "shadow", execute: async () => ({}) };
  for (const type of ["meta_adset_budget_change", "facebook_pause", "ig_boost", "adset_status", "ad_account_settings", "ads_bid", "google_ads_budget", "campaign_budget_shift"]) {
    assert.throws(() => defineAction({ ...base, type }), /advertising/, type);
    _unregister(type);
  }
  assert.throws(() => defineAction({ ...base, type: "harmless_name", description: "Changes the Meta ad set budget" }), /advertising/);
  _unregister("harmless_name");
});

test("no registered growth action targets advertising", () => {
  require("../utils/growth/actions");
  const { listDefinitions, PROHIBITED_ACTION_PATTERNS } = require("../utils/growth/actionRegistry");
  for (const d of listDefinitions()) {
    assert.ok(!PROHIBITED_ACTION_PATTERNS.some((re) => re.test(d.type)), d.type);
  }
});

test("only the three pinned files talk to the Graph API", () => {
  const callers = Object.entries(code)
    .filter(([, src]) => /graph\.facebook\.com|GRAPH_HOST/.test(src))
    .map(([f]) => f)
    .sort();
  assert.deepStrictEqual(callers, ["utils/analytics/metaAdSpend.js", "utils/analytics/metaCampaignAudit.js", "utils/metaCapi.js"]);
});

test("ad spend and campaign audit only ever GET", () => {
  for (const f of ["utils/analytics/metaAdSpend.js", "utils/analytics/metaCampaignAudit.js"]) {
    const src = code[f];
    assert.ok(!/method:\s*["'](POST|PUT|PATCH|DELETE)["']/i.test(src), `${f} has a write method`);
    assert.ok(!/\.(post|put|patch|delete)\(/i.test(src), `${f} calls a write helper`);
  }
  assert.match(code["utils/analytics/metaAdSpend.js"], /method:\s*"GET"/);
});

test("the Conversions API only posts events to the pixel (measurement, not ad management)", () => {
  const src = code["utils/metaCapi.js"];
  const urls = src.match(/graph\.facebook\.com\/[^`"']*/g) || [];
  assert.ok(urls.length > 0);
  for (const u of urls) assert.match(u, /\/events$/, u);
});

test("no ads_management credential or configuration exists", () => {
  for (const [f, src] of Object.entries(code)) {
    assert.ok(!/META_ADS_MANAGE/.test(src), `${f} references META_ADS_MANAGE`);
    if (f === "utils/analytics/metaAdSpend.js") continue; // only to classify a permission error it may receive
    assert.ok(!/ads_management/.test(src), `${f} references ads_management`);
  }
  const example = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
  assert.ok(!/^META_ADS_MANAGE/m.test(example));
});

test("no agent can propose an advertising action or holds an advertising tool", () => {
  const { AGENTS } = require("../utils/agents/definitions");
  const { PROHIBITED_ACTION_PATTERNS } = require("../utils/growth/actionRegistry");
  for (const a of Object.values(AGENTS)) {
    for (const t of a.allowedActions || []) assert.ok(!PROHIBITED_ACTION_PATTERNS.some((re) => re.test(t)), `${a.name} may propose ${t}`);
    for (const t of a.tools) assert.ok(!/budget|pause|campaign_|ad_?set|bid/i.test(t), `${a.name} has tool ${t}`);
  }
});

console.log(`\n${passed} passed`);
