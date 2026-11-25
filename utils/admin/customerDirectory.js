/**
 * The customer list, search and profile reads for the redesigned Admin.
 *
 * LEAN BY CONSTRUCTION. Every row is built field by field from an explicit
 * .select(); nothing spreads a user document into a response. So no password
 * hash, Stripe ids, lastPurchase (and its token), googleId/appleId,
 * tokenVersion or temporary-password metadata can leak into a list.
 *
 * NO N+1. A page of customers costs a fixed number of queries whatever its
 * size: the users, one Subscription query (utils/admin/planStatus), one
 * Blacklist query and one Booking aggregate.
 *
 * SEARCH TEXT ARRIVES IN POST BODIES ONLY (it is a phone number or an address
 * more often than not, and URLs end up in logs and browser history).
 */
const mongoose = require("mongoose");

const User = require("../../models/User");
const Booking = require("../../models/Booking");
const Subscription = require("../../models/Subscription");
const Blacklist = require("../../models/Blacklist");
const { completedBookingCountsForUsers } = require("../customerBookingCounts");
const { normalizeSearchPhone, normalizeSearchText } = require("../userSearchFields");
const { formatAddressLine, formatPhone, splitUnit } = require("../formatAddress");
const { blockedUserIdSet } = require("../customerBlock");
const { blacklistPhoneDigits } = require("../../models/Blacklist");
const { NON_ENDED_STATUSES, loadAddressPlans } = require("./planStatus");

const ADMIN_EMAIL = () => String(process.env.MAIL_ADMIN || "getfixter@gmail.com").toLowerCase();
const FILTERS = ["all", "members", "payment_issue", "ending", "blocked", "archived"];
const MEMBER_STATUSES = new Set(["active", "trialing", "payment_issue", "ending"]);
const PLANS = ["basic", "plus", "premium", "elite"];
/** The filters `counts` reports; `archived` only for the owner. */
const COUNT_FILTERS = ["all", "members", "payment_issue", "ending", "blocked", "archived"];

/** Fields a list row may be built from. Nothing else is ever loaded for a list. */
const LIST_SELECT = "userId name firstName lastName email phone city addresses defaultAddressId createdAt archivedAt";

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Customer accounts: never the owner, never staff. */
function customerBaseQuery({ includeArchived = false, archivedOnly = false } = {}) {
  const query = {
    role: { $nin: ["employee", "admin"] },
    $or: [{ employeePosition: null }, { employeePosition: { $exists: false } }],
    email: { $ne: ADMIN_EMAIL() },
  };
  if (archivedOnly) query.archivedAt = { $ne: null };
  else if (!includeArchived) query.archivedAt = null;
  return query;
}

function townOf(user) {
  const addresses = user.addresses || [];
  const preferred = addresses.find((a) => String(a._id) === String(user.defaultAddressId || "")) || addresses[0];
  return preferred?.city || user.city || "";
}

function addressDto(address, summary, { user } = {}) {
  const { street, unit } = splitUnit(address);
  return {
    id: String(address._id),
    label: address.label || "",
    line1: street,
    unit,
    town: address.city || "",
    state: address.state || "",
    zip: address.zip || "",
    formatted: formatAddressLine(address),
    isDefault: user ? String(user.defaultAddressId || "") === String(address._id) : false,
    plan: summary?.plan || null,
    billingCycle: summary?.plan ? summary.billingCycle : null,
    planStatus: summary?.planStatus || "none",
    statusDetail: summary?.statusDetail || "",
    renewsAt: summary?.renewsAt || null,
    endsAt: summary?.endsAt || null,
    currentPeriodEnd: summary?.currentPeriodEnd || null,
    cancelAt: summary?.cancelAt || null,
    complimentary: Boolean(summary?.complimentary),
    stripeManaged: Boolean(summary?.stripeManaged),
  };
}

