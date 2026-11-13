// 📁 backend/routes/admin.js — per-address subscription aware (FINAL, DB-only)
const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();

const auth = require("../middleware/auth");
const { PERMISSIONS, requirePermission, requireAnyPermission } = require("../middleware/authorize");
const smsNotify = require("../utils/sms/smsNotifications");
const { optOutFor } = require("../utils/sms/smsEligibility");
const { toE164, maskPhone } = require("../utils/sms/smsPhone");
const { consentResetForPhoneChange } = require("../utils/sms/consentOnPhoneChange");
const { normalizePhoneE164 } = require("../utils/identity");
const { maskPhone: maskPhoneForLog } = require("../utils/customerProfileEdit");
const User = require("../models/User");
const Booking = require("../models/Booking");
const Referral = require("../models/Referral");
const Blacklist = require("../models/Blacklist");
const Subscription = require("../models/Subscription");
const CalendarConfig = require("../models/CalendarConfig");
const SlotCounter = require("../models/SlotCounter");
const BookingHistory = require("../models/BookingHistory");
const EmailLog = require("../models/EmailLog");
const AdminActivityLog = require("../models/AdminActivityLog");
const {
  createAdminActivityLog,
  markAdminActivityLog,
} = require("../utils/adminActivityLog");
const {
  snapshot: bookingSnapshot,
  logBookingChanges,
} = require("../utils/bookingHistory");
const {
  evaluate24HourReminder,
  evaluate60MinuteReminder,
  REMINDER_LOCK_STALE_MS,
} = require("../utils/bookingReminderPolicy");
const {
  evaluateReviewRequest,
  isCompletionTransition,
} = require("../utils/bookingReviewRequestPolicy");
const { tipUrlForBooking } = require("../utils/fixterTips");
const {
  cancelBookingWithReservation,
  findEligibleTechnicians,
  moveReservationForBooking,
  reservationEngineEnabled,
  resetBookingReminderEmailStateForDateChange,
  transitionBookingWithReservation,
} = require("../utils/slotReservationService");
const {
  getOneTimeVisitSettings,
  upsertOneTimeVisitSettings,
} = require("../utils/oneTimeVisitSettings");
const {
  uploadAppointmentPhotos,
  storeAppointmentImages,
} = require("../utils/bookingAttachments");
const {
  actorSnapshot,
  appendContentUpdate,
} = require("../utils/bookingContentUpdates");
const { buildUserSearchFields } = require("../utils/userSearchFields");
const { completedBookingCountsForUsers, completedBookingCountForUser } = require("../utils/customerBookingCounts");
const { adminLoyaltyForUsers, programActive: loyaltyProgramActive } = require("../utils/loyalty/adminLoyalty");
const { effectiveAt: loyaltyEffectiveAt } = require("../utils/loyalty/loyaltyConfig");
const { loadAddressPlans } = require("../utils/admin/planStatus");
const { findActiveBlockForUser } = require("../utils/customerBlock");
const { formatAddressLine } = require("../utils/formatAddress");

const mail = require("../utils/emailService");
const Request = require("../models/Request");
const EstimateLead = require("../models/EstimateLead");
const {
  stripe,
  normalizePlanType,
  normalizeStripeStatus,
  resolveStripePriceId,
  classifyPlanChange,
  resolveStripeSubscriptionForRecord,
  getStripeSubscriptionItemForRecord,
  applyStripeSubscriptionUpgrade,
  scheduleStripeSubscriptionDowngrade,
  upsertSubscriptionFromStripe,
  clearStripeSubscriptionSchedule,
  subscriptionGrantsAccess,
  selectCurrentSubscription,
  subscriptionSelectionDiagnostics,
  syncCustomerFromStripe,
} = require("../utils/subscriptionManagement");

const ADMIN_EMAIL = process.env.MAIL_ADMIN || "getfixter@gmail.com";

/* ───────────────── helpers ───────────────── */
const ymdInTZ = (d, tz) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
const hhmmInTZ = (d, tz) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);

// ✅ Middleware: Allow only admin
const legacyOnlyAdmin = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user || user.email !== ADMIN_EMAIL) {
      return res.status(403).json({ message: "Access denied. Admins only." });
    }
    next();
  } catch (err) {
    console.error("❌ Admin check failed:", err);
    res.status(err?.statusCode || 500).json({ message: err.message || "Server error" });
  }
};

/* ───────────────── per-address plan helper ───────────────── */
/*
 * Guards. Owner-only things (settings, repair and debug tools, deleting a
 * customer account) keep onlyAdmin. Everything else is a section permission
 * from utils/adminAccess.js that the owner can grant per employee.
 */
const onlyAdmin = requirePermission(PERMISSIONS.ADMIN);
const bookingsWrite = requirePermission(PERMISSIONS.BOOKINGS_WRITE);
const { declineGuestVisit, isPendingFreeVisit, syncLeadFromBooking } = require("../utils/freeVisit/guestVisit");
const bookingsAssign = requirePermission(PERMISSIONS.BOOKINGS_ASSIGN);
const customersManage = requirePermission(PERMISSIONS.CUSTOMERS_MANAGE);
const blacklistManage = requirePermission(PERMISSIONS.BLACKLIST_MANAGE);
const leadsManage = requirePermission(PERMISSIONS.LEADS_MANAGE);
const activityRead = requirePermission(PERMISSIONS.ACTIVITY_READ);

const { canAccessJob, canSeeAllJobs, jobScopeFilter, sendForbiddenRecord } = require("../utils/jobs/jobAccess");
const { legacyActionFor, performTransition } = require("../utils/bookingTransitions");
const { notifyRescheduled } = require("../utils/jobs/jobNotifications");
const { canonicalStatus: canonicalBookingStatus, STATUS: JOB_STATUS } = require("../utils/jobs/jobStatus");
/* Never sent by the legacy booking list or status reply; no Admin screen reads them. */
const LEGACY_HIDDEN_BOOKING_FIELDS = "-freeVisitIdentity -guestContactConsent.ip -checkoutClientKey -freeVisitClientKey";
function legacyBookingView(booking) {
  const out = booking?.toObject ? booking.toObject() : { ...(booking || {}) };
  delete out.freeVisitIdentity;
  delete out.checkoutClientKey;
  delete out.freeVisitClientKey;
  delete out.staffNotes;
  if (out.guestContactConsent) out.guestContactConsent = { ...out.guestContactConsent, ip: undefined };
  return out;
}

const isOwnerAccount = (user) =>
  String(user?.email || "").toLowerCase() === String(ADMIN_EMAIL).toLowerCase() || user?.role === "admin";
const isStaffAccount = (user) => isOwnerAccount(user) || user?.role === "employee";

/*
 * An employee holding a customer section acts on CUSTOMER accounts only: not
 * on the owner, not on other staff. Without this, "All Users" would let them
 * edit the owner's phone or blacklist a colleague. The owner is unaffected.
 */
function customerTargetsOnly(param = "id") {
  return async (req, res, next) => {
    if (req.accessRole === "admin") return next();
    try {
      const target = await User.findById(req.params[param]).select("email role").lean();
      if (target && isStaffAccount(target)) return res.status(403).json({ message: "Access denied" });
      return next();
    } catch (error) {
      return next();
    }
  };
}

const ONE_TIME_SETTING_FIELDS = new Set([
  "enabled",
  "priceCents",
  "durationMinutes",
  "stripePriceId",
  "holdMinutes",
  "cancellationPhone",
  "allowedServices",
  "excludedServices",
  "promoNote",
]);

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function terminalBookingStatuses() {
  return ["completed", "cancelled", "canceled", "done", "failed", "no-show"];
}
void legacyOnlyAdmin;

router.get("/one-time-visit-settings", auth, ...onlyAdmin, async (_req, res) => {
  try {
    const settings = await getOneTimeVisitSettings();
    return res.json(settings);
  } catch (error) {
    console.error("One-time visit settings load failed:", error.message);
    return res.status(500).json({ message: "Failed to load one-time visit settings" });
  }
});

router.put("/one-time-visit-settings", auth, ...onlyAdmin, async (req, res) => {
  try {
    const patch = {};
    for (const [key, value] of Object.entries(req.body || {})) {
      if (ONE_TIME_SETTING_FIELDS.has(key)) patch[key] = value;
    }

    const settings = await upsertOneTimeVisitSettings(patch);
    return res.json(settings);
  } catch (error) {
    console.error("One-time visit settings update failed:", error.message);
    return res.status(400).json({
      message: error.message || "Failed to update one-time visit settings",
    });
  }
});

/*
 * Per-address plan rows for the Admin lists (addressesDetailed).
 *
 * The response shape is the one the current Admin screens read, unchanged:
 * `plan` is set only while the membership grants access, exactly as before.
 * Added alongside, for the redesigned screens: unit, planStatus (active,
 * trialing, payment_issue, ending, ended, none), currentPeriodEnd, cancelAt.
 *
 * Loaded for many customers with ONE Subscription query (utils/admin/planStatus)
 * instead of one query per customer in a serial loop.
 */
function addressRowsFor(user, perAddress) {
  return (user.addresses || []).map((a) => {
    const summary = perAddress?.get(String(a._id)) || null;
    const granting = Boolean(summary?.grantsAccess);
    return {
      _id: String(a._id),
      label: a.label,
      line1: a.line1,
      unit: a.unit || "",
      city: a.city,
      state: a.state,
      zip: a.zip,
      county: a.county || "",
      isDefault: String(user.defaultAddressId || "") === String(a._id),
      plan: granting ? summary.lastPlan : null,
      scheduledCancellationDate:
        granting && summary.cancellationDate ? summary.cancellationDate.toISOString().split("T")[0] : null,
      planStatus: summary?.planStatus || "none",
      currentPeriodEnd: summary?.currentPeriodEnd || null,
      cancelAt: summary?.cancelAt || null,
    };
  });
}

async function getAddressPlansForUsers(users) {
  const plans = await loadAddressPlans(users);
  const out = new Map();
  for (const user of users) out.set(String(user._id), addressRowsFor(user, plans.get(String(user._id))));
  return out;
}

async function getAddressPlansForUser(user) {
  return (await getAddressPlansForUsers([user])).get(String(user._id)) || [];
}

function maskExternalId(value) {
  if (!value) return null;
  const text = String(value);
  if (text.length <= 12) return `${text.slice(0, 4)}...`;
  return `${text.slice(0, 8)}...${text.slice(-4)}`;
}

