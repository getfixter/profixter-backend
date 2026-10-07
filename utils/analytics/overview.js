/**
 * The Admin Overview: customers, memberships, visits, revenue, marketing,
 * geography - from the records Profixter already keeps, plus Stripe for money.
 *
 * DEFINITIONS (they are shown in the UI, keep the two in step):
 * - Customer: any account that is not staff (role employee/admin, or the owner
 *   address). New customer = account created in the period.
 * - Membership: one per home. A paid Subscription, or a claimed gift. Where a
 *   home has both, the paid one counts (same rule as the coverage map).
 *   Active now = subscriptionGrantsAccess / giftAccessState, the same
 *   authorities the app itself uses. Active on a past day is reconstructed from
 *   start and end dates.
 *   New member = membership started in the period. Cancellation = a paid
 *   membership that actually ended in the period.
 * - MRR: paid memberships billing today (status active, not a gift-covered
 *   trial), monthly list price, annual divided by twelve. It is a run rate, not
 *   cash; cash is the Revenue figure, which comes from Stripe.
 * - Free Visit: Booking.isFreeFirstVisit / accessType free_first_visit.
 *   Booked = created in the period. Completed = marked Completed in the period.
 *   Converted = that customer started a membership after the visit.
 *   No-shows are counted only if a booking was marked No-Show; nothing in the
 *   app sets that status today, so the UI says so instead of claiming zero.
 * - One-Time Visit: paid one_time_handyman_visit bookings (Full Day separate).
 * - Source: the customer's first touch (utils/analytics/attribution). Every
 *   event in the period is credited to the source of the customer it belongs
 *   to, so the source rows always add up to the totals above them.
 *
 * Everything is computed in memory from lean, projected queries: Profixter's
 * volumes are thousands of rows, not millions, and one consistent pass is far
 * easier to keep correct than a dozen aggregation pipelines. Cached briefly.
 */
const User = require("../../models/User");
const Subscription = require("../../models/Subscription");
const GiftMembership = require("../../models/GiftMembership");
const Booking = require("../../models/Booking");
const SiteVisitor = require("../../models/SiteVisitor");
const { subscriptionGrantsAccess } = require("../subscriptionManagement");
const { giftAccessState } = require("../gifts/giftAccess");
const { project } = require("../membershipMap/projection");
const { placeZipCluster } = require("../membershipMap/publicPoint");
const { classifySource, campaignOf, SOURCES } = require("./attribution");
const { collectedRevenue } = require("./stripeRevenue");

const TZ = "America/New_York";
const DAY = 24 * 60 * 60 * 1000;
const PLANS = ["basic", "plus", "premium", "elite"];
const ADMIN_EMAIL = String(process.env.MAIL_ADMIN || "getfixter@gmail.com").toLowerCase();
const ENDED_STATUSES = new Set(["canceled", "expired", "incomplete_expired"]);
const NEVER_STARTED = new Set(["incomplete", "incomplete_expired"]);
const CACHE_TTL_MS = 60 * 1000;
const cache = new Map();

/* ------------------------------------------------------------------ */
/* Periods (New York days)                                             */
/* ------------------------------------------------------------------ */

const ymdFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const hourFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

function nyYmd(date) {
  return ymdFmt.format(date);
}

/** The instant of 00:00 New York time on a YYYY-MM-DD day. */
function nyMidnight(ymd) {
  const [y, m, d] = String(ymd).split("-").map(Number);
  for (const offsetHours of [4, 5]) {
    const candidate = new Date(Date.UTC(y, m - 1, d, offsetHours, 0, 0));
    if (nyYmd(candidate) === ymd && hourFmt.format(candidate) === "00:00") return candidate;
  }
  return new Date(Date.UTC(y, m - 1, d, 5, 0, 0));
}

function shiftYmd(ymd, days) {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

function monthStartYmd(ymd, deltaMonths = 0) {
  const [y, m] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 + deltaMonths, 1));
  return t.toISOString().slice(0, 10);
}

const PRESETS = {
  today: "Today",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  month: "This month",
  lastmonth: "Last month",
  custom: "Custom range",
};

/**
 * [from, to) for a preset, plus the previous period of equal length.
 * "Last N days" includes today. Custom is inclusive of both picked days.
 */
function resolvePeriod({ range = "30d", from, to, now = new Date() } = {}) {
  const validCustom =
    range === "custom" && /^\d{4}-\d{2}-\d{2}$/.test(String(from)) && /^\d{4}-\d{2}-\d{2}$/.test(String(to)) && from <= to;
  // An unusable custom range falls back to the default, and says so.
  const key = PRESETS[range] && (range !== "custom" || validCustom) ? range : "30d";
  const today = nyYmd(now);
  let startYmd;
  let endYmd; // exclusive
  if (key === "today") {
    startYmd = today;
    endYmd = shiftYmd(today, 1);
  } else if (key === "7d") {
    startYmd = shiftYmd(today, -6);
    endYmd = shiftYmd(today, 1);
  } else if (key === "month") {
    startYmd = monthStartYmd(today);
    endYmd = shiftYmd(today, 1);
  } else if (key === "lastmonth") {
    startYmd = monthStartYmd(today, -1);
    endYmd = monthStartYmd(today);
  } else if (key === "custom") {
    startYmd = from;
    endYmd = shiftYmd(to, 1);
  } else {
    startYmd = shiftYmd(today, -29);
    endYmd = shiftYmd(today, 1);
  }
  const start = nyMidnight(startYmd);
  const end = nyMidnight(endYmd);
  const lengthDays = Math.max(1, Math.round((end - start) / DAY));
  const prevStart = nyMidnight(shiftYmd(startYmd, -lengthDays));
  return {
    key,
    label: PRESETS[key],
    from: start,
    to: end,
    prevFrom: prevStart,
    prevTo: start,
    days: lengthDays,
    fromYmd: startYmd,
    toYmd: shiftYmd(endYmd, -1),
    timezone: TZ,
  };
}

