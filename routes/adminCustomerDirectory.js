/**
 * Admin customers, redesigned: list, search, profile, membership actions,
 * block, notes, archive. Mounted under /api/admin by routes/admin.js.
 *
 *   GET    /customers?filter&cursor&limit           lean rows, cursor paging
 *   POST   /customers/search  {q, filter, limit}    search (text in the body)
 *   POST   /search            {q}                   customers + jobs + projects
 *   GET    /customers/:id                           profile summary + allowedActions
 *   GET    /customers/:id/visits?cursor&limit
 *   GET    /customers/:id/billing                   read-only Stripe proxy
 *   GET    /customers/:id/gifts
 *   GET    /customers/:id/payment-links
 *   GET    /customers/:id/notes     POST /customers/:id/notes {text}
 *   GET    /customers/:id/consent                   read only
 *   POST   /customers/:id/addresses/:addressId/plan-change/preview {plan, cycle?}
 *   POST   /customers/:id/addresses/:addressId/plan-change/confirm {previewToken, idempotencyKey}
 *   POST   /customers/:id/addresses/:addressId/cancellation {mode, date?, confirm, idempotencyKey}
 *   POST   /customers/:id/addresses/:addressId/complimentary {plan, reason, confirm, endsOn?}  owner
 *   POST   /customers/:id/block {reason}    DELETE /customers/:id/block {reason?}
 *   POST   /customers/:id/archive {reason?} POST /customers/:id/unarchive   owner
 *
 * Errors are { message, code }. Customer accounts only: the owner and staff
 * records are 403 FORBIDDEN_RECORD for everyone.
 */
const express = require("express");
const mongoose = require("mongoose");

const auth = require("../middleware/auth");
const { PERMISSIONS, hasPermission, requirePermission, requireAnyPermission } = require("../middleware/authorize");
const User = require("../models/User");
const Booking = require("../models/Booking");
const Blacklist = require("../models/Blacklist");
const ConsentEvent = require("../models/ConsentEvent");
const GiftMembership = require("../models/GiftMembership");
const AdminPaymentLink = require("../models/AdminPaymentLink");
const { createAdminActivityLog } = require("../utils/adminActivityLog");
const { communicationState } = require("../utils/admin/communicationControls");
const { optOutFor } = require("../utils/sms/smsEligibility");
const { toE164 } = require("../utils/sms/smsPhone");
const { completedBookingCountForUser } = require("../utils/customerBookingCounts");
const { adminLoyaltyForUsers } = require("../utils/loyalty/adminLoyalty");
const { formatAddressLine, formatPhone } = require("../utils/formatAddress");
const { findActiveBlockForUser } = require("../utils/customerBlock");
const { loadAddressPlans } = require("../utils/admin/planStatus");
const { billingForCustomer } = require("../utils/admin/customerBilling");
const directory = require("../utils/admin/customerDirectory");
const membership = require("../utils/admin/membershipActions");

const router = express.Router();
const customersManage = requirePermission(PERMISSIONS.CUSTOMERS_MANAGE);
const customersOrMembers = requireAnyPermission(PERMISSIONS.CUSTOMERS_MANAGE, PERMISSIONS.MEMBERS_READ);
const blacklistManage = requirePermission(PERMISSIONS.BLACKLIST_MANAGE);
const ownerOnly = requirePermission(PERMISSIONS.ADMIN);
const anySearch = requireAnyPermission(
  PERMISSIONS.CUSTOMERS_MANAGE,
  PERMISSIONS.MEMBERS_READ,
  PERMISSIONS.BOOKINGS_READ,
  PERMISSIONS.PROJECTS_MANAGE
);

const ADMIN_EMAIL = () => String(process.env.MAIL_ADMIN || "getfixter@gmail.com").toLowerCase();
const isStaff = (user) =>
  String(user?.email || "").toLowerCase() === ADMIN_EMAIL() || user?.role === "admin" || user?.role === "employee" || Boolean(user?.employeePosition);

