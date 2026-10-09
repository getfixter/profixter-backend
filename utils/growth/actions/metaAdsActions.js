const { GRAPH_VERSION, graphGet, MetaApiError } = require("../../analytics/metaAdSpend");
const { defineAction } = require("../actionRegistry");

/**
 * Meta ad changes the Marketing agent may PROPOSE. High risk, so the registry
 * caps both at "supervised": every single one waits for the owner, forever,
 * however many have gone well. They exist so the owner's decision is one
 * click on a precise, capped, reversible change instead of a trip to Ads
 * Manager - not so that money moves unattended.
 *
 * Inert until configured:
 *   META_ADS_MANAGE_TOKEN                 a token with ads_management (separate
 *                                         from the read-only CAPI/spend token)
 *   META_MAX_ADSET_DAILY_BUDGET_CENTS     hard ceiling for any ad set's daily
 *                                         budget; required for budget changes
 * Guards at execution time (not just at proposal): the change is re-read from
 * Meta, limited to +/-20% of the CURRENT budget, and never above the ceiling.
 * The previous value is stored so a rollback restores it exactly.
 */

const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const MAX_STEP = 0.2;

function permanent(message) {
  return Object.assign(new Error(message), { permanent: true });
}

function manageToken(env = process.env) {
  return env.META_ADS_MANAGE_TOKEN || "";
}

async function graphPost(path, params, { token, fetchImpl = globalThis.fetch }) {
  const body = new URLSearchParams({ ...params, access_token: token });
  const res = await fetchImpl(`${GRAPH}/${path}`, { method: "POST", body });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok || json?.error) {
    const msg = String(json?.error?.message || `HTTP ${res.status}`).split(token).join("[token]");
    throw permanent(`Meta rejected the change: ${msg}`);
  }
  return json;
}

async function readAdset(adsetId, { token, fetchImpl }) {
  const u = new URL(`${GRAPH}/${adsetId}`);
  u.searchParams.set("fields", "name,daily_budget,status,effective_status,campaign{name}");
  try {
    return await graphGet(u.toString(), { token, fetchImpl });
  } catch (error) {
    if (error instanceof MetaApiError) throw permanent(error.message);
    throw error;
  }
}

function validId(v) {
  const id = String(v || "");
  if (!/^\d{6,25}$/.test(id)) throw new Error("adsetId must be a numeric Meta ad set id");
  return id;
}

/* --------------------------- budget change --------------------------- */

function validateBudget(p = {}) {
  const adsetId = validId(p.adsetId);
  const to = Math.round(Number(p.newDailyBudgetCents));
  if (!Number.isFinite(to) || to < 100) throw new Error("newDailyBudgetCents must be at least 100");
  return {
    adsetId,
    adsetName: String(p.adsetName || "").slice(0, 120),
    fromDailyBudgetCents: Number.isFinite(Number(p.fromDailyBudgetCents)) ? Math.round(Number(p.fromDailyBudgetCents)) : null,
    newDailyBudgetCents: to,
  };
}

async function executeBudget(payload, { env = process.env, fetchImpl } = {}) {
  const token = manageToken(env);
  if (!token) throw permanent("META_ADS_MANAGE_TOKEN is not configured; budget changes cannot run.");
  const ceiling = Number(env.META_MAX_ADSET_DAILY_BUDGET_CENTS);
  if (!Number.isFinite(ceiling) || ceiling <= 0) throw permanent("META_MAX_ADSET_DAILY_BUDGET_CENTS is not configured.");

  const adset = await readAdset(payload.adsetId, { token, fetchImpl });
  const current = Number(adset.daily_budget);
  if (!Number.isFinite(current) || current <= 0) throw permanent("This ad set has no daily budget (campaign budget or lifetime budget); not changed.");
  const target = payload.newDailyBudgetCents;
  if (Math.abs(target - current) / current > MAX_STEP + 1e-9) {
    throw permanent(`Change from ${current} to ${target} cents exceeds the ${MAX_STEP * 100}% step limit.`);
  }
  if (target > ceiling) throw permanent(`Target ${target} cents exceeds the ceiling of ${ceiling}.`);

  await graphPost(payload.adsetId, { daily_budget: String(target) }, { token, fetchImpl });
  return { outcome: "done", result: { adsetId: payload.adsetId, previousDailyBudgetCents: current, newDailyBudgetCents: target } };
}

