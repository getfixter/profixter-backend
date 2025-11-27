// 📁 backend/routes/subscriptions.js — per-address aware + strict ObjectId casting
const express = require("express");
const mongoose = require("mongoose");
const auth = require("../middleware/auth");
const User = require("../models/User");
const Subscription = require("../models/Subscription");

const router = express.Router();

/**
 * GET /api/subscriptions/my
 * Return my subscriptions, enriched with address info.
 * If none found but user has a legacy plan, synthesize one for the default address.
 */
router.get("/my", auth, async (req, res) => {
  try {
    const me = await User.findById(req.user.id);
    if (!me) return res.status(404).json({ message: "User not found" });

    let subs = await Subscription.find({ user: me._id }).sort({ startDate: -1 });
    const addrMap = {};
    for (const a of me.addresses || []) addrMap[String(a._id)] = a;

    // Legacy shim: synthesize one if DB has none but user has legacy plan
    if ((!subs || subs.length === 0) && me.subscription && me.defaultAddressId) {
      const active = !me.subscriptionExpiry || new Date(me.subscriptionExpiry).getTime() >= Date.now();
      if (active) {
        subs = [{
          _id: "legacy",
          user: me._id,
          addressId: me.defaultAddressId,
          subscriptionType: String(me.subscription).toLowerCase(),
          status: "active",
          startDate: me.subscriptionStart || new Date(),
          latestPaymentDate: me.subscriptionStart || new Date(),
          nextPaymentDate: me.subscriptionExpiry || new Date(Date.now() + 30*24*3600*1000),
          planPrice: null,
        }];
      }
    }

    const list = subs.map((s) => {
      const addr = s.addressId ? (addrMap[String(s.addressId)] || null) : null;
      return {
        _id: String(s._id),
        addressId: s.addressId ? String(s.addressId) : null,
        address: addr ? {
          _id: String(addr._id),
          label: addr.label,
          line1: addr.line1,
          city:  addr.city,
          state: addr.state,
          zip:   addr.zip,
          county: addr.county || "",
        } : null,
        subscriptionType: s.subscriptionType,   // basic | plus | premium | elite
        status: s.status,                       // active | canceled | trialing | ...
        startDate: s.startDate,
        latestPaymentDate: s.latestPaymentDate || null,
        nextPaymentDate: s.nextPaymentDate || null,
        planPrice: s.planPrice || null,
      };
    });

    res.json({ subscriptions: list });
  } catch (err) {
    console.error("GET /subscriptions/my error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/**
 * GET /api/subscriptions/check/address/:addressId
 * Is there an active subscription for this address?
 * Includes legacy default-address allowance.
 */
router.get("/check/address/:addressId", auth, async (req, res) => {
  try {
    const { addressId } = req.params;
    if (!mongoose.isValidObjectId(addressId)) {
      return res.status(400).json({ message: "Invalid addressId" });
    }
    const addrObjId = new mongoose.Types.ObjectId(addressId); // strict cast

    const me = await User.findById(req.user.id);
    if (!me) return res.status(404).json({ message: "User not found" });

    const exists = me.addresses.id(addrObjId);
    if (!exists) return res.status(404).json({ message: "Address not found" });

    let activeSub = await Subscription.findOne({
      user: me._id,
      addressId: addrObjId,
      status: { $in: ["active", "trialing"] },
    });

    // Legacy: addressless active sub allowed on default address
    if (!activeSub) {
      const addrless = await Subscription.findOne({
        user: me._id,
        addressId: { $in: [null, undefined] },
        status: { $in: ["active", "trialing"] },
      });
      if (addrless && me.defaultAddressId && String(me.defaultAddressId) === String(addrObjId)) {
        activeSub = addrless;
      }
    }

    // Legacy: user.subscription allowed on default address if active
    if (!activeSub) {
      const plan = String(me.subscription || "").toLowerCase();
      const notNone = !!plan && plan !== "none";
      const notExpired = !me.subscriptionExpiry || new Date(me.subscriptionExpiry).getTime() >= Date.now();
      if (notNone && notExpired && me.defaultAddressId && String(me.defaultAddressId) === String(addrObjId)) {
        return res.json({
          active: true,
          subscription: {
            _id: "legacy",
            addressId: String(addrObjId),
            subscriptionType: plan,
            status: "active",
            startDate: me.subscriptionStart || null,
            nextPaymentDate: me.subscriptionExpiry || null,
          },
        });
      }
    }

    if (!activeSub) return res.json({ active: false });

    return res.json({
      active: true,
      subscription: {
        _id: String(activeSub._id),
        addressId: String(addrObjId),
        subscriptionType: activeSub.subscriptionType,
        status: activeSub.status,
        startDate: activeSub.startDate,
        nextPaymentDate: activeSub.nextPaymentDate || null,
      },
    });
  } catch (err) {
    console.error("GET /subscriptions/check/address error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/**
 * DELETE /api/subscriptions/:id
 */
router.delete("/:id", auth, async (req, res) => {
  try {
    if (!req.params.id.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).json({ message: "Invalid subscription ID" });
    }

    const subscription = await Subscription.findById(req.params.id);
    if (!subscription) {
      return res.status(404).json({ message: "Subscription not found" });
    }

    if (String(subscription.user) !== String(req.user.id)) {
      return res.status(403).json({ message: "Unauthorized to delete this subscription" });
    }

    await subscription.deleteOne();
    res.status(200).json({ message: "Subscription deleted successfully" });
  } catch (error) {
    console.error("❌ DELETE Subscription Error:", error.message);
    res.status(500).json({ message: "Server Error", error: error.message });
  }
});

/**
 * POST /api/subscriptions
 * Disabled — creation is handled via Stripe checkout
 */
router.post("/", auth, async (req, res) => {
  return res.status(403).json({
    message: "Direct subscription creation is disabled. Please use the Stripe checkout process.",
  });
});

module.exports = router;
