// 📁 backend/routes/referrals.js
/**
 * Customer referral program, the customer's side (utils/referrals).
 *
 *   GET  /api/referrals/me                    personal link + the rewards it earned
 *   POST /api/referrals/claim                 record the referral a signed-in browser holds
 *   POST /api/referrals/rewards/:id/payee     where to mail the check (signed in + confirm it's you)
 *   POST /api/referrals/accept                the 2025 "enter a referral ID" form, kept for old clients
 *
 * Any signed-in customer can refer, member or not. Staff accounts have no link.
 */
const express = require("express");
const jwt = require("jsonwebtoken");
const router = express.Router();
const User = require("../models/User");
const Referral = require("../models/Referral");
const { CustomerReferral } = require("../models/ReferralProgram");
const auth = require("../middleware/auth");
const codes = require("../utils/referrals/codes");
const engine = require("../utils/referrals/engine");
const notify = require("../utils/referrals/notify");

const FRESH_SESSION_MS = 10 * 60 * 1000;

/** The same rule as changing a verified email or phone (routes/authV2): a fresh sign-in or a fresh code. */
function recentlyConfirmed(req, user) {
  const sessions = require("../utils/auth/sessions");
  const accounts = require("../utils/auth/accounts");
  try {
    const header = String(req.headers.authorization || "");
    const token = header.startsWith("Bearer ") ? header.slice(7) : String(req.headers["x-auth-token"] || "");
    const session = jwt.verify(token, process.env.JWT_SECRET);
    if (!sessions.isPurposeToken(session) && session?.iat && Date.now() - session.iat * 1000 <= FRESH_SESSION_MS) return true;
  } catch {
    /* auth already refused a bad session */
  }
  const proof = String(req.body?.reauthToken || "");
  if (!proof) return false;
  try {
    const decoded = jwt.verify(proof, process.env.JWT_SECRET);
    return decoded?.purpose === "reauth" && String(decoded.id) === String(user._id) && accounts.sessionIsCurrent(decoded, user);
  } catch {
    return false;
  }
}

const STATUS_LABEL = {
  attributed: "Joined, no membership yet",
  pending: "Pending",
  eligible: "Ready",
  approved: "Approved",
  mailed: "Check mailed",
  void: "No reward",
  not_eligible: "Doesn't qualify",
};

function customerView(doc, friend) {
  const p = doc.payee || {};
  const open = ["pending", "eligible", "approved"].includes(doc.status);
  return {
    id: String(doc._id),
    friend,
    status: doc.status,
    statusLabel: STATUS_LABEL[doc.status] || doc.status,
    amountCents: doc.status === "mailed" ? doc.approval?.amountCents || doc.amountCents : doc.amountCents,
    plan: notify.PLAN_LABEL[doc.first?.plan] || null,
    joinedAt: doc.createdAt,
    firstPaidAt: doc.first?.paidAt || null,
    secondPaidAt: doc.second?.paidAt || null,
    mailedAt: doc.check?.mailedAt || null,
    // Why there is no reward, in the customer's terms (never the owner's flags).
    note:
      doc.status === "void"
        ? "Their membership payment was refunded, so this referral doesn't earn a reward."
        : doc.status === "not_eligible"
          ? "They already had a Profixter membership, so this referral doesn't qualify."
          : doc.status === "attributed"
            ? "The reward starts when they pay for a membership."
            : doc.status === "pending"
              ? "Ready after their second membership payment."
              : "",
    payee: p.confirmedAt
      ? { confirmed: true, name: p.name, address: [p.line1, p.line2, `${p.city}, ${p.state} ${p.zip}`].filter(Boolean).join(", ") }
      : { confirmed: false },
    needsPayee: open && !p.confirmedAt,
    canEditPayee: open,
  };
}

async function signedInCustomer(req) {
  const user = await User.findById(req.user.id).lean();
  if (!user) return null;
  return user;
}

