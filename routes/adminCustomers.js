const express = require("express");
const mongoose = require("mongoose");

const auth = require("../middleware/auth");
const { PERMISSIONS, requirePermission, requireAnyPermission } = require("../middleware/authorize");
const User = require("../models/User");
const { createAdminActivityLog } = require("../utils/adminActivityLog");
const { CustomerAccessError, createCustomerByAdmin, resendAccess } = require("../utils/admin/customerAccess");
const {
  CommunicationControlError,
  communicationState,
  setCommunicationPreference,
} = require("../utils/admin/communicationControls");

/**
 * Admin: create a customer by phone, resend their sign-in details, and see or
 * change what they are sent. Mounted under /api/admin by routes/admin.js.
 *
 * Customer accounts only: the owner and staff are never targets here.
 */
const router = express.Router();
const customersManage = requirePermission(PERMISSIONS.CUSTOMERS_MANAGE);
const customersOrMembers = requireAnyPermission(PERMISSIONS.CUSTOMERS_MANAGE, PERMISSIONS.MEMBERS_READ);

const ADMIN_EMAIL = () => String(process.env.MAIL_ADMIN || "getfixter@gmail.com").toLowerCase();
const isStaff = (user) =>
  String(user?.email || "").toLowerCase() === ADMIN_EMAIL() || user?.role === "admin" || user?.role === "employee" || Boolean(user?.employeePosition);

function actingAdmin(req) {
  const a = req.accessUser || req.authUser || {};
  return { _id: a._id || req.user?.id || null, name: a.name || "", email: a.email || "" };
}

async function loadCustomer(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(400).json({ message: "Invalid user id" });
    return null;
  }
  const user = await User.findById(req.params.id).select("name email phone role employeePosition").lean();
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

function sendError(res, error, fallback) {
  if (error instanceof CustomerAccessError || error instanceof CommunicationControlError) {
    return res.status(error.status).json({ message: error.message, code: error.code, ...(error.extra || {}) });
  }
  console.error(fallback, error);
  return res.status(500).json({ message: "Something went wrong. Nothing was sent." });
}

function customerSummary(user) {
  return {
    _id: String(user._id),
    userId: user.userId,
    name: user.name || "",
    firstName: user.firstName || "",
    lastName: user.lastName || "",
    email: user.email || "",
    phone: user.phone || "",
    addresses: (user.addresses || []).map((a) => ({
      _id: String(a._id),
      label: a.label || "",
      line1: a.line1,
      city: a.city,
      state: a.state,
      zip: a.zip,
      county: a.county || "",
    })),
    defaultAddressId: user.defaultAddressId ? String(user.defaultAddressId) : null,
    createdAt: user.createdAt,
    signupMethod: user.signupMethod || null,
  };
}

/* Create a customer account. */
router.post("/customers", auth, ...customersManage, async (req, res) => {
  try {
    const admin = actingAdmin(req);
    const result = await createCustomerByAdmin({ body: req.body || {}, admin, req });
    await createAdminActivityLog(req, {
      action: "Customer Account Created",
      entityType: "user",
      entityId: result.user._id,
      entityName: result.user.name,
      details: {
        userId: result.user.userId,
        addresses: result.user.addresses.length,
        temporaryPasswordExpiresAt: result.expiresAt,
        delivery: result.delivery,
        communicationDefaults: req.body?.communication || "all_on",
        sharedPhoneConfirmed: req.body?.allowSharedPhone === true,
      },
    }).catch((error) => console.error("activity log failed:", error.message));
    return res.status(201).json({
      customer: customerSummary(result.user),
      delivery: result.delivery,
      temporaryPasswordExpiresAt: result.expiresAt,
      warnings: result.warnings,
    });
  } catch (error) {
    return sendError(res, error, "POST /admin/customers error:");
  }
});

/* Issue a new temporary password and resend the sign-in email and text. */
router.post("/customers/:id/resend-access", auth, ...customersManage, async (req, res) => {
  try {
    const target = await loadCustomer(req, res);
    if (!target) return undefined;
    const result = await resendAccess({ userId: target._id, admin: actingAdmin(req) });
    await createAdminActivityLog(req, {
      action: "Customer Sign-In Details Resent",
      entityType: "user",
      entityId: target._id,
      entityName: target.name,
      details: { temporaryPasswordExpiresAt: result.expiresAt, delivery: result.delivery },
    }).catch((error) => console.error("activity log failed:", error.message));
    return res.json({ delivery: result.delivery, temporaryPasswordExpiresAt: result.expiresAt });
  } catch (error) {
    return sendError(res, error, "POST /admin/customers/:id/resend-access error:");
  }
});

/* The four switches: service/marketing x email/SMS. */
router.get("/users/:id/communication", auth, ...customersOrMembers, async (req, res) => {
  try {
    const target = await loadCustomer(req, res);
    if (!target) return undefined;
    return res.json(await communicationState(target._id));
  } catch (error) {
    return sendError(res, error, "GET /admin/users/:id/communication error:");
  }
});

/*
 * Change one switch. Takes effect at once; the customer is not told. The
 * change is in the consent history (ledger) and the activity log.
 */
router.put("/users/:id/communication", auth, ...customersManage, async (req, res) => {
  try {
    const target = await loadCustomer(req, res);
    if (!target) return undefined;
    const { key, enabled } = req.body || {};
    const result = await setCommunicationPreference({
      userId: target._id,
      key: String(key || ""),
      enabled,
      admin: actingAdmin(req),
      req,
      note: String(req.body?.note || "").slice(0, 120),
    });
    if (result.changed) {
      await createAdminActivityLog(req, {
        action: "Customer Communication Preference Changed",
        entityType: "user",
        entityId: target._id,
        entityName: target.name,
        details: { setting: key, from: !enabled, to: enabled, source: enabled ? "admin_phone" : "admin_change" },
      }).catch((error) => console.error("activity log failed:", error.message));
    }
    return res.json({ changed: result.changed, state: result.after });
  } catch (error) {
    return sendError(res, error, "PUT /admin/users/:id/communication error:");
  }
});

module.exports = router;
module.exports.customerSummary = customerSummary;