function rowDto(user, { plans, blocked, visits }) {
  const perAddress = plans.get(String(user._id)) || new Map();
  return {
    id: String(user._id),
    userId: user.userId || "",
    name: user.name || [user.firstName, user.lastName].filter(Boolean).join(" "),
    phone: formatPhone(user.phone),
    email: user.email || "",
    town: townOf(user),
    addresses: (user.addresses || []).map((a) => addressDto(a, perAddress.get(String(a._id)), { user })),
    blocked: blocked.has(String(user._id)),
    archived: Boolean(user.archivedAt),
    visitsCompleted: visits.get(String(user._id)) || 0,
  };
}

/** Rows for a set of users, in a fixed number of queries. */
async function buildRows(users) {
  const [plans, blocked, visits] = await Promise.all([
    loadAddressPlans(users),
    blockedUserIdSet(users),
    completedBookingCountsForUsers(users),
  ]);
  return users.map((user) => rowDto(user, { plans, blocked, visits }));
}

/* --------------------------------------------------------------- filters */

/**
 * Every customer with a not-ended subscription, with the plan summary of each
 * home. One Subscription query, one User query, one more Subscription query;
 * computed once per request and shared by the filter and all the counts.
 */
async function loadPlanIndex() {
  const candidateIds = await Subscription.distinct("user", { status: { $in: NON_ENDED_STATUSES } });
  if (!candidateIds.length) return [];
  const users = await User.find({ _id: { $in: candidateIds } }).select("_id addresses defaultAddressId").lean();
  const plans = await loadAddressPlans(users);
  return users.map((u) => ({ id: u._id, homes: [...(plans.get(String(u._id)) || new Map()).values()] }));
}

/** Users with a home in one of these plan states (and on this plan, when given: the same home). */
function idsMatching(index, statuses, plan = null) {
  const wanted = new Set(statuses);
  return index
    .filter((u) => u.homes.some((home) => wanted.has(home.planStatus) && (!plan || home.plan === plan)))
    .map((u) => u.id);
}

/** Users whose homes are in one of these plan states. */
async function userIdsWithPlanStatus(statuses) {
  return idsMatching(await loadPlanIndex(), statuses);
}

async function blockedClause() {
  const rows = await Blacklist.find({}).select("user email phone phoneDigits").lean();
  const ids = rows.map((r) => r.user).filter(Boolean);
  const emails = rows.map((r) => String(r.email || "").toLowerCase()).filter(Boolean);
  const digits = rows.map((r) => r.phoneDigits || blacklistPhoneDigits(r.phone)).filter((d) => d.length === 10);
  return { $or: [{ _id: { $in: ids } }, { email: { $in: emails } }, { "search.phone": { $in: digits } }] };
}

async function filterClause(filter) {
  if (filter === "members") return { _id: { $in: await userIdsWithPlanStatus([...MEMBER_STATUSES]) } };
  if (filter === "payment_issue") return { _id: { $in: await userIdsWithPlanStatus(["payment_issue"]) } };
  if (filter === "ending") return { _id: { $in: await userIdsWithPlanStatus(["ending"]) } };
  if (filter === "blocked") return blockedClause();
  return null;
}

/**
 * The clauses for one filter, optionally narrowed to a plan. `plan` means a
 * home on that plan that is still a membership (active, trialing, payment
 * issue or ending); with payment_issue / ending it must be the same home.
 * `ctx` caches the plan index and the block clause across filters.
 */
async function filterClauses(filter, plan, ctx) {
  const clauses = [];
  const needsIndex = plan || ["members", "payment_issue", "ending"].includes(filter);
  if (needsIndex && !ctx.index) ctx.index = await loadPlanIndex();
  if (filter === "members") clauses.push({ _id: { $in: idsMatching(ctx.index, [...MEMBER_STATUSES], plan) } });
  else if (filter === "payment_issue") clauses.push({ _id: { $in: idsMatching(ctx.index, ["payment_issue"], plan) } });
  else if (filter === "ending") clauses.push({ _id: { $in: idsMatching(ctx.index, ["ending"], plan) } });
  else if (plan) clauses.push({ _id: { $in: idsMatching(ctx.index, [...MEMBER_STATUSES], plan) } });
  if (filter === "blocked") {
    if (!ctx.blocked) ctx.blocked = await blockedClause();
    clauses.push(ctx.blocked);
  }
  return clauses;
}