async function verifyBudget(action, { env = process.env, fetchImpl } = {}) {
  const token = manageToken(env);
  if (!token) return { passed: null, detail: "no token to verify" };
  const adset = await readAdset(action.payload.adsetId, { token, fetchImpl });
  const ok = Number(adset.daily_budget) === Number(action.result?.newDailyBudgetCents);
  return { passed: ok, detail: `daily_budget now ${adset.daily_budget}` };
}

async function rollbackBudget(action, { env = process.env, fetchImpl } = {}) {
  const token = manageToken(env);
  if (!token) throw permanent("META_ADS_MANAGE_TOKEN is not configured.");
  const prev = action.result?.previousDailyBudgetCents;
  if (!prev) throw permanent("No previous budget recorded.");
  await graphPost(action.payload.adsetId, { daily_budget: String(prev) }, { token, fetchImpl });
  return { restoredDailyBudgetCents: prev };
}

defineAction({
  type: "meta_adset_budget_change",
  label: "Meta ad set budget change",
  description:
    "Change one ad set's daily budget by at most 20%, never above the configured ceiling. Always needs the owner's approval; reversible.",
  riskTier: "high",
  defaultMode: "supervised",
  maxMode: "supervised",
  limits: { perDay: 6 },
  approvalTtlMs: 2 * 24 * 60 * 60 * 1000,
  verifyAfterMs: 2 * 60 * 1000,
  maxAttempts: 2,
  validate: validateBudget,
  describe: (p) =>
    `Change Meta ad set ${p.adsetName || p.adsetId} daily budget${p.fromDailyBudgetCents ? ` from $${(p.fromDailyBudgetCents / 100).toFixed(2)}` : ""} to $${(p.newDailyBudgetCents / 100).toFixed(2)}`,
  subjectOf: (p) => ({ entityType: "meta_adset", entityId: p.adsetId }),
  execute: (payload) => executeBudget(payload),
  verify: (action) => verifyBudget(action),
  rollback: (action) => rollbackBudget(action),
});

/* --------------------------- pause / resume -------------------------- */

function validateStatus(p = {}) {
  const status = String(p.status || "").toUpperCase();
  if (!["PAUSED", "ACTIVE"].includes(status)) throw new Error("status must be PAUSED or ACTIVE");
  return { adsetId: validId(p.adsetId), adsetName: String(p.adsetName || "").slice(0, 120), status };
}

async function executeStatus(payload, { env = process.env, fetchImpl } = {}) {
  const token = manageToken(env);
  if (!token) throw permanent("META_ADS_MANAGE_TOKEN is not configured; status changes cannot run.");
  const adset = await readAdset(payload.adsetId, { token, fetchImpl });
  await graphPost(payload.adsetId, { status: payload.status }, { token, fetchImpl });
  return { outcome: "done", result: { adsetId: payload.adsetId, previousStatus: adset.status, newStatus: payload.status } };
}

defineAction({
  type: "meta_adset_status",
  label: "Pause or resume a Meta ad set",
  description: "Pause an ad set that is spending without producing customers, or resume one. Always needs the owner's approval; reversible.",
  riskTier: "high",
  defaultMode: "supervised",
  maxMode: "supervised",
  limits: { perDay: 6 },
  approvalTtlMs: 2 * 24 * 60 * 60 * 1000,
  verifyAfterMs: 2 * 60 * 1000,
  maxAttempts: 2,
  validate: validateStatus,
  describe: (p) => `${p.status === "PAUSED" ? "Pause" : "Resume"} Meta ad set ${p.adsetName || p.adsetId}`,
  subjectOf: (p) => ({ entityType: "meta_adset", entityId: p.adsetId }),
  execute: (payload) => executeStatus(payload),
  verify: async (action) => {
    const token = manageToken();
    if (!token) return { passed: null, detail: "no token to verify" };
    const adset = await readAdset(action.payload.adsetId, { token });
    return { passed: adset.status === action.payload.status, detail: `status now ${adset.status}` };
  },
  rollback: async (action) => {
    const token = manageToken();
    if (!token) throw permanent("META_ADS_MANAGE_TOKEN is not configured.");
    const prev = action.result?.previousStatus;
    if (!prev) throw permanent("No previous status recorded.");
    await graphPost(action.payload.adsetId, { status: prev }, { token });
    return { restoredStatus: prev };
  },
});

module.exports = { MAX_STEP, executeBudget, executeStatus, rollbackBudget, validateBudget, validateStatus, verifyBudget };
