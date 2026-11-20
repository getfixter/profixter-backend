/**
 * Admin > Referrals: the owner's referral rewards (utils/referrals). OWNER ONLY.
 *
 *   GET  /api/admin/referral-rewards?status=ready|pending|approved|mailed|closed|all
 *   GET  /api/admin/referral-rewards/:id
 *   POST /api/admin/referral-rewards/:id/recheck        every number again from Stripe
 *   POST /api/admin/referral-rewards/:id/flags/clear    { note }
 *   POST /api/admin/referral-rewards/:id/payee          { name, line1, line2, city, state, zip, note }
 *   POST /api/admin/referral-rewards/:id/approve        { expectedAmountCents, payeeConfirmed: true }
 *   POST /api/admin/referral-rewards/:id/mailed         { reference, mailedAt, note }
 *   POST /api/admin/referral-rewards/:id/void           { reason }
 *   POST /api/admin/referral-rewards/:id/acknowledge    { note }  (closes a refund/chargeback notice)
 *
 * Approve and Mailed each re-read Stripe first and refuse (409) when anything
 * changed. The owner writes and mails the check; nothing here moves money.
 * (The 2025 list GET /api/admin/referrals in routes/admin.js is unchanged.)
 */
const express = require("express");
const auth = require("../middleware/auth");
const { loadAccessUser } = require("../middleware/authorize");
const User = require("../models/User");
const { CustomerReferral } = require("../models/ReferralProgram");
const engine = require("../utils/referrals/engine");
const { flagsCleared, blockingFlags } = require("../utils/referrals/signals");
const { REWARD_CAP_CENTS, annualQualifiesAt } = require("../utils/referrals/amounts");
const { PLAN_LABEL } = require("../utils/referrals/notify");
const { createAdminActivityLog } = require("../utils/adminActivityLog");

const router = express.Router();

function ownerOnly(req, res, next) {
  if (req.accessRole !== "admin") return res.status(403).json({ message: "Only the owner can see referral rewards.", code: "FORBIDDEN" });
  return next();
}
router.use(auth, loadAccessUser, ownerOnly);

const STATUS_LABEL = {
  attributed: "Signed up",
  pending: "Pending",
  eligible: "Ready",
  approved: "Approved",
  mailed: "Mailed",
  void: "Void",
  not_eligible: "Not eligible",
};
const FILTERS = {
  ready: { $or: [{ status: "eligible" }, { attention: { $nin: ["", null] } }] },
  pending: { status: { $in: ["attributed", "pending"] } },
  approved: { status: "approved" },
  mailed: { status: "mailed" },
  closed: { status: { $in: ["void", "not_eligible"] } },
  all: {},
};

const person = (u) => (u ? { id: String(u._id), name: u.name || "", email: u.email || "", phone: u.phone || "", userId: u.userId || "" } : null);

async function people(rows) {
  const ids = [...new Set(rows.flatMap((r) => [String(r.referrer), String(r.referred)]))];
  const users = await User.find({ _id: { $in: ids } }).select("name email phone userId addresses createdAt").lean();
  return new Map(users.map((u) => [String(u._id), u]));
}