const inRange = (date, from, to) => {
  if (!date) return false;
  const t = new Date(date).getTime();
  return t >= from.getTime() && t < to.getTime();
};

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

function isStaff(user) {
  return user.role === "employee" || user.role === "admin" || String(user.email || "").toLowerCase() === ADMIN_EMAIL;
}

function shortName(name, email) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
  if (parts.length === 1) return parts[0];
  return String(email || "Customer").split("@")[0];
}

function primaryAddress(user) {
  const list = user.addresses || [];
  return list.find((a) => String(a._id) === String(user.defaultAddressId)) || list[0] || null;
}

async function loadData({ now = new Date() } = {}) {
  const [users, subs, gifts, bookings, visitorAgg] = await Promise.all([
    User.find({})
      .select("_id userId name email role createdAt addresses defaultAddressId attribution stripeCustomerId")
      .lean(),
    Subscription.find({})
      .select("_id user addressId subscriptionType billingCycle status accessStatus startDate createdAt updatedAt cancellationDate cancelAtPeriodEnd currentPeriodEnd trialEnd planPrice stripeSubscriptionId addressSnapshot")
      .lean(),
    GiftMembership.find({ status: { $in: ["claimed", "cancelled"] } })
      .select("_id recipient addressId plan status startAt endAt claimedAt cancelledAt cancelledReason addressSnapshot")
      .lean(),
    Booking.find({})
      .select("_id user addressId date status completedAt createdAt isFreeFirstVisit accessType bookingType paymentState bookingNumber")
      .lean(),
    SiteVisitor.aggregate([{ $group: { _id: null, first: { $min: "$firstSeenAt" } } }]),
  ]);

  const customers = users.filter((u) => !isStaff(u));
  const userById = new Map(customers.map((u) => [String(u._id), u]));
  const userByPublicId = new Map(customers.filter((u) => u.userId).map((u) => [String(u.userId), u]));
  const userByStripe = new Map(customers.filter((u) => u.stripeCustomerId).map((u) => [String(u.stripeCustomerId), u]));

  /* Memberships: paid subscriptions first, then gifts for homes not already covered. */
  const memberships = [];
  const homeKey = (userId, addressId) => `${userId}:${addressId || "-"}`;
  for (const sub of subs) {
    if (NEVER_STARTED.has(sub.status)) continue;
    const userId = String(sub.user || "");
    if (!userById.has(userId)) continue;
    const plan = PLANS.includes(String(sub.subscriptionType)) ? String(sub.subscriptionType) : null;
    const start = sub.startDate || sub.createdAt;
    const ended = ENDED_STATUSES.has(sub.status);
    const end = ended ? sub.cancellationDate || sub.updatedAt || null : null;
    const monthly = Number(sub.planPrice || 0) / (sub.billingCycle === "annual" ? 12 : 1);
    memberships.push({
      id: `sub:${sub._id}`,
      kind: "paid",
      userId,
      addressId: sub.addressId ? String(sub.addressId) : null,
      home: homeKey(userId, sub.addressId),
      plan,
      billingCycle: sub.billingCycle || "monthly",
      status: sub.status,
      start: start ? new Date(start) : null,
      end: end ? new Date(end) : null,
      activeNow: subscriptionGrantsAccess(sub, { now }),
      paying: sub.status === "active" || sub.status === "past_due",
      failing: sub.status === "past_due" || sub.status === "unpaid",
      cancelScheduled: !!sub.cancelAtPeriodEnd && !ended,
      monthlyCents: Math.round(monthly * 100),
    });
  }
  const paidHomes = new Set(memberships.map((m) => m.home));
  for (const gift of gifts) {
    const userId = String(gift.recipient || "");
    if (!userById.has(userId)) continue;
    const home = homeKey(userId, gift.addressId);
    if (paidHomes.has(home)) continue;
    const start = gift.startAt || gift.claimedAt;
    const end = gift.status === "cancelled" ? gift.cancelledAt || gift.endAt : gift.endAt;
    memberships.push({
      id: `gift:${gift._id}`,
      kind: "gift",
      userId,
      addressId: gift.addressId ? String(gift.addressId) : null,
      home,
      plan: PLANS.includes(String(gift.plan)) ? String(gift.plan) : null,
      billingCycle: "gift",
      status: gift.status,
      start: start ? new Date(start) : null,
      end: end ? new Date(end) : null,
      activeNow: giftAccessState(gift, now).active,
      paying: false,
      failing: false,
      cancelScheduled: false,
      monthlyCents: 0,
    });
  }

  const freeVisits = bookings.filter((b) => b.isFreeFirstVisit || b.accessType === "free_first_visit");
  const oneTimeVisits = bookings.filter(
    (b) => b.bookingType === "one_time_handyman_visit" && (b.paymentState === "paid" || b.paymentState === "not_required" || !b.paymentState || b.status === "Completed")
  );
  const fullDayVisits = bookings.filter((b) => b.bookingType === "full_day_visit" && b.paymentState === "paid");

  return {
    now,
    customers,
    userById,
    userByPublicId,
    userByStripe,
    memberships,
    bookings,
    freeVisits,
    oneTimeVisits,
    fullDayVisits,
    visitorsSince: visitorAgg[0]?.first || null,
  };
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const statusOf = (b) => String(b.status || "Pending").toLowerCase().replace(/[\s_-]/g, "");
const isCompleted = (b) => statusOf(b) === "completed" || statusOf(b) === "done";
const isCanceled = (b) => statusOf(b) === "canceled" || statusOf(b) === "cancelled" || statusOf(b) === "failed";
const isNoShow = (b) => statusOf(b) === "noshow";
const completedAt = (b) => (isCompleted(b) ? new Date(b.completedAt || b.date) : null);

function activeAt(m, t) {
  if (!m.start || m.start > t) return false;
  return !m.end || m.end > t;
}

function sourceOf(user) {
  return classifySource(user?.attribution).key;
}

function membershipStartedAfter(data, userId, after) {
  return data.memberships.some(
    (m) => m.userId === userId && m.start && m.start.getTime() >= new Date(after).getTime() - DAY
  );
}

function pct(part, whole) {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
}

function revenueUser(data, row) {
  if (row.stripeCustomerId && data.userByStripe.has(row.stripeCustomerId)) return data.userByStripe.get(row.stripeCustomerId);
  if (row.userRef) {
    return data.userById.get(String(row.userRef)) || data.userByPublicId.get(String(row.userRef)) || null;
  }
  return null;
}

function summarizeRevenue(rows) {
  const out = { membershipCents: 0, oneTimeCents: 0, fullDayCents: 0, giftCents: 0, otherCents: 0, refundedCents: 0, count: 0 };
  for (const r of rows) {
    if (r.kind === "project" || r.kind === "tip") continue;
    out.refundedCents += r.refundedCents;
    if (r.kind === "membership") out.membershipCents += r.netCents;
    else if (r.kind === "one_time") out.oneTimeCents += r.netCents;
    else if (r.kind === "full_day") out.fullDayCents += r.netCents;
    else if (r.kind === "gift") out.giftCents += r.netCents;
    else out.otherCents += r.netCents;
    if (r.service) out.count += 1;
  }
  out.totalCents = out.membershipCents + out.oneTimeCents + out.fullDayCents + out.giftCents;
  return out;
}

/* ------------------------------------------------------------------ */
/* Period metrics                                                      */
/* ------------------------------------------------------------------ */

function periodCounts(data, from, to) {
  const newCustomers = data.customers.filter((u) => inRange(u.createdAt, from, to));
  const newMemberships = data.memberships.filter((m) => inRange(m.start, from, to));
  const cancellations = data.memberships.filter((m) => m.kind === "paid" && ENDED_STATUSES.has(m.status) && inRange(m.end, from, to));
  const fvBooked = data.freeVisits.filter((b) => inRange(b.createdAt, from, to));
  const fvCompleted = data.freeVisits.filter((b) => isCompleted(b) && inRange(completedAt(b), from, to));
  const fvConverted = fvCompleted.filter((b) => membershipStartedAfter(data, String(b.user), b.date));
  const activeAtEnd = data.memberships.filter((m) => activeAt(m, new Date(Math.min(to.getTime(), data.now.getTime())))).length;
  return { newCustomers, newMemberships, cancellations, fvBooked, fvCompleted, fvConverted, activeAtEnd };
}

function buildPlans(data, period) {
  const active = data.memberships.filter((m) => m.activeNow);
  return PLANS.map((plan) => {
    const current = active.filter((m) => m.plan === plan);
    return {
      plan,
      active: current.length,
      paying: current.filter((m) => m.paying).length,
      gifts: current.filter((m) => m.kind === "gift").length,
      newInPeriod: data.memberships.filter((m) => m.plan === plan && inRange(m.start, period.from, period.to)).length,
      canceledInPeriod: data.memberships.filter(
        (m) => m.plan === plan && m.kind === "paid" && ENDED_STATUSES.has(m.status) && inRange(m.end, period.from, period.to)
      ).length,
      mrrCents: current.filter((m) => m.paying).reduce((s, m) => s + m.monthlyCents, 0),
      share: pct(current.length, active.length),
    };
  });
}

function mrrAt(data, t, nowMode) {
  return data.memberships
    .filter((m) => m.kind === "paid" && (nowMode ? m.activeNow && m.paying : activeAt(m, t)))
    .reduce((s, m) => s + m.monthlyCents, 0);
}

/* Buckets for the growth and revenue charts. */
function buildBuckets(period, granularity) {
  const buckets = [];
  if (granularity === "month") {
    let ymd = monthStartYmd(period.fromYmd);
    while (nyMidnight(ymd) < period.to) {
      const next = monthStartYmd(ymd, 1);
      buckets.push({ key: ymd.slice(0, 7), from: nyMidnight(ymd), to: nyMidnight(next) });
      ymd = next;
    }
  } else {
    const step = granularity === "week" ? 7 : 1;
    let ymd = period.fromYmd;
    while (nyMidnight(ymd) < period.to) {
      const next = shiftYmd(ymd, step);
      buckets.push({ key: ymd, from: nyMidnight(ymd), to: nyMidnight(next) < period.to ? nyMidnight(next) : period.to });
      ymd = next;
    }
  }
  return buckets;
}

function granularityFor(days) {
  if (days <= 45) return "day";
  if (days <= 190) return "week";
  return "month";
}

function growthSeries(data, period, granularity) {
  return buildBuckets(period, granularity).map((b) => {
    const at = new Date(Math.min(b.to.getTime() - 1, data.now.getTime()));
    return {
      key: b.key,
      from: b.from,
      active: data.memberships.filter((m) => activeAt(m, at)).length,
      new: data.memberships.filter((m) => inRange(m.start, b.from, b.to)).length,
      canceled: data.memberships.filter((m) => m.kind === "paid" && ENDED_STATUSES.has(m.status) && inRange(m.end, b.from, b.to)).length,
      customers: data.customers.filter((u) => inRange(u.createdAt, b.from, b.to)).length,
    };
  });
}

function revenueSeries(rows, period, granularity) {
  return buildBuckets(period, granularity).map((b) => {
    const inBucket = rows.filter((r) => inRange(r.at, b.from, b.to));
    const s = summarizeRevenue(inBucket);
    return { key: b.key, from: b.from, membershipCents: s.membershipCents + s.giftCents, visitCents: s.oneTimeCents + s.fullDayCents };
  });
}

/* ------------------------------------------------------------------ */
/* Marketing                                                           */
/* ------------------------------------------------------------------ */

async function visitorCounts(from, to) {
  const rows = await SiteVisitor.aggregate([
    { $match: { firstSeenAt: { $gte: from, $lt: to } } },
    { $group: { _id: "$source", n: { $sum: 1 } } },
  ]);
  const bySource = Object.fromEntries(rows.map((r) => [r._id || "direct", r.n]));
  return { total: rows.reduce((s, r) => s + r.n, 0), bySource };
}

function buildSources(data, period, counts, revenueRows, visitors) {
  const rows = new Map(
    SOURCES.map((s) => [s.key, { key: s.key, label: s.label, visitors: visitors.bySource[s.key] || 0, registrations: 0, freeVisits: 0, members: 0, revenueCents: 0, spendCents: null }])
  );
  const bump = (user, field, by = 1) => {
    const row = rows.get(sourceOf(user)) || rows.get("other");
    row[field] += by;
  };
  for (const u of counts.newCustomers) bump(u, "registrations");
  for (const b of counts.fvBooked) bump(data.userById.get(String(b.user)), "freeVisits");
  for (const m of counts.newMemberships) bump(data.userById.get(m.userId), "members");
  let unmatchedRevenueCents = 0;
  for (const r of revenueRows) {
    if (!r.service) continue;
    const user = revenueUser(data, r);
    if (user) bump(user, "revenueCents", r.netCents);
    else unmatchedRevenueCents += r.netCents;
  }
  const list = [...rows.values()].map((r) => ({
    ...r,
    conversion: pct(r.members, r.registrations),
    costPerRegistrationCents: null,
    costPerMemberCents: null,
    roas: null,
  }));
  const totalRegs = counts.newCustomers.length;
  for (const r of list) r.share = pct(r.registrations, totalRegs);
  return { rows: list, unmatchedRevenueCents };
}

function buildCampaigns(data, period, counts, revenueRows) {
  const tree = new Map();
  const node = (user) => {
    const c = campaignOf(user?.attribution);
    const campaignName = c.campaign || "(no campaign tag)";
    if (!tree.has(campaignName)) tree.set(campaignName, { name: campaignName, campaignId: c.campaignId, registrations: 0, freeVisits: 0, members: 0, revenueCents: 0, plans: {}, adsets: new Map() });
    const camp = tree.get(campaignName);
    const adsetName = c.adset || "(no ad set tag)";
    if (!camp.adsets.has(adsetName)) camp.adsets.set(adsetName, { name: adsetName, adsetId: c.adsetId, registrations: 0, freeVisits: 0, members: 0, revenueCents: 0, ads: new Map() });
    const adset = camp.adsets.get(adsetName);
    const adName = c.ad || "(no ad tag)";
    if (!adset.ads.has(adName)) adset.ads.set(adName, { name: adName, adId: c.adId, registrations: 0, freeVisits: 0, members: 0, revenueCents: 0 });
    return [camp, adset, adset.ads.get(adName)];
  };
  const isMeta = (u) => u && sourceOf(u) === "meta_ads";
  const add = (user, field, by = 1, plan) => {
    if (!isMeta(user)) return;
    for (const n of node(user)) n[field] += by;
    if (plan) {
      const [camp] = node(user);
      camp.plans[plan] = (camp.plans[plan] || 0) + 1;
    }
  };
  for (const u of counts.newCustomers) add(u, "registrations");
  for (const b of counts.fvBooked) add(data.userById.get(String(b.user)), "freeVisits");
  for (const m of counts.newMemberships) add(data.userById.get(m.userId), "members", 1, m.plan);
  for (const r of revenueRows) if (r.service) add(revenueUser(data, r), "revenueCents", r.netCents);
  const finish = (n) => ({ ...n, conversion: pct(n.members, n.registrations), spendCents: null, roas: null, costPerMemberCents: null });
  return [...tree.values()]
    .map((c) => ({
      ...finish(c),
      adsets: [...c.adsets.values()].map((s) => ({ ...finish(s), ads: [...s.ads.values()].map(finish) })),
    }))
    .sort((a, b) => b.revenueCents - a.revenueCents || b.members - a.members || b.registrations - a.registrations);
}

/* ------------------------------------------------------------------ */
/* Activity and attention                                              */
/* ------------------------------------------------------------------ */

function buildActivity(data, limit = 20) {
  const since = new Date(data.now.getTime() - 14 * DAY);
  const events = [];
  const label = (u) => shortName(u?.name, u?.email);
  for (const u of data.customers) {
    if (inRange(u.createdAt, since, data.now)) {
      const src = classifySource(u.attribution);
      events.push({ at: u.createdAt, type: "registered", text: `New customer registered${src.key !== "direct" ? ` from ${src.label}` : ""}`, who: label(u), ref: u?.userId || null, userId: String(u._id) });
    }
  }
  for (const m of data.memberships) {
    const u = data.userById.get(m.userId);
    const planName = m.plan ? m.plan[0].toUpperCase() + m.plan.slice(1) : "Membership";
    if (inRange(m.start, since, data.now)) events.push({ at: m.start, type: "membership", text: `${planName} membership ${m.kind === "gift" ? "started (gift)" : "purchased"}`, who: label(u), ref: u?.userId || null, userId: m.userId });
    if (m.kind === "paid" && ENDED_STATUSES.has(m.status) && inRange(m.end, since, data.now)) events.push({ at: m.end, type: "cancellation", text: `${planName} membership canceled`, who: label(u), ref: u?.userId || null, userId: m.userId });
  }
  for (const b of data.freeVisits) {
    const u = data.userById.get(String(b.user));
    if (!u) continue;
    if (inRange(b.createdAt, since, data.now)) events.push({ at: b.createdAt, type: "free_visit", text: "Free Visit booked", who: label(u), ref: u?.userId || null, userId: String(b.user) });
    const done = completedAt(b);
    if (done && inRange(done, since, data.now)) events.push({ at: done, type: "free_visit_completed", text: "Free Visit completed", who: label(u), ref: u?.userId || null, userId: String(b.user) });
  }
  for (const b of data.oneTimeVisits) {
    const u = data.userById.get(String(b.user));
    if (u && inRange(b.createdAt, since, data.now)) events.push({ at: b.createdAt, type: "one_time", text: "One-Time Visit booked", who: label(u), ref: u?.userId || null, userId: String(b.user) });
  }
  return events.sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, limit);
}

