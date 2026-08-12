// 📁 backend/routes/requests.js
const express = require("express");
const router = express.Router();
const Request = require("../models/Request");
const {
  sendAdminEventNotification,
  sendAdminLeadNotification,
  formatSubmittedAt,
} = require("../utils/adminLeadNotification");
const { normalizePhoneE164, digitsOnlyPhone } = require("../utils/identity");

function clean(v) {
  return String(v || "").trim();
}

function normalizeEmail(v) {
  return clean(v).toLowerCase();
}

function serviceLabel(serviceType) {
  return (
    {
      address_request: "Address Request",
      on_demand: "On-Demand Service",
      general_contractor: "General Contractor",
      home_improvement: "Home Improvement",
      membership_interest: "Membership / Subscription interest",
    }[serviceType] || serviceType
  );
}

// -----------------------------------------------------------------------------
// OLD endpoint kept for compatibility
// -----------------------------------------------------------------------------
router.post("/", async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      phone,
      address,
      city,
      state,
      zip,
      county,
    } = req.body;

    const newRequest = new Request({
      name: clean(name),
      email: normalizeEmail(email),
      password: clean(password),
      phone: clean(phone),
      address: clean(address),
      city: clean(city),
      state: clean(state),
      zip: clean(zip),
      county: clean(county),
      serviceType: "address_request",
      status: "new",
    });

    await newRequest.save();
    console.log("✅ Address request saved:", newRequest._id);

    try {
      await sendAdminLeadNotification({
        leadId: String(newRequest._id),
        leadType: "Address Request",
        service: serviceLabel(newRequest.serviceType),
        name: newRequest.name,
        phone: newRequest.phone,
        email: newRequest.email,
        address: [
          newRequest.address,
          newRequest.city,
          newRequest.state,
          newRequest.zip,
        ]
          .filter(Boolean)
          .join(", "),
        sourcePage: "/api/requests",
        submittedAt: newRequest.createdAt,
      });
    } catch (emailErr) {
      console.error("⚠️ Address request notification failed; lead was saved:", {
        requestId: newRequest._id,
        message: emailErr.message,
      });
    }

    res.status(201).json({ message: "Request received" });
  } catch (err) {
    console.error("❌ Request save error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

// -----------------------------------------------------------------------------
// NEW public service request endpoint
// -----------------------------------------------------------------------------
router.post("/public", async (req, res) => {
  try {
    const name = clean(req.body.name);
    const email = normalizeEmail(req.body.email);
    const phone = clean(req.body.phone);
    const message = clean(req.body.message);
    const serviceType = clean(req.body.serviceType);
    const sourcePage = clean(req.body.sourcePage);

    if (!name || !email || !phone || !message || !serviceType) {
      return res.status(400).json({
        message: "Please fill out all required fields.",
      });
    }

    const allowedServiceTypes = [
      "on_demand",
      "general_contractor",
      "home_improvement",
    ];

    if (!allowedServiceTypes.includes(serviceType)) {
      return res.status(400).json({
        message: "Invalid service type.",
      });
    }

    const newRequest = new Request({
      name,
      email,
      phone,
      message,
      serviceType,
      sourcePage,
      status: "new",
    });

    await newRequest.save();

    console.log("✅ Public service request saved:", {
      id: newRequest._id,
      name,
      email,
      phone,
      serviceType,
      sourcePage,
    });

    try {
      await sendAdminLeadNotification({
        leadId: String(newRequest._id),
        leadType: serviceLabel(serviceType),
        service: serviceLabel(serviceType),
        name,
        email,
        phone,
        message,
        sourcePage,
        submittedAt: newRequest.createdAt,
      });
      console.log("✅ Public service request notification sent:", {
        requestId: newRequest._id,
      });
    } catch (emailErr) {
      console.error(
        "⚠️ Public service request notification failed; lead was saved:",
        {
          requestId: newRequest._id,
          message: emailErr.message,
        }
      );
    }

    return res.status(201).json({
      success: true,
      message: "Request received",
    });
  } catch (err) {
    console.error("❌ Public request save error:", err.message);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

/* -----------------------------------------------------------------------------
 * Membership callback request
 *
 * "This sounds interesting, call me and explain it." A name and a phone number,
 * nothing else. Every field this does not ask for is a field somebody would
 * have abandoned the form over, and we can ask the rest on the call.
 *
 * It is a Request like every other enquiry rather than a new collection, so it
 * appears in the Leads list the admin already works from with no Admin changes
 * beyond the one new serviceType.
 * -------------------------------------------------------------------------- */

/** How long an identical number is treated as the same enquiry. */
const MEMBERSHIP_LEAD_DEDUPE_MS = 10 * 60 * 1000;

router.post("/membership", async (req, res) => {
  try {
    const name = clean(req.body.name).slice(0, 120);
    const rawPhone = clean(req.body.phone);

    /*
     * Validated here and not only in the browser. The endpoint is public, so
     * the form is a convenience rather than a control.
     */
    if (!name) {
      return res.status(400).json({ success: false, message: "Please tell us your name." });
    }
    if (name.length < 2) {
      return res.status(400).json({ success: false, message: "Please enter your full name." });
    }

    const phone = normalizePhoneE164(rawPhone);
    if (!phone) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid US phone number so we can call you.",
      });
    }

    /*
     * A double tap, a retried request or an impatient second submission should
     * not become two leads for one person. The window is short so somebody who
     * genuinely enquires again later still gets through.
     *
     * The key is what makes this hold: three taps arriving together would all
     * pass a read-then-write check, so the unique index on dedupeKey decides
     * instead and the losers come back as duplicates.
     */
    const bucket = Math.floor(Date.now() / MEMBERSHIP_LEAD_DEDUPE_MS);
    const dedupeKey = `membership:${phone}:${bucket}`;

    const newRequest = new Request({
      name,
      phone,
      // Deliberately no email: this form does not ask for one, and inventing a
      // placeholder would put junk in the Leads list.
      email: "",
      message: "Asked us to call and explain ProFixter Membership.",
      serviceType: "membership_interest",
      sourcePage: clean(req.body.sourcePage).slice(0, 200) || "/",
      status: "new",
      dedupeKey,
    });

    try {
      await newRequest.save();
    } catch (saveErr) {
      if (saveErr?.code === 11000) {
        // Somebody else's tap won the race. Same enquiry, one lead.
        return res.status(200).json({
          success: true,
          message: "Request received",
          duplicate: true,
        });
      }
      throw saveErr;
    }

    try {
      await sendAdminEventNotification({
        // Exactly this subject, so it is filterable in the inbox.
        subject: "Subscription Lead!",
        heading: "Subscription Lead!",
        templateKey: "admin_membership_lead",
        customerName: name,
        source: "membershipLeadForm",
        fields: [
          ["Name", name],
          ["Phone", digitsOnlyPhone(phone).replace(/^1(\d{3})(\d{3})(\d{4})$/, "$1-$2-$3") || phone],
          ["Source", "Membership / Home website"],
          ["Submitted", formatSubmittedAt(newRequest.createdAt)],
        ],
      });
    } catch (emailErr) {
      // The lead is already saved. Losing the email must not lose the lead.
      console.error("Membership lead notification failed; lead was saved:", {
        requestId: newRequest._id,
        message: emailErr.message,
      });
    }

    return res.status(201).json({ success: true, message: "Request received" });
  } catch (err) {
    console.error("Membership lead save error:", err.message);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
