const Booking = require("../../models/Booking");
const Subscription = require("../../models/Subscription");
const User = require("../../models/User");
const { resolveAudience } = require("../marketing/marketingEligibility");

/**
 * The only audiences an email playbook can target, each a fixed, reviewable
 * rule over live data. Agents choose among these; they cannot write queries.
 *
 * `members()` lists candidate user ids (cheap pre-filter, capped); `includes()`
 * re-checks ONE person at send time, because a supervised send can wait days
 * and people move between segments (book, join, change their mind).
 */
const DAY = 24 * 60 * 60 * 1000;
const COMPLETED = /complete|done/i;

async function freeVisitState(userId) {
  const visits = await Booking.find({ user: userId, isFreeFirstVisit: true }).select("status completedAt").lean();
  const completed = visits
    .filter((b) => b.completedAt || COMPLETED.test(String(b.status || "")))
    .map((b) => new Date(b.completedAt || 0))
    .sort((a, b) => b - a);
  return { any: visits.length > 0, lastCompletedAt: completed[0] || null };
}

const SEGMENT_DEFS = {
  free_visit_undecided: {
    label: "Had the free visit 3-60 days ago, not a member",
    async members({ now = new Date(), limit = 100 } = {}) {
      const rows = await Booking.find({
        isFreeFirstVisit: true,
        completedAt: { $gte: new Date(now - 60 * DAY), $lte: new Date(now - 3 * DAY) },
      })
        .select("user")
        .limit(limit * 2)
        .lean();
      return [...new Set(rows.map((r) => String(r.user)).filter(Boolean))].slice(0, limit);
    },
    async includes(user, { now = new Date() } = {}) {
      const { audience } = await resolveAudience(user, now);
      if (audience === "member") return false;
      const fv = await freeVisitState(user._id);
      if (!fv.lastCompletedAt) return false;
      const age = (now - fv.lastCompletedAt) / DAY;
      return age >= 3 && age <= 60;
    },
  },
  registered_never_booked: {
    label: "Registered 2-60 days ago, never booked, not a member",
    async members({ now = new Date(), limit = 100 } = {}) {
      const users = await User.find({
        role: { $nin: ["employee", "admin"] },
        createdAt: { $gte: new Date(now - 60 * DAY), $lte: new Date(now - 2 * DAY) },
      })
        .select("_id")
        .limit(limit * 3)
        .lean();
      const out = [];
      for (const u of users) {
        if (out.length >= limit) break;
        if (await Booking.exists({ user: u._id })) continue;
        out.push(String(u._id));
      }
      return out;
    },
    async includes(user, { now = new Date() } = {}) {
      const age = (now - new Date(user.createdAt)) / DAY;
      if (age < 2 || age > 60) return false;
      if (await Booking.exists({ user: user._id })) return false;
      const { audience } = await resolveAudience(user, now);
      return audience === "non_member";
    },
  },
  cancellation_scheduled: {
    label: "Member whose cancellation is scheduled",
    async members({ limit = 100 } = {}) {
      const rows = await Subscription.find({ status: { $in: ["active", "trialing"] }, cancelAtPeriodEnd: true })
        .select("user")
        .limit(limit)
        .lean();
      return [...new Set(rows.map((r) => String(r.user)))];
    },
    async includes(user) {
      return Boolean(
        await Subscription.exists({ user: user._id, status: { $in: ["active", "trialing"] }, cancelAtPeriodEnd: true })
      );
    },
  },
  former_member_recent: {
    label: "Membership ended 14-120 days ago, not a member now",
    async members({ now = new Date(), limit = 100 } = {}) {
      const rows = await Subscription.find({
        status: "canceled",
        cancellationDate: { $gte: new Date(now - 120 * DAY), $lte: new Date(now - 14 * DAY) },
        cancellationReason: { $not: /duplicate/i },
      })
        .select("user")
        .limit(limit * 2)
        .lean();
      return [...new Set(rows.map((r) => String(r.user)))].slice(0, limit);
    },
    async includes(user, { now = new Date() } = {}) {
      const { audience } = await resolveAudience(user, now);
      if (audience !== "former_member") return false;
      const last = await Subscription.findOne({ user: user._id, status: "canceled" }).sort({ cancellationDate: -1 }).lean();
      if (!last?.cancellationDate) return false;
      const age = (now - new Date(last.cancellationDate)) / DAY;
      return age >= 14 && age <= 120;
    },
  },
};

function segmentDef(key) {
  return SEGMENT_DEFS[key] || null;
}

module.exports = { SEGMENT_DEFS, segmentDef };