function readFilter(value) {
  const filter = String(value || "all").toLowerCase();
  return FILTERS.includes(filter) ? filter : null;
}

/** "" for no plan filter, the plan key, or null when it is not a plan. */
function readPlan(value) {
  const plan = String(value || "").trim().toLowerCase();
  if (!plan) return "";
  return PLANS.includes(plan) ? plan : null;
}

/**
 * Per-filter totals with the same clauses the list uses (and the same plan
 * narrowing): one countDocuments each, in parallel, sharing one plan index.
 */
async function countCustomers({ plan = "", includeArchived = false, ctx = {} } = {}) {
  const filters = COUNT_FILTERS.filter((f) => f !== "archived" || includeArchived);
  const totals = await Promise.all(
    filters.map(async (filter) => {
      const and = [customerBaseQuery({ archivedOnly: filter === "archived" }), ...(await filterClauses(filter, plan, ctx))];
      return User.countDocuments({ $and: and });
    })
  );
  return Object.fromEntries(filters.map((filter, i) => [filter, totals[i]]));
}

/* ---------------------------------------------------------------- cursor */

function encodeCursor(user) {
  return Buffer.from(`${new Date(user.createdAt || 0).toISOString()}|${user._id}`).toString("base64url");
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const [at, id] = Buffer.from(String(cursor), "base64url").toString("utf8").split("|");
    const date = new Date(at);
    if (Number.isNaN(date.getTime()) || !mongoose.isValidObjectId(id)) return null;
    return { date, id: new mongoose.Types.ObjectId(id) };
  } catch {
    return null;
  }
}

function readLimit(value, fallback, max) {
  const n = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(n) ? Math.max(1, Math.min(n, max)) : fallback;
}

/**
 * GET /api/admin/customers
 *
 * `plan` (basic|plus|premium|elite) narrows any filter. `includeCounts` adds
 * `counts` (the first page only, by the route); `includeArchivedCount` adds
 * the archived total (owner only, by the route).
 */
async function listCustomers({ filter: rawFilter, plan: rawPlan, cursor, limit: rawLimit, includeCounts = false, includeArchivedCount = false }) {
  const filter = readFilter(rawFilter);
  if (!filter) return { error: { status: 400, code: "INVALID_FILTER", message: `filter must be one of ${FILTERS.join(", ")}` } };
  const plan = readPlan(rawPlan);
  if (plan === null) return { error: { status: 400, code: "INVALID_PLAN", message: `plan must be one of ${PLANS.join(", ")}` } };
  const limit = readLimit(rawLimit, 50, 100);
  const ctx = {};
  const and = [customerBaseQuery({ archivedOnly: filter === "archived" }), ...(await filterClauses(filter, plan, ctx))];
  const after = decodeCursor(cursor);
  if (cursor && !after) return { error: { status: 400, code: "INVALID_CURSOR", message: "Invalid cursor." } };
  if (after) and.push({ $or: [{ createdAt: { $lt: after.date } }, { createdAt: after.date, _id: { $lt: after.id } }] });

  const users = await User.find({ $and: and }).select(LIST_SELECT).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean();
  const page = users.slice(0, limit);
  const [items, counts] = await Promise.all([
    buildRows(page),
    includeCounts ? countCustomers({ plan, includeArchived: includeArchivedCount, ctx }) : Promise.resolve(null),
  ]);
  return {
    filter,
    plan: plan || null,
    items,
    nextCursor: users.length > limit ? encodeCursor(page[page.length - 1]) : null,
    counts,
  };
}

/* ---------------------------------------------------------------- search */

const PHONE_ONLY = /^[\d\s()+.\-]+$/;