function stripeTimestamp(value) {
  if (!value) return null;
  const date = new Date(Number(value) * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

function serializeStripeSubscriptionForDiagnostics(subscription) {
  if (!subscription) return null;
  const item = subscription.items?.data?.[0] || null;
  return {
    stripeSubscriptionId: maskExternalId(subscription.id),
    stripeCustomerId: maskExternalId(subscription.customer),
    status: subscription.status || null,
    normalizedStatus: normalizeStripeStatus(subscription.status),
    cancelAtPeriodEnd: !!subscription.cancel_at_period_end,
    currentPeriodEnd: stripeTimestamp(subscription.current_period_end),
    createdAt: stripeTimestamp(subscription.created),
    metadata: {
      userId: subscription.metadata?.userId || null,
      email: subscription.metadata?.email || null,
      addressId: subscription.metadata?.addressId || null,
      plan: subscription.metadata?.plan || null,
      billingCycle: subscription.metadata?.billingCycle || null,
    },
    priceId: maskExternalId(item?.price?.id),
    interval: item?.price?.recurring?.interval || null,
  };
}

function chooseActiveStripeSubscription(stripeSubscriptions = []) {
  return stripeSubscriptions
    .filter((subscription) =>
      ["active", "trialing"].includes(normalizeStripeStatus(subscription?.status))
    )
    .sort((left, right) => {
      const leftStatusRank = normalizeStripeStatus(left?.status) === "active" ? 2 : 1;
      const rightStatusRank = normalizeStripeStatus(right?.status) === "active" ? 2 : 1;
      if (leftStatusRank !== rightStatusRank) return rightStatusRank - leftStatusRank;

      const leftPeriodEnd = Number(left?.current_period_end || 0);
      const rightPeriodEnd = Number(right?.current_period_end || 0);
      if (leftPeriodEnd !== rightPeriodEnd) return rightPeriodEnd - leftPeriodEnd;

      return Number(right?.created || 0) - Number(left?.created || 0);
    })[0] || null;
}

async function findUserForSubscriptionRepair({
  userId,
  email,
  stripeCustomerId,
  stripeSubscription = null,
}) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const clauses = [];

  if (userId && mongoose.isValidObjectId(userId)) clauses.push({ _id: userId });
  if (userId) clauses.push({ userId: String(userId) });
  if (normalizedEmail) clauses.push({ email: normalizedEmail });
  if (stripeCustomerId) clauses.push({ stripeCustomerId: String(stripeCustomerId) });
  if (stripeSubscription?.customer) {
    clauses.push({ stripeCustomerId: String(stripeSubscription.customer) });
  }
  if (stripeSubscription?.metadata?.email) {
    clauses.push({ email: String(stripeSubscription.metadata.email).trim().toLowerCase() });
  }
  if (stripeSubscription?.metadata?.userId) {
    clauses.push({ userId: String(stripeSubscription.metadata.userId) });
  }

  let user = clauses.length ? await User.findOne({ $or: clauses }) : null;
  const customerId = stripeCustomerId || stripeSubscription?.customer || null;
  if (!user && customerId) {
    user = await syncCustomerFromStripe(String(customerId));
  }

  return user;
}

async function collectStripeSubscriptionsForUserRepair({
  user,
  email,
  stripeCustomerId,
  stripeSubscriptionId,
}) {
  const customerIds = new Set(
    [stripeCustomerId, user?.stripeCustomerId].filter(Boolean).map((value) => String(value))
  );
  const subscriptionsById = new Map();

  if (stripeSubscriptionId) {
    const subscription = await stripe.subscriptions.retrieve(String(stripeSubscriptionId), {
      expand: ["items.data.price"],
    });
    subscriptionsById.set(String(subscription.id), subscription);
    if (subscription.customer) customerIds.add(String(subscription.customer));
  }

  const normalizedEmail = String(email || user?.email || "").trim().toLowerCase();
  if (!customerIds.size && normalizedEmail) {
    const customers = await stripe.customers.list({ email: normalizedEmail, limit: 10 });
    for (const customer of customers.data || []) {
      if (customer?.id) customerIds.add(String(customer.id));
    }
  }

  for (const customerId of customerIds) {
    const page = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 100,
      expand: ["data.items.data.price"],
    });
    for (const subscription of page.data || []) {
      subscriptionsById.set(String(subscription.id), subscription);
    }
  }

  return {
    customerIds: Array.from(customerIds),
    stripeSubscriptions: Array.from(subscriptionsById.values()),
  };
}

async function syncActiveStripeSubscriptionForUser(user, options = {}) {
  const localBefore = await Subscription.find({ user: user._id }).sort({
    currentPeriodEnd: -1,
    nextPaymentDate: -1,
    createdAt: -1,
    updatedAt: -1,
  });
  const selectedBefore = selectCurrentSubscription(localBefore);
  const beforeDiagnostics = subscriptionSelectionDiagnostics(localBefore, selectedBefore);
  const alreadyGrantingAccess =
    selectedBefore && subscriptionGrantsAccess(selectedBefore) ? selectedBefore : null;

  const { customerIds, stripeSubscriptions } = await collectStripeSubscriptionsForUserRepair({
    user,
    email: options.email,
    stripeCustomerId: options.stripeCustomerId,
    stripeSubscriptionId: options.stripeSubscriptionId,
  });
  const selectedStripeSubscription = chooseActiveStripeSubscription(stripeSubscriptions);

  if (!selectedStripeSubscription) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "admin_subscription_repair_no_active_stripe_subscription",
        scope: "admin_subscription_sync",
        userId: String(user._id),
        publicUserId: user.userId || null,
        email: user.email || null,
        source: options.source || "admin_repair",
        scannedStripeCustomers: customerIds.map(maskExternalId),
        localSelection: beforeDiagnostics,
      })
    );

    return {
      repaired: false,
      reason: alreadyGrantingAccess
        ? "local_subscription_already_grants_access"
        : "no_active_stripe_subscription_found",
      user,
      localBefore,
      localAfter: localBefore,
      selectedBefore,
      selectedAfter: selectedBefore,
      stripeSubscriptions,
      selectedStripeSubscription: null,
      customerIds,
    };
  }

  const synced = await upsertSubscriptionFromStripe({
    stripeSubscription: selectedStripeSubscription,
    user,
    addressIdHint: selectedStripeSubscription.metadata?.addressId || null,
  });

  const localAfter = await Subscription.find({ user: user._id }).sort({
    currentPeriodEnd: -1,
    nextPaymentDate: -1,
    createdAt: -1,
    updatedAt: -1,
  });
  const selectedAfter = selectCurrentSubscription(localAfter);
  const afterDiagnostics = subscriptionSelectionDiagnostics(localAfter, selectedAfter);

  console.log(
    JSON.stringify({
      level: "info",
      event: "admin_subscription_repair_completed",
      scope: "admin_subscription_sync",
      userId: String(user._id),
      publicUserId: user.userId || null,
      email: user.email || null,
      source: options.source || "admin_repair",
      selectedStripeSubscriptionId: maskExternalId(selectedStripeSubscription.id),
      selectedLocalSubscriptionId: String(selectedAfter?._id || ""),
      ignoredSubscriptions: afterDiagnostics.filter((entry) => !entry.selected),
    })
  );

  return {
    repaired: !!synced,
    reason: synced ? "active_stripe_subscription_synced" : "stripe_subscription_not_synced",
    user,
    localBefore,
    localAfter,
    selectedBefore,
    selectedAfter,
    stripeSubscriptions,
    selectedStripeSubscription,
    customerIds,
  };
}

// DEBUG: see exactly what Admin will render for one user
router.get("/users/:id/addressesDetailed", auth, ...customersManage, customerTargetsOnly(), async (req, res) => {
  const u = await User.findById(req.params.id).lean();
  if (!u) return res.status(404).json({ message: "User not found" });
  const rows = await getAddressPlansForUser(u);
  res.json(rows);
});

/**
 * What this customer has actually agreed to be texted about.
 *
 * READ-ONLY, AND DELIBERATELY SO.
 *
 * There is no matching write route and there must never be one. Consent is
 * something the customer performs; an admin button that set transactionalEnabled
 * would manufacture a record asserting they did something they did not, which is
 * worse than having no record at all - it is a false one, and it is the first
 * thing that would be examined if a complaint were ever made. Support's job here
 * is to read the state and, if the customer wants texts on, tell them where the
 * switch is.
 *
 * The handset STOP is reported from SmsOptOut rather than from the copy mirrored
 * onto the user, and through the same optOutFor the send path uses, so that a
 * START which resolved an earlier STOP is interpreted here exactly as it is at
 * send time. An admin screen that disagreed with the eligibility engine would be
 * worse than no screen.
 */
router.get("/users/:id/sms-consent", auth, ...customersManage, customerTargetsOnly(), async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select("phone smsPreferences").lean();
    if (!user) return res.status(404).json({ message: "User not found" });

    const prefs = user.smsPreferences || {};
    const e164 = toE164(user.phone);
    const optOut = e164 ? await optOutFor(e164) : null;

    return res.json({
      /*
       * Strict === true on both, so an account written before these fields
       * existed reports "not opted in" rather than inheriting a consent nobody
       * gave. Absence is never consent, here or anywhere else.
       */
      transactionalEnabled: prefs.transactionalEnabled === true,
      transactionalConsentAt: prefs.transactionalConsentAt || null,
      transactionalConsentSource: prefs.transactionalConsentSource || "",
      marketingEnabled: prefs.marketingEnabled === true,
      marketingConsentAt: prefs.marketingConsentAt || null,
      marketingConsentSource: prefs.marketingConsentSource || "",
      phoneOptedOut: Boolean(optOut),
      phoneOptOutScope: optOut?.scope || "",
      phoneOptedOutAt: optOut?.optedOutAt || null,
      phoneOptOutSource: optOut?.source || "",
    });
  } catch (error) {
    console.error("GET /admin/users/:id/sms-consent error:", error);
    return res.status(500).json({ message: "Failed to read SMS consent" });
  }
});

router.post("/users/subscription-sync/repair", auth, ...onlyAdmin, async (req, res) => {
  try {
    const stripeSubscriptionId = String(req.body?.stripeSubscriptionId || "").trim();
    const stripeCustomerId = String(req.body?.stripeCustomerId || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const userId = String(req.body?.userId || "").trim();

    let stripeSubscription = null;
    if (stripeSubscriptionId) {
      stripeSubscription = await stripe.subscriptions.retrieve(stripeSubscriptionId, {
        expand: ["items.data.price"],
      });
    }

    const user = await findUserForSubscriptionRepair({
      userId,
      email,
      stripeCustomerId,
      stripeSubscription,
    });

    if (!user) {
      return res.status(404).json({
        message: "No local user matched that email, customer ID, user ID, or subscription.",
      });
    }

    const result = await syncActiveStripeSubscriptionForUser(user, {
      email,
      stripeCustomerId,
      stripeSubscriptionId,
      source: "admin_subscription_repair_endpoint",
    });

    const selectedAfterGrantsAccess =
      result.selectedAfter && subscriptionGrantsAccess(result.selectedAfter);

    return res.json({
      message: result.repaired
        ? "Stripe subscription repair finished."
        : "No active Stripe subscription was synced.",
      repaired: result.repaired,
      reason: result.reason,
      user: {
        _id: String(user._id),
        userId: user.userId || null,
        name: user.name || "",
        email: user.email || "",
        stripeCustomerId: maskExternalId(user.stripeCustomerId),
      },
      selectedStripeSubscription: serializeStripeSubscriptionForDiagnostics(
        result.selectedStripeSubscription
      ),
      localBefore: subscriptionSelectionDiagnostics(result.localBefore, result.selectedBefore),
      localAfter: subscriptionSelectionDiagnostics(result.localAfter, result.selectedAfter),
      selectedCurrentPlan: selectedAfterGrantsAccess
        ? {
            subscriptionId: String(result.selectedAfter._id),
            subscriptionType: result.selectedAfter.subscriptionType,
            status: result.selectedAfter.status,
            accessStatus: result.selectedAfter.accessStatus,
            currentPeriodEnd: result.selectedAfter.currentPeriodEnd || null,
          }
        : null,
      scannedStripeCustomers: result.customerIds.map(maskExternalId),
      scannedStripeSubscriptions: result.stripeSubscriptions.map(
        serializeStripeSubscriptionForDiagnostics
      ),
      addressesDetailed: await getAddressPlansForUser(user),
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "admin_subscription_repair_failed",
        scope: "admin_subscription_sync",
        message: err.message,
      })
    );
    return res.status(err?.statusCode || 500).json({
      message: "Failed to repair subscription from Stripe.",
      error: err.message,
    });
  }
});

/* ───────────────── USERS ───────────────── */

// ✅ GET All Users (NEWEST FIRST) + includes addressesDetailed with per-address plan
router.get("/users", auth, ...customersManage, async (req, res) => {
  try {
    // The owner sees every non-staff account as before; an employee sees customers only.
    const filter = req.accessRole === "admin"
      ? { role: { $ne: "employee" } }
      : { role: "customer", email: { $ne: String(ADMIN_EMAIL).toLowerCase() } };
    const users = await User.find(filter)
      .select("-password")
      .sort({ createdAt: -1 })
      .lean();
    const [completedBookings, plansByUser] = await Promise.all([
      completedBookingCountsForUsers(users),
      getAddressPlansForUsers(users),
    ]);
    const out = users.map((u) => ({
      ...u,
      addressesDetailed: plansByUser.get(String(u._id)) || [],
      completedBookings: completedBookings.get(String(u._id)) || 0,
    }));

    res.json(out);
  } catch (err) {
    console.error("❌ Fetch users error:", err);
    res.status(500).json({ message: "Failed to get users" });
  }
});