function actor(req) {
  const a = req.accessUser || req.authUser || {};
  return { id: a._id || req.user?.id || null, name: a.name || a.email || "Admin" };
}

/** A field Fixter (Q-1): position Fixter without the owner-granted Jobs section. */
function isFieldFixter(req) {
  return req.accessRole !== "admin" && req.accessUser?.employeePosition === "Fixter" && !hasPermission(req, PERMISSIONS.BOOKINGS_ASSIGN);
}

function sendError(res, error, label) {
  if (error instanceof membership.MembershipActionError) {
    return res.status(error.status).json({ message: error.message, code: error.code, ...(error.extra || {}) });
  }
  console.error(`${label}:`, error);
  return res.status(500).json({ message: "Something went wrong. Nothing was changed.", code: "SERVER_ERROR" });
}

const LOAD_SELECT =
  "userId name firstName lastName email phone role employeePosition addresses defaultAddressId createdAt updatedAt archivedAt archivedByName archiveReason phoneVerifiedAt emailVerifiedAt signupMethod adminNotes stripeCustomerId smsPreferences emailPreferences excludeFromMarketing isActive";

/** The target customer, or an error response. Owner and staff records are never targets. */
async function loadCustomer(req, res, select = LOAD_SELECT) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(400).json({ message: "Invalid customer id", code: "INVALID_ID" });
    return null;
  }
  const user = await User.findById(req.params.id).select(`${select} role employeePosition email`).lean();
  if (!user) {
    res.status(404).json({ message: "Customer not found", code: "NOT_FOUND" });
    return null;
  }
  if (isStaff(user)) {
    res.status(403).json({ message: "Only customer accounts.", code: "FORBIDDEN_RECORD" });
    return null;
  }
  return user;
}

const visitMatch = (user) => ({ $or: [{ user: user._id }, ...(user.userId ? [{ userId: String(user.userId) }] : [])] });
const TERMINAL_RE = /^\s*(completed|done|cancel+ed|failed|no-show|declined|expired)\s*$/i;

function visitDto(b) {
  return {
    id: String(b._id),
    bookingNumber: b.bookingNumber,
    date: b.date,
    service: b.service,
    status: b.status,
    accessType: b.accessType || null,
    bookingType: b.bookingType || null,
    paymentState: b.paymentState || null,
    addressId: b.addressId ? String(b.addressId) : null,
    address: formatAddressLine({ line1: b.address, unit: b.unit, city: b.city, state: b.state, zip: b.zip }),
    assignedFixterName: b.assignedFixterName || "",
    href: `/admin/jobs/${b._id}`,
  };
}
const VISIT_SELECT = "bookingNumber date service status accessType bookingType paymentState addressId address unit city state zip assignedFixterName";

function blockDto(entry) {
  return {
    id: String(entry._id),
    reason: entry.reason || "",
    blockedAt: entry.createdAt || null,
    blockedByName: entry.blockedByName || "",
    liftedAt: entry.liftedAt || null,
    liftedByName: entry.liftedByName || "",
    liftReason: entry.liftReason || "",
    active: !entry.liftedAt,
  };
}

async function blockHistoryFor(user) {
  const or = [{ user: user._id }];
  if (user.email) or.push({ email: String(user.email).toLowerCase() });
  const rows = await Blacklist.find({ $or: or }).setOptions({ includeLifted: true }).sort({ createdAt: -1 }).limit(20).lean();
  return rows.map(blockDto);
}

function noteDto(note) {
  return { id: String(note._id), text: note.text, authorName: note.authorName || "", at: note.at };
}

function allowedActionsFor(req, user, { blocked }) {
  const owner = req.accessRole === "admin";
  const manage = hasPermission(req, PERMISSIONS.CUSTOMERS_MANAGE);
  const archived = Boolean(user.archivedAt);
  return {
    editProfile: manage,
    editContact: owner,
    changePlan: manage,
    scheduleCancellation: manage,
    grantComplimentary: owner,
    sellMembership: manage,
    createVisit: hasPermission(req, PERMISSIONS.BOOKINGS_WRITE),
    addInternalNote: manage,
    block: hasPermission(req, PERMISSIONS.BLACKLIST_MANAGE) && !blocked,
    unblock: hasPermission(req, PERMISSIONS.BLACKLIST_MANAGE) && blocked,
    archive: owner && !archived,
    unarchive: owner && archived,
    viewBilling: true,
    changeCommunication: manage,
  };
}

