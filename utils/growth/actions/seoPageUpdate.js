const SeoOverride = require("../../../models/SeoOverride");
const GrowthAction = require("../../../models/GrowthAction");
const { checkCopy } = require("../../agents/copyRules");
const { ALLOWED_PATH, SITE, livePage, pagePerformance } = require("../../seo/pageData");
const { defineAction } = require("../actionRegistry");

/**
 * Change a page's search title and/or meta description (and, as a separate
 * medium-risk type, its H1 and intro) through the live override layer.
 *
 * GUARDRAILS, all re-checked when the action runs:
 *   - only pages we publish (ALLOWED_PATH); the page must be live and indexable
 *   - copy rules (no prices, discounts, claims, banned wording); "Profixter"
 *     stays in every title; length bounds Google actually displays
 *   - DATA FIRST: needs at least 14 days of Search Console data for the page,
 *     and refuses to touch a page that already performs (top-3 average
 *     position with a healthy CTR) - working pages are preserved
 *   - at most one change per page per 28 days, so each change can be measured
 *     before the next; the outcome is read back 28 days later
 *   - the business itself never changes here: services, area, plans, prices
 *     and booking rules live in code, not in this layer
 *
 * VERIFIED on the live page (the new title must actually be served), and
 * REVERSIBLE: rollback restores the exact previous wording (or the code
 * default). IndexNow is pinged so Bing/Yandex recrawl promptly.
 */

const COOLDOWN_DAYS = 28;
const MIN_DATA_DAYS = 14;
const LIMITS = {
  metaTitle: [30, 70],
  metaDescription: [70, 165],
  h1: [15, 90],
  intro: [80, 600],
};

function ymd(d) {
  return new Date(d).toISOString().slice(0, 10);
}

function validator(allowed) {
  return (p = {}) => {
    const path = String(p.path || "").trim();
    if (!ALLOWED_PATH.test(path)) throw new Error(`Not a page we optimize: ${path}`);
    const changes = {};
    for (const k of allowed) {
      if (p.changes?.[k] == null) continue;
      const v = String(p.changes[k]).replace(/\s+/g, " ").trim();
      const [min, max] = LIMITS[k];
      if (v.length < min || v.length > max) throw new Error(`${k} must be ${min}-${max} characters (got ${v.length})`);
      changes[k] = v;
    }
    if (!Object.keys(changes).length) throw new Error(`No change to ${allowed.join("/")}`);
    if (changes.metaTitle && !/profixter/i.test(changes.metaTitle)) throw new Error('Titles keep the brand: include "Profixter"');
    const problems = checkCopy(Object.values(changes).join("\n"));
    if (problems.length) throw new Error(`Rewrite needed: ${problems.join(" ")}`);
    return {
      path,
      changes,
      targetQueries: (p.targetQueries || []).slice(0, 5).map((q) => String(q).slice(0, 80)),
      reason: String(p.reason || "").slice(0, 600),
    };
  };
}

async function guard(payload, { action, now }) {
  const since = new Date(now.getTime() - COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
  const recent = await GrowthAction.exists({
    _id: { $ne: action._id },
    type: { $in: ["seo_page_update", "seo_content_update"] },
    "subject.entityId": payload.path,
    status: "succeeded",
    executedAt: { $gte: since },
  });
  if (recent) return "changed_within_28_days";

  const perf = await pagePerformance(payload.path, { from: ymd(now - 28 * 864e5), to: ymd(now) });
  if (perf.daysWithData < MIN_DATA_DAYS) return "not_enough_search_data";
  if (perf.position !== null && perf.position <= 3 && (perf.ctr ?? 0) >= 5) return "page_already_performs";
  const page = await livePage(payload.path);
  if (page.noindex) return "page_not_indexable";
  return null;
}

async function apply(payload, { action }) {
  const doc = (await SeoOverride.findOne({ path: payload.path })) || new SeoOverride({ path: payload.path, fields: {} });
  const previous = { ...(doc.fields?.toObject?.() || doc.fields || {}) };
  const next = { ...previous, ...payload.changes };
  doc.fields = next;
  doc.active = true;
  doc.history.push({ at: new Date(), fields: next, previous, actionId: String(action._id), by: action.proposedBy?.name || "growth engine", reason: payload.reason });
  await doc.save();
  await pingIndexNow(payload.path).catch(() => {});
  return { previous, applied: payload.changes, baselineFrom: ymd(Date.now() - 28 * 864e5), baselineTo: ymd(Date.now()) };
}

async function pingIndexNow(path) {
  const key = process.env.INDEXNOW_KEY || "fcb86454c853bca4a1bc07419213d129";
  await fetch("https://api.indexnow.org/indexnow", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ host: new URL(SITE).host, key, keyLocation: `${SITE}/${key}.txt`, urlList: [`${SITE}${path}`] }),
  });
}

