// 📁 backend/routes/admin.js — per-address subscription aware (FINAL, DB-only)
const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();

const auth = require("../middleware/auth");
const { PERMISSIONS, requirePermission } = require("../middleware/authorize");
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
const {
  cancelBookingWithReservation,
  findEligibleTechnicians,
  moveReservationForBooking,
  reservationEngineEnabled,
  transitionBookingWithReservation,
} = require("../utils/slotReservationService");
const {
  getOneTimeVisitSettings,
  upsertOneTimeVisitSettings,
} = require("../utils/oneTimeVisitSettings");

const mail = require("../utils/emailService");
const Request = require("../models/Request");
const EstimateLead = require("../models/EstimateLead");
const {
  createOrUpdateContact,
  updateContactFields,
  formatBookingDateTime,
  addTag,
  removeTag,
} = require("../utils/ghlContact");
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
const onlyAdmin = requirePermission(PERMISSIONS.ADMIN);
const bookingsWrite = requirePermission(PERMISSIONS.BOOKINGS_WRITE);
const bookingsAssign = requirePermission(PERMISSIONS.BOOKINGS_ASSIGN);

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

async function getAddressPlansForUser(user) {
  const candidates = await Subscription.find({ user: user._id }).sort({
    currentPeriodEnd: -1,
    nextPaymentDate: -1,
    createdAt: -1,
    updatedAt: -1,
  });

  const byAddressId = new Map();
  const cancellationByAddressId = new Map();
  const hasAnyAddressSubs = candidates.some((subscription) => subscription.addressId);

  // 1) Map address-bound subs
  for (const address of user.addresses || []) {
    const addressSubs = candidates.filter(
      (subscription) => String(subscription.addressId || "") === String(address._id)
    );
    const selected = selectCurrentSubscription(addressSubs);
    if (selected && subscriptionGrantsAccess(selected)) {
      byAddressId.set(String(address._id), selected.subscriptionType);
      if (selected.cancellationDate) {
        cancellationByAddressId.set(
          String(address._id),
          selected.cancellationDate.toISOString().split("T")[0]
        );
      }
    }
  }

  // 2) Addressless active sub → default address
  const addrless = !hasAnyAddressSubs
    ? selectCurrentSubscription(candidates.filter((subscription) => !subscription.addressId))
    : null;
  if (addrless && subscriptionGrantsAccess(addrless) && user.defaultAddressId) {
    byAddressId.set(String(user.defaultAddressId), addrless.subscriptionType);
    if (addrless.cancellationDate) {
      cancellationByAddressId.set(
        String(user.defaultAddressId),
        addrless.cancellationDate.toISOString().split("T")[0]
      );
    }
  }

  return (user.addresses || []).map((a) => ({
    _id: String(a._id),
    label: a.label,
    line1: a.line1,
    city: a.city,
    state: a.state,
    zip: a.zip,
    county: a.county || "",
    isDefault: String(user.defaultAddressId || "") === String(a._id),
    plan: byAddressId.get(String(a._id)) || null,
    scheduledCancellationDate: cancellationByAddressId.get(String(a._id)) || null,
  }));
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
router.get("/users/:id/addressesDetailed", auth, onlyAdmin, async (req, res) => {
  const u = await User.findById(req.params.id).lean();
  if (!u) return res.status(404).json({ message: "User not found" });
  const rows = await getAddressPlansForUser(u);
  res.json(rows);
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
router.get("/users", auth, onlyAdmin, async (_req, res) => {
  try {
    const users = await User.find({ role: { $ne: "employee" } })
      .select("-password")
      .sort({ createdAt: -1 })
      .lean();
    const out = [];

    for (const u of users) {
      const addressesDetailed = await getAddressPlansForUser(u);
      out.push({ ...u, addressesDetailed });
    }

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
      const out = [];
      for (const user of users) {
        out.push({
          _id: String(user._id),
          userId: user.userId,
          name: user.name,
          email: user.email,
          phone: user.phone || "",
          createdAt: user.createdAt,
          addressesDetailed: await getAddressPlansForUser(user),
        });
      }
      return res.json(out);
    } catch (error) {
      console.error("Fetch members failed:", error);
      return res.status(500).json({ message: "Failed to get members" });
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
          .select("user userId name email reason createdAt")
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
            actorName: "Admin",
            actorRole: "admin",
            status: "blocked",
          })
        );
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
          "Removed blacklist entries are not retained after unblock.",
        ],
      });
    } catch (err) {
      console.error("Customer activity failed:", err);
      return res.status(500).json({ message: "Failed to load customer activity" });
    }
  }
);

