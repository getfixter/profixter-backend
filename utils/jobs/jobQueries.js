/**
 * Read side of the new Jobs screens: lean list rows, the job detail, all-dates
 * search, the schedule and My Day. Every query here goes through
 * jobScopeFilter, so a field Fixter only ever reads their own jobs (Q-1).
 *
 * The date windows are New York days computed on the server (J-16): the list
 * no longer downloads every booking ever and filters it in the browser.
 */
const mongoose = require("mongoose");
const moment = require("moment-timezone");
const Booking = require("../../models/Booking");
const User = require("../../models/User");
const Subscription = require("../../models/Subscription");
const { PERMISSIONS } = require("../adminAccess");
const { toE164 } = require("../sms/smsPhone");
const { completedBookingCountForUser } = require("../customerBookingCounts");
const { canSeeAllJobs, hasPerm, jobScopeFilter } = require("./jobAccess");
const {
  STATUS,
  TIMEZONE,
  canonicalStatus,
  endEstimate,
  fullAddress,
  jobFlags,
  jobType,
  shortAddress,
  statusMatcher,
  timingLabel,
} = require("./jobStatus");
const { moneyBlockFor } = require("./jobMoney");

/*
 * What a scoped field Fixter (Q-1, K.1) may know about a job's money: what
 * kind of visit it is, never an amount, a tip, a payment date or a Stripe
 * reference. Labels are neutral and amount-free.
 */
const FIELD_MONEY_LABELS = {
  paid: "Paid online",
  payment_pending: "Awaiting payment",
  payment_failed: "Payment problem: the office will follow up",
  refunded: "Refunded",
  membership_included: "Membership visit",
  free: "Free Visit",
  admin_free: "Complimentary visit",
  full_day_included: "Full Day (membership)",
  full_day_loyalty: "Full Day (loyalty)",
};

function moneyForCaller(req, money) {
  if (!money || canSeeAllJobs(req)) return money;
  return { kind: money.kind, label: FIELD_MONEY_LABELS[money.kind] || "Visit" };
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const MAX_RANGE_DAYS = 62;
const ROW_FIELDS =
  "_id bookingNumber date scheduledStart scheduledEnd status bookingType accessType isFreeFirstVisit guestRequestId freeVisitChannel freeVisitPurpose freeVisitReview name phone user address city state zip assignedFixterId assignedFixterName paymentState paymentHoldExpiresAt reservationIssue updatedAt";

const VIEWS = new Set(["today", "tomorrow", "week", "range", "needs_action"]);
/* Default statuses: everything except Canceled (the old calendar counted those, J-16). */
const ACTIVE_STATUSES = [STATUS.PENDING, STATUS.PENDING_CONFIRMATION, STATUS.CONFIRMED, STATUS.COMPLETED];
const STATUS_ALIASES = {
  pending: [STATUS.PENDING],
  pending_confirmation: [STATUS.PENDING_CONFIRMATION],
  requests: [STATUS.PENDING, STATUS.PENDING_CONFIRMATION],
  confirmed: [STATUS.CONFIRMED],
  completed: [STATUS.COMPLETED],
  canceled: [STATUS.CANCELED],
  cancelled: [STATUS.CANCELED],
  active: ACTIVE_STATUSES,
  all: [...ACTIVE_STATUSES, STATUS.CANCELED],
};

class JobQueryError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

/* -------------------------------- windows -------------------------------- */

function nyStartOfDay(now = new Date()) {
  return moment.tz(now, TIMEZONE).startOf("day");
}

/** { from, to } as YYYY-MM-DD plus the [start, end) Date range for a view. */
function windowFor(view, { from, to, now = new Date() } = {}) {
  const today = nyStartOfDay(now);
  if (view === "today") return bounds(today, today);
  if (view === "tomorrow") {
    const t = today.clone().add(1, "day");
    return bounds(t, t);
  }
  if (view === "week") return bounds(today, today.clone().add(6, "days"));
  if (view === "range") {
    const start = moment.tz(String(from || ""), "YYYY-MM-DD", true, TIMEZONE);
    const end = to ? moment.tz(String(to), "YYYY-MM-DD", true, TIMEZONE) : start.clone();
    if (!start.isValid() || !end.isValid()) throw new JobQueryError("INVALID_RANGE", "from and to must be YYYY-MM-DD");
    if (end.isBefore(start)) throw new JobQueryError("INVALID_RANGE", "to is before from");
    if (end.diff(start, "days") + 1 > MAX_RANGE_DAYS) throw new JobQueryError("RANGE_TOO_LONG", `A range can cover at most ${MAX_RANGE_DAYS} days`);
    return bounds(start, end);
  }
  throw new JobQueryError("INVALID_VIEW", "view must be today, tomorrow, week, range or needs_action");
}

function bounds(startDay, endDay) {
  return {
    from: startDay.format("YYYY-MM-DD"),
    to: endDay.format("YYYY-MM-DD"),
    start: startDay.clone().startOf("day").toDate(),
    end: endDay.clone().add(1, "day").startOf("day").toDate(),
  };
}

function parseStatuses(value) {
  if (!value) return ACTIVE_STATUSES;
  const out = new Set();
  for (const part of String(value).split(",").map((p) => p.trim().toLowerCase()).filter(Boolean)) {
    const mapped = STATUS_ALIASES[part];
    if (!mapped) throw new JobQueryError("INVALID_STATUS", `Unknown status filter "${part}"`);
    mapped.forEach((s) => out.add(s));
  }
  return [...out];
}

/** The tech filter: an id, "unassigned" or "me". A scoped caller's is always themselves. */
function techFilter(req, tech) {
  if (!canSeeAllJobs(req)) return {};
  const value = String(tech || "").trim();
  if (!value) return {};
  if (value === "me") return { assignedFixterId: req.accessUser?._id || null };
  if (value === "unassigned") return { assignedFixterId: null };
  if (!mongoose.isValidObjectId(value)) throw new JobQueryError("INVALID_TECH", "tech must be a Fixter id, me or unassigned");
  return { assignedFixterId: new mongoose.Types.ObjectId(value) };
}

/* --------------------------------- cursor -------------------------------- */

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ d: new Date(row.date).getTime(), id: String(row._id) })).toString("base64url");
}

function decodeCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    if (!Number.isFinite(parsed.d) || !mongoose.isValidObjectId(parsed.id)) throw new Error("bad");
    return { date: new Date(parsed.d), id: new mongoose.Types.ObjectId(parsed.id) };
  } catch {
    throw new JobQueryError("INVALID_CURSOR", "cursor is not valid");
  }
}

function cursorFilter(cursor, descending) {
  if (!cursor) return {};
  const op = descending ? "$lt" : "$gt";
  return { $or: [{ date: { [op]: cursor.date } }, { date: cursor.date, _id: { [op]: cursor.id } }] };
}

/* ---------------------------------- rows --------------------------------- */

function town(booking) {
  return String(booking.city || "").trim();
}

/** The lean list row (JobRow). */
function toJobRow(booking, now = new Date()) {
  const { type, typeLabel } = jobType(booking);
  const end = endEstimate(booking);
  const userId = booking.user ? String(booking.user._id || booking.user) : null;
  return {
    id: String(booking._id),
    bookingNumber: booking.bookingNumber || "",
    date: booking.date ? new Date(booking.date).toISOString() : null,
    endEstimate: end ? end.toISOString() : null,
    status: canonicalStatus(booking.status),
    type,
    typeLabel,
    customer: {
      id: userId,
      name: booking.name || "",
      ...(booking.phone ? { phone: booking.phone } : {}),
    },
    addressShort: shortAddress(booking),
    town: town(booking),
    technician: booking.assignedFixterId
      ? { id: String(booking.assignedFixterId), name: booking.assignedFixterName || "" }
      : null,
    flags: jobFlags(booking, now),
    timing: timingLabel(booking, now),
    updatedAt: booking.updatedAt ? new Date(booking.updatedAt).toISOString() : null,
  };
}

/* ------------------------------ needs action ----------------------------- */

const CLOSE_LAG_MS = require("../bookingReminderPolicy").FIXTER_CLOSE_LAG_MS;
const NON_FINAL = [STATUS.PENDING, STATUS.PENDING_CONFIRMATION, STATUS.CONFIRMED];

