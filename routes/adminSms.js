const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();

const auth = require("../middleware/auth");
const { PERMISSIONS, requirePermission } = require("../middleware/authorize");
const SmsCampaign = require("../models/SmsCampaign");
const SmsMessage = require("../models/SmsMessage");
const SmsOptOut = require("../models/SmsOptOut");
const SmsPhoneStatus = require("../models/SmsPhoneStatus");
const { configSnapshot } = require("../utils/sms/smsConfig");
const { toE164 } = require("../utils/sms/smsPhone");
const { clearUndeliverable } = require("../utils/sms/smsPhoneStatus");
const { SMS_TYPES } = require("../utils/sms/smsTypes");

/**
 * Admin visibility into the SMS system.
 *
 * Shaped to match routes/adminEmailLogs deliberately: the same query
 * parameters, the same pagination envelope, the same permission. Whoever builds
 * the front end gets a screen that behaves like the one next to it, and this
 * stays a log viewer rather than growing into a second CRM.
 *
 * There is no send endpoint here, and there should not be one. Messages are
 * produced by domain events, which is what makes the audit trail meaningful; an
 * admin button that sends arbitrary texts would put messages in the log that no
 * event explains.
 */

const onlyAdmin = requirePermission(PERMISSIONS.ADMIN);

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function asDate(value, endOfDay = false) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  if (endOfDay) date.setHours(23, 59, 59, 999);
  return date;
}

/**
 * The configuration, stated plainly.
 *
 * The first thing anybody will want from this screen while Twilio approval is
 * pending is confirmation that sending is off. It is the first endpoint for
 * that reason, and it reports only whether each credential is present, never
 * any part of its value.
 */
router.get("/config", auth, ...onlyAdmin, async (_req, res) => {
  try {
    const [pendingRetries, optOuts, undeliverable, validPhones] = await Promise.all([
      SmsMessage.countDocuments({ status: "retry_scheduled" }),
      SmsOptOut.countDocuments({}),
      SmsPhoneStatus.countDocuments({ status: "undeliverable" }),
      SmsPhoneStatus.countDocuments({ status: "valid" }),
    ]);
    return res.json({
      config: configSnapshot(),
      pendingRetries,
      optOuts,
      phones: { undeliverable, valid: validPhones },
      types: SMS_TYPES,
    });
  } catch (error) {
    console.error("SMS config read failed:", error);
    return res.status(500).json({ message: "Failed to load SMS configuration" });
  }
});

/** The message log. Filterable the same way the email log is. */
router.get("/messages", auth, ...onlyAdmin, async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 25)));
    const query = {};

    for (const field of [
      "notificationType",
      "channelClass",
      "status",
      "bookingNumber",
      "campaignId",
      "userId",
    ]) {
      if (req.query[field]) query[field] = String(req.query[field]).trim();
    }

    // Accept a phone in any format an operator might paste and normalise it,
    // so searching "(631) 599-1363" finds messages stored as +16315991363.
    if (req.query.phone) {
      query.toPhone = toE164(req.query.phone) || String(req.query.phone).trim();
    }
    if (req.query.user && mongoose.Types.ObjectId.isValid(String(req.query.user))) {
      query.user = new mongoose.Types.ObjectId(String(req.query.user));
    }

    const dateFrom = asDate(req.query.dateFrom);
    const dateTo = asDate(req.query.dateTo, true);
    if (dateFrom || dateTo) {
      query.createdAt = {};
      if (dateFrom) query.createdAt.$gte = dateFrom;
      if (dateTo) query.createdAt.$lte = dateTo;
    }

    const search = String(req.query.search || "").trim();
    if (search) {
      const regex = new RegExp(escapeRegex(search), "i");
      query.$or = [
        { notificationType: regex },
        { recipientName: regex },
        { bookingNumber: regex },
        { body: regex },
        { providerErrorMessage: regex },
        { suppressionReason: regex },
      ];
    }

    const [items, total] = await Promise.all([
      SmsMessage.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      SmsMessage.countDocuments(query),
    ]);

    return res.json({
      items,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (error) {
    console.error("SMS message list failed:", error);
    return res.status(500).json({ message: "Failed to load SMS messages" });
  }
});

