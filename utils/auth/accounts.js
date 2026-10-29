const jwt = require("jsonwebtoken");
const User = require("../../models/User");
const RepAttribution = require("../../models/RepAttribution");
const SiteVisitor = require("../../models/SiteVisitor");
const { normalizeEmail, normalizePhone } = require("../identity");
const { sanitizeAttribution } = require("../analytics/attribution");

/**
 * Who someone is, and creating them when they are new.
 *
 * THE ONE RULE: an existing account is only ever opened with a VERIFIED
 * identifier - a phone or email the person just proved with a code, or an
 * email a provider says it verified, or that provider's own stable id. A
 * number somebody once typed into a form is never enough on its own; those
 * accounts go through linking, where the person also proves something the
 * account already trusts.
 */

const ACCOUNT_TTL = "30d";
const LINK_TTL = "15m";

function notEmployee() {
  return { role: { $ne: "employee" } };
}

function tenDigits(e164) {
  return normalizePhone(e164) || "";
}

/**
 * Accounts that proved this phone. Usually one; a shared household handset can
 * legitimately have several, each person with their own account.
 */
async function findCustomersByVerifiedPhone(e164) {
  return User.find({ ...notEmployee(), phone: e164, phoneVerifiedAt: { $type: "date" } }).sort({ createdAt: 1 }).limit(10);
}

/** Short-lived proof of a phone, naming the accounts it may open. 10 minutes. */
function issueChoiceToken(e164, accountIds) {
  return jwt.sign({ typ: "phone_choice", phone: e164, ids: accountIds.map(String) }, process.env.JWT_SECRET, { expiresIn: "10m" });
}

function readChoiceToken(token) {
  try {
    const payload = jwt.verify(String(token || ""), process.env.JWT_SECRET);
    return payload?.typ === "phone_choice" && Array.isArray(payload.ids) ? payload : null;
  } catch {
    return null;
  }
}

/** Accounts that list this number without ever having proved it. */
async function findCustomersWithUnverifiedPhone(e164) {
  const ten = tenDigits(e164);
  return User.find({
    ...notEmployee(),
    $and: [
      { $or: [{ phoneVerifiedAt: null }, { phoneVerifiedAt: { $exists: false } }] },
      { $or: [{ phone: e164 }, ...(ten ? [{ "search.phone": ten }] : [])] },
    ],
  }).limit(5);
}

async function findCustomerByEmail(email) {
  const clean = normalizeEmail(email);
  if (!clean) return null;
  const users = await User.find({ email: clean });
  return users.find((user) => user.role !== "employee") || null;
}

/** The one place sessions are minted. "tv" lets a password reset end them all. */
function issueSession(user) {
  return jwt.sign({ id: user._id, tv: Number(user.tokenVersion || 0) }, process.env.JWT_SECRET, { expiresIn: ACCOUNT_TTL });
}

/** Whether a decoded session still belongs to the account's current sessions. */
function sessionIsCurrent(decoded, user) {
  return Number(decoded?.tv || 0) === Number(user?.tokenVersion || 0);
}

/** Proof that this browser controls a phone, for finishing a link. 15 minutes. */
function issueLinkToken(e164, consent = {}) {
  return jwt.sign(
    {
      typ: "phone_link",
      phone: e164,
      consent: { transactional: Boolean(consent.transactional), marketing: Boolean(consent.marketing) },
    },
    process.env.JWT_SECRET,
    { expiresIn: LINK_TTL }
  );
}

/** { phone, consent } from a valid link token, or null. */
function readLinkToken(token) {
  try {
    const payload = jwt.verify(String(token || ""), process.env.JWT_SECRET);
    if (payload?.typ !== "phone_link" || !payload.phone) return null;
    return { phone: payload.phone, consent: payload.consent || {} };
  } catch {
    return null;
  }
}

function addProvider(user, provider) {
  const current = Array.isArray(user.authProviders) ? user.authProviders : [];
  if (!current.includes(provider)) user.authProviders = [...current, provider];
}

/** Put a proved phone on an account. */
async function attachVerifiedPhone(user, e164) {
  /*
   * Never refused because another account holds the same number: a household
   * shares a handset. The phone was just proved by this person, for this
   * account, which is all verification means.
   */
  const alreadyVerifiedHere = user.phone === e164 && user.phoneVerifiedAt;
  user.phone = e164;
  if (!alreadyVerifiedHere) user.phoneVerifiedAt = new Date();
  addProvider(user, "phone");
  await user.save();
  return { ok: true };
}

