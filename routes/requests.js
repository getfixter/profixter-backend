// 📁 routes/requests.js
const express = require("express");
const router = express.Router();
const Request = require("../models/Request");

router.post("/", async (req, res) => {
  try {
    const {
      name, email, password, phone, address,
      city, state, zip, county
    } = req.body;

    const newRequest = new Request({
      name, email, password, phone, address,
      city, state, zip, county,
    });

    await newRequest.save();
    console.log("✅ Address request saved:", newRequest);

    res.status(201).json({ message: "Request received" });
  } catch (err) {
    console.error("❌ Request save error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