/**
 * The bookings that need somebody: requests to review, upcoming unassigned
 * jobs, Confirmed jobs not closed 2h after their start, payment problems and
 * reservation issues. One filter, shared by the Needs-action collector, the
 * list's needs_action view and the counts, so the three can never disagree.
 */
function needsActionFilter(now = new Date()) {
  const startOfToday = nyStartOfDay(now).toDate();
  return {
    $or: [
      { status: statusMatcher([STATUS.PENDING, STATUS.PENDING_CONFIRMATION]) },
      { status: statusMatcher(NON_FINAL), assignedFixterId: null, date: { $gte: startOfToday } },
      { status: statusMatcher([STATUS.CONFIRMED]), date: { $lt: new Date(now.getTime() - CLOSE_LAG_MS) } },
      { status: statusMatcher(NON_FINAL), paymentState: { $in: ["failed", "expired"] } },
      { status: statusMatcher(NON_FINAL), paymentState: "pending", paymentHoldExpiresAt: { $ne: null, $lt: now } },
      { status: statusMatcher(NON_FINAL), "reservationIssue.status": { $nin: ["", null] } },
    ],
  };
}

/**
 * Needs action as the caller may act on it. A field Fixter cannot confirm
 * requests, assign, or deal with payments, so for them it holds only their own
 * Confirmed jobs that are past time and not closed - the one thing they can do.
 * Everyone else gets the full filter. Used by the list, the badge count and the
 * collector alike, so the three numbers stay equal for every role.
 */
function needsActionFilterFor(req, now = new Date()) {
  const scope = jobScopeFilter(req);
  if (canSeeAllJobs(req)) return { ...needsActionFilter(now), ...scope };
  return { status: statusMatcher([STATUS.CONFIRMED]), date: { $lt: new Date(now.getTime() - CLOSE_LAG_MS) }, ...scope };
}

/** The one reason a booking is in Needs action, most serious first. */
function needsActionReason(booking, now = new Date()) {
  const status = canonicalStatus(booking.status);
  const nonFinal = NON_FINAL.includes(status);
  const startMs = new Date(booking.date).getTime();
  if (nonFinal && booking.reservationIssue?.status) {
    return { kind: "job_reservation_issue", reason: booking.reservationIssue.message || "The reservation needs review.", severity: "problem" };
  }
  if (nonFinal && ["failed", "expired"].includes(booking.paymentState)) {
    return { kind: "job_payment_problem", reason: booking.paymentState === "expired" ? "The payment window expired." : "The payment failed.", severity: "problem" };
  }
  if (nonFinal && booking.paymentState === "pending" && booking.paymentHoldExpiresAt && new Date(booking.paymentHoldExpiresAt) < now) {
    return { kind: "job_payment_problem", reason: "Payment is still pending after the hold expired.", severity: "problem" };
  }
  if (status === STATUS.CONFIRMED && Number.isFinite(startMs) && startMs < now.getTime() - CLOSE_LAG_MS) {
    return { kind: "job_not_closed", reason: "Confirmed and more than 2 hours past its start, but not closed.", severity: "problem" };
  }
  if (status === STATUS.PENDING || status === STATUS.PENDING_CONFIRMATION) {
    const soon = Number.isFinite(startMs) && startMs < now.getTime() + 24 * 60 * 60 * 1000;
    return {
      kind: "job_request",
      reason: status === STATUS.PENDING_CONFIRMATION ? "Free-visit request to review." : "Request waiting for confirmation.",
      severity: soon ? "problem" : "attention",
    };
  }
  if (nonFinal && !booking.assignedFixterId) {
    return { kind: "job_unassigned", reason: "No Fixter assigned.", severity: "attention" };
  }
  return null;
}

async function needsActionBookings(req, { now = new Date(), limit = 50 } = {}) {
  const filter = needsActionFilterFor(req, now);
  const [count, rows] = await Promise.all([
    Booking.countDocuments(filter),
    Booking.find(filter).sort({ date: 1, _id: 1 }).limit(Math.min(Math.max(1, limit), MAX_LIMIT)).select(ROW_FIELDS).lean(),
  ]);
  return { count, rows, filter };
}

