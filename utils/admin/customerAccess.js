const User = require("../../models/User");
const mail = require("../emailService");
const { sendTransactionalSms } = require("../sms/smsService");
const { normalizeEmail, normalizePhoneE164 } = require("../identity");
const { generateUserId } = require("../auth/accounts");
const temporaryPassword = require("../auth/temporaryPassword");
const { buildAddress, MAX_ADDRESSES, cleanText, maskEmail } = require("../customerProfileEdit");
const { setCommunicationPreference } = require("./communicationControls");

/**
 * Admin signs a caller up: a complete, active customer account, no codes.
 *
 * The owner's assisted sign-up (2026-10-30). What it deliberately does NOT do:
 *  - stamp phoneVerifiedAt / emailVerifiedAt. Those are proof the PERSON
 *    controls the identifier; staff typing it in is not that, and phone/email
 *    code sign-in into an existing account depends on the stamps meaning it;
 *  - stamp termsAcceptedAt. The customer has not accepted anything yet;
 *  - merge with, or adopt, an existing account. An email already registered is
 *    refused and the existing account is pointed to; a phone already on a
 *    customer account needs Admin to confirm it is a different person.
 *
 * The welcome email and text tell the customer how in: their mobile number
 * and a code (2026-11-20; routes/authV2.js signs a staff-typed number in
 * directly). No temporary password is issued any more; one issued before
 * still retires at the first code sign-in (utils/auth/temporaryPassword.js).
 */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_KEY = "admin_account_created";
// Texts are never assumed (2026-11-03): staff answer the service-text question, and a call never qualifies marketing texts.
const DEFAULT_COMMUNICATION = { "service.sms": false, "service.email": true, "marketing.sms": false, "marketing.email": true };

class CustomerAccessError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

function firstNameOf(user) {
  const first = String(user.firstName || user.name || "").trim().split(/\s+/)[0] || "";
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : "there";
}


function renderAccessEmail({ user }) {
  const signIn = "https://www.profixter.com/signin";
  const e = mail.escapeHtml;
  const p = (t) => `<p style="margin:0 0 16px;">${t}</p>`;
  /*
   * 2026-11-20: no password at all. Staff typed this address, so it carries
   * nothing that opens the account: the way in is a code to the customer's phone.
   */
  const how = "To sign in, choose Sign in and enter your mobile number. We'll text you a code - that's all you need.";
  const html = mail.frame(
    `${p(`Hi ${e(firstNameOf(user))},`)}
     ${p("Your Profixter account has been created, as we discussed on the phone.")}
     ${p(how)}
     ${mail.btn(signIn, "Sign in")}
     <p style="margin:20px 0 0;">The Profixter Team<br/><a href="https://www.profixter.com">https://www.profixter.com</a></p>`,
    { preheader: "Sign in with your mobile number." }
  );
  const text = [
    `Hi ${firstNameOf(user)},`,
    "Your Profixter account has been created, as we discussed on the phone.",
    how,
    `Sign in: ${signIn}`,
    "The Profixter Team\nhttps://www.profixter.com",
  ].join("\n\n");
  return { subject: "Your Profixter account is ready", html, text };
}

/**
 * Send the sign-in details once for this issue of the temporary password.
 * The SMS dedupe key carries the issue time, so a retry of the same issue
 * cannot text twice while a deliberate resend (a new issue) can.
 */
async function sendAccessDetails(user, { deps = {} } = {}) {
  const sendEmail = deps.sendRaw || mail.sendRaw;
  const sendSms = deps.sendTransactionalSms || sendTransactionalSms;
  // Each send is its own (a resend is deliberate); the key only stops a retry of this one from texting twice.
  const issuedAt = Date.now();
  const result = { email: null, sms: null };

  if (user.email) {
    try {
      const { subject, html, text } = renderAccessEmail({ user });
      await sendEmail({
        to: user.email,
        subject,
        html,
        text,
        bccAdmin: false,
        logContext: {
          templateKey: EMAIL_KEY,
          userId: user._id,
          customerName: user.name || "",
          customerEmail: user.email,
          recipientName: user.name || "",
          recipientEmail: user.email,
          emailType: "security",
          source: "adminCustomerCreate",
        },
      });
      result.email = "sent";
      await User.updateOne({ _id: user._id }, { $set: { "adminCreated.accessEmailSentAt": new Date() } });
    } catch (error) {
      result.email = `failed: ${String(error?.message || error).slice(0, 120)}`;
    }
  }

  if (user.phone) {
    try {
      const sms = await sendSms({
        notificationType: "ADMIN_ACCOUNT_CREATED",
        dedupeKey: `ADMIN_ACCOUNT_CREATED:${user._id}:${issuedAt}`,
        user,
        phone: user.phone,
        vars: { name: user.name },
        source: "adminCustomerCreate",
      });
      result.sms = String(sms?.status || "unknown");
      if (sms?.ok) await User.updateOne({ _id: user._id }, { $set: { "adminCreated.accessSmsSentAt": new Date() } });
    } catch (error) {
      result.sms = `failed: ${String(error?.message || error).slice(0, 120)}`;
    }
  }
  return result;
}