/* ------------------------------------------------------------ list/search */

router.get("/customers", auth, ...customersOrMembers, async (req, res) => {
  try {
    const result = await directory.listCustomers({ filter: req.query.filter, cursor: req.query.cursor, limit: req.query.limit });
    if (result.error) return res.status(result.error.status).json({ message: result.error.message, code: result.error.code });
    return res.json(result);
  } catch (error) {
    return sendError(res, error, "GET /admin/customers");
  }
});

router.post("/customers/search", auth, ...customersOrMembers, async (req, res) => {
  try {
    const body = req.body || {};
    const result = await directory.searchCustomers({ q: body.q, filter: body.filter, limit: body.limit, includeArchived: body.includeArchived === true });
    if (result.error) return res.status(result.error.status).json({ message: result.error.message, code: result.error.code });
    return res.json(result);
  } catch (error) {
    return sendError(res, error, "POST /admin/customers/search");
  }
});

/*
 * One box, three kinds of result, each only for those allowed to see it:
 * customers (All Users or Members, never a field Fixter), jobs (Jobs; a field
 * Fixter gets only the jobs assigned to them), projects (Projects).
 */
router.post("/search", auth, ...anySearch, async (req, res) => {
  try {
    const q = String(req.body?.q || "");
    const fieldFixter = isFieldFixter(req);
    const canCustomers = !fieldFixter && (hasPermission(req, PERMISSIONS.CUSTOMERS_MANAGE) || hasPermission(req, PERMISSIONS.MEMBERS_READ));
    const canJobs = hasPermission(req, PERMISSIONS.BOOKINGS_READ);
    const canProjects = hasPermission(req, PERMISSIONS.PROJECTS_MANAGE);
    const [customers, jobs, projects] = await Promise.all([
      canCustomers ? directory.searchCustomers({ q, limit: 8 }).then((r) => r.items || []) : [],
      canJobs ? directory.searchJobs(q, { onlyFixterId: fieldFixter ? req.accessUser._id : null }) : [],
      canProjects ? directory.searchProjects(q) : [],
    ]);
    return res.json({
      query: q,
      customers: customers.map((c) => ({ ...c, href: `/admin/customers/${c.id}` })),
      jobs,
      projects,
      scopes: { customers: canCustomers, jobs: canJobs ? (fieldFixter ? "assigned" : "all") : false, projects: canProjects },
    });
  } catch (error) {
    return sendError(res, error, "POST /admin/search");
  }
});

/* ---------------------------------------------------------------- profile */