router.get(
  "/members",
  auth,
  ...requirePermission(PERMISSIONS.MEMBERS_READ),
  async (_req, res) => {
    try {
      const users = await User.find({ role: { $ne: "employee" } })
        .select("userId name email phone addresses defaultAddressId createdAt")
        .sort({ createdAt: -1 })
        .lean();
      const [completedBookings, plansByUser] = await Promise.all([
        completedBookingCountsForUsers(users),
        getAddressPlansForUsers(users),
      ]);
      const out = users.map((user) => ({
        _id: String(user._id),
        userId: user.userId,
        name: user.name,
        email: user.email,
        phone: user.phone || "",
        createdAt: user.createdAt,
        addressesDetailed: plansByUser.get(String(user._id)) || [],
        completedBookings: completedBookings.get(String(user._id)) || 0,
      }));
      return res.json(out);
    } catch (error) {
      console.error("Fetch members failed:", error);
      return res.status(500).json({ message: "Failed to get members" });
    }
  }
);

/*
 * Loyalty Benefits for every property that has ever had a membership.
 *
 * Its own request, loaded after the member list has drawn, so the list never
 * waits on the ledger. Each row is the same answer the customer detail gives
 * for that property, so the two cannot disagree. Read only.
 */
router.get(
  "/members/loyalty",
  auth,
  ...requirePermission(PERMISSIONS.MEMBERS_READ),
  async (_req, res) => {
    try {
      const users = await User.find({ role: { $ne: "employee" } })
        .select("_id userId addresses defaultAddressId")
        .lean();
      const rows = await adminLoyaltyForUsers(users);
      return res.json({
        programActive: loyaltyProgramActive(),
        programStartedAt: loyaltyEffectiveAt(),
        rows,
      });
    } catch (error) {
      console.error("Fetch members loyalty failed:", error);
      return res.status(500).json({ message: "Failed to load loyalty progress" });
    }
  }
);

/* One customer's completed visits and Loyalty Benefits at every property. Read only. */
router.get(
  "/users/:userId/loyalty",
  auth,
  ...requirePermission(PERMISSIONS.MEMBERS_READ),
  async (req, res) => {
    try {
      const { userId } = req.params;
      if (!mongoose.isValidObjectId(userId)) {
        return res.status(400).json({ message: "Invalid user id" });
      }
      const user = await User.findById(userId)
        .select("_id userId role addresses defaultAddressId")
        .lean();
      if (!user || user.role === "employee") return res.status(404).json({ message: "User not found" });

      const [completedBookings, addresses] = await Promise.all([
        completedBookingCountForUser(user),
        adminLoyaltyForUsers([user], { allAddresses: true }),
      ]);
      return res.json({
        programActive: loyaltyProgramActive(),
        programStartedAt: loyaltyEffectiveAt(),
        completedBookings,
        addresses,
      });
    } catch (error) {
      console.error("Fetch customer loyalty failed:", error);
      return res.status(500).json({ message: "Failed to load loyalty progress" });
    }
  }
);

// ✅ DELETE User by ID
function titleCase(value) {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function normalizeTimelineDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const ISO_DATE_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})/g;

