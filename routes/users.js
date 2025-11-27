// routes/users.js — final
const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();

const User = require("../models/User");
const Subscription = require("../models/Subscription");
const Booking = require("../models/Booking");
const auth = require("../middleware/auth");

/* Helpers */
function normalizeAddressInput(body = {}) {
  const line1  = String(body.line1 || body.address || "").trim();
  const city   = String(body.city || "").trim();
  const state  = String((body.state || "NY")).trim();
  const zip    = String(body.zip || "").trim();
  const county = String(body.county || "").trim();
  const label  = String(body.label || body.name || "Address").trim() || "Address";
  return { label, line1, city, state, zip, county };
}
function validateAddressFields(a) {
  const errs = [];
  if (!a.line1) errs.push("line1");
  if (!a.city)  errs.push("city");
  if (!a.state) errs.push("state");
  if (!a.zip)   errs.push("zip");
  return errs;
}
function toAddressDTO(subdoc) {
  return {
    _id: String(subdoc._id),
    label: subdoc.label,
    line1: subdoc.line1,
    city:  subdoc.city,
    state: subdoc.state,
    zip:   subdoc.zip,
    county: subdoc.county || "",
  };
}

/** 🔧 If user has NO sub-addresses but has legacy fields, create a Primary and set default */
async function ensurePrimaryFromLegacy(user) {
  if (!user) return false;
  const hasSubs = Array.isArray(user.addresses) && user.addresses.length > 0;
  const legacyComplete = [user.address, user.city, user.state, user.zip]
    .every(v => !!(v && String(v).trim()));
  if (hasSubs || !legacyComplete) return false;

  user.addresses.push({
    label: "Primary",
    line1: String(user.address).trim(),
    city:  String(user.city).trim(),
    state: String(user.state || "NY").trim(),
    zip:   String(user.zip).trim(),
    county: String(user.county || "").trim(),
  });
  user.defaultAddressId = user.addresses[user.addresses.length - 1]._id;
  await user.save();
  return true;
}

/* ───────── ROUTES ───────── */

// Get my addresses (auto-hydrate from legacy if needed)
router.get("/me/addresses", auth, async (req, res) => {
  try {
    const me = await User.findById(req.user.id);
    if (!me) return res.status(404).json({ message: "User not found" });

    await ensurePrimaryFromLegacy(me);

    const list = (me.addresses || []).map(toAddressDTO);
    const defaultId = me.defaultAddressId ? String(me.defaultAddressId) : null;
    return res.json({ addresses: list, defaultAddressId: defaultId });
  } catch (e) {
    console.error("GET /me/addresses error:", e);
    return res.status(500).json({ message: "Server error" });
  }
});

// Add a new address
router.post("/addresses", auth, async (req, res) => {
  try {
    const me = await User.findById(req.user.id);
    if (!me) return res.status(404).json({ message: "User not found" });

    const addr = normalizeAddressInput(req.body);
    const errs = validateAddressFields(addr);
    if (errs.length) {
      return res.status(400).json({ message: "Missing fields", fields: errs });
    }

    me.addresses.push(addr);
    if (!me.defaultAddressId) {
      me.defaultAddressId = me.addresses[me.addresses.length - 1]._id;
    }
    await me.save();

    const created = me.addresses[me.addresses.length - 1];
    return res.status(201).json({
      address: toAddressDTO(created),
      defaultAddressId: me.defaultAddressId ? String(me.defaultAddressId) : null,
    });
  } catch (e) {
    console.error("POST /addresses error:", e);
    return res.status(500).json({ message: "Server error" });
  }
});

// Alias: GET /api/users/addresses  → same as /me/addresses
router.get("/addresses", auth, async (req, res) => {
  try {
    const me = await User.findById(req.user.id);
    if (!me) return res.status(404).json({ message: "User not found" });
    const list = (me.addresses || []).map(toAddressDTO);
    const defaultId = me.defaultAddressId ? String(me.defaultAddressId) : null;
    return res.json({ addresses: list, defaultAddressId: defaultId });
  } catch (e) {
    console.error("GET /addresses alias error:", e);
    return res.status(500).json({ message: "Server error" });
  }
});

