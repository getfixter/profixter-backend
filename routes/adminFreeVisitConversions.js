// 📁 backend/routes/adminFreeVisitConversions.js
/*
 * Admin: "Convert to paid visit" for a free visit (utils/freeVisit/conversion.js).
 *
 *   GET  /api/admin/free-visit-conversions/bookings/:bookingId                 offers, account, seven-day rule, links so far
 *   POST /api/admin/free-visit-conversions/bookings/:bookingId                 make the link (nothing is sent; the link is returned once)
 *   POST /api/admin/free-visit-conversions/bookings/:bookingId/:id/send        send it by email and/or text (each once)
 *   POST /api/admin/free-visit-conversions/bookings/:bookingId/:id/cancel      withdraw an unpaid link
 *   POST /api/admin/free-visit-conversions/bookings/:bookingId/:id/retry       a paid one that needs attention, again
 *   POST /api/admin/free-visit-conversions/bookings/:bookingId/:id/close       a paid one that needs attention, settled by hand: { resolution, reason, firstPaymentRefunded? }
 *   GET  /api/admin/free-visit-conversions/bookings/:bookingId/:id/payment     the payment, and the membership it started, as Stripe has them now
 *   POST /api/admin/free-visit-conversions/bookings/:bookingId/:id/resolve     a converted visit canceled afterwards: what was done with its payment
 *
 * Settling checks Stripe and never refunds or cancels anything itself
 * (utils/freeVisit/paymentResolution.js).
 *
 * The Jobs section (bookings.assign), like reviewing a free visit and making
 * paid-visit links. Creating a customer account for a guest also needs the
 * Customers section, as it does everywhere else; so do linking a guest visit to
 * an existing account and adding a home to one. Every action is audited.
 */
const express = require("express");

const router = express.Router();
const auth = require("../middleware/auth");
const { PERMISSIONS, requirePermission } = require("../middleware/authorize");
const { hasPerm } = require("../utils/jobs/jobAccess");
const { createAdminActivityLog } = require("../utils/adminActivityLog");
const conversion = require("../utils/freeVisit/conversion");

/* The same two permissions the job sheet checks before it shows the action (utils/jobs/jobQueries canConvertToPaid). */
const jobsManage = [...requirePermission(PERMISSIONS.BOOKINGS_ASSIGN), ...requirePermission(PERMISSIONS.BOOKINGS_WRITE).slice(1)];

function actingAdmin(req) {
  const a = req.accessUser || req.authUser || {};
  return { _id: a._id || req.user?.id || null, name: a.name || "", email: a.email || "" };
}

function fail(res, error, fallback) {
  if (error instanceof conversion.ConversionError) {
    return res.status(error.status || 409).json({ code: error.code, message: error.message, ...(error.extra || {}) });
  }
  console.error("admin free-visit conversion error:", error);
  return res.status(500).json({ code: "CONVERSION_ERROR", message: fallback });
}

async function audit(req, action, conv, details = {}) {
  await createAdminActivityLog(req, {
    action,
    entityType: "Booking",
    entityId: String(conv.booking),
    entityName: `#${conv.bookingNumber || ""} ${conv.contact?.name || ""}`.trim(),
    details: { conversionId: String(conv._id), kind: conv.kind, plan: conv.plan, billingCycle: conv.billingCycle, ...details },
  }).catch((error) => console.error("conversion activity log failed:", error.message));
}

router.get("/bookings/:bookingId", auth, ...jobsManage, async (req, res) => {
  try {
    return res.json(await conversion.conversionOptions({ bookingId: req.params.bookingId }));
  } catch (error) {
    return fail(res, error, "Could not load the conversion options.");
  }
});

router.post("/bookings/:bookingId", auth, ...jobsManage, async (req, res) => {
  try {
    const body = req.body || {};
    const made = await conversion.createConversion({
      bookingId: req.params.bookingId,
      kind: String(body.kind || ""),
      plan: String(body.plan || ""),
      billingCycle: String(body.billingCycle || ""),
      task: String(body.task || ""),
      account: body.account && typeof body.account === "object" ? body.account : {},
      overrideLeadTimeReason: String(body.overrideLeadTimeReason || ""),
      admin: actingAdmin(req),
      /* Linking a guest visit to an account, creating one, or adding a home to one: the Customers section. */
      canManageAccounts: hasPerm(req, PERMISSIONS.CUSTOMERS_MANAGE),
      req,
    });
    await audit(req, "Free Visit Conversion Link Created", made.conversion, {
      task: made.conversion.task,
      accountSource: made.conversion.accountSource,
      leadTimeRule: made.conversion.leadTime?.rule || "",
      leadTimeOverrideReason: made.conversion.leadTime?.override?.reason || "",
      linkExpiresAt: made.conversion.linkExpiresAt,
    });
    /* The only time the link itself is returned: only its hash is stored. */
    return res.json({ conversion: conversion.presentConversion(made.conversion), payUrl: made.payUrl, token: made.token });
  } catch (error) {
    return fail(res, error, "Could not make the payment link. Nothing was created.");
  }
});

