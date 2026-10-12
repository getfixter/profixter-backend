const crypto = require("crypto");
const GrowthAction = require("../../../models/GrowthAction");
const { checkCopy } = require("../../agents/copyRules");
const { isPaid, PAID_WHY } = require("../../agents/organicOnly");
const { outOfScope, SCOPE_WHY } = require("../acquisitionScope");
const { defineAction } = require("../actionRegistry");

/**
 * One organic Google Business Profile post, published through the Social
 * Planner (utils/ghl/socialPlanner.js), with a "Book" button to the free
 * first visit on profixter.com.
 *
 * Checked before it can even be proposed: the business copy rules (no
 * prices, discounts, "unlimited", inspection/estimate wording, claimed
 * reviews), 100% organic (nothing paid), acquisition only, no contact details
 * of anyone, and the button must go to www.profixter.com/book/free tagged
 * utm_source=google&utm_medium=organic so the bookings it brings are counted.
 * Re-checked at run time, with at most one post every 3 days and never the
 * same text twice.
 *
 * Trust: the owner gave STANDING APPROVAL (2026-10-12) - it starts autonomous,
 * no per-post approval. It acts only while the owner has turned this one type
 * on (GROWTH_ACTIONS_ENABLED_TYPES=gbp_post; customer messages and website
 * changes stay off). Verified by reading the post's status back from the
 * Social Planner; a post not published within 6 hours, or reported failed,
 * fails verification - and the FIRST failure suspends posting completely
 * (shadow) until the owner resumes it. Rollback deletes the post.
 */
const TYPE = "gbp_post";
const MIN_GAP_DAYS = 3;
const PUBLISH_DEADLINE_MS = 6 * 60 * 60 * 1000;
const LINK_RE = /^https:\/\/www\.profixter\.com\/book\/free\?(?=[^\s]*utm_source=google)(?=[^\s]*utm_medium=organic)[^\s]*$/;

function fingerprint(text) {
  return crypto.createHash("sha256").update(String(text).toLowerCase().replace(/\s+/g, " ").trim()).digest("hex").slice(0, 24);
}

function problems(p) {
  const out = [];
  const summary = String(p.summary || "").trim();
  if (summary.length < 80 || summary.length > 1400) out.push("The post text must be 80-1400 characters.");
  if (p.title && String(p.title).length > 58) out.push("Keep the title under 58 characters.");
  if (!LINK_RE.test(String(p.url || ""))) out.push("The button link must be https://www.profixter.com/book/free?... tagged utm_source=google&utm_medium=organic.");
  if (/https?:\/\//i.test(summary)) out.push("No links in the text - the Book button carries the link.");
  if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(summary) || /\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/.test(summary)) out.push("No email addresses or phone numbers in the text.");
  const text = `${p.title || ""}\n${summary}`;
  out.push(...checkCopy(text));
  if (isPaid(text)) out.push(PAID_WHY);
  if (outOfScope(text)) out.push(SCOPE_WHY);
  return out;
}

function validate(p = {}) {
  const payload = { summary: String(p.summary || "").trim(), title: p.title ? String(p.title).trim() : "", url: String(p.url || "").trim(), reason: String(p.reason || "").slice(0, 600) };
  const bad = problems(payload);
  if (bad.length) throw new Error(`gbp_post refused: ${bad.join(" ")}`);
  return payload;
}

async function execute(payload, { action, now }) {
  const social = require("../../ghl/socialPlanner");
  const bad = problems(payload);
  if (bad.length) return { outcome: "skip", reason: `rules_failed: ${bad.join(" ").slice(0, 200)}` };
  if (!social.config().configured) return { outcome: "skip", reason: "not_connected" };
  const since = new Date(now.getTime() - MIN_GAP_DAYS * 864e5);
  const recent = await GrowthAction.exists({ _id: { $ne: action._id }, type: TYPE, status: "succeeded", executedAt: { $gte: since } });
  if (recent) return { outcome: "skip", reason: "posted_recently" };
  const fp = fingerprint(payload.summary);
  if (await GrowthAction.exists({ _id: { $ne: action._id }, type: TYPE, status: "succeeded", "result.fingerprint": fp })) return { outcome: "skip", reason: "duplicate_text" };
  const r = await social.createGbpPost({ summary: payload.summary, title: payload.title, url: payload.url, now });
  return { outcome: "done", result: { platform: "google_business_profile", postId: r.postId, account: r.account, scheduledFor: r.scheduledFor, fingerprint: fp, estimatedCostCents: 0 } };
}

/** Published = verified (with its public link when the Social Planner reports one); failed = failed. */
async function verify(action, { now = new Date() } = {}) {
  const social = require("../../ghl/socialPlanner");
  const s = await social.postStatus(action.result?.postId);
  if (s.status === "published") return { passed: true, detail: `published${s.link ? ` at ${s.link}` : " (the Social Planner reported no public link)"}` };
  if (["failed", "deleted"].includes(s.status)) return { passed: false, detail: `Social Planner status ${s.status}${s.error ? `: ${String(s.error).slice(0, 200)}` : ""}` };
  // a post that has not gone out within 6 hours is a failure, not "still waiting" for a week
  if (action.executedAt && now - new Date(action.executedAt) > PUBLISH_DEADLINE_MS) return { passed: false, detail: `not published within 6 hours (Social Planner status ${s.status})` };
  return { passed: null, detail: `still ${s.status}` };
}

async function rollback(action) {
  if (!action.result?.postId) return { restored: "nothing was posted" };
  return require("../../ghl/socialPlanner").deletePost(action.result.postId);
}

defineAction({
  type: TYPE,
  label: "Google Business Profile post",
  description:
    "Publish one organic post on Profixter's Google Business Profile with a Book button to the free first visit. Copy rules, organic-only and acquisition-only checks; at most one post every 3 days, never the same text twice; verified by reading the post back; rollback deletes it.",
  platform: "google_business_profile",
  riskTier: "medium",
  // owner's standing approval (2026-10-12): no per-post approval; the first failure suspends
  defaultMode: "autonomous",
  maxMode: "autonomous",
  promoteAfter: null,
  suspendAfterFailures: 1,
  overLimit: "record",
  limits: { perDay: 1 },
  approvalTtlMs: 3 * 864e5,
  verifyAfterMs: 30 * 60 * 1000,
  maxAttempts: 2,
  validate,
  describe: (p) => `Post on Google Business Profile: "${String(p.title || p.summary).slice(0, 70)}"`,
  subjectOf: (p) => ({ entityType: "gbp_post", entityId: fingerprint(p.summary) }),
  execute,
  verify,
  rollback,
});

module.exports = { LINK_RE, MIN_GAP_DAYS, TYPE, execute, problems, validate, verify };