router.get("/messages/:id", auth, ...onlyAdmin, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: "Invalid SMS message id" });
    }
    const item = await SmsMessage.findById(req.params.id).lean();
    if (!item) return res.status(404).json({ message: "SMS message not found" });
    return res.json({ item });
  } catch (error) {
    console.error("SMS message detail failed:", error);
    return res.status(500).json({ message: "Failed to load SMS message" });
  }
});

/**
 * Everything sent to one customer, plus their current consent state.
 *
 * This is the endpoint a customer-detail timeline should call: one request
 * answers "what have we texted them, and are they opted out", which is the
 * whole question anybody has when a customer rings up about a message.
 */
router.get("/customers/:userId/history", auth, ...onlyAdmin, async (req, res) => {
  try {
    const rawId = String(req.params.userId || "");
    const match = mongoose.Types.ObjectId.isValid(rawId)
      ? { user: new mongoose.Types.ObjectId(rawId) }
      : { userId: rawId };

    const messages = await SmsMessage.find(match)
      .sort({ createdAt: -1 })
      .limit(Math.min(200, Math.max(1, Number(req.query.limit || 50))))
      .lean();

    const phones = [...new Set(messages.map((m) => m.toPhone).filter(Boolean))];
    const [optOuts, phoneStatuses] = await Promise.all([
      phones.length ? SmsOptOut.find({ phone: { $in: phones } }).lean() : [],
      phones.length ? SmsPhoneStatus.find({ phone: { $in: phones } }).lean() : [],
    ]);

    /*
     * Deliverability alongside consent, in one response.
     *
     * The two answer different halves of the same question an operator has
     * when a customer says they never got a text: did we decide not to send
     * (opt-out), or did we send and the number refused it (deliverability)?
     * A number with no status row has simply never proven itself either way,
     * which is reported as unknown rather than as missing data.
     */
    const deliverability = phones.map((phone) => {
      const row = phoneStatuses.find((s) => s.phone === phone);
      return row
        ? {
            phone,
            status: row.status,
            lastSuccessAt: row.lastSuccessAt,
            lastFailureAt: row.lastFailureAt,
            lastFailureCode: row.lastFailureCode,
            lastFailureReason: row.lastFailureReason,
            undeliverableAt: row.undeliverableAt,
            undeliverableCode: row.undeliverableCode,
            undeliverableReason: row.undeliverableReason,
            successCount: row.successCount,
            failureCount: row.failureCount,
          }
        : { phone, status: "unknown", lastSuccessAt: null, lastFailureAt: null };
    });

    return res.json({ messages, optOuts, deliverability });
  } catch (error) {
    console.error("SMS customer history failed:", error);
    return res.status(500).json({ message: "Failed to load SMS history" });
  }
});

/**
 * Failures worth somebody looking at.
 *
 * A dedicated endpoint rather than a filter, because "are messages failing" is
 * a question that should be one click and not a query somebody has to
 * construct. Repeated silent failure is the specific outcome this exists to
 * prevent.
 */
router.get("/failures", auth, ...onlyAdmin, async (req, res) => {
  try {
    const sinceHours = Math.min(720, Math.max(1, Number(req.query.hours || 24)));
    const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);

    const [items, byReason] = await Promise.all([
      SmsMessage.find({
        status: { $in: ["failed", "undelivered"] },
        createdAt: { $gte: since },
      })
        .sort({ createdAt: -1 })
        .limit(100)
        .lean(),
      SmsMessage.aggregate([
        { $match: { status: { $in: ["failed", "undelivered"] }, createdAt: { $gte: since } } },
        {
          $group: {
            _id: { reason: "$suppressionReason", code: "$providerErrorCode" },
            count: { $sum: 1 },
          },
        },
        { $sort: { count: -1 } },
      ]),
    ]);

    return res.json({ sinceHours, items, byReason });
  } catch (error) {
    console.error("SMS failure list failed:", error);
    return res.status(500).json({ message: "Failed to load SMS failures" });
  }
});

/**
 * Numbers we have stopped texting, and why.
 *
 * Its own endpoint beside the opt-out list rather than mixed into it, because
 * the two mean different things: an opt-out is a person's choice, an
 * undeliverable number is a carrier's verdict. Filterable by status so an
 * operator can also see which numbers are merely unproven.
 */