router.post("/bookings/:bookingId/:id/send", auth, ...jobsManage, async (req, res) => {
  try {
    const sent = await conversion.sendConversionLink({
      conversionId: req.params.id,
      bookingId: req.params.bookingId,
      token: String(req.body?.token || ""),
      channels: Array.isArray(req.body?.channels) ? req.body.channels : [],
      admin: actingAdmin(req),
    });
    await audit(req, "Free Visit Conversion Link Sent", sent.conversion, { channels: req.body?.channels, delivery: sent.delivery });
    return res.json({ conversion: conversion.presentConversion(sent.conversion), delivery: sent.delivery });
  } catch (error) {
    return fail(res, error, "Could not send the link.");
  }
});

router.post("/bookings/:bookingId/:id/cancel", auth, ...jobsManage, async (req, res) => {
  try {
    const withdrawn = await conversion.cancelConversion({ conversionId: req.params.id, bookingId: req.params.bookingId, admin: actingAdmin(req), reason: req.body?.reason || "" });
    await audit(req, "Free Visit Conversion Link Withdrawn", withdrawn, { reason: String(req.body?.reason || "").slice(0, 300) });
    return res.json({ conversion: conversion.presentConversion(withdrawn) });
  } catch (error) {
    return fail(res, error, "Could not withdraw the link.");
  }
});

router.post("/bookings/:bookingId/:id/retry", auth, ...jobsManage, async (req, res) => {
  try {
    const after = await conversion.retryConversion({
      conversionId: req.params.id,
      bookingId: req.params.bookingId,
      admin: actingAdmin(req),
      overrideLeadTimeReason: String(req.body?.overrideLeadTimeReason || ""),
      acceptCurrentVisit: req.body?.acceptCurrentVisit === true,
    });
    await audit(req, "Free Visit Conversion Retried", after, { result: after.status, overrideLeadTimeReason: String(req.body?.overrideLeadTimeReason || "").slice(0, 300), acceptCurrentVisit: req.body?.acceptCurrentVisit === true });
    return res.json({ conversion: conversion.presentConversion(after) });
  } catch (error) {
    return fail(res, error, "Could not retry the conversion.");
  }
});

function resolutionArgs(req) {
  const body = req.body || {};
  return {
    resolution: String(body.resolution || ""),
    firstPaymentRefunded: typeof body.firstPaymentRefunded === "boolean" ? body.firstPaymentRefunded : null,
  };
}

router.get("/bookings/:bookingId/:id/payment", auth, ...jobsManage, async (req, res) => {
  try {
    const conv = await conversion.loadConversion(req.params.id, req.params.bookingId);
    const resolution = require("../utils/freeVisit/paymentResolution");
    const facts = await resolution.paymentFacts(conv);
    return res.json({ conversion: conversion.presentConversion(conv), facts, followUp: resolution.openFollowUp(conv) });
  } catch (error) {
    return fail(res, error, "Could not load the payment.");
  }
});

router.post("/bookings/:bookingId/:id/resolve", auth, ...jobsManage, async (req, res) => {
  try {
    const { conversion: resolved, facts } = await require("../utils/freeVisit/paymentResolution").resolvePayment({
      conversionId: req.params.id,
      bookingId: req.params.bookingId,
      admin: actingAdmin(req),
      note: req.body?.reason || "",
      ...resolutionArgs(req),
    });
    await audit(req, "Free Visit Conversion Payment Resolved", resolved, { resolution: resolved.resolution?.kind, for: resolved.resolution?.for, reason: String(req.body?.reason || "").slice(0, 300) });
    return res.json({ conversion: conversion.presentConversion(resolved), facts });
  } catch (error) {
    return fail(res, error, "Could not record the payment decision.");
  }
});

router.post("/bookings/:bookingId/:id/close", auth, ...jobsManage, async (req, res) => {
  try {
    const closed = await conversion.closeConversion({ conversionId: req.params.id, bookingId: req.params.bookingId, admin: actingAdmin(req), reason: req.body?.reason || "", ...resolutionArgs(req) });
    await audit(req, "Free Visit Conversion Closed", closed, { reason: String(req.body?.reason || "").slice(0, 300), resolution: closed.resolution?.kind });
    return res.json({ conversion: conversion.presentConversion(closed) });
  } catch (error) {
    return fail(res, error, "Could not close the conversion.");
  }
});

module.exports = router;