function buildAttention(data, period, counts) {
  const items = [];
  const now = data.now.getTime();
  const undecided = data.freeVisits.filter((b) => {
    const done = completedAt(b);
    return done && now - done.getTime() > 3 * DAY && now - done.getTime() < 60 * DAY && !membershipStartedAfter(data, String(b.user), b.date);
  });
  if (undecided.length) items.push({ key: "free_visit_undecided", count: undecided.length, tone: "info", text: `${undecided.length} completed Free Visit${undecided.length === 1 ? " hasn't" : "s haven't"} turned into a membership yet` });
  const failing = data.memberships.filter((m) => m.failing && !ENDED_STATUSES.has(m.status));
  if (failing.length) items.push({ key: "failed_payments", count: failing.length, tone: "critical", text: `${failing.length} membership payment${failing.length === 1 ? " is" : "s are"} failing` });
  const booked = new Set(data.bookings.map((b) => String(b.user)));
  const members = new Set(data.memberships.map((m) => m.userId));
  const idle = data.customers.filter((u) => {
    const age = now - new Date(u.createdAt).getTime();
    return age > 3 * DAY && age < 30 * DAY && !booked.has(String(u._id)) && !members.has(String(u._id));
  });
  if (idle.length) items.push({ key: "registered_no_booking", count: idle.length, tone: "info", text: `${idle.length} new customer${idle.length === 1 ? " hasn't" : "s haven't"} booked a visit` });
  const stale = data.freeVisits.filter((b) => !isCompleted(b) && !isCanceled(b) && !isNoShow(b) && b.date && now - new Date(b.date).getTime() > DAY);
  if (stale.length) items.push({ key: "free_visit_unmarked", count: stale.length, tone: "warning", text: `${stale.length} past Free Visit${stale.length === 1 ? " is" : "s are"} not marked completed - conversion can't count ${stale.length === 1 ? "it" : "them"}` });
  const regs = counts.newCustomers.length;
  const unknown = counts.newCustomers.filter((u) => sourceOf(u) === "direct").length;
  if (regs >= 5 && unknown / regs >= 0.25) items.push({ key: "attribution_gap", count: unknown, tone: "info", text: `Source unknown for ${Math.round((unknown / regs) * 100)}% of new customers this period` });
  return items;
}

