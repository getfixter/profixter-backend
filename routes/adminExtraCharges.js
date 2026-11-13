/**
 * Charge extra on a booking (owner only, enforced here and again in the service).
 * Mounted under /api/admin.
 *
 *   GET  /jobs/:id/extra-charges                       the extras, reconciled with Stripe
 *   POST /jobs/:id/extra-charges/preview               who pays, card, tax, total (nothing saved)
 *   POST /jobs/:id/extra-charges                       confirm: card charge or payment link
 *   POST /jobs/:id/extra-charges/:chargeId/refresh     ask Stripe now
 *   POST /jobs/:id/extra-charges/:chargeId/retry-card  try the saved card again (owner's press only)
 *   POST /jobs/:id/extra-charges/:chargeId/payment-link   send or copy a link for the same charge
 *   POST /jobs/:id/extra-charges/:chargeId/close       close an unpaid charge
 *
 * The browser never sends a customer, Stripe customer or payment method id:
 * the server resolves them from the booking every time. Idempotency keys
 * travel in the body (the CORS allow-list has no Idempotency-Key header).
 */
const express = require("express");
const auth = require("../middleware/auth");
const { PERMISSIONS, requirePermission } = require("../middleware/authorize");
const { createAdminActivityLog } = require("../utils/adminActivityLog");
const { IdempotencyError, readIdempotencyKey, runIdempotent } = require("../utils/adminIdempotency");
const extras = require("../utils/extraCharges");

const router = express.Router();
const ownerOnly = [
  ...requirePermission(PERMISSIONS.ADMIN),
  (req, res, next) => (req.accessRole === "admin" ? next() : res.status(403).json({ code: "OWNER_ONLY", message: "Only the owner can charge extras." })),
];

function sendError(res, error, where) {
  if (error instanceof extras.ExtraChargeError || error instanceof IdempotencyError) {
    return res.status(error.statusCode || 400).json({ code: error.code, message: error.message, ...(error.extra || {}) });
  }
  console.error(`${where} error:`, error);
  return res.status(500).json({ code: "SERVER_ERROR", message: "Something went wrong. If a charge was started, its status is checked with Stripe when you reopen the job." });
}

async function log(req, action, record, details = {}) {
  await createAdminActivityLog(req, {
    action,
    entityType: "booking",
    entityId: record.booking,
    entityName: `#${record.bookingNumber} ${record.number}`,
    details: {
      additionalChargeId: String(record._id),
      number: record.number,
      status: record.status,
      totalCents: record.totalCents,
      subtotalCents: record.subtotalCents,
      taxCents: record.taxCents,
      method: record.method,
      ...details,
    },
  }).catch((error) => console.error("activity log failed:", error.message));
}

router.get("/jobs/:id/extra-charges", auth, ...ownerOnly, async (req, res) => {
  try {
    const records = await extras.listForBooking(req.params.id);
    return res.json({ charges: records.map(extras.serialize) });
  } catch (error) {
    return sendError(res, error, "GET extra-charges");
  }
});

router.post("/jobs/:id/extra-charges/preview", auth, ...ownerOnly, async (req, res) => {
  try {
    return res.json({ preview: await extras.preview(req.params.id, req.body || {}) });
  } catch (error) {
    return sendError(res, error, "POST extra-charges/preview");
  }
});

router.post("/jobs/:id/extra-charges", auth, ...ownerOnly, async (req, res) => {
  try {
    const { record, payUrl, delivery, replayed } = await extras.create(req, req.params.id, req.body || {});
    if (!replayed) {
      await log(req, record.method === "card" ? "Extra Charged (Saved Card)" : "Extra Charge Payment Link Created", record, {
        consent: { statement: record.consent.statement, confirmedAt: record.consent.confirmedAt, writtenApprovalRef: record.consent.writtenApprovalRef },
        card: record.card?.last4 ? `${record.card.brand} •••• ${record.card.last4}` : "",
        taxBasis: record.tax?.basis?.document ? { document: record.tax.basis.document, reference: record.tax.basis.reference } : null,
        paymentIntentId: record.paymentIntentId || "",
        delivery: delivery || null,
      });
    }
    return res.status(replayed ? 200 : 201).json({ charge: extras.serialize(record), replayed: Boolean(replayed), ...(payUrl ? { payUrl } : {}), ...(delivery ? { delivery } : {}) });
  } catch (error) {
    return sendError(res, error, "POST extra-charges");
  }
});

router.post("/jobs/:id/extra-charges/:chargeId/refresh", auth, ...ownerOnly, async (req, res) => {
  try {
    const records = await extras.listForBooking(req.params.id, { sync: false });
    const record = records.find((r) => String(r._id) === String(req.params.chargeId));
    if (!record) return res.status(404).json({ code: "NOT_FOUND", message: "Charge not found" });
    const AdditionalCharge = require("../models/AdditionalCharge");
    await extras.reconcile(await AdditionalCharge.findById(record._id), { force: true });
    const fresh = (await extras.listForBooking(req.params.id, { sync: false })).find((r) => String(r._id) === String(record._id));
    return res.json({ charge: extras.serialize(fresh) });
  } catch (error) {
    return sendError(res, error, "POST extra-charges/refresh");
  }
});

router.post("/jobs/:id/extra-charges/:chargeId/retry-card", auth, ...ownerOnly, async (req, res) => {
  try {
    const key = readIdempotencyKey(req.body?.idempotencyKey);
    const result = await runIdempotent({ req, action: "extra_charge.retry_card", key, entityId: req.params.chargeId }, async () => {
      const record = await extras.retryCard(req, req.params.id, req.params.chargeId, req.body || {});
      await log(req, "Extra Charge Retried (Saved Card)", record, { card: record.card?.last4 ? `${record.card.brand} •••• ${record.card.last4}` : "" });
      return { httpStatus: 200, body: { charge: extras.serialize(record) } };
    });
    return res.status(result.httpStatus).json(result.body);
  } catch (error) {
    return sendError(res, error, "POST extra-charges/retry-card");
  }
});

router.post("/jobs/:id/extra-charges/:chargeId/payment-link", auth, ...ownerOnly, async (req, res) => {
  try {
    const key = readIdempotencyKey(req.body?.idempotencyKey);
    const result = await runIdempotent(
      { req, action: "extra_charge.payment_link", key, entityId: req.params.chargeId, storeBody: (b) => ({ ...b, payUrl: undefined, payUrlShownOnce: true }) },
      async () => {
        const { record, payUrl, delivery } = await extras.paymentLink(req, req.params.id, req.params.chargeId, req.body || {});
        await log(req, req.body?.send === true ? "Extra Charge Payment Link Sent" : "Extra Charge Payment Link Copied", record, { delivery: delivery || null });
        return { httpStatus: 200, body: { charge: extras.serialize(record), payUrl, delivery: delivery || null } };
      }
    );
    return res.status(result.httpStatus).json(result.body);
  } catch (error) {
    return sendError(res, error, "POST extra-charges/payment-link");
  }
});

router.post("/jobs/:id/extra-charges/:chargeId/close", auth, ...ownerOnly, async (req, res) => {
  try {
    const record = await extras.cancelCharge(req, req.params.id, req.params.chargeId);
    await log(req, "Extra Charge Closed Unpaid", record);
    return res.json({ charge: extras.serialize(record) });
  } catch (error) {
    return sendError(res, error, "POST extra-charges/close");
  }
});

module.exports = router;
