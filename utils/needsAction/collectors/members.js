/**
 * Needs action: members. Loaded by utils/needsAction/index.js (directory scan).
 *
 *   payment_issue   Stripe is trying to collect (past_due, unpaid, incomplete,
 *                   paused, or a renewal not on record)        severity problem
 *   ending          a cancellation takes effect within 30 days  severity attention
 *
 * Read only. Statuses come from utils/admin/planStatus, the same answer the
 * customer list and profile give, so the three can never disagree.
 */
const Subscription = require("../../../models/Subscription");
const User = require("../../../models/User");
const { PERMISSIONS } = require("../../adminAccess");
const { formatAddressLine } = require("../../formatAddress");
const { NON_ENDED_STATUSES, loadAddressPlans } = require("../../admin/planStatus");

const ENDING_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const ADMIN_EMAIL = () => String(process.env.MAIL_ADMIN || "getfixter@gmail.com").toLowerCase();

const PLAN = { basic: "Basic", plus: "Plus", premium: "Premium", elite: "Elite" };
const DETAIL = {
  past_due: "Renewal payment failed (past due)",
  unpaid: "Unpaid after retries",
  incomplete: "First payment incomplete",
  paused: "Billing paused",
  renewal_not_recorded: "Billing period ended with no renewal on record",
};
const nyDay = (d) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }).format(d);

async function collect({ now = new Date(), limit = 50 } = {}) {
  const userIds = await Subscription.distinct("user", { status: { $in: NON_ENDED_STATUSES } });
  if (!userIds.length) return { count: 0, items: [] };
  const users = await User.find({ _id: { $in: userIds }, role: { $nin: ["employee", "admin"] }, email: { $ne: ADMIN_EMAIL() }, archivedAt: null })
    .select("name userId addresses defaultAddressId")
    .lean();
  const plans = await loadAddressPlans(users, { now });
  const items = [];
  for (const user of users) {
    const perAddress = plans.get(String(user._id)) || new Map();
    for (const address of user.addresses || []) {
      const s = perAddress.get(String(address._id));
      if (!s) continue;
      const who = user.name || `Customer ${user.userId || ""}`.trim();
      const plan = PLAN[s.lastPlan] || s.lastPlan || "Membership";
      if (s.planStatus === "payment_issue") {
        items.push({
          id: `${user._id}:${address._id}`,
          kind: "member_payment_issue",
          title: `${who}: payment issue`,
          subtitle: `${plan} · ${formatAddressLine(address)}`,
          reason: DETAIL[s.statusDetail] || "Payment issue",
          severity: "problem",
          href: `/admin/customers/${user._id}`,
          at: s.currentPeriodEnd ? new Date(s.currentPeriodEnd).toISOString() : null,
        });
      } else if (s.planStatus === "ending" && s.cancelAt && new Date(s.cancelAt).getTime() - now.getTime() <= ENDING_WINDOW_MS) {
        items.push({
          id: `${user._id}:${address._id}`,
          kind: "member_ending",
          title: `${who}: membership ending`,
          subtitle: `${plan} · ${formatAddressLine(address)}`,
          reason: `Ends ${nyDay(new Date(s.cancelAt))}`,
          severity: "attention",
          href: `/admin/customers/${user._id}`,
          at: new Date(s.cancelAt).toISOString(),
        });
      }
    }
  }
  const rank = { problem: 0, attention: 1 };
  items.sort((a, b) => rank[a.severity] - rank[b.severity] || String(a.at || "").localeCompare(String(b.at || "")));
  return { count: items.length, items: items.slice(0, limit) };
}

module.exports = { key: "members", order: 20, permission: PERMISSIONS.MEMBERS_READ, collect };
