const AnalyticsState = require("../../models/AnalyticsState");
const {
  GRAPH_VERSION,
  configuredAccountId,
  resolveToken,
  graphGet,
  MetaApiError,
} = require("./metaAdSpend");

/**
 * What do the live Meta campaigns optimise for? Read-only.
 *
 * WHY THIS EXISTS. A tracking change is only safe if we know which events the
 * ad delivery system is learning from. Removing a duplicate Lead is harmless
 * to a campaign optimising for "Lead", and silently fatal to one optimising
 * for a custom conversion defined as "Lead where content_name =
 * free_visit_booked". The owner should not have to open Ads Manager to answer
 * that, and nobody should change events without answering it.
 *
 * WHAT IT DOES. GET only, with whatever token the Conversions API / spend sync
 * already uses (never logged): the ad accounts the token can see (or the
 * configured one), each account's ad sets with their optimisation goal and
 * promoted event, and the account's custom conversions with their rules. The
 * result is stored in AnalyticsState and logged as one compact line, so it can
 * be read from the server log without anyone handling the token.
 *
 * It changes nothing in Meta: no budgets, no statuses, no conversions.
 */

const STATE_KEY = "meta-campaign-audit";
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const ACTIVE = new Set(["ACTIVE", "IN_PROCESS", "WITH_ISSUES"]);
const MAX_ACCOUNTS = 5;

