const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Subscription = require("../models/Subscription");
const RepAttribution = require("../models/RepAttribution");
const { normalizeEmail, normalizePhone, normalizePhoneE164 } = require("../utils/identity");
const { syncGhlConversion } = require("../utils/ghlSync");
const { createOrUpdateContact, addTag } = require("../utils/ghlContact");
const mail = require("../utils/emailService");
const smsNotify = require("../utils/sms/smsNotifications");
const {
  sendAdminLeadNotification,
} = require("../utils/adminLeadNotification");
const { subscriptionGrantsAccess } = require("../utils/subscriptionManagement");
const { activeGiftsByAddress } = require("../utils/gifts/giftAccess");
const { accessProfile, effectiveRole } = require("../middleware/authorize");
const {
  findCustomerByEmail,
  findUsersByEmail,
  isEmployeeRecord,
} = require("../utils/userLookup");
const router = express.Router();

/**
 * Which account somebody is signing in to, when one email has two.
 *
 * The password does the work. A customer account and a Fixter account are
 * separate records with separate credentials, so in practice only one of them
 * matches what was typed and there is nothing to disambiguate. Only when both
 * records happen to share a password is the request genuinely ambiguous, and
 * that is the one case this refuses to guess at: it asks, rather than picking
 * one and hoping. Guessing would drop a Fixter into the customer app, or
 * worse, hand somebody the wrong account entirely.
 */
const ACCOUNT_KINDS = Object.freeze({ CUSTOMER: "customer", EMPLOYEE: "employee" });

function accountKind(user) {
  return isEmployeeRecord(user) ? ACCOUNT_KINDS.EMPLOYEE : ACCOUNT_KINDS.CUSTOMER;
}

function accountChoiceLabel(user) {
  if (!isEmployeeRecord(user)) return "Customer account";
  return user.employeePosition ? `${user.employeePosition} account` : "Employee account";
}

function authUserDTO(user, coverageMap) {
  return {
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
    ...accessProfile(user),
  };
}

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
/*
 * Build per-address map: {addressId: {active, plan, source}}
 *
 * This is the answer the entire customer UI is built on. hasActiveMembership()
 * on the frontend is just "does any address in this map say active", and from
 * that one boolean hang the member navigation, the membership booking flow,
 * the mobile nav and every members-only affordance on the site.
 *
 * It must therefore describe MEMBERSHIP, not billing. For most people those
 * are the same thing and a Subscription row is the whole story. For somebody
 * holding a gift they are not: a gift is deliberately not a Subscription and
 * carries no Stripe customer, so a map built from Subscription rows alone
 * reported a claimed, paid-for, currently-running gift as no membership at
 * all. The booking API knew better and would have let them book; the UI
 * never offered them the door.
 */
