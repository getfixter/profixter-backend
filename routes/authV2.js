const express = require("express");
const { linkGuestFreeVisitsQuietly } = require("../utils/freeVisit/guestLink");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const { normalizeEmail, normalizePhoneE164 } = require("../utils/identity");
const { OtpError, startChallenge, verifyChallenge } = require("../utils/auth/otpService");
const { OtpDeliveryError } = require("../utils/auth/otpDelivery");
const { ProviderTokenError, verifyAppleIdToken } = require("../utils/auth/providerTokens");
const accounts = require("../utils/auth/accounts");
const temporaryPassword = require("../utils/auth/temporaryPassword");
const { clientIp } = require("../utils/auth/clientIp");

const router = express.Router();

/**
 * Registration & sign-in 2.0: phone code, email code, Apple.
 *
 * Mounted beside routes/auth.js at /api/auth. Every path ends the same way -
 * a normal 30-day session, exactly what password sign-in issues - so nothing
 * else in the app needs to know how somebody signed in.
 *
 * Tests inject delivery and provider checks through `router.deps`, so the
 * suite never sends a text or calls Apple.
 */
router.deps = { deliver: null, checkRemote: null, fetchAppleKeys: null };

/* ---------------------------------------------------------------- helpers */


function maskEmail(value) {
  const email = String(value || "");
  const at = email.lastIndexOf("@");
  if (at < 1) return null;
  const local = email.slice(0, at);
  return `${local.slice(0, Math.min(2, local.length))}${"•".repeat(Math.max(3, Math.min(local.length - 2, 6)))}${email.slice(at)}`;
}

function maskPhone(e164) {
  const digits = String(e164 || "").replace(/\D/g, "");
  return digits.length >= 4 ? `••• ••• ${digits.slice(-4)}` : "";
}

const MESSAGES = {
  INVALID_PHONE: "Enter a valid US mobile number.",
  INVALID_EMAIL: "Enter a valid email address.",
  SERVICE_SMS_CONSENT_REQUIRED: "Please agree to receive ProFixter service text messages to continue with your phone.",
  RATE_LIMITED: "Too many tries. Please wait a moment and try again.",
  SMS_UNAVAILABLE: "We can't send texts right now. Please continue with email instead.",
  SMS_OPTED_OUT: "This number has opted out of our texts. Reply START to our number to opt back in, or continue with email.",
  INVALID_CODE: "That code isn't right.",
  CODE_EXPIRED: "That code has expired. Send a new one.",
  IDENTIFIER_IN_USE: "That is already used by another Profixter account.",
  LINK_EXPIRED: "That took a little too long. Please verify your phone again.",
  SIGN_IN_REQUIRED: "Please sign in first.",
  REAUTH_REQUIRED: "Please confirm it's you first.",
  REAUTH_UNAVAILABLE: "We can't confirm it's you online. Please call 631-599-1363 and we'll help.",
  APPLE_NOT_CONFIGURED: "Sign in with Apple isn't available right now.",
  INVALID_PROVIDER_TOKEN: "We couldn't confirm that sign-in. Please try again.",
};