router.get("/customers/:id", auth, ...customersOrMembers, async (req, res) => {
  try {
    const user = await loadCustomer(req, res);
    if (!user) return undefined;
    const now = new Date();
    const showLoyalty = hasPermission(req, PERMISSIONS.MEMBERS_READ);
    const [plans, block, blockHistory, visitsCompleted, nextVisit, lastVisit, comms, loyaltyRows] = await Promise.all([
      loadAddressPlans([user], { now }),
      findActiveBlockForUser(user),
      blockHistoryFor(user),
      completedBookingCountForUser(user),
      Booking.findOne({ ...visitMatch(user), date: { $gte: now }, status: { $not: TERMINAL_RE } }).select(VISIT_SELECT).sort({ date: 1 }).lean(),
      Booking.findOne({ ...visitMatch(user), date: { $lt: now }, status: { $not: /^\s*cancel+ed\s*$/i } }).select(VISIT_SELECT).sort({ date: -1 }).lean(),
      communicationState(user).catch(() => null),
      showLoyalty ? adminLoyaltyForUsers([user], { allAddresses: true, now }).catch(() => []) : Promise.resolve([]),
    ]);
    const perAddress = plans.get(String(user._id)) || new Map();
    const loyaltyByAddress = new Map(loyaltyRows.map((row) => [String(row.addressId), row.loyalty]));

    return res.json({
      customer: {
        id: String(user._id),
        userId: user.userId || "",
        name: user.name || [user.firstName, user.lastName].filter(Boolean).join(" "),
        firstName: user.firstName || "",
        lastName: user.lastName || "",
        email: user.email || "",
        phone: user.phone || "",
        phoneFormatted: formatPhone(user.phone),
        signupMethod: user.signupMethod || null,
        customerSince: user.createdAt || null,
        updatedAt: user.updatedAt || null,
        archivedAt: user.archivedAt || null,
      },
      addresses: (user.addresses || []).map((a) => {
        const dto = directory.addressDto(a, perAddress.get(String(a._id)), { user });
        const loyalty = loyaltyByAddress.get(String(a._id));
        return {
          ...dto,
          introVisitStatus: a.introVisit?.status || null,
          loyalty: loyalty
            ? {
                standing: loyalty.standing?.label || "",
                standingKey: loyalty.standing?.key || "",
                countedMonths: loyalty.countedMonths || 0,
                nextMilestone: loyalty.nextMilestone || null,
                monthsRemaining: loyalty.monthsRemaining ?? null,
                nextReward: loyalty.nextReward || null,
                expectedDate: loyalty.expectedDate || null,
                benefitsEarned: loyalty.benefitsEarned || 0,
              }
            : null,
        };
      }),
      visits: {
        completed: visitsCompleted,
        next: nextVisit ? visitDto(nextVisit) : null,
        last: lastVisit ? visitDto(lastVisit) : null,
      },
      flags: {
        blocked: Boolean(block),
        blockedReason: block && hasPermission(req, PERMISSIONS.BLACKLIST_MANAGE) ? block.reason || "" : undefined,
        phoneVerified: Boolean(user.phoneVerifiedAt),
        emailVerified: Boolean(user.emailVerifiedAt),
        textsOk: Boolean(comms?.service?.sms?.enabled),
        offersByTextOk: Boolean(comms?.marketing?.sms?.enabled && comms?.marketing?.sms?.delivery?.sending),
        archived: Boolean(user.archivedAt),
        hasStripeCustomer: Boolean(user.stripeCustomerId),
      },
      blockHistory: hasPermission(req, PERMISSIONS.BLACKLIST_MANAGE) ? blockHistory : undefined,
      notesCount: (user.adminNotes || []).length,
      allowedActions: allowedActionsFor(req, user, { blocked: Boolean(block) }),
    });
  } catch (error) {
    return sendError(res, error, "GET /admin/customers/:id");
  }
});

router.get("/customers/:id/visits", auth, ...customersOrMembers, async (req, res) => {
  try {
    const user = await loadCustomer(req, res, "userId");
    if (!user) return undefined;
    const limit = Math.max(1, Math.min(Number.parseInt(String(req.query.limit || "25"), 10) || 25, 100));
    const and = [visitMatch(user)];
    if (req.query.cursor) {
      const [at, id] = Buffer.from(String(req.query.cursor), "base64url").toString("utf8").split("|");
      const date = new Date(at);
      if (Number.isNaN(date.getTime()) || !mongoose.isValidObjectId(id)) return res.status(400).json({ message: "Invalid cursor", code: "INVALID_CURSOR" });
      and.push({ $or: [{ date: { $lt: date } }, { date, _id: { $lt: new mongoose.Types.ObjectId(id) } }] });
    }
    const rows = await Booking.find({ $and: and }).select(VISIT_SELECT).sort({ date: -1, _id: -1 }).limit(limit + 1).lean();
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return res.json({
      items: page.map(visitDto),
      nextCursor: rows.length > limit ? Buffer.from(`${new Date(last.date).toISOString()}|${last._id}`).toString("base64url") : null,
    });
  } catch (error) {
    return sendError(res, error, "GET /admin/customers/:id/visits");
  }
});