/* --------------------------------- list ---------------------------------- */

async function listJobs(req, { view = "today", from, to, tech, status, cursor, limit, now = new Date() } = {}) {
  if (!VIEWS.has(view)) throw new JobQueryError("INVALID_VIEW", "view must be today, tomorrow, week, range or needs_action");
  const size = Math.min(Math.max(1, Number(limit) || DEFAULT_LIMIT), MAX_LIMIT);
  if (view === "needs_action") {
    const { count, rows } = await needsActionBookings(req, { now, limit: size });
    return { view, from: null, to: null, total: count, rows: rows.map((b) => toJobRow(b, now)), nextCursor: null, counts: await jobCounts(req, { now }) };
  }
  const win = windowFor(view, { from, to, now });
  const statuses = parseStatuses(status);
  const onlyFinished = statuses.every((s) => s === STATUS.COMPLETED || s === STATUS.CANCELED);
  const descending = onlyFinished; // completed/canceled views read newest first (J-16)
  const base = {
    date: { $gte: win.start, $lt: win.end },
    status: statusMatcher(statuses),
    ...techFilter(req, tech),
    ...jobScopeFilter(req),
  };
  const filter = { ...base, ...cursorFilter(decodeCursor(cursor), descending) };
  const dir = descending ? -1 : 1;
  const [total, docs] = await Promise.all([
    Booking.countDocuments(base),
    Booking.find(filter).sort({ date: dir, _id: dir }).limit(size + 1).select(ROW_FIELDS).lean(),
  ]);
  const page = docs.slice(0, size);
  return {
    view,
    from: win.from,
    to: win.to,
    total,
    rows: page.map((b) => toJobRow(b, now)),
    nextCursor: docs.length > size ? encodeCursor(page[page.length - 1]) : null,
    counts: await jobCounts(req, { now }),
  };
}

/** The badge numbers, from the same windows and scope the list uses. */
async function jobCounts(req, { now = new Date() } = {}) {
  const scope = jobScopeFilter(req);
  const count = (view) => {
    const win = windowFor(view, { now });
    return Booking.countDocuments({ date: { $gte: win.start, $lt: win.end }, status: statusMatcher(ACTIVE_STATUSES), ...scope });
  };
  const [today, tomorrow, week, needsAction] = await Promise.all([
    count("today"),
    count("tomorrow"),
    count("week"),
    Booking.countDocuments(needsActionFilterFor(req, now)),
  ]);
  return { today, tomorrow, week, needsAction };
}

/* -------------------------------- search --------------------------------- */

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Search across ALL dates (J-13): name, email, address, booking number and
 * phone digits (with or without the leading 1, whatever the stored format).
 * The text arrives in a POST body, never a URL.
 */
async function searchJobs(req, { q, limit, now = new Date() } = {}) {
  const text = String(q || "").trim().slice(0, 120);
  if (text.length < 2) throw new JobQueryError("QUERY_TOO_SHORT", "Type at least 2 characters");
  const size = Math.min(Math.max(1, Number(limit) || 50), 100);
  const pattern = new RegExp(escapeRegex(text), "i");
  const or = [{ name: pattern }, { email: pattern }, { address: pattern }, { city: pattern }, { bookingNumber: pattern }];
  let digits = text.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (digits.length >= 4) {
    // Digits in order with any separators between them: matches "+1 (516) 555-0142", "5165550142", ...
    or.push({ phone: new RegExp(digits.split("").join("\\D*")) });
  }
  const docs = await Booking.find({ $or: or, ...jobScopeFilter(req) })
    .sort({ date: -1, _id: -1 })
    .limit(size)
    .select(ROW_FIELDS)
    .lean();
  // Upcoming first (soonest first), then the past (most recent first).
  const startOfToday = nyStartOfDay(now).toDate().getTime();
  const upcoming = docs.filter((d) => new Date(d.date).getTime() >= startOfToday).sort((a, b) => new Date(a.date) - new Date(b.date));
  const past = docs.filter((d) => new Date(d.date).getTime() < startOfToday);
  const rows = [...upcoming, ...past].map((b) => toJobRow(b, now));
  const groups = [];
  for (const row of rows) {
    const date = row.date ? moment.tz(row.date, TIMEZONE).format("YYYY-MM-DD") : "";
    const last = groups[groups.length - 1];
    if (last && last.date === date) last.rows.push(row);
    else groups.push({ date, rows: [row] });
  }
  return { q: text, total: rows.length, limited: docs.length >= size, groups };
}