function sendError(res, error) {
  const code = error?.code;
  const status =
    code === "RATE_LIMITED" ? 429
      : code === "SMS_UNAVAILABLE" || code === "APPLE_NOT_CONFIGURED" ? 503
        : code === "IDENTIFIER_IN_USE" ? 409
          : code === "INVALID_PROVIDER_TOKEN" || code === "SIGN_IN_REQUIRED" ? 401
            : code === "REAUTH_REQUIRED" ? 403
            : code && MESSAGES[code] ? 400
              : 500;
  if (status === 500) console.error("auth v2 error:", error?.stack || error?.message);
  return res.status(status).json({
    code: code && MESSAGES[code] ? code : "AUTH_FAILED",
    message: MESSAGES[code] || "Something went wrong. Please try again.",
    ...(error?.attemptsLeft !== undefined && error.attemptsLeft !== null ? { attemptsLeft: error.attemptsLeft } : {}),
    ...(error?.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
  });
}

class AuthFlowError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/** The signed-in account for "attach" requests, or throws. */
async function requireSignedInUser(req) {
  const header = String(req.headers.authorization || "");
  const token = header.startsWith("Bearer ") ? header.slice(7) : req.headers["x-auth-token"];
  if (!token) throw new AuthFlowError("SIGN_IN_REQUIRED");
  let payload;
  try {
    payload = jwt.verify(String(token), process.env.JWT_SECRET);
  } catch {
    throw new AuthFlowError("SIGN_IN_REQUIRED");
  }
  const user = await User.findById(payload?.id);
  if (!user || user.role === "employee") throw new AuthFlowError("SIGN_IN_REQUIRED");
  if (!accounts.sessionIsCurrent(payload, user)) throw new AuthFlowError("SIGN_IN_REQUIRED");
  return user;
}

async function sessionResponse(user, { created = false, extra = {} } = {}) {
  // An earlier callback request with this proved phone or email joins the account.
  await linkGuestFreeVisitsQuietly(user);
  // A code or Apple just proved the account: an Admin-issued temporary password is no longer needed.
  await temporaryPassword.retireAfterOtherSignIn(user);
  const { authUserDTO, buildPerAddressCoverage } = require("./auth");
  const coverage = await buildPerAddressCoverage(user);
  return { status: "signed_in", token: accounts.issueSession(user), user: authUserDTO(user, coverage), created, ...extra };
}

async function userDTO(user) {
  const { authUserDTO, buildPerAddressCoverage } = require("./auth");
  return authUserDTO(user, await buildPerAddressCoverage(user));
}

function trackingFrom(req) {
  return {
    req,
    metaEventId: req.body?.metaEventId,
    fbp: req.body?.fbp,
    fbc: req.body?.fbc,
  };
}

/* ------------------------------------------------------------ phone code */

/* ------------------------------------------------- confirm it's you */

/*
 * Replacing an email or phone the account has already VERIFIED is the step
 * that turns a borrowed session into a stolen account, so it needs more than
 * the session itself: either a session that was signed into in the last ten
 * minutes, or a fresh code to a contact the account already trusts
 * (POST /reauth/start + /reauth/verify, which returns a ten-minute token).
 * Adding a missing email or phone, or re-verifying the same one, needs neither.
 */
const REAUTH_TTL_S = 10 * 60;
const FRESH_SESSION_MS = 10 * 60 * 1000;

function sessionToken(req) {
  const header = String(req.headers.authorization || "");
  return header.startsWith("Bearer ") ? header.slice(7) : String(req.headers["x-auth-token"] || "");
}

function recentlyConfirmed(req, user) {
  try {
    const session = jwt.verify(sessionToken(req), process.env.JWT_SECRET);
    if (session?.iat && Date.now() - session.iat * 1000 <= FRESH_SESSION_MS) return true;
  } catch {
    /* requireSignedInUser already refused a bad session */
  }
  const token = String(req.body?.reauthToken || "");
  if (!token) return false;
  try {
    const proof = jwt.verify(token, process.env.JWT_SECRET);
    return proof?.purpose === "reauth" && String(proof.id) === String(user._id) && accounts.sessionIsCurrent(proof, user);
  } catch {
    return false;
  }
}

/* Where a confirmation code can go: only a contact this account has already verified. */
function reauthTarget(user, channel) {
  if (channel === "sms") return user.phoneVerifiedAt && normalizePhoneE164(user.phone) ? normalizePhoneE164(user.phone) : "";
  return user.emailVerifiedAt && normalizeEmail(user.email) && !user.emailIsAppleRelay ? normalizeEmail(user.email) : "";
}

router.post("/reauth/start", async (req, res) => {
  try {
    const user = await requireSignedInUser(req);
    const channel = req.body?.channel === "email" ? "email" : "sms";
    const target = reauthTarget(user, channel);
    if (!target) throw new AuthFlowError("REAUTH_UNAVAILABLE");
    const result = await startChallenge({
      channel,
      target,
      purpose: "reauth",
      consent: { transactional: false, marketing: false },
      ip: clientIp(req),
      deliver: router.deps.deliver,
    });
    return res.json({ ok: true, channel, destination: channel === "sms" ? maskPhone(target) : maskEmail(target), ...result });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/reauth/verify", async (req, res) => {
  try {
    const user = await requireSignedInUser(req);
    const channel = req.body?.channel === "email" ? "email" : "sms";
    const target = reauthTarget(user, channel);
    if (!target) throw new AuthFlowError("REAUTH_UNAVAILABLE");
    await verifyChallenge({
      channel,
      target,
      code: req.body?.code,
      purpose: "reauth",
      ip: clientIp(req),
      checkRemote: router.deps.checkRemote,
    });
    const reauthToken = jwt.sign({ id: String(user._id), tv: Number(user.tokenVersion || 0), purpose: "reauth" }, process.env.JWT_SECRET, {
      expiresIn: REAUTH_TTL_S,
    });
    return res.json({ ok: true, reauthToken, expiresInSeconds: REAUTH_TTL_S });
  } catch (error) {
    return sendError(res, error);
  }
});

/*
 * The optional boxes on the "Add your mobile number" screen
 * (FrontEnd ContactCompletion): "Text me ProFixter offers, too." and, when the
 * number is being changed, "Text me about my ProFixter visits".
 *
 * Recorded only here, after the code proved the number belongs to the person
 * who ticked the box - and only for what was ticked: verifying a phone is never
 * consent (A2P 30923). Literal true only. A STOP from that handset outranks a
 * website box: nothing is switched on, the STOP row is left alone, and the
 * screen says so. Email choices are never touched.
 */
async function applyPhoneOptIn(user, phone, choice, req) {
  const marketing = choice?.marketing === true;
  const service = choice?.service === true;
  if (!marketing && !service) return { marketing: false, service: false };
  const { optOutFor } = require("../utils/sms/smsEligibility");
  if (await optOutFor(phone)) {
    console.log(JSON.stringify({ event: "phone_optin_blocked_by_stop", userId: String(user._id), marketing, service }));
    return { marketing: false, service: false, blocked: "stopped" };
  }
  const { recordConsent } = require("../utils/consent/ledger");
  const { CURRENT } = require("../utils/consent/consentText");
  const now = new Date();
  const set = {};
  const unset = {};
  if (marketing) {
    set["smsPreferences.marketingEnabled"] = true;
    set["smsPreferences.marketingConsentAt"] = now;
    set["smsPreferences.marketingConsentSource"] = "phone_verification";
    // The customer's own act replaces any staff-recorded basis.
    unset["smsPreferences.marketingConsentMethod"] = "";
    unset["smsPreferences.marketingConsentEvidence"] = "";
    unset["smsPreferences.marketingConsentRecordedBy"] = "";
  }
  if (service) {
    set["smsPreferences.transactionalEnabled"] = true;
    set["smsPreferences.transactionalConsentAt"] = now;
    set["smsPreferences.transactionalConsentSource"] = "phone_verification";
  }
  await User.updateOne({ _id: user._id }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) });
  for (const [purpose, on] of [["marketing", marketing], ["service", service]]) {
    if (!on) continue;
    await recordConsent({
      user: user._id,
      channel: "sms",
      purpose,
      action: "granted",
      source: "phone_verification",
      version: CURRENT.phone_verify[purpose],
      phone,
      req,
      at: now,
    });
  }
  console.log(JSON.stringify({ event: "sms_preference_changed", userId: String(user._id), changed: { ...(marketing ? { marketingEnabled: true } : {}), ...(service ? { transactionalEnabled: true } : {}) }, source: "phone_verification" }));
  return { marketing, service };
}

