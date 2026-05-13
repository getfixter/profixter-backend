// backend/models/Otp.js
const mongoose = require("mongoose");

const otpSchema = new mongoose.Schema({
  email: { type: String, required: true, index: true, lowercase: true, trim: true },

  // Store ONLY the bcrypt hash of the OTP
  hash: { type: String, required: true },

  // TTL: MongoDB will delete the doc ~5 minutes after creation
  createdAt: { type: Date, default: Date.now, expires: 300 }, // 300s = 5min
});

module.exports = mongoose.model("Otp", otpSchema);