/**
 * One clause per word, ANDed: "smith 11756" finds the Smith at that ZIP.
 * A word matches a name, an email, any address part, or (for 4+ digits) the
 * phone anywhere in the number, so "1234" finds the number ending 1234 and
 * "(516) 555-1234", "516.555.1234" and "+1 516 555 1234" all find the same
 * customer. The indexed search.* fields are matched first; the raw fields are
 * a fallback for accounts saved before search fields existed.
 */
function tokenClause(token) {
  const text = normalizeSearchText(token);
  const digits = normalizeSearchPhone(token);
  const or = [];
  if (text) {
    const prefix = new RegExp(`^${escapeRegex(text)}`);
    or.push({ "search.names": prefix }, { "search.emails": prefix }, { "search.addresses": prefix });
    if (text.length >= 2) {
      const contains = new RegExp(escapeRegex(text), "i");
      or.push({ name: contains }, { email: contains }, { "addresses.line1": contains }, { "addresses.city": contains }, { "addresses.zip": contains }, { address: contains }, { city: contains }, { zip: contains });
    }
  }
  if (digits.length >= 4 && PHONE_ONLY.test(token)) {
    or.push({ "search.phone": new RegExp(escapeRegex(digits)) });
    or.push({ phone: new RegExp(digits.split("").map(escapeRegex).join("\\D*")) });
  }
  return or.length ? { $or: or } : null;
}

function searchClauses(rawQuery) {
  const q = String(rawQuery || "").replace(/\u0000/g, "").trim().slice(0, 120);
  if (q.length < 2) return null;
  // A query that is only a phone number, however it is written, is one phone term.
  if (PHONE_ONLY.test(q) && normalizeSearchPhone(q).length >= 4) return [tokenClause(normalizeSearchPhone(q))];
  const clauses = q.split(/\s+/).filter(Boolean).map(tokenClause).filter(Boolean);
  return clauses.length ? clauses : null;
}

