const express = require("express");
const mongoose = require("mongoose");

const auth = require("../middleware/auth");
const { PERMISSIONS, requirePermission, requireAnyPermission } = require("../middleware/authorize");
const User = require("../models/User");
const Subscription = require("../models/Subscription");
const { createAdminActivityLog } = require("../utils/adminActivityLog");
const { uploadAppointmentPhotos } = require("../utils/bookingAttachments");
const { PLAN_CATALOG, normalizeBillingCycle } = require("../utils/subscriptionManagement");
const { CLIENT_URL, CheckoutRefusal, membershipSaleBlocker, openMembershipCheckout } = require("../utils/membershipCheckout");
const { createAndSendLink, MEMBERSHIP_LINK_DAYS } = require("../utils/admin/paymentLinks");
const { AdminVisitError, createAdminVisit } = require("../utils/admin/adminVisits");
const { getOneTimeVisitSettings } = require("../utils/oneTimeVisitSettings");
const { getFullDayVisitSettings } = require("../utils/fullDayVisitSettings");

/**
 * Admin sells a membership and creates visits, on the phone with a customer.
 * Mounted under /api/admin by routes/admin.js.
 *
 * PAY BY PHONE is a Stripe-hosted Checkout opened on Admin's own screen, and
 * the card the customer reads out is typed into Stripe's page - never into
 * ours. Nothing card-shaped reaches this server, its logs or its database.
 * (Stripe's MOTO flag needs Stripe to enable it on the account and a
 * publishable key in the app; neither exists today, so the hosted page is the
 * compliant route. A bank's 3-D Secure check, if one appears, goes to the
 * cardholder's phone and they read the code out as usual.)
 *
 * SEND PAYMENT LINK sends profixter.com/pay/<token> by email and/or text
 * (utils/admin/paymentLinks.js, routes/pay.js).
 *
 * Either way the membership is activated by the normal Stripe webhook, and
 * every protection against billing a home twice is the customer's own
 * (utils/membershipCheckout.js).
 */
const router = express.Router();
const customersManage = requirePermission(PERMISSIONS.CUSTOMERS_MANAGE);
const customersOrMembers = requireAnyPermission(PERMISSIONS.CUSTOMERS_MANAGE, PERMISSIONS.MEMBERS_READ);
const bookingsWrite = requirePermission(PERMISSIONS.BOOKINGS_WRITE);

const PLAN_LABELS = { basic: "Basic", plus: "Plus", premium: "Premium", elite: "Elite" };
const ADMIN_EMAIL = () => String(process.env.MAIL_ADMIN || "getfixter@gmail.com").toLowerCase();

function actingAdmin(req) {
  const a = req.accessUser || req.authUser || {};
  return { _id: a._id || req.user?.id || null, name: a.name || "", email: a.email || "" };
}

function isStaff(user) {
  return String(user?.email || "").toLowerCase() === ADMIN_EMAIL() || user?.role === "admin" || user?.role === "employee" || Boolean(user?.employeePosition);
}

async function loadCustomer(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(400).json({ message: "Invalid user id" });
    return null;
  }
  const user = await User.findById(req.params.id);
  if (!user) {
    res.status(404).json({ message: "User not found" });
    return null;
  }
  if (isStaff(user)) {
    res.status(403).json({ message: "Only customer accounts." });
    return null;
  }
  return user;
}

function membershipLabel(plan, cycle) {
  return `your ${PLAN_LABELS[plan] || plan} membership (${cycle === "annual" ? "annual" : "monthly"})`;
}

function readChannels(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(",");
  const set = new Set(list.map((v) => String(v).trim()).filter((v) => v === "email" || v === "sms"));
  return set.size ? [...set] : ["email", "sms"];
}

/* What Admin can sell: plans and prices, and whether paid visits are on. */
router.get("/sales/options", auth, ...customersOrMembers, async (_req, res) => {
  try {
    const [oneTime, fullDay] = await Promise.all([getOneTimeVisitSettings(), getFullDayVisitSettings()]);
    return res.json({
      plans: Object.entries(PLAN_CATALOG).map(([key, plan]) => ({
        key,
        label: PLAN_LABELS[key] || key,
        monthly: plan.monthly.price,
        annual: plan.annual.price,
      })),
      oneTime: { enabled: !!oneTime.enabled && !!oneTime.stripePriceId, priceCents: oneTime.priceCents },
      fullDay: { enabled: !!fullDay.enabled && !!fullDay.stripePriceId, priceCents: fullDay.priceCents },
    });
  } catch (error) {
    console.error("GET /admin/sales/options error:", error);
    return res.status(500).json({ message: "Could not load prices." });
  }
});

/* The customer's homes, and whether each one can be sold a membership right now. */
router.get("/customers/:id/membership-options", auth, ...customersOrMembers, async (req, res) => {
  try {
    const user = await loadCustomer(req, res);
    if (!user) return undefined;
    const homes = [];
    for (const address of user.addresses || []) {
      const live = await Subscription.findOne({
        user: user._id,
        addressId: address._id,
        status: { $in: ["active", "trialing", "past_due", "unpaid"] },
      })
        .select("subscriptionType billingCycle status")
        .lean();
      let blocker = null;
      try {
        blocker = await membershipSaleBlocker({ user, addressId: address._id });
      } catch (error) {
        blocker = { body: { code: "CHECK_FAILED", message: "Could not check with Stripe. Try again." } };
      }
      homes.push({
        addressId: String(address._id),
        label: address.label || "",
        line: [address.line1, address.city, address.state, address.zip].filter(Boolean).join(", "),
        current: live ? { plan: live.subscriptionType, billingCycle: live.billingCycle || "monthly", status: live.status } : null,
        canBuy: !blocker,
        blocked: blocker ? { code: blocker.body?.code || "", message: blocker.body?.message || "" } : null,
      });
    }
    return res.json({ homes, hasEmail: !!user.email, hasPhone: !!user.phone });
  } catch (error) {
    console.error("GET /admin/customers/:id/membership-options error:", error);
    return res.status(500).json({ message: "Could not load this customer's homes." });
  }
});

