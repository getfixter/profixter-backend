const mongoose = require("mongoose");
const User = require("../../../models/User");
const EmailPlaybook = require("../../../models/EmailPlaybook");
const GrowthAction = require("../../../models/GrowthAction");
const MarketingSend = require("../../../models/MarketingSend");
const { sendRaw } = require("../../emailService");
const { renderMarketingEmail } = require("../../marketing/marketingRenderer");
const { isMarketableAccount, isUnsubscribed } = require("../../marketing/marketingEligibility");
const { checkCopy } = require("../../agents/copyRules");
const { segmentDef } = require("../segments");
const { defineAction } = require("../actionRegistry");

/**
 * One approved playbook email to one customer in the playbook's segment.
 *
 * Email only - marketing SMS consent covers almost nobody, and email follows
 * the opt-out model with a one-click unsubscribe. Every send re-checks, at
 * the moment it runs:
 *   - the playbook is still approved, at the version the owner approved
 *   - the wording still passes the copy rules (no discounts, prices, claims)
 *   - the person is a marketable account and not unsubscribed
 *   - the person is STILL in the segment (they may have booked or joined)
 *   - no other marketing or playbook email reached them in the last 4 days
 *   - they have never received this playbook (idempotency key per person)
 *
 * Starts in SHADOW: the Command Center lists exactly who would receive it,
 * which is how the audience is verified before anything is sent.
 */
const TYPE = "playbook_email";
const QUIET_DAYS = 4;

function validate(p = {}) {
  if (!mongoose.Types.ObjectId.isValid(String(p.userId || ""))) throw new Error("playbook_email needs a userId");
  const playbookKey = String(p.playbookKey || "");
  if (!/^[a-z0-9_-]{3,60}$/.test(playbookKey)) throw new Error("playbook_email needs a playbookKey");
  return { userId: String(p.userId), playbookKey, version: Number(p.version) || null };
}

function templateOf(pb) {
  return {
    id: `playbook_${pb.key}`,
    audience: ["non_member", "member", "former_member"],
    subject: pb.subject,
    preheader: pb.preheader,
    headline: pb.headline,
    paragraphs: [({ name }) => `Hi ${name},`, ...pb.paragraphs],
    ctaLabel: pb.ctaLabel,
    ctaRoute: pb.ctaRoute,
    closing: pb.closing,
  };
}

function playbookText(pb) {
  return [pb.subject, pb.preheader, pb.headline, ...(pb.paragraphs || []), pb.ctaLabel, pb.closing].join("\n");
}

async function recentlyEmailed(user, actionId, now) {
  const since = new Date(now.getTime() - QUIET_DAYS * 24 * 60 * 60 * 1000);
  const [marketing, playbook] = await Promise.all([
    MarketingSend.exists({ user: user._id, status: "sent", sentAt: { $gte: since } }),
    GrowthAction.exists({ _id: { $ne: actionId }, type: TYPE, "subject.entityId": String(user._id), status: "succeeded", executedAt: { $gte: since } }),
  ]);
  return Boolean(marketing || playbook);
}

async function execute(payload, { action, now }) {
  const pb = await EmailPlaybook.findOne({ key: payload.playbookKey }).lean();
  if (!pb || pb.status !== "approved") return { outcome: "skip", reason: "playbook_not_approved" };
  if (pb.approvedVersion !== pb.version) return { outcome: "skip", reason: "playbook_changed_since_approval" };
  if (checkCopy(playbookText(pb)).length) return { outcome: "skip", reason: "copy_rules_failed" };

  const user = await User.findById(payload.userId).select(
    "_id userId email name firstName role isActive employeePosition excludeFromMarketing createdAt"
  );
  if (!user) return { outcome: "skip", reason: "user_not_found" };
  if (!isMarketableAccount(user)) return { outcome: "skip", reason: "not_marketable" };
  if (await isUnsubscribed(user.email)) return { outcome: "skip", reason: "unsubscribed" };
  const seg = segmentDef(pb.segment);
  if (!seg || !(await seg.includes(user, { now }))) return { outcome: "skip", reason: "no_longer_in_segment" };
  if (await recentlyEmailed(user, action._id, now)) return { outcome: "skip", reason: "emailed_recently" };

  const rendered = renderMarketingEmail(templateOf(pb), {
    name: String(user.firstName || user.name || "there").split(" ")[0],
    email: user.email,
  });
  const info = await sendRaw({
    to: user.email,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    headers: {
      "List-Unsubscribe": `<${rendered.unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    logContext: {
      templateKey: `playbook:${pb.key}`,
      emailType: "marketing",
      source: "growth_engine",
      userId: user.userId || String(user._id),
      recipientName: user.firstName || user.name || "",
    },
  });
  const [local, domain] = String(user.email).split("@");
  return {
    outcome: "done",
    result: { to: `${local.slice(0, 2)}***@${domain}`, messageId: String(info?.messageId || "") || null, playbook: pb.key, version: pb.version },
  };
}

defineAction({
  type: TYPE,
  label: "Approved follow-up email",
  description:
    "One email from an owner-approved playbook to one customer in its segment. Email only, marketing rules, unsubscribe honoured, at most one per person per playbook, nothing within 4 days of another marketing email.",
  riskTier: "medium",
  defaultMode: "shadow",
  maxMode: "autonomous",
  promoteAfter: 5,
  limits: { perDay: 12 },
  approvalTtlMs: 3 * 24 * 60 * 60 * 1000,
  verifyAfterMs: 5 * 60 * 1000,
  maxAttempts: 2,
  validate,
  describe: (p) => `Send the "${p.playbookKey}" follow-up email to one customer`,
  subjectOf: (p) => ({ entityType: "user", entityId: p.userId }),
  execute,
  verify: async (a) => (a.result?.messageId ? { passed: true, detail: "accepted by the mail provider" } : { passed: false, detail: "no message id" }),
});

/** Hourly: propose one send per person for every approved playbook (idempotent). */
async function proposePlaybookEmails({ propose, now = new Date() } = {}) {
  const playbooks = await EmailPlaybook.find({ status: "approved" }).lean();
  let proposed = 0;
  for (const pb of playbooks) {
    if (pb.approvedVersion !== pb.version) continue;
    const seg = segmentDef(pb.segment);
    if (!seg) continue;
    const ids = await seg.members({ now, limit: 50 });
    for (const userId of ids) {
      const { created } = await propose(
        TYPE,
        { userId, playbookKey: pb.key, version: pb.version },
        {
          idempotencyKey: `${TYPE}:${pb.key}:${userId}`,
          rationale: `In segment "${pb.segment}". Playbook purpose: ${pb.purpose || "-"}`.slice(0, 500),
          proposedBy: { kind: "system", name: `Playbook: ${pb.name}` },
          now,
        }
      );
      if (created) proposed += 1;
    }
  }
  return { proposed };
}

module.exports = { TYPE, execute, playbookText, proposePlaybookEmails, templateOf, validate };