/* -------------------------------- detail --------------------------------- */

function formatPhone(value) {
  const e164 = toE164(value);
  if (!e164) return { formatted: String(value || ""), e164: null };
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return { formatted: m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164, e164 };
}

async function customerSummary(req, booking) {
  const phone = formatPhone(booking.phone);
  const summary = {
    id: booking.user ? String(booking.user._id || booking.user) : null,
    name: booking.name || "",
    phone: phone.formatted,
    phoneE164: phone.e164,
    email: booking.email || "",
    guest: !booking.user,
  };
  if (!booking.user) return summary;
  const user = await User.findById(booking.user._id || booking.user).select("_id userId name").lean();
  if (!user) return summary;
  summary.visitsCompleted = await completedBookingCountForUser(user).catch(() => null);
  // Plan state is membership information: only for callers who may read memberships.
  if (hasPerm(req, PERMISSIONS.MEMBERS_READ) || hasPerm(req, PERMISSIONS.CUSTOMERS_MANAGE)) {
    const sub = booking.addressId
      ? await Subscription.findOne({ user: user._id, addressId: booking.addressId })
          .sort({ updatedAt: -1 })
          .select("subscriptionType billingCycle status cancelAtPeriodEnd")
          .lean()
      : null;
    summary.plan = sub
      ? { plan: sub.subscriptionType || "", billingCycle: sub.billingCycle || "monthly", status: sub.status || "", cancelAtPeriodEnd: !!sub.cancelAtPeriodEnd }
      : null;
  }
  return summary;
}

function staffNotesOf(booking) {
  return (booking.staffNotes || []).map((note) => ({
    id: String(note._id),
    text: note.text,
    authorId: note.authorId ? String(note.authorId) : null,
    authorName: note.authorName || "",
    authorRole: note.authorRole || "",
    at: note.at,
  }));
}

/** Charge customer: the Owner or a General Fixter (utils/extraCharges/access.js), on a confirmed or completed visit. */
function canChargeExtra(req, booking) {
  return require("../extraCharges/access").canChargeCustomers(req) && [STATUS.CONFIRMED, STATUS.COMPLETED].includes(canonicalStatus(booking.status));
}

async function extraChargeSummary(bookingId) {
  const AdditionalCharge = require("../../models/AdditionalCharge");
  const rows = await AdditionalCharge.find({ booking: bookingId }).select("status totalCents refundedCents").lean();
  const paidStates = ["paid", "partially_refunded", "refunded"];
  return {
    count: rows.length,
    paidCents: rows.filter((r) => paidStates.includes(r.status)).reduce((sum, r) => sum + r.totalCents - Number(r.refundedCents || 0), 0),
    open: rows.filter((r) => ["charging", "processing", "awaiting_payment", "failed"].includes(r.status)).length,
  };
}