async function attachVerifiedEmail(user, email) {
  const clean = normalizeEmail(email);
  const holder = await findCustomerByEmail(clean);
  if (holder && String(holder._id) !== String(user._id)) return { ok: false, code: "IDENTIFIER_IN_USE" };
  user.email = clean;
  user.emailVerifiedAt = new Date();
  addProvider(user, "email_code");
  await user.save();
  return { ok: true };
}

/* -------------------------------------------------------- lead matching */

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

/**
 * A field rep's cold lead who has now made an account. Moved here unchanged
 * from routes/auth.js so every way of signing up credits the rep the same way.
 */
async function markLeadRegistered(user) {
  try {
    const match = await findBestLeadMatch({ email: user.email, phone: user.phone });
    if (!match) return;
    match.matchedUserId = user._id;
    match.emailRaw = user.email || match.emailRaw;
    match.emailNormalized = normalizeEmail(user.email) || match.emailNormalized;
    match.phoneRaw = user.phone || match.phoneRaw;
    match.phoneNormalized = normalizePhone(user.phone) || match.phoneNormalized;
    if (!match.fullName && user.name) match.fullName = user.name;
    if (!match.cityAtAssignment && user.city) match.cityAtAssignment = user.city;
    if (!match.stateAtAssignment && user.state) match.stateAtAssignment = user.state;
    if (match.status !== "subscribed") match.status = "registered";
    if (match.conversionType === "none") match.conversionType = "registered";
    if (!match.registeredAt) match.registeredAt = new Date();
    match.lastSyncedAt = new Date();
    await match.save();
  } catch (error) {
    console.error("❌ markLeadRegistered failed:", error.message);
  }
}

/* ------------------------------------------------------ account creation */

const generateUserId = () => Math.floor(10000000 + Math.random() * 90000000).toString();

/**
 * Report a brand-new account to Meta, once.
 *
 * The same Lead (lead_type "account") the password sign-up has always sent,
 * sharing the browser's event id so Meta keeps one copy. Hashed contact data
 * goes only when we have it; a phone-only account still matches on phone and
 * external id.
 */
function reportAccountLead(user, { req, metaEventId, fbp, fbc, sourcePath = "/signup" } = {}) {
  try {
    const metaCapi = require("../metaCapi");
    const primary = user.addresses?.[0];
    metaCapi.sendDetached({
      eventName: "Lead",
      eventId: String(metaEventId || "") || undefined,
      eventSourceUrl: req?.headers?.referer || `${process.env.CLIENT_URL || ""}${sourcePath}`,
      customData: {
        content_name: "account_created",
        status: "new_account",
        lead_type: "account",
        signup_method: user.signupMethod || undefined,
        utm_source: user.attribution?.utmSource || undefined,
        utm_campaign: user.attribution?.utmCampaign || undefined,
      },
      user: {
        email: user.email || undefined,
        phone: user.phone || undefined,
        firstName: user.firstName || undefined,
        lastName: user.lastName || undefined,
        name: user.name || undefined,
      },
      address: primary ? { city: primary.city, state: primary.state, zip: primary.zip } : {},
      externalId: user.userId || String(user._id),
      fbp,
      fbc,
      fbclid: user.attribution?.fbclid,
      req,
    });
  } catch (error) {
    console.warn("Meta Lead dispatch failed:", error.message);
  }
}

/**
 * Everything a new account has always triggered, for every way of signing up.
 * Each step is best effort: a failed email must never undo an account.
 */