/*
 * Sell a membership. method "phone" returns the Stripe page to open here;
 * method "link" sends the customer a link and returns where it went.
 */
router.post("/customers/:id/membership-sale", auth, ...customersManage, async (req, res) => {
  try {
    const user = await loadCustomer(req, res);
    if (!user) return undefined;
    const admin = actingAdmin(req);
    const plan = String(req.body?.plan || "").toLowerCase();
    const billingCycle = normalizeBillingCycle(req.body?.billingCycle, "monthly");
    const addressId = String(req.body?.addressId || "");
    const method = req.body?.method === "link" ? "link" : "phone";
    if (!PLAN_CATALOG[plan]) return res.status(400).json({ message: "Choose a plan.", code: "PLAN_REQUIRED" });
    if (!mongoose.isValidObjectId(addressId) || !user.addresses.id(addressId)) {
      return res.status(400).json({ message: "Choose the home.", code: "ADDRESS_REQUIRED" });
    }

    if (method === "phone") {
      const { session, trialEndUnix } = await openMembershipCheckout({
        userId: user._id,
        plan,
        billingCycle,
        addressId,
        successUrl: `${CLIENT_URL}/admin?tab=users&paid=membership`,
        cancelUrl: `${CLIENT_URL}/admin?tab=users`,
        metadata: { adminInitiated: "phone", adminUserId: String(admin._id || "") },
      });
      await createAdminActivityLog(req, {
        action: "Membership Sale Started (Pay by Phone)",
        entityType: "user",
        entityId: user._id,
        entityName: user.name,
        details: { plan, billingCycle, addressId, stripeSessionId: session.id },
      }).catch((error) => console.error("activity log failed:", error.message));
      return res.json({
        method,
        url: session.url,
        billingStartsAt: trialEndUnix ? new Date(trialEndUnix * 1000).toISOString() : null,
      });
    }

    /*
     * A link is only sent for a home that could be sold right now. It asks
     * again when it is opened, so a purchase in between still cannot double up.
     */
    const blocker = await membershipSaleBlocker({ user, addressId });
    if (blocker) return res.status(blocker.status).json(blocker.body);
    const sent = await createAndSendLink({
      kind: "membership",
      contact: { name: user.name, email: user.email, phone: user.phone, user },
      itemLabel: membershipLabel(plan, billingCycle),
      channels: readChannels(req.body?.channels),
      plan,
      billingCycle,
      addressId,
      admin,
    });
    await createAdminActivityLog(req, {
      action: "Payment Link Sent (Membership)",
      entityType: "user",
      entityId: user._id,
      entityName: user.name,
      details: { plan, billingCycle, addressId, linkId: String(sent.link._id), sentVia: sent.link.sentVia, delivery: sent.delivery, expiresAt: sent.link.expiresAt },
    }).catch((error) => console.error("activity log failed:", error.message));
    return res.json({ method, payUrl: sent.payUrl, delivery: sent.delivery, expiresAt: sent.link.expiresAt, linkDays: MEMBERSHIP_LINK_DAYS });
  } catch (error) {
    if (error instanceof CheckoutRefusal) return res.status(error.status).json(error.body);
    console.error("POST /admin/customers/:id/membership-sale error:", error);
    return res.status(500).json({ message: "Could not start the payment. Nothing was charged." });
  }
});

/* Create a visit: multipart, with optional photos in "images". */
router.post("/visits", auth, ...bookingsWrite, uploadAppointmentPhotos, async (req, res) => {
  try {
    const admin = actingAdmin(req);
    const { booking, payment } = await createAdminVisit({ body: req.body || {}, files: req.files || [], admin, clientUrl: CLIENT_URL });
    await createAdminActivityLog(req, {
      action: "Visit Created in Admin",
      entityType: "booking",
      entityId: booking._id,
      entityName: `${booking.name} #${booking.bookingNumber}`,
      details: {
        type: req.body?.type,
        mode: req.body?.mode === "guest" ? "guest" : "existing",
        userId: booking.userId || null,
        date: booking.date,
        photos: (booking.images || []).length,
        payment: payment ? { method: payment.method, delivery: payment.delivery || null, linkId: payment.linkId || null } : "none",
      },
    }).catch((error) => console.error("activity log failed:", error.message));
    return res.status(201).json({
      booking: {
        _id: String(booking._id),
        bookingNumber: booking.bookingNumber,
        date: booking.date,
        service: booking.service,
        status: booking.status,
        accessType: booking.accessType,
        bookingType: booking.bookingType,
        paymentState: booking.paymentState,
        images: booking.images || [],
      },
      payment,
    });
  } catch (error) {
    if (error instanceof AdminVisitError) {
      return res.status(error.status).json({ message: error.message, code: error.code, ...(error.extra || {}) });
    }
    if (error?.statusCode || error?.status) {
      return res.status(error.statusCode || error.status).json({ message: error.message, code: error.code || "" });
    }
    console.error("POST /admin/visits error:", error);
    return res.status(500).json({ message: "Could not create the visit." });
  }
});

module.exports = router;
