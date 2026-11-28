/**
 * Writing a Tip record: the one path every writer shares.
 *
 * The live Stripe webhook, the hourly reconcile (utils/tipReconcile) and the
 * repair script (scripts/repair_missing_tips.js) all record a tip through
 * recordTipFromSession, so they cannot disagree about who is credited, which
 * date it carries, or what counts as a duplicate.
 *
 * IDEMPOTENT ON THE PAYMENT INTENT
 * A read first so a redelivery is cheap, and the unique index on
 * Tip.stripePaymentIntentId behind it, so two writers racing (a webhook retry
 * and a reconcile pass, or two repair runs) still produce exactly one Tip.
 *
 * NEVER MOVES MONEY
 * Reads our database and writes Tip rows. No Stripe writes, no payouts. The
 * Fixter notification is sent only when the caller asks (the live webhook);
 * reconcile and repair pass notify: false.
 */

const mongoose = require("mongoose");
const User = require("../models/User");
const Booking = require("../models/Booking");
const Tip = require("../models/Tip");
const {
  applyRefundToTip,
  attributionFromVisitHistory,
  isEligibleFixter,
  isFixterTipCheckoutSession,
  isLegacyTipPaymentLinkSession,
  tipRecordFromCheckoutSession,
} = require("./fixterTips");

const VISIT_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

function log(level, event, details = {}) {
  const payload = JSON.stringify({ level, event, scope: "fixter_tip", ...details });
  if (level === "error") console.error(payload);
  else if (level === "warn") console.warn(payload);
  else console.log(payload);
}

function stripeId(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  return value.id ? String(value.id) : "";
}

function objectIdOrNull(value) {
  const text = String(value || "").trim();
  return mongoose.isValidObjectId(text) ? text : null;
}

function formatMoney(cents, currency = "usd") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: String(currency || "usd").toUpperCase() }).format(
    Number(cents || 0) / 100
  );
}

/**
 * The Fixter this tip claims to be for, re-validated here. Metadata is not
 * evidence: the employee could have been edited or removed since the session
 * was created. Anything that is not a Fixter or General Fixter resolves to null.
 */
async function loadTipFixter(fixterId) {
  const id = objectIdOrNull(fixterId);
  if (!id) return null;
  const fixter = await User.findById(id).select("_id name email role employeePosition isActive").lean();
  return isEligibleFixter(fixter) ? fixter : null;
}

/**
 * The person who tipped, where we can say so honestly: the account from our
 * own token, else an exact match on the email Stripe collected, and never an
 * account whose email was only typed at checkout
 * (utils/communications/unconfirmedEmailPolicy).
 */
async function loadTipUser(userId, booking, session) {
  const fromToken = objectIdOrNull(userId) || objectIdOrNull(booking?.user);
  if (fromToken) {
    const user = await User.findById(fromToken).select("_id name email role").lean();
    if (user) return user;
  }
  const email = String(session?.customer_details?.email || session?.customer_email || "")
    .trim()
    .toLowerCase();
  if (!email) return null;
  return User.findOne({ email, role: "customer", $or: [{ emailUnconfirmedAt: null }, { emailVerifiedAt: { $ne: null } }] })
    .select("_id name email role")
    .lean();
}

/** Old-link tip: Fixter and visit from the customer's own history, or a reason to review. */
async function legacyAttribution(user, paidAt) {
  if (!user) {
    return { fixter: null, booking: null, reviewReason: "Old-link tip: the payer's email does not match a Profixter customer account." };
  }
  const paid = new Date(paidAt);
  const visits = await Booking.find({
    user: user._id,
    status: { $regex: /^completed$/i },
    completedAt: { $gte: new Date(paid.getTime() - VISIT_LOOKBACK_MS), $lte: paid },
  })
    .select("_id bookingNumber name email user status completedAt assignedFixterId")
    .lean();
  const ids = [...new Set(visits.map((visit) => String(visit.assignedFixterId || "")).filter(Boolean))];
  const fixters = ids.length
    ? await User.find({ _id: { $in: ids } }).select("_id name email role employeePosition isActive").lean()
    : [];
  return attributionFromVisitHistory({
    visits,
    fixtersById: new Map(fixters.map((fixter) => [String(fixter._id), fixter])),
    paidAt: paid,
  });
}

/** Tell the Fixter. Uses their own account email; no address is written here. */
async function notifyFixterOfTip(tip, fixter) {
  if (!fixter?.email) return;
  try {
    const mail = require("./emailService");
    await mail.sendTx(
      "fixter_tip_received",
      fixter.email,
      {
        name: String(fixter.name || "").split(/\s+/)[0] || "there",
        amount: formatMoney(tip.amountCents, tip.currency),
        tipperName: tip.tipperName || "",
        bookingNumber: tip.bookingNumberSnapshot || "",
        receivedAt: tip.receivedAt,
      },
      {
        bccAdmin: false,
        logContext: {
          userId: fixter._id,
          recipientName: fixter.name || "",
          recipientEmail: fixter.email,
          customerName: tip.tipperName || "",
          customerEmail: tip.tipperEmail || "",
          emailType: "transactional",
          source: "stripeWebhookFixterTip",
        },
      }
    );
    await Tip.updateOne({ _id: tip._id }, { $set: { notificationSentAt: new Date() } });
  } catch (error) {
    console.error("fixter_tip_received email failed:", error.message);
  }
}