/** Customers owning a booking with this exact number. */
async function userIdsForBookingNumber(rawQuery) {
  const q = String(rawQuery || "").trim().replace(/^#/, "");
  if (!/^[A-Za-z0-9-]{3,40}$/.test(q)) return [];
  const bookings = await Booking.find({ bookingNumber: q }).select("user userId").limit(5).lean();
  const ids = bookings.map((b) => b.user).filter(Boolean);
  const publicIds = bookings.map((b) => b.userId).filter(Boolean);
  if (publicIds.length) {
    const more = await User.find({ userId: { $in: publicIds } }).select("_id").lean();
    ids.push(...more.map((u) => u._id));
  }
  return ids;
}

function relevance(user, rawQuery) {
  const q = normalizeSearchText(rawQuery);
  const digits = normalizeSearchPhone(rawQuery);
  if (q && String(user.email || "").toLowerCase() === q) return 0;
  if (digits.length >= 10 && normalizeSearchPhone(user.phone) === digits) return 0;
  if (q && normalizeSearchText(user.name).startsWith(q)) return 1;
  return 2;
}

/** POST /api/admin/customers/search */
async function searchCustomers({ q, filter: rawFilter, limit: rawLimit, includeArchived = false }) {
  const filter = readFilter(rawFilter || "all");
  if (!filter) return { error: { status: 400, code: "INVALID_FILTER", message: `filter must be one of ${FILTERS.join(", ")}` } };
  const limit = readLimit(rawLimit, 25, 50);
  const clauses = searchClauses(q);
  const bookingOwners = await userIdsForBookingNumber(q);
  if (!clauses && !bookingOwners.length) return { filter, items: [], query: String(q || "") };

  const base = customerBaseQuery({ includeArchived: includeArchived || filter === "archived", archivedOnly: filter === "archived" });
  const extra = await filterClause(filter);
  const match = [];
  if (clauses) match.push({ $and: clauses });
  if (bookingOwners.length) match.push({ _id: { $in: bookingOwners } });
  const users = await User.find({ $and: [base, ...(extra ? [extra] : []), { $or: match }] })
    .select(LIST_SELECT)
    .sort({ createdAt: -1 })
    .limit(limit * 2)
    .lean();
  const ownerSet = new Set(bookingOwners.map(String));
  users.sort((a, b) => (ownerSet.has(String(b._id)) - ownerSet.has(String(a._id))) || relevance(a, q) - relevance(b, q));
  return { filter, items: await buildRows(users.slice(0, limit)), query: String(q || "") };
}

/* ---------------------------------------------------------- global search */

const TERMINAL = /^(completed|done|cancel+ed|failed|no-show)$/i;

function jobDto(booking) {
  return {
    id: String(booking._id),
    bookingNumber: booking.bookingNumber,
    date: booking.date,
    service: booking.service,
    status: booking.status,
    customerName: booking.name || "",
    address: formatAddressLine({ line1: booking.address, unit: booking.unit, city: booking.city, state: booking.state, zip: booking.zip }),
    assignedFixterName: booking.assignedFixterName || "",
    href: `/admin/jobs/${booking._id}`,
    open: !TERMINAL.test(String(booking.status || "")),
  };
}

/**
 * Bookings matching the query. `onlyFixterId` limits a field Fixter to the
 * jobs assigned to them (owner decision Q-1), enforced in the query itself.
 */
async function searchJobs(rawQuery, { onlyFixterId = null, limit = 8 } = {}) {
  const q = String(rawQuery || "").trim().slice(0, 120);
  if (q.length < 2) return [];
  const or = [{ bookingNumber: q.replace(/^#/, "") }];
  const words = q.split(/\s+/).filter(Boolean);
  const textAnd = words.map((word) => {
    const re = new RegExp(escapeRegex(word), "i");
    const digits = normalizeSearchPhone(word);
    const options = [{ name: re }, { email: re }, { address: re }, { city: re }, { zip: re }, { service: re }];
    if (digits.length >= 4 && PHONE_ONLY.test(word)) options.push({ phone: new RegExp(digits.split("").map(escapeRegex).join("\\D*")) });
    return { $or: options };
  });
  if (PHONE_ONLY.test(q) && normalizeSearchPhone(q).length >= 4) {
    or.push({ phone: new RegExp(normalizeSearchPhone(q).split("").map(escapeRegex).join("\\D*")) });
  } else if (textAnd.length) {
    or.push({ $and: textAnd });
  }
  const query = { $or: or };
  if (onlyFixterId) query.assignedFixterId = onlyFixterId;
  const rows = await Booking.find(query)
    .select("bookingNumber date service status name address unit city state zip assignedFixterName")
    .sort({ date: -1 })
    .limit(limit)
    .lean();
  return rows.map(jobDto);
}

async function searchProjects(rawQuery, { limit = 8 } = {}) {
  const q = String(rawQuery || "").trim().slice(0, 120);
  if (q.length < 2) return [];
  let Project;
  try {
    Project = require("../../models/Project");
  } catch {
    return [];
  }
  const re = new RegExp(escapeRegex(q), "i");
  const digits = normalizeSearchPhone(q);
  const or = [{ projectNumber: re }, { customerName: re }, { email: re }, { address: re }];
  if (digits.length >= 4 && PHONE_ONLY.test(q)) or.push({ phone: new RegExp(digits.split("").map(escapeRegex).join("\\D*")) });
  const rows = await Project.find({ $or: or }).select("projectNumber customerName status address projectType").sort({ updatedAt: -1 }).limit(limit).lean();
  return rows.map((p) => ({
    id: String(p._id),
    projectNumber: p.projectNumber,
    projectType: p.projectType || "",
    customerName: p.customerName || "",
    status: p.status,
    address: p.address || "",
    href: `/admin/projects/${p._id}`,
  }));
}

module.exports = {
  FILTERS,
  LIST_SELECT,
  addressDto,
  buildRows,
  customerBaseQuery,
  filterClauses,
  PLANS,
  listCustomers,
  searchCustomers,
  searchJobs,
  searchProjects,
};
