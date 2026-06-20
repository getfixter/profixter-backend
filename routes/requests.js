// 📁 backend/routes/requests.js
const express = require("express");
const router = express.Router();
const Request = require("../models/Request");
const {
  sendAdminLeadNotification,
} = require("../utils/adminLeadNotification");

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

module.exports = router;