router.get("/phone-status", auth, ...onlyAdmin, async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 25)));
    const query = {};

    if (req.query.status) query.status = String(req.query.status).trim();
    if (req.query.phone) query.phone = toE164(req.query.phone) || String(req.query.phone).trim();

    const [items, total, counts] = await Promise.all([
      SmsPhoneStatus.find(query)
        .sort({ undeliverableAt: -1, updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      SmsPhoneStatus.countDocuments(query),
      SmsPhoneStatus.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
    ]);

    return res.json({
      items,
      total,
      page,
      limit,
      counts: counts.reduce((acc, row) => ({ ...acc, [row._id]: row.count }), {}),
    });
  } catch (error) {
    console.error("SMS phone status list failed:", error);
    return res.status(500).json({ message: "Failed to load SMS phone statuses" });
  }
});

/**
 * Put a number back into play by hand.
 *
 * The escape hatch for the case automation cannot see: a customer rings to say
 * the text never arrived, somebody checks the number, and it is fine. Resets
 * to unknown rather than valid, because an operator's judgement is not a
 * carrier's confirmation; the next delivered message supplies that.
 */
router.post("/phone-status/:phone/clear", auth, ...onlyAdmin, async (req, res) => {
  try {
    const e164 = toE164(req.params.phone);
    if (!e164) return res.status(400).json({ message: "Invalid phone number" });

    await clearUndeliverable(e164);
    const item = await SmsPhoneStatus.findOne({ phone: e164 }).lean();

    console.log(
      JSON.stringify({
        event: "sms_phone_status_cleared_by_admin",
        by: req.user?.id || "",
      })
    );
    return res.json({ item });
  } catch (error) {
    console.error("SMS phone status clear failed:", error);
    return res.status(500).json({ message: "Failed to clear phone status" });
  }
});

/** Who has opted out, and how. */
router.get("/opt-outs", auth, ...onlyAdmin, async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 25)));
    const query = {};
    if (req.query.scope) query.scope = String(req.query.scope);
    if (req.query.phone) query.phone = toE164(req.query.phone) || String(req.query.phone);

    const [items, total] = await Promise.all([
      SmsOptOut.find(query).sort({ optedOutAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      SmsOptOut.countDocuments(query),
    ]);
    return res.json({ items, total, page, limit });
  } catch (error) {
    console.error("SMS opt-out list failed:", error);
    return res.status(500).json({ message: "Failed to load SMS opt-outs" });
  }
});

/* -------------------------------------------------------------------------- */
/* Campaigns                                                                   */
/* -------------------------------------------------------------------------- */

router.get("/campaigns", auth, ...onlyAdmin, async (_req, res) => {
  try {
    const items = await SmsCampaign.find({}).sort({ createdAt: -1 }).lean();
    return res.json({ items });
  } catch (error) {
    console.error("SMS campaign list failed:", error);
    return res.status(500).json({ message: "Failed to load SMS campaigns" });
  }
});

/**
 * Create or update a campaign.
 *
 * `enabled` is accepted, so an admin can turn a campaign on. It is NOT a way
 * around anything else: the marketing channel switch, consent, opt-out and
 * quiet hours are all enforced downstream and no field here can override them.
 * A campaign switched on while SMS_MARKETING_ENABLED is false simply does
 * nothing.
 */
router.put("/campaigns/:campaignId", auth, ...onlyAdmin, async (req, res) => {
  try {
    const campaignId = String(req.params.campaignId || "").trim();
    if (!campaignId) return res.status(400).json({ message: "campaignId is required" });

    const allowed = [
      "name",
      "category",
      "enabled",
      "audience",
      "templateKey",
      "body",
      "frequency",
      "limits",
      "sendWindow",
      "startsAt",
      "endsAt",
      "notes",
    ];
    const update = {};
    for (const field of allowed) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, field)) {
        update[field] = req.body[field];
      }
    }

    const item = await SmsCampaign.findOneAndUpdate(
      { campaignId },
      { $set: update, $setOnInsert: { campaignId, createdByUserId: req.user?.id || null } },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    ).lean();

    console.log(
      JSON.stringify({
        event: "sms_campaign_updated",
        campaignId,
        enabled: item?.enabled,
        by: req.user?.id || "",
      })
    );
    return res.json({ item });
  } catch (error) {
    console.error("SMS campaign update failed:", error);
    return res.status(500).json({ message: "Failed to save SMS campaign" });
  }
});

module.exports = router;