// GET /api/admin/activity-log
router.get("/activity-log", auth, onlyAdmin, async (req, res) => {
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
router.get("/activity-log/summary", auth, onlyAdmin, async (_req, res) => {
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

    const expectedConfirmation = `DELETE ${String(user.email || "").trim()}`;
    if (String(req.body?.confirmation || "") !== expectedConfirmation) {
      return res.status(400).json({
        message: `Type ${expectedConfirmation} to delete this user.`,
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

// ✅ UPDATE User Info (name, phone, legacy subscription)
router.put("/users/:id", auth, onlyAdmin, async (req, res) => {
  const allowedFields = ["name", "phone", "subscription"];
  const updates = {};

  allowedFields.forEach((field) => {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  });

  try {
    const user = await User.findByIdAndUpdate(req.params.id, updates, {
      new: true,
    }).select("-password");

    if (!user) return res.status(404).json({ message: "User not found" });
    res.json({ message: "User updated", user });
  } catch (err) {
    console.error("❌ Edit user error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ✅ Legacy: Update single user.subscription (kept for backward compatibility)
router.put("/users/:id/subscription", auth, onlyAdmin, async (req, res) => {
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

// ✅ NEW: Set/Clear subscription for a specific address
// PUT /api/admin/users/:id/address/:addressId/subscription
router.put(
  "/users/:id/address/:addressId/subscription",
  auth,
  onlyAdmin,
  async (req, res) => {
    try {
      const { id, addressId } = req.params;
      const planRaw = String(req.body.plan || "").toLowerCase();
      const addrObjId = new mongoose.Types.ObjectId(addressId);

      const user = await User.findById(id);
      if (!user) return res.status(404).json({ message: "User not found" });

      const addr = user.addresses.id(addressId);
      if (!addr) return res.status(404).json({ message: "Address not found" });

      const respond = async (message, activityDetails = null) => {
        if (activityDetails) {
          await createAdminActivityLog(req, activityDetails);
        }
        const uLean = await User.findById(user._id).lean();
        const addressesDetailed = await getAddressPlansForUser(uLean);
        return res.json({ message, addressesDetailed });
      };

      const activeSub = await Subscription.findOne({
        user: user._id,
        addressId: addrObjId,
        status: { $in: ["active", "trialing"] },
      }).sort({ updatedAt: -1 });
      const previousAddressPlan = activeSub?.subscriptionType || "";

      const stripeSubscription = activeSub
        ? await resolveStripeSubscriptionForRecord({ subscription: activeSub, user })
        : null;

      const shouldRequireStripeSync = !!(
        activeSub &&
        (activeSub.stripeSubscriptionId ||
          activeSub.stripeCustomerId ||
          activeSub.stripeSubscriptionItemId ||
          activeSub.stripePriceId ||
          user.stripeCustomerId)
      );

      // 1) CANCEL
      if (planRaw === "cancel") {
        if (stripeSubscription && activeSub) {
          const activeStripeSubscription = await clearStripeSubscriptionSchedule(stripeSubscription);
          const cancellationTarget = activeStripeSubscription || stripeSubscription;
          const canceledStripeSubscription = await stripe.subscriptions.update(
            cancellationTarget.id,
            {
              cancel_at_period_end: true,
              metadata: {
                ...(cancellationTarget.metadata || {}),
                addressId: String(addrObjId),
                userId: String(user.userId || user._id),
                localSubscriptionId: String(activeSub._id),
              },
              expand: ["items.data.price", "schedule"],
            }
          );

          await upsertSubscriptionFromStripe({
            stripeSubscription: canceledStripeSubscription,
            user,
            addressIdHint: String(addrObjId),
          });

          return respond("Address cancellation scheduled in Stripe", {
            action: "Subscription Canceled",
            entityType: "Subscription",
            entityId: activeSub._id,
            entityName: `${user.name} - ${addr.line1}`,
            details: {
              customerName: user.name,
              email: user.email,
              addressId,
              address: `${addr.line1}, ${addr.city}, ${addr.state} ${addr.zip}`,
              previousPlan: previousAddressPlan,
              source: "admin_panel_stripe",
            },
          });
        }

        if (shouldRequireStripeSync) {
          return res.status(409).json({
            message:
              "This subscription could not be safely linked to Stripe. Admin DB-only cancellation was blocked.",
          });
        }

        await Subscription.updateMany(
          {
            user: user._id,
            addressId: addrObjId,
            status: { $in: ["active", "trialing"] },
          },
          {
            $set: {
              status: "canceled",
              cancellationDate: new Date(),
              cancellationReason: "admin_panel",
            },
          }
        );

        if (
          String(user.defaultAddressId || "") === String(addrObjId) &&
          user.subscription
        ) {
          await User.collection.updateOne({ _id: user._id }, { $set: { subscription: null } });
        }

        try {
          const stillHasAnyActiveSubscription = await Subscription.findOne({
            user: user._id,
            status: { $in: ["active", "trialing"] },
          }).lean();

          if (!stillHasAnyActiveSubscription) {
            const contactId = await createOrUpdateContact({
              name: user.name,
              email: user.email,
              phone: user.phone,
            });

            if (contactId) {
              await removeTag(contactId, "subscription_purchased");
            }
          }
        } catch (e) {
          console.log("GHL subscription cancel automation error:", e.message);
        }

        return respond("Address plan canceled", {
          action: "Subscription Canceled",
          entityType: "Subscription",
          entityId: activeSub?._id || addressId,
          entityName: `${user.name} - ${addr.line1}`,
          details: {
            customerName: user.name,
            email: user.email,
            addressId,
            address: `${addr.line1}, ${addr.city}, ${addr.state} ${addr.zip}`,
            previousPlan: previousAddressPlan,
            source: "admin_panel_db",
          },
        });
      }

      // 2) VALIDATE PLAN
      if (!["basic", "plus", "premium", "elite"].includes(planRaw)) {
        return res.status(400).json({ message: "Invalid plan" });
      }

      if (stripeSubscription && activeSub) {
        if (activeSub.cancelAtPeriodEnd) {
          return res.status(409).json({
            message:
              "Cancellation is already scheduled for this subscription. Admin plan changes are blocked until that is removed.",
          });
        }

        const targetPlan = normalizePlanType(planRaw);
        const targetCycle = activeSub.billingCycle || "monthly";
        const priceResolution = await resolveStripePriceId({
          plan: targetPlan,
          billingCycle: targetCycle,
        });
        const nextPriceId = priceResolution.priceId;
        const item = getStripeSubscriptionItemForRecord({
          subscription: activeSub,
          stripeSubscription,
        });

        if (!targetPlan || !nextPriceId || !item?.id) {
          return res.status(409).json({
            message: "Unable to map this Stripe subscription for an admin plan change.",
          });
        }

        const changeType = classifyPlanChange({
          currentPlan: activeSub.subscriptionType,
          currentBillingCycle: activeSub.billingCycle,
          targetPlan,
          targetBillingCycle: targetCycle,
        });

        let updatedStripeSubscription;
        if (changeType === "upgrade") {
          updatedStripeSubscription = await applyStripeSubscriptionUpgrade({
            stripeSubscription,
            subscription: activeSub,
            user,
            addressId: String(addrObjId),
            nextPriceId,
          });
        } else {
          updatedStripeSubscription = await scheduleStripeSubscriptionDowngrade({
            stripeSubscription,
            subscription: activeSub,
            user,
            addressId: String(addrObjId),
            nextPriceId,
          });
        }

        await upsertSubscriptionFromStripe({
          stripeSubscription: updatedStripeSubscription,
          user,
          addressIdHint: String(addrObjId),
        });

        return respond(
          changeType === "upgrade"
            ? "Address plan updated in Stripe"
            : "Address downgrade scheduled in Stripe",
          {
            action: "Plan Changed",
            entityType: "Subscription",
            entityId: activeSub._id,
            entityName: `${user.name} - ${addr.line1}`,
            details: {
              customerName: user.name,
              email: user.email,
              addressId,
              address: `${addr.line1}, ${addr.city}, ${addr.state} ${addr.zip}`,
              previousPlan: previousAddressPlan,
              newPlan: planRaw,
              changeType,
              source: "admin_panel_stripe",
            },
          }
        );
      }

      if (shouldRequireStripeSync) {
        return res.status(409).json({
          message:
            "This subscription could not be safely linked to Stripe. Admin DB-only plan update was blocked.",
        });
      }

      // 3) UPSERT active subscription
      let sub = activeSub;

      const now = new Date();
      const next = new Date(now);
      next.setMonth(now.getMonth() + 1);

      if (!sub) {
        sub = new Subscription({
          user: user._id,
          userId: user.userId,
          subscriptionType: planRaw,
          addressId: addrObjId,
          addressSnapshot: {
            line1: addr.line1,
            city: addr.city,
            state: addr.state,
            zip: addr.zip,
            county: addr.county || "",
          },
          startDate: now,
          latestPaymentDate: now,
          nextPaymentDate: next,
          status: "active",
          planPrice: null,
          paymentMethod: "admin-panel",
        });
      } else {
        sub.subscriptionType = planRaw;
        sub.status = "active";
        sub.latestPaymentDate = now;
        sub.nextPaymentDate = sub.nextPaymentDate || next;
      }

      await sub.save();

      if (String(user.defaultAddressId || "") === String(addrObjId)) {
        await User.collection.updateOne(
          { _id: user._id },
          { $set: { subscription: planRaw, subscriptionStart: now } }
        );
      }

      try {
        const contactId = await createOrUpdateContact({
          name: user.name,
          email: user.email,
          phone: user.phone,
        });

        if (contactId) {
          await addTag(contactId, "subscription_purchased");
        }
      } catch (e) {
        console.log("GHL subscription add automation error:", e.message);
      }

      return respond("Address plan updated", {
        action: "Plan Changed",
        entityType: "Subscription",
        entityId: sub._id,
        entityName: `${user.name} - ${addr.line1}`,
        details: {
          customerName: user.name,
          email: user.email,
          addressId,
          address: `${addr.line1}, ${addr.city}, ${addr.state} ${addr.zip}`,
          previousPlan: previousAddressPlan,
          newPlan: planRaw,
          source: "admin_panel_db",
        },
      });
    } catch (err) {
      console.error("❌ Per-address plan update error:", err.message);
      res.status(err?.statusCode || 500).json({ message: "Server error", error: err.message });
    }
  }
);

// ✅ NEW: Schedule or clear a specific cancellation date for an address subscription
// PUT /api/admin/users/:id/address/:addressId/cancellation-date
router.put(
  "/users/:id/address/:addressId/cancellation-date",
  auth,
  onlyAdmin,
  async (req, res) => {
    try {
      const { id, addressId } = req.params;
      const { cancelOnDate } = req.body; // "YYYY-MM-DD" or null to clear
      const addrObjId = new mongoose.Types.ObjectId(addressId);

      const user = await User.findById(id);
      if (!user) return res.status(404).json({ message: "User not found" });

      const addr = user.addresses.id(addressId);
      if (!addr) return res.status(404).json({ message: "Address not found" });

      const activeSub = await Subscription.findOne({
        user: user._id,
        addressId: addrObjId,
        status: { $in: ["active", "trialing"] },
      }).sort({ updatedAt: -1 });

      if (!activeSub) {
        return res.status(404).json({ message: "No active subscription for this address" });
      }

      const respond = async (message) => {
        const uLean = await User.findById(user._id).lean();
        const addressesDetailed = await getAddressPlansForUser(uLean);
        return res.json({ message, addressesDetailed });
      };

      const stripeSubscription = activeSub.stripeSubscriptionId
        ? await resolveStripeSubscriptionForRecord({ subscription: activeSub, user })
        : null;

      // CLEAR cancellation date
      if (!cancelOnDate) {
        if (stripeSubscription) {
          const clearedSub = await stripe.subscriptions.update(stripeSubscription.id, {
            cancel_at: "",
            cancel_at_period_end: false,
            expand: ["items.data.price", "schedule"],
          });
          await upsertSubscriptionFromStripe({
            stripeSubscription: clearedSub,
            user,
            addressIdHint: String(addrObjId),
          });
        } else {
          activeSub.cancellationDate = null;
          activeSub.cancelAtPeriodEnd = false;
          await activeSub.save();
        }
        return respond("Cancellation date cleared");
      }

      // SET cancellation date — convert YYYY-MM-DD to end-of-day UTC timestamp
      // Use 05:00 UTC of D+1 which equals midnight/1am Eastern (covers both EST and EDT)
      const [year, month, day] = String(cancelOnDate).split("-").map(Number);
      if (!year || !month || !day) {
        return res.status(400).json({ message: "Invalid cancelOnDate format, expected YYYY-MM-DD" });
      }
      const cancelAtDate = new Date(Date.UTC(year, month - 1, day + 1, 5, 0, 0));
      const cancelAtTimestamp = Math.floor(cancelAtDate.getTime() / 1000);

      if (stripeSubscription) {
        const updatedSub = await stripe.subscriptions.update(stripeSubscription.id, {
          cancel_at: cancelAtTimestamp,
          cancel_at_period_end: false,
          expand: ["items.data.price", "schedule"],
        });
        await upsertSubscriptionFromStripe({
          stripeSubscription: updatedSub,
          user,
          addressIdHint: String(addrObjId),
        });
      } else {
        activeSub.cancellationDate = cancelAtDate;
        activeSub.cancelAtPeriodEnd = true;
        await activeSub.save();
      }

      return respond("Cancellation date set");
    } catch (err) {
      console.error("❌ Per-address cancellation-date update error:", err.message);
      res.status(err?.statusCode || 500).json({ message: "Server error", error: err.message });
    }
  }
);

// ✅ ONE-TIME: remove subscription_purchased from users with NO active subscription
// POST /api/admin/ghl/subscription-tags/cleanup
router.post("/ghl/subscription-tags/cleanup", auth, onlyAdmin, async (_req, res) => {
  try {
    const users = await User.find({
      phone: { $exists: true, $ne: "" },
    }).select("_id name email phone userId subscription stripeCustomerId");

    let scanned = 0;
    let noPhone = 0;
    let noContact = 0;
    let removed = 0;
    let repairedFromStripe = 0;
    const errors = [];

    for (const user of users) {
      scanned++;

      if (!user.phone) {
        noPhone++;
        continue;
      }

      const subscriptions = await Subscription.find({ user: user._id });
      const selectedSubscription = selectCurrentSubscription(subscriptions);
      let hasActiveAccess =
        selectedSubscription && subscriptionGrantsAccess(selectedSubscription);

      if (!hasActiveAccess && user.stripeCustomerId) {
        try {
          const repair = await syncActiveStripeSubscriptionForUser(user, {
            source: "ghl_subscription_tag_cleanup",
          });
          hasActiveAccess =
            repair.selectedAfter && subscriptionGrantsAccess(repair.selectedAfter);
          if (hasActiveAccess) repairedFromStripe++;
        } catch (repairError) {
          errors.push({
            userId: user.userId || "",
            email: user.email || "",
            phone: user.phone || "",
            error: `Stripe subscription repair failed before GHL cleanup: ${repairError.message}`,
          });
          continue;
        }
      }

      if (hasActiveAccess) {
        continue;
      }

      try {
        const contactId = await createOrUpdateContact({
          name: user.name,
          email: user.email,
          phone: user.phone,
        });

        if (!contactId) {
          noContact++;
          continue;
        }

        const ok = await removeTag(contactId, "subscription_purchased");
        if (ok) removed++;
      } catch (e) {
        errors.push({
          userId: user.userId || "",
          email: user.email || "",
          phone: user.phone || "",
          error: e.message,
        });
      }
    }

    return res.json({
      message: "GHL subscription tag cleanup finished",
      scanned,
      removed,
      repairedFromStripe,
      noPhone,
      noContact,
      errors,
    });
  } catch (err) {
    console.error("❌ GHL subscription tag cleanup error:", err.message);
    return res.status(500).json({
      message: "Server error",
      error: err.message,
    });
  }
});

// ✅ ONE-TIME: sync all DB users into GHL contacts
router.post("/ghl/sync-all-users", auth, onlyAdmin, async (_req, res) => {
  try {
    const users = await User.find({}).select("_id userId name email phone");

    let scanned = 0;
    let skippedNoPhone = 0;
    let synced = 0;
    const errors = [];

    for (const user of users) {
      scanned++;

      if (!user.phone || !String(user.phone).trim()) {
        skippedNoPhone++;
        continue;
      }

      try {
        const contactId = await createOrUpdateContact({
          name: user.name,
          email: user.email,
          phone: user.phone,
        });

        if (contactId) {
          synced++;
        } else {
          errors.push({
            userId: user.userId || "",
            email: user.email || "",
            phone: user.phone || "",
            error: "No contactId returned from GHL",
          });
        }
      } catch (e) {
        errors.push({
          userId: user.userId || "",
          email: user.email || "",
          phone: user.phone || "",
          error: e.message,
        });
      }
    }

    return res.json({
      message: "GHL full sync finished",
      scanned,
      synced,
      skippedNoPhone,
      errors,
    });
  } catch (err) {
    console.error("❌ GHL full sync error:", err.message);
    return res.status(500).json({
      message: "Server error",
      error: err.message,
    });
  }
});
/* ───────────────── BOOKINGS ───────────────── */

// ✅ GET All Bookings
router.get("/bookings", auth, ...requirePermission(PERMISSIONS.BOOKINGS_READ), async (req, res) => {
  try {
    const query =
      String(req.query.assigned || "").toLowerCase() === "me"
        ? { assignedFixterId: req.accessUser._id }
        : {};
    const bookings = await Booking.find(query).populate(
      "user",
      "userId name email phone subscription"
    );
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
      const booking = await Booking.findById(req.params.bookingId)
        .select("_id name email user")
        .lean();
      if (!booking) {
        return res.status(404).json({ message: "Booking not found" });
      }
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
router.put("/bookings/:id/status", auth, ...bookingsWrite, async (req, res) => {
  const { status } = req.body;
  const validStatuses = ["Pending", "Confirmed", "Completed", "Canceled"];

  if (!validStatuses.includes(status)) {
    return res.status(400).json({ message: "Invalid status" });
  }

  try {
    let booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ message: "Booking not found" });
    const before = bookingSnapshot(booking);
    const useReservationEngine = reservationEngineEnabled();
    const assignmentRequested = Object.prototype.hasOwnProperty.call(
      req.body,
      "assignedFixterId"
    );
    if (assignmentRequested) {
      if (req.accessRole !== "admin" && !req.permissions.includes(PERMISSIONS.BOOKINGS_ASSIGN)) {
        return res.status(403).json({ message: "Assignment access denied" });
      }
      if (useReservationEngine) {
        if (!req.body.assignedFixterId) {
          return res.status(400).json({
            code: "TECHNICIAN_REQUIRED",
            message: "A reserved booking cannot be unassigned",
          });
        }
        await moveReservationForBooking({
          bookingId: booking._id,
          technicianId: req.body.assignedFixterId,
          slotStart: booking.date,
          actorUser: req.accessUser,
          createdByType: "admin",
          assignmentSource:
            req.accessRole === "admin" ? "admin" : "general_fixter",
        });
        booking = await Booking.findById(booking._id);
      } else {
        Object.assign(booking, await resolveAssignment(req.body.assignedFixterId));
      }
    }
    if (
      useReservationEngine &&
      status.toLowerCase() === "confirmed" &&
      !booking.slotReservationId &&
      !assignmentRequested
    ) {
      const options = await findEligibleTechnicians({
        slotStart: booking.date,
      });
      if (!options.recommended?.id) {
        return res.status(409).json({
          code: "SLOT_UNAVAILABLE",
          message: "No eligible technician is available for this booking",
        });
      }
      await moveReservationForBooking({
        bookingId: booking._id,
        technicianId: options.recommended.id,
        slotStart: booking.date,
        actorUser: req.accessUser,
        createdByType: "admin",
        assignmentSource: "automatic",
      });
      booking = await Booking.findById(booking._id);
    }

    const prev = String(booking.status || "");
    const normalizedNextStatus = String(status || "").toLowerCase();
    const transitionedToCompleted = isCompletionTransition(prev, status);

    if (
      useReservationEngine &&
      status.toLowerCase() === "canceled"
    ) {
      const result = await cancelBookingWithReservation({
        bookingId: booking._id,
        actorUser: req.accessUser,
        createdByType: "admin",
        reason: "Canceled by Admin",
      });
      booking = result.booking;
    } else if (
      useReservationEngine &&
      status.toLowerCase() === "completed" &&
      prev.toLowerCase() !== "completed"
    ) {
      const result = await transitionBookingWithReservation({
        bookingId: booking._id,
        actorUser: req.accessUser,
        createdByType: "admin",
        reason: "Booking completed",
        status: "Completed",
        clearAssignment: false,
      });
      booking = result.booking;
    } else {
      booking.statusHistory = (booking.statusHistory || []).concat({
        status: booking.status,
        date: new Date(),
      });
      booking.status = status;

      if (
        prev.toLowerCase() !== "confirmed" &&
        String(status).toLowerCase() === "confirmed"
      ) {
        booking.reminder24hQueuedAt = undefined;
        booking.reminder24hSentAt = undefined;
        booking.reminder24hSkippedAt = undefined;
        booking.reminder24hSkipReason = "";
        booking.reminder60mQueuedAt = undefined;
        booking.reminder60mSentAt = undefined;
      }

      await booking.save();
      await logBookingChanges({
        bookingId: booking._id,
        before,
        after: bookingSnapshot(booking),
        req,
      });
    }

    if (transitionedToCompleted) {
      await Booking.updateOne(
        { _id: booking._id, status: /^completed$/i },
        {
          $set: { completedAt: new Date() },
          $unset: {
            reviewRequestQueuedAt: 1,
            reviewRequestLockExpiresAt: 1,
            reviewRequestSkippedAt: 1,
          },
        }
      );
      booking = await Booking.findById(booking._id);
    } else if (normalizedNextStatus !== "completed") {
      await Booking.updateOne(
        { _id: booking._id },
        {
          $unset: {
            reviewRequestQueuedAt: 1,
            reviewRequestLockExpiresAt: 1,
          },
        }
      );
    }

    // GHL SMS automation hooks
    try {
      const normalizedStatus = String(status || "").toLowerCase();
      const u = await User.findOne({ userId: booking.userId });

      const contactId = await createOrUpdateContact({
        name: booking.name || u?.name,
        email: booking.email || u?.email,
        phone: booking.phone || u?.phone,
      });

      if (normalizedStatus === "confirmed") {
        const pretty = formatBookingDateTime(booking.date);

        await updateContactFields(contactId, [
          {
            key: "booking_datetime_pretty",
            value: pretty,
          },
        ]);

        await addTag(contactId, "booking_confirmed");
      }

      if (normalizedStatus === "completed") {
        const pretty = formatBookingDateTime(booking.date);

        await updateContactFields(contactId, [
          {
            key: "booking_datetime_pretty",
            value: pretty,
          },
        ]);

        await addTag(contactId, "booking_completed");
      }

      if (normalizedStatus === "canceled") {
        const pretty = formatBookingDateTime(booking.date);

        await updateContactFields(contactId, [
          {
            key: "booking_datetime_pretty",
            value: pretty,
          },
        ]);

        await addTag(contactId, "booking_cancelled");
      }
    } catch (e) {
      console.log("GHL booking status automation error:", e.message);
    }

    // Free capacity if newly canceled
    if (
      !useReservationEngine &&
      prev.toLowerCase() !== "canceled" &&
      status.toLowerCase() === "canceled"
    ) {
      try {
        const cfg = await CalendarConfig.findOne().lean();
        const tz = cfg?.timezone || "America/New_York";
        const ymd = ymdInTZ(new Date(booking.date), tz);
        const hh = hhmmInTZ(new Date(booking.date), tz);

        await SlotCounter.updateOne({ ymd, time: hh }, { $inc: { count: -1 } });
      } catch (e) {
        console.log("Slot free (admin cancel) error:", e.message);
      }
    }

    // Optional: notify user
    try {
      const u = (await User.findOne({ userId: booking.userId })) || {};
      const address = [booking.address, booking.city, booking.state, booking.zip]
        .filter(Boolean)
        .join(", ");

      const key =
        {
          confirmed: "booking_confirmed",
          completed: "booking_completed",
          canceled: "booking_canceled",
        }[(status || "").toLowerCase()];

      const shouldSendStatusEmail =
        key &&
        (key !== "booking_completed" || transitionedToCompleted);

      if (shouldSendStatusEmail && (booking.email || u.email)) {
        await mail.sendTx(
          key,
          booking.email || u.email,
          {
            name: booking.name || u.name || (u.email || "").split("@")[0],
            bookingNumber: booking.bookingNumber,
            date: booking.date,
            service: booking.service,
            selectedTask: booking.selectedTask,
            bookingType: booking.bookingType,
            accessType: booking.accessType,
            address,
          },
          {
            bccAdmin: false,
            logContext: {
              bookingId: booking._id,
              bookingNumber: booking.bookingNumber,
              customerName: booking.name || u.name || "",
              customerEmail: booking.email || u.email || "",
              recipientName: booking.name || u.name || "",
              recipientEmail: booking.email || u.email || "",
              emailType: "transactional",
              source: "adminBookingStatus",
            },
          }
        );
      }
    } catch (e) {
      console.log("Mail status-change error:", e.message);
    }

    if (prev.toLowerCase() !== "canceled" && status.toLowerCase() === "canceled") {
      await createAdminActivityLog(req, {
        action: "Booking Manually Canceled",
        entityType: "Booking",
        entityId: booking._id,
        entityName: booking.bookingNumber || booking.name,
        details: {
          bookingNumber: booking.bookingNumber,
          customerName: booking.name,
          customerEmail: booking.email,
          service: booking.service,
          date: booking.date,
          previousStatus: prev,
          newStatus: status,
        },
      });
    }

    res.json({ message: "Status updated", booking });
  } catch (err) {
    console.error("❌ Update booking status error:", err);
    res.status(err?.statusCode || 500).json({ message: err.message || "Server error" });
  }
});

// ✅ NEW: Update booking note/date (admin)
// PUT /api/admin/bookings/:id
router.put("/bookings/:id", auth, ...bookingsWrite, async (req, res) => {
  try {
    const { id } = req.params;
    const { note, date } = req.body || {};

    let booking = await Booking.findById(id);
    if (!booking) return res.status(404).json({ message: "Booking not found" });
    const before = bookingSnapshot(booking);
    const useReservationEngine = reservationEngineEnabled();
    const assignmentRequested = Object.prototype.hasOwnProperty.call(
      req.body || {},
      "assignedFixterId"
    );
    let parsedDate = null;

    if (note !== undefined) booking.note = String(note);

    if (date !== undefined) {
      const d = new Date(String(date));
      if (isNaN(d.getTime())) {
        return res.status(400).json({ message: "Invalid date" });
      }
      parsedDate = d;
      if (!useReservationEngine) booking.date = d;
      booking.reminder24hQueuedAt = undefined;
      booking.reminder24hSentAt = undefined;
      booking.reminder24hSkippedAt = undefined;
      booking.reminder24hSkipReason = "";
      booking.reminder60mQueuedAt = undefined;
      booking.reminder60mSentAt = undefined;
    }
    if (assignmentRequested) {
      if (req.accessRole !== "admin" && !req.permissions.includes(PERMISSIONS.BOOKINGS_ASSIGN)) {
        return res.status(403).json({ message: "Assignment access denied" });
      }
      if (!useReservationEngine) {
        Object.assign(booking, await resolveAssignment(req.body.assignedFixterId));
      }
    }
    if (useReservationEngine && (parsedDate || assignmentRequested)) {
      let technicianId =
        req.body.assignedFixterId || booking.assignedFixterId || null;
      if (!technicianId) {
        const options = await findEligibleTechnicians({
          slotStart: parsedDate || booking.date,
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
        slotStart: parsedDate || booking.date,
        actorUser: req.accessUser,
        createdByType: "admin",
        assignmentSource:
          req.accessRole === "admin" ? "admin" : "general_fixter",
      });
      booking = await Booking.findById(booking._id);
      if (note !== undefined) booking.note = String(note);
      if (parsedDate) {
        booking.reminder24hQueuedAt = undefined;
        booking.reminder24hSentAt = undefined;
        booking.reminder24hSkippedAt = undefined;
        booking.reminder24hSkipReason = "";
        booking.reminder60mQueuedAt = undefined;
        booking.reminder60mSentAt = undefined;
      }
    }

    await booking.save();
    await logBookingChanges({
      bookingId: booking._id,
      before,
      after: bookingSnapshot(booking),
      req,
    });

    return res.json({ message: "Booking updated", booking });
  } catch (err) {
    console.error("❌ Admin booking update error:", err.message);
    res.status(err?.statusCode || 500).json({ message: "Server error", error: err.message });
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
router.get("/blacklist", auth, onlyAdmin, async (_req, res) => {
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
router.post("/blacklist/:id", auth, onlyAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    const exists = await Blacklist.findOne({
      $or: [{ user: user._id }, { email: user.email }],
    });

    if (exists) return res.json({ message: "Already blacklisted", id: exists._id });

    const entry = await Blacklist.create({
      user: user._id,
      userId: user.userId,
      name: user.name,
      email: user.email,
      phone: user.phone,
      address: user.address,
      city: user.city,
      county: user.county,
      state: user.state,
      zip: user.zip,
      reason: req.body.reason || "",
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
router.delete("/blacklist/:id", auth, onlyAdmin, async (req, res) => {
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

    const removed = await Blacklist.findByIdAndDelete(target._id);
    if (!removed) {
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

// GET /api/admin/requests
router.get("/requests", auth, onlyAdmin, async (_req, res) => {
  try {
    const [requests, estimateLeads] = await Promise.all([
      Request.find({}).sort({ createdAt: -1 }).lean(),
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
router.put("/requests/:id/status", auth, onlyAdmin, async (req, res) => {
  try {
    const { status } = req.body;

    if (!["new", "contacted", "won", "lost"].includes(String(status))) {
      return res.status(400).json({ message: "Invalid status" });
    }

    if (String(req.params.id).startsWith("estimate:")) {
      const estimateId = String(req.params.id).slice("estimate:".length);
      if (!mongoose.isValidObjectId(estimateId)) {
        return res.status(400).json({ message: "Invalid estimate lead ID" });
      }
      const estimateLead = await EstimateLead.findByIdAndUpdate(
        estimateId,
        { $set: { status } },
        { new: true }
      );
      if (!estimateLead) {
        return res.status(404).json({ message: "Estimate lead not found" });
      }
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

    const request = await Request.findByIdAndUpdate(
      req.params.id,
      { $set: { status } },
      { new: true }
    );

    if (!request) {
      return res.status(404).json({ message: "Request not found" });
    }

    res.json({ request });
  } catch (err) {
    console.error("❌ Failed to update request status:", err.message);
    res.status(500).json({ message: "Failed to update request status" });
  }
});

// DELETE /api/admin/requests/:id
router.delete("/requests/:id", auth, onlyAdmin, async (req, res) => {
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

