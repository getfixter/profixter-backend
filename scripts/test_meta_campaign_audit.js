/**
 * Meta campaign audit: read-only, flags the tracking changes that would hurt.
 *   node scripts/test_meta_campaign_audit.js
 */
process.env.NODE_ENV = "test";
const assert = require("assert");
const { auditMetaCampaigns, summarize, describeRule } = require("../utils/analytics/metaCampaignAudit");

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

function fakeFetch(routes, calls) {
  return async (u) => {
    const url = new URL(u);
    calls.push({ path: url.pathname, method: "GET" });
    const hit = Object.entries(routes).find(([k]) => url.pathname.endsWith(k));
    const body = hit ? hit[1] : { error: { code: 100, message: "unknown" } };
    return { ok: !body.error, status: body.error ? 400 : 200, json: async () => body };
  };
}

(async () => {
  console.log("meta campaign audit");

  await test("a custom conversion on content_name=free_visit_booked is a high risk", async () => {
    const out = summarize({
      accounts: [
        {
          id: "1",
          adsets: [
            {
              name: "Free visit LI",
              effective_status: "ACTIVE",
              optimization_goal: "OFFSITE_CONVERSIONS",
              promoted_object: { custom_conversion_id: "99" },
              campaign: { name: "Free Visit", objective: "OUTCOME_LEADS" },
            },
          ],
          customConversions: [
            { id: "99", name: "Free visit booked", custom_event_type: "LEAD", rule: '{"and":[{"content_name":{"eq":"free_visit_booked"}}]}' },
          ],
        },
      ],
    });
    assert.strictEqual(out.risks.filter((r) => r.level === "high").length, 1);
  });

  await test("plain Lead optimisation is informational, paused ad sets are not audited", async () => {
    const out = summarize({
      accounts: [
        {
          id: "1",
          adsets: [
            { name: "A", effective_status: "ACTIVE", optimization_goal: "OFFSITE_CONVERSIONS", promoted_object: { custom_event_type: "LEAD" }, campaign: { name: "C" } },
            { name: "B", effective_status: "PAUSED", optimization_goal: "OFFSITE_CONVERSIONS", promoted_object: { custom_event_type: "LEAD" }, campaign: { name: "C" } },
          ],
          customConversions: [],
        },
      ],
    });
    assert.deepStrictEqual(out.risks.map((r) => r.level), ["info"]);
    assert.strictEqual(out.accounts[0].pausedAdsets, 1);
  });

  await test("rule description spots the content names", async () => {
    assert.strictEqual(describeRule({ content_name: { i_contains: "free_visit_booked" } }).contentNameFreeVisit, true);
    assert.strictEqual(describeRule(null), null);
  });

  await test("discovers accounts and only ever GETs", async () => {
    const calls = [];
    const fetchImpl = fakeFetch(
      {
        "/me/adaccounts": { data: [{ account_id: "123", name: "Profixter" }] },
        "/act_123/adsets": { data: [{ name: "S", effective_status: "ACTIVE", optimization_goal: "LINK_CLICKS", campaign: { name: "Traffic" } }] },
        "/act_123/customconversions": { data: [] },
      },
      calls
    );
    const out = await auditMetaCampaigns({ env: { FB_ACCESS_TOKEN: "t" }, fetchImpl });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.accounts[0].activeAdsets[0].optimizationGoal, "LINK_CLICKS");
    assert.ok(calls.every((c) => c.method === "GET"));
  });

  await test("no token, or a token without ads access, is a clear reason", async () => {
    assert.strictEqual((await auditMetaCampaigns({ env: {} })).reason, "token_missing");
    const calls = [];
    const fetchImpl = fakeFetch({ "/me/adaccounts": { error: { code: 200, message: "Requires ads_read" } } }, calls);
    const out = await auditMetaCampaigns({ env: { FB_ACCESS_TOKEN: "secret-token" }, fetchImpl });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.reason, "token_missing_ads_read");
    assert.ok(!String(out.message).includes("secret-token"));
  });

  console.log(`\n${passed} passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
