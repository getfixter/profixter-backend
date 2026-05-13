// 📁 backend/routes/requests.js
const express = require("express");
const router = express.Router();
const Request = require("../models/Request");
const { sendTx } = require("../utils/emailService");

function clean(v) {
  return String(v || "").trim();
}

function normalizeEmail(v) {
  return clean(v).toLowerCase();
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

    const adminTo =
      process.env.MAIL_ADMIN ||
      process.env.MAIL_REPLY_TO ||
      "getfixter@gmail.com";

    await sendTx(
      "service_request_admin",
      adminTo,
      {
        name,
        email,
        phone,
        message,
        serviceType,
        sourcePage,
        requestId: String(newRequest._id),
      },
      { bccAdmin: false }
    );

    console.log("✅ Public service request email sent to admin:", {
      requestId: newRequest._id,
      adminTo,
    });

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