function url(path, params = {}) {
  const u = new URL(`${GRAPH}/${path}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, typeof v === "string" ? v : JSON.stringify(v));
  return u.toString();
}

async function allPages(first, ctx, maxPages = 20) {
  const rows = [];
  let next = first;
  for (let i = 0; next && i < maxPages; i += 1) {
    const body = await graphGet(next, ctx);
    rows.push(...(Array.isArray(body.data) ? body.data : []));
    next = body.paging?.next || null;
  }
  return rows;
}

/** Which tracked event, if any, a custom conversion rule filters on. */
function describeRule(rule) {
  if (!rule) return null;
  const text = typeof rule === "string" ? rule : JSON.stringify(rule);
  const mentions = (needle) => text.toLowerCase().includes(needle);
  return {
    raw: text.slice(0, 400),
    contentNameFreeVisit: mentions("free_visit_booked"),
    contentNameAccount: mentions("account_created"),
    url: /url/i.test(text),
  };
}

/** Pure: reduce raw Graph rows to the facts a tracking change depends on. */
function summarize({ accounts }) {
  const out = { accounts: [], risks: [] };
  for (const acc of accounts) {
    const conversions = new Map(acc.customConversions.map((c) => [String(c.id), c]));
    const adsets = acc.adsets.map((s) => {
      const promoted = s.promoted_object || {};
      const cc = promoted.custom_conversion_id ? conversions.get(String(promoted.custom_conversion_id)) : null;
      return {
        campaign: s.campaign?.name || null,
        objective: s.campaign?.objective || null,
        adset: s.name,
        active: ACTIVE.has(String(s.effective_status || "")),
        optimizationGoal: s.optimization_goal || null,
        event: promoted.custom_event_type || cc?.custom_event_type || null,
        customConversion: cc
          ? { id: String(cc.id), name: cc.name, event: cc.custom_event_type || null, rule: describeRule(cc.rule) }
          : promoted.custom_conversion_id
          ? { id: String(promoted.custom_conversion_id), name: null, event: null, rule: null }
          : null,
        pixelId: promoted.pixel_id || null,
      };
    });
    out.accounts.push({
      id: acc.id,
      name: acc.name || null,
      currency: acc.currency || null,
      activeAdsets: adsets.filter((a) => a.active),
      pausedAdsets: adsets.filter((a) => !a.active).length,
      customConversions: acc.customConversions
        .filter((c) => !c.is_archived)
        .map((c) => ({ id: String(c.id), name: c.name, event: c.custom_event_type || null, rule: describeRule(c.rule) })),
    });
  }

  for (const acc of out.accounts) {
    for (const a of acc.activeAdsets) {
      if (a.customConversion?.rule?.contentNameFreeVisit) {
        out.risks.push({
          level: "high",
          adset: a.adset,
          campaign: a.campaign,
          text: "Optimises on a custom conversion that filters content_name=free_visit_booked on Lead; that Lead no longer fires once the frontend deploys.",
        });
      }
      if (a.event === "LEAD" || a.optimizationGoal === "LEAD_GENERATION" || a.optimizationGoal === "OFFSITE_CONVERSIONS") {
        if (a.event === "LEAD") {
          out.risks.push({
            level: "info",
            adset: a.adset,
            campaign: a.campaign,
            text: "Optimises on Lead. After the change every new account still sends exactly one Lead; only the duplicate free-visit Lead disappears, so reported Leads drop while the people converting are the same.",
          });
        }
      }
    }
  }
  return out;
}

async function auditMetaCampaigns({ env = process.env, fetchImpl = globalThis.fetch, now = new Date() } = {}) {
  const { token, source } = resolveToken(env);
  if (!token) return { ok: false, reason: "token_missing", at: now };
  const ctx = { token, fetchImpl };

  let accountRows;
  try {
    const configured = configuredAccountId(env);
    if (configured) {
      accountRows = [await graphGet(url(`act_${configured}`, { fields: "account_id,name,currency,account_status" }), ctx)];
    } else {
      accountRows = await allPages(url("me/adaccounts", { fields: "account_id,name,currency,account_status", limit: 50 }), ctx, 2);
    }
  } catch (error) {
    const reason = error instanceof MetaApiError ? error.reason : "error";
    return { ok: false, reason, tokenSource: source, message: String(error.message || "").slice(0, 300), at: now };
  }

  const accounts = [];
  for (const row of accountRows.slice(0, MAX_ACCOUNTS)) {
    const id = String(row.account_id || row.id || "").replace(/^act_/, "");
    if (!id) continue;
    const acc = { id, name: row.name, currency: row.currency, adsets: [], customConversions: [], errors: [] };
    try {
      acc.adsets = await allPages(
        url(`act_${id}/adsets`, {
          fields: "name,effective_status,optimization_goal,promoted_object,campaign{name,objective,effective_status}",
          limit: 200,
        }),
        ctx
      );
    } catch (error) {
      acc.errors.push(`adsets: ${String(error.message || error).slice(0, 200)}`);
    }
    try {
      acc.customConversions = await allPages(
        url(`act_${id}/customconversions`, { fields: "name,custom_event_type,rule,is_archived", limit: 200 }),
        ctx
      );
    } catch (error) {
      acc.errors.push(`customconversions: ${String(error.message || error).slice(0, 200)}`);
    }
    accounts.push(acc);
  }

  const summary = summarize({ accounts });
  summary.errors = accounts.flatMap((a) => a.errors.map((e) => `${a.id} ${e}`));
  return { ok: true, at: now, tokenSource: source, ...summary };
}

async function runAndStore(options = {}) {
  const result = await auditMetaCampaigns(options);
  await AnalyticsState.updateOne({ key: STATE_KEY }, { $set: { value: result } }, { upsert: true });
  // One line, no token, no personal data: campaign and ad set names only.
  console.log(
    JSON.stringify({
      event: "meta_campaign_audit",
      ok: result.ok,
      reason: result.reason || null,
      tokenSource: result.tokenSource || null,
      accounts: (result.accounts || []).map((a) => ({
        id: a.id,
        name: a.name,
        active: a.activeAdsets.map((s) => ({
          c: s.campaign,
          s: s.adset,
          goal: s.optimizationGoal,
          ev: s.event,
          cc: s.customConversion ? { n: s.customConversion.name, ev: s.customConversion.event, rule: s.customConversion.rule?.raw || null } : null,
        })),
        paused: a.pausedAdsets,
        customConversions: a.customConversions.map((c) => ({ n: c.name, ev: c.event, rule: c.rule?.raw || null })),
      })),
      risks: result.risks || [],
      errors: result.errors || [],
      message: result.message || null,
    })
  );
  return result;
}

async function latestAudit() {
  const row = await AnalyticsState.findOne({ key: STATE_KEY }).lean();
  return row?.value || null;
}

/** Once ~3 minutes after boot, then daily. Read-only and cheap; no lease needed. */
function startMetaCampaignAudit() {
  if (process.env.NODE_ENV === "test" || process.env.META_CAMPAIGN_AUDIT_ENABLED === "false") return;
  const run = () => runAndStore().catch((error) => console.warn("meta_campaign_audit failed:", error.message));
  setTimeout(run, 3 * 60 * 1000).unref?.();
  setInterval(run, 24 * 60 * 60 * 1000).unref?.();
}

module.exports = { STATE_KEY, auditMetaCampaigns, describeRule, latestAudit, runAndStore, startMetaCampaignAudit, summarize };