/* ------------------------------------------------------------------ */
/* The payload                                                         */
/* ------------------------------------------------------------------ */

function delta(value, prev) {
  if (value === null || prev === null || prev === undefined) return null;
  return { abs: value - prev, pct: prev > 0 ? Math.round(((value - prev) / prev) * 1000) / 10 : null };
}

async function buildOverview({ range, from, to, now = new Date() } = {}) {
  const period = resolvePeriod({ range, from, to, now });
  /*
   * The range key is part of the key: "Last 7 days" and "This month" can be
   * the same window (Oct 1-7), and must still come back labelled as asked.
   */
  const cacheKey = `${period.key}|${period.from.toISOString()}|${period.to.toISOString()}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const data = await loadData({ now });
  const cur = periodCounts(data, period.from, period.to);
  const prev = periodCounts(data, period.prevFrom, period.prevTo);

  // Charts: the selected period at a sensible step, and the last 12 months.
  const gran = granularityFor(period.days);
  const yearPeriod = { ...period, fromYmd: monthStartYmd(nyYmd(now), -11), to: nyMidnight(shiftYmd(nyYmd(now), 1)) };
  yearPeriod.from = nyMidnight(yearPeriod.fromYmd);

  const revenueWindowFrom = new Date(Math.min(period.prevFrom.getTime(), yearPeriod.from.getTime()));
  const revenueWindowTo = new Date(Math.max(period.to.getTime(), yearPeriod.to.getTime()));
  const [revenueAll, visitors, prevVisitors] = await Promise.all([
    collectedRevenue({ from: revenueWindowFrom, to: revenueWindowTo }),
    visitorCounts(period.from, period.to),
    visitorCounts(period.prevFrom, period.prevTo),
  ]);
  const curRevenueRows = revenueAll.rows.filter((r) => inRange(r.at, period.from, period.to));
  const prevRevenueRows = revenueAll.rows.filter((r) => inRange(r.at, period.prevFrom, period.prevTo));
  const revenueNow = summarizeRevenue(curRevenueRows);
  const revenuePrev = summarizeRevenue(prevRevenueRows);

  const activeNow = data.memberships.filter((m) => m.activeNow);
  const activeAtStart = data.memberships.filter((m) => activeAt(m, period.from)).length;
  const mrrNow = mrrAt(data, now, true);
  const mrrStart = mrrAt(data, period.from, false);

  const fvUpcoming = data.freeVisits.filter((b) => !isCompleted(b) && !isCanceled(b) && b.date && new Date(b.date) >= now).length;
  const oneTimeBooked = data.oneTimeVisits.filter((b) => inRange(b.createdAt, period.from, period.to));
  const fullDayBooked = data.fullDayVisits.filter((b) => inRange(b.createdAt, period.from, period.to));

  const sources = buildSources(data, period, cur, curRevenueRows, visitors);
  const cities = new Map();
  for (const u of data.customers) {
    const addr = primaryAddress(u);
    const city = String(addr?.city || "").trim();
    if (!city) continue;
    const key = city.toLowerCase();
    if (!cities.has(key)) cities.set(key, { city, customers: 0, members: 0, newInPeriod: 0 });
    const row = cities.get(key);
    row.customers += 1;
    if (activeNow.some((m) => m.userId === String(u._id))) row.members += 1;
    if (inRange(u.createdAt, period.from, period.to)) row.newInPeriod += 1;
  }

  const value = {
    generatedAt: now,
    period: {
      key: period.key,
      label: period.label,
      from: period.from,
      to: period.to,
      fromYmd: period.fromYmd,
      toYmd: period.toYmd,
      prevFrom: period.prevFrom,
      prevTo: period.prevTo,
      days: period.days,
      timezone: TZ,
    },
    kpis: {
      totalCustomers: { value: data.customers.length },
      activeMembers: { value: activeNow.length, prev: activeAtStart, delta: delta(activeNow.length, activeAtStart), paying: activeNow.filter((m) => m.paying).length, gifts: activeNow.filter((m) => m.kind === "gift").length },
      newMembers: { value: cur.newMemberships.length, prev: prev.newMemberships.length, delta: delta(cur.newMemberships.length, prev.newMemberships.length) },
      cancellations: { value: cur.cancellations.length, prev: prev.cancellations.length, delta: delta(cur.cancellations.length, prev.cancellations.length), scheduled: data.memberships.filter((m) => m.cancelScheduled && m.activeNow).length },
      newCustomers: { value: cur.newCustomers.length, prev: prev.newCustomers.length, delta: delta(cur.newCustomers.length, prev.newCustomers.length) },
      revenue: {
        available: revenueAll.available,
        error: revenueAll.error || null,
        truncated: revenueAll.truncated,
        ...revenueNow,
        prevTotalCents: revenuePrev.totalCents,
        delta: revenueAll.available ? delta(revenueNow.totalCents, revenuePrev.totalCents) : null,
      },
      mrr: { cents: mrrNow, startCents: mrrStart, delta: delta(mrrNow, mrrStart), payingMembers: activeNow.filter((m) => m.paying).length },
      freeVisits: {
        booked: cur.fvBooked.length,
        prevBooked: prev.fvBooked.length,
        delta: delta(cur.fvBooked.length, prev.fvBooked.length),
        completed: cur.fvCompleted.length,
        upcoming: fvUpcoming,
        canceled: cur.fvBooked.filter(isCanceled).length,
        noShow: cur.fvBooked.filter(isNoShow).length,
        noShowTracked: data.freeVisits.some(isNoShow),
      },
      conversion: {
        completed: cur.fvCompleted.length,
        converted: cur.fvConverted.length,
        rate: pct(cur.fvConverted.length, cur.fvCompleted.length),
        prevRate: pct(prev.fvConverted.length, prev.fvCompleted.length),
      },
      oneTime: {
        booked: oneTimeBooked.length,
        completed: oneTimeBooked.filter(isCompleted).length,
        canceled: oneTimeBooked.filter(isCanceled).length,
        revenueCents: revenueNow.oneTimeCents,
        converted: oneTimeBooked.filter((b) => membershipStartedAfter(data, String(b.user), b.createdAt)).length,
        fullDayBooked: fullDayBooked.length,
        fullDayRevenueCents: revenueNow.fullDayCents,
      },
    },
    plans: buildPlans(data, period),
    growth: {
      period: { granularity: gran, points: growthSeries(data, period, gran) },
      year: { granularity: "month", points: growthSeries(data, yearPeriod, "month") },
    },
    revenueSeries: revenueAll.available
      ? {
          period: { granularity: gran, points: revenueSeries(revenueAll.rows, period, gran) },
          year: { granularity: "month", points: revenueSeries(revenueAll.rows, yearPeriod, "month") },
        }
      : null,
    funnel: {
      visitors: visitors.total,
      prevVisitors: prevVisitors.total,
      visitorsTrackingSince: data.visitorsSince,
      registered: cur.newCustomers.length,
      freeVisitBooked: cur.fvBooked.length,
      freeVisitCompleted: cur.fvCompleted.length,
      members: cur.newMemberships.filter((m) => m.kind === "paid").length,
    },
    sources: sources.rows,
    unmatchedRevenueCents: sources.unmatchedRevenueCents,
    campaigns: buildCampaigns(data, period, cur, curRevenueRows),
    spend: { connected: false },
    topAreas: [...cities.values()].sort((a, b) => b.customers - a.customers).slice(0, 8),
    activity: buildActivity(data),
    attention: buildAttention(data, period, cur),
  };
  cache.set(cacheKey, { at: Date.now(), value });
  if (cache.size > 30) cache.delete(cache.keys().next().value);
  return value;
}

/* ------------------------------------------------------------------ */
/* Drill-down lists                                                    */
/* ------------------------------------------------------------------ */

function customerRow(data, user, extra = {}) {
  const active = data.memberships.find((m) => m.userId === String(user._id) && m.activeNow);
  const src = classifySource(user.attribution);
  const c = campaignOf(user.attribution);
  const addr = primaryAddress(user);
  return {
    userId: String(user._id),
    name: user.name || "",
    email: user.email || "",
    city: addr?.city || "",
    plan: active?.plan || null,
    membership: active ? (active.kind === "gift" ? "gift" : active.billingCycle) : null,
    registeredAt: user.createdAt,
    source: src.label,
    campaign: src.key === "meta_ads" ? c.campaign : null,
    ad: src.key === "meta_ads" ? c.ad : null,
    hadFreeVisit: data.freeVisits.some((b) => String(b.user) === String(user._id)),
    ...extra,
  };
}

/**
 * The rows behind one number. `metric` is one of the keys the Overview links
 * to; unknown metrics return an empty list rather than everything.
 */
async function buildList({ metric, range, from, to, now = new Date(), param } = {}) {
  const period = resolvePeriod({ range, from, to, now });
  const data = await loadData({ now });
  const cur = periodCounts(data, period.from, period.to);
  const u = (id) => data.userById.get(String(id));
  const byMembership = (m, extra = {}) => {
    const user = u(m.userId);
    return user ? customerRow(data, user, { plan: m.plan, date: m.start, membership: m.kind === "gift" ? "gift" : m.billingCycle, ...extra }) : null;
  };
  let title = "";
  let rows = [];
  switch (metric) {
    case "activeMembers":
      title = "Active members";
      rows = data.memberships.filter((m) => m.activeNow).map((m) => byMembership(m));
      break;
    case "newMembers":
      title = "New members";
      rows = cur.newMemberships.map((m) => byMembership(m));
      break;
    case "cancellations":
      title = "Cancellations";
      rows = cur.cancellations.map((m) => byMembership(m, { date: m.end }));
      break;
    case "newCustomers":
      title = "New customers";
      rows = cur.newCustomers.map((user) => customerRow(data, user, { date: user.createdAt }));
      break;
    case "freeVisits":
      title = "Free Visits booked";
      rows = cur.fvBooked.map((b) => (u(b.user) ? customerRow(data, u(b.user), { date: b.date, status: b.status, converted: membershipStartedAfter(data, String(b.user), b.date) }) : null));
      break;
    case "conversions":
      title = "Completed Free Visits";
      rows = cur.fvCompleted.map((b) => (u(b.user) ? customerRow(data, u(b.user), { date: completedAt(b), status: b.status, converted: membershipStartedAfter(data, String(b.user), b.date) }) : null));
      break;
    case "oneTime":
      title = "One-Time Visits";
      rows = data.oneTimeVisits.filter((b) => inRange(b.createdAt, period.from, period.to)).map((b) => (u(b.user) ? customerRow(data, u(b.user), { date: b.date, status: b.status, converted: membershipStartedAfter(data, String(b.user), b.createdAt) }) : null));
      break;
    case "plan":
      title = `${String(param || "").replace(/^./, (c) => c.toUpperCase())} members`;
      rows = data.memberships.filter((m) => m.activeNow && m.plan === param).map((m) => byMembership(m));
      break;
    case "source":
      title = `${(SOURCES.find((s) => s.key === param) || { label: "Source" }).label}: new customers`;
      rows = cur.newCustomers.filter((user) => sourceOf(user) === param).map((user) => customerRow(data, user, { date: user.createdAt }));
      break;
    case "campaign":
      title = `Campaign: ${param}`;
      rows = cur.newCustomers
        .filter((user) => sourceOf(user) === "meta_ads" && (campaignOf(user.attribution).campaign || "(no campaign tag)") === param)
        .map((user) => customerRow(data, user, { date: user.createdAt }));
      break;
    case "area":
      title = `Customers in ${param}`;
      rows = data.customers
        .filter((user) => String(primaryAddress(user)?.city || "").toLowerCase() === String(param || "").toLowerCase())
        .map((user) => customerRow(data, user, { date: user.createdAt }));
      break;
    case "attention": {
      const item = buildAttention(data, period, cur).find((a) => a.key === param);
      title = item ? item.text : "Needs attention";
      const now2 = now.getTime();
      if (param === "failed_payments") rows = data.memberships.filter((m) => m.failing && !ENDED_STATUSES.has(m.status)).map((m) => byMembership(m));
      else if (param === "free_visit_undecided" || param === "free_visit_unmarked")
        rows = data.freeVisits
          .filter((b) => {
            const done = completedAt(b);
            if (param === "free_visit_undecided") return done && now2 - done.getTime() > 3 * DAY && now2 - done.getTime() < 60 * DAY && !membershipStartedAfter(data, String(b.user), b.date);
            return !isCompleted(b) && !isCanceled(b) && !isNoShow(b) && b.date && now2 - new Date(b.date).getTime() > DAY;
          })
          .map((b) => (u(b.user) ? customerRow(data, u(b.user), { date: b.date, status: b.status }) : null));
      else if (param === "registered_no_booking") {
        const booked = new Set(data.bookings.map((b) => String(b.user)));
        const members = new Set(data.memberships.map((m) => m.userId));
        rows = data.customers
          .filter((user) => {
            const age = now2 - new Date(user.createdAt).getTime();
            return age > 3 * DAY && age < 30 * DAY && !booked.has(String(user._id)) && !members.has(String(user._id));
          })
          .map((user) => customerRow(data, user, { date: user.createdAt }));
      } else if (param === "attribution_gap") rows = cur.newCustomers.filter((user) => sourceOf(user) === "direct").map((user) => customerRow(data, user, { date: user.createdAt }));
      break;
    }
    default:
      title = "Details";
      rows = [];
  }
  rows = rows.filter(Boolean).sort((a, b) => new Date(b.date || b.registeredAt) - new Date(a.date || a.registeredAt));
  return { title, period: { label: period.label, fromYmd: period.fromYmd, toYmd: period.toYmd }, rows };
}

/* ------------------------------------------------------------------ */
/* Map                                                                 */
/* ------------------------------------------------------------------ */

/**
 * One point per customer with a placeable home. Exact coordinates when the
 * address has them (they were verified against the ZIP at signup), otherwise a
 * stable spot inside the ZIP. Only what the pin card shows is returned - no
 * street address, email or phone.
 */
async function buildMap({ now = new Date() } = {}) {
  const data = await loadData({ now });
  const byZip = new Map();
  const points = [];
  const lastVisit = new Map();
  const nextVisit = new Map();
  for (const b of data.bookings) {
    if (!b.date || isCanceled(b)) continue;
    const key = String(b.user);
    const t = new Date(b.date);
    if (t <= now && (isCompleted(b) || statusOf(b) === "confirmed")) {
      if (!lastVisit.has(key) || lastVisit.get(key) < t) lastVisit.set(key, t);
    } else if (t > now && !nextVisit.has(key)) nextVisit.set(key, t);
    else if (t > now && nextVisit.get(key) > t) nextVisit.set(key, t);
  }
  for (const user of data.customers) {
    const addr = primaryAddress(user);
    if (!addr) continue;
    const id = String(user._id);
    const active = data.memberships.find((m) => m.userId === id && m.activeNow);
    const card = {
      id,
      ref: user.userId || id,
      name: shortName(user.name, user.email),
      city: addr.city || "",
      plan: active?.plan || null,
      member: !!active,
      gift: active?.kind === "gift",
      freeVisit: data.freeVisits.some((b) => String(b.user) === id),
      oneTime: data.oneTimeVisits.some((b) => String(b.user) === id),
      joinedAt: user.createdAt,
      memberSince: active?.start || null,
      source: classifySource(user.attribution).label,
      lastVisit: lastVisit.get(id) || null,
      nextVisit: nextVisit.get(id) || null,
    };
    const exact = addr.lat != null && addr.lng != null ? project(addr.lat, addr.lng) : null;
    if (exact) {
      points.push({ ...card, x: exact.x, y: exact.y, precise: true });
      continue;
    }
    const zip = /^\d{5}$/.test(String(addr.zip || "").trim()) ? String(addr.zip).trim() : null;
    if (!zip) continue;
    if (!byZip.has(zip)) byZip.set(zip, []);
    byZip.get(zip).push(card);
  }
  for (const [zip, cards] of byZip) {
    const placed = placeZipCluster({ zip, seeds: cards.map((c) => `admin:${c.id}`) });
    for (const card of cards) {
      const spot = placed.get(`admin:${card.id}`);
      const xy = spot ? project(spot.lat, spot.lng) : null;
      if (xy) points.push({ ...card, x: xy.x, y: xy.y, precise: false });
    }
  }
  return { generatedAt: now, total: data.customers.length, placed: points.length, points };
}

function clearOverviewCache() {
  cache.clear();
}

module.exports = {
  resolvePeriod,
  nyMidnight,
  buildOverview,
  buildList,
  buildMap,
  clearOverviewCache,
  _internal: { activeAt, summarizeRevenue, granularityFor, buildBuckets, shortName },
};