function formatNYDateTime(value) {
  const date = normalizeTimelineDate(value);
  if (!date) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatNYTime(value) {
  const date = normalizeTimelineDate(value);
  if (!date) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatNYDateKey(value) {
  const date = normalizeTimelineDate(value);
  if (!date) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function formatNYRange(startValue, endValue) {
  const start = formatNYDateTime(startValue);
  const end = formatNYDateKey(startValue) === formatNYDateKey(endValue)
    ? formatNYTime(endValue)
    : formatNYDateTime(endValue);
  return [start, end].filter(Boolean).join(" – ");
}

function extractReservationParts(value) {
  const text = String(value || "").trim();
  if (!text) return { fixterName: "", range: "" };

  const matches = text.match(ISO_DATE_PATTERN) || [];
  const firstIso = matches[0] || "";
  const fixterName = firstIso
    ? text
        .slice(0, text.indexOf(firstIso))
        .replace(/[·•|–—-]+\s*$/g, "")
        .trim()
    : "";

  if (matches.length >= 2) {
    return { fixterName, range: formatNYRange(matches[0], matches[1]) };
  }

  if (matches.length === 1) {
    return { fixterName, range: formatNYDateTime(matches[0]) };
  }

  return { fixterName, range: text };
}

function containsIsoDate(value) {
  ISO_DATE_PATTERN.lastIndex = 0;
  const result = ISO_DATE_PATTERN.test(String(value || ""));
  ISO_DATE_PATTERN.lastIndex = 0;
  return result;
}

function cleanChangeValue(value) {
  const text = String(value ?? "").trim();
  if (!text || text.toLowerCase() === "empty" || text.toLowerCase() === "null") {
    return "Unassigned";
  }

  const matches = text.match(ISO_DATE_PATTERN) || [];
  if (matches.length >= 2) return formatNYRange(matches[0], matches[1]);
  if (matches.length === 1) return formatNYDateTime(matches[0]);

  return text;
}

function bookingHistoryDescriptionLines(entry) {
  const actionType = String(entry?.actionType || "");
  const changes = Array.isArray(entry?.changes) ? entry.changes : [];
  const reservationChange = changes.find((change) => {
    const label = `${change?.label || ""} ${change?.field || ""}`.toLowerCase();
    const values = `${change?.oldValue || ""} ${change?.newValue || ""}`;
    return label.includes("reservation") || label.includes("appointment") || containsIsoDate(values);
  });

  if (actionType === "reservation_moved" && reservationChange) {
    const from = extractReservationParts(reservationChange.oldValue);
    const to = extractReservationParts(reservationChange.newValue);
    const fixterName = to.fixterName || from.fixterName;
    return [
      from.range ? `From: ${from.range}` : "",
      to.range ? `To: ${to.range}` : "",
      fixterName ? `Fixter: ${fixterName}` : "",
    ].filter(Boolean);
  }

  if (
    (actionType === "reservation_created" ||
      actionType === "reservation_hold_created" ||
      actionType === "reservation_hold_paid") &&
    reservationChange
  ) {
    const reservation = extractReservationParts(reservationChange.newValue || reservationChange.oldValue);
    const isHold = actionType === "reservation_hold_created";
    const isPaidHold = actionType === "reservation_hold_paid";
    return [
      reservation.range
        ? `${isHold ? "Appointment hold created for" : isPaidHold ? "Paid hold reserved for" : "Appointment reserved for"} ${reservation.range}`
        : isHold
          ? "Appointment hold created"
          : isPaidHold
            ? "Paid hold reserved"
            : "Appointment reserved",
      reservation.fixterName ? `Fixter: ${reservation.fixterName}` : "",
    ].filter(Boolean);
  }

  if (actionType === "reservation_released" && reservationChange) {
    const reservation = extractReservationParts(reservationChange.oldValue || reservationChange.newValue);
    return [
      "Appointment reservation released",
      reservation.range ? `Previous time: ${reservation.range}` : "",
      reservation.fixterName ? `Fixter: ${reservation.fixterName}` : "",
    ].filter(Boolean);
  }

  const lines = changes
    .map((change) => {
      const label = titleCase(change?.label || change?.field || "Value");
      const oldValue = cleanChangeValue(change?.oldValue);
      const newValue = cleanChangeValue(change?.newValue);
      const lowerLabel = label.toLowerCase();

      if (lowerLabel.includes("status")) {
        return `Status changed from ${oldValue} to ${newValue}`;
      }
      if (lowerLabel.includes("fixter") || lowerLabel.includes("assigned")) {
        return `Fixter changed from ${oldValue} to ${newValue}`;
      }
      if (lowerLabel.includes("reservation") || lowerLabel.includes("appointment")) {
        return `Appointment changed from ${oldValue} to ${newValue}`;
      }
      return `${label} changed from ${oldValue} to ${newValue}`;
    })
    .filter(Boolean);

  if (lines.length) return lines.slice(0, 5);

  const summary = String(entry?.summary || "").trim();
  const title = bookingHistoryTitle(actionType);
  if (summary && summary.toLowerCase() !== title.toLowerCase()) {
    return [summary.replace(/\s*Changes:\s*/gi, " ").trim()];
  }
  return [];
}

function bookingHistoryTitle(actionType) {
  const titles = {
    booking_created: "Booking created",
    booking_confirmed: "Booking confirmed",
    booking_canceled: "Booking canceled",
    status_changed: "Booking status changed",
    booking_edited: "Booking updated",
    assigned_fixter_changed: "Fixter assignment changed",
    note_added: "Booking note added",
    reservation_created: "Appointment reserved",
    reservation_hold_created: "Appointment hold created",
    reservation_hold_paid: "Paid hold reserved",
    reservation_released: "Appointment reservation released",
    reservation_moved: "Appointment moved",
    reservation_backfilled: "Appointment reservation backfilled",
    reservation_conflict: "Appointment reservation conflict",
  };
  return titles[String(actionType || "")] || titleCase(actionType || "Booking activity");
}

function timelineItem({
  id,
  type,
  title,
  description = "",
  descriptionLines = [],
  timestamp,
  source,
  actorName = "",
  actorRole = "",
  relatedBookingNumber = "",
  status = "",
}) {
  const date = normalizeTimelineDate(timestamp);
  if (!date) return null;
  return {
    id: String(id),
    type: String(type || "activity"),
    title: String(title || "Activity"),
    description: String(description || (Array.isArray(descriptionLines) ? descriptionLines.join("\n") : "")),
    descriptionLines: Array.isArray(descriptionLines)
      ? descriptionLines.filter(Boolean).map((line) => String(line))
      : [],
    timestamp: date.toISOString(),
    source: String(source || ""),
    actorName: String(actorName || ""),
    actorRole: String(actorRole || ""),
    relatedBookingNumber: String(relatedBookingNumber || ""),
    status: String(status || ""),
  };
}

// GET /api/admin/users/:userId/activity?limit=10|all
router.get(
  "/users/:userId/activity",
  auth,
  ...requirePermission(PERMISSIONS.MEMBERS_READ),
  async (req, res) => {
    try {
      const { userId } = req.params;
      const limitParam = String(req.query.limit || "10").toLowerCase();
      const limitAll = limitParam === "all";
      const limit = limitAll
        ? null
        : Math.min(Math.max(Number.parseInt(limitParam, 10) || 10, 1), 100);

      const user = await User.findById(userId).select("-password").lean();
      if (!user) return res.status(404).json({ message: "User not found" });

      const userObjectId = new mongoose.Types.ObjectId(String(user._id));
      const email = String(user.email || "").toLowerCase().trim();

      const bookings = await Booking.find({
        $or: [{ user: userObjectId }, { userId: user.userId }],
      })
        .select("_id bookingNumber status service date scheduledStart createdAt updatedAt")
        .sort({ createdAt: -1 })
        .lean();
      const bookingIds = bookings.map((booking) => booking._id);
      const bookingIdStrings = bookingIds.map((id) => String(id));
      const bookingById = new Map(bookings.map((booking) => [String(booking._id), booking]));

      const [subscriptions, bookingHistory, emailLogs, blacklistEntries] = await Promise.all([
        Subscription.find({
          $or: [{ user: userObjectId }, { userId: user.userId }],
        })
          .select(
            "subscriptionType billingCycle status accessStatus startDate createdAt updatedAt cancelAtPeriodEnd cancellationDate pendingPlan pendingBillingCycle pendingChangeEffectiveDate addressSnapshot"
          )
          .sort({ createdAt: -1 })
          .lean(),
        bookingIds.length
          ? BookingHistory.find({ bookingId: { $in: bookingIds } })
              .sort({ createdAt: -1 })
              .populate("actorUserId", "name email role employeePosition")
              .lean()
          : [],
        EmailLog.find({
          $or: [
            { userId: userObjectId },
            { userId: String(user._id) },
            { userId: user.userId },
            ...(email ? [{ customerEmail: email }, { recipientEmail: email }] : []),
            ...(bookingIds.length ? [{ bookingId: { $in: bookingIds } }] : []),
            ...(bookingIdStrings.length ? [{ bookingId: { $in: bookingIdStrings } }] : []),
          ],
        })
          .select(
            "templateKey subject recipientEmail recipientName customerEmail customerName userId bookingId bookingNumber source emailType status sentAt failedAt createdAt errorMessage"
          )
          .sort({ createdAt: -1 })
          .lean(),
        Blacklist.find({
          $or: [
            { user: userObjectId },
            { userId: user.userId },
            ...(email ? [{ email }] : []),
          ],
        })
          .select("user userId name email reason createdAt blockedByName liftedAt liftedByName liftReason")
          .setOptions({ includeLifted: true })
          .sort({ createdAt: -1 })
          .lean(),
      ]);

      const items = [
        timelineItem({
          id: `account-${user._id}`,
          type: "account_created",
          title: "Account created",
          description: `${user.name || "Customer"} created a Profixter account.`,
          timestamp: user.createdAt,
          source: "user",
          actorName: user.name || "",
          actorRole: "customer",
          status: "created",
        }),
      ];

      for (const subscription of subscriptions) {
        const plan = titleCase(subscription.subscriptionType);
        const billing = subscription.billingCycle ? ` (${subscription.billingCycle})` : "";
        const address = subscription.addressSnapshot
          ? [
              subscription.addressSnapshot.line1,
              subscription.addressSnapshot.city,
              subscription.addressSnapshot.state,
              subscription.addressSnapshot.zip,
            ]
              .filter(Boolean)
              .join(", ")
          : "";

        items.push(
          timelineItem({
            id: `subscription-purchased-${subscription._id}`,
            type: "subscription_purchased",
            title: "Subscription purchased",
            description: `${plan}${billing}${address ? ` for ${address}` : ""}`,
            timestamp: subscription.startDate || subscription.createdAt,
            source: "subscription",
            actorName: user.name || "",
            actorRole: "customer",
            status: subscription.status || subscription.accessStatus || "",
          })
        );

        const createdAtMs = subscription.createdAt
          ? new Date(subscription.createdAt).getTime()
          : 0;
        const updatedAtMs = subscription.updatedAt
          ? new Date(subscription.updatedAt).getTime()
          : 0;
        const hasMeaningfulUpdate = updatedAtMs && createdAtMs && updatedAtMs - createdAtMs > 60 * 1000;
        const hasSeparatePendingOrCancelEvent =
          subscription.pendingPlan ||
          subscription.cancelAtPeriodEnd ||
          String(subscription.status).toLowerCase() === "canceled";

        if (hasMeaningfulUpdate && !hasSeparatePendingOrCancelEvent) {
          items.push(
            timelineItem({
              id: `subscription-updated-${subscription._id}`,
              type: "subscription_changed",
              title: "Subscription updated",
              description: `${plan} membership record was updated.`,
              timestamp: subscription.updatedAt,
              source: "subscription",
              actorName: "System",
              actorRole: "system",
              status: subscription.status || subscription.accessStatus || "",
            })
          );
        }

        if (subscription.pendingPlan) {
          items.push(
            timelineItem({
              id: `subscription-change-${subscription._id}`,
              type: "subscription_changed",
              title: "Subscription change scheduled",
              description: `Plan change pending: ${titleCase(subscription.pendingPlan)}${
                subscription.pendingBillingCycle ? ` (${subscription.pendingBillingCycle})` : ""
              }`,
              timestamp: subscription.pendingChangeEffectiveDate || subscription.updatedAt,
              source: "subscription",
              actorName: "System",
              actorRole: "system",
              status: "pending",
            })
          );
        }

        if (subscription.cancelAtPeriodEnd || String(subscription.status).toLowerCase() === "canceled") {
          items.push(
            timelineItem({
              id: `subscription-canceled-${subscription._id}`,
              type: "subscription_canceled",
              title: subscription.cancelAtPeriodEnd
                ? "Subscription cancellation scheduled"
                : "Subscription canceled",
              description: `${plan} membership ${
                subscription.cancelAtPeriodEnd ? "is scheduled to end" : "ended"
              }.`,
              timestamp: subscription.cancellationDate || subscription.updatedAt,
              source: "subscription",
              actorName: "System",
              actorRole: "system",
              status: subscription.status || "canceled",
            })
          );
        }
      }

      for (const entry of bookingHistory) {
        const booking = bookingById.get(String(entry.bookingId));
        const actorUser =
          entry.actorUserId && typeof entry.actorUserId === "object"
            ? entry.actorUserId
            : null;
        const actorRole = String(entry.actorRole || actorUser?.role || "system");
        const actorPosition = String(entry.actorPosition || actorUser?.employeePosition || "");
        const actorName =
          actorUser?.name ||
          (actorRole.toLowerCase() === "customer" &&
          ["customer", "unknown user"].includes(String(entry.actorName || "").trim().toLowerCase())
            ? user.name
            : entry.actorName) ||
          "System";
        const descriptionLines = bookingHistoryDescriptionLines(entry);

        items.push(
          timelineItem({
            id: `booking-history-${entry._id}`,
            type: entry.actionType,
            title: bookingHistoryTitle(entry.actionType),
            descriptionLines,
            timestamp: entry.createdAt,
            source: "booking_history",
            actorName,
            actorRole: actorPosition || actorRole,
            relatedBookingNumber: booking?.bookingNumber || "",
            status: booking?.status || "",
          })
        );
      }

      for (const log of emailLogs) {
        const timestamp = log.status === "failed"
          ? log.failedAt || log.createdAt
          : log.sentAt || log.createdAt;
        items.push(
          timelineItem({
            id: `email-${log._id}`,
            type: `email_${log.status}`,
            title: log.status === "failed"
              ? `Email failed: ${log.templateKey || "email"}`
              : `Email sent: ${log.templateKey || "email"}`,
            descriptionLines: [
              log.subject ? `Subject: ${log.subject}` : "",
              log.status === "failed" && log.errorMessage
                ? `Error: ${String(log.errorMessage).slice(0, 180)}`
                : "",
            ].filter(Boolean),
            timestamp,
            source: log.source || "email_log",
            actorName: "System",
            actorRole: "system",
            relatedBookingNumber: log.bookingNumber || "",
            status: log.status,
          })
        );
      }

      for (const entry of blacklistEntries) {
        items.push(
          timelineItem({
            id: `blacklist-${entry._id}`,
            type: "blacklist_added",
            title: "Customer blocked",
            description: entry.reason ? `Reason: ${entry.reason}` : "Customer was added to the blacklist.",
            timestamp: entry.createdAt,
            source: "blacklist",
            actorName: entry.blockedByName || "Admin",
            actorRole: "admin",
            status: "blocked",
          })
        );
        if (entry.liftedAt) {
          items.push(
            timelineItem({
              id: `blacklist-lifted-${entry._id}`,
              type: "blacklist_lifted",
              title: "Customer unblocked",
              description: entry.liftReason ? `Reason: ${entry.liftReason}` : "The block was lifted.",
              timestamp: entry.liftedAt,
              source: "blacklist",
              actorName: entry.liftedByName || "Admin",
              actorRole: "admin",
              status: "unblocked",
            })
          );
        }
      }

      const sorted = items
        .filter(Boolean)
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      return res.json({
        user: {
          _id: String(user._id),
          userId: user.userId,
          name: user.name,
          email: user.email,
        },
        limit: limitAll ? "all" : limit,
        total: sorted.length,
        items: limitAll ? sorted : sorted.slice(0, limit),
        unavailableSources: [
          "Historical admin customer/account action audit is only shown when it exists in booking history or current blacklist records.",
          "Historical plan-change actor details are not stored separately yet; subscription records show current purchase/cancellation/pending-change state.",
          "Blocks lifted before this release were deleted at the time and are not shown.",
        ],
      });
    } catch (err) {
      console.error("Customer activity failed:", err);
      return res.status(500).json({ message: "Failed to load customer activity" });
    }
  }
);

// GET /api/admin/activity-log
router.get("/activity-log", auth, ...activityRead, async (req, res) => {
  try {
    const page = Math.max(Number.parseInt(String(req.query.page || "1"), 10) || 1, 1);
    const limit = Math.min(
      Math.max(Number.parseInt(String(req.query.limit || "50"), 10) || 50, 1),
      200
    );
    const query = {};

    if (req.query.actorUserId) query.actorUserId = req.query.actorUserId;
    if (req.query.action) query.action = { $regex: escapeRegex(req.query.action), $options: "i" };
    if (req.query.entityType) query.entityType = String(req.query.entityType);

    if (req.query.dateFrom || req.query.dateTo) {
      query.createdAt = {};
      if (req.query.dateFrom) query.createdAt.$gte = new Date(String(req.query.dateFrom));
      if (req.query.dateTo) query.createdAt.$lte = new Date(String(req.query.dateTo));
    }

    const search = String(req.query.search || "").trim();
    if (search) {
      const safe = escapeRegex(search);
      query.$or = [
        { action: { $regex: safe, $options: "i" } },
        { entityName: { $regex: safe, $options: "i" } },
        { entityId: { $regex: safe, $options: "i" } },
        { actorName: { $regex: safe, $options: "i" } },
        { "details.email": { $regex: safe, $options: "i" } },
        { "details.customerEmail": { $regex: safe, $options: "i" } },
        { "details.leadEmail": { $regex: safe, $options: "i" } },
        { "details.projectNumber": { $regex: safe, $options: "i" } },
      ];
    }

    const [items, total] = await Promise.all([
      AdminActivityLog.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      AdminActivityLog.countDocuments(query),
    ]);

    // Full phone/email values from customer edits are the owner's to see.
    if (req.accessRole !== "admin") {
      for (const item of items) if (item.details && item.details.ownerOnly) delete item.details.ownerOnly;
    }

    return res.json({
      items,
      total,
      page,
      limit,
      totalPages: Math.max(Math.ceil(total / limit), 1),
    });
  } catch (error) {
    console.error("Fetch admin activity log failed:", error);
    return res.status(500).json({ message: "Failed to load activity log" });
  }
});

// GET /api/admin/activity-log/summary
router.get("/activity-log/summary", auth, ...activityRead, async (_req, res) => {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [usersDeleted, leadsDeleted, projectsDeleted] = await Promise.all([
      AdminActivityLog.countDocuments({ action: "User Deleted", createdAt: { $gte: since } }),
      AdminActivityLog.countDocuments({ action: "Lead Deleted", createdAt: { $gte: since } }),
      AdminActivityLog.countDocuments({ action: "Project Deleted", createdAt: { $gte: since } }),
    ]);
    return res.json({
      since: since.toISOString(),
      usersDeleted,
      leadsDeleted,
      projectsDeleted,
    });
  } catch (error) {
    console.error("Fetch admin activity summary failed:", error);
    return res.status(500).json({ message: "Failed to load activity summary" });
  }
});

router.delete("/users/:id", auth, onlyAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id).lean();
    if (!user) return res.status(404).json({ message: "User not found" });

    /*
     * The confirmation names the account: its email, or - for an account with
     * no email (phone sign-in) - its public user id, which is what the Admin
     * dialog shows. It used to demand "DELETE " + an empty email for those, so
     * a phone-only account could never be deleted.
     */
    const email = String(user.email || "").trim();
    const accepted = email
      ? [`DELETE ${email}`]
      : [`DELETE ${String(user.userId || "").trim()}`, `DELETE ${String(user._id)}`].filter((v) => v !== "DELETE ");
    const expectedConfirmation = accepted[0];
    if (!accepted.includes(String(req.body?.confirmation || "").trim())) {
      return res.status(400).json({
        message: `Type ${expectedConfirmation} to delete this user.`,
        code: "CONFIRMATION_MISMATCH",
      });
    }

    const activeSubscription = await Subscription.findOne({
      user: user._id,
      status: { $in: ["active", "trialing", "past_due", "incomplete"] },
    }).lean();
    if (activeSubscription && subscriptionGrantsAccess(activeSubscription)) {
      return res.status(409).json({
        message: "This user has an active subscription. Cancel or resolve the subscription before deleting.",
      });
    }

    const futureBooking = await Booking.findOne({
      user: user._id,
      date: { $gte: new Date() },
      $expr: {
        $not: {
          $in: [{ $toLower: "$status" }, terminalBookingStatuses()],
        },
      },
    })
      .select("_id bookingNumber date status")
      .lean();
    if (futureBooking) {
      return res.status(409).json({
        message: "This user has future active bookings. Cancel or complete those bookings before deleting.",
        bookingNumber: futureBooking.bookingNumber,
      });
    }

    const audit = await createAdminActivityLog(req, {
      action: "User Delete Started",
      entityType: "User",
      entityId: user._id,
      entityName: user.name || user.email || user.userId,
      details: {
        customerName: user.name,
        email: user.email,
        phone: user.phone,
        userId: user.userId,
      },
    });

    const deleted = await User.findByIdAndDelete(user._id);
    if (!deleted) return res.status(404).json({ message: "User not found" });

    await markAdminActivityLog(audit, {
      action: "User Deleted",
      details: {
        customerName: user.name,
        email: user.email,
        phone: user.phone,
        userId: user.userId,
        deletedAt: new Date().toISOString(),
      },
    });

    res.json({ message: "User deleted" });
  } catch (err) {
    console.error("❌ Delete user error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/*
 * Correcting a customer's names, phone, email and addresses, with the
 * verification, consent and audit rules that edit needs. See the file.
 */
router.use(require("./adminCustomerProfile")({ getAddressPlansForUser }));
router.use(require("./adminCustomers"));
router.use(require("./adminSales"));
/* The redesigned customer list, search, profile and confirmed membership actions. */
router.use(require("./adminCustomerDirectory"));

// ✅ UPDATE User Info (name, phone, legacy subscription)
router.put("/users/:id", auth, ...customersManage, customerTargetsOnly(), async (req, res) => {
  const allowedFields = ["name", "phone", "subscription"];
  const updates = {};

  allowedFields.forEach((field) => {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  });

  /*
   * Normalise a phone before it is stored, and refuse garbage.
   *
   * Registration already does this, so an account created through the website
   * always holds a clean E.164 number. This path did not, which meant an admin
   * edit was the one way a malformed number could get into the database and
   * silently make every future text to that customer impossible.
   *
   * Clearing the phone stays allowed - an empty value is a deliberate removal,
   * not a typo. Anything else that cannot be normalised is rejected rather
   * than stored, because storing it only moves the failure to a place nobody
   * is watching.
   *
   * This validates FORMAT, which is all it can do. A well-formed number is
   * still only "unknown" until a carrier confirms delivery to it.
   */
  if (updates.phone !== undefined) {
    const raw = String(updates.phone || "").trim();
    if (!raw) {
      updates.phone = "";
    } else {
      const e164 = normalizePhoneE164(raw);
      if (!e164) {
        return res.status(400).json({
          message: "Phone must be a valid US number.",
          code: "INVALID_PHONE",
        });
      }
      updates.phone = e164;
    }
  }

  try {
    const existing = await User.findById(req.params.id).lean();
    if (!existing) return res.status(404).json({ message: "User not found" });

    /*
     * A phone is a way into the account (phone-code sign-in opens accounts that
     * verified the number), so a genuine change is the owner's alone and the
     * new number starts unverified, exactly as PATCH /users/:id/profile does.
     * Without this the old verification stamp stayed on the new number, and
     * whoever held that number could sign in.
     */
    let phoneNumberChanged = false;
    if (updates.phone !== undefined) {
      const before = normalizePhoneE164(existing.phone) || String(existing.phone || "").trim();
      phoneNumberChanged = before !== updates.phone;
      if (phoneNumberChanged && req.accessRole !== "admin") {
        return res.status(403).json({ code: "OWNER_ONLY_FIELDS", message: "Only the owner can change a customer's phone or email." });
      }
      if (phoneNumberChanged) updates.phoneVerifiedAt = null;
    }

    /*
     * CONSENT DOES NOT TRAVEL WITH THE ACCOUNT. IT BELONGS TO THE NUMBER.
     *
     * A customer ticked "text me about my visits" about the handset in their
     * hand. Move the account to a different number and that tick is evidence
     * about a phone we are no longer dialling: the new number never agreed to
     * anything, and nobody at that number was asked. Leaving the flags set
     * would make it eligible purely because its predecessor consented, which is
     * the same defect as inferring consent from a phone field - the thing the
     * A2P 30923 work existed to remove - only harder to spot, because the
     * record still looks like a real opt-in.
     *
     * So a genuine change of number clears both eligibility flags.
     *
     * FORMATTING IS NOT A CHANGE. "(631) 555-0147" and "631-555-0147" and
     * "+16315550147" are one number, and an admin tidying up how it is written
     * must not silently unsubscribe somebody. The comparison is therefore made
     * on the normalised E.164 on both sides, never on the raw strings.
     *
     * The timestamps and sources are deliberately left alone. They are the
     * historical evidence that this account did consent, when, and through
     * which surface; that remains true and is worth keeping. What changes is
     * eligibility, and it is unset rather than set false because the honest
     * description of the new number is "never asked", not "asked and declined"
     * - the model keeps those two states distinguishable on purpose.
     */
    let unsetOnPhoneChange = {};
    if (updates.phone !== undefined) {
      const verdict = consentResetForPhoneChange({
        previousPhone: existing.phone,
        nextPhone: updates.phone,
        smsPreferences: existing.smsPreferences,
      });
      unsetOnPhoneChange = verdict.unset;
      if (verdict.reset) {
        console.log(
          JSON.stringify({
            event: "sms_consent_reset_phone_changed",
            userId: String(existing._id),
            from: maskPhone(verdict.previous),
            to: maskPhone(verdict.next),
            clearedTransactional: verdict.clearedTransactional,
            clearedMarketing: verdict.clearedMarketing,
          })
        );
      }
    }

    const nextUser = { ...existing, ...updates };
    const write = { $set: { ...updates, search: buildUserSearchFields(nextUser) } };
    if (Object.keys(unsetOnPhoneChange).length) write.$unset = unsetOnPhoneChange;

    await User.updateOne({ _id: existing._id }, write, { runValidators: false });

    if (phoneNumberChanged) {
      await createAdminActivityLog(req, {
        action: "Customer Profile Updated",
        entityType: "User",
        entityId: existing._id,
        entityName: existing.name || existing.userId,
        details: {
          summary: "Changed: Phone",
          changes: [{ field: "phone", label: "Phone", from: maskPhoneForLog(existing.phone), to: maskPhoneForLog(updates.phone), sensitive: true }],
          ownerOnly: { changes: [{ field: "phone", label: "Phone", from: existing.phone || "", to: updates.phone }] },
          adminOverride: { phoneVerificationCleared: Boolean(existing.phoneVerifiedAt), emailVerificationCleared: false },
        },
      });
    }

    if (Object.keys(unsetOnPhoneChange).length) {
      const { recordConsent } = require("../utils/consent/ledger");
      const verdict = consentResetForPhoneChange({ previousPhone: existing.phone, nextPhone: updates.phone, smsPreferences: existing.smsPreferences });
      for (const [purpose, cleared] of [["service", verdict.clearedTransactional], ["marketing", verdict.clearedMarketing]]) {
        if (cleared) await recordConsent({ user: existing._id, channel: "sms", purpose, action: "reset", source: "admin_phone_change", phone: verdict.previous, detail: "consent covered the previous number only", req });
      }
    }

    const user = await User.findById(existing._id).select("-password").lean();
    res.json({
      message: Object.keys(unsetOnPhoneChange).length
        ? "User updated. SMS consent was cleared because the phone number changed."
        : "User updated",
      smsConsentReset: Object.keys(unsetOnPhoneChange).length > 0,
      user,
    });
  } catch (err) {
    console.error("❌ Edit user error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ✅ Legacy: Update single user.subscription (kept for backward compatibility)
router.put("/users/:id/subscription", auth, ...customersManage, customerTargetsOnly(), async (req, res) => {
  try {
    const { id } = req.params;
    const { subscription } = req.body;

    const user = await User.findById(id);
    if (!user) return res.status(404).json({ message: "User not found" });

    user.subscription =
      subscription === "Cancel" ? null : String(subscription || "").toLowerCase();

    await user.save();

    res.json({
      message: "Subscription updated",
      subscription: user.subscription,
    });
  } catch (err) {
    console.error("❌ Admin Subscription Update Error:", err.message);
    res.status(err?.statusCode || 500).json({ message: "Server error", error: err.message });
  }
});

/*
 * LEGACY plan and cancellation writes from the old customer list.
 *
 * These used to act on one tap: a higher plan charged the card at once, "Cancel"
 * scheduled a Stripe cancellation, a date input wrote Stripe on every change,
 * and a home without an active subscription (a past-due one included) was
 * handed a free, open-ended DB-only "admin-panel" membership. None of it asked
 * first, showed the amount, or was protected against a double tap, and the
 * cancellation date was not audited.
 *
 * They now refuse every change with 428 { code: "CONFIRMATION_REQUIRED" } and
 * do nothing; the change is made through the confirmed flow instead:
 *   POST /customers/:id/addresses/:addressId/plan-change/preview + /confirm
 *   POST /customers/:id/addresses/:addressId/cancellation
 *   POST /customers/:id/addresses/:addressId/complimentary   (owner)
 * Re-sending the current state (the same plan, or clearing when nothing is
 * scheduled) is not a change and still answers 200 with addressesDetailed.
 *
 * The current Admin screen shows its own "Failed to update subscription plan" /
 * "Failed to save cancellation date" toast and keeps the row as it was.
 */
function confirmationRequired(res, what) {
  return res.status(428).json({
    code: "CONFIRMATION_REQUIRED",
    message: `${what} now needs a confirmed preview. Open the customer and use Change plan or Cancellation, which show the amount first.`,
    next: {
      planChangePreview: "POST /api/admin/customers/:id/addresses/:addressId/plan-change/preview",
      planChangeConfirm: "POST /api/admin/customers/:id/addresses/:addressId/plan-change/confirm",
      cancellation: "POST /api/admin/customers/:id/addresses/:addressId/cancellation",
    },
  });
}

async function legacyAddressContext(req, res) {
  const { id, addressId } = req.params;
  if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(addressId)) {
    res.status(400).json({ message: "Invalid id", code: "INVALID_ID" });
    return null;
  }
  const user = await User.findById(id).lean();
  if (!user) {
    res.status(404).json({ message: "User not found" });
    return null;
  }
  const addr = (user.addresses || []).find((a) => String(a._id) === String(addressId));
  if (!addr) {
    res.status(404).json({ message: "Address not found" });
    return null;
  }
  const rows = await getAddressPlansForUser(user);
  return { user, addr, row: rows.find((r) => r._id === String(addressId)) || null, rows };
}

// PUT /api/admin/users/:id/address/:addressId/subscription
router.put(
  "/users/:id/address/:addressId/subscription",
  auth,
  ...customersManage,
  customerTargetsOnly(),
  async (req, res) => {
    try {
      const ctx = await legacyAddressContext(req, res);
      if (!ctx) return undefined;
      const planRaw = String(req.body?.plan || "").toLowerCase();
      if (planRaw !== "cancel" && !["basic", "plus", "premium", "elite"].includes(planRaw)) {
        return res.status(400).json({ message: "Invalid plan", code: "INVALID_PLAN" });
      }
      const current = ctx.row?.plan || null;
      const unchanged = planRaw === "cancel" ? !current && ctx.row?.planStatus !== "payment_issue" : current === planRaw;
      if (unchanged) return res.json({ message: "No change", addressesDetailed: ctx.rows });
      return confirmationRequired(res, planRaw === "cancel" ? "Cancelling a membership" : "Changing a plan");
    } catch (err) {
      console.error("❌ Per-address plan update error:", err.message);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

// PUT /api/admin/users/:id/address/:addressId/cancellation-date
router.put(
  "/users/:id/address/:addressId/cancellation-date",
  auth,
  ...customersManage,
  customerTargetsOnly(),
  async (req, res) => {
    try {
      const ctx = await legacyAddressContext(req, res);
      if (!ctx) return undefined;
      const requested = req.body?.cancelOnDate ? String(req.body.cancelOnDate) : null;
      const scheduled = ctx.row?.scheduledCancellationDate || null;
      if (requested === scheduled || (!requested && !ctx.row?.cancelAt)) {
        return res.json({ message: "No change", addressesDetailed: ctx.rows });
      }
      return confirmationRequired(res, "Scheduling or clearing a cancellation");
    } catch (err) {
      console.error("❌ Per-address cancellation-date update error:", err.message);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

/* ───────────────── BOOKINGS ───────────────── */

// ✅ GET All Bookings
/*
 * The legacy list (kept for the current Admin). Record scope is the server's
 * decision (Q-1): a field Fixter gets their own jobs whatever ?assigned says;
 * ?assigned=me can only narrow a wider caller's list. Fields no Admin screen
 * reads and that should not leave the server (free-visit identity keys, the
 * consent IP, browser retry keys, staff notes) are left out.
 */
router.get("/bookings", auth, ...requirePermission(PERMISSIONS.BOOKINGS_READ), async (req, res) => {
  try {
    const query = canSeeAllJobs(req)
      ? String(req.query.assigned || "").toLowerCase() === "me"
        ? { assignedFixterId: req.accessUser._id }
        : {}
      : jobScopeFilter(req);
    const bookings = await Booking.find(query)
      .select(LEGACY_HIDDEN_BOOKING_FIELDS)
      .populate("user", "userId name email phone subscription");
    res.json(bookings);
  } catch (err) {
    console.error("❌ Fetch bookings error:", err);
    res.status(500).json({ message: "Failed to get bookings" });
  }
});

router.get("/bookings/reminders/debug", auth, ...onlyAdmin, async (_req, res) => {
  try {
    const now = new Date();
    const lockStaleBefore = new Date(now.getTime() - REMINDER_LOCK_STALE_MS);
    const bookings = await Booking.find({
      status: /^confirmed$/i,
      date: { $gte: now },
    })
      .sort({ date: 1 })
      .limit(20)
      .select(
        "_id bookingNumber status name date email reminder24hQueuedAt reminder24hSentAt reminder24hSkippedAt reminder24hSkipReason reminder60mQueuedAt reminder60mSentAt"
      )
      .lean();

    return res.json({
      serverTime: now.toISOString(),
      newYorkTime: now.toLocaleString("en-US", {
        timeZone: "America/New_York",
        dateStyle: "full",
        timeStyle: "long",
      }),
      bookings: bookings.map((booking) => {
        const reminder24h = evaluate24HourReminder(booking, now);
        const reminder60m = evaluate60MinuteReminder(booking, now);
        const bookingStartMs = new Date(booking.date).getTime();
        const queuedAtMs = booking.reminder24hQueuedAt
          ? new Date(booking.reminder24hQueuedAt).getTime()
          : null;
        const reminder24hLockExpiresAt =
          Number.isFinite(queuedAtMs)
            ? new Date(queuedAtMs + REMINDER_LOCK_STALE_MS)
            : null;
        const email = String(booking.email || "").trim().toLowerCase();
        const hoursUntilAppointment = Number.isFinite(bookingStartMs)
          ? Number(
              ((bookingStartMs - now.getTime()) / (60 * 60 * 1000)).toFixed(2)
            )
          : null;
        return {
          bookingId: String(booking._id),
          bookingNumber: booking.bookingNumber,
          customerName: booking.name || "",
          customerEmailDomain: email.includes("@") ? email.split("@").pop() : "",
          customerEmailExists: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
          status: booking.status,
          startDateTime: booking.date,
          hoursUntilAppointment,
          reminder24hQueuedAt: booking.reminder24hQueuedAt || null,
          reminder24hSentAt: booking.reminder24hSentAt || null,
          reminder24hSkippedAt: booking.reminder24hSkippedAt || null,
          reminder24hSkipReason: booking.reminder24hSkipReason || "",
          reminder24hLockExpiresAt,
          reminder24hLockIsStale:
            !!booking.reminder24hQueuedAt &&
            new Date(booking.reminder24hQueuedAt) <= lockStaleBefore,
          reminder24hEligible: reminder24h.eligible,
          reminder24hReason: reminder24h.reason,
          reminder24hWouldSendNow: reminder24h.eligible,
          reminder60mQueuedAt: booking.reminder60mQueuedAt || null,
          reminder60mSentAt: booking.reminder60mSentAt || null,
          reminder60mEligible: reminder60m.eligible,
          reminder60mReason: reminder60m.reason,
          reminder60mWouldSendNow: reminder60m.eligible,
        };
      }),
    });
  } catch (error) {
    console.error("Reminder diagnostics failed:", error);
    return res.status(500).json({ message: "Failed to load reminder diagnostics" });
  }
});

router.post(
  "/bookings/reminders/repair-24h",
  auth,
  ...onlyAdmin,
  async (req, res) => {
    try {
      const now = new Date();
      const dryRun =
        String(req.query.dryRun || req.body?.dryRun || "").toLowerCase() ===
        "true";
      const staleBefore = new Date(now.getTime() - REMINDER_LOCK_STALE_MS);

      const bookings = await Booking.find({
        status: /^confirmed$/i,
        date: { $gt: now },
        $or: [
          { reminder24hSentAt: { $exists: false } },
          { reminder24hSentAt: null },
        ],
      })
        .sort({ date: 1 })
        .limit(500)
        .select(
          "_id bookingNumber status name date email reminder24hQueuedAt reminder24hSentAt reminder24hSkippedAt reminder24hSkipReason"
        )
        .lean();

      const inspected = [];
      const repaired = [];
      const skipped = [];

      for (const booking of bookings) {
        const eligibility = evaluate24HourReminder(booking, now);
        const hasStaleQueue =
          !!booking.reminder24hQueuedAt &&
          new Date(booking.reminder24hQueuedAt) <= staleBefore;
        const hasSkipped = !!booking.reminder24hSkippedAt;
        const unset = {};

        if (hasStaleQueue) {
          unset.reminder24hQueuedAt = 1;
        }
        if (hasSkipped && eligibility.eligible) {
          unset.reminder24hSkippedAt = 1;
          unset.reminder24hSkipReason = 1;
        }

        const action = {
          bookingId: String(booking._id),
          bookingNumber: booking.bookingNumber,
          startDateTime: booking.date,
          hoursUntilAppointment: Number(
            ((new Date(booking.date).getTime() - now.getTime()) /
              (60 * 60 * 1000)).toFixed(2)
          ),
          eligibleNow: eligibility.eligible,
          reason: eligibility.reason,
          clearedQueuedAt: !!unset.reminder24hQueuedAt,
          clearedSkippedAt: !!unset.reminder24hSkippedAt,
        };
        inspected.push(action);

        if (!Object.keys(unset).length) {
          skipped.push(action);
          continue;
        }

        if (!dryRun) {
          await Booking.updateOne(
            {
              _id: booking._id,
              status: /^confirmed$/i,
              $or: [
                { reminder24hSentAt: { $exists: false } },
                { reminder24hSentAt: null },
              ],
            },
            { $unset: unset }
          );
        }
        repaired.push(action);
      }

      console.log("24h reminder repair completed", {
        dryRun,
        inspected: inspected.length,
        repaired: repaired.length,
        skipped: skipped.length,
      });

      return res.json({
        dryRun,
        serverTime: now.toISOString(),
        inspectedCount: inspected.length,
        repairedCount: repaired.length,
        skippedCount: skipped.length,
        repaired,
        skipped,
      });
    } catch (error) {
      console.error("24h reminder repair failed:", error);
      return res.status(500).json({
        message: "Failed to repair 24h reminder state",
      });
    }
  }
);

router.get(
  "/bookings/review-requests/debug",
  auth,
  ...onlyAdmin,
  async (_req, res) => {
    try {
      const now = new Date();
      const bookings = await Booking.find({
        status: /^completed$/i,
        completedAt: { $ne: null },
        reviewRequestSentAt: null,
      })
        .sort({ completedAt: 1 })
        .limit(20)
        .select(
          "_id bookingNumber status email completedAt reviewRequestQueuedAt reviewRequestSentAt reviewRequestLockExpiresAt reviewRequestSkippedAt"
        )
        .lean();

      return res.json({
        enabled: process.env.BOOKING_REVIEW_REQUESTS_ENABLED !== "false",
        serverTime: now.toISOString(),
        newYorkTime: now.toLocaleString("en-US", {
          timeZone: "America/New_York",
          dateStyle: "full",
          timeStyle: "long",
        }),
        bookings: bookings.map((booking) => {
          const eligibility = evaluateReviewRequest(booking, now);
          const completedAtMs = new Date(booking.completedAt).getTime();
          const minutesSinceCompletion = Number.isFinite(completedAtMs)
            ? Number(
                ((now.getTime() - completedAtMs) / (60 * 1000)).toFixed(2)
              )
            : null;

          return {
            bookingId: String(booking._id),
            bookingNumber: booking.bookingNumber,
            status: booking.status,
            completedAt: booking.completedAt,
            minutesSinceCompletion,
            reviewRequestQueuedAt: booking.reviewRequestQueuedAt || null,
            reviewRequestSentAt: booking.reviewRequestSentAt || null,
            reviewRequestLockExpiresAt:
              booking.reviewRequestLockExpiresAt || null,
            reviewRequestSkippedAt: booking.reviewRequestSkippedAt || null,
            eligible: eligibility.eligible,
            eligibilityReason: eligibility.reason,
          };
        }),
      });
    } catch (error) {
      console.error("Review request diagnostics failed:", error);
      return res
        .status(500)
        .json({ message: "Failed to load review request diagnostics" });
    }
  }
);

async function resolveAssignment(assignedFixterId) {
  if (assignedFixterId === "" || assignedFixterId === null) {
    return {
      assignedFixterId: null,
      assignedFixterName: "",
      assignedFixterEmail: "",
      assignedFixterPosition: "",
    };
  }
  const fixter = await User.findOne({
    _id: assignedFixterId,
    role: "employee",
    isActive: true,
    employeePosition: { $in: ["Fixter", "General Fixter"] },
  }).lean();
  if (!fixter) {
    const error = new Error("Assigned employee is invalid or inactive");
    error.statusCode = 400;
    throw error;
  }
  return {
    assignedFixterId: fixter._id,
    assignedFixterName: fixter.name,
    assignedFixterEmail: fixter.email,
    assignedFixterPosition: fixter.employeePosition,
  };
}

router.get("/booking-assignees", auth, ...bookingsAssign, async (_req, res) => {
  const fixters = await User.find({
    role: "employee",
    isActive: true,
    employeePosition: { $in: ["Fixter", "General Fixter"] },
  })
    .select("name email employeePosition isDefaultFixter")
    .sort({ isDefaultFixter: -1, name: 1 })
    .lean();
  return res.json({
    fixters: fixters.map((fixter) => ({
      id: String(fixter._id),
      name: fixter.name,
      email: fixter.email,
      employeePosition: fixter.employeePosition,
      isDefaultFixter: !!fixter.isDefaultFixter,
    })),
  });
});

router.get(
  "/bookings/:bookingId/history",
  auth,
  ...requirePermission(PERMISSIONS.BOOKINGS_READ),
  async (req, res) => {
    try {
      if (!mongoose.isValidObjectId(req.params.bookingId)) {
        return res.status(400).json({ message: "Invalid booking id", code: "INVALID_BOOKING" });
      }
      const booking = await Booking.findById(req.params.bookingId)
        .select("_id name email user assignedFixterId")
        .lean();
      if (!booking) {
        return res.status(404).json({ message: "Booking not found" });
      }
      if (!canAccessJob(req, booking)) return sendForbiddenRecord(res);
      const history = await BookingHistory.find({ bookingId: booking._id })
        .sort({ createdAt: -1 })
        .populate("actorUserId", "name email role employeePosition")
        .lean();
      const enrichedHistory = history.map((entry) => {
        const actorUser =
          entry.actorUserId && typeof entry.actorUserId === "object"
            ? entry.actorUserId
            : null;
        const actorRole = String(entry.actorRole || actorUser?.role || "system");
        const actorPosition = String(
          entry.actorPosition || actorUser?.employeePosition || ""
        );
        const actorName =
          actorUser?.name ||
          (actorRole.toLowerCase() === "customer" &&
          ["customer", "unknown user"].includes(
            String(entry.actorName || "").trim().toLowerCase()
          )
            ? booking.name
            : entry.actorName) ||
          "System";

        return {
          ...entry,
          actorUserId: actorUser?._id || entry.actorUserId || null,
          actorName,
          actorEmail: entry.actorEmail || actorUser?.email || "",
          actorRole,
          actorPosition,
        };
      });
      return res.json({ history: enrichedHistory });
    } catch (error) {
      console.error("Load booking history failed:", error);
      return res.status(500).json({ message: "Failed to load booking history" });
    }
  }
);

// ✅ UPDATE Booking Status (admin)
/*
 * The legacy status route, kept for the current Admin. Since 2026-11-12 it is
 * a thin adapter over utils/bookingTransitions: the requested status is mapped
 * to an allow-listed action from the job's current status, and the change is
 * made atomically there, with the same side effects as before, exactly once.
 *
 * The old screen sends no expectedStatus, so there is no stale check beyond
 * the atomic claim on the status it read; but what the allow-list forbids is
 * refused: Canceled/Completed -> anything answers 409 INVALID_TRANSITION and
 * tells the user to use Reinstate. Setting the status a job already has is a
 * no-op (no second email or text). A pending free visit still confirms only
 * through its review, and Cancel on it is still the decline.
 */
router.put("/bookings/:id/status", auth, ...bookingsWrite, async (req, res) => {
  const { status } = req.body || {};
  const validStatuses = ["Pending", "Confirmed", "Completed", "Canceled"];

  if (!validStatuses.includes(status)) {
    return res.status(400).json({ message: "Invalid status" });
  }

  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: "Invalid booking id", code: "INVALID_BOOKING" });
    }
    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ message: "Booking not found" });
    if (!canAccessJob(req, booking)) return sendForbiddenRecord(res);

    const action = legacyActionFor(canonicalBookingStatus(booking.status), status);
    if (action === "noop") {
      return res.json({ message: "Status unchanged", booking: legacyBookingView(booking) });
    }
    const assignmentRequested = Object.prototype.hasOwnProperty.call(req.body, "assignedFixterId");
    if (assignmentRequested && req.accessRole !== "admin" && !req.permissions.includes(PERMISSIONS.BOOKINGS_ASSIGN)) {
      return res.status(403).json({ message: "Assignment access denied" });
    }
    const outcome = await performTransition({
      req,
      bookingId: booking._id,
      action,
      // Only Confirm takes an assignee; the old screen sends one only with Confirm.
      assignedFixterId: action === "confirm" && assignmentRequested ? req.body.assignedFixterId ?? "" : undefined,
      reason: action === "cancel" ? "Canceled by Admin" : undefined,
      source: "adminBookingStatus",
    });
    return res.json({
      message: "Status updated",
      booking: legacyBookingView(outcome.booking),
      ...(outcome.payment ? { payment: outcome.payment } : {}),
    });
  } catch (err) {
    if (err?.statusCode && err.statusCode < 500) {
      return res.status(err.statusCode).json({ message: err.message, code: err.code, ...(err.extra || {}) });
    }
    console.error("❌ Update booking status error:", err);
    res.status(err?.statusCode || 500).json({ message: err.message || "Server error" });
  }
});

// ✅ NEW: Update booking note/date (admin)
// PUT /api/admin/bookings/:id
router.put("/bookings/:id", auth, ...bookingsWrite, uploadAppointmentPhotos, async (req, res) => {
  try {
    const { id } = req.params;
    const { note, adminNote, date } = req.body || {};

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid booking id", code: "INVALID_BOOKING" });
    }
    let booking = await Booking.findById(id);
    if (!booking) return res.status(404).json({ message: "Booking not found" });
    if (!canAccessJob(req, booking)) return sendForbiddenRecord(res);
    /* Optional precondition; the new Admin sends it, the old one does not. */
    if (req.body?.expectedUpdatedAt) {
      const expectedMs = new Date(req.body.expectedUpdatedAt).getTime();
      if (!Number.isFinite(expectedMs) || expectedMs !== new Date(booking.updatedAt).getTime()) {
        return res.status(409).json({ code: "STALE", message: "This job changed since you opened it. Reload and try again.", updatedAt: booking.updatedAt });
      }
    }
    const before = bookingSnapshot(booking);
    const useReservationEngine = reservationEngineEnabled();
    let assignmentRequested = Object.prototype.hasOwnProperty.call(
      req.body || {},
      "assignedFixterId"
    );
    /*
     * J-06. The old Edit form starts its Fixter picker at
     * "booking.assignedFixterId || the default Fixter" and always sends it, so
     * saving a note on an unassigned job used to assign the default Fixter,
     * move the reservation and text the customer. Rule: an assignment counts
     * only when it differs from what is stored, and "the default Fixter" sent
     * for a job with nobody assigned is read as the form's pre-fill, not as a
     * choice (to assign the default deliberately, use Confirm's picker, the
     * reassign action or PATCH /api/admin/jobs/:id).
     */
    if (assignmentRequested) {
      const requested = req.body.assignedFixterId ? String(req.body.assignedFixterId) : "";
      const stored = booking.assignedFixterId ? String(booking.assignedFixterId) : "";
      if (requested === stored) {
        assignmentRequested = false;
      } else if (!stored && requested) {
        const isDefault = await User.exists({ _id: mongoose.isValidObjectId(requested) ? requested : null, isDefaultFixter: true });
        if (isDefault) assignmentRequested = false;
      }
    }
    const noteChanged = note !== undefined && String(note) !== String(booking.note || "");
    /*
     * J-07. The customer can append to the description (bookingContentUpdates).
     * Without a precondition the old form would save its stale copy over that
     * text, so a save that drops something the customer added is refused.
     */
    if (noteChanged && !req.body?.expectedUpdatedAt) {
      const customerAdded = (booking.contentUpdates || [])
        .filter((u) => u.source === "customer" && String(u.noteAdded || "").trim())
        .map((u) => String(u.noteAdded).trim());
      if (customerAdded.some((text) => String(booking.note || "").includes(text) && !String(note).includes(text))) {
        return res.status(409).json({
          code: "STALE",
          message: "The customer added to the description since you opened it. Reload, then make your change again.",
        });
      }
    }
    const requestedDateChange = date !== undefined && !isNaN(new Date(String(date)).getTime()) && new Date(String(date)).getTime() !== new Date(booking.date).getTime();
    if (!canSeeAllJobs(req) && (noteChanged || requestedDateChange || assignmentRequested)) {
      return res.status(403).json({ code: "FORBIDDEN_ACTION", message: "You can add notes and photos to your jobs; ask the office to change the time, description or Fixter." });
    }
    if ((requestedDateChange || assignmentRequested) && [JOB_STATUS.CANCELED, JOB_STATUS.COMPLETED].includes(canonicalBookingStatus(booking.status))) {
      return res.status(409).json({ code: "INVALID_TRANSITION", message: `This job is ${canonicalBookingStatus(booking.status)}. Use Reinstate to reopen it before changing its time or Fixter.` });
    }
    let parsedDate = null;
    let dateChanged = false;
    let assignmentChanged = false;

    if (date !== undefined) {
      const d = new Date(String(date));
      if (isNaN(d.getTime())) {
        return res.status(400).json({ message: "Invalid date" });
      }
      parsedDate = d;
      dateChanged = parsedDate.getTime() !== new Date(booking.date).getTime();
      if (!useReservationEngine && dateChanged) {
        // Same helper the reservation-engine path uses. This was a second
        // hand-written copy of the field list and had already fallen behind it,
        // which is how a rescheduled booking keeps a stale "already sent".
        resetBookingReminderEmailStateForDateChange(booking, d);
        booking.date = d;
      }
    }
    if (assignmentRequested) {
      if (req.accessRole !== "admin" && !req.permissions.includes(PERMISSIONS.BOOKINGS_ASSIGN)) {
        return res.status(403).json({ message: "Assignment access denied" });
      }
      const currentAssignmentId = booking.assignedFixterId
        ? String(booking.assignedFixterId)
        : "";
      const requestedAssignmentId = req.body.assignedFixterId
        ? String(req.body.assignedFixterId)
        : "";
      assignmentChanged = currentAssignmentId !== requestedAssignmentId;
      if (!useReservationEngine) {
        Object.assign(booking, await resolveAssignment(req.body.assignedFixterId));
      }
    }
    if (useReservationEngine && (dateChanged || assignmentChanged)) {
      if (assignmentRequested && !req.body.assignedFixterId && booking.slotReservationId) {
        return res.status(400).json({
          code: "TECHNICIAN_REQUIRED",
          message: "A reserved booking cannot be unassigned",
        });
      }
      let technicianId = req.body.assignedFixterId || booking.assignedFixterId || null;
      if (!technicianId) {
        const options = await findEligibleTechnicians({
          slotStart: dateChanged ? parsedDate : booking.date,
          excludeReservationId: booking.slotReservationId || null,
          excludeBookingId: booking._id,
        });
        technicianId = options.recommended?.id;
      }
      if (!technicianId) {
        return res.status(409).json({
          code: "SLOT_UNAVAILABLE",
          message: "No eligible technician is available for this time",
        });
      }
      await moveReservationForBooking({
        bookingId: booking._id,
        technicianId,
        slotStart: dateChanged ? parsedDate : booking.date,
        actorUser: req.accessUser,
        createdByType: "admin",
        assignmentSource:
          req.accessRole === "admin" ? "admin" : "general_fixter",
      });
      booking = await Booking.findById(booking._id);
    }

    if (noteChanged) booking.note = String(note);
    if (adminNote !== undefined && String(adminNote) !== String(booking.adminNote || "")) booking.adminNote = String(adminNote);

    const imageUpload = await storeAppointmentImages({
      files: req.files || [],
      bookingDate: booking.date,
      bookingNumber: booking.bookingNumber,
      source: "admin",
    });
    if (imageUpload.images.length) {
      booking.images = (booking.images || []).concat(imageUpload.images);
      appendContentUpdate(booking, {
        actor: actorSnapshot(req.accessUser, req.accessRole || "admin"),
        source: "admin",
        imagesAdded: imageUpload.images,
      });
    }

    await booking.save();
    await logBookingChanges({
      bookingId: booking._id,
      before,
      after: bookingSnapshot(booking),
      req,
    });
    if (booking.guestRequestId) {
      await syncLeadFromBooking(booking.toObject()).catch((e) =>
        console.error("free visit lead sync (admin edit) failed:", e.message)
      );
    }

    /*
     * Reschedule and reassignment texts.
     *
     * Sent only for a booking that is actually Confirmed. Moving a Pending
     * or Canceled booking around is administrative housekeeping, and a
     * customer who was never told the original time has nothing to be told
     * about the new one.
     *
     * booking now carries the NEW date, which is what the reschedule key is
     * scoped to: the message is about this appointment, and a booking moved
     * twice correctly produces two notices.
     */
    try {
      if (/^confirmed$/i.test(String(booking.status || ""))) {
        const smsUser = booking.user ? await User.findById(booking.user).lean() : null;
        if (dateChanged) {
          // Email as well as the text (J-09): customers who cannot be texted heard nothing before.
          await notifyRescheduled(booking, { previousDate: before.date, source: "adminBookingUpdate" });
        }
        if (assignmentChanged && booking.assignedFixterId) {
          await smsNotify.notifyFixterAssignment(booking, {
            user: smsUser,
            fixterId: booking.assignedFixterId,
            fixterName: booking.assignedFixterName,
            // "Changed" only when somebody was already assigned. A first
            // assignment is news, not a correction, and saying "will now be"
            // to a customer who was never told a name reads as an apology
            // for something that never happened.
            isChange: Boolean(before?.assignedFixterId),
            source: "adminBookingUpdate",
          });
        }
      }
    } catch (e) {
      console.log("SMS booking-update error:", e.message);
    }

    return res.json({ message: "Booking updated", booking: legacyBookingView(booking) });
  } catch (err) {
    console.error("❌ Admin booking update error:", err.message);
    res.status(err?.statusCode || 500).json({
      code: err?.code || "BOOKING_UPDATE_FAILED",
      message: err.message || "Failed to update booking",
    });
  }
});

/* ───────────────── REFERRALS ───────────────── */

// ✅ GET All Referrals
router.get("/referrals", auth, onlyAdmin, async (_req, res) => {
  try {
    const referrals = await Referral.find();
    res.json(referrals);
  } catch (err) {
    console.error("❌ Fetch referrals error:", err);
    res.status(500).json({ message: "Failed to get referrals" });
  }
});

/* ───────────────── BLACKLIST ───────────────── */

// GET /api/admin/blacklist
router.get("/blacklist", auth, ...blacklistManage, async (_req, res) => {
  try {
    const rows = await Blacklist.find().populate(
      "user",
      "userId name email phone address city county state zip"
    );

    const out = rows.map((b) => {
      const u = b.user || {};
      return {
        _id: b._id,
        userId: u.userId,
        name: b.name || u.name,
        email: b.email || u.email,
        phone: b.phone || u.phone,
        address: u.address,
        city: u.city,
        county: u.county,
        state: u.state,
        zip: u.zip,
        reason: b.reason || "",
      };
    });

    res.json(out);
  } catch (e) {
    console.error("❌ blacklist GET:", e.message);
    res.status(500).json({ message: "Failed to load blacklist" });
  }
});

// POST /api/admin/blacklist/:id
router.post("/blacklist/:id", auth, ...blacklistManage, customerTargetsOnly(), async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    const exists = await findActiveBlockForUser(user);

    if (exists) return res.json({ message: "Already blacklisted", id: exists._id });

    // The home on the entry is the customer's default saved address (the legacy top-level fields are usually empty).
    const home = (user.addresses || []).find((a) => String(a._id) === String(user.defaultAddressId || "")) || (user.addresses || [])[0] || null;
    const blocker = req.accessUser || {};
    const entry = await Blacklist.create({
      user: user._id,
      userId: user.userId,
      name: user.name,
      email: user.email || undefined,
      phone: user.phone,
      address: home ? formatAddressLine(home) : user.address,
      city: home?.city || user.city,
      county: home?.county || user.county,
      state: home?.state || user.state,
      zip: home?.zip || user.zip,
      reason: req.body.reason || "",
      blockedBy: blocker._id || req.user?.id || null,
      blockedByName: blocker.name || blocker.email || "",
    });

    await createAdminActivityLog(req, {
      action: "Customer Blocked",
      entityType: "User",
      entityId: user._id,
      entityName: user.name || user.email || user.userId,
      details: {
        customerName: user.name,
        email: user.email,
        phone: user.phone,
        userId: user.userId,
        reason: req.body.reason || "",
        blacklistId: entry._id,
      },
    });

    res.json({ message: "Added to blacklist", id: entry._id });
  } catch (e) {
    console.error("❌ blacklist POST:", e.message);
    res.status(500).json({ message: "Failed to add to blacklist" });
  }
});

// DELETE /api/admin/blacklist/:id
router.delete("/blacklist/:id", auth, ...blacklistManage, async (req, res) => {
  try {
    const { id } = req.params;
    let target = await Blacklist.findById(id).lean();

    if (!target && /^[0-9a-fA-F]{24}$/.test(id)) {
      target = await Blacklist.findOne({ user: id }).lean();
    }

    if (!target) {
      return res.status(404).json({ message: "Blacklist entry not found" });
    }

    const audit = await createAdminActivityLog(req, {
      action: "Customer Unblock Started",
      entityType: "Blacklist",
      entityId: target._id,
      entityName: target.name || target.email || target.userId || "Blacklist entry",
      details: {
        customerName: target.name,
        email: target.email,
        phone: target.phone,
        userId: target.userId,
        reason: target.reason || "",
      },
    });

    /*
     * Lifted, not deleted: the entry stays as history (who blocked, why, who
     * lifted it, when). Every reader ignores lifted entries.
     */
    const blocker = req.accessUser || {};
    const lifted = await Blacklist.updateOne(
      { _id: target._id, liftedAt: null },
      {
        $set: {
          liftedAt: new Date(),
          liftedBy: blocker._id || req.user?.id || null,
          liftedByName: blocker.name || blocker.email || "",
          liftReason: String(req.body?.reason || "").trim().slice(0, 500),
        },
      }
    );
    if (!lifted.modifiedCount) {
      return res.status(404).json({ message: "Blacklist entry not found" });
    }

    await markAdminActivityLog(audit, {
      action: "Customer Unblocked",
      details: {
        customerName: target.name,
        email: target.email,
        phone: target.phone,
        userId: target.userId,
        reason: target.reason || "",
        unblockedAt: new Date().toISOString(),
      },
    });

    res.json({ message: "Removed from blacklist" });
  } catch (e) {
    console.error("❌ blacklist DELETE:", e.message);
    res.status(500).json({ message: "Failed to remove from blacklist" });
  }
});

/* ───────────────── REQUESTS / LEADS ───────────────── */

const { MANUAL_STATUSES: LEAD_MANUAL_STATUSES } = require("../utils/projects/leadConversion");
const { logProjectActivity: logLeadActivity } = require("../utils/projectActivity");

// GET /api/admin/requests
router.get("/requests", auth, ...leadsManage, async (_req, res) => {
  try {
    const [requests, estimateLeads] = await Promise.all([
      Request.find({}).select("-password").sort({ createdAt: -1 }).lean(),
      EstimateLead.find({}).sort({ createdAt: -1 }).lean(),
    ]);
    const mappedEstimateLeads = estimateLeads.map((lead) => ({
      _id: `estimate:${lead._id}`,
      name: lead.name,
      email: lead.email,
      phone: lead.phone,
      address: lead.address,
      message: lead.notes,
      serviceType: lead.service,
      sourcePage: lead.sourcePage || lead.source || "estimate",
      status: lead.status === "qualified" ? "contacted" : lead.status,
      createdAt: lead.createdAt,
      leadSource: "estimate",
    }));
    const combined = [...requests, ...mappedEstimateLeads].sort(
      (a, b) =>
        new Date(b.createdAt || 0).getTime() -
        new Date(a.createdAt || 0).getTime()
    );

    res.json(combined);
  } catch (err) {
    console.error("❌ Failed to fetch requests:", err.message);
    res.status(500).json({ message: "Failed to fetch requests" });
  }
});

// PUT /api/admin/requests/:id/status
router.put("/requests/:id/status", auth, ...leadsManage, async (req, res) => {
  try {
    const { status } = req.body;

    /* A free-visit lead with a visit takes its status from the visit, never by hand. */
    if (mongoose.isValidObjectId(req.params.id)) {
      const linked = await Request.findOne({ _id: req.params.id, bookingId: { $ne: null } }).select("_id").lean();
      if (linked) {
        return res.status(409).json({
          code: "STATUS_FOLLOWS_VISIT",
          message: "This lead's status follows its visit. Open the visit to confirm or decline it.",
        });
      }
    }

    if (!["new", "pending_confirmation", "contacted", "won", "lost"].includes(String(status))) {
      return res.status(400).json({ message: "Invalid status" });
    }

    if (String(req.params.id).startsWith("estimate:")) {
      const estimateId = String(req.params.id).slice("estimate:".length);
      if (!mongoose.isValidObjectId(estimateId)) {
        return res.status(400).json({ message: "Invalid estimate lead ID" });
      }
      // EstimateLead has no pending_confirmation (that belongs to free-visit
      // requests); writing it would store a value its own schema forbids.
      if (!LEAD_MANUAL_STATUSES.estimate.includes(String(status))) {
        return res.status(400).json({ message: "Invalid status for an estimate lead", code: "INVALID_STATUS" });
      }
      const beforeEstimate = await EstimateLead.findById(estimateId).select("status name").lean();
      const estimateLead = await EstimateLead.findByIdAndUpdate(
        estimateId,
        { $set: { status } },
        { new: true, runValidators: true }
      );
      if (!estimateLead) {
        return res.status(404).json({ message: "Estimate lead not found" });
      }
      await logLeadActivity(req, {
        action: "Lead Status Changed",
        entityType: "Lead",
        entityId: `estimate:${estimateLead._id}`,
        entityName: estimateLead.name || "",
        before: { status: beforeEstimate?.status || "" },
        after: { status: estimateLead.status },
      });
      return res.json({
        request: {
          _id: `estimate:${estimateLead._id}`,
          name: estimateLead.name,
          email: estimateLead.email,
          phone: estimateLead.phone,
          address: estimateLead.address,
          message: estimateLead.notes,
          serviceType: estimateLead.service,
          sourcePage:
            estimateLead.sourcePage || estimateLead.source || "estimate",
          status: estimateLead.status,
          createdAt: estimateLead.createdAt,
          leadSource: "estimate",
        },
      });
    }

    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: "Invalid lead ID" });
    }
    const beforeRequest = await Request.findById(req.params.id).select("status name").lean();
    const request = await Request.findByIdAndUpdate(
      req.params.id,
      { $set: { status } },
      { new: true, runValidators: true }
    ).select("-password");

    if (!request) {
      return res.status(404).json({ message: "Request not found" });
    }
    await logLeadActivity(req, {
      action: "Lead Status Changed",
      entityType: "Lead",
      entityId: String(request._id),
      entityName: request.name || "",
      before: { status: beforeRequest?.status || "" },
      after: { status: request.status },
    });

    res.json({ request });
  } catch (err) {
    console.error("❌ Failed to update request status:", err.message);
    res.status(500).json({ message: "Failed to update request status" });
  }
});