function row(doc, users) {
  const open = blockingFlags(doc.flags).length;
  return {
    id: String(doc._id),
    status: doc.status,
    statusLabel: STATUS_LABEL[doc.status] || doc.status,
    referrer: person(users.get(String(doc.referrer))),
    referred: person(users.get(String(doc.referred))),
    amountCents: doc.amountCents,
    plan: PLAN_LABEL[doc.first?.plan] || null,
    cycle: doc.first?.cycle || null,
    firstPaidAt: doc.first?.paidAt || null,
    secondPaidAt: doc.second?.paidAt || null,
    flagCount: open,
    flagsCleared: flagsCleared(doc),
    attention: doc.attention || "",
    payeeConfirmed: Boolean(doc.payee?.confirmedAt),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function detail(doc, users) {
  const reviewed = new Set(doc.flagsReview?.codes || []);
  const inv = (x) =>
    x?.invoiceId
      ? {
          invoiceId: x.invoiceId,
          subscriptionId: x.subscriptionId,
          chargeId: x.chargeId,
          billingReason: x.billingReason,
          paidAt: x.paidAt,
          plan: PLAN_LABEL[x.plan] || x.plan,
          cycle: x.cycle,
          baseCents: x.baseCents,
          discountCents: x.discountCents,
          taxCents: x.taxCents,
          amountPaidCents: x.amountPaidCents,
          paidPreTaxCents: x.paidPreTaxCents,
          refundedCents: x.refundedCents,
          refundedPreTaxCents: x.refundedPreTaxCents,
          disputed: x.disputed,
          discountSource: x.discountSource,
          promoCode: x.promoCode,
          stripeUrl: `https://dashboard.stripe.com/invoices/${x.invoiceId}`,
        }
      : null;
  return {
    ...row(doc, users),
    code: doc.code,
    via: doc.via,
    reason: doc.reason || "",
    capCents: REWARD_CAP_CENTS,
    first: inv(doc.first),
    second: inv(doc.second),
    // Which rule decides: monthly - the second paid invoice; annual - 60 days of active membership.
    rule: doc.first?.cycle === "annual" ? "annual" : "monthly",
    qualifiesAt: doc.first?.cycle === "annual" ? annualQualifiesAt(doc.first) : null,
    membership: doc.membership?.checkedAt ? { status: doc.membership.status, endedAt: doc.membership.endedAt, checkedAt: doc.membership.checkedAt } : null,
    flags: (doc.flags || []).map((f) => ({ code: f.code, strength: f.strength, text: f.text, at: f.at, reviewed: f.strength === "info" || reviewed.has(f.code) })),
    flagsReview: doc.flagsReview?.clearedAt ? { at: doc.flagsReview.clearedAt, note: doc.flagsReview.note, codes: doc.flagsReview.codes } : null,
    payee: doc.payee?.confirmedAt ? { ...doc.payee } : null,
    approval: doc.approval?.at ? { at: doc.approval.at, amountCents: doc.approval.amountCents } : null,
    check: doc.check?.mailedAt ? { reference: doc.check.reference, mailedAt: doc.check.mailedAt, note: doc.check.note } : null,
    lastRecheck: doc.lastRecheck?.at ? doc.lastRecheck : null,
    history: [...(doc.history || [])].reverse().slice(0, 100),
    canApprove: doc.status === "eligible" && Boolean(doc.payee?.confirmedAt) && flagsCleared(doc),
  };
}

const plain = (doc) => (doc?.toObject ? doc.toObject() : doc);
const byLabel = (req) => `owner:${req.accessUser?._id || ""}`;
const audit = (req, action, doc, details = {}) =>
  createAdminActivityLog(req, { action, entityType: "referral_reward", entityId: doc?._id, entityName: "Referral reward", details }).catch(() => null);

async function respond(res, doc) {
  const d = plain(doc);
  return res.json({ reward: detail(d, await people([d])) });
}

function fail(res, error) {
  if (error instanceof engine.ReferralError) {
    const extra = {};
    if (error.changes) extra.changes = error.changes;
    return (async () => {
      if (error.referral) {
        const d = plain(error.referral);
        extra.reward = detail(d, await people([d]));
      }
      return res.status(error.status).json({ code: error.code, message: error.message, ...extra });
    })();
  }
  console.error("admin referral rewards failed:", error);
  return res.status(500).json({ message: "Something went wrong. Nothing was changed." });
}

const validId = (req, res, next) => (/^[a-f0-9]{24}$/i.test(String(req.params.id)) ? next() : res.status(404).json({ message: "Referral not found." }));

router.get("/", async (req, res) => {
  try {
    const key = Object.hasOwn(FILTERS, String(req.query.status)) ? String(req.query.status) : "ready";
    const rows = await CustomerReferral.find(FILTERS[key]).sort({ updatedAt: -1 }).limit(200).lean();
    const users = await people(rows);
    const [ready, pending, approved, attention] = await Promise.all([
      CustomerReferral.countDocuments({ status: "eligible" }),
      CustomerReferral.countDocuments(FILTERS.pending),
      CustomerReferral.countDocuments({ status: "approved" }),
      CustomerReferral.countDocuments({ attention: { $nin: ["", null] } }),
    ]);
    return res.json({ status: key, counts: { ready, pending, approved, attention }, rewards: rows.map((r) => row(r, users)) });
  } catch (error) {
    return fail(res, error);
  }
});

router.get("/:id", validId, async (req, res) => {
  try {
    const doc = await CustomerReferral.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ message: "Referral not found." });
    return respond(res, doc);
  } catch (error) {
    return fail(res, error);
  }
});