router.get("/me", auth, async (req, res) => {
  try {
    const user = await signedInCustomer(req);
    if (!user) return res.status(401).json({ message: "Please sign in again." });
    if (!codes.isCustomerAccount(user)) return res.json({ eligible: false, code: null, url: null, rewards: [] });
    const code = await codes.codeFor(user);
    const rows = await CustomerReferral.find({ referrer: user._id }).sort({ createdAt: -1 }).limit(100).lean();
    const friends = new Map((await User.find({ _id: { $in: rows.map((r) => r.referred) } }).select("name firstName lastName").lean()).map((u) => [String(u._id), notify.friendLabel(u)]));
    const rewards = rows.map((r) => customerView(r, friends.get(String(r.referred)) || "Your friend"));
    const sum = (statuses) => rewards.filter((r) => statuses.includes(r.status)).reduce((s, r) => s + (r.amountCents || 0), 0);
    return res.json({
      eligible: true,
      code,
      url: codes.shareUrl(code),
      rewards,
      totals: { pendingCents: sum(["pending"]), readyCents: sum(["eligible", "approved"]), mailedCents: sum(["mailed"]) },
    });
  } catch (error) {
    console.error("referrals/me failed:", error.message);
    return res.status(500).json({ message: "Your referral link couldn't be loaded. Please try again." });
  }
});

router.post("/claim", auth, async (req, res) => {
  try {
    const user = await signedInCustomer(req);
    if (!user) return res.status(401).json({ message: "Please sign in again." });
    const carried = engine.referralFromBody(req.body) || (req.body?.code ? { code: String(req.body.code).slice(0, 200), capturedAt: req.body.capturedAt } : null);
    if (!carried) return res.status(400).json({ message: "No referral code.", reason: "no_code" });
    const result = await engine.bindReferral({ user, code: carried.code, capturedAt: carried.capturedAt, via: "claim" });
    // Always 200: the browser forgets the code either way; the reason says why nothing was recorded.
    return res.json({ recorded: result.reason === "recorded", reason: result.reason });
  } catch (error) {
    console.error("referrals/claim failed:", error.message);
    return res.status(500).json({ message: "Server error" });
  }
});

router.post("/rewards/:id/payee", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(401).json({ message: "Please sign in again." });
    if (!/^[a-f0-9]{24}$/i.test(String(req.params.id))) return res.status(404).json({ message: "Referral not found." });
    const owned = await CustomerReferral.exists({ _id: req.params.id, referrer: user._id });
    if (!owned) return res.status(404).json({ message: "Referral not found." });
    if (!recentlyConfirmed(req, user)) return res.status(403).json({ code: "REAUTH_REQUIRED", message: "Please confirm it's you first." });
    const doc = await engine.setPayee(req.params.id, req.body, { by: `customer:${user._id}`, actor: "customer", actorUserId: user._id });
    await notify.referrerPayeeSaved(doc);
    const friend = notify.friendLabel(await User.findById(doc.referred).select("name firstName lastName").lean());
    return res.json({ reward: customerView(doc.toObject(), friend) });
  } catch (error) {
    if (error instanceof engine.ReferralError) return res.status(error.status).json({ code: error.code, message: error.message });
    console.error("referrals payee failed:", error.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// Accept Referral (2025 form: an 8-digit referral ID). Kept, and now also recorded in the referral program.
router.post("/accept", auth, async (req, res) => {
  try {
    const { referralId } = req.body;
    const currentUser = await User.findById(req.user.id);

    if (!referralId || referralId.length !== 8)
      return res.status(400).json({ message: "Invalid referral ID format." });

    if (referralId === currentUser.userId)
      return res.status(400).json({ message: "You cannot refer yourself." });

    const referrer = await User.findOne({ userId: referralId });
    if (!referrer)
      return res.status(404).json({ message: "Referral ID not found." });

    const existing = await Referral.findOne({ "receiver.userId": currentUser.userId });
    if (existing)
      return res.status(400).json({ message: "Referral already accepted." });

    const newReferral = new Referral({
      referrer: {
        userId: referrer.userId,
        name: referrer.name,
        address: referrer.address,
      },
      receiver: {
        userId: currentUser.userId,
        name: currentUser.name,
        address: currentUser.address,
      },
      acceptedAt: new Date(),
    });

    await newReferral.save();
    await engine.bindReferral({ user: currentUser, code: referralId, via: "legacy_accept" });
    res.json({
      message: "Referral accepted!",
      referrer: {
        userId: referrer.userId,
        name: referrer.name,
      },
    });
  } catch (err) {
    console.error("❌ Referral error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
