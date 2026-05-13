const express = require("express");
const router = express.Router();
const RepAttribution = require("../models/RepAttribution");
const { normalizeEmail, normalizePhone } = require("../utils/identity");

function verifyGhlWebhook(req, res, next) {
  const provided = req.headers["x-ghl-secret"];
  const expected = process.env.GHL_WEBHOOK_SECRET;

  if (!expected) {
    console.error("❌ GHL_WEBHOOK_SECRET is not set");
    return res.status(500).json({ message: "Server misconfigured" });
  }

  if (!provided || provided !== expected) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  next();
}

/**
 * POST /api/ghl/lead-assigned
 *
 * This endpoint is called when a cold-call lead is assigned/imported in GHL.
 * It stores rep ownership in your DB as the source of truth.
 */
router.post("/lead-assigned", verifyGhlWebhook, async (req, res) => {
  try {
    const {
      ghlContactId,
      ghlLocationId,
      ghlOpportunityId,
      ghlPipelineId,
      ghlStageId,

      repName,
      repUserId,
      repPhoneNumber,

      firstName,
      lastName,
      fullName,

      email,
      phone,

      campaignName,
      listName,
      city,
      county,
      state,
      tags,
    } = req.body || {};

    console.log("📥 GHL webhook headers:", req.headers);
console.log("📥 GHL webhook body:", req.body);

if (!phone) {
  return res.status(400).json({
    message: "phone is required",
  });
}

    const phoneNormalized = normalizePhone(phone);
    const emailNormalized = normalizeEmail(email);

    if (!phoneNormalized) {
      return res.status(400).json({
        message: "Valid phone is required",
      });
    }

    let existing = null;

    // 1) strongest match = ghlContactId
    if (ghlContactId) {
      existing = await RepAttribution.findOne({
        ghlContactId: String(ghlContactId).trim(),
      });
    }

    // 2) fallback = normalized phone
    if (!existing) {
      existing = await RepAttribution.findOne({
        phoneNormalized,
        status: { $in: ["active", "registered", "subscribed"] },
      }).sort({ assignedAt: -1, createdAt: -1 });
    }

    // 3) fallback = normalized email
    if (!existing && emailNormalized) {
      existing = await RepAttribution.findOne({
        emailNormalized,
        status: { $in: ["active", "registered", "subscribed"] },
      }).sort({ assignedAt: -1, createdAt: -1 });
    }

    const payload = {
repName: repName ? String(repName).trim() : "Unknown Rep",
      repUserId: repUserId ? String(repUserId).trim() : null,
      repPhoneNumber: repPhoneNumber ? String(repPhoneNumber).trim() : null,

      ghlContactId: ghlContactId ? String(ghlContactId).trim() : undefined,
      ghlLocationId: ghlLocationId ? String(ghlLocationId).trim() : undefined,
      ghlOpportunityId: ghlOpportunityId ? String(ghlOpportunityId).trim() : null,
      ghlPipelineId: ghlPipelineId ? String(ghlPipelineId).trim() : null,
      ghlStageId: ghlStageId ? String(ghlStageId).trim() : null,

      firstName: firstName ? String(firstName).trim() : "",
      lastName: lastName ? String(lastName).trim() : "",
      fullName: fullName
        ? String(fullName).trim()
        : [firstName, lastName].filter(Boolean).join(" ").trim(),

      emailRaw: email ? String(email).trim() : "",
      emailNormalized: emailNormalized || null,

      phoneRaw: String(phone).trim(),
      phoneNormalized,

      attributionSource: "cold_call",
      assignmentSource: "ghl",
      campaignName: campaignName ? String(campaignName).trim() : "",
      listName: listName ? String(listName).trim() : "",
      tags: Array.isArray(tags) ? tags.map(String) : [],

      cityAtAssignment: city ? String(city).trim() : "",
      countyAtAssignment: county ? String(county).trim() : "",
      stateAtAssignment: state ? String(state).trim() : "",

      lastSyncedAt: new Date(),
    };

    let doc;

    if (existing) {
      Object.assign(existing, payload);

      if (!existing.assignedAt) existing.assignedAt = new Date();

      doc = await existing.save();

      return res.json({
        ok: true,
        mode: "updated",
        attributionId: doc._id,
        repName: doc.repName,
        phoneNormalized: doc.phoneNormalized,
        emailNormalized: doc.emailNormalized,
        status: doc.status,
        conversionType: doc.conversionType,
      });
    }

    doc = await RepAttribution.create({
      ...payload,
      status: "active",
      conversionType: "none",
      assignedAt: new Date(),
      isPrimary: true,
      commissionRate: 0.5,
      commissionAmount: 0,
      commissionStatus: "unpaid",
    });

    return res.status(201).json({
      ok: true,
      mode: "created",
      attributionId: doc._id,
      repName: doc.repName,
      phoneNormalized: doc.phoneNormalized,
      emailNormalized: doc.emailNormalized,
      status: doc.status,
      conversionType: doc.conversionType,
    });
  } catch (err) {
    console.error("❌ GHL lead-assigned error:", err.stack || err.message);
    return res.status(500).json({
      message: "Failed to store attribution",
      error: err.message,
    });
  }
});

module.exports = router;