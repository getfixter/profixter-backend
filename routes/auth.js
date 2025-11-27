// backend/routes/auth.js — FINAL
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Subscription = require("../models/Subscription"); // ⬅ added
const mail = require("../utils/emailService");
const router = express.Router();

// 8-digit public userId
const generateUserId = () =>
  Math.floor(10000000 + Math.random() * 90000000).toString();

/** Same helper as in users.js */
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

// ── Coverage helpers (new)
const isSubActive = (sub) =>
  !!sub && ["active", "trialing"].includes(String(sub.status || "").toLowerCase());

const legacyPlanActive = (user) => {
  const plan = String(user.subscription || "").toLowerCase();
  if (!plan || plan === "none") return { active: false, plan: "" };
  if (user.subscriptionExpiry && new Date(user.subscriptionExpiry).getTime() < Date.now()) {
    return { active: false, plan: "" };
  }
  return { active: true, plan };
};

// Build per-address map: {addressId: {active, plan}}
async function buildPerAddressCoverage(user) {
  const map = {};

  // 1) Address-scoped subs (new world)
  const subs = await Subscription.find({ user: user._id });
  for (const s of subs) {
    if (!isSubActive(s)) continue;
    const plan = String(s.subscriptionType || "").toLowerCase();
    if (!s.addressId) continue;
    map[String(s.addressId)] = { active: true, plan };
  }

  // 2) Addressless active sub → assign to default
  const addrless = subs.find((s) => isSubActive(s) && !s.addressId);
  if (addrless && user.defaultAddressId) {
    const plan = String(addrless.subscriptionType || "").toLowerCase();
    map[String(user.defaultAddressId)] = { active: true, plan };
    // Optional one-time migration:
    // try { addrless.addressId = user.defaultAddressId; await addrless.save(); } catch {}
  }

  // 3) Pure legacy user.subscription → assign to default
  if (!addrless) {
    const legacy = legacyPlanActive(user);
    if (legacy.active && user.defaultAddressId) {
      map[String(user.defaultAddressId)] = { active: true, plan: legacy.plan };
    }
  }

  return map;
}

function toAddressDTOWithCoverage(a, coverageMap) {
  const c = coverageMap[String(a._id)] || { active: false, plan: "" };
  return {
    _id: String(a._id),
    label: a.label,
    line1: a.line1,
    city: a.city,
    state: a.state,
    zip: a.zip,
    county: a.county || "",
    hasActiveSubscription: !!c.active,
    plan: c.plan || null, // basic|plus|premium|elite|null
  };
}

/* ───────── Register (REQUIRED address) ───────── */
router.post("/register", async (req, res) => {
  try {
    const {
  name,
  email,
  password,
  phone,
  // required address parts now:
  address, // street (line1)
  city,
  state,
  zip,
  county
} = req.body;


    // Basic required fields
    const cleanEmail = String(email || "").trim().toLowerCase();
    if (![name, cleanEmail, password, phone, address, city, state, zip, county].every(Boolean)) {
  return res.status(400).json({
    message: "All fields are required: name, email, password, phone, address, city, state, zip, county",
  });
}


    // Email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(cleanEmail)) {
      return res.status(400).json({ message: "Invalid email format" });
    }

    // Phone: accept 10 digits or 1 + 10 digits
    const phoneDigits = String(phone || "").replace(/\D/g, "");
    const phoneOk = phoneDigits.length === 10 || (phoneDigits.length === 11 && phoneDigits.startsWith("1"));
    if (!phoneOk) {
      return res.status(400).json({ message: "Phone must be 10 digits (or 1 + 10 digits)." });
    }

    // Check duplicate
    const existing = await User.findOne({ email: cleanEmail });
    if (existing) return res.status(400).json({ message: "User already exists" });

    // Hash password
    const hashed = await bcrypt.hash(password, 10);

    // Create user with legacy fields preserved AND new multi-address structure
    const user = new User({
      userId: generateUserId(),
      name,
      email: cleanEmail,
      password: hashed,
      phone: phoneDigits,

      // legacy fields (kept populated for backward compatibility)
      address: String(address).trim(),
      city: String(city).trim(),
      state: String(state || "NY").trim(),
      zip: String(zip).trim(),
      county: String(county || "").trim(),

      // new multi-address
      addresses: [],
      defaultAddressId: null,

      // legacy subscription fields preserved as-is
      subscription: null,
      subscriptionExpiry: null,
      subscriptionStart: null,
    });

    // Always create the new-style address and make it default
    user.addresses.push({
      label: "Primary",
      line1: String(address).trim(),
      city: String(city).trim(),
      state: String(state || "NY").trim(),
      zip: String(zip).trim(),
      county: String(county || "").trim(),
    });
    user.defaultAddressId = user.addresses[0]._id;

    await user.save();

    // Best-effort welcome/admin emails (preserves your previous behavior)
    try {
      await mail.sendTx("welcome", user.email, {
        name: user.name || user.email.split("@")[0],
        userId: user.userId,
      }, { bccAdmin: false });

      await mail.sendPromo(process.env.MAIL_ADMIN || "getfixter@gmail.com", {
        subject: `New Registration: ${user.name}`,
        html: `
          <h2>New Customer Registered</h2>
          <p><strong>Name:</strong> ${user.name}</p>
          <p><strong>Email:</strong> ${user.email}</p>
          <p><strong>Phone:</strong> ${user.phone}</p>
          <p><strong>ID:</strong> ${user.userId}</p>
        `,
      });
    } catch (_) { /* ignore email errors */ }

    // JWT
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: "30d" });

    // Coverage map (keeps your enriched response shape)
    const coverageMap = await buildPerAddressCoverage(user);

    return res.status(201).json({
      token,
      user: {
        id: user.userId,
        name: user.name,
        email: user.email,
        phone: user.phone,
        subscription: user.subscription || null,
        subscriptionExpiry: user.subscriptionExpiry || null,
        subscriptionStart: user.subscriptionStart || null,
        defaultAddressId: user.defaultAddressId ? String(user.defaultAddressId) : null,
        addresses: (user.addresses || []).map(a => toAddressDTOWithCoverage(a, coverageMap)),
      },
    });
  } catch (err) {
    console.error("❌ Registration Error:", err.stack || err.message);
    return res.status(500).json({ message: "Registration failed", error: err.message });
  }
});


