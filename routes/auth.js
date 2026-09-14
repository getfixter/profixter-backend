const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Subscription = require("../models/Subscription");
const RepAttribution = require("../models/RepAttribution");
const { normalizeEmail, normalizePhone, normalizePhoneE164 } = require("../utils/identity");
const mail = require("../utils/emailService");
const smsNotify = require("../utils/sms/smsNotifications");
const {
  sendAdminLeadNotification,
} = require("../utils/adminLeadNotification");
const { subscriptionGrantsAccess } = require("../utils/subscriptionManagement");
const { activeGiftsByAddress } = require("../utils/gifts/giftAccess");
const { effectivePlansForUser } = require("../utils/loyalty/effectivePlan");
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
   * A Loyalty tier upgrade raises the plan this map reports, without anything
   * having changed in Stripe.
   *
   * This is the point of the whole entitlement layer. The customer keeps paying
   * for the plan they bought — subscriptionType is never written — but every
   * screen built on this map now describes the plan they are actually being
   * treated as having, which is what makes "complimentary Premium benefits"
   * mean something rather than being a line in an email.
   *
   * paidPlan is carried alongside so the account screen can say "complimentary
   * Premium through 14 October" rather than claiming they bought Premium.
   *
   * One query for the whole customer, and a failure degrades to the paid plan
   * rather than costing anybody their sign-in — coverage is rebuilt on every
   * /me, so one degraded request recovers by itself.
   */
  try {
    const paidPlanByAddress = new Map(
      Object.entries(map)
        .filter(([, entry]) => entry.source === "subscription")
        .map(([key, entry]) => [key, entry.plan])
    );

    if (paidPlanByAddress.size) {
      const effective = await effectivePlansForUser({ user: user._id, paidPlanByAddress });
      for (const [key, resolved] of effective) {
        if (!map[key] || resolved.source !== "loyalty") continue;
        map[key] = {
          ...map[key],
          plan: resolved.plan,
          paidPlan: resolved.paidPlan,
          loyaltyUpgrade: { plan: resolved.plan, until: resolved.until },
        };
      }
    }
  } catch (err) {
    console.error("buildPerAddressCoverage: loyalty lookup failed:", err);
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
    /*
     * The plan they PAY for, when Loyalty is temporarily giving them a higher
     * one. Null the rest of the time, so the common case is unchanged and the
     * UI can tell "you are Premium" from "we are treating you as Premium".
     */
    paidPlan: c.paidPlan || null,
    loyaltyUpgrade: c.loyaltyUpgrade || null,
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

    /*
     * The conversion is recorded HERE, in ProFixter, and nowhere else.
     *
     * This used to also push the conversion back into GoHighLevel, moving an
     * opportunity through a pipeline. That is gone: a registered ProFixter
     * customer no longer touches GHL for any reason, including attribution.
     *
     * Nothing about rep tracking is lost. The RepAttribution record above is
     * the source of truth and is saved before this point - status, timestamps
     * and commission are all computed and persisted in our own database. The
     * GHL half was only ever a mirror, and it had never once succeeded: every
     * one of the 31,180 attribution records still has a null ghlOpportunityId,
     * because the opportunity lookup always threw and the error was caught and
     * logged. Removing it changes no numbers.
     *
     * The lead record in GHL is left exactly as it is. A prospect who later
     * becomes a customer keeps their history over there; we simply stop
     * writing to it.
     */
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
     * The two SMS ticks, each read as the customer actually left it.
     *
     * Compared against the literal boolean rather than for truthiness, so that
     * "false", "0", "no" or any other string a future client sends cannot
     * become consent by accident - a string is always truthy, and that is
     * exactly the bug that would silently enrol somebody in texting they never
     * agreed to.
     *
     * THE ABSENCE OF EITHER FIELD IS NOT CONSENT, AND NEITHER IS A PHONE
     * NUMBER. Registration still requires a phone, because a Fixter has to be
     * able to ring the doorbell and call when they are outside. It is not
     * permission to text. Service texts and marketing texts each need their own
     * express opt-in, which is what these two are, and a customer who ticks
     * neither gets a working account that is simply never texted.
     */
    const smsTransactionalConsent = req.body?.smsTransactionalConsent === true;
    const smsMarketingConsent = req.body?.smsMarketingConsent === true;
    /**
     * The smsPreferences subdocument for the ticks we were given, or undefined.
     *
     * Built here rather than inline so that adding a third channel later means
     * adding a branch to one function instead of editing an object literal
     * buried in the middle of a 120-line constructor.
     */
    function smsConsentRecord() {
      const now = new Date();
      const record = {};
      if (smsTransactionalConsent) {
        record.transactionalEnabled = true;
        record.transactionalConsentAt = now;
        record.transactionalConsentSource = "signup_web_form";
      }
      if (smsMarketingConsent) {
        record.marketingEnabled = true;
        record.marketingConsentAt = now;
        record.marketingConsentSource = "signup_web_form";
      }
      return Object.keys(record).length ? record : undefined;
    }


    const cleanEmail = String(email || "").trim().toLowerCase();
    if (![name, cleanEmail, password, phone, address, city, state, zip, county].every(Boolean)) {
      return res.status(400).json({
        message:
          "All fields are required: name, email, password, phone, address, city, state, zip, county",
      });
    }

    /*
     * SERVICE SMS IS NOW A CONDITION OF REGISTRATION, ENFORCED HERE.
     *
     * Enforced on the server because a checkbox is a suggestion: the browser
     * form can be bypassed by anyone willing to POST this endpoint directly,
     * and an account created that way would otherwise be texted on the
     * strength of a tick nobody made. The frontend blocks the button; this
     * blocks the request.
     *
     * Still compared against the literal boolean. A string is always truthy,
     * and "false" arriving as consent is precisely the bug that would enrol
     * somebody in texting they never agreed to - required or not, the tick has
     * to be a real tick.
     *
     * MARKETING IS DELIBERATELY NOT CHECKED HERE and must never be added to
     * this condition. It stays optional, independent, and absent unless the
     * customer ticks its own box.
     */
    if (req.body?.smsTransactionalConsent !== true) {
      return res.status(400).json({
        message:
          "Please agree to receive ProFixter service text messages to create your account.",
        code: "SERVICE_SMS_CONSENT_REQUIRED",
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
       * transactionalEnabled and marketingEnabled are the two fields
       * smsEligibility reads before any send. The timestamp and source beside
       * each one are the evidence that consent was given, which is the half
       * that matters if it is ever disputed.
       *
       * A box left unticked writes nothing at all rather than writing false, so
       * "never asked" stays distinguishable from "said no" forever. Eligibility
       * treats both as no; only one of them is worth a follow-up conversation.
       *
       * When neither box is ticked this is undefined and the account has no
       * smsPreferences subdocument, which is exactly what an account created
       * before any of this existed looks like. Both are read as off, which is
       * the correct and honest answer for a customer who never opted in.
       */
      smsPreferences: smsConsentRecord(),
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

    /*
     * A NEW CUSTOMER IS NOT COPIED INTO GOHIGHLEVEL ANY MORE.
     *
     * This block used to create a GHL contact from the name, email and phone
     * somebody had just typed into ProFixter, then tag it website_registered -
     * which is what made GHL send the welcome text. Registered customers now
     * live in ProFixter's database and are reached by ProFixter's own email
     * and, once it is switched on, ProFixter's own Twilio number.
     *
     * GHL keeps doing the one job it is genuinely good at: independent cold
     * leads and prospects that have nothing to do with an account here.
     */
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
/*
 * Exported so the membership question has one answer.
 * Recent Work gates member uploads on live cover, and re-deriving that from
 * Subscription rows elsewhere is how the gift-holder bug got written the first
 * time. Attaching it to the router keeps the route file the owner.
 */
module.exports.buildPerAddressCoverage = buildPerAddressCoverage;
