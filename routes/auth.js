const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Subscription = require("../models/Subscription");
const RepAttribution = require("../models/RepAttribution");
const { normalizeEmail, normalizePhone } = require("../utils/identity");
const { syncGhlConversion } = require("../utils/ghlSync");
const { createOrUpdateContact, addTag } = require("../utils/ghlContact");
const mail = require("../utils/emailService");
const { subscriptionGrantsAccess } = require("../utils/subscriptionManagement");
const router = express.Router();

router.get("/___ping", (req, res) => {
  res.json({ ok: true, msg: "AUTH ROUTER LOADED" });
});

// 8-digit public userId
const generateUserId = () =>
  Math.floor(10000000 + Math.random() * 90000000).toString();

/** Same helper as in users.js */
async function ensurePrimaryFromLegacy(user) {
  if (!user) return false;
  const hasSubs = Array.isArray(user.addresses) && user.addresses.length > 0;
  const legacyComplete = [user.address, user.city, user.state, user.zip].every(
    (v) => !!(v && String(v).trim())
  );
  if (hasSubs || !legacyComplete) return false;

  user.addresses.push({
    label: "Primary",
    line1: String(user.address).trim(),
    city: String(user.city).trim(),
    state: String(user.state || "NY").trim(),
    zip: String(user.zip).trim(),
    county: String(user.county || "").trim(),
  });
  user.defaultAddressId = user.addresses[user.addresses.length - 1]._id;
  await user.save();
  return true;
}

// ── Coverage helpers
// Build per-address map: {addressId: {active, plan}}
async function buildPerAddressCoverage(user) {
  const map = {};
  const subs = await Subscription.find({ user: user._id }).sort({ startDate: -1, createdAt: -1 });

  for (const s of subs) {
    if (!subscriptionGrantsAccess(s)) continue;
    const plan = String(s.subscriptionType || "").toLowerCase();
    if (!s.addressId) continue;

    const key = String(s.addressId);
    if (!map[key]) map[key] = { active: true, plan };
  }

  const addrless = subs.find((s) => subscriptionGrantsAccess(s) && !s.addressId);
  if (addrless && user.defaultAddressId) {
    const plan = String(addrless.subscriptionType || "").toLowerCase();
    const key = String(user.defaultAddressId);
    if (!map[key]) map[key] = { active: true, plan };
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
    plan: c.plan || null,
  };
}

// ── Cold lead matching helpers
async function findBestLeadMatch({ email, phone }) {
  const phoneNormalized = normalizePhone(phone);
  const emailNormalized = normalizeEmail(email);

  let doc = null;

  if (phoneNormalized) {
    doc = await RepAttribution.findOne({
      phoneNormalized,
      status: { $in: ["active", "registered", "subscribed"] },
    }).sort({ assignedAt: -1, createdAt: -1 });
  }

  if (!doc && emailNormalized) {
    doc = await RepAttribution.findOne({
      emailNormalized,
      status: { $in: ["active", "registered", "subscribed"] },
    }).sort({ assignedAt: -1, createdAt: -1 });
  }

  return doc;
}

async function markLeadRegistered(user) {
  try {
    const match = await findBestLeadMatch({
      email: user.email,
      phone: user.phone,
    });

    if (!match) {
      console.log("ℹ️ No cold-lead match found on registration for:", user.email);
      return;
    }

    match.matchedUserId = user._id;
    match.emailRaw = user.email || match.emailRaw;
    match.emailNormalized = normalizeEmail(user.email) || match.emailNormalized;
    match.phoneRaw = user.phone || match.phoneRaw;
    match.phoneNormalized = normalizePhone(user.phone) || match.phoneNormalized;

    if (!match.fullName && user.name) match.fullName = user.name;
    if (!match.cityAtAssignment && user.city) match.cityAtAssignment = user.city;
    if (!match.stateAtAssignment && user.state) match.stateAtAssignment = user.state;

    if (match.status !== "subscribed") {
      match.status = "registered";
    }

    if (match.conversionType === "none") {
      match.conversionType = "registered";
    }

    if (!match.registeredAt) {
      match.registeredAt = new Date();
    }

    match.lastSyncedAt = new Date();

    await match.save();

    try {
      await syncGhlConversion({
        repAttributionId: match._id,
        event: "registered",
      });
    } catch (syncErr) {
      console.error("❌ GHL registered sync failed:", syncErr.message);
    }

    console.log("✅ Lead marked as registered:", {
      id: String(match._id),
      email: match.emailRaw,
      phone: match.phoneRaw,
    });
  } catch (e) {
    console.error("❌ markLeadRegistered failed:", e.message);
  }
}

