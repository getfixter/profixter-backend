/**
 * Charge customer (Owner and General Fixter only - utils/extraCharges/access.js -
 * enforced here and again in the service; a field Fixter gets 403 on every route).
 * Mounted under /api/admin. Two entry points, the same flow and protections:
 *
 *   from a booking (who pays = the booking's stored owner)
 *     GET  /jobs/:id/extra-charges                          the booking's charges, reconciled with Stripe
 *     GET  /jobs/:id/extra-charges/target                   who pays: customer, saved card (nothing saved)
 *     POST /jobs/:id/extra-charges                          "Charge $X" (card) or payment link
 *     POST /jobs/:id/extra-charges/:chargeId/refresh|retry-card|payment-link|close
 *
 *   from the customer profile, no booking (who pays = that profile's stored account)
 *     GET  /customers/:id/charges                           ALL the customer's charges (booking and direct)
 *     GET  /customers/:id/charges/target
 *     POST /customers/:id/charges                           a direct charge: no booking is required or made
 *     POST /customers/:id/charges/:chargeId/refresh|retry-card|payment-link|close
 *
 * The browser never sends a customer, Stripe customer or payment method id:
 * the server resolves them from the stored ids every time. A charge id is
 * accepted only under its own job, or its own customer. Idempotency keys
 * travel in the body (the CORS allow-list has no Idempotency-Key header).
 */
const express = require("express");
const auth = require("../middleware/auth");
const { loadAccessUser } = require("../middleware/authorize");
const { createAdminActivityLog } = require("../utils/adminActivityLog");
const { IdempotencyError, readIdempotencyKey, runIdempotent } = require("../utils/adminIdempotency");
const extras = require("../utils/extraCharges");
const AdditionalCharge = require("../models/AdditionalCharge");
const { DENIED, canChargeCustomers } = require("../utils/extraCharges/access");

const router = express.Router();
/* Who may charge: the Owner or a General Fixter. Nothing else is granted by this. */
const chargers = [loadAccessUser, (req, res, next) => (canChargeCustomers(req) ? next() : res.status(403).json(DENIED))];

function sendError(res, error, where) {
  if (error instanceof extras.ExtraChargeError || error instanceof IdempotencyError) {
    return res.status(error.statusCode || 400).json({ code: error.code, message: error.message, ...(error.extra || {}) });
  }
  console.error(`${where} error:`, error);
  return res.status(500).json({ code: "SERVER_ERROR", message: "Something went wrong. If a charge was started, its status is checked with Stripe when you reopen it." });
}

async function log(req, action, record, details = {}) {
  const direct = !record.booking;
  await createAdminActivityLog(req, {
    action,
    entityType: direct ? "user" : "booking",
    entityId: direct ? record.user : record.booking,
    entityName: direct ? `${record.customerName || "Customer"} ${record.number} (direct charge)` : `#${record.bookingNumber} ${record.number}`,
    details: {
      additionalChargeId: String(record._id),
      number: record.number,
      scope: direct ? "direct" : "booking",
      userId: record.user ? String(record.user) : "",
      status: record.status,
      totalCents: record.totalCents,
      taxStatus: record.tax?.status || "not_calculated",
      method: record.method,
      ...details,
    },
  }).catch((error) => console.error("activity log failed:", error.message));
}

/*
 * One set of handlers for both entry points. `entry` says how the URL's :id
 * is read: as the job, or as the customer. Everything else is shared.
 */
const ENTRIES = [
  {
    base: "/jobs/:id/extra-charges",
    where: (req) => ({ bookingId: req.params.id }),
    list: (req) => extras.listForBooking(req.params.id),
    target: (req) => extras.targetFor(req.params.id),
    create: (req) => extras.create(req, req.params.id, req.body || {}),
  },
  {
    base: "/customers/:id/charges",
    where: (req) => ({ customerId: req.params.id }),
    list: (req) => extras.listForCustomer(req.params.id),
    target: (req) => extras.targetForCustomer(req.params.id),
    create: (req) => extras.createDirect(req, req.params.id, req.body || {}),
  },
];

async function serializedById(id) {
  const fresh = await AdditionalCharge.findById(id).populate("paymentLink", "status expiresAt sentVia delivery createdAt").lean();
  return extras.serialize(fresh);
}