function readNames(body) {
  const firstName = cleanText(body.firstName, 60);
  const lastName = cleanText(body.lastName, 60);
  return { firstName, lastName, name: `${firstName} ${lastName}`.trim() };
}

/** Check the request and say what is wrong, field by field, before anything is written. */
async function validateNewCustomer(body) {
  const errors = {};
  const { firstName, lastName, name } = readNames(body);
  if (!firstName) errors.firstName = "Enter the first name.";
  if (!lastName) errors.lastName = "Enter the last name.";

  const email = normalizeEmail(body.email);
  if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) errors.email = "Enter a valid email address.";
  const phone = normalizePhoneE164(body.phone);
  if (!phone || !temporaryPassword.passwordForPhone(phone)) errors.phone = "Enter a valid US phone number.";

  const rawAddresses = Array.isArray(body.addresses) ? body.addresses : body.address ? [body.address] : [];
  const filled = rawAddresses.filter((a) => a && typeof a === "object" && String(a.line1 || "").trim());
  if (filled.length > MAX_ADDRESSES) errors.addresses = `Up to ${MAX_ADDRESSES} addresses.`;
  const addresses = [];
  const outsideServiceArea = [];
  filled.slice(0, MAX_ADDRESSES).forEach((raw, index) => {
    const built = buildAddress(raw, null, index);
    if (built.errors) Object.assign(errors, built.errors);
    else {
      addresses.push(built.address);
      if (!built.inServiceArea) outsideServiceArea.push(index);
    }
  });

  if (Object.keys(errors).length) throw new CustomerAccessError("INVALID", "Please check the highlighted fields.", 400, { errors });
  return { firstName, lastName, name, email, phone, addresses, outsideServiceArea };
}

/**
 * Create the account, record the call's consent, issue the temporary password
 * and send the sign-in details. Returns { user, delivery, warnings }.
 */
