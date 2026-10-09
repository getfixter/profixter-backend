const mongoose = require("mongoose");
const User = require("../../../models/User");
const GrowthAction = require("../../../models/GrowthAction");
const { sendRaw } = require("../../emailService");
const { renderMarketingEmail } = require("../../marketing/marketingRenderer");
const { BUSINESS } = require("../../marketing/marketingConfig");
const {
  isMarketableAccount,
  isUnsubscribed,
  resolveAudience,
} = require("../../marketing/marketingEligibility");
const { defineAction } = require("../actionRegistry");

/**
 * One email to somebody who started a membership checkout and let it expire.
 *
 * Stripe expires an unfinished Checkout Session after 24 hours and tells us
 * (checkout.session.expired). Until now nothing happened next: the person had
 * chosen a plan, reached the card form, and was never heard from again.
 *
 * WHY NOT STRIPE'S OWN RECOVERY LINK. Stripe can mint a link that reopens the
 * expired session for 30 days. It would reopen it with the original
 * parameters - skipping our "this address already has a plan" check, and
 * carrying a gift-coverage trial date computed on the original day. The email
 * sends them to the plans page instead, which creates a fresh, fully checked
 * session.
 *
 * This is commercial email, so it is held to the marketing rules, not the
 * transactional ones: a marketable account, not unsubscribed, with the
 * one-click unsubscribe header. Everything is re-checked when the action runs,
 * not when it was proposed, because a supervised action can sit in the queue
 * for a day and the customer may have subscribed in the meantime.
 *
 * At most one per person per 30 days, however many checkouts they abandon.
 */

const TYPE = "checkout_recovery_email";
const TEMPLATE_KEY = "growth:checkout_recovery_v1";
const REMIND_AT_MOST_EVERY_DAYS = 30;
const PLAN_LABELS = { basic: "Basic", plus: "Plus", premium: "Premium", elite: "Elite" };

function planLabel(plan) {
  return PLAN_LABELS[String(plan || "").toLowerCase()] || null;
}

function maskEmail(email) {
  const [local, domain] = String(email || "").split("@");
  if (!domain) return "";
  return `${local.slice(0, 2)}***@${domain}`;
}

const TEMPLATE = {
  id: "checkout_recovery_v1",
  audience: ["non_member", "former_member"],
  subject: "Still thinking about membership?",
  preheader: "Nothing was charged. Pick up where you left off whenever you're ready.",
  headline: "Pick up where you left off",
  paragraphs: [
    ({ name, plan }) =>
      plan
        ? `Hi ${name}, you started setting up the ${plan} plan but didn't finish checking out. Nothing was charged.`
        : `Hi ${name}, you started setting up a membership but didn't finish checking out. Nothing was charged.`,
    ({ phone }) =>
      `If something didn't work, or you had a question about which plan fits, call us at ${phone} and we'll sort it out.`,
    "Whenever you're ready, choosing your plan again takes about a minute.",
  ],
  ctaLabel: "Finish choosing my plan",
  ctaRoute: "plans",
  closing: "Not the right time? That's fine - this is the only reminder we'll send about it.",
};

function validate(payload = {}) {
  const userId = String(payload.userId || "");
  if (!mongoose.Types.ObjectId.isValid(userId)) throw new Error("checkout_recovery_email needs a userId");
  const stripeSessionId = String(payload.stripeSessionId || "");
  if (!stripeSessionId.startsWith("cs_")) throw new Error("checkout_recovery_email needs a Checkout Session id");
  return {
    userId,
    stripeSessionId,
    plan: planLabel(payload.plan) ? String(payload.plan).toLowerCase() : null,
    billingCycle: payload.billingCycle === "annual" ? "annual" : "monthly",
    sessionCreatedAt: payload.sessionCreatedAt ? new Date(payload.sessionCreatedAt) : null,
  };
}

async function remindedRecently(userId, actionId, now) {
  const since = new Date(now.getTime() - REMIND_AT_MOST_EVERY_DAYS * 24 * 60 * 60 * 1000);
  return GrowthAction.exists({
    _id: { $ne: actionId },
    type: TYPE,
    "subject.entityId": String(userId),
    status: { $in: ["succeeded", "running"] },
    executedAt: { $gte: since },
  });
}

async function execute(payload, { action, now }) {
  const user = await User.findById(payload.userId).select(
    "_id userId email name firstName role isActive employeePosition excludeFromMarketing"
  );
  if (!user) return { outcome: "skip", reason: "user_not_found" };
  if (!isMarketableAccount(user)) return { outcome: "skip", reason: "not_marketable" };
  if (await isUnsubscribed(user.email)) return { outcome: "skip", reason: "unsubscribed" };

  const { audience } = await resolveAudience(user, now);
  if (audience === "member") return { outcome: "skip", reason: "already_member" };
  if (await remindedRecently(user._id, action._id, now)) {
    return { outcome: "skip", reason: "reminded_recently" };
  }

  const rendered = renderMarketingEmail(TEMPLATE, {
    name: String(user.firstName || user.name || "there").split(" ")[0],
    email: user.email,
    audience,
    vars: { plan: planLabel(payload.plan), phone: BUSINESS.phone },
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
      templateKey: TEMPLATE_KEY,
      emailType: "marketing",
      source: "growth_engine",
      userId: user.userId || String(user._id),
      recipientName: user.firstName || user.name || "",
    },
  });

  return {
    outcome: "done",
    result: {
      to: maskEmail(user.email),
      messageId: String(info?.messageId || "").trim() || null,
      audience,
    },
  };
}

/** The provider accepted it. Whether they came back is an outcome, measured in the Command Center. */
async function verify(action) {
  if (action.result?.messageId) return { passed: true, detail: "accepted by the mail provider" };
  return { passed: false, detail: "no provider message id" };
}

defineAction({
  type: TYPE,
  label: "Abandoned checkout email",
  description:
    "One email to a customer whose membership checkout expired unpaid, sending them back to the plans page. Marketing rules apply; at most one per person per 30 days.",
  riskTier: "medium",
  defaultMode: "supervised",
  maxMode: "autonomous",
  promoteAfter: 5,
  limits: { perDay: 15 },
  approvalTtlMs: 3 * 24 * 60 * 60 * 1000,
  verifyAfterMs: 5 * 60 * 1000,
  maxAttempts: 3,
  validate,
  describe: (p) =>
    `Email a customer who left ${planLabel(p.plan) ? `the ${planLabel(p.plan)} (${p.billingCycle})` : "a membership"} checkout`,
  subjectOf: (p) => ({ entityType: "user", entityId: p.userId }),
  execute,
  verify,
});

module.exports = { TYPE, TEMPLATE, validate, execute, verify };