for (const entry of ENTRIES) {
  router.get(entry.base, auth, ...chargers, async (req, res) => {
    try {
      const records = await entry.list(req);
      return res.json({ charges: records.map(extras.serialize) });
    } catch (error) {
      return sendError(res, error, `GET ${entry.base}`);
    }
  });

  router.get(`${entry.base}/target`, auth, ...chargers, async (req, res) => {
    try {
      return res.json({ target: await entry.target(req) });
    } catch (error) {
      return sendError(res, error, `GET ${entry.base}/target`);
    }
  });

  router.post(entry.base, auth, ...chargers, async (req, res) => {
    try {
      const { record, payUrl, delivery, replayed } = await entry.create(req);
      if (!replayed) {
        await log(req, record.method === "card" ? (record.booking ? "Extra Charged (Saved Card)" : "Direct Charge (Saved Card)") : record.booking ? "Extra Charge Payment Link Created" : "Direct Charge Payment Link Created", record, {
          consent: { statement: record.consent.statement, confirmedAt: record.consent.confirmedAt },
          note: record.description || "",
          card: record.card?.last4 ? `${record.card.brand} •••• ${record.card.last4}` : "",
          paymentIntentId: record.paymentIntentId || "",
          delivery: delivery || null,
        });
      }
      return res.status(replayed ? 200 : 201).json({ charge: extras.serialize(record), replayed: Boolean(replayed), ...(payUrl ? { payUrl } : {}), ...(delivery ? { delivery } : {}) });
    } catch (error) {
      return sendError(res, error, `POST ${entry.base}`);
    }
  });

  router.post(`${entry.base}/:chargeId/refresh`, auth, ...chargers, async (req, res) => {
    try {
      const record = await extras.loadRecord(entry.where(req), req.params.chargeId);
      await extras.reconcile(record, { force: true });
      return res.json({ charge: await serializedById(record._id) });
    } catch (error) {
      return sendError(res, error, `POST ${entry.base}/refresh`);
    }
  });

  router.post(`${entry.base}/:chargeId/retry-card`, auth, ...chargers, async (req, res) => {
    try {
      const key = readIdempotencyKey(req.body?.idempotencyKey);
      const result = await runIdempotent({ req, action: "extra_charge.retry_card", key, entityId: req.params.chargeId }, async () => {
        const record = await extras.retryCard(req, entry.where(req), req.params.chargeId, req.body || {});
        await log(req, "Extra Charge Retried (Saved Card)", record, { card: record.card?.last4 ? `${record.card.brand} •••• ${record.card.last4}` : "" });
        return { httpStatus: 200, body: { charge: extras.serialize(record) } };
      });
      return res.status(result.httpStatus).json(result.body);
    } catch (error) {
      return sendError(res, error, `POST ${entry.base}/retry-card`);
    }
  });

  router.post(`${entry.base}/:chargeId/payment-link`, auth, ...chargers, async (req, res) => {
    try {
      const key = readIdempotencyKey(req.body?.idempotencyKey);
      const result = await runIdempotent(
        { req, action: "extra_charge.payment_link", key, entityId: req.params.chargeId, storeBody: (b) => ({ ...b, payUrl: undefined, payUrlShownOnce: true }) },
        async () => {
          const { record, payUrl, delivery } = await extras.paymentLink(req, entry.where(req), req.params.chargeId, req.body || {});
          await log(req, req.body?.send === true ? "Extra Charge Payment Link Sent" : "Extra Charge Payment Link Copied", record, { delivery: delivery || null });
          return { httpStatus: 200, body: { charge: extras.serialize(record), payUrl, delivery: delivery || null } };
        }
      );
      return res.status(result.httpStatus).json(result.body);
    } catch (error) {
      return sendError(res, error, `POST ${entry.base}/payment-link`);
    }
  });

  router.post(`${entry.base}/:chargeId/close`, auth, ...chargers, async (req, res) => {
    try {
      const record = await extras.cancelCharge(req, entry.where(req), req.params.chargeId);
      await log(req, "Extra Charge Closed Unpaid", record);
      return res.json({ charge: extras.serialize(record) });
    } catch (error) {
      return sendError(res, error, `POST ${entry.base}/close`);
    }
  });
}

module.exports = router;