async function buildPerAddressCoverage(user) {
  const map = {};
  const subs = await Subscription.find({ user: user._id }).sort({ startDate: -1, createdAt: -1 });

  for (const s of subs) {
    if (!subscriptionGrantsAccess(s)) continue;
    const plan = String(s.subscriptionType || "").toLowerCase();
    if (!s.addressId) continue;

    const key = String(s.addressId);
    if (!map[key]) map[key] = { active: true, plan, source: "subscription" };
  }

  const addrless = subs.find((s) => subscriptionGrantsAccess(s) && !s.addressId);
  if (addrless && user.defaultAddressId) {
    const plan = String(addrless.subscriptionType || "").toLowerCase();
    const key = String(user.defaultAddressId);
    if (!map[key]) map[key] = { active: true, plan, source: "subscription" };
  }

  /*
   * Gifts fill only the addresses paid cover has not already claimed.
   *
   * Ordered second so a paying member resolves exactly as before and their
   * behaviour cannot move — the same ordering the booking API uses. Whether
   * a gift is live is computed from its dates by the shared authority rather
   * than read from a flag, so a late lifecycle sweep can never cost somebody
   * the membership they are holding.
   *
   * A failure here must not cost anybody their sign-in. Coverage is rebuilt
   * on every /me, so degrading to paid-only for one request is recoverable;
   * refusing to authenticate is not.
   */
  try {
    const giftsByAddress = await activeGiftsByAddress(user._id);
    for (const [key, gift] of giftsByAddress) {
      if (map[key]) continue;
      map[key] = {
        active: true,
        plan: String(gift.plan || "").toLowerCase(),
        source: "gift",
      };
    }
  } catch (err) {
    console.error("buildPerAddressCoverage: gift lookup failed:", err);
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
    /*
     * How the cover was obtained. The UI gates on hasActiveSubscription and
     * does not need this, but a gift has no billing behind it, so anything
     * offering to manage a payment should ask first.
     */
    coverageSource: c.active ? c.source || "subscription" : null,
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

    /*
     * Marketing-SMS consent, and ONLY when the customer actually ticked it.
     *
     * Compared against the literal boolean rather than read for truthiness, so
     * that "false", "0", "no" or any other string a future client sends cannot
     * become consent by accident - a string is always truthy, and that is
     * exactly the bug that would silently enrol somebody in promotional
     * texting they never agreed to.
     *
     * THE ABSENCE OF THIS FIELD IS NOT CONSENT, AND NEITHER IS A PHONE NUMBER.
     * Registration requires a phone so we can text about the visits a customer
     * books; that is the transactional basis and it is not permission to
     * advertise. Marketing needs its own express opt-in, which is what this is.
     */
    const smsMarketingConsent = req.body?.smsMarketingConsent === true;

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

    const e164Phone = normalizePhoneE164(phone);

    if (!e164Phone) {
      return res.status(400).json({ message: "Phone must be a valid US number." });
    }

    const existing = await User.findOne({ email: cleanEmail });
    if (existing) return res.status(400).json({ message: "User already exists" });

    const hashed = await bcrypt.hash(password, 10);

    const user = new User({
      userId: generateUserId(),
      name,
      email: cleanEmail,
      password: hashed,
      phone: e164Phone,
      role: "customer",
      employeePosition: null,
      isActive: true,
      mustChangePassword: false,

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

      /*
       * The consent record, written at the moment it was given.
       *
       * marketingEnabled is the field smsEligibility reads before any
       * promotional send; the timestamp and source beside it are the evidence
       * that it was given, which is the half that matters if consent is ever
       * disputed. Left undefined when the box was not ticked rather than set
       * to false, so "never asked" stays distinguishable from "said no" -
       * eligibility treats both as no, and only one of them is worth a
       * follow-up conversation later.
       *
       * transactionalEnabled is deliberately NOT set here. Absent means yes for
       * service messages, which is the rule smsEligibility already encodes; a
       * customer who wants those off opts out with STOP.
       */
      smsPreferences: smsMarketingConsent
        ? {
            marketingEnabled: true,
            marketingConsentAt: new Date(),
            marketingConsentSource: "signup_web_form",
          }
        : undefined,
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
        {
          bccAdmin: false,
          logContext: {
            userId: user._id,
            customerName: user.name || "",
            customerEmail: user.email,
            recipientName: user.name || "",
            recipientEmail: user.email,
            emailType: "transactional",
            source: "authRegister",
          },
        }
      );
    } catch (emailErr) {
      console.error("Welcome email failed after registration:", {
        userId: user.userId,
        message: emailErr.message,
      });
    }

    // The welcome text. Carries the STOP disclosure, because for most
    // customers this is the first message ProFixter ever sends them.
    await smsNotify.notifyAccountCreated(user, "authRegister");

    try {
      const primaryAddress = user.addresses?.[0];
      await sendAdminLeadNotification({
        leadId: String(user._id),
        leadType: "Website Registration",
        service: "Customer account registration",
        name: user.name,
        email: user.email,
        phone: user.phone,
        address: primaryAddress
          ? [
              primaryAddress.line1,
              primaryAddress.city,
              primaryAddress.state,
              primaryAddress.zip,
            ]
              .filter(Boolean)
              .join(", ")
          : [user.address, user.city, user.state, user.zip]
              .filter(Boolean)
              .join(", "),
        sourcePage: "/signup",
        submittedAt: user.createdAt,
      });
    } catch (emailErr) {
      console.error(
        "Registration admin notification failed; user was saved:",
        {
          userId: user.userId,
          message: emailErr.message,
        }
      );
    }

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: "30d" });

    const coverageMap = await buildPerAddressCoverage(user);

    return res.status(201).json({
      token,
      user: authUserDTO(user, coverageMap),
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

    /*
     * One email can now belong to a customer account and a separate Fixter
     * account, so the password is checked against every record on the address
     * and the one it actually opens is the one signed in to. An unqualified
     * findOne here would have picked whichever document Mongo returned first.
     */
    const candidates = await findUsersByEmail(cleanEmail);
    if (!candidates.length) return res.status(400).json({ message: "Invalid credentials" });

    const matches = [];
    for (const candidate of candidates) {
      if (!candidate.password) continue;
      if (await bcrypt.compare(password, candidate.password)) matches.push(candidate);
    }
    if (!matches.length) return res.status(400).json({ message: "Invalid credentials" });

    let user = matches[0];
    if (matches.length > 1) {
      // Both accounts share a password. Never guess which one was meant.
      const requested = String(req.body.accountRole || "").trim().toLowerCase();
      const chosen = matches.find((match) => accountKind(match) === requested);
      if (!chosen) {
        return res.status(409).json({
          message: "This email has more than one account. Choose which one to open.",
          code: "ACCOUNT_CHOICE_REQUIRED",
          accounts: matches.map((match) => ({
            accountRole: accountKind(match),
            label: accountChoiceLabel(match),
          })),
        });
      }
      user = chosen;
    }

    if (effectiveRole(user) === "employee" && user.isActive === false) {
      return res.status(403).json({ message: "Employee account is inactive" });
    }

    await ensurePrimaryFromLegacy(user);

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: "30d" });

    const coverageMap = await buildPerAddressCoverage(user);
    return res.json({
      token,
      user: authUserDTO(user, coverageMap),
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
    if (effectiveRole(user) === "employee" && user.isActive === false) {
      return res.status(403).json({ message: "Employee account is inactive" });
    }

    await ensurePrimaryFromLegacy(user);
    const coverageMap = await buildPerAddressCoverage(user);

    return res.json(authUserDTO(user, coverageMap));
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
    if (String(newPassword).length < 8) {
      return res.status(400).json({ message: "New password must be at least 8 characters" });
    }

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    const match = await bcrypt.compare(currentPassword, user.password);
    if (!match) {
      return res.status(400).json({ message: "Current password is incorrect" });
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    user.password = hashed;
    user.mustChangePassword = false;
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
    const { idToken, accessToken } = req.body;

    if (!idToken && !accessToken) {
      return res.status(400).json({ message: "Google token is required" });
    }

    let googleEmail = "";
    let googleName = "";
    let googleId = "";

    if (idToken) {
      const { OAuth2Client } = require("google-auth-library");
      const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

      let ticket;
      try {
        ticket = await client.verifyIdToken({
          idToken,
          audience: process.env.GOOGLE_CLIENT_ID,
        });
      } catch (error) {
        console.error("Google ID token verification failed:", error.message);
        return res.status(401).json({ message: "Invalid Google token" });
      }

      const payload = ticket.getPayload();
      googleEmail = String(payload.email || "").toLowerCase();
      googleName = payload.name || "";
      googleId = payload.sub || "";
    } else {
      const profileResponse = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!profileResponse.ok) {
        return res.status(401).json({ message: "Invalid Google token" });
      }

      const payload = await profileResponse.json();
      googleEmail = String(payload.email || "").toLowerCase();
      googleName = payload.name || "";
      googleId = payload.sub || "";
    }

    if (!googleEmail || !googleId) {
      return res.status(401).json({ message: "Google account profile is incomplete" });
    }

    // Google sign-in is the customer app's front door, so it resolves the
    // customer record. A Fixter account on the same address is not it, and
    // must not be handed a customer session.
    let user = await findCustomerByEmail(googleEmail);

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
        role: "customer",
        employeePosition: null,
        isActive: true,
        mustChangePassword: false,
      });

      await user.save();

      try {
        await mail.sendTx("welcome", user.email, { name: user.name }, {
          logContext: {
            userId: user._id,
            customerName: user.name || "",
            customerEmail: user.email,
            recipientName: user.name || "",
            recipientEmail: user.email,
            emailType: "transactional",
            source: "googleAuth",
          },
        });
      } catch (emailError) {
        console.log("Welcome email failed:", emailError.message);
      }

      // Google sign-up often has no phone number on the account; the
      // eligibility check records that as no_valid_phone and sends nothing.
      await smsNotify.notifyAccountCreated(user, "googleAuth");

      try {
        await sendAdminLeadNotification({
          leadId: String(user._id),
          leadType: "Google Registration",
          service: "Customer account registration",
          name: user.name,
          email: user.email,
          phone: user.phone,
          sourcePage: "/signin",
          submittedAt: user.createdAt,
        });
      } catch (emailError) {
        console.error(
          "Google registration admin notification failed; user was saved:",
          {
            userId: user.userId,
            message: emailError.message,
          }
        );
      }
    }

    if (effectiveRole(user) === "employee" && user.isActive === false) {
      return res.status(403).json({ message: "Employee account is inactive" });
    }

    const token = jwt.sign({ id: user._id, email: user.email }, process.env.JWT_SECRET, {
      expiresIn: "30d",
    });

    await ensurePrimaryFromLegacy(user);
    const coverageMap = await buildPerAddressCoverage(user);

    return res.json({
      token,
      user: authUserDTO(user, coverageMap),
    });
  } catch (error) {
    console.error("❌ Google OAuth Error:", error.stack || error.message);
    return res.status(500).json({ message: "Google authentication failed", error: error.message });
  }
});

module.exports = router;