async function createCustomerByAdmin({ body, admin, req = null, deps = {} }) {
  const input = await validateNewCustomer(body || {});

  /*
   * An email already registered is never a second account and never a silent
   * merge: Admin is shown who already has it and can open them instead.
   */
  const existingEmail = await User.findOne({ email: input.email }).select("_id name role employeePosition").lean();
  if (existingEmail) {
    const staff = existingEmail.role === "employee" || existingEmail.role === "admin" || existingEmail.employeePosition;
    throw new CustomerAccessError("EMAIL_IN_USE", "An account with this email already exists.", 409, {
      errors: { email: "Already registered." },
      existing: staff ? null : { id: String(existingEmail._id), name: existingEmail.name || "" },
    });
  }

  if (body?.allowSharedPhone !== true) {
    // Older accounts stored phones as typed, so match the common spellings of the same number.
    const national = temporaryPassword.passwordForPhone(input.phone);
    const spellings = [input.phone, national, `1${national}`, `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`, `${national.slice(0, 3)}-${national.slice(3, 6)}-${national.slice(6)}`];
    const samePhone = await User.find({ phone: { $in: spellings }, role: { $nin: ["employee", "admin"] }, employeePosition: { $in: [null, ""] } })
      .select("_id name email")
      .limit(3)
      .lean();
    if (samePhone.length) {
      throw new CustomerAccessError("PHONE_IN_USE", "This phone number is already on another customer's account.", 409, {
        errors: { phone: "Already on another account." },
        existing: samePhone.map((u) => ({ id: String(u._id), name: u.name || "", email: maskEmail(u.email || "") })),
      });
    }
  }

  const now = new Date();
  const user = new User({
    userId: generateUserId(),
    name: input.name,
    firstName: input.firstName,
    lastName: input.lastName,
    email: input.email,
    phone: input.phone,
    role: "customer",
    employeePosition: null,
    isActive: true,
    signupMethod: "admin",
    authProviders: [],
    addresses: input.addresses,
    adminCreated: { at: now, by: admin?._id || null, byName: String(admin?.name || admin?.email || "").slice(0, 120) },
    // Typed by staff: opens nothing until the customer proves it (utils/auth/accounts inboxOpensAccount).
    emailEnteredByStaffAt: input.email ? now : null,
    // Typed by staff on the call: a code to it signs the customer in (routes/authV2.js phone verify).
    phoneEnteredByStaffAt: now,
  });
  if (user.addresses.length) {
    user.defaultAddressId = user.addresses[0]._id;
    const primary = user.addresses[0];
    user.address = primary.line1;
    user.city = primary.city;
    user.state = primary.state;
    user.zip = primary.zip;
    user.county = primary.county || "";
  }
  // 2026-11-20: no temporary password. The customer signs in with a code to this number.
  await user.save();

  /*
   * The call is the consent (owner's decision). Each switch goes through the
   * one audited writer, so the ledger names the staff member and the wording.
   */
  const wanted = { ...DEFAULT_COMMUNICATION, ...(body?.communication && typeof body.communication === "object" ? body.communication : {}) };
  const communication = {};
  for (const key of Object.keys(DEFAULT_COMMUNICATION)) {
    if (wanted[key] !== true) continue;
    try {
      const change = await setCommunicationPreference({
        userId: user._id,
        key,
        enabled: true,
        admin,
        req,
        note: "account created by phone",
        recordIfUnchanged: true,
        at: now,
      });
      communication[key] = change.after;
    } catch (error) {
      communication[key] = { error: error.code || error.message };
    }
  }

  const fresh = await User.findById(user._id);
  const delivery = await sendAccessDetails(fresh, { deps });
  return {
    user: fresh,
    delivery,
    expiresAt: null,
    warnings: input.outsideServiceArea.length ? ["address_outside_service_area"] : [],
  };
}

/** Send the sign-in steps again (2026-11-20: no password; a code to their phone is the way in). */
async function resendAccess({ userId, admin, deps = {} }) {
  void admin;
  const user = await User.findById(userId);
  if (!user) throw new CustomerAccessError("NOT_FOUND", "Customer not found.", 404);
  if (user.role === "employee" || user.role === "admin" || user.employeePosition) {
    throw new CustomerAccessError("NOT_A_CUSTOMER", "Only customer accounts.", 400);
  }
  if (!user.phone && !user.email) throw new CustomerAccessError("NO_CONTACT", "Add a phone number first.", 400);
  /*
   * Only for accounts that have not signed in yet. Once the customer has
   * proved their phone or set a password, they already know the way in.
   */
  if (!resendAccessWaiting(user)) {
    throw new CustomerAccessError("ALREADY_SIGNED_IN", "This customer has already signed in. They can sign in with a code to their mobile number.", 409);
  }
  // A temporary password issued before 2026-11-20 is no longer how they get in.
  if (temporaryPassword.isIssued(user)) {
    await temporaryPassword.retireAfterOtherSignIn(user);
  }
  const delivery = await sendAccessDetails(user, { deps });
  return { user, delivery, expiresAt: null };
}

/** Still waiting on a first sign-in: staff made it, the phone is unproved and no password of their own. */
function resendAccessWaiting(user) {
  const ownPassword = Boolean(user?.password) && !temporaryPassword.isIssued(user);
  return Boolean(user) && !user.phoneVerifiedAt && !ownPassword && Boolean(user.signupMethod === "admin" || user.adminCreated?.at);
}

module.exports = {
  CustomerAccessError,
  DEFAULT_COMMUNICATION,
  EMAIL_KEY,
  createCustomerByAdmin,
  renderAccessEmail,
  resendAccess,
  resendAccessWaiting,
  sendAccessDetails,
  validateNewCustomer,
};
