// routes/estimates.js
// Public endpoint — no auth required.
// Saves estimate builder submissions to MongoDB and notifies admin by email.
const express = require("express");
const router = express.Router();
const EstimateLead = require("../models/EstimateLead");
const { sendTx } = require("../utils/emailService");

// ── Helpers ───────────────────────────────────────────────────────────────────

function clean(v) {
  return String(v || "").trim();
}

function normalizeEmail(v) {
  return clean(v).toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidPhone(phone) {
  return phone.replace(/\D/g, "").length >= 10;
}

// ── POST /api/estimates ───────────────────────────────────────────────────────

router.post("/", async (req, res) => {
  try {
    const b = req.body;

    // ── Required field validation ──────────────────────────────────────────
    const name    = clean(b.name);
    const phone   = clean(b.phone);
    const email   = normalizeEmail(b.email);
    const address = clean(b.address);
    const service = clean(b.service);

    if (!name || !phone || !email || !address || !service) {
      return res.status(400).json({
        success: false,
        message: "All required fields must be filled.",
      });
    }

    if (!["roofing", "siding", "roofing_siding", "both", "bathroom", "kitchen"].includes(service)) {
      return res.status(400).json({
        success: false,
        message: "Invalid service type.",
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid email address.",
      });
    }

    if (!isValidPhone(phone)) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid phone number (at least 10 digits).",
      });
    }

    // ── Spam guard: reject suspiciously short address ──────────────────────
    if (address.length < 6) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid project address.",
      });
    }

    // ── Build document ─────────────────────────────────────────────────────
    const contactPref = clean(b.contactPref) || "phone";
    const bestTime    = clean(b.bestTime) || "any";
    const sourcePage  = clean(b.sourcePage) || "";
    const notes       = clean(b.notes);
    const timeline    = clean(b.timeline);
    const financing   = clean(b.financing);

    const estimateLow  = typeof b.estimateLow  === "number" ? b.estimateLow  : undefined;
    const estimateHigh = typeof b.estimateHigh === "number" ? b.estimateHigh : undefined;

    const source = clean(b.source) || "estimate_builder";

    const doc = {
      service,
      name,
      phone,
      email,
      address,
      contactPref,
      bestTime:   bestTime   || undefined,
      sourcePage: sourcePage || undefined,
      notes,
      estimateLow,
      estimateHigh,
      timeline:  timeline  || undefined,
      financing: financing || undefined,
      source,
    };

    // Roofing answers
    if (service === "roofing") {
      doc.roofScope     = clean(b.roofScope)     || undefined;
      doc.roofSize      = clean(b.roofSize)      || undefined;
      doc.roofMaterial  = clean(b.roofMaterial)  || undefined;
      doc.roofUrgency   = clean(b.roofUrgency)   || undefined;
      doc.roofInsurance = clean(b.roofInsurance) || undefined;
      doc.roofFinish    = clean(b.roofFinish)    || undefined;
    }

    // Bathroom answers
    if (service === "bathroom") {
      doc.bathroomScope    = clean(b.bathroomScope)    || undefined;
      doc.bathroomSize     = clean(b.bathroomSize)     || undefined;
      doc.bathroomItems    = Array.isArray(b.bathroomItems) ? b.bathroomItems : [];
      doc.bathroomFinish   = clean(b.bathroomFinish)   || undefined;
      doc.bathroomPlumbing = clean(b.bathroomPlumbing) || undefined;
    }

    // Kitchen answers
    if (service === "kitchen") {
      doc.kitchenScope    = clean(b.kitchenScope)    || undefined;
      doc.kitchenSize     = clean(b.kitchenSize)     || undefined;
      doc.kitchenItems    = Array.isArray(b.kitchenItems) ? b.kitchenItems : [];
      doc.kitchenFinish   = clean(b.kitchenFinish)   || undefined;
      doc.kitchenLayout   = clean(b.kitchenLayout)   || undefined;
      doc.kitchenPlumbing = clean(b.kitchenPlumbing) || undefined;
    }

    const lead = new EstimateLead(doc);
    await lead.save();

    console.log("✅ EstimateLead saved:", {
      id: lead._id,
      service,
      name,
      email,
    });

    // ── Admin notification email ───────────────────────────────────────────
    const adminTo =
      source === "exterior_landing"
        ? "premiumislandconstruction@gmail.com"
        : process.env.MAIL_ADMIN || "getfixter@gmail.com";
    try {
      await sendTx(
        source === "exterior_landing" ? "exterior_lead_admin" : "estimate_lead_admin",
        adminTo,
        {
          leadId: String(lead._id),
          service,
          name,
          phone,
          email,
          address,
          contactPref,
          bestTime,
          sourcePage,
          notes,
          estimateLow,
          estimateHigh,
          timeline,
          financing,
          source,
        },
        { bccAdmin: false }
      );
      console.log("✅ Estimate admin email sent to:", adminTo);
    } catch (emailErr) {
      // Never let email failure kill the lead save response
      console.error("⚠️ Estimate admin email failed (lead was saved):", emailErr.message);
    }

    return res.status(201).json({ success: true, message: "Estimate received" });
  } catch (err) {
    console.error("❌ EstimateLead save error:", err.message);
    return res.status(500).json({
      success: false,
      message: "Server error. Please call us directly at 631-599-1363.",
    });
  }
});

module.exports = router;
