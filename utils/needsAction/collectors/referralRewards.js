/**
 * Needs action - referral rewards (utils/referrals), owner only: a reward that
 * is ready for approval, and a refund or chargeback that changed one after it
 * was approved or mailed. Opens Admin > Referrals.
 */
const { PERMISSIONS } = require("../../adminAccess");

const dollars = (c) => `$${(Math.round(Number(c) || 0) / 100).toFixed(2)}`;

module.exports = {
  key: "referral_rewards",
  order: 40,
  permission: PERMISSIONS.ADMIN,
  async collect({ limit = 25 }) {
    const User = require("../../../models/User");
    const { CustomerReferral } = require("../../../models/ReferralProgram");
    const filter = { $or: [{ status: "eligible" }, { attention: { $nin: ["", null] } }] };
    const [count, rows] = await Promise.all([
      CustomerReferral.countDocuments(filter),
      CustomerReferral.find(filter).sort({ updatedAt: 1 }).limit(limit).select("referrer status amountCents attention flags flagsReview payee updatedAt").lean(),
    ]);
    const names = new Map((await User.find({ _id: { $in: rows.map((r) => r.referrer) } }).select("name").lean()).map((u) => [String(u._id), u.name || "Customer"]));
    const items = rows.map((r) => {
      const problem = Boolean(r.attention);
      const flags = (r.flags || []).filter((f) => f.strength !== "info").length;
      return {
        id: String(r._id),
        kind: problem ? "referral_reward_attention" : "referral_reward_ready",
        title: `${problem ? "Referral reward changed" : "Referral reward ready"}: ${names.get(String(r.referrer)) || "Customer"}`,
        subtitle: [dollars(r.amountCents), flags ? `${flags} flag${flags === 1 ? "" : "s"} to review` : "", r.payee?.confirmedAt ? "Payee confirmed" : "Payee not confirmed yet"].filter(Boolean).join(" · "),
        reason: problem ? r.attention : "The friend's second membership payment cleared. Approve, then mail the check.",
        severity: problem ? "problem" : "attention",
        href: `/admin/referrals/${r._id}`,
        at: r.updatedAt || null,
      };
    });
    return { count, items };
  },
};