router.get("/customers/:id/billing", auth, ...customersOrMembers, async (req, res) => {
  try {
    const user = await loadCustomer(req, res, "stripeCustomerId");
    if (!user) return undefined;
    return res.json(await billingForCustomer(user, { fresh: req.query.fresh === "1" }));
  } catch (error) {
    return sendError(res, error, "GET /admin/customers/:id/billing");
  }
});

router.get("/customers/:id/gifts", auth, ...customersOrMembers, async (req, res) => {
  try {
    const user = await loadCustomer(req, res, "email");
    if (!user) return undefined;
    const or = [{ purchaser: user._id }, { recipient: user._id }];
    if (user.email) or.push({ recipientEmail: String(user.email).toLowerCase() });
    const gifts = await GiftMembership.find({ $or: or })
      .select("giftNumber purchaser purchaserSnapshot recipient recipientEmail recipientFirstName recipientLastName plan durationMonths status addressId purchasedAt claimedAt createdAt")
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    return res.json({
      items: gifts.map((g) => ({
        id: String(g._id),
        giftNumber: g.giftNumber,
        role: String(g.purchaser) === String(user._id) ? "purchased" : "received",
        plan: g.plan,
        durationMonths: g.durationMonths,
        status: g.status,
        purchaserName: g.purchaserSnapshot?.name || "",
        recipientName: [g.recipientFirstName, g.recipientLastName].filter(Boolean).join(" "),
        recipientEmail: g.recipientEmail || "",
        addressId: g.addressId ? String(g.addressId) : null,
        purchasedAt: g.purchasedAt || g.createdAt || null,
        claimedAt: g.claimedAt || null,
      })),
    });
  } catch (error) {
    return sendError(res, error, "GET /admin/customers/:id/gifts");
  }
});

/** sent | paid | expired | canceled, as the customer would find the link today. */
function paymentLinkStatus(link, booking, now) {
  if (link.status === "paid" || link.paidAt) return "paid";
  if (link.status === "canceled") return "canceled";
  if (booking && booking.paymentState === "paid") return "paid";
  if (link.status === "expired" || new Date(link.expiresAt).getTime() <= now.getTime()) return "expired";
  if (booking && (["expired", "failed"].includes(booking.paymentState) || /cancel/i.test(String(booking.status || "")))) return "expired";
  return "sent";
}

router.get("/customers/:id/payment-links", auth, ...customersOrMembers, async (req, res) => {
  try {
    const user = await loadCustomer(req, res, "userId");
    if (!user) return undefined;
    const links = await AdminPaymentLink.find({ user: user._id })
      .select("kind addressId plan billingCycle booking itemLabel status expiresAt sentVia openedCount lastOpenedAt paidAt createdAt createdByName")
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    const bookingIds = links.map((l) => l.booking).filter(Boolean);
    const bookings = bookingIds.length ? await Booking.find({ _id: { $in: bookingIds } }).select("paymentState status bookingNumber").lean() : [];
    const byId = new Map(bookings.map((b) => [String(b._id), b]));
    const now = new Date();
    return res.json({
      items: links.map((l) => {
        const booking = l.booking ? byId.get(String(l.booking)) : null;
        return {
          id: String(l._id),
          kind: l.kind,
          itemLabel: l.itemLabel || "",
          status: paymentLinkStatus(l, booking, now),
          plan: l.plan || null,
          billingCycle: l.billingCycle || null,
          addressId: l.addressId ? String(l.addressId) : null,
          bookingId: l.booking ? String(l.booking) : null,
          bookingNumber: booking?.bookingNumber || null,
          sentVia: l.sentVia || [],
          expiresAt: l.expiresAt,
          openedCount: l.openedCount || 0,
          lastOpenedAt: l.lastOpenedAt || null,
          paidAt: l.paidAt || null,
          createdAt: l.createdAt,
          createdByName: l.createdByName || "",
        };
      }),
    });
  } catch (error) {
    return sendError(res, error, "GET /admin/customers/:id/payment-links");
  }
});

/* ------------------------------------------------------------------ notes */