/* ───────── Login ───────── */
router.post("/login", async (req, res) => {
  try {
    const cleanEmail = String(req.body.email || "").trim().toLowerCase();
    const { password } = req.body;
    if (!cleanEmail || !password) {
      return res.status(400).json({ message: "Missing credentials" });
    }

    const user = await User.findOne({ email: cleanEmail });
    if (!user) return res.status(400).json({ message: "Invalid credentials" });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(400).json({ message: "Invalid credentials" });

    await ensurePrimaryFromLegacy(user);

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: "30d" });

    const coverageMap = await buildPerAddressCoverage(user);
    return res.json({
      token,
      user: {
        id: user.userId,
        name: user.name,
        email: user.email,
        phone: user.phone || "",
        subscription: user.subscription || null,
        subscriptionExpiry: user.subscriptionExpiry || null,
        subscriptionStart: user.subscriptionStart || null,
        defaultAddressId: user.defaultAddressId ? String(user.defaultAddressId) : null,
        addresses: (user.addresses || []).map(a => toAddressDTOWithCoverage(a, coverageMap)),
      },
    });
  } catch (err) {
    console.error("❌ Login Error:", err.stack || err.message);
    return res.status(500).json({ message: "Login failed", error: err.message });
  }
});

/* ───────── Me ───────── */
router.get("/me", require("../middleware/auth"), async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    await ensurePrimaryFromLegacy(user);
    const coverageMap = await buildPerAddressCoverage(user);

    return res.json({
      id: user.userId,
      name: user.name,
      email: user.email,
      phone: user.phone || "",
      subscription: user.subscription || null,
      subscriptionExpiry: user.subscriptionExpiry || null,
      subscriptionStart: user.subscriptionStart || null,
      defaultAddressId: user.defaultAddressId ? String(user.defaultAddressId) : null,
      addresses: (user.addresses || []).map(a => toAddressDTOWithCoverage(a, coverageMap)),
    });
  } catch (err) {
    console.error("❌ /me Error:", err.stack || err.message);
    return res.status(500).json({ message: "User fetch failed", error: err.message });
  }
});

/* ========================================================================= */
/* GOOGLE OAUTH AUTHENTICATION                                               */
/* ========================================================================= */

/**
 * POST /api/auth/google
 * 
 * Accepts Google ID token from frontend, verifies it, and:
 * - Creates new user if email doesn't exist
 * - Returns JWT token for existing user
 * 
 * Request body: { idToken: "google_id_token_from_frontend" }
 */
router.post("/google", async (req, res) => {
  try {
    const { idToken } = req.body;
    
    if (!idToken) {
      return res.status(400).json({ message: "Google ID token is required" });
    }

    // Verify Google token using google-auth-library
    const { OAuth2Client } = require('google-auth-library');
    const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
    
    let ticket;
    try {
      ticket = await client.verifyIdToken({
        idToken,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
    } catch (error) {
      console.error("Google token verification failed:", error.message);
      return res.status(401).json({ message: "Invalid Google token" });
    }

    const payload = ticket.getPayload();
    const googleEmail = payload.email.toLowerCase();
    const googleName = payload.name;
    const googleId = payload.sub; // Google user ID

    // Check if user exists
    let user = await User.findOne({ email: googleEmail });

    if (user) {
      // Existing user - link Google ID if not already linked
      if (!user.googleId) {
        user.googleId = googleId;
        await user.save();
      }
    } else {
      // New user from Google - create account without password
      user = new User({
        userId: generateUserId(),
        name: googleName,
        email: googleEmail,
        googleId: googleId,
        // No password for Google users
        phone: "", // User can add later in profile
        // Legacy fields (empty for Google users initially)
        address: "",
        city: "",
        state: "NY",
        zip: "",
        county: "",
        subscription: "none",
        addresses: [], // Empty initially
      });

      await user.save();

      // Send welcome email
      try {
        await mail.sendTx("welcome", user.email, { name: user.name });
      } catch (emailError) {
        console.log("Welcome email failed:", emailError.message);
      }
    }

    // Generate JWT token
    const token = jwt.sign(
      { id: user._id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "30d" }
    );

    // Ensure primary address from legacy
    await ensurePrimaryFromLegacy(user);
    const coverageMap = await buildPerAddressCoverage(user);

    return res.json({
      token,
      user: {
        id: user.userId,
        name: user.name,
        email: user.email,
        phone: user.phone || "",
        subscription: user.subscription || null,
        subscriptionExpiry: user.subscriptionExpiry || null,
        subscriptionStart: user.subscriptionStart || null,
        defaultAddressId: user.defaultAddressId ? String(user.defaultAddressId) : null,
        addresses: (user.addresses || []).map(a => toAddressDTOWithCoverage(a, coverageMap)),
      }
    });

  } catch (error) {
    console.error("❌ Google OAuth Error:", error.stack || error.message);
    return res.status(500).json({ 
      message: "Google authentication failed", 
      error: error.message 
    });
  }
});

module.exports = router;