/*
 * A customer changed their own verified email or phone: the account history
 * Admin reads (Customer details → edit history), and a notice to the email the
 * account had before, so its owner hears about it even if they did not do it.
 */
async function recordContactChange(req, user, { field, from, to }) {
  const { maskEmail: maskE, maskPhone: maskP } = require("../utils/customerProfileEdit");
  const mask = field === "phone" ? maskP : maskE;
  const label = field === "phone" ? "Phone" : "Email";
  try {
    const AdminActivityLog = require("../models/AdminActivityLog");
    await AdminActivityLog.create({
      action: "Customer Profile Updated",
      entityType: "User",
      entityId: String(user._id),
      entityName: user.name || maskE(user.email) || user.userId || "",
      actorUserId: user._id,
      actorName: user.name || "Customer",
      actorRole: "customer",
      details: {
        selfService: true,
        changes: [{ field, label, from: mask(from), to: mask(to), sensitive: true }],
        ownerOnly: { changes: [{ field, label, from, to }] },
      },
      ipAddress: String(req.headers?.["x-forwarded-for"] || req.ip || "").split(",")[0].trim(),
    });
  } catch (error) {
    console.error("Contact change history write failed:", error.message);
  }
  console.log(JSON.stringify({ event: "account_contact_changed", userId: String(user._id), field, source: "self_service" }));
  const noticeTo = field === "email" ? from : user.email;
  if (noticeTo && !user.emailIsAppleRelay) {
    const { sendTx } = require("../utils/emailService");
    sendTx("account_contact_changed", noticeTo, { name: user.name || "there", field, maskedNew: mask(to) }, {
      bccAdmin: false,
      logContext: { userId: user._id, customerName: user.name || "", recipientEmail: noticeTo, emailType: "security", source: "self_service_contact_change" },
    }).catch((error) => console.error("Contact change notice failed:", error.message));
  }
}