router.get("/customers/:id/notes", auth, ...customersOrMembers, async (req, res) => {
  try {
    const user = await loadCustomer(req, res, "adminNotes");
    if (!user) return undefined;
    const notes = [...(user.adminNotes || [])].sort((a, b) => new Date(b.at) - new Date(a.at)).map(noteDto);
    return res.json({ items: notes });
  } catch (error) {
    return sendError(res, error, "GET /admin/customers/:id/notes");
  }
});

router.post("/customers/:id/notes", auth, ...customersManage, async (req, res) => {
  try {
    const user = await loadCustomer(req, res, "name userId");
    if (!user) return undefined;
    const text = String(req.body?.text || "").replace(/\u0000/g, "").trim();
    if (!text) return res.status(400).json({ message: "Write the note first.", code: "NOTE_REQUIRED" });
    if (text.length > 2000) return res.status(400).json({ message: "Notes are up to 2000 characters.", code: "NOTE_TOO_LONG" });
    const who = actor(req);
    const note = { _id: new mongoose.Types.ObjectId(), text, authorId: who.id, authorName: who.name, at: new Date() };
    await User.updateOne({ _id: user._id }, { $push: { adminNotes: note } }, { runValidators: false });
    await createAdminActivityLog(req, {
      action: "Customer Note Added",
      entityType: "User",
      entityId: user._id,
      entityName: user.name || user.userId,
      details: { noteId: String(note._id), text, before: null, after: { noteId: String(note._id) } },
    });
    return res.status(201).json({ note: noteDto(note) });
  } catch (error) {
    return sendError(res, error, "POST /admin/customers/:id/notes");
  }
});

/* ---------------------------------------------------------------- consent */

/*
 * What this customer agreed to, and the evidence. READ ONLY: switches are
 * changed through PUT /users/:id/communication exactly as before; nothing
 * here alters consent or the rules that read it.
 */
router.get("/customers/:id/consent", auth, ...customersOrMembers, async (req, res) => {
  try {
    const user = await loadCustomer(req, res);
    if (!user) return undefined;
    const owner = req.accessRole === "admin";
    const prefs = user.smsPreferences || {};
    const e164 = toE164(user.phone);
    const [state, optOut, events] = await Promise.all([
      communicationState(user),
      e164 ? optOutFor(e164) : null,
      ConsentEvent.find({ user: user._id }).sort({ at: -1 }).limit(100).lean(),
    ]);
    const recorderIds = [...new Set(events.map((e) => e.recordedBy).filter(Boolean).map(String))];
    const recorders = recorderIds.length ? await User.find({ _id: { $in: recorderIds } }).select("name").lean() : [];
    const recorderName = new Map(recorders.map((r) => [String(r._id), r.name || ""]));
    return res.json({
      switches: state,
      evidence: {
        serviceSms: { enabled: prefs.transactionalEnabled === true, at: prefs.transactionalConsentAt || null, source: prefs.transactionalConsentSource || "" },
        marketingSms: {
          enabled: prefs.marketingEnabled === true,
          at: prefs.marketingConsentAt || null,
          source: prefs.marketingConsentSource || "",
          method: prefs.marketingConsentMethod || "",
          evidence: prefs.marketingConsentEvidence || "",
        },
        serviceEmail: { enabled: user.emailPreferences?.serviceEnabled !== false, changedAt: user.emailPreferences?.serviceChangedAt || null, source: user.emailPreferences?.serviceChangeSource || "" },
        marketingEmail: { at: user.emailPreferences?.marketingConsentAt || null, source: user.emailPreferences?.marketingConsentSource || "" },
      },
      stop: {
        phoneOptedOut: Boolean(optOut),
        scope: optOut?.scope || "",
        at: optOut?.optedOutAt || null,
        source: optOut?.source || "",
      },
      history: events.map((e) => ({
        id: String(e._id),
        at: e.at,
        channel: e.channel,
        purpose: e.purpose,
        action: e.action,
        source: e.source,
        method: e.method || "",
        evidence: e.evidence || "",
        consentText: e.consentText || "",
        detail: e.detail || "",
        recordedByName: e.recordedBy ? recorderName.get(String(e.recordedBy)) || "" : "",
        ...(owner ? { ip: e.ip || "" } : {}),
      })),
    });
  } catch (error) {
    return sendError(res, error, "GET /admin/customers/:id/consent");
  }
});

