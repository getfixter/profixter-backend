/**
 * The owner correcting a customer's details: the rules, kept apart from the route.
 *
 * WHY THIS IS MORE THAN A FORM
 * Since Registration 2.0 a phone or an email is not just contact information,
 * it is a way IN. A verified phone opens the account with a text code, and any
 * email on the account opens it with an email code or a password reset. So
 * every contact edit here answers a security question first:
 *
 *   - A changed phone loses its verification (phoneVerifiedAt = null). The new
 *     number is something the owner typed, not something the customer proved,
 *     and phone sign-in only ever opens accounts that proved the number. Until
 *     the customer verifies it themselves, the new number can only reach the
 *     "link to your account" step, which needs something the account already
 *     trusts.
 *   - A changed email loses its verification too (emailVerifiedAt = null). An
 *     email code is proof of the inbox and opens the account that holds the
 *     address (the same proof a password reset accepts), so the email is the
 *     sensitive field: that is why only the owner can change it, and why the
 *     screen says so before saving.
 *   - Google and Apple links (googleId / appleId) are never touched. They are
 *     the provider's stable id for the person and survive any email change.
 *   - Sessions are NOT ended (tokenVersion is not bumped). Sessions belong to
 *     the account, not to the identifier; the people holding them are the
 *     customer on their own devices, and a typo fix must not sign them out.
 *     When a takeover is actually suspected, a password reset ends every session.
 *
 * AN ACCOUNT IS NEVER LEFT WITHOUT A WAY IN
 * signInMethods() is the rule, enforced on the server: an email (email code,
 * password reset, password login), a VERIFIED phone (text code), Google or
 * Apple. An unverified phone does not count; on its own it can never open the
 * account. An edit that would take the last one away is refused.
 */
const { normalizeEmail, normalizePhoneE164 } = require("./identity");
const { buildSignupAddress } = require("./addressVerification");
const { normalizeZip, countyForZip, isZipInServiceArea } = require("./serviceArea");
const { buildAddressKey } = require("./introVisitEligibility");

/* Only these may appear in a request body. Anything else is refused, never ignored silently. */
const ALLOWED_BODY_KEYS = new Set([
  "firstName",
  "lastName",
  "phone",
  "email",
  "addresses",
  "acknowledgeWarnings",
  "expectedUpdatedAt",
  "reason",
]);
/* Owner only: they are ways into the account. */
const OWNER_ONLY_FIELDS = new Set(["phone", "email"]);

const MAX_ADDRESSES = 20;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* The fifty states, DC and the inhabited territories: US addresses only. */
const US_STATES = new Set(
  "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR VI GU AS MP".split(
    " "
  )
);

function cleanText(value, max) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** First and last as the edit form shows them, from whichever fields the account has. */
function splitName(user) {
  const first = cleanText(user?.firstName, 60);
  const last = cleanText(user?.lastName, 60);
  if (first || last) return { firstName: first, lastName: last };
  const [head = "", ...rest] = cleanText(user?.name, 120).split(" ").filter(Boolean);
  return { firstName: head.slice(0, 60), lastName: rest.join(" ").slice(0, 60) };
}

/** The ways this account can be opened. See the header. */
function signInMethods(user) {
  const methods = [];
  if (user?.email) methods.push("email");
  if (user?.phone && user?.phoneVerifiedAt) methods.push("phone");
  if (user?.googleId) methods.push("google");
  if (user?.appleId) methods.push("apple");
  return methods;
}

/** "(•••) •••-0147": enough to recognise, not enough to use. */
function maskPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.length >= 4 ? `(•••) •••-${digits.slice(-4)}` : "•••";
}

/** "ca•••@example.com". */
function maskEmail(value) {
  const email = String(value || "");
  const at = email.lastIndexOf("@");
  if (at < 1) return email ? "•••" : "";
  return `${email.slice(0, Math.min(2, at))}•••${email.slice(at)}`;
}