/*
 * A marketing unsubscribe (or a manual block) is the PERSON's choice, so it
 * follows them to their new address - the same rule Admin's edit applies.
 * Bounces and complaints describe the old mailbox and stay with it.
 */
async function carryEmailChoices(previousEmail, nextEmail) {
  if (!previousEmail || !nextEmail || previousEmail === nextEmail) return;
  try {
    const EmailSuppression = require("../models/EmailSuppression");
    const row = await EmailSuppression.findOne({ email: previousEmail }).lean();
    if (row && EmailSuppression.isActive(row) && ["unsubscribe", "manual_blacklist"].includes(row.reason)) {
      await EmailSuppression.updateOne(
        { email: nextEmail },
        {
          $setOnInsert: {
            email: nextEmail,
            reason: row.reason,
            source: "self_service_email_change",
            detail: "carried over from the customer's previous email",
            suppressedAt: new Date(),
          },
        },
        { upsert: true }
      );
    }
  } catch (error) {
    console.error("Suppression carry-over failed:", error.message);
  }
}

router.post("/otp/phone/start", async (req, res) => {
  try {
    const phone = normalizePhoneE164(req.body?.phone);
    if (!phone) throw new AuthFlowError("INVALID_PHONE");
    /*
     * No text consent is asked for here. The person is requesting ONE
     * verification code for themselves, sent through Twilio Verify (outside
     * the A2P campaign). Ongoing service texts and offers are separate,
     * optional choices made later - never implied by signing up.
     */
    const result = await startChallenge({
      channel: "sms",
      target: phone,
      consent: { transactional: false, marketing: false },
      ip: clientIp(req),
      deliver: router.deps.deliver,
    });
    return res.json({ ok: true, phoneMasked: maskPhone(phone), ...result });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/otp/phone/verify", async (req, res) => {
  try {
    const phone = normalizePhoneE164(req.body?.phone);
    if (!phone) throw new AuthFlowError("INVALID_PHONE");
    const attach = req.body?.mode === "attach";
    const signedIn = attach ? await requireSignedInUser(req) : null;
    const changing = Boolean(attach && signedIn.phoneVerifiedAt && normalizePhoneE164(signedIn.phone) && normalizePhoneE164(signedIn.phone) !== phone);
    // Checked before the code is spent, so a refused change costs the customer nothing.
    if (changing && !recentlyConfirmed(req, signedIn)) throw new AuthFlowError("REAUTH_REQUIRED");
    const { consent } = await verifyChallenge({
      channel: "sms",
      target: phone,
      code: req.body?.code,
      ip: clientIp(req),
      checkRemote: router.deps.checkRemote,
    });

    if (attach) {
      const attached = await accounts.attachVerifiedPhone(signedIn, phone);
      if (!attached.ok) throw new AuthFlowError(attached.code);
      const smsOptIn = await applyPhoneOptIn(signedIn, phone, req.body?.smsOptIn, req);
      if (changing) await recordContactChange(req, signedIn, { field: "phone", from: attached.previousPhone, to: phone });
      await linkGuestFreeVisitsQuietly(signedIn);
      const fresh = await User.findById(signedIn._id);
      return res.json({ status: "attached", user: await userDTO(fresh || signedIn), smsOptIn, consentReset: attached.consentReset || null });
    }

    // 1. Accounts that already proved this phone: sign in, or choose when a
    //    household shares the handset.
    const verified = await accounts.findCustomersByVerifiedPhone(phone);
    if (verified.length === 1) {
      accounts.addProvider(verified[0], "phone");
      await verified[0].save();
      return res.json(await sessionResponse(verified[0]));
    }
    if (verified.length > 1) return res.json(chooseAccountResponse(phone, verified));

    // 2. Accounts that only TYPED this number: never opened on the phone alone.
    const typed = await accounts.findCustomersWithUnverifiedPhone(phone);
    if (typed.length) {
      const only = typed.length === 1 ? typed[0] : null;
      return res.json({
        status: "link_required",
        linkToken: accounts.issueLinkToken(phone, consent),
        hint: { maskedEmail: only ? maskEmail(only.email) : null, hasPassword: Boolean(only?.password) },
      });
    }

    // 3. Nobody: a new, phone-verified customer.
    return res.json(await createPhoneCustomer(req, phone, consent));
  } catch (error) {
    return sendError(res, error);
  }
});

function chooseAccountResponse(phone, users) {
  return {
    status: "choose_account",
    choiceToken: accounts.issueChoiceToken(phone, users.map((user) => user._id)),
    accounts: users.map((user) => ({
      id: String(user._id),
      label: String(user.name || "").trim().split(/\s+/)[0] || maskEmail(user.email) || "Profixter account",
      detail: maskEmail(user.email) || `Since ${new Date(user.createdAt).getFullYear()}`,
    })),
  };
}

/*
 * A code can only be redeemed once (verifyChallenge claims it atomically), so
 * two taps cannot create two accounts for one sign-up.
 */
async function createPhoneCustomer(req, phone, consent = {}) {
  const user = await accounts.createCustomer({
    signupMethod: "phone",
    phone,
    phoneVerified: true,
    attribution: req.body?.attribution,
    smsConsent: { transactional: Boolean(consent.transactional), marketing: Boolean(consent.marketing), source: "signup_phone_code" },
  });
  await accounts.afterAccountCreated(user, {
    ...trackingFrom(req),
    consents: { transactional: Boolean(consent.transactional), marketing: Boolean(consent.marketing), source: "signup_phone_code" },
  });
  return sessionResponse(user, { created: true });
}

/**
 * "This isn't my account": the phone is proved, the existing record that typed
 * it stays untouched, and this person gets their own account.
 */
router.post("/otp/phone/new-account", async (req, res) => {
  try {
    const link = accounts.readLinkToken(req.body?.linkToken);
    if (!link) throw new AuthFlowError("LINK_EXPIRED");
    return res.json(await createPhoneCustomer(req, link.phone, link.consent));
  } catch (error) {
    return sendError(res, error);
  }
});

/** Which account to open, when a household shares one verified handset. */
router.post("/otp/phone/choose", async (req, res) => {
  try {
    const choice = accounts.readChoiceToken(req.body?.choiceToken);
    if (!choice) throw new AuthFlowError("LINK_EXPIRED");
    const id = String(req.body?.accountId || "");
    if (!choice.ids.includes(id)) throw new AuthFlowError("LINK_EXPIRED");
    const user = await User.findOne({ _id: id, phone: choice.phone, phoneVerifiedAt: { $type: "date" }, role: { $ne: "employee" } });
    if (!user) throw new AuthFlowError("LINK_EXPIRED");
    accounts.addProvider(user, "phone");
    await user.save();
    return res.json(await sessionResponse(user));
  } catch (error) {
    return sendError(res, error);
  }
});

/* ------------------------------------------------------------ email code */

router.post("/otp/email/start", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AuthFlowError("INVALID_EMAIL");
    // Adding or changing the email on a signed-in account: never send a code for an address another account uses.
    if (req.body?.mode === "attach") {
      const signedIn = await requireSignedInUser(req);
      const holder = await accounts.findCustomerByEmail(email);
      if (holder && String(holder._id) !== String(signedIn._id)) throw new AuthFlowError("IDENTIFIER_IN_USE");
    }
    const result = await startChallenge({ channel: "email", target: email, ip: clientIp(req), deliver: router.deps.deliver });
    return res.json({ ok: true, emailMasked: maskEmail(email), ...result });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/otp/email/verify", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!email) throw new AuthFlowError("INVALID_EMAIL");
    const attach = req.body?.mode === "attach";
    const signedIn = attach ? await requireSignedInUser(req) : null;
    const link = req.body?.linkToken ? accounts.readLinkToken(req.body.linkToken) : null;
    if (req.body?.linkToken && !link) throw new AuthFlowError("LINK_EXPIRED");
    const changing = Boolean(attach && signedIn.emailVerifiedAt && normalizeEmail(signedIn.email) && normalizeEmail(signedIn.email) !== email);
    if (changing && !recentlyConfirmed(req, signedIn)) throw new AuthFlowError("REAUTH_REQUIRED");
    // Refused before the code is spent: an address another account uses is never moved.
    if (attach) {
      const holder = await accounts.findCustomerByEmail(email);
      if (holder && String(holder._id) !== String(signedIn._id)) throw new AuthFlowError("IDENTIFIER_IN_USE");
    }

    await verifyChallenge({ channel: "email", target: email, code: req.body?.code, ip: clientIp(req) });

    if (attach) {
      const attached = await accounts.attachVerifiedEmail(signedIn, email);
      if (!attached.ok) throw new AuthFlowError(attached.code);
      if (changing) {
        await carryEmailChoices(attached.previousEmail, email);
        await recordContactChange(req, signedIn, { field: "email", from: attached.previousEmail, to: email });
      }
      await linkGuestFreeVisitsQuietly(signedIn);
      return res.json({ status: "attached", user: await userDTO(signedIn) });
    }

    /*
     * Proving the inbox is the same proof a password reset accepts, so it
     * opens the account that owns this email. With a link token it also proves
     * the phone, and the two are joined.
     */
    const existing = await accounts.findCustomerByEmail(email);
    if (existing) {
      if (!existing.emailVerifiedAt) existing.emailVerifiedAt = new Date();
      accounts.addProvider(existing, "email_code");
      await existing.save();
      let linkedPhone = false;
      if (link) linkedPhone = (await accounts.attachVerifiedPhone(existing, link.phone)).ok;
      return res.json(await sessionResponse(existing, { extra: { linkedPhone } }));
    }

    let user;
    try {
      user = await accounts.createCustomer({
        signupMethod: "email_code",
        email,
        emailVerified: true,
        attribution: req.body?.attribution,
      });
    } catch (error) {
      if (!accounts.isDuplicateKey(error)) throw error;
      const winner = await accounts.findCustomerByEmail(email);
      if (!winner) throw error;
      return res.json(await sessionResponse(winner));
    }
    let linkedPhone = false;
    if (link) linkedPhone = (await accounts.attachVerifiedPhone(user, link.phone)).ok;
    await accounts.afterAccountCreated(user, { ...trackingFrom(req) });
    return res.json(await sessionResponse(user, { created: true, extra: { linkedPhone } }));
  } catch (error) {
    return sendError(res, error);
  }
});

