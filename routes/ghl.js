const express = require("express");
const router = express.Router();
const RepAttribution = require("../models/RepAttribution");
const crypto = require("crypto");
const { normalizeEmail, normalizePhone } = require("../utils/identity");

function secretsMatch(provided, expected) {
  const a = Buffer.from(provided);
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyGhlWebhook(req, res, next) {
  const provided = req.headers["x-ghl-secret"];
  const expected = process.env.GHL_WEBHOOK_SECRET;

  if (!expected) {
    console.error("❌ GHL_WEBHOOK_SECRET is not set");
    return res.status(500).json({ message: "Server misconfigured" });
  }

  if (!provided || !secretsMatch(String(provided), expected)) {
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

    // Never log req.headers (it carries x-ghl-secret) or req.body (contact
    // PII). Ids and presence flags are enough to trace a delivery.
    console.log("📥 GHL lead-assigned:", {
      ghlContactId: ghlContactId ? String(ghlContactId) : null,
      hasPhone: Boolean(phone),
      hasEmail: Boolean(email),
      rep: repName ? String(repName) : null,
    });

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

/**
 * POST /api/ghl/inbound-message
 *
 * A homeowner replied in GoHighLevel (SMS or email). Called by a GHL workflow
 * ("Customer Replied" -> Webhook, header x-ghl-secret) or a Marketplace app's
 * InboundMessage webhook - both payload shapes are accepted. The message goes
 * into the Conversation agent's thread; the agent's reply, if any, is only a
 * PROPOSAL for the growth engine. Inert unless CONVERSATIONS_ENABLED is
 * "true". Answers 200 quickly; the decision runs after the response.
 */
router.post("/inbound-message", verifyGhlWebhook, async (req, res) => {
  if (process.env.CONVERSATIONS_ENABLED !== "true") return res.status(202).json({ accepted: false, reason: "conversations_disabled" });
  try {
    const b = req.body || {};
    const msg = typeof b.message === "object" && b.message ? b.message : {};
    const direction = String(b.direction || msg.direction || "inbound").toLowerCase();
    const conversationId = String(b.conversationId || b.conversation_id || msg.conversationId || "") || null;
    const contactId = String(b.contactId || b.contact_id || "") || null;
    if (!contactId || !conversationId) return res.status(400).json({ message: "contactId and conversationId are required" });
    const { ingestInbound, ingestOutbound, processThread } = require("../utils/conversation/service");
    const tags = String(b.tags || "").toLowerCase();
    if (direction !== "inbound") {
      await ingestOutbound({ conversationId, body: b.body || msg.body, at: b.dateAdded, messageId: b.messageId || msg.id });
      return res.json({ ok: true });
    }
    const thread = await ingestInbound({
      conversationId,
      contactId,
      channel: b.messageType || msg.type || b.type,
      body: b.body || msg.body || "",
      at: b.dateAdded || msg.dateAdded,
      messageId: b.messageId || msg.id || null,
      firstName: b.first_name || b.firstName || "",
      town: b.city || "",
      zip: b.postal_code || b.postalCode || "",
      origin: tags.includes("cold_prospects_2026") ? "cold_outreach_reply" : "inbound",
    });
    res.json({ ok: true });
    processThread(thread).catch((error) => console.warn("Conversation decision failed:", error.message));
  } catch (error) {
    console.error("GHL inbound-message failed:", error.message);
    if (!res.headersSent) res.status(500).json({ message: "Could not record that message" });
  }
});

module.exports = router;