/* ───────── Register (REQUIRED address) ───────── */
router.post("/register", async (req, res) => {
  try {
    const { name, email, password, phone, address, city, state, zip, county } = req.body;

    const cleanEmail = String(email || "").trim().toLowerCase();
    if (![name, cleanEmail, password, phone, address, city, state, zip, county].every(Boolean)) {
      return res.status(400).json({
        message:
          "All fields are required: name, email, password, phone, address, city, state, zip, county",
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(cleanEmail)) {
      return res.status(400).json({ message: "Invalid email format" });
    }

    const rawPhoneDigits = String(phone || "").replace(/\D/g, "");
    let normalizedPhone = rawPhoneDigits;

    if (normalizedPhone.length === 10) normalizedPhone = "1" + normalizedPhone;

    const phoneOk = normalizedPhone.length === 11 && normalizedPhone.startsWith("1");

    if (!phoneOk) {
      return res.status(400).json({ message: "Phone must be a valid US number." });
    }

    const e164Phone = "+" + normalizedPhone;

    const existing = await User.findOne({ email: cleanEmail });
    if (existing) return res.status(400).json({ message: "User already exists" });

    const hashed = await bcrypt.hash(password, 10);

    const user = new User({
      userId: generateUserId(),
      name,
      email: cleanEmail,
      password: hashed,
      phone: e164Phone,

      address: String(address).trim(),
      city: String(city).trim(),
      state: String(state || "NY").trim(),
      zip: String(zip).trim(),
      county: String(county || "").trim(),

      addresses: [],
      defaultAddressId: null,

      subscription: null,
      subscriptionExpiry: null,
      subscriptionStart: null,
    });

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
    await markLeadRegistered(user);

    // Sync customer into GHL in background
    (async () => {
      try {
        const contactId = await createOrUpdateContact({
          name: user.name,
          email: user.email,
          phone: user.phone,
        });

        await addTag(contactId, "website_registered");

        console.log("✅ GHL contact synced:", contactId);
      } catch (err) {
        console.error("❌ GHL sync failed:", err.message);
      }
    })();

    try {
      await mail.sendTx(
        "welcome",
        user.email,
        { name: user.name || user.email.split("@")[0], userId: user.userId },
        { bccAdmin: false }
      );

      await mail.sendPromo(process.env.MAIL_ADMIN || "getfixter@gmail.com", {
        subject: `New Registration: ${user.name}`,
        html: `
          <h2>New Customer Registered</h2>
          <p><strong>Name:</strong> ${user.name}</p>
          <p><strong>Email:</strong> ${user.email}</p>
          <p><strong>Phone:</strong> ${user.phone}</p>
          <p><strong>ID:</strong> ${user.userId}</p>
          <p><strong>Address:</strong> ${user.address}, ${user.city}, ${user.state} ${user.zip}</p>
        `,
      });
    } catch (_) {}

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: "30d" });

    const coverageMap = await buildPerAddressCoverage(user);

    return res.status(201).json({
      token,
      user: {
        userId: user.userId,
        id: user.userId,
        name: user.name,
        email: user.email,
        phone: user.phone,
        subscription: user.subscription || null,
        subscriptionExpiry: user.subscriptionExpiry || null,
        subscriptionStart: user.subscriptionStart || null,
        defaultAddressId: user.defaultAddressId ? String(user.defaultAddressId) : null,
        addresses: (user.addresses || []).map((a) => toAddressDTOWithCoverage(a, coverageMap)),
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
        userId: user.userId,
        id: user.userId,
        name: user.name,
        email: user.email,
        phone: user.phone || "",
        subscription: user.subscription || null,
        subscriptionExpiry: user.subscriptionExpiry || null,
        subscriptionStart: user.subscriptionStart || null,
        defaultAddressId: user.defaultAddressId ? String(user.defaultAddressId) : null,
        addresses: (user.addresses || []).map((a) => toAddressDTOWithCoverage(a, coverageMap)),
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
      userId: user.userId,
      id: user.userId,
      name: user.name,
      email: user.email,
      phone: user.phone || "",
      subscription: user.subscription || null,
      subscriptionExpiry: user.subscriptionExpiry || null,
      subscriptionStart: user.subscriptionStart || null,
      defaultAddressId: user.defaultAddressId ? String(user.defaultAddressId) : null,
      addresses: (user.addresses || []).map((a) => toAddressDTOWithCoverage(a, coverageMap)),
    });
  } catch (err) {
    console.error("❌ /me Error:", err.stack || err.message);
    return res.status(500).json({ message: "User fetch failed", error: err.message });
  }
});

/* ───────── Change Password ───────── */
router.post("/change-password", require("../middleware/auth"), async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: "Both current and new password are required" });
    }

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    const match = await bcrypt.compare(currentPassword, user.password);
    if (!match) {
      return res.status(400).json({ message: "Current password is incorrect" });
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    user.password = hashed;
    await user.save();

    return res.json({ message: "Password updated successfully" });
  } catch (err) {
    console.error("❌ Change Password Error:", err.stack || err.message);
    return res.status(500).json({ message: "Password update failed" });
  }
});