/** The JobDetail DTO. `allowedActions` is computed by the caller's rules. */
async function jobDetail(req, booking, { now = new Date() } = {}) {
  const { allowedActionsFor } = require("../bookingTransitions");
  const row = toJobRow(booking, now);
  const [customer, fullMoney] = await Promise.all([customerSummary(req, booking), moneyBlockFor(booking)]);
  const money = moneyForCaller(req, fullMoney);
  return {
    ...row,
    customer,
    address: {
      line1: booking.address || "",
      city: booking.city || "",
      state: booking.state || "",
      zip: booking.zip || "",
      full: fullAddress(booking),
    },
    service: booking.service || "",
    selectedTask: booking.selectedTask || "",
    description: booking.note || "",
    adminNote: booking.adminNote || "",
    photos: (booking.images || []).map(String),
    libraryReference: booking.libraryReference || "",
    money,
    staffNotes: staffNotesOf(booking),
    freeVisit: booking.guestRequestId || booking.freeVisitChannel
      ? {
          channel: booking.guestRequestId ? "callback" : booking.freeVisitChannel || "",
          purpose: booking.freeVisitPurpose || "",
          reviewRequired: Boolean(booking.freeVisitReview?.required && !booking.freeVisitReview?.acknowledgedAt),
        }
      : null,
    reservationIssue: booking.reservationIssue?.status
      ? { status: booking.reservationIssue.status, message: booking.reservationIssue.message || "" }
      : null,
    cancellationReason: canonicalStatus(booking.status) === STATUS.CANCELED ? booking.cancellationReason || "" : "",
    completedAt: booking.completedAt || null,
    createdAt: booking.createdAt || null,
    allowedActions: [...allowedActionsFor(req, booking), ...(canChargeExtra(req, booking) ? ["chargeExtra"] : [])],
    // Owner and General Fixter only: the charges on this visit, summarised; the sheet loads the full list.
    extraCharges: require("../extraCharges/access").canChargeCustomers(req) ? await extraChargeSummary(booking._id) : undefined,
    history: { href: `/api/admin/bookings/${booking._id}/history` },
  };
}

/* ------------------------------- schedule -------------------------------- */

async function capacityForRange({ from, to, tech, now }) {
  const { calculateDayFromContext, loadAvailabilityContext } = require("../availabilityService");
  const scope = tech && mongoose.isValidObjectId(tech) ? "technician" : "company";
  const context = await loadAvailabilityContext({ from, to, scope, technicianId: scope === "technician" ? tech : null });
  const days = [];
  for (let d = moment.tz(from, "YYYY-MM-DD", TIMEZONE); !d.isAfter(moment.tz(to, "YYYY-MM-DD", TIMEZONE)); d.add(1, "day")) {
    const date = d.format("YYYY-MM-DD");
    const day = calculateDayFromContext({ date, context, now, includeDetails: false });
    days.push({
      date,
      closed: day.closed,
      note: day.note || "",
      totalCapacity: day.totalCapacity,
      usedCapacity: day.usedCapacity,
      openSlotCount: day.openSlotCount,
      slots: day.slots.map((s) => ({
        time: s.time,
        endTime: s.endTime,
        totalCapacity: s.totalCapacity,
        usedCapacity: s.usedCapacity,
        remainingCapacity: s.remainingCapacity,
        open: s.open,
      })),
    });
  }
  return { scope, days };
}

/**
 * Jobs whose technician holds another blocking reservation overlapping
 * theirs: the engine's own overlap rule (slotStart < otherEnd && slotEnd >
 * otherStart, reserved or unexpired held), read for the whole window in one
 * query instead of one technicianOverlap call per job.
 * @returns Map<bookingIdString, reason>
 */
async function technicianConflicts(docs, win, now) {
  const out = new Map();
  const techIds = [...new Set(docs.map((d) => d.assignedFixterId).filter(Boolean).map(String))];
  if (!techIds.length) return out;
  const BookingSlotReservation = require("../../models/BookingSlotReservation");
  const { blockingReservationFilter } = require("../slotReservationService");
  // Reach a little past the window so an overlap across midnight is still seen.
  const reservations = await BookingSlotReservation.find({
    technicianId: { $in: techIds.map((id) => new mongoose.Types.ObjectId(id)) },
    ...blockingReservationFilter(now),
    slotStart: { $lt: new Date(win.end.getTime() + 24 * 3600 * 1000) },
    slotEnd: { $gt: new Date(win.start.getTime() - 24 * 3600 * 1000) },
  })
    .select("bookingId technicianId slotStart slotEnd")
    .lean();
  const byTech = new Map();
  for (const r of reservations) {
    const key = String(r.technicianId);
    if (!byTech.has(key)) byTech.set(key, []);
    byTech.get(key).push(r);
  }
  const numberOf = new Map(docs.map((d) => [String(d._id), d.bookingNumber || ""]));
  for (const list of byTech.values()) {
    list.sort((a, b) => new Date(a.slotStart) - new Date(b.slotStart));
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i];
        const b = list[j];
        if (new Date(b.slotStart) >= new Date(a.slotEnd)) break;
        if (String(a.bookingId) === String(b.bookingId)) continue;
        const mark = (self, other) => {
          const id = String(self.bookingId);
          if (out.has(id) || !numberOf.has(id)) return;
          const otherNumber = numberOf.get(String(other.bookingId));
          out.set(id, `Overlaps another visit for this Fixter${otherNumber ? ` (#${otherNumber})` : ""}.`);
        };
        mark(a, b);
        mark(b, a);
      }
    }
  }
  return out;
}

