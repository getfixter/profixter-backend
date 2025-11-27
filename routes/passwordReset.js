// backend/routes/passwordReset.js
const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const Otp = require("../models/Otp");
const User = require("../models/User");
const mail = require("../utils/emailService");

const RESET_SECRET = process.env.JWT_RESET_SECRET;

// ✅ Step 1: Send OTP
router.post("/", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: "Email is required" });

  const cleanEmail = email.toLowerCase().trim();
  const otp = Math.floor(100000 + Math.random() * 900000).toString();

  try {
    // burn any previous codes for this email
    await Otp.deleteMany({ email: cleanEmail });

    // store only a hash
    const hash = await bcrypt.hash(otp, 12);
    await Otp.create({ email: cleanEmail, hash }); // TTL handled by model

    await mail.sendTx("password_otp", cleanEmail, { otp }, { bccAdmin: false });

    res.status(200).json({ message: "OTP sent" });
  } catch (err) {
    console.error("❌ OTP send error:", err);
    res.status(500).json({ message: "Failed to send OTP" });
  }
});

// ✅ Step 2: Verify OTP -> return short-lived reset token
router.post("/verify", async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ message: "Missing input" });

  const cleanEmail = email.toLowerCase().trim();

  try {
    const record = await Otp.findOne({ email: cleanEmail });
    if (!record) return res.status(400).json({ message: "Invalid or expired code" });

    // Extra safety in case TTL monitor hasn't pruned yet
    const maxAgeMs = 5 * 60 * 1000;
    if (Date.now() - record.createdAt.getTime() > maxAgeMs) {
      await Otp.deleteMany({ email: cleanEmail });
      return res.status(400).json({ message: "Invalid or expired code" });
    }

    const ok = await bcrypt.compare(otp, record.hash);
    if (!ok) return res.status(400).json({ message: "Invalid or expired code" });

    // burn after use
    await Otp.deleteMany({ email: cleanEmail });

    // short-lived reset token (do NOT use login JWT)
    const resetToken = jwt.sign({ email: cleanEmail }, RESET_SECRET, { expiresIn: "15m" });
    res.status(200).json({ message: "OTP verified", token: resetToken });
  } catch (err) {
    console.error("❌ OTP verify error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ✅ Step 3: Set New Password (accept token from body, header, or query)
router.post("/set-password", async (req, res) => {
  try {
    // read token flexibly
    const rawAuth = req.headers.authorization || "";
    const bearer = rawAuth.startsWith("Bearer ") ? rawAuth.slice(7) : null;
    const token = req.body.token || req.body.resetToken || bearer || req.query.token;

    const { password } = req.body;

    if (!token) return res.status(400).json({ message: "Missing reset token" });
    if (!password) return res.status(400).json({ message: "Password required" });

    const { email } = jwt.verify(token, RESET_SECRET);


    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: "User not found" });

    const hashedPassword = await bcrypt.hash(password, 10);
    user.password = hashedPassword;
    await user.save();

    await mail.sendTx("password_changed", email, { name: user.name }, { bccAdmin: false });

    return res.status(200).json({ message: "Password updated" });
  } catch (err) {
  console.error("❌ Set password error:", err.name, err.message);
  if (err.name === "TokenExpiredError") {
    return res.status(400).json({ message: "Reset code expired. Please request a new one." });
  }
  if (err.name === "JsonWebTokenError") {
    return res.status(400).json({ message: "Invalid reset code. Please request a new one." });
  }
  if (err.message?.includes("data and salt arguments required")) {
    return res.status(400).json({ message: "Password is required." });
  }
  return res.status(500).json({ message: "Server error" });
}

});


module.exports = router;