function formatAddress(address) {
  if (!address) return "";
  const stateZip = [address.state, address.zip].filter(Boolean).join(" ");
  return [address.line1, address.city, stateZip].filter(Boolean).join(", ");
}

/**
 * Validate one submitted address and turn it into the stored shape.
 *
 * buildSignupAddress is the same verification sign-up and "add your home" use:
 * the unit rides inside line1 (so "Apt 1" and "Apt 2" stay distinct
 * properties), the ZIP is normalised, and Places coordinates are kept only when
 * they fall inside their own ZIP. County is derived from the ZIP and never
 * accepted from the browser; an address we do not serve keeps the county it
 * already had while its ZIP is unchanged.
 */
function buildAddress(input, existing, index) {
  const errors = {};
  const at = (field) => `addresses.${index}.${field}`;
  const raw = input && typeof input === "object" ? input : {};

  const line1 = cleanText(raw.line1, 120);
  const unit = cleanText(raw.unit, 30);
  const city = cleanText(raw.city, 60);
  const state = cleanText(raw.state || "NY", 2).toUpperCase();
  const zip = normalizeZip(raw.zip);
  const label = cleanText(raw.label, 40);

  if (!line1) errors[at("line1")] = "Enter the street address.";
  if (!city) errors[at("city")] = "Enter the city.";
  if (!US_STATES.has(state)) errors[at("state")] = "Use a two-letter US state, e.g. NY.";
  if (!zip) errors[at("zip")] = "Enter a 5-digit ZIP code.";
  if (Object.keys(errors).length) return { errors };

  const built = buildSignupAddress({ line1, unit, city, state, zip, placeId: raw.placeId, lat: raw.lat, lng: raw.lng });
  if (!built.ok) return { errors: { [at(built.field === "address" ? "line1" : built.field)]: "This part of the address is not valid." } };

  const address = { ...built.address, label: label || existing?.label || (index === 0 ? "Primary" : "Home") };
  const sameZip = existing && normalizeZip(existing.zip) === address.zip;
  if (!address.county && sameZip) address.county = String(existing.county || "");

  /*
   * A lookup pin describes one place. If the street or ZIP changed without a
   * new lookup, the old pin is about the old house, so it goes rather than
   * quietly mislabelling the new one.
   */
  if (existing && !String(raw.placeId || "").trim()) {
    const moved = buildAddressKey(existing) !== buildAddressKey(address);
    if (!moved) {
      address.placeId = existing.placeId || "";
      address.lat = existing.lat ?? null;
      address.lng = existing.lng ?? null;
    }
  }

  return { address, inServiceArea: isZipInServiceArea(address.zip), county: countyForZip(address.zip) || null };
}

/**
 * Normalise the contact fields of a request. Returns the values the account
 * would hold afterwards ("" means "remove"), or per-field errors.
 */
function readContact(body) {
  const errors = {};
  const out = {};
  if (body.phone !== undefined) {
    const raw = String(body.phone ?? "").trim();
    if (!raw) out.phone = "";
    else {
      const e164 = normalizePhoneE164(raw);
      if (!e164) errors.phone = "Enter a valid US phone number.";
      else out.phone = e164;
    }
  }
  if (body.email !== undefined) {
    const raw = String(body.email ?? "").trim();
    if (!raw) out.email = "";
    else {
      const email = normalizeEmail(raw);
      if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) errors.email = "Enter a valid email address.";
      else out.email = email;
    }
  }
  return { errors, values: out };
}

/** A one-line description of an edit, for the global activity log. */
function summarise(changes) {
  const labels = [...new Set(changes.map((change) => change.label))];
  return labels.length ? `Changed: ${labels.join(", ")}` : "No changes";
}

module.exports = {
  ALLOWED_BODY_KEYS,
  MAX_ADDRESSES,
  OWNER_ONLY_FIELDS,
  US_STATES,
  buildAddress,
  cleanText,
  formatAddress,
  maskEmail,
  maskPhone,
  readContact,
  signInMethods,
  splitName,
  summarise,
};
