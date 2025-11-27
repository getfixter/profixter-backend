const express = require("express");
const router = express.Router();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const mongoose = require("mongoose");
const User = require("../models/User");

const priceMap = {
  basic:   "price_1RUdq2Bw0RtvSZjMnnI6uRgn",
  plus:    "price_1RUds8Bw0RtvSZjMFS1BoQEU",
  premium: "price_1RUdtWBw0RtvSZjMOo8Q1as9",
  elite:   "price_1RUduRBw0RtvSZjMy6ySmgHk",
};

router.post("/create-checkout-session", async (req, res) => {
  const { plan, email, addressId, code } = req.body; // 👈 added `code` for promo code support

  if (!plan || !email || !priceMap[plan]) {
    return res.status(400).json({ message: "Missing or invalid plan/email" });
  }
  if (!addressId || !mongoose.isValidObjectId(addressId)) {
    return res.status(400).json({ message: "Missing or invalid addressId" });
  }

  try {
    const user = await User.findOne({ email: String(email).toLowerCase() });
    if (!user) return res.status(404).json({ message: "User not found" });

    const subdoc = user.addresses.id(addressId);
    if (!subdoc) return res.status(400).json({ message: "Address not found for this user" });

    // 👇 Try to find and auto-apply a valid promo code (optional)
    let discounts = [];
    if (code) {
      const promo = await stripe.promotionCodes.list({
        code,
        active: true,
        limit: 1,
      });
      if (promo.data[0]) {
        discounts = [{ promotion_code: promo.data[0].id }];
      }
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      customer_email: email,
      line_items: [{ price: priceMap[plan], quantity: 1 }],
      subscription_data: { trial_period_days: 7 },

      // Allow customers to enter promo codes manually
      allow_promotion_codes: true,

      // Auto-apply one if provided in request
      discounts,

      // Keep your metadata and tax settings
      metadata: {
        plan,
        email,
        userId: String(user.userId || user._id || ""),
        addressId: String(addressId),
      },
      automatic_tax: { enabled: true },

      success_url: `${process.env.CLIENT_URL}/?success=true&plan=${plan}&session_id={CHECKOUT_SESSION_ID}&trial=1`,
cancel_url:  `${process.env.CLIENT_URL}/?canceled=true&plan=${plan}`,

    });

    res.status(200).json({ url: session.url });
  } catch (error) {
    console.error("❌ Stripe Session Error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

module.exports = router;