/**
 * Day/week schedule: jobs grouped by technician, plus capacity and closed
 * slots from the availability engine (the same reader the calendar uses).
 * Capacity is shown to callers with schedule or assignment rights only.
 */
async function scheduleView(req, { from, to, tech, now = new Date() } = {}) {
  const win = windowFor("range", { from, to, now });
  if (moment.tz(win.to, TIMEZONE).diff(moment.tz(win.from, TIMEZONE), "days") + 1 > 14) {
    throw new JobQueryError("RANGE_TOO_LONG", "The schedule covers at most 14 days");
  }
  const filter = {
    date: { $gte: win.start, $lt: win.end },
    status: statusMatcher(ACTIVE_STATUSES),
    ...techFilter(req, tech),
    ...jobScopeFilter(req),
  };
  const docs = await Booking.find(filter).sort({ date: 1, _id: 1 }).limit(1000).select(ROW_FIELDS).lean();
  const conflicts = await technicianConflicts(docs, win, now);
  const lanes = new Map();
  for (const doc of docs) {
    const key = doc.assignedFixterId ? String(doc.assignedFixterId) : "";
    if (!lanes.has(key)) {
      lanes.set(key, { technician: key ? { id: key, name: doc.assignedFixterName || "" } : null, rows: [] });
    }
    const conflict = conflicts.get(String(doc._id));
    lanes.get(key).rows.push({
      ...toJobRow(doc, now),
      conflict: Boolean(conflict),
      ...(conflict ? { conflictReason: conflict } : {}),
    });
  }
  const ordered = [...lanes.values()].sort((a, b) => {
    if (!a.technician) return 1;
    if (!b.technician) return -1;
    return a.technician.name.localeCompare(b.technician.name);
  });
  let capacity = null;
  let capacityError = null;
  if (hasPerm(req, PERMISSIONS.SCHEDULE_READ) || canSeeAllJobs(req)) {
    try {
      capacity = await capacityForRange({ from: win.from, to: win.to, tech: canSeeAllJobs(req) ? tech : null, now });
    } catch (error) {
      capacityError = { code: error?.code || "CAPACITY_UNAVAILABLE", message: error?.message || "Capacity could not be loaded" };
    }
  }
  return { from: win.from, to: win.to, lanes: ordered, total: docs.length, capacity, capacityError };
}

/* -------------------------------- my day --------------------------------- */

/** The caller's own jobs today and tomorrow (Q-10), whatever their other rights. */
async function myDay(req, { now = new Date() } = {}) {
  const me = req.accessUser?._id;
  const section = async (view) => {
    const win = windowFor(view, { now });
    const docs = await Booking.find({
      date: { $gte: win.start, $lt: win.end },
      status: statusMatcher(ACTIVE_STATUSES),
      assignedFixterId: me || new mongoose.Types.ObjectId(),
    })
      .sort({ date: 1, _id: 1 })
      .select(ROW_FIELDS)
      .lean();
    return { date: win.from, rows: docs.map((b) => toJobRow(b, now)) };
  };
  const [today, tomorrow] = await Promise.all([section("today"), section("tomorrow")]);
  return { today, tomorrow };
}

module.exports = {
  needsActionFilterFor,
  ACTIVE_STATUSES,
  JobQueryError,
  ROW_FIELDS,
  jobCounts,
  jobDetail,
  listJobs,
  myDay,
  needsActionBookings,
  needsActionFilter,
  needsActionReason,
  parseStatuses,
  scheduleView,
  searchJobs,
  toJobRow,
  windowFor,
};