/* ------------------------------------------------------------- membership */

const homeRoute = (suffix) => `/customers/:id/addresses/:addressId/${suffix}`;

router.post(homeRoute("plan-change/preview"), auth, ...customersManage, async (req, res) => {
  try {
    const result = await membership.previewPlanChange({ userId: req.params.id, addressId: req.params.addressId, plan: req.body?.plan, cycle: req.body?.cycle });
    return res.json(result);
  } catch (error) {
    return sendError(res, error, "POST plan-change/preview");
  }
});

router.post(homeRoute("plan-change/confirm"), auth, ...customersManage, async (req, res) => {
  try {
    const outcome = await membership.confirmPlanChange({
      userId: req.params.id,
      addressId: req.params.addressId,
      previewToken: req.body?.previewToken,
      idempotencyKey: req.body?.idempotencyKey,
      req,
    });
    return res.status(outcome.status).json(outcome.body);
  } catch (error) {
    return sendError(res, error, "POST plan-change/confirm");
  }
});

router.post(homeRoute("cancellation"), auth, ...customersManage, async (req, res) => {
  try {
    const outcome = await membership.setCancellation({
      userId: req.params.id,
      addressId: req.params.addressId,
      mode: req.body?.mode,
      date: req.body?.date,
      confirm: req.body?.confirm,
      idempotencyKey: req.body?.idempotencyKey,
      req,
    });
    return res.status(outcome.status).json(outcome.body);
  } catch (error) {
    return sendError(res, error, "POST cancellation");
  }
});

router.post(homeRoute("complimentary"), auth, ...ownerOnly, async (req, res) => {
  try {
    const result = await membership.grantComplimentary({
      userId: req.params.id,
      addressId: req.params.addressId,
      plan: req.body?.plan,
      reason: req.body?.reason,
      confirm: req.body?.confirm,
      endsOn: req.body?.endsOn || null,
      req,
    });
    return res.status(201).json(result);
  } catch (error) {
    return sendError(res, error, "POST complimentary");
  }
});

/* ------------------------------------------------------------------ block */

router.post("/customers/:id/block", auth, ...blacklistManage, async (req, res) => {
  try {
    const user = await loadCustomer(req, res, "userId name email phone addresses defaultAddressId");
    if (!user) return undefined;
    const reason = String(req.body?.reason || "").trim().slice(0, 500);
    if (reason.length < 3) return res.status(400).json({ message: "Give the reason for blocking.", code: "REASON_REQUIRED" });
    const existing = await findActiveBlockForUser(user);
    if (existing) return res.status(409).json({ message: "This customer is already blocked.", code: "ALREADY_BLOCKED", block: blockDto(existing) });
    const home = (user.addresses || []).find((a) => String(a._id) === String(user.defaultAddressId || "")) || (user.addresses || [])[0] || {};
    const who = actor(req);
    const entry = await Blacklist.create({
      user: user._id,
      userId: user.userId,
      name: user.name,
      email: user.email || undefined,
      phone: user.phone || "",
      address: formatAddressLine(home),
      city: home.city || "",
      county: home.county || "",
      state: home.state || "",
      zip: home.zip || "",
      reason,
      blockedBy: who.id,
      blockedByName: who.name,
    });
    await createAdminActivityLog(req, {
      action: "Customer Blocked",
      entityType: "User",
      entityId: user._id,
      entityName: user.name || user.email || user.userId,
      details: { userId: user.userId, reason, blacklistId: String(entry._id), before: { blocked: false }, after: { blocked: true } },
    });
    return res.status(201).json({ blocked: true, block: blockDto(entry.toObject()), history: await blockHistoryFor(user) });
  } catch (error) {
    return sendError(res, error, "POST /admin/customers/:id/block");
  }
});

