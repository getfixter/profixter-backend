const crypto = require("crypto");
const { checkCopy } = require("../../agents/copyRules");
const { isPaid, PAID_WHY } = require("../../agents/organicOnly");
const { outOfScope, SCOPE_WHY } = require("../acquisitionScope");
const { defineAction } = require("../actionRegistry");

/**
 * Google Business Profile posts - RETIRED as an automatic action (2026-11-12,
 * owner decision Q-6).
 *
 * Posts used to be published autonomously through the GoHighLevel Social
 * Planner under a standing approval. Two of them went live with wrong copy
 * and GoHighLevel could not take them off Google. The GHL path is gone and
 * publishing is impossible in code:
 *
 *   - the type is capped at "shadow" (maxMode), so no stored GrowthPolicy, no
 *     owner button and no switch can make it supervised or autonomous;
 *   - it is no longer in the per-type switch list (actionEngine);
 *   - execute() never publishes: an action that reaches it (an old approval,
 *     an old queue entry) is recorded as skipped with reason "ghl_retired";
 *   - there is no verifier and no rollback, so nothing here ever calls
 *     GoHighLevel or touches a post that is already on Google.
 *
 * The definition stays so historical gbp_post records keep their label and
 * the copy rules (problems/validate) can still check a draft. Odysseus writes
 * Google post text as a content draft (save_content_draft, page_type
 * "gbp_post") for the owner to post by hand.
 */
const TYPE = "gbp_post";
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

const RETIRED_REASON =
  "ghl_retired: Google Business Profile posts are no longer published automatically. Post the text by hand from the content draft.";

/** Never publishes. Recorded on the action as a skip so the owner sees why. */
async function execute() {
  return { outcome: "skip", reason: RETIRED_REASON };
}

defineAction({
  type: TYPE,
  label: "Google Business Profile post",
  description:
    "Retired 2026-11-12: Google Business Profile posts are never published automatically. Kept so past posts keep their history; the owner posts drafted text by hand.",
  platform: "google_business_profile",
  riskTier: "medium",
  // retired: recorded at most, never executed, whatever the stored policy says
  defaultMode: "shadow",
  maxMode: "shadow",
  retiredReason: RETIRED_REASON,
  overLimit: "record",
  limits: { perDay: 1 },
  approvalTtlMs: 3 * 864e5,
  verifyAfterMs: 30 * 60 * 1000,
  maxAttempts: 2,
  validate,
  describe: (p) => `Post on Google Business Profile: "${String(p.title || p.summary).slice(0, 70)}"`,
  subjectOf: (p) => ({ entityType: "gbp_post", entityId: fingerprint(p.summary) }),
  execute,
  verify: null,
  rollback: null,
});

module.exports = { LINK_RE, RETIRED_REASON, TYPE, execute, fingerprint, problems, validate };