/* ───────── Google OAuth ───────── */
router.post("/google", async (req, res) => {
  try {
    const { idToken } = req.body;

    if (!idToken) {
      return res.status(400).json({ message: "Google ID token is required" });
    }

    const { OAuth2Client } = require("google-auth-library");
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
    const googleId = payload.sub;

    let user = await User.findOne({ email: googleEmail });

    if (user) {
      if (!user.googleId) {
        user.googleId = googleId;
        await user.save();
      }
    } else {
      user = new User({
        userId: generateUserId(),
        name: googleName,
        email: googleEmail,
        googleId,
        phone: "",
        address: "",
        city: "",
        state: "NY",
        zip: "",
        county: "",
        subscription: "none",
        addresses: [],
        defaultAddressId: null,
      });

      await user.save();

      try {
        await mail.sendTx("welcome", user.email, { name: user.name });
      } catch (emailError) {
        console.log("Welcome email failed:", emailError.message);
      }
    }

    const token = jwt.sign({ id: user._id, email: user.email }, process.env.JWT_SECRET, {
      expiresIn: "30d",
    });

    await ensurePrimaryFromLegacy(user);
    const coverageMap = await buildPerAddressCoverage(user);

    return res.json({
      token,
      user: {
        userId: user.userId,
        id: user.userId,
        name: user.name,
        email: user.email,
        phone: user.phone || "",
        subscription: user.subscription || null,
        subscriptionExpiry: user.subscriptionExpiry || null,
        subscriptionStart: user.subscriptionStart || null,
        defaultAddressId: user.defaultAddressId ? String(user.defaultAddressId) : null,
        addresses: (user.addresses || []).map((a) => toAddressDTOWithCoverage(a, coverageMap)),
      },
    });
  } catch (error) {
    console.error("❌ Google OAuth Error:", error.stack || error.message);
    return res.status(500).json({ message: "Google authentication failed", error: error.message });
  }
});

module.exports = router;
