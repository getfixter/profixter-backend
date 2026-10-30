const bcrypt = require("bcryptjs");
const { normalizePhoneE164 } = require("../identity");

/**
 * The one-time password Admin gives a customer it signed up by phone.
 *
 * The owner chose the customer's phone number as that password, so it is easy
 * to say on a call. A phone number is guessable by anyone who knows it, which
 * is why everything here narrows what the password can do rather than trusting
 * it:
 *
 *  - it opens ONE screen. middleware/auth.js refuses every other request from
 *    a session it opened until a real password is set;
 *  - it expires (TTL_HOURS, 72 by default). After that it signs nobody in, and
 *    the customer uses "Forgot password" or a sign-in code, or Admin resends;
 *  - it dies the moment anything better proves the account: a new password, a
 *    password reset, or a sign-in by phone/email code, Google or Apple.
 *
 * While it is live, `user.password` holds its hash. That keeps every existing
 * password path (login, change-password, reset) working on one field, and
 * means "replaced" is simply "the hash changed".
 */

const DEFAULT_TTL_HOURS = 72;

function ttlHours(env = process.env) {
  const raw = Number(env.ADMIN_TEMP_PASSWORD_TTL_HOURS);
  return Number.isFinite(raw) && raw >= 1 && raw <= 24 * 14 ? raw : DEFAULT_TTL_HOURS;
}

/** The ten digits a US customer would say: "5164736259". */
function passwordForPhone(phone) {
  const e164 = normalizePhoneE164(phone) || "";
  const digits = e164.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.length >= 10 ? digits : "";
}

function isIssued(user) {
  return Boolean(user?.temporaryPassword?.issuedAt);
}

function isExpired(user, now = new Date()) {
  if (!isIssued(user)) return false;
  const at = user.temporaryPassword.expiresAt;
  return !at || new Date(at).getTime() <= now.getTime();
}

/** Live: issued, not yet expired. */
function isLive(user, now = new Date()) {
  return isIssued(user) && !isExpired(user, now);
}

/**
 * Put a temporary password on the account (not saved: the caller saves).
 * Returns the plain password so it can be sent, once, to the customer.
 */
async function issue(user, { admin = null, now = new Date(), env = process.env } = {}) {
  const plain = passwordForPhone(user.phone);
  if (!plain) {
    const error = new Error("A valid phone number is needed for the temporary password.");
    error.code = "PHONE_REQUIRED";
    throw error;
  }
  user.password = await bcrypt.hash(plain, 10);
  user.mustChangePassword = true;
  user.temporaryPassword = {
    issuedAt: now,
    expiresAt: new Date(now.getTime() + ttlHours(env) * 60 * 60 * 1000),
    issuedBy: admin?._id || null,
    issuedByName: String(admin?.name || admin?.email || "").slice(0, 120),
  };
  return { plain, expiresAt: user.temporaryPassword.expiresAt };
}

/**
 * Whether a typed password is the live temporary one. Accepts the number as
 * people actually type it - "(516) 473-6259", "+1 516 473 6259" - because it
 * was given to them as a phone number, not as a string of digits.
 */
async function matches(user, typed) {
  if (!isIssued(user) || !user.password) return false;
  const digits = String(typed || "").replace(/\D/g, "");
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (!national) return false;
  return bcrypt.compare(national, user.password);
}

/** A real password now exists: forget the temporary one (not saved). */
function clear(user) {
  user.temporaryPassword = { issuedAt: null, expiresAt: null, issuedBy: null, issuedByName: "" };
  user.mustChangePassword = false;
}

/**
 * The customer proved the account another way (a code, Google, Apple): the
 * temporary password is removed outright rather than left working until it
 * expires. They keep signing in the way they just did, and can set a password
 * from their account whenever they like. Saves; safe to call on anyone.
 */
async function retireAfterOtherSignIn(user) {
  if (!isIssued(user)) return false;
  user.password = undefined;
  clear(user);
  user.authProviders = (user.authProviders || []).filter((p) => p !== "password");
  await user.save();
  return true;
}

module.exports = {
  DEFAULT_TTL_HOURS,
  clear,
  isExpired,
  isIssued,
  isLive,
  issue,
  matches,
  passwordForPhone,
  retireAfterOtherSignIn,
  ttlHours,
};