async function afterAccountCreated(user, { req, metaEventId, fbp, fbc, consents = null, sourcePath } = {}) {
  await markLeadRegistered(user);

  if (consents && user.phone) {
    try {
      const { recordConsent } = require("../consent/ledger");
      const { CURRENT } = require("../consent/consentText");
      const common = { user, channel: "sms", action: "granted", source: consents.source, phone: user.phone, email: user.email, req };
      if (consents.transactional) await recordConsent({ ...common, purpose: "service", version: CURRENT.signup.service, at: new Date() });
      if (consents.marketing) await recordConsent({ ...common, purpose: "marketing", version: CURRENT.signup.marketing, at: new Date() });
    } catch (error) {
      console.error("Consent ledger write failed:", error.message);
    }
  }

  if (user.attribution?.visitorId) {
    SiteVisitor.updateOne({ visitorId: user.attribution.visitorId, user: null }, { $set: { user: user._id } }).catch(() => {});
  }

  reportAccountLead(user, { req, metaEventId, fbp, fbc, sourcePath });

  if (user.email && !user.emailIsAppleRelay) {
    try {
      const mail = require("../emailService");
      await mail.sendTx("welcome", user.email, { name: user.name || "there", userId: user.userId }, {
        bccAdmin: false,
        logContext: {
          userId: user._id,
          customerName: user.name || "",
          customerEmail: user.email,
          recipientName: user.name || "",
          recipientEmail: user.email,
          emailType: "transactional",
          source: `signup_${user.signupMethod || "unknown"}`,
        },
      });
    } catch (error) {
      console.error("Welcome email failed:", error.message);
    }
  }

  // The welcome text; gated inside by the account's own service-text consent.
  try {
    await require("../sms/smsNotifications").notifyAccountCreated(user, `signup_${user.signupMethod || "unknown"}`);
  } catch (error) {
    console.error("Welcome SMS failed:", error.message);
  }

  try {
    const { sendAdminLeadNotification } = require("../adminLeadNotification");
    await sendAdminLeadNotification({
      leadId: String(user._id),
      leadType: "Website Registration",
      service: `Customer account (${user.signupMethod || "unknown"})`,
      name: user.name || "Not given yet",
      email: user.email || "Not given yet",
      phone: user.phone || "Not given yet",
      address: "Not given yet",
      sourcePage: sourcePath || "/signup",
      submittedAt: user.createdAt,
    });
  } catch (error) {
    console.error("Registration admin notification failed:", error.message);
  }
}

/**
 * Create a customer from what was just proved. No address, no password, no
 * plan: those are asked for when something actually needs them.
 */
async function createCustomer({
  signupMethod,
  phone = null,
  phoneVerified = false,
  email = null,
  emailVerified = false,
  emailIsAppleRelay = false,
  name = "",
  firstName = "",
  lastName = "",
  googleId = null,
  appleId = null,
  attribution = null,
  smsConsent = null,
}) {
  const now = new Date();
  const fullName = String(name || `${firstName} ${lastName}`).trim().slice(0, 120);
  const user = new User({
    userId: generateUserId(),
    name: fullName,
    firstName: String(firstName || "").slice(0, 60),
    lastName: String(lastName || "").slice(0, 60),
    role: "customer",
    employeePosition: null,
    isActive: true,
    mustChangePassword: false,
    addresses: [],
    defaultAddressId: null,
    signupMethod,
    authProviders: [signupMethod],
    termsAcceptedAt: now,
    termsVersion: require("../consent/consentText").CURRENT.continue_terms,
    ...(email ? { email: normalizeEmail(email), emailVerifiedAt: emailVerified ? now : null, emailIsAppleRelay } : {}),
    ...(phone ? { phone, phoneVerifiedAt: phoneVerified ? now : null } : {}),
    ...(googleId ? { googleId } : {}),
    ...(appleId ? { appleId } : {}),
    ...(smsConsent && (smsConsent.transactional || smsConsent.marketing)
      ? {
          smsPreferences: {
            ...(smsConsent.transactional
              ? { transactionalEnabled: true, transactionalConsentAt: now, transactionalConsentSource: smsConsent.source }
              : {}),
            ...(smsConsent.marketing
              ? { marketingEnabled: true, marketingConsentAt: now, marketingConsentSource: smsConsent.source }
              : {}),
          },
        }
      : {}),
  });
  const cleanAttribution = sanitizeAttribution(attribution);
  if (cleanAttribution) user.attribution = cleanAttribution;
  await user.save();
  return user;
}

/**
 * Turn an inbound duplicate-key error on create into the account that won.
 * Two taps on "verify" can race to create the same person.
 */
function isDuplicateKey(error) {
  return error?.code === 11000;
}

module.exports = {
  addProvider,
  afterAccountCreated,
  attachVerifiedEmail,
  attachVerifiedPhone,
  createCustomer,
  findBestLeadMatch,
  findCustomerByEmail,
  findCustomersByVerifiedPhone,
  issueChoiceToken,
  readChoiceToken,
  findCustomersWithUnverifiedPhone,
  generateUserId,
  isDuplicateKey,
  issueLinkToken,
  issueSession,
  sessionIsCurrent,
  markLeadRegistered,
  readLinkToken,
  reportAccountLead,
};