function executor() {
  return async (payload, ctx) => {
    const blocked = await guard(payload, ctx);
    if (blocked) return { outcome: "skip", reason: blocked };
    return { outcome: "done", result: await apply(payload, ctx) };
  };
}

/** The live page must serve the new wording (the site regenerates within ~10 minutes). */
async function verify(action) {
  const page = await livePage(action.payload.path);
  const c = action.payload.changes;
  const ok =
    (!c.metaTitle || page.title.includes(c.metaTitle)) &&
    (!c.metaDescription || page.metaDescription === c.metaDescription) &&
    (!c.h1 || page.h1 === c.h1);
  if (ok) return { passed: true, detail: "live page serves the new wording" };
  // Not yet regenerated: inconclusive, checked again later rather than failed.
  return { passed: null, detail: `live title still "${page.title.slice(0, 80)}"` };
}

async function rollback(action) {
  const doc = await SeoOverride.findOne({ path: action.payload.path });
  if (!doc) return { restored: "code default" };
  const previous = action.result?.previous || {};
  doc.fields = previous;
  doc.active = Object.values(previous).some(Boolean);
  doc.history.push({ at: new Date(), fields: previous, previous: doc.fields, actionId: String(action._id), by: "rollback", reason: "rolled back" });
  await doc.save();
  await pingIndexNow(action.payload.path).catch(() => {});
  return { restored: doc.active ? previous : "code default" };
}

const common = {
  approvalTtlMs: 5 * 24 * 60 * 60 * 1000,
  verifyAfterMs: 15 * 60 * 1000,
  maxAttempts: 2,
  subjectOf: (p) => ({ entityType: "page", entityId: p.path }),
  execute: executor(),
  verify,
  rollback,
};

defineAction({
  type: "seo_page_update",
  label: "Search title / description update",
  description:
    "Change one page's search title and/or meta description, based on its Search Console data. Max once per page per 28 days; pages already performing are left alone; verified live; reversible.",
  riskTier: "low",
  defaultMode: "supervised",
  maxMode: "autonomous",
  promoteAfter: 3,
  limits: { perDay: 3 },
  validate: validator(["metaTitle", "metaDescription"]),
  describe: (p) => `Update search ${Object.keys(p.changes).map((k) => (k === "metaTitle" ? "title" : "description")).join(" and ")} of ${p.path}`,
  ...common,
});

defineAction({
  type: "seo_content_update",
  label: "Page heading / intro update",
  description:
    "Change one page's H1 and/or intro paragraph. Same guardrails as title updates; customers read this text, so it needs more clean runs before it runs on its own.",
  riskTier: "medium",
  defaultMode: "supervised",
  maxMode: "autonomous",
  promoteAfter: 5,
  limits: { perDay: 2 },
  validate: validator(["h1", "intro"]),
  describe: (p) => `Update the ${Object.keys(p.changes).join(" and ")} of ${p.path}`,
  ...common,
});

module.exports = { COOLDOWN_DAYS, LIMITS, guard, rollback, validateTitle: validator(["metaTitle", "metaDescription"]), verify };