// DELETE /api/admin/requests/:id
router.delete("/requests/:id", auth, ...leadsManage, async (req, res) => {
  try {
    const rawId = String(req.params.id || "");
    const isEstimateLead = rawId.startsWith("estimate:");
    const actualId = isEstimateLead ? rawId.slice("estimate:".length) : rawId;

    if (!mongoose.isValidObjectId(actualId)) {
      return res.status(400).json({ message: "Invalid lead ID" });
    }

    const Model = isEstimateLead ? EstimateLead : Request;
    const lead = await Model.findById(actualId).lean();
    if (!lead) return res.status(404).json({ message: "Lead not found" });

    const expectedConfirmation = String(lead.name || "").trim();
    if (!expectedConfirmation || String(req.body?.confirmation || "") !== expectedConfirmation) {
      return res.status(400).json({
        message: `Type ${expectedConfirmation || "the lead name"} exactly to delete this lead.`,
      });
    }

    const audit = await createAdminActivityLog(req, {
      action: "Lead Delete Started",
      entityType: "Lead",
      entityId: rawId,
      entityName: lead.name || lead.email || rawId,
      details: {
        leadName: lead.name,
        leadEmail: lead.email,
        leadPhone: lead.phone,
        leadType: lead.serviceType || lead.service || lead.leadSource || "",
        leadId: rawId,
        source: isEstimateLead ? "EstimateLead" : "Request",
      },
    });

    const deleted = await Model.findByIdAndDelete(actualId);
    if (!deleted) return res.status(404).json({ message: "Lead not found" });

    await markAdminActivityLog(audit, {
      action: "Lead Deleted",
      details: {
        leadName: lead.name,
        leadEmail: lead.email,
        leadPhone: lead.phone,
        leadType: lead.serviceType || lead.service || lead.leadSource || "",
        leadId: rawId,
        source: isEstimateLead ? "EstimateLead" : "Request",
        deletedAt: new Date().toISOString(),
      },
    });

    return res.json({ message: "Lead deleted" });
  } catch (err) {
    console.error("Failed to delete lead:", err);
    return res.status(500).json({ message: "Failed to delete lead" });
  }
});

module.exports = router;