router.post("/:id/recheck", validId, async (req, res) => {
  try {
    const result = await engine.recheck(req.params.id, { by: byLabel(req) });
    if (!result.referral) return res.status(404).json({ message: "Referral not found." });
    await audit(req, "Referral Reward Rechecked", result.referral, { ok: result.ok, changes: result.changes });
    const d = plain(result.referral);
    return res.json({ ok: result.ok, changes: result.changes, reward: detail(d, await people([d])) });
  } catch (error) {
    return fail(res, error);
  }
});

router.post("/:id/flags/clear", validId, async (req, res) => {
  try {
    const doc = await engine.clearFlags(req.params.id, { note: req.body?.note, byUserId: req.accessUser._id, by: byLabel(req) });
    if (!doc) return res.status(404).json({ message: "Referral not found." });
    await audit(req, "Referral Reward Flags Reviewed", doc, { note: String(req.body?.note || "").slice(0, 500) });
    return respond(res, doc);
  } catch (error) {
    return fail(res, error);
  }
});

router.post("/:id/payee", validId, async (req, res) => {
  try {
    const doc = await engine.setPayee(req.params.id, req.body, { by: byLabel(req), actor: "owner", note: req.body?.note });
    if (!doc) return res.status(404).json({ message: "Referral not found." });
    await audit(req, "Referral Reward Payee Confirmed", doc, { note: String(req.body?.note || "").slice(0, 300) });
    await require("../utils/referrals/notify").referrerPayeeSaved(doc);
    return respond(res, doc);
  } catch (error) {
    return fail(res, error);
  }
});

router.post("/:id/approve", validId, async (req, res) => {
  try {
    const doc = await engine.approve(req.params.id, {
      expectedAmountCents: req.body?.expectedAmountCents,
      payeeConfirmed: req.body?.payeeConfirmed,
      byUserId: req.accessUser._id,
      by: byLabel(req),
    });
    await audit(req, "Referral Reward Approved", doc, { amountCents: doc.approval?.amountCents });
    return respond(res, doc);
  } catch (error) {
    return fail(res, error);
  }
});

router.post("/:id/mailed", validId, async (req, res) => {
  try {
    const doc = await engine.markMailed(req.params.id, { reference: req.body?.reference, mailedAt: req.body?.mailedAt, note: req.body?.note, byUserId: req.accessUser._id, by: byLabel(req) });
    await audit(req, "Referral Reward Check Mailed", doc, { reference: doc.check?.reference, amountCents: doc.approval?.amountCents });
    return respond(res, doc);
  } catch (error) {
    return fail(res, error);
  }
});

router.post("/:id/void", validId, async (req, res) => {
  try {
    const doc = await engine.voidReward(req.params.id, { reason: req.body?.reason, by: byLabel(req) });
    if (!doc) return res.status(404).json({ message: "Referral not found." });
    await audit(req, "Referral Reward Voided", doc, { reason: String(req.body?.reason || "").slice(0, 300) });
    return respond(res, doc);
  } catch (error) {
    return fail(res, error);
  }
});

router.post("/:id/acknowledge", validId, async (req, res) => {
  try {
    const doc = await engine.acknowledge(req.params.id, { note: req.body?.note, by: byLabel(req) });
    if (!doc) return res.status(404).json({ message: "Referral not found." });
    return respond(res, doc);
  } catch (error) {
    return fail(res, error);
  }
});

module.exports = router;