/* ------------------------------------------------------------------ Apple */

router.post("/apple", async (req, res) => {
  try {
    const identity = await verifyAppleIdToken(String(req.body?.idToken || ""), {
      rawNonce: req.body?.rawNonce,
      fetchKeys: router.deps.fetchAppleKeys,
    });
    const firstName = String(req.body?.name?.firstName || "").trim().slice(0, 60);
    const lastName = String(req.body?.name?.lastName || "").trim().slice(0, 60);

    // Apple's stable id first: it survives a hidden or changed email.
    let user = await User.findOne({ appleId: identity.sub, role: { $ne: "employee" } });
    if (!user && identity.email && !identity.emailIsRelay) {
      user = await accounts.findCustomerByEmail(identity.email);
      if (user) {
        user.appleId = identity.sub;
        if (!user.emailVerifiedAt) user.emailVerifiedAt = new Date();
      }
    }
    if (user) {
      if (!user.name && (firstName || lastName)) {
        user.name = `${firstName} ${lastName}`.trim();
        user.firstName = user.firstName || firstName;
        user.lastName = user.lastName || lastName;
      }
      accounts.addProvider(user, "apple");
      await user.save();
      return res.json(await sessionResponse(user));
    }

    let created;
    try {
      created = await accounts.createCustomer({
        signupMethod: "apple",
        appleId: identity.sub,
        email: identity.email || null,
        emailVerified: Boolean(identity.email),
        emailIsAppleRelay: identity.emailIsRelay,
        firstName,
        lastName,
        attribution: req.body?.attribution,
      });
    } catch (error) {
      if (!accounts.isDuplicateKey(error)) throw error;
      const winner = await User.findOne({ appleId: identity.sub });
      if (!winner) throw error;
      return res.json(await sessionResponse(winner));
    }
    await accounts.afterAccountCreated(created, { ...trackingFrom(req) });
    return res.json(await sessionResponse(created, { created: true }));
  } catch (error) {
    if (error instanceof ProviderTokenError) return sendError(res, error);
    return sendError(res, error);
  }
});

router.AuthFlowError = AuthFlowError;
router.errorTypes = { OtpError, OtpDeliveryError };
module.exports = router;