/** Lift every active entry covering this person. The entries stay, as history. */
async function liftBlocksFor(user, { req, reason }) {
  const or = [{ user: user._id }];
  if (user.email) or.push({ email: String(user.email).toLowerCase() });
  const digits = String(user.phone || "").replace(/\D/g, "").replace(/^1(\d{10})$/, "$1");
  if (digits.length === 10) or.push({ phoneDigits: digits });
  const active = await Blacklist.find({ $or: or }).lean();
  if (!active.length) return [];
  const who = actor(req);
  await Blacklist.updateMany(
    { _id: { $in: active.map((e) => e._id) }, liftedAt: null },
    { $set: { liftedAt: new Date(), liftedBy: who.id, liftedByName: who.name, liftReason: reason } }
  );
  return active;
}

router.delete("/customers/:id/block", auth, ...blacklistManage, async (req, res) => {
  try {
    const user = await loadCustomer(req, res, "userId name email phone");
    if (!user) return undefined;
    const reason = String(req.body?.reason || "").trim().slice(0, 500);
    const lifted = await liftBlocksFor(user, { req, reason });
    if (!lifted.length) return res.status(409).json({ message: "This customer is not blocked.", code: "NOT_BLOCKED" });
    await createAdminActivityLog(req, {
      action: "Customer Unblocked",
      entityType: "User",
      entityId: user._id,
      entityName: user.name || user.email || user.userId,
      details: { userId: user.userId, reason, blacklistIds: lifted.map((e) => String(e._id)), before: { blocked: true, reasons: lifted.map((e) => e.reason || "") }, after: { blocked: false } },
    });
    return res.json({ blocked: false, history: await blockHistoryFor(user) });
  } catch (error) {
    return sendError(res, error, "DELETE /admin/customers/:id/block");
  }
});

/* ---------------------------------------------------------------- archive */

router.post("/customers/:id/archive", auth, ...ownerOnly, async (req, res) => {
  try {
    const user = await loadCustomer(req, res, "userId name archivedAt");
    if (!user) return undefined;
    if (user.archivedAt) return res.status(409).json({ message: "Already archived.", code: "ALREADY_ARCHIVED" });
    const who = actor(req);
    const reason = String(req.body?.reason || "").trim().slice(0, 500);
    const at = new Date();
    await User.updateOne({ _id: user._id }, { $set: { archivedAt: at, archivedBy: who.id, archivedByName: who.name, archiveReason: reason } }, { runValidators: false });
    await createAdminActivityLog(req, {
      action: "Customer Archived",
      entityType: "User",
      entityId: user._id,
      entityName: user.name || user.userId,
      details: { userId: user.userId, reason, before: { archived: false }, after: { archived: true, archivedAt: at.toISOString() } },
    });
    return res.json({ archived: true, archivedAt: at });
  } catch (error) {
    return sendError(res, error, "POST /admin/customers/:id/archive");
  }
});

router.post("/customers/:id/unarchive", auth, ...ownerOnly, async (req, res) => {
  try {
    const user = await loadCustomer(req, res, "userId name archivedAt");
    if (!user) return undefined;
    if (!user.archivedAt) return res.status(409).json({ message: "This customer is not archived.", code: "NOT_ARCHIVED" });
    await User.updateOne({ _id: user._id }, { $set: { archivedAt: null, archivedBy: null, archivedByName: "", archiveReason: "" } }, { runValidators: false });
    await createAdminActivityLog(req, {
      action: "Customer Unarchived",
      entityType: "User",
      entityId: user._id,
      entityName: user.name || user.userId,
      details: { userId: user.userId, before: { archived: true, archivedAt: user.archivedAt }, after: { archived: false } },
    });
    return res.json({ archived: false });
  } catch (error) {
    return sendError(res, error, "POST /admin/customers/:id/unarchive");
  }
});

module.exports = router;
module.exports.liftBlocksFor = liftBlocksFor;
module.exports.blockHistoryFor = blockHistoryFor;