// Alias: PATCH /api/users/addresses/:id/default  → same as /default-address/:id
router.patch("/addresses/:addressId/default", auth, async (req, res) => {
  try {
    const { addressId } = req.params;
    if (!mongoose.isValidObjectId(addressId)) {
      return res.status(400).json({ message: "Invalid addressId" });
    }
    const me = await User.findById(req.user.id);
    if (!me) return res.status(404).json({ message: "User not found" });
    const exists = me.addresses.id(addressId);
    if (!exists) return res.status(404).json({ message: "Address not found" });
    me.defaultAddressId = addressId;
    await me.save();
    return res.json({ ok: true, defaultAddressId: String(me.defaultAddressId) });
  } catch (e) {
    console.error("PATCH /addresses/:id/default alias error:", e);
    return res.status(500).json({ message: "Server error" });
  }
});

// Update an address
router.patch("/addresses/:addressId", auth, async (req, res) => {
  try {
    const { addressId } = req.params;
    if (!mongoose.isValidObjectId(addressId)) {
      return res.status(400).json({ message: "Invalid addressId" });
    }
    const me = await User.findById(req.user.id);
    if (!me) return res.status(404).json({ message: "User not found" });

    const sub = me.addresses.id(addressId);
    if (!sub) return res.status(404).json({ message: "Address not found" });

    const patch = normalizeAddressInput(req.body);
    const errs = validateAddressFields({ ...sub.toObject(), ...patch });
    if (errs.length) {
      return res.status(400).json({ message: "Missing fields", fields: errs });
    }

    sub.label  = patch.label || sub.label;
    sub.line1  = patch.line1 || sub.line1;
    sub.city   = patch.city  || sub.city;
    sub.state  = patch.state || sub.state;
    sub.zip    = patch.zip   || sub.zip;
    sub.county = patch.county ?? sub.county;

    await me.save();
    return res.json({ address: toAddressDTO(sub) });
  } catch (e) {
    console.error("PATCH /addresses/:id error:", e);
    return res.status(500).json({ message: "Server error" });
  }
});

// Delete an address (guarded)
router.delete("/addresses/:addressId", auth, async (req, res) => {
  try {
    const { addressId } = req.params;
    if (!mongoose.isValidObjectId(addressId)) {
      return res.status(400).json({ message: "Invalid addressId" });
    }
    const me = await User.findById(req.user.id);
    if (!me) return res.status(404).json({ message: "User not found" });

    const subdoc = me.addresses.id(addressId);
    if (!subdoc) return res.status(404).json({ message: "Address not found" });

    if (String(me.defaultAddressId) === String(addressId) && (me.addresses?.length || 0) <= 1) {
      return res.status(400).json({ message: "Cannot delete the only address on the account" });
    }

    const activeSub = await Subscription.findOne({ user: me._id, addressId, status: "active" });
    if (activeSub) {
      return res.status(400).json({ message: "This address has an active subscription. Cancel or move the subscription first." });
    }

    const now = new Date();
    const futureBooking = await Booking.findOne({
      user: me._id,
      addressId,
      date: { $gte: now },
      status: { $nin: ["Canceled"] },
    });
    if (futureBooking) {
      return res.status(400).json({ message: "This address has a future booking. Cancel that booking first." });
    }

    subdoc.remove();
    if (String(me.defaultAddressId) === String(addressId)) {
      me.defaultAddressId = me.addresses[0]?._id || null;
    }
    await me.save();

    return res.json({
      ok: true,
      defaultAddressId: me.defaultAddressId ? String(me.defaultAddressId) : null,
      addresses: (me.addresses || []).map(toAddressDTO),
    });
  } catch (e) {
    console.error("DELETE /addresses/:id error:", e);
    return res.status(500).json({ message: "Server error" });
  }
});

// Set default
router.patch("/default-address/:addressId", auth, async (req, res) => {
  try {
    const { addressId } = req.params;
    if (!mongoose.isValidObjectId(addressId)) {
      return res.status(400).json({ message: "Invalid addressId" });
    }
    const me = await User.findById(req.user.id);
    if (!me) return res.status(404).json({ message: "User not found" });

    const exists = me.addresses.id(addressId);
    if (!exists) return res.status(404).json({ message: "Address not found" });

    me.defaultAddressId = addressId;
    await me.save();

    return res.json({ ok: true, defaultAddressId: String(me.defaultAddressId) });
  } catch (e) {
    console.error("PATCH /default-address/:id error:", e);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