/**
 * Record one paid tip Checkout Session.
 *
 * options:
 *   eventId     Stripe event id, kept for audit (webhook only).
 *   paidAt      when the customer paid (Date). Webhook: event time; reconcile
 *               and repair: the charge time.
 *   recordedBy  "webhook" | "reconcile" | "repair".
 *   notify      send the Fixter their "tip received" email (webhook only).
 *   charge      the Stripe charge, when the caller has it: its refunds and
 *               dispute are applied to a newly written record by the existing
 *               rules (refunds reduce, disputes are flagged, nothing deleted).
 *
 * Returns { tipId, created, duplicate, attributed } or null when the session
 * is not a recordable paid tip.
 */
async function recordTipFromSession(session, { eventId = "", paidAt = null, recordedBy = "webhook", notify = false, charge = null } = {}) {
  const paymentIntentId = stripeId(session?.payment_intent);
  const legacy = isLegacyTipPaymentLinkSession(session) && !isFixterTipCheckoutSession(session);

  if (!isFixterTipCheckoutSession(session) && !legacy) return null;
  if (!paymentIntentId) {
    log("error", "fixter_tip_missing_payment_intent", { stripeSessionId: session?.id });
    return null;
  }
  if (String(session.payment_status || "").toLowerCase() !== "paid") {
    log("warn", "fixter_tip_not_paid", { stripeSessionId: session.id, paymentStatus: session.payment_status || null });
    return null;
  }

  const existing = await Tip.findOne({ stripePaymentIntentId: paymentIntentId }).lean();
  if (existing) {
    log("info", "fixter_tip_duplicate_event", { stripeSessionId: session.id, tipId: String(existing._id), recordedBy });
    return { tipId: String(existing._id), created: false, duplicate: true, attributed: !!existing.fixter };
  }

  const planned = await planTipRecord(session, { eventId, paidAt, recordedBy, charge });
  const { record, fixter } = planned;

  let tip;
  try {
    tip = await Tip.create(record);
  } catch (error) {
    if (error?.code === 11000) {
      const winner = await Tip.findOne({ stripePaymentIntentId: paymentIntentId }).lean();
      log("info", "fixter_tip_concurrent_duplicate", { stripeSessionId: session.id, tipId: winner ? String(winner._id) : null, recordedBy });
      return winner ? { tipId: String(winner._id), created: false, duplicate: true, attributed: !!winner.fixter } : null;
    }
    throw error;
  }

  log("info", "fixter_tip_recorded", {
    stripeSessionId: session.id,
    tipId: String(tip._id),
    amountCents: tip.amountCents,
    attributed: !!tip.fixter,
    assignmentStatus: tip.assignmentStatus,
    source: tip.source,
    recordedBy,
    needsReview: tip.needsReview,
  });

  if (notify) await notifyFixterOfTip(tip, fixter);
  return { tipId: String(tip._id), created: true, duplicate: false, attributed: !!tip.fixter };
}

/**
 * The Tip record a paid tip session would produce, without writing it. The
 * repair dry run shows exactly this; recordTipFromSession writes exactly this.
 */
async function planTipRecord(session, { eventId = "", paidAt = null, recordedBy = "webhook", charge = null } = {}) {
  const metadata = session?.metadata || {};
  const legacy = isLegacyTipPaymentLinkSession(session) && !isFixterTipCheckoutSession(session);
  const when = paidAt instanceof Date && !Number.isNaN(paidAt.getTime()) ? paidAt : new Date();
  let fixter = null;
  let booking = null;
  let user = null;
  let reviewReason = "";

  if (legacy) {
    user = await loadTipUser("", null, session);
    const found = await legacyAttribution(user, when);
    fixter = found.fixter;
    booking = found.booking;
    reviewReason = found.reviewReason;
  } else {
    fixter = await loadTipFixter(metadata.fixterId);
    const bookingId = objectIdOrNull(metadata.bookingId);
    booking = bookingId ? await Booking.findById(bookingId).select("_id bookingNumber name email user").lean() : null;
    user = await loadTipUser(metadata.userId, booking, session);
  }

  const record = tipRecordFromCheckoutSession(session, { fixter, booking, user, eventId, paidAt: when, recordedBy, reviewReason });
  if (charge) {
    applyRefundToTip(record, charge);
    if (charge.disputed || charge.dispute) {
      record.disputeStatus = String(charge.dispute?.status || "open");
      record.needsReview = true;
      record.reviewReason = record.reviewReason || "This tip has a card dispute in Stripe.";
    }
  }

  return { record, fixter, booking, user };
}

module.exports = { recordTipFromSession, planTipRecord, loadTipFixter, loadTipUser, legacyAttribution, notifyFixterOfTip };
