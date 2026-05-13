// 📁 backend/routes/referrals.js
const express = require("express");
const router = express.Router();
const User = require("../models/User");
const Referral = require("../models/Referral");
const auth = require("../middleware/auth");

// Accept Referral
router.post("/accept", auth, async (req, res) => {
  try {
    const { referralId } = req.body;
    const currentUser = await User.findById(req.user.id);

    if (!referralId || referralId.length !== 8)
      return res.status(400).json({ message: "Invalid referral ID format." });

    if (referralId === currentUser.userId)
      return res.status(400).json({ message: "You cannot refer yourself." });

    const referrer = await User.findOne({ userId: referralId });
    if (!referrer)
      return res.status(404).json({ message: "Referral ID not found." });

    const existing = await Referral.findOne({ "receiver.userId": currentUser.userId });
    if (existing)
      return res.status(400).json({ message: "Referral already accepted." });

    const newReferral = new Referral({
      referrer: {
        userId: referrer.userId,
        name: referrer.name,
        address: referrer.address,
      },
      receiver: {
        userId: currentUser.userId,
        name: currentUser.name,
        address: currentUser.address,
      },
      acceptedAt: new Date(),
    });

    await newReferral.save();
    res.json({
      message: "Referral accepted!",
      referrer: {
        userId: referrer.userId,
        name: referrer.name,
      },
    });
  } catch (err) {
    console.error("❌ Referral error